// Support CSAT rating + auto-close helpers (Task: support satisfaction & auto-close).
//
// - HMAC-signed one-click rating tokens: let the ticket submitter rate a
//   resolved ticket from an email WITHOUT logging in. Token covers
//   ticketId + expiry (score is chosen at click time via the link set —
//   the link is private to the submitter's inbox, any score they pick is
//   legitimate).
// - Tenant auto-close settings parsing (stored in system_settings under
//   SUPPORT_AUTO_CLOSE_KEY as JSON {enabled, warnDays, closeDays}).
// - Pure decision logic for the nightly cron: which resolved tickets get a
//   warning email, and which get auto-closed.

import crypto from 'node:crypto';

export const SUPPORT_AUTO_CLOSE_KEY = 'support_auto_close';

export const AUTO_CLOSE_DEFAULTS = Object.freeze({
  enabled: false,
  warnDays: 7,
  closeDays: 10,
});

/** Rating links stay valid for 60 days after the resolution email is sent. */
export const RATING_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export function ratingSecret() {
  return process.env.SUPPORT_RATING_SECRET || process.env.CRON_SECRET || null;
}

/**
 * Sign a rating token for a ticket. `exp` is a unix ms timestamp.
 * Returns null when no signing secret is configured.
 */
export function signRatingToken(ticketId, exp, secret = ratingSecret()) {
  if (!secret || !ticketId || !exp) return null;
  return crypto.createHmac('sha256', secret)
    .update(`support-rating.${ticketId}.${exp}`)
    .digest('hex');
}

/** Verify a rating token (constant-time) and its expiry. */
export function verifyRatingToken(ticketId, exp, sig, secret = ratingSecret(), now = Date.now()) {
  const expected = signRatingToken(ticketId, exp, secret);
  if (!expected || !sig) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > now;
}

/**
 * Build the set of one-click rating URLs (scores 1..5) for a ticket.
 * Returns null when signing is unconfigured or no base URL is known.
 */
export function buildRatingUrls(baseUrl, ticketId, { ttlMs = RATING_TOKEN_TTL_MS, secret = ratingSecret(), now = Date.now() } = {}) {
  const origin = (baseUrl || '').replace(/\/$/, '');
  if (!origin || !ticketId) return null;
  const exp = now + ttlMs;
  const sig = signRatingToken(ticketId, exp, secret);
  if (!sig) return null;
  const base = `${origin}/api/support/rate?ticket=${encodeURIComponent(ticketId)}&exp=${exp}&sig=${sig}`;
  const urls = {};
  for (let score = 1; score <= 5; score++) {
    urls[score] = `${base}&score=${score}`;
  }
  return urls;
}

/** Clamp/validate a rating score. Returns an int 1..5 or null. */
export function normalizeRatingScore(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 1 ? i : fallback;
}

/**
 * Parse a raw support_auto_close setting value (JSON string) into
 * { enabled, warnDays, closeDays }. Falls back to defaults on any error.
 * Guarantees closeDays > warnDays (bumps closeDays to warnDays + 1 otherwise).
 */
export function parseAutoCloseSettings(settingValue) {
  let parsed = null;
  if (settingValue) {
    try {
      parsed = JSON.parse(settingValue);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...AUTO_CLOSE_DEFAULTS };
  }
  const enabled = parsed.enabled === true;
  const warnDays = toPositiveInt(parsed.warnDays, AUTO_CLOSE_DEFAULTS.warnDays);
  let closeDays = toPositiveInt(parsed.closeDays, AUTO_CLOSE_DEFAULTS.closeDays);
  if (closeDays <= warnDays) closeDays = warnDays + 1;
  return { enabled, warnDays, closeDays };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure decision for one resolved ticket in the nightly cron.
 *
 * @param {object} ticket - { status, resolved_at, auto_close_warning_sent_at }
 * @param {object} settings - { enabled, warnDays, closeDays }
 * @param {number} now - unix ms
 * @returns {'warn'|'close'|null}
 *
 * Rules:
 * - Only resolved tickets with a resolved_at are eligible (a member reply
 *   auto-reopens the ticket to 'open', which removes it from this pool).
 * - warn: resolved >= warnDays ago and no warning sent yet.
 * - close: resolved >= closeDays ago AND a warning was already sent.
 *   (A warning is always sent first; if the cron was down long enough that
 *   both thresholds pass at once, we still warn first and close on a later
 *   run, so the member always gets the heads-up.)
 */
export function decideAutoCloseAction(ticket, settings, now = Date.now()) {
  if (!settings?.enabled) return null;
  if (!ticket || ticket.status !== 'resolved' || !ticket.resolved_at) return null;
  const resolvedAt = Date.parse(ticket.resolved_at);
  if (!Number.isFinite(resolvedAt)) return null;

  const ageDays = (now - resolvedAt) / DAY_MS;
  const warningSent = !!ticket.auto_close_warning_sent_at;

  if (!warningSent) {
    return ageDays >= settings.warnDays ? 'warn' : null;
  }
  return ageDays >= settings.closeDays ? 'close' : null;
}
