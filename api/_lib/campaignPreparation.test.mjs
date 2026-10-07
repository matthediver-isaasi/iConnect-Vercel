import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCampaignAudience, preparationContext, isRetryablePreparationError } from './campaignPreparation.js';
import { resolveEventSurveyAudience } from './eventSurveyAudience.js';
import { resolvePreparationChunk } from './campaignPreparationStream.js';
import { resolveSpeakerAudience, validateSpeakerAudienceSegments } from './eventSpeakerAudience.js';

process.env.SUPABASE_URL = 'https://campaign-preparation.invalid';
process.env.SUPABASE_SERVICE_KEY = 'isolated-test-key';
const { getTargetRecipients, applyConditionToQuery, applyPrefValueCondition } = await import('./campaignService.js');
const { supabase } = await import('./database.js');

test('speaker preview and resumed preparation share assignments, identities, suppression and deduplication', async () => {
  const segment = { type: 'event_speakers', ids: ['simple', 'complex'], events: [
    { id: 'simple', source: 'event' }, { id: 'complex', source: 'complex_event' },
  ] };
  const speaker = (id, extra = {}) => ({ id, tenant_id: 'tenant', email: `${id}@example.com`, is_active: true, ...extra });
  const many = Array.from({ length: 405 }, (_, i) => speaker(`bulk-${String(i).padStart(3, '0')}`));
  const tables = {
    event: [{ id: 'simple', tenant_id: 'tenant', speaker_ids: ['linked', 'external', 'duplicate', 'inactive', 'missing', 'bad', 'foreign', 'dangling', 'no-member-email', 'deleted', 'optout', 'unsub', ...many.map(s => s.id)] }],
    complex_event: [{ id: 'complex', tenant_id: 'tenant', speaker_ids: ['external'] }],
    event_agenda_item: Array.from({ length: 205 }, (_, i) => ({ id: `agenda-${String(i).padStart(3, '0')}`, tenant_id: 'tenant', event_id: 'simple', speaker_ids: ['agenda-speaker'] })),
    complex_event_session: [{ id: 'session', tenant_id: 'tenant', complex_event_id: 'complex', speaker_ids: ['session-speaker', 'external'] }],
    speaker: [speaker('linked', { member_id: 'member' }), speaker('external', { email: ' EXTERNAL@example.com ' }),
      speaker('inactive', { is_active: false }), speaker('bad', { email: 'invalid' }),
      speaker('foreign', { tenant_id: 'other' }), speaker('dangling', { member_id: 'foreign-member' }),
      speaker('duplicate', { email: 'external@example.com' }),
      speaker('no-member-email', { member_id: 'no-email' }), speaker('deleted', { email: 'deleted_person@deleted.local' }),
      speaker('optout', { member_id: 'opted-member' }), speaker('unsub'),
      speaker('agenda-speaker'), speaker('session-speaker'), ...many],
    member: [{ id: 'member', tenant_id: 'tenant', email: 'member@example.com' },
      { id: 'no-email', tenant_id: 'tenant', email: null },
      { id: 'opted-member', tenant_id: 'tenant', email: 'opted@example.com', communications_opted_out_all: true }],
    booking: [{ id: 'attendee-only', tenant_id: 'tenant', event_id: 'simple', status: 'confirmed', attendee_email: 'attendee@example.com' }],
    email_unsubscribe: [{ id: 'unsub', tenant_id: 'tenant', email: 'unsub@example.com', unsubscribe_type: 'all' }],
  };
  const model = fixture(tables, [segment, { type: 'individual_members', ids: ['member'] }]);
  const preview = await preparationContext.run({ db: model.db }, () => getTargetRecipients(model.state.snapshot, 'tenant'));
  assert.equal(preview.success, true, preview.error);
  const addresses = new Set(preview.recipients.map(r => r.email));
  assert.equal(addresses.size, 409);
  assert.ok(addresses.has('member@example.com'));
  assert.ok(!addresses.has('linked@example.com'));
  assert.ok(!addresses.has('attendee@example.com'));
  const external = preview.recipients.find(r => r.email === 'external@example.com');
  assert.equal(external.member_id, null);
  const count = await preparationContext.run({ db: model.db }, () => getTargetRecipients(model.state.snapshot, 'tenant', true));
  assert.equal(count.count, addresses.size);
  model.crashAfter = 'chunk';
  for (let attempt = 0; attempt < 400 && model.state.phase !== 'complete'; attempt++) {
    await model.run({ resolveChunk: resolvePreparationChunk });
  }
  assert.equal(model.state.phase, 'complete', 'many agenda assignments must make forward progress');
  assert.deepEqual(new Set(model.recipients.keys()), addresses);
  const bypass = await preparationContext.run({ db: model.db }, () => getTargetRecipients({ ...model.state.snapshot, ignore_opt_outs: true }, 'tenant'));
  assert.equal(bypass.recipients.length, 411);
  tables.member_communication_preference = [{ tenant_id: 'tenant', member_id: 'member', category_id: 'category', is_subscribed: true }];
  tables.email_unsubscribe.push({ id: 'category-unsub', tenant_id: 'tenant', email: 'external@example.com',
    unsubscribe_type: 'category', communication_category_id: 'category' });
  const category = await preparationContext.run({ db: model.db }, () => getTargetRecipients({
    ...model.state.snapshot, communication_category_id: 'category',
  }, 'tenant'));
  assert.equal(category.success, true, category.error);
  assert.equal(category.recipients.length, 408);
  assert.ok(category.recipients.some(r => r.email === 'member@example.com'));
  await assert.rejects(validateSpeakerAudienceSegments(model.db, 'other', [segment]), /inaccessible/);
  await assert.rejects(resolveSpeakerAudience(model.db, 'tenant', { ...segment, events: [{ id: 'simple', source: 'wrong' }] }), /event kind/);
  await assert.rejects(resolveSpeakerAudience({ from() { throw new Error('Source unavailable'); } }, 'tenant', segment), /Source unavailable/);
});

// Any escape from the journal/client injected into a test is a failure, never
// a real database read/write.
supabase.from = () => { throw new Error('Unexpected non-journal database access'); };
supabase.rpc = () => { throw new Error('Unexpected non-journal RPC'); };

function fixture(tables, segments = [{ type: 'all_members', ids: [] }]) {
  const state = {
    id: 'generation', campaign_id: 'campaign', tenant_id: 'tenant',
    snapshot: { id: 'campaign', tenant_id: 'tenant', status: 'preparing',
      sent_at: '2026-01-01T00:00:00Z', target_audiences: segments },
    phase: 'resolve', segment: 0, cursor: 0, total: 0, continuation: {},
  };
  const model = {
    state, clock: 0, journal: [], staged: new Map(), recipients: new Map(),
    sourceReads: new Map(), actions: [], status: 'preparing', pageSizes: [],
    sourceCost: 700, writeCost: 20, quotaAllowed: true,
    facts: new Map(), candidates: [], sourceQueries: [],
  };
  const db = {
    from(table) {
      const filters = []; let start = 0; let end = Infinity; let single = false; let max = Infinity;
      let after = '', ordering, columns;
      const query = {
        select(value) { columns=value; return this; },
        eq(k,v) { filters.push(r => r[k] === v); return this; },
        neq(k,v) { filters.push(r => r[k] !== v); return this; },
        is(k,v) { filters.push(r => r[k] === v); return this; },
        in(k,v) { filters.push(r => v.includes(r[k])); return this; },
        not(k,op,v) {
          if (op === 'ilike') filters.push(r => !r[k]?.startsWith('deleted_'));
          else if(op === 'is') filters.push(r => r[k] !== v);
          return this;
        },
        gte(k,v) { filters.push(r => r[k] >= v); return this; },
        lt(k,v) { filters.push(r => r[k] < v); return this; },
        gt(k,v) { after=String(v); filters.push(r => r[k] > v); return this; },
        order(k) { ordering=k; return this; },
        range(a,b) { start=a; end=b; return this; },
        limit(n) { max=n; return this; },
        single() { single=true; return this; },
        maybeSingle() { single=true; return this; },
        abortSignal() { return this; },
        async then(resolve, reject) {
          try {
            const journal = table === 'campaign_preparation_read';
            model.clock += journal ? 2 : model.sourceCost;
            if (!journal) {
              model.sourceQueries.push({table,columns});
              const key = `${table}:${start}:${after}`;
              model.sourceReads.set(key,(model.sourceReads.get(key)||0)+1);
            }
            if (model.failTable === table) throw new Error('Source unavailable');
            const source = journal ? model.journal : table === 'campaign_preparation_fact'
              ? [...model.facts.values()] : tables[table] || [];
            const rows = source.filter(row => filters.every(f => f(row)))
              .sort((a,b) => ordering ? (a[ordering] < b[ordering] ? -1 : a[ordering] > b[ordering] ? 1 : 0) : 0)
              .slice(start,end+1).slice(0,max);
            if (journal) model.pageSizes.push(rows.length);
            return resolve({ data: structuredClone(single ? rows[0] || null : rows), error: null });
          } catch (error) { return reject(error); }
        },
      };
      return query;
    },
    async rpc(name, args) {
      if(name==='campaign_preparation_email_members'){
        model.clock+=model.sourceCost;
        const result=args.p_emails.flatMap(key=>{
          const found=(tables.member||[]).filter(m=>m.tenant_id===args.p_tenant&&
            (args.p_trim?m.email?.trim():m.email)?.toLowerCase()===key)
            .sort((a,b)=>a.id>b.id?-1:1);
          return found.length?[{...found[0],email_key:key,any_opted_out:found.some(m=>m.communications_opted_out_all===true)}]:[];
        });
        return {data:result,error:null};
      }
      if(name==='campaign_preparation_attended_bookings') return {data:[],error:null};
      assert.equal(name,'campaign_preparation_step');
      const action=args.p_action, p=args.p_payload;
      model.actions.push(action);
      model.clock += model.writeCost;
      if (model.status !== 'preparing') return { error: { message:'Preparation no longer authorized' } };
      if (action==='claim') {
        if (model.owner && model.owner!==args.p_owner) return { data:null };
        model.owner=args.p_owner;
      } else {
        if (model.owner!==args.p_owner) return { error:{message:'Preparation lease expired'} };
        if (action==='read') {
          if (!model.journal.some(r => r.key===p.key && r.segment===p.segment)) model.journal.push({
            generation:state.id,segment:p.segment,sequence:p.sequence,key:p.key,result:structuredClone(p.result),
          });
        } else if(action==='stream'){
          assert.deepEqual(p.expected,state.continuation);
          assert.ok(p.candidates.length<=200);
          for(const f of p.facts)model.facts.set(`${state.segment}:${f.bucket}:${f.key}`,
            {generation:state.id,segment:state.segment,...structuredClone(f)});
          model.candidates.push(...structuredClone(p.candidates));
          state.continuation=p.done?{}:structuredClone(p.continuation);
          model.journal=model.journal.filter(r=>r.segment!==state.segment);
          if(p.done)state.segment++;
        } else if(action==='stream_resolved'){
          state.phase='global_consent';state.cursor=0;
        } else if(action==='global_consent'){
          const batch=model.candidates.slice(state.cursor,state.cursor+200);
          for(const r of batch){
            r.globalEligible=r.bypass_opt_out || (!r.communications_opted_out_all&&
              !(tables.email_unsubscribe||[]).some(u=>u.tenant_id===state.tenant_id&&u.unsubscribe_type==='all'&&u.email.trim().toLowerCase()===r.email.trim().toLowerCase()));
          }
          state.cursor+=batch.length;
          if(!batch.length){state.phase='consent';state.cursor=0;}
        } else if(action==='consent'){
          const eligible=model.candidates.filter(r=>r.globalEligible);
          const batch=eligible.slice(state.cursor,state.cursor+200);
          for(const r of batch)if(!model.staged.has(r.email.toLowerCase()))model.staged.set(r.email.toLowerCase(),r);
          state.cursor+=batch.length;state.total=model.staged.size;
          if(!batch.length){
            if(!state.total)return {error:{code:'P0001',message:'No recipients found for this campaign'}};
            state.phase='quota';state.cursor=0;
          }
        } else if (action==='stage') {
          assert.equal(p.cursor,state.cursor);
          for (const r of p.recipients) if (!model.staged.has(r.email.toLowerCase())) model.staged.set(r.email.toLowerCase(),r);
          state.cursor+=p.recipients.length;
        } else if (action==='segment') {
          state.segment++;state.cursor=0;
          model.journal=model.journal.filter(r => r.segment!==p.segment);
        } else if (action==='resolved') {
          state.phase='quota';state.cursor=0;state.total=model.staged.size;
        } else if (action==='quota') {
          if (!model.quotaAllowed) return {error:{message:'Plan quota exceeded'}};
          state.phase='insert';
        } else if (action==='insert') {
          assert.equal(p.cursor,state.cursor);
          for (const r of [...model.staged.values()].slice(state.cursor,state.cursor+200)) model.recipients.set(r.email,r);
          state.cursor=Math.min(state.total,state.cursor+200);
        } else if (action==='complete') {
          assert.equal(state.cursor,state.total);
          if (!model.quotaAllowed) return {error:{message:'Plan quota exceeded'}};
          state.phase='complete';model.status='sending';
        } else if (action==='fail') {
          state.phase='failed';state.last_error=p.error;model.status='failed';model.owner=null;
        } else if (action==='release') { model.owner=null;state.last_error=p.error; }
      }
      if (model.afterAction) await model.afterAction(action);
      if (model.crashAfter===action) {
        model.crashAfter=null;
        throw Object.assign(new Error(`Lost response after committed ${action}`), {code:'ECONNRESET'});
      }
      return { data:structuredClone(state),error:null };
    },
  };
  model.db = db;
  model.run = (overrides={}) => prepareCampaignAudience({
    db,generation:state.id,owner:'worker',now:()=>model.clock,deadline:model.clock+4200,
    authorize:async()=>{},quota:async()=>({ok:true}),resolve:getTargetRecipients,...overrides,
  });
  model.finish = async(overrides={}) => {
    for(let attempts=0; attempts<150 && state.phase!=='complete'; attempts++) await model.run(overrides);
    assert.equal(state.phase,'complete','preparation must make progress across budgets');
  };
  const stream=input=>resolvePreparationChunk({...input,conditions:{applyConditionToQuery,applyPrefValueCondition}});
  model.stream = overrides => model.run({resolveChunk:stream,...overrides});
  model.finishStream = overrides => model.finish({resolveChunk:stream,...overrides});
  return model;
}

test('12,000 normal members: resolution checkpoints before insertion, consent, dedup and bounded journal pages',async()=>{
  const members=Array.from({length:12000},(_,i)=>({
    id:`member-${i}`,tenant_id:'tenant',email:`recipient-${i}@example.com`,
    communications_opted_out_all:i%10===0,
  }));
  const model=fixture({member:members,email_unsubscribe:[
    {id:'unsubscribe',tenant_id:'tenant',unsubscribe_type:'all',email:'recipient-1@example.com'},
  ]});
  const first=await model.run();
  assert.equal(first.status,'preparing');
  assert.equal(model.state.phase,'resolve');
  assert.equal(model.recipients.size,0);
  assert.ok(model.journal.length>0,'source resolution itself must be checkpointed');
  await model.finish();
  assert.equal(model.recipients.size,10799);
  assert.ok(model.pageSizes.every(n=>n<=8),'journal history is never loaded without a page bound');
  assert.ok([...model.sourceReads.values()].every(n=>n===1),'completed source reads replay instead of restarting');
});

test('large real survey resolver preserves assignment, attendee identity and responded/no-response distinction across crashes',async()=>{
  const scoped={tenant_id:'tenant',form_id:'form'};
  const tables={
    form:[{id:'form',tenant_id:'tenant',form_type:'survey',survey_settings:{current_version:1}}],
    event_survey_assignment:[{...scoped,id:'assignment',event_type:'event',event_id:'event',survey_version_id:'version',status:'archived'}],
    event:[{id:'event',tenant_id:'tenant'}],
    survey_version:[{...scoped,id:'version',version_number:1,survey_settings:{response_identity:'identified'}}],
    form_submission:Array.from({length:2500},(_,i)=>({...scoped,id:`response-${i}`,
      survey_assignment_id:'assignment',survey_version_id:'version',
      submitted_by_email:`attendee-${i}@example.com`,is_anonymous:false})),
    booking:Array.from({length:6000},(_,i)=>({id:`booking-${i}`,tenant_id:'tenant',
      event_id:'event',status:i===5999?'cancelled':'confirmed',member_id:'purchaser',
      attendee_email:`attendee-${i}@example.com`})),
  };
  const segment={type:'event_form',form_id:'form',survey_assignment_id:'assignment',received:false};
  const model=fixture(tables,[segment]);
  const resolve=async campaign=>({success:true,recipients:await resolveEventSurveyAudience(
    preparationContext.getStore().db,'tenant',campaign.target_audiences[0])});
  model.crashAfter='read';
  await model.run({resolve});
  model.crashAfter='stage';
  await model.finish({resolve});
  assert.equal(model.recipients.size,3499);
  assert.ok([...model.recipients.values()].every(r=>r.member_id===null));
  assert.ok(!model.recipients.has('attendee-0@example.com'));
  assert.ok(!model.recipients.has('attendee-5999@example.com'));
});

for(const crash of ['stage','segment','resolved','quota','insert','complete']){
  test(`committed ${crash} with lost response resumes idempotently and cannot promote a prefix`,async()=>{
    const model=fixture({member:Array.from({length:650},(_,i)=>({
      id:`member-${i}`,tenant_id:'tenant',email:`member-${i}@example.com`,
    }))});
    model.sourceCost=1;
    model.crashAfter=crash;
    await model.run({deadline:model.clock+100000});
    if(crash!=='complete') assert.equal(model.status,'preparing');
    await model.finish();
    assert.equal(model.recipients.size,650);
    assert.equal(model.state.total,650);
  });
}

test('quota failures retain resolved audience for retry; cancellation fences partial insertion',async()=>{
  const model=fixture({member:Array.from({length:500},(_,i)=>({
    id:`m${i}`,tenant_id:'tenant',email:`m${i}@example.com`,
  }))});
  model.sourceCost=1;model.quotaAllowed=false;
  const blocked=await model.run();
  assert.equal(blocked.success,false);
  assert.match(blocked.error,/quota/i);
  assert.equal(model.state.phase,'quota');
  assert.equal(model.recipients.size,0);
  const reads=[...model.sourceReads.values()].reduce((a,b)=>a+b,0);
  model.quotaAllowed=true;
  model.afterAction=async action=>{if(action==='insert') model.status='cancelled';};
  await model.run();
  assert.equal(model.status,'cancelled');
  assert.equal(model.recipients.size,200);
  assert.equal([...model.sourceReads.values()].reduce((a,b)=>a+b,0),reads);
  assert.ok(!model.actions.includes('complete'));
});

test('authority revocation stops before any audience mutation; paused claims do not run',async()=>{
  const model=fixture({});
  const result=await model.run({authorize:async()=>{throw new Error('Group authority revoked');}});
  assert.match(result.error,/authority revoked/);
  assert.equal(model.journal.length,0);
  assert.equal(model.recipients.size,0);
  model.status='paused';
  await assert.rejects(model.run(),/no longer authorized/);
});

test('60,000-member single segment progresses when old replay history alone exceeds the entire budget',async()=>{
  const members=Array.from({length:60000},(_,i)=>({id:`m${String(i).padStart(8,'0')}`,
    tenant_id:'tenant',email:`member${i}@example.com`,communications_opted_out_all:i%10===0}));
  const model=fixture({member:members});
  // A legacy replay would need 20,000 sequential lookups, already more than
  // the invocation budget without even fetching a new source page.
  model.journal=Array.from({length:20000},(_,i)=>({
    generation:model.state.id,segment:0,sequence:i,key:`old-${i}`,result:{data:[],error:null},
  }));
  await model.stream();
  assert.ok(model.candidates.length>=200);
  assert.equal(model.journal.length,0,'committed transition retires prior read history');
  assert.ok(model.state.continuation.stack[0].cursor);
  await model.finishStream();
  assert.equal(model.recipients.size,54000);
  assert.ok(model.pageSizes.every(n=>n<=8));
  assert.ok([...model.sourceReads.entries()].filter(([key])=>key.startsWith('member:')).every(([,n])=>n===1));
});

test('streamed survey policy/evidence and attendee membership survive crashes without replaying history',async()=>{
  const scoped={tenant_id:'tenant',form_id:'form'};
  const tables={
    form:[{id:'form',tenant_id:'tenant',form_type:'survey',survey_settings:{current_version:1}}],
    event_survey_assignment:[{...scoped,id:'assignment',event_type:'event',event_id:'event',survey_version_id:'version',status:'archived'}],
    event:[{id:'event',tenant_id:'tenant'}],
    survey_version:[{...scoped,id:'version',version_number:1,survey_settings:{response_identity:'identified'}}],
    form_submission:Array.from({length:2500},(_,i)=>({...scoped,id:`response-${String(i).padStart(6,'0')}`,
      survey_assignment_id:'assignment',survey_version_id:'version',submitted_by_email:`a${i}@example.com`,is_anonymous:false})),
    booking:Array.from({length:6000},(_,i)=>({id:`booking-${String(i).padStart(6,'0')}`,tenant_id:'tenant',
      event_id:'event',status:i===5999?'cancelled':'confirmed',member_id:'purchaser',attendee_email:`a${i}@example.com`})),
  };
  const segment={type:'event_form',form_id:'form',survey_assignment_id:'assignment',received:false};
  const model=fixture(tables,[segment]);
  model.sourceCost=100;
  model.crashAfter='stream';
  await model.stream();
  await model.finishStream();
  assert.equal(model.recipients.size,3499);
  assert.ok([...model.recipients.values()].every(r=>r.member_id===null));
  assert.ok(model.facts.size>2500,'policy/evidence are indexed facts, not continuation arrays');
  assert.ok(JSON.stringify(model.state.continuation).length<100,'completed segment drops its continuation');
});

test('streamed field-filter sets and per-condition reductions remain bounded and match the legacy resolver',async()=>{
  const members=Array.from({length:5000},(_,i)=>({id:`m${String(i).padStart(6,'0')}`,tenant_id:'tenant',
    email:`m${i}@example.com`,login_enabled:i%2===0,communications_opted_out_all:false}));
  const tables={member:members,member_preference_value:members.map((m,i)=>({
    id:`p${String(i).padStart(6,'0')}`,member_id:m.id,field_id:'score',value:String(i%100),
  }))};
  const segment={type:'field_filter',filter_groups:[{conditions:[
    {entity_scope:'member',field_type:'core',field_key:'login_enabled',operator:'is_true'},
    {entity_scope:'member',field_type:'custom',field_key:'score',operator:'greater_than',data_type:'number',value:75},
  ]}]};
  const model=fixture(tables,[segment]);model.sourceCost=100;
  const legacy=await preparationContext.run({db:model.db},()=>getTargetRecipients(model.state.snapshot,'tenant'));
  assert.equal(legacy.success,true);
  model.sourceReads.clear();
  await model.finishStream();
  assert.deepEqual([...model.recipients.keys()].sort(),legacy.recipients.map(r=>r.email.toLowerCase()).sort());
  assert.equal(model.recipients.size,600);
});

test('streamed anonymous policy fails closed and never reads anonymous answer or identity columns',async()=>{
  for(const variant of ['responded','no-response','unknown-current','flag-mismatch']){
    const scoped={tenant_id:'tenant',form_id:'form'};
    const tables={
      form:[{id:'form',tenant_id:'tenant',form_type:'survey',survey_settings:{current_version:2}}],
      event_survey_assignment:[{...scoped,id:'assignment',event_type:'event',event_id:'event',survey_version_id:'version',status:'active'}],
      event:[{id:'event',tenant_id:'tenant'}],
      survey_version:[
        {...scoped,id:'version',version_number:1,survey_settings:{response_identity:'anonymous',anonymous_completion_version:1}},
        {...scoped,id:'current',version_number:2,survey_settings:variant==='unknown-current'?{}:{response_identity:'identified'}},
      ],
      form_submission:[{...scoped,id:'response',survey_assignment_id:'assignment',survey_version_id:'version',
        is_anonymous:variant!=='flag-mismatch',submitted_by_email:'private@example.com',submission_data:{secret:'never read'}}],
      survey_completion:[{...scoped,id:'completion',assignment_id:'assignment',recipient_email:'yes@example.com'}],
      booking:[{id:'booking',tenant_id:'tenant',event_id:'event',status:'confirmed',attendee_email:'yes@example.com'}],
    };
    const segment={type:'event_form',form_id:'form',survey_assignment_id:'assignment',received:variant!=='no-response'};
    const model=fixture(tables,[segment]);model.sourceCost=10;
    if(variant==='responded'){
      await model.finishStream();assert.equal(model.recipients.size,1);
    }else{
      const result=await model.stream();assert.equal(result.success,false,variant);
      assert.match(result.error,/policy|completeness|inconsistent/i);
      assert.equal(model.recipients.size,0);
    }
    assert.ok(model.sourceQueries.filter(q=>q.table==='form_submission')
      .every(q=>!/submitted_by|submission_data|member_id/.test(q.columns)));
  }
});

test('streamed custom-object predicates bind the same record and edge across thousands of relationships',async()=>{
  const condition={entity_scope:'custom_object',version:1,custom_object_id:'object',
    relationship_definition_id:'rel',object_side:'source',field_type:'relationship',
    field_id:'respondent',field_key:'respondent',data_type:'boolean',operator:'is_true'};
  const member=Array.from({length:3000},(_,i)=>({id:`m${String(i).padStart(6,'0')}`,
    tenant_id:'tenant',email:`m${i}@example.com`,communications_opted_out_all:false}));
  const tables={
    member,
    custom_object_definition:[{id:'object',tenant_id:'tenant',status:'active',archived_at:null,singular_label:'Department'}],
    custom_object_relationship_definition:[{id:'rel',tenant_id:'tenant',status:'active',archived_at:null,
      source_kind:'custom_object',source_custom_object_id:'object',target_kind:'member',
      configuration:{relationship_fields:[{id:'respondent',key:'respondent',type:'boolean'}]}}],
    preference_field:[{id:'name-field',tenant_id:'tenant',custom_object_id:'object',entity_scope:'custom_object',
      is_active:true,name:'name',label:'Name',field_type:'text'}],
    custom_object_record:['a','b'].map(id=>({id,tenant_id:'tenant',custom_object_id:'object',archived_at:null,data:{name:id}})),
    custom_object_relationship:member.flatMap((m,i)=>['a','b'].map(id=>({
      id:`${m.id}-${id}`,tenant_id:'tenant',relationship_definition_id:'rel',source_record_id:id,
      target_record_id:m.id,archived_at:null,field_values:{respondent:id==='b'||i%3===0},
    }))),
  };
  const segment={type:'field_filter',filter_groups:[{conditions:[condition,{
    ...condition,field_type:'record',field_id:'name-field',field_key:'name',data_type:'text',operator:'equals',value:'a',
  }]}]};
  const model=fixture(tables,[segment]);model.sourceCost=100;
  const legacy=await preparationContext.run({db:model.db},()=>getTargetRecipients(model.state.snapshot,'tenant'));
  assert.equal(legacy.success,true);
  await model.finishStream();
  assert.equal(model.recipients.size,1000);
  assert.deepEqual([...model.recipients.keys()].sort(),legacy.recipients.map(r=>r.email.toLowerCase()).sort());
});

test('20,000-member group retains role, expiry, tenant and opt-out semantics while advancing source pages',async()=>{
  const member=Array.from({length:20000},(_,i)=>({id:`m${String(i).padStart(6,'0')}`,
    tenant_id:i%11===0?'other':'tenant',email:`m${i}@example.com`,communications_opted_out_all:i%7===0}));
  const tables={member,member_group_assignment:member.map((m,i)=>({
    id:m.id,member_id:m.id,group_id:'group',group_role:i%2===0?'chair':'member',
    expires_at:i%3===0?'2025-01-01T00:00:00Z':null,
  }))};
  const segment={type:'member_group',ids:['group'],roles:['chair']};
  const model=fixture(tables,[segment]);model.sourceCost=100;
  const legacy=await preparationContext.run({db:model.db,at:model.state.snapshot.sent_at},()=>getTargetRecipients(model.state.snapshot,'tenant'));
  assert.equal(legacy.success,true);
  await model.finishStream();
  assert.deepEqual([...model.recipients.keys()].sort(),legacy.recipients.map(r=>r.email.toLowerCase()).sort());
});

for(const action of ['stream','stream_resolved','global_consent','consent']){
  test(`streamed ${action} checkpoint survives a committed-but-lost response without skipping or duplicating recipients`,async()=>{
    const member=Array.from({length:401},(_,i)=>({id:`m${String(i).padStart(6,'0')}`,
      tenant_id:'tenant',email:`m${i}@example.com`,communications_opted_out_all:i%5===0}));
    const model=fixture({member});model.crashAfter=action;
    await model.finishStream();
    assert.equal(model.candidates.length,401);
    assert.equal(model.recipients.size,320);
    assert.equal(model.recipients.has('m400@example.com'),false);
    assert.ok(model.actions.includes(action));
  });
}

test('permanent preparation failures terminate durably, including zero recipients, denied authority and unknown errors',async()=>{
  for(const variant of ['empty','permission','unknown']){
    const model=fixture({});
    const result=await model.stream(variant==='permission'
      ? {authorize:async()=>{throw new Error('Group administrator permission revoked');}}
      : variant==='unknown'?{resolveChunk:async()=>{throw new Error('Unexpected resolver invariant violation');}}:{});
    assert.equal(result.success,false);
    assert.equal(result.terminal,true);
    assert.equal(result.status,'failed');
    assert.equal(result.preparationPending,false);
    assert.equal(model.status,'failed');
    assert.equal(model.state.phase,'failed');
    assert.equal(model.state.last_error,result.error);
    assert.equal(model.recipients.size,0);
  }
});

test('known operational and quota failures retain resumable state; unknown and permission failures do not',async()=>{
  for(const error of [
    Object.assign(new Error('serialization failure'),{code:'40001'}),
    Object.assign(new Error('database connection unavailable'),{code:'08006'}),
    Object.assign(new Error('connection reset'),{code:'ECONNRESET'}),
    Object.assign(new Error('temporarily unavailable'),{status:503}),
    new Error('Plan email quota exceeded: used 100, limit 100'),
  ]){
    assert.equal(isRetryablePreparationError(error),true);
    const model=fixture({member:[{id:'m1',tenant_id:'tenant',email:'one@example.com'}]});
    const result=await model.stream({resolveChunk:async()=>{throw error;}});
    assert.equal(result.status,'preparing');
    assert.equal(result.retryable,true);
    assert.equal(model.state.last_error,error.message);
    await model.finishStream();
    assert.equal(model.recipients.size,1);
  }
  assert.equal(isRetryablePreparationError(Object.assign(new Error('permission denied'),{code:'42501'})),false);
  assert.equal(isRetryablePreparationError(new Error('unknown')),false);
});