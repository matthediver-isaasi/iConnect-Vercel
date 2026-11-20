import { supabase } from '../_lib/database.js';
import { resolveTenantFromHost, getHostFromRequest } from '../_lib/tenantResolver.js';
import { CustomObjectHttpError, createSharedReportExecutor } from '../_lib/customObjectService.js';
import { createReportShareAccess, limitReportShareRequests, reportShareUnavailable } from '../_lib/customObjectReportSharing.js';
import { privateReportHeaders } from '../_lib/reportShareHeaders.js';

const jobView = job => Object.fromEntries(['id', 'status', 'processed', 'total', 'chunk_count', 'filename']
  .filter(key => job?.[key] !== undefined).map(key => [key, job[key]]));
export function createPublicCustomReportHandler({ db = supabase,
  resolveTenant = req => resolveTenantFromHost(getHostFromRequest(req), { fresh: true }),
  limit = limitReportShareRequests, executorFactory = createSharedReportExecutor } = {}) {
  return async function handler(req, res) {
    privateReportHeaders(res);
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const body = req.body || {};
    if (!['unlock', 'check', 'preview', 'export'].includes(body.action)
      || typeof body.token !== 'string' || body.token.length > 128) return res.status(404).json({ error: reportShareUnavailable });
    try {
      if (!db) throw new Error('Database unavailable');
      const tenant = await resolveTenant(req);
      if (!tenant) return res.status(404).json({ error: reportShareUnavailable });
      await limit(db, tenant.id, body.token, req, body.action === 'unlock');
      const access = createReportShareAccess({ db, tenantId: tenant.id, token: body.token });
      const authenticated = body.action === 'unlock' ? await access.unlock(body.password) : await access.authorize(body.grant);
      const { share, grantId } = authenticated;
      const grant = authenticated.grant || body.grant;
      const engine = executorFactory({
        db, tenantId: tenant.id, objectId: share.custom_object_id, definition: share.definition,
        grantId, allowCsv: share.allow_csv, name: share.name,
        reauthorize: async () => {
          const current = await access.authorize(grant);
          if (String(current.share.revision) !== String(share.revision)) throw new CustomObjectHttpError(401, reportShareUnavailable);
        },
      });
      let payload;
      if (['unlock', 'check'].includes(body.action)) {
        await engine.validate();
        payload = { report: { name: share.name, allow_csv: share.allow_csv },
          ...(body.action === 'unlock' ? { access_grant: grant, expires_at: authenticated.expiresAt } : {}) };
      } else if (body.action === 'preview') {
        if (!['start', 'page', 'process'].includes(body.preview_action || 'start')) throw new CustomObjectHttpError(404, reportShareUnavailable);
        const result = await engine.preview({
          action: body.preview_action === 'start' ? undefined : body.preview_action,
          job_id: body.job_id, page: body.page, pageSize: body.pageSize,
        });
        payload = { sort_job: jobView(result.sort_job) };
        if (Array.isArray(result.data)) Object.assign(payload, {
          columns: result.columns.map(column => ({ label: column.label })),
          data: result.data.map((row, index) => ({ id: `row-${index}`, values: row.values })),
          total: result.total, page: result.page, pageSize: result.pageSize, has_more: result.has_more,
        });
      } else {
        if (!share.allow_csv) throw new CustomObjectHttpError(403, 'CSV download is disabled');
        if (!['start', 'status', 'process', 'chunk'].includes(body.export_action || 'start')) throw new CustomObjectHttpError(404, reportShareUnavailable);
        const result = await engine.export({ action: body.export_action || 'start',
          job_id: body.job_id, chunk_index: body.chunk_index });
        payload = body.export_action === 'chunk'
          ? { csv_text: result.csv_text } : jobView(result);
      }
      // Fence revocation, report edits and permission changes during execution,
      // including the final status request before a browser assembles its CSV.
      const latest = await access.authorize(grant);
      if (String(latest.share.revision) !== String(share.revision)) throw new CustomObjectHttpError(401, reportShareUnavailable);
      return res.status(200).json(payload);
    } catch (error) {
      const status = error instanceof CustomObjectHttpError && [400, 401, 403, 404, 409, 429].includes(error.status) ? error.status : 503;
      if (status === 429) res.setHeader('Retry-After', '60');
      return res.status(status).json({ error: status === 429 ? 'Too many requests. Please try again later.'
        : status === 409 ? 'The report changed. Refresh it to continue.'
          : status === 503 ? 'The report is temporarily unavailable. Please try again.'
            : reportShareUnavailable,
        ...(status === 401 ? { password_required: true } : {}) });
    }
  };
}
export default createPublicCustomReportHandler();
