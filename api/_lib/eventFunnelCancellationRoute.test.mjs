import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

test('the single-request route exits through atomic approval before legacy payment checks or side effects',async()=>{
  const stubs={
    'database.js':`export const supabase={from:table=>{const q={select(){return q;},eq(){return q;},
      async single(){return {data:table==='booking_cancellation_request'?globalThis.__funnelRoute.request:{email:'Reviewer'}};},
      update(){throw new Error('Legacy request update executed');}};return q;}};`,
    'tenantContext.js':`export const getTenantContext=async()=>({isAuthenticated:true,tenantId:'tenant',tenantUserId:'user'});
      export const hasAdminAccess=async()=>true;export const hasFeatureAccess=async()=>true;`,
    'eventFunnelCancellationApproval.js':`export async function approveFunnelCancellation(args){
      globalThis.__funnelRoute.args=args;return {operationId:'operation',orderId:'order',recovery:'queued',reviewedAt:'accepted'};}`,
    'emailService.js':`export const sendEmail=async()=>{throw new Error('Legacy email sent');};`,
    'bookingCancellation.js':`export const CANCELLATION_REASON_REQUEST_APPROVED='approved';
      export const cancelBooking=async()=>{throw new Error('Legacy refund executed');};`,
    'bookingLookup.js':`export const isComplexSource=value=>value==='complex_event_booking';
      export const normalizeComplexBooking=value=>value;`,
  };
  const output=await build({stdin:{contents:`export {default} from './api/booking-cancellation-requests/[requestId].js';`,
    resolveDir:process.cwd()},platform:'node',format:'esm',bundle:true,write:false,
    plugins:[{name:'route-boundaries',setup(b){
      b.onResolve({filter:/\.js$/},args=>{const name=args.path.split('/').at(-1);if(stubs[name])return {path:name,namespace:'stub'};});
      b.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:stubs[args.path],loader:'js'}));
    }}]});
  const {default:handler}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  try{
    for(const state of ['pending','approved']){
      globalThis.__funnelRoute={request:{id:'request',tenant_id:'tenant',booking_id:'booking',status:state}};
      let response;
      const res={setHeader(){},status(code){this.code=code;return this;},json(value){response=value;return this;}};
      await handler({method:'PATCH',headers:{},query:{requestId:'request'},body:{
        status:'approved',custom_refund_amount:0,suppress_emails:true}},res);
      assert.equal(response.request.status,'approved');
      assert.equal(response.reversalResults.funnel.operationId,'operation');
      assert.equal(globalThis.__funnelRoute.args.amountsByRequest.request.customRefundAmount,0);
      assert.equal(globalThis.__funnelRoute.args.suppressEmails,true);
    }
  }finally{delete globalThis.__funnelRoute;}
});

test('group approvals and exact replays exit before legacy consolidated refunds or notifications',async()=>{
  const exports=names=>names.map(name=>`export const ${name}=()=>{throw new Error('Legacy ${name} executed');};`).join('\n');
  const stubs={
    'database.js':`export const supabase={from:table=>{const q={select(){return q;},eq(){return q;},in(){return q;},
      then(resolve,reject){return Promise.resolve({data:globalThis.__funnelGroup.requests}).then(resolve,reject);},
      async single(){return {data:{email:'Reviewer'}};},update(){throw new Error('Legacy request update executed');}};
      return q;}};`,
    'tenantContext.js':`export const getTenantContext=async()=>({isAuthenticated:true,tenantId:'tenant',tenantUserId:'user'});
      export const hasAdminAccess=async()=>true;export const hasFeatureAccess=async()=>true;`,
    'eventFunnelCancellationApproval.js':`export async function approveFunnelCancellation(args){
      globalThis.__funnelGroup.args=args;return {operationId:'operation',orderId:'order',recovery:'queued'};}`,
    'stripe':`export default class Stripe {constructor(){throw new Error('Legacy Stripe executed');}}`,
    'stripeCredentials.js':exports(['getStripeCredentials']),
    'accountingProvider.js':exports(['getAccountingProvider','buildCreditNoteColumnUpdate']),
    'emailService.js':exports(['sendEmail']),
    'transactionalInbox.js':exports(['buildInboxDelivery']),
    'zoomClient.js':exports(['cancelZoomRegistrant','resolveEventZoomWebinar']),
    'bookingCreditEvidence.js':exports(['captureCancellationCredits','prepareCancellationCredits']),
    'cancellationCreditRecovery.js':exports(['createRecoverableCancellationCredit']),
    'eventFunnelReversalBoundary.js':exports(['assertLegacyFunnelReversalAllowed']),
    'bookingLookup.js':exports(['isComplexSource','normalizeComplexBooking','getBookingTable','restoreComplexEventSeatsMultiple',
      'cancelComplexEventZoomRegistrationsMultiple','reinstateVoucherDirect','reinstateVoucherFromTransactions']),
    'bookingCancellation.js':`export const CANCELLATION_REASON_REQUEST_APPROVED='approved';${exports(['cancelBooking'])}`,
  };
  const output=await build({stdin:{contents:`export {default} from './api/booking-cancellation-requests/approve-group.js';`,
    resolveDir:process.cwd()},platform:'node',format:'esm',bundle:true,write:false,
    plugins:[{name:'group-route-boundaries',setup(b){
      b.onResolve({filter:/.*/},args=>{const name=args.path.split('/').at(-1);if(stubs[name])return {path:name,namespace:'stub'};});
      b.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:stubs[args.path],loader:'js'}));
    }}]});
  const {default:handler}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  try{
    for(const status of ['pending','approved']){
      globalThis.__funnelGroup={requests:['one','two'].map(id=>({id,tenant_id:'tenant',booking_id:`booking-${id}`,status}))};
      let response;
      await handler({method:'POST',headers:{},body:{request_ids:['one','two'],status:'approved',
        custom_refund_amount:0,suppress_emails:true}},{
        setHeader(){},status(){return this;},json(value){response=value;return this;}});
      assert.equal(response.success,true);assert.equal(response.count,2);
      assert.equal(response.reversalResults.funnel.operationId,'operation');
      assert.equal(globalThis.__funnelGroup.args.requests.length,2);
      assert.equal(globalThis.__funnelGroup.args.groupAmounts.customRefundAmount,0);
    }
  }finally{delete globalThis.__funnelGroup;}
});
