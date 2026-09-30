import { parse, parseFragment, serialize } from 'parse5';
import { supabase } from './database.js';
import { generateMemberPreferencesToken } from '../email-preferences/index.js';

const TOKEN_SOURCE = '\\{\\{\\s*(unsubscribe_(?:link|url)|communication_preferences_(?:link|url))\\s*\\}\\}';
const tokens = () => new RegExp(TOKEN_SOURCE, 'gi');
const hasToken = value => new RegExp(TOKEN_SOURCE, 'i').test(value || '');
export const isPreferencePlaceholder = name => /^(unsubscribe|communication_preferences)_(link|url)$/i.test(String(name).trim());
const FALLBACK = 'Communication preferences unavailable';
const escapeHtml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UNSAFE_ELEMENTS = new Set(['style', 'script', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'template', 'svg', 'math']);
const URL_TEXT_CONTAINERS = new Set(['p', 'div', 'td', 'th', 'li', 'section', 'article', 'footer', 'header', 'blockquote', 'pre']);
const ASCII_SPACE = /[ \t\r\n\f]/;

function standaloneTextToken(source, offset, match) {
  return (offset === 0 || ASCII_SPACE.test(source[offset - 1])) &&
    (offset + match.length === source.length || ASCII_SPACE.test(source[offset + match.length]));
}

function renderPlainText(text, url, state = null) {
  return text.replace(tokens(), (match, name, offset) => {
    if (url && standaloneTextToken(text, offset, match)) {
      if (state) state.hasUsableDestination = true;
      return url;
    }
    return FALLBACK;
  });
}

function singleMailbox(to) {
  const addresses = Array.isArray(to) ? to : [to];
  if (addresses.length !== 1 || typeof addresses[0] !== 'string') return null;
  const value = addresses[0].trim();
  const match = value.match(/^(?:[^<>,;\r\n]*<([^<>\s,;]+)>|([^<>\s,;]+))$/);
  const email = (match?.[1] || match?.[2] || '').toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

function renderHtml(html, url, state = null) {
  if (!hasToken(html)) return html;
  const tree = /<!doctype|<html[\s>]/i.test(html) ? parse(html) : parseFragment(html);
  function visit(node, inAnchor = false, unsafeAncestor = false) {
    const unsafe = unsafeAncestor || UNSAFE_ELEMENTS.has(node.tagName) ||
      (node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml');
    if (node.attrs) {
      const href = node.attrs.find(a => a.name === 'href');
      if (node.tagName === 'a' && href && hasToken(href.value) && !url) {
        node.tagName = 'span';
        node.nodeName = 'span';
        node.attrs = node.attrs.filter(a => !['href', 'target', 'download', 'ping'].includes(a.name));
      }
      node.attrs = node.attrs.filter(attr => {
        if (!hasToken(attr.value)) return true;
        // Bearer URLs belong only in a standalone href, never arbitrary URL
        // prefixes (which could exfiltrate them) or other attributes.
        if (!unsafe && attr.name === 'href' && node.tagName === 'a' && url &&
            new RegExp(`^${TOKEN_SOURCE}$`, 'i').test(attr.value.trim())) {
          attr.value = url;
          if (state) state.hasUsableDestination = true;
          return true;
        }
        return false;
      });
      if (href && url && href.value === url) {
        node.attrs = node.attrs.filter(attr => attr.name !== 'ping' && !attr.name.startsWith('on'));
      }
    }
    if (node.childNodes) {
      const children = [];
      for (const child of node.childNodes) {
        if (child.nodeName === '#text' && hasToken(child.value)) {
          if (unsafe) {
            child.value = child.value.replace(tokens(), FALLBACK);
            children.push(child);
            continue;
          }
          // Bare URLs are only emitted in a standalone token-only text block.
          // Inline sibling markup, punctuation, encoded separators and URL
          // prefixes must never turn the bearer URL into attacker-controlled
          // URL data. Link aliases use an actual generated anchor instead.
          const safeUrlText = !inAnchor && (URL_TEXT_CONTAINERS.has(node.tagName) || node.nodeName === '#document-fragment') &&
            node.childNodes.every(n => n.nodeName === '#text') &&
            child.value.replace(tokens(), '').replace(/[ \t\r\n\f]/g, '') === '';
          const escapedText = escapeHtml(child.value);
          const markup = escapedText.replace(tokens(), (match, name, offset) => {
            if (!url || !standaloneTextToken(escapedText, offset, match)) return FALLBACK;
            if (name.toLowerCase().endsWith('_url')) {
              if (safeUrlText && state) state.hasUsableDestination = true;
              return safeUrlText ? escapeHtml(url) : FALLBACK;
            }
            const label = name.toLowerCase().startsWith('unsubscribe') ? 'Unsubscribe' : 'Manage communication preferences';
            if (inAnchor || node.tagName === 'a') return label;
            if (state) state.hasUsableDestination = true;
            return `<a href="${escapeHtml(url)}" style="color: #666;">${label}</a>`;
          });
          children.push(...parseFragment(markup).childNodes);
        } else {
          visit(child, inAnchor || node.tagName === 'a', unsafe);
          children.push(child);
        }
      }
      node.childNodes = children;
      for (const child of children) child.parentNode = node;
    }
    if (node.content) visit(node.content, inAnchor, true);
  }
  visit(tree);
  // Also remove tokens in comments and unusual raw-text HTML contexts.
  return serialize(tree).replace(tokens(), FALLBACK);
}

// Shared final-envelope renderer for callers that already own a trusted,
// recipient-specific preference URL (campaigns use their tracking identity;
// transactional sends derive one above). The metadata records only destinations
// emitted in parser-approved contexts, never mere token presence.
export function resolveTrustedPreferenceHtml(html, url) {
  const state = { hasUsableDestination: false };
  return {
    value: renderHtml(html, url, state),
    hasUsableDestination: state.hasUsableDestination,
  };
}

export function resolveTrustedPreferenceText(text, url) {
  const state = { hasUsableDestination: false };
  return {
    value: renderPlainText(text, url, state),
    hasUsableDestination: state.hasUsableDestination,
  };
}

/**
 * Final transactional boundary: identity comes from the actual sole envelope
 * recipient, not template/workflow entity data or caller-provided origins.
 * Already-rendered links (including external preference identities) are intact.
 */
export async function resolveTransactionalPreferenceTokens({ html = '', text, subject, to, cc, bcc, tenantId, systemEmail = false }) {
  if (![html, text, subject].some(hasToken)) return { html, text, subject };
  let url = null;
  let reason = 'unsupported-recipient';
  const email = singleMailbox(to);
  const hasRecipients = value => Array.isArray(value) ? value.some(Boolean) : Boolean(value);
  if (email && tenantId && !systemEmail && !hasRecipients(cc) && !hasRecipients(bcc)) {
    try {
      const { data: members, error } = await supabase.from('member')
        .select('id, tenant_id, email').eq('tenant_id', tenantId)
        .ilike('email', email.replace(/[\\%_]/g, '\\$&')).limit(2);
      const member = !error && members?.length === 1 ? members[0] : null;
      if (member?.id && member.tenant_id === tenantId && member.email?.trim().toLowerCase() === email) {
        const { data: tenant, error: tenantError } = await supabase.from('tenant')
          .select('id, slug').eq('id', tenantId).single();
        const domain = process.env.APP_DOMAIN || 'iconn.app';
        if (!tenantError && tenant?.id === tenantId &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(tenant.slug || '') &&
            /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) {
          url = `https://${tenant.slug}.${domain}/email-preferences?t=${generateMemberPreferencesToken(tenantId, member.id)}`;
        } else reason = 'trusted-origin-unavailable';
      } else reason = 'recipient-not-uniquely-verified';
    } catch {
      reason = 'identity-resolution-failed';
    }
  }
  if (!url) console.warn(`[Transactional Preferences] ${reason}; rendering non-clickable fallback`);
  const resolvedHtml = renderHtml(html, url);
  // Explicit text resolves directly; derived text must retain the URL of
  // generated preference anchors rather than losing it when tags are stripped.
  const derivedText = resolvedHtml.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (match, href, label) => url && href === escapeHtml(url) ? `${label} (${url})` : match)
    .replace(/<[^>]*>/g, '');
  return {
    html: resolvedHtml,
    text: typeof text === 'string' && text ? renderPlainText(text, url) : derivedText,
    // Never place bearer credentials in message subjects.
    subject: typeof subject === 'string' ? subject.replace(tokens(), FALLBACK) : subject,
  };
}