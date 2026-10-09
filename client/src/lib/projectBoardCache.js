// Publish the server-confirmed card before the slower board refresh completes.
export async function publishCreatedProjectCard(queryClient, boardId, card) {
  if (!card?.id || card.board_id !== boardId) return;
  const queryKey = ['project-board', boardId];
  // A realtime-triggered read may have started before the insert committed.
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData(queryKey, (old) => {
    if (!old) return old;
    // Realtime may already have delivered a newer, enriched copy.
    if (old.cards?.some(existing => existing.id === card.id)) return old;
    return {
      ...old,
      cards: [...(old.cards || []), {
        ...card,
        project_card_label: card.project_card_label || [],
        project_card_assignee: card.project_card_assignee || [],
        project_card_attachment: card.project_card_attachment || [],
      }],
    };
  });
  // Do not keep the create spinner waiting for this round trip.
  void queryClient.invalidateQueries({ queryKey, exact: true });
}
