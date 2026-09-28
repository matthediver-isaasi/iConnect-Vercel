// Server-owned provenance for Member AI answers and citations.
//
// Conversation writes happen in a separate browser request from /ask.  The
// browser is consequently not an authority for the citations attached to an
// assistant reply.  /ask signs the exact answer and server-derived source
// provenance; history endpoints accept that signed envelope only.

import crypto from 'node:crypto';

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_SOURCES = 16;
const ALLOWED_TYPES = new Set([
  'resource',
  'event',
  'complex_event',
  'news_post',
  'blog_post',
  'canvas_page',
]);

function secret() {
  // SESSION_SECRET is already the server-side signing root for the platform.
  // A dedicated value permits independent rotation where it is configured.
  return (
    process.env.MEMBER_AI_PROVENANCE_SECRET ||
    process.env.SESSION_SECRET ||
    // Match the legacy session fallback so local development remains usable.
    // Production must set a strong SESSION_SECRET (as the session subsystem
    // already requires).
    'iconnect-session-secret-change-in-production'
  );
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function answerHash(answer) {
  return crypto.createHash('sha256').update(String(answer)).digest('hex');
}

export function makeStructuredAccessFingerprint({ tenantId, memberId, roleId, groupIds, exclusions }) {
  if (!tenantId || !memberId) return null;
  const canonical = JSON.stringify({
    tenantId,
    memberId,
    roleId: roleId || null,
    groupIds: [...(groupIds || [])].sort(),
    exclusions: [...(exclusions || [])].sort(),
  });
  return crypto.createHmac('sha256', secret()).update(canonical).digest('hex');
}

function safeDependency(dependency) {
  if (
    !dependency ||
    !['file_repository', 'canvas_symbol'].includes(dependency.contentType) ||
    typeof dependency.sourceId !== 'string' ||
    !dependency.sourceId
  ) return null;
  const generation = dependency.generation;
  if (
    !(
      (typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0) ||
      (typeof generation === 'string' && /^\d+$/.test(generation))
    )
  ) return null;
  return {
    contentType: dependency.contentType,
    sourceId: dependency.sourceId.slice(0, 100),
    generation: String(generation),
  };
}

function safeProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') return {};
  const dependencies = Array.isArray(provenance.dependencies)
    ? provenance.dependencies.map(safeDependency).filter(Boolean)
    : [];
  // Keep only the fields the current reauthorizer evaluates. This makes the
  // signed envelope both small and an explicit dependency fence.
  if (provenance.kind === 'resource_pdf') {
    if (typeof provenance.fileId !== 'string' || !provenance.fileId) return null;
    if (!dependencies.some(
      (dependency) =>
        dependency.contentType === 'file_repository' &&
        dependency.sourceId === provenance.fileId
    )) return null;
    return {
      kind: 'resource_pdf',
      fileId: provenance.fileId.slice(0, 100),
      dependencies,
    };
  }
  return dependencies.length ? { dependencies } : {};
}

function safeSource(source) {
  if (!source || !ALLOWED_TYPES.has(source.type) || typeof source.sourceId !== 'string') {
    return null;
  }
  const generation = source.sourceGeneration;
  if (
    !(
      (typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0) ||
      (typeof generation === 'string' && /^\d+$/.test(generation))
    )
  ) return null;
  const rawSupportingProvenance = Array.isArray(source.supportingProvenance)
    ? source.supportingProvenance
    : [source.provenance];
  const supportingProvenance = rawSupportingProvenance
    .map(safeProvenance);
  // Do not discard just the PDF provenance from a mixed metadata/PDF citation:
  // that would reintroduce the "first chunk wins" revocation bypass.
  if (supportingProvenance.some((entry) => entry === null)) return null;
  return {
    citationId: typeof source.citationId === 'string' ? source.citationId.slice(0, 12) : null,
    title: typeof source.title === 'string' ? source.title.slice(0, 300) : '(untitled)',
    type: source.type,
    typeLabel: typeof source.typeLabel === 'string' ? source.typeLabel.slice(0, 50) : 'Item',
    // Links are derived from an authorized source, never model output.
    link: typeof source.link === 'string' && source.link.startsWith('/') ? source.link.slice(0, 1000) : null,
    sourceId: source.sourceId.slice(0, 100),
    // Registry generation is the durable source fence. Timestamps are not
    // reliable enough: many source tables lack an updated_at column.
    sourceGeneration: String(generation),
    accessScope: source.accessScope === 'authenticated' ? 'authenticated' : 'public',
    // A single citation can represent title/metadata and multiple derived
    // chunks (for example a PDF). Preserve the union rather than whichever
    // chunk ranked first, so any revoked dependency invalidates the reply.
    supportingProvenance: supportingProvenance
      .filter((entry, index, all) =>
        all.findIndex((other) => JSON.stringify(other) === JSON.stringify(entry)) === index
      )
      .slice(0, 64),
  };
}

export function makeCitationSources(chunks, labels = {}) {
  const sources = [];
  const chunksByKey = new Map();
  for (const chunk of chunks || []) {
    const key = `${chunk?.content_type}:${chunk?.source_id}`;
    if (!chunk?.source_id) continue;
    if (!chunksByKey.has(key)) chunksByKey.set(key, []);
    chunksByKey.get(key).push(chunk);
  }
  const sourceByKey = new Map();
  for (const [key, supportingChunks] of chunksByKey) {
    const chunk = supportingChunks[0];
    const citationId = `S${sources.length + 1}`;
    const source = safeSource({
      citationId,
      title: chunk.title,
      type: chunk.content_type,
      typeLabel: labels[chunk.content_type] || 'Item',
      link: chunk.link,
      sourceId: chunk.source_id,
      sourceGeneration: chunk.source_generation,
      accessScope: chunk.access_scope,
      supportingProvenance: supportingChunks.map((entry) => entry.provenance),
    });
    // A chunk without its new source fence cannot safely be cited or stored.
    if (!source) continue;
    sources.push(source);
    sourceByKey.set(key, source);
  }
  return { sources, sourceByKey };
}

export function sourceCitationId(chunk, sourceByKey) {
  return sourceByKey.get(`${chunk?.content_type}:${chunk?.source_id}`)?.citationId || null;
}

export function citationIdsInAnswer(answer) {
  const ids = new Set();
  const text = typeof answer === 'string' ? answer : '';
  for (const match of text.matchAll(/\[([A-Za-z][A-Za-z0-9_-]{0,11})\]/g)) {
    ids.add(match[1]);
  }
  return ids;
}

export function validateAnswerCitations(answer, sources) {
  // Source links are rendered only from the server-provided cards. A generated
  // URL could lead a member to a preview, storage credential, or unrelated
  // destination, so it is never accepted as an answer citation.
  if (/(?:https?:\/\/|www\.)/i.test(String(answer || ''))) {
    return { ok: false, reason: 'model_url' };
  }
  const known = new Set((sources || []).map((source) => source.citationId).filter(Boolean));
  const used = citationIdsInAnswer(answer);
  if ([...used].some((id) => !known.has(id))) {
    return { ok: false, reason: 'unknown_citation' };
  }
  if (sources?.length && used.size === 0) {
    return { ok: false, reason: 'missing_citation' };
  }
  const citedSources = (sources || []).filter((source) => used.has(source.citationId));
  return { ok: true, sources: citedSources, citationIds: [...used] };
}

export function makeAnswerProvenance({
  tenantId, memberId, answer, sources, answerKind = 'content',
  structuredAccessFingerprint = null, now = Date.now(),
}) {
  const signingSecret = secret();
  if (!signingSecret || !tenantId || !memberId) return null;
  const payload = {
    v: 1,
    tenantId,
    memberId,
    answerHash: answerHash(answer),
    issuedAt: now,
    answerKind: answerKind === 'structured' ? 'structured' : 'content',
    structuredAccessFingerprint:
      answerKind === 'structured' && /^[a-f0-9]{64}$/.test(structuredAccessFingerprint || '')
        ? structuredAccessFingerprint
        : null,
    sources: (sources || []).map(safeSource).filter(Boolean).slice(0, MAX_SOURCES),
  };
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', signingSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyAnswerProvenance(token, { tenantId, memberId, answer, now = Date.now() } = {}) {
  const signingSecret = secret();
  if (!signingSecret || typeof token !== 'string') return null;
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (!encoded || !suppliedSignature || extra) return null;
  const expected = crypto.createHmac('sha256', signingSecret).update(encoded).digest('base64url');
  const supplied = Buffer.from(suppliedSignature);
  const calculated = Buffer.from(expected);
  if (supplied.length !== calculated.length || !crypto.timingSafeEqual(supplied, calculated)) return null;
  let payload;
  try {
    payload = JSON.parse(fromBase64url(encoded));
  } catch {
    return null;
  }
  if (
    payload?.v !== 1 ||
    payload.tenantId !== tenantId ||
    payload.memberId !== memberId ||
    !Number.isFinite(payload.issuedAt) ||
    now - payload.issuedAt > TOKEN_TTL_MS ||
    payload.issuedAt - now > 60_000 ||
    payload.answerHash !== answerHash(answer) ||
    !Array.isArray(payload.sources)
  ) {
    return null;
  }
  const sources = payload.sources.map(safeSource).filter(Boolean);
  if (sources.length !== payload.sources.length || sources.length > MAX_SOURCES) return null;
  return {
    sources,
    answerKind: payload.answerKind === 'structured' ? 'structured' : 'content',
    structuredAccessFingerprint:
      /^[a-f0-9]{64}$/.test(payload.structuredAccessFingerprint || '')
        ? payload.structuredAccessFingerprint
        : null,
  };
}