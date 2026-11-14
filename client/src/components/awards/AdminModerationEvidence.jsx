import { useRef } from 'react';
import ImmutableEvidence from './ImmutableEvidence';
import { adminEvidenceAttachment, adminEvidenceReview } from './adminEvidenceClient';

export default function AdminModerationEvidence({ tenant, roundId, applicationId, versionId, canModerate = false, canApprove = false, enabled = true }) {
  const permitted = Boolean(canModerate || canApprove);
  const scopeKey = JSON.stringify(['admin-moderation-evidence', tenant?.scopeKey, roundId, applicationId, versionId || 'shared-current', canModerate, canApprove]);
  const live = useRef();
  live.current = { scopeKey, enabled: enabled && permitted };
  const assertCurrent = () => {
    if (!live.current.enabled || live.current.scopeKey !== scopeKey) throw Object.assign(new Error('Moderation evidence role or source changed. Reopen current evidence.'), { status: 403 });
    tenant.assertCurrent();
  };
  const options = { tenant, roundId, applicationId, versionId, access: { canModerate, canApprove, assertCurrent } };
  // Reporting permits submitted assessment history, NOT this private evidence.
  if (!permitted) return null;
  return <div className="space-y-3">
    {versionId && <p className="awards-help">Historical submitted evidence version. This is a prior/source snapshot, not a current official score or proof that it is used for current judging. No reassessment/adoption is performed.</p>}
    <ImmutableEvidence key={scopeKey} scopeKey={scopeKey} enabled={enabled} assertCurrent={assertCurrent}
      title={versionId ? 'Historical application evidence — submitted source version' : 'Current shared moderation application evidence'}
      loadReview={signal => adminEvidenceReview(options, { signal })}
      loadAttachment={(attachmentId, request) => adminEvidenceAttachment(options, attachmentId, request)} />
  </div>;
}
