// Defensive fallback: server-side coercion in api/forms/process-application.js
// reduces file-upload payloads to a plain URL before writing logo_url, but if
// a stringified `{file_url, storage_path, ...}` object ever slips through we
// still want a real <img src> rather than raw JSON in the DOM. Returns null
// when the value isn't a usable URL string.
export const safeLogoSrc = (raw) => {
  if (!raw) return null;
  if (typeof raw !== 'string') {
    if (typeof raw === 'object' && typeof raw.file_url === 'string') return raw.file_url;
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[object Object]') return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.includes('file_url')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.file_url === 'string') {
        return parsed.file_url;
      }
      return null;
    } catch (_) {
      return null;
    }
  }
  return trimmed;
};

export default safeLogoSrc;
