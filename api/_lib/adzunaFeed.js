import crypto from 'node:crypto';
import { supabase } from './database.js';

const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;
export const ADZUNA_ATTRIBUTION = 'Jobs by Adzuna';
const BASE_URL = 'https://api.adzuna.com/v1/api/jobs/gb/search/1';

function decrypt(value) {
  if (!value || !ENCRYPTION_KEY) return null;
  try {
    const [ivHex, encrypted] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32), Buffer.from(ivHex, 'hex'));
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
  } catch { return null; }
}

export function getAdzunaQuery(config = {}) {
  const params = new URLSearchParams();
  if (config.keywords?.trim()) params.set('what', config.keywords.trim());
  if (config.exclusions?.trim()) params.set('what_exclude', config.exclusions.trim());
  if (config.category?.trim()) params.set('category', config.category.trim());
  if (config.location?.trim()) params.set('where', config.location.trim());
  params.set('max_days_old', String(Math.min(90, Math.max(1, Number(config.max_days_old) || 30))));
  params.set('results_per_page', String(Math.min(50, Math.max(1, Number(config.result_limit) || 25))));
  params.set('content-type', 'application/json');
  return params;
}

export function sanitiseAdzunaHtml(value = '') {
  const plainText = String(value)
    .replace(/<\s*(script|style|iframe|object)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .slice(0, 50000);
  return plainText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '<br>');
}

export function mapAdzunaJob(job, now = new Date().toISOString()) {
  const id = String(job?.id || '');
  let redirectUrl;
  try {
    redirectUrl = new URL(String(job?.redirect_url || ''));
  } catch {
    return null;
  }
  if (!id || !job?.title || !['http:', 'https:'].includes(redirectUrl.protocol)) return null;
  const salaryMin = Number(job.salary_min);
  const salaryMax = Number(job.salary_max);
  const salaryParts = [];
  if (Number.isFinite(salaryMin) && salaryMin > 0) salaryParts.push(`£${Math.round(salaryMin).toLocaleString()}`);
  if (Number.isFinite(salaryMax) && salaryMax > 0) salaryParts.push(`£${Math.round(salaryMax).toLocaleString()}`);
  const providerCreated = new Date(job.created || now);
  const createdDate = Number.isNaN(providerCreated.valueOf()) ? now : providerCreated.toISOString();
  return {
    title: String(job.title).slice(0, 500),
    description: sanitiseAdzunaHtml(job.description || ''),
    company_name: String(job.company?.display_name || 'External employer').slice(0, 500),
    location: String(job.location?.display_name || 'United Kingdom').slice(0, 500),
    salary_range: salaryParts.join('–') || null,
    job_type: job.contract_type ? String(job.contract_type).replace(/_/g, ' ') : null,
    hours: job.contract_time ? String(job.contract_time).replace(/_/g, ' ') : null,
    application_method: 'url',
    application_value: redirectUrl.toString(),
    contact_email: 'jobs@adzuna.co.uk',
    contact_name: ADZUNA_ATTRIBUTION,
    created_date: createdDate,
    closing_date: null,
    status: 'active',
    payment_status: 'N/A',
    is_member_post: false,
    featured: false,
    external_source: 'adzuna',
    external_id: id,
    external_url: redirectUrl.toString(),
    source_attribution: ADZUNA_ATTRIBUTION,
    external_last_seen_at: now,
  };
}

export async function getAdzunaCredentials(tenantId, { db = supabase } = {}) {
  const { data, error } = await db.from('tenant_integrations').select('credentials,is_enabled')
    .eq('tenant_id', tenantId).eq('integration_type', 'adzuna').maybeSingle();
  if (error) throw new Error('Unable to load Adzuna credentials');
  if (!data?.is_enabled) return null;
  const credentials = Object.fromEntries(Object.entries(data.credentials || {}).map(([k, v]) => [k, typeof v === 'string' && v.includes(':') ? decrypt(v) : v]));
  return credentials.app_id && credentials.app_key ? credentials : null;
}

export async function fetchAdzunaJobs(credentials, config, fetcher = fetch) {
  const params = getAdzunaQuery(config);
  params.set('app_id', credentials.app_id);
  params.set('app_key', credentials.app_key);
  let response;
  try {
    response = await fetcher(`${BASE_URL}?${params}`, {
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(10_000)
        : undefined,
    });
  } catch {
    throw new Error('Adzuna is unavailable. Please try again later.');
  }
  if (!response.ok) {
    const status = response.status;
    throw new Error(status === 401 || status === 403 ? 'Adzuna authentication failed. Check the API ID and key.' : 'Adzuna is unavailable. Please try again later.');
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Adzuna returned an invalid response. Please try again later.');
  }
  return Array.isArray(body?.results) ? body.results : [];
}

export async function syncAdzunaFeed(tenantId, { db = supabase, fetcher = fetch, now: nowFactory = () => new Date().toISOString() } = {}) {
  const { data: config, error: configError } = await db.from('tenant_job_feed_config').select('*').eq('tenant_id', tenantId).maybeSingle();
  if (configError) throw new Error('Unable to load feed settings');
  const credentials = await getAdzunaCredentials(tenantId, { db });
  if (!credentials) throw new Error('Adzuna is not connected or enabled');
  const now = nowFactory();
  const jobs = await fetchAdzunaJobs(credentials, config || {}, fetcher);
  const rows = jobs.map(job => mapAdzunaJob(job, now)).filter(Boolean).map(row => ({ ...row, tenant_id: tenantId }));
  if (rows.length) {
    const { error } = await db.from('job_posting').upsert(rows, { onConflict: 'tenant_id,external_source,external_id' });
    if (error) throw new Error('Unable to save Adzuna jobs');
  }
  // Retire only successfully refreshed Adzuna records; native and failed refreshes remain untouched.
  const { error: retireError } = await db.from('job_posting').update({ status: 'expired' })
    .eq('tenant_id', tenantId).eq('external_source', 'adzuna').eq('status', 'active').lt('external_last_seen_at', now);
  if (retireError) throw new Error('Unable to retire stale Adzuna jobs');
  const { error: statusError } = await db.from('tenant_job_feed_config').upsert({ tenant_id: tenantId, provider: 'adzuna', last_sync_at: now, last_success_at: now, last_error: null, last_imported_count: rows.length, updated_at: now });
  if (statusError) throw new Error('Unable to record Adzuna sync status');
  return { imported: rows.length, fetched: jobs.length, at: now };
}