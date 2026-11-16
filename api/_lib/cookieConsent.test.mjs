import test from 'node:test';
import assert from 'node:assert/strict';
import {consentHost,sameOrigin,validateConsentRecord,policyFingerprint,loadConsentConfig} from './cookieConsent.js';
import {effectiveConsentConfig,consentComplete} from '../../shared/cookieConsent.js';
const ctx={host:'site.example',policyVersion:'1',revision:'r',taxonomyHash:'tax'};
const record={recordId:'abc.1.x',consentId:'abc',categories:{necessary:true,functional:false,analytics:false,marketing:false},regulation:'GDPR',domain:ctx.host,decidedAt:new Date().toISOString(),taxonomyHash:'tax',action:'reject_all',source:'banner',policyVersion:'1',policyRevision:'r'};
test('host authority ignores forged forwarded hosts and overrides',()=>{
  assert.equal(consentHost({headers:{host:'site.example','x-forwarded-host':'evil.example'},query:{tenant:'evil'}}),'site.example');
  for(const host of ['localhost','x.replit.dev','x.vercel.app','evil.example/path','site.example,evil.example']) assert.throws(()=>consentHost({headers:{host}}));
  assert.equal(sameOrigin({headers:{origin:'https://evil.example'}},ctx.host),false);
  assert.equal(sameOrigin({headers:{origin:'https://site.example'}},ctx.host),true);
});
test('validation rejects spoofing, drift, invalid categories, timestamps and oversize',()=>{
  assert.equal(validateConsentRecord(record,ctx).domain,ctx.host);
  for(const edit of [{domain:'evil.example'},{tenant_id:'fake'},{policyRevision:'old'},{categories:{necessary:true,analytics:'yes'}},{decidedAt:'not a date'},{decidedAt:new Date(Date.now()-8*86400000).toISOString()},{recordId:'x'.repeat(5000)},{action:'unknown'}]) assert.throws(()=>validateConsentRecord({...record,...edit},ctx));
});
test('material wording changes invalidate persisted consent scope',()=>{
  assert.notEqual(policyFingerprint({policyVersion:'1',title:'old'}),policyFingerprint({policyVersion:'1',title:'new'}));
});
test('website privacy fallback preserves explicit consent URLs and rejects unsafe legacy URLs',()=>{
  const website='https://tenant.example/privacy';
  assert.equal(effectiveConsentConfig({}, {}, website).privacyUrl,website);
  assert.equal(effectiveConsentConfig({}, {privacyUrl:''}, website).privacyUrl,website);
  assert.equal(effectiveConsentConfig({privacyUrl:'/platform-policy'}, {},website).privacyUrl,'/platform-policy');
  assert.equal(effectiveConsentConfig({privacyUrl:'/platform-policy'}, {privacyUrl:'/custom'},website).privacyUrl,'/custom');
  assert.equal(effectiveConsentConfig({}, {}, ' /privacy ').privacyUrl,'/privacy');
  for(const bad of ['javascript:alert(1)','//evil.example','http://tenant.example/privacy','https://user:pass@tenant.example','/bad path',{},null]) {
    assert.equal(consentComplete(effectiveConsentConfig({}, {},bad)),false);
  }
});
test('live resolver inherits only its tenant website URL without weakening rollout gates',async()=>{
  const id='00000000-0000-4000-8000-000000000001';
  let settings={enabled:true,pilotTenantIds:[id],analyticsEnabled:true};
  const db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{value:settings}})})})})};
  const tenant={id,settings:{},footer_config:{privacyPolicyUrl:'https://tenant.example/privacy'}};
  const result=await loadConsentConfig(tenant,db);
  assert.equal(result.active,true);
  assert.equal(result.effective.privacyUrl,tenant.footer_config.privacyPolicyUrl);
  assert.equal((await loadConsentConfig({...tenant,footer_config:{}},db)).active,false);
  assert.equal((await loadConsentConfig({...tenant,id:'other'},db)).active,false);
  settings={...settings,enabled:false};
  assert.equal((await loadConsentConfig(tenant,db)).active,false);
  const changed=effectiveConsentConfig({}, {},'/new-policy');
  assert.notEqual(policyFingerprint(result.effective),policyFingerprint(changed));
});
