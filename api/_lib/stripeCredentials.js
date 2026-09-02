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

export function decryptCredentials(credentials) {
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

export function selectStripeCredentials(decrypted = {}, feature = null) {
  const mode = feature ? (decrypted[`stripe_mode_${feature}`] || 'live') : 'live';
  if (mode === 'test') {
    const complete = !!(decrypted.test_secret_key && decrypted.test_publishable_key);
    return {
      secret_key: complete ? decrypted.test_secret_key : null,
      publishable_key: complete ? decrypted.test_publishable_key : null,
      mode,
      configuration_error: complete
        ? null
        : `Stripe ${feature || 'payment'} payments are set to Test, but the test credentials are missing or could not be read.`,
    };
  }
  const complete = !!(decrypted.secret_key && decrypted.publishable_key);
  return {
    secret_key: complete ? decrypted.secret_key : null,
    publishable_key: complete ? decrypted.publishable_key : null,
    mode: 'live',
    configuration_error: complete
      ? null
      : `Stripe ${feature || 'payment'} payments are set to Live, but the live credentials are missing or could not be read.`,
  };
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

  const selected = selectStripeCredentials(decrypted, feature);
  if (selected.mode === 'test' && !selected.configuration_error) {
    console.log(`[Stripe] Using TEST keys for feature "${feature}" (tenant: ${tenantId})`);
  } else if (selected.configuration_error) {
    console.warn(`[Stripe] ${selected.configuration_error} (tenant: ${tenantId})`);
  }
  
  return {
    ...selected,
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
  const selectedKey = mode === 'test' ? testKey : liveKey;
  const otherKey = mode === 'test' ? liveKey : testKey;
  const publishableFor = (secretKey) => (
    secretKey === testKey ? all.test_publishable_key : all.publishable_key
  ) || null;
  // Confirmation is the one place where the opposite mode is allowed: an
  // intent may genuinely pre-date an admin mode switch. If the newly selected
  // mode has no readable key, try only the opposite account for that old ID.
  if (!selectedKey && otherKey) {
    const otherStripe = new Stripe(otherKey);
    const paymentIntent = await otherStripe.paymentIntents.retrieve(paymentIntentId);
    return {
      paymentIntent,
      stripe: otherStripe,
      usedMode: 'other',
      secretKey: otherKey,
      publishableKey: publishableFor(otherKey),
    };
  }
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

function normalizedCustomerEmail(email) {
  if (typeof email !== 'string') return null;
  const value = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function stripeCustomerMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(metadata || {})
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  );
}

async function findOrCreateStripeCustomerUnsafe(
  stripe,
  { email, name, metadata = {}, idempotencyKey = null, allowMissingEmail = false },
) {
  const normalizedEmail = normalizedCustomerEmail(email);
  if (!normalizedEmail && !allowMissingEmail) return null;

  const safeMetadata = stripeCustomerMetadata(metadata);
  if (normalizedEmail) {
    const existing = await stripe.customers.list({
      email: normalizedEmail,
      limit: 1,
    });

    if (existing.data.length > 0) {
      const customer = existing.data[0];
      const updates = {};
      if (name && !customer.name) updates.name = name;
      if (Object.keys(safeMetadata).length > 0) {
        updates.metadata = { ...(customer.metadata || {}), ...safeMetadata };
      }
      return Object.keys(updates).length > 0
        ? stripe.customers.update(customer.id, updates)
        : customer;
    }
  }

  const params = {
    email: normalizedEmail || undefined,
    name: name || undefined,
    metadata: safeMetadata,
  };
  return idempotencyKey
    ? stripe.customers.create(params, { idempotencyKey })
    : stripe.customers.create(params);
}

export async function findOrCreateStripeCustomer(stripe, options) {
  if (!options?.email) return null;
  try {
    return await findOrCreateStripeCustomerUnsafe(stripe, options);
  } catch (err) {
    console.error('[Stripe] Error finding/creating customer:', err.message);
    return null;
  }
}

/**
 * Membership PaymentIntents require a Customer so the verified billing
 * address can be attached after payment. Public application forms do not
 * always collect an email, and Stripe Customers do not require one, so this
 * path deliberately creates an address-ready Customer without an email rather
 * than failing before Elements can open.
 */
export async function prepareRequiredStripeCustomer(stripe, options = {}) {
  const normalizedEmail = normalizedCustomerEmail(options.email);
  try {
    const customer = await findOrCreateStripeCustomerUnsafe(stripe, {
      ...options,
      email: normalizedEmail,
      allowMissingEmail: true,
    });
    if (!customer?.id) {
      return {
        ok: false,
        code: 'STRIPE_CUSTOMER_UNAVAILABLE',
        status: 502,
      };
    }
    return {
      ok: true,
      customer,
      email: normalizedEmail,
      emailOmitted: !normalizedEmail,
    };
  } catch (err) {
    console.error('[Stripe] Required customer preparation failed:', {
      code: err?.code || null,
      type: err?.type || null,
      statusCode: err?.statusCode || null,
      requestId: err?.requestId || err?.request_id || null,
      tenantId: options.metadata?.tenant_id || null,
      memberId: options.metadata?.member_id || null,
      formSubmissionId: options.metadata?.form_submission_id || null,
      message: err?.message || 'Unknown Stripe error',
    });
    return {
      ok: false,
      code: 'STRIPE_CUSTOMER_PROVIDER_ERROR',
      status: 502,
    };
  }
}
