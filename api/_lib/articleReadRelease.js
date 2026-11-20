import { articlePublicationDateFilter } from '../../shared/articlePublication.js';

// Authenticated entity reads serve both readers and the editor. Only the
// article's author or a tenant administrator may read ahead of publication.
export async function applyArticleReadRelease(query, ctx, hasAdminAccess, now = new Date()) {
  if (await hasAdminAccess(ctx)) return { query };
  const author = typeof ctx?.memberId === 'string' && /^[0-9a-f-]{36}$/i.test(ctx.memberId)
    ? `,author_id.eq.${ctx.memberId}` : '';
  return { query: query.or(`${articlePublicationDateFilter(now)}${author}`) };
}
