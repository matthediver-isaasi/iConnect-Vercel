import test from 'node:test';
import assert from 'node:assert/strict';
import { getMemberBadgePanelState } from './memberBadgePanelState.js';

test('loading and error states never expose actions', () => {
  assert.deepEqual(getMemberBadgePanelState({ isLoading: true, canManage: true }), {
    kind: 'loading',
    canAward: false,
  });
  assert.deepEqual(getMemberBadgePanelState({ isError: true, canManage: true }), {
    kind: 'error',
    canAward: false,
  });
});

test('empty state exposes award control only to managers with an available badge', () => {
  assert.equal(getMemberBadgePanelState({ canManage: false, availableBadges: [{ id: 'b1' }] }).showAwardControl, false);
  assert.equal(getMemberBadgePanelState({ canManage: true, availableBadges: [] }).canAward, false);
  assert.equal(getMemberBadgePanelState({ canManage: true, availableBadges: [{ id: 'b1' }] }).canAward, true);
});

test('history state counts active and revoked awards', () => {
  const state = getMemberBadgePanelState({
    awards: [{ status: 'active' }, { status: 'revoked' }, { status: 'revoked' }],
  });
  assert.equal(state.kind, 'history');
  assert.equal(state.activeAwards, 1);
  assert.equal(state.revokedAwards, 2);
});
