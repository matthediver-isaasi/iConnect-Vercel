import test from 'node:test';
import assert from 'node:assert/strict';
import {createFunnelReversalHandler} from './eventFunnelReversalHandler.js';
const order='10000000-0000-0000-0000-000000000001',operation='20000000-0000-0000-0000-000000000001';
function fixture(){
  const calls=[],row={id:operation,tenant_id:'tenant',order_id:order,state:'retry',refund_options:{voucherReplacements:[]},
    last_outcomes:{card:'complete',credit:'retry'},private:'DO NOT RETURN'};
  const options={db:{rpc:async(name,args)=>{
    calls.push({name,args});
    return name==='event_funnel_consume_limit'?{data:true}:{data:{order:{id:order,tenant_id:'tenant',private:'DO NOT RETURN'},history:[row]}};
  }},getTenantContext:async()=>({isAuthenticated:true,tenantId:'tenant',memberId:'member',roleId:'role'}),
    hasAdminAccess:async()=>true,hasFeatureAccess:async(_role,key)=>key==='commerce.event-cancellations',
    run:async args=>{calls.push({run:args});row.state='complete';return {status:'complete'};}};
  const req={method:'POST',headers:{host:'app.example','content-type':'application/json',origin:'https://app.example'},
    body:{action:'list',orderId:order}};
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  return {options,req,res,row,calls,invoke:()=>createFunnelReversalHandler(options)(req,res)};
}
test('list returns only redacted cancellation status',async()=>{
  const f=fixture();await f.invoke();assert.equal(f.res.code,200);
  assert.equal(f.res.body.operations[0].state,'retry');
  assert.ok(!JSON.stringify(f.res.body).includes('DO NOT RETURN'));
  assert.ok(!JSON.stringify(f.res.body).includes('refund_options'));
});
test('retry executes only the previously approved, tenant-owned operation',async()=>{
  const f=fixture();f.req.body={action:'retry',orderId:order,operationId:operation};
  await f.invoke();assert.equal(f.res.code,200);
  assert.equal(f.res.body.operations[0].state,'complete');
  const run=f.calls.find(c=>c.run).run;assert.equal(run.tenantId,'tenant');assert.equal(run.operationId,operation);
});
test('authentication, feature permission and cross-site checks precede private reads',async()=>{
  for(const mode of ['anonymous','nonadmin','denied-feature','cross-site']){
    const f=fixture();
    if(mode==='anonymous')f.options.getTenantContext=async()=>({isAuthenticated:false});
    if(mode==='nonadmin')f.options.hasAdminAccess=async()=>false;
    if(mode==='denied-feature')f.options.hasFeatureAccess=async()=>false;
    if(mode==='cross-site')f.req.headers.origin='https://other.example';
    await f.invoke();assert.ok([401,403].includes(f.res.code));assert.equal(f.calls.length,0);
  }
});
test('recovery cannot accept new amounts or replacement choices',async()=>{
  for(const extra of [{refund_options:{}},{amount:100},{tenantId:'other'}]){
    const f=fixture();Object.assign(f.req.body,extra);await f.invoke();
    assert.equal(f.res.code,400);assert.equal(f.calls.length,0);
  }
});
test('foreign history, missing approval and unknown operation never reach the worker',async()=>{
  for(const mode of ['foreign','missing','unknown']){
    const f=fixture();f.req.body={action:'retry',orderId:order,operationId:operation};
    if(mode==='foreign')f.row.tenant_id='other';
    if(mode==='missing')delete f.row.refund_options;
    if(mode==='unknown')f.row.id=order;
    await f.invoke();assert.ok([503,409,404].includes(f.res.code));
    assert.ok(!f.calls.some(c=>c.run));
  }
});
test('rate limiting prevents a recovery attempt',async()=>{
  const f=fixture();f.options.db.rpc=async()=>({data:false});await f.invoke();assert.equal(f.res.code,429);
});
