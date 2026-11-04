import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";

const endpoint = "/api/reports/registrant-survey-email";
async function read(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Survey invitation unavailable.");
  return body;
}
export default function RegistrantSurveyEmailAction({ identity, attendee }) {
  const [open, setOpen] = useState(false);
  const [assignment, setAssignment] = useState("");
  const [preview, setPreview] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState("");
  const [attempted, setAttempted] = useState(false);
  const choices = useQuery({
    queryKey: ["registrant-survey-choices", identity.booking_source, identity.event_id],
    queryFn: () => fetch(`${endpoint}?${new URLSearchParams({ booking_source: identity.booking_source, event_id: identity.event_id })}`, { credentials: "include" }).then(read),
    enabled: !!identity.event_id,
    staleTime: 30000,
  });
  const attended = !!attendee.checked_in_at || attendee.attendance_status === "attended"
    || attendee.attendance_details?.some(row => row.status === "attended")
    || attendee.attendance_by_session?.some(row => row.attended);
  // Hide rather than invite an override when tracking requires verified attendance.
  if (attendee.status !== "confirmed" || (choices.data?.tracking && !attended)) return null;
  const enabled = !!choices.data?.surveys?.length;
  const reason = choices.isError ? "Survey availability could not be checked" : enabled ? "Send survey invitation" : "No survey currently open for responses";
  const post = body => fetch(endpoint, {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...identity, assignment_id: assignment, ...body }),
  }).then(read);
  const getPreview = async () => {
    setBusy(true); setError(""); setPreview(null); setAcknowledged(false);
    try { setPreview(await post({ action: "preview" })); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const send = async () => {
    setBusy(true); setError(""); setAttempted(true);
    try {
      await post({ action: "send", request_id: requestId, expected_fingerprint: preview.fingerprint,
        confirmed: true, acknowledge_unverified: acknowledged });
      toast.success("Survey invitation sent"); setOpen(false);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <>
    <Tooltip><TooltipTrigger asChild><span>
      <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={!enabled}
        aria-label={reason} onClick={event => {
          event.stopPropagation(); setOpen(true); setPreview(null); setError(""); setAcknowledged(false);
          setAttempted(false); setRequestId(crypto.randomUUID());
          setAssignment(choices.data.surveys.length === 1 ? choices.data.surveys[0].id : "");
        }}>
        <Mail className="h-3.5 w-3.5" />
      </Button>
    </span></TooltipTrigger><TooltipContent>{reason}</TooltipContent></Tooltip>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto" onClick={event => event.stopPropagation()}>
        <DialogHeader><DialogTitle>Send survey invitation</DialogTitle>
          <DialogDescription>Review the email before sending it to this registrant. Survey access rules still apply.</DialogDescription></DialogHeader>
        <label className="text-sm font-medium">Survey
          <select className="mt-2 w-full border rounded-md p-2 bg-background" value={assignment} disabled={busy || attempted}
            onChange={event => { setAssignment(event.target.value); setPreview(null); setAcknowledged(false); }}>
            <option value="">Choose an open survey</option>
            {choices.data?.surveys.map(survey => <option key={survey.id} value={survey.id}>{survey.name}</option>)}
          </select>
        </label>
        {choices.data?.tracking === false && <p className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
          No attendance verification is in place for this event. Attendance cannot be confirmed before sending.
        </p>}
        <Button type="button" variant="outline" onClick={getPreview} disabled={!assignment || busy || attempted}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Preview email
        </Button>
        {preview && <div className="space-y-3">
          <p className="text-sm"><strong>To:</strong> {preview.recipient}</p>
          <p className="text-sm"><strong>Subject:</strong> {preview.subject}</p>
          <iframe title="Survey invitation email preview" sandbox="" srcDoc={preview.html} className="w-full h-64 border rounded-md bg-white" />
          {preview.attendance_warning && <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={acknowledged} disabled={busy || attempted} onChange={event => setAcknowledged(event.target.checked)} />
            I understand attendance is unverified and confirm sending this survey invitation.
          </label>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" onClick={send} disabled={busy || attempted || (preview.attendance_warning && !acknowledged)}>Confirm and send</Button>
          </div>
        </div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  </>;
}
