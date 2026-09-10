import Stripe from 'stripe';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';
import { getTrustedBaseUrlForTenant } from '../_lib/publicBaseUrl.js';
import { getStripeIntegrationCredentials } from '../_lib/stripeCredentials.js';
import {
  STRIPE_MEMBERSHIP_WEBHOOK_EVENTS,
  buildStripeMembershipWebhookUrl,
  checkStripeMembershipWebhookConfiguration,
} from '../_lib/stripeMembershipWebhookConfig.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const tenantContext = await getTenantContext(req);
  if (!tenantContext?.isAuthenticated || !tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!await hasAdminAccess(tenantContext)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const mode = req.body?.mode;
  if (mode !== 'live' && mode !== 'test') {
    return res.status(400).json({ error: 'mode must be live or test' });
  }

  let url;
  try {
    const baseUrl = await getTrustedBaseUrlForTenant(null, supabase, tenantContext.tenantId);
    url = buildStripeMembershipWebhookUrl(baseUrl, tenantContext.tenantId);
  } catch {
    return res.status(503).json({ error: 'A trusted production HTTPS webhook host is not configured' });
  }

  let credentials;
  try {
    credentials = await getStripeIntegrationCredentials(tenantContext.tenantId);
  } catch {
    return res.status(503).json({ error: 'Stripe configuration could not be read' });
  }
  const apiKey = mode === 'live' ? credentials?.secret_key : credentials?.test_secret_key;
  const signingSecret = mode === 'live'
    ? credentials?.membership_webhook_secret
    : credentials?.test_membership_webhook_secret;
  let stripe = null;
  if (apiKey) {
    try {
      stripe = new Stripe(apiKey);
    } catch {
      return res.status(200).json({
        mode,
        status: 'unavailable',
        url,
        secret_configured: Boolean(signingSecret),
        checks: {
          api_key_configured: true,
          endpoint_found: false,
          endpoint_enabled: false,
          events_complete: false,
        },
        missing_events: [...STRIPE_MEMBERSHIP_WEBHOOK_EVENTS],
        message: 'Stripe webhook configuration is currently unavailable because the configured API key could not be used.',
      });
    }
  }
  const result = await checkStripeMembershipWebhookConfiguration({
    stripe,
    mode,
    url,
    secretConfigured: Boolean(signingSecret),
  });
  return res.status(200).json(result);
}