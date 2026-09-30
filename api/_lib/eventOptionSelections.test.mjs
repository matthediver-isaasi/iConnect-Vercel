// Task #3264: tenant-wide toggle for dietary/allergy/accessibility collection.
// Verifies that when `collect_attendee_options` is 'false' the booking paths
// persist no selections, and that the client/server helpers default to enabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeOptionSelections,
  isAttendeeOptionsCollectionEnabled,
  EMPTY_OPTION_SELECTIONS,
} from './eventOptionSelections.js';
import { isAttendeeOptionsCollectionEnabled as clientEnabled } from '../../client/src/lib/attendeeOptionsSetting.js';

const makeSupabase = (result) => ({
  from() { return this; },
  select() { return this; },
  eq() { return this; },
  async maybeSingle() { return result; },
});

test('EMPTY_OPTION_SELECTIONS carries null selections only', () => {
  assert.deepEqual(EMPTY_OPTION_SELECTIONS, {
    dietary_selections: null,
    allergy_selections: null,
    accessibility_selections: null,
  });
});

test('sanitizeOptionSelections keeps only admin-defined values', () => {
  const event = {
    dietary_options: ['Vegan'],
    allergy_options: ['Nuts'],
    accessibility_options: ['Wheelchair access'],
  };
  const out = sanitizeOptionSelections(
    {
      dietary_selections: ['Vegan', 'Made up'],
      allergy_selections: [{ name: 'Nuts', severity: 'severe' }, { name: 'Nope' }],
      accessibility_selections: ['Wheelchair access', 'Nope'],
    },
    event
  );
  assert.deepEqual(out, {
    dietary_selections: ['Vegan'],
    allergy_selections: [{ name: 'Nuts', severity: 'severe' }],
    accessibility_selections: ['Wheelchair access'],
  });
});

test('server toggle helper: disabled when setting_value is false', async () => {
  const supabase = makeSupabase({ data: { setting_value: 'false' } });
  assert.equal(await isAttendeeOptionsCollectionEnabled(supabase, 'tenant-1'), false);
});

test('server toggle helper: enabled by default (missing setting / error / true)', async () => {
  assert.equal(
    await isAttendeeOptionsCollectionEnabled(makeSupabase({ data: null }), 'tenant-1'),
    true
  );
  assert.equal(
    await isAttendeeOptionsCollectionEnabled(makeSupabase({ data: { setting_value: 'true' } }), 'tenant-1'),
    true
  );
  const throwing = { from() { throw new Error('boom'); } };
  assert.equal(await isAttendeeOptionsCollectionEnabled(throwing, 'tenant-1'), true);
});

test('booking insert shape when disabled: no selections persisted', async () => {
  const supabase = makeSupabase({ data: { setting_value: 'false' } });
  const enabled = await isAttendeeOptionsCollectionEnabled(supabase, 'tenant-1');
  const event = { dietary_options: ['Vegan'], allergy_options: [], accessibility_options: [] };
  const attendee = { dietary_selections: ['Vegan'] };
  const persisted = enabled
    ? sanitizeOptionSelections(attendee, event)
    : EMPTY_OPTION_SELECTIONS;
  assert.equal(persisted.dietary_selections, null);
  assert.equal(persisted.allergy_selections, null);
  assert.equal(persisted.accessibility_selections, null);
});

test('client helper mirrors default-on semantics for public settings list', () => {
  assert.equal(clientEnabled([]), true);
  assert.equal(clientEnabled(undefined), true);
  assert.equal(clientEnabled([{ setting_key: 'collect_attendee_options', setting_value: 'true' }]), true);
  assert.equal(clientEnabled([{ setting_key: 'collect_attendee_options', setting_value: 'false' }]), false);
});
