import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorPoints, connectorPath, connectorMidpoint, moveConnectorBend, moveConnectorSegment, addConnectorBend } from './eventFunnelConnectorGeometry.mjs';
import { funnelConnectorKey, funnelConnectorKeys, pruneFunnelEditorLayout } from '../../../../shared/eventFunnelEditorLayout.mjs';
const start = { x: 10, y: 20 }, end = { x: 210, y: 300 };
function orthogonal(points) {
  assert.deepEqual(points[0], start);
  assert.deepEqual(points.at(-1), end);
  for (let i = 1; i < points.length; i++) assert.ok(points[i].x === points[i - 1].x || points[i].y === points[i - 1].y);
}
test('connector paths attach to ports, support backwards routes and use arc-length label positions', () => {
  const points = connectorPoints(start, end);
  orthogonal(points);
  assert.match(connectorPath(points), /^M 10 20 L/);
  assert.deepEqual(connectorMidpoint(points), { x: 110, y: 160 });
  const backwards = connectorPoints(end, start);
  assert.ok(backwards.some(point => point.x > end.x));
  assert.deepEqual(backwards.at(-1), start);
});
test('bend and segment editing preserve endpoint identity and orthogonal connections', () => {
  const points = connectorPoints(start, end), before = JSON.stringify(points);
  for (const changed of [moveConnectorBend(points, 1, { x: 90, y: 220 }),
    moveConnectorBend(points, 2, { x: 300, y: 100 }),
    moveConnectorSegment(points, 1, { x: 110, y: 200 }),
    addConnectorBend(points)]) orthogonal(changed);
  assert.equal(JSON.stringify(points), before);
  const complex = addConnectorBend(points);
  for (let index = 1; index < complex.length - 1; index++) orthogonal(moveConnectorBend(complex, index, { x: 140, y: 240 }));
});
test('saved bends round-trip and stay connected when a step moves', () => {
  const points = addConnectorBend(connectorPoints(start, end));
  const saved = JSON.parse(JSON.stringify(points.slice(1, -1)));
  assert.deepEqual(connectorPoints(start, end, saved), points);
  const movedStart = { x: 300, y: 200 };
  const moved = connectorPoints(movedStart, end, saved);
  assert.deepEqual(moved[0], movedStart); assert.deepEqual(moved.at(-1), end);
  for (let i = 1; i < moved.length; i++) assert.ok(moved[i].x === moved[i - 1].x || moved[i].y === moved[i - 1].y);
});
test('connector identities distinguish parallel outcomes and ignore display ordering', () => {
  const graph = { nodes: [{ id: 'source', type: 'source', accept: 'offer' },
    { id: 'offer', type: 'addon', accept: 'end', skip: 'end' }, { id: 'end', type: 'checkout' }] };
  const accept = funnelConnectorKey({ source: 'offer', sourceHandle: 'accept', target: 'end' });
  const skip = funnelConnectorKey({ source: 'offer', sourceHandle: 'skip', target: 'end' });
  assert.notEqual(accept, skip);
  assert.ok(funnelConnectorKeys(graph).has(accept));
  assert.deepEqual(funnelConnectorKeys(graph), funnelConnectorKeys({ nodes: [...graph.nodes].reverse() }));
  const layout = { positions: { source: start, removed: end }, connectors: { [accept]: { bends: [start, end] }, old: {} } };
  assert.deepEqual(pruneFunnelEditorLayout(layout, graph), {
    positions: { source: start }, connectors: { [accept]: { bends: [start, end] } },
  });
});
test('deleting a step prunes only its width, retaining other widths and connector geometry', () => {
  const graph = { nodes: [{ id: 'source', type: 'source', accept: 'end' }, { id: 'end', type: 'checkout' }] };
  const key = funnelConnectorKey({ source: 'source', sourceHandle: 'accept', target: 'end' });
  const layout = { positions: {}, nodeWidths: { source: 320, removed: 400 }, connectors: { [key]: { labelOffset: start } } };
  assert.deepEqual(pruneFunnelEditorLayout(layout, graph), {
    positions: {}, nodeWidths: { source: 320 }, connectors: layout.connectors,
  });
  assert.equal(layout.nodeWidths.removed, 400);
});
