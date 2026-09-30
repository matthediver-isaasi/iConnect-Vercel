#!/usr/bin/env node
/**
 * Standardise member group role names to Title Case (task: role name
 * standardisation + autocomplete).
 *
 * Member group roles are free-form strings, so the same role can exist with
 * different capitalisation ("chair" vs "Chair", within one group or across a
 * tenant's groups). This script:
 *
 *   1. Groups every role name in a tenant case-insensitively and picks ONE
 *      canonical spelling per lowercase key: Title Case of the preferred
 *      variant. "Preferred variant" = the spelling that carries role metadata
 *      (term definitions / terms of reference / terms URL) in the most groups,
 *      then the one with the most member assignments, then alphabetical for
 *      determinism. Title-casing capitalises the first letter of each word and
 *      preserves all-caps words (acronyms like "PR", "CEO").
 *   2. Rewrites, per group:
 *        - member_group.roles (merging case-only duplicates within the group)
 *        - leadership_roles / projects_enabled_roles / forum_enabled_roles
 *        - default_self_join_role
 *        - role_terms_of_reference / role_terms_url / role_term_definitions
 *          (re-keyed; on a within-group merge the variant that HAS metadata
 *          wins, first-seen otherwise)
 *   3. Rewrites member_group_assignment.group_role and
 *      member_group_role_invitation.group_role rows to the canonical spelling
 *      (all invitation statuses, so history stays consistent).
 *
 * Idempotent: re-running produces no further changes once names are canonical.
 * Defaults to DRY-RUN. Pass --apply to write.
 *
 * Usage:
 *   node scripts/normalize-member-group-roles.mjs                       # dry-run, all tenants
 *   node scripts/normalize-member-group-roles.mjs --tenant=<uuid|slug>  # dry-run, one tenant
 *   node scripts/normalize-member-group-roles.mjs --apply               # apply, all tenants
 *   node scripts/normalize-member-group-roles.mjs --tenant=<uuid> --apply
 */

import { createClient } from '@supabase/supabase-js';
import {
  remapRoleKeyedMap,
  remapGroupRolePolicy,
  isEmptyRoleHtml,
  isEmptyRoleUrl,
  isEmptyRoleTermDef,
} from '../client/src/lib/memberGroupRoleNames.js';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY || process.env.DEST_SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[normalize-roles] DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const tenantArg = (args.find((a) => a.startsWith('--tenant=')) || '').split('=')[1];

// Mirror of client/src/lib/memberGroupRoleNames.js toTitleCase — keep in sync.
function toTitleCase(name) {
  const trimmed = (name || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return trimmed
    .split(' ')
    .map((word) => {
      if (!word) return word;
      // Preserve all-caps words (acronyms like "PR", "CEO").
      if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
      return word[0].toUpperCase() + word.slice(1);
    })
    .join(' ');
}

const lc = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();

async function fetchAll(table, select, filterFn) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(select).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function resolveTenantIds() {
  const tenants = await fetchAll('tenant', 'id, slug, name');
  if (!tenantArg) return tenants;
  const t = tenants.find((x) => x.id === tenantArg || x.slug === tenantArg);
  if (!t) {
    console.error(`[normalize-roles] tenant not found: ${tenantArg}`);
    process.exit(1);
  }
  return [t];
}

function hasMetadataFor(group, roleName) {
  const tor = (group.role_terms_of_reference || {})[roleName];
  const url = (group.role_terms_url || {})[roleName];
  const def = (group.role_term_definitions || {})[roleName];
  return Boolean((tor && String(tor).trim()) || (url && String(url).trim()) || (def && typeof def === 'object'));
}

function remapArray(arr, canonicalByKey) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const r of arr) {
    const canonical = canonicalByKey.get(lc(r)) || r;
    if (seen.has(lc(canonical))) continue;
    seen.add(lc(canonical));
    out.push(canonical);
  }
  return out;
}

// Re-keying of role-keyed metadata maps is shared with the client save path:
// remapRoleKeyedMap (client/src/lib/memberGroupRoleNames.js) guarantees a
// non-empty entry always beats an empty one on a case-only merge, with the
// preferred variant winning only among equally-(non-)empty entries.

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function processTenant(tenant) {
  const groups = await fetchAll(
    'member_group',
    'id, name, roles, leadership_roles, projects_enabled_roles, forum_enabled_roles, default_self_join_role, role_terms_of_reference, role_terms_url, role_term_definitions',
    (q) => q.eq('tenant_id', tenant.id)
  );
  if (groups.length === 0) return { groups: 0, assignments: 0, invitations: 0, forms: 0 };

  const groupIds = groups.map((g) => g.id);
  const assignments = await fetchAll('member_group_assignment', 'id, group_id, group_role', (q) =>
    q.in('group_id', groupIds)
  );
  const invitations = await fetchAll('member_group_role_invitation', 'id, group_id, group_role', (q) =>
    q.in('group_id', groupIds)
  );
  const forms = await fetchAll('form', 'id, access_policy', (q) =>
    q.eq('tenant_id', tenant.id).not('access_policy', 'is', null)
  );

  // ---- Pick a canonical spelling per lowercase key, tenant-wide. ----
  // variants: lcKey -> Map(spelling -> { metaGroups, assignmentCount })
  const variants = new Map();
  const touch = (spelling) => {
    const key = lc(spelling);
    if (!key) return null;
    if (!variants.has(key)) variants.set(key, new Map());
    const m = variants.get(key);
    if (!m.has(spelling)) m.set(spelling, { metaGroups: 0, assignmentCount: 0 });
    return m.get(spelling);
  };
  for (const g of groups) {
    for (const r of g.roles || []) {
      const v = touch(r);
      if (v && hasMetadataFor(g, r)) v.metaGroups += 1;
    }
    // Names referenced only by metadata/arrays still count as variants.
    for (const map of [g.role_terms_of_reference, g.role_terms_url, g.role_term_definitions]) {
      for (const k of Object.keys(map || {})) touch(k);
    }
    for (const arr of [g.leadership_roles, g.projects_enabled_roles, g.forum_enabled_roles]) {
      for (const r of arr || []) touch(r);
    }
    if (g.default_self_join_role) touch(g.default_self_join_role);
  }
  for (const a of assignments) {
    const v = touch(a.group_role);
    if (v) v.assignmentCount += 1;
  }
  for (const inv of invitations) touch(inv.group_role);

  const canonicalByKey = new Map();
  const preferredVariantByKey = new Map();
  for (const [key, m] of variants) {
    const ranked = [...m.entries()].sort((a, b) => {
      if (b[1].metaGroups !== a[1].metaGroups) return b[1].metaGroups - a[1].metaGroups;
      if (b[1].assignmentCount !== a[1].assignmentCount) return b[1].assignmentCount - a[1].assignmentCount;
      return a[0].localeCompare(b[0]);
    });
    const preferred = ranked[0][0];
    preferredVariantByKey.set(key, preferred);
    canonicalByKey.set(key, toTitleCase(preferred));
  }

  let changedGroups = 0;
  let changedAssignments = 0;
  let changedInvitations = 0;
  let changedForms = 0;
  const canonicalRolesByGroupId = new Map();

  for (const g of groups) {
    const next = {
      roles: remapArray(g.roles, canonicalByKey),
      leadership_roles: remapArray(g.leadership_roles, canonicalByKey),
      projects_enabled_roles: remapArray(g.projects_enabled_roles, canonicalByKey),
      forum_enabled_roles: remapArray(g.forum_enabled_roles, canonicalByKey),
      default_self_join_role: g.default_self_join_role
        ? canonicalByKey.get(lc(g.default_self_join_role)) || g.default_self_join_role
        : g.default_self_join_role,
      role_terms_of_reference: remapRoleKeyedMap(g.role_terms_of_reference, canonicalByKey, preferredVariantByKey, isEmptyRoleHtml),
      role_terms_url: remapRoleKeyedMap(g.role_terms_url, canonicalByKey, preferredVariantByKey, isEmptyRoleUrl),
      role_term_definitions: remapRoleKeyedMap(g.role_term_definitions, canonicalByKey, preferredVariantByKey, isEmptyRoleTermDef),
    };
    canonicalRolesByGroupId.set(g.id, next.roles);
    const changed =
      !sameJson(next.roles, g.roles || []) ||
      !sameJson(next.leadership_roles, g.leadership_roles || []) ||
      !sameJson(next.projects_enabled_roles, g.projects_enabled_roles || []) ||
      !sameJson(next.forum_enabled_roles, g.forum_enabled_roles || []) ||
      next.default_self_join_role !== g.default_self_join_role ||
      !sameJson(next.role_terms_of_reference, g.role_terms_of_reference || {}) ||
      !sameJson(next.role_terms_url, g.role_terms_url || {}) ||
      !sameJson(next.role_term_definitions, g.role_term_definitions || {});
    if (!changed) continue;
    changedGroups += 1;
    console.log(`  group "${g.name}" (${g.id}):`);
    console.log(`    roles: ${JSON.stringify(g.roles || [])} -> ${JSON.stringify(next.roles)}`);
    if (APPLY) {
      const { error } = await sb.from('member_group').update(next).eq('id', g.id);
      if (error) throw new Error(`update member_group ${g.id}: ${error.message}`);
    }
  }

  for (const a of assignments) {
    const canonical = canonicalByKey.get(lc(a.group_role));
    if (!canonical || canonical === a.group_role) continue;
    changedAssignments += 1;
    console.log(`  assignment ${a.id}: "${a.group_role}" -> "${canonical}"`);
    if (APPLY) {
      const { error } = await sb.from('member_group_assignment').update({ group_role: canonical }).eq('id', a.id);
      if (error) throw new Error(`update member_group_assignment ${a.id}: ${error.message}`);
    }
  }

  for (const inv of invitations) {
    const canonical = canonicalByKey.get(lc(inv.group_role));
    if (!canonical || canonical === inv.group_role) continue;
    changedInvitations += 1;
    console.log(`  invitation ${inv.id}: "${inv.group_role}" -> "${canonical}"`);
    if (APPLY) {
      const { error } = await sb
        .from('member_group_role_invitation')
        .update({ group_role: canonical })
        .eq('id', inv.id);
      if (error) throw new Error(`update member_group_role_invitation ${inv.id}: ${error.message}`);
    }
  }

  for (const form of forms) {
    let nextPolicy = form.access_policy;
    for (const [groupId, roleNames] of canonicalRolesByGroupId) {
      nextPolicy = remapGroupRolePolicy(nextPolicy, groupId, roleNames);
    }
    if (sameJson(nextPolicy, form.access_policy)) continue;
    changedForms += 1;
    console.log(`  form ${form.id}: canonicalised member-group access roles`);
    if (APPLY) {
      const { error } = await sb.from('form').update({ access_policy: nextPolicy })
        .eq('id', form.id).eq('tenant_id', tenant.id);
      if (error) throw new Error(`update form ${form.id}: ${error.message}`);
    }
  }

  return { groups: changedGroups, assignments: changedAssignments, invitations: changedInvitations, forms: changedForms };
}

(async () => {
  console.log(`[normalize-roles] mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}${tenantArg ? ` tenant=${tenantArg}` : ' (all tenants)'}`);
  const tenants = await resolveTenantIds();
  const totals = { groups: 0, assignments: 0, invitations: 0, forms: 0 };
  for (const tenant of tenants) {
    const res = await processTenant(tenant);
    if (res.groups || res.assignments || res.invitations || res.forms) {
      console.log(`[normalize-roles] tenant ${tenant.slug || tenant.id} (${tenant.name}): groups=${res.groups} assignments=${res.assignments} invitations=${res.invitations} forms=${res.forms}`);
    }
    totals.groups += res.groups;
    totals.assignments += res.assignments;
    totals.invitations += res.invitations;
    totals.forms += res.forms;
  }
  console.log(`[normalize-roles] TOTAL changed: groups=${totals.groups} assignments=${totals.assignments} invitations=${totals.invitations} forms=${totals.forms}${APPLY ? '' : ' (dry-run; nothing written)'}`);
})().catch((err) => {
  console.error('[normalize-roles] FAILED:', err.message || err);
  process.exit(1);
});
