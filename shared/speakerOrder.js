// Resolve only already-authorized records; never change catalogue sorting.
export function speakersInOrder(ids, speakers) {
  const byId = new Map((speakers || []).map(s => [s.id, s]));
  return [...new Set(ids || [])].map(id => byId.get(id)).filter(Boolean);
}
