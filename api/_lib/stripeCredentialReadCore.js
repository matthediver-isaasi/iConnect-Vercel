import crypto from 'node:crypto';

export async function readStripeCredentials(db, tenantId, feature, {
  encryptionKey,
} = {}) {
  if (!db || !tenantId) throw new Error('Stripe credential database and tenant are required');
  const { data: integration, error } = await db.from('tenant_integrations').select('credentials, is_enabled')
    .eq('tenant_id', tenantId).eq('integration_type', 'stripe').maybeSingle();
  if (error && error.code !== 'PGRST116') throw new Error('Failed to fetch Stripe credentials');
  if (!integration) return null;
  const credentials = {};
  for (const [key, value] of Object.entries(integration.credentials || {})) {
    if (typeof value !== 'string' || !value.includes(':')) { credentials[key] = value; continue; }
    try {
      if (!encryptionKey) { credentials[key] = null; continue; }
      const [iv, encrypted] = value.split(':');
      const decipher = crypto.createDecipheriv('aes-256-cbc', crypto.scryptSync(encryptionKey, 'salt', 32), Buffer.from(iv, 'hex'));
      credentials[key] = decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
    } catch { credentials[key] = null; }
  }
  const mode = feature && credentials[`stripe_mode_${feature}`] === 'test' ? 'test' : 'live';
  const secret = credentials[mode === 'test' ? 'test_secret_key' : 'secret_key'];
  const publishable = credentials[mode === 'test' ? 'test_publishable_key' : 'publishable_key'];
  const complete = !!(secret && publishable);
  return {
    secret_key: complete ? secret : null, publishable_key: complete ? publishable : null,
    mode, is_enabled: integration.is_enabled,
    configuration_error: complete ? null : `Stripe ${feature || 'payment'} payments are set to ${mode === 'test' ? 'Test' : 'Live'}, but the ${mode === 'test' ? 'test' : 'live'} credentials are missing or could not be read.`,
  };
}