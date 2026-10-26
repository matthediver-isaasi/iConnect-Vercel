import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exhibitionEvent, exhibitionLifecycleEffect, exhibitionMoney, exhibitionSlots,
  MAX_EXHIBITION_UNITS, normalizeExhibitionPrefix, validateExhibitionSelections,
} from './salesExhibitionContract.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const product = (overrides = {}) => ({
  kind: 'product', logicalLineId: id(1), quantity: 1,
  spaceRequirement: { requirementId: id(10), units: 1 }, ...overrides,
});
const bundle = (overrides = {}) => ({
  kind: 'bundle', logicalLineId: id(2), quantity: 2,
  components: [
    { logicalComponentId: id(3), quantity: 3, spaceRequirement: { requirementId: id(10), units: 2 } },
    { logicalComponentId: id(4), quantity: 4 }, // Ticket/advertising products stay independent.
  ], ...overrides,
});

test('prefixes normalise predictably, with no empty or unsafe references', () => {
  assert.equal(normalizeExhibitionPrefix(' bronze '), 'BRONZE');
  assert.equal(normalizeExhibitionPrefix('BRONZE_2027-A'), 'BRONZE_2027-A');
  for (const invalid of ['', ' ', null, 'A/B', 'A B', 'Ａ', '-BRONZE', 'X'.repeat(49)]) {
    assert.throws(() => normalizeExhibitionPrefix(invalid));
  }
});

test('zero is a genuine price; invalid or coercion-only money fails', () => {
  for (const price of [0, 1, 19999, Number.MAX_SAFE_INTEGER]) assert.equal(exhibitionMoney(price), price);
  for (const price of [null, '', '0', false, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => exhibitionMoney(price));
  }
});

test('only a verified proposal event supplies inventory context', () => {
  assert.deepEqual(exhibitionEvent({ id: id(9), kind: 'complex' }), { id: id(9), kind: 'complex' });
  for (const snapshot of [null, {}, { id: id(9) }, { id: id(9), kind: 'ticket' }, { id: 'bad', kind: 'simple' }]) {
    assert.throws(() => exhibitionEvent(snapshot));
  }
  assert.throws(() => exhibitionEvent({ eventReference: { eventId: id(9), kind: 'simple' } }));
});

test('multiple spaces and multiplied bundles have independent identities', () => {
  const slots = exhibitionSlots([product({ quantity: '2.00' }), bundle()]);
  assert.equal(slots.length, 14);
  assert.equal(new Set(slots.map(slot => slot.key)).size, 14);
  assert.equal(slots.filter(slot => slot.pricing === 'individual').length, 2);
  assert.equal(slots.filter(slot => slot.pricing === 'included').length, 12);
});

test('reordering, row rewrites and increased component quantities preserve old unit identities', () => {
  const first = exhibitionSlots([product(), bundle()]);
  const changed = bundle();
  changed.components[0].quantity = 4;
  changed.id = id(300); // Physical child row IDs have no effect.
  const next = exhibitionSlots([changed, product({ id: id(301) })]);
  const keys = new Set(next.map(slot => slot.key));
  for (const slot of first) assert.ok(keys.has(slot.key));
});

test('repeated catalogue products remain separate logical lines', () => {
  const slots = exhibitionSlots([product(), product({ logicalLineId: id(5) })]);
  assert.equal(slots.length, 2);
  assert.notEqual(slots[0].key, slots[1].key);
  assert.throws(() => exhibitionSlots([product(), product()]), /Duplicate/);
});

test('exhibition quantity fails closed without affecting ordinary fractional lines', () => {
  assert.deepEqual(exhibitionSlots([{ kind: 'free_text', quantity: '.5' }, { kind: 'product', quantity: '.25' }]), []);
  for (const quantity of [0, -1, 1.5, '', ' ', true, null, undefined, '0x10', '1e2', MAX_EXHIBITION_UNITS + 1]) {
    assert.throws(() => exhibitionSlots([product({ quantity })]));
  }
  assert.throws(() => exhibitionSlots([bundle({ quantity: 1000 })]), /more than/);
  assert.throws(() => exhibitionSlots([bundle({ components: undefined })]), /resolved/);
});

test('duplicate component identities and invalid requirements fail', () => {
  const source = bundle();
  source.components.push({ ...source.components[0] });
  assert.throws(() => exhibitionSlots([source]), /Duplicate/);
  assert.throws(() => exhibitionSlots([product({ logicalLineId: null })]), /UUID/);
  assert.throws(() => exhibitionSlots([product({ spaceRequirement: { requirementId: id(10), units: false } })]));
});

test('drafts may be incomplete; issue requires exact unit coverage', () => {
  const slots = exhibitionSlots([product({ quantity: 2 })]);
  assert.equal(validateExhibitionSelections(slots, []), true);
  assert.throws(() => validateExhibitionSelections(slots, [], { complete: true }), /every/);
  const selections = slots.map((slot, i) => ({ slotKey: slot.key, spaceId: id(20 + i) }));
  assert.equal(validateExhibitionSelections(slots, selections, { complete: true }), true);
  assert.throws(() => validateExhibitionSelections(slots, [...selections, selections[0]]), /independently/);
  assert.throws(() => validateExhibitionSelections(slots, [selections[0], { ...selections[1], spaceId: id(20) }]), /multiple/);
  assert.throws(() => validateExhibitionSelections(slots, [{ slotKey: 'stale', spaceId: id(22) }]), /current/);
});

test('removing a unit invalidates its old selection rather than shifting it to another unit', () => {
  const before = exhibitionSlots([product({ quantity: 2 })]);
  const after = exhibitionSlots([product()]);
  assert.equal(after[0].key, before[0].key);
  assert.throws(() => validateExhibitionSelections(after, [{ slotKey: before[1].key, spaceId: id(20) }]), /current/);
});

test('Won and link expiry do not imply acceptance or reservation release', () => {
  for (const command of ['save', 'reassign', 'opportunity_won', 'delivery_expired', 'delivery_revoked']) {
    assert.equal(exhibitionLifecycleEffect(command), 'preserve');
  }
  assert.equal(exhibitionLifecycleEffect('accept'), 'finalize_sale');
  assert.equal(exhibitionLifecycleEffect('amend'), 'transfer');
  assert.equal(exhibitionLifecycleEffect('reopen'), 'revalidate');
  assert.equal(exhibitionLifecycleEffect('change_event'), 'require_no_allocations');
  assert.throws(() => exhibitionLifecycleEffect('superseded'), /Unknown/);
});

test('unsold terminal operations release reservations; sold inventory stays protected', () => {
  for (const command of ['decline', 'proposal_expire', 'cancel', 'delete', 'opportunity_lost']) {
    assert.equal(exhibitionLifecycleEffect(command), 'release_reserved');
    assert.notEqual(exhibitionLifecycleEffect(command, { sold: true }), 'release_reserved');
  }
  assert.equal(exhibitionLifecycleEffect('opportunity_lost', { sold: true }), 'preserve');
  assert.equal(exhibitionLifecycleEffect('amend', { sold: true }), 'require_financial_safeguards');
  assert.equal(exhibitionLifecycleEffect('accept', { sold: true }), 'verify_existing_sale');
});
