// Advanced Accordion data-contract tests.
// React-free: tests run directly under Node with `node:test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_TYPES,
  AUTO_HEIGHT_LEAF_TYPES,
  createBlock,
  normalizeCanvasDesign,
  validateBlock,
  validateCanvasDesign,
  getPageAnchors,
  findDuplicateAnchorIds,
  cloneCanvasBlockWithFreshIds,
  addAdvancedAccordionItem,
  removeAdvancedAccordionItem,
  updateAdvancedAccordionItem,
  reorderAdvancedAccordionItems,
} from './canvasDesign.js';

// ---------------------------------------------------------------------------
// 1. Block type constant
// ---------------------------------------------------------------------------
test('BLOCK_TYPES.ADVANCED_ACCORDION is distinct from BLOCK_TYPES.ACCORDION', () => {
  assert.equal(BLOCK_TYPES.ADVANCED_ACCORDION, 'advanced-accordion');
  assert.equal(BLOCK_TYPES.ACCORDION, 'accordion');
  assert.notEqual(BLOCK_TYPES.ADVANCED_ACCORDION, BLOCK_TYPES.ACCORDION);
});

// ---------------------------------------------------------------------------
// 2. createBlock produces well-formed defaults
// ---------------------------------------------------------------------------
test('createBlock produces 2 items with stable ids and nested children', () => {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  assert.equal(block.type, 'advanced-accordion');
  assert.ok(Array.isArray(block.content.items));
  assert.equal(block.content.items.length, 2);

  const [i1, i2] = block.content.items;
  assert.match(i1.id, /^adv-acc-item-/);
  assert.match(i2.id, /^adv-acc-item-/);
  assert.notEqual(i1.id, i2.id);
  assert.ok(i1.anchor && i2.anchor && i1.anchor !== i2.anchor);
  assert.ok(typeof i1.title === 'string' && i1.title.length > 0);
  assert.ok(Array.isArray(i1.children) && i1.children.length > 0);

  // Each child should be a normalised canvas leaf (e.g. text block)
  const child = i1.children[0];
  assert.ok(child.type === 'text' || typeof child.type === 'string');
  assert.ok(child.id, 'child must have an id');
});

test('createBlock defaults mode to single and initialId to empty string', () => {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  assert.equal(block.content.mode, 'single');
  assert.equal(block.content.initialId, '');
});

// ---------------------------------------------------------------------------
// 3. ACCORDION legacy block is byte-identical (not touched)
// ---------------------------------------------------------------------------
test('ACCORDION createBlock is unchanged', () => {
  const block = createBlock(BLOCK_TYPES.ACCORDION);
  assert.equal(block.type, 'accordion');
  assert.equal(block.content.expandOne, true);
  assert.ok(Array.isArray(block.content.items));
  assert.equal(block.content.items[0].q, 'Question one?');
});

// ---------------------------------------------------------------------------
// 4. AUTO_HEIGHT_LEAF_TYPES includes ADVANCED_ACCORDION but not as ACCORDION
// ---------------------------------------------------------------------------
test('AUTO_HEIGHT_LEAF_TYPES includes advanced-accordion', () => {
  assert.ok(AUTO_HEIGHT_LEAF_TYPES.has(BLOCK_TYPES.ADVANCED_ACCORDION));
});

test('AUTO_HEIGHT_LEAF_TYPES also still includes legacy accordion', () => {
  assert.ok(AUTO_HEIGHT_LEAF_TYPES.has(BLOCK_TYPES.ACCORDION));
});

// ---------------------------------------------------------------------------
// 5. normalizeCanvasDesign round-trips the block
// ---------------------------------------------------------------------------
test('normalizeCanvasDesign preserves advanced accordion content across a round-trip', () => {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  const reloaded = normalizeCanvasDesign(JSON.parse(JSON.stringify(design)));
  const reBlock = reloaded.root.sections[0].children[0];
  assert.equal(reBlock.type, 'advanced-accordion');
  assert.equal(reBlock.content.items.length, 2);
  assert.equal(reBlock.content.mode, 'single');
});

// ---------------------------------------------------------------------------
// 6. Defensive normalization: malformed mode
// ---------------------------------------------------------------------------
test('normalizeBlock coerces invalid mode to single', () => {
  const malformed = {
    id: 'x',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      mode: 'INVALID_MODE',
      initialId: '',
      items: [{ id: 'i1', title: 'P', anchor: '', children: [] }],
    },
  };
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [malformed] }] },
  });
  assert.equal(design.root.sections[0].children[0].content.mode, 'single');
});

test('legacy multi mode is normalized to multiple', () => {
  const block = {
    id: 'x',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      mode: 'multi',
      initialId: '',
      items: [{ id: 'i1', title: 'P', anchor: '', children: [] }],
    },
  };
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  assert.equal(design.root.sections[0].children[0].content.mode, 'multiple');
});

// ---------------------------------------------------------------------------
// 7. Defensive normalization: stale initialId cleared
// ---------------------------------------------------------------------------
test('normalizeBlock clears initialId that does not match any item', () => {
  const block = {
    id: 'x',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      mode: 'single',
      initialId: 'does-not-exist',
      items: [{ id: 'i1', title: 'P', anchor: '', children: [] }],
    },
  };
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  assert.equal(design.root.sections[0].children[0].content.initialId, '');
});

test('normalizeBlock preserves a valid initialId', () => {
  const block = {
    id: 'x',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      mode: 'single',
      initialId: 'i1',
      items: [{ id: 'i1', title: 'P', anchor: '', children: [] }],
    },
  };
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  assert.equal(design.root.sections[0].children[0].content.initialId, 'i1');
});

// ---------------------------------------------------------------------------
// 8. Defensive normalization: duplicate item ids are re-keyed
// ---------------------------------------------------------------------------
test('normalizeBlock re-keys duplicate item ids to make them unique', () => {
  const block = {
    id: 'x',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      items: [
        { id: 'same', title: 'A', anchor: '', children: [] },
        { id: 'same', title: 'B', anchor: '', children: [] },
      ],
    },
  };
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  const items = design.root.sections[0].children[0].content.items;
  assert.equal(items.length, 2);
  assert.notEqual(items[0].id, items[1].id, 'Duplicate ids should be re-keyed to unique values');
});

// ---------------------------------------------------------------------------
// 9. Defensive normalization: missing item id is generated
// ---------------------------------------------------------------------------
test('normalizeBlock generates an id for items with no id', () => {
  const block = {
    id: 'x',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      items: [{ title: 'No Id', anchor: '', children: [] }],
    },
  };
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  const item = design.root.sections[0].children[0].content.items[0];
  assert.ok(typeof item.id === 'string' && item.id.length > 0, 'Generated id must be a non-empty string');
});

// ---------------------------------------------------------------------------
// 10. Defensive normalization: empty items list seeded with one item
// ---------------------------------------------------------------------------
test('normalizeBlock seeds one item when items array is empty', () => {
  const block = {
    id: 'x',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: { items: [], mode: 'single', initialId: '' },
  };
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  const items = design.root.sections[0].children[0].content.items;
  assert.equal(items.length, 1);
});

// ---------------------------------------------------------------------------
// 11. Recursive normalization of nested child blocks
// ---------------------------------------------------------------------------
test('nested child blocks are normalized via normalizeBlock', () => {
  const block = {
    id: 'x',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      items: [{
        id: 'i1',
        title: 'P',
        anchor: '',
        children: [{
          // Missing id — should be generated by normalizeBlock
          type: 'text',
          name: 'Text',
          content: { html: '<p>hello</p>' },
        }],
      }],
    },
  };
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  const child = design.root.sections[0].children[0].content.items[0].children[0];
  assert.equal(child.type, 'text');
  assert.ok(typeof child.id === 'string' && child.id.length > 0, 'Child id must be generated');
  // normalizeBlock merges defaults so style should be present
  assert.ok(child.style, 'Child should have style after normalization');
});

// ---------------------------------------------------------------------------
// 12. Advanced accordion recursion is blocked
// ---------------------------------------------------------------------------
test('nested advanced-accordion within an item is silently dropped', () => {
  const block = {
    id: 'x',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      items: [{
        id: 'i1',
        title: 'Outer',
        anchor: '',
        children: [{
          // An advanced-accordion nested inside — must be dropped.
          id: 'nested',
          type: BLOCK_TYPES.ADVANCED_ACCORDION,
          name: 'Inner',
          content: { items: [], mode: 'single', initialId: '' },
        }],
      }],
    },
  };
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  const children = design.root.sections[0].children[0].content.items[0].children;
  assert.equal(children.length, 0, 'Nested advanced-accordion must be silently dropped');
});

// ---------------------------------------------------------------------------
// 13. Anchor sanitization on items
// ---------------------------------------------------------------------------
test('item anchors are sanitized during normalization', () => {
  const block = {
    id: 'x',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      items: [{
        id: 'i1',
        title: 'P',
        anchor: '  MY Anchor!! ',
        children: [],
      }],
    },
  };
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  const anchor = design.root.sections[0].children[0].content.items[0].anchor;
  assert.match(anchor, /^[a-z0-9-]+$/, 'Anchor must be lowercase slug with hyphens only');
  assert.equal(anchor, 'my-anchor', 'Sanitized anchor must match expected slug');
});

// ---------------------------------------------------------------------------
// 14. getPageAnchors includes advanced accordion item anchors
// ---------------------------------------------------------------------------
test('getPageAnchors includes item-level anchors from advanced accordion', () => {
  const design = normalizeCanvasDesign({
    version: 1,
    root: {
      sections: [{
        id: 'root-section',
        children: [{
          id: 'adv-1',
          type: BLOCK_TYPES.ADVANCED_ACCORDION,
          name: 'Acc',
          anchorId: '',
          content: {
            mode: 'single',
            initialId: '',
            items: [
              { id: 'i1', title: 'Panel 1', anchor: 'panel-one', children: [] },
              { id: 'i2', title: 'Panel 2', anchor: 'panel-two', children: [] },
            ],
          },
        }],
      }],
    },
  });
  const anchors = getPageAnchors(design);
  const anchorIds = anchors.map((a) => a.anchorId);
  assert.ok(anchorIds.includes('panel-one'), 'panel-one anchor must be included');
  assert.ok(anchorIds.includes('panel-two'), 'panel-two anchor must be included');
});

// ---------------------------------------------------------------------------
// 15. getPageAnchors includes nested child block anchors
// ---------------------------------------------------------------------------
test('getPageAnchors includes nested child block anchors inside advanced accordion items', () => {
  const design = normalizeCanvasDesign({
    version: 1,
    root: {
      sections: [{
        id: 'root-section',
        children: [{
          id: 'adv-1',
          type: BLOCK_TYPES.ADVANCED_ACCORDION,
          name: 'Acc',
          anchorId: '',
          content: {
            mode: 'single',
            initialId: '',
            items: [{
              id: 'i1',
              title: 'Panel 1',
              anchor: '',
              children: [{
                id: 'child-1',
                type: 'text',
                name: 'Text',
                anchorId: 'child-anchor',
                content: { html: '<p>hi</p>' },
              }],
            }],
          },
        }],
      }],
    },
  });
  const anchors = getPageAnchors(design);
  const anchorIds = anchors.map((a) => a.anchorId);
  assert.ok(anchorIds.includes('child-anchor'), 'child-anchor must be included in page anchors');
});

// ---------------------------------------------------------------------------
// 16. findDuplicateAnchorIds detects advanced accordion anchor duplicates
// ---------------------------------------------------------------------------
test('findDuplicateAnchorIds detects duplicate anchors in advanced accordion items', () => {
  const design = {
    version: 1,
    root: {
      sections: [{
        id: 'root-section',
        children: [{
          id: 'adv-1',
          type: BLOCK_TYPES.ADVANCED_ACCORDION,
          name: 'Acc',
          anchorId: 'dup',
          content: {
            mode: 'single',
            initialId: '',
            items: [
              // This item anchor collides with the block-level anchor 'dup'
              { id: 'i1', title: 'P', anchor: 'dup', children: [] },
            ],
          },
        }],
      }],
    },
  };
  const dups = findDuplicateAnchorIds(design);
  assert.ok(dups.has('dup'), 'Duplicate anchor between block and item must be flagged');
});

// ---------------------------------------------------------------------------
// 17. validateBlock — valid block has no errors
// ---------------------------------------------------------------------------
test('validateBlock returns no errors for a well-formed advanced accordion', () => {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  const errors = validateBlock(block);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// 18. validateBlock — empty items
// ---------------------------------------------------------------------------
test('validateBlock reports an error when items are empty', () => {
  const block = { type: BLOCK_TYPES.ADVANCED_ACCORDION, content: { items: [], mode: 'single', initialId: '' } };
  const errors = validateBlock(block);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.includes('no items')));
});

// ---------------------------------------------------------------------------
// 19. validateBlock — missing title
// ---------------------------------------------------------------------------
test('validateBlock reports error for an item without a title', () => {
  const block = {
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      mode: 'single',
      initialId: '',
      items: [{ id: 'i1', title: '', anchor: '', children: [] }],
    },
  };
  const errors = validateBlock(block);
  assert.ok(errors.some((e) => e.toLowerCase().includes('title')));
});

// ---------------------------------------------------------------------------
// 20. validateBlock — duplicate item ids
// ---------------------------------------------------------------------------
test('validateBlock reports error for duplicate item ids', () => {
  const block = {
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      mode: 'single',
      initialId: '',
      items: [
        { id: 'same', title: 'A', anchor: '', children: [] },
        { id: 'same', title: 'B', anchor: '', children: [] },
      ],
    },
  };
  const errors = validateBlock(block);
  assert.ok(errors.some((e) => e.toLowerCase().includes('duplicate')));
});

// ---------------------------------------------------------------------------
// 21. validateBlock — duplicate item-level anchors
// ---------------------------------------------------------------------------
test('validateBlock reports error for duplicate anchors within the same advanced accordion', () => {
  const block = {
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      mode: 'single',
      initialId: '',
      items: [
        { id: 'i1', title: 'A', anchor: 'shared', children: [] },
        { id: 'i2', title: 'B', anchor: 'shared', children: [] },
      ],
    },
  };
  const errors = validateBlock(block);
  assert.ok(errors.some((e) => e.toLowerCase().includes('anchor')));
});

// ---------------------------------------------------------------------------
// 22. validateBlock — stale initialId
// ---------------------------------------------------------------------------
test('validateBlock reports error when initialId does not match any item', () => {
  const block = {
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      mode: 'single',
      initialId: 'ghost-id',
      items: [{ id: 'i1', title: 'A', anchor: '', children: [] }],
    },
  };
  const errors = validateBlock(block);
  assert.ok(errors.some((e) => e.toLowerCase().includes('initialid') || e.toLowerCase().includes('initial')));
});

// ---------------------------------------------------------------------------
// 23. CRUD helper: addAdvancedAccordionItem
// ---------------------------------------------------------------------------
test('addAdvancedAccordionItem appends a new item with a unique id', () => {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  const c = addAdvancedAccordionItem(block.content, { title: 'New Panel', anchor: 'new-panel' });
  assert.equal(c.items.length, 3);
  const last = c.items[2];
  assert.equal(last.title, 'New Panel');
  assert.equal(last.anchor, 'new-panel');
  assert.ok(last.id && typeof last.id === 'string');
  // All ids must be unique
  const ids = c.items.map((it) => it.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// 24. CRUD helper: removeAdvancedAccordionItem
// ---------------------------------------------------------------------------
test('removeAdvancedAccordionItem removes the correct item', () => {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  const firstId = block.content.items[0].id;
  const c = removeAdvancedAccordionItem(block.content, firstId);
  assert.equal(c.items.length, 1);
  assert.ok(c.items.every((it) => it.id !== firstId));
});

test('removeAdvancedAccordionItem clears initialId when it matches the removed item', () => {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  const firstId = block.content.items[0].id;
  const contentWithInit = { ...block.content, initialId: firstId };
  const c = removeAdvancedAccordionItem(contentWithInit, firstId);
  assert.equal(c.initialId, '');
});

// ---------------------------------------------------------------------------
// 25. CRUD helper: updateAdvancedAccordionItem
// ---------------------------------------------------------------------------
test('updateAdvancedAccordionItem updates title and anchor', () => {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  const id = block.content.items[0].id;
  const c = updateAdvancedAccordionItem(block.content, id, { title: 'Renamed', anchor: 'renamed' });
  const updated = c.items.find((it) => it.id === id);
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.anchor, 'renamed');
});

// ---------------------------------------------------------------------------
// 26. CRUD helper: reorderAdvancedAccordionItems
// ---------------------------------------------------------------------------
test('reorderAdvancedAccordionItems reorders items correctly', () => {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  const [id1, id2] = block.content.items.map((it) => it.id);
  const c = reorderAdvancedAccordionItems(block.content, [id2, id1]);
  assert.equal(c.items[0].id, id2);
  assert.equal(c.items[1].id, id1);
});

// ---------------------------------------------------------------------------
// 27. Legacy ACCORDION validateBlock behaviour is unchanged
// ---------------------------------------------------------------------------
test('legacy ACCORDION validateBlock is unchanged (no spurious errors on valid content)', () => {
  const block = createBlock(BLOCK_TYPES.ACCORDION);
  const errors = validateBlock(block);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// 28. Idempotency: normalizing an already-normalized design is a no-op
// ---------------------------------------------------------------------------
test('normalizeCanvasDesign is idempotent for advanced accordion', () => {
  const block = createBlock(BLOCK_TYPES.ADVANCED_ACCORDION);
  const design = normalizeCanvasDesign({
    version: 1,
    root: { sections: [{ id: 'root-section', children: [block] }] },
  });
  const design2 = normalizeCanvasDesign(JSON.parse(JSON.stringify(design)));
  const c1 = design.root.sections[0].children[0].content;
  const c2 = design2.root.sections[0].children[0].content;
  assert.deepEqual(c1, c2);
});

// ---------------------------------------------------------------------------
// 29. getPageAnchors visits nested grandchildren anchors at arbitrary depth
// ---------------------------------------------------------------------------
test('getPageAnchors visits nested grandchildren anchors inside accordion items', () => {
  // Raw (un-normalized) design so we exercise getPageAnchors' arbitrary-depth
  // traversal directly: an accordion item child (box) with its own children[].
  const design = {
    version: 1,
    root: {
      sections: [{
        id: 'root-section',
        children: [{
          id: 'adv-1',
          type: BLOCK_TYPES.ADVANCED_ACCORDION,
          name: 'Acc',
          anchorId: '',
          content: {
            mode: 'single',
            initialId: '',
            items: [{
              id: 'i1',
              title: 'Panel 1',
              anchor: 'panel-one',
              children: [{
                // A container child with a grandchild that carries an anchor.
                id: 'child-box',
                type: BLOCK_TYPES.BOX,
                name: 'Box',
                anchorId: 'child-box-anchor',
                children: [{
                  id: 'grandchild-1',
                  type: 'text',
                  name: 'Deep text',
                  anchorId: 'grandchild-anchor',
                  content: { html: '<p>deep</p>' },
                }],
              }],
            }],
          },
        }],
      }],
    },
  };
  const anchorIds = getPageAnchors(design).map((a) => a.anchorId);
  assert.ok(anchorIds.includes('panel-one'), 'top item anchor included');
  assert.ok(anchorIds.includes('child-box-anchor'), 'item child anchor included');
  assert.ok(anchorIds.includes('grandchild-anchor'), 'grandchild block anchor included at depth');
});

// ---------------------------------------------------------------------------
// 30. getPageAnchors flags duplicates found deep in the tree
// ---------------------------------------------------------------------------
test('getPageAnchors flags duplicate anchors across nested descendants', () => {
  const design = normalizeCanvasDesign({
    version: 1,
    root: {
      sections: [{
        id: 'root-section',
        children: [{
          id: 'adv-1',
          type: BLOCK_TYPES.ADVANCED_ACCORDION,
          name: 'Acc',
          anchorId: 'shared',
          content: {
            mode: 'single',
            initialId: '',
            items: [{
              id: 'i1',
              title: 'Panel 1',
              anchor: '',
              children: [{
                id: 'child-1',
                type: 'text',
                name: 'Text',
                anchorId: 'shared',
                content: { html: '<p>hi</p>' },
              }],
            }],
          },
        }],
      }],
    },
  });
  const anchors = getPageAnchors(design);
  const shared = anchors.filter((a) => a.anchorId === 'shared');
  assert.equal(shared.length, 2, 'both shared anchors are emitted');
  assert.ok(shared.some((a) => a.duplicate), 'the second occurrence is flagged as duplicate');
  assert.ok(findDuplicateAnchorIds(design).has('shared'), 'duplicate detected across depth');
});

// ---------------------------------------------------------------------------
// 31. cloneCanvasBlockWithFreshIds freshens every descendant block id
// ---------------------------------------------------------------------------
test('cloneCanvasBlockWithFreshIds assigns fresh ids recursively', () => {
  const block = {
    id: 'adv-root',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    name: 'Acc',
    content: {
      mode: 'single',
      initialId: '',
      items: [{
        id: 'item-a',
        title: 'A',
        children: [{
          id: 'child-a',
          type: BLOCK_TYPES.ADVANCED_ACCORDION,
          name: 'Nested',
          content: {
            mode: 'single',
            initialId: '',
            items: [{
              id: 'nested-item',
              title: 'N',
              children: [{ id: 'deep-text', type: 'text', content: { html: '<p>x</p>' } }],
            }],
          },
        }],
      }],
    },
  };
  const clone = cloneCanvasBlockWithFreshIds(block);

  const collectIds = (b, ids = []) => {
    if (!b || typeof b !== 'object') return ids;
    if (b.id) ids.push(b.id);
    const items = Array.isArray(b.content?.items) ? b.content.items : [];
    for (const it of items) {
      if (it?.id) ids.push(it.id);
      for (const c of (Array.isArray(it.children) ? it.children : [])) collectIds(c, ids);
    }
    for (const c of (Array.isArray(b.children) ? b.children : [])) collectIds(c, ids);
    return ids;
  };

  const origIds = collectIds(block);
  const newIds = collectIds(clone);
  // Same count of ids, but none shared with the original.
  assert.equal(newIds.length, origIds.length);
  const origSet = new Set(origIds);
  for (const id of newIds) {
    assert.ok(!origSet.has(id), `id ${id} must be fresh`);
  }
  // All new ids are unique among themselves.
  assert.equal(new Set(newIds).size, newIds.length, 'all fresh ids are unique');
  // Original block is untouched (deep clone, not mutation).
  assert.equal(block.id, 'adv-root');
  assert.equal(block.content.items[0].id, 'item-a');
});

test('cloning also freshens item and descendant anchors', () => {
  const block = {
    id: 'adv-root',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    anchorId: 'accordion-block',
    content: {
      items: [{
        id: 'item-a',
        title: 'A',
        anchor: 'panel-a',
        children: [{
          id: 'child-a',
          type: BLOCK_TYPES.TEXT,
          anchorId: 'panel-child',
          content: { html: '<p>A</p>' },
        }],
      }],
    },
  };
  const clone = cloneCanvasBlockWithFreshIds(block);
  assert.notEqual(clone.anchorId, block.anchorId);
  assert.notEqual(clone.content.items[0].anchor, block.content.items[0].anchor);
  assert.notEqual(clone.content.items[0].children[0].anchorId, 'panel-child');
});

test('validateBlock reports invalid nested panel content', () => {
  const block = {
    id: 'adv-root',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      items: [{
        id: 'item-a',
        title: 'A',
        anchor: 'panel-a',
        children: [{
          id: 'button-a',
          type: BLOCK_TYPES.BUTTON,
          name: 'Missing button content',
          content: { label: '', href: '' },
        }],
      }],
    },
  };
  const errors = validateBlock(block);
  assert.ok(errors.some((message) => message.includes('Button requires a label')));
  assert.ok(errors.some((message) => message.includes('Button requires a link target')));
});

test('normalization deterministically allocates unique item anchors across accordions', () => {
  const makeAccordion = (id) => ({
    id,
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    name: id,
    content: {
      items: [{
        id: `${id}-item`,
        title: 'Panel',
        anchor: 'shared-panel',
        children: [],
      }],
    },
  });
  const design = normalizeCanvasDesign({
    version: 1,
    root: {
      sections: [{
        id: 'root-section',
        children: [makeAccordion('first'), makeAccordion('second')],
      }],
    },
  });
  const anchors = design.root.sections[0].children
    .flatMap((block) => block.content.items.map((item) => item.anchor));
  assert.equal(new Set(anchors).size, 2);
  assert.equal(anchors[0], 'shared-panel');
  assert.match(anchors[1], /^shared-panel-/);
  assert.equal(validateCanvasDesign(design).length, 0);
});

test('updateAdvancedAccordionItem avoids local and page-reserved anchor collisions', () => {
  const content = {
    items: [
      { id: 'item-a', title: 'A', anchor: 'panel-a', children: [] },
      { id: 'item-b', title: 'B', anchor: 'panel-b', children: [] },
    ],
  };
  const local = updateAdvancedAccordionItem(content, 'item-b', { anchor: 'panel-a' });
  assert.notEqual(local.items[1].anchor, 'panel-a');
  const page = updateAdvancedAccordionItem(
    content,
    'item-b',
    { anchor: 'page-block' },
    { reservedAnchors: ['page-block'] },
  );
  assert.notEqual(page.items[1].anchor, 'page-block');
});

// ---------------------------------------------------------------------------
// 32. cloneCanvasBlockWithFreshIds remaps initialId / initialOpenIds
// ---------------------------------------------------------------------------
test('cloneCanvasBlockWithFreshIds remaps initial open references to new item ids', () => {
  const block = {
    id: 'adv-root',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    content: {
      mode: 'multiple',
      initialState: 'multiple',
      initialId: 'item-a',
      initialOpenIds: ['item-a', 'item-b'],
      items: [
        { id: 'item-a', title: 'A', children: [] },
        { id: 'item-b', title: 'B', children: [] },
      ],
    },
  };
  const clone = cloneCanvasBlockWithFreshIds(block);
  const [na, nb] = clone.content.items.map((it) => it.id);

  assert.notEqual(na, 'item-a');
  assert.notEqual(nb, 'item-b');
  assert.equal(clone.content.initialId, na, 'initialId remapped to new first item id');
  assert.deepEqual(clone.content.initialOpenIds, [na, nb], 'initialOpenIds remapped in order');
});

// ---------------------------------------------------------------------------
// 33. cloneCanvasBlockWithFreshIds honours top-level overrides
// ---------------------------------------------------------------------------
test('cloneCanvasBlockWithFreshIds applies top-level overrides without losing fresh ids', () => {
  const block = {
    id: 'adv-root',
    type: BLOCK_TYPES.ADVANCED_ACCORDION,
    name: 'Original',
    content: { mode: 'single', initialId: '', items: [{ id: 'i1', title: 'A', children: [] }] },
  };
  const clone = cloneCanvasBlockWithFreshIds(block, { name: 'Copy' });
  assert.equal(clone.name, 'Copy');
  assert.notEqual(clone.id, 'adv-root');
  assert.notEqual(clone.content.items[0].id, 'i1');
});

// ---------------------------------------------------------------------------
// 34. cloneCanvasBlockWithFreshIds freshens plain children[] containers
// ---------------------------------------------------------------------------
test('cloneCanvasBlockWithFreshIds freshens ids in flow children[] trees', () => {
  const block = {
    id: 'box-root',
    type: BLOCK_TYPES.BOX,
    children: [
      { id: 'c1', type: 'text', content: {} },
      { id: 'c2', type: BLOCK_TYPES.BOX, children: [{ id: 'gc', type: 'text', content: {} }] },
    ],
  };
  const clone = cloneCanvasBlockWithFreshIds(block);
  assert.notEqual(clone.id, 'box-root');
  assert.notEqual(clone.children[0].id, 'c1');
  assert.notEqual(clone.children[1].id, 'c2');
  assert.notEqual(clone.children[1].children[0].id, 'gc');
});
