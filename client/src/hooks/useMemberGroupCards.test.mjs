import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { countOpenVacanciesByGroup, isVacancyClosed } from '../lib/vacancyStatus.js';
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

const now = new Date(2026, 8, 16, 23, 59);
const cases = [
  ['past', 'open', new Date(2026, 8, 15).toISOString(), true],
  ['today', 'open', new Date(2026, 8, 16).toISOString(), false],
  ['future', 'open', new Date(2026, 8, 17).toISOString(), false],
  ['missing', 'open', null, false],
  ['invalid', 'open', 'invalid', false],
  ['explicit', 'closed', new Date(2026, 8, 17).toISOString(), true],
  ['closed without date', 'closed', null, true],
];
for (const [name, status, closing_date, closed] of cases) {
  test(`vacancy badge eligibility agrees with closure rule: ${name}`, () => {
    const vacancy = { member_group_id: 'group', status, closing_date };
    assert.equal(isVacancyClosed(vacancy, now), closed);
    assert.deepEqual(countOpenVacanciesByGroup([vacancy], now), closed ? {} : { group: 1 });
  });
}

test('mixed vacancies count independently across groups without mutating records', () => {
  const vacancies = cases.map(([, status, closing_date]) => Object.freeze({
    member_group_id: 'mixed', status, closing_date,
  }));
  vacancies.push(
    { member_group_id: 'closed-only', status: 'closed' },
    { member_group_id: 'expired-only', status: 'open', closing_date: '2020-01-01' },
    { member_group_id: 'open-only', status: 'open' },
    { status: 'open' },
  );
  assert.deepEqual(countOpenVacanciesByGroup(vacancies, now), { mixed: 4, 'open-only': 1 });
});

test('create/edit, close/reopen and delete success handlers refresh mounted card counts', async () => {
  const source = readFileSync(new URL('../pages/MemberGroupDetail.jsx', import.meta.url), 'utf8');
  for (const name of ['saveVacancyMutation', 'toggleVacancyStatusMutation', 'removeVacancyMutation']) {
    const mutation = source.split(`const ${name} = useMutation({`)[1].split('onError:')[0];
    const success = mutation.split('onSuccess:')[1];
    const refresh = success.match(/queryClient\.invalidateQueries\(\{ queryKey: \["member-groups-open-vacancies"\] \}\);/);
    assert.ok(refresh, `${name} invalidates card counts on success`);
    const queryClient = new QueryClient();
    let records = [{ member_group_id: 'group', status: 'open' }];
    const queryKey = ['member-groups-open-vacancies'];
    const observer = new QueryObserver(queryClient, {
      queryKey, queryFn: async () => records, staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    assert.deepEqual(countOpenVacanciesByGroup(queryClient.getQueryData(queryKey), now), { group: 1 });
    records = [{ member_group_id: 'group', status: 'open', closing_date: '2020-01-01' }];
    await new Function('queryClient', `return ${refresh[0]}`)(queryClient);
    assert.deepEqual(countOpenVacanciesByGroup(queryClient.getQueryData(queryKey), now), {});
    unsubscribe();
    queryClient.clear();
  }
});

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