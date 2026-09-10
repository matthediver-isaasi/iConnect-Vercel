import { supabase } from '../_lib/database.js';
import {
  getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
} from '../_lib/tenantContext.js';
import {
  createCustomObjectDirectory,
  CustomObjectDirectoryError,
  isDirectoryObjectFilePath,
  parseCustomObjectDirectorySourceKey,
} from '../_lib/customObjectDirectory.js';

function attachmentName(value) {
  const name = String(value || 'file')
    .replace(/[\r\n"]/g, '')
    .split(/[\\/]/).pop()
    .slice(0, 255) || 'file';
  return `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"`;
}

export function createHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const featureCheck = dependencies.hasFeatureAccess || hasFeatureAccess;
  const adminCheck = dependencies.hasAdminAccess || hasAdminAccess;
  const settingsCheck = dependencies.settingsCheck || (async () => false);
  const serviceFactory = dependencies.createCustomObjectDirectory || createCustomObjectDirectory;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      const context = await getContext(req);
      if (context?.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
      if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
      if (!context?.tenantId) return res.status(400).json({ error: 'Tenant context not found' });
      const referer = String(req.headers?.referer || req.headers?.referrer || '');
      if (req.query.embed === 'true' || req.headers?.['x-embed-context'] === 'true'
        || /\/embed(?:\/|[?#]|$)/i.test(referer)) {
        return res.status(403).json({ error: 'Embed access denied' });
      }

      const isAdmin = await adminCheck(context);
      const service = serviceFactory({
        db, context, featureCheck, settingsCheck, isAdmin,
      });
      const file = await service.file({
        directoryId: req.query.directory_id || 'main',
        organizationId: req.query.organization_id,
        sourceKey: req.query.source_key,
        recordId: req.query.record_id,
        fileIndex: req.query.file_index || 0,
      });
      const parsedSource = parseCustomObjectDirectorySourceKey(req.query.source_key);
      if (!parsedSource
        || file.bucket !== 'private-uploads'
        || !isDirectoryObjectFilePath(
          file.storage_path,
          context.tenantId,
          parsedSource.objectId,
          parsedSource.fieldId,
        )) {
        throw new CustomObjectDirectoryError(404, 'File not found');
      }
      const { data, error } = await db.storage.from(file.bucket).download(file.storage_path);
      if (error || !data) throw new CustomObjectDirectoryError(404, 'File not found');
      const buffer = Buffer.from(await data.arrayBuffer());
      const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(file.mime_type || '')
        ? file.mime_type : 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Content-Disposition', attachmentName(file.file_name));
      return res.status(200).send(buffer);
    } catch (error) {
      const status = error instanceof CustomObjectDirectoryError ? error.status : 500;
      return res.status(status).json({
        error: status === 500 ? 'Failed to download Custom Object file' : error.message,
      });
    }
  };
}

export default createHandler();