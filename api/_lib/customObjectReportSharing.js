import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { CustomObjectHttpError, createSharedReportExecutor } from './customObjectService.js';
import { reportDefinitionKey } from '../../shared/customObjectReportSort.mjs';

const scrypt = promisify(scryptCallback);
export const reportShareDigest = value => createHash('sha256').update(String(value)).digest('hex');
const fail = (status, message) => { throw new CustomObjectHttpError(status, message); };
const checked = result => {
  if (result.error) fail(503, 'Report sharing is temporarily unavailable');
  return result.data;
};
const reportIdentity = report => reportShareDigest(reportDefinitionKey({ id: report.id, name: report.name, config: report.config }));
const reportIdValid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const reportShareUnavailable = 'This report is unavailable or access is no longer valid.';
export async function hashReportPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail(400, 'Use a password containing 12–128 characters');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
export async function verifyReportPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128 || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored || '')) return false;
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(await scrypt(password, salt, 64), Buffer.from(hash, 'hex'));
}
function shareToken(share, key) {
  if (typeof key !== 'string' || Buffer.byteLength(key) < 32) fail(503, 'Report sharing requires the server signing key');
  // Reconstructable only on the server: the database stores a token hash, not
  // the capability secret. Password/CSV changes need not change the URL.
  return `${share.id}.${createHmac('sha256', key).update(`custom-report-link:${share.tenant_id}:${share.id}:${share.link_nonce}`).digest('base64url')}`;
}
export async function loadSavedCustomReport(db, tenantId, objectId, reportId) {
  if (!reportIdValid(reportId)) fail(404, reportShareUnavailable);
  const object = checked(await db.from('custom_object_definition').select('id,status')
    .eq('tenant_id', tenantId).eq('id', objectId).maybeSingle());
  if (!object || object.status !== 'active') fail(404, reportShareUnavailable);
  const row = checked(await db.from('system_settings').select('setting_value')
    .eq('tenant_id', tenantId).eq('setting_key', `custom_object_reports_${objectId}`).maybeSingle());
  let saved;
  try { saved = typeof row?.setting_value === 'string' ? JSON.parse(row.setting_value) : row?.setting_value; }
  catch { fail(404, reportShareUnavailable); }
  const found = Array.isArray(saved?.reports) ? saved.reports.filter(report => report?.id === reportId) : [];
  if (found.length !== 1 || !found[0].config || typeof found[0].name !== 'string') fail(404, reportShareUnavailable);
  return found[0];
}

export function createReportSharingManager({ db, context, isAdmin, baseUrl, linkKey = process.env.SESSION_SECRET,
  executorFactory = createSharedReportExecutor }) {
  if (!context?.isAuthenticated) fail(401, 'Authentication required');
  if (!isAdmin || !context.tenantId || context.tenantMismatch) fail(403, 'Administrator access required');
  const tenantId = context.tenantId;
  const defaults = { can_manage: true, enabled: false, password_required: true, allow_csv: false, url: null };
  const state = share => {
    if (!share) return defaults;
    let url = null;
    if (share.enabled && typeof linkKey === 'string' && Buffer.byteLength(linkKey) >= 32) {
      const token = shareToken(share, linkKey);
      if (reportShareDigest(token) === share.token_hash) url = `${baseUrl}/shared-reports/${token}`;
    }
    return { ...defaults, enabled: share.enabled, password_required: share.password_required,
      allow_csv: share.allow_csv, revision: share.revision, url };
  };
  async function read(objectId, reportId) {
    return checked(await db.from('custom_object_report_share').select('*').eq('tenant_id', tenantId)
      .eq('custom_object_id', objectId).eq('report_id', reportId).maybeSingle());
  }
  return {
    async get(objectId, reportId) {
      await loadSavedCustomReport(db, tenantId, objectId, reportId);
      return state(await read(objectId, reportId));
    },
    async change(objectId, input = {}) {
      const reportId = input.report_id;
      const action = input.action || 'save';
      if (!['save', 'rotate', 'revoke', 'sync'].includes(action)) fail(400, 'Invalid sharing action');
      const report = await loadSavedCustomReport(db, tenantId, objectId, reportId);
      const existing = await read(objectId, reportId);
      if (existing && input.expected_revision !== undefined && String(input.expected_revision) !== String(existing.revision)) {
        fail(409, 'Sharing changed in another window. Reload before saving');
      }
      if (action === 'sync' && !existing) return defaults;
      for (const key of ['enabled', 'password_required', 'allow_csv']) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean') fail(400, 'Sharing settings must be true or false');
      }
      const share = { ...existing, id: existing?.id || randomUUID(), tenant_id: tenantId, custom_object_id: objectId,
        report_id: reportId, enabled: existing?.enabled ?? false,
        password_required: existing?.password_required ?? true, allow_csv: existing?.allow_csv ?? false,
        password_hash: existing?.password_hash || null, link_nonce: existing?.link_nonce || randomUUID(),
        revision: (Number(existing?.revision) || 0) + 1,
        name: report.name, definition: report.config, source_hash: reportIdentity(report),
        updated_at: new Date().toISOString(),
        updated_by: context.tenantUserId ? `tenant_user:${context.tenantUserId}` : `member:${context.memberId}`,
      };
      if (action === 'save') {
        for (const key of ['enabled', 'password_required', 'allow_csv']) if (input[key] !== undefined) share[key] = input[key];
        if (input.password) share.password_hash = await hashReportPassword(input.password);
        if (!share.password_required && (existing?.password_required !== false || (!existing.enabled && share.enabled))
          && input.acknowledge_public !== true) fail(400, 'Confirm that anyone with the link may view this report without a password');
        if (share.enabled && share.password_required && !share.password_hash) fail(400, 'Set a password before enabling sharing');
        if (share.enabled && !existing?.enabled) share.link_nonce = randomUUID();
      }
      if (action === 'revoke') share.enabled = false;
      if (['rotate', 'revoke'].includes(action)) share.link_nonce = randomUUID();
      if (share.enabled) await executorFactory({ db, tenantId, objectId, definition: report.config,
        grantId: randomUUID(), allowCsv: share.allow_csv, reauthorize: async () => {} }).validate();
      share.token_hash = share.enabled ? reportShareDigest(shareToken(share, linkKey))
        : reportShareDigest(randomBytes(32));
      const query = existing
        ? db.from('custom_object_report_share').update(share).eq('tenant_id', tenantId)
          .eq('id', existing.id).eq('revision', existing.revision)
        : db.from('custom_object_report_share').insert(share);
      const result = checked(await query.select('*').maybeSingle());
      if (!result) fail(409, 'Sharing changed in another window. Reload before saving');
      // Saved settings are also re-read by every visitor. An untrusted generic
      // SystemSettings write cannot silently expand the published definition.
      const latest = await loadSavedCustomReport(db, tenantId, objectId, reportId);
      if (reportIdentity(latest) !== share.source_hash) fail(409, 'The saved report changed. Save sharing settings again');
      return state(result);
    },
  };
}

export async function limitReportShareRequests(db, tenantId, token, req, unlocking) {
  const client = String(req.headers?.['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim().slice(0, 100);
  const scope = `${tenantId}:${reportShareDigest(token)}`;
  for (const [key, user, limit, seconds] of unlocking ? [
    [scope, client, 10, 3600], [scope, 'all-clients', 100, 3600], [`${tenantId}:all-reports`, client, 30, 3600],
  ] : [
    [scope, client, 120, 60], [scope, 'all-clients', 600, 60], [`${tenantId}:all-reports`, client, 240, 60],
  ]) {
    const result = await db.rpc('consume_sales_quote_public_rate_limit', {
      p_token_hash_hex: reportShareDigest(`custom-report-${unlocking ? 'unlock' : 'read'}:${key}`),
      p_client_key: user, p_limit: limit, p_window_seconds: seconds,
    });
    if (result.error || typeof result.data !== 'boolean') fail(503, 'Report sharing is temporarily unavailable');
    if (result.data) fail(429, 'Too many requests. Please try again later');
  }
}

export function createReportShareAccess({ db, tenantId, token, now = () => new Date() }) {
  if (typeof token !== 'string' || !/^[0-9a-f-]{36}\.[a-zA-Z0-9_-]{43}$/.test(token)) fail(404, reportShareUnavailable);
  const tokenHash = reportShareDigest(token);
  async function current() {
    const share = checked(await db.from('custom_object_report_share').select('*')
      .eq('tenant_id', tenantId).eq('token_hash', tokenHash).eq('enabled', true).maybeSingle());
    if (!share) fail(404, reportShareUnavailable);
    const report = await loadSavedCustomReport(db, tenantId, share.custom_object_id, share.report_id);
    if (reportIdentity(report) !== share.source_hash
      || reportIdentity({ id: share.report_id, name: share.name, config: share.definition }) !== share.source_hash) fail(404, reportShareUnavailable);
    return share;
  }
  async function authorize(grant) {
    const share = await current();
    if (typeof grant !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(grant)) fail(401, reportShareUnavailable);
    const row = checked(await db.from('custom_object_report_share_grant').select('id,revision,expires_at')
      .eq('tenant_id', tenantId).eq('share_id', share.id).eq('token_hash', reportShareDigest(grant)).maybeSingle());
    if (!row || String(row.revision) !== String(share.revision) || new Date(row.expires_at) <= now()) fail(401, reportShareUnavailable);
    return { share, grantId: row.id };
  }
  return {
    authorize,
    async unlock(password) {
      const share = await current();
      if (share.password_required && !(await verifyReportPassword(password, share.password_hash))) fail(401, reportShareUnavailable);
      checked(await db.rpc('custom_object_report_sort_prune', { p_tenant_id: tenantId }));
      checked(await db.rpc('custom_object_report_share_prune', { p_tenant_id: tenantId }));
      const grant = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now().getTime() + 15 * 60 * 1000).toISOString();
      checked(await db.from('custom_object_report_share_grant').insert({
        tenant_id: tenantId, share_id: share.id, revision: share.revision,
        token_hash: reportShareDigest(grant), expires_at: expiresAt,
      }));
      const access = await authorize(grant);
      return { ...access, grant, expiresAt };
    },
  };
}
