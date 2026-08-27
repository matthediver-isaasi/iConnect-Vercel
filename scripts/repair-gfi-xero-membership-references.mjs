/**
 * Repair GFI Xero membership references. This command defaults to dry-run.
 *
 * Dry run:
 *   node scripts/repair-gfi-xero-membership-references.mjs
 *
 * Apply an explicitly reviewed manifest:
 *   node scripts/repair-gfi-xero-membership-references.mjs \
 *     --apply --manifest=scripts/output/gfi-xero-reference-dry-run-....json
 *
 * This script never changes application membership records. Dry-run never
 * changes Xero invoices, but may rotate and persist Xero OAuth credentials.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

if (process.env.DEST_SUPABASE_URL) process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
if (process.env.DEST_SUPABASE_KEY) process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;

const {
  REPAIR_KIND,
  TARGET_TENANT_NAME,
  TARGET_TENANT_SLUG,
  PROPOSED_REFERENCE,
  authenticateRepairConnection,
  buildDryRunManifest,
  processReviewedInvoice,
  validateManifest,
} = await import('./lib/repair-gfi-xero-references.mjs');
const { supabase } = await import('../api/_lib/database.js');
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');

const args = Object.fromEntries(process.argv.slice(2).map((raw) => {
  const [key, ...rest] = raw.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
const apply = args.apply === true;
const manifestPath = typeof args.manifest === 'string' ? args.manifest : null;
const OUTPUT_DIR = path.resolve('scripts/output');
const SIGNING_SECRET = process.env.SESSION_SECRET;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function writeJson(prefix, value) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${prefix}-${stamp()}.json`);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  console.log(`Report: ${path.relative(process.cwd(), file)}`);
  return file;
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, file);
}

async function resolveTenant() {
  const { data, error } = await supabase
    .from('tenant').select('id, slug, name').eq('slug', TARGET_TENANT_SLUG);
  if (error) throw new Error(`Could not resolve GFI tenant: ${error.message}`);
  if (data?.length !== 1 || data[0].name !== TARGET_TENANT_NAME) {
    throw new Error(`Refusing to proceed: expected exactly ${TARGET_TENANT_NAME} with slug ${TARGET_TENANT_SLUG}.`);
  }
  return data[0];
}

async function authenticate(tenantId) {
  const { data: connections, error } = await supabase.from('xero_token')
    .select('tenant_id, expires_at').eq('app_tenant_id', tenantId);
  if (error) throw new Error(`Could not read GFI Xero connection: ${error.message}`);
  return authenticateRepairConnection({
    tenantId,
    connections,
    getAccessToken: getValidXeroAccessToken,
  });
}

async function xeroRequest(accessToken, xeroTenantId, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'xero-tenant-id': xeroTenantId,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(`Xero HTTP ${response.status}: ${JSON.stringify(data).slice(0, 800)}`);
    error.xeroResponse = data;
    throw error;
  }
  return data;
}

async function fetchAllInvoices(auth) {
  const all = [];
  for (let page = 1; ; page++) {
    const where = encodeURIComponent('Type=="ACCREC"');
    const url = `https://api.xero.com/api.xro/2.0/Invoices?page=${page}&order=InvoiceID&where=${where}`;
    const data = await xeroRequest(auth.accessToken, auth.tenantId, url);
    const rows = data.Invoices || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

async function fetchInvoice(auth, invoiceId) {
  const data = await xeroRequest(
    auth.accessToken,
    auth.tenantId,
    `https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(invoiceId)}`,
  );
  return data.Invoices?.[0] || null;
}

async function loadHistory(tenantId, invoice) {
  const columns = 'id, tenant_id, organization_id, membership_year, status, payment_status, xero_invoice_id, xero_invoice_number, accounting_invoice_id, accounting_invoice_number';
  const rows = [];
  for (const table of ['organisation_membership_history', 'member_membership_history']) {
    const filters = [
      `xero_invoice_id.eq.${invoice.InvoiceID}`,
      `accounting_invoice_id.eq.${invoice.InvoiceID}`,
    ];
    if (invoice.InvoiceNumber) {
      filters.push(`xero_invoice_number.eq.${invoice.InvoiceNumber}`);
      filters.push(`accounting_invoice_number.eq.${invoice.InvoiceNumber}`);
    }
    const { data, error } = await supabase.from(table).select(columns)
      .eq('tenant_id', tenantId).or(filters.join(','));
    if (error) throw new Error(`Could not link ${table}: ${error.message}`);
    rows.push(...(data || []).map((row) => ({ table, ...row })));
  }
  return rows;
}

async function dryRun(tenant, auth) {
  if (manifestPath) throw new Error('--manifest is only valid with --apply');
  const invoices = await fetchAllInvoices(auth);
  const manifest = await buildDryRunManifest({
    tenant,
    xeroTenantId: auth.tenantId,
    invoices,
    loadHistory: (invoice) => loadHistory(tenant.id, invoice),
    writeReport: (report) => writeJson('gfi-xero-reference-dry-run', report),
    signingSecret: SIGNING_SECRET,
  });
  console.log(JSON.stringify(manifest.summary, null, 2));
  console.log('DRY RUN ONLY: no Xero invoices or application membership/business records were changed.');
  console.log('Authentication may have rotated and persisted the saved Xero OAuth credentials.');
}

async function applyManifest(tenant, auth) {
  if (!manifestPath) throw new Error('--apply requires --manifest=<saved dry-run JSON path>');
  const raw = await fs.readFile(path.resolve(manifestPath), 'utf8');
  const manifest = JSON.parse(raw);
  validateManifest(manifest, { tenantId: tenant.id, xeroTenantId: auth.tenantId }, SIGNING_SECRET);

  const outcomes = [];
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const resultFile = path.join(OUTPUT_DIR, `gfi-xero-reference-apply-result-${stamp()}.json`);
  const resultReport = {
    repairKind: REPAIR_KIND,
    mode: 'apply-result',
    generatedAt: new Date().toISOString(),
    sourceManifest: path.resolve(manifestPath),
    sourceManifestSignature: manifest.signature,
    target: manifest.target,
    state: 'in-progress',
    summary: { reviewed: manifest.selected.length, attempted: 0, succeeded: 0, skipped: 0, errors: 0 },
    outcomes,
  };
  await writeJsonAtomic(resultFile, resultReport);
  console.log(`Result journal: ${path.relative(process.cwd(), resultFile)}`);
  for (const reviewed of manifest.selected) {
    let currentOutcome;
    const checkpoint = async (outcome) => {
      currentOutcome = structuredClone(outcome);
      const index = outcomes.findIndex((item) => item.invoiceId === outcome.invoiceId);
      if (index === -1) outcomes.push(currentOutcome);
      else outcomes[index] = currentOutcome;
      await writeJsonAtomic(resultFile, resultReport);
    };
    const outcome = await processReviewedInvoice({
      reviewed,
      fetchInvoice: (invoiceId) => fetchInvoice(auth, invoiceId),
      updateInvoice: async (invoiceId) => {
        const response = await xeroRequest(
          auth.accessToken,
          auth.tenantId,
          `https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(invoiceId)}`,
          {
            method: 'POST',
            body: JSON.stringify({ Invoices: [{ InvoiceID: invoiceId, Reference: PROPOSED_REFERENCE }] }),
          },
        );
        return response.Invoices?.[0] || response;
      },
      checkpoint,
    });
    currentOutcome = outcome;
    resultReport.summary.attempted = outcomes.filter((x) => x.attempted).length;
    resultReport.summary.succeeded = outcomes.filter((x) => x.result === 'success').length;
    resultReport.summary.skipped = outcomes.filter((x) => x.result === 'skipped').length;
    resultReport.summary.errors = outcomes.filter((x) => x.result === 'error').length;
    await checkpoint(currentOutcome);
  }
  resultReport.state = 'complete';
  resultReport.completedAt = new Date().toISOString();
  await writeJsonAtomic(resultFile, resultReport);
  console.log(JSON.stringify(resultReport.summary, null, 2));
  if (resultReport.summary.errors > 0) process.exitCode = 1;
}

if (!supabase) throw new Error('Production database is not configured');
if (!SIGNING_SECRET) throw new Error('SESSION_SECRET is required to sign and validate repair manifests');
const tenant = await resolveTenant();
const auth = await authenticate(tenant.id);
if (apply) await applyManifest(tenant, auth);
else await dryRun(tenant, auth);
