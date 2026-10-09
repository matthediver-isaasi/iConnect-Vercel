// Project notifications are projected into the member inbox, never copied.
// Resolve the effective member, not the admin's identity during masquerading.
export async function projectInboxScope(db, ctx) {
  const { data, error } = await db.from('member').select('identity_id')
    .eq('id', ctx.memberId).eq('tenant_id', ctx.tenantId).maybeSingle();
  if (error) throw error;
  if (!data?.identity_id) return null;
  const identityId = data.identity_id;
  return {
    identityId,
    query: (columns = '*', options) => db.from('project_mention_inbox_visible')
      .select(columns, options).eq('tenant_id', ctx.tenantId).eq('recipient_id', identityId),
  };
}

export function projectMessage(row) {
  return {
    recipient_id: row.id, campaign_id: null, source: 'project', label: 'Project mentions',
    name: row.board_name || '', subject: `Mentioned in ${row.card_title || 'a card'}`,
    preheader: row.content || '', from_name: row.author_name || 'Board member', from_email: '',
    sent_at: row.created_at, board_id: row.board_id, card_id: row.card_id, card_title: row.card_title,
    member_group_id: null, is_read: !!row.read_at, read_at: row.read_at,
    is_pinned: !!row.pinned_at, is_archived: !!row.is_archived,
    is_favourite: !!row.is_favourite, folder_id: row.folder_id || null,
  };
}

export async function fetchProjectMessages(db, ctx) {
  const scope = await projectInboxScope(db, ctx);
  if (!scope) return [];
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await scope.query()
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + 499);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows.map(projectMessage);
  }
}

export async function projectUnreadSummary(db, ctx) {
  const scope = await projectInboxScope(db, ctx);
  if (!scope) return { count: 0, latest: null };
  const result = await scope.query('id,created_at,card_title', { count: 'exact' })
    .is('read_at', null).eq('is_archived', false)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (result.error) throw result.error;
  const row = result.data?.[0];
  return {
    count: result.count || 0,
    latest: row ? { subject: `Mentioned in ${row.card_title || 'a card'}`, recipientId: row.id, sentAt: row.created_at } : null,
  };
}

export async function verifyProjectMessages(scope, ids) {
  if (!scope) throw Object.assign(new Error('Message not found'), { status: 404 });
  for (let offset = 0; offset < ids.length; offset += 150) {
    const batch = ids.slice(offset, offset + 150);
    const { data, error } = await scope.query('id').in('id', batch);
    if (error) throw error;
    if (data.length !== batch.length) throw Object.assign(new Error('Message not found'), { status: 404 });
  }
}

export async function updateProjectMessages(db, scope, ids, action, folderId) {
  const now = new Date().toISOString();
  const patches = {
    read: { read_at: now }, unread: { read_at: null },
    pin: { pinned_at: now }, unpin: { pinned_at: null },
    archive: { is_archived: true }, unarchive: { is_archived: false },
    favourite: { is_favourite: true }, unfavourite: { is_favourite: false },
    move: { folder_id: folderId || null },
  };
  if (!patches[action]) throw Object.assign(new Error('Invalid project message action'), { status: 400 });
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += 150) {
    const { data, error } = await db.from('project_mention_inbox').update(patches[action])
      .eq('recipient_id', scope.identityId).in('id', ids.slice(offset, offset + 150)).select('*');
    if (error) throw error;
    rows.push(...(data || []).map(projectMessage));
  }
  return rows;
}

export const projectMessageHtml = text => `<p style="white-space:pre-wrap">${String(text || '').replace(/[&<>"']/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])}</p>`;
