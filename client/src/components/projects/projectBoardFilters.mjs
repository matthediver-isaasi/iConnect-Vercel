export const ASSIGNED_TO_ME = "@me";
export const UNASSIGNED = "@unassigned";
export const emptyBoardFilters = () => ({ labels: [], assignees: [], hideCompleted: false, keyword: "" });
export const hasBoardFilters = filters =>
  Boolean(filters.labels.length || filters.assignees.length || filters.hideCompleted || filters.keyword.trim());

/** Normalize complete child text once per index response, never once per keystroke. */
export function normalizeSearchDocuments(documents = []) {
  return new Map(documents.map(document => [String(document.cardId), String(document.text || "").toLowerCase()]));
}

export function filterBoardCards(cards, filters, viewerIdentityId, searchDocuments, keyword = filters.keyword) {
  const labels = new Set(filters.labels.map(String));
  const assignees = new Set(filters.assignees.map(String));
  const term = keyword.trim().toLowerCase();
  return cards.filter(card => {
    if (filters.hideCompleted && card.is_complete) return false;
    if (labels.size && !(card.project_card_label || []).some(label => labels.has(String(label.label_id)))) return false;
    const assigned = (card.project_card_assignee || []).map(item => String(item.identity_id));
    if (assignees.size && !(
      (assignees.has(UNASSIGNED) && !assigned.length) ||
      (assignees.has(ASSIGNED_TO_ME) && viewerIdentityId != null && assigned.includes(String(viewerIdentityId))) ||
      assigned.some(id => assignees.has(id))
    )) return false;
    if (term) {
      const local = `${card.title || ""}\n${card.description || ""}`.toLowerCase();
      if (!local.includes(term) && !searchDocuments?.get(String(card.id))?.includes(term)) return false;
    }
    return true;
  });
}

export function groupBoardCards(cards) {
  const groups = new Map();
  for (const card of cards) {
    const id = String(card.list_id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(card);
  }
  for (const group of groups.values()) group.sort((a, b) => a.position - b.position);
  return groups;
}

/** DnD indices refer to the visible list after removing the dragged card.
 * Anchor before the next visible card, or directly after the last visible card.
 * When no cards are visible, append; never reorder the hidden cards.
 */
export function filteredInsertionPosition(fullCards, visibleCards, movedCardId, droppedIndex) {
  const remaining = fullCards.filter(card => String(card.id) !== String(movedCardId))
    .slice().sort((a, b) => a.position - b.position);
  const remainingIds = new Set(remaining.map(card => String(card.id)));
  const visible = visibleCards.filter(card =>
    String(card.id) !== String(movedCardId) && remainingIds.has(String(card.id)))
    .slice().sort((a, b) => a.position - b.position);
  const index = Math.max(0, Math.min(droppedIndex, visible.length));
  if (visible[index]) return remaining.findIndex(card => String(card.id) === String(visible[index].id));
  if (visible.length) return remaining.findIndex(card => String(card.id) === String(visible.at(-1).id)) + 1;
  return remaining.length;
}
