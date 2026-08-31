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

/**
 * Full decrypted Stripe integration credential map for a tenant (all keys:
 * live + test secret/publishable keys, per-feature mode flags, webhook
 * secrets). Use when a caller needs more than the single feature-selected
 * key pair (e.g. webhook signature verification, cross-mode PI lookup).
 */
export async function getStripeIntegrationCredentials(tenantId) {
  if (!supabase) throw new Error('Database not configured');
  if (!tenantId) throw new Error('tenantId is required to get Stripe credentials');

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
  if (!integration) return null;
  return { ...decryptCredentials(integration.credentials), is_enabled: integration.is_enabled };
}

/**
 * Retrieve a PaymentIntent for a tenant feature, tolerating a mid-session
 * test/live mode flip (Task #3278).
 *
 * A fee/payment page keeps the publishable key + client secret it loaded
 * with; if an admin flips `stripe_mode_<feature>` while the payer is mid
 * checkout, the confirm step would resolve the OTHER mode's secret key and
 * `paymentIntents.retrieve` fails with `resource_missing` — a succeeded
 * charge then looks like a hard failure. This helper retries the lookup
 * with the other mode's key and reports the mismatch so callers can still
 * verify + record the payment against the account that actually charged it.
 *
 * @returns {Promise<{ paymentIntent, stripe, usedMode: 'selected'|'other', secretKey, publishableKey } | null>}
 *          null when no Stripe credentials are configured at all.
 * @throws the original Stripe error when the PI is not found in either mode.
 */
export async function retrieveTenantPaymentIntent(tenantId, feature, paymentIntentId) {
  const Stripe = (await import('stripe')).default;
  const all = await getStripeIntegrationCredentials(tenantId);
  if (!all) return null;

  const mode = (feature && all[`stripe_mode_${feature}`]) || 'live';
  const liveKey = all.secret_key || null;
  const testKey = all.test_secret_key || null;
  const selectedKey = mode === 'test' && testKey ? testKey : liveKey;
  const otherKey = selectedKey === liveKey ? testKey : liveKey;
  const publishableFor = (secretKey) => (
    secretKey === testKey ? all.test_publishable_key : all.publishable_key
  ) || null;
  if (!selectedKey) return null;

  const selectedStripe = new Stripe(selectedKey);
  try {
    const paymentIntent = await selectedStripe.paymentIntents.retrieve(paymentIntentId);
    return {
      paymentIntent,
      stripe: selectedStripe,
      usedMode: 'selected',
      secretKey: selectedKey,
      publishableKey: publishableFor(selectedKey),
    };
  } catch (err) {
    const notFound = err?.code === 'resource_missing' || err?.statusCode === 404;
    if (!notFound || !otherKey || otherKey === selectedKey) throw err;
    console.warn(`[Stripe] PI ${paymentIntentId} not found with the ${mode} key for feature "${feature}" (tenant ${tenantId}); retrying with the other mode's key (possible mid-session test/live mode flip)`);
    const otherStripe = new Stripe(otherKey);
    const paymentIntent = await otherStripe.paymentIntents.retrieve(paymentIntentId);
    console.warn(`[Stripe] MODE MISMATCH: PI ${paymentIntentId} belongs to the ${mode === 'test' ? 'live' : 'test'} account while feature "${feature}" is set to ${mode} (tenant ${tenantId})`);
    return {
      paymentIntent,
      stripe: otherStripe,
      usedMode: 'other',
      secretKey: otherKey,
      publishableKey: publishableFor(otherKey),
    };
  }
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
