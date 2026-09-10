import { randomUUID } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  coerceCustomObjectFieldValue,
  resolveCustomObjectFieldAccess,
  resolveCustomObjectPermission,
} from '../_lib/customObjectDomain.js';
import { checkStorageQuota } from '../_lib/planQuota.js';
import { addTenantStorageBytes } from '../_lib/tenantStorageUsage.js';

const BUCKET = 'private-uploads';
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export function sanitizeCustomObjectUploadFileName(value) {
  const baseName = String(value || '').split(/[\\/]/).at(-1);
  return baseName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(0, 200);
}

function jsonError(res, status, error, message = error) {
  return res.status(status).json({ error, message });
}

async function maybeOne(query) {
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

export function createCustomObjectUploadUrlHandler({
  db,
  getContext = getTenantContext,
  quotaCheck = checkStorageQuota,
  addStorageBytes = addTenantStorageBytes,
  adminCheck = hasAdminAccess,
  uuid = randomUUID,
} = {}) {
  return async function customObjectUploadUrlHandler(req, res) {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return jsonError(res, 405, 'Method not allowed');
    if (!db) return jsonError(res, 503, 'Storage service not configured');

    try {
      const context = await getContext(req);
      if (!context?.isAuthenticated || !context.tenantId) {
        return jsonError(res, 401, 'Authentication required', 'You must be logged in to upload files');
      }
      if (context.tenantMismatch) {
        return jsonError(res, 409, 'Tenant context mismatch');
      }
      const {
        customObjectId,
        fieldId,
        fileName,
        fileSize,
        mimeType,
      } = req.body || {};
      if (!customObjectId || !fieldId) {
        return jsonError(res, 400, 'customObjectId and fieldId are required');
      }
      const sanitizedFileName = sanitizeCustomObjectUploadFileName(fileName);
      if (!sanitizedFileName) return jsonError(res, 400, 'fileName is required');
      if (!Number.isFinite(fileSize) || fileSize <= 0) {
        return jsonError(res, 400, 'fileSize is required and must be a positive number');
      }
      if (fileSize > MAX_FILE_SIZE) {
        return res.status(400).json({
          error: 'File size exceeds maximum allowed size of 50MB',
          maxSize: MAX_FILE_SIZE,
          providedSize: fileSize,
        });
      }
      if (mimeType !== undefined && typeof mimeType !== 'string') {
        return jsonError(res, 400, 'mimeType must be a string');
      }

      const definition = await maybeOne(db.from('custom_object_definition').select('id, tenant_id, status')
        .eq('tenant_id', context.tenantId).eq('id', customObjectId)
        .eq('status', 'active').is('archived_at', null));
      if (!definition) return jsonError(res, 404, 'Custom Object not found');

      const field = await maybeOne(db.from('preference_field').select('*')
        .eq('tenant_id', context.tenantId).eq('id', fieldId)
        .eq('custom_object_id', customObjectId).eq('entity_scope', 'custom_object')
        .eq('field_type', 'file').eq('is_active', true));
      if (!field) return jsonError(res, 404, 'Custom Object field not found');

      const isTenantAdmin = Boolean(await adminCheck(context));
      let objectPermission = null;
      let fieldPermission = null;
      if (!isTenantAdmin) {
        if (!context.roleId) return jsonError(res, 403, 'Custom Object write access required');
        [objectPermission, fieldPermission] = await Promise.all([
          maybeOne(db.from('custom_object_role_permission').select('*')
            .eq('tenant_id', context.tenantId).eq('custom_object_id', customObjectId)
            .eq('role_id', context.roleId)),
          maybeOne(db.from('custom_object_field_role_permission').select('*')
            .eq('tenant_id', context.tenantId).eq('custom_object_id', customObjectId)
            .eq('field_id', fieldId).eq('role_id', context.roleId)),
        ]);
      }
      const canWriteObject = ['create_records', 'edit_records'].some((capability) =>
        resolveCustomObjectPermission({
          permission: objectPermission,
          capability,
          isTenantAdmin,
        }));
      const fieldAccess = resolveCustomObjectFieldAccess({
        permission: fieldPermission,
        isTenantAdmin,
      });
      if (!canWriteObject || fieldAccess !== 'edit') {
        return jsonError(res, 403, 'Custom Object field edit access required');
      }

      const fileValidation = coerceCustomObjectFieldValue({ name: sanitizedFileName }, field);
      if (!fileValidation.ok) {
        return jsonError(res, 400, 'File type is not allowed for this field', fileValidation.error);
      }
      const storageCheck = await quotaCheck(context.tenantId, { fileSizeBytes: fileSize });
      if (!storageCheck.ok) return res.status(storageCheck.status).json(storageCheck.body);

      const storagePath = `${context.tenantId}/custom-object-files/${definition.id}/${field.id}/${uuid()}-${sanitizedFileName}`;
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(storagePath);
      if (error || !data?.signedUrl) {
        return jsonError(res, 500, 'Failed to generate upload URL');
      }
      Promise.resolve(addStorageBytes(context.tenantId, fileSize)).catch(() => {});
      return res.json({
        success: true,
        signedUrl: data.signedUrl,
        ...(data.token ? { token: data.token } : {}),
        fileUrl: `/api/storage/secure-url?bucket=${BUCKET}&path=${encodeURIComponent(storagePath)}&redirect=true`,
        path: storagePath,
        bucket: BUCKET,
        isPrivate: true,
        expiresIn: 3600,
      });
    } catch (error) {
      console.error('[CustomObjectUpload] Failed to generate upload URL:', error);
      return jsonError(res, 500, 'Failed to generate upload URL');
    }
  };
}

export default createCustomObjectUploadUrlHandler({ db: supabase });