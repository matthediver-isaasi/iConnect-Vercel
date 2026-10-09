// Build this only on demand. Return searchable text, not copies of child records.
const PAGE_SIZE = 500;
const ACTION_TEXT = {
  created: 'created this card', updated: 'updated this card', completed: 'completed this card',
  reopened: 'reopened this card', archived: 'archived this card', moved: 'moved this card',
  assigned: 'assigned', unassigned: 'unassigned', cover_set: 'changed the cover',
  cover_cleared: 'removed the cover', attachment_added: 'added attachment',
  attachment_deleted: 'removed attachment', commented: 'added a comment',
};

function textValues(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (value && typeof value === 'object') return Object.entries(value)
    .filter(([key]) => !/(?:^|_)(?:id|ids|url|path|token)$/.test(key))
    .flatMap(([, child]) => textValues(child));
  return [];
}

export async function buildProjectBoardSearchIndex(db, cards, lists = [], members = []) {
  const documents = new Map(cards.map(card => [card.id, [card.title || '', card.description || '']]));
  const names = new Map(members.map(member => [member.identity_id,
    [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email || 'Board member']));
  const listNames = new Map(lists.map(list => [list.id, list.name]));
  const ids = [...documents.keys()];
  // IDs come only from the already-authorized board query, never request input.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    for (const [table, columns] of [
      ['project_card_comment', 'id,card_id,content'],
      ['project_card_activity', 'id,card_id,identity_id,action_type,action_data'],
    ]) {
      for (let start = 0; ; start += PAGE_SIZE) {
        const { data, error } = await db.from(table).select(columns).in('card_id', batch)
          .order('id', { ascending: true }).range(start, start + PAGE_SIZE - 1);
        if (error) throw error;
        for (const row of data || []) {
          const texts = documents.get(row.card_id);
          if (!texts) continue;
          if (table === 'project_card_comment') texts.push(row.content || '');
          else {
            const details = row.action_data || {};
            texts.push(ACTION_TEXT[row.action_type] || String(row.action_type || '').replaceAll('_', ' '),
              ...textValues(details), names.get(row.identity_id) || '',
              names.get(details.assignee_id) || '',
              listNames.get(details.to_list || details.moved_to_list) || '',
              listNames.get(details.from_list) || '');
          }
        }
        if (!data || data.length < PAGE_SIZE) break;
      }
    }
  }
  return { documents: [...documents].map(([cardId, texts]) => ({ cardId, text: texts.filter(Boolean).join('\n') })) };
}
