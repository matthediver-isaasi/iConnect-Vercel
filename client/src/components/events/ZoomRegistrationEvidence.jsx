import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export default function ZoomRegistrationEvidence({ evidence, loading, error }) {
  if (loading) return <p role="status">Checking live Zoom settings…</p>;
  if (error) return <p role="alert">Zoom evidence unavailable: {error.message || error}</p>;
  if (!evidence?.cached) return null;
  const data = evidence.live || evidence.cached;
  return <div className="space-y-2 text-sm my-3" data-testid="zoom-registration-evidence">
    <p className="font-medium">{data.topic}</p>
    <p>Zoom ID: {data.numericId}</p>
    <p>{data.start_time ? new Date(data.start_time).toLocaleString(undefined, { timeZone: data.timezone || 'UTC' }) : 'Schedule unavailable'} ({data.timezone || 'UTC'})</p>
    <p>Registration: {data.registration_required ? 'enabled' : 'disabled'} — {evidence.live ? 'verified live in Zoom' : 'cached, not verified'}</p>
    {evidence.error && <p role="alert">{evidence.error}</p>}
    {evidence.live?.join_url && <div className="flex gap-3">
      <a href={evidence.live.join_url} target="_blank" rel="noopener noreferrer" className="underline">Open attendee join link</a>
      <Button type="button" size="sm" variant="outline" onClick={async () => {
        try { await navigator.clipboard.writeText(evidence.live.join_url); toast.success('Attendee join link copied'); }
        catch { toast.error('Could not copy attendee join link'); }
      }}>Copy attendee join link</Button>
    </div>}
    <p>Confirmed bookings: {evidence.confirmedBookings ?? 'unavailable'}</p>
    {evidence.counts ? <p>Approved: {evidence.counts.approved}; pending: {evidence.counts.pending}; denied: {evidence.counts.denied}; missing: {evidence.counts.missing}; missing email: {evidence.counts.missingEmail}.</p>
      : <p>Registration counts unavailable. {evidence.registrationError}</p>}
  </div>;
}
