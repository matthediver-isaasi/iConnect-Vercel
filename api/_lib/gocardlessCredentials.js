// Per-tenant GoCardless credential resolution.
//
// Mirrors stripeCredentials.js: each tenant connects their OWN GoCardless
// account under /admin/integrations; credentials live encrypted in
// tenant_integrations (integration_type='gocardless'). Falls back to the
// platform-level GOCARDLESS_* env vars when a tenant has no connection of
// its own (useful for early rollout / single-tenant pilots).
//
// Credential fields stored per tenant:
//   access_token   GoCardless API access token (sandbox_… or live_…)
//   webhook_secret GoCardless webhook endpoint secret
//   environment    'sandbox' | 'live' (defaults to sandbox)
//   creditor_id    optional creditor pin for multi-creditor accounts

import crypto from 'node:crypto';
import { supabase } from './database.js';

const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[gocardless] Cannot decrypt - no encryption key configured');
    return null;
  }
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('[gocardless] Decryption error:', e.message);
    return null;
  }
}

function decryptCredentials(credentials) {
  if (!credentials) return {};
  const decrypted = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (value && typeof value === 'string' && value.includes(':')) {
      decrypted[key] = decrypt(value);
    } else {
      decrypted[key] = value;
    }
  }
  return decrypted;
}

export function envGocardlessCredentials() {
  const environment = (process.env.GOCARDLESS_ENVIRONMENT || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
  return {
    source: 'platform-env',
    tenantId: null,
    environment,
    accessToken: process.env.GOCARDLESS_ACCESS_TOKEN || null,
    webhookSecret: process.env.GOCARDLESS_WEBHOOK_SECRET || null,
    creditorId: process.env.GOCARDLESS_CREDITOR_ID || null,
    redirectBaseUrl: process.env.GOCARDLESS_REDIRECT_BASE_URL || null,
  };
}

/**
 * Resolve GoCardless credentials for a tenant.
 * Order: tenant_integrations row (enabled, integration_type='gocardless')
 * → platform env vars. Returns null accessToken if neither is configured.
 *
 * @param {string} tenantId
 * @param {{ db?: object }} [deps] injectable for tests
 */
export async function getGocardlessCredentials(tenantId, { db = supabase } = {}) {
  if (!tenantId) return envGocardlessCredentials();
  if (!db) throw new Error('Database not configured');

  const { data: integration, error } = await db
    .from('tenant_integrations')
    .select('credentials, is_enabled')
    .eq('tenant_id', tenantId)
    .eq('integration_type', 'gocardless')
    .maybeSingle();

  if (error) {
    console.error('[gocardless] Error fetching tenant credentials:', error.message);
    throw new Error('Failed to fetch GoCardless credentials');
  }

  if (integration && integration.is_enabled !== false && integration.credentials) {
    const creds = decryptCredentials(integration.credentials);
    if (creds.access_token) {
      const environment = (creds.environment || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
      return {
        source: 'tenant',
        tenantId,
        environment,
        accessToken: creds.access_token,
        webhookSecret: creds.webhook_secret || null,
        creditorId: creds.creditor_id || null,
        redirectBaseUrl: process.env.GOCARDLESS_REDIRECT_BASE_URL || null,
      };
    }
  }

  return envGocardlessCredentials();
}
