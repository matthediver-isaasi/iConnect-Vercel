// Operator-approved historical data repair. No financial provider write endpoints.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { assessMember } from './bnms-live-xero-review-core.mjs';
import { TENANT, REVIEW_HASH, CSV_HASH, sha, memberInvoice, financialProjection,
  buildRecord, assertRecord, historyId, approvalState } from './bnms-approved-72-core.mjs';

const root = 'generated-artifacts/bnms-live-xero-150';
const out = 'generated-artifacts/bnms-approved-72';
const read = path => JSON.parse(fs.readFileSync(path));
const save = (name, value) => {
  const path = `${out}/${name}.json`;
  fs.writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  return path;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const mode = process.argv[2];
  assert.ok(['verify', 'dry-run', 'apply', 'replay'].includes(mode));
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const bytes = fs.readFileSync(`${root}/review-results.json`);
  assert.equal(sha(bytes), REVIEW_HASH);
  assert.equal(sha(fs.readFileSync(`${root}/BNMS-Live-Xero-Membership-Review-150-14-10-2026.csv`)), CSV_HASH);
  const candidates = JSON.parse(bytes).results.filter(r => r.conditionalCandidate);
  assert.equal(candidates.length, 72);
  assert.equal(new Set(candidates.map(r => r.memberId)).size, 72);
  const original = read(`${root}/members.json`);
  const proposal = read('generated-artifacts/bnms-missing-150-review/final/proposal.json');
  const snapshotBytes = fs.readFileSync('generated-artifacts/bnms-missing-150-review/snapshot.json');
  assert.equal(sha(snapshotBytes), read(`${root}/pin.json`).snapshotHash);
  assert.equal(sha(snapshotBytes), proposal.snapshotSha256);
  const snapshot = JSON.parse(snapshotBytes);
  const context = read(`${root}/live-context.json`);
  destinationTarget(process.env);
  // Must precede importing helpers which transitively initialize the API client.
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
  const { SOURCE_SQL, canonicalHash } = await import('./bnms-non-dd-apply.mjs');

  if (mode === 'verify') {
    process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
    const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
    let auth, authTime = 0, last = 0, requests = 0;
    const responses = [];
    const get = async (resource, params = {}) => {
      assert.ok(++requests < 400);
      await sleep(Math.max(0, 2100 - (Date.now() - last)));
      if (!auth || Date.now() - authTime > 600000) {
        auth = await getValidXeroAccessToken(TENANT); authTime = Date.now();
        assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
      }
      last = Date.now();
      const url = `${resource}?${new URLSearchParams(params)}`;
      const response = await fetch(`https://api.xero.com/api.xro/2.0/${url}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(response.status, 200, 'Provider verification incomplete');
      const body = await response.json();
      responses.push({ url, capturedAt: new Date().toISOString(), body });
      if (response.headers.has('x-daylimit-remaining'))
        assert.ok(Number(response.headers.get('x-daylimit-remaining')) >= 300, 'Provider request reserve reached');
      return body;
    };
    const pages = async (resource, params, key) => {
      const rows = [], seen = new Set();
      for (let page = 1; page <= 100; page++) {
        const body = await get(resource, { ...params, page: String(page) });
        assert.ok(Array.isArray(body[key]));
        for (const row of body[key]) {
          const id = row[key === 'Contacts' ? 'ContactID' : 'InvoiceID'];
          assert.ok(id && !seen.has(id)); seen.add(id); rows.push(row);
        }
        if (body[key].length < 100) return rows;
      }
      throw Error('Incomplete pagination');
    };
    const contacts = new Map(), invoices = [];
    for (let n = 0; n < candidates.length; n += 10) {
      const batch = candidates.slice(n, n + 10);
      const clauses = batch.flatMap(c => {
        const p = proposal.members.find(p => p.memberId === c.memberId);
        return [`EmailAddress==${JSON.stringify(c.email.trim().toLowerCase())}`,
          `AccountNumber==${JSON.stringify(p.liveSource.preferences.ym_web_site_member_id.trim())}`];
      });
      for (const c of await pages('Contacts', { where: clauses.join(' OR '), includeArchived: 'true' }, 'Contacts'))
        contacts.set(c.ContactID, c);
    }
    const ids = [...contacts.keys()];
    for (let n = 0; n < ids.length; n += 15) {
      const batch = ids.slice(n, n + 15);
      const rows = await pages('Invoices', { ContactIDs: batch.join(','), where: 'Type=="ACCREC"', order: 'Date DESC' }, 'Invoices');
      assert.ok(rows.every(i => batch.includes(i.Contact?.ContactID)));
      invoices.push(...rows);
    }
    assert.equal(new Set(invoices.map(i => i.InvoiceID)).size, invoices.length);
    const providers = [];
    for (const c of candidates) {
      const old = original.find(p => p.memberId === c.memberId);
      assert.equal(old.contacts.length, 1);
      const account = proposal.members.find(p => p.memberId === c.memberId).liveSource.preferences.ym_web_site_member_id.trim();
      const found = [...contacts.values()].filter(x => x.ContactID === old.contacts[0].ContactID
        || x.EmailAddress?.trim().toLowerCase() === c.email.trim().toLowerCase() || x.AccountNumber?.trim() === account);
      assert.equal(found.length, 1, 'Contact identity changed');
      assert.equal(found[0].ContactID, old.contacts[0].ContactID);
      assert.equal(found[0].EmailAddress?.trim().toLowerCase(), c.email.trim().toLowerCase());
      assert.equal(found[0].AccountNumber?.trim() || '', old.contacts[0].AccountNumber?.trim() || '');
      const history = invoices.filter(i => i.Contact.ContactID === found[0].ContactID && memberInvoice(i))
        .sort((a,b) => String(b.DateString).localeCompare(String(a.DateString)) || a.InvoiceID.localeCompare(b.InvoiceID));
      const latest = history.find(i => !['VOIDED','DELETED','DRAFT'].includes(i.Status));
      const paid = history.find(i => i.Status === 'PAID');
      assert.equal(latest?.InvoiceID, old.latestInvoiceId);
      assert.equal(paid?.InvoiceID, old.latestPaidInvoiceId);
      assert.deepEqual(financialProjection(paid), financialProjection(old.membershipInvoices.find(i => i.InvoiceID === old.latestPaidInvoiceId)));
      const payments = [];
      for (const p of paid.Payments || []) {
        const body = await get(`Payments/${p.PaymentID}`);
        assert.equal(body.Payments?.length, 1);
        const live = body.Payments[0], prior = old.payments.find(x => x.PaymentID === p.PaymentID);
        assert.ok(prior);
        for (const key of ['PaymentID','Status','Amount','Date','CurrencyRate','IsReconciled'])
          assert.deepEqual(live[key], prior[key]);
        assert.equal(live.Invoice?.InvoiceID, paid.InvoiceID);
        payments.push(live);
      }
      providers.push({ ...old, contacts: found, membershipInvoices: history, payments });
      if (providers.length % 12 === 0) console.log(`Verified ${providers.length}/72; requests=${requests}`);
    }
    const path = save(`provider-${Date.now()}`, { reviewSha256: REVIEW_HASH, csvSha256: CSV_HASH,
      capturedAt: new Date().toISOString(), providers, responses, requests, financialWrites: 0 });
    console.log(`PROVIDER_EVIDENCE ${path}`);
    return;
  }

  const evidencePath = process.argv[3];
  assert.ok(evidencePath?.startsWith(`${out}/provider-`) && evidencePath.endsWith('.json'));
  const evidenceBytes = fs.readFileSync(evidencePath), evidence = JSON.parse(evidenceBytes);
  assert.equal(evidence.reviewSha256, REVIEW_HASH); assert.equal(evidence.csvSha256, CSV_HASH);
  const age = Date.now() - Date.parse(evidence.capturedAt);
  assert.ok(age >= 0 && age < 30 * 60000, 'Provider evidence must be less than 30 minutes old');
  assert.equal(evidence.providers.length, 72);
  assert.equal(new Set(evidence.providers.map(p => p.memberId)).size, 72);
  const evidenceHash = sha(evidenceBytes);
  const { shapePersistedCommitment } = await import('../api/membership/member-membership.js');
  const dryPath = `${out}/dry-v2-${evidenceHash}.json`;
  if (mode === 'apply') {
    const dry = read(dryPath);
    assert.equal(dry.evidenceHash, evidenceHash); assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.inserted, 72);
  }
  const db = await connectDestination();
  try {
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SET LOCAL statement_timeout='90s'");
    const protectedTables = ['member', 'member_membership_history', 'member_preference_value',
      'preference_field', 'membership_tier_config', 'membership_billing_agreements', 'membership_payment_plans',
      'bnms_dd_alpha_adoption', 'bnms_dd_beta_adoption', 'bnms_dd_pilot_import', 'bnms_dd_historical_payment',
      'gocardless_customers', 'gocardless_mandate_discovery_row'];
    await db.query(`LOCK TABLE ${protectedTables.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const readTable = async table => {
      const scope = table === 'member_preference_value'
        ? 'member_id IN (SELECT id FROM member WHERE tenant_id=$1)' : 'tenant_id=$1';
      return (await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE ${scope} ORDER BY id`, [TENANT])).rows.map(r => r.data);
    };
    const before = {};
    for (const table of protectedTables) before[table] = await readTable(table);
    const sources = (await db.query(SOURCE_SQL, [TENANT])).rows;
    const records = [];
    for (const c of candidates) {
      const provider = evidence.providers.find(p => p.memberId === c.memberId);
      assert.ok(provider);
      const review = proposal.members.find(p => p.memberId === c.memberId);
      const oldProvider = original.find(p => p.memberId === c.memberId);
      const originalAssessment = assessMember({ review, live: context.sources.find(s => s.id === c.memberId),
        provider: oldProvider, configs: context.configs, classFieldId: context.classFields[0].id });
      assert.deepEqual(originalAssessment, c, 'Supporting evidence differs from pinned review');
      const liveMember = before.member.find(m => m.id === c.memberId);
      const pinnedMember = snapshot.members.find(m => m.id === c.memberId);
      for (const [key, value] of Object.entries(pinnedMember)) assert.deepEqual(liveMember?.[key], value);
      const own = before.member_membership_history.filter(h => h.member_id === c.memberId);
      const existing = own.find(h => h.id === historyId(c.memberId));
      assert.equal(own.length, existing ? 1 : 0, 'Unreviewed history exists');
      if (mode === 'replay') assert.ok(existing, 'Replay cannot insert missing rows');
      if (mode === 'apply') assert.equal(existing, undefined, 'Use replay for already-applied cohort');
      const live = { ...sources.find(s => s.id === c.memberId), history_count: own.length - (existing ? 1 : 0) };
      assert.deepEqual(live, context.sources.find(s => s.id === c.memberId), 'Membership source changed');
      assert.equal(live.duplicate_fields, false); assert.equal(live.dd_evidence, false);
      const assessed = assessMember({ review, live, provider, configs: before.membership_tier_config,
        classFieldId: context.classFields[0].id });
      assert.deepEqual(assessed, c, 'Candidate no longer matches approval');
      const config = before.membership_tier_config.find(x => x.structure_field_id === context.classFields[0].id
        && x.structure_match_value === c.memberClass && x.name === c.structure && x.is_active
        && x.effective_from <= '2026-10-14' && (!x.effective_to || x.effective_to >= '2026-10-14'));
      assert.ok(config);
      assert.deepEqual(config, context.configs.find(x => x.id === config.id), 'Structure changed');
      const record = buildRecord(c, config, provider);
      if (existing) assertRecord(existing, record);
      records.push(record);
    }
    assert.equal(new Set(records.map(r => r.accounting_invoice_id)).size, 72);
    const beforeHash = canonicalHash(before);
    // Unrelated members can legitimately browse the live portal between phases.
    // Pin the approved records across phases; still compare ALL protected rows
    // before/after within each locked transaction below.
    const approvalStateHash = canonicalHash(approvalState(before, records));
    if (mode === 'apply') assert.equal(read(dryPath).approvalStateHash, approvalStateHash, 'Approved member state changed since dry run');
    // Private durable before-image, written before any SQL insert, even during dry run.
    const journal = save(`before-${mode}-${Date.now()}`, { evidenceHash, beforeHash, before, records,
      approval: { reviewSha256: REVIEW_HASH, csvSha256: CSV_HASH, approvedCount: 72, exactDatesApproved: true } });
    let inserted = 0;
    for (const record of records) {
      if (before.member_membership_history.some(h => h.id === record.id)) continue;
      assert.notEqual(mode, 'replay');
      const keys = Object.keys(record);
      await db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_,i) => `$${i+1}`).join(',')})`,
        keys.map(k => record[k] != null && typeof record[k] === 'object' ? JSON.stringify(record[k]) : record[k]));
      inserted++;
    }
    const after = await readTable('member_membership_history');
    for (const r of records) {
      const actual = after.find(h => h.id === r.id);
      assertRecord(actual, r);
      const display = shapePersistedCommitment(actual, new Date('2026-10-14T12:00:00Z'));
      assert.equal(display.structureName, r.commitment_snapshot.config.name);
      assert.equal(display.startDate, r.term_start_date);
      assert.equal(display.endDate, r.term_end_date);
      assert.equal(display.renewalDate, r.membership_renewal_date);
      assert.equal(display.agreedPrice, r.total_with_vat);
      assert.equal(display.lifecycle, 'current');
    }
    const addedIds = new Set(records.filter(r => !before.member_membership_history.some(h => h.id === r.id)).map(r => r.id));
    assert.deepEqual(after.filter(h => !addedIds.has(h.id)), before.member_membership_history);
    for (const table of protectedTables.filter(t => t !== 'member_membership_history'))
      assert.deepEqual(await readTable(table), before[table], `Unexpected change in ${table}`);
    if (mode === 'replay') assert.equal(inserted, 0);
    await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    const receipt = { mode, evidenceHash, beforeHash, approvalStateHash, inserted, committed: mode === 'apply',
      financialWrites: 0, otherTablesChanged: 0, journal, at: new Date().toISOString() };
    if (mode === 'apply') {
      const persisted = await readTable('member_membership_history');
      for (const r of records) assertRecord(persisted.find(h => h.id === r.id), r);
    }
    const receiptPath = mode === 'dry-run' ? save(`dry-v2-${evidenceHash}`, receipt) : save(`receipt-${mode}-${Date.now()}`, receipt);
    console.log(JSON.stringify({ ...receipt, receiptPath }));
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { await db.end(); }
}
main().catch(e => {
  // Avoid logging assertion contents containing private member data.
  console.error(JSON.stringify({ stopped: true, code: e.code || e.name,
    reason: e.code === 'ERR_ASSERTION' ? String(e.message).split('\n')[0] : 'Operation failed; inspect private evidence',
    location: e.stack?.split('\n').find(l => l.includes('scripts/reconstruct-bnms-approved-72.mjs:'))?.trim() }));
  process.exitCode = 1;
});
