import {
  EVENT_PAYMENT_POLICY_KEYS,
  resolveEventPaymentPolicy,
} from '../../shared/eventPaymentPolicy.js';

export class EventPaymentPolicyError extends Error {
  constructor(message, statusCode = 403) {
    super(message);
    this.name = 'EventPaymentPolicyError';
    this.statusCode = statusCode;
  }
}

export async function loadEventPaymentPolicy(client, tenantId) {
  if (!client || !tenantId) {
    throw new EventPaymentPolicyError('Event payment settings are temporarily unavailable', 503);
  }

  let result;
  try {
    result = await client
      .from('system_settings')
      .select('setting_key, setting_value')
      .eq('tenant_id', tenantId)
      .in('setting_key', EVENT_PAYMENT_POLICY_KEYS);
  } catch {
    throw new EventPaymentPolicyError('Event payment settings are temporarily unavailable', 503);
  }

  if (result?.error || !Array.isArray(result?.data)) {
    throw new EventPaymentPolicyError('Event payment settings are temporarily unavailable', 503);
  }
  return resolveEventPaymentPolicy(result.data);
}

export function assertEventPaymentMethodsAllowed(policy, {
  voucherRequested = false,
  trainingFundRequested = false,
} = {}) {
  if (voucherRequested && !policy?.allowVoucherPayment) {
    throw new EventPaymentPolicyError('Voucher payment is not enabled for event bookings');
  }
  if (trainingFundRequested && !policy?.allowTrainingFundPayment) {
    throw new EventPaymentPolicyError('Training fund payment is not enabled for event bookings');
  }
}