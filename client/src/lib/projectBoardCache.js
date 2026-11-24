import { invalidateInboxViews } from './inboxSources.mjs';

// Only publish confirmed deltas; never replace unrelated relationships with an
// endpoint snapshot. Cancellation fences reads started before this write.
export async function publishProjectCardAssignee(queryClient, cardId, identityId, assignee) {
  const predicate = query =>
    (query.queryKey[0] === 'card-detail' && query.queryKey[1] === cardId) ||
    (query.queryKey[0] === 'project-board' && query.state.data?.cards?.some(card => card.id === cardId));
  await queryClient.cancelQueries({ predicate });
  const merge = card => {
    const remaining = (card.project_card_assignee || []).filter(item => item.identity_id !== identityId);
    return { ...card, project_card_assignee: assignee ? [...remaining, assignee] : remaining };
  };
  queryClient.setQueriesData({ predicate }, old => !old ? old : old.cards
    ? { ...old, cards: old.cards.map(card => card.id === cardId ? merge(card) : card) }
    : { ...old, card: old.card ? merge(old.card) : old.card });
}

// Publish a confirmed comment before the background refresh. Cancel pre-write
// reads, deduplicate by ID, and preserve every other card relationship.
export async function publishProjectCardComment(queryClient, boardId, cardId, comment) {
  if (!comment?.id) return;
  const detailKey = ['card-detail', cardId];
  const boardKey = ['project-board', boardId];
  await Promise.all([
    queryClient.cancelQueries({ queryKey: detailKey, exact: true }),
    queryClient.cancelQueries({ queryKey: boardKey, exact: true }),
  ]);
  const detail = queryClient.getQueryData(detailKey);
  const alreadyPublished = detail?.comments?.some(item => item.id === comment.id);
  const comments = detail?.comments
    ? orderProjectDiscussion([...detail.comments.filter(item => item.id !== comment.id), comment])
    : undefined;
  const increment = alreadyPublished ? 0 : 1;
  const withCount = (card) => ({
    ...card,
    project_card_comment: [{ count: Math.max(
      (Number(card.project_card_comment?.[0]?.count) || 0) + increment,
      comments?.length || 0,
    ) }],
  });
  queryClient.setQueryData(boardKey, old => old ? {
    ...old, cards: old.cards?.map(card => card.id === cardId ? withCount(card) : card),
  } : old);
  queryClient.setQueryData(detailKey, old => old ? {
    ...old, comments: comments || [comment], card: old.card ? withCount(old.card) : old.card,
  } : old);
}

export function orderProjectDiscussion(comments = []) {
  const compare = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id));
  const roots = comments.filter(comment => !comment.parent_comment_id).sort((a, b) => -compare(a, b));
  const children = new Map();
  for (const comment of comments) if (comment.parent_comment_id) {
    if (!children.has(comment.parent_comment_id)) children.set(comment.parent_comment_id, []);
    children.get(comment.parent_comment_id).push(comment);
  }
  return roots.flatMap(root => [root, ...(children.get(root.id) || []).sort(compare)]);
}

// All write responses carry a complete transaction snapshot. Versions fence
// delayed mutation responses as well as reads started before the commit.
export async function publishProjectDiscussion(client, boardId, cardId, result) {
  if (!Array.isArray(result?.comments)) throw new Error('Incomplete discussion response; reopen this task to confirm the saved change.');
  const detailKey = ['card-detail', cardId];
  const boardKey = ['project-board', boardId];
  await Promise.all([
    client.cancelQueries({ queryKey: detailKey, exact: true }),
    client.cancelQueries({ queryKey: boardKey, exact: true }),
  ]);
  const oldDetail = client.getQueryData(detailKey);
  if (Number(oldDetail?.discussionVersion ?? -1) > Number(result.discussionVersion ?? -1)) return;
  const comments = orderProjectDiscussion(result.comments);
  const count = card => ({ ...card, project_card_comment: [{ count: comments.length }] });
  client.setQueryData(detailKey, old => old ? {
    ...old, comments, discussionVersion: result.discussionVersion,
    ...(typeof result.discussionCanWrite === 'boolean' ? { discussionCanWrite: result.discussionCanWrite } : {}),
    card: old.card ? count(old.card) : old.card,
  } : old);
  client.setQueryData(boardKey, old => old ? {
    ...old, cards: old.cards?.map(card => card.id === cardId ? count(card) : card),
  } : old);
  void client.invalidateQueries({ queryKey: [...boardKey, 'search-index'], exact: true });
  // These reads are background work, not evidence needed to confirm a write.
  // Never subscribe browsers to the private reaction table.
  void invalidateInboxViews(client, boardId);
}

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
  void queryClient.invalidateQueries({ predicate: query =>
    query.queryKey[0] === 'project-board' && query.queryKey[2] === 'search-index' &&
    query.state.data?.documents?.some(document => document.cardId === cardId),
  });
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
  void queryClient.invalidateQueries({ queryKey: [...queryKey, 'search-index'], exact: true });
}
