import test from 'node:test';
import assert from 'node:assert/strict';
import { savePurchaserSlot, purchaserAllocationAuthority } from './salesPurchaserRoster.js';
import { ticketRegistrationDeadline, isTicketClosed, validateTicketRelease } from '../../shared/ticketRelease.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row = { id:id(1),tenant_id:id(2),sale_id:id(3) };
const input = { allocationId:id(4),slotId:id(5),commandId:id(6),expectedVersion:0,complete:false,details:{first_name:'Partial'} };
process.env.SESSION_SECRET='isolated-roster-not-production-secret';
function fixture({eventChanges={},ticketChanges={},settings=[]}={}) {
  const calls=[];
  const data={
    sales_commercial_allocation:[{id:id(4),tenant_id:id(2),sale_id:id(3),event_reference_kind:'simple',event_id:id(7),ticket_type_id:'T'}],
    event:[{id:id(7),tenant_id:id(2),pricing_config:{ticket_classes:[{id:'T',...ticketChanges}]},
      dietary_options:['Vegetarian'],...eventChanges}],
    system_settings:settings.map(s=>({...s,tenant_id:id(2)})),
  };
  return {calls,from(table) {
    assert.ok(Object.hasOwn(data,table),'never read unrelated member profiles');
    let rows=data[table];
    const q={select(){return q;},eq(k,v){rows=rows.filter(r=>r[k]===v);return q;},
      in(k,v){rows=rows.filter(r=>v.includes(r[k]));return q;},limit(){return q;},
      maybeSingle:async()=>({data:rows[0]||null}),then(resolve){resolve({data:rows});}};
    return q;
  },rpc:async(name,args)=>{calls.push({name,args});return {data:{id:args.p_slot,version:1}};}};
}
test('partial progress is scoped, bounded and never creates or updates member profiles',async()=>{
  const db=fixture();await savePurchaserSlot(db,row,'a'.repeat(43),input);
  assert.equal(db.calls[0].name,'save_sales_purchaser_slot');
  assert.equal(db.calls[0].args.p_details.first_name,'Partial');
  assert.equal(db.calls[0].args.p_complete,false);
  assert.equal(db.calls[0].args.p_tenant,row.tenant_id);
  assert.equal(JSON.stringify(db.calls).includes('a'.repeat(43)),false,'raw token is never persisted');
});
test('completion validates names, email, job title, current terms and code of conduct',async()=>{
  const settings=[{setting_key:'require_attendee_job_title',setting_value:true},
    {setting_key:'event_booking_terms',setting_value:'Current terms'},
    {setting_key:'event_code_of_conduct',setting_value:{required:true,content:'Current conduct'}}];
  const db=fixture({settings});const value={...input,complete:true};
  await assert.rejects(savePurchaserSlot(db,row,'a'.repeat(43),value),/first name/);
  value.details={first_name:'Test',last_name:'Person',email:'person@example.invalid'};
  await assert.rejects(savePurchaserSlot(db,row,'a'.repeat(43),value),/job title/);
  value.details.job_title='Attendee';
  await assert.rejects(savePurchaserSlot(db,row,'a'.repeat(43),value),/terms/);
  value.termsAccepted=true;value.termsContent='Current terms';
  await assert.rejects(savePurchaserSlot(db,row,'a'.repeat(43),value),/Code of Conduct/);
  value.codeOfConductAccepted=true;value.codeOfConductContent='Current conduct';
  await savePurchaserSlot(db,row,'a'.repeat(43),value);
  assert.equal(db.calls.length,1);
});
test('other sales, changed deadlines, waiting lists and self-only group rules fail closed',async()=>{
  await assert.rejects(purchaserAllocationAuthority(fixture(),{...row,sale_id:id(99)},id(4)),/not found/);
  for(const options of [{ticketChanges:{close_at:'2000-01-01T00:00:00Z',close_timezone:'UTC'}},
    {eventChanges:{registration_closes_at:'invalid'}},{eventChanges:{waiting_list_enabled:true}},
    {eventChanges:{event_state:'closed'}}]){
    const db=fixture(options);await assert.rejects(savePurchaserSlot(db,row,'a'.repeat(43),input));
    assert.equal(db.calls.length,0);
  }
  await assert.rejects(savePurchaserSlot(fixture({eventChanges:{member_group_id:id(9)}}),row,'a'.repeat(43),
    {...input,complete:true}),/register themselves/);
});
test('deadline is earliest applicable instant, closes exactly, and never invents a countdown',()=>{
  const ticket={close_at:'2030-10-27T01:30:00Z',close_timezone:'Europe/London'};
  const at=Date.parse(ticket.close_at);
  assert.equal(isTicketClosed(ticket,at-1),false);
  assert.equal(isTicketClosed(ticket,at),true);
  assert.equal(ticketRegistrationDeadline({},ticket,at-1).closesAt,ticket.close_at.replace('Z','.000Z'));
  assert.equal(ticketRegistrationDeadline({registration_closes_at:'2030-10-26T12:00:00Z'},ticket,0).closesAt,'2030-10-26T12:00:00.000Z');
  assert.equal(ticketRegistrationDeadline({}, {},0).closesAt,null);
  assert.equal(validateTicketRelease({...ticket,release_at:ticket.close_at,release_timezone:'UTC'}),'Ticket auto close must be after its release date and time.');
});
