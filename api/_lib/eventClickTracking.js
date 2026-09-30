import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * Event-card clicks are intentionally keyed by a browser-generated UUID, not
 * by a cookie, IP address, member id, or any other personal identifier. The
 * raw UUID is never persisted: it is HMAC'd with a server-only key and the
 * tenant id before it reaches the database.
 */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

export function normalizeUuid(value) {
  return isUuid(value) ? value.trim().toLowerCase() : null;
}

export function deriveEventClickVisitorHash(tenantId, visitorId, secret = null) {
  const normalizedTenantId = normalizeUuid(tenantId);
  const normalizedVisitorId = normalizeUuid(visitorId);
  const hmacSecret = secret || process.env.EVENT_CLICK_HASH_SECRET || process.env.SUPABASE_SERVICE_KEY;
  if (!normalizedTenantId || !normalizedVisitorId || !hmacSecret) return null;

  return crypto
    .createHmac('sha256', String(hmacSecret))
    .update(`${normalizedTenantId}:${normalizedVisitorId}`, 'utf8')
    .digest('hex');
}

export function isDerivedEventClickVisitorHash(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

/**
 * Keep the anonymous write surface bounded without persisting network
 * addresses. Vercel's edge-provided header is used when available; normal
 * x-forwarded-for is deliberately ignored because callers can forge it.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;
const MAX_RATE_BUCKETS = 5_000;
const rateBuckets = new Map();

export function trustedEventClickClientKey(req) {
  const edgeAddress = req?.headers?.['x-vercel-forwarded-for'];
  const peerAddress = req?.socket?.remoteAddress;
  const address = edgeAddress || peerAddress || 'unknown';
  return String(address).split(',')[0].trim().slice(0, 100) || 'unknown';
}

export function consumeEventClickRateLimit(key, now = Date.now()) {
  const safeKey = String(key || 'unknown').slice(0, 180);
  const bucket = rateBuckets.get(safeKey);
  const timestamps = (bucket || []).filter((timestamp) => now - timestamp < RATE_WINDOW_MS);

  if (timestamps.length >= RATE_LIMIT) {
    rateBuckets.set(safeKey, timestamps);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((RATE_WINDOW_MS - (now - timestamps[0])) / 1000),
      ),
    };
  }

  timestamps.push(now);
  rateBuckets.set(safeKey, timestamps);

  // Prevent a burst of forged keys from growing this process-local guard
  // without bound. This is supplementary protection; validation and the
  // database uniqueness constraint remain authoritative.
  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [existingKey, existingTimestamps] of rateBuckets) {
      if (existingTimestamps.length === 0 || now - existingTimestamps[existingTimestamps.length - 1] >= RATE_WINDOW_MS) {
        rateBuckets.delete(existingKey);
      }
      if (rateBuckets.size <= MAX_RATE_BUCKETS) break;
    }
    while (rateBuckets.size > MAX_RATE_BUCKETS) {
      const oldestKey = rateBuckets.keys().next().value;
      if (oldestKey === undefined) break;
      rateBuckets.delete(oldestKey);
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

export function clearEventClickRateLimits() {
  rateBuckets.clear();
}