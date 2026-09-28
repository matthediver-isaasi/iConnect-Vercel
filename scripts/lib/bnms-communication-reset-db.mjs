import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildResetPlan, TENANT_ID } from './bnms-communication-reset-plan.mjs';
import { buildCommunicationStatusReportRow } from '../../shared/memberCommunicationStatusReport.js';
import { isEligibleCommunicationMember } from '../../shared/communicationCategoryMembership.js';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tables = {
  members: 'member', categories: 'communication_category',
  assignments: 'communication_category_role', roles: 'role',
  preferences: 'member_communication_preference', ledgers: 'email_unsubscribe',
  subscribers: 'email_subscriber',
};

export async function loadSnapshot(client) {
  const snapshot = {};
  const identity = (await client.query(
    'SELECT id,name,slug FROM public.tenant WHERE id=$1', [TENANT_ID],
  )).rows;
  if (identity.length !== 1 || identity[0].name !== 'BNMS' || identity[0].slug !== 'bnms') {
    throw new Error('Live BNMS identity mismatch; refusing repair');
  }
  for (const [key, table] of Object.entries(tables)) {
    // Include corrupt cross-tenant references rather than hiding them with a tenant filter.
    let predicate = 'r.tenant_id=$1';
    if (['preferences', 'ledgers'].includes(key)) {
      predicate += ' OR r.member_id IN (SELECT id FROM public.member WHERE tenant_id=$1)';
    }
    if (['preferences', 'assignments'].includes(key)) {
      predicate += ' OR r.category_id IN (SELECT id FROM public.communication_category WHERE tenant_id=$1)';
    }
    const projection = key === 'members'
      ? `jsonb_build_object('id',id,'tenant_id',tenant_id,'email',email,'role_id',role_id,
          'status',status,'login_enabled',login_enabled,
          'communications_opted_out_all',communications_opted_out_all,
          'updated_at',updated_at,
          'protected_hash',md5((to_jsonb(r)-'communications_opted_out_all'-'updated_at')::text))`
      : 'to_jsonb(r)';
    snapshot[key] = (await client.query(
      `SELECT ${projection} AS value FROM public.${table} r WHERE ${predicate} ORDER BY r.id`, [TENANT_ID],
    )).rows.map(row => row.value);
  }
  return snapshot;
}

export async function inspectContract(client) {
  const migration = await readFile(new URL('../../supabase/migrations/20260831_repair_atomic_email_preference_global_state.sql', import.meta.url), 'utf8');
  const functions = (await client.query(`
    SELECT proname,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname IN ('set_email_preference_global_state','set_email_preference_category_state')
    ORDER BY proname`)).rows;
  if (functions.length !== 2) throw new Error('Missing or ambiguous deployed consent RPCs');
  for (const fn of functions) {
    const match = migration.match(new RegExp(`CREATE OR REPLACE FUNCTION ${fn.proname}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`, 'i'));
    if (!match || match[1].trim() !== fn.prosrc.trim()) throw new Error('Deployed consent RPC differs from reviewed contract');
  }
  const triggers = (await client.query(`
    SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition,
           pg_get_functiondef(t.tgfoid) AS function
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
      AND c.relname IN ('member','member_communication_preference','email_unsubscribe')
    ORDER BY c.relname,t.tgname`)).rows;
  const queueFunction = (await client.query(`
    SELECT pg_get_functiondef(oid) AS definition FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname='queue_automatic_memberships_for_source_changes'`)).rows;
  const affectedGroups = (await client.query(`
    SELECT count(*)::int AS count FROM public.member_group
    WHERE tenant_id=$1 AND automatic_membership_enabled=true
      AND automatic_membership_filter_groups::text LIKE '%communications_opted_out_all%'`, [TENANT_ID])).rows[0].count;
  if (affectedGroups) throw new Error('Consent-dependent automatic groups require separate review');
  return { functions, triggers, queueFunction };
}

export async function acquireIdentityLocks(client, snapshot) {
  const keys = [...new Set(snapshot.members.map(m => String(m.email || '').trim().toLowerCase()).filter(Boolean))].sort();
  // Exactly the lock namespace used by all deployed atomic consent RPCs.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || email,0))
    FROM unnest($2::text[]) email ORDER BY email`, [TENANT_ID, keys]);
  await client.query('SELECT id FROM public.member WHERE tenant_id=$1 ORDER BY id FOR UPDATE', [TENANT_ID]);
  for (const table of ['communication_category', 'communication_category_role', 'role']) {
    await client.query(`SELECT id FROM public.${table} WHERE tenant_id=$1 ORDER BY id FOR SHARE`, [TENANT_ID]);
  }
}

export async function executePlan(client, snapshot, plan) {
  const removed = snapshot.ledgers.filter(row => plan.removeLedgerIds.includes(row.id));
  const pairs = [];
  for (const member of plan.members) {
    const globalLedger = removed.some(row => row.unsubscribe_type === 'all'
      && String(row.email).trim().toLowerCase() === member.email);
    if (member.clearGlobal || globalLedger) {
      if (member.email) {
        await client.query('SELECT public.set_email_preference_global_state($1,$2,$3,false,null,$4)', [
          TENANT_ID, member.email, member.clearGlobal ? member.id : null, [],
        ]);
      } else {
        // No ledger identity exists for an email-less member; never fabricate one.
        await client.query(`UPDATE public.member SET communications_opted_out_all=false
          WHERE tenant_id=$1 AND id=$2 AND communications_opted_out_all IS DISTINCT FROM false`,
        [TENANT_ID, member.id]);
      }
    }
    const categoryIds = new Set([...member.addCategoryIds, ...member.changeCategoryIds]);
    for (const row of removed) {
      if (row.unsubscribe_type === 'category' && String(row.email).trim().toLowerCase() === member.email) {
        categoryIds.add(row.communication_category_id);
      }
    }
    for (const categoryId of categoryIds) pairs.push({ member_id: member.id, email: member.email, category_id: categoryId });
  }
  // Bulk transport, not a replacement for the existing per-identity RPC contract.
  await client.query(`SELECT public.set_email_preference_category_state($1,p.email,p.member_id,p.category_id,true,null)
    FROM jsonb_to_recordset($2::jsonb) p(member_id uuid,email text,category_id uuid)
    WHERE p.email<>'' ORDER BY p.email,p.member_id,p.category_id`, [TENANT_ID, JSON.stringify(pairs)]);
  const emailLess = pairs.filter(p => !p.email);
  if (emailLess.length) {
    await client.query(`INSERT INTO public.member_communication_preference
        (tenant_id,member_id,category_id,is_subscribed)
        SELECT $1,p.member_id,p.category_id,true
        FROM jsonb_to_recordset($2::jsonb) p(member_id uuid,category_id uuid)
        ON CONFLICT(member_id,category_id) DO UPDATE SET is_subscribed=true`,
    [TENANT_ID, JSON.stringify(emailLess)]);
  }
}

export function verifyChanges(before, after, plan) {
  const targetIds = new Set(plan.members.map(m => m.id));
  for (let i = 0; i < before.members.length; i++) {
    const old = before.members[i], next = after.members[i];
    if (!next || next.id !== old.id) throw new Error('Member set changed');
    if (!targetIds.has(old.id)) {
      if (digest(old) !== digest(next)) throw new Error('Excluded member changed');
    } else {
      if (old.protected_hash !== next.protected_hash || next.communications_opted_out_all !== false) {
        throw new Error('Member protected fields or global flag mismatch');
      }
      if (!plan.members.find(m => m.id === old.id).clearGlobal && old.updated_at !== next.updated_at) {
        throw new Error('Unexpected member timestamp update');
      }
    }
  }
  if (before.members.length !== after.members.length) throw new Error('Member set changed');
  for (const key of ['categories', 'assignments', 'roles', 'subscribers']) {
    if (digest(before[key]) !== digest(after[key])) throw new Error(`Protected ${key} changed`);
  }
  const allowed = new Set(plan.members.flatMap(m => m.categoryIds.map(c => `${m.id}:${c}`)));
  const unaffected = rows => rows.filter(r => !allowed.has(`${r.member_id}:${r.category_id}`));
  if (digest(unaffected(before.preferences)) !== digest(unaffected(after.preferences))) {
    throw new Error('Inaccessible or excluded preferences changed');
  }
  const afterPreferences = new Map(after.preferences.map(p => [p.id, p]));
  for (const previous of before.preferences) {
    const next = afterPreferences.get(previous.id);
    if (!next) throw new Error('Existing preference removed');
    const key = `${previous.member_id}:${previous.category_id}`;
    const expected = allowed.has(key) ? { ...previous, is_subscribed: true } : previous;
    if (digest(expected) !== digest(next)) throw new Error('Unexpected existing preference mutation');
  }
  if (after.preferences.length !== before.preferences.length + plan.summary.subscriptionsAdded) {
    throw new Error('Unexpected new preference count');
  }
  const remainingLedgers = before.ledgers.filter(row => !plan.removeLedgerIds.includes(row.id));
  if (digest(remainingLedgers) !== digest(after.ledgers)) throw new Error('Unexpected ledger changes');
  const replay = buildResetPlan(after);
  if (changeCount(replay) !== 0) throw new Error('Nonzero replay');
  return replay.summary;
}

export function changeCount(plan) {
  return plan.removeLedgerIds.length + plan.members.reduce((n, m) =>
    n + Number(m.clearGlobal) + m.addCategoryIds.length + m.changeCategoryIds.length, 0);
}

export function reportEvidence(snapshot, plan) {
  const roles = new Map(snapshot.categories.map(c => [c.id,
    snapshot.assignments.filter(a => a.category_id === c.id).map(a => a.role_id)]));
  const byMember = new Map();
  for (const preference of snapshot.preferences) {
    const list = byMember.get(preference.member_id) || [];
    list.push(preference);
    byMember.set(preference.member_id, list);
  }
  const included = new Set(plan.members.map(m => m.id));
  const members = snapshot.members.filter(m => included.has(m.id));
  const rows = members.map(m => buildCommunicationStatusReportRow(m, snapshot.categories, byMember.get(m.id) || [], roles));
  let availablePairs = 0, subscribedAvailablePairs = 0;
  for (const row of rows) for (const status of Object.values(row.categoryStatuses)) {
    if (status.available) {
      availablePairs++;
      if (status.optedIn) subscribedAvailablePairs++;
    }
  }
  return {
    reportMembers: rows.length,
    reportGloballyOptedOut: rows.filter(r => r.globalOptOut).length,
    availablePairs, subscribedAvailablePairs,
    normalMemberDeliveryEligible: members.filter(isEligibleCommunicationMember).length,
    categories: snapshot.categories.map(c => ({
      name: c.name,
      eligibleMembers: rows.filter(r => r.categoryStatuses[c.id]?.available).length,
      optedInEligibleMembers: rows.filter(r => r.categoryStatuses[c.id]?.available && r.categoryStatuses[c.id]?.optedIn).length,
      normalMemberAudience: members.filter(m => isEligibleCommunicationMember(m)
        && rows.find(r => r.memberId === m.id)?.categoryStatuses[c.id]?.available
        && (byMember.get(m.id) || []).some(p => p.category_id === c.id && p.is_subscribed === true)).length,
    })),
  };
}

export async function independentPairCheck(client) {
  // Independent SQL cross product, not the JS plan or its list of target pairs.
  return (await client.query(`
    WITH members AS (
      SELECT * FROM public.member WHERE tenant_id=$1
      AND NOT (trim(coalesce(email,'')) ~* '^deleted_.*@deleted[.]local$')
      AND coalesce(status,'') NOT IN ('deleted','anonymized')
    ), pairs AS (
      SELECT m.id,m.email,c.id AS category_id
      FROM members m CROSS JOIN public.communication_category c
      WHERE c.tenant_id=$1 AND c.is_active=true AND c.member_enabled IS DISTINCT FROM false
      AND (NOT EXISTS (SELECT 1 FROM public.communication_category_role r WHERE r.category_id=c.id)
        OR EXISTS (SELECT 1 FROM public.communication_category_role r WHERE r.category_id=c.id
          AND to_jsonb(m.role_id) @> to_jsonb(r.role_id)))
    )
    SELECT (SELECT count(*)::int FROM members) AS members,
      (SELECT count(*)::int FROM members WHERE communications_opted_out_all IS DISTINCT FROM false) AS global_mismatches,
      count(*)::int AS expected_pairs,
      count(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM public.member_communication_preference p
        WHERE p.tenant_id=$1 AND p.member_id=pairs.id AND p.category_id=pairs.category_id
          AND p.is_subscribed=true))::int AS pair_mismatches,
      (SELECT count(*)::int FROM public.email_unsubscribe e WHERE e.tenant_id=$1
        AND e.unsubscribe_type='all' AND e.communication_category_id IS NULL
        AND EXISTS (SELECT 1 FROM members m WHERE lower(trim(m.email))=lower(trim(e.email)))) AS global_suppressions,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.email_unsubscribe e
        WHERE e.tenant_id=$1 AND lower(trim(e.email))=lower(trim(pairs.email))
        AND e.unsubscribe_type='category' AND e.communication_category_id=pairs.category_id))::int AS category_suppression_pairs
    FROM pairs`, [TENANT_ID])).rows[0];
}

export async function protectedFingerprints(client) {
  const result = {};
  // Hashes only: no unrelated member/contact details leave the database.
  for (const table of ['member', 'member_communication_preference', 'email_unsubscribe',
    'email_subscriber', 'role', 'member_group', 'email_campaign', 'email_campaign_recipient']) {
    const where = ['member', 'member_communication_preference', 'email_unsubscribe'].includes(table)
      ? 'WHERE tenant_id IS DISTINCT FROM $1::uuid' : 'WHERE $1::uuid IS NOT NULL';
    result[table] = (await client.query(`SELECT count(*)::int AS count,
      md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY r.id),'')) AS hash
      FROM public.${table} r ${where}`, [TENANT_ID])).rows[0];
  }
  return result;
}