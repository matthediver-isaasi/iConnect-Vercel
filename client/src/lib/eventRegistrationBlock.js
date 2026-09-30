export const EVENT_REGISTRATION_KINDS = Object.freeze({
  SIMPLE: 'simple',
  COMPLEX: 'complex',
});

// Shared by the registry and focused contract tests. In V1 the live
// measurement reflows neighbours without baking viewer state into the saved
// design; in V2 the data-layer auto-height set drives flow measurement.
export const EVENT_REGISTRATION_LAYOUT_CONTRACT = Object.freeze({
  allowOverflow: true,
  autoHeight: true,
  widthResizeOnly: true,
  renderOnlyAutoHeight: true,
  signedAutoHeight: true,
  editorInteractive: false,
});

// Resolve the persisted picker value into the explicit props consumed by the
// two route-independent event experiences. Stable ids are retained alongside
// slugs so records remain resolvable if their public URL changes.
export function resolveEventRegistrationSelection(content) {
  const c = content && typeof content === 'object' ? content : {};
  const eventType = c.eventType === EVENT_REGISTRATION_KINDS.COMPLEX
    ? EVENT_REGISTRATION_KINDS.COMPLEX
    : EVENT_REGISTRATION_KINDS.SIMPLE;
  const eventId = c.eventId == null ? '' : String(c.eventId).trim();
  const eventSlug = c.eventSlug == null ? '' : String(c.eventSlug).trim();
  if (!eventId && !eventSlug) return null;
  return {
    eventType,
    eventId: eventId || null,
    eventSlug: eventSlug || null,
  };
}

export const EVENT_REGISTRATION_MEASUREMENT_OPTIONS = Object.freeze({
  includeExtraHeightPublic: true,
});

// The embedded booking experiences contain links, forms and payment controls.
// In the builder none of those actions may navigate, submit or mutate booking
// state. Kept as a small reusable helper so every capture handler applies the
// same prevent/stop contract and the behaviour is node-testable.
export function guardEventRegistrationEditorInteraction(event, asEditor) {
  if (!asEditor || !event) return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  return true;
}