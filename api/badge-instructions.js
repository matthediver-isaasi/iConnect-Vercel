import { supabase } from './_lib/database.js';
import { getTenantContext, hasAdminAccess } from './_lib/tenantContext.js';
import { createBadgeInstructionsService, publicConfig, failure, HELP_PATH } from './_lib/badgeInstructions.js';

export const config = { api: { bodyParser: { sizeLimit: '3mb' } } };

export function createHandler({ db = supabase, contextFor = getTenantContext, adminFor = hasAdminAccess,
  service = db && createBadgeInstructionsService(db) } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Vary', 'Cookie, X-Tenant-Id');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const delivering = req.method === 'GET' && req.query?.document === 'true';
    try {
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
        throw failure(405, 'Method not allowed.');
      }
      const context = await contextFor(req);
      if (!context?.isAuthenticated || !context.tenantId) throw failure(401, 'Sign in to view your tenant instructions.');
      if (context.tenantMismatch) {
        throw failure(403, 'Your active tenant has changed. Return to your profile and reload before trying again.');
      }
      const expectedTenant = req.query?.tenantId;
      if ((delivering && !expectedTenant) || (expectedTenant && expectedTenant !== context.tenantId)) {
        throw failure(403, 'These instructions belong to a different tenant. Return to your profile and try again.');
      }
      if (!service) throw failure(503, 'Instructions are temporarily unavailable.');
      const tenantId = context.tenantId;
      const canManage = await adminFor(context);
      if (req.method === 'GET') {
        const current = await service.read(tenantId);
        if (!delivering) return res.status(200).json(publicConfig(tenantId, current, canManage));
        if (current.mode !== 'pdf' && !canManage) throw failure(404, 'Your tenant currently uses the standard help page.');
        const bytes = await service.document(tenantId, current);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', String(bytes.length));
        res.setHeader('Content-Disposition', `inline; filename="badge-sharing-instructions.pdf"; filename*=UTF-8''${encodeURIComponent(current.document.filename)}`);
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        return res.status(200).send(bytes);
      }
      if (!canManage) throw failure(403, 'Administrator access is required to manage instructions.');
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || !Object.hasOwn(body, 'revision') || (body.revision !== null && typeof body.revision !== 'string')) {
        throw failure(400, 'A revision is required. Reload settings and try again.');
      }
      let next;
      if (req.method === 'POST') {
        if (body.action !== 'upload') throw failure(400, 'Use the upload action.');
        next = await service.upload(tenantId, body.revision, body);
      } else if (req.method === 'PATCH') {
        if (!['standard', 'pdf'].includes(body.mode)) throw failure(400, 'Choose standard or pdf mode.');
        if (body.mode === 'pdf') {
          // Verify the retained file still exists and is readable before use.
          const current = await service.read(tenantId);
          await service.document(tenantId, current);
        }
        next = await service.mutate(tenantId, 'mode', { p_revision: body.revision, p_mode: body.mode });
      } else {
        if (body.confirm !== true) throw failure(400, 'Confirm permanent deletion before deleting the PDF.');
        next = await service.deleteDocument(tenantId, body.revision);
      }
      const warning = await service.cleanup(tenantId);
      return res.status(200).json({ ...publicConfig(tenantId, next, canManage), ...(warning ? { warning } : {}) });
    } catch (error) {
      const status = error.safe ? error.status : 503;
      const message = error.safe ? error.message : 'Instructions are temporarily unavailable. Please retry.';
      if (delivering) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        const escaped = message.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        return res.status(status).send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Badge instructions unavailable</title><h1>Badge instructions unavailable</h1><p>${escaped}</p><p><a href="${HELP_PATH}">Read the standard badge-sharing help</a></p></html>`);
      }
      return res.status(status).json({ error: message, ...(error.warning ? { warning: error.warning } : {}) });
    }
  };
}

export default createHandler();
