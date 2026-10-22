import { createHash } from 'node:crypto';
import { programRegistrationIdentity } from '../../shared/programRegistrationIdentity.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}

export function programRegistrationFingerprint({ tenantId, memberId, eventId, owner, params }) {
  return createHash('sha256').update(JSON.stringify(canonical({
    version: 1, tenantId, memberId, eventId, owner,
    ...programRegistrationIdentity(params),
  }))).digest('hex');
}

export function programRegistrationReplay(result, reference) {
  return { success: true, booking_reference: reference, bookings: result.bookings,
    tickets_used: result.bookings.length, remaining_balance: result.new_balance, replayed: true };
}
