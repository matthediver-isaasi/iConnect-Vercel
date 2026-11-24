import MemberCpdPointsTab from '@/components/MemberCpdPointsTab';
import SpeakerAwardsHistory from '@/components/SpeakerAwardsHistory';
import { Button } from '@/components/ui/button';

export default function MemberRecordCpdContent({ memberId, enabled, canCorrect, preferences }) {
  return (
    <>
      {!preferences.resolved && (
        preferences.error
          ? <div role="alert">Could not load member record preferences. <Button variant="outline" onClick={() => preferences.retry()}>Retry preferences</Button></div>
          : <p role="status">Loading member record preferences…</p>
      )}
      {preferences.resolved && preferences.cpdVisible && <MemberCpdPointsTab
        key={`points-${memberId}`}
        memberId={memberId}
        certificates
        enabled={enabled}
        canCorrect={canCorrect}
      />}
      <SpeakerAwardsHistory
        key={`speaker-${memberId}`}
        endpoint={`/api/members/${encodeURIComponent(memberId)}/speaker-awards`}
        certificateEndpoint={`/api/members/${encodeURIComponent(memberId)}/speaker-certificate`}
        enabled={enabled}
        showEmpty
      />
    </>
  );
}
