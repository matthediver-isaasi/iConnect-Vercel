import Mailgun from 'mailgun.js';
import formData from 'form-data';
import { supabase } from './database.js';

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';
const MAILGUN_FALLBACK_DOMAIN = `mail.${APP_DOMAIN}`;
const MAILGUN_REGION = process.env.MAILGUN_REGION || 'eu';

let mailgunClient = null;

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

async function getTenantDomain(tenantId) {
  if (!tenantId) {
    return MAILGUN_FALLBACK_DOMAIN;
  }

  try {
    const { data: tenant, error } = await supabase
      .from('tenant')
      .select('id, name, slug, settings')
      .eq('id', tenantId)
      .single();

    if (error || !tenant) {
      console.log(`[Email Logs] No tenant found for ${tenantId}`);
      return MAILGUN_FALLBACK_DOMAIN;
    }

    const emailDomainConfig = tenant.settings?.email_domain;
    
    if (emailDomainConfig && emailDomainConfig.status === 'verified') {
      return emailDomainConfig.domain;
    }

    return MAILGUN_FALLBACK_DOMAIN;
  } catch (err) {
    console.error('[Email Logs] Error fetching tenant domain:', err);
    return MAILGUN_FALLBACK_DOMAIN;
  }
}

export async function getEmailStats(tenantId) {
  if (!MAILGUN_API_KEY) {
    return {
      success: false,
      error: 'Mailgun not configured'
    };
  }

  const client = getMailgunClient();
  if (!client) {
    return {
      success: false,
      error: 'Failed to initialize Mailgun client'
    };
  }

  const domain = await getTenantDomain(tenantId);
  console.log(`[Email Logs] Fetching stats for domain: ${domain}`);

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    let totals = {
      accepted: 0,
      delivered: 0,
      failed: 0,
      opened: 0,
      clicked: 0,
      unsubscribed: 0,
      complained: 0,
      stored: 0
    };

    try {
      const stats = await client.stats.getDomain(domain, {
        event: ['accepted', 'delivered', 'failed', 'opened', 'clicked', 'unsubscribed', 'complained', 'stored'],
        start: thirtyDaysAgo.toISOString(),
        end: now.toISOString(),
        resolution: 'month'
      });

      if (stats && stats.stats) {
        for (const stat of stats.stats) {
          if (stat.accepted) totals.accepted += (stat.accepted.total || 0);
          if (stat.delivered) totals.delivered += (stat.delivered.total || 0);
          if (stat.failed) {
            totals.failed += (stat.failed.permanent?.total || 0) + (stat.failed.temporary?.total || 0);
          }
          if (stat.opened) totals.opened += (stat.opened.total || 0);
          if (stat.clicked) totals.clicked += (stat.clicked.total || 0);
          if (stat.unsubscribed) totals.unsubscribed += (stat.unsubscribed.total || 0);
          if (stat.complained) totals.complained += (stat.complained.total || 0);
          if (stat.stored) totals.stored += (stat.stored.total || 0);
        }
      }
    } catch (statsErr) {
      console.log('[Email Logs] Stats API error, will calculate from events:', statsErr.message);
    }

    const hasStats = Object.values(totals).some(v => v > 0);
    
    if (!hasStats) {
      console.log('[Email Logs] No aggregated stats available, calculating from recent events');
      try {
        const events = await client.events.get(domain, { limit: 300 });
        
        if (events && events.items) {
          for (const item of events.items) {
            const eventType = item.event;
            if (eventType === 'accepted') totals.accepted++;
            else if (eventType === 'delivered') totals.delivered++;
            else if (eventType === 'failed') totals.failed++;
            else if (eventType === 'opened') totals.opened++;
            else if (eventType === 'clicked') totals.clicked++;
            else if (eventType === 'unsubscribed') totals.unsubscribed++;
            else if (eventType === 'complained') totals.complained++;
            else if (eventType === 'stored') totals.stored++;
          }
          console.log(`[Email Logs] Calculated stats from ${events.items.length} events`);
        }
      } catch (eventsErr) {
        console.error('[Email Logs] Error fetching events for stats:', eventsErr.message);
      }
    }

    return {
      success: true,
      domain,
      period: '30 days',
      stats: totals
    };
  } catch (err) {
    console.error('[Email Logs] Error fetching stats:', err.message);
    return {
      success: false,
      error: err.message || 'Failed to fetch email stats'
    };
  }
}

export async function getEmailEvents(tenantId, options = {}) {
  if (!MAILGUN_API_KEY) {
    return {
      success: false,
      error: 'Mailgun not configured'
    };
  }

  const client = getMailgunClient();
  if (!client) {
    return {
      success: false,
      error: 'Failed to initialize Mailgun client'
    };
  }

  const domain = await getTenantDomain(tenantId);
  console.log(`[Email Logs] Fetching events for domain: ${domain}`);

  try {
    const {
      limit = 25,
      page = null,
      event = null,
      recipient = null
    } = options;

    const query = {
      limit
    };

    if (event) {
      query.event = event;
    }

    if (recipient) {
      query.recipient = recipient;
    }

    if (page) {
      query.page = page;
    }

    const events = await client.events.get(domain, query);

    const formattedEvents = (events.items || []).map(item => ({
      id: item.id,
      event: item.event,
      timestamp: item.timestamp,
      recipient: item.recipient,
      subject: item.message?.headers?.subject || '',
      from: item.message?.headers?.from || '',
      messageId: item.message?.headers?.['message-id'] || '',
      deliveryStatus: item['delivery-status'] || null,
      severity: item.severity || null,
      reason: item.reason || null,
      tags: item.tags || []
    }));

    return {
      success: true,
      domain,
      events: formattedEvents,
      paging: events.pages || null
    };
  } catch (err) {
    console.error('[Email Logs] Error fetching events:', err.message);
    return {
      success: false,
      error: err.message || 'Failed to fetch email events'
    };
  }
}
