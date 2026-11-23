import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<html><body></body></html>',{url:'https://isolated.example.test'});
for(const key of ['window','document','navigator','HTMLElement','Event','MouseEvent'])
  Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?dom.window:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=(await import('react')).default,{act}=React;
const {createRoot}=await import('react-dom/client');
const bundle=await build({entryPoints:['client/src/components/booking/EventFunnelCancellationRecovery.jsx'],
  bundle:true,write:false,packages:'external',platform:'node',format:'cjs',plugins:[{
    name:'isolated-admin-transport',setup(b){
      b.onResolve({filter:/^@\/lib\/adminFetch$/},()=>({path:'transport',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const adminFetch=(...args)=>globalThis.fetch(...args);'}));
    },
  }]});
const compiled=new Module(`${process.cwd()}/funnel-cancellation-mounted.cjs`);
compiled.filename=`${process.cwd()}/funnel-cancellation-mounted.cjs`;compiled.paths=Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text,compiled.filename);
const Component=compiled.exports.default,originalFetch=globalThis.fetch;
after(()=>{globalThis.fetch=originalFetch;dom.window.close();});
async function mount(){
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  await act(async()=>root.render(React.createElement(Component,{orderId:'order'})));
  return {host,click:async text=>{
    const button=[...host.querySelectorAll('button')].find(node=>node.textContent===text);assert.ok(button,text);
    await act(async()=>{button.click();await new Promise(resolve=>setTimeout(resolve,0));});
  },close:async()=>{await act(async()=>root.unmount());host.remove();}};
}
test('report recovery opens on demand and retries the exact recorded operation',async()=>{
  const calls=[];globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    return Response.json({operations:[{id:'operation',state:body.action==='retry'?'complete':'needs_review',
      outcomes:{credit:body.action==='retry'?'complete':'needs_review',cleanup:body.action==='retry'?'complete':'needs_review'}}]});
  };
  const f=await mount();
  try{
    assert.equal(calls.length,0);await f.click('Cancellation recovery');
    assert.match(f.host.textContent,/Accounting credit: Needs attention/);
    assert.match(f.host.textContent,/Booking access and notifications: Needs attention/);
    await f.click('Retry reconciliation');
    assert.deepEqual(calls,[{action:'list',orderId:'order'},{action:'retry',orderId:'order',operationId:'operation'}]);
    assert.match(f.host.textContent,/Accounting credit: Complete/);
    assert.ok(![...f.host.querySelectorAll('button')].some(button=>button.textContent==='Retry reconciliation'));
  }finally{await f.close();}
});
test('permission failures are visible and cannot expose retry controls',async()=>{
  globalThis.fetch=async()=>Response.json({error:'Cancellation management permission required'},{status:403});
  const f=await mount();
  try{await f.click('Cancellation recovery');assert.match(f.host.querySelector('[role="alert"]').textContent,/permission/);
    assert.ok(!f.host.textContent.includes('Retry reconciliation'));
  }finally{await f.close();}
});
test('closing the panel aborts an outstanding request',async()=>{
  let signal;globalThis.fetch=async(_url,options)=>{signal=options.signal;return new Promise(()=>{});};
  const f=await mount();
  try{await f.click('Cancellation recovery');assert.equal(signal.aborted,false);
    await f.click('Cancellation recovery');assert.equal(signal.aborted,true);
  }finally{await f.close();}
});
