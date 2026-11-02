import { createHash } from 'node:crypto';
import { supabase } from './database.js';
import { resolveTenantFromHost } from './tenantResolver.js';
import { effectiveConsentConfig, consentComplete } from '../../shared/cookieConsent.js';

export function consentHost(req) {
  // Never accept tenant/domain query overrides or client-supplied forwarded hosts.
  const host = req.headers?.host;
  if (typeof host !== 'string' || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw new Error('Untrusted host');
  const name = host.toLowerCase().replace(/:\d+$/, '');
  if (name === 'localhost' || name.endsWith('.replit.dev') || name.endsWith('.vercel.app') || !name.includes('.')) throw new Error('Shared host is not eligible');
  return name;
}
export function sameOrigin(req, host) {
  try {
    const url = new URL(req.headers?.origin);
    return url.protocol === 'https:' && url.hostname === host && !url.port;
  } catch { return false; }
}
export async function loadConsentConfig(tenant, db = supabase) {
  const { data, error } = await db.from('platform_preferences').select('value').eq('key', 'cookie_consent').maybeSingle();
  if (error) throw error;
  const effective = effectiveConsentConfig(data?.value || {}, tenant?.settings?.cookie_consent || {});
  return { effective, active: effective.enabled && effective.pilotTenantIds.includes(tenant?.id) && consentComplete(effective) };
}
export async function resolveConsentRequest(req) {
  const host = consentHost(req);
  const tenant = await resolveTenantFromHost(host, { fresh: true });
  if (!tenant) throw new Error('Unknown tenant host');
  return { host, tenant, ...await loadConsentConfig(tenant) };
}
export function validateConsentRecord(body, { host, policyVersion, taxonomyHash, revision }, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 4096) throw new Error('Invalid record size');
  const allowed = ['recordId','consentId','categories','regulation','domain','decidedAt','taxonomyHash','action','source','region','policyVersion','policyRevision'];
  if (Object.keys(body).some(k => !allowed.includes(k))) throw new Error('Unexpected record field');
  for (const key of ['recordId','consentId','taxonomyHash']) if (typeof body[key] !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(body[key])) throw new Error(`Invalid ${key}`);
  if (body.domain !== host || body.policyVersion !== policyVersion || body.taxonomyHash !== taxonomyHash || body.policyRevision !== revision) throw new Error('Record configuration mismatch');
  if (body.regulation !== 'GDPR' || !['accept_all','reject_all','accept_selected','save'].includes(body.action) || !['banner','preferences','optout','api'].includes(body.source)) throw new Error('Invalid decision');
  const date = Date.parse(body.decidedAt);
  if (typeof body.decidedAt !== 'string' || !Number.isFinite(date) || date < now - 7 * 86400000 || date > now + 300000) throw new Error('Invalid decision time');
  if (body.region !== undefined && (typeof body.region !== 'string' || !/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(body.region))) throw new Error('Invalid region');
  const cats = body.categories;
  if (!cats || Object.keys(cats).sort().join(',') !== 'analytics,functional,marketing,necessary' || Object.values(cats).some(v => typeof v !== 'boolean') || cats.necessary !== true) throw new Error('Invalid categories');
  if (body.action==='reject_all' && (cats.functional || cats.analytics || cats.marketing)) throw new Error('Reject action mismatch');
  if (body.action==='accept_all' && (!cats.functional || !cats.analytics || !cats.marketing)) throw new Error('Accept action mismatch');
  return {
    record_id: body.recordId, consent_id: body.consentId, domain: host, categories: cats,
    regulation: body.regulation, region: body.region || null, decided_at: new Date(date).toISOString(),
    taxonomy_hash: body.taxonomyHash, action: body.action, source: body.source, policy_version: policyVersion, policy_revision: revision,
  };
}
export function policyFingerprint(config, measurementId = null) {
  return createHash('sha256').update(JSON.stringify([config.policyVersion,config.title,config.description,config.privacyUrl,config.cookieUrl,config.analyticsEnabled,measurementId])).digest('hex').slice(0,24);
}
