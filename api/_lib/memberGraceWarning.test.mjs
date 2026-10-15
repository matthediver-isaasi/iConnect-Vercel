import test from 'node:test';
import assert from 'node:assert/strict';
import { annualGraceWarning, recurringGraceWarning, loadMemberGraceWarning } from './memberGraceWarning.js';

test('annual grace uses UTC days and inclusive final day', () => {
  const e = { paidThroughDate: '2026-10-01', graceEndDate: '2026-10-08' };
  assert.equal(annualGraceWarning(e, '2026-10-01'), null);
  assert.equal(annualGraceWarning(e, '2026-10-02').days, 1);
  assert.equal(annualGraceWarning(e, '2026-10-08').expired, false);
  assert.equal(annualGraceWarning(e, '2026-10-09').expired, true);
  assert.equal(annualGraceWarning({}, '2026-10-09'), null);
});
test('DD grace uses saved policy and expires at its timestamp', () => {
  const agreement = { provider: 'gocardless', metadata: { dd: { grace_days: 7 } } };
  const plan = { status: 'payment_grace_period', grace_expires_at: '2026-10-08T12:00:00Z', failed_provider_reference: 'payment' };
  const warning = recurringGraceWarning(plan, agreement, Date.parse('2026-10-04T12:00:00Z'));
  assert.equal(warning.days, 3);
  assert.match(warning.reason, /payment failed/);
  assert.equal(recurringGraceWarning(plan, agreement, Date.parse(plan.grace_expires_at)).expired, true);
  assert.match(recurringGraceWarning({ ...plan, status: 'cancelled' }, agreement, Date.now()).reason, /cancelled/);
  assert.match(recurringGraceWarning({ ...plan, status: 'payment_plan_cancelled' }, agreement, Date.now()).reason, /cancelled/);
  const card = recurringGraceWarning(plan, { provider: 'stripe', metadata: { card: { grace_days: 7 } } }, Date.parse('2026-10-04T12:00:00Z'));
  assert.equal(card.days, 3);
  assert.match(card.reason, /Recurring card/);
  assert.equal(recurringGraceWarning({ ...plan, status: 'active' }, agreement, Date.now()), null);
  assert.equal(recurringGraceWarning({ ...plan, grace_expires_at: null }, agreement, Date.now()), null);
});
test('no warning for paused, missing or already renewed personal membership', async () => {
  const db = { from() { throw new Error('Unexpected database lookup'); } };
  const member = { id: 'member', tenant_id: 'tenant' };
  const base = { member, now: new Date('2026-10-13'), history: [] };
  assert.equal(await loadMemberGraceWarning(db, base), null);
  assert.equal(await loadMemberGraceWarning(db, { ...base, paused: true }), null);
  assert.equal(await loadMemberGraceWarning(db, { ...base, history: [
    { ...term, status: 'expired', term_end_date: '2026-10-01' },
    { ...term, id: 'new', status: 'active', term_end_date: '2027-10-01' },
  ] }), null);
});

const term = {
  id: 'h', tenant_id: 'tenant', member_id: 'member', membership_source: 'personal',
  status: 'expired', payment_status: 'paid', payment_method: 'upfront', billing_period: 'annual',
  term_start_date: '2025-10-02', term_end_date: '2026-10-01',
  commitment_snapshot: { config: { renewal_grace_days: 30 } },
};
const check = (history, today='2026-10-09', db=null) => loadMemberGraceWarning(db, {
  member: { id: 'member', tenant_id: 'tenant' }, history, now: new Date(today),
});
test('expired paid and active paid terms show applied-policy grace and remaining days', async () => {
  for (const status of ['expired', 'active', 'paid']) {
    const warning = await check([{ ...term, status }]);
    assert.equal(warning.expired, false); assert.equal(warning.days, 8);
    assert.equal(warning.remainingDays, 22); assert.equal(warning.endsOn, '2026-10-31');
  }
});
test('after grace is red, zero grace is explicit, missing grace is unknown not defaulted', async () => {
  assert.equal((await check([term], '2026-11-01')).expired, true);
  const zero={...term,commitment_snapshot:{config:{renewal_grace_days:0}}};
  assert.equal((await check([zero])).noGrace, true);
  assert.equal((await check([{...term,commitment_snapshot:{config:{}}}])).policyUnknown, true);
});
test('settlement is separate from lifecycle, and only this member personal records qualify', async () => {
  for(const patch of [{status:'paid',payment_status:'unpaid'},{status:'cancelled'},
    {membership_source:'organisation'},{tenant_id:'other'},{member_id:'other'}]) {
    assert.equal(await check([{...term,...patch}]),null);
  }
});
test('pending renewals do not hide an overdue term, paid current renewals do', async () => {
  const newer={...term,id:'new',term_start_date:'2026-10-02',term_end_date:'2027-10-01',status:'active'};
  assert.equal(await check([term,newer]),null);
  assert.equal((await check([term,{...newer,payment_status:'unpaid'}])).days,8);
  assert.equal((await check([term,{...newer,term_start_date:'2026-11-01'}])).days,8);
});
test('saved config lookup failures are explicit rather than silent', async () => {
  const q={select(){return this},eq(){return this},async maybeSingle(){return {error:new Error('unavailable')}}};
  await assert.rejects(check([{...term,commitment_snapshot:null,config_id:'c'}],undefined,{from:()=>q}));
});
test('a saved config is loaded by ID and manual upfront terms retain grace', async () => {
  const scopes=[];
  const q={select(){return this},eq(key,value){scopes.push([key,value]);return this},
    async maybeSingle(){return {data:{id:'c',tenant_id:'tenant',renewal_grace_days:7}}}};
  const warning=await check([{...term,payment_method:'manual',commitment_snapshot:null,config_id:'c'}],
    '2026-10-09',{from:()=>q});
  assert.equal(warning.expired,true);
  assert.deepEqual(scopes,[['tenant_id','tenant'],['id','c']]);
});
test('paid active recurring records still report failed payments and missing deadlines', async () => {
  for(const provider of ['gocardless','stripe']){
    for(const deadline of ['2026-10-08T12:00:00Z',null]){
      const db={from(table){
        const data=table==='membership_billing_agreements'?{provider,metadata:{dd:{grace_days:7},card:{grace_days:7}}}:
          {status:'payment_overdue',grace_expires_at:deadline,failed_provider_reference:'failure'};
        return {select(){return this},eq(){return this},order(){return this},limit(){return this},async maybeSingle(){return {data}}};
      }};
      const warning=await check([{...term,status:'active',billing_agreement_id:'agreement'}],'2026-10-09',db);
      if(deadline){assert.equal(warning.expired,true);assert.match(warning.reason,/payment failed/);}
      else assert.equal(warning.policyUnknown,true);
    }
  }
});
