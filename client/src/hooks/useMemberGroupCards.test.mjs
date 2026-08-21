import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBER_GROUP_CARD_SOURCE,
  resolveMemberGroupCardSource,
  resolveSelectedMemberGroupIds,
  resolveMemberGroupCardsAccess,
  selectSelectedMemberGroups,
  selectSelfJoinMemberGroups,
} from '../lib/memberGroupCards.js';

const groups = [
  { id: 'closed', name: 'Closed', allow_self_join: true, is_active: false },
  { id: 'no-self-join', name: 'Anyone', allow_self_join: false, is_active: true },
  { id: 'zebra', name: 'Zebra', allow_self_join: true, is_active: true },
  { id: 'alpha', name: 'Alpha', allow_self_join: true, is_active: true },
  { id: 'beta', name: 'Beta', allow_self_join: true },
];

test('eligible Canvas group cards are active self-join groups in alphabetical order and limited', () => {
  assert.deepEqual(
    selectSelfJoinMemberGroups(groups, 2).map((group) => group.id),
    ['alpha', 'beta'],
  );
});

test('eligible Canvas group card count defaults safely and stays bounded', () => {
  assert.equal(selectSelfJoinMemberGroups(groups).length, 3);
  assert.equal(selectSelfJoinMemberGroups(groups, 0).length, 1);
  assert.equal(selectSelfJoinMemberGroups(groups, 99).length, 3);
});

test('selected Canvas groups preserve saved order and safely omit unavailable selections', () => {
  assert.deepEqual(
    selectSelectedMemberGroups(groups, ['zebra', 'missing', 'alpha', 'closed']).map((group) => group.id),
    ['zebra', 'alpha'],
  );
  assert.deepEqual(
    resolveSelectedMemberGroupIds([' alpha ', 'alpha', '', 'beta']),
    ['alpha', 'beta'],
  );
});

test('legacy blocks resolve to self-join and only the supported manual source is accepted', () => {
  assert.equal(resolveMemberGroupCardSource(undefined), MEMBER_GROUP_CARD_SOURCE.SELF_JOIN);
  assert.equal(resolveMemberGroupCardSource('something-else'), MEMBER_GROUP_CARD_SOURCE.SELF_JOIN);
  assert.equal(resolveMemberGroupCardSource(MEMBER_GROUP_CARD_SOURCE.SELECTED), MEMBER_GROUP_CARD_SOURCE.SELECTED);
});

test('member-only queries require a server-validated session and allowed feature access', () => {
  assert.deepEqual(resolveMemberGroupCardsAccess({
    authResolved: false,
    sessionValidated: false,
    memberId: null,
    isAccessReady: false,
    featureExcluded: false,
  }), {
    isAuthenticated: false,
    accessRestricted: false,
    shouldLoadPublicData: false,
    shouldLoadAuthenticatedData: false,
  });

  assert.deepEqual(resolveMemberGroupCardsAccess({
    authResolved: true,
    sessionValidated: false,
    memberId: 'stale-local-member',
    isAccessReady: true,
    featureExcluded: false,
  }), {
    isAuthenticated: false,
    accessRestricted: false,
    shouldLoadPublicData: true,
    shouldLoadAuthenticatedData: false,
  });

  assert.deepEqual(resolveMemberGroupCardsAccess({
    authResolved: true,
    sessionValidated: true,
    memberId: 'member-1',
    isAccessReady: true,
    featureExcluded: true,
  }), {
    isAuthenticated: true,
    accessRestricted: true,
    shouldLoadPublicData: false,
    shouldLoadAuthenticatedData: false,
  });

  assert.equal(resolveMemberGroupCardsAccess({
    authResolved: true,
    sessionValidated: true,
    memberId: 'member-1',
    isAccessReady: true,
    featureExcluded: false,
  }).shouldLoadAuthenticatedData, true);
});