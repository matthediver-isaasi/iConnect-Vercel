const MAX_FILE = 25 * 1024 * 1024;
const MAX_CHUNK = 1024 * 1024;

// No retries, storage URLs or partial-file results. Every request must retain
// the caller's authority, including while reading bytes and hashing the file.
export async function readAwardAttachment({ requestChunk, assertCurrent, signal }) {
  const check = () => {
    if (signal?.aborted) throw new DOMException('Attachment download cancelled.', 'AbortError');
    assertCurrent();
  };
  let bytes;
  try {
    check();
    if (!globalThis.crypto?.subtle) throw new Error('This browser cannot verify attachment integrity. Use a secure browser context.');
    let offset = 0, total, digest;
    while (total === undefined || offset < total) {
      check();
      const before = offset;
      await requestChunk(offset, signal, async response => {
        try {
          check();
          const range = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/([1-9]\d*)$/.exec(response.headers.get('Content-Range') || '');
          const hash = response.headers.get('X-Awards-File-Sha256') || '';
          const start = Number(range?.[1]), end = Number(range?.[2]), size = Number(range?.[3]);
          const valid = response.status === 206
            && response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/octet-stream'
            && range && [start, end, size].every(Number.isSafeInteger)
            && start === offset && end >= start && end < size && end - start + 1 <= MAX_CHUNK
            && size <= MAX_FILE && /^[a-f0-9]{64}$/.test(hash)
            && (total === undefined || (size === total && hash === digest));
          if (!valid) throw Object.assign(new Error('The attachment response was unavailable or inconsistent. All partial bytes were discarded; no file was downloaded.'), { status: response.status });
          if (total === undefined) { total = size; digest = hash; bytes = new Uint8Array(total); }
          const reader = response.body?.getReader();
          if (!reader) throw new Error('This browser cannot safely read the attachment stream.');
          let received = 0;
          try {
            while (true) {
              check();
              const part = await reader.read();
              check();
              if (part.done) break;
              if (!part.value?.byteLength || received + part.value.byteLength > end - start + 1) throw new Error('The attachment chunk length was inconsistent.');
              bytes.set(part.value, start + received); received += part.value.byteLength;
            }
          } finally {
            try { await reader.cancel(); } catch { /* Drop unread/failed response bytes. */ }
            reader.releaseLock();
          }
          if (received !== end - start + 1) throw new Error('The attachment chunk was incomplete.');
          offset = end + 1;
        } finally {
          try { await response.body?.cancel(); } catch { /* Discard any unread response. */ }
        }
      });
      if (offset <= before) throw new Error('The attachment reader did not receive a contiguous chunk.');
    }
    check();
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    check();
    if (actual !== digest) throw new Error('Attachment integrity verification failed. No file was downloaded.');
    const result = new Blob([bytes], { type: 'application/octet-stream' });
    bytes.fill(0); bytes = null;
    return result;
  } catch (error) {
    bytes?.fill(0); bytes = null;
    throw error;
  }
}

export function validateEvidenceReview(value) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const review = value?.review;
  if (!uuid.test(value?.applicationVersionId || '') || !Array.isArray(review?.fields) || !Array.isArray(review?.attachments)
    || review.fields.some(field => !field || typeof field.id !== 'string' || typeof field.label !== 'string' || typeof field.type !== 'string')
    || review.attachments.some(file => !uuid.test(file?.id || '') || typeof file.name !== 'string')
    || new Set(review.fields.map(field => field.id)).size !== review.fields.length
    || new Set(review.attachments.map(file => file.id)).size !== review.attachments.length) {
    throw new Error('The immutable evidence projection was incomplete. No partial evidence is shown.');
  }
  return value;
}
