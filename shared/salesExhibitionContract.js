/**
 * Exhibition integration contract. These pure helpers do not reserve inventory.
 * Reservation ownership must be validated and changed in one database transaction.
 * Used by server-side preparation; see docs/sales-exhibition-integration-contract.md.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_EXHIBITION_UNITS = 1000;

function identity(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} must be a UUID`);
  return value.toLowerCase();
}

function positiveQuantity(value, label) {
  // Quote quantities arrive as numeric strings. Do not accept JS coercion of
  // booleans, null, blank strings, exponent notation or hexadecimal.
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label} must be a positive whole number`);
  if (typeof value === 'string' && !/^[0-9]+(?:\.0+)?$/.test(value)) throw new Error(`${label} must be a positive whole number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_EXHIBITION_UNITS) {
    throw new Error(`${label} must be a whole number from 1 to ${MAX_EXHIBITION_UNITS}`);
  }
  return parsed;
}

export function exhibitionMoney(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Space price must be a non-negative safe integer in minor units');
  return value;
}

export function normalizeExhibitionPrefix(value) {
  if (typeof value !== 'string') throw new Error('Reference prefix is required');
  const prefix = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,47}$/.test(prefix)) {
    throw new Error('Use 1–48 letters, numbers, underscores or hyphens for the reference prefix');
  }
  return prefix;
}

/**
 * Event authority is exclusively the proposal snapshot, never a product's
 * ticket link. Legacy snapshots lack kind; normalisation at the server must
 * supply the verified kind, rather than guess from another product.
 */
export function exhibitionEvent(snapshot) {
  if (!snapshot?.id || !['simple', 'complex'].includes(snapshot.kind)) {
    throw new Error('Choose an Event on the proposal and save the draft before selecting exhibition spaces');
  }
  return { id: identity(snapshot.id, 'Proposal event'), kind: snapshot.kind };
}

/**
 * A requirement is event-independent. Each event group implements one
 * requirementId, letting the same product or bundle sell at different events.
 *
 * logicalLineId and logicalComponentId are server-validated persisted UUIDs,
 * NOT the database child-row ID, array position, catalogue ID or product ID.
 * Reordering and quantity growth therefore leave existing unit keys unchanged.
 */
export function exhibitionSlots(lines) {
  if (!Array.isArray(lines)) throw new Error('Proposal lines must be an array');
  const slots = [];
  const linesSeen = new Set();
  for (const line of lines) {
    const components = line.kind === 'bundle' ? line.components : [];
    if (line.kind === 'bundle' && !Array.isArray(components)) throw new Error('Bundle components must be resolved before selecting spaces');
    const requirements = line.kind === 'product'
      ? (line.spaceRequirement ? [{ logicalComponentId: null, quantity: 1, spaceRequirement: line.spaceRequirement }] : [])
      : line.kind === 'bundle' ? components.filter(component => component.spaceRequirement) : [];
    if (!requirements.length) continue;
    const lineId = identity(line.logicalLineId, 'Logical line identity');
    if (linesSeen.has(lineId)) throw new Error('Duplicate logical exhibition line identity');
    linesSeen.add(lineId);
    const lineQuantity = positiveQuantity(line.quantity, 'Exhibition line quantity');
    const componentsSeen = new Set();
    for (const component of requirements) {
      const componentId = line.kind === 'bundle'
        ? identity(component.logicalComponentId, 'Logical component identity') : null;
      if (componentsSeen.has(componentId)) throw new Error('Duplicate logical exhibition component identity');
      componentsSeen.add(componentId);
      const requirementId = identity(component.spaceRequirement.requirementId, 'Space requirement');
      const componentQuantity = positiveQuantity(component.quantity, 'Exhibition component quantity');
      const units = positiveQuantity(component.spaceRequirement.units, 'Spaces per product');
      const count = lineQuantity * componentQuantity * units;
      if (!Number.isSafeInteger(count) || slots.length + count > MAX_EXHIBITION_UNITS) {
        throw new Error(`A proposal cannot require more than ${MAX_EXHIBITION_UNITS} exhibition spaces`);
      }
      // Keep a tuple rather than a flattened index: increasing the quantity
      // inside a component must not re-identify later bundle copies.
      for (let lineUnit = 1; lineUnit <= lineQuantity; lineUnit++) {
        for (let componentUnit = 1; componentUnit <= componentQuantity; componentUnit++) {
          for (let requirementUnit = 1; requirementUnit <= units; requirementUnit++) {
            slots.push({
              key: `${lineId}/${componentId || 'product'}/${lineUnit}/${componentUnit}/${requirementUnit}`,
              logicalLineId: lineId, logicalComponentId: componentId,
              lineUnit, componentUnit, requirementUnit, requirementId,
              pricing: line.kind === 'bundle' ? 'included' : 'individual',
            });
          }
        }
      }
    }
  }
  return slots;
}

/**
 * Validates a complete proposed selection, not just a count. The server must
 * additionally re-read each space and validate tenant/event/group/ownership
 * under database locks. Empty selections are permitted in drafts only.
 */
export function validateExhibitionSelections(slots, selections, { complete = false } = {}) {
  if (!Array.isArray(slots) || !Array.isArray(selections)) throw new Error('Slots and selections must be arrays');
  const allowed = new Set(slots.map(slot => slot.key));
  if (allowed.size !== slots.length) throw new Error('Duplicate required slot');
  const selectedSlots = new Set();
  const selectedSpaces = new Set();
  for (const selection of selections) {
    if (!selection || !allowed.has(selection.slotKey)) throw new Error('Selection does not belong to a current exhibition requirement');
    if (selectedSlots.has(selection.slotKey)) throw new Error('Each exhibition unit needs one independently tracked selection');
    const spaceId = identity(selection.spaceId, 'Space');
    if (selectedSpaces.has(spaceId)) throw new Error('A space cannot satisfy multiple exhibition units');
    selectedSlots.add(selection.slotKey);
    selectedSpaces.add(spaceId);
  }
  if (complete && selectedSlots.size !== allowed.size) throw new Error('Select a space for every exhibition unit before issuing or accepting the proposal');
  return true;
}

/**
 * Explicit commands, not inference from arbitrary status labels.
 * Delivery-token expiry/revocation does not cancel a proposal.
 * Supersession is part of a version transfer, not a release-and-reacquire.
 */
export function exhibitionLifecycleEffect(command, { sold = false } = {}) {
  const effects = {
    save: 'preserve',
    reassign: 'preserve',
    issue: 'validate_complete',
    send: 'preserve',
    delivery_expired: 'preserve',
    delivery_revoked: 'preserve',
    opportunity_won: 'preserve',
    accept: 'finalize_sale',
    confirm_sale: 'finalize_sale',
    decline: 'release_reserved',
    proposal_expire: 'release_reserved',
    cancel: 'release_reserved',
    delete: 'release_reserved',
    opportunity_lost: 'release_reserved',
    reopen: 'revalidate',
    amend: 'transfer',
    replace_selection: 'replace_atomically',
    remove_selection: 'release_reserved',
    change_event: 'require_no_allocations',
  };
  if (!Object.hasOwn(effects, command)) throw new Error('Unknown exhibition lifecycle command');
  if (sold) {
    if (['opportunity_lost', 'opportunity_won', 'reassign', 'delivery_expired', 'delivery_revoked'].includes(command)) return 'preserve';
    if (['accept', 'confirm_sale'].includes(command)) return 'verify_existing_sale';
    // Accepted inventory cannot become mutable through a new version.
    return 'require_financial_safeguards';
  }
  return effects[command];
}
