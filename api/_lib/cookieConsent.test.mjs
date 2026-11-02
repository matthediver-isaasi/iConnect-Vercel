import test from 'node:test';
import assert from 'node:assert/strict';
import {consentHost,sameOrigin,validateConsentRecord,policyFingerprint} from './cookieConsent.js';
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
