// Pure helper for building the author-handle segment of article URLs
// (/articles/{authorHandle}/{articleSlug}). Extracted from
// ArticleUrlContext.jsx so it can be unit-tested without React.
//
// Handle resolution rules:
// - Guest-writer articles use the reserved segment 'guest'.
// - Member-authored articles use the author's handle from the lookup map,
//   falling back to a legacy "-by-{handle}" slug suffix.
// - When a member author's handle is unknown, the segment falls back to the
//   reserved placeholder 'member' — NEVER 'guest'. The guest endpoint only
//   serves guest-writer articles, so a 'guest' link for a member-authored
//   article 404s; the article APIs resolve any non-guest segment by slug.
export const MEMBER_HANDLE_FALLBACK = 'member';

export function getArticleUrlParts(article, authorHandles = {}) {
  // Determine author handle
  let authorHandle;
  if (article.guest_writer_id && !article.author_id) {
    authorHandle = 'guest';
  } else {
    authorHandle = MEMBER_HANDLE_FALLBACK;
    if (authorHandles[article.author_id]) {
      authorHandle = authorHandles[article.author_id];
    } else {
      // Fallback: extract from legacy slug format "-by-{handle}"
      const byHandleMatch = (article.slug || "").match(/-by-([a-z0-9-]+)$/i);
      if (byHandleMatch) {
        authorHandle = byHandleMatch[1];
      }
    }
  }

  // Get clean slug without handle suffix
  let cleanSlug = article.slug || "";
  const byHandleMatch = cleanSlug.match(/-by-([a-z0-9-]+)$/i);
  if (byHandleMatch) {
    cleanSlug = cleanSlug.slice(0, -byHandleMatch[0].length);
  }

  return { authorHandle, cleanSlug };
}

// True when a stored article slug matches a requested (clean) slug, honoring
// the legacy "-by-{handle}" suffix. Handles may themselves contain hyphens
// (e.g. "post-by-aisha-rahman" matches "post"), so the suffix pattern must be
// the same [a-z0-9-]+ class used by getArticleUrlParts — NOT [^-]+.
export function articleSlugMatches(storedSlug, targetSlug) {
  if (!storedSlug || !targetSlug) return false;
  if (storedSlug === targetSlug) return true;
  const byHandleMatch = storedSlug.match(/-by-([a-z0-9-]+)$/i);
  if (byHandleMatch) {
    return storedSlug.slice(0, -byHandleMatch[0].length) === targetSlug;
  }
  return false;
}
