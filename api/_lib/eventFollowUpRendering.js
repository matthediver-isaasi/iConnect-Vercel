import { replacePlaceholders, formatBodyAsHtml, formatEventDate, buildSessionScheduleHtml } from './eventConfirmationEmail.js';
import { fetchTrainingAgendaData, applyAgendaPlaceholders, escapeHtml } from './trainingAgenda.js';
import { resolveEventEmailSurvey } from './campaignEventSurvey.js';
import { accessibleFollowUpEntries } from './eventFollowUps.js';

// Both preview and delivery use this renderer. Full schedule tokens remain a
// labelled full schedule; target tokens never silently mean the whole agenda.
export async function renderFollowUp(client, { event, booking, programme, target, timezone }, email) {
  const accessible = accessibleFollowUpEntries(event, booking, programme);
  const sessions = programme.entries.filter(e => accessible.includes(e.id) && !['cancelled', 'deleted'].includes(e.status));
  const complexEventData = event.is_complex ? {
    sessions, accessibleTracks: [],
    sessionScheduleHtml: `<h3>Full accessible programme</h3>${buildSessionScheduleHtml(sessions, timezone)}`,
  } : null;
  const agenda = !event.is_complex ? await fetchTrainingAgendaData(event.id, client) : null;
  if (agenda?.agendaScheduleHtml) agenda.agendaScheduleHtml = `<h3>Full event agenda</h3>${agenda.agendaScheduleHtml}`;
  const line = target.scope === 'session' && !event.is_complex ? target.entries[0] : null;
  const content = await resolveEventEmailSurvey(client, email, event, event.is_complex ? 'complex_event' : 'event');
  const render = template => {
    let text = replacePlaceholders(template, { event, booking, complexEventData });
    if (agenda) text = applyAgendaPlaceholders(text, { agendaData: agenda, line });
    return text.replace(/\{\{follow_up_target\}\}/gi, () => escapeHtml(target.label))
      .replace(/\{\{follow_up_end\}\}/gi, () => escapeHtml(formatEventDate(target.end.toISOString(), timezone)))
      .replace(/\{\{follow_up_scope\}\}/gi, () => escapeHtml(`After ${target.scope}`));
  };
  return { subject: render(content.subject), html: formatBodyAsHtml(render(content.body)) };
}
