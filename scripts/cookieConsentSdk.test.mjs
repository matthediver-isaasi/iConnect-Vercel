import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {CONSENT_CATEGORIES,validateConsentOverrides,effectiveConsentConfig} from '../shared/cookieConsent.js';
const dom = new JSDOM('',{url:'https://tenant.example'});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,location:dom.window.location,localStorage:dom.window.localStorage});
const {initCookieYes,resetConsentRuntime} = await import('@cookieyes/core');
function start(scope,persist=async()=>{}) {
  return initCookieYes({mode:'self-hosted',regulation:'GDPR',categories:CONSENT_CATEGORIES,backend:{storageScope:scope,persist}});
}
test('React lifecycle disposal stops queued retries across replacement',async()=>{
  const {initCookieYes:initReact}=await import('@cookieyes/react');
  const {resetConsentRuntime:resetReact}=await import('../client/src/lib/resetConsentRuntime.js');
  let attempts=0;
  const runtime=initReact({mode:'self-hosted',regulation:'GDPR',categories:CONSENT_CATEGORIES,
    backend:{storageScope:'react-old',persist:async()=>{attempts++;throw new Error('offline');}}});
  runtime.manager.acceptAll();
  await new Promise(r=>setTimeout(r,10));
  assert.equal(attempts,1);
  resetReact(runtime);
  const next=initReact({mode:'self-hosted',regulation:'GDPR',categories:CONSENT_CATEGORIES,
    backend:{storageScope:'react-new',persist:async()=>{}}});
  window.dispatchEvent(new window.Event('online'));
  await new Promise(r=>setTimeout(r,10100));
  assert.equal(attempts,1,'neither online nor scheduled retries survive React disposal');
  assert.equal(next.manager.hasActed,false);
  resetReact(next);
});
test('real patched SDK isolates tenant cookies and retry queues',async()=>{
  const a=start('a',async()=>{throw new Error('offline')});
  a.consentManager.acceptAll();
  await new Promise(r=>setTimeout(r,0));
  assert.match(document.cookie,/cookieyes-consent-a=/);
  assert.equal(JSON.parse(localStorage.getItem('cookieyes-consent-records-a')).length,1);
  resetConsentRuntime();
  const b=start('b'); assert.equal(b.consentManager.hasActed,false);
  b.consentManager.rejectAll(); resetConsentRuntime();
  const back=start('a'); assert.equal(back.consentManager.committedCategories.analytics,true);resetConsentRuntime();
});
test('revision scope re-prompts and legacy binary acceptance grants nothing',()=>{
  localStorage.setItem('cookie-consent','accepted');
  const r=start('a-policy2');assert.equal(r.consentManager.hasActed,false);
  assert.equal(r.consentManager.committedCategories.analytics,false);
  resetConsentRuntime();
});
test('queue retains at most ten records, expires old records and disposes online retries',async()=>{
  const key='cookieyes-consent-records-cap';
  localStorage.setItem(key,JSON.stringify(Array.from({length:14},(_,i)=>({recordId:String(i),decidedAt:new Date(Date.now()-(i===0?9:0)*86400000).toISOString()}))));
  let calls=0;
  start('cap',async()=>{calls++;throw Error('offline')});
  await new Promise(r=>setTimeout(r,0));
  assert.equal(JSON.parse(localStorage.getItem(key)).length,10);
  resetConsentRuntime();const before=calls;
  window.dispatchEvent(new window.Event('online'));await new Promise(r=>setTimeout(r,0));
  assert.equal(calls,before);
});
test('settings default off and tenant cannot enable rollout',()=>{
  assert.equal(effectiveConsentConfig().enabled,false);
  assert.throws(()=>validateConsentOverrides({enabled:true}));
  assert.throws(()=>validateConsentOverrides({privacyUrl:'javascript:alert(1)'}));
  assert.throws(()=>validateConsentOverrides({privacyUrl:'//evil.test'}));
  assert.throws(()=>validateConsentOverrides({retentionDays:0},true));
});
