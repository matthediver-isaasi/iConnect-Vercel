function usableString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url, 'https://local.invalid');
    const segment = parsed.pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return url.split(/[/?#]/).filter(Boolean).pop() || null;
  }
}

function usableFileUrl(value) {
  const url = usableString(value);
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function normalizeCustomFieldFileValue(value) {
  if (value == null || value === '') {
    return { status: 'empty', file: null };
  }

  let parsed = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { status: 'empty', file: null };
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return { status: 'unavailable', file: null };
      }
    } else {
      parsed = { file_url: trimmed };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unavailable', file: null };
  }

  const storagePath = usableString(parsed.storage_path || parsed.path);
  const bucket = usableString(parsed.bucket) || 'private-uploads';
  let fileUrl = usableFileUrl(parsed.file_url || parsed.url);
  const isPrivate = parsed.is_private === true || parsed.isPrivate === true;

  if (!fileUrl && storagePath && isPrivate) {
    const params = new URLSearchParams({ bucket, path: storagePath });
    fileUrl = `/api/storage/secure-url?${params.toString()}`;
  }

  if (!fileUrl) return { status: 'unavailable', file: null };

  const size = Number(parsed.file_size ?? parsed.size);
  return {
    status: 'ready',
    file: {
      file_url: fileUrl,
      file_name: usableString(parsed.file_name || parsed.name) || filenameFromUrl(fileUrl) || 'Uploaded file',
      file_size: Number.isFinite(size) && size >= 0 ? size : null,
      mime_type: usableString(parsed.mime_type || parsed.type),
      storage_path: storagePath,
      bucket,
      is_private: isPrivate,
    },
  };
}

export function formatCustomFieldFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}