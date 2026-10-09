// Merge confirmed edits into both consumers without waiting for a GET.
export async function publishProjectCardUpdate(queryClient, cardId, patch = {}, {
  attachment, removedAttachmentId,
} = {}) {
  const predicate = query =>
    (query.queryKey[0] === 'card-detail' && query.queryKey[1] === cardId) ||
    (query.queryKey[0] === 'project-board' && query.state.data?.cards?.some(card => card.id === cardId));
  await queryClient.cancelQueries({ predicate });
  const mergeAttachments = (items = []) => {
    const remaining = items.filter(item => item.id !== removedAttachmentId);
    return attachment
      ? [...remaining.filter(item => item.id !== attachment.id), attachment]
      : remaining;
  };
  const mergeCard = card => ({
    ...card, ...patch,
    ...(attachment || removedAttachmentId ? {
      project_card_attachment: mergeAttachments(card.project_card_attachment),
    } : {}),
  });
  queryClient.setQueriesData({ predicate }, old => {
    if (!old) return old;
    if (old.cards) return { ...old, cards: old.cards.map(card => card.id === cardId ? mergeCard(card) : card) };
    return { ...old, card: old.card ? mergeCard(old.card) : old.card,
      ...(attachment || removedAttachmentId ? { attachments: mergeAttachments(old.attachments) } : {}) };
  });
  void queryClient.invalidateQueries({ predicate });
}

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
