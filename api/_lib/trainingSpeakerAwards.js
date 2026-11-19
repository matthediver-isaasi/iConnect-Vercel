// Training awards have an agenda identity; they must never enter the legacy
// event-wide grant loop. The database serialises effects with source edits.
export async function processTrainingSpeakerAwards(db, { tenantId, eventId, assignment = false }) {
  const { data, error } = await db.rpc('process_training_speaker_awards', {
    p_tenant: tenantId, p_event: eventId, p_assignment: assignment,
  });
  if (error) throw new Error(`Agenda speaker awards failed: ${error.message}`);
  return data || [];
}

export async function loadTrainingSpeakerIds(db, tenantId, eventId) {
  const { data, error } = await db.rpc('training_speaker_ids', { p_tenant: tenantId, p_event: eventId });
  if (error) throw new Error(`Agenda speakers unavailable: ${error.message}`);
  if (!Array.isArray(data)) throw new Error('Agenda speakers returned an invalid result');
  return data;
}
