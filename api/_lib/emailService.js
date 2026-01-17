import Mailgun from 'mailgun.js';
import formData from 'form-data';
import { supabase } from './database.js';

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';
const MAILGUN_FALLBACK_DOMAIN = process.env.MAILGUN_DOMAIN || APP_DOMAIN;
const DEFAULT_DOMAIN = MAILGUN_FALLBACK_DOMAIN;
const DEFAULT_FROM = process.env.MAILGUN_FROM_EMAIL || `ICONN <noreply@${MAILGUN_FALLBACK_DOMAIN}>`;
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';

let mailgunClient = null;
let cachedEmailFooter = null;
let footerLastFetched = 0;
const FOOTER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const tenantEmailConfigCache = new Map();
const TENANT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getTenantEmailConfig(tenantId) {
  if (!tenantId) {
    return null;
  }

  const cacheKey = tenantId;
  const cached = tenantEmailConfigCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < TENANT_CACHE_TTL) {
    return cached.config;
  }

  try {
    const { data: tenant, error } = await supabase
      .from('tenant')
      .select('id, name, slug, settings')
      .eq('id', tenantId)
      .single();

    if (error || !tenant) {
      console.log(`[Email Service] No tenant found for ${tenantId}`);
      return null;
    }

    const emailDomainConfig = tenant.settings?.email_domain;
    
    if (emailDomainConfig && emailDomainConfig.status === 'verified') {
      const config = {
        domain: emailDomainConfig.domain,
        fromEmail: emailDomainConfig.from_email || `noreply@${emailDomainConfig.domain}`,
        fromName: emailDomainConfig.from_name || tenant.name || 'ICONN',
      };
      tenantEmailConfigCache.set(cacheKey, { config, timestamp: Date.now() });
      return config;
    }

    if (tenant.slug) {
      const config = {
        domain: `${tenant.slug}.${APP_DOMAIN}`,
        fromEmail: `noreply@${tenant.slug}.${APP_DOMAIN}`,
        fromName: tenant.name || 'ICONN',
      };
      tenantEmailConfigCache.set(cacheKey, { config, timestamp: Date.now() });
      return config;
    }

    tenantEmailConfigCache.set(cacheKey, { config: null, timestamp: Date.now() });
    return null;

  } catch (err) {
    console.error('[Email Service] Error fetching tenant email config:', err);
    return null;
  }
}

async function getEmailFooter() {
  const now = Date.now();
  if (cachedEmailFooter !== null && (now - footerLastFetched) < FOOTER_CACHE_TTL) {
    return cachedEmailFooter;
  }

  try {
    if (!supabase) {
      console.log('[Email Service] Supabase not configured, skipping footer');
      return null;
    }

    const { data, error } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'email_footer_html')
      .single();

    if (error || !data) {
      console.log('[Email Service] No email footer configured');
      cachedEmailFooter = null;
    } else {
      cachedEmailFooter = data.setting_value;
      console.log('[Email Service] Email footer loaded successfully');
    }
    footerLastFetched = now;
    return cachedEmailFooter;
  } catch (err) {
    console.error('[Email Service] Error fetching email footer:', err);
    return null;
  }
}

async function replaceSocialPlaceholdersInFooter(footer) {
  if (!footer) return footer;
  
  try {
    if (!supabase) return footer;

    const { data } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'social_icons_config')
      .single();

    if (!data?.setting_value) return footer;

    const socialConfig = JSON.parse(data.setting_value);
    let result = footer;
    
    // Replace social media URL placeholders
    if (socialConfig.linkedin?.url) {
      result = result.replace(/\{\{linkedin_url\}\}/g, socialConfig.linkedin.url);
    }
    if (socialConfig.twitter?.url) {
      result = result.replace(/\{\{twitter_url\}\}/g, socialConfig.twitter.url);
    }
    if (socialConfig.facebook?.url) {
      result = result.replace(/\{\{facebook_url\}\}/g, socialConfig.facebook.url);
    }
    if (socialConfig.instagram?.url) {
      result = result.replace(/\{\{instagram_url\}\}/g, socialConfig.instagram.url);
    }
    if (socialConfig.youtube?.url) {
      result = result.replace(/\{\{youtube_url\}\}/g, socialConfig.youtube.url);
    }
    
    return result;
  } catch (err) {
    console.error('[Email Service] Error replacing social placeholders:', err);
    return footer;
  }
}

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

export async function sendEmail({ to, subject, html, text, from, replyTo, cc, bcc, skipFooter = false, tenantId = null }) {
  if (!MAILGUN_API_KEY) {
    console.error('[Email Service] MAILGUN_API_KEY not configured');
    return {
      success: false,
      error: 'Email service not configured - missing API key',
    };
  }

  const client = getMailgunClient();
  if (!client) {
    return {
      success: false,
      error: 'Failed to initialize Mailgun client',
    };
  }

  const tenantConfig = await getTenantEmailConfig(tenantId);
  
  let domain = DEFAULT_DOMAIN;
  let fromAddress = from || DEFAULT_FROM;
  
  if (tenantConfig) {
    domain = tenantConfig.domain;
    if (!from) {
      fromAddress = `${tenantConfig.fromName} <${tenantConfig.fromEmail}>`;
    }
    console.log(`[Email Service] Using tenant domain: ${domain}`);
  } else {
    console.log(`[Email Service] Using default domain: ${domain}`);
  }

  try {
    let finalHtml = html || '';
    if (!skipFooter) {
      const footer = await getEmailFooter();
      if (footer) {
        const processedFooter = await replaceSocialPlaceholdersInFooter(footer);
        finalHtml = finalHtml + processedFooter;
        console.log('[Email Service] Email footer appended');
      }
    }

    console.log(`[Email Service] Sending email to: ${to}, domain: ${domain}`);
    if (cc) console.log(`[Email Service] CC: ${cc}`);
    if (bcc) console.log(`[Email Service] BCC: ${bcc}`);
    console.log(`[Email Service] Subject: ${subject}`);

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

    console.log(`[Email Service] Email sent successfully. Message ID: ${response.id}`);

    return {
      success: true,
      messageId: response.id,
      domain: domain,
    };
  } catch (error) {
    console.error('[Email Service] Failed to send email:', error.message || error);
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

export function replacePlaceholders(template, entityType, entityData) {
  if (!template) return '';
  
  console.log(`[replacePlaceholders] entityType="${entityType}", entityData keys: ${entityData ? Object.keys(entityData).join(', ') : 'null'}`);
  
  // First handle {{placeholder}} syntax (form field mappings)
  let result = template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (match, path) => {
    const parts = path.split('.');
    console.log(`[replacePlaceholders] {{}} match="${match}", path="${path}", parts=${JSON.stringify(parts)}, parts[0]="${parts[0]}", entityType="${entityType}"`);
    if (parts[0] === entityType || parts[0] === 'record') {
      const fieldName = parts[1] || parts[0];
      const value = entityData?.[fieldName];
      console.log(`[replacePlaceholders] {{}} prefix match: fieldName="${fieldName}", value="${value}"`);
      return value || match;
    }
    const directValue = entityData?.[path];
    console.log(`[replacePlaceholders] {{}} direct lookup: path="${path}", value="${directValue}"`);
    return directValue || match;
  });
  
  // Then handle [[placeholder]] syntax (core database values like [[organization.id]], [[member.email]])
  result = result.replace(/\[\[(\w+(?:\.\w+)?)\]\]/g, (match, path) => {
    const parts = path.split('.');
    console.log(`[replacePlaceholders] [[]] match="${match}", path="${path}", parts=${JSON.stringify(parts)}, parts[0]="${parts[0]}", entityType="${entityType}"`);
    // Handle patterns like [[organization.id]], [[member.email]], [[record.field]]
    if (parts[0] === entityType || parts[0] === 'record' || parts[0] === 'organization' || parts[0] === 'member') {
      const fieldName = parts[1] || parts[0];
      const value = entityData?.[fieldName];
      console.log(`[replacePlaceholders] [[]] prefix match: fieldName="${fieldName}", value="${value}"`);
      return value || match;
    }
    const directValue = entityData?.[path];
    console.log(`[replacePlaceholders] [[]] direct lookup: path="${path}", value="${directValue}"`);
    return directValue || match;
  });
  
  return result;
}
