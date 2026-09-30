/**
 * Task #945 — Apply £240 training fund to booking OOE-1773151742540-THT1Y.
 *
 * Parent reference OOE-1773151742540-THT1Y (University of Birmingham,
 * organisation 6b4f477c-4cfc-4000-886d-5e8b67be210a) was made on account by
 * accident — it should have been paid from the organisation's training fund.
 * The reference actually corresponds to 5 sibling bookings (-1 .. -5) on a
 * single Xero invoice SI-43837, each £48, totalling £240. The org has
 * £2,942.50 in the fund (well above the £240 total).
 *
 * Apply £240 from the training fund (2942.50 -> 2702.50), zero each
 * booking's account_amount and set training_fund_amount = 48, and issue a
 * single £240 Xero credit note against SI-43837 so the invoice is fully
 * reconciled in one step.
 *
 * The script is idempotent and guarded so a second run is a no-op:
 *   - INSERT of training_fund_transaction is skipped if any rows already
 *     exist for the booking_id.
 *   - UPDATE of organization.training_fund_balance is guarded with the
 *     expected current value (2942.50).
 *   - UPDATE of each booking is guarded with the expected current values
 *     (training_fund_amount = 0, account_amount = 48).
 *   - Xero credit note creation uses a Reference de-dupe ("Manual-TF-fix:
 *     OOE-1773151742540-THT1Y") so a re-run reuses the existing CN; if any
 *     booking already has xero_credit_note_id we skip the Xero step.
 *
 * Usage:
 *   node scripts/fix-booking-OOE-1773151742540-tf.mjs [--dry-run]
 *     [--skip-xero]   # only run the DB changes
 *     [--xero-only]   # only run the Xero credit note (assumes DB already done)
 */
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;
const PG_URL = process.env.DEST_DATABASE_URL;

// api/_lib/database.js (which api/_lib/xero.js depends on) reads
// SUPABASE_URL / SUPABASE_SERVICE_KEY / DATABASE_URL at import time. In this
// workspace those point at the *legacy* SOURCE project, not the destination
// prod DB where the Xero tokens live. Override before the dynamic import.
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = SUPABASE_KEY;
process.env.DATABASE_URL = PG_URL;
const { createXeroCreditNote } = await import('../api/_lib/xero.js');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(1);
}
if (!PG_URL) {
  console.error('Missing DEST_DATABASE_URL');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_XERO = process.argv.includes('--skip-xero');
const XERO_ONLY = process.argv.includes('--xero-only');

const PARENT_REF = 'OOE-1773151742540-THT1Y';
const ORG_ID = '6b4f477c-4cfc-4000-886d-5e8b67be210a';
const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const PER_BOOKING_AMOUNT = 48;
const TOTAL_APPLIED = 240;
const EXPECTED_ORG_BALANCE_BEFORE = 2942.50;
const EXPECTED_ORG_BALANCE_AFTER = 2702.50;

const BOOKINGS = [
  { id: '6ba46195-e47d-4a32-8836-23dcf010c8f8', reference: 'OOE-1773151742540-THT1Y-1', amount: 48 },
  { id: '59a65a57-7cf2-4e0e-937c-57e872820abb', reference: 'OOE-1773151742540-THT1Y-2', amount: 48 },
  { id: '3e82c194-560f-4c65-898f-2e1baef7891f', reference: 'OOE-1773151742540-THT1Y-3', amount: 48 },
  { id: '6cefbb6f-1fbb-4c09-aef1-7233a34f2f1f', reference: 'OOE-1773151742540-THT1Y-4', amount: 48 },
  { id: '68a7def5-4cc0-42af-ba02-1e23147856b2', reference: 'OOE-1773151742540-THT1Y-5', amount: 48 },
];

const XERO_INVOICE_ID = '70509efe-a777-41bf-aaf5-9630f5c893fe';
const XERO_INVOICE_NUMBER = 'SI-43837';
const XERO_REFERENCE = `Manual-TF-fix: ${PARENT_REF}`;
const XERO_DESCRIPTION =
  `Manual adjustment: £${TOTAL_APPLIED.toFixed(2)} paid from training fund ` +
  `for bookings ${BOOKINGS.map(b => b.reference).join(', ')} ` +
  `(University of Birmingham). Invoice ${XERO_INVOICE_NUMBER}.`;
const REASON_TEMPLATE = (ref) =>
  `Manual adjustment (task #945): apply £${PER_BOOKING_AMOUNT.toFixed(2)} ` +
  `training fund to booking ${ref} (parent ${PARENT_REF}) — booking was ` +
  `mistakenly placed on account.`;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function verifyState() {
  const ids = BOOKINGS.map(b => b.id);
  const { data: bookings, error: bErr } = await supabase
    .from('booking')
    .select('id, booking_reference, tenant_id, organization_id, total_cost, training_fund_amount, account_amount, voucher_amount, discount_code_amount, payment_method, xero_invoice_id, xero_invoice_number, xero_credit_note_id, xero_credit_note_number, stripe_payment_intent_id, status')
    .in('id', ids);
  if (bErr) throw bErr;

  const { data: org, error: oErr } = await supabase
    .from('organization')
    .select('id, name, tenant_id, training_fund_balance')
    .eq('id', ORG_ID)
    .single();
  if (oErr) throw oErr;

  const { data: existingTxs, error: tErr } = await supabase
    .from('training_fund_transaction')
    .select('id, type, amount, balance_before, balance_after, booking_id, reason, created_date')
    .in('booking_id', ids);
  if (tErr) throw tErr;

  // Order bookings deterministically by reference suffix (-1 .. -5).
  const byId = new Map(bookings.map(b => [b.id, b]));
  const ordered = BOOKINGS.map(b => byId.get(b.id)).filter(Boolean);
  return { bookings: ordered, org, existingTxs };
}

function num(v) { return Number(v ?? 0); }

async function main() {
  console.log(`\n=== Task #945 — apply £${TOTAL_APPLIED} TF to ${PARENT_REF} (5 sub-bookings) ===`);
  console.log(`DRY_RUN=${DRY_RUN} SKIP_XERO=${SKIP_XERO} XERO_ONLY=${XERO_ONLY}`);

  const before = await verifyState();
  console.log('\n--- Current state ---');
  for (const b of before.bookings) {
    console.log('booking:', {
      id: b.id,
      ref: b.booking_reference,
      total_cost: b.total_cost,
      training_fund_amount: b.training_fund_amount,
      account_amount: b.account_amount,
      voucher_amount: b.voucher_amount,
      discount_code_amount: b.discount_code_amount,
      payment_method: b.payment_method,
      xero_invoice_id: b.xero_invoice_id,
      xero_invoice_number: b.xero_invoice_number,
      xero_credit_note_id: b.xero_credit_note_id,
      xero_credit_note_number: b.xero_credit_note_number,
      status: b.status,
    });
  }
  console.log('organization:', before.org);
  console.log(`existing training_fund_transaction rows for these bookings: ${before.existingTxs.length}`);
  for (const tx of before.existingTxs) console.log('  ', tx);

  if (before.bookings.length !== BOOKINGS.length) {
    throw new Error(`Expected ${BOOKINGS.length} bookings, found ${before.bookings.length}`);
  }

  // Idempotency check: DB changes fully applied already?
  const dbAlreadyApplied =
    num(before.org.training_fund_balance) === EXPECTED_ORG_BALANCE_AFTER &&
    before.bookings.every(b => num(b.training_fund_amount) === PER_BOOKING_AMOUNT && num(b.account_amount) === 0) &&
    before.existingTxs.filter(t => t.type === 'booking_usage' && num(t.amount) === PER_BOOKING_AMOUNT).length === BOOKINGS.length;

  if (!XERO_ONLY) {
    if (dbAlreadyApplied) {
      console.log('\n[skip] DB changes already applied — skipping DB step.');
    } else {
      // Re-verify the assumed pre-state defensively.
      for (const b of before.bookings) {
        if (b.tenant_id !== TENANT_ID) throw new Error(`Booking ${b.booking_reference} tenant_id mismatch: ${b.tenant_id}`);
        if (b.organization_id !== ORG_ID) throw new Error(`Booking ${b.booking_reference} organization_id mismatch: ${b.organization_id}`);
        if (num(b.total_cost) !== PER_BOOKING_AMOUNT) throw new Error(`Booking ${b.booking_reference} total_cost drift: ${b.total_cost}`);
        if (num(b.training_fund_amount) !== 0) throw new Error(`Booking ${b.booking_reference} training_fund_amount drift: ${b.training_fund_amount}`);
        if (num(b.account_amount) !== PER_BOOKING_AMOUNT) throw new Error(`Booking ${b.booking_reference} account_amount drift: ${b.account_amount}`);
        if (num(b.voucher_amount) !== 0) throw new Error(`Booking ${b.booking_reference} voucher_amount drift: ${b.voucher_amount}`);
        if (num(b.discount_code_amount) !== 0) throw new Error(`Booking ${b.booking_reference} discount_code_amount drift: ${b.discount_code_amount}`);
        if (b.xero_invoice_id !== XERO_INVOICE_ID) throw new Error(`Booking ${b.booking_reference} xero_invoice_id mismatch: ${b.xero_invoice_id}`);
        if (b.xero_credit_note_id) throw new Error(`Booking ${b.booking_reference} already has xero_credit_note_id=${b.xero_credit_note_id}`);
      }
      if (num(before.org.training_fund_balance) !== EXPECTED_ORG_BALANCE_BEFORE) {
        throw new Error(`Org training_fund_balance drift: ${before.org.training_fund_balance}`);
      }
      if (before.existingTxs.length !== 0) {
        throw new Error(`Unexpected existing training_fund_transaction rows for these bookings`);
      }

      console.log('\n--- Applying DB changes (single transaction) ---');
      const client = new pg.Client({ connectionString: PG_URL });
      await client.connect();
      try {
        await client.query('BEGIN');

        const insertTxSql = `
          INSERT INTO training_fund_transaction
            (organization_id, tenant_id, type, amount, balance_before, balance_after, booking_id, reason)
          VALUES ($1, $2, 'booking_usage', $3, $4, $5, $6, $7)
          RETURNING id, organization_id, tenant_id, type, amount, balance_before, balance_after, booking_id, reason, created_date
        `;

        const updBookingSql = `
          UPDATE booking
          SET training_fund_amount = $1,
              account_amount = $2
          WHERE id = $3
            AND tenant_id = $4
            AND training_fund_amount = 0
            AND account_amount = $5
          RETURNING id, booking_reference, training_fund_amount, account_amount, payment_method, total_cost
        `;

        const updOrgSql = `
          UPDATE organization
          SET training_fund_balance = $3
          WHERE id = $1 AND training_fund_balance = $4 AND tenant_id = $2
          RETURNING id, training_fund_balance
        `;

        let runningBalance = EXPECTED_ORG_BALANCE_BEFORE;
        for (const b of before.bookings) {
          const balanceBefore = runningBalance;
          const balanceAfter = +(runningBalance - PER_BOOKING_AMOUNT).toFixed(2);
          const insertParams = [ORG_ID, TENANT_ID, PER_BOOKING_AMOUNT, balanceBefore, balanceAfter, b.id, REASON_TEMPLATE(b.booking_reference)];

          if (DRY_RUN) {
            console.log(`[dry-run] would INSERT training_fund_transaction for ${b.booking_reference} (balance ${balanceBefore}->${balanceAfter}):`, insertParams);
            console.log(`[dry-run] would UPDATE booking ${b.booking_reference} training_fund_amount=${PER_BOOKING_AMOUNT}, account_amount=0`);
          } else {
            const txRes = await client.query(insertTxSql, insertParams);
            console.log(`  inserted training_fund_transaction for ${b.booking_reference}:`, txRes.rows[0]);

            const bRes = await client.query(updBookingSql, [PER_BOOKING_AMOUNT, 0, b.id, TENANT_ID, PER_BOOKING_AMOUNT]);
            if (bRes.rowCount !== 1) {
              throw new Error(`Guarded booking update for ${b.booking_reference} affected ${bRes.rowCount} rows — aborting`);
            }
            console.log(`  updated booking ${b.booking_reference}:`, bRes.rows[0]);
          }
          runningBalance = balanceAfter;
        }

        if (DRY_RUN) {
          console.log(`[dry-run] would UPDATE organization training_fund_balance: ${EXPECTED_ORG_BALANCE_BEFORE} -> ${EXPECTED_ORG_BALANCE_AFTER}`);
          await client.query('ROLLBACK');
        } else {
          if (runningBalance !== EXPECTED_ORG_BALANCE_AFTER) {
            throw new Error(`Running balance ${runningBalance} !== expected ${EXPECTED_ORG_BALANCE_AFTER}`);
          }
          const orgRes = await client.query(updOrgSql, [ORG_ID, TENANT_ID, EXPECTED_ORG_BALANCE_AFTER, EXPECTED_ORG_BALANCE_BEFORE]);
          if (orgRes.rowCount !== 1) {
            throw new Error(`Guarded organization update affected ${orgRes.rowCount} rows — aborting`);
          }
          console.log('  updated organization:', orgRes.rows[0]);

          await client.query('COMMIT');
          console.log('  COMMIT');
        }
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      } finally {
        await client.end();
      }
    }
  }

  // Xero credit note.
  if (SKIP_XERO) {
    console.log('\n[skip] --skip-xero — leaving Xero invoice un-reconciled.');
  } else if (DRY_RUN) {
    console.log(`\n[dry-run] would create Xero credit note £${TOTAL_APPLIED} against invoice ${XERO_INVOICE_NUMBER}.`);
  } else {
    const cur = await verifyState();
    const alreadyCredited = cur.bookings.find(b => b.xero_credit_note_id);
    if (alreadyCredited) {
      console.log(`\n[skip] booking ${alreadyCredited.booking_reference} already has xero_credit_note_id=${alreadyCredited.xero_credit_note_id} (${alreadyCredited.xero_credit_note_number}) — skipping Xero step.`);
    } else {
      console.log(`\n--- Creating Xero credit note £${TOTAL_APPLIED} against invoice ${XERO_INVOICE_NUMBER} ---`);
      try {
        const result = await createXeroCreditNote({
          appTenantId: TENANT_ID,
          invoiceId: XERO_INVOICE_ID,
          creditAmount: TOTAL_APPLIED,
          description: XERO_DESCRIPTION,
          reference: XERO_REFERENCE,
        });
        console.log('  Xero result:', result);
        if (result.skipped) {
          console.warn(`\n[WARN] Xero credit note SKIPPED: ${result.reason}. Reconcile ${XERO_INVOICE_NUMBER} manually:`);
          console.warn(`  invoice_id=${XERO_INVOICE_ID} number=${XERO_INVOICE_NUMBER}`);
        } else if (result.creditNoteId) {
          const ids = BOOKINGS.map(b => b.id);
          const { error: updErr } = await supabase
            .from('booking')
            .update({
              xero_credit_note_id: result.creditNoteId,
              xero_credit_note_number: result.creditNoteNumber,
            })
            .in('id', ids)
            .eq('tenant_id', TENANT_ID);
          if (updErr) throw updErr;
          console.log(`  wrote xero_credit_note_id/number back to all ${ids.length} bookings: ${result.creditNoteNumber} (${result.creditNoteId})`);
        }
      } catch (err) {
        console.error('\n[ERROR] Xero credit note creation failed:', err.message);
        console.error(`Reconcile ${XERO_INVOICE_NUMBER} manually for £${TOTAL_APPLIED}:`);
        console.error(`  invoice_id=${XERO_INVOICE_ID} number=${XERO_INVOICE_NUMBER}`);
        // Do not rethrow — DB changes are already committed.
      }
    }
  }

  // Post-write verification.
  const after = await verifyState();
  console.log('\n--- Post-state ---');
  for (const b of after.bookings) {
    console.log('booking:', {
      id: b.id,
      ref: b.booking_reference,
      total_cost: b.total_cost,
      training_fund_amount: b.training_fund_amount,
      account_amount: b.account_amount,
      voucher_amount: b.voucher_amount,
      discount_code_amount: b.discount_code_amount,
      payment_method: b.payment_method,
      xero_invoice_id: b.xero_invoice_id,
      xero_invoice_number: b.xero_invoice_number,
      xero_credit_note_id: b.xero_credit_note_id,
      xero_credit_note_number: b.xero_credit_note_number,
    });
  }
  console.log('organization:', after.org);
  console.log(`training_fund_transaction rows for bookings: ${after.existingTxs.length}`);
  for (const tx of after.existingTxs) console.log('  ', tx);

  if (!DRY_RUN) {
    for (const b of after.bookings) {
      const sum = num(b.training_fund_amount) + num(b.account_amount) + num(b.voucher_amount) + num(b.discount_code_amount);
      const total = num(b.total_cost);
      console.log(`Sum check ${b.booking_reference}: tf(${b.training_fund_amount}) + account(${b.account_amount}) + voucher(${b.voucher_amount}) + dc(${b.discount_code_amount}) = ${sum} vs total_cost(${total})`);
      if (sum !== total) {
        throw new Error(`Sum mismatch on ${b.booking_reference}: ${sum} !== ${total}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
