import { programRegistrationIdentity } from '../../../shared/programRegistrationIdentity.js';

const attempts = new Map();
const fingerprintFor = payload => JSON.stringify({ owner: payload.programTicketOwner, ...programRegistrationIdentity(payload) });

export function hasProgramRegistrationAttempt({ memberId, eventId, payload, storage }) {
  const key = `program-registration:${memberId}:${eventId}`;
  let previous = attempts.get(key);
  if (!previous) {
    try { previous = JSON.parse(storage?.getItem(key)); } catch { return false; }
  }
  return !!previous?.id && previous.fingerprint === fingerprintFor(payload);
}

// Separate from paid standard/complex checkout attempts: no payment lifecycle.
export function resolveProgramRegistrationAttempt({ memberId, eventId, payload, storage, createId }) {
  const key = `program-registration:${memberId}:${eventId}`;
  const fingerprint = fingerprintFor(payload);
  let previous = attempts.get(key);
  if (!previous) {
    try { previous = JSON.parse(storage.getItem(key)); } catch { /* Memory retains retries if storage is unavailable. */ }
  }
  const attempt = previous?.fingerprint === fingerprint && previous?.id
    ? previous : { id: createId(), fingerprint };
  attempts.set(key, attempt);
  try { storage.setItem(key, JSON.stringify(attempt)); } catch { /* Preserve the in-memory attempt. */ }
  return attempt.id;
}

export function finishProgramRegistrationAttempt({ memberId, eventId, attemptId, storage }) {
  const key = `program-registration:${memberId}:${eventId}`;
  if (attempts.get(key)?.id === attemptId) attempts.delete(key);
  try {
    if (JSON.parse(storage.getItem(key))?.id === attemptId) storage.removeItem(key);
  } catch { /* The acknowledged attempt no longer needs persistent retry state. */ }
}
