import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

export default function CampaignEventSurveySettings({ value, onChange, fixedEvent = false }) {
  const context = value || {};
  const type = context.event_type || 'event';
  const { data: events = [], error: eventError } = useQuery({
    queryKey: ['campaign-survey-events', type],
    queryFn: () => base44.entities[type === 'event' ? 'Event' : 'ComplexEvent'].list(),
    enabled: !fixedEvent,
  });
  const { data: assignments = [], error: assignmentError } = useQuery({
    queryKey: ['campaign-survey-assignments', type, context.event_id],
    enabled: !!context.event_id,
    queryFn: () => base44.entities.EventSurveyAssignment.filter({
      [type === 'event' ? 'event_id' : 'complex_event_id']: context.event_id,
      status: 'active',
    }),
  });
  const { data: forms = [], error: formError } = useQuery({
    queryKey: ['forms-for-surveys'],
    queryFn: () => base44.entities.Form.list(),
  });
  const classes = 'w-full rounded-md border bg-background p-2';
  return <fieldset className="space-y-3 rounded-md border p-4">
    <legend className="px-1 font-medium">Campaign event survey</legend>
    <p className="text-sm text-muted-foreground">
      Use <code>{'{{event_survey_url}}'}</code> (or <code>[[event.survey_url]]</code>)
      in your reusable template, including a button URL or link href.
      {fixedEvent ? ' The event is taken from this email configuration.' : ' Select the event here, not on the template.'}
      Sending requires an open assignment and an active published survey. Existing login and access restrictions still apply.
    </p>
    {(eventError || assignmentError || formError) && <p role="alert">Could not load event survey choices. Please retry.</p>}
    {!fixedEvent && <><label className="block">Event type
      <select aria-label="Event type" className={classes} value={type} onChange={e => onChange({ event_type: e.target.value, event_id: '', assignment_id: '' })}>
        <option value="event">Event</option><option value="complex_event">Complex event</option>
      </select>
    </label>
    <label className="block">Event
      <select aria-label="Event" className={classes} value={context.event_id || ''} onChange={e => onChange({ event_type: type, event_id: e.target.value, assignment_id: '' })}>
        <option value="">Select an event</option>
        {events.map(event => <option key={event.id} value={event.id}>{event.title || event.name}</option>)}
      </select>
    </label></>}
    <label className="block">Survey assignment
      <select aria-label="Survey assignment" className={classes} disabled={!context.event_id} value={context.assignment_id || ''} onChange={e => onChange({ ...context, assignment_id: e.target.value })}>
        <option value="">Automatic only when exactly one active assignment exists</option>
        {assignments.map(row => <option key={row.id} value={row.id}>{forms.find(form => form.id === row.form_id)?.name || 'Survey'} ({row.access_mode === 'authenticated' ? 'Login required' : 'Public assignment'})</option>)}
      </select>
    </label>
  </fieldset>;
}