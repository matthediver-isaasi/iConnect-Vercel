import Mailgun from 'mailgun.js';
import formData from 'form-data';
import { supabase } from './database.js';

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';
const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';
// Root domain for platform-level emails (no tenant context)
const ROOT_EMAIL_DOMAIN = process.env.MAILGUN_DOMAIN || `mail.${APP_DOMAIN}`;
const DEFAULT_FROM = process.env.MAILGUN_FROM_EMAIL || `ICONN <noreply@${ROOT_EMAIL_DOMAIN}>`;

let mailgunClient = null;
const tenantEmailConfigCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getMailgunClient() {
  if (!mailgunClient && MAILGUN_API_KEY) {
    const mailgun = new Mailgun(formData);
    const config = {
      username: 'api',
      key: MAILGUN_API_KEY,
    };
    if (MAILGUN_REGION === 'eu') {
      config.url = 'https://api.eu.mailgun.net';
    }
    mailgunClient = mailgun.client(config);
  }
  return mailgunClient;
}

async function getTenantEmailConfig(tenantId) {
  if (!tenantId) {
    return null;
  }

  const cacheKey = tenantId;
  const cached = tenantEmailConfigCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.config;
  }

  try {
    const { data: tenant, error } = await supabase
      .from('tenant')
      .select('id, name, settings')
      .eq('id', tenantId)
      .single();

    if (error || !tenant) {
      console.log(`[Tenant Email] No tenant found for ${tenantId}`);
      return null;
    }

    const emailDomainConfig = tenant.settings?.email_domain;
    if (!emailDomainConfig || emailDomainConfig.status !== 'verified') {
      console.log(`[Tenant Email] No verified email domain for tenant ${tenantId}`);
      tenantEmailConfigCache.set(cacheKey, { config: null, timestamp: Date.now() });
      return null;
    }

    const config = {
      domain: emailDomainConfig.domain,
      fromEmail: emailDomainConfig.from_email || `noreply@${emailDomainConfig.domain}`,
      fromName: emailDomainConfig.from_name || tenant.name || 'ICONN',
    };

    tenantEmailConfigCache.set(cacheKey, { config, timestamp: Date.now() });
    return config;

  } catch (err) {
    console.error('[Tenant Email] Error fetching tenant email config:', err);
    return null;
  }
}

export async function sendTenantEmail({ 
  tenantId, 
  to, 
  subject, 
  html, 
  text, 
  from, 
  replyTo, 
  cc, 
  bcc,
  footer 
}) {
  if (!MAILGUN_API_KEY) {
    console.error('[Tenant Email] MAILGUN_API_KEY not configured');
    return {
      success: false,
      error: 'Email service not configured',
    };
  }

  const client = getMailgunClient();
  if (!client) {
    return {
      success: false,
      error: 'Failed to initialize email client',
    };
  }

  // Get tenant-specific email configuration
  const tenantConfig = await getTenantEmailConfig(tenantId);
  
  // Determine domain and from address
  // Default to root email domain (mail.iconn.app) for platform-level emails
  let domain = ROOT_EMAIL_DOMAIN;
  let fromAddress = from || DEFAULT_FROM;
  
  if (tenantConfig) {
    domain = tenantConfig.domain;
    if (!from) {
      fromAddress = `${tenantConfig.fromName} <${tenantConfig.fromEmail}>`;
    }
    console.log(`[Tenant Email] Using tenant-specific domain: ${domain}`);
  } else {
    console.log(`[Tenant Email] Using default domain: ${domain}`);
  }

  try {
    let finalHtml = html || '';
    if (footer) {
      finalHtml = finalHtml + footer;
    }

    console.log(`[Tenant Email] Sending to: ${to}, domain: ${domain}`);

    const messageData = {
      from: fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject,
      html: finalHtml,
      text: text || finalHtml.replace(/<[^>]*>/g, ''),
    };

    if (replyTo) {
      messageData['h:Reply-To'] = replyTo;
    }
    if (cc) {
      messageData.cc = Array.isArray(cc) ? cc : [cc];
    }
    if (bcc) {
      messageData.bcc = Array.isArray(bcc) ? bcc : [bcc];
    }

    const response = await client.messages.create(domain, messageData);

    console.log(`[Tenant Email] Email sent successfully. Message ID: ${response.id}`);

    return {
      success: true,
      messageId: response.id,
      domain: domain,
    };

  } catch (error) {
    console.error('[Tenant Email] Failed to send email:', error.message || error);
    return {
      success: false,
      error: error.message || 'Unknown error sending email',
    };
  }
}

export function clearTenantEmailCache(tenantId) {
  if (tenantId) {
    tenantEmailConfigCache.delete(tenantId);
  } else {
    tenantEmailConfigCache.clear();
  }
}
