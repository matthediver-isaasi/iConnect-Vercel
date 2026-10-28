import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./eventZoomRegistration.js', import.meta.url), 'utf8')
  .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g, '')
  .replaceAll('export async function', 'async function');
function helper({ failPage = -1 } = {}) {
  const calls = [], logs = [];
  const db = { from(table) {
    const call = { table, filters: [] }; calls.push(call);
    const q = {
      select(columns) { call.columns = columns; return q; },
      eq(...args) { call.filters.push(args); return q; },
      order(key) { call.order = key; return q; },
      range(start, end) { call.range = [start, end]; return q; },
      then(resolve) {
        const page = call.range[0] / 500;
        return Promise.resolve(page === failPage
          ? { error: { code: '42703', message: 'private attendee and token', details: 'private' } }
          : { data: Array.from({length: page === 0 ? 500 : 1}, (_, i) => ({id: String(page * 500 + i)})) }).then(resolve);
      },
    }; return q;
  }};
  const fns = new Function('supabase', 'console', 'getZoomAccessTokenForTenant', 'readZoomRegistration', 'listZoomRegistrations',
    source + '; return {confirmedZoomBookings, zoomEvidence};')(
      db, {error: (...args) => logs.push(args)}, async()=> 'token',
      async()=>({topic:'Live meeting',numericId:'123',registration_required:true}),
      async()=> { throw Error('Registrant lookup must not run without bookings'); });
  return {...fns, calls, logs};
}
test('real projection preserves email fields, tenant/event/status scopes and stable multi-page reads', async()=>{
  const h=helper();
  assert.equal((await h.confirmedZoomBookings('event','tenant')).length,501);
  assert.deepEqual(h.calls.map(c=>c.range),[[0,499],[500,999]]);
  for(const c of h.calls) {
    assert.equal(c.table,'booking'); assert.equal(c.order,'id');
    assert.deepEqual(c.filters,[['event_id','event'],['tenant_id','tenant'],['status','confirmed']]);
    assert.doesNotMatch(c.columns,/discount_amount|free_tickets/);
    for(const field of ['member_id','booking_reference','ticket_price','ticket_class_name','ticket_class_id','total_cost']) assert.ok(c.columns.split(', ').includes(field));
  }
});
test('later-page failure discards partial results and logs only safe context', async()=>{
  const h=helper({failPage:1});
  await assert.rejects(h.confirmedZoomBookings('event','tenant'),e=>e.code==='42703');
  assert.equal(h.logs[0][1].offset,500);
  assert.doesNotMatch(JSON.stringify(h.logs),/private|token|attendee/);
});
test('missing bookings do not hide live identity or claim zero registrations', async()=>{
  const h=helper();
  const evidence=await h.zoomEvidence('tenant',{zoom_meeting_id:'123',topic:'Cached meeting'},'meetings',null);
  assert.equal(evidence.live.topic,'Live meeting');
  assert.equal(evidence.cached.topic,'Cached meeting');
  assert.equal(evidence.counts,null);
  assert.equal(evidence.registrationError,undefined);
});
