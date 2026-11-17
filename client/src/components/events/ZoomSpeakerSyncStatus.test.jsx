import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost'});
for(const key of ['window','document','navigator','HTMLElement','Node','Event','MutationObserver']) {
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
}
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=(await import('react')).default;
globalThis.React=React;
const {act}=React;
const {createRoot}=await import('react-dom/client');
const {default:Status}=await import('./ZoomSpeakerSyncStatus.jsx');
after(()=>dom.window.close());
test('shows retryable status, completes sync, and never automatically sends a POST',async()=>{
  const calls=[];const original=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    calls.push(options.method||'GET');
    return {ok:true,json:async()=>({job:options.method==='POST'?{status:'completed'}:{status:'attention',last_error:'Missing speaker email'}})};
  };
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  try{
    await act(async()=>root.render(<Status eventId="event" webinarId="webinar"/>));
    assert.match(container.textContent,/Missing speaker email/);assert.deepEqual(calls,['GET']);
    await act(async()=>container.querySelector('button').click());
    assert.deepEqual(calls,['GET','POST']);assert.match(container.textContent,/are synchronised/);
  } finally {await act(async()=>root.unmount());container.remove();globalThis.fetch=original;}
});
