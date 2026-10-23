// Presentation only: never infer dates, payment authority or renewal policies.
import { directDebitCollectionPolicy } from './directDebitConsentSummary';

export function memberDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

export function membershipPeriod(data) {
  const sources = [
    [data?.memberStart?.termStart, data?.memberStart?.termEnd],
    [data?.commitment?.term_start_date, data?.commitment?.term_end_date],
    [data?.renewalLifecycle?.termStart, data?.renewalLifecycle?.termEnd],
  ];
  for (const [start, end] of sources) {
    if (memberDate(start) && memberDate(end)) return `${memberDate(start)} – ${memberDate(end)}`;
  }
  return /^\d{4}(?:\s*[-/–]\s*\d{4})?$/.test(data?.membershipYear || '') ? data.membershipYear : 'Please contact us to confirm your membership dates.';
}

export function membershipHeading(data) {
  return data?.renewalLifecycle?.termStart || data?.renewal
    ? 'Your Membership Renewal' : 'Your Membership';
}

export function annualMembershipFeeLabel(data) {
  const mode = data?.memberStart?.paymentMode || data?.voucherRequote?.paymentMode || data?.voucherMonthly?.paymentMode;
  const variable = data?.voucherFunding?.variableCredit === true
    || ((!mode || mode === 'direct_debit') && directDebitCollectionPolicy(data?.ddOffer)?.pricing_policy === 'dynamic');
  return `Annual membership fee${variable ? ' at current rates' : ''}${data?.vatAmount > 0 ? ' (excluding VAT)' : ''}`;
}

export function activationText(rule) {
  if (rule === 'first_payment') return 'Your membership becomes active after your first payment is received.';
  if (rule === 'mandate') return 'Your membership becomes active once your Direct Debit is confirmed.';
  return 'We’ll confirm when your membership becomes active.';
}

export function memberDirectDebitPolicy(offer) {
  const policy = directDebitCollectionPolicy(offer);
  if (policy?.needs_review || !['stop', 'continue'].includes(policy?.end_policy)
    || !['fixed', 'dynamic'].includes(policy?.pricing_policy)) {
    return 'Please contact the membership team to confirm your payment amount and when payments will end.';
  }
  const price = policy.pricing_policy === 'dynamic'
    ? 'Your monthly amount may change if membership fees are updated. You’ll be notified in advance of changes to your payments.'
    : 'Your monthly amount is fixed for this membership period.';
  const end = policy.end_policy === 'continue'
    ? 'Your monthly payments continue when your membership renews, unless you cancel your arrangement.'
    : 'Your payments stop at the end of this membership period. You’ll need to renew before payments can continue.';
  return `${price} ${end}${policy.pricing_policy === 'fixed' && policy.end_policy === 'continue' ? ' We’ll confirm your new monthly amount before renewal.' : ''}`;
}

export function memberFirstCollection(offer = {}) {
  const day = Number(offer.collectionDay);
  if (offer.firstCollectionRule === 'nominated_day' && Number.isInteger(day) && day >= 1 && day <= 28)
    return `on the next available collection date, on day ${day} of the month`;
  if (offer.firstCollectionRule === 'anniversary') return 'on the next available monthly date matching your membership start day';
  return 'as soon as your Direct Debit is ready. You’ll receive advance notice of the collection date';
}

export function reusesDirectDebit(data) {
  // This is the existing backend-confirmed renewal/reuse path. A saved payment
  // option or a historical mandate alone does not establish reuse.
  return data?.renewal?.status === 'notice_sent' && data.renewal.mode === 'confirm'
    && data.renewal.provider === 'gocardless';
}

export function creditOwnerLabel(row) {
  const name = String(row?.displayName || '').trim();
  if (name && !/^member vouchers$|^organisation vouchers$|^vouchers$/i.test(name)) {
    return `${name} (${row.ownerType === 'member' ? 'your credit' : 'organisation credit'})`;
  }
  return row?.ownerType === 'member' ? 'Member credit' : 'Organisation credit';
}
