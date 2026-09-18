// Presentation-only configuration. Never put a viewer's records or editor samples
// in these defaults: Canvas documents are public, reusable authoring documents.
export const MEMBERSHIP_DATA_STATES = ['active', 'pending', 'paused', 'expired', 'failed', 'unavailable', 'none'];
export const MEMBERSHIP_PAYMENT_METHODS = ['direct_debit', 'monthly_direct_debit', 'card', 'monthly_card', 'bank_transfer', 'invoice', 'unavailable'];
export const MEMBERSHIP_TEXT_ROLES = ['eyebrow', 'heading', 'supporting', 'fieldLabel', 'value', 'status', 'link'];

const statuses = {
  active: 'Active', pending: 'Pending', paused: 'Paused', expired: 'Expired',
  failed: 'Payment failed', unavailable: 'Unavailable', none: 'No membership',
};
const membershipHeadings = {
  active: 'Membership Active', pending: 'Membership pending', paused: 'Membership paused',
  expired: 'Membership expired', failed: 'Membership needs attention',
  unavailable: 'Membership details unavailable', none: 'No current membership',
};
const membershipSupport = {
  active: 'Thank you for being a valued member.',
  pending: 'Your membership is pending confirmation.',
  paused: 'Your membership is currently paused.',
  expired: 'Your membership has expired.',
  failed: 'Your membership payment needs attention.',
  unavailable: 'We cannot confirm your membership details right now.',
  none: 'There is no current membership to display.',
};
const paymentHeadings = {
  active: 'Your payment method', pending: 'Payment setup pending', paused: 'Payments paused',
  expired: 'Payment arrangement expired', failed: 'Payment needs attention',
  unavailable: 'Payment details unavailable', none: 'No payment arrangement',
};
const paymentSupport = {
  active: 'Your membership payment is set up',
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

export function getCanvasMembershipDefaults(type = 'membership-summary') {
  const payment = type === 'payment-details';
  return {
    eyebrow: payment ? 'PAYMENT DETAILS' : 'YOUR MEMBERSHIP',
    states: Object.fromEntries(MEMBERSHIP_DATA_STATES.map(state => [state, {
      heading: (payment ? paymentHeadings : membershipHeadings)[state],
      supporting: (payment ? paymentSupport : membershipSupport)[state],
      status: payment && state === 'none' ? 'Not set up' : statuses[state],
    }])),
    fields: { memberSince: 'Member since', membershipType: 'Membership type', method: 'Payment method', nextPayment: 'Next payment' },
    methods: {
      direct_debit: 'Direct Debit', monthly_direct_debit: 'Monthly Direct Debit',
      card: 'Card', monthly_card: 'Monthly card', bank_transfer: 'Bank transfer',
      invoice: 'Invoice', unavailable: 'Unavailable',
    },
    messages: {
      loading: 'Loading your membership details…',
      guest: 'Sign in to view your membership details.',
      denied: 'You do not have permission to view these details.',
      error: 'Your membership details could not be loaded. Please try again later.',
      missing: 'Not available',
    },
    typography: Object.fromEntries(MEMBERSHIP_TEXT_ROLES.map(role => [role, ''])),
    manageLink: '', manageLinkText: 'Manage payments', manageLinkNewTab: false,
    panel: { background: '#f4faf6', borderColor: '#c4e6d1', borderWidth: 2, borderRadius: 6 },
  };
}

export function normalizeCanvasMembershipContent(content, type = 'membership-summary') {
  const input = record(content);
  const defaults = getCanvasMembershipDefaults(type);
  const strings = (source, fallback) => Object.fromEntries(Object.entries(fallback)
    .map(([key, value]) => [key, text(record(source)[key], value)]));
  const panel = record(input.panel);
  return {
    eyebrow: text(input.eyebrow, defaults.eyebrow),
    states: Object.fromEntries(MEMBERSHIP_DATA_STATES.map(state => [
      state, strings(record(input.states)[state], defaults.states[state]),
    ])),
    fields: strings(input.fields, defaults.fields),
    methods: strings(input.methods, defaults.methods),
    messages: strings(input.messages, defaults.messages),
    typography: strings(input.typography, defaults.typography),
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

export function normalizeCanvasMembershipSummary(value) {
  const source = record(value);
  const membership = record(source.membership);
  const payment = record(source.payment);
  return {
    membership: {
      state: MEMBERSHIP_DATA_STATES.includes(membership.state) ? membership.state : 'unavailable',
      memberSince: isoDate(membership.memberSince),
      membershipType: typeof membership.membershipType === 'string' ? membership.membershipType : null,
    },
    payment: {
      state: MEMBERSHIP_DATA_STATES.includes(payment.state) ? payment.state : 'unavailable',
      method: MEMBERSHIP_PAYMENT_METHODS.includes(payment.method) ? payment.method : 'unavailable',
      nextPayment: isoDate(payment.nextPayment),
    },
  };
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