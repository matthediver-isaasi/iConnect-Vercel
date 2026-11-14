import { bindExternalAwardApplicantTenant, externalAwardApplicantResponse } from '@/lib/externalAwardApplicantAccess';
import { validatedPdf } from '@/lib/awardCertificatePdf';
import { applicantUuid, validateApplicantResponse } from './useAwardApplications';
import { readAwardAttachment, validateEvidenceReview } from '@/lib/awardEvidenceReader';

export async function externalApplicantRequest(authority, tenantSlug, options = {}) {
  authority.assertCurrent();
  if (!authority.externalApplicant || tenantSlug !== authority.tenantSlug || (options.applicationId && options.applicationId.toLowerCase() !== authority.applicationId)) throw new Error('The secure applicant scope does not match this request.');
  return externalAwardApplicantResponse(authority, options, async (response, assertCurrent) => {
    if (options.issueId && response.ok) {
      const blob = await validatedPdf(response); assertCurrent(); return blob;
    }
    let result;
    try { result = await response.json(); } catch { throw new Error(options.payload
      ? 'The secure application change response could not be read. A change may have committed; no automatic retry was made.'
      : 'The secure application response could not be read. No partial evidence is shown. Retry loading explicitly.'); }
    assertCurrent();
    if (!response.ok) throw Object.assign(new Error(typeof result?.error === 'string' ? result.error : 'The secure application request failed.'), { status: response.status });
    // The external handler returns awards_external_withdraw's SQL decision
    // {id,version,eligibility}; the normal member handler wraps that decision.
    // Normalise only an explicitly confirmed withdrawn eligibility, never an
    // HTTP-200/error or a guessed status, before the shared strict validator.
    if (options.payload?.command === 'withdraw' && result?.eligibility === 'withdrawn') result = { ...result, status: 'Withdrawn' };
    if (options.review) return validateEvidenceReview(result);
    const validated = validateApplicantResponse(result, { ...options, applicationId: authority.applicationId });
    if (options.edit) bindExternalAwardApplicantTenant(authority, validated.tenantId);
    else if (!options.payload) {
      const row = validated.applications[0];
      if (validated.total !== 1 || validated.applications.length !== 1 || typeof row.canAmend !== 'boolean'
        || !Array.isArray(row.certificates) || new Set(row.certificates.map(item => item?.id)).size !== row.certificates.length
        || row.certificates.some(item => !applicantUuid.test(item?.id || '') || !Number.isFinite(Date.parse(item.issuedAt))
          || (item.category !== null && typeof item.category !== 'string'))) throw new Error('The secure application/released certificate projection is incomplete. No partial evidence is shown.');
    }
    return validated;
  });
}

export function externalApplicantAttachmentRequest(authority, tenantSlug, applicationId, attachmentId, { signal } = {}) {
  if (!authority.externalApplicant || tenantSlug !== authority.tenantSlug || applicationId?.toLowerCase() !== authority.applicationId) throw new Error('The secure attachment scope does not match this application.');
  return readAwardAttachment({
    signal, assertCurrent: () => authority.assertCurrent(),
    requestChunk: (offset, chunkSignal, consume) => externalAwardApplicantResponse(authority,
      { review: true, attachmentId, offset, signal: chunkSignal }, consume),
  });
}

