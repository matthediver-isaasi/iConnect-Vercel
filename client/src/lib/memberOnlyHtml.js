// Shared contracts for member-only Custom HTML blocks. Keep these helpers
// React-free so the editor, renderers and persistence tests use one
// normalization path.
import {
  DEFAULT_MEMBER_ONLY_GUEST_MESSAGE as SHARED_DEFAULT_MEMBER_ONLY_GUEST_MESSAGE,
  MEMBER_ONLY_GUEST_MESSAGE_MAX_LENGTH,
} from '../../../shared/canvasMemberOnly.js';

export const DEFAULT_MEMBER_ONLY_GUEST_MESSAGE = SHARED_DEFAULT_MEMBER_ONLY_GUEST_MESSAGE;

// Guest copy is intentionally bounded: it is displayed in a compact redacted
// placeholder and is never treated as HTML. Keep this in sync with the shared
// server projection contract.
export const MAX_MEMBER_ONLY_GUEST_MESSAGE_LENGTH = MEMBER_ONLY_GUEST_MESSAGE_MAX_LENGTH;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HTML_TAG = /<[^>]*>/g;

function decodeNumericEntity(match, radix, digits) {
  const codePoint = parseInt(digits, radix);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : match;
}

/**
 * Convert an authored guest message to plain text without relying on a DOM.
 * The value is bounded here as well as by the inspector's maxLength so data
 * arriving from older clients or the API cannot grow without limit.
 */
export function toMemberOnlyPlainText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(HTML_TAG, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (match, digits) => decodeNumericEntity(match, 10, digits))
    .replace(/&#x([0-9a-f]+);/gi, (match, digits) => decodeNumericEntity(match, 16, digits))
    .replace(CONTROL_CHARACTERS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MEMBER_ONLY_GUEST_MESSAGE_LENGTH);
}

export function normalizeMemberOnlyGuestMessage(value) {
  return toMemberOnlyPlainText(value) || DEFAULT_MEMBER_ONLY_GUEST_MESSAGE;
}

/**
 * Normalize only the security-sensitive member-only fields while preserving
 * all other Custom HTML content fields. The redaction marker is server-owned;
 * clients only preserve a strict boolean value when one is supplied.
 */
export function normalizeMemberOnlyContent(content = {}) {
  const source = content && typeof content === 'object' && !Array.isArray(content)
    ? content
    : {};
  return {
    ...source,
    memberOnly: source.memberOnly === true,
    guestMessage: normalizeMemberOnlyGuestMessage(source.guestMessage),
    ...(source.memberOnlyRedacted === true ? { memberOnlyRedacted: true } : {}),
  };
}

/**
 * Return an internal path/query/hash suitable for a login returnTo value.
 * Never accept absolute URLs, protocol-relative URLs, backslashes or control
 * characters. This deliberately preserves the current query and hash so a
 * member returns to the exact page state that prompted login.
 */
export function getValidatedReturnTo(locationLike, fallback = '/') {
  const path = typeof locationLike?.pathname === 'string'
    ? locationLike.pathname
    : (typeof window !== 'undefined' ? window.location.pathname : fallback);
  const search = typeof locationLike?.search === 'string'
    ? locationLike.search
    : (typeof window !== 'undefined' ? window.location.search : '');
  const hash = typeof locationLike?.hash === 'string'
    ? locationLike.hash
    : (typeof window !== 'undefined' ? window.location.hash : '');
  const candidate = `${path || ''}${search || ''}${hash || ''}`;
  if (
    !candidate ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    /[\u0000-\u001F\u007F]/.test(candidate)
  ) {
    return fallback;
  }
  try {
    const parsed = new URL(candidate, 'https://internal.invalid');
    if (parsed.origin !== 'https://internal.invalid') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || fallback;
  } catch {
    return fallback;
  }
}
