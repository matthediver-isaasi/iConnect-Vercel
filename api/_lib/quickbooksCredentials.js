import { supabase } from './database.js';
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[QuickBooks] Cannot decrypt - no encryption key configured');
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
    console.error('[QuickBooks] Decryption error:', e.message);
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

export async function getQuickBooksCredentials(tenantId) {
  if (!supabase) {
    throw new Error('Database not configured');
  }
  if (!tenantId) {
    throw new Error('tenantId is required to get QuickBooks credentials');
  }

  const { data: integration, error } = await supabase
    .from('tenant_integrations')
    .select('credentials, is_enabled')
    .eq('tenant_id', tenantId)
    .eq('integration_type', 'quickbooks')
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('[QuickBooks] Error fetching credentials:', error);
    throw new Error('Failed to fetch QuickBooks credentials');
  }

  if (!integration) return null;

  const decrypted = decryptCredentials(integration.credentials);
  const environment = decrypted.environment === 'sandbox' ? 'sandbox' : 'production';

  return {
    client_id: decrypted.client_id || null,
    client_secret: decrypted.client_secret || null,
    environment,
    is_enabled: integration.is_enabled,
  };
}

export function getIntuitEndpoints(environment) {
  const isSandbox = environment === 'sandbox';
  return {
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    revokeUrl: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
    apiBaseUrl: isSandbox
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com',
  };
}
