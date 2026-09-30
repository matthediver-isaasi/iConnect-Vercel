#!/usr/bin/env node
// Evidence preparation ONLY. Deliberately has no apply mode or write SQL.
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { TENANT_ID, MEMBER_ID, WORKBOOK_SHA256, digest, validateGrid, providerReader, readAllProviderPages } from './bnms-dd-pilot.mjs';
import { getTenantGocardlessCredentials } from '../api/_lib/gocardlessCredentials.js';
const SOURCE = new URL('../attached_assets/DD_matched_different_emails_1789802289108.xlsx', import.meta.url);
const norm = v => String(v || '').trim().toLowerCase();
const day = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export function matchingStructures(structures, classes, asOf) {
  return structures.filter(s => s.is_active && s.dd_enabled && s.structure_scope_type === 'member'
    && classes.length === 1 && norm(s.structure_match_value) === norm(classes[0].value)
    && (!s.effective_from || day(s.effective_from) <= day(asOf))
    && (!s.effective_to || day(s.effective_to) >= day(asOf)));
}

export function candidatePools(grid, members, discovery) {
  validateGrid(grid);
  const byId = new Map(members.map(m => [m.id, m]));
  const sheet = grid.slice(1).map((r, i) => ({
    group: 'spreadsheet', sourceRow: i + 2, memberId: String(r[4]).trim(),
    customerId: String(r[5]).trim(), mandateId: String(r[6]).trim(), email: norm(r[3]),
  }));
  const sheetIds = new Set(sheet.map(r => r.memberId));
  const sheetCustomers = new Set(sheet.map(r => r.customerId));
  const sheetMandates = new Set(sheet.map(r => r.mandateId));
  const direct = discovery.map(r => ({
    group: 'direct_match', discoveryRowId: r.id, batchId: r.batch_id,
    memberId: r.matched_member_id, customerId: r.gocardless_customer_id,
    mandateId: r.gocardless_mandate_id, email: norm(r.customer_email),
  })).filter(r => !sheetIds.has(r.memberId) && !sheetCustomers.has(r.customerId) && !sheetMandates.has(r.mandateId));
  return [sheet, direct].map(pool => pool.filter(r => {
    const member = byId.get(r.memberId);
    return member && member.tenant_id === TENANT_ID && member.id !== MEMBER_ID
      && !member.membership_paused && !member.is_deleted && !member.deleted_at
      && !['cancelled', 'paused', 'deleted'].includes(member.status)
      && norm(member.email) === r.email && !!r.email
      && members.filter(m => norm(m.email) === r.email).length === 1
      && /^MD[A-Z0-9]+$/.test(r.mandateId) && /^CU[A-Z0-9]+$/.test(r.customerId)
      && pool.filter(x => x.memberId === r.memberId || x.mandateId === r.mandateId || x.customerId === r.customerId).length === 1;
  }).sort((a, b) => a.group === 'spreadsheet' ? a.sourceRow - b.sourceRow : a.memberId.localeCompare(b.memberId)));
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--out' || !resolve(args[1]).startsWith('/tmp/')) {
    throw Error('Only --out /tmp/new-private-report.json is supported; no apply mode');
  }
  destinationTarget(process.env);
  const bytes = await readFile(SOURCE);
  if (digest(bytes) !== WORKBOOK_SHA256) throw Error('Workbook fingerprint mismatch');
  const wb = XLSX.read(bytes, { type: 'buffer' });
  if (wb.SheetNames.length !== 1) throw Error('Workbook sheet drift');
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const client = await destinationConnection();
  await client.connect();
  let snapshot;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows = async (sql, values = [TENANT_ID]) => (await client.query(sql, values)).rows;
    snapshot = {
      members: await rows('SELECT id,tenant_id,email,first_name,last_name,status,membership_paused FROM member WHERE tenant_id=$1'),
      batches: await rows("SELECT * FROM gocardless_mandate_discovery_batch WHERE tenant_id=$1 AND environment='live' ORDER BY created_at DESC"),
      discovery: await rows("SELECT * FROM gocardless_mandate_discovery_row WHERE tenant_id=$1 AND environment='live'"),
      preferences: await rows(`SELECT v.member_id,f.name,v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
        JOIN member m ON m.id=v.member_id WHERE m.tenant_id=$1 AND f.tenant_id=$1 AND f.entity_scope='member' AND f.is_active=true
        AND f.name IN ('member_class','membership_status','direct_debit_payment','ym_membership_type','ym_date_membership_expires')`),
      structures: await rows('SELECT * FROM membership_tier_config WHERE tenant_id=$1'),
      agreements: await rows('SELECT id,member_id,status,gocardless_mandate_id FROM membership_billing_agreements WHERE tenant_id=$1'),
      plans: await rows('SELECT id,member_id,status,gocardless_mandate_id FROM membership_payment_plans WHERE tenant_id=$1'),
      history: await rows('SELECT * FROM member_membership_history WHERE tenant_id=$1'),
    };
    await client.query('ROLLBACK');
  } finally { await client.end(); }
  // A partial batch is only a source of candidate identities, never completeness
  // or import approval. Each selected identity is freshly checked with provider.
  const latest = snapshot.batches.find(b => ['completed', 'complete', 'partial'].includes(b.status));
  if (!latest) throw Error('No usable live discovery batch');
  const direct = snapshot.discovery.filter(r => r.batch_id === latest.id && r.match_outcome === 'matched');
  const pools = candidatePools(grid, snapshot.members, direct);
  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const get = providerReader(await getTenantGocardlessCredentials(TENANT_ID, { db }));
  const candidates = [], excluded = [];
  const asOf = new Date().toISOString();
  for (const pool of pools) {
    let selected = 0;
    for (const identity of pool) {
      if (selected === 5) break;
      const member = snapshot.members.find(m => m.id === identity.memberId);
      const existing = Object.fromEntries(['agreements', 'plans', 'history'].map(k =>
        [k, snapshot[k].filter(r => r.member_id === member.id || r.gocardless_mandate_id === identity.mandateId)]));
      if (Object.values(existing).some(rows => rows.length)) {
        excluded.push({ identity, reason: 'EXISTING_CANONICAL_RECORDS_REQUIRE_RECONCILIATION' }); continue;
      }
      const mandate = (await get(`mandates/${identity.mandateId}`)).mandates;
      const customer = (await get(`customers/${identity.customerId}`)).customers;
      if (mandate?.id !== identity.mandateId || mandate.status !== 'active'
        || mandate.links?.customer !== identity.customerId || mandate.links?.creditor !== 'CR0000B50W1Y2R'
        || customer?.id !== identity.customerId
        || (identity.group === 'direct_match' && norm(customer.email) !== norm(member.email))) {
        excluded.push({ identity, reason: 'LIVE_IDENTITY_OR_MANDATE_CONFLICT' }); continue;
      }
      const subscriptions = await readAllProviderPages(get, 'subscriptions', { mandate: identity.mandateId });
      const payments = await readAllProviderPages(get, 'payments', { mandate: identity.mandateId });
      if (subscriptions.some(s => s.links?.mandate !== identity.mandateId)
        || payments.some(p => p.links?.mandate !== identity.mandateId)) throw Error('Provider filtered evidence identity mismatch');
      const preferences = snapshot.preferences.filter(p => p.member_id === member.id);
      const classes = preferences.filter(p => p.name === 'member_class');
      const structures = matchingStructures(snapshot.structures, classes, asOf);
      if (structures.length !== 1 || !payments.some(p => p.status === 'paid_out')) {
        excluded.push({ identity, reason: structures.length !== 1
          ? 'CURRENT_STRUCTURE_AMBIGUOUS_OR_MISSING' : 'NO_SETTLED_PROVIDER_HISTORY' });
        continue;
      }
      const blockers = ['CURRENT_ENTITLEMENT_START_AND_END_NOT_VERIFIED', 'XERO_INVOICES_NOT_RECONCILED',
        'FUTURE_TERM_AND_PRICING_APPROVAL_REQUIRED', 'LEGACY_AUTOMATIC_COLLECTION_HANDOVER_NOT_VERIFIED',
        'BATCH_IMPORT_IMPLEMENTATION_AND_REVIEW_REQUIRED', 'DEPLOYED_MEMBER_AND_TENANT_VISUAL_VERIFICATION_PENDING'];
      if (latest.status === 'partial') blockers.push('LIVE_DISCOVERY_INCOMPLETE_RECONCILIATION_REQUIRED');
      if (structures.length !== 1) blockers.push('CURRENT_STRUCTURE_AMBIGUOUS_OR_MISSING');
      if (subscriptions.length) blockers.push('EXISTING_PROVIDER_SUBSCRIPTIONS');
      if (payments.some(p => ['pending_submission','submitted','confirmed'].includes(p.status)
        || p.charge_date >= asOf.slice(0,10))) blockers.push('PENDING_OR_FUTURE_PROVIDER_PAYMENT_REQUIRES_RECONCILIATION');
      candidates.push({ identity, member, preferences, existing, mandate,
        customer: { id: customer.id, email: customer.email, given_name: customer.given_name, family_name: customer.family_name },
        subscriptions, payments, applicableStructures: structures, blockers,
        entitlement: { verified: false, sourceDateFields: preferences.filter(p => p.name === 'ym_date_membership_expires') },
        futureTerm: { start: null, end: null, pricingApproval: null, collectionHeld: true },
        historicalEvidence: { providerSettledCount: payments.filter(p => p.status === 'paid_out').length,
          invoiceReconciled: false, entitlementProven: false } });
      selected++;
    }
  }
  const report = { version: 1, mode: 'beta_candidate_review_only', observedAt: asOf, tenantId: TENANT_ID,
    workbookSha256: WORKBOOK_SHA256, discoveryBatch: latest, originalPilotExcluded: MEMBER_ID,
    poolCounts: pools.map(p => p.length), candidates, excluded, readyToImport: false, writes: 0, providerWrites: 0,
    verification: {
      backend: 'Fresh evidence and reviewed immutable batch hash; one agreement/held plan/history per approved member; unpaid future term, preserved annual nulls, active scoped mandate, reconciled historical invoice/payment identities; transaction rollback and zero-write replay.',
      member: 'Authenticated own-member membership/history/DD/payment views: active existing mandate, held awaiting-first-payment future term, separate historical payments, dynamic estimate not annual commitment; no setup or pay-now action for adopted mandate.',
      tenant: 'Authenticated BNMS admin detail/history/DD views show identical dates, class, pricing, historical balances and holds; cross-tenant and unrelated-member access denied.',
      deployment: 'Not authenticated or visually verified by this evidence-only runner. Use approved deployed member/admin sessions; local SOURCE preview is not DEST membership evidence.',
      noEffects: 'No scheduling, release, provider mutation, email, account impersonation or entitlement inference.',
    } };
  const content = JSON.stringify(report, null, 2);
  const file = await open(resolve(args[1]), 'wx', 0o600);
  try { await file.writeFile(content); } finally { await file.close(); }
  console.log(JSON.stringify({ mode: report.mode, candidates: candidates.length,
    groups: ['spreadsheet','direct_match'].map(group => ({ group, count: candidates.filter(c => c.identity.group === group).length })),
    poolCounts: report.poolCounts, excluded: excluded.length, readyToImport: false,
    reportSha256: digest(content), out: resolve(args[1]), writes: 0, providerWrites: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Beta evidence preparation failed; no live writes performed. Inspect evidence access/source contracts without exposing secrets.'); process.exitCode = 1; });
}