import { membershipAmountMinor } from './membershipVoucherQuote.js';

/** Fixed purchased-term funding. Provider cash is an exact whole minor-unit
 * amount per instalment; credit absorbs gross penny remainders. Unused credit
 * stays on its source voucher.
 * This avoids fake rounding adjustments and supports both existing finite
 * provider schedules without an ongoing coupon or altered renewal price.
 */
export function monthlyVoucherCreditLimit({ grossMinor, availableMinor, count, minimumMinor }) {
  if (![grossMinor, availableMinor, count, minimumMinor].every(Number.isSafeInteger)
      || grossMinor < 0 || availableMinor < 0 || count < 1 || count > 120
      || minimumMinor < 1) throw new Error('Invalid fixed membership funding schedule');
  if (availableMinor >= grossMinor) return grossMinor;
  const cash = Math.ceil(Math.max(grossMinor - availableMinor, count * minimumMinor) / count) * count;
  return Math.max(0, grossMinor - cash);
}

export function fundedMonthlySnapshot(snapshot, funding, settlementId) {
  const count = Number(snapshot.instalment_count);
  const grossMinor = membershipAmountMinor(snapshot.plan_total);
  if (!settlementId || funding.payableMinor !== grossMinor || funding.currency !== snapshot.currency
      || !Number.isSafeInteger(count) || count < 1 || count > 120
      || funding.remainingMinor % count
      || funding.remainingMinor + funding.voucherMinor !== grossMinor) {
    throw new Error('Monthly funding must reconcile exactly with the purchased term');
  }
  if (snapshot.collection_policy?.pricing_policy === 'dynamic') throw new Error('Dynamic ongoing pricing cannot consume a finite-term credit quote');
  const cashMinor = funding.remainingMinor / count;
  return {
    ...snapshot,
    // Gross plan_total, VAT, incentive and commitment snapshots stay intact.
    monthly_amount_minor: cashMinor, monthly_amount: cashMinor / 100,
    ...(snapshot.billing_request_payment ? {
      billing_request_payment: { ...snapshot.billing_request_payment, amount_minor: cashMinor },
    } : {}),
    voucher_funding: { settlement_id: settlementId, instalment_count: count,
      gross_minor: grossMinor, credit_minor: funding.voucherMinor, cash_minor: funding.remainingMinor,
      gross_per_instalment_minor: Math.floor(grossMinor / count),
      credit_per_instalment_minor: Math.floor(funding.voucherMinor / count),
      gross_remainder_count: grossMinor % count,
      credit_remainder_count: funding.voucherMinor % count,
      cash_per_instalment_minor: cashMinor,
      allocations: funding.allocations,
    },
  };
}

export function monthlyFundingSlice(funding, ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > funding.instalment_count) {
    throw new Error('Invalid purchased-term instalment');
  }
  const creditMinor = funding.credit_per_instalment_minor + (ordinal <= (funding.credit_remainder_count || 0) ? 1 : 0);
  const grossMinor = funding.gross_per_instalment_minor + (ordinal <= (funding.gross_remainder_count || 0) ? 1 : 0);
  const start = (ordinal - 1) * funding.credit_per_instalment_minor + Math.min(ordinal - 1, funding.credit_remainder_count || 0);
  const end = start + creditMinor;
  let cursor = 0;
  const allocations = funding.allocations.map(allocation => {
    const left = cursor; cursor += allocation.amountMinor;
    return { ...allocation, amountMinor: Math.max(0, Math.min(cursor, end) - Math.max(left, start)) };
  }).filter(allocation => allocation.amountMinor > 0);
  if (allocations.reduce((sum, row) => sum + row.amountMinor, 0) !== creditMinor) {
    throw new Error('Frozen voucher allocations do not cover this instalment');
  }
  return { ordinal, grossMinor, cashMinor: funding.cash_per_instalment_minor, creditMinor, allocations };
}

export function fundedInstalmentDate(snapshot, ordinal) {
  const accepted = String(snapshot.accepted_at || '').slice(0, 10);
  const deferred = snapshot.deferred_billing?.first_charge_date;
  const termStart = snapshot.commitment?.term_start_date;
  const start = deferred || (termStart && termStart > accepted ? termStart : accepted);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > snapshot.instalment_count) {
    throw new Error('Funded instalment requires an immutable first collection date');
  }
  const [year, month, day] = start.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 + ordinal - 1, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return first.toISOString().slice(0, 10);
}

export async function prepareMembershipVoucherMonthly(db, token, settlement) {
  const { data, error } = await db.rpc('membership_voucher_prepare_monthly', {
    p_tenant_id: token.tenant_id, p_token_id: token.id,
  });
  if (error) throw new Error(error.message);
  if (!data?.monthly_snapshot || data.id !== settlement.id) throw new Error('Monthly credit commitment was not confirmed');
  return { settlement: data, snapshot: fundedMonthlySnapshot(data.monthly_snapshot, data.funding, data.id) };
}

export async function commitMembershipVoucherMonthly(db, agreement) {
  const snapshot = agreement.metadata?.card || agreement.metadata?.dd;
  if (!snapshot?.voucher_funding) return null;
  const { data, error } = await db.rpc('membership_voucher_commit_monthly', {
    p_tenant_id: agreement.tenant_id, p_settlement_id: snapshot.voucher_funding.settlement_id,
    p_agreement_id: agreement.id,
  });
  if (error) throw new Error(error.message);
  if (snapshot.invoicing_mode !== 'per_instalment') {
    const tokenResult = await db.from('membership_fee_token').select('*')
      .eq('id', data.fee_token_id).eq('tenant_id', agreement.tenant_id).single();
    if (tokenResult.error || !tokenResult.data) throw new Error('Monthly credit token is unavailable');
    const { accountMembershipVoucherSettlement } = await import('./membershipVoucherAccounting.js');
    await accountMembershipVoucherSettlement(db, tokenResult.data, data, null, { onlyFunding: true });
  }
  return data;
}

export async function releaseMembershipVoucherMonthly(db, token, settlement, deps = {}) {
  if (['committed', 'plan_committed'].includes(settlement.state)) throw new Error('This monthly membership is already committed; use the membership cancellation process');
  const mode = settlement.monthly_snapshot.payment_mode;
  const namespace = mode === 'stripe_monthly' ? 'card' : 'dd';
  const found = await db.from('membership_billing_agreements').select('*')
    .eq('tenant_id', token.tenant_id).eq('member_id', token.member_id)
    .eq(`metadata->${namespace}->voucher_funding->>settlement_id`, settlement.id).maybeSingle();
  if (found.error) throw new Error('Could not reconcile monthly setup before releasing credit');
  const agreement = found.data;
  let reference = null;
  if (agreement) {
    if (mode === 'stripe_monthly') {
      if (!agreement.stripe_checkout_session_id) throw new Error('Monthly card setup has an uncertain outcome; reconcile before releasing credit');
      const stripe = await deps.getStripe();
      let session = await stripe.checkout.sessions.retrieve(agreement.stripe_checkout_session_id);
      if (session.status === 'complete' || session.subscription || session.payment_status === 'paid') {
        throw new Error('Monthly card consent is completed; use the membership cancellation process');
      }
      if (session.status !== 'expired') session = await stripe.checkout.sessions.expire(session.id);
      if (session.status !== 'expired') throw new Error('Card provider did not confirm cancellation');
      reference = session.id;
    } else {
      if (agreement.gocardless_mandate_id || !agreement.gocardless_billing_request_id) {
        throw new Error('Direct Debit mandate setup needs reconciliation before releasing credit');
      }
      const gc = deps.gc || await (await import('./gocardless.js')).gocardlessForTenant(token.tenant_id);
      let request = await gc.getBillingRequest(agreement.gocardless_billing_request_id);
      if (request.status === 'fulfilled' || request.links?.mandate_request_mandate || request.links?.payment_request_payment) {
        throw new Error('Direct Debit consent is completed; use the membership cancellation process');
      }
      if (request.status !== 'cancelled') request = await gc.cancelBillingRequest(request.id);
      if (request.status !== 'cancelled') throw new Error('Direct Debit provider did not confirm cancellation');
      reference = request.id;
    }
  } else if (settlement.provider_attempted_at) {
    throw new Error('Monthly provider outcome is uncertain; credit remains reserved for reconciliation');
  }
  const { data, error } = await db.rpc('membership_voucher_release_monthly', {
    p_tenant_id: token.tenant_id, p_settlement_id: settlement.id,
    p_agreement_id: agreement?.id || null, p_provider_reference: reference,
  });
  if (error) throw new Error(error.message);
  return data;
}
