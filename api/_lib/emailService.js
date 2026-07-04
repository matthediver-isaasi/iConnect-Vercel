import Mailgun from 'mailgun.js';
import formData from 'form-data';
import { supabase } from './database.js';
import { generateMemberPreferencesToken } from '../email-preferences/index.js';
import { recordTransactionalInboxMessage } from './transactionalInbox.js';

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';
// Use mail.iconn.app as the standard fallback domain for all tenants
const MAILGUN_FALLBACK_DOMAIN = `mail.${APP_DOMAIN}`;
const DEFAULT_DOMAIN = MAILGUN_FALLBACK_DOMAIN;
const DEFAULT_FROM = process.env.MAILGUN_FROM_EMAIL || `ICONN <noreply@${MAILGUN_FALLBACK_DOMAIN}>`;
// Platform-pinned From for systemEmail=true. Intentionally ignores
// MAILGUN_FROM_EMAIL so a misconfigured/legacy env var can never make a
// system message (admin reset, signup verification, team invite, billing)
// appear to come from a tenant domain like noreply@mail.graduatefutures.org.
const PLATFORM_SYSTEM_FROM = `ICONN <noreply@${MAILGUN_FALLBACK_DOMAIN}>`;
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';

let mailgunClient = null;
const FOOTER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const tenantEmailConfigCache = new Map();
const tenantFooterCache = new Map(); // Per-tenant footer cache
const tenantSocialConfigCache = new Map(); // Per-tenant social config cache
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

    tenantEmailConfigCache.set(cacheKey, { config: null, timestamp: Date.now() });
    return null;

  } catch (err) {
    console.error('[Email Service] Error fetching tenant email config:', err);
    return null;
  }
}

async function getEmailFooter(tenantId = null) {
  const cacheKey = tenantId || 'global';
  const now = Date.now();
  const cached = tenantFooterCache.get(cacheKey);
  
  if (cached && (now - cached.timestamp) < FOOTER_CACHE_TTL) {
    return cached.footer;
  }

  try {
    if (!supabase) {
      console.log('[Email Service] Supabase not configured, skipping footer');
      return null;
    }

    let query = supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'email_footer_html');
    
    // Filter by tenant_id if provided
    if (tenantId) {
      query = query.eq('tenant_id', tenantId);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      console.log(`[Email Service] No email footer configured for tenant: ${tenantId || 'global'}`);
      tenantFooterCache.set(cacheKey, { footer: null, timestamp: now });
      return null;
    } else {
      console.log(`[Email Service] Email footer loaded for tenant: ${tenantId || 'global'}`);
      tenantFooterCache.set(cacheKey, { footer: data.setting_value, timestamp: now });
      return data.setting_value;
    }
  } catch (err) {
    console.error('[Email Service] Error fetching email footer:', err);
    return null;
  }
}

function constrainFooterForEmail(footerHtml) {
  if (!footerHtml) return footerHtml;
  let result = footerHtml;
  result = result.replace(/<img\b([^>]*?)>/gi, (match, attrs) => {
    if (/max-width/i.test(attrs)) return match;
    if (/style\s*=/i.test(attrs)) {
      return match.replace(/style\s*=\s*"([^"]*)"/i, 'style="$1; max-width: 100%; height: auto;"');
    }
    return `<img style="max-width: 100%; height: auto;"${attrs}>`;
  });
  result = result.replace(/<table\b([^>]*?)>/gi, (match, attrs) => {
    if (/max-width/i.test(attrs)) return match;
    if (/style\s*=/i.test(attrs)) {
      return match.replace(/style\s*=\s*"([^"]*)"/i, 'style="$1; max-width: 100%; width: 100%;"');
    }
    return `<table style="max-width: 100%; width: 100%;"${attrs}>`;
  });
  return result;
}

async function replaceSocialPlaceholdersInFooter(footer, tenantId = null) {
  if (!footer) return footer;
  
  try {
    if (!supabase) return footer;

    const cacheKey = tenantId || 'global';
    const now = Date.now();
    const cached = tenantSocialConfigCache.get(cacheKey);
    
    let socialConfig = null;
    
    if (cached && (now - cached.timestamp) < TENANT_CACHE_TTL) {
      socialConfig = cached.config;
    } else {
      let query = supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'social_icons_config');
      
      // Filter by tenant_id if provided
      if (tenantId) {
        query = query.eq('tenant_id', tenantId);
      }

      const { data } = await query.single();

      if (data?.setting_value) {
        socialConfig = JSON.parse(data.setting_value);
        tenantSocialConfigCache.set(cacheKey, { config: socialConfig, timestamp: now });
      } else {
        tenantSocialConfigCache.set(cacheKey, { config: null, timestamp: now });
      }
    }

    if (!socialConfig) return footer;

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

// Architectural rule: platform→tenant-owner system messages (admin password
// reset, signup verification, admin invites, billing notifications) MUST come
// from `mail.iconn.app`, NOT a tenant's own verified sending domain. Pass
// `systemEmail: true` (or use `sendSystemEmail()`) to force the platform
// domain and skip tenant-domain resolution entirely, regardless of tenantId.
// Tenant→member messages (welcomes, reminders, campaigns, form notifications)
// continue to resolve off tenantId as before.
export async function sendEmail({ to, subject, html, text, from, replyTo, cc, bcc, skipFooter = false, tenantId = null, contentWidth = null, enableTracking = false, unsubscribeUrl = null, attachments = null, testMode = false, systemEmail = false, inboxDelivery = null }) {
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

  // Log tenantId for debugging email domain resolution
  console.log(`[Email Service] tenantId provided: ${tenantId || 'none'}${systemEmail ? ' (systemEmail=true, forcing platform domain)' : ''}`);

  let domain = DEFAULT_DOMAIN;
  let fromAddress = from || DEFAULT_FROM;

  if (systemEmail) {
    // System (platform→tenant-owner) messages: always send from the platform
    // domain AND the platform From identity, never from a tenant's verified
    // sending domain and never from MAILGUN_FROM_EMAIL (which may legitimately
    // be a per-deployment tenant address for non-system sends). Do not look
    // up the tenant config — the rule is mechanical, not heuristic. Any
    // caller-provided `from` is also ignored for system emails.
    fromAddress = PLATFORM_SYSTEM_FROM;
    console.log(`[Email Service] systemEmail=true → forcing platform domain: ${domain}, from: ${fromAddress}`);
  } else {
    const tenantConfig = await getTenantEmailConfig(tenantId);
    if (tenantConfig) {
      domain = tenantConfig.domain;
      if (!from) {
        fromAddress = `${tenantConfig.fromName} <${tenantConfig.fromEmail}>`;
      }
      console.log(`[Email Service] Using tenant domain: ${domain} (tenantId: ${tenantId})`);
    } else {
      console.log(`[Email Service] Using fallback domain: ${domain} (tenantId: ${tenantId || 'not provided'})`);
    }
  }

  try {
    let finalHtml = html || '';
    if (!skipFooter) {
      const footer = await getEmailFooter(tenantId);
      if (footer) {
        const processedFooter = await replaceSocialPlaceholdersInFooter(footer, tenantId);
        const constrainedFooter = constrainFooterForEmail(processedFooter);
        const footerWidthCss = contentWidth || '600px';
        const footerWidthNum = parseInt(footerWidthCss, 10) || 600;
        const wrappedFooter = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${footerWidthNum}" style="max-width:${footerWidthCss};width:${footerWidthCss};margin:0 auto;"><tr><td style="padding:12px 0;">${constrainedFooter}</td></tr></table>`;
        finalHtml = finalHtml + wrappedFooter;
        console.log(`[Email Service] Email footer appended for tenant: ${tenantId || 'global'}`);
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

    if (enableTracking) {
      messageData['o:tracking'] = 'yes';
      messageData['o:tracking-opens'] = 'yes';
      messageData['o:tracking-clicks'] = 'htmlonly';
    }

    if (unsubscribeUrl) {
      const mailtoAddress = `unsubscribe@${domain}`;
      messageData['h:List-Unsubscribe'] = `<mailto:${mailtoAddress}>, <${unsubscribeUrl}>`;
      messageData['h:List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    if (testMode) {
      messageData['o:testmode'] = 'yes';
      console.log(`[Email Service] Test mode enabled — Mailgun will accept but not deliver this email`);
    }

    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      messageData.attachment = attachments.map(att => ({
        filename: att.filename,
        data: att.data,
        contentType: att.contentType || 'application/octet-stream',
      }));
      console.log(`[Email Service] Adding ${attachments.length} attachment(s)`);
    }

    // Opt-in inbox delivery: on a successful send, persist the final rendered
    // HTML to the recipient member's inbox. Swallows its own errors (never
    // throws) and must not alter sendEmail's return contract. Uses
    // messageData.from so the fallback-domain identity is captured correctly.
    const maybeRecordInbox = async () => {
      if (!inboxDelivery || !inboxDelivery.memberId) return;
      await recordTransactionalInboxMessage({
        tenantId,
        memberId: inboxDelivery.memberId,
        to,
        subject,
        html: finalHtml,
        fromAddress: messageData.from,
        preheader: inboxDelivery.preheader || null,
        communicationCategoryId: inboxDelivery.communicationCategoryId || null,
        labelKey: inboxDelivery.labelKey || null,
      });
    };

    // Try sending with the tenant domain first
    try {
      const response = await client.messages.create(domain, messageData);
      console.log(`[Email Service] Email sent successfully. Message ID: ${response.id}`);
      await maybeRecordInbox();
      return {
        success: true,
        messageId: response.id,
        domain: domain,
      };
    } catch (primaryError) {
      // If tenant domain fails with auth/domain error, fall back to default domain
      const errorMsg = primaryError.message || primaryError.toString();
      const isAuthError = errorMsg.includes('Unauthorized') || 
                          errorMsg.includes('Forbidden') || 
                          errorMsg.includes('Domain not found') ||
                          primaryError.status === 401 ||
                          primaryError.status === 403;
      
      if (isAuthError && domain !== DEFAULT_DOMAIN) {
        console.warn(`[Email Service] Tenant domain ${domain} failed (${errorMsg}), falling back to ${DEFAULT_DOMAIN}`);
        
        // Update from address to use fallback domain
        const fallbackFrom = from || DEFAULT_FROM;
        messageData.from = fallbackFrom;
        
        const fallbackResponse = await client.messages.create(DEFAULT_DOMAIN, messageData);
        console.log(`[Email Service] Email sent via fallback domain. Message ID: ${fallbackResponse.id}`);
        await maybeRecordInbox();
        return {
          success: true,
          messageId: fallbackResponse.id,
          domain: DEFAULT_DOMAIN,
          fallback: true,
        };
      }
      
      // Re-throw if not an auth error or already using default domain
      throw primaryError;
    }
  } catch (error) {
    const status = error?.status || error?.statusCode;
    const errMsg = error?.message || String(error) || 'Unknown error sending email';
    console.error(
      `[Email Service] Failed to send email: status=${status || 'n/a'} domain=${domain} message="${errMsg}"`
    );
    return {
      success: false,
      error: status ? `${status}: ${errMsg}` : errMsg,
      status: status || null,
      domain,
    };
  }
}

/**
 * Convenience wrapper for platform→tenant-owner system messages (admin
 * password reset, signup verification, admin invites, billing notifications).
 * Forces sending from `mail.iconn.app` regardless of tenantId. Use this at
 * any call site where the recipient is a tenant owner/admin acting in their
 * capacity as our customer, not their tenant's members.
 */
export async function sendSystemEmail(opts) {
  return sendEmail({ ...opts, systemEmail: true });
}

export async function getEmailFooterForPreview(tenantId) {
  const footer = await getEmailFooter(tenantId);
  if (!footer) return null;
  return await replaceSocialPlaceholdersInFooter(footer, tenantId);
}

export function clearTenantEmailCache(tenantId) {
  if (tenantId) {
    tenantEmailConfigCache.delete(tenantId);
  } else {
    tenantEmailConfigCache.clear();
  }
}

export function replacePlaceholders(template, entityType, entityData, context) {
  if (!template) return '';
  
  console.log(`[replacePlaceholders] entityType="${entityType}", entityData keys: ${entityData ? Object.keys(entityData).join(', ') : 'null'}`);

  let result = template;

  if (context?.tenantBaseUrl && context?.tenantId && context?.memberId) {
    const prefToken = generateMemberPreferencesToken(context.tenantId, context.memberId);
    const preferencesUrl = `${context.tenantBaseUrl}/email-preferences?t=${prefToken}`;
    const preferencesLink = `<a href="${preferencesUrl}" style="color: #666;">Manage communication preferences</a>`;
    result = result.replace(/\{\{communication_preferences_link\}\}/gi, preferencesLink);
    result = result.replace(/\{\{communication_preferences_url\}\}/gi, preferencesUrl);
  }
  
  // First handle {{placeholder}} syntax (form field mappings)
  result = result.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (match, path) => {
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
    if (parts[0] === entityType || parts[0] === 'record' || parts[0] === 'organization' || parts[0] === 'member') {
      const fieldName = parts[1] || parts[0];
      let value;
      if (parts[0] !== entityType && parts[1]) {
        const prefixedFieldName = `${parts[0]}_${parts[1]}`;
        value = entityData?.[prefixedFieldName] || entityData?.[fieldName];
        console.log(`[replacePlaceholders] [[]] cross-entity lookup: prefixedFieldName="${prefixedFieldName}", fieldName="${fieldName}", value="${value}"`);
      } else {
        value = entityData?.[fieldName];
        console.log(`[replacePlaceholders] [[]] prefix match: fieldName="${fieldName}", value="${value}"`);
      }
      return value || match;
    }
    const directValue = entityData?.[path];
    console.log(`[replacePlaceholders] [[]] direct lookup: path="${path}", value="${directValue}"`);
    return directValue || match;
  });
  
  return result;
}
