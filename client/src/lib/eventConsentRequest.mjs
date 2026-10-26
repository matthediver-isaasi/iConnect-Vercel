// Separate from payment/idempotency authority: this secret only recovers an
// already-issued optional consent offer after a lost successful response.
export function withEventConsentNonce(input, kind, storage) {
  if (input.allocation_invitation_token) return input;
  const key = `event-consent-nonce:${kind}:${input.eventId || input.event_id}`;
  let nonce;
  try { storage ??= globalThis.sessionStorage; nonce = storage.getItem(key); } catch { /* tab storage may be disabled */ }
  if (!/^[a-f0-9]{64}$/.test(nonce || '')) {
    try {
      nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { return input; } // Consent recovery must never prevent a booking.
    try { storage.setItem(key, nonce); } catch { /* recovery unavailable after refresh */ }
  }
  return { ...input, communication_nonce: nonce };
}
