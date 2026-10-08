import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './form-alerts.js';
import { normalizeFormAlertSettings } from '../../shared/formAlertSettings.js';

test('recipient settings normalize and deduplicate without silently dropping invalid entries', () => {
  assert.deepEqual(normalizeFormAlertSettings({ enabled: true, recipients: [' Staff@Example.com ', 'staff@example.com'] }),
    { enabled: true, recipients: ['staff@example.com'] });
  for (const recipients of [[], ['a@example.com\r\nBcc: b@example.com'], ['Name <a@example.com>'], [null], Array(21).fill('a@example.com')]) {
    assert.throws(() => normalizeFormAlertSettings({ enabled: true, recipients }));
  }
  assert.deepEqual(normalizeFormAlertSettings({ enabled: false, recipients: [] }), { enabled: false, recipients: [] });
  assert.throws(() => normalizeFormAlertSettings({ enabled: 'true', recipients: ['a@example.com'] }));
});

function response() {
  return { statusCode: 200, headers: {}, setHeader(k,v) { this.headers[k]=v; },
    status(code) { this.statusCode=code; return this; }, json(body) { this.body=body; return this; } };
}
const formId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const submissionId = '33333333-3333-4333-8333-333333333333';
function fixture({ form = { id: formId }, stored = null, submission = { id: submissionId }, role = { excluded_features: [] } } = {}) {
  const calls = [];
  const db = {
    from(table) {
      const filters = {};
      const chain = {
        select() { return chain; },
        eq(k,v) { filters[k]=v; return chain; },
        maybeSingle() {
          calls.push({ table, filters });
          return Promise.resolve({ data: table === 'role' ? role : table === 'form' ? form : table === 'form_submission' ? submission : stored });
        },
        upsert(value, options) { calls.push({ table,value,options }); return Promise.resolve({ error: null }); },
      };
      return chain;
    },
    rpc(name,args) { calls.push({ name,args }); return Promise.resolve({ error:null }); },
  };
  return { calls, db, getTenantContext: async () => ({ tenantId,isAuthenticated:true,tenantUserId:'dashboard-user' }) };
}
test('authentication and missing-role authorization fail before any private read', async () => {
  for (const authenticated of [false,true]) {
    const deps=fixture(); deps.getTenantContext=async()=>({ tenantId,isAuthenticated:authenticated });
    const res=response(); await handler({method:'GET',query:{form_id:formId}},res,deps);
    assert.equal(res.statusCode,authenticated ? 403 : 401); assert.equal(deps.calls.length,0);
  }
});
test('non-admin FormBuilder members can read, save, enable and revoke alerts', async () => {
  for (const method of ['GET','PUT','POST']) {
    const deps=fixture();
    deps.getTenantContext=async()=>({tenantId,isAuthenticated:true,roleId:'editor-role'});
    const res=response();
    await handler({method,query:{form_id:formId},body:{
      enabled:true,recipients:['a@example.com'],action:'revoke',submission_id:submissionId,
    }},res,deps);
    assert.equal(res.statusCode,200);
    assert.deepEqual(deps.calls[0].filters,{id:'editor-role',tenant_id:tenantId});
  }
});
test('FormBuilder exclusions and unresolved roles deny every alert operation before reading settings',async()=>{
  for (const method of ['GET','PUT','POST']) {
    for (const exclusion of ['forms','forms.form-builder','page_FormBuilder']) {
      for (const individual of [false,true]) {
        const deps=fixture({role:{excluded_features:individual ? [] : [exclusion]}});
        deps.getTenantContext=async()=>({tenantId,isAuthenticated:true,roleId:'editor-role',
          memberExcludedFeatures:individual ? [exclusion] : []});
        const res=response();
        await handler({method,query:{form_id:formId}},res,deps);
        assert.equal(res.statusCode,403);
        assert.deepEqual(deps.calls.map(c=>c.table),['role']);
      }
    }
    const deps=fixture({role:null});
    deps.getTenantContext=async()=>({tenantId,isAuthenticated:true,roleId:'missing-role'});
    const res=response(); await handler({method,query:{form_id:formId}},res,deps);
    assert.equal(res.statusCode,403);
    assert.equal(deps.calls.length,1);
  }
});
test('default-off reads and writes are scoped to the authenticated tenant and form', async () => {
  const deps=fixture(); const res=response();
  await handler({method:'GET',query:{form_id:formId}},res,deps);
  assert.deepEqual(res.body,{enabled:false,recipients:[],expires_in_days:7,available:true});
  assert.ok(deps.calls.every(call=>call.filters.tenant_id===tenantId));
  const saved=response();
  await handler({method:'PUT',query:{form_id:formId},body:{enabled:false,recipients:[' A@Example.com '],tenant_id:'attacker'}},saved,deps);
  assert.equal(saved.statusCode,200);
  assert.deepEqual(deps.calls.at(-1).value,{tenant_id:tenantId,form_id:formId,enabled:false,recipients:['a@example.com']});
});
test('verified delivery can be enabled only with validated recipients',async()=>{
  const deps=fixture();const res=response();
  await handler({method:'PUT',query:{form_id:formId},body:{enabled:true,recipients:['a@example.com']}},res,deps);
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body,{enabled:true,recipients:['a@example.com'],expires_in_days:7,available:true});
});
test('cross-tenant forms and submissions cannot be configured or revoked', async () => {
  const missingForm=fixture({form:null}); const res=response();
  await handler({method:'PUT',query:{form_id:formId},body:{enabled:true,recipients:['a@example.com']}},res,missingForm);
  assert.equal(res.statusCode,404); assert.equal(missingForm.calls.length,1);
  const missingSubmission=fixture({submission:null}); const revoke=response();
  await handler({method:'POST',body:{action:'revoke',form_id:formId,submission_id:submissionId}},revoke,missingSubmission);
  assert.equal(revoke.statusCode,404); assert.ok(!missingSubmission.calls.some(c=>c.name));
});
test('revocation carries all three scope keys, and database failures do not leak diagnostics', async () => {
  const deps=fixture(); const res=response();
  await handler({method:'POST',body:{action:'revoke',form_id:formId,submission_id:submissionId}},res,deps);
  assert.deepEqual(deps.calls.at(-1),{name:'revoke_form_submission_alerts',args:{
    p_tenant_id:tenantId,p_form_id:formId,p_submission_id:submissionId }});
  deps.db.from=()=>{throw new Error('private diagnostic');};
  const failed=response(); await handler({method:'GET',query:{form_id:formId}},failed,deps);
  assert.equal(failed.statusCode,503); assert.ok(!JSON.stringify(failed.body).includes('private diagnostic'));
});
