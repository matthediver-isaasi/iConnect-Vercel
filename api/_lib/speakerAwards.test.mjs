import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpeakerEmailMatchOr,
  matchSpeakersToMembers,
} from './speakerAwards.js';

function makeDb({ linkedMembers = [], emailMembers = [], organizations = [] }) {
  const log = [];
  return {
    log,
    from(table) {
      const state = { table, mode: null, tenantId: null, values: [] };
      const chain = {
        select() { return chain; },
        eq(column, value) {
          if (column === 'tenant_id') state.tenantId = value;
          return chain;
        },
        in(column, values) {
          state.mode = column;
          state.values = values;
          return chain;
        },
        or(filter) {
          state.mode = 'email';
          state.values = [filter];
          return chain;
        },
        then(resolve) {
          log.push({ ...state });
          if (table === 'organization') {
            resolve({ data: organizations, error: null });
          } else if (state.mode === 'id') {
            resolve({ data: linkedMembers, error: null });
          } else {
            resolve({ data: emailMembers, error: null });
          }
        },
      };
      return chain;
    },
  };
}

test('email fallback builds an escaped exact case-insensitive PostgREST filter', () => {
  assert.equal(
    buildSpeakerEmailMatchOr([
      'Person@example.com',
      'odd,(name)%_\\@example.com',
    ]),
    'email.ilike."Person@example.com",email.ilike."odd\\,\\(name\\)\\\\%\\\\_\\\\\\\\@example.com"',
  );
});

test('persisted member link wins over a different email match', async () => {
  const db = makeDb({
    linkedMembers: [{ id: 'linked', email: 'linked@example.com', organization_id: 'o1' }],
    emailMembers: [{ id: 'legacy', email: 'speaker@example.com', organization_id: 'o2' }],
    organizations: [{ id: 'o1', name: 'Linked Org' }, { id: 'o2', name: 'Email Org' }],
  });
  const matches = await matchSpeakersToMembers(db, 't1', [{
    id: 's1',
    member_id: 'linked',
    email: 'speaker@example.com',
  }]);
  assert.deepEqual(matches.s1, {
    member_id: 'linked',
    organization_id: 'o1',
    organization_name: 'Linked Org',
  });
  assert.equal(db.log.find((entry) => entry.mode === 'id')?.tenantId, 't1');
  assert.match(
    db.log.find((entry) => entry.mode === 'email')?.values?.[0] || '',
    /^email\.ilike\./,
  );
});

test('linked member resolves without a speaker email', async () => {
  const db = makeDb({
    linkedMembers: [{ id: 'linked', email: 'linked@example.com', organization_id: null }],
  });
  const matches = await matchSpeakersToMembers(db, 't1', [{
    id: 's1',
    member_id: 'linked',
    email: null,
  }]);
  assert.equal(matches.s1.member_id, 'linked');
});

test('invalid saved link falls back to case-insensitive legacy email matching', async () => {
  const db = makeDb({
    linkedMembers: [],
    emailMembers: [{ id: 'legacy', email: 'Speaker@Example.com', organization_id: 'o1' }],
    organizations: [{ id: 'o1', name: 'Legacy Org' }],
  });
  const matches = await matchSpeakersToMembers(db, 't1', [{
    id: 's1',
    member_id: 'missing',
    email: 'speaker@example.com',
  }]);
  assert.equal(matches.s1.member_id, 'legacy');
  assert.equal(matches.s1.organization_name, 'Legacy Org');
});