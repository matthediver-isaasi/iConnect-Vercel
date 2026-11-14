import { getTenantSlugFromLocation } from '@/api/publicClient';
import { applicantRequest, applicantAttachmentRequest } from './useAwardApplications';
import { externalApplicantRequest, externalApplicantAttachmentRequest } from './externalApplicantRequest';
import ImmutableEvidence from './ImmutableEvidence';

export default function ApplicantEvidence({ session, tenantSlug, applicationId, version, enabled = true }) {
  const external = session.externalApplicant === true;
  const assertCurrent = () => {
    session.assertCurrent();
    if (getTenantSlugFromLocation() !== tenantSlug) throw new Error('Your organisation changed. Reopen current evidence.');
  };
  const request = external ? externalApplicantRequest : applicantRequest;
  const download = external ? externalApplicantAttachmentRequest : applicantAttachmentRequest;
  return <ImmutableEvidence scopeKey={JSON.stringify([session.scopeKey, tenantSlug, applicationId, version])}
    enabled={enabled && session.status === 'ready'} assertCurrent={assertCurrent}
    title="Your saved application evidence"
    loadReview={signal => request(session, tenantSlug, { applicationId, review: true, signal })}
    loadAttachment={(attachmentId, options) => download(session, tenantSlug, applicationId, attachmentId, options)} />;
}
