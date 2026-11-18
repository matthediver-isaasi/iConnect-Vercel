import test from 'node:test';
import assert from 'node:assert/strict';
import { TENANT,COMPANY,keys,mapAddress,planAudit,scanContacts,excluded,pick,blank } from './lib/bnms-member-invoice-audit.mjs';

const contact=(extra={})=>({ContactID:'c1',ContactStatus:'ACTIVE',EmailAddress:'person@example.test',Name:'Name Only',
  Addresses:[{AddressType:'POBOX',AddressLine1:'1 Street',AddressLine2:'Flat 2',City:'Town',Region:'County',PostalCode:'AB1',Country:'United Kingdom'}],...extra});
const member=(extra={})=>({id:'m1',tenant_id:TENANT,role_id:'member',email:'person@example.test',first_name:'Name',...extra});
const snapshot=(extra={})=>({tenant:{id:TENANT},guestRole:{id:'guest'},total:1,members:[member()],secondary:[],addresses:[],links:[],...extra});
const plan=(s=snapshot(),c=[contact()],complete=true)=>planAudit(s,{contacts:c,complete});

test('all-null or whitespace targets only; partial targets never become candidates',()=>{
  assert.ok(blank(null)); assert.ok(blank(Object.fromEntries(keys.map(k=>[k,' \t ']))));
  assert.equal(plan()[0].candidate,true);
  for(const key of keys) {
    const rows=plan(snapshot({addresses:[{owner_type:'member',owner_id:'m1',[key]:'existing'}]}));
    assert.equal(rows[0].candidate,false);assert.equal(rows[0].outcome,'partial iConnect address');
  }
});
test('exclude CPD Guest primary and applicable secondary assignments, even if status inactive',()=>{
  assert.equal(plan(snapshot({members:[member({role_id:'guest',status:'inactive'})]})).length,0);
  assert.equal(plan(snapshot({secondary:[{member_id:'m1',role_id:'guest'}]})).length,0);
  assert.ok(excluded(member(),'guest',[{member_id:'m1',role_id:'guest'}]));
});
test('unique normalized exact email permitted; names alone never authorize writes',()=>{
  assert.ok(plan(snapshot({members:[member({email:' PERSON@example.test '})]}))[0].candidate);
  assert.equal(plan(snapshot(),[contact({EmailAddress:'other@example.test'})])[0].outcome,'no contact');
});
test('duplicates, shared identities, archived contacts, inconsistent bound companies held',()=>{
  assert.equal(plan(snapshot(),[contact(),contact({ContactID:'c2'})])[0].outcome,'ambiguous');
  const members=[member(),member({id:'m2',role_id:'guest'})];
  assert.equal(plan(snapshot({members,total:2}))[0].candidate,false);
  assert.equal(plan(snapshot(),[contact({ContactStatus:'ARCHIVED'})])[0].outcome,'ambiguous');
  assert.equal(plan(snapshot({members:[member({xero_contact_id:'c1',xero_tenant_id:'wrong'})]}))[0].candidate,false);
});
test('bound contact provenance must be tenant/member/company consistent',()=>{
  const link={tenant_id:TENANT,member_id:'m1',xero_tenant_id:COMPANY,xero_contact_id:'c1',
    evidence:{contact:{ContactID:'c1'},invoice:{Contact:{ContactID:'c1'}}}};
  assert.equal(plan(snapshot({links:[link]}),[contact({EmailAddress:'old@example.test'})])[0].candidate,true);
  link.evidence.invoice.Contact.ContactID='wrong';
  assert.equal(plan(snapshot({links:[link]}))[0].candidate,false);
});
test('missing POBOX, missing first line, optional nulls, unsupported lines and length boundaries',()=>{
  const identified=contact();identified.Addresses[0].AddressID='provider-record-id';
  assert.ok(mapAddress(identified).address,'Provider record metadata is preserved in evidence, not treated as address text');
  assert.equal(mapAddress(contact({Addresses:[{AddressType:'STREET',AddressLine1:'Street'}]})).address,undefined);
  assert.equal(mapAddress(contact({Addresses:[{AddressType:'POBOX',City:'Town'}]})).address,undefined);
  assert.ok(mapAddress(contact({Addresses:[{AddressType:'POBOX',AddressLine1:'A',Country:null}]})).address);
  for(const key of ['AttentionTo','AddressLine3','AddressLine4','Unsupported']) {
    const c=contact();c.Addresses[0][key]='Preserve this';assert.equal(mapAddress(c).review,true);
  }
  for(const [field,max] of [['AddressLine1',255],['AddressLine2',255],['City',100],['Region',100],['PostalCode',32],['Country',50]]) {
    const c=contact();c.Addresses[0][field]='x'.repeat(max);assert.ok(mapAddress(c).address);
    c.Addresses[0][field]+='x';assert.equal(mapAddress(c).review,true);
  }
  const c=contact();c.Addresses[0].AddressLine1='A\nB';assert.equal(mapAddress(c).review,true);
});
test('comparison is conservative; original source and target values are preserved',()=>{
  const a=mapAddress(contact()).address;
  const s=snapshot({addresses:[{owner_type:'member',owner_id:'m1',...a,invoicing_city:'  TOWN  '}]});
  const row=plan(s)[0];assert.equal(row.outcome,'same');assert.equal(row.before.invoicing_city,'  TOWN  ');
  assert.equal(row.candidate,false);
  s.addresses[0].invoicing_city='Another Town';assert.equal(plan(s)[0].outcome,'different');
});
test('incomplete/failed lookups never mean no contact or permit writes',()=>{
  assert.equal(plan(snapshot(),[],false)[0].outcome,'lookup error/incomplete');
});
test('full pagination demands terminal empty page; repeat pages, malformed pages and bounds fail closed',async()=>{
  const calls=[];const pages=[[contact()],[]];
  const result=await scanContacts(async path=>{calls.push(path);return {Contacts:pages.shift()};});
  assert.equal(result.complete,true);assert.equal(calls.length,2);
  assert.equal((await scanContacts(async()=>({Contacts:[contact()]}))).complete,false);
  assert.equal((await scanContacts(async()=>({}))).complete,false);
  assert.equal((await scanContacts(async()=>({Contacts:[contact()]}),1)).complete,false);
  const error=await scanContacts(async()=>{throw Error('HTTP 429');});assert.equal(error.complete,false);assert.match(error.error,/429/);
});
test('contact scans reconcile multiple full pages beyond provider default caps',async()=>{
  const all=Array.from({length:205},(_,i)=>contact({ContactID:`contact-${i}`}));
  let offset=0;
  const result=await scanContacts(async()=>{
    const page=all.slice(offset,offset+100);offset+=100;return {Contacts:page};
  });
  assert.equal(result.complete,true);assert.equal(result.contacts.length,205);
  assert.deepEqual(result.pages.map(p=>p.count),[100,100,5,0]);
});
test('replay after copy cannot propose another write',()=>{
  const row=plan()[0];
  const next=snapshot({addresses:[{owner_type:'member',owner_id:'m1',...row.proposed}]});
  assert.equal(plan(next).filter(r=>r.candidate).length,0);
  assert.deepEqual(pick(next.addresses[0]),row.proposed);
});
