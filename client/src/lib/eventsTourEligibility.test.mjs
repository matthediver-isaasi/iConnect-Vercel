import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseEventsPageTour } from './eventsTourEligibility.js';

test('guests cannot use the Events page tour', () => {
  assert.equal(
    canUseEventsPageTour({ memberInfo: null, memberRole: null }),
    false
  );
});

test('authenticated members cannot use the Events page tour until their role resolves', () => {
  assert.equal(
    canUseEventsPageTour({ memberInfo: { id: 'member-1' }, memberRole: null }),
    false
  );
});

test('authenticated members can use the Events page tour when their role enables tours', () => {
  assert.equal(
    canUseEventsPageTour({
      memberInfo: { id: 'member-1' },
      memberRole: { show_tours: true },
    }),
    true
  );
  assert.equal(
    canUseEventsPageTour({
      memberInfo: { id: 'member-1' },
      memberRole: {},
    }),
    true
  );
});

test('authenticated members cannot use the Events page tour when their role disables tours', () => {
  assert.equal(
    canUseEventsPageTour({
      memberInfo: { id: 'member-1' },
      memberRole: { show_tours: false },
    }),
    false
  );
});