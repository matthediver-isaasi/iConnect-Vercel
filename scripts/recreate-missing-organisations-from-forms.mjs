#!/usr/bin/env node
/**
 * Recreate missing organisations from form submissions (and re-link DD submissions)
 * =================================================================================
 *
 * Who this is for:
 *   Admin / engineering only. Use this after a Zoho CRM <-> iConnect sync issue
 *   has wiped organisation rows but the original `form_submission` records are
 *   intact and can be reprocessed to recreate them.
 *
 * What it does:
 *   Step A — Application form (existing behaviour):
 *     For a given tenant + form, finds every form_submission whose linked
 *     organisation no longer exists (NULL organization_id, dangling FK, or
 *     wrong-tenant org), reports them as a CSV (dry-run) and, with --apply,
 *     reprocesses each flagged submission through the SAME entity pipeline used
 *     by api/forms/process-application.js. Each flagged submission either:
 *       - creates a new organisation (and writes back form_submission.organization_id), or
 *       - links to an existing organisation whose name matches case-insensitively, or
 *       - fails (and is logged in the post-run CSV; the batch continues).
 *
 *   Step B — Due Diligence submissions:
 *     After the application form is processed, the script also scans every Due
 *     Diligence form configured for the tenant (auto-discovered via
 *     `form_due_diligence_config`) and finds DD submissions whose organisation
 *     is missing/dangling/wrong-tenant. For each flagged DD submission it tries
 *     to resolve a target organisation by joining on the applicant email shared
 *     with the application form (most recent application submission wins on a
 *     tie). With --apply it always updates `form_submission.organization_id`
 *     and ALSO overwrites the DD form's "Name of organisation" key inside
 *     `submission_data` with the resolved organisation id (replacing the stale
 *     invalid UUID or free-text value). The target field is resolved per DD
 *     form, in order:
 *       1. configured                       — form_due_diligence_config.applicant_organization_name_field
 *       2. label_match                      — field whose label equals "name of organisation"
 *       3. type_organisation_dropdown       — first field whose type === 'organisation_dropdown'
 *     `organisation_dropdown` is single-purpose (its value semantics ARE "an
 *     organisation id"), so the type-based fallback is on by default — unlike
 *     the email resolver, which has --allow-dd-email-type-fallback because DD
 *     forms typically have several email-shaped fields (CEO, point of contact,
 *     safeguarding lead, etc.). When even that fallback finds nothing, the
 *     script links by `organization_id` only and leaves `submission_data`
 *     untouched. Both column updates (when applicable) happen in a single
 *     update per submission so the row never lands in a partially-updated
 *     state.
 *     Two extra reports are written:
 *       tmp/missing-dd-orgs-dry-run-<ts>.csv  (always)
 *       tmp/missing-dd-orgs-apply-<ts>.csv    (only with --apply)
 *     A `submission_data_patched` column on both reports records, per row,
 *     whether the `submission_data` patch is applicable (`yes` / `no`); an
 *     `org_field_source` column records which resolution rule above produced
 *     the field id used for the patch.
 *     DD submissions whose applicant email does not match any application
 *     submission, or whose matched application submission has no valid
 *     organisation, are reported as `no_application_match` /
 *     `application_org_unresolved` and the run continues.
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
 *   # Dry run (no DB changes). Always writes both:
 *   #   tmp/missing-orgs-dry-run-<ts>.csv         (Step A — applications)
 *   #   tmp/missing-dd-orgs-dry-run-<ts>.csv      (Step B — DD submissions)
 *   node scripts/recreate-missing-organisations-from-forms.mjs
 *
 *   # Apply. Writes the dry-run CSVs above plus:
 *   #   tmp/missing-orgs-apply-<ts>.csv           (Step A — applications)
 *   #   tmp/missing-dd-orgs-apply-<ts>.csv        (Step B — DD submissions)
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
      'allow-dd-email-type-fallback': { type: 'boolean', default: false },
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
// Off by default: in apply mode this fallback could mis-link DD submissions
// to the wrong organisation if a DD form has multiple email-type fields
// (CEO, point of contact, safeguarding, etc.) and no exact "Applicant
// email" label or member.email core mapping. Operators can opt in for
// dry-run inspection via --allow-dd-email-type-fallback.
const ALLOW_DD_EMAIL_TYPE_FALLBACK = !!parsed.values['allow-dd-email-type-fallback'];

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

// Re-export the chosen credentials onto the canonical SUPABASE_URL /
// SUPABASE_SERVICE_KEY env vars BEFORE we dynamically import any
// `api/forms/*` handler in apply mode. Those handlers (e.g.
// `api/forms/process-application.js`) build their own Supabase client at
// module-load time directly from `process.env.SUPABASE_URL` /
// `process.env.SUPABASE_SERVICE_KEY`. Without this override the apply
// path silently splits brain across two databases — this script reads
// from the resolved tier (typically DEV_SUPABASE_*) but the AppProcessor
// writes to the legacy SUPABASE_* snapshot, which on this Repl is a
// pre-multi-tenancy database missing `organization.tenant_id` and other
// columns. Symptom is a PGRST204 "Could not find the 'tenant_id'
// column of 'organization' in the schema cache" error during org
// creation. We force both clients to point at the same DB by mirroring
// the chosen tier's credentials onto SUPABASE_URL / SUPABASE_SERVICE_KEY
// here, even when the chosen tier already IS SUPABASE_* (idempotent).
process.env.SUPABASE_URL = supabaseUrl;
process.env.SUPABASE_SERVICE_KEY = supabaseServiceKey;

function printUsageAndExit(code) {
  console.log(`Usage: node scripts/recreate-missing-organisations-from-forms.mjs [options]

Options:
  --tenant-id=<uuid>            Tenant id (default ${DEFAULT_TENANT_ID})
  --form-id=<uuid>              Form id   (default ${DEFAULT_FORM_ID})
  --supabase-url=<url>          Override Supabase project URL
  --supabase-service-key=<key>  Override Supabase service role key
  --apply                       Reprocess flagged submissions (otherwise dry-run only)
  --allow-dd-email-type-fallback
                                When a DD form has no configured applicant_email_field,
                                no field labelled "Applicant email", and no field with
                                core_field_mapping=member.email, allow falling back to
                                the first field of type "email" on the form. OFF by
                                default because this can mis-link to CEO / point-of-contact
                                / safeguarding email fields. Use only after auditing the
                                dry-run logs.
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
    .select('id, name, tenant_id, fields, entity_pipelines, field_mappings, application_level')
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

/**
 * Find which form-field id supplies the applicant email on the application
 * form. The `form_submission.submitted_by_email` *column* is frequently NULL
 * for these submissions (see e.g. tenant 21296ad6 / form 3c4124e1 — 0 of 102
 * rows had it set, but every row had the email in submission_data under the
 * "Your Email" field). Without this resolution Step B's email->org map is
 * empty and the DD-linking pass cannot match anything.
 *
 * Resolution order:
 *   1. entity_pipelines.members primary mappings -> core member.email
 *   2. legacy field_mappings array -> target_entity=member, target_field=email
 *   3. per-field core_field_mapping = 'member.email'
 *   4. first form field of type === 'email'
 */
function resolveApplicantEmailSourceFieldId(form) {
  const memberPipelines = form?.entity_pipelines?.members || [];
  const primary = memberPipelines.find(o => o.isPrimary || o.is_primary) || memberPipelines[0];
  if (primary?.mappings && Array.isArray(primary.mappings)) {
    const m = primary.mappings.find(
      x => x?.target_type === 'core' && x?.target_field === 'email' && x?.source_field_id
    );
    if (m) return m.source_field_id;
  }

  if (Array.isArray(form?.field_mappings)) {
    const m = form.field_mappings.find(
      x => x?.target_type === 'core' && x?.target_entity === 'member'
        && x?.target_field === 'email' && x?.source_field_id
    );
    if (m) return m.source_field_id;
  }

  if (Array.isArray(form?.fields)) {
    const f = form.fields.find(x => x?.core_field_mapping === 'member.email');
    if (f) return f.id;
    const e = form.fields.find(x => x?.type === 'email' && x?.id);
    if (e) return e.id;
  }

  return null;
}

/**
 * Extract the applicant email for an application-form submission. Prefer the
 * configured email field inside submission_data; fall back to the
 * submitted_by_email column. Returns null if neither yields a non-empty
 * string.
 */
function extractApplicantEmailFromSubmission(submission, emailFieldId) {
  const data = submission.submission_data || {};
  if (emailFieldId) {
    const v = data[emailFieldId];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const col = submission.submitted_by_email;
  if (typeof col === 'string' && col.trim()) return col.trim();
  return null;
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
      .select('id, created_date, submitted_by_name, submitted_by_email, organization_id, submission_data')
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

async function buildFlaggedRows(form, tenantId, orgNameFieldId, emailFieldId) {
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
    // applicant_email is resolved using the same submission_data-first /
    // submitted_by_email-fallback logic Step B uses, so the dry-run CSV
    // surfaces a real email even when the column is NULL (which it is for
    // the application form on tenant 21296ad6, all 102 of 102 rows).
    const applicantEmail = extractApplicantEmailFromSubmission(s, emailFieldId) || '';
    flagged.push({
      submission_id: s.id,
      created_date: s.created_date,
      applicant_name: s.submitted_by_name || '',
      applicant_email: applicantEmail,
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
    // Returned so the DD-linking step can build an email->org map without
    // re-scanning the application form. `orgMap` only contains rows referenced
    // by some application submission, but that is exactly what we need for
    // valid (non-flagged) submissions.
    submissions,
    orgMap,
  };
}

// ---------------------------------------------------------------------------
// DD-linking helpers (Step B)
// ---------------------------------------------------------------------------

/**
 * Auto-discover all Due Diligence forms for the tenant. Returns
 *   [{ form, config }]
 * for every form_due_diligence_config row whose joined `form` row exists for
 * the same tenant. Forms missing `applicant_organization_name_field` are
 * still returned — for those, the apply step links by `organization_id`
 * only and skips the optional `submission_data` patch. An informational log
 * line records which mode each form will use.
 */
async function discoverDDForms(tenantId) {
  const { data: configs, error } = await supabase
    .from('form_due_diligence_config')
    .select('id, form_id, applicant_email_field, applicant_organization_name_field')
    .eq('tenant_id', tenantId);
  if (error) {
    err('Failed to query form_due_diligence_config:', error.message);
    process.exit(1);
  }
  if (!configs || configs.length === 0) {
    log('[dd discovery] No form_due_diligence_config rows for tenant — nothing to scan.');
    return [];
  }

  const formIds = Array.from(new Set(configs.map(c => c.form_id).filter(Boolean)));
  const formMap = new Map();
  if (formIds.length > 0) {
    const { data: forms, error: formErr } = await supabase
      .from('form')
      .select('id, name, fields, tenant_id')
      .in('id', formIds)
      .eq('tenant_id', tenantId);
    if (formErr) {
      err('Failed to fetch DD forms:', formErr.message);
      process.exit(1);
    }
    for (const f of forms || []) formMap.set(f.id, f);
  }

  const result = [];
  for (const config of configs) {
    const form = formMap.get(config.form_id);
    if (!form) {
      warn(`[dd discovery] DD config ${config.id} references form ${config.form_id} which is missing or belongs to a different tenant; skipping`);
      continue;
    }
    log(`[dd discovery] DD form "${form.name || form.id}" (${form.id})`);

    // Resolve where the "Name of organisation" dropdown actually lives on this
    // DD form. The DB-stored DD config has applicant_organization_name_field
    // unset on the GSF tenant, so fall back to a label match ("Name of
    // organisation") and finally to the first organisation_dropdown-typed
    // field. The type-based fallback is on by default — that field type is
    // single-purpose, so picking it cannot mis-link to an unrelated email-like
    // field.
    const { fieldId: effectiveOrgFieldId, source: orgFieldSource } =
      resolveDDApplicantOrgFieldId(form, config);
    if (effectiveOrgFieldId) {
      log(`[dd discovery]   "Name of organisation" field: submission_data["${effectiveOrgFieldId}"] (resolver=${orgFieldSource}) — apply will overwrite this with the resolved org id and also set organization_id`);
    } else {
      warn(`[dd discovery]   no "Name of organisation" field could be resolved on this form (no DD-config field, no "name of organisation" label, no organisation_dropdown-typed field) — apply will set organization_id only and leave submission_data untouched`);
    }

    // Resolve where the applicant email actually lives on this DD form.
    // The DB-stored DD config may not have applicant_email_field set, and
    // form_submission.submitted_by_email is frequently NULL on these rows
    // too, so fall back to a narrow label/core-mapping heuristic over the
    // form fields. The bare type:'email' fallback is opt-in (see
    // --allow-dd-email-type-fallback) because it can mis-link to CEO /
    // point-of-contact / safeguarding email fields on multi-email DD forms.
    const { fieldId: effectiveApplicantEmailFieldId, source: emailSource } =
      resolveDDApplicantEmailFieldId(form, config, { allowTypeFallback: ALLOW_DD_EMAIL_TYPE_FALLBACK });
    if (effectiveApplicantEmailFieldId) {
      log(`[dd discovery]   applicant email source: submission_data["${effectiveApplicantEmailFieldId}"] (resolver=${emailSource}), with submitted_by_email column as fallback`);
      if (emailSource === 'type_email_fallback') {
        warn(`[dd discovery]   WARNING: chose first type:'email' field on this form. If the DD form has multiple email fields (CEO / POC / safeguarding) this may mis-link. Audit the dry-run CSV before running --apply.`);
      }
    } else if (emailSource === 'unresolved_type_fallback_disabled') {
      warn(`[dd discovery]   no configured / "Applicant email"-labelled / member.email-mapped field on this form. A type:'email' field exists but was NOT used (pass --allow-dd-email-type-fallback to opt in after auditing). Falling back to the submitted_by_email column only.`);
    } else {
      warn(`[dd discovery]   no applicant email source resolvable on this form — will rely on submitted_by_email column only`);
    }

    result.push({ form, config, effectiveApplicantEmailFieldId, emailSource, effectiveOrgFieldId, orgFieldSource });
  }
  log(`[dd discovery] ${result.length} DD form(s) eligible for re-linking (out of ${configs.length} config row(s))`);
  return result;
}

/**
 * Find which form-field id supplies the applicant email on a Due Diligence
 * form, and explain how it was chosen. Resolution order:
 *   1. Whatever the DD config explicitly says (form_due_diligence_config.applicant_email_field).
 *   2. A field on the DD form whose label equals "applicant email" (case-insensitive).
 *   3. A field whose core_field_mapping = 'member.email'.
 *   4. (OPT-IN) The first field with type === 'email', only if
 *      `allowTypeFallback` is true.
 * Returns { fieldId, source } where source ∈
 *   'configured' | 'label_match' | 'core_field_mapping' |
 *   'type_email_fallback' | 'unresolved' | 'unresolved_type_fallback_disabled'.
 * fieldId is null when source starts with 'unresolved'; the caller will
 * then rely on the submitted_by_email column.
 *
 * The label match is intentionally narrow — DD forms typically have several
 * email-shaped fields (CEO, point of contact, safeguarding lead, etc.) that
 * we MUST NOT pick by accident. The bare "first email field" fallback is
 * therefore disabled by default and only enabled via
 * --allow-dd-email-type-fallback after the operator has audited the
 * dry-run logs.
 */
function resolveDDApplicantEmailFieldId(form, ddConfig, { allowTypeFallback = false } = {}) {
  if (ddConfig?.applicant_email_field) {
    return { fieldId: ddConfig.applicant_email_field, source: 'configured' };
  }
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  if (fields.length === 0) return { fieldId: null, source: 'unresolved' };

  const labelMatch = fields.find(f => {
    const label = (f?.label || f?.name || '').trim().toLowerCase();
    return label === 'applicant email';
  });
  if (labelMatch?.id) return { fieldId: labelMatch.id, source: 'label_match' };

  const coreMatch = fields.find(f => f?.core_field_mapping === 'member.email');
  if (coreMatch?.id) return { fieldId: coreMatch.id, source: 'core_field_mapping' };

  const typeMatch = fields.find(f => f?.type === 'email' && f?.id);
  if (typeMatch?.id) {
    if (allowTypeFallback) {
      return { fieldId: typeMatch.id, source: 'type_email_fallback' };
    }
    return { fieldId: null, source: 'unresolved_type_fallback_disabled' };
  }

  return { fieldId: null, source: 'unresolved' };
}

/**
 * Find which form-field id supplies the "Name of organisation" dropdown on a
 * Due Diligence form, and explain how it was chosen. Resolution order:
 *   1. Whatever the DD config explicitly says
 *      (form_due_diligence_config.applicant_organization_name_field).
 *   2. A field whose label equals "name of organisation" (case-insensitive).
 *   3. The first field whose type === 'organisation_dropdown'.
 * Returns { fieldId, source } where source ∈
 *   'configured' | 'label_match' | 'type_organisation_dropdown' | 'unresolved'.
 * fieldId is null when source === 'unresolved'; the apply step will then skip
 * the submission_data patch for that form (as it does today for forms with no
 * configured org-name field).
 *
 * Unlike the email resolver, the type-based fallback here is on by default.
 * `organisation_dropdown` is single-purpose: its semantics are "this field
 * holds an organisation id". DD forms typically have at most one such field,
 * so picking it by type is safe even when the label has been customised.
 */
function resolveDDApplicantOrgFieldId(form, ddConfig) {
  if (ddConfig?.applicant_organization_name_field) {
    return { fieldId: ddConfig.applicant_organization_name_field, source: 'configured' };
  }
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  if (fields.length === 0) return { fieldId: null, source: 'unresolved' };

  const labelMatch = fields.find(f => {
    const label = (f?.label || f?.name || '').trim().toLowerCase();
    return label === 'name of organisation';
  });
  if (labelMatch?.id) return { fieldId: labelMatch.id, source: 'label_match' };

  const typeMatch = fields.find(f => f?.type === 'organisation_dropdown' && f?.id);
  if (typeMatch?.id) return { fieldId: typeMatch.id, source: 'type_organisation_dropdown' };

  return { fieldId: null, source: 'unresolved' };
}

/**
 * Extract the applicant email for a DD submission. Prefer the resolved
 * `applicantEmailFieldId` value inside submission_data; fall back to
 * `submitted_by_email` on the submission row itself.
 */
function getDDApplicantEmail(submission, applicantEmailFieldId) {
  const data = submission.submission_data || {};
  if (applicantEmailFieldId) {
    const v = data[applicantEmailFieldId];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (typeof submission.submitted_by_email === 'string' && submission.submitted_by_email.trim()) {
    return submission.submitted_by_email.trim();
  }
  return null;
}

/**
 * Read the current value of the DD form's "Name of Organisation" field on the
 * submission. After the incident this typically holds an invalid org UUID; in
 * historically-clean rows it tends to hold a free-text org name. Returned as
 * a string for reporting; objects/arrays are JSON-stringified.
 *
 * `orgFieldId` is the resolver's chosen field id (configured / label_match /
 * type_organisation_dropdown). When the resolver returned `unresolved`, the
 * caller passes null and we report no value.
 */
function getDDOrgFieldRawValue(submission, orgFieldId) {
  if (!orgFieldId) return null;
  const data = submission.submission_data || {};
  const v = data[orgFieldId];
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Scan one DD form for missing/dangling organisation links — same three checks
 * the application-form scan uses. Returns flagged rows annotated with the
 * applicant email and the current invalid org-field value.
 */
async function scanDDForMissingOrgs(ddForm, ddConfig, tenantId, applicantEmailFieldId, applicantEmailFieldSource, orgFieldId, orgFieldSource) {
  const submissions = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('form_submission')
      .select('id, created_date, submitted_by_email, organization_id, submission_data')
      .eq('form_id', ddForm.id)
      .eq('tenant_id', tenantId)
      .order('created_date', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      err(`Failed to fetch DD form_submission rows for ${ddForm.id}:`, error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    submissions.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

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
    flagged.push({
      dd_form_id: ddForm.id,
      dd_form_name: ddForm.name || '',
      submission_id: s.id,
      created_date: s.created_date,
      applicant_email: getDDApplicantEmail(s, applicantEmailFieldId) || '',
      // Provenance of the per-form email-field resolution. Constant for
      // every row from the same DD form, but per-row makes the CSV
      // self-contained for auditing without cross-referencing logs.
      email_source: applicantEmailFieldSource || '',
      current_invalid_org_field_value: getDDOrgFieldRawValue(s, orgFieldId) || '',
      missing_reason: reason,
      // Carried through so the apply step knows which key in submission_data
      // to overwrite. Comes from the resolver (configured / label_match /
      // type_organisation_dropdown), NOT directly from the DD config — many
      // DD configs have applicant_organization_name_field unset even when
      // the form does have a "Name of organisation" dropdown. Empty when
      // the resolver returned 'unresolved', in which case the apply step
      // skips the submission_data patch for this row.
      applicant_organization_name_field: orgFieldId || null,
      // Provenance of the per-form org-field resolution. Mirrors email_source
      // so an operator auditing the dry-run CSV can tell at a glance how the
      // patch target was discovered.
      org_field_source: orgFieldSource || '',
    });
  }
  return { totalSubmissions: submissions.length, validCount, flagged };
}

/**
 * Build a map keyed by lowercased applicant email -> resolution metadata,
 * derived from the application form's submissions. The "resolved" org id per
 * application submission depends on mode:
 *   - Always-valid submissions:    use their existing organization_id.
 *   - Flagged-but-applied (apply): use the apply result's organization_id.
 *   - Flagged-and-not-applied (dry-run): use the flagged row's
 *     matched_existing_org_id when present (would-link path); CREATE-path
 *     submissions stay unresolved in dry-run mode (we cannot guess what the
 *     pipeline would invent), and DD rows pointing at them will be reported
 *     as application_org_unresolved.
 *
 * When several application submissions share an email, the most recent one
 * with a resolved org wins. The total count of matching submissions is kept
 * so the dry-run CSV can record "picked most recent of N matching".
 */
function buildEmailToOrgMap({ submissions, flagged, applyResultsById, orgMap, tenantId, applyMode, emailFieldId }) {
  const flaggedById = new Map(flagged.map(f => [f.submission_id, f]));
  const perEmail = new Map();

  for (const s of submissions) {
    // Same resolution as the dry-run row: prefer submission_data[emailFieldId]
    // (which is where the application form actually stores it for this
    // tenant), fall back to the submitted_by_email column. Without this the
    // map ends up empty for any application form that doesn't populate the
    // column (e.g. "Initial enquiry" on tenant 21296ad6 — 0 of 102 rows).
    const rawEmail = extractApplicantEmailFromSubmission(s, emailFieldId);
    if (!rawEmail) continue;
    const email = rawEmail.toLowerCase();

    let resolvedOrgId = null;
    if (!flaggedById.has(s.id)) {
      // Pre-existing valid submission. Org was confirmed tenant-owned during
      // buildFlaggedRows, otherwise it would have been flagged.
      const org = orgMap.get(s.organization_id);
      if (org && org.tenant_id === tenantId) resolvedOrgId = org.id;
    } else if (applyMode && applyResultsById) {
      const r = applyResultsById.get(s.id);
      if (r && (r.outcome === 'created' || r.outcome === 'linked_existing') && r.organization_id) {
        resolvedOrgId = r.organization_id;
      }
    } else {
      // Dry-run: only the would-link branch produces a known org id.
      const f = flaggedById.get(s.id);
      if (f && f.matched_existing_org_id) resolvedOrgId = f.matched_existing_org_id;
    }

    let bucket = perEmail.get(email);
    if (!bucket) { bucket = []; perEmail.set(email, bucket); }
    bucket.push({
      submission_id: s.id,
      created_date: s.created_date,
      resolved_organization_id: resolvedOrgId,
    });
  }

  const result = new Map();
  for (const [email, entries] of perEmail) {
    entries.sort((a, b) => {
      const da = a.created_date ? new Date(a.created_date).getTime() : 0;
      const db = b.created_date ? new Date(b.created_date).getTime() : 0;
      return db - da;
    });
    const valid = entries.filter(e => e.resolved_organization_id);
    if (valid.length === 0) {
      result.set(email, {
        organization_id: null,
        application_submission_id: null,
        total_application_matches: entries.length,
        total_resolved_matches: 0,
      });
      continue;
    }
    const chosen = valid[0];
    result.set(email, {
      organization_id: chosen.resolved_organization_id,
      application_submission_id: chosen.submission_id,
      total_application_matches: entries.length,
      total_resolved_matches: valid.length,
    });
  }
  return result;
}

/**
 * For each flagged DD row, look the applicant email up in the email->org map
 * and assign one of: linkable, no_application_match, application_org_unresolved.
 * Returns rows ready for the dry-run CSV (and the apply loop).
 */
function resolveDDFlagsAgainstMap(ddFlaggedRows, emailMap, orgNameMap) {
  const out = [];
  for (const row of ddFlaggedRows) {
    // Per-row prediction of whether the apply step would also patch
    // submission_data. `applicant_organization_name_field` here comes from
    // the resolver (configured / label_match / type_organisation_dropdown),
    // not from the raw DD config — so on the GSF tenant where the DD
    // configs leave that column NULL, the label/type fallbacks still let
    // us patch the dropdown. Empty for non-linkable outcomes (since no
    // apply update would happen).
    const willPatchSubmissionData = row.applicant_organization_name_field ? 'yes' : 'no';

    const email = (row.applicant_email || '').trim().toLowerCase();
    if (!email) {
      out.push({
        ...row,
        outcome: 'no_application_match',
        resolved_organization_id: '',
        resolved_organization_name: '',
        application_submission_id: '',
        submission_data_patched: '',
        notes: 'DD submission has no applicant email (neither configured field nor submitted_by_email)',
      });
      continue;
    }
    const entry = emailMap.get(email);
    if (!entry) {
      out.push({
        ...row,
        outcome: 'no_application_match',
        resolved_organization_id: '',
        resolved_organization_name: '',
        application_submission_id: '',
        submission_data_patched: '',
        notes: '',
      });
      continue;
    }
    if (!entry.organization_id) {
      out.push({
        ...row,
        outcome: 'application_org_unresolved',
        resolved_organization_id: '',
        resolved_organization_name: '',
        application_submission_id: '',
        submission_data_patched: '',
        notes: entry.total_application_matches > 1
          ? `${entry.total_application_matches} matching application submission(s), none resolved to a valid organisation in this run`
          : 'Matching application submission has no valid organisation in this run',
      });
      continue;
    }
    const tieNote = entry.total_application_matches > 1
      ? `picked most recent of ${entry.total_application_matches} matching application submission(s) (${entry.total_resolved_matches} had a resolved org)`
      : '';
    const patchNote = willPatchSubmissionData === 'no'
      ? 'organization_id only — no "Name of organisation" field could be resolved on this DD form, submission_data will not be patched'
      : '';
    const notes = [tieNote, patchNote].filter(Boolean).join(' | ');
    out.push({
      ...row,
      outcome: 'linkable',
      resolved_organization_id: entry.organization_id,
      resolved_organization_name: orgNameMap.get(entry.organization_id) || '',
      application_submission_id: entry.application_submission_id || '',
      submission_data_patched: willPatchSubmissionData,
      notes,
    });
  }
  return out;
}

/**
 * Apply DD linking: for each `linkable` row, re-verify the resolved org is
 * still valid for the tenant, then update `form_submission.organization_id`.
 * If the row carries a resolved `applicant_organization_name_field` (set
 * upstream by `resolveDDApplicantOrgFieldId` — configured / label_match /
 * type_organisation_dropdown), the same UPDATE also patches that key inside
 * `submission_data` to hold the resolved org id (replacing the stale invalid
 * UUID or free-text value); otherwise `submission_data` is left untouched.
 * Either way the column updates happen in a SINGLE update per row, so the
 * row never lands in a partially-updated state. On any failure the row is
 * left untouched and the run continues.
 */
async function applyDDLinking(resolvedDDRows, tenantId) {
  const results = [];
  let linkedCount = 0;
  let noMatchCount = 0;
  let unresolvedCount = 0;
  let failedCount = 0;

  for (const row of resolvedDDRows) {
    // Carry the tie-resolution metadata from the dry-run pass into the apply
    // CSV so the operator can audit which application submission was chosen
    // (and why) without having to cross-reference the dry-run report.
    const baseRecord = {
      dd_form_id: row.dd_form_id,
      submission_id: row.submission_id,
      applicant_email: row.applicant_email,
      // Mirror the dry-run CSV columns so the apply artifact is fully
      // self-contained for audit (no need to cross-reference logs).
      email_source: row.email_source || '',
      org_field_source: row.org_field_source || '',
      application_submission_id: row.application_submission_id || '',
      notes: row.notes || '',
    };

    if (row.outcome === 'no_application_match') {
      noMatchCount++;
      results.push({ ...baseRecord, outcome: 'no_application_match', organization_id: '', submission_data_patched: '', error: '' });
      continue;
    }
    if (row.outcome === 'application_org_unresolved') {
      unresolvedCount++;
      results.push({ ...baseRecord, outcome: 'application_org_unresolved', organization_id: '', submission_data_patched: '', error: '' });
      continue;
    }

    log(`\n[dd apply] Submission ${row.submission_id} (${row.applicant_email}) -> org ${row.resolved_organization_id} on form "${row.dd_form_name}"`);

    // Re-verify resolved organisation still exists and is tenant-owned.
    const { data: org, error: orgErr } = await supabase
      .from('organization')
      .select('id, tenant_id')
      .eq('id', row.resolved_organization_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (orgErr || !org) {
      const msg = `Resolved org ${row.resolved_organization_id} not found or wrong tenant: ${orgErr?.message || 'not found for tenant'}`;
      err(`  -> FAILED: ${msg}`);
      failedCount++;
      results.push({ ...baseRecord, outcome: 'failed', organization_id: '', submission_data_patched: '', error: msg });
      continue;
    }

    // Re-fetch DD submission to get fresh submission_data for the (optional) patch.
    const { data: sub, error: subErr } = await supabase
      .from('form_submission')
      .select('id, submission_data')
      .eq('id', row.submission_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (subErr || !sub) {
      const msg = `DD submission ${row.submission_id} not found for tenant: ${subErr?.message || 'not found'}`;
      err(`  -> FAILED: ${msg}`);
      failedCount++;
      results.push({ ...baseRecord, outcome: 'failed', organization_id: '', submission_data_patched: '', error: msg });
      continue;
    }

    // Build the per-row update payload. We always set organization_id; the
    // submission_data patch is OPTIONAL and only happens when the resolver
    // (`resolveDDApplicantOrgFieldId`) chose a target field key for this DD
    // form. The resolver tries configured -> "name of organisation" label
    // -> first organisation_dropdown-typed field, so on the GSF tenant —
    // where DD configs leave applicant_organization_name_field NULL — we
    // still get a target field id from the label/type fallbacks. Both
    // column updates (when applicable) happen in the same UPDATE so the
    // row never lands partially patched.
    const update = { organization_id: row.resolved_organization_id };
    let submissionDataPatched = false;
    if (row.applicant_organization_name_field) {
      const newSubmissionData = { ...(sub.submission_data || {}) };
      newSubmissionData[row.applicant_organization_name_field] = row.resolved_organization_id;
      update.submission_data = newSubmissionData;
      submissionDataPatched = true;
    }

    const { error: updErr } = await supabase
      .from('form_submission')
      .update(update)
      .eq('id', row.submission_id)
      .eq('tenant_id', tenantId);
    if (updErr) {
      const msg = `Failed to update form_submission: ${updErr.message}`;
      err(`  -> FAILED: ${msg}`);
      failedCount++;
      results.push({ ...baseRecord, outcome: 'failed', organization_id: '', submission_data_patched: '', error: msg });
      continue;
    }

    linkedCount++;
    log(`  -> LINKED${submissionDataPatched ? ` (organization_id + submission_data["${row.applicant_organization_name_field}"] patched, resolver=${row.org_field_source})` : ' (organization_id only — submission_data left untouched, no "Name of organisation" field resolvable)'}`);
    results.push({
      ...baseRecord,
      outcome: 'linked',
      organization_id: row.resolved_organization_id,
      submission_data_patched: submissionDataPatched ? 'yes' : 'no',
      error: '',
    });
  }

  return { results, linkedCount, noMatchCount, unresolvedCount, failedCount };
}

/**
 * Bulk-fetch organisation names by id, tenant-scoped. Used to populate the
 * `resolved_organization_name` column in the DD dry-run CSV.
 */
async function fetchTenantOrgNames(orgIds, tenantId) {
  const map = new Map();
  if (!orgIds.length) return map;
  const ids = Array.from(new Set(orgIds));
  const chunkSize = 500;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('organization')
      .select('id, name')
      .in('id', chunk)
      .eq('tenant_id', tenantId);
    if (error) {
      err('Failed to fetch resolved organisation names:', error.message);
      process.exit(1);
    }
    for (const o of data || []) map.set(o.id, o.name);
  }
  return map;
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
    // Notably we do NOT pass submission_id, which bypasses the handler's
    // idempotency short-circuit entirely — so this script does not depend on
    // the form_submission.processed_at column existing in the target DB. We
    // DO pass prefill_organization_id so the handler uses our verified/
    // pre-created tenant-safe id and skips its unscoped name lookup.
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
  log(`Mode:          ${APPLY ? 'APPLY (will reprocess + link)' : 'DRY RUN (no changes)'}`);
  if (ALLOW_DD_EMAIL_TYPE_FALLBACK) {
    log(`DD email fallback: --allow-dd-email-type-fallback ENABLED`);
    if (APPLY) {
      warn('!! APPLY + --allow-dd-email-type-fallback combined. On any DD form');
      warn('!! lacking a configured / "Applicant email"-labelled / member.email-mapped');
      warn('!! field, the resolver will fall back to the FIRST type:"email" field on');
      warn('!! that form. Multi-email DD forms (CEO / POC / safeguarding) can be');
      warn('!! mis-linked. Audit the dry-run CSV first if you have not already.');
    }
  }
  log('');

  // 1. Pre-flight schema sanity check — abort loudly if we are pointed at a
  //    non-multi-tenant DB before touching any data.
  await assertMultiTenantSchema();

  // 2. Pre-flight workflow audit (always runs, in both dry-run and apply mode).
  //    The DD-linking step does NOT trigger workflows itself (it only updates
  //    columns on existing form_submission rows), but the application-form
  //    apply step still does, so the audit remains a hard precondition.
  await auditWorkflowsOff(TENANT_ID);

  // 3. Fetch application form
  const form = await fetchForm(FORM_ID, TENANT_ID);
  log(`[form] Loaded "${form.name || form.id}"`);

  const orgNameFieldId = resolveOrgNameSourceFieldId(form);
  if (!orgNameFieldId) {
    warn('[form] Could not resolve which form field supplies organisation.name. The dry-run will still scan submissions but extracted_org_name will be blank for every row, and apply mode will likely fail with MISSING_ORG_NAME for every flagged submission.');
  } else {
    log(`[form] Organisation name source field id: ${orgNameFieldId}`);
  }

  // Resolve the form-field id that supplies the applicant email. Step B
  // joins DD submissions to application submissions on this email, so if
  // we cannot find it the email->org map will be empty and DD linking
  // cannot match anything. The submitted_by_email column is frequently
  // NULL on these submissions (it is for tenant 21296ad6 — 0 of 102 rows).
  const emailFieldId = resolveApplicantEmailSourceFieldId(form);
  if (!emailFieldId) {
    warn('[form] Could not resolve which form field supplies the applicant email. Step B will fall back to the submitted_by_email column only; if that column is not populated for these submissions the email->org map will be empty and no DD submissions can be linked.');
  } else {
    log(`[form] Applicant email source field id: ${emailFieldId}`);
  }

  // 4. Build the missing-org report for the application form
  const stats = await buildFlaggedRows(form, TENANT_ID, orgNameFieldId, emailFieldId);

  // 5. Always write the application-form dry-run CSV
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

  // 6. DD discovery + scan (always runs; needed to write the DD dry-run CSV)
  log('\n=== Step B: Due Diligence form scan ===');
  const ddForms = await discoverDDForms(TENANT_ID);
  const ddScans = [];
  for (const { form: ddForm, config: ddConfig, effectiveApplicantEmailFieldId, emailSource, effectiveOrgFieldId, orgFieldSource } of ddForms) {
    const scan = await scanDDForMissingOrgs(ddForm, ddConfig, TENANT_ID, effectiveApplicantEmailFieldId, emailSource, effectiveOrgFieldId, orgFieldSource);
    log(`[dd scan] "${ddForm.name || ddForm.id}" (${ddForm.id}): ${scan.totalSubmissions} submission(s), ${scan.validCount} valid, ${scan.flagged.length} flagged`);
    ddScans.push({ ddForm, ddConfig, effectiveApplicantEmailFieldId, emailSource, effectiveOrgFieldId, orgFieldSource, scan });
  }
  const allDDFlagged = ddScans.flatMap(s => s.scan.flagged);

  // 7. Application-form apply path (only when --apply). DD apply runs after
  //    this, so the DD email map is built from the *post-recreation* state.
  let applyResult = null;
  let applyPath = null;
  let applyResultsById = null;
  if (APPLY) {
    if (stats.flagged.length === 0) {
      log('\n[apply] Nothing to reprocess — no flagged application submissions.');
    } else {
      log('\n=== Apply: reprocessing flagged application submissions ===');
      applyResult = await applyReprocessing(form, TENANT_ID, stats.flagged, orgNameFieldId);

      applyPath = path.join('tmp', `missing-orgs-apply-${ts}.csv`);
      writeCsv(applyPath, applyResult.results, [
        'submission_id',
        'applicant_email',
        'extracted_org_name',
        'outcome',
        'organization_id',
        'error',
      ]);
      log(`\n[csv] App apply report written: ${applyPath}`);

      log('\n=== App apply summary ===');
      log(`Created new organisations:  ${applyResult.createdCount}`);
      log(`Linked to existing orgs:    ${applyResult.linkedCount}`);
      log(`Failed:                     ${applyResult.failedCount}`);

      applyResultsById = new Map(applyResult.results.map(r => [r.submission_id, r]));
    }
  }

  // 8. Build the email -> resolved-org map from the application-form state.
  const emailMap = buildEmailToOrgMap({
    submissions: stats.submissions,
    flagged: stats.flagged,
    applyResultsById,
    orgMap: stats.orgMap,
    tenantId: TENANT_ID,
    applyMode: APPLY,
    emailFieldId,
  });
  log(`\n[dd email map] Built map for ${emailMap.size} unique applicant email(s) from ${stats.submissions.length} application submission(s)`);

  // 9. Resolve every flagged DD submission against the email map.
  const resolvedOrgIds = new Set();
  for (const entry of emailMap.values()) {
    if (entry.organization_id) resolvedOrgIds.add(entry.organization_id);
  }
  const orgNameMap = await fetchTenantOrgNames(Array.from(resolvedOrgIds), TENANT_ID);
  const resolvedDD = resolveDDFlagsAgainstMap(allDDFlagged, emailMap, orgNameMap);

  // 10. Always write the DD dry-run CSV.
  const ddDryRunPath = path.join('tmp', `missing-dd-orgs-dry-run-${ts}.csv`);
  writeCsv(ddDryRunPath, resolvedDD, [
    'dd_form_id',
    'dd_form_name',
    'submission_id',
    'created_date',
    'applicant_email',
    // How the email-field id was chosen for this DD form (configured /
    // label_match / core_field_mapping / type_email_fallback / unresolved*).
    'email_source',
    // How the "Name of organisation" field id was chosen for this DD form
    // (configured / label_match / type_organisation_dropdown / unresolved).
    // Empty when no resolver chose a target.
    'org_field_source',
    'current_invalid_org_field_value',
    'outcome',
    'resolved_organization_id',
    'resolved_organization_name',
    'application_submission_id',
    // Predicts whether the apply step would also rewrite submission_data for
    // this row. `yes` when the resolver picked a target field (configured,
    // label_match or type_organisation_dropdown); `no` when no target field
    // could be resolved on this DD form; blank for non-linkable outcomes.
    'submission_data_patched',
    'notes',
  ]);
  log(`[csv] DD dry-run report written: ${ddDryRunPath}`);

  const ddDryCounts = { linkable: 0, no_application_match: 0, application_org_unresolved: 0 };
  for (const r of resolvedDD) ddDryCounts[r.outcome] = (ddDryCounts[r.outcome] || 0) + 1;
  log('\n=== DD-linking dry-run summary ===');
  log(`DD forms scanned:                       ${ddScans.length}`);
  log(`Flagged DD submissions (across forms):  ${resolvedDD.length}`);
  log(`  - linkable (would link):              ${ddDryCounts.linkable}`);
  log(`  - no_application_match:               ${ddDryCounts.no_application_match}`);
  log(`  - application_org_unresolved:         ${ddDryCounts.application_org_unresolved}`);

  // 11. DD apply path (only when --apply).
  let ddApplyResult = null;
  let ddApplyPath = null;
  if (APPLY) {
    if (resolvedDD.length === 0) {
      log('\n[dd apply] Nothing to link — no flagged DD submissions.');
    } else {
      log('\n=== Apply: linking DD submissions ===');
      ddApplyResult = await applyDDLinking(resolvedDD, TENANT_ID);

      ddApplyPath = path.join('tmp', `missing-dd-orgs-apply-${ts}.csv`);
      writeCsv(ddApplyPath, ddApplyResult.results, [
        'dd_form_id',
        'submission_id',
        'applicant_email',
        // How the email-field id was chosen for this DD form (configured /
        // label_match / core_field_mapping / type_email_fallback /
        // unresolved*). Mirrors the dry-run CSV so apply artifacts are
        // self-contained for audit.
        'email_source',
        // How the "Name of organisation" field id was chosen for this DD form
        // (configured / label_match / type_organisation_dropdown / unresolved).
        // Mirrors the dry-run CSV.
        'org_field_source',
        'outcome',
        'organization_id',
        // yes -> the row's submission_data was rewritten alongside organization_id;
        // no  -> only organization_id was set (the resolver returned 'unresolved'
        //        for this DD form — no configured / label / type-based target);
        // ''  -> no apply update happened (skipped or failed).
        'submission_data_patched',
        // Tie-resolution metadata: which application submission supplied the
        // resolved org id, and the human-readable note (e.g. "picked most
        // recent of 3 matching application submission(s)") so an operator can
        // audit the apply artifact directly without cross-referencing the
        // dry-run CSV.
        'application_submission_id',
        'notes',
        'error',
      ]);
      log(`\n[csv] DD apply report written: ${ddApplyPath}`);

      log('\n=== DD apply summary ===');
      log(`Linked:                       ${ddApplyResult.linkedCount}`);
      log(`No application match:         ${ddApplyResult.noMatchCount}`);
      log(`Application org unresolved:   ${ddApplyResult.unresolvedCount}`);
      log(`Failed:                       ${ddApplyResult.failedCount}`);
    }
  } else {
    log('\nDry-run complete. Re-run with --apply to reprocess application submissions and link DD submissions.');
  }

  // 12. Combined exit code. Both reports are already on disk by this point.
  const appFailed = applyResult?.failedCount || 0;
  const ddFailed = ddApplyResult?.failedCount || 0;
  if (appFailed + ddFailed > 0) {
    err('');
    if (appFailed > 0) err(`${appFailed} application submission(s) failed. See ${applyPath} for details.`);
    if (ddFailed > 0) err(`${ddFailed} DD submission(s) failed to link. See ${ddApplyPath} for details.`);
    process.exit(3);
  }
}

main().catch(e => {
  err('Script failed:', e);
  process.exit(1);
});
