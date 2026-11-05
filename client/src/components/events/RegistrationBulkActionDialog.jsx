import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import CpdFollowUpActions from "./CpdFollowUpActions";
import { cpdRegistrationKey } from "@/lib/cpdPointsReplay";

const surveyEndpoint = "/api/reports/registrant-survey-email";
export async function bulkRequest(url, body) {
  const response = await fetch(url, { credentials: "include", ...(body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
export const eventKey = row => `${row.booking_source}:${row.event_id}`;
export const identity = row => ({ booking_id: row.booking_id, booking_source: row.booking_source, event_id: row.event_id });
export function cancellationBody(row, reason) {
  return { booking_ids: [row.booking_id], booking_source: row.booking_source === "complex" ? "complex_event_booking" : "booking",
    request_type: "individual", reason: reason.trim() || null };
}

export default function RegistrationBulkActionDialog({ action, registrations, onClose, onChanged }) {
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [choices, setChoices] = useState({});
  const [assignments, setAssignments] = useState({});
  const [reviews, setReviews] = useState(null);
  const [outcomes, setOutcomes] = useState({});
  const [attempted, setAttempted] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [previewKey, setPreviewKey] = useState("");
  const events = [...new Map(registrations.map(row => [eventKey(row), row])).values()];
  const run = async work => {
    if (active.current) return;
    active.current = true; setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e.message); }
    finally { active.current = false; setBusy(false); }
  };
  const load = () => run(async () => {
    const result = {}, selected = {};
    for (const row of events) {
      try {
        const data = await bulkRequest(`${surveyEndpoint}?${new URLSearchParams({ booking_source: row.booking_source, event_id: row.event_id })}`);
        result[eventKey(row)] = data;
        if (data.surveys.length === 1) selected[eventKey(row)] = data.surveys[0].id;
      } catch (e) { result[eventKey(row)] = { error: e.message, surveys: [] }; }
    }
    setChoices(result); setAssignments(selected);
  });
  useEffect(() => { if (action === "survey") load(); }, []); // Frozen selection for this dialog.
  const review = () => run(async () => {
    const items = [];
    setReviews(null); setAcknowledged(false);
    for (const row of registrations) {
      const assignment = assignments[eventKey(row)];
      if (!assignment) { items.push({ row, error: "No open survey selected for this event." }); continue; }
      try {
        const preview = await bulkRequest(surveyEndpoint, { ...identity(row), assignment_id: assignment, action: "preview" });
        items.push({ row, assignment, preview, requestId: crypto.randomUUID() });
      } catch (e) { items.push({ row, error: e.message }); }
    }
    setReviews(items);
    setPreviewKey(cpdRegistrationKey(items.find(item => item.preview)?.row || {}));
  });
  const cancel = () => run(async () => {
    setAttempted(true);
    const result = {};
    for (const row of registrations) {
      const key = cpdRegistrationKey(row);
      if (row.status === "cancelled") { result[key] = "Skipped: already cancelled."; setOutcomes({ ...result }); continue; }
      try {
        const data = await bulkRequest("/api/booking-cancellation-requests", cancellationBody(row, reason));
        result[key] = data.message || "Cancellation request submitted for review.";
      } catch (e) { result[key] = `${e.message} Check the cancellation queue before retrying; no automatic retry was made.`; }
      setOutcomes({ ...result });
    }
    onChanged?.();
  });
  const send = () => run(async () => {
    setAttempted(true);
    const result = {};
    for (const item of reviews || []) {
      const key = cpdRegistrationKey(item.row);
      if (!item.preview) { result[key] = `Skipped: ${item.error}`; setOutcomes({ ...result }); continue; }
      try {
        await bulkRequest(surveyEndpoint, { ...identity(item.row), assignment_id: item.assignment, action: "send",
          confirmed: true, acknowledge_unverified: acknowledged, request_id: item.requestId,
          expected_fingerprint: item.preview.fingerprint });
        result[key] = "Survey invitation sent.";
      } catch (e) { result[key] = `${e.message} Check delivery before retrying; no automatic retry was made.`; }
      setOutcomes({ ...result });
    }
  });
  const title = action === "cancel" ? "Request cancellation" : action === "certificate" ? "Preview or email CPD certificates" : "Send survey invitations";
  const eligible = reviews?.filter(item => item.preview) || [];
  const needsAcknowledgement = eligible.some(item => item.preview.attendance_warning);
  const preview = eligible.find(item => cpdRegistrationKey(item.row) === previewKey)?.preview;
  return <Dialog open onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto" onEscapeKeyDown={e => { if (busy) e.preventDefault(); }} onPointerDownOutside={e => e.preventDefault()}>
      <DialogHeader><DialogTitle>{title}</DialogTitle>
        <DialogDescription>{registrations.length} selected registrations, including selections on other pages or hidden by filters. Keep this window open until processing finishes.</DialogDescription>
      </DialogHeader>
      {action === "certificate" ? <CpdFollowUpActions registrations={registrations} ready certificateOnly onBusyChange={setBusy} /> : <>
        {action === "cancel" && <>
          <p className="text-sm">This submits individual requests to the cancellation review queue. It does not approve cancellations or issue refunds. Already cancelled registrations will be skipped.</p>
          <label className="text-sm">Reason (optional)<textarea className="block w-full border rounded p-2" value={reason} onChange={e => setReason(e.target.value)} disabled={busy || attempted} /></label>
        </>}
        {action === "survey" && <>
          {events.map(row => <label key={eventKey(row)} className="block text-sm">
            {row.event_title || "Selected event"}
            <select className="block w-full border rounded p-2 bg-background" value={assignments[eventKey(row)] || ""} disabled={busy || attempted}
              onChange={e => { setAssignments({ ...assignments, [eventKey(row)]: e.target.value }); setReviews(null); }}>
              <option value="">Choose an open survey</option>
              {choices[eventKey(row)]?.surveys?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {choices[eventKey(row)]?.error && <span role="alert">{choices[eventKey(row)].error}</span>}
            {choices[eventKey(row)] && !choices[eventKey(row)].error && !choices[eventKey(row)].surveys.length && <span>No survey is currently open for responses.</span>}
          </label>)}
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy || attempted} onClick={load}>Reload survey choices</Button>
            <Button variant="outline" disabled={busy || attempted} onClick={review}>Review recipients and preview emails</Button>
          </div>
          {reviews && <p>{eligible.length} eligible; {reviews.length - eligible.length} excluded. Attendance and survey access are checked again when sending.</p>}
          {eligible.length > 0 && <label className="text-sm">Preview recipient
            <select className="block w-full border rounded p-2 bg-background" value={previewKey} onChange={e => setPreviewKey(e.target.value)}>
              {eligible.map(item => <option key={cpdRegistrationKey(item.row)} value={cpdRegistrationKey(item.row)}>{item.row.attendee_name} — {item.preview.recipient}</option>)}
            </select>
          </label>}
          {preview && <div><p>To: {preview.recipient}</p><p>Subject: {preview.subject}</p><iframe title="Survey invitation preview" sandbox="" srcDoc={preview.html} className="w-full h-64 border bg-white" /></div>}
          {needsAcknowledgement && <label className="flex gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
            <input type="checkbox" checked={acknowledged} disabled={busy || attempted} onChange={e => setAcknowledged(e.target.checked)} />
            No attendance verification is in place for one or more selected events. I confirm sending invitations to these unverified attendees.
          </label>}
        </>}
        <div className="max-h-48 overflow-auto border rounded p-2 text-sm" tabIndex={0} aria-label="Selected registrations and results" aria-live="polite">
          {registrations.map(row => <p key={cpdRegistrationKey(row)} className="py-1">
            <strong>{row.attendee_name || "Unnamed attendee"}</strong>{row.attendee_email ? ` — ${row.attendee_email}` : ""} · {row.event_title}
            {outcomes[cpdRegistrationKey(row)] ? ` — ${outcomes[cpdRegistrationKey(row)]}` : reviews?.find(item => cpdRegistrationKey(item.row) === cpdRegistrationKey(row))?.error ? ` — Excluded: ${reviews.find(item => cpdRegistrationKey(item.row) === cpdRegistrationKey(row)).error}` : ""}
          </p>)}
        </div>
        <Button disabled={busy || attempted || (action === "survey" && (!eligible.length || (needsAcknowledgement && !acknowledged)))}
          onClick={action === "cancel" ? cancel : send}>{busy ? "Processing…" : action === "cancel" ? "Confirm cancellation requests" : `Confirm and send ${eligible.length} invitations`}</Button>
      </>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <Button variant="outline" disabled={busy} onClick={onClose}>Close</Button>
    </DialogContent>
  </Dialog>;
}
