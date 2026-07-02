import Mailgun from 'mailgun.js';
import formData from 'form-data';
import { createClient } from '@supabase/supabase-js';

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || 'mail.iconn.app';
const DEFAULT_FROM = process.env.MAILGUN_FROM_EMAIL || 'ICONN <noreply@mail.iconn.app>';
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  cc?: string;
  bcc?: string;
  skipFooter?: boolean;
}

interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

let mailgunClient: any = null;
let cachedEmailFooter: string | null = null;
let footerLastFetched = 0;
const FOOTER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getEmailFooter(): Promise<string | null> {
  const now = Date.now();
  if (cachedEmailFooter !== null && (now - footerLastFetched) < FOOTER_CACHE_TTL) {
    return cachedEmailFooter;
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      console.log('[Email Service] Supabase not configured, skipping footer');
      return null;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
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

async function replaceSocialPlaceholdersInFooter(footer: string): Promise<string> {
  if (!footer) return footer;
  
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) return footer;

    const supabase = createClient(supabaseUrl, supabaseKey);
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
    const config: any = {
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

export async function sendEmail(options: EmailOptions): Promise<EmailResult> {
  const { to, subject, html, text, from = DEFAULT_FROM, cc, bcc, skipFooter = false } = options;

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

  try {
    // Append email footer if configured
    let finalHtml = html;
    if (!skipFooter) {
      const footer = await getEmailFooter();
      if (footer) {
        const processedFooter = await replaceSocialPlaceholdersInFooter(footer);
        finalHtml = finalHtml + processedFooter;
        console.log('[Email Service] Email footer appended');
      }
    }

    console.log(`[Email Service] Sending email to: ${to}`);
    console.log(`[Email Service] Subject: ${subject}`);
    if (cc) console.log(`[Email Service] CC: ${cc}`);
    if (bcc) console.log(`[Email Service] BCC: ${bcc}`);

    const messageData: any = {
      from,
      to: [to],
      subject,
      html: finalHtml,
      text: text || finalHtml.replace(/<[^>]*>/g, ''),
    };
    
    // Add CC and BCC if provided
    if (cc) {
      messageData.cc = cc.split(',').map((e: string) => e.trim()).filter((e: string) => e);
    }
    if (bcc) {
      messageData.bcc = bcc.split(',').map((e: string) => e.trim()).filter((e: string) => e);
    }

    const response = await client.messages.create(MAILGUN_DOMAIN, messageData);

    console.log(`[Email Service] Email sent successfully. Message ID: ${response.id}`);

    return {
      success: true,
      messageId: response.id,
    };
  } catch (error: any) {
    console.error('[Email Service] Failed to send email:', error.message || error);
    return {
      success: false,
      error: error.message || 'Unknown error sending email',
    };
  }
}

export function isEmailServiceConfigured(): boolean {
  return !!MAILGUN_API_KEY;
}
