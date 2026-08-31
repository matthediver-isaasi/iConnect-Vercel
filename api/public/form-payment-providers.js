/**
 * GET /api/public/form-payment-providers (Task #3483)
 *
 * Tenant-scoped payment provider detection for the generic form Payment
 * field. Safe to call from BOTH the authenticated FormBuilder and the
 * public form page: it reveals only which providers are usable, their
 * display names and (for Stripe) the publishable key — never secrets.
 */
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getStripeCredentials } from '../_lib/stripeCredentials.js';
import { getGocardlessCredentials } from '../_lib/gocardlessCredentials.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const tenantData = await resolveTenantFromRequest(req);
    if (!tenantData) return res.status(404).json({ error: 'Tenant not found' });
    const purpose = req.query?.purpose || 'forms';
    if (!['forms', 'membership'].includes(purpose)) {
      return res.status(400).json({ error: 'Invalid payment purpose' });
    }

    const providers = [];

    // Stripe: usable when the tenant integration is enabled and the
    // feature-resolved key pair (respecting the requested feature's
    // test/live mode)
    // includes both a secret and a publishable key.
    let stripeConfigured = false;
    let stripePublishableKey = null;
    let stripeConfigurationError = null;
    let stripeMode = null;
    try {
      const creds = await getStripeCredentials(tenantData.id, purpose);
      stripeMode = creds?.mode || null;
      if (creds && creds.is_enabled !== false && creds.secret_key && creds.publishable_key) {
        stripeConfigured = true;
        stripePublishableKey = creds.publishable_key;
      } else if (creds?.is_enabled !== false) {
        stripeConfigurationError = creds?.configuration_error || null;
      }
    } catch (err) {
      console.warn('[form-payment-providers] Stripe credential check failed:', err?.message);
    }
    providers.push({
      id: 'stripe',
      name: 'Card payment (Stripe)',
      configured: stripeConfigured,
      ...(stripeMode ? { mode: stripeMode } : {}),
      ...(stripeConfigured ? { publishableKey: stripePublishableKey } : {}),
      ...(!stripeConfigured && stripeConfigurationError ? { configurationError: stripeConfigurationError } : {}),
    });

    // GoCardless: usable when tenant (or platform env fallback) creds exist.
    let gcConfigured = false;
    try {
      const gcCreds = await getGocardlessCredentials(tenantData.id);
      gcConfigured = !!gcCreds?.accessToken;
    } catch (err) {
      console.warn('[form-payment-providers] GoCardless credential check failed:', err?.message);
    }
    providers.push({
      id: 'gocardless',
      name: 'Direct Debit (GoCardless)',
      configured: gcConfigured,
    });

    return res.status(200).json({ providers });
  } catch (err) {
    console.error('[form-payment-providers] Error:', err);
    return res.status(500).json({ error: 'Failed to detect payment providers' });
  }
}
