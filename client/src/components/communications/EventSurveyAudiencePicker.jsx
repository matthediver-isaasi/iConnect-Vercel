import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

async function loadSurveys(params = "") {
  const response = await fetch(`/api/audience-lists/event-surveys${params}`, { credentials: "include" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to load event surveys.");
  if (!Array.isArray(data)) throw new Error("Invalid event survey response.");
  return data;
}

export default function EventSurveyAudiencePicker({ onChange }) {
  const [eventKey, setEventKey] = useState("");
  const [assignmentId, setAssignmentId] = useState("");
  const [received, setReceived] = useState("");
  const events = useQuery({ queryKey: ["audience-survey-events"], queryFn: () => loadSurveys(), retry: false });
  const event = events.data?.find(e => `${e.event_type}:${e.event_id}` === eventKey);
  const assignments = useQuery({
    queryKey: ["audience-event-surveys", eventKey],
    enabled: !!event,
    queryFn: () => loadSurveys(`?event_id=${encodeURIComponent(event.event_id)}&event_type=${encodeURIComponent(event.event_type)}`),
    retry: false,
  });
  const options = [...new Map((events.data || []).map(e => [`${e.event_type}:${e.event_id}`, e])).values()];
  const selectedAssignment = assignments.data?.find(a => a.id === assignmentId);
  const noResponseUnsupported = selectedAssignment?.no_response_supported === false;
  function update(id, response) {
    const assignment = assignments.data?.find(a => a.id === id && a.supported);
    const responseSupported = response === "yes" || (response === "no" && assignment?.no_response_supported !== false);
    onChange(assignment && responseSupported ? {
      type: "event_form", ids: [assignment.form_id], form_id: assignment.form_id,
      survey_assignment_id: assignment.id, event_id: event.event_id, event_type: event.event_type,
      survey_name: assignment.survey_name, event_title: event.event_title,
      names: { [assignment.form_id]: assignment.survey_name }, received: response === "yes",
    } : null);
  }
  return <div className="space-y-3 border rounded-md p-3">
    <label className="block text-sm">Event
      <select aria-label="Survey event" className="block w-full border rounded p-2 bg-background" value={eventKey} onChange={e => {
        setEventKey(e.target.value); setAssignmentId(""); setReceived(""); onChange(null);
      }}>
        <option value="">Select an event</option>
        {options.map(e => <option key={`${e.event_type}:${e.event_id}`} value={`${e.event_type}:${e.event_id}`}>{e.event_title} — {e.event_type === "complex_event" ? "Complex event" : "Event"}</option>)}
      </select>
    </label>
    {events.isLoading && <p role="status">Loading events…</p>}
    {events.error && <p role="alert">{events.error.message} <button type="button" onClick={() => events.refetch()}>Retry</button></p>}
    {events.isSuccess && !options.length && <p>No events with survey assignments available.</p>}
    {event && <>
      <label className="block text-sm">Event Survey
        <select aria-label="Event survey assignment" className="block w-full border rounded p-2 bg-background" value={assignmentId} onChange={e => {
          setAssignmentId(e.target.value); setReceived(""); onChange(null);
        }}>
          <option value="">Select a survey assignment</option>
          {(assignments.data || []).map(a => <option key={a.id} value={a.id} disabled={!a.supported}>{a.survey_name} — {a.status || "Unknown status"} — {a.created_date || "Date unavailable"} — {a.id}{!a.supported ? ` — ${a.unsupported_reason || "Unsupported"}` : ""}</option>)}
        </select>
      </label>
      {assignments.isLoading && <p role="status">Loading survey assignments…</p>}
      {assignments.error && <p role="alert">{assignments.error.message} <button type="button" onClick={() => assignments.refetch()}>Retry</button></p>}
      {assignments.isSuccess && !assignments.data.length && <p>No survey assignments for this event.</p>}
      {(assignments.data || []).filter(a => !a.supported).map(a => <p key={a.id} className="text-sm text-muted-foreground">{a.survey_name}: {a.unsupported_reason || "This survey assignment is unsupported."}</p>)}
    </>}
    {assignmentId && <label className="block text-sm">Response
      <select aria-label="Survey response" aria-describedby={noResponseUnsupported ? "survey-no-response-reason" : undefined} className="block w-full border rounded p-2 bg-background" value={received} onChange={e => { setReceived(e.target.value); update(assignmentId, e.target.value); }}>
        <option value="">Select response status</option><option value="yes">Responded</option><option value="no" disabled={noResponseUnsupported}>No response</option>
      </select>
    </label>}
    {assignmentId && noResponseUnsupported && <p id="survey-no-response-reason" className="text-sm text-muted-foreground">
      No response is unavailable: {selectedAssignment.no_response_unsupported_reason || "Anonymous submissions may lack completion identities, so non-response cannot be reliably determined."}
    </p>}
  </div>;
}