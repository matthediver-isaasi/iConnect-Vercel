import { randomBytes } from 'node:crypto';
import { supabase } from './database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from './tenantContext.js';
import { resolveTrustedSchemaCapabilities } from './customObjectSchemaAccess.js';
import { createReportSharingManager, loadSavedCustomReport, reportIdentity, reportShareDigest } from './customObjectReportSharing.js';
import { createSharedReportExecutor, CustomObjectHttpError } from './customObjectService.js';
import { privateReportHeaders } from './reportShareHeaders.js';

const unavailable = 'Report unavailable or you do not have permission to view it.';
const fail = (status, message = unavailable) => { throw new CustomObjectHttpError(status, message); };
const check = result => {
  if (result.error) fail(result.error.code === 'PT409' ? 409 : 503, 'Report permissions could not be read or saved. Reload and try again.');
  return result.data;
};
const urlFor = (objectId, reportId) => `/internal-reports/${encodeURIComponent(objectId)}/${encodeURIComponent(reportId)}`;
const actorKey = context => context.tenantUserId ? `tenant_user:${context.tenantUserId}` : `member:${context.memberId}`;
const jobView = job => Object.fromEntries(['id', 'status', 'processed', 'total', 'chunk_count', 'filename']
  .filter(key => job?.[key] !== undefined).map(key => [key, job[key]]));
async function scan(makeQuery, key = 'id') {
  const result = [];
  for (let offset = 0; offset < 10000; offset += 200) {
    const rows = check(await makeQuery().order(key).range(offset, offset + 199)) || [];
    result.push(...rows);
    if (rows.length < 200) return result;
  }
  fail(503, 'The report catalogue exceeds the supported size.');
}

export function createInternalReportService({ db, context, canManageLinks = false, canManageRoles = false,
  executorFactory = createSharedReportExecutor, now = () => new Date() }) {
  if (!context?.isAuthenticated || !context.tenantId || (!context.memberId && !context.tenantUserId)) fail(401, 'Sign in to view this report.');
  if (context.tenantMismatch || (context.tenantFromHost?.id && context.tenantFromHost.id !== context.tenantId)) fail(403);
  const tenantId = context.tenantId;
  const shareQuery = () => db.from('custom_object_report_share').select('*').eq('tenant_id', tenantId);
  async function role() {
    if (context.tenantUserId) return { admin: true, id: null };
    // Re-read the authenticated subject, not a client-supplied or captured role.
    // This also fences a role change or disabled login during report execution.
    const member = check(await db.from('member').select('role_id,tenant_id,login_enabled')
      .eq('id', context.memberId).maybeSingle());
    if (!member?.role_id || member.login_enabled === false || (member.tenant_id && member.tenant_id !== tenantId)) fail(403);
    const row = check(await db.from('role').select('id,is_tenant_admin').eq('tenant_id', tenantId).eq('id', member.role_id).maybeSingle());
    if (!row) fail(403);
    return { id: row.id, admin: row.is_tenant_admin === true };
  }
  async function current(objectId, reportId) {
    const identity = await role();
    const share = check(await shareQuery().eq('custom_object_id', objectId).eq('report_id', reportId).maybeSingle());
    if (!share) fail(404);
    const permission = identity.admin ? { can_view: true, can_download: true, revision: 0 }
      : check(await db.from('custom_object_report_role_access').select('*')
        .eq('tenant_id', tenantId).eq('share_id', share.id).eq('role_id', identity.id).maybeSingle());
    if (!permission?.can_view) fail(403);
    const report = await loadSavedCustomReport(db, tenantId, objectId, reportId);
    if (reportIdentity(report) !== share.source_hash
      || reportIdentity({ id: share.report_id, name: share.name, config: share.definition }) !== share.source_hash) fail(404);
    return { share, permission, identity };
  }
  async function authorize(objectId, reportId, grant) {
    const access = await current(objectId, reportId);
    if (typeof grant !== 'string' || !/^[\w-]{43}$/.test(grant)) fail(409, 'Report access expired. Open the report again.');
    const row = check(await db.from('custom_object_report_share_grant').select('*')
      .eq('tenant_id', tenantId).eq('share_id', access.share.id).eq('channel', 'internal')
      .eq('actor_key', actorKey(context)).eq('token_hash', reportShareDigest(grant)).maybeSingle());
    if (!row || row.role_id !== access.identity.id || String(row.revision) !== String(access.share.internal_revision)
      || String(row.permission_revision) !== String(access.permission.revision)
      || new Date(row.expires_at) <= now()) fail(409, 'Report access expired or changed. Open the report again.');
    return { ...access, grantId: row.id };
  }
  async function publisher(objectId, reportId) {
    if (!canManageLinks && !canManageRoles) fail(403);
    const manager = createReportSharingManager({ db, context, isAdmin: true, baseUrl: '', executorFactory });
    await manager.change(objectId, { report_id: reportId, action: 'internal-publish' });
    return check(await shareQuery().eq('custom_object_id', objectId).eq('report_id', reportId).maybeSingle());
  }
  return {
    authorize,
    async link(objectId, reportId, publish = false) {
      if (!canManageLinks) fail(403);
      const report = await loadSavedCustomReport(db, tenantId, objectId, reportId);
      const row = publish ? await publisher(objectId, reportId)
        : check(await shareQuery().eq('custom_object_id', objectId).eq('report_id', reportId).maybeSingle());
      return { url: urlFor(objectId, reportId), ready: Boolean(row && row.source_hash === reportIdentity(report)) };
    },
    async rolePermissions(roleId) {
      if (!canManageRoles) fail(403);
      const target = check(await db.from('role').select('id').eq('tenant_id', tenantId).eq('id', roleId).maybeSingle());
      if (!target) fail(404);
      const settings = await scan(() => db.from('system_settings').select('id,setting_key,setting_value')
        .eq('tenant_id', tenantId).like('setting_key', 'custom_object_reports_%'));
      const objects = await scan(() => db.from('custom_object_definition').select('id,plural_label,status').eq('tenant_id', tenantId).eq('status', 'active'));
      const shares = await scan(shareQuery);
      // This table's stable scan key is share_id, not a fabricated row id.
      const permissions = await scan(() => db.from('custom_object_report_role_access').select('*').eq('tenant_id', tenantId)
        .eq('role_id', roleId), 'share_id');
      const reports = [];
      const active = new Map(objects.map(object => [object.id, object]));
      for (const setting of settings) {
        if (!setting.setting_key.startsWith('custom_object_reports_')) continue;
        const objectId = setting.setting_key.slice('custom_object_reports_'.length), object = active.get(objectId);
        if (!object) continue;
        let value;
        try { value = typeof setting.setting_value === 'string' ? JSON.parse(setting.setting_value) : setting.setting_value; } catch { continue; }
        if (!Array.isArray(value?.reports)) continue;
        for (const report of value.reports) {
          if (typeof report?.id !== 'string' || typeof report.name !== 'string' || !report.config
            || value.reports.filter(item => item?.id === report.id).length !== 1) continue;
          const share = shares.find(row => row.custom_object_id === objectId && row.report_id === report.id);
          const permission = permissions.find(row => row.share_id === share?.id);
          reports.push({ object_id: objectId, report_id: report.id, name: report.name, object_name: object.plural_label,
            url: urlFor(objectId, report.id), published: Boolean(share && share.source_hash === reportIdentity(report)),
            can_view: permission?.can_view === true, can_download: permission?.can_download === true,
            revision: permission?.revision || 0 });
          if (reports.length > 10000) fail(503);
        }
      }
      return { reports };
    },
    async setRolePermissions(roleId, changes) {
      if (!canManageRoles) fail(403);
      if (!Array.isArray(changes) || changes.length > 100) fail(400, 'Change up to 100 report permissions at once.');
      const target = check(await db.from('role').select('id').eq('tenant_id', tenantId).eq('id', roleId).maybeSingle());
      if (!target) fail(404);
      const writes = [], seen = new Set();
      // Validate all supplied changes before creating any trusted publications.
      for (const item of changes) {
        if (!item || typeof item.can_view !== 'boolean' || typeof item.can_download !== 'boolean'
          || (item.can_download && !item.can_view) || !Number.isSafeInteger(item.expected_revision)
          || item.expected_revision === null || item.expected_revision === undefined || Number(item.expected_revision) < 0) fail(400, 'Invalid report permission.');
        const key = `${item.object_id}:${item.report_id}`;
        if (seen.has(key)) fail(400, 'Duplicate report permission.');
        seen.add(key);
        const saved = await loadSavedCustomReport(db, tenantId, item.object_id, item.report_id);
        const existing = check(await shareQuery().eq('custom_object_id', item.object_id).eq('report_id', item.report_id).maybeSingle());
        if (existing && existing.source_hash !== reportIdentity(saved)) fail(409, 'Save this report in Data Studio before changing its role access.');
      }
      for (const item of changes) {
        const share = await publisher(item.object_id, item.report_id);
        writes.push({ share_id: share.id, can_view: item.can_view, can_download: item.can_download,
          expected_revision: Number(item.expected_revision) });
      }
      check(await db.rpc('set_internal_report_role_access', { p_tenant_id: tenantId, p_role_id: roleId,
        p_changes: writes, p_actor: actorKey(context) }));
      return { ok: true };
    },
    async catalog() {
      // Only trusted, published reports are candidates. Every row is authorized
      // again, so a missing role, removed report, or generic settings edit hides it.
      const reports = [], objectNames = new Map();
      const identity = await role(), candidates = [];
      if (identity.admin) candidates.push(...await scan(shareQuery));
      else {
        const allowed = await scan(() => db.from('custom_object_report_role_access').select('share_id')
          .eq('tenant_id', tenantId).eq('role_id', identity.id).eq('can_view', true), 'share_id');
        for (let offset = 0; offset < allowed.length; offset += 100) {
          candidates.push(...await scan(() => shareQuery().in('id', allowed.slice(offset, offset + 100).map(row => row.share_id))));
        }
      }
      for (const share of candidates) {
        try {
          const access = await current(share.custom_object_id, share.report_id);
          if (!objectNames.has(share.custom_object_id)) {
            const object = check(await db.from('custom_object_definition').select('plural_label').eq('tenant_id', tenantId)
              .eq('id', share.custom_object_id).maybeSingle());
            objectNames.set(share.custom_object_id, object?.plural_label || 'Report');
          }
          reports.push({ object_id: share.custom_object_id, report_id: share.report_id, name: share.name,
            object_name: objectNames.get(share.custom_object_id), url: urlFor(share.custom_object_id, share.report_id),
            can_download: access.permission.can_download });
        } catch (error) { if (![403, 404].includes(error.status)) throw error; }
      }
      return { reports };
    },
    async view(body = {}) {
      const objectId = body.object_id, reportId = body.report_id;
      if (!['unlock', 'check', 'preview', 'export'].includes(body.action)) fail(404);
      let grant = body.grant, expiresAt;
      if (body.action === 'unlock') {
        const access = await current(objectId, reportId);
        check(await db.rpc('custom_object_report_sort_prune', { p_tenant_id: tenantId }));
        check(await db.rpc('custom_object_report_share_prune', { p_tenant_id: tenantId }));
        grant = randomBytes(32).toString('base64url');
        expiresAt = new Date(now().getTime() + 15 * 60 * 1000).toISOString();
        check(await db.from('custom_object_report_share_grant').insert({
          tenant_id: tenantId, share_id: access.share.id, revision: access.share.internal_revision,
          channel: 'internal', actor_key: actorKey(context), role_id: access.identity.id,
          permission_revision: access.permission.revision, token_hash: reportShareDigest(grant), expires_at: expiresAt,
        }));
      }
      const access = await authorize(objectId, reportId, grant);
      const reauthorize = async () => {
        const latest = await authorize(objectId, reportId, grant);
        if (body.action === 'export' && !latest.permission.can_download) fail(403);
      };
      const engine = executorFactory({ db, tenantId, objectId, definition: access.share.definition, grantId: access.grantId,
        allowCsv: access.permission.can_download, name: access.share.name, reauthorize });
      let payload;
      if (['unlock', 'check'].includes(body.action)) {
        await engine.validate();
        payload = { report: { name: access.share.name, allow_csv: access.permission.can_download },
          ...(expiresAt ? { access_grant: grant, expires_at: expiresAt } : {}) };
      } else if (body.action === 'preview') {
        if (!['start', 'page', 'process'].includes(body.preview_action || 'start')) fail(404);
        const result = await engine.preview({ action: body.preview_action === 'start' ? undefined : body.preview_action,
          job_id: body.job_id, page: body.page, pageSize: body.pageSize });
        payload = { sort_job: jobView(result.sort_job) };
        if (Array.isArray(result.data)) Object.assign(payload, {
          columns: result.columns.map(column => ({ label: column.label })),
          data: result.data.map((row, index) => ({ id: `row-${index}`, values: row.values })),
          total: result.total, page: result.page, pageSize: result.pageSize, has_more: result.has_more,
        });
      } else {
        if (!access.permission.can_download) fail(403);
        if (!['start', 'status', 'process', 'chunk'].includes(body.export_action || 'start')) fail(404);
        const result = await engine.export({ action: body.export_action || 'start', job_id: body.job_id, chunk_index: body.chunk_index });
        payload = body.export_action === 'chunk' ? { csv_text: result.csv_text } : jobView(result);
      }
      await reauthorize();
      return payload;
    },
  };
}

export function createInternalReportHandler({ db = supabase, getContext = getTenantContext, adminCheck = hasAdminAccess,
  featureCheck = hasFeatureAccess, schemaCheck = resolveTrustedSchemaCapabilities, executorFactory } = {}) {
  return async (req, res) => {
    privateReportHeaders(res);
    try {
      const resource = req.query?.resource;
      const methods = { catalog: ['GET'], permissions: ['GET', 'POST'], link: ['GET', 'POST'], view: ['POST'] }[resource];
      if (!methods) fail(404);
      if (!methods.includes(req.method)) { res.setHeader('Allow', methods); return res.status(405).json({ error: 'Method not allowed' }); }
      const context = await getContext(req);
      if (!context?.isAuthenticated) fail(401, 'Sign in to view this report.');
      let canManageRoles = false, canManageLinks = false;
      if (['permissions', 'link'].includes(resource)) {
        if (!(await adminCheck(context))) fail(403);
        const allowed = resource === 'permissions' ? context.tenantUserId
          || await featureCheck(context.roleId, 'admin.role-management', context.memberExcludedFeatures)
          : (await schemaCheck(context, { hasFeatureAccess: featureCheck })).canManageSchema;
        if (!allowed) fail(403);
        canManageRoles = resource === 'permissions';
        canManageLinks = resource === 'link';
      }
      const service = createInternalReportService({ db, context, canManageRoles, canManageLinks, executorFactory });
      const data = req.method === 'POST' ? req.body || {} : req.query || {};
      const result = resource === 'catalog' ? await service.catalog()
        : resource === 'view' ? await service.view(data)
          : resource === 'link' ? await service.link(data.object_id, data.report_id, req.method === 'POST')
            : req.method === 'GET' ? await service.rolePermissions(data.role_id) : await service.setRolePermissions(data.role_id, data.changes);
      return res.status(200).json(result);
    } catch (error) {
      const status = error instanceof CustomObjectHttpError && [400, 401, 403, 404, 409].includes(error.status) ? error.status : 503;
      return res.status(status).json({ error: status === 401 ? 'Sign in to view this report.'
        : status === 403 || status === 404 ? unavailable
          : status === 503 ? 'Reports are temporarily unavailable. Please try again.' : error.message });
    }
  };
}
