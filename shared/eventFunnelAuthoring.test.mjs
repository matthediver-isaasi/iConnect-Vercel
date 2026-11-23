import test from 'node:test';
import assert from 'node:assert/strict';
import { isFutureFunnelEvent, sortFunnelCatalog } from './eventFunnelAuthoring.mjs';
const now = Date.parse('2026-11-23T12:00:00Z');
test('only known future, non-completed events can be selected', () => {
  assert.equal(isFutureFunnelEvent({start_date:'2026-11-24T00:00:00Z'},now),true);
  for (const event of [{}, {start_date:'bad'}, {start_date:'2026-11-23T12:00:00Z'},
    {start_date:'2026-11-23T11:00:00Z',end_date:'2026-11-25'},
    {start_date:'2026-11-24',status:'completed'}, {start_date:'2026-11-24',event_state:'cancelled'}]) {
    assert.equal(isFutureFunnelEvent(event,now),false);
  }
});
test('catalog sorting is alphabetical, case-insensitive and non-mutating', () => {
  const catalog = [{id:'3',title:'zebra'},{id:'2',title:'Beta'},{id:'1',title:'alpha'}];
  assert.deepEqual(sortFunnelCatalog(catalog).map(e=>e.title),['alpha','Beta','zebra']);
  assert.equal(catalog[0].title,'zebra');
});
