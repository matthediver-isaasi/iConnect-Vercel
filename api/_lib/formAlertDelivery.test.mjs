import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverFormAlerts} from './formAlertDelivery.js';
function fixture(){
  const rows=['a','b'].map((id)=>({id,tenant_id:'tenant',form_id:'form',submission_id:'sub',recipient:`${id}@example.test`,
    status:'pending',attempts:0,available_at:'2000-01-01',expires_at:'2099-01-01',revoked_at:null,
    form_snapshot:{name:'Title'}}));
  const tables={form_alert_delivery:rows,form_alert_read_limit:[],tenant:[{id:'tenant',slug:'fixture',domain:'fixture.example.test'}],
    form:[{id:'form',tenant_id:'tenant',form_type:'standard'}],
    form_submission:[{id:'sub',tenant_id:'tenant',form_id:'form',created_date:'2026-01-01T12:34:56Z',is_anonymous:false}]};
  const db={rows,async rpc(name,args){
    assert.equal(name,'claim_form_submission_alert');
    const row=rows.find(row=>row.id===args.p_delivery_id&&['pending','retry'].includes(row.status)
      && Date.parse(row.available_at)<=Date.now() && !row.revoked_at && row.attempts<5);
    if(!row)return {data:[],error:null};
    Object.assign(row,{status:'sending',claim_id:args.p_claim_id,token_hash:args.p_token_hash,claimed_at:new Date().toISOString(),attempts:row.attempts+1});
    return {data:[{...row}],error:null};
  },from(table){
    assert.ok(Object.hasOwn(tables,table),table);
    let found=tables[table],patch,cap=Infinity;
    const q={select(){return q;},delete(){return q;},update(value){patch=value;return q;},
      eq(k,v){found=found.filter(row=>row[k]===v);return q;},neq(k,v){found=found.filter(row=>row[k]!==v);return q;},
      is(k,v){found=found.filter(row=>(row[k]??null)===v);return q;},
      in(k,v){found=found.filter(row=>v.includes(row[k]));return q;},
      lt(k,v){found=found.filter(row=>row[k]&&Date.parse(row[k])<Date.parse(v));return q;},
      lte(k,v){found=found.filter(row=>Date.parse(row[k])<=Date.parse(v));return q;},
      order(){return q;},limit(n){cap=n;return q;},
      maybeSingle(){return Promise.resolve({data:found[0]||null,error:null});},
      then(resolve){if(patch)found.forEach(row=>Object.assign(row,patch));return Promise.resolve({data:found.slice(0,cap).map(row=>({...row})),error:null}).then(resolve);}};
    return q;
  }};
  return db;
}
test('concurrent workers claim each recipient independently and never expose answers to transport',async()=>{
  const db=fixture(),sent=[];
  const send=async options=>{
    sent.push(options);
    assert.equal(options.disableTracking,true);assert.equal(options.skipFooter,true);
    assert.equal(options.resolveTransactionalPreferences,false);assert.equal(options.confidentialDiagnostics,true);
    assert.equal(options.subject,'New Form Submission – Title');
    assert.match(options.text,/UTC/);assert.match(options.text,/#[-_a-zA-Z0-9]{43}/);
    return options.to.startsWith('a')?{success:true,messageId:'provider'}:{success:false,status:429};
  };
  await Promise.all([deliverFormAlerts(db,{send}),deliverFormAlerts(db,{send})]);
  assert.equal(sent.length,2);
  assert.deepEqual(db.rows.map(row=>row.status),['sent','retry']);
  assert.equal(db.rows[0].token_hash.length,64);assert.equal(db.rows[1].token_hash,null);
  assert.ok(!JSON.stringify(db.rows).includes(sent[0].text.match(/#([-\w]{43})/)[1]));
});
test('ambiguous external acceptance is observable and never automatically resent',async()=>{
  const db=fixture();let attempts=0;
  const send=async()=>{attempts++;throw new Error('transport interrupted');};
  await deliverFormAlerts(db,{send});await deliverFormAlerts(db,{send});
  assert.equal(attempts,2);
  assert.ok(db.rows.every(row=>row.status==='attention'&&row.outcome_code==='delivery_interrupted'&&row.token_hash===null));
});
