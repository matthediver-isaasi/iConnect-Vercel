// Shared contract and projection for Canvas Builder member-only Custom HTML.
//
// This module intentionally has no framework or database dependencies. Public
// API handlers, SSR/search code, and the client can all use the same recursive
// projection, which is important because a protected block may be nested in a
// flow container, an advanced accordion, a symbol, or a footer design.

export const MEMBER_ONLY_BLOCK_TYPE = 'custom-html';
export const DEFAULT_MEMBER_ONLY_GUEST_MESSAGE =
  'Please login to view this member only content';
export const MEMBER_ONLY_GUEST_MESSAGE_MAX_LENGTH = 500;

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, number) => {
      const codePoint = Number(number);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => {
      const codePoint = parseInt(number, 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : '';
    });
}

/**
 * Normalize the author-controlled guest message to plain text.
 *
 * This is deliberately not an HTML sanitizer: a guest message is a text
 * contract, so markup is removed rather than retained. Script/style contents
 * are discarded as well, preventing an author from hiding active markup in a
 * message that is later rendered as text.
 */
export function normalizeMemberOnlyGuestMessage(value) {
  const source = typeof value === 'string' ? value : '';
  const plainText = decodeHtmlEntities(
    source
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

  if (!plainText) return DEFAULT_MEMBER_ONLY_GUEST_MESSAGE;
  return plainText
    .slice(0, MEMBER_ONLY_GUEST_MESSAGE_MAX_LENGTH)
    .trimEnd();
}

/**
 * Normalize the shared Custom HTML content contract for authoring/storage.
 * Callers that need byte-compatible legacy documents may choose not to add
 * these defaults until a block is edited; a missing memberOnly value still
 * means false everywhere.
 */
export function normalizeMemberOnlyContent(content) {
  const source = content && typeof content === 'object' && !Array.isArray(content)
    ? content
    : {};
  return {
    ...source,
    memberOnly: source.memberOnly === true,
    guestMessage: normalizeMemberOnlyGuestMessage(source.guestMessage),
  };
}

/**
 * Apply the authoring contract to every Custom HTML block in a JSON design
 * while retaining its HTML for trusted authoring responses. This is separate
 * from the guest projection: it does not remove content.html.
 */
export function normalizeMemberOnlyFields(value) {
  if (!isObject(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeMemberOnlyFields);

  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = normalizeMemberOnlyFields(child);
  }
  if (
    value.type === MEMBER_ONLY_BLOCK_TYPE
    && isObject(value.content)
    && !Array.isArray(value.content)
  ) {
    normalized.content = normalizeMemberOnlyContent(value.content);
  }
  return normalized;
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

/**
 * Recursively project a Canvas JSON value for a guest.
 *
 * A redacted block retains its frame and non-sensitive presentation fields,
 * but its actual content.html is omitted. The explicit marker tells the
 * renderer to show its non-sensitive login placeholder rather than treating
 * the block as an empty legacy block.
 *
 * `allowMemberOnlyContent` is intentionally opt-in. Any caller that cannot
 * prove a trusted tenant session should use the default guest projection.
 */
export function projectMemberOnlyGuest(value, { allowMemberOnlyContent = false } = {}) {
  if (!isObject(value)) return value;
  if (allowMemberOnlyContent) {
    if (Array.isArray(value)) return value.map((item) => projectMemberOnlyGuest(item, { allowMemberOnlyContent: true }));
    const copy = {};
    for (const [key, child] of Object.entries(value)) {
      copy[key] = projectMemberOnlyGuest(child, { allowMemberOnlyContent: true });
    }
    return copy;
  }

  if (Array.isArray(value)) {
    return value.map((item) => projectMemberOnlyGuest(item));
  }

  if (
    value.type === MEMBER_ONLY_BLOCK_TYPE
    && isObject(value.content)
    && value.content.memberOnly === true
  ) {
    const redactedContent = {};
    for (const [key, child] of Object.entries(value.content)) {
      // The sensitive field is omitted, not replaced by an empty value. This
      // prevents accidental fallback paths from receiving the source HTML.
      if (key === 'html') continue;
      redactedContent[key] = projectMemberOnlyGuest(child);
    }
    redactedContent.memberOnly = true;
    redactedContent.guestMessage = normalizeMemberOnlyGuestMessage(
      value.content.guestMessage
    );
    redactedContent.memberOnlyRedacted = true;

    const projected = {};
    for (const [key, child] of Object.entries(value)) {
      projected[key] = key === 'content'
        ? redactedContent
        : projectMemberOnlyGuest(child);
    }
    return projected;
  }

  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    projected[key] = projectMemberOnlyGuest(child);
  }
  return projected;
}

export function projectCanvasDesignForGuest(design) {
  return projectMemberOnlyGuest(design);
}
