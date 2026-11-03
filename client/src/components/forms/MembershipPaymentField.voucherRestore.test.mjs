import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import Module from 'node:module';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://fixture.invalid/FormView?slug=renew'});
Object.assign(globalThis, {window:dom.window,document:dom.window.document,navigator:dom.window.navigator,
  HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,IS_REACT_ACT_ENVIRONMENT:true});
const React = (await import('react')).default;
globalThis.React = React;
const {act} = React;
const {createRoot} = await import('react-dom/client');
const bundle = await build({
  entryPoints:['client/src/components/forms/MembershipPaymentField.jsx'],
  bundle:true,write:false,packages:'external',platform:'node',format:'cjs',
  plugins:[{name:'unused-provider-surfaces',setup(b){
    b.onResolve({filter:/FormMembershipCredit|GoCardlessDropinFlow|DirectDebitPlanCard/},args=>({path:args.path,namespace:'stub'}));
    b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export default function Stub(){return null}'}));
  }}],
});
const mod = new Module(`${process.cwd()}/voucher-restore-fixture.cjs`);
mod.filename = `${process.cwd()}/voucher-restore-fixture.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text,mod.filename);
const Payment = mod.exports.default;
const originalFetch = globalThis.fetch;
after(()=>{globalThis.fetch=originalFetch;dom.window.close();});
const settle = async()=>{for(let i=0;i<4;i++)await act(async()=>new Promise(r=>setTimeout(r,5)));};

test('saved renewal retains checkout and answers across outage, retry, paid refresh and remount',async()=>{
  let unavailable=true;
  const requests=[];
  let values={name:'Fixture answer',payment:{status:'voucher_checkout_pending',voucherCheckoutId:'fee'}};
  globalThis.fetch=async input=>{
    const url=new URL(input,'https://fixture.invalid');
    if(url.pathname==='/api/membership/payment-plan')return {ok:true,json:async()=>({})};
    requests.push(url);
    for(const [key,val] of [['formId','form'],['paymentFieldId','payment'],['voucherCheckoutId','fee']]){
      assert.deepEqual(url.searchParams.getAll(key),[val]);
    }
    if(unavailable)return {ok:false,json:async()=>({error:'Retry checking saved checkout',retryable:true})};
    return {ok:true,json:async()=>({membershipYear:'saved-purchase',voucherCheckoutId:'fee',
      existingRecord:{id:'history',paymentStatus:'paid',status:'active'}})};
  };
  async function mount(){
    const element=document.createElement('div');document.body.appendChild(element);
    const root=createRoot(element);
    await act(async()=>root.render(React.createElement(Payment,{
      resolvedMemberId:'member',formId:'form',field:{id:'payment'},value:values.payment,
      allFormValues:values,onChange:answer=>{values={...values,payment:answer};},
    })));
    await settle();
    return {element,close:async()=>{await act(async()=>root.unmount());element.remove();}};
  }
  const first=await mount();
  assert.match(first.element.textContent,/Retry checking/);
  assert.equal(values.payment.voucherCheckoutId,'fee');
  assert.equal(values.name,'Fixture answer');
  unavailable=false;
  await act(async()=>first.element.querySelector('button').click());await settle();
  assert.equal(values.payment.status,'already_paid');
  assert.equal(values.payment.voucherCheckoutId,'fee');
  await first.close();
  const restored=await mount();
  assert.equal(values.name,'Fixture answer');
  assert.equal(values.payment.existingRecordId,'history');
  assert.ok(requests.length>=3);
  await restored.close();
});
