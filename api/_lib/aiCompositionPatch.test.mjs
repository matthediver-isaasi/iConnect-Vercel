// AI Composition patch applier tests — Phase 2 (Task #2850).
// Covers: patch application, immutability, protected-value preservation,
// section insert/remove/reorder, breakpoint isolation, broken-link collection.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPatch,
  diffProtectedValues,
  checkBreakpointIsolation,
  collectLinkRefs,
  findElement,
} from './aiCompositionPatch.js';

function baseDoc() {
  return {
    schemaVersion: 1,
    id: 'comp_test',
    name: 'Test composition',
    compositionType: 'multi_section_page',
    status: 'draft',
    sections: [
      {
        id: 'sec_a',
        type: 'ai_section',
        readingOrder: ['h1', 'p1', 'btn1'],
        elements: [
          { id: 'h1', type: 'heading', role: 'h2', content: { text: 'Hello' } },
          { id: 'p1', type: 'paragraph', content: { text: 'Body copy' } },
          {
            id: 'btn1',
            type: 'button',
            content: { text: 'Register' },
            link: { kind: 'event_registration', eventId: '11111111-1111-4111-8111-111111111111' },
          },
        ],
      },
      {
        id: 'sec_b',
        type: 'ai_section',
        readingOrder: ['grp1'],
        elements: [
          {
            id: 'grp1',
            type: 'group',
            children: [
              { id: 'stat1', type: 'statistic', data: { value: '1200', label: 'Members' } },
            ],
          },
        ],
      },
    ],
    layouts: {
      desktop: {
        h1: { mode: 'flow' }, p1: { mode: 'flow' }, btn1: { mode: 'flow' },
        grp1: { mode: 'flex', flex: { direction: 'row', gap: 16 } },
        stat1: { mode: 'flow' },
      },
      tablet: { grp1: { flex: { direction: 'column', gap: 12 } } },
      mobile: { btn1: { w: 390 } },
    },
    protectedValues: [
      { kind: 'event_ref', elementId: 'btn1', path: 'link.eventId', label: 'Registration link' },
      { kind: 'statistic', elementId: 'stat1', path: 'data.value', label: 'Member count' },
    ],
    generatedAssets: [], conversation: [], generationMetadata: {}, accessibility: {},
    currentVersionId: null,
  };
}

// ---------------------------------------------------------------------------
test('update_content applies and never mutates the input', () => {
  const doc = baseDoc();
  const frozen = JSON.stringify(doc);
  const res = applyPatch(doc, [
    { op: 'update_content', elementId: 'h1', changes: { text: 'New heading' } },
  ]);
  assert.equal(res.ok, true);
  assert.equal(findElement(res.doc, 'h1').el.content.text, 'New heading');
  assert.equal(JSON.stringify(doc), frozen, 'input document must be untouched');
});

test('invalid op leaves everything untouched', () => {
  const doc = baseDoc();
  const res = applyPatch(doc, [
    { op: 'update_content', elementId: 'nope', changes: { text: 'x' } },
  ]);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /not found/);
});

test('patched doc failing schema validation is rejected wholesale', () => {
  const doc = baseDoc();
  // Inserting an element without a desktop frame fails validateComposition.
  const res = applyPatch(doc, [
    { op: 'insert_element', sectionId: 'sec_a', element: { id: 'x1', type: 'paragraph', content: { text: 'hi' } } },
  ]);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /layouts\.desktop/.test(e)));
});

test('insert_element with frame + position updates elements, readingOrder and layouts', () => {
  const doc = baseDoc();
  const res = applyPatch(doc, [
    {
      op: 'insert_element',
      sectionId: 'sec_a',
      position: 1,
      element: { id: 'x1', type: 'paragraph', content: { text: 'inserted' } },
      frame: { mode: 'flow' },
    },
  ]);
  assert.equal(res.ok, true);
  const sec = res.doc.sections[0];
  assert.deepEqual(sec.readingOrder, ['h1', 'x1', 'p1', 'btn1']);
  assert.ok(res.doc.layouts.desktop.x1);
});

test('remove_element cleans readingOrder, layouts (all breakpoints) and protected values', () => {
  const doc = baseDoc();
  const res = applyPatch(doc, [{ op: 'remove_element', elementId: 'btn1' }]);
  assert.equal(res.ok, true);
  const sec = res.doc.sections[0];
  assert.deepEqual(sec.readingOrder, ['h1', 'p1']);
  assert.equal(res.doc.layouts.desktop.btn1, undefined);
  assert.equal(res.doc.layouts.mobile.btn1, undefined);
  assert.ok(!res.doc.protectedValues.some((pv) => pv.elementId === 'btn1'));
});

test('update_link validates the link ref (no raw internal URLs)', () => {
  const doc = baseDoc();
  const bad = applyPatch(doc, [
    { op: 'update_link', elementId: 'btn1', changes: { link: { kind: 'page', pageId: 'https://evil.example/x' } } },
  ]);
  assert.equal(bad.ok, false);
  const good = applyPatch(doc, [
    { op: 'update_link', elementId: 'btn1', changes: { link: { kind: 'page', pageId: '22222222-2222-4222-8222-222222222222' } } },
  ]);
  assert.equal(good.ok, true);
});

test('update_style with breakpoint writes ONLY that breakpoint map', () => {
  const doc = baseDoc();
  const res = applyPatch(doc, [
    { op: 'update_style', elementId: 'h1', breakpoint: 'mobile', changes: { frame: { visible: false } } },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.doc.layouts.mobile.h1.visible, false);
  assert.equal(res.doc.layouts.desktop.h1.visible, undefined);
  assert.equal(res.doc.layouts.tablet.h1, undefined);
  assert.deepEqual(checkBreakpointIsolation(doc, res.doc, 'mobile'), []);
});

test('checkBreakpointIsolation flags cross-breakpoint leaks', () => {
  const doc = baseDoc();
  const leaked = JSON.parse(JSON.stringify(doc));
  leaked.layouts.desktop.h1 = { mode: 'flow', w: 500 };
  const violations = checkBreakpointIsolation(doc, leaked, 'mobile');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /layouts\.desktop/);
});

// ---- Section ops ----------------------------------------------------------

test('insert_section + reorder_sections + remove_section', () => {
  const doc = baseDoc();
  const inserted = applyPatch(doc, [
    {
      op: 'insert_section',
      position: 1,
      section: {
        id: 'sec_new', type: 'ai_section', readingOrder: ['nh1'],
        elements: [{ id: 'nh1', type: 'heading', content: { text: 'New section' } }],
      },
      layouts: { desktop: { nh1: { mode: 'flow' } } },
    },
  ]);
  assert.equal(inserted.ok, true);
  assert.deepEqual(inserted.doc.sections.map((s) => s.id), ['sec_a', 'sec_new', 'sec_b']);

  const reordered = applyPatch(inserted.doc, [
    { op: 'reorder_sections', order: ['sec_b', 'sec_new', 'sec_a'] },
  ]);
  assert.equal(reordered.ok, true);
  assert.deepEqual(reordered.doc.sections.map((s) => s.id), ['sec_b', 'sec_new', 'sec_a']);

  const removed = applyPatch(reordered.doc, [{ op: 'remove_section', sectionId: 'sec_new' }]);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.doc.sections.map((s) => s.id), ['sec_b', 'sec_a']);
  assert.equal(removed.doc.layouts.desktop.nh1, undefined);
});

test('remove_section refuses to delete the only section; reorder rejects bad lists', () => {
  const doc = baseDoc();
  doc.compositionType = 'section';
  doc.sections = [doc.sections[0]];
  delete doc.layouts.desktop.grp1;
  delete doc.layouts.desktop.stat1;
  delete doc.layouts.tablet.grp1;
  doc.protectedValues = doc.protectedValues.filter((pv) => pv.elementId !== 'stat1');
  const res = applyPatch(doc, [{ op: 'remove_section', sectionId: 'sec_a' }]);
  assert.equal(res.ok, false);

  const bad = applyPatch(baseDoc(), [{ op: 'reorder_sections', order: ['sec_a'] }]);
  assert.equal(bad.ok, false);
});

test('replace_section keeps surviving element frames and prunes dead ones', () => {
  const doc = baseDoc();
  const res = applyPatch(doc, [
    {
      op: 'replace_section',
      sectionId: 'sec_b',
      section: {
        id: 'sec_b', type: 'ai_section', readingOrder: ['stat1'],
        elements: [{ id: 'stat1', type: 'statistic', data: { value: '1200', label: 'Members' } }],
      },
    },
  ]);
  assert.equal(res.ok, true);
  assert.ok(res.doc.layouts.desktop.stat1, 'surviving element keeps its frame');
  assert.equal(res.doc.layouts.desktop.grp1, undefined, 'dead element frame pruned');
  assert.equal(res.doc.layouts.tablet.grp1, undefined);
});

// ---- Protected values -----------------------------------------------------

test('diffProtectedValues: unchanged protected values pass', () => {
  const doc = baseDoc();
  const res = applyPatch(doc, [
    { op: 'update_content', elementId: 'h1', changes: { text: 'Different heading' } },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(diffProtectedValues(doc, res.doc), []);
});

test('diffProtectedValues: changing a protected link is a violation', () => {
  const doc = baseDoc();
  const res = applyPatch(doc, [
    { op: 'update_link', elementId: 'btn1', changes: { link: { kind: 'event_registration', eventId: '33333333-3333-4333-8333-333333333333' } } },
  ]);
  assert.equal(res.ok, true);
  const violations = diffProtectedValues(doc, res.doc);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].elementId, 'btn1');
  assert.equal(violations[0].reason, 'value changed');
});

test('diffProtectedValues: removing a protected element is a violation', () => {
  const doc = baseDoc();
  const next = JSON.parse(JSON.stringify(doc));
  next.sections[1].elements[0].children = [];
  const violations = diffProtectedValues(doc, next);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'element removed');
});

test('protected statistic survives a section redesign that keeps the element', () => {
  const doc = baseDoc();
  const res = applyPatch(doc, [
    {
      op: 'replace_section',
      sectionId: 'sec_b',
      section: {
        id: 'sec_b', type: 'ai_section', readingOrder: ['stat1'],
        elements: [{ id: 'stat1', type: 'statistic', data: { value: '1200', label: 'Active members' }, style: { color: '#123456' } }],
      },
    },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(diffProtectedValues(doc, res.doc), [], 'presentation change, value preserved');
});

// ---- Link collection ------------------------------------------------------

test('collectLinkRefs collects internal record refs incl. nested, skips external', () => {
  const doc = baseDoc();
  doc.sections[1].elements[0].children.push({
    id: 'lnk1', type: 'text_link', content: { text: 'Docs' },
    link: { kind: 'document', fileId: '44444444-4444-4444-8444-444444444444' },
  });
  doc.sections[0].elements[0].link = { kind: 'external', url: 'https://example.com' };
  const refs = collectLinkRefs(doc);
  assert.deepEqual(
    refs.map((r) => [r.elementId, r.kind]).sort(),
    [['btn1', 'event_registration'], ['lnk1', 'document']].sort(),
  );
});
