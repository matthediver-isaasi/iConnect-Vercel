/**
 * POST /api/public/signup-start
 *
 * Step 1 of the self-serve signup flow:
 *   - Validate input (name, slug, email, password)
 *   - Run captcha + per-IP/per-email rate limits
 *   - Stash a pending tenant_signup row with a single-use verification token
 *   - Send the verification email (link points at /signup-verify?token=…&email=…)
 *
 * Always responds 200 with { ok: true } when the request is well-formed to avoid
 * leaking whether the email is already in use. Real provisioning happens in
 * /api/public/signup-verify.
 */

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { supabase } from '../_lib/database.js';
import { sendEmail } from '../_lib/emailService.js';
import { verifyCaptcha } from '../_lib/captcha.js';
import { checkSignupRateLimit, extractClientIp } from '../_lib/signupRateLimit.js';
import { validateProvisionInput, checkSlugAvailability } from '../_lib/provisionTenantService.js';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function appBaseUrl() {
  return (process.env.VITE_APP_URL || process.env.APP_URL || 'https://iconn.app').replace(/\/$/, '');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  if (process.env.SELF_SERVE_SIGNUP_DISABLED === '1') {
    return res.status(503).json({ error: 'Self-serve signup is temporarily disabled. Please contact us.' });
  }

  const {
    tenantName, slug, adminEmail, adminFirstName, adminLastName, password, captchaToken,
  } = req.body || {};

  const errors = await validateProvisionInput({
    tenantName, slug, adminEmail, adminFirstName, adminLastName, password,
    isPlatformProvision: false,
  });
  if (errors.length) return res.status(400).json({ error: errors.join('. ') });

  const ip = extractClientIp(req);
  const rl = checkSignupRateLimit({ ip, email: adminEmail });
  if (!rl.ok) return res.status(429).json({ error: rl.error });

  const captcha = await verifyCaptcha(captchaToken, { remoteIp: ip });
  if (!captcha.ok) return res.status(400).json({ error: captcha.error || 'Captcha check failed' });

  const available = await checkSlugAvailability(slug);
  if (!available) return res.status(400).json({ error: 'This subdomain is already taken' });

  const passwordHash = password ? await bcrypt.hash(password, 10) : null;
  const verificationToken = crypto.randomUUID();
  const verificationExpires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  // Expire any prior pending signup for this email so the latest link wins
  await supabase
    .from('tenant_signup')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .ilike('email', adminEmail.toLowerCase());

  const { error: insertError } = await supabase
    .from('tenant_signup')
    .insert({
      email: adminEmail.toLowerCase(),
      tenant_name: tenantName,
      slug,
      admin_first_name: adminFirstName,
      admin_last_name: adminLastName,
      password_hash: passwordHash,
      verification_token: verificationToken,
      verification_expires: verificationExpires,
      ip_address: ip,
      user_agent: req.headers['user-agent'] || null,
      status: 'pending',
    });

  if (insertError) {
    console.error('[signup-start] insert error:', insertError);
    return res.status(500).json({ error: 'Could not start signup. Please try again.' });
  }

  const verifyUrl = `${appBaseUrl()}/signup-verify?token=${encodeURIComponent(verificationToken)}&email=${encodeURIComponent(adminEmail.toLowerCase())}`;
  try {
    await sendEmail({
      to: adminEmail,
      subject: `Verify your email to finish creating ${tenantName}`,
      html: `
        <p>Hi ${adminFirstName},</p>
        <p>Click the link below to verify your email and finish creating your workspace
        <strong>${tenantName}</strong> at <code>${slug}.${(process.env.APP_DOMAIN || 'iconn.app')}</code>:</p>
        <p><a href="${verifyUrl}">Verify and create my workspace</a></p>
        <p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
      `,
      text: `Verify your email to finish creating ${tenantName}: ${verifyUrl}\n\nThis link expires in 1 hour.`,
      skipFooter: true,
    });
  } catch (err) {
    console.error('[signup-start] email send error:', err.message);
    // Don't fail the request — the row exists and admins can re-request via signup-start again
  }

  return res.status(200).json({ ok: true, message: 'Check your email to finish setting up your workspace.' });
}
