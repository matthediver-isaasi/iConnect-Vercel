// Null dates are legacy immediately-published posts; malformed dates fail closed.
export function isArticlePublished(article, now = Date.now()) {
  if (article?.status !== 'published') return false;
  if (article.published_date == null || article.published_date === '') return true;
  const date = Date.parse(article.published_date);
  return Number.isFinite(date) && date <= Number(now);
}

export function articlePublicationDateFilter(now = new Date()) {
  return `published_date.is.null,published_date.lte.${now.toISOString()}`;
}
