// Speaker reference maintenance (Task #1509).
//
// `event.speaker_ids` and `complex_event_session.speaker_ids` are plain UUID
// arrays — there is no FK from those arrays to the speaker table, so deleting a
// speaker leaves dangling ids behind. Count badges read the raw array length
// while rendered lists drop ids that no longer resolve, so the number and the
// list disagree ("1 speaker selected" with an empty list).
//
// These helpers take a Supabase client (so both the runtime entity-delete path
// and the standalone maintenance script can reuse them) and are tenant-scoped.

/**
 * Remove one or more speaker ids from every event and complex-event session in
 * a tenant that still references them. Used when a speaker is deleted so no
 * event/session is left pointing at a non-existent speaker.
 *
 * @param {object} supabase - Supabase client (service role).
 * @param {object} opts
 * @param {string} opts.tenantId - Tenant to scope the cleanup to (required).
 * @param {string|string[]} opts.speakerIds - Speaker id(s) to strip.
 * @returns {Promise<{eventsUpdated: number, sessionsUpdated: number, errors: string[]}>}
 */
export async function pruneSpeakerIdsFromReferences(supabase, { tenantId, speakerIds }) {
  const result = { eventsUpdated: 0, sessionsUpdated: 0, errors: [] };

  if (!tenantId) {
    result.errors.push('tenantId is required');
    return result;
  }

  const ids = (Array.isArray(speakerIds) ? speakerIds : [speakerIds]).filter(Boolean);
  if (ids.length === 0) return result;

  const idSet = new Set(ids);

  for (const table of ['event', 'complex_event_session']) {
    for (const speakerId of ids) {
      const { data: rows, error: selectError } = await supabase
        .from(table)
        .select('id, speaker_ids')
        .eq('tenant_id', tenantId)
        .contains('speaker_ids', [speakerId]);

      if (selectError) {
        result.errors.push(`select ${table} for ${speakerId}: ${selectError.message}`);
        continue;
      }

      for (const row of rows || []) {
        const next = (row.speaker_ids || []).filter((sid) => !idSet.has(sid));
        const { error: updateError } = await supabase
          .from(table)
          .update({ speaker_ids: next })
          .eq('id', row.id);

        if (updateError) {
          result.errors.push(`update ${table} ${row.id}: ${updateError.message}`);
          continue;
        }

        if (table === 'event') result.eventsUpdated += 1;
        else result.sessionsUpdated += 1;
      }
    }
  }

  return result;
}
