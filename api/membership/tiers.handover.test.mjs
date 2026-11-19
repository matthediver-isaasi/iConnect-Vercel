import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStructureChildren } from '../_lib/membershipStructureChildren.js';
import { parseFlatMembershipCost } from '../../shared/membershipFlatCost.js';
import { normalizeMembershipProjectCode } from '../../shared/membershipProjectCode.js';

// Exercise the real route logic with an RPC spy; no network, providers or credentials.
function fixture({ error, admin = true } = {}) {
  const calls = [];
  const db = {
    from(table) {
      const q = {
        select() { return q; }, eq() { return q; }, limit() { return q; }, order() { return q; },
        maybeSingle() { return q; },
        then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
        insert() { throw new Error('Route must never insert outside the transaction'); },
        update() { throw new Error('Route must never cap a predecessor outside the transaction'); },
        delete() { throw new Error('Route must never delete a predecessor'); },
      };
      return q;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return error ? { error, data: null } : { data: { ...args.p_config,id:args.p_config_id || 'new',effective_to:null },error:null };
    },
  };
  const src = readFileSync(new URL('./tiers.js',import.meta.url),'utf8')
    .replace(/^import .*;\n/gm,'').replace(/export default /g,'').replace(/export /g,'');
  const handler = new Function('supabase','getTenantContext','hasAdminAccess','normalizeMembershipProjectCode',
    'parseFlatMembershipCost','normalizeInvoiceRecipients','validateInvoiceRecipientsShape',
    'getRemindersForConfig','buildStructureChildren',
    `${src}\nreturn handler;`)(db, async()=>({tenantId:'tenant',isAuthenticated:true}),
    async()=>admin,normalizeMembershipProjectCode,parseFlatMembershipCost,()=>({}),()=>null,async()=>[],buildStructureChildren);
  const call = async (body, method='POST') => {
    const res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};
    await handler({method,body,query:{}},res);return res;
  };
  const config={name:'University',effective_from:'2026-11-19',pricing_model:'flat',flat_cost:100,term_end_mode:'standard'};
  return {calls,call,config};
}
test('create, duplicate and allowed date updates use one atomic RPC with normalized children', async () => {
  const {calls,call,config}=fixture();
  for(const [method,id] of [['POST',null],['POST',null],['PUT','existing']]) {
    const result=await call({config:{...config,id},bands:[{id:'untrusted',label:'A',annual_cost:'125'}],
      discounts:[],vatOverrides:[],reminders:[{label:'Renew',offset_unit:'weeks',offset_value:2}]},method);
    assert.equal(result.statusCode,200);
    const last=calls.at(-1);assert.equal(last.name,'save_membership_structure');
    assert.equal(last.args.p_tenant_id,'tenant');assert.equal(last.args.p_config_id,id);
    assert.equal(last.args.p_children.bands[0].id,undefined);
    assert.equal(last.args.p_children.bands[0].annual_cost,'125');
    assert.equal(last.args.p_children.reminders[0].offset_value,2);
    assert.deepEqual(last.args.p_children.discounts,[]);
  }
  assert.equal(calls.length,3);
});
test('transaction errors are explicit and never trigger compensating or partial writes', async () => {
  for(const [code,status] of [['PT409',409],['23514',503],['PGRST202',503]]) {
    const {calls,call,config}=fixture({error:{code,message:'Scope conflict'}});
    const result=await call({config});
    assert.equal(result.statusCode,status);assert.equal(calls.length,1);
    assert.match(result.body.error,code==='PT409'?/Scope conflict/:/No changes were saved/);
  }
});
test('non-admin requests and missing dates never reach the save operation', async () => {
  const denied=fixture({admin:false});
  assert.equal((await denied.call({config:denied.config})).statusCode,403);
  assert.equal(denied.calls.length,0);
  const invalid=fixture();
  assert.equal((await invalid.call({config:{...invalid.config,effective_from:null}})).statusCode,400);
  assert.equal(invalid.calls.length,0);
});
test('API lifecycle classifies capped future rows as Scheduled and honors inclusive handover', () => {
  const src=readFileSync(new URL('./tiers.js',import.meta.url),'utf8');
  const helpers=src.slice(src.indexOf('function todayStr()'),src.indexOf('export default async function'));
  const lifecycle=new Function(`${helpers};return configLifecycleStatus;`)();
  const old={effective_from:'2026-08-01',effective_to:'2026-11-18'};
  const next={effective_from:'2026-11-19',effective_to:'2027-07-31'};
  assert.equal(lifecycle(old,'2026-11-18'),'active');
  assert.equal(lifecycle(old,'2026-11-19'),'historical');
  assert.equal(lifecycle(next,'2026-11-18'),'scheduled');
  assert.equal(lifecycle(next,'2026-11-19'),'active');
  assert.equal(lifecycle(next,'2027-07-31'),'active');
  assert.equal(lifecycle(next,'2027-08-01'),'historical');
});
