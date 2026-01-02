import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { sendEmail } from '../_lib/emailService.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, email, first_name')
      .eq('email', email.toLowerCase())
      .single();

    if (memberError || !member) {
      console.log('[Password Reset] No member found for:', email);
      return res.json({ success: true, message: 'If an account exists, a reset link will be sent.' });
    }

    const resetToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const { data: existingCreds } = await supabase
      .from('member_credentials')
      .select('id')
      .eq('member_id', member.id)
      .single();

    if (existingCreds) {
      await supabase
        .from('member_credentials')
        .update({ 
          reset_token: resetToken,
          reset_token_expires: expiresAt.toISOString()
        })
        .eq('id', existingCreds.id);
    } else {
      await supabase
        .from('member_credentials')
        .insert({
          member_id: member.id,
          email: email.toLowerCase(),
          reset_token: resetToken,
          reset_token_expires: expiresAt.toISOString()
        });
    }

    const host = req.headers.host || 'auth.iconn.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const resetUrl = `${protocol}://${host}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;
    console.log(`[Password Reset] Link for ${email}: ${resetUrl}`);

    // Send password reset email using the shared email service (includes footer)
    try {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
          <p>Hi,</p>
          <p>We received a request to reset your password. No worries - we've got you covered! Just click the button below to create a new password:</p>
          <p style="margin: 30px 0; text-align: center;">
            <a href="${resetUrl}" style="background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">
              Reset Password
            </a>
          </p>
          <p>This link will expire in 1 hour, so be sure to update your password soon.</p>
          <p>If you didn't request this reset, you can safely ignore this email.</p>
          <p>Need help or have questions? Feel free to reach out to us at <a href="mailto:hello@graduatefutures.org" style="color: #4f46e5;">hello@graduatefutures.org</a></p>
          <p style="margin-top: 30px;">The Graduate Futures Team</p>
        </div>
      `;

      const emailResult = await sendEmail({
        to: email,
        subject: 'Graduate Futures Password Reset Request',
        html: emailHtml
      });

      if (emailResult.success) {
        console.log(`[Password Reset] Email sent to ${email}`);
      } else {
        console.error(`[Password Reset] Failed to send email: ${emailResult.error}`);
      }
    } catch (mailError) {
      console.error('[Password Reset] Failed to send email:', mailError);
    }

    res.json({ 
      success: true, 
      message: 'If an account exists, a reset link will be sent.'
    });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ success: false, error: 'Failed to process request' });
  }
}
