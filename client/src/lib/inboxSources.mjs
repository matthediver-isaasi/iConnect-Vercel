// Source-qualified identities prevent collisions between independent tables.
export function inboxSource(source) {
  return source === "project" || source === "transactional" ? source : "campaign";
}

export function inboxMessageKey(message) {
  return `${inboxSource(message.source)}:${message.recipient_id}`;
}

export function inboxActionBody(recipientId, action, folderId, source) {
  const field = { campaign: "recipient_id", transactional: "transactional_id", project: "project_id" }[inboxSource(source)];
  return { action, folder_id: folderId, [field]: recipientId };
}

// Keep the first four arguments compatible with the existing callers.
export function inboxBulkBody(campaignIds, transactionalIds, action, folderId, projectIds = []) {
  const body = { action, folder_id: folderId };
  for (const [field, ids] of [["recipient_ids", campaignIds], ["transactional_ids", transactionalIds], ["project_ids", projectIds]]) {
    const values = Array.isArray(ids) ? ids.filter((id) => id !== null && id !== undefined && id !== "") : [];
    if (values.length) body[field] = values;
  }
  return Object.keys(body).length > 2 ? body : null;
}

export function splitInboxSelection(keys, messagesByKey) {
  const groups = { campaign: [], transactional: [], project: [] };
  for (const key of keys) {
    const message = messagesByKey.get(key);
    if (message) groups[inboxSource(message.source)].push(message.recipient_id);
  }
  return groups;
}

export function inboxDetailPath(recipientId, source) {
  const normalized = inboxSource(source);
  return `/api/communication/inbox/${encodeURIComponent(recipientId)}${normalized === "campaign" ? "" : `?source=${normalized}`}`;
}

export function projectInboxCardUrl(message) {
  if (message?.source !== "project" || !message.board_id || !message.card_id) return null;
  return `/ProjectBoard/${encodeURIComponent(message.board_id)}?cardId=${encodeURIComponent(message.card_id)}`;
}

// Legacy recipientIds include all sources; resolve them against the current list.
// New results can use qualified IDs, records, or separate per-source arrays.
export function inboxSearchKeys(data = {}, messages = []) {
  const keys = new Set();
  for (const [field, source] of [["recipientIds", "campaign"], ["transactionalIds", "transactional"], ["projectIds", "project"]]) {
    for (const value of Array.isArray(data[field]) ? data[field] : []) {
      if (value && typeof value === "object") keys.add(inboxMessageKey({ source: value.source || source, recipient_id: value.recipient_id ?? value.id }));
      else if (typeof value === "string" && /^(campaign|transactional|project):/.test(value)) keys.add(value);
      else {
        const legacyMatches = field === "recipientIds" ? messages.filter((message) => String(message.recipient_id) === String(value)) : [];
        if (legacyMatches.length) legacyMatches.forEach((message) => keys.add(inboxMessageKey(message)));
        else keys.add(inboxMessageKey({ source, recipient_id: value }));
      }
    }
  }
  for (const message of Array.isArray(data.matches) ? data.matches : []) {
    keys.add(inboxMessageKey({ ...message, recipient_id: message.recipient_id ?? message.id }));
  }
  return [...keys];
}

// Do not refetch detail queries: a GET marks read and would undo "Mark unread".
export function invalidateInboxViews(queryClient, boardId) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["inbox"], exact: true }),
    queryClient.invalidateQueries({ queryKey: ["inbox", "unread"], exact: true }),
    queryClient.invalidateQueries({ queryKey: ["inbox", "search"] }),
    queryClient.invalidateQueries({ queryKey: boardId ? ["board-inbox", boardId] : ["board-inbox"] }),
  ]);
}
