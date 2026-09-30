// AI Design Studio V2 Phase 2 (Task #2906) — the action system.
//
// V2 code packages express navigation intent through `data-ai-action` keys in
// the sanitised HTML plus a keyed `actions` list in the document. The model
// NEVER invents internal URLs: record-backed action types carry a free-text
// `hint` (a search phrase) which the server resolves against real tenant
// records after generation. Each action ends up either:
//   { ...action, resolved: true,  href, recordId?, recordTitle?, slug? }
//   { ...action, resolved: false, unresolvedReason }
// The client only ever navigates using the server-produced `href`; unresolved
// actions render as inert placeholders and block publishing (spec: publish
// gate) until an editor resolves them via /api/ai-compositions/resolve-action.
//
// Pure helpers take injected lookups so they are unit-testable without a DB;
// `makeSupabaseActionLookups` builds the real tenant-scoped lookups.

import { AI_CODE_ACTION_TYPES } from './aiCodePackageSchema.js';

const IDENT_RE = /^[a-zA-Z0-9_-]+$/;
const ANCHOR_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEL_RE = /^\+?[0-9 ()-]{5,25}$/;

const ident = (v) => (typeof v === 'string' && IDENT_RE.test(v) ? v : null);

/**
 * Validate an external URL for use in a generated composition.
 * https-only, no embedded credentials, no fragments-only tricks, sane length.
 * Returns { ok: true, url } (normalised) or { ok: false, error }.
 */
export function validateExternalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'URL is required' };
  const s = raw.trim();
  if (s.length > 2000) return { ok: false, error: 'URL is too long' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: 'URL is not valid' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'Only https:// URLs are allowed' };
  if (u.username || u.password) return { ok: false, error: 'URLs with credentials are not allowed' };
  if (!u.hostname || !u.hostname.includes('.')) return { ok: false, error: 'URL host is not valid' };
  return { ok: true, url: u.toString() };
}

/**
 * Build the canonical in-app href for a RESOLVED action. Mirrors the V1
 * `aicLinkHref` conventions (client/src/lib/aiCompositionRender.js) so both
 * studios navigate identically. Returns null when the action cannot produce
 * a navigable href (caller marks it unresolved).
 */
export function buildActionHref(action) {
  if (!action || typeof action !== 'object') return null;
  switch (action.type) {
    case 'external_url': {
      const v = validateExternalUrl(action.url);
      return v.ok ? v.url : null;
    }
    case 'anchor':
      return typeof action.anchorId === 'string' && ANCHOR_RE.test(action.anchorId)
        ? `#${action.anchorId}` : null;
    case 'email':
      return typeof action.address === 'string' && EMAIL_RE.test(action.address)
        ? `mailto:${action.address}` : null;
    case 'tel':
      return typeof action.number === 'string' && TEL_RE.test(action.number.trim())
        ? `tel:${action.number.trim().replace(/[ ()-]/g, '')}` : null;
    case 'internal_page':
      return ident(action.slug) ? `/${action.slug}` : null;
    case 'event':
      return ident(action.recordId) ? `/EventDetails?id=${action.recordId}` : null;
    case 'event_registration':
      return ident(action.recordId) ? `/EventDetails?id=${action.recordId}&register=1` : null;
    case 'form':
      return ident(action.slug) ? `/FormView?slug=${action.slug}` : null;
    case 'membership_application':
      return ident(action.recordId)
        ? `/MembershipApplication?tier=${action.recordId}`
        : '/MembershipApplication';
    case 'document':
      return typeof action.fileUrl === 'string' && action.fileUrl ? action.fileUrl : null;
    default:
      return null;
  }
}

/** Action types resolved deterministically (no tenant record lookup). */
const SELF_RESOLVING = new Set(['external_url', 'anchor', 'email', 'tel']);

/** Which lookup each record-backed action type uses. */
const ACTION_LOOKUP = {
  internal_page: 'findPage',
  event: 'findEvent',
  event_registration: 'findEvent',
  form: 'findForm',
  membership_application: 'findMembershipTier',
  document: 'findDocument',
};

/**
 * Resolve a document's actions. `lookups` is an object of async functions
 * (hint) => ({ id, slug?, title?, fileUrl? } | null):
 *   findPage, findEvent, findForm, findMembershipTier, findDocument
 * Pure apart from the injected lookups; never throws on a failed lookup —
 * the action is simply left unresolved.
 */
export async function resolveCodeActions(actions, lookups = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const out = [];
  for (const action of list) {
    if (!action || typeof action !== 'object' || !AI_CODE_ACTION_TYPES.has(action.type)) {
      out.push({ ...action, resolved: false, unresolvedReason: 'Unsupported action type' });
      continue;
    }
    if (SELF_RESOLVING.has(action.type)) {
      const href = buildActionHref(action);
      out.push(href
        ? { ...action, resolved: true, href }
        : { ...action, resolved: false, unresolvedReason: invalidReason(action) });
      continue;
    }
    // Record-backed: resolve the hint against real tenant records.
    const lookupName = ACTION_LOOKUP[action.type];
    const lookup = lookups[lookupName];
    const hint = typeof action.hint === 'string' ? action.hint.trim() : '';
    let record = null;
    if (typeof lookup === 'function' && hint) {
      try { record = await lookup(hint); } catch { record = null; }
    }
    if (!record || !record.id) {
      out.push({ ...action, resolved: false, unresolvedReason: hint ? `No matching record for "${hint}"` : 'No record hint provided' });
      continue;
    }
    const enriched = {
      ...action,
      recordId: String(record.id),
      slug: record.slug || action.slug || null,
      recordTitle: record.title || null,
      fileUrl: record.fileUrl || null,
    };
    const href = buildActionHref(enriched);
    out.push(href
      ? { ...enriched, resolved: true, href }
      : { ...enriched, resolved: false, unresolvedReason: 'Matched record has no navigable URL' });
  }
  return out;
}

function invalidReason(action) {
  switch (action.type) {
    case 'external_url': return validateExternalUrl(action.url).error || 'Invalid URL';
    case 'anchor': return 'Invalid anchor id';
    case 'email': return 'Invalid email address';
    case 'tel': return 'Invalid phone number';
    default: return 'Could not resolve action';
  }
}

/**
 * Unresolved action keys for a stored V2 document — the publish gate.
 * Only counts actions actually referenced from the sanitised HTML
 * (`sanitisation.actionKeys` recorded by the pipeline) so an orphan list
 * entry the markup never uses cannot block publishing. Falls back to the
 * full actions list when referenced keys are unknown.
 */
export function unresolvedActionKeys(document) {
  const actions = Array.isArray(document?.actions) ? document.actions : [];
  const recorded = document?.sanitisation?.actionKeys;
  const referenced = Array.isArray(recorded) && recorded.length ? new Set(recorded) : null;
  return actions
    .filter((a) => a && typeof a === 'object' && (!referenced || referenced.has(a.key)))
    .filter((a) => a.resolved !== true || !a.href)
    .map((a) => ({ key: a.key, type: a.type, label: a.label || a.hint || a.key, reason: a.unresolvedReason || 'Not resolved' }));
}

/**
 * Publish-gate assessment across all V2 compositions on a page.
 * `documents` is [{ compositionId, title, document }]. Returns
 * { ok, blockers: [{ compositionId, compositionTitle, key, label, reason }] }.
 */
export function assessAiCodePublishGate(documents) {
  const blockers = [];
  for (const entry of Array.isArray(documents) ? documents : []) {
    for (const u of unresolvedActionKeys(entry?.document)) {
      blockers.push({
        compositionId: entry.compositionId,
        compositionTitle: entry.title || 'AI composition',
        ...u,
      });
    }
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * Publish gate for a canvas page: walk the page design for
 * `ai-code-composition` blocks, load each placed V2 composition's CURRENT
 * version document and assess unresolved actions. Fail-open on missing data
 * (a page without V2 compositions must never be blocked from publishing).
 * Returns { ok, blockers } (assessAiCodePublishGate shape).
 */
export async function assessAiCodePagePublishGate(supabase, tenantId, pageId) {
  const { data: page } = await supabase
    .from('i_edit_page')
    .select('id, canvas_design')
    .eq('id', pageId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const ids = new Set();
  const walk = (children) => {
    for (const b of children || []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'ai-code-composition' && b.content?.compositionId) {
        ids.add(String(b.content.compositionId));
      }
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  for (const s of page?.canvas_design?.root?.sections || []) walk(s?.children);
  if (!ids.size) return { ok: true, blockers: [] };

  const { data: comps } = await supabase
    .from('ai_composition')
    .select('id, name, current_version_id, renderer_version')
    .eq('tenant_id', tenantId)
    .eq('renderer_version', 2)
    .in('id', [...ids]);
  const withVersion = (comps || []).filter((c) => c.current_version_id);
  if (!withVersion.length) return { ok: true, blockers: [] };

  const { data: versions } = await supabase
    .from('ai_composition_version')
    .select('id, composition_id, document')
    .eq('tenant_id', tenantId)
    .in('id', withVersion.map((c) => c.current_version_id));
  const docByComp = new Map((versions || []).map((v) => [v.composition_id, v.document]));
  return assessAiCodePublishGate(withVersion.map((c) => ({
    compositionId: c.id,
    title: c.name,
    document: docByComp.get(c.id),
  })));
}

/**
 * Real tenant-scoped lookups (best ilike match). Conventions mirror
 * api/ai-compositions/destinations.js SEARCHERS.
 */
export function makeSupabaseActionLookups(supabase, tenantId) {
  const first = async (q) => {
    const { data } = await q;
    return (data && data[0]) || null;
  };
  return {
    findPage: async (hint) => {
      const r = await first(supabase
        .from('i_edit_page').select('id, title, slug')
        .eq('tenant_id', tenantId).is('microsite_id', null)
        .ilike('title', `%${hint}%`).limit(1));
      return r ? { id: r.id, slug: r.slug, title: r.title || r.slug } : null;
    },
    findEvent: async (hint) => {
      const r = await first(supabase
        .from('event').select('id, title, slug')
        .eq('tenant_id', tenantId)
        .ilike('title', `%${hint}%`)
        .order('start_date', { ascending: false }).limit(1));
      return r ? { id: r.id, slug: r.slug || null, title: r.title } : null;
    },
    findForm: async (hint) => {
      const r = await first(supabase
        .from('form').select('id, name, slug')
        .eq('tenant_id', tenantId)
        .ilike('name', `%${hint}%`).limit(1));
      return r && r.slug ? { id: r.id, slug: r.slug, title: r.name } : null;
    },
    findMembershipTier: async (hint) => {
      const r = await first(supabase
        .from('membership_tier_config').select('id, name')
        .eq('tenant_id', tenantId).eq('is_active', true)
        .ilike('name', `%${hint}%`).limit(1));
      return r ? { id: r.id, title: r.name } : null;
    },
    findDocument: async (hint) => {
      const r = await first(supabase
        .from('file_repository').select('id, file_name, file_url')
        .eq('tenant_id', tenantId)
        .ilike('file_name', `%${hint}%`).limit(1));
      return r && r.file_url ? { id: r.id, title: r.file_name, fileUrl: r.file_url } : null;
    },
  };
}

/**
 * Verify an explicit editor-picked target for an action (used by the
 * resolve-action endpoint). `target` is { kind-specific fields }. Returns the
 * updated resolved action or { error }.
 */
export async function resolveActionWithTarget(action, target, lookupsById) {
  if (!action || !AI_CODE_ACTION_TYPES.has(action.type)) return { error: 'Unknown action' };
  const t = target || {};
  if (SELF_RESOLVING.has(action.type)) {
    const candidate = { ...action, url: t.url ?? action.url, anchorId: t.anchorId ?? action.anchorId, address: t.address ?? action.address, number: t.number ?? action.number };
    const href = buildActionHref(candidate);
    return href ? { action: { ...candidate, resolved: true, href, unresolvedReason: undefined } } : { error: invalidReason(candidate) };
  }
  const byId = lookupsById?.[ACTION_LOOKUP[action.type]];
  if (typeof byId !== 'function') return { error: 'Unsupported action type' };
  if (!ident(String(t.recordId || ''))) return { error: 'A record id is required' };
  let record = null;
  try { record = await byId(String(t.recordId)); } catch { record = null; }
  if (!record || !record.id) return { error: 'Record not found' };
  const enriched = {
    ...action,
    recordId: String(record.id),
    slug: record.slug || null,
    recordTitle: record.title || null,
    fileUrl: record.fileUrl || null,
  };
  const href = buildActionHref(enriched);
  return href
    ? { action: { ...enriched, resolved: true, href, unresolvedReason: undefined } }
    : { error: 'Matched record has no navigable URL' };
}

/** Tenant-scoped by-id verifiers for editor-picked resolution. */
export function makeSupabaseActionLookupsById(supabase, tenantId) {
  const one = async (q) => {
    const { data } = await q;
    return (data && data[0]) || null;
  };
  return {
    findPage: async (id) => {
      const r = await one(supabase.from('i_edit_page').select('id, title, slug').eq('tenant_id', tenantId).eq('id', id).limit(1));
      return r ? { id: r.id, slug: r.slug, title: r.title || r.slug } : null;
    },
    findEvent: async (id) => {
      const r = await one(supabase.from('event').select('id, title').eq('tenant_id', tenantId).eq('id', id).limit(1));
      return r ? { id: r.id, title: r.title } : null;
    },
    findForm: async (id) => {
      const r = await one(supabase.from('form').select('id, name, slug').eq('tenant_id', tenantId).eq('id', id).limit(1));
      return r && r.slug ? { id: r.id, slug: r.slug, title: r.name } : null;
    },
    findMembershipTier: async (id) => {
      const r = await one(supabase.from('membership_tier_config').select('id, name').eq('tenant_id', tenantId).eq('id', id).limit(1));
      return r ? { id: r.id, title: r.name } : null;
    },
    findDocument: async (id) => {
      const r = await one(supabase.from('file_repository').select('id, file_name, file_url').eq('tenant_id', tenantId).eq('id', id).limit(1));
      return r && r.file_url ? { id: r.id, title: r.file_name, fileUrl: r.file_url } : null;
    },
  };
}
