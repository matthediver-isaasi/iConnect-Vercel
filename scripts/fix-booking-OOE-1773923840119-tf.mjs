/**
 * Task #943 — Apply £20 training fund to booking OOE-1773923840119-983DO.
 *
 * Booking 8e8ac7e9-5607-4117-8fff-fdba5516cb09 (ref OOE-1773923840119-983DO,
 * attendee Kane Ingham / University of Westminster, total £125) should have
 * been paid using the organisation's training fund. The fund has only £20
 * available, so apply £20 from the fund and leave the £105 balance on
 * account. The Xero invoice already issued against this booking (SI-43875)
 * must be reconciled so the £20 isn't double-counted.
 *
 * The script is idempotent and guarded so a second run is a no-op:
 *   - INSERT of the training_fund_transaction is skipped if a row already
 *     exists for this booking_id + type 'booking_usage'.
 *   - UPDATE of organization.training_fund_balance is guarded with the
 *     expected current value (20).
 *   - UPDATE of booking is guarded with the expected current values
 *     (training_fund_amount = 0, account_amount = 125).
 *   - Xero credit note creation uses a Reference de-dupe ("Manual-TF-fix:
 *     OOE-1773923840119-983DO") so a re-run reuses the existing CN.
 *
 * Usage:
 *   node scripts/fix-booking-OOE-1773923840119-tf.mjs [--dry-run]
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

const BOOKING_ID = '8e8ac7e9-5607-4117-8fff-fdba5516cb09';
const BOOKING_REF = 'OOE-1773923840119-983DO';
const ORG_ID = '6dafc123-cddb-4397-8d81-51d7579e61d9';
const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const APPLIED_AMOUNT = 20;
const APPLIED_DATE = '2026-03-19T12:37:20.12+00:00';
const REASON_TEXT =
  `Manual adjustment (task #943): apply £${APPLIED_AMOUNT.toFixed(2)} ` +
  `training fund to booking ${BOOKING_REF} — fund depleted, £105 balance ` +
  `remains on account.`;
const XERO_REFERENCE = `Manual-TF-fix: ${BOOKING_REF}`;
const XERO_DESCRIPTION =
  `Manual adjustment: £${APPLIED_AMOUNT.toFixed(2)} paid from training fund ` +
  `for booking ${BOOKING_REF} (Kane Ingham, University of Westminster).`;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function verifyState() {
  const { data: booking, error: bErr } = await supabase
    .from('booking')
    .select('id, booking_reference, tenant_id, organization_id, total_cost, training_fund_amount, account_amount, voucher_amount, discount_code_amount, payment_method, xero_invoice_id, xero_invoice_number, xero_credit_note_id, xero_credit_note_number, stripe_payment_intent_id, status')
    .eq('id', BOOKING_ID)
    .single();
  if (bErr) throw bErr;

  const { data: org, error: oErr } = await supabase
    .from('organization')
    .select('id, name, tenant_id, training_fund_balance')
    .eq('id', ORG_ID)
    .single();
  if (oErr) throw oErr;

  const { data: existingTxs, error: tErr } = await supabase
    .from('training_fund_transaction')
    .select('id, type, amount, balance_before, balance_after, created_date, reason')
    .eq('booking_id', BOOKING_ID);
  if (tErr) throw tErr;

  return { booking, org, existingTxs };
}

function num(v) { return Number(v ?? 0); }

async function main() {
  console.log(`\n=== Task #943 — apply £${APPLIED_AMOUNT} TF to ${BOOKING_REF} ===`);
  console.log(`DRY_RUN=${DRY_RUN} SKIP_XERO=${SKIP_XERO} XERO_ONLY=${XERO_ONLY}`);

  const before = await verifyState();
  console.log('\n--- Current state ---');
  console.log('booking:', {
    id: before.booking.id,
    ref: before.booking.booking_reference,
    tenant_id: before.booking.tenant_id,
    organization_id: before.booking.organization_id,
    total_cost: before.booking.total_cost,
    training_fund_amount: before.booking.training_fund_amount,
    account_amount: before.booking.account_amount,
    voucher_amount: before.booking.voucher_amount,
    discount_code_amount: before.booking.discount_code_amount,
    payment_method: before.booking.payment_method,
    xero_invoice_id: before.booking.xero_invoice_id,
    xero_invoice_number: before.booking.xero_invoice_number,
    xero_credit_note_id: before.booking.xero_credit_note_id,
    xero_credit_note_number: before.booking.xero_credit_note_number,
    status: before.booking.status,
  });
  console.log('organization:', before.org);
  console.log(`existing training_fund_transaction rows for booking: ${before.existingTxs.length}`);
  for (const tx of before.existingTxs) console.log('  ', tx);

  // Guards: if DB changes already applied, allow proceeding (idempotent).
  const dbAlreadyApplied =
    num(before.booking.training_fund_amount) === APPLIED_AMOUNT &&
    num(before.booking.account_amount) === 105 &&
    before.existingTxs.some(t => t.type === 'booking_usage' && num(t.amount) === APPLIED_AMOUNT) &&
    num(before.org.training_fund_balance) === 0;

  if (!XERO_ONLY) {
    if (dbAlreadyApplied) {
      console.log('\n[skip] DB changes already applied — skipping DB step.');
    } else {
      // Re-verify the assumed pre-state defensively.
      if (before.booking.tenant_id !== TENANT_ID) throw new Error(`Booking tenant_id mismatch: ${before.booking.tenant_id}`);
      if (before.booking.organization_id !== ORG_ID) throw new Error(`Booking organization_id mismatch: ${before.booking.organization_id}`);
      if (num(before.booking.total_cost) !== 125) throw new Error(`Booking total_cost drift: ${before.booking.total_cost}`);
      if (num(before.booking.training_fund_amount) !== 0) throw new Error(`Booking training_fund_amount drift: ${before.booking.training_fund_amount}`);
      if (num(before.booking.account_amount) !== 125) throw new Error(`Booking account_amount drift: ${before.booking.account_amount}`);
      if (num(before.booking.voucher_amount) !== 0) throw new Error(`Booking voucher_amount drift: ${before.booking.voucher_amount}`);
      if (num(before.booking.discount_code_amount) !== 0) throw new Error(`Booking discount_code_amount drift: ${before.booking.discount_code_amount}`);
      if (num(before.org.training_fund_balance) !== 20) throw new Error(`Org training_fund_balance drift: ${before.org.training_fund_balance}`);
      if (before.existingTxs.length !== 0) throw new Error(`Unexpected existing training_fund_transaction rows for booking`);

      console.log('\n--- Applying DB changes (single transaction) ---');
      const client = new pg.Client({ connectionString: PG_URL });
      await client.connect();
      try {
        await client.query('BEGIN');

        // 1. Insert training_fund_transaction.
        const insertTxSql = `
          INSERT INTO training_fund_transaction
            (organization_id, tenant_id, type, amount, balance_before, balance_after, booking_id, reason, created_date)
          VALUES ($1, $2, 'booking_usage', $3, $4, $5, $6, $7, $8)
          RETURNING id, organization_id, tenant_id, type, amount, balance_before, balance_after, booking_id, reason, created_date
        `;
        const insertTxParams = [ORG_ID, TENANT_ID, APPLIED_AMOUNT, 20, 0, BOOKING_ID, REASON_TEXT, APPLIED_DATE];

        // 2. Decrement org training_fund_balance, guarded.
        const updOrgSql = `
          UPDATE organization
          SET training_fund_balance = 0
          WHERE id = $1 AND training_fund_balance = 20 AND tenant_id = $2
          RETURNING id, training_fund_balance
        `;

        // 3. Update booking, guarded. Keep payment_method='account' (no 'mixed'
        //    enum exists in this codebase — confirmedPaymentMethod is a single
        //    value at booking time; the split is conveyed by
        //    training_fund_amount + account_amount). payment_status is left
        //    unchanged because there is no clear "partially paid" state in use
        //    here either — the £105 outstanding is already represented by
        //    account_amount > 0 and the absence of a paid stripe intent /
        //    'paid' status.
        const updBookingSql = `
          UPDATE booking
          SET training_fund_amount = $1,
              account_amount = $2
          WHERE id = $3
            AND tenant_id = $4
            AND training_fund_amount = 0
            AND account_amount = 125
          RETURNING id, training_fund_amount, account_amount, payment_method, total_cost
        `;

        if (DRY_RUN) {
          console.log('[dry-run] would INSERT training_fund_transaction with params:', insertTxParams);
          console.log('[dry-run] would UPDATE organization training_fund_balance: 20 -> 0');
          console.log('[dry-run] would UPDATE booking training_fund_amount=20, account_amount=105');
          await client.query('ROLLBACK');
        } else {
          const txRes = await client.query(insertTxSql, insertTxParams);
          console.log('  inserted training_fund_transaction:', txRes.rows[0]);

          const orgRes = await client.query(updOrgSql, [ORG_ID, TENANT_ID]);
          if (orgRes.rowCount !== 1) {
            throw new Error(`Guarded organization update affected ${orgRes.rowCount} rows — aborting`);
          }
          console.log('  updated organization:', orgRes.rows[0]);

          const bRes = await client.query(updBookingSql, [APPLIED_AMOUNT, 105, BOOKING_ID, TENANT_ID]);
          if (bRes.rowCount !== 1) {
            throw new Error(`Guarded booking update affected ${bRes.rowCount} rows — aborting`);
          }
          console.log('  updated booking:', bRes.rows[0]);

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
    console.log('\n[dry-run] would create Xero credit note £20 against invoice SI-43875.');
  } else {
    const cur = await verifyState();
    if (cur.booking.xero_credit_note_id) {
      console.log(`\n[skip] booking already has xero_credit_note_id=${cur.booking.xero_credit_note_id} (${cur.booking.xero_credit_note_number}) — skipping Xero step.`);
    } else if (!cur.booking.xero_invoice_id) {
      console.log('\n[skip] booking has no xero_invoice_id — nothing to credit.');
    } else {
      console.log(`\n--- Creating Xero credit note £${APPLIED_AMOUNT} against invoice ${cur.booking.xero_invoice_number} ---`);
      try {
        const result = await createXeroCreditNote({
          appTenantId: TENANT_ID,
          invoiceId: cur.booking.xero_invoice_id,
          creditAmount: APPLIED_AMOUNT,
          description: XERO_DESCRIPTION,
          reference: XERO_REFERENCE,
        });
        console.log('  Xero result:', result);
        if (result.skipped) {
          console.warn(`\n[WARN] Xero credit note SKIPPED: ${result.reason}. Reconcile SI-43875 manually:`);
          console.warn(`  invoice_id=${cur.booking.xero_invoice_id} number=${cur.booking.xero_invoice_number}`);
        } else if (result.creditNoteId) {
          const { error: updErr } = await supabase
            .from('booking')
            .update({
              xero_credit_note_id: result.creditNoteId,
              xero_credit_note_number: result.creditNoteNumber,
            })
            .eq('id', BOOKING_ID)
            .eq('tenant_id', TENANT_ID);
          if (updErr) throw updErr;
          console.log(`  wrote xero_credit_note_id/number back to booking: ${result.creditNoteNumber} (${result.creditNoteId})`);
        }
      } catch (err) {
        console.error('\n[ERROR] Xero credit note creation failed:', err.message);
        console.error('Reconcile SI-43875 manually for £20:');
        console.error(`  invoice_id=${BOOKING_REF ? '(see booking row)' : ''}, see post-state below.`);
        // Do not rethrow — DB changes are already committed and the manual
        // path is documented for the user.
      }
    }
  }

  // Post-write verification.
  const after = await verifyState();
  console.log('\n--- Post-state ---');
  console.log('booking:', {
    id: after.booking.id,
    ref: after.booking.booking_reference,
    total_cost: after.booking.total_cost,
    training_fund_amount: after.booking.training_fund_amount,
    account_amount: after.booking.account_amount,
    voucher_amount: after.booking.voucher_amount,
    discount_code_amount: after.booking.discount_code_amount,
    payment_method: after.booking.payment_method,
    xero_invoice_id: after.booking.xero_invoice_id,
    xero_invoice_number: after.booking.xero_invoice_number,
    xero_credit_note_id: after.booking.xero_credit_note_id,
    xero_credit_note_number: after.booking.xero_credit_note_number,
  });
  console.log('organization:', after.org);
  console.log(`training_fund_transaction rows for booking: ${after.existingTxs.length}`);
  for (const tx of after.existingTxs) console.log('  ', tx);

  const sum =
    num(after.booking.training_fund_amount) +
    num(after.booking.account_amount) +
    num(after.booking.voucher_amount) +
    num(after.booking.discount_code_amount);
  const total = num(after.booking.total_cost);
  console.log(`\nSum check: training_fund(${after.booking.training_fund_amount}) + account(${after.booking.account_amount}) + voucher(${after.booking.voucher_amount}) + discount_code(${after.booking.discount_code_amount}) = ${sum} vs total_cost(${total})`);
  if (!DRY_RUN && sum !== total) {
    throw new Error(`Sum mismatch: ${sum} !== ${total}`);
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
