import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverPublicPoInvoice,publicPoEmailRecipient} from './publicPoInvoiceEmail.js';
import {sendEmail} from './emailService.js';
function fixture(){
 const row={id:'id',tenant_id:'tenant',member_id:'member',invoice_number:'INV-1',email_status:'pending',
  email_next_at:new Date(0).toISOString(),original_records:[{purchaser_context:{details:{email:'booker@example.invalid',first_name:'Booker'}}}]};
 const db={from(){let patch,filters=[];const q={
  update(v){patch=v;return q},eq(k,v){filters.push(r=>r[k]===v);return q},lte(k,v){filters.push(r=>r[k]<=v);return q},
  select(){return q},then(resolve,reject){if(filters.every(f=>f(row))){Object.assign(row,patch);return Promise.resolve({data:[{id:row.id}]}).then(resolve,reject)}return Promise.resolve({data:[]}).then(resolve,reject)}
 };return q}};
 return {db,row};
}
const document=async()=>({pdf:Buffer.from('%PDF-test')});
test('send original booker PDF once, including concurrent workers',async()=>{
 const {db,row}=fixture();let calls=0;
 const send=async data=>{calls++;assert.equal(data.to,'booker@example.invalid');assert.equal(data.attachments[0].data.toString(),'%PDF-test');return {success:true,messageId:'accepted'}};
 await Promise.all([deliverPublicPoInvoice({db,row,document,send}),deliverPublicPoInvoice({db,row,document,send})]);
 assert.equal(calls,1);assert.equal(row.email_status,'sent');assert.equal(row.email_message_id,'accepted');
});
test('uncertain send never automatically retries',async()=>{
 const {db,row}=fixture();let calls=0;
 const send=async()=>{calls++;throw Error('timeout')};
 await deliverPublicPoInvoice({db,row,document,send});
 await deliverPublicPoInvoice({db,row,document,send});
 assert.equal(calls,1);assert.equal(row.email_status,'unknown');
});
test('safe rejection retries later, provider-already-sent does not resend',async()=>{
 const {db,row}=fixture();
 await deliverPublicPoInvoice({db,row,document,send:async()=>({success:false,ambiguousEffect:false})});
 assert.equal(row.email_status,'pending');assert.ok(Date.parse(row.email_next_at)>Date.now());
 row.email_next_at=new Date(0).toISOString();
 await deliverPublicPoInvoice({db,row,document:async()=>({alreadySent:true}),send:async()=>assert.fail('duplicate')});
 assert.equal(row.email_status,'sent_external');
});
test('never substitute attendee or current member email for missing purchaser',()=>{
 assert.throws(()=>publicPoEmailRecipient({original_records:[{attendee_email:'attendee@example.invalid'}]}),/booker email/);
});

test('standard mail transport safely falls back after explicit domain rejection',async()=>{
 const {db,row}=fixture();const calls=[];
 await deliverPublicPoInvoice({db,row,document,send:payload=>sendEmail({
  ...payload,skipFooter:true,resolveTransactionalPreferences:false,
 },{
  client:{messages:{create:async(domain,message)=>{
   calls.push({domain,message});
   if(calls.length===1)throw Object.assign(Error('Unauthorized'),{status:401});
   return {id:'accepted-on-fallback'};
  }}},
  getTenantEmailConfig:async()=>({domain:'tenant.invalid',fromEmail:'accounts@tenant.invalid',fromName:'Tenant'}),
  getEmailFooter:async()=>null,defaultDomain:'fallback.invalid',
 })});
 assert.equal(calls.length,2);
 assert.equal(calls[1].domain,'fallback.invalid');
 assert.deepEqual(calls[1].message.to,['booker@example.invalid']);
 assert.equal(calls[1].message.attachment[0].data.toString(),'%PDF-test');
 assert.equal(row.email_status,'sent');
 assert.equal(row.email_message_id,'accepted-on-fallback');
});
