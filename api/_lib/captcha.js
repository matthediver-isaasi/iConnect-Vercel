/**
 * Captcha verification — pluggable behind env vars.
 *
 *   CAPTCHA_PROVIDER     - 'hcaptcha' | 'turnstile' | 'recaptcha' | unset (disabled)
 *   CAPTCHA_SECRET_KEY   - server-side secret for the chosen provider
 *   CAPTCHA_DISABLED=1   - explicit bypass (also implicitly bypassed when
 *                          NODE_ENV !== 'production')
 *
 * When disabled, verifyCaptcha() returns { ok: true, bypassed: true } so
 * non-production environments don't require a real captcha challenge.
 */

const PROVIDER_ENDPOINTS = {
  hcaptcha:  'https://hcaptcha.com/siteverify',
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
};

export function isCaptchaEnabled() {
  if (process.env.CAPTCHA_DISABLED === '1') return false;
  if (process.env.NODE_ENV !== 'production') return false;
  return Boolean(process.env.CAPTCHA_PROVIDER && process.env.CAPTCHA_SECRET_KEY);
}

export async function verifyCaptcha(token, { remoteIp } = {}) {
  if (!isCaptchaEnabled()) {
    return { ok: true, bypassed: true };
  }
  if (!token) {
    return { ok: false, error: 'Captcha token missing' };
  }

  const provider = process.env.CAPTCHA_PROVIDER;
  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) {
    console.warn(`[captcha] Unknown provider: ${provider} — treating as failure`);
    return { ok: false, error: 'Captcha provider misconfigured' };
  }

  const params = new URLSearchParams();
  params.set('secret', process.env.CAPTCHA_SECRET_KEY);
  params.set('response', token);
  if (remoteIp) params.set('remoteip', remoteIp);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const json = await resp.json();
    if (json && json.success) {
      return { ok: true };
    }
    return { ok: false, error: 'Captcha verification failed', detail: json };
  } catch (err) {
    console.error('[captcha] Verification error:', err.message);
    return { ok: false, error: 'Captcha verification network error' };
  }
}
