import test from 'node:test';
import assert from 'node:assert/strict';
import { eventFunnelChoices, eventFunnelSetupUrl, funnelSourceEvent } from './eventFunnelApi.js';

const data = {
  definitions: [{ id: 'b', name: 'beta day' }, { id: 'a', name: 'Alpha' }, { id: 'c', name: 'Gamma 10' }, { id: 'd', name: 'Gamma 2' }],
  groups: [{ id: 'g2', name: 'Zed' }, { id: 'g1', name: 'Autumn' }],
  groupMembers: [{ definition_id: 'b', collection_id: 'g1' }],
};
test('funnels and groups are alphabetical, case-insensitive and type-ahead filtered', () => {
  const all = eventFunnelChoices(data);
  assert.deepEqual(all.funnels.map(f => f.name), ['Alpha', 'beta day', 'Gamma 2', 'Gamma 10']);
  assert.deepEqual(all.groups.map(g => [g.name, g.funnelCount]), [['Autumn', 1], ['Zed', 0]]);
  assert.equal(all.funnels[1].groupName, 'Autumn');
  const search = eventFunnelChoices(data, ' AUT ');
  assert.deepEqual(search.groups.map(g => g.id), ['g1']);
  assert.deepEqual(search.funnels.map(f => f.id), ['b']); // matched by its group name
  assert.deepEqual(eventFunnelChoices(data, 'gamma').funnels.map(f => f.id), ['d', 'c']);
  assert.deepEqual(eventFunnelChoices(data, 'nothing'), { groups: [], funnels: [] });
});
test('setup links open the selected funnel and source events come from the entry node', () => {
  assert.equal(eventFunnelSetupUrl('a b'), '/EventFunnels?funnel=a%20b');
  const event = { kind: 'simple', id: 'e1' };
  assert.deepEqual(funnelSourceEvent({ graph: { entry: 's', nodes: [{ id: 'x' }, { id: 's', event }] } }), event);
  assert.equal(funnelSourceEvent(null), null);
});
