// Three explicitly approved paid legacy histories only. No provider financial writes.
// The two unknown-payment cases remain untouched. No schema, role or UI changes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { TENANT, MEMBERS, hash, prepareProposal, planIdempotentInserts }
  from './prepare-bnms-five-members.mjs';

export const AS_OF = '2026-10-20';
export const APPROVED = [
  [MEMBERS[0], '552222ac-f33b-4ecd-8c76-f1ab07e41e5c', '300005416', 156],
  [MEMBERS[2], 'a31c81a0-ac4b-4428-ad11-f6dad75ddc49', '300004834', 61],
  [MEMBERS[4], 'f289b192-0e3a-4401-b0f9-815acd4b4f57', '300004921', 156],
];
const INPUTS = [
  ['/tmp/bnms-five-members-evidence.json', 'a94ff6c2005303c6d42e7aeb3a1288fe6069a6693a4184ff07f5538c32efb367'],
  ['/tmp/bnms-five-decisions.json', 'cf4d9d91f1296bc15ea3ece67506d08bde21c3aae2131e6a398ab030cf0a25bc'],
  ['/tmp/bnms-five-source-rows.json', '5a21600a6fbfa8c3eb255241846d41df4e9a418e389bb7eeb5781552c2c864ad'],
];
// Actual DEST schema, indexes, constraints and all history trigger bodies reviewed.
const SCHEMA_HASH = '05c88b3be37e121e2963ded879f00f640d5e71cb7b63ae624ec11388693a4c9e';
const XERO_TENANT = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
const SQL_SCHEMA = {
  columns: `SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
    WHERE table_schema='public' AND table_name='member_membership_history' ORDER BY ordinal_position`,
  constraints: `SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
    WHERE conrelid='public.member_membership_history'::regclass ORDER BY conname`,
  triggers: `SELECT tgname,tgenabled,pg_get_triggerdef(t.oid) definition,pg_get_functiondef(t.tgfoid) function
    FROM pg_trigger t WHERE tgrelid='public.member_membership_history'::regclass
    AND NOT tgisinternal ORDER BY tgname`,
  indexes: `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public'
    AND tablename='member_membership_history' ORDER BY indexname`,
};
const schema = async db => {
  const result = {};
  for (const [key, sql] of Object.entries(SQL_SCHEMA)) result[key] = (await db.query(sql)).rows;
  assert.equal(hash(result), SCHEMA_HASH, 'Reviewed schema/defaults/constraints/triggers changed');
  return result;
};
function xeroDate(value) {
  const match = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(value || '');
  assert.ok(match, 'Unverified payment date');
  return new Date(Number(match[1])).toISOString();
}
export function buildApprovedRows(evidence, decisions, sourceRows) {
  assert.deepEqual(decisions.map(d => d.memberId).sort(), APPROVED.map(a => a[0]).sort());
  const proposal = prepareProposal(evidence, decisions, AS_OF, sourceRows);
  assert.equal(proposal.blocked.length, 0, 'Missing source authority');
  return APPROVED.map(([memberId, invoiceId, number, amount]) => {
    const selected = proposal.rows.find(r => r.member_id === memberId);
    assert.equal(selected.accounting_invoice_id, invoiceId);
    assert.equal(selected.accounting_invoice_number, number);
    assert.equal(selected.total_with_vat, amount);
    assert.equal(selected.payment_status, 'paid');
    const row = structuredClone(selected);
    delete row.payment_frequency; // Not a persisted column in the reviewed destination.
    row.commitment_snapshot = null; // Never bypass the rolling-completeness constraint.
    const decision = decisions.find(d => d.memberId === memberId);
    row.paid_at = decision.payments.map(p => xeroDate(p.Date)).sort().at(-1);
    row.notes = JSON.stringify({
      ...JSON.parse(row.notes),
      approvalDate: AS_OF,
      approvalScope: 'three_independently_verified_paid_histories_only',
      recordKind: 'legacy_date_only_fee_history',
      purchasedRollingCommitment: false,
      currentScheduleAuthority: 'not_evidence_of_a_purchased_commitment_or_renewal',
      historicalAnnualPriceAuthority: 'unknown_not_inferred',
      paymentMethodAuthority: 'not_inferred_from_legacy_DD_label',
      frequencyAuthority: 'unknown_not_inferred',
      invoiceTermAssociationAuthority: 'operator_reviewed_original_membership_history_and_existing_invoice',
      providerFinancialWrites: 0,
    });
    for (const field of ['config_id', 'term_key', 'membership_renewal_date',
      'commitment_snapshot', 'billing_agreement_id', 'payment_method', 'billing_period', 'annual_cost']) {
      assert.equal(row[field], null, `Unsupported authority: ${field}`);
    }
    return row;
  });
}
export function invoiceProjection(invoice) {
  const fields = ['InvoiceID', 'InvoiceNumber', 'Type', 'Status', 'CurrencyCode',
    'Date', 'DueDate', 'Total', 'SubTotal', 'TotalTax', 'AmountPaid', 'AmountDue',
    'LineAmountTypes', 'FullyPaidOnDate'];
  return {
    ...Object.fromEntries(fields.map(key => [key, invoice[key] ?? null])),
    contactId: invoice.Contact?.ContactID,
    credited: invoice.AmountCredited || 0,
    credits: invoice.CreditNotes || [], prepayments: invoice.Prepayments || [],
    overpayments: invoice.Overpayments || [],
    lines: (invoice.LineItems || []).map(line => Object.fromEntries([
      'LineItemID','Description','Quantity','UnitAmount','LineAmount','TaxType','TaxAmount','AccountCode',
    ].map(key => [key, line[key] ?? null]))),
    payments: (invoice.Payments || []).map(p => ({
      id: p.PaymentID, amount: p.Amount, date: p.Date,
    })).sort((a,b) => a.id.localeCompare(b.id)),
  };
}
export function paymentProjection(payment) {
  return {
    id: payment.PaymentID, invoiceId: payment.Invoice?.InvoiceID,
    status: payment.Status, amount: payment.Amount, date: payment.Date,
    type: payment.PaymentType, currencyRate: payment.CurrencyRate,
    accountId: payment.Account?.AccountID, accountCurrency: payment.Account?.CurrencyCode,
    reconciled: payment.IsReconciled,
  };
}
async function verifyWorkbookRows(proposalRows) {
  for (const row of proposalRows) {
    const pin = JSON.parse(row.notes).sourcePin;
    assert.ok(pin?.file.startsWith('attached_assets/') && pin.file.endsWith('.xlsx'));
    const buffer = await readFile(pin.file);
    assert.equal(createHash('sha256').update(buffer).digest('hex'), pin.sha256, 'Workbook bytes changed');
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheet = workbook.Sheets[pin.sheet];
    assert.ok(sheet, 'Source sheet missing');
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
    const actual = {};
    data[0].forEach((header, index) => {
      const value = data[pin.row - 1]?.[index];
      if (value == null || value === '') return;
      actual[header] = value instanceof Date
        ? `${value.toISOString().slice(0,10)} 00:00:00` : String(value);
    });
    assert.equal(hash(actual), pin.rowHash, 'Source row content changed');
    assert.equal(actual['iConnect UUID'], row.member_id);
  }
}
function assertRecord(actual, expected) {
  assert.ok(actual, 'Expected history missing');
  for (const [key,value] of Object.entries(expected)) {
    if (['created_at','updated_at','paid_at'].includes(key) && value != null) {
      assert.equal(Date.parse(actual[key]), Date.parse(value), `Persisted ${key} differs`);
    } else assert.deepEqual(actual[key], value, `Persisted ${key} differs`);
  }
}
const ident = value => {
  assert.ok(/^[a-z][a-z0-9_]*$/.test(value), 'Unexpected SQL identifier');
  return `"${value}"`;
};

export async function main(args = process.argv.slice(2)) {
  const [mode, directory] = args;
  assert.ok(mode === '--execute-approved-three' && args.length === 2,
    'Only the explicitly approved three-record execution is supported');
  assert.ok(/^\/tmp\/bnms-five-paid-[a-z0-9-]+$/.test(directory || ''), 'Private audit directory required');
  const loaded = [];
  for (const [path, expected] of INPUTS) {
    const value = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(hash(value), expected, 'Pinned input changed; obtain a new review');
    loaded.push(value);
  }
  const [evidence, decisions, sourceRows] = loaded;
  const partialRows = buildApprovedRows(evidence, decisions, sourceRows);
  await verifyWorkbookRows(partialRows);
  await mkdir(directory, { mode: 0o700 }); // Exclusive new directory; never overwrite an audit.
  const journal = await open(`${directory}/journal.jsonl`, 'wx', 0o600);
  let previousHash = null;
  const record = async data => {
    const entry = { previousHash, at: new Date().toISOString(), ...data };
    previousHash = hash(entry);
    await journal.writeFile(`${JSON.stringify({ ...entry, hash: previousHash })}\n`);
    await journal.sync();
  };
  let db, providerReads = 0, committed = false;
  try {
    // Imported only after the offline scope, source-file and journal checks.
    const { connectDestination } = await import('./annual-meeting-destination.mjs');
    db = await connectDestination();
    process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
    const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
    const auth = await getValidXeroAccessToken(TENANT);
    assert.equal(auth.tenantId, XERO_TENANT, 'Xero tenant changed');
    const get = async path => {
      assert.ok(/^(Invoices|Contacts|Payments)\/[a-f0-9-]{36}$/.test(path), 'Unapproved provider path');
      assert.ok(++providerReads <= 30, 'Provider read budget exceeded');
      await new Promise(resolve => setTimeout(resolve, 1300));
      const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': XERO_TENANT,
          Accept: 'application/json' },
      });
      assert.equal(response.status, 200, `Xero GET failed (${response.status}); no retry`);
      const result = await response.json();
      assert.ok(!result.HasErrors, 'Xero response contains validation errors');
      const values = result[path.split('/')[0]];
      assert.equal(values?.length, 1, 'Xero response cardinality');
      return values[0];
    };
    const refresh = async () => {
      const fresh = structuredClone(evidence), freshDecisions = structuredClone(decisions);
      for (const decision of freshDecisions) {
        const target = fresh.find(e => e.member.id === decision.memberId);
        const oldInvoice = target.invoices.find(i => i.InvoiceID === decision.invoiceId);
        const invoice = await get(`Invoices/${decision.invoiceId}`);
        assert.deepEqual(invoiceProjection(invoice), invoiceProjection(oldInvoice), 'Invoice financial state changed');
        const oldContact = target.contacts.find(c => c.ContactID === decision.contactId);
        const contact = await get(`Contacts/${decision.contactId}`);
        for (const key of ['ContactID', 'EmailAddress', 'AccountNumber']) {
          assert.deepEqual(contact[key] ?? null, oldContact[key] ?? null, 'Provider contact binding changed');
        }
        for (let i = 0; i < decision.payments.length; i++) {
          const expected = decision.payments[i];
          const payment = await get(`Payments/${expected.PaymentID}`);
          assert.deepEqual(paymentProjection(payment), paymentProjection(expected), 'Verified payment changed');
          decision.payments[i] = payment;
        }
        target.invoices = target.invoices.map(i => i.InvoiceID === invoice.InvoiceID ? invoice : i);
        target.contacts = target.contacts.map(c => c.ContactID === contact.ContactID ? contact : c);
      }
      // Re-exercise identity, membership-only lines, credits and settlement checks.
      const freshRows = buildApprovedRows(fresh, freshDecisions, sourceRows);
      for (let i = 0; i < freshRows.length; i++) {
        const originalNotes = JSON.parse(partialRows[i].notes), freshNotes = JSON.parse(freshRows[i].notes);
        // GET detail responses may expand contact/invoice objects. All actual
        // bindings and financial invariants above must nevertheless be identical.
        freshNotes.evidenceHash = originalNotes.evidenceHash;
        freshRows[i].notes = JSON.stringify(freshNotes);
        assert.deepEqual(freshRows[i], partialRows[i], 'Revalidated proposal changed');
      }
      await record({ phase: 'provider_verified', invoices: freshDecisions.map(d => ({
        memberId: d.memberId, invoice: invoiceProjection(fresh.find(e => e.member.id === d.memberId)
          .invoices.find(i => i.InvoiceID === d.invoiceId)),
        payments: d.payments.map(paymentProjection),
      })) });
    };
    const takeProtected = async tables => {
      const result = {};
      for (const table of tables) result[table] = (await db.query(`SELECT count(*)::int count,
        md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY md5(to_jsonb(r)::text)),'')) hash
        FROM public.${ident(table)} r`)).rows[0];
      return result;
    };
    let rehearsalPin, persistedRows, persistedHash;
    for (const stage of ['dry-run', 'apply', 'replay']) {
      await refresh(); // Fresh provider reads before every transaction/commit attempt.
      await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
        const protectedTables = (await db.query(`SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'
          AND (table_name ~ '(membership|gocardless|bnms|historical.*invoice|stripe.*payment|communication)'
            OR table_name IN ('member','member_preference_value','preference_field','role','organization'))
          AND table_name <> 'member_membership_history' ORDER BY table_name`)).rows.map(r => r.table_name);
        await db.query(`LOCK TABLE public.member_membership_history,${protectedTables.map(t => `public.${ident(t)}`).join(',')}
          IN SHARE ROW EXCLUSIVE MODE`);
        const reviewed = await schema(db);
        assert.equal((await db.query('SELECT slug FROM tenant WHERE id=$1', [TENANT])).rows[0]?.slug, 'bnms');
        await db.query('SELECT id FROM tenant WHERE id=$1 FOR UPDATE', [TENANT]);
        const members = (await db.query(`SELECT to_jsonb(m) data FROM member m
          WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [TENANT, MEMBERS])).rows.map(r => r.data);
        assert.equal(members.length, 5);
        for (const member of members) {
          const original = evidence.find(e => e.member.id === member.id).member;
          for (const key of Object.keys(original)) {
            if (key === 'created_on' && original[key] != null) {
              assert.equal(Date.parse(member[key]), Date.parse(original[key]), `Local member ${key} changed`);
            } else assert.deepEqual(member[key], original[key], `Local member ${key} changed`);
          }
          if (APPROVED.some(a => a[0] === member.id)) {
            assert.ok(!member.deleted_at && !member.anonymized_at && member.status !== 'deleted'
              && !member.is_sample && !member.is_test && !member.is_guest, 'Ineligible member');
          }
        }
        const preferences = (await db.query(`SELECT v.member_id,f.name,v.value FROM member_preference_value v
          JOIN preference_field f ON f.id=v.field_id WHERE f.tenant_id=$1 AND v.member_id=ANY($2::uuid[])
          ORDER BY v.member_id,f.name,v.id`, [TENANT,MEMBERS])).rows;
        for (const captured of evidence) for (const name of [
          'member_class', 'membership_status', 'ym_membership_type', 'ym_date_membership_expires', 'ym_web_site_member_id',
        ]) {
          const current = preferences.filter(p => p.member_id === captured.member.id && p.name === name).map(p => p.value);
          assert.deepEqual(current, captured.prefs.filter(p => p.name === name).map(p => p.value), `Local ${name} changed`);
        }
        const allowedIds = APPROVED.map(a => a[0]);
        for (const table of ['membership_billing_agreements','membership_payment_plans','membership_successor_election',
          'membership_payment_quote','member_membership_amendment']) {
          assert.equal((await db.query(`SELECT count(*)::int n FROM ${ident(table)}
            WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])`, [TENANT,allowedIds])).rows[0].n, 0,
          `Unexpected existing ${table}`);
        }
        const before = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h ORDER BY id')).rows.map(r => r.data);
        const scopeBefore = before.filter(r => MEMBERS.includes(r.member_id));
        if (stage === 'dry-run') {
          assert.equal(scopeBefore.length, 0, 'Expected no existing history');
          // Explicit NULLs suppress unsubstantiated schema defaults. Only timestamps
          // are generated; nullable price/discount/config/renewal fields remain unknown.
          const now = new Date().toISOString();
          persistedRows = partialRows.map(row => {
            const full = Object.fromEntries(reviewed.columns.map(c => [c.column_name, null]));
            for (const key of Object.keys(row)) assert.ok(key in full, `Unknown destination column ${key}`);
            Object.assign(full, row, { created_at: now, updated_at: now });
            for (const column of reviewed.columns) if (column.is_nullable === 'NO') {
              assert.notEqual(full[column.column_name], null, `Required ${column.column_name}`);
            }
            return full;
          });
          persistedHash = hash(persistedRows);
        }
        const plan = planIdempotentInserts(persistedRows, before.map(row => {
          if (!persistedRows.some(r => r.id === row.id)) return row;
          const normalized = structuredClone(row);
          for (const key of ['created_at','updated_at','paid_at']) {
            if (normalized[key] != null) normalized[key] = new Date(normalized[key]).toISOString();
          }
          return normalized;
        }));
        assert.equal(plan.pending.length, stage === 'replay' ? 0 : 3);
        assert.equal(plan.replayed.length, stage === 'replay' ? 3 : 0);
        // Accounting IDs must not already be attached to an organisation history,
        // separate historical invoice/import row, or a historical-only DD record.
        const invoiceIds = APPROVED.map(a => a[1]);
        for (const table of ['organisation_membership_history','historical_member_invoice',
          'historical_invoice_import_row','bnms_dd_historical_payment','membership_instalment_invoices']) {
          const collisions = (await db.query(`SELECT count(*)::int n FROM ${ident(table)} r
            WHERE to_jsonb(r)->>'xero_invoice_id'=ANY($1::text[])
              OR to_jsonb(r)->>'accounting_invoice_id'=ANY($1::text[])
              OR to_jsonb(r)->>'invoice_id'=ANY($1::text[])`, [invoiceIds])).rows[0].n;
          assert.equal(collisions, 0, `Existing invoice association in ${table}`);
        }
        const protectedBefore = await takeProtected(protectedTables);
        const historyBeforeHash = hash(before), memberHash = hash(members), preferenceHash = hash(preferences);
        const pin = hash({ rows: persistedRows, memberHash, preferenceHash, historyBeforeHash, schemaHash: hash(reviewed) });
        if (stage === 'apply') assert.equal(pin, rehearsalPin, 'Scope changed since rollback rehearsal');
        await record({ phase: 'before_write', stage, persistedHash, rows: persistedRows, pin,
          protectedBefore, historyBeforeHash, memberHash, preferenceHash, schema: reviewed });
        for (const row of plan.pending) {
          const keys = Object.keys(row);
          const inserted = await db.query(`INSERT INTO member_membership_history (${keys.map(ident).join(',')})
            VALUES (${keys.map((_,i) => `$${i+1}`).join(',')}) RETURNING id`, keys.map(key => row[key]));
          assert.equal(inserted.rowCount, 1);
        }
        const after = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h ORDER BY id')).rows.map(r => r.data);
        const insertedIds = new Set(persistedRows.map(r => r.id));
        for (const row of persistedRows) assertRecord(after.find(h => h.id === row.id), row);
        assert.deepEqual(after.filter(h => !insertedIds.has(h.id)), before.filter(h => !insertedIds.has(h.id)),
          'Other history changed, including deferred members or other tenants');
        assert.equal(after.length - before.length, stage === 'replay' ? 0 : 3);
        assert.deepEqual(await takeProtected(protectedTables), protectedBefore, 'Protected whole rows changed');
        await record({ phase: 'validated', stage, historyAfterHash: hash(after), protectedTables: protectedTables.length,
          insertsValidated: plan.pending.length, replayed: plan.replayed.length, protectedRowsUnchanged: true });
        await db.query(stage === 'apply' ? 'COMMIT' : 'ROLLBACK');
        if (stage === 'dry-run') {
          rehearsalPin = pin;
          const actual = (await db.query(`SELECT count(*)::int n FROM member_membership_history
            WHERE id=ANY($1::uuid[])`, [persistedRows.map(r => r.id)])).rows[0].n;
          assert.equal(actual, 0, 'Rehearsal rollback did not remove all inserts');
        }
        if (stage === 'apply') committed = true;
        if (stage !== 'dry-run') {
          const actual = (await db.query(`SELECT to_jsonb(h) data FROM member_membership_history h
            WHERE id=ANY($1::uuid[]) ORDER BY id`, [persistedRows.map(r => r.id)])).rows.map(r => r.data);
          for (const row of persistedRows) assertRecord(actual.find(h => h.id === row.id), row);
        }
        await record({ phase: stage === 'apply' ? 'committed' : 'rolled_back', stage,
          inserted: stage === 'apply' ? 3 : 0, replayed: plan.replayed.length, persistedHash });
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    const result = { complete: true, asOf: AS_OF, inserted: 3, rollbackRehearsed: 3,
      replayInserts: 0, providerReads, providerFinancialWrites: 0, protectedRowsUnchanged: true,
      untouchedMemberIds: [MEMBERS[1],MEMBERS[3]], rows: persistedRows.map(r => ({
        memberId: r.member_id, historyId: r.id, invoiceNumber: r.accounting_invoice_number,
        invoiceId: r.accounting_invoice_id, start: r.term_start_date, end: r.term_end_date,
        total: r.total_with_vat, paidAt: r.paid_at,
      })) };
    await record({ phase: 'complete', result });
    console.log(JSON.stringify(result));
  } catch (error) {
    await record({ phase: 'stopped', committed, errorCode: error.code || error.name,
      reason: error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : 'Execution stopped; inspect private audit' });
    throw error;
  } finally { if (db) await db.end(); await journal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ stopped: true, code: error.code || error.name,
      reason: error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : 'Execution stopped; inspect private audit',
      location: error.stack?.split('\n').find(line => line.includes('repair-bnms-five-verified-paid.mjs:'))?.trim() }));
    process.exitCode = 1;
  });
}
