import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEAKER_MEMBER_UNIQUE_INDEX,
  isSpeakerMemberUniqueViolation,
  validateSpeakerMemberLink,
} from './speakerMemberLink.js';

function makeDb({ members = [], speakers = [], errors = {} } = {}) {
  const log = [];
  return {
    log,
    from(table) {
      const filters = {};
      const chain = {
        select() { return chain; },
        eq(column, value) { filters[column] = value; return chain; },
        neq(column, value) { filters[`${column}!=`] = value; return chain; },
        async maybeSingle() {
          log.push({ table, filters: { ...filters } });
          if (errors[table]) return { data: null, error: errors[table] };
          const rows = table === 'member' ? members : speakers;
          const found = rows.find((row) => Object.entries(filters).every(([key, value]) => (
            key.endsWith('!=') ? row[key.slice(0, -2)] !== value : row[key] === value
          )));
          return { data: found || null, error: null };
        },
      };
      return chain;
    },
  };
}

test('accepts a member from the speaker tenant when not linked elsewhere', async () => {
  const db = makeDb({ members: [{ id: 'm1', tenant_id: 't1' }] });
  const result = await validateSpeakerMemberLink({ db, tenantId: 't1', memberId: 'm1' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(db.log[0].filters, { id: 'm1', tenant_id: 't1' });
});

test('rejects a member from another tenant without exposing that tenant', async () => {
  const db = makeDb({ members: [{ id: 'm1', tenant_id: 't2' }] });
  const result = await validateSpeakerMemberLink({ db, tenantId: 't1', memberId: 'm1' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'Member does not belong to your tenant');
});

test('rejects duplicate links and excludes the speaker being edited', async () => {
  const members = [{ id: 'm1', tenant_id: 't1' }];
  const speakers = [{ id: 's1', tenant_id: 't1', member_id: 'm1', full_name: 'Ada' }];
  const duplicate = await validateSpeakerMemberLink({
    db: makeDb({ members, speakers }),
    tenantId: 't1',
    memberId: 'm1',
    excludeSpeakerId: 's2',
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'DUPLICATE_SPEAKER_MEMBER');

  const unchanged = await validateSpeakerMemberLink({
    db: makeDb({ members, speakers }),
    tenantId: 't1',
    memberId: 'm1',
    excludeSpeakerId: 's1',
  });
  assert.deepEqual(unchanged, { ok: true });
});

test('recognises only the speaker member unique index as the duplicate race', () => {
  assert.equal(isSpeakerMemberUniqueViolation({
    code: '23505',
    constraint: SPEAKER_MEMBER_UNIQUE_INDEX,
  }), true);
  assert.equal(isSpeakerMemberUniqueViolation({
    code: '23505',
    message: `duplicate key violates unique constraint "${SPEAKER_MEMBER_UNIQUE_INDEX}"`,
  }), true);
  assert.equal(isSpeakerMemberUniqueViolation({
    code: '23505',
    constraint: 'another_unique_index',
  }), false);
});