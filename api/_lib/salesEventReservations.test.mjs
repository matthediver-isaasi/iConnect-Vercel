import test from 'node:test';
import assert from 'node:assert/strict';
import { salesEventReservations } from './salesEventReservations.js';
test('reserved places include invitations but exclude actual attendees and released places',async()=>{
  let tenant;
  const db={from(table){assert.equal(table,'sales_commercial_allocation');return {
    select(){return this;},eq(k,v){tenant=v;return this;},in:async()=>({data:[{
      id:'allocation',ticket_snapshot:{event_title:'Conference',ticket_name:'Delegate'},
      sales_commercial_sale:{sales_quote:{quote_number:'P-42'},sales_quote_version:{organisation_snapshot:{name:'Purchaser Ltd'}}},
    }]}),
  };}};
  const result=await salesEventReservations(db,'tenant',[{allocation_id:'allocation',event_id:'event',remaining:7,named:3,reserved:2},
    {allocation_id:'completed',remaining:4,named:4}]);
  assert.equal(tenant,'tenant');assert.equal(result.length,1);
  assert.deepEqual(result[0],{allocationId:'allocation',eventId:'event',eventName:'Conference',ticketName:'Delegate',
    proposalNumber:'P-42',organizationName:'Purchaser Ltd',status:'Reserved',places:4});
  assert.equal(result[0].attendees,undefined);
});
