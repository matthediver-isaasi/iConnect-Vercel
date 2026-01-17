import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import Mailgun from 'mailgun.js';
import formData from 'form-data';

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';

const ALLOWED_ORIGINS = ['https://iconn.app', 'https://www.iconn.app'];

function getAllowedOrigin(requestOrigin) {
  if (!requestOrigin) return ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  if (requestOrigin.endsWith('.iconn.app')) return requestOrigin;
  return ALLOWED_ORIGINS[0];
}

export default async function handler(req, res) {
  const origin = getAllowedOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log('[Verify Mailgun Domain] Handler invoked');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authenticate request - must be a tenant owner/admin
  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Check if user has owner/admin role
  if (tenantUser.role !== 'owner' && tenantUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden - requires owner or admin role' });
  }

  // Use authenticated tenant's context
  const tenantId = tenantUser.tenant_id;

  if (!MAILGUN_API_KEY) {
    return res.status(500).json({ error: 'MAILGUN_API_KEY not configured' });
  }

  try {
    // Get tenant and its email domain settings
    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, slug, settings')
      .eq('id', tenantId)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const emailDomainConfig = tenant.settings?.email_domain;
    if (!emailDomainConfig?.domain) {
      return res.status(400).json({ error: 'No email domain configured for this tenant' });
    }

    const mailgunDomain = emailDomainConfig.domain;
    console.log(`[Verify Mailgun Domain] Verifying domain ${mailgunDomain}`);

    // Initialize Mailgun client
    const mailgun = new Mailgun(formData);
    const mailgunConfig = {
      username: 'api',
      key: MAILGUN_API_KEY,
    };
    if (MAILGUN_REGION === 'eu') {
      mailgunConfig.url = 'https://api.eu.mailgun.net';
    }
    const mg = mailgun.client(mailgunConfig);

    // Get current domain status
    const domainInfo = await mg.domains.get(mailgunDomain);
    console.log('[Verify Mailgun Domain] Domain info:', domainInfo);

    // Attempt verification
    let verificationResult;
    try {
      verificationResult = await mg.domains.verify(mailgunDomain);
      console.log('[Verify Mailgun Domain] Verification result:', verificationResult);
    } catch (verifyError) {
      console.log('[Verify Mailgun Domain] Verification check:', verifyError.message);
      verificationResult = domainInfo;
    }

    const isVerified = domainInfo.state === 'active' || verificationResult?.state === 'active';

    // Update tenant settings with latest status
    const currentSettings = tenant.settings || {};
    const updatedSettings = {
      ...currentSettings,
      email_domain: {
        ...emailDomainConfig,
        status: isVerified ? 'verified' : 'pending',
        last_verified_at: new Date().toISOString(),
        dns_status: domainInfo.sending_dns_records?.map(r => ({
          name: r.name,
          type: r.record_type,
          valid: r.valid,
        })) || [],
      }
    };

    await supabase
      .from('tenant')
      .update({ settings: updatedSettings })
      .eq('id', tenantId);

    return res.status(200).json({
      success: true,
      domain: mailgunDomain,
      status: isVerified ? 'verified' : 'pending',
      dns_records: updatedSettings.email_domain.dns_status,
      message: isVerified 
        ? 'Email domain is verified and ready to use'
        : 'Email domain verification pending. Please ensure all DNS records are correctly configured.',
    });

  } catch (error) {
    console.error('[Verify Mailgun Domain] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to verify email domain',
      details: error.message 
    });
  }
}
