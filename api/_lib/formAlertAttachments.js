// A persisted URL alone does not prove ownership. Legacy form-/tenant-wide
// uploads stay unavailable; only exact submission-prefixed private objects
// can be downloaded through a submission capability.
export function scopedFormAlertAttachment(value, tenantId, submissionId) {
  let input = value;
  if (typeof input === 'string' && input.trim().startsWith('{')) {
    try { input = JSON.parse(input); } catch { return null; }
  }
  let path = input?.storage_path || input?.path;
  let bucket = input?.bucket;
  const url = typeof input === 'string' ? input : input?.file_url || input?.url;
  if (!path && typeof url === 'string' && url.startsWith('/api/storage/secure-url?')) {
    const parsed = new URL(url, 'https://internal.invalid');
    path = parsed.searchParams.get('path');
    bucket = parsed.searchParams.get('bucket');
  }
  if (bucket !== 'private-uploads' || typeof path !== 'string'
    || !path.startsWith(`${tenantId}/form-submissions/${submissionId}/`)
    || path.includes('..') || /[%\\\0\r\n?#]/.test(path)
    || path.split('/').length !== 4 || !path.split('/')[3]) return null;
  return { bucket, path, name: String(input?.file_name || input?.name || 'attachment')
    .replace(/[\r\n"\\/\0]/g, '_').slice(0,150) };
}
