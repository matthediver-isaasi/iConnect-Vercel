import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deliverZoomConfirmation, validZoomConfirmationOperation } from './zoomConfirmationDelivery.js';
import { createZoomOperation, runZoomOperation } from '../../client/src/components/events/changeZoomWorkflow.mjs';

const operationId = '00000000-0000-4000-8000-000000000001';
function ledger() {
  const rows = new Map();
  let failInsert = false, failComplete = false;
  return {
    rows,
    failInsert() { failInsert = true; },
    failComplete() { failComplete = true; },
    from() {
      let action, value, filters = {};
      const q = {
        insert(v) { action = 'insert'; value = v; return q; },
        update(v) { action = 'update'; value = v; return q; },
        select() { return q; },
        eq(k,v) { filters[k] = v; return q; },
        single() { return q; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (action === 'insert') {
              if (failInsert) return { error: { code: '42P01' } };
              const key = JSON.stringify([value.tenant_id,value.scope,value.resource_id,value.operation_id,value.booking_id]);
              if (rows.has(key)) return { error: { code: '23505' } };
              rows.set(key, { ...value });
              return { error: null };
            }
            const row = [...rows.values()].find(r => Object.entries(filters).every(([k,v]) => r[k] === v));
            if (!row || (action === 'update' && failComplete)) return { error: { code: 'failure' } };
            if (action === 'update') Object.assign(row, value);
            return { data: { ...row }, error: null };
          }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}
const identity = { tenantId:'tenant',scope:'event',resourceId:'event',operationId,bookingId:'booking',target:'meeting' };

test('lost send acknowledgement never releases a claim, including final database failure', async () => {
  for (const mode of ['provider', 'database', 'partial', 'empty']) {
    const db = ledger(); let sends = 0;
    if (mode === 'database') db.failComplete();
    const send = async () => {
      sends++;
      if (mode === 'provider') throw new Error('lost provider response');
      if (mode === 'partial') return [{ success:true }, { success:false }];
      return mode === 'empty' ? [] : [{ success:true }];
    };
    await assert.rejects(deliverZoomConfirmation(db,identity,send));
    await assert.rejects(deliverZoomConfirmation(db,identity,send), /uncertain/);
    assert.equal(sends,1);
  }
});
test('claim storage failure is fail closed; identity includes tenant, session, booking and operation', async () => {
  const db = ledger(); let sends = 0;
  const send = async () => { sends++; return [{success:true}]; };
  db.failInsert();
  await assert.rejects(deliverZoomConfirmation(db,identity,send), /no email sent/);
  assert.equal(sends,0);
  const ok = ledger();
  for (const i of [identity, {...identity,tenantId:'other'}, {...identity,scope:'session'},
    {...identity,resourceId:'session-2'}, {...identity,bookingId:'booking-2'}, {...identity,operationId:'later'}]) {
    await deliverZoomConfirmation(ok,i,send);
    await deliverZoomConfirmation(ok,i,send);
  }
  assert.equal(sends,6);
  await assert.rejects(deliverZoomConfirmation(ok,{...identity,target:'changed'},send), /different Zoom target/);
});

for (const scope of ['event','session']) {
  const path = scope === 'event' ? '../events/[id]/change-zoom.js' : '../complex-event-sessions/[id]/change-zoom.js';
  const source = readFileSync(new URL(path,import.meta.url),'utf8')
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g,'')
    .replace('export default async function handler','return async function handler');
  function fixture(registrationRequired = false) {
    const store = ledger(); let sends = 0, hold;
    const booking = {id:'booking',attendee_email:'test@example.invalid'};
    const db = { from(table) {
      if (table === 'zoom_confirmation_delivery') return store.from(table);
      const data = {
        event: { id:'event',zoom_meeting_id:'local' },
        complex_event_session: { id:'session',complex_event_id:'event',zoom_meeting_id:'123' },
        complex_event_session_track: [],
        complex_event_ticket_class: [{id:'ticket',all_tracks:true}],
        complex_event_booking: [booking],
        zoom_meeting: {id:'local',tenant_id:'tenant',zoom_meeting_id:'123'},
      }[table];
      const q = {then(resolve) {return Promise.resolve({data,error:null}).then(resolve);}};
      for (const name of ['select','eq','in','order','single','maybeSingle','update','range']) q[name] = () => q;
      return q;
    }};
    const dependencies = {
      supabase:db, getTenantContext:async()=>({isAuthenticated:true,tenantId:'tenant'}),
      hasAdminAccess:async()=>true, confirmedZoomBookings:async()=>[booking],
      zoomAuthority:async()=>({live:{registration_required:registrationRequired},kind:'meetings',id:'123'}),
      enqueueZoomJob:async ({body})=>({id:body.requestKey,status:'queued'}),
      validZoomConfirmationOperation, deliverZoomConfirmation,
      sendConfirmationEmailsFromTemplate:async()=>{
        sends++; if (hold) await hold; return [{success:true}];
      },
    };
    const handler = new Function(...Object.keys(dependencies),source)(...Object.values(dependencies));
    async function post(body) {
      const res = {status(n){this.code=n;return this;},json(d){this.body=d;return this;}};
      await handler({method:'POST',query:{id:scope},body},res);
      if (res.code !== 200 && res.code !== 202) throw new Error(`${res.code}: ${res.body.error}`);
      return res.body;
    }
    return {post,store,get sends(){return sends;},set hold(value){hold=value;}};
  }
  const body = {zoom_meeting_id:'local',zoom_webinar_id:null,cancelOld:false,registerNew:false,resendConfirmations:true};
  test(`${scope}: background registration uses its durable request key, not the interactive operation ID`, async () => {
    const f = fixture(true);
    const request = {...body,background:true,registerNew:true,requestKey:operationId};
    assert.equal((await f.post(request)).job.id, operationId);
    assert.equal(f.sends,0);
    await assert.rejects(f.post({...request,requestKey:null}),/400/);
  });
  test(`${scope}: actual handler and client retry lost HTTP response without another send; later consent sends again`, async () => {
    const f = fixture();
    const op = createZoomOperation(body,{zoom_meeting_id:'local',zoom_webinar_id:null});
    await assert.rejects(runZoomOperation(op,async request=>{
      await f.post(request); throw new Error('HTTP response lost');
    }),/lost/);
    assert.equal(f.sends,1);
    await runZoomOperation(op,f.post);
    assert.equal(f.sends,1);
    assert.equal(op.totals.emailed,1);
    const later = createZoomOperation(body,{zoom_meeting_id:'local',zoom_webinar_id:null});
    assert.notEqual(later.body.confirmationOperationId,op.body.confirmationOperationId);
    await runZoomOperation(later,f.post);
    assert.equal(f.sends,2);
  });
  test(`${scope}: concurrent requests cannot both send; missing consent and missing identity cannot send`, async () => {
    const f = fixture();
    let release;
    f.hold = new Promise(resolve => {release=resolve;});
    const request = {...body,confirmationOperationId:operationId};
    const first = f.post(request);
    for (let i = 0; !f.sends && i < 100; i++) await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.sends,1);
    const concurrent = await f.post(request);
    assert.equal(f.sends,1);
    assert.match(concurrent.errors[0].message,/uncertain/);
    release(); await first;
    assert.equal((await f.post(request)).emailed,1);
    await f.post({...request,resendConfirmations:false});
    await assert.rejects(f.post({...request,confirmationOperationId:null}),/400/);
    await assert.rejects(f.post({...request,resendConfirmations:'true'}),/400/);
    assert.equal(f.sends,1);
  });
}
