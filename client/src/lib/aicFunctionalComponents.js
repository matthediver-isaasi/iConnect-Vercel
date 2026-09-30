// AI Design Studio Phase 5 (canvas_component_placeholder → real
// iConnect canvas block resolution.
//
// The AI only ever RECOMMENDS and POSITIONS standard functionality via a
// placeholder element carrying a componentKey (server-allowlisted in
// api/_lib/aiCompositionSchema.js — keep the two lists in sync). Rendering a
// placeholder always mounts the REAL, existing canvas block component; the AI
// never recreates behaviour. React-free module so tests can import it.

import { BLOCK_TYPES, BLOCK_DEFAULTS } from '@/lib/canvasDesign';

export const AIC_COMPONENT_LABELS = {
  form: 'Form',
  event_registration: 'Event registration',
  event_list: 'Event list',
  news_listing: 'News & articles',
  resource_list: 'Resources & downloads',
  member_directory: 'Member directory',
  login: 'Member login',
};

// componentKey → the standard canvas block that owns this functionality.
// `wire` maps the placeholder's verified record reference onto the block's
// content fields. Keys without a mapping render as an editor notice only —
// never a lookalike. (membership_application is excluded from the server
// allowlist until a dedicated canvas block exists.)
const COMPONENT_BLOCKS = {
  form: {
    blockType: BLOCK_TYPES.FORM_EMBED,
    wire: (data) => ({ formSlug: data.recordSlug || '' }),
    needsRecord: true,
  },
  event_registration: {
    blockType: BLOCK_TYPES.EVENT_TEASER,
    wire: (data) => ({ eventId: data.recordId || '', eventSlug: data.recordSlug || '' }),
    needsRecord: true,
  },
  event_list: { blockType: BLOCK_TYPES.EVENT_LIST, wire: () => ({}) },
  news_listing: { blockType: BLOCK_TYPES.ARTICLE_LIST, wire: () => ({}) },
  resource_list: { blockType: BLOCK_TYPES.RESOURCE_LIST, wire: () => ({}) },
  member_directory: { blockType: BLOCK_TYPES.MEMBER_DIRECTORY_EMBED, wire: () => ({}) },
  login: { blockType: BLOCK_TYPES.LOGIN_FORM, wire: () => ({}) },
};

/**
 * Resolve a placeholder element's data into a synthetic canvas block the
 * standard registry can render. Returns null when the key has no canvas
 * block or a required record is missing (caller shows a neutral notice).
 */
export function resolveFunctionalComponent(data, elementId) {
  const key = data?.componentKey;
  const def = COMPONENT_BLOCKS[key];
  if (!def) return null;
  if (def.needsRecord && !data.recordId && !data.recordSlug) return null;
  const defaults = BLOCK_DEFAULTS[def.blockType] || {};
  return {
    componentKey: key,
    blockType: def.blockType,
    block: {
      id: `aicfc-${elementId || key}`,
      type: def.blockType,
      name: data.label || AIC_COMPONENT_LABELS[key] || key,
      content: {
        ...(defaults.content || {}),
        ...def.wire(data || {}),
      },
      style: { background: 'transparent', borderWidth: 0 },
      geom: { ...(defaults.geom || {}) },
    },
  };
}

export function functionalComponentLabel(data) {
  return data?.label || AIC_COMPONENT_LABELS[data?.componentKey] || 'iConnect component';
}
