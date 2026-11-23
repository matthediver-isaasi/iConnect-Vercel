import test from 'node:test';
import assert from 'node:assert/strict';
import { autoLayoutFunnel } from './eventFunnelLayout.mjs';

const graph = { nodes: [
  {id:'source',type:'source',accept:'condition'},
  {id:'condition',type:'condition',rules:[{to:'offer'}],fallback:'checkout'},
  {id:'offer',type:'event',accept:'checkout',skip:'checkout'},
  {id:'checkout',type:'checkout'},
] };
test('layout is top-down, deterministic, and never mutates routing', () => {
  const before = structuredClone(graph);
  const positions = autoLayoutFunnel(graph);
  assert.deepEqual(graph,before);
  assert.deepEqual(positions,autoLayoutFunnel(graph));
  assert.deepEqual(Object.keys(positions),graph.nodes.map(node=>node.id));
  for (const p of Object.values(positions)) assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
  assert.ok(positions.source.y < positions.condition.y);
  assert.ok(positions.condition.y < positions.offer.y);
  assert.ok(positions.offer.y < positions.checkout.y);
});
test('layout uses measured dimensions and separates parallel branches', () => {
  const branched = {nodes:[{id:'source',type:'source',accept:'choice'},
    {id:'choice',type:'condition',rules:[{to:'left'},{to:'right'}],fallback:'checkout'},
    {id:'left',type:'event',accept:'checkout'},{id:'right',type:'event',accept:'checkout'},
    {id:'checkout',type:'checkout'}]};
  const p = autoLayoutFunnel(branched,[{id:'left',measured:{width:400,height:280}},
    {id:'right',measured:{width:450,height:350}}]);
  assert.ok(p.left.x+400 <= p.right.x || p.right.x+450 <= p.left.x);
  assert.ok(p.checkout.y >= p.left.y+280);
  assert.ok(p.checkout.y >= p.right.y+350);
});
test('incomplete drafts, disconnected steps, and cycles remain arrangeable', () => {
  assert.deepEqual(autoLayoutFunnel({nodes:[]}),{});
  for (const nodes of [
    [{id:'one',type:'source',accept:'missing'},{id:'two',type:'checkout'}],
    [{id:'one',type:'event',accept:'two'},{id:'two',type:'event',accept:'one'}],
  ]) {
    const p = autoLayoutFunnel({nodes});
    assert.equal(Object.keys(p).length,2);
    assert.ok(Object.values(p).every(pos=>Number.isFinite(pos.x)&&Number.isFinite(pos.y)));
  }
});
