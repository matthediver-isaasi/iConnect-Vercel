import { adminFetch } from '@/lib/adminFetch';
import { readAwardAttachment, validateEvidenceReview } from '@/lib/awardEvidenceReader';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function evidenceScope({ tenant, roundId, applicationId, versionId, access }) {
  if (![roundId, applicationId].every(uuid) || (versionId !== undefined && !uuid(versionId))) throw new Error('The moderation evidence source is invalid.');
  const assertCurrent = () => {
    tenant.assertCurrent();
    access.assertCurrent();
    if (!access.canModerate && !access.canApprove) throw Object.assign(new Error('Moderation or approval permission is required to view application evidence.'), { status: 403 });
  };
  assertCurrent();
  const params = new URLSearchParams({ roundId, applicationId });
  if (versionId) params.set('versionId', versionId);
  return { assertCurrent, params };
}

export async function adminEvidenceReview(options, { signal } = {}) {
  const { assertCurrent, params } = evidenceScope(options);
  params.set('scope', 'review');
  const response = await adminFetch(`/api/awards/assessment-history?${params}`, {
    signal, cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
  }, options.tenant.tenantId);
  try {
    assertCurrent();
    if (!response.ok) throw Object.assign(new Error(`Application evidence access failed (${response.status}). Recheck current moderation/approval permission.`), { status: response.status });
    if (response.redirected || response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new Error('Application evidence JSON was not returned.');
    const data = validateEvidenceReview(await response.json());
    assertCurrent();
    if (options.versionId && data.applicationVersionId !== options.versionId) throw new Error('The returned evidence does not match the requested historical version. No alternative version is displayed.');
    return data;
  } finally { try { await response.body?.cancel(); } catch { /* Drop failed/revoked responses. */ } }
}

export function adminEvidenceAttachment(options, attachmentId, { signal } = {}) {
  if (!uuid(attachmentId)) throw new Error('The immutable attachment reference is invalid.');
  const { assertCurrent, params } = evidenceScope(options);
  params.set('scope', 'attachment'); params.set('attachmentId', attachmentId);
  return readAwardAttachment({ signal, assertCurrent, requestChunk: async (offset, chunkSignal, consume) => {
    assertCurrent(); params.set('offset', String(offset));
    const response = await adminFetch(`/api/awards/assessment-history?${params}`, {
      signal: chunkSignal, cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/octet-stream' },
    }, options.tenant.tenantId);
    return consume(response);
  } });
}
