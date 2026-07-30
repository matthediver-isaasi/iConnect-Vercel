// Task #3232 — chain guard for workflow-initiated field changes.
// extendWorkflowChain is the pure core of the loop/depth guard: each
// update_field action extends the chain with the current workflow's id before
// downstream evaluation; trigger paths skip workflows already in `visited`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extendWorkflowChain } from './workflows.js';

const wf = (id) => ({ id, name: `wf-${id}` });

test('first link starts a chain at depth 1 containing the workflow id', () => {
  const chain = extendWorkflowChain({}, wf('a'));
  assert.deepEqual(chain, { depth: 1, visited: ['a'] });
});

test('undefined/absent context behaves like an empty chain', () => {
  const chain = extendWorkflowChain(undefined, wf('a'));
  assert.deepEqual(chain, { depth: 1, visited: ['a'] });
});

test('subsequent links accumulate visited ids and depth', () => {
  const c1 = extendWorkflowChain({}, wf('a'));
  const c2 = extendWorkflowChain({ chain: c1 }, wf('b'));
  assert.equal(c2.depth, 2);
  assert.deepEqual([...c2.visited].sort(), ['a', 'b']);
});

test('re-adding the same workflow keeps visited deduplicated (self-trigger)', () => {
  const c1 = extendWorkflowChain({}, wf('a'));
  const c2 = extendWorkflowChain({ chain: c1 }, wf('a'));
  assert.deepEqual(c2.visited, ['a']);
  // the visited guard in the trigger paths is what blocks the re-run:
  assert.ok(c2.visited.includes('a'));
});

test('depth cap returns null so callers stop chaining', () => {
  let ctx = {};
  let chain = null;
  for (let i = 0; i < 5; i++) {
    chain = extendWorkflowChain(ctx, wf(`w${i}`));
    assert.notEqual(chain, null, `link ${i + 1} should be allowed`);
    ctx = { chain };
  }
  // 6th link exceeds MAX_WORKFLOW_CHAIN_DEPTH (5)
  assert.equal(extendWorkflowChain(ctx, wf('w5')), null);
});

test('extending does not mutate the parent chain (branches stay independent)', () => {
  const c1 = extendWorkflowChain({}, wf('a'));
  const snapshot = [...c1.visited];
  extendWorkflowChain({ chain: c1 }, wf('b'));
  assert.deepEqual(c1.visited, snapshot);
});
