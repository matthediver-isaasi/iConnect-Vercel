export const CONSENT_CATEGORIES = [
  { id: 'necessary', required: true, label: 'Necessary', description: 'Login, security, consent choices and requested payment services.' },
  { id: 'functional', label: 'Functional', description: 'Optional embedded media and personalisation.', gcm: ['functionality_storage', 'personalization_storage'] },
  { id: 'analytics', label: 'Analytics', description: 'Website usage measurement and event click counts.', gcm: ['analytics_storage'] },
  { id: 'marketing', label: 'Marketing', description: 'Advertising technologies, if introduced and declared.', gcm: ['ad_storage', 'ad_user_data', 'ad_personalization'] },
];
export const CONSENT_DEFAULTS = Object.freeze({
  enabled: false, pilotTenantIds: [], policyVersion: '1', retentionDays: 180,
  title: 'Your privacy choices',
  description: 'Necessary storage keeps this site working. You can choose whether to allow optional features and analytics. Rejecting optional storage does not affect login, forms or payments.',
  privacyUrl: '', cookieUrl: '/cookie-declaration', language: 'en', analyticsEnabled: false,
});
const tenantKeys = ['title', 'description', 'privacyUrl', 'cookieUrl', 'language', 'analyticsEnabled'];
const platformKeys = [...tenantKeys, 'enabled', 'pilotTenantIds', 'policyVersion', 'retentionDays'];
export function validateConsentOverrides(input, platform = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Overrides must be an object');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(platform ? platformKeys : tenantKeys).includes(key)) throw new Error(`Unsupported setting: ${key}`);
    if (['enabled', 'analyticsEnabled'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
    } else if (key === 'retentionDays') {
      if (!Number.isInteger(value) || value < 7 || value > 730) throw new Error('Retention must be 7–730 days');
    } else if (key === 'pilotTenantIds') {
      if (!Array.isArray(value) || value.length > 100 || value.some(id => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))) throw new Error('Invalid pilot tenant list');
    } else {
      if (typeof value !== 'string' || value.length > (key === 'description' ? 2000 : 500)) throw new Error(`Invalid ${key}`);
      if (key === 'language' && value !== 'en') throw new Error('Only English is currently supported');
      if (key === 'policyVersion' && !/^[a-zA-Z0-9._-]{1,64}$/.test(value)) throw new Error('Invalid policy version');
      if (['title', 'description'].includes(key) && !value.trim()) throw new Error(`${key} cannot be empty`);
      if (key.endsWith('Url') && value && !(/^\/(?!\/)[^\s\\]*$/.test(value) || /^https:\/\/[^\s\\]+$/.test(value))) throw new Error(`Invalid ${key}`);
      if (key.endsWith('Url') && value.startsWith('https:')) {
        const url = new URL(value);
        if (url.username || url.password) throw new Error('Policy links cannot contain credentials');
      }
    }
    result[key] = value;
  }
  return result;
}
export function effectiveConsentConfig(platform = {}, tenant = {}) {
  return { ...CONSENT_DEFAULTS, ...validateConsentOverrides(platform, true), ...validateConsentOverrides(tenant) };
}
export function consentComplete(config) {
  return !!(config.privacyUrl && config.cookieUrl && config.title && config.description);
}
