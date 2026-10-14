import test from 'node:test';
import assert from 'node:assert/strict';
import {overseasWordingAgrees} from './bnms-recovery-source-evidence.mjs';
const source=()=>({state:'source_conflict_requires_review',memberClass:'Overseas associate',
  retainedExpiry:'2027-06-01',legacyType:'Associate Membership Overseas',
  matches:['Associate','Overseas Associate','Overseas associate'].map(klass=>({
    class:klass,type:'Associate Membership Overseas',status:'Active',expiry:'2027-06-01',identityConflict:false}))});
test('overseas class wording agrees only with independent type, expiry and identity evidence',()=>{
  assert.equal(overseasWordingAgrees(source()),true);
  for(const mutate of [
    s=>s.matches[0].class='Full junior',
    s=>s.matches[0].class='Associate with NMC',
    s=>s.matches[0].type='Associate Membership UK',
    s=>s.matches[0].expiry='2026-06-01',
    s=>s.matches[0].status='Expired',
    s=>s.matches[0].identityConflict=true,
    s=>s.matches=[],
  ]){const s=source();mutate(s);assert.equal(overseasWordingAgrees(s),false);}
});
