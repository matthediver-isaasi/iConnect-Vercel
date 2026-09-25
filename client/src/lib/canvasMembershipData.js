// Presentation-only configuration. Never put a viewer's records or editor samples
// in these defaults: Canvas documents are public, reusable authoring documents.
export const MEMBERSHIP_DATA_STATES = ['active', 'pending', 'paused', 'expired', 'failed', 'unavailable', 'none'];
export const MEMBERSHIP_PAYMENT_STATES = ['active', 'paid', 'pending', 'first_payment_pending', 'paused', 'expired', 'failed', 'unavailable', 'none'];
export const MEMBERSHIP_PAYMENT_METHODS = ['direct_debit', 'monthly_direct_debit', 'card', 'monthly_card', 'bank_transfer', 'invoice', 'upfront', 'flat_rate', 'unavailable'];
export const MEMBERSHIP_TEXT_ROLES = ['eyebrow', 'heading', 'supporting', 'fieldLabel', 'value', 'status', 'link'];

const statuses = {
  first_payment_pending: 'Payment pending',
  active: 'Active', pending: 'Pending', paused: 'Paused', expired: 'Expired',
  failed: 'Payment failed', unavailable: 'Unavailable', none: 'No membership',
};
const membershipHeadings = Object.fromEntries(MEMBERSHIP_DATA_STATES.map(state => [state, 'Your membership']));
const membershipSupport = {
  active: 'Your membership is active.',
  pending: 'Your membership is pending confirmation.',
  paused: 'Your membership is currently paused.',
  expired: 'Your membership has expired.',
  failed: 'Your membership payment needs attention.',
  unavailable: 'We cannot confirm your membership details right now.',
  none: 'There is no current membership to display.',
};
const paymentHeadings = {
  first_payment_pending: 'Payment details',
  active: 'Payment details', paid: 'Payment details', pending: 'Payment details', paused: 'Payment details',
  expired: 'Payment arrangement expired', failed: 'Payment needs attention',
  unavailable: 'Payment details unavailable', none: 'No payment arrangement',
};
const paymentSupport = {
  first_payment_pending: 'Your payment is awaiting confirmation.',
  active: 'Your payment arrangement is active.',
  paid: 'Your current membership has been paid in full.',
  pending: 'Your payment setup is awaiting confirmation.',
  paused: 'Your payment arrangement is paused.',
  expired: 'Your payment arrangement has expired.',
  failed: 'Your payment could not be completed.',
  unavailable: 'We cannot confirm your payment arrangement right now.',
  none: 'There is no payment arrangement to display.',
};
const text = (value, fallback) => typeof value === 'string' ? value.slice(0, 4000) : fallback;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const number = (value, fallback, max) => value !== '' && value != null && Number.isFinite(Number(value))
  ? Math.max(0, Math.min(max, Number(value))) : fallback;
const responsiveNumber = (value, fallback, max) => {
  if (typeof value === 'number') return number(value, fallback, max);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const out = {};
  for (const breakpoint of ['desktop', 'tablet', 'mobile']) {
    if (value[breakpoint] !== '' && value[breakpoint] != null && Number.isFinite(Number(value[breakpoint]))) {
      out[breakpoint] = number(value[breakpoint], 0, max);
    }
  }
  const keys = Object.keys(out);
  if (keys.length === 0) return fallback;
  return keys.length === 1 && keys[0] === 'desktop' ? out.desktop : out;
};

export function getCanvasMembershipDefaults(type = 'membership-summary') {
  const payment = type === 'payment-details';
  const states = payment ? MEMBERSHIP_PAYMENT_STATES : MEMBERSHIP_DATA_STATES;
  return {
    eyebrow: payment ? 'PAYMENT DETAILS' : 'YOUR MEMBERSHIP',
    states: Object.fromEntries(states.map(state => [state, {
      heading: (payment ? paymentHeadings : membershipHeadings)[state],
      supporting: (payment ? paymentSupport : membershipSupport)[state],
      status: payment && state === 'paid' ? 'Paid in full' : payment && state === 'none' ? 'Not set up' : statuses[state],
    }])),
    fields: {
      memberSince: 'Member since', membershipType: '', amount: 'Next payment amount', method: 'Payment method',
      // nextPayment is retained only as a migration source for author wording.
      nextPayment: 'Payment date', expiryDate: 'Membership valid until', plannedPaymentDate: 'Planned payment date',
      confirmedPaymentDate: 'Confirmed payment date', renewalDate: 'Renewal date', paymentHistoryFrom: 'Payment history from',
      confirmedPayment: 'Confirmed payment', historicalPayment: 'Historical confirmed payment',
      confirmedPaymentAmount: 'Confirmed payment amount', plannedPayment: 'Planned payment',
      mandateStatus: 'Direct Debit status',
    },
    methods: {
      direct_debit: 'Direct Debit', monthly_direct_debit: 'Monthly Direct Debit',
      card: 'Card', monthly_card: 'Monthly card', bank_transfer: 'Bank transfer',
      invoice: 'Invoice', upfront: 'Upfront', flat_rate: 'Flat Rate', unavailable: 'Unavailable',
    },
    messages: {
      loading: 'Loading your membership details…',
      guest: 'Sign in to view your membership details.',
      denied: 'You do not have permission to view these details.',
      error: 'Your membership details could not be loaded. Please try again later.',
      missing: 'Not available',
      joinDateNotRecorded: 'Join date not recorded',
      amountUnknown: 'Amount not available',
      noPaymentScheduled: 'No scheduled payment recorded',
    },
    typography: Object.fromEntries(MEMBERSHIP_TEXT_ROLES.map(role => [role, ''])),
    // Responsive outer-card minimum height. Zero deliberately means Auto.
    minHeight: 0,
    manageLink: '', manageLinkText: 'Manage payments', manageLinkNewTab: false,
    panel: { background: '#f4faf6', borderColor: '#c4e6d1', borderWidth: 2, borderRadius: 6 },
  };
}

// Values generated by the first release. Upgrade only exact generated strings:
// authored variants, including a single changed word, are intentionally retained.
const legacyGenerated = {
  membership: {
    active: { heading: 'Membership Active', supporting: 'Thank you for being a valued member.' },
    pending: { heading: 'Membership pending', supporting: 'Your membership is pending confirmation.' },
    paused: { heading: 'Membership paused', supporting: 'Your membership is currently paused.' },
    expired: { heading: 'Membership expired', supporting: 'Your membership has expired.' },
    failed: { heading: 'Membership needs attention', supporting: 'Your membership payment needs attention.' },
    unavailable: { heading: 'Membership details unavailable', supporting: 'We cannot confirm your membership details right now.' },
    none: { heading: 'No current membership', supporting: 'There is no current membership to display.' },
  },
  payment: {
    first_payment_pending: {
      heading: 'Direct Debit mandate active',
      supporting: 'Your existing Direct Debit mandate is active. This membership term is awaiting its first payment. The mandate alone does not establish membership entitlement.',
      status: 'Awaiting first payment',
    },
    active: { heading: 'Your payment method', supporting: 'Your membership payment is set up' },
    paid: { heading: 'Membership paid', supporting: 'Your current membership has been paid in full.' },
    pending: { heading: 'Payment setup pending', supporting: 'Your payment setup is awaiting confirmation.' },
    paused: { heading: 'Payments paused', supporting: 'Your payment arrangement is paused.' },
    expired: { heading: 'Payment arrangement expired', supporting: 'Your payment arrangement has expired.' },
    failed: { heading: 'Payment needs attention', supporting: 'Your payment could not be completed.' },
    unavailable: { heading: 'Payment details unavailable', supporting: 'We cannot confirm your payment arrangement right now.' },
    none: { heading: 'No payment arrangement', supporting: 'There is no payment arrangement to display.' },
  },
  fields: { membershipType: 'Membership type', nextPayment: 'Next payment' },
};

export function normalizeCanvasMembershipContent(content, type = 'membership-summary') {
  const input = record(content);
  const defaults = getCanvasMembershipDefaults(type);
  const strings = (source, fallback, legacy = {}) => Object.fromEntries(Object.entries(fallback)
    .map(([key, value]) => {
      const incoming = text(record(source)[key], value);
      return [key, incoming === legacy[key] ? value : incoming];
    }));
  const panel = record(input.panel);
  return {
    eyebrow: text(input.eyebrow, defaults.eyebrow),
    states: Object.fromEntries((type === 'payment-details' ? MEMBERSHIP_PAYMENT_STATES : MEMBERSHIP_DATA_STATES).map(state => [
      state, strings(record(input.states)[state], defaults.states[state],
        (type === 'payment-details' ? legacyGenerated.payment : legacyGenerated.membership)[state]),
    ])),
    fields: (() => {
      const raw = record(input.fields);
      const normalized = strings(raw, defaults.fields, legacyGenerated.fields);
      const legacyDateLabel = text(raw.nextPayment, '') !== 'Next payment' ? text(raw.nextPayment, '') : '';
      // Existing authored date copy remains authoritative until an author opts
      // into one of the more specific labels. Generated "Next payment" is not
      // content and must not leak into the new semantic fields.
      if (!text(raw.plannedPaymentDate, '')) normalized.plannedPaymentDate = legacyDateLabel || defaults.fields.plannedPaymentDate;
      if (!text(raw.confirmedPaymentDate, '')) normalized.confirmedPaymentDate = legacyDateLabel || defaults.fields.confirmedPaymentDate;
      if (raw.membershipType === legacyGenerated.fields.membershipType) normalized.membershipType = '';
      return normalized;
    })(),
    methods: strings(input.methods, defaults.methods),
    messages: strings(input.messages, defaults.messages),
    typography: strings(input.typography, defaults.typography),
    minHeight: responsiveNumber(input.minHeight, defaults.minHeight, 4000),
    // Preserve incomplete input while an author types; validate at the link sink.
    manageLink: text(input.manageLink, defaults.manageLink),
    manageLinkText: text(input.manageLinkText, defaults.manageLinkText),
    manageLinkNewTab: input.manageLinkNewTab === true,
    panel: {
      background: text(panel.background, defaults.panel.background),
      borderColor: text(panel.borderColor, defaults.panel.borderColor),
      borderWidth: number(panel.borderWidth, defaults.panel.borderWidth, 20),
      borderRadius: number(panel.borderRadius, defaults.panel.borderRadius, 100),
    },
  };
}

export function safeMembershipLink(value) {
  if (typeof value !== 'string') return '';
  const href = value.trim();
  if (!href || /[\u0000-\u0020\u007f\\]/.test(href)) return '';
  if (/^\/(?!\/)/.test(href) || /^#[^\s]*$/.test(href)) return href;
  try {
    const url = new URL(href);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? href : '';
  } catch { return ''; }
}

function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null;
}

function paymentEvidence(value) {
  const source = record(value);
  const date = isoDate(source.date);
  if (!date) return null;
  return {
    date,
    amount: source.amount !== '' && source.amount != null && Number.isFinite(Number(source.amount))
      ? Number(source.amount) : null,
    currency: typeof source.currency === 'string' && /^[A-Z]{3}$/.test(source.currency) ? source.currency : null,
    historical: source.historical === true,
  };
}

function nextCollectionEvidence(value) {
  const evidence = paymentEvidence(value);
  const source = record(value);
  return evidence && ['confirmed', 'planned'].includes(source.status)
    ? { ...evidence, status: source.status } : null;
}

export function normalizeCanvasMembershipSummary(value) {
  const source = record(value);
  const membership = record(source.membership);
  const payment = record(source.payment);
  return {
    membership: {
      state: MEMBERSHIP_DATA_STATES.includes(membership.state) ? membership.state : 'unavailable',
      memberSince: isoDate(membership.memberSince),
      membershipType: typeof membership.membershipType === 'string' ? membership.membershipType : null,
      renewalDate: isoDate(membership.renewalDate),
      ...(isoDate(membership.expiryDate) ? { expiryDate: isoDate(membership.expiryDate) } : {}),
      paymentHistoryFrom: isoDate(membership.paymentHistoryFrom),
    },
    payment: {
      state: MEMBERSHIP_PAYMENT_STATES.includes(payment.state) ? payment.state : 'unavailable',
      method: MEMBERSHIP_PAYMENT_METHODS.includes(payment.method) ? payment.method : 'unavailable',
      nextPayment: isoDate(payment.nextPayment),
      plannedPayment: paymentEvidence(payment.plannedPayment),
      confirmedPayment: paymentEvidence(payment.confirmedPayment),
      nextCollection: nextCollectionEvidence(payment.nextCollection),
      amount: payment.amount !== '' && payment.amount != null && Number.isFinite(Number(payment.amount))
        ? Number(payment.amount) : null,
      currency: typeof payment.currency === 'string' && /^[A-Z]{3}$/.test(payment.currency) ? payment.currency : null,
      collectionStatus: ['confirmed', 'planned', 'unscheduled', 'unavailable'].includes(payment.collectionStatus)
        ? payment.collectionStatus : 'unavailable',
      mandateStatus: typeof payment.mandateStatus === 'string' ? payment.mandateStatus.slice(0, 400) : null,
    },
  };
}

export function formatMembershipAmount(amount, currency) {
  if (!Number.isFinite(amount) || !currency) return null;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
  } catch { return null; }
}

export function formatMembershipDate(value, yearOnly = false) {
  const date = isoDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', year: 'numeric', ...(yearOnly ? {} : { month: 'long', day: 'numeric' }),
  }).format(new Date(date));
}

export function canvasMembershipQueryKey({ tenantId, tenantSlug, host, viewerId }) {
  return ['canvas-membership-summary', tenantId || '', tenantSlug || '', host || '', viewerId || ''];
}