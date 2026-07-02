import { supabase } from './database.js';
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[Stripe] Cannot decrypt - no encryption key configured');
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
    console.error('[Stripe] Decryption error:', e.message);
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

export async function getStripeCredentials(tenantId, feature) {
  if (!supabase) {
    throw new Error('Database not configured');
  }
  
  if (!tenantId) {
    throw new Error('tenantId is required to get Stripe credentials');
  }

  const { data: integration, error } = await supabase
    .from('tenant_integrations')
    .select('credentials, is_enabled')
    .eq('tenant_id', tenantId)
    .eq('integration_type', 'stripe')
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('[Stripe] Error fetching credentials:', error);
    throw new Error('Failed to fetch Stripe credentials');
  }

  if (!integration) {
    return null;
  }

  const decrypted = decryptCredentials(integration.credentials);

  let secret_key = decrypted.secret_key || null;
  let publishable_key = decrypted.publishable_key || null;

  if (feature) {
    const modeKey = `stripe_mode_${feature}`;
    const mode = decrypted[modeKey] || 'live';
    if (mode === 'test' && decrypted.test_secret_key && decrypted.test_publishable_key) {
      secret_key = decrypted.test_secret_key;
      publishable_key = decrypted.test_publishable_key;
      console.log(`[Stripe] Using TEST keys for feature "${feature}" (tenant: ${tenantId})`);
    } else if (mode === 'test') {
      console.warn(`[Stripe] Feature "${feature}" set to test mode but test keys not configured, falling back to live keys (tenant: ${tenantId})`);
    }
  }
  
  return {
    secret_key,
    publishable_key,
    is_enabled: integration.is_enabled
  };
}

export async function findOrCreateStripeCustomer(stripe, { email, name, metadata = {} }) {
  if (!email) return null;

  try {
    const existing = await stripe.customers.list({
      email: email.toLowerCase(),
      limit: 1,
    });

    if (existing.data.length > 0) {
      const customer = existing.data[0];
      const updates = {};
      if (name && !customer.name) {
        updates.name = name;
      }
      if (metadata && Object.keys(metadata).length > 0) {
        const mergedMeta = { ...customer.metadata, ...metadata };
        updates.metadata = mergedMeta;
      }
      if (Object.keys(updates).length > 0) {
        return await stripe.customers.update(customer.id, updates);
      }
      return customer;
    }

    const newCustomer = await stripe.customers.create({
      email: email.toLowerCase(),
      name: name || undefined,
      metadata,
    });

    return newCustomer;
  } catch (err) {
    console.error('[Stripe] Error finding/creating customer:', err.message);
    return null;
  }
}
