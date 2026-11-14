import test from 'node:test';
import assert from 'node:assert/strict';
import { previewAllocation } from './allocation.js';
const input = () => ({
  mode: 'balanced', requiredJudges: 2,
  applications: ['a','b','c'].map(id=>({id,eligibility:'eligible'})),
  appointments: ['j1','j2','j3'].map(id=>({id,state:'accepted',role:'judge',available:true,capacity:10})),
});
test('balanced preview distributes work fairly and deterministically', () => {
  const r=previewAllocation(input());
  assert.equal(r.assignments.length,6); assert.deepEqual(r.workload,{j1:2,j2:2,j3:2});
  assert.deepEqual(r,previewAllocation(input()));
});
test('availability, capacity, conflicts and eligibility exclude unsafe assignments', () => {
  const p=input(); p.applications[2].eligibility='withdrawn'; p.appointments[2].available=false;
  p.appointments[1].capacity=1; p.conflicts=[{applicationId:'a',appointmentId:'j1',state:'potential'}];
  const r=previewAllocation(p);
  assert.equal(r.assignments.some(a=>a.appointmentId==='j3'||a.applicationId==='c'),false);
  assert.equal(r.assignments.some(a=>a.applicationId==='a'&&a.appointmentId==='j1'),false);
  assert.ok(r.shortages.length);
});
test('all-to-all and existing assignments never duplicate pairs', () => {
  const p=input();p.mode='all';p.assignments=[{applicationId:'a',appointmentId:'j1',state:'assigned'}];
  assert.equal(previewAllocation(p).assignments.length,8);
  p.mode='manual';p.manual=[{applicationId:'a',appointmentId:'j1'}];
  assert.throws(()=>previewAllocation(p),/duplicate/);
});
