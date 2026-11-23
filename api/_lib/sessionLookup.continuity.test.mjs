import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { boundedSessionLookup, sessionDatabase } from './sessionAvailability.js';

// Load the actual helpers with an isolated database, without creating users,
// sessions, provider requests, or changing the real database.
const require = createRequire(import.meta.url);
let failure;
let absent = false;
let disabled = false;
let paused = false;
let revoked = false;
let expired = false;
let deletes = 0;
let delayTable = null;
const reads = [];
const db = {
  from(table) {
    let deleting = false;
    const query = {
      select() { return this; }, eq() { return this; },
      delete() { deleting = true; return this; },
      then(resolve, reject) { return this.maybeSingle().then(resolve, reject); },
      single() { return this.maybeSingle(); },
      async maybeSingle() {
        reads.push(table);
        if (table === delayTable) await new Promise(resolve => setTimeout(resolve, 50));
        if (deleting) { deletes++; return { data: null }; }
        if (failure === table) return { data: null, error: { message: 'fixture outage' } };
        if (table === 'session') return { data: absent ? null : {
          expire: new Date(Date.now() + (expired ? -1000 : 60000)).toISOString(),
          sess: { memberId: 'member-fixture' },
        } };
        if (table === 'member') return { data: { id: 'member-fixture', login_enabled: !disabled, membership_paused: paused } };
        if (table === 'member_login_session_revocation') return { data: revoked ? { generation: 1 } : null };
        throw new Error(`Unexpected fixture table ${table}`);
      },
    };
    return query;
  },
};
globalThis.__sessionContinuityDb = sessionDatabase(db);
let source = await fs.readFile(new URL('./session.js', import.meta.url), 'utf8');
source = source.replace("import { supabase } from './database.js';", 'const supabase = globalThis.__sessionContinuityDb;');
source = source.replace(/from '([^']+)'/g, (_, path) => {
  const url = path.startsWith('.') ? new URL(path, import.meta.url).href
    : path === 'crypto' ? 'node:crypto' : `file://${require.resolve(path)}`;
  return `from '${url}'`;
});
const { getSession, getSessionMember, getSessionTenantUser } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
delete globalThis.__sessionContinuityDb;
const req = { headers: { cookie: 'iconnect.sid=fixture-only' } };

test('tenant-user lookup accepts an explicitly checked absent session without reading again', async () => {
  failure = 'session';
  assert.equal(await getSessionTenantUser(req, null), null);
  await assert.rejects(getSessionTenantUser(req), { code: 'SESSION_UNAVAILABLE' });
  failure = undefined;
});

test('session/member/fence outages deny without deleting the session; valid state recovers', async () => {
  for (const table of ['session', 'member', 'member_login_session_revocation']) {
    failure = table;
    await assert.rejects(getSessionMember(req), error => error.code === 'SESSION_UNAVAILABLE');
    assert.equal(deletes, 0);
  }
  failure = undefined;
  assert.equal((await getSessionMember(req)).id, 'member-fixture');
  assert.equal(deletes, 0);
});

test('confirmed absence, expiry, disabled login, pause and revocation still reject', async () => {
  absent = true;
  assert.equal(await getSession(req), null);
  absent = false;
  expired = true;
  assert.equal(await getSession(req), null);
  expired = false;
  disabled = true;
  assert.equal(await getSessionMember(req), null);
  disabled = false;
  paused = true;
  assert.equal(await getSessionMember(req), null);
  paused = false;
  revoked = true;
  assert.equal(await getSessionMember(req), null);
  assert.equal(deletes, 4);
  revoked = false;
});

test('timed-out actual session helper does not continue into fences or delete a late absent session', async () => {
  for (const table of ['session', 'member']) {
    const beforeDeletes = deletes;
    reads.length = 0;
    delayTable = table;
    await assert.rejects(boundedSessionLookup(() => getSessionMember(req), 10),
      { code: 'SESSION_UNAVAILABLE' });
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(deletes, beforeDeletes);
    assert.equal(reads.includes('member_login_session_revocation'), false);
    if (table === 'session') assert.deepEqual(reads, ['session']);
    delayTable = null;
  }
  assert.equal((await getSessionMember(req)).id, 'member-fixture');
});
