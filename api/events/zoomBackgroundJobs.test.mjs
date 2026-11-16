import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function run({ kind = 'event', admin = true, authenticated = true, method = 'POST', foreign = false, status = false } = {}) {
  const file = kind === 'event' ? './[id]/change-zoom.js' : '../complex-event-sessions/[id]/change-zoom.js';
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g, '').replace('export default async function handler', 'return async function handler');
  const bookings = Array.from({ length: 43 }, (_, i) => ({ id: `booking-${i}`, attendee_email: 'test@example.invalid' }));
  const writes = [], jobs = [], statuses = [];
  const db = { from(table) {
    const chain = {};
    for (const op of ['select','eq','in','order','range','single','maybeSingle','update']) {
      chain[op] = (...args) => { if (op === 'update') writes.push([table,args[0]]); return chain; };
    }
    chain.then = resolve => Promise.resolve({ data:
      table === 'event' || table === 'complex_event_session' ? { id: 'event', tenant_id: 'tenant', complex_event_id: 'parent', zoom_meeting_id: null, zoom_webinar_id: null }
      : table === 'complex_event_session_track' ? [{ complex_event_track_id: 'track' }]
      : table === 'complex_event_ticket_class' ? [{ id: 'ticket', all_tracks: true }]
      : table === 'complex_event_booking' ? bookings
      : { id: 'local', tenant_id: foreign ? 'foreign' : 'tenant', zoom_meeting_id: '123' }, error: null }).then(resolve);
    return chain;
  } };
  const never = async () => { throw new Error('Attendee effects must not run in HTTP request'); };
  const deps = {
    supabase: db,
    getTenantContext: async () => ({ isAuthenticated: authenticated, tenantId: 'tenant', tenantUserId: 'admin' }),
    hasAdminAccess: async () => admin, cancelZoomRegistrant: never, cancelZoomMeetingRegistrant: never,
    confirmedZoomBookings: async () => bookings,
    zoomAuthority: async () => ({ live: { registration_required: true }, token: 'fixture', kind: 'meetings', id: '123' }),
    zoomEvidence: never, listZoomRegistrations: never, registerWithZoom: never, sendConfirmationEmailsFromTemplate: never,
    enqueueZoomJob: async args => { jobs.push(args); return { id: 'job', status: 'queued' }; },
    latestZoomJob: async (...args) => { statuses.push(args); return { id: 'job' }; },
  };
  const handler = new Function(...Object.keys(deps), source)(...Object.values(deps));
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method, query: { id: 'event', ...(status ? { jobStatus: 'true' } : {}) }, body: {
    background: true, requestKey: 'request', zoom_meeting_id: 'local', registerNew: true, cancelOld: false, resendConfirmations: true,
  } }, res);
  return { res, jobs, writes, statuses };
}
for (const kind of ['event','session']) {
  test(`${kind}: queues every confirmed booking atomically with the target, email choice and tenant`, async () => {
    const f = await run({ kind });
    assert.equal(f.res.code, 202);
    assert.equal(f.jobs.length, 1);
    assert.equal(f.jobs[0].bookings.length, 43);
    assert.equal(f.jobs[0].tenantId, 'tenant');
    assert.equal(f.jobs[0].body.resendConfirmations, true);
    assert.equal(f.jobs[0].target.current.zoom_meeting_id, kind === 'event' ? 'local' : '123');
    assert.ok(!f.writes.some(([table]) => ['event','complex_event_session'].includes(table)));
  });
  test(`${kind}: admin and authentication gates protect creation and status`, async () => {
    for (const method of ['GET','POST']) {
      const denied = await run({ kind, method, status: true, admin: false });
      assert.equal(denied.res.code, 403); assert.equal(denied.jobs.length, 0); assert.equal(denied.statuses.length, 0);
      assert.equal((await run({ kind, method, status: true, authenticated: false })).res.code, 401);
    }
    const f = await run({ kind, method: 'GET', status: true });
    assert.deepEqual(f.statuses, [['tenant', kind, 'event']]);
  });
  test(`${kind}: cross-tenant target never enters the queue`, async () => {
    const f = await run({ kind, foreign: true });
    assert.equal(f.res.code, 400);
    assert.equal(f.jobs.length, 0);
  });
}
