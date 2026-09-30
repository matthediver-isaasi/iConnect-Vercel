/**
 * In-memory sliding-window rate limit for the public signup endpoints.
 *
 * Vercel serverless functions can warm-start multiple instances, so this is
 * best-effort, not strict — it stops casual abuse but is not a hard guard
 * against a determined attacker. For stricter limits, swap to Redis/Upstash.
 *
 *   - Per-IP:    SIGNUP_RATE_IP_PER_HOUR    (default 5)
 *   - Per-email: SIGNUP_RATE_EMAIL_PER_DAY  (default 3)
 *
 * Setting SIGNUP_RATE_DISABLED=1 disables the limiter entirely (useful for
 * tests).
 */

const ipBuckets = new Map();    // key -> [timestamps]
const emailBuckets = new Map(); // key -> [timestamps]

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS  = 24 * HOUR_MS;

function prune(arr, windowMs) {
  const cutoff = Date.now() - windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function checkSignupRateLimit({ ip, email }) {
  if (process.env.SIGNUP_RATE_DISABLED === '1') {
    return { ok: true, bypassed: true };
  }

  const now = Date.now();
  const ipLimit    = envInt('SIGNUP_RATE_IP_PER_HOUR', 5);
  const emailLimit = envInt('SIGNUP_RATE_EMAIL_PER_DAY', 3);

  if (ip) {
    const arr = ipBuckets.get(ip) || [];
    prune(arr, HOUR_MS);
    if (arr.length >= ipLimit) {
      return { ok: false, error: 'Too many signup attempts from this network. Try again later.' };
    }
    arr.push(now);
    ipBuckets.set(ip, arr);
  }

  if (email) {
    const key = email.toLowerCase();
    const arr = emailBuckets.get(key) || [];
    prune(arr, DAY_MS);
    if (arr.length >= emailLimit) {
      return { ok: false, error: 'Too many signup attempts for this email. Try again tomorrow.' };
    }
    arr.push(now);
    emailBuckets.set(key, arr);
  }

  return { ok: true };
}

export function extractClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || null;
}
