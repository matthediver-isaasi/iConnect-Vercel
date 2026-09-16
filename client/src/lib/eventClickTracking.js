const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const EVENT_CLICK_VISITOR_STORAGE_PREFIX = 'iconn:event-click-visitor:';

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

function createUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    const value = crypto.randomUUID();
    return isUuid(value) ? value : null;
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // RFC 4122 version 4 UUID.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const value = [...bytes]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    return isUuid(value) ? value : null;
  }

  // A browser with neither Web Crypto API is unusual, but this keeps the
  // client usable in older/webview environments while still sending a UUID.
  const value = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.random() * 16 | 0;
    const nibble = char === 'x' ? random : (random & 0x3) | 0x8;
    return nibble.toString(16);
  });
  return isUuid(value) ? value : null;
}

export function getEventClickTenantScope(tenantSlug) {
  const normalizedSlug = typeof tenantSlug === 'string' ? tenantSlug.trim().toLowerCase() : '';
  if (normalizedSlug) return normalizedSlug;

  if (typeof window !== 'undefined' && window.location?.hostname) {
    return `host:${window.location.hostname.toLowerCase()}`;
  }

  return 'unknown';
}

/**
 * Returns one UUID per tenant and browser. A storage failure is deliberately
 * treated as an opt-out: sending an ephemeral identifier would over-count
 * visitors and would violate the persistence contract.
 */
export function getOrCreateEventClickVisitorId(tenantScope) {
  if (typeof window === 'undefined') return null;

  const storageKey = `${EVENT_CLICK_VISITOR_STORAGE_PREFIX}${tenantScope || 'unknown'}`;
  let storage;
  try {
    storage = window.localStorage;
    if (!storage) return null;
    const existing = storage.getItem(storageKey);
    if (isUuid(existing)) return existing.trim();

    const generated = createUuid();
    if (!generated) return null;
    storage.setItem(storageKey, generated);

    // Some privacy-mode storage implementations silently discard writes.
    if (storage.getItem(storageKey) !== generated) return null;
    return generated;
  } catch {
    return null;
  }
}

export function buildEventClickEndpoint(tenantSlug) {
  if (typeof window === 'undefined') return '/api/public/event-click';

  const endpoint = new URL('/api/public/event-click', window.location.origin);
  if (typeof tenantSlug === 'string' && tenantSlug.trim()) {
    endpoint.searchParams.set('tenant', tenantSlug.trim());
  }
  return `${endpoint.pathname}${endpoint.search}`;
}

/**
 * Fire-and-forget by design. keepalive lets the request survive a normal
 * anchor navigation, while the catch ensures analytics never changes CTA
 * navigation or surfaces a user-facing error.
 */
export function sendEventClick({
  eventId,
  eventType,
  visitorId,
  tenantSlug,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  onSuccess,
} = {}) {
  if (!isUuid(eventId) || (eventType !== 'simple' && eventType !== 'complex') || !isUuid(visitorId) || !fetchImpl) {
    return false;
  }

  try {
    const request = fetchImpl(buildEventClickEndpoint(tenantSlug), {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, eventType, visitorId }),
    });
    // Do not await this request from CTA handlers. This is only a rejection
    // sink for implementations that return a Promise.
    if (request && typeof request.then === 'function') {
      request
        .then((response) => {
          if (response?.ok !== false) onSuccess?.();
        })
        .catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}