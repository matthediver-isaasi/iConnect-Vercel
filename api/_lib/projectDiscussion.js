// One authorized SQL snapshot aggregates every row, including reactions and
// images; no PostgREST default row cap or per-comment query waterfall.
export async function readProjectDiscussion(db, cardId, actorId) {
  const { data, error } = await db.rpc('read_project_discussion', { p_card_id: cardId, p_actor_id: actorId });
  if (error) throw error;
  if (!data || !Array.isArray(data.comments)) throw new Error('Incomplete discussion response');
  return data;
}
