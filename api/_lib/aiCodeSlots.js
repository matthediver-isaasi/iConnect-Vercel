// AI Design Studio V2 Phase 2 (Task #2906) — the slot system.
//
// Generated markup can carve out placeholder elements with
// `data-iconnect-slot` (the sanitiser empties their children and stamps
// `data-slot-key`). Each slot in the document's keyed `slots` list is
// resolved server-side into a TRUSTED iConnect component: a synthetic canvas
// block config that the client mounts into the placeholder via the real
// block registry render path (builder AND public). Generated code never
// renders these components itself — the AI only reserves the space.
//
// Resolved slot shape:
//   { ...slot, resolved: true, block: { type, content } }
// Unresolved (record-backed slot whose hint matched nothing):
//   { ...slot, resolved: false, unresolvedReason }
// Unresolved slots render as a neutral placeholder panel; they do NOT block
// publishing (unlike actions) because they degrade to an empty region rather
// than a dead navigation promise.

import { AI_CODE_SLOT_TYPES } from './aiCodePackageSchema.js';

// Slot kind → trusted canvas block. `lookup` names the record lookup needed
// (null = no record required); `content(record)` builds the block content.
const SLOT_BLOCKS = {
  form: {
    lookup: 'findForm',
    block: (r) => ({ type: 'form-embed', content: { formSlug: r.slug, mode: 'inline' } }),
  },
  event_registration: {
    lookup: 'findEvent',
    block: (r) => ({ type: 'event-teaser', content: { eventId: String(r.id), showImage: true, showSummary: true, showCta: true, ctaLabel: 'Register' } }),
  },
  event_listing: {
    lookup: null,
    block: () => ({ type: 'event-list', content: { title: '', limit: 6, filter: 'upcoming', columns: { desktop: 3, tablet: 2, mobile: 1 } } }),
  },
  membership_application: {
    lookup: 'findMembershipTier',
    // Rendered by a small trusted client component (tier CTA panel) — there
    // is no canvas block for membership application, so the client maps this
    // pseudo-type itself. Content carries only the verified record id/name.
    block: (r) => ({ type: 'membership-application-cta', content: { tierId: String(r.id), tierName: r.title || '' } }),
  },
  document_list: {
    lookup: null,
    block: () => ({ type: 'resource-list', content: { title: '', limit: 6, columns: { desktop: 3, tablet: 2, mobile: 1 } } }),
  },
  news_listing: {
    lookup: null,
    block: () => ({ type: 'article-list', content: { title: '', source: 'news', limit: 3, columns: { desktop: 3, tablet: 2, mobile: 1 }, showSummary: true, showImage: true } }),
  },
  directory: {
    lookup: 'findDirectory',
    block: (r) => ({ type: 'dynamic-directory-embed', content: { directorySlug: r.slug, limit: 12, columns: { desktop: 3, tablet: 2, mobile: 1 } } }),
  },
  login_prompt: {
    lookup: null,
    block: () => ({ type: 'login-form', content: {} }),
  },
  donation: {
    lookup: 'findCampaign',
    block: (r) => ({ type: 'campaign-embed', content: { campaignSlug: r.slug, showProgress: true, showImage: true, ctaLabel: 'Donate now' } }),
  },
};

/**
 * Resolve a document's slots against tenant records. `lookups` is an object
 * of async (hint) => ({ id, slug?, title? } | null):
 *   findForm, findEvent, findMembershipTier, findDirectory, findCampaign
 */
export async function resolveCodeSlots(slots, lookups = {}) {
  const list = Array.isArray(slots) ? slots : [];
  const out = [];
  for (const slot of list) {
    if (!slot || typeof slot !== 'object' || !AI_CODE_SLOT_TYPES.has(slot.type) || !SLOT_BLOCKS[slot.type]) {
      out.push({ ...slot, resolved: false, unresolvedReason: 'Unsupported slot type' });
      continue;
    }
    const spec = SLOT_BLOCKS[slot.type];
    if (!spec.lookup) {
      out.push({ ...slot, resolved: true, block: spec.block(null) });
      continue;
    }
    const lookup = lookups[spec.lookup];
    const hint = typeof slot.hint === 'string' ? slot.hint.trim() : '';
    let record = null;
    if (typeof lookup === 'function' && hint) {
      try { record = await lookup(hint); } catch { record = null; }
    }
    if (!record || !record.id) {
      out.push({ ...slot, resolved: false, unresolvedReason: hint ? `No matching record for "${hint}"` : 'No record hint provided' });
      continue;
    }
    out.push({ ...slot, resolved: true, recordId: String(record.id), recordTitle: record.title || null, block: spec.block(record) });
  }
  return out;
}

/** Real tenant-scoped slot lookups. */
export function makeSupabaseSlotLookups(supabase, tenantId) {
  const first = async (q) => {
    const { data } = await q;
    return (data && data[0]) || null;
  };
  return {
    findForm: async (hint) => {
      const r = await first(supabase.from('form').select('id, name, slug').eq('tenant_id', tenantId).ilike('name', `%${hint}%`).limit(1));
      return r && r.slug ? { id: r.id, slug: r.slug, title: r.name } : null;
    },
    findEvent: async (hint) => {
      const r = await first(supabase.from('event').select('id, title').eq('tenant_id', tenantId).ilike('title', `%${hint}%`).order('start_date', { ascending: false }).limit(1));
      return r ? { id: r.id, title: r.title } : null;
    },
    findMembershipTier: async (hint) => {
      const r = await first(supabase.from('membership_tier_config').select('id, name').eq('tenant_id', tenantId).eq('is_active', true).ilike('name', `%${hint}%`).limit(1));
      return r ? { id: r.id, title: r.name } : null;
    },
    findDirectory: async (hint) => {
      const r = await first(supabase.from('dynamic_directory').select('id, name, slug').eq('tenant_id', tenantId).ilike('name', `%${hint}%`).limit(1));
      return r && r.slug ? { id: r.id, slug: r.slug, title: r.name } : null;
    },
    findCampaign: async (hint) => {
      const r = await first(supabase.from('fundraising_campaign').select('id, title, slug').eq('tenant_id', tenantId).ilike('title', `%${hint}%`).limit(1));
      return r && r.slug ? { id: r.id, slug: r.slug, title: r.title } : null;
    },
  };
}
