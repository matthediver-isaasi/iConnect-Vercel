#!/usr/bin/env node
/**
 * Recreate missing organisations from form submissions
 * ====================================================
 *
 * Who this is for:
 *   Admin / engineering only. Use this after a Zoho CRM <-> iConnect sync issue
 *   has wiped organisation rows but the original `form_submission` records are
 *   intact and can be reprocessed to recreate them.
 *
 * What it does:
 *   For a given tenant + form, finds every form_submission whose linked
 *   organisation no longer exists (NULL organization_id, dangling FK, or
 *   wrong-tenant org), reports them as a CSV (dry-run) and, with --apply,
 *   reprocesses each flagged submission through the SAME entity pipeline used
 *   by api/forms/process-application.js. Each flagged submission either:
 *     - creates a new organisation (and writes back form_submission.organization_id), or
 *     - links to an existing organisation whose name matches case-insensitively, or
 *     - fails (and is logged in the post-run CSV; the batch continues).
 *
 * Workflow-off precondition:
 *   Reprocessing through process-application.js will trigger workflows for
 *   newly-created organisations/members. The user has manually deactivated the
 *   workflows that could send embarrassing emails or trigger external
 *   side-effects. This script enforces that precondition by running a
 *   pre-flight workflow audit BEFORE doing anything else, in both dry-run and
 *   apply modes:
 *     - It reads every row in `workflow` for the given tenant.
 *     - If any row has is_active = true, the script prints the offending
 *       workflows (id, name, entity_type, trigger_type, action types) and
 *       exits non-zero. The operator must disable them in /WorkflowManagement
 *       before re-running.
 *   The script never flips is_active itself.
 *
 * Defaults (set by the originating incident):
 *   --tenant-id  21296ad6-1350-483a-a90c-1b06ece70501
 *   --form-id    3c4124e1-05c6-4423-88e1-a5f91045152b
 *
 * Usage:
 *   # Dry run (writes tmp/missing-orgs-dry-run-<ts>.csv, no DB changes):
 *   node scripts/recreate-missing-organisations-from-forms.mjs
 *
 *   # Apply (writes tmp/missing-orgs-apply-<ts>.csv, reprocesses flagged rows):
 *   node scripts/recreate-missing-organisations-from-forms.mjs --apply
 *
 *   # Override (rare; only when explicitly directed):
 *   node scripts/recreate-missing-organisations-from-forms.mjs \
 *     --tenant-id=<uuid> --form-id=<uuid> [--apply]
 *
 *   # Point at a different Supabase project (rare; only when explicitly directed):
 *   node scripts/recreate-missing-organisations-from-forms.mjs \
 *     --supabase-url=https://<ref>.supabase.co \
 *     --supabase-service-key=<service-role-key>
 *
 * Required env vars (in priority order — first COMPLETE pair wins):
 *   1. --supabase-url / --supabase-service-key CLI flags (highest priority).
 *   2. DEV_SUPABASE_URL  / DEV_SUPABASE_SERVICE_KEY  (the current iConnect dev DB;
 *      this is what you almost always want in this Repl).
 *   3. DEST_SUPABASE_URL / DEST_SUPABASE_SERVICE_KEY (used by some sibling
 *      migration scripts to denote the "destination" DB).
 *   4. SUPABASE_URL      / SUPABASE_SERVICE_KEY      (legacy fallback — note that
 *      in this Repl this currently points at an OLD pre-multi-tenancy snapshot
 *      that does not have workflow.tenant_id; the schema sanity check below will
 *      abort loudly if you accidentally land there).
 *
 *   URL and service key are resolved as a PAIR from the same tier — never mixed.
 *   If a tier has only one half set (e.g. you pass --supabase-url but not
 *   --supabase-service-key), that tier is skipped with a warning and the script
 *   falls through to the next complete tier. This prevents the footgun of
 *   authenticating against the wrong Supabase project with another project's key.
 *
 * Sanity checks (run before any data work, in both dry-run and apply mode):
 *   - The script prints a startup banner naming the Supabase host it is about to
 *     connect to, so the operator can sanity-check before anything happens.
 *   - It then verifies the connected DB looks like a multi-tenant iConnect DB
 *     (workflow.tenant_id column present, tenant table present). If not, it
 *     aborts with a clear, actionable error naming the host and pointing at the
 *     env vars / CLI flags above, instead of failing later with a cryptic
 *     PostgREST "column workflow.tenant_id does not exist" error.
 *
 * Important:
 *   This script must only be used for the specified tenant/form unless
 *   explicitly overridden via CLI args. It does not touch other tenants,
 *   other forms, submissions that already have a valid organisation, or any
 *   workflow row.
 */

import { createClient } from '@supabase/supabase-js';
import { parseArgs } from 'node:util';
import fs from 'fs';
import path from 'path';

const DEFAULT_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const DEFAULT_FORM_ID = '3c4124e1-05c6-4423-88e1-a5f91045152b';

let parsed;
try {
  parsed = parseArgs({
    options: {
      'tenant-id': { type: 'string' },
      'form-id': { type: 'string' },
      'supabase-url': { type: 'string' },
      'supabase-service-key': { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
} catch (e) {
  console.error('Failed to parse arguments:', e.message);
  printUsageAndExit(1);
}

if (parsed.values.help) printUsageAndExit(0);

const TENANT_ID = parsed.values['tenant-id'] || DEFAULT_TENANT_ID;
const FORM_ID = parsed.values['form-id'] || DEFAULT_FORM_ID;
const APPLY = !!parsed.values.apply;

// Resolve Supabase connection.
// Priority: explicit CLI flags > DEV_SUPABASE_* > DEST_SUPABASE_* > SUPABASE_*.
// In this Repl, plain SUPABASE_URL points at an OLD pre-multi-tenancy snapshot
// that does NOT have workflow.tenant_id, so we deliberately demote it to the
// last fallback. The schema sanity check (assertMultiTenantSchema) will abort
// loudly if we end up connected there anyway.
//
// IMPORTANT: URL and service key are resolved as a PAIR from the same source,
// not independently. Mixing (e.g. CLI URL + DEV env key, or DEV URL + legacy
// SUPABASE key) is a footgun — operators end up authenticating against the
// wrong DB or failing with confusing auth errors. We require both halves of
// a tier to be present together; if a tier has only one half set we skip it
// and fall through to the next tier, with a warning printed at startup.
const credentialTiers = [
  {
    name: 'CLI flags',
    url: parsed.values['supabase-url'],
    key: parsed.values['supabase-service-key'],
    urlSource: '--supabase-url flag',
    keySource: '--supabase-service-key flag',
  },
  {
    name: 'DEV_SUPABASE_*',
    url: process.env.DEV_SUPABASE_URL,
    key: process.env.DEV_SUPABASE_SERVICE_KEY,
    urlSource: 'DEV_SUPABASE_URL env var',
    keySource: 'DEV_SUPABASE_SERVICE_KEY env var',
  },
  {
    name: 'DEST_SUPABASE_*',
    url: process.env.DEST_SUPABASE_URL,
    key: process.env.DEST_SUPABASE_SERVICE_KEY,
    urlSource: 'DEST_SUPABASE_URL env var',
    keySource: 'DEST_SUPABASE_SERVICE_KEY env var',
  },
  {
    name: 'SUPABASE_* (legacy)',
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_KEY,
    urlSource: 'SUPABASE_URL env var',
    keySource: 'SUPABASE_SERVICE_KEY env var',
  },
];

const credentialWarnings = [];
let chosenTier = null;
for (const tier of credentialTiers) {
  if (tier.url && tier.key) {
    chosenTier = tier;
    break;
  }
  if (tier.url && !tier.key) {
    credentialWarnings.push(`Skipping ${tier.name}: ${tier.urlSource} is set but ${tier.keySource} is not. URL and key must come from the same tier.`);
  } else if (!tier.url && tier.key) {
    credentialWarnings.push(`Skipping ${tier.name}: ${tier.keySource} is set but ${tier.urlSource} is not. URL and key must come from the same tier.`);
  }
}

const supabaseUrl = chosenTier?.url;
const supabaseServiceKey = chosenTier?.key;
const supabaseUrlSource = chosenTier?.urlSource || '(none)';
const supabaseKeySource = chosenTier?.keySource || '(none)';

if (credentialWarnings.length > 0) {
  for (const w of credentialWarnings) console.warn(`[connection] WARNING: ${w}`);
}

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase connection details.');
  console.error('Provide a complete URL+key pair from one of these tiers (first complete pair wins):');
  console.error('  1. --supabase-url=<url> --supabase-service-key=<key>           (CLI flags)');
  console.error('  2. DEV_SUPABASE_URL  / DEV_SUPABASE_SERVICE_KEY                (preferred for this Repl)');
  console.error('  3. DEST_SUPABASE_URL / DEST_SUPABASE_SERVICE_KEY');
  console.error('  4. SUPABASE_URL      / SUPABASE_SERVICE_KEY                    (legacy fallback)');
  console.error('Tiers where only one half is set are skipped to avoid mixing credentials across projects.');
  process.exit(1);
}

let supabaseHost;
try {
  supabaseHost = new URL(supabaseUrl).host;
} catch {
  supabaseHost = supabaseUrl;
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

function printUsageAndExit(code) {
  console.log(`Usage: node scripts/recreate-missing-organisations-from-forms.mjs [options]

Options:
  --tenant-id=<uuid>            Tenant id (default ${DEFAULT_TENANT_ID})
  --form-id=<uuid>              Form id   (default ${DEFAULT_FORM_ID})
  --supabase-url=<url>          Override Supabase project URL
  --supabase-service-key=<key>  Override Supabase service role key
  --apply                       Reprocess flagged submissions (otherwise dry-run only)
  --help                        Show this help

Connection priority (first set wins):
  1. --supabase-url / --supabase-service-key
  2. DEV_SUPABASE_URL  / DEV_SUPABASE_SERVICE_KEY    (preferred for this Repl)
  3. DEST_SUPABASE_URL / DEST_SUPABASE_SERVICE_KEY
  4. SUPABASE_URL      / SUPABASE_SERVICE_KEY        (legacy fallback)
`);
  process.exit(code);
}

function log(...args) { console.log(...args); }
function warn(...args) { console.warn(...args); }
function err(...args) { console.error(...args); }

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(filepath, rows, headers) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Pre-flight: schema sanity check
// ---------------------------------------------------------------------------
/**
 * Confirm we are connected to a multi-tenant iConnect database before doing
 * anything else. We check two things:
 *   1. workflow.tenant_id column exists (the canonical multi-tenancy marker
 *      and the exact column whose absence triggered the original bug report).
 *   2. The `tenant` table itself exists.
 * If either check fails, abort with a clear, host-named error message instead
 * of letting the run blow up later with a cryptic PostgREST error.
 */
async function assertMultiTenantSchema() {
  // Probe 1: tiny tenant_id select against workflow. We use limit(0) so no
  // row is returned but PostgREST will still validate the column reference
  // and surface a "column does not exist" error if it's missing.
  const { error: wfErr } = await supabase
    .from('workflow')
    .select('tenant_id')
    .limit(0);
  if (wfErr) {
    const msg = (wfErr.message || '').toLowerCase();
    const looksLikeMissingColumn =
      msg.includes('tenant_id') ||
      msg.includes('does not exist') ||
      msg.includes('column') ||
      wfErr.code === '42703';
    if (looksLikeMissingColumn) {
      err('\nABORTED: This database does not look like a multi-tenant iConnect database.');
      err(`Connected host: ${supabaseHost}`);
      err(`URL source:     ${supabaseUrlSource}`);
      err(`Key source:     ${supabaseKeySource}`);
      err('Reason:         workflow.tenant_id is missing on this database.');
      err('');
      err('You are probably pointed at the wrong Supabase project. Check your');
      err('SUPABASE_URL / DEV_SUPABASE_URL env vars, or pass --supabase-url and');
      err('--supabase-service-key explicitly. The current iConnect dev DB is');
      err('exposed via DEV_SUPABASE_URL in this Repl.');
      err(`Underlying error: ${wfErr.message}`);
      process.exit(1);
    }
    err(`Failed to verify workflow schema on ${supabaseHost}: ${wfErr.message}`);
    process.exit(1);
  }

  // Probe 2: tenant table exists.
  const { error: tErr } = await supabase
    .from('tenant')
    .select('id')
    .limit(0);
  if (tErr) {
    const msg = (tErr.message || '').toLowerCase();
    const looksLikeMissingTable =
      msg.includes('relation') ||
      msg.includes('does not exist') ||
      msg.includes('not find the table') ||
      tErr.code === '42P01' ||
      tErr.code === 'PGRST205';
    if (looksLikeMissingTable) {
      err('\nABORTED: This database does not look like a multi-tenant iConnect database.');
      err(`Connected host: ${supabaseHost}`);
      err(`URL source:     ${supabaseUrlSource}`);
      err(`Key source:     ${supabaseKeySource}`);
      err('Reason:         the `tenant` table is missing on this database.');
      err('');
      err('You are probably pointed at the wrong Supabase project. Check your');
      err('SUPABASE_URL / DEV_SUPABASE_URL env vars, or pass --supabase-url and');
      err('--supabase-service-key explicitly.');
      err(`Underlying error: ${tErr.message}`);
      process.exit(1);
    }
    err(`Failed to verify tenant schema on ${supabaseHost}: ${tErr.message}`);
    process.exit(1);
  }

  log(`[schema check] OK — ${supabaseHost} has workflow.tenant_id and tenant table`);
}

// ---------------------------------------------------------------------------
// Pre-flight: workflow audit
// ---------------------------------------------------------------------------
async function auditWorkflowsOff(tenantId) {
  const { data, error } = await supabase
    .from('workflow')
    .select('id, name, entity_type, trigger_type, actions, is_active')
    .eq('tenant_id', tenantId)
    .eq('is_active', true);

  if (error) {
    err('Failed to query workflow table:', error.message);
    process.exit(1);
  }

  if (data && data.length > 0) {
    err('\nABORTED: Active workflows found for tenant', tenantId);
    err('Disable them in /WorkflowManagement before running this script.\n');
    err('Active workflows:');
    for (const wf of data) {
      const actionTypes = Array.isArray(wf.actions)
        ? wf.actions.map(a => a?.type).filter(Boolean).join(', ')
        : '';
      err(`  - ${wf.id}  "${wf.name || '(unnamed)'}"  entity=${wf.entity_type}  trigger=${wf.trigger_type}  actions=[${actionTypes}]`);
    }
    process.exit(2);
  }

  log(`[workflow audit] OK — no active workflows for tenant ${tenantId}`);
}

// ---------------------------------------------------------------------------
// Form lookup + org-name source field resolution
// ---------------------------------------------------------------------------
async function fetchForm(formId, tenantId) {
  const { data: form, error } = await supabase
    .from('form')
    .select('id, title, name, tenant_id, fields, entity_pipelines, field_mappings, application_level')
    .eq('id', formId)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !form) {
    err(`Form ${formId} not found for tenant ${tenantId}:`, error?.message);
    process.exit(1);
  }
  return form;
}

/**
 * Find which form-field id supplies the organisation name.
 * Looks first in entity_pipelines.organisations primary mappings, then in
 * legacy field_mappings array (target_entity=organization, target_field=name),
 * then falls back to the per-field core_field_mapping = 'organization.name'.
 */
function resolveOrgNameSourceFieldId(form) {
  const orgPipelines = form?.entity_pipelines?.organisations || [];
  const primary = orgPipelines.find(o => o.isPrimary || o.is_primary) || orgPipelines[0];
  if (primary?.mappings && Array.isArray(primary.mappings)) {
    const m = primary.mappings.find(
      x => x?.target_type === 'core' && x?.target_field === 'name' && x?.source_field_id
    );
    if (m) return m.source_field_id;
  }

  if (Array.isArray(form?.field_mappings)) {
    const m = form.field_mappings.find(
      x => x?.target_type === 'core' && x?.target_entity === 'organization'
        && x?.target_field === 'name' && x?.source_field_id
    );
    if (m) return m.source_field_id;
  }

  if (Array.isArray(form?.fields)) {
    const f = form.fields.find(x => x?.core_field_mapping === 'organization.name');
    if (f) return f.id;
  }

  return null;
}

function extractOrgNameFromSubmission(submission, orgNameFieldId) {
  if (!orgNameFieldId) return null;
  const data = submission.submission_data || {};
  const v = data[orgNameFieldId];
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  // Defensive: organisation name should never be an array/object, but if it is
  // we leave the raw JSON for the report rather than guessing.
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ---------------------------------------------------------------------------
// Find flagged submissions (missing/dangling organisation)
// ---------------------------------------------------------------------------
async function fetchAllSubmissions(formId, tenantId) {
  const all = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('form_submission')
      .select('id, created_date, submitted_by_name, submitted_by_email, organization_id, processed_at, submission_data')
      .eq('form_id', formId)
      .eq('tenant_id', tenantId)
      .order('created_date', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      err('Failed to fetch form_submission rows:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function fetchOrganisationsByIds(orgIds) {
  if (!orgIds.length) return new Map();
  const map = new Map();
  const chunkSize = 500;
  for (let i = 0; i < orgIds.length; i += chunkSize) {
    const chunk = orgIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('organization')
      .select('id, name, tenant_id')
      .in('id', chunk);
    if (error) {
      err('Failed to fetch organization rows:', error.message);
      process.exit(1);
    }
    for (const o of data || []) map.set(o.id, o);
  }
  return map;
}

async function fetchTenantOrganisationsByName(names, tenantId) {
  if (!names.length) return new Map();
  // Lowercase-keyed map of name -> {id, name}
  const result = new Map();
  const lowered = Array.from(new Set(names.map(n => n.toLowerCase())));
  // Use ilike with `in` is not supported, so fetch all tenant orgs once if
  // the lowered list is small enough; for the incident this set is small.
  // Defensive batched query: pull in chunks via repeated ilike scans.
  const chunkSize = 50;
  for (let i = 0; i < lowered.length; i += chunkSize) {
    const chunk = lowered.slice(i, i + chunkSize);
    // Build OR clause: name.ilike.foo,name.ilike.bar
    const orParts = chunk.map(n => `name.ilike.${n.replace(/[,%_()]/g, m => '\\' + m)}`);
    const { data, error } = await supabase
      .from('organization')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .or(orParts.join(','));
    if (error) {
      err('Failed to look up name-matched organisations:', error.message);
      process.exit(1);
    }
    for (const o of data || []) {
      const key = (o.name || '').toLowerCase();
      if (!result.has(key)) result.set(key, o);
    }
  }
  return result;
}

async function buildFlaggedRows(form, tenantId, orgNameFieldId) {
  const submissions = await fetchAllSubmissions(form.id, tenantId);
  log(`[scan] Loaded ${submissions.length} submissions for form ${form.id}`);

  // Bulk-load referenced org rows
  const referencedOrgIds = Array.from(new Set(
    submissions.map(s => s.organization_id).filter(Boolean)
  ));
  const orgMap = await fetchOrganisationsByIds(referencedOrgIds);

  const flagged = [];
  let validCount = 0;

  for (const s of submissions) {
    let reason = null;
    if (!s.organization_id) {
      reason = 'organization_id is NULL';
    } else {
      const org = orgMap.get(s.organization_id);
      if (!org) {
        reason = `organization_id ${s.organization_id} does not exist`;
      } else if (org.tenant_id !== tenantId) {
        reason = `organization belongs to a different tenant (${org.tenant_id})`;
      }
    }

    if (!reason) {
      validCount++;
      continue;
    }

    const orgName = extractOrgNameFromSubmission(s, orgNameFieldId);
    flagged.push({
      submission_id: s.id,
      created_date: s.created_date,
      applicant_name: s.submitted_by_name || '',
      applicant_email: s.submitted_by_email || '',
      extracted_org_name: orgName || '',
      missing_reason: reason,
      matched_existing_org_id: '',
      matched_existing_org_name: '',
    });
  }

  // Now look up case-insensitive name matches
  const candidateNames = flagged
    .map(r => r.extracted_org_name)
    .filter(Boolean);
  const matchMap = await fetchTenantOrganisationsByName(candidateNames, tenantId);

  let wouldMatchCount = 0;
  for (const row of flagged) {
    if (!row.extracted_org_name) continue;
    const match = matchMap.get(row.extracted_org_name.toLowerCase());
    if (match) {
      row.matched_existing_org_id = match.id;
      row.matched_existing_org_name = match.name;
      wouldMatchCount++;
    }
  }

  return {
    totalSubmissions: submissions.length,
    validCount,
    flaggedCount: flagged.length,
    wouldMatchCount,
    wouldCreateCount: flagged.length - wouldMatchCount,
    flagged,
  };
}

function printSummary(stats) {
  log('\n=== Missing-organisation summary ===');
  log(`Total submissions for form:           ${stats.totalSubmissions}`);
  log(`With valid organisation (skipped):    ${stats.validCount}`);
  log(`Flagged as missing organisation:      ${stats.flaggedCount}`);
  log(`  - would link to existing org:       ${stats.wouldMatchCount}`);
  log(`  - would create new org:             ${stats.wouldCreateCount}`);
}

// ---------------------------------------------------------------------------
// Apply: reprocess flagged submissions through process-application.js
// ---------------------------------------------------------------------------
async function loadProcessApplicationHandler() {
  // Imported lazily so dry-run mode never executes the handler module.
  const mod = await import('../api/forms/process-application.js');
  return mod.default;
}

async function callProcessApplication(handler, body) {
  let statusCode = 200;
  let responseBody = null;
  let ended = false;

  const res = {
    statusCode: 200,
    setHeader() { /* noop */ },
    status(code) { statusCode = code; this.statusCode = code; return this; },
    json(payload) { responseBody = payload; ended = true; return this; },
    end() { ended = true; return this; },
  };

  const req = {
    method: 'POST',
    body,
    headers: {
      host: 'localhost',
      'x-forwarded-proto': 'https',
    },
  };

  await handler(req, res);
  return { statusCode, body: responseBody, ended };
}

/**
 * Re-verify a name match against the database with a tenant-scoped query.
 * Returns { id, name, tenant_id } or null. Used right before apply so the
 * organisation we are about to link is guaranteed to belong to TENANT_ID.
 */
async function verifyTenantNameMatch(orgName, tenantId) {
  if (!orgName) return null;
  const { data, error } = await supabase
    .from('organization')
    .select('id, name, tenant_id')
    .eq('tenant_id', tenantId)
    .ilike('name', orgName)
    .limit(1)
    .maybeSingle();
  if (error) {
    err(`  ! tenant-scoped name lookup failed: ${error.message}`);
    return null;
  }
  if (!data) return null;
  if (data.tenant_id !== tenantId) return null; // belt-and-braces
  return data;
}

/**
 * Pre-create a minimal organisation stub stamped with our target tenant.
 * We do this so that we can hand process-application.js a prefill_organization_id
 * and bypass its unscoped ilike-by-name lookup, which would otherwise be able to
 * match an organisation in a DIFFERENT tenant by coincidental name collision.
 * Returns the new organisation id, or null on error.
 */
async function preCreateTenantOrg(orgName, tenantId) {
  const { data, error } = await supabase
    .from('organization')
    .insert({
      name: orgName,
      tenant_id: tenantId,
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error || !data) {
    err(`  ! pre-create org failed: ${error?.message || 'no row returned'}`);
    return null;
  }
  return data.id;
}

async function applyReprocessing(form, tenantId, flaggedRows, orgNameFieldId) {
  const handler = await loadProcessApplicationHandler();
  const results = [];
  let createdCount = 0;
  let linkedCount = 0;
  let failedCount = 0;

  for (const row of flaggedRows) {
    const submissionId = row.submission_id;
    log(`\n[apply] Processing submission ${submissionId} (${row.applicant_email || 'no email'}) — org name: "${row.extracted_org_name || ''}"`);

    // Re-fetch the submission to get fresh submission_data (in case it was
    // updated since the dry-run scan).
    const { data: submission, error: subErr } = await supabase
      .from('form_submission')
      .select('id, submission_data')
      .eq('id', submissionId)
      .eq('tenant_id', tenantId)
      .single();

    if (subErr || !submission) {
      const msg = `Failed to re-fetch submission: ${subErr?.message || 'not found'}`;
      err(`  -> FAILED: ${msg}`);
      failedCount++;
      results.push({
        submission_id: submissionId,
        applicant_email: row.applicant_email,
        extracted_org_name: row.extracted_org_name,
        outcome: 'failed',
        organization_id: '',
        error: msg,
      });
      continue;
    }

    // Re-extract the org name from the freshly-fetched submission_data — the
    // dry-run snapshot may be stale.
    const orgName = extractOrgNameFromSubmission(submission, orgNameFieldId)
      || row.extracted_org_name
      || '';

    if (!orgName) {
      const msg = 'No organisation name could be extracted from submission_data';
      err(`  -> FAILED: ${msg}`);
      failedCount++;
      results.push({
        submission_id: submissionId,
        applicant_email: row.applicant_email,
        extracted_org_name: row.extracted_org_name,
        outcome: 'failed',
        organization_id: '',
        error: msg,
      });
      continue;
    }

    // ---- Tenant-safe org id resolution ---------------------------------
    // We MUST pass prefill_organization_id to process-application so that it
    // does an id-based lookup rather than its unscoped ilike-by-name lookup,
    // which would risk linking a tenant A submission to a tenant B org.
    let prefillOrgId = '';
    let preExistingMatch = false;
    let preCreatedStubId = ''; // tracked so we can roll back the stub on failure

    const tenantMatch = await verifyTenantNameMatch(orgName, tenantId);
    if (tenantMatch) {
      prefillOrgId = tenantMatch.id;
      preExistingMatch = true;
      log(`  · same-tenant name match found — will link to org ${prefillOrgId}`);
    } else {
      const newId = await preCreateTenantOrg(orgName, tenantId);
      if (!newId) {
        const msg = 'Failed to pre-create tenant-stamped organisation stub';
        err(`  -> FAILED: ${msg}`);
        failedCount++;
        results.push({
          submission_id: submissionId,
          applicant_email: row.applicant_email,
          extracted_org_name: orgName,
          outcome: 'failed',
          organization_id: '',
          error: msg,
        });
        continue;
      }
      prefillOrgId = newId;
      preCreatedStubId = newId;
      log(`  · pre-created tenant-stamped org ${prefillOrgId}`);
    }

    // Build the same payload the public submission endpoint would send.
    // Notably we do NOT pass submission_id (the handler short-circuits on
    // already-processed submissions via processed_at). We DO pass
    // prefill_organization_id so the handler uses our verified/pre-created
    // tenant-safe id and skips its unscoped name lookup.
    const payload = {
      form_id: form.id,
      form_values: submission.submission_data || {},
      fields: form.fields || [],
      field_mappings: form.field_mappings || [],
      application_level: form.application_level || 'member',
      entity_pipelines: form.entity_pipelines || {},
      tenant_id: tenantId,
      prefill_organization_id: prefillOrgId,
    };

    let outcome = 'failed';
    let resolvedOrgId = '';
    let errorMsg = '';

    try {
      const { statusCode, body } = await callProcessApplication(handler, payload);

      if (statusCode >= 200 && statusCode < 300 && body && body.success) {
        // organization_id is canonical (created or matched-existing).
        resolvedOrgId = body.organization_id || body.created_organization_id || '';
        if (!resolvedOrgId) {
          outcome = 'failed';
          errorMsg = 'Pipeline returned no organization_id';
        } else if (resolvedOrgId !== prefillOrgId) {
          // Defensive: if for any reason the handler resolved to a different
          // org id than the prefill we passed, treat it as a failure rather
          // than silently linking somewhere unexpected.
          outcome = 'failed';
          errorMsg = `Handler returned unexpected org id ${resolvedOrgId} (expected ${prefillOrgId})`;
        } else {
          outcome = preExistingMatch ? 'linked_existing' : 'created';
        }
      } else {
        outcome = 'failed';
        errorMsg = body?.error || `Pipeline returned status ${statusCode}`;
      }
    } catch (e) {
      outcome = 'failed';
      errorMsg = e?.message || String(e);
    }

    // Tenant safety post-condition: the resolved org MUST belong to TENANT_ID.
    // If not, refuse to write back and record a failure.
    if (outcome !== 'failed' && resolvedOrgId) {
      const { data: verifyOrg, error: verifyErr } = await supabase
        .from('organization')
        .select('id, tenant_id')
        .eq('id', resolvedOrgId)
        .single();
      if (verifyErr || !verifyOrg || verifyOrg.tenant_id !== tenantId) {
        outcome = 'failed';
        errorMsg = `Resolved org ${resolvedOrgId} tenant_id=${verifyOrg?.tenant_id || 'unknown'} does not match target tenant ${tenantId}`;
        resolvedOrgId = '';
      }
    }

    if (outcome !== 'failed' && resolvedOrgId) {
      // Write the resulting organization_id back onto the form_submission row.
      // (We didn't pass submission_id to the handler so it didn't update this
      // for us.)
      const { error: updErr } = await supabase
        .from('form_submission')
        .update({ organization_id: resolvedOrgId })
        .eq('id', submissionId)
        .eq('tenant_id', tenantId);
      if (updErr) {
        outcome = 'failed';
        errorMsg = `Updated org but failed to write back to form_submission: ${updErr.message}`;
        resolvedOrgId = '';
      }
    }

    // If we pre-created a tenant-stamped stub but the apply ultimately
    // failed (handler error, mismatched id, post-condition rejection,
    // form_submission update failure), try to roll the stub back so we
    // do not leak orphan organisation rows. If deletion is blocked
    // (e.g. by FK references the handler created on the stub before
    // failing), we leave it behind and surface a warning in the report.
    if (outcome === 'failed' && preCreatedStubId) {
      const { error: delErr } = await supabase
        .from('organization')
        .delete()
        .eq('id', preCreatedStubId)
        .eq('tenant_id', tenantId);
      if (delErr) {
        warn(`  ! could not roll back pre-created stub ${preCreatedStubId}: ${delErr.message}`);
        errorMsg = `${errorMsg} | orphan stub ${preCreatedStubId} could not be deleted: ${delErr.message}`;
      } else {
        log(`  · rolled back pre-created stub ${preCreatedStubId}`);
      }
    }

    if (outcome === 'created') {
      createdCount++;
      log(`  -> CREATED org ${resolvedOrgId}`);
    } else if (outcome === 'linked_existing') {
      linkedCount++;
      log(`  -> LINKED existing org ${resolvedOrgId}`);
    } else {
      failedCount++;
      err(`  -> FAILED: ${errorMsg}`);
    }

    results.push({
      submission_id: submissionId,
      applicant_email: row.applicant_email,
      extracted_org_name: row.extracted_org_name,
      outcome,
      organization_id: resolvedOrgId,
      error: errorMsg,
    });
  }

  return { results, createdCount, linkedCount, failedCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log('='.repeat(70));
  log('Recreate missing organisations from form submissions');
  log('='.repeat(70));
  log(`Connecting to: ${supabaseHost}`);
  log(`URL source:    ${supabaseUrlSource}`);
  log(`Key source:    ${supabaseKeySource}`);
  log(`Tenant id:     ${TENANT_ID}`);
  log(`Form id:       ${FORM_ID}`);
  log(`Mode:          ${APPLY ? 'APPLY (will reprocess)' : 'DRY RUN (no changes)'}`);
  log('');

  // 1. Pre-flight schema sanity check — abort loudly if we are pointed at a
  //    non-multi-tenant DB before touching any data.
  await assertMultiTenantSchema();

  // 2. Pre-flight workflow audit (always runs, in both dry-run and apply mode)
  await auditWorkflowsOff(TENANT_ID);

  // 3. Fetch form
  const form = await fetchForm(FORM_ID, TENANT_ID);
  log(`[form] Loaded "${form.title || form.name || form.id}"`);

  const orgNameFieldId = resolveOrgNameSourceFieldId(form);
  if (!orgNameFieldId) {
    warn('[form] Could not resolve which form field supplies organisation.name. The dry-run will still scan submissions but extracted_org_name will be blank for every row, and apply mode will likely fail with MISSING_ORG_NAME for every flagged submission.');
  } else {
    log(`[form] Organisation name source field id: ${orgNameFieldId}`);
  }

  // 4. Build the missing-org report
  const stats = await buildFlaggedRows(form, TENANT_ID, orgNameFieldId);

  // 5. Always write the dry-run CSV
  const ts = timestamp();
  const dryRunPath = path.join('tmp', `missing-orgs-dry-run-${ts}.csv`);
  writeCsv(dryRunPath, stats.flagged, [
    'submission_id',
    'created_date',
    'applicant_name',
    'applicant_email',
    'extracted_org_name',
    'missing_reason',
    'matched_existing_org_id',
    'matched_existing_org_name',
  ]);
  log(`[csv] Dry-run report written: ${dryRunPath}`);

  printSummary(stats);

  if (!APPLY) {
    log('\nDry-run complete. Re-run with --apply to reprocess flagged submissions.');
    return;
  }

  if (stats.flagged.length === 0) {
    log('\nNothing to reprocess — no flagged submissions.');
    return;
  }

  // 6. Apply path
  log('\n=== Apply: reprocessing flagged submissions ===');
  const applyResult = await applyReprocessing(form, TENANT_ID, stats.flagged, orgNameFieldId);

  const applyPath = path.join('tmp', `missing-orgs-apply-${ts}.csv`);
  writeCsv(applyPath, applyResult.results, [
    'submission_id',
    'applicant_email',
    'extracted_org_name',
    'outcome',
    'organization_id',
    'error',
  ]);
  log(`\n[csv] Post-run report written: ${applyPath}`);

  log('\n=== Apply summary ===');
  log(`Created new organisations:  ${applyResult.createdCount}`);
  log(`Linked to existing orgs:    ${applyResult.linkedCount}`);
  log(`Failed:                     ${applyResult.failedCount}`);

  if (applyResult.failedCount > 0) {
    err(`\n${applyResult.failedCount} submission(s) failed. See ${applyPath} for details.`);
    process.exit(3);
  }
}

main().catch(e => {
  err('Script failed:', e);
  process.exit(1);
});
