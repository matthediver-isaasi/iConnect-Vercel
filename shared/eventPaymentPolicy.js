export const EVENT_ALLOW_VOUCHER_PAYMENT_KEY = 'event_allow_voucher_payment';
export const EVENT_ALLOW_TRAINING_FUND_PAYMENT_KEY = 'event_allow_training_fund_payment';

export const EVENT_PAYMENT_POLICY_KEYS = [
  EVENT_ALLOW_VOUCHER_PAYMENT_KEY,
  EVENT_ALLOW_TRAINING_FUND_PAYMENT_KEY,
];

function isExplicitFalse(value) {
  return value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false');
}

/**
 * Resolve tenant event-payment settings. Missing settings preserve the legacy,
 * default-on behaviour; only an explicit boolean/string false disables a method.
 */
export function resolveEventPaymentPolicy(rows = []) {
  const settings = Array.isArray(rows) ? rows : [];
  const valueFor = (key) => settings.find((row) => row?.setting_key === key)?.setting_value;

  return {
    allowVoucherPayment: !isExplicitFalse(valueFor(EVENT_ALLOW_VOUCHER_PAYMENT_KEY)),
    allowTrainingFundPayment: !isExplicitFalse(valueFor(EVENT_ALLOW_TRAINING_FUND_PAYMENT_KEY)),
  };
}

export function isEventPaymentPolicyKey(key) {
  return EVENT_PAYMENT_POLICY_KEYS.includes(String(key || ''));
}