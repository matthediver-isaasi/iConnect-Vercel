/**
 * One-off cleanup for near-simultaneous duplicate public form submissions on
 * the "Initial enquiry" form (double-click / retry / automated-burst pattern).
 *
 * Clusters form_submission rows by (organisation_id OR lowercased email)
 * where consecutive submissions in the cluster are <= WINDOW_SECONDS apart,
 * keeps the EARLIEST row in each cluster, and on --apply deletes the redundant
 * rows AND their linked form_submission_due_diligence rows. Every affected ID
 * is logged.
 *
 * Dry-run by default. Idempotent (re-running after apply finds no clusters).
 * Hard-pinned to the Initial enquiry form/tenant unless overridden.
 *
 * Usage:
 *   node scripts/dedupe-initial-enquiry-submissions.mjs             # dry run
 *   node scripts/dedupe-initial-enquiry-submissions.mjs --apply     # delete duplicates
 *   node scripts/dedupe-initial-enquiry-submissions.mjs --form=<uuid> --tenant=<uuid> [--window=10]
 */
import { createClient } from '@supabase/supabase-js';

const DEFAULT_FORM_ID = '3c4124e1-05c6-4423-88e1-a5f91045152b';
const DEFAULT_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const DEFAULT_WINDOW_SECONDS = 10;

const args = process.argv.slice(2);
const getFlag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const APPLY = args.includes('--apply');
const FORM_ID = getFlag('form') || DEFAULT_FORM_ID;
const TENANT_ID = getFlag('tenant') || DEFAULT_TENANT_ID;
const WINDOW_SECONDS = Number(getFlag('window')) > 0 ? Number(getFlag('window')) : DEFAULT_WINDOW_SECONDS;

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

// Fetch ALL submissions for the pinned form+tenant, paginated (PostgREST caps
// at 1000 per request; .range() paging requires a stable unique ORDER BY).
async function fetchAllSubmissions() {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('form_submission')
      .select('id, created_date, organization_id, submitted_by_email, submission_data')
      .eq('form_id', FORM_ID)
      .eq('tenant_id', TENANT_ID)
      .order('created_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Fetch failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

// Duplicate identity: prefer organisation_id, else canonical email (the
// stored submitted_by_email, else the first email-looking value in
// submission_data — mirrors the endpoint's extraction fallback for legacy
// rows that predate the canonical column).
function identityOf(row) {
  if (row.organization_id) return `org:${row.organization_id}`;
  if (isEmail(row.submitted_by_email)) return `email:${row.submitted_by_email.trim().toLowerCase()}`;
  for (const value of Object.values(row.submission_data || {})) {
    if (isEmail(value)) return `email:${value.trim().toLowerCase()}`;
  }
  return null; // unidentifiable — never treated as duplicate
}

async function run() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Form: ${FORM_ID}  Tenant: ${TENANT_ID}  Window: ${WINDOW_SECONDS}s`);

  const rows = await fetchAllSubmissions();
  console.log(`Fetched ${rows.length} submissions.`);

  // Group by identity, then chain-cluster: a row joins the current cluster if
  // it is within WINDOW_SECONDS of the PREVIOUS row in the cluster.
  const byIdentity = new Map();
  for (const row of rows) {
    const id = identityOf(row);
    if (!id) continue;
    if (!byIdentity.has(id)) byIdentity.set(id, []);
    byIdentity.get(id).push(row);
  }

  const clusters = [];
  for (const [identity, group] of byIdentity) {
    group.sort((a, b) => new Date(a.created_date) - new Date(b.created_date));
    let current = [group[0]];
    for (let i = 1; i < group.length; i++) {
      const prev = current[current.length - 1];
      const gapMs = new Date(group[i].created_date) - new Date(prev.created_date);
      if (gapMs <= WINDOW_SECONDS * 1000) {
        current.push(group[i]);
      } else {
        if (current.length > 1) clusters.push({ identity, rows: current });
        current = [group[i]];
      }
    }
    if (current.length > 1) clusters.push({ identity, rows: current });
  }

  if (clusters.length === 0) {
    console.log('No duplicate clusters found. Nothing to do.');
    return;
  }

  const toDelete = [];
  console.log(`\nFound ${clusters.length} duplicate cluster(s):`);
  for (const cluster of clusters) {
    const [keep, ...dupes] = cluster.rows;
    console.log(`\nCluster ${cluster.identity} (${cluster.rows.length} rows):`);
    console.log(`  KEEP   ${keep.id}  ${keep.created_date}`);
    for (const d of dupes) {
      console.log(`  DELETE ${d.id}  ${d.created_date}`);
      toDelete.push(d.id);
    }
  }

  // Linked due diligence rows for the redundant submissions.
  const { data: ddRows, error: ddErr } = await supabase
    .from('form_submission_due_diligence')
    .select('id, form_submission_id')
    .eq('tenant_id', TENANT_ID)
    .in('form_submission_id', toDelete);
  if (ddErr) throw new Error(`DD lookup failed: ${ddErr.message}`);
  console.log(`\nRedundant submissions: ${toDelete.length}`);
  console.log(`Linked due diligence rows to delete: ${(ddRows || []).length}`);
  for (const dd of ddRows || []) {
    console.log(`  DD DELETE ${dd.id} (submission ${dd.form_submission_id})`);
  }

  if (!APPLY) {
    console.log('\nDry run complete — no changes made. Re-run with --apply to delete.');
    return;
  }

  // Delete DD rows first (FK direction), then the submissions.
  if ((ddRows || []).length > 0) {
    const { error: ddDelErr } = await supabase
      .from('form_submission_due_diligence')
      .delete()
      .eq('tenant_id', TENANT_ID)
      .in('id', ddRows.map((d) => d.id));
    if (ddDelErr) throw new Error(`DD delete failed: ${ddDelErr.message}`);
    console.log(`Deleted ${ddRows.length} due diligence row(s).`);
  }

  const { error: subDelErr } = await supabase
    .from('form_submission')
    .delete()
    .eq('tenant_id', TENANT_ID)
    .eq('form_id', FORM_ID)
    .in('id', toDelete);
  if (subDelErr) throw new Error(`Submission delete failed: ${subDelErr.message}`);
  console.log(`Deleted ${toDelete.length} duplicate submission(s). Done.`);
}

run().catch((err) => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
