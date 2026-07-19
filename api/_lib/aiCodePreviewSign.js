// AI Design Studio V2 — signed preview URL helpers (Phase 0/3).
//
// The CSP-locked preview route (api/ai-compositions/preview.js GET) is the
// only surface Browserless renders. Access is a short-lived HMAC signature —
// shared here so both the preview endpoint and the Phase 3 visual-validation
// stage (generate-v2) mint identical URLs.

import crypto from 'node:crypto';

export const SIGNATURE_TTL_MS = 10 * 60 * 1000;

export function signingSecret() {
  return process.env.AIC_PREVIEW_SECRET || process.env.CRON_SECRET || null;
}

export function signPreview(compositionId, versionId, exp) {
  const secret = signingSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret)
    .update(`${compositionId}.${versionId}.${exp}`)
    .digest('hex');
}

export function verifyPreviewSignature(compositionId, versionId, exp, sig) {
  const expected = signPreview(compositionId, versionId, exp);
  if (!expected || !sig) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > Date.now();
}

/** Resolve the externally reachable app origin for a request. */
export function appOrigin(req) {
  if (process.env.VITE_APP_URL) return process.env.VITE_APP_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

/** Build a fully signed preview URL, or null when signing is unconfigured. */
export function buildSignedPreviewUrl(origin, compositionId, versionId, ttlMs = SIGNATURE_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const sig = signPreview(compositionId, versionId, exp);
  if (!sig) return null;
  return `${origin}/api/ai-compositions/preview`
    + `?compositionId=${encodeURIComponent(compositionId)}`
    + `&versionId=${encodeURIComponent(versionId)}&exp=${exp}&sig=${sig}`;
}
