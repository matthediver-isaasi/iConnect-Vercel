import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_TYPES, AUTO_HEIGHT_LEAF_TYPES, blockSupportsShadow, createBlock, createFlowNode,
  normalizeCanvasDesign, convertDesignToFlow, cloneCanvasBlockWithFreshIds,
} from './canvasDesign.js';

for (const type of [BLOCK_TYPES.MEMBERSHIP_SUMMARY, BLOCK_TYPES.PAYMENT_DETAILS]) {
  test(`${type} has independent responsive geometry and shared appearance support`, () => {
    const block = createBlock(type);
    assert.ok(AUTO_HEIGHT_LEAF_TYPES.has(type));
    assert.ok(blockSupportsShadow(type));
    assert.ok(block.bp.desktop.w > block.bp.tablet.w);
    assert.ok(block.bp.mobile.w <= 375 - block.bp.mobile.x);
    assert.equal(block.style.borderWidth, 1);
    assert.equal(block.style.boxShadow, 'none');
    const copy = cloneCanvasBlockWithFreshIds(block);
    assert.notEqual(copy.id, block.id);
    assert.deepEqual(copy.content, block.content);
    copy.content.eyebrow = 'Independent copy';
    assert.notEqual(copy.content.eyebrow, block.content.eyebrow);
  });

  test(`${type} round-trips presentation in positioned and flow documents, never data`, () => {
    for (const version of [1, 2]) {
      const make = version === 1 ? createBlock : createFlowNode;
      const block = make(type, {
        content: { eyebrow: 'My membership words', memberSince: 'PRIVATE', payment: { state: 'active' }, memberId: 'PRIVATE' },
        style: { boxShadow: 'lg', paddingTop: 36, borderRadius: 18 },
        mobile: { w: 300 },
      });
      const design = {
        version,
        root: { sections: [{ id: 'root', ...(version === 2 ? { type: 'section' } : {}), children: [block] }] },
      };
      const saved = normalizeCanvasDesign(JSON.parse(JSON.stringify(design)));
      const reopened = saved.root.sections[0].children[0];
      assert.equal(reopened.type, type);
      assert.equal(reopened.content.eyebrow, 'My membership words');
      assert.equal(reopened.style.boxShadow, 'lg');
      assert.equal(reopened.style.paddingTop, 36);
      assert.equal(reopened.bp.mobile.w, 300);
      assert.equal(reopened.content.memberSince, undefined);
      assert.equal(reopened.content.memberId, undefined);
      assert.equal(reopened.content.payment, undefined);
      assert.deepEqual(normalizeCanvasDesign(saved), saved);
    }
  });

  test(`${type} remains content-sized when converting positioned pages to flow`, () => {
    const design = convertDesignToFlow({
      version: 1,
      root: { sections: [{ id: 'root', children: [createBlock(type)] }] },
    });
    const find = (node) => node.type === type ? node : (node.children || []).map(find).find(Boolean);
    const leaf = design.root.sections.map(find).find(Boolean);
    assert.ok(leaf);
    assert.equal(leaf.flow.heightMode, 'auto');
  });
}

test('new shadow support does not change existing block defaults or type gates', () => {
  assert.equal(blockSupportsShadow(BLOCK_TYPES.TEXT), false);
  assert.equal(createBlock(BLOCK_TYPES.BOX).style.boxShadow, 'none');
});