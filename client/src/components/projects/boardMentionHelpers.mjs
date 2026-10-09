// Use the tenant identity's literal name. Do not abbreviate or normalize labels.
export function mentionLabel(member) {
  return [member?.first_name, member?.last_name].filter(Boolean).join(" ").trim() || member?.email || "";
}

export function boardMentionOptions(members = []) {
  const seen = new Set();
  return members.flatMap((member) => {
    const label = mentionLabel(member);
    if (!member.identity_id || !label || seen.has(member.identity_id)) return [];
    seen.add(member.identity_id);
    return [{ id: member.identity_id, label, email: member.email || "" }];
  });
}

export function retainedMentions(content, picked = [], members = []) {
  const current = new Map(boardMentionOptions(members).map((member) => [member.id, member.label]));
  const seen = new Set();
  return picked.filter((mention) => {
    if (seen.has(mention.id) || current.get(mention.id) !== mention.label || !content.includes(`@${mention.label}`)) return false;
    seen.add(mention.id);
    return true;
  });
}

export function mentionIdentityIds(content, picked, members) {
  return retainedMentions(content, picked, members).map((mention) => mention.id);
}

export function mentionTrigger(content, caret) {
  const before = content.slice(0, caret);
  // A whitespace boundary avoids turning email addresses into a picker.
  const match = before.match(/(?:^|\s)@([^@\n\r]*)$/);
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null;
}

export function insertMention(content, trigger, member) {
  const inserted = `@${member.label} `;
  return {
    content: content.slice(0, trigger.start) + inserted + content.slice(trigger.end),
    caret: trigger.start + inserted.length,
  };
}

export function availableInboxCard(result, boardId) {
  const card = result?.card;
  if (!card || card.is_archived || card.archived_at || card.deleted_at) {
    throw new Error("This card was deleted or archived and can no longer be opened.");
  }
  if (!card.board_id || String(card.board_id) !== String(boardId)) {
    throw new Error("This card is no longer on this board.");
  }
  return card;
}

export function inboxCardError(error) {
  if ([404, 410].includes(error?.status)) return "This card was deleted or archived and can no longer be opened.";
  if (error?.status === 403) return "You no longer have access to this card.";
  return error?.message || "Could not open this card. Please try again.";
}
