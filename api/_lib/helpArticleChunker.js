// Task #2257: Help Center AI Q&A.
//
// Splits a help_article body into retrieval chunks, computing the effective
// feature-gate(s) that apply to each chunk. This MUST mirror the section-gating
// DSL parsed for display in client/src/components/help/HelpArticleContent.jsx so
// that what the AI can retrieve exactly matches what the reader is allowed to
// see on the page:
//
//   {{feature: some.key}} ... {{/feature}}   RBAC section gate (nestable)
//   {{screenshot: Label | url}}              non-text placeholder (label kept)
//   # / ## / ###                             headings (start a new chunk)
//
// A chunk's `featureGates` is the set of keys the reader must be able to access
// for that chunk to be visible: the article's `required_feature` (if any) plus
// every enclosing {{feature}} key. Empty keys ({{feature:}}) are ignored for
// gating but still count toward nesting depth, matching the renderer.

const SCREENSHOT_RE = /\{\{\s*screenshot\s*:\s*([^}]*)\}\}/i;
const FEATURE_OPEN_RE = /^\{\{\s*feature\s*:\s*([^}]*)\}\}$/i;
const FEATURE_CLOSE_RE = /^\{\{\s*\/\s*feature\s*\}\}$/i;

// Soft ceiling for a single chunk. Long sections are split at paragraph
// boundaries so embeddings stay focused and retrieval is granular.
const MAX_CHUNK_CHARS = 1500;

function splitLargeChunk(content) {
  if (content.length <= MAX_CHUNK_CHARS) return [content];
  const paragraphs = content.split(/\n\s*\n/);
  const out = [];
  let current = '';
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > MAX_CHUNK_CHARS && current) {
      out.push(current.trim());
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.length ? out : [content];
}

/**
 * Chunk an article body.
 *
 * @param {string} body                raw article body
 * @param {object} opts
 * @param {string|null} opts.requiredFeature  article-level required_feature key
 * @returns {Array<{ chunkIndex:number, content:string, featureGates:string[] }>}
 */
export function chunkArticleBody(body, { requiredFeature } = {}) {
  const source = typeof body === 'string' ? body : '';
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  const baseGate =
    requiredFeature && String(requiredFeature).trim()
      ? [String(requiredFeature).trim()]
      : [];

  // Stack of feature keys for open {{feature}} markers (empty strings allowed,
  // so nesting depth matches the renderer even for un-keyed gates).
  const gateStack = [];
  const sections = [];
  let buffer = [];

  const activeGates = () => {
    const set = new Set(baseGate);
    for (const g of gateStack) {
      if (g) set.add(g);
    }
    return Array.from(set);
  };

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) {
      sections.push({ content: text, featureGates: activeGates() });
    }
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const openMatch = line.match(FEATURE_OPEN_RE);
    if (openMatch) {
      flush();
      gateStack.push(openMatch[1].trim());
      continue;
    }
    if (FEATURE_CLOSE_RE.test(line)) {
      flush();
      if (gateStack.length) gateStack.pop();
      continue;
    }

    // Screenshots are non-textual; keep only the human label for context.
    const shot = line.match(SCREENSHOT_RE);
    if (shot) {
      const label = (shot[1] || '').split('|')[0].trim();
      if (label) buffer.push(label);
      continue;
    }

    // Headings start a fresh chunk and lead it (heading text kept as context).
    if (line.startsWith('### ') || line.startsWith('## ') || line.startsWith('# ')) {
      flush();
      buffer.push(line.replace(/^#{1,3}\s+/, '').trim());
      continue;
    }

    buffer.push(line);
  }
  flush();

  // Split oversized sections and assign a stable ordering index.
  const chunks = [];
  let index = 0;
  for (const section of sections) {
    for (const piece of splitLargeChunk(section.content)) {
      const text = piece.trim();
      if (!text) continue;
      chunks.push({
        chunkIndex: index++,
        content: text,
        featureGates: section.featureGates,
      });
    }
  }
  return chunks;
}
