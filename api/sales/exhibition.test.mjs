import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesExhibitionHandler } from './exhibition.js';
const response = () => ({ statusCode:0,setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;} });
test('exhibition rejects unauthenticated and tenant-mismatched requests before DB access', async () => {
  for (const [context,status] of [[{},401],[{tenantMismatch:true},409]]) {
    const handler=createSalesExhibitionHandler({db:{rpc(){throw Error('must not access')}},getTenantContext:async()=>context});
    const res=response();await handler({method:'POST',body:{}},res);assert.equal(res.statusCode,status);
  }
});
test('portal mutations require independent catalogue capability',async()=>{
  const handler=createSalesExhibitionHandler({db:{},getTenantContext:async()=>({isAuthenticated:true,tenantId:'tenant',memberId:'member',roleId:'role'}),
    hasFeatureAccess:async(_,cap)=>cap==='sales.view'});
  const res=response();await handler({method:'POST',body:{action:'requirement',name:'Bronze'}},res);assert.equal(res.statusCode,403);
});
test('command tenant always comes from authenticated context, never body',async()=>{
  let called;
  const handler=createSalesExhibitionHandler({db:{rpc:async(name,args)=>{called={name,args};return{data:{id:'requirement'}};}},
    getTenantContext:async()=>({isAuthenticated:true,tenantId:'trusted',tenantUserId:'actor'})});
  const res=response();await handler({method:'POST',body:{action:'requirement',name:'Bronze',tenantId:'forged'}},res);
  assert.equal(res.statusCode,200);assert.equal(called.args.p_tenant,'trusted');
});
test('price, fractional quantity and null blocking are rejected before mutation',async()=>{
  for(const body of [{action:'generate',quantity:1.5,priceMinor:0},{action:'edit',priceMinor:-1},{action:'edit',blocked:null}]) {
    const handler=createSalesExhibitionHandler({db:{rpc(){throw Error('must not access');}},getTenantContext:async()=>({isAuthenticated:true,tenantId:'tenant',tenantUserId:'actor'})});
    const res=response();await handler({method:'POST',body},res);assert.equal(res.statusCode,400);
  }
});
