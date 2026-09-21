const BUCKETS = new Set(['public-assets', 'private-uploads']);
const PRODUCTION_ORIGIN = 'https://lvmzliemqnieeoruhkik.supabase.co';

class DeleteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function reject(message) {
  throw new DeleteError(409, message);
}

function validateTarget(bucket, path, tenantId) {
  if (!BUCKETS.has(bucket) || typeof path !== 'string'
    || !path.startsWith(`${tenantId}/`) || path.includes('%')
    || /[\\?#\u0000-\u001f]/.test(path)
    || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    reject('File storage ownership could not be verified. No file was deleted.');
  }
  return { bucket, path };
}

function urlTarget(value, tenantId, storageOrigin) {
  if (!value || typeof value !== 'string') reject('File storage URL is missing.');
  // Reject traversal before URL parsing can normalize it.
  if (value.includes('\\') || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(value)) {
    reject('Unsafe file storage URL.');
  }
  let url;
  try { url = new URL(value, 'https://repository.invalid'); } catch { reject('Invalid file storage URL.'); }
  if (url.username || url.password || url.hash) reject('Unsafe file storage URL.');
  if (url.origin === 'https://repository.invalid' && value.startsWith('/api/storage/secure-url?')
    && url.pathname === '/api/storage/secure-url') {
    if (url.searchParams.getAll('bucket').length !== 1 || url.searchParams.getAll('path').length !== 1) {
      reject('Ambiguous file storage URL.');
    }
    return validateTarget(url.searchParams.get('bucket'), url.searchParams.get('path'), tenantId);
  }
  const origins = new Set([storageOrigin]);
  // The vault alias belongs only to production, never the legacy/source project.
  if (storageOrigin === PRODUCTION_ORIGIN) origins.add('https://vault.iconn.app');
  if (!origins.has(url.origin) || url.protocol !== 'https:') reject('Untrusted file storage URL.');
  const match = url.pathname.match(/^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
  if (!match) reject('Unsupported file storage URL.');
  let path;
  try { path = decodeURIComponent(match[2]); } catch { reject('Invalid file storage path.'); }
  return validateTarget(match[1], path, tenantId);
}

export function resolveRepositoryStorageTarget(record, tenantId, storageOrigin) {
  if (!tenantId || record.tenant_id !== tenantId) reject('File tenant ownership could not be verified.');
  const fromUrl = record.file_url ? urlTarget(record.file_url, tenantId, storageOrigin) : null;
  let target = fromUrl;
  if (record.storage_path || record.bucket) {
    target = validateTarget(record.bucket, record.storage_path, tenantId);
    if (fromUrl && (fromUrl.bucket !== target.bucket || fromUrl.path !== target.path)) {
      reject('File storage metadata is ambiguous. No file was deleted.');
    }
  }
  if (!target) reject('File storage location is missing.');
  return target;
}

export async function deleteRepositoryFile({
  db, context, id, storageOrigin, hasFeatureAccess,
}) {
  try {
    if (context.tenantMismatch) throw new DeleteError(409, 'Tenant context changed. Reload this tab.');
    if (!context.isAuthenticated) throw new DeleteError(401, 'Authentication required');
    if (!context.tenantId) throw new DeleteError(403, 'Tenant context required');
    if (!context.tenantUserId && !(context.roleId && await hasFeatureAccess(
      context.roleId, 'content.files', context.memberExcludedFeatures,
    ))) throw new DeleteError(403, 'File management access required');
    const tenantId = context.tenantId;
    const { data: record, error: readError } = await db.from('file_repository')
      .select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    if (readError) throw new DeleteError(500, 'Failed to load repository file. No file was deleted.');
    // A repeated successful request is safe, without disclosing other tenants' IDs.
    if (!record) return { status: 200, body: { success: true, alreadyDeleted: true } };
    const target = resolveRepositoryStorageTarget(record, tenantId, storageOrigin);
    // Page through all tenant references; never rely on the default 1000-row limit.
    for (let offset = 0; ; offset += 500) {
      const { data: rows, error } = await db.from('file_repository').select('*')
        .eq('tenant_id', tenantId).neq('id', id).order('id').range(offset, offset + 499);
      if (error || !Array.isArray(rows)) throw new DeleteError(500, 'Failed to check shared file references.');
      for (const row of rows) {
        // Check both independent references even when the other metadata is malformed.
        const candidates = [];
        if (row.storage_path === target.path && (!row.bucket || row.bucket === target.bucket)) {
          reject('This storage object is referenced by another repository file.');
        }
        try { candidates.push(urlTarget(row.file_url, tenantId, storageOrigin)); } catch {}
        if (candidates.some(ref => ref.bucket === target.bucket && ref.path === target.path)) {
          reject('This storage object is referenced by another repository file.');
        }
      }
      if (rows.length < 500) break;
    }
    // Supabase remove is idempotent for missing objects (successful empty array).
    // Never interpret generic 404/403 provider failures as object absence.
    const { error: storageError } = await db.storage.from(target.bucket).remove([target.path]);
    if (storageError) throw new DeleteError(502, 'Storage deletion failed. The repository record was retained; please retry.');
    const { error: deleteError } = await db.from('file_repository').delete()
      .eq('tenant_id', tenantId).eq('id', id);
    if (deleteError) throw new DeleteError(500, 'Storage object removed, but repository record deletion failed. Please retry.');
    // Usage is reconciled by the existing nightly storage scan. Do not decrement
    // a client-editable claimed size, or decrement twice on partial retries.
    return { status: 200, body: { success: true } };
  } catch (error) {
    return {
      status: error.status || 500,
      body: { error: error instanceof DeleteError ? error.message : 'File deletion failed. Please retry.' },
    };
  }
}