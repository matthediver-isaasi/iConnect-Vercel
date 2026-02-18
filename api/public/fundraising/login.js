import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import { sendEmail } from '../../_lib/emailService.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const successResponse = {
    success: true,
    message: "If you have registered for any campaigns, you'll receive a login link shortly."
  };

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) {
      return res.status(200).json(successResponse);
    }

    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const { data: members } = await supabase
      .from('fundraising_team_member')
      .select('id')
      .eq('tenant_id', tenant.id)
      .ilike('email', normalizedEmail)
      .eq('is_active', true)
      .limit(1);

    if (!members || members.length === 0) {
      return res.status(200).json(successResponse);
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const { error: insertError } = await supabase
      .from('fundraising_login_token')
      .insert({
        tenant_id: tenant.id,
        email: normalizedEmail,
        token,
        expires_at: expiresAt
      });

    if (insertError) {
      console.error('Failed to create login token:', insertError);
      return res.status(200).json(successResponse);
    }

    let baseUrl;
    if (tenant.domain) {
      baseUrl = `https://${tenant.domain}`;
    } else {
      baseUrl = `https://${tenant.slug}.${process.env.APP_DOMAIN || 'iconn.app'}`;
    }

    const loginUrl = `${baseUrl}/fundraiser/dashboard?token=${token}`;

    try {
      await sendEmail({
        to: normalizedEmail,
        subject: `Your Fundraiser Dashboard Login - ${tenant.name}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a1a1a; margin-bottom: 8px;">Access Your Fundraiser Dashboard</h2>
            <p style="color: #666; font-size: 16px; line-height: 1.5;">
              Click the button below to view your fundraising campaigns, donation links, and progress.
            </p>
            <div style="margin: 32px 0;">
              <a href="${loginUrl}" 
                 style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">
                Open My Dashboard
              </a>
            </div>
            <p style="color: #999; font-size: 13px;">
              This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
            </p>
          </div>
        `,
        tenantId: tenant.id
      });
    } catch (emailErr) {
      console.error('Failed to send fundraiser login email:', emailErr);
    }

    return res.status(200).json(successResponse);
  } catch (err) {
    console.error('Fundraiser login error:', err);
    return res.status(200).json(successResponse);
  }
}
