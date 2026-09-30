// Tests for duplicate-safe cloning and duplicate-token repair in the email
// builder (types.js). Run with: node --test client/src/components/email-builder/dynamicTokenDedup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_TYPES,
  cloneBlockForDuplicate,
  normalizeDuplicateDynamicTokens,
  nextDynamicTokenIndex,
  extractDynamicSlots,
} from './types.js';

const dynText = (id, token, label) => ({
  id, type: BLOCK_TYPES.DYNAMIC_TEXT, token, label, styles: {},
});
const dynButton = (id, token) => ({
  id, type: BLOCK_TYPES.DYNAMIC_BUTTON, token, linkToken: `${token}_link`,
  label: `Slot ${token.split('_')[1]}`, content: 'Click', href: 'https://x.test', styles: {},
});

test('cloneBlockForDuplicate reassigns token/linkToken/label and all ids', () => {
  const section = {
    id: 's1', type: BLOCK_TYPES.SECTION, styles: {},
    children: [dynText('c1', 'dynamic_1', 'Slot 1'), dynButton('c2', 'dynamic_2')],
  };
  const blocks = [section];
  const clone = cloneBlockForDuplicate(section, blocks);

  assert.notEqual(clone.id, section.id);
  assert.notEqual(clone.children[0].id, 'c1');
  assert.notEqual(clone.children[1].id, 'c2');
  assert.equal(clone.children[0].token, 'dynamic_3');
  assert.equal(clone.children[0].label, 'Slot 3');
  assert.equal(clone.children[1].token, 'dynamic_4');
  assert.equal(clone.children[1].linkToken, 'dynamic_4_link');
  // original untouched
  assert.equal(section.children[0].token, 'dynamic_1');
});

test('cloneBlockForDuplicate counts tokens nested in columns', () => {
  const cols = {
    id: 'col1', type: BLOCK_TYPES.COLUMNS, styles: {},
    columns: [
      { id: 'a', width: '50%', blocks: [dynText('c1', 'dynamic_7', 'Slot 7')] },
      { id: 'b', width: '50%', blocks: [] },
    ],
  };
  const clone = cloneBlockForDuplicate(cols, [cols]);
  assert.equal(clone.columns[0].blocks[0].token, 'dynamic_8');
  assert.notEqual(clone.columns[0].id, 'a');
  assert.notEqual(clone.columns[0].blocks[0].id, 'c1');
});

test('cloneBlockForDuplicate keeps custom labels', () => {
  const b = dynText('c1', 'dynamic_1', 'Hero headline');
  const clone = cloneBlockForDuplicate(b, [b]);
  assert.equal(clone.token, 'dynamic_2');
  assert.equal(clone.label, 'Hero headline');
});

test('normalize returns original object when design is healthy', () => {
  const design = { blocks: [dynText('c1', 'dynamic_1', 'Slot 1'), dynText('c2', 'dynamic_2', 'Slot 2')] };
  const { design: out, changed, renames } = normalizeDuplicateDynamicTokens(design);
  assert.equal(changed, false);
  assert.equal(out, design);
  assert.deepEqual(renames, []);
});

test('normalize reassigns later duplicate tokens and preserves slot values', () => {
  const design = {
    blocks: [
      { id: 's1', type: BLOCK_TYPES.SECTION, styles: {}, children: [dynText('c1', 'dynamic_1', 'Slot 1')] },
      { id: 's2', type: BLOCK_TYPES.SECTION, styles: {}, children: [dynText('c1', 'dynamic_1', 'Slot 1')] },
    ],
    slotValues: { dynamic_1: 'Hello world' },
  };
  const { design: out, changed, renames } = normalizeDuplicateDynamicTokens(design);
  assert.equal(changed, true);
  assert.equal(out.blocks[0].children[0].token, 'dynamic_1');
  const renamed = out.blocks[1].children[0];
  assert.equal(renamed.token, 'dynamic_2');
  assert.equal(renamed.label, 'Slot 2');
  assert.notEqual(renamed.id, 'c1'); // duplicate id also regenerated
  assert.equal(out.slotValues.dynamic_2, 'Hello world'); // value copied
  assert.equal(out.slotValues.dynamic_1, 'Hello world'); // original kept
  assert.deepEqual(renames, [{
    oldToken: 'dynamic_1', newToken: 'dynamic_2',
    oldLinkToken: null, newLinkToken: null, occurrence: 1,
  }]);
});

test('normalize handles duplicated buttons incl. linkToken values', () => {
  const design = {
    blocks: [dynButton('b1', 'dynamic_3'), dynButton('b1', 'dynamic_3')],
    slotValues: { dynamic_3: 'Buy', dynamic_3_link: 'https://a.test' },
  };
  const { design: out, changed } = normalizeDuplicateDynamicTokens(design);
  assert.equal(changed, true);
  assert.equal(out.blocks[1].token, 'dynamic_4');
  assert.equal(out.blocks[1].linkToken, 'dynamic_4_link');
  assert.equal(out.slotValues.dynamic_4, 'Buy');
  assert.equal(out.slotValues.dynamic_4_link, 'https://a.test');
});

test('normalize assigns non-colliding tokens for triple duplicates across nesting', () => {
  const design = {
    blocks: [
      dynText('t1', 'dynamic_5', 'Slot 5'),
      { id: 's1', type: BLOCK_TYPES.SECTION, styles: {}, children: [dynText('t1', 'dynamic_5', 'Slot 5')] },
      {
        id: 'c1', type: BLOCK_TYPES.COLUMNS, styles: {},
        columns: [{ id: 'k1', blocks: [dynText('t1', 'dynamic_5', 'Slot 5')] }],
      },
    ],
  };
  const { design: out } = normalizeDuplicateDynamicTokens(design);
  const tokens = extractDynamicSlots(out).map((s) => s.token);
  assert.equal(new Set(tokens).size, 3);
  assert.deepEqual(tokens.sort(), ['dynamic_5', 'dynamic_6', 'dynamic_7']);
  // next token index counts across every nesting level
  assert.equal(nextDynamicTokenIndex(out.blocks), 8);
});
