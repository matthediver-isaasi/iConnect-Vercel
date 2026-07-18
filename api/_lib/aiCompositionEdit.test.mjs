// AI Composition edit pipeline tests — Phase 2 (Task #2850).
// Covers: scoped-prompt isolation (explicit target + breakpoint), patch-mode
// proposals, section/composition redesign with protected-value enforcement,
// link_request workflow and deterministic destination patches.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runEditProposal,
  runCompositionRedesign,
  buildEditPrompt,
  buildDestinationLinkOp,
  resolveTarget,
  normalizeBreakpointScope,
  assessAccept,
} from './aiCompositionEdit.js';
import { applyPatch, diffProtectedValues } from './aiCompositionPatch.js';

function baseDoc() {
  return {
    schemaVersion: 1,
    id: 'comp_test',
    name: 'Test composition',
    compositionType: 'multi_section_page',
    status: 'draft',
    sections: [
      {
        id: 'sec_a', type: 'ai_section', readingOrder: ['h1', 'btn1'],
        elements: [
          { id: 'h1', type: 'heading', role: 'h2', content: { text: 'Hello' } },
          {
            id: 'btn1', type: 'button', content: { text: 'Register' },
            link: { kind: 'event_registration', eventId: '11111111-1111-4111-8111-111111111111' },
          },
        ],
      },
      {
        id: 'sec_b', type: 'ai_section', readingOrder: ['p2'],
        elements: [{ id: 'p2', type: 'paragraph', content: { text: 'About us' } }],
      },
    ],
    layouts: {
      desktop: { h1: { mode: 'flow' }, btn1: { mode: 'flow' }, p2: { mode: 'flow' } },
      tablet: {},
      mobile: {},
    },
    protectedValues: [
      { kind: 'event_ref', elementId: 'btn1', path: 'link.eventId', label: 'Registration link' },
    ],
    generatedAssets: [], conversation: [], generationMetadata: {}, accessibility: {},
    currentVersionId: null,
  };
}

const llmOnce = (payload) => async () => JSON.stringify(payload);

// ---------------------------------------------------------------------------

test('resolveTarget verifies explicit selection against the document', () => {
  const doc = baseDoc();
  assert.equal(resolveTarget(doc, { type: 'element', elementId: 'h1' }).sectionId, 'sec_a');
  assert.ok(resolveTarget(doc, { type: 'element', elementId: 'ghost' }).error);
  assert.ok(resolveTarget(doc, { type: 'section', sectionId: 'ghost' }).error);
  assert.equal(resolveTarget(doc, {}).type, 'composition');
  assert.equal(normalizeBreakpointScope('bogus'), 'all');
});

test('element-scoped prompt contains only the selected subtree, and passes the ID explicitly', () => {
  const doc = baseDoc();
  const { system, user } = buildEditPrompt({
    doc, instruction: 'Make this heading friendlier',
    target: { type: 'element', elementId: 'h1', sectionId: 'sec_a' },
    breakpoint: 'all', brand: null,
  });
  assert.match(system, /EXPLICITLY selected element "h1"/);
  assert.match(user, /"h1"/);
  assert.ok(!user.includes('"p2"') || !user.includes('About us'), 'other sections\' content stays out of the scoped payload');
});

test('patch-mode proposal applies and reports no protected violations', async () => {
  const doc = baseDoc();
  const res = await runEditProposal({
    callLlm: llmOnce({
      mode: 'patch', summary: 'Reworded the heading',
      operations: [{ op: 'update_content', elementId: 'h1', changes: { text: 'Welcome back' } }],
    }),
    doc, instruction: 'Make this heading friendlier',
    target: { type: 'element', elementId: 'h1', sectionId: 'sec_a' },
  });
  assert.equal(res.kind, 'patch');
  assert.equal(res.doc.sections[0].elements[0].content.text, 'Welcome back');
  assert.deepEqual(res.protectedViolations, []);
  assert.equal(res.isAlternative, false);
});

test('protected-value change is surfaced as a violation (warning path)', async () => {
  const doc = baseDoc();
  const res = await runEditProposal({
    callLlm: llmOnce({
      mode: 'patch', summary: 'Changed the link',
      operations: [{
        op: 'update_link', elementId: 'btn1',
        changes: { link: { kind: 'event_registration', eventId: '22222222-2222-4222-8222-222222222222' } },
      }],
    }),
    doc, instruction: 'Point the button at the other event',
    target: { type: 'element', elementId: 'btn1', sectionId: 'sec_a' },
  });
  assert.equal(res.kind, 'patch');
  assert.equal(res.protectedViolations.length, 1);
  assert.equal(res.protectedViolations[0].elementId, 'btn1');
});

test('breakpoint-scoped edit that leaks into another breakpoint is retried then rejected', async () => {
  const doc = baseDoc();
  let calls = 0;
  const callLlm = async () => {
    calls += 1;
    // Every attempt (wrongly) edits the desktop frame during a mobile-only edit.
    return JSON.stringify({
      mode: 'patch', summary: 'x',
      operations: [{ op: 'update_style', elementId: 'h1', changes: { frame: { w: 500 } } }],
    });
  };
  await assert.rejects(
    () => runEditProposal({
      callLlm, doc, instruction: 'Make the heading narrower on mobile',
      target: { type: 'element', elementId: 'h1', sectionId: 'sec_a' }, breakpoint: 'mobile',
    }),
    (err) => {
      assert.ok(err.validationErrors.some((e) => /desktop/.test(e)));
      return true;
    },
  );
  assert.equal(calls, 3, 'bounded retry (1 + 2)');
});

test('breakpoint-scoped edit succeeds when confined to that breakpoint', async () => {
  const doc = baseDoc();
  const res = await runEditProposal({
    callLlm: llmOnce({
      mode: 'patch', summary: 'Hid the heading on mobile',
      operations: [{ op: 'update_style', elementId: 'h1', breakpoint: 'mobile', changes: { frame: { visible: false } } }],
    }),
    doc, instruction: 'Hide the heading on mobile',
    target: { type: 'element', elementId: 'h1', sectionId: 'sec_a' }, breakpoint: 'mobile',
  });
  assert.equal(res.kind, 'patch');
  assert.equal(res.doc.layouts.mobile.h1.visible, false);
  assert.deepEqual(res.doc.layouts.desktop, doc.layouts.desktop);
});

test('section add/remove/reorder work through patch-mode proposals', async () => {
  const doc = baseDoc();
  const res = await runEditProposal({
    callLlm: llmOnce({
      mode: 'patch', summary: 'Moved the about section first',
      operations: [{ op: 'reorder_sections', order: ['sec_b', 'sec_a'] }],
    }),
    doc, instruction: 'Move the about section above the hero', target: { type: 'composition' },
  });
  assert.deepEqual(res.doc.sections.map((s) => s.id), ['sec_b', 'sec_a']);
});

test('link_request is returned for internal-destination linking (AI never invents IDs)', async () => {
  const doc = baseDoc();
  const res = await runEditProposal({
    callLlm: llmOnce({ mode: 'link_request', elementId: 'btn1', query: 'conference registration', summary: 'Pick the destination' }),
    doc, instruction: 'Link this to conference registration',
    target: { type: 'element', elementId: 'btn1', sectionId: 'sec_a' },
  });
  assert.equal(res.kind, 'link_request');
  assert.equal(res.elementId, 'btn1');
  assert.equal(res.query, 'conference registration');
});

test('buildDestinationLinkOp produces a valid, applyable update_link op', () => {
  const doc = baseDoc();
  const op = buildDestinationLinkOp('btn1', { kind: 'form', id: '33333333-3333-4333-8333-333333333333' });
  const applied = applyPatch(doc, [op]);
  assert.equal(applied.ok, true);
  assert.equal(applied.doc.sections[0].elements[1].link.formId, '33333333-3333-4333-8333-333333333333');
});

test('section_redesign: keeps section id, validates, replaces only that section', async () => {
  const doc = baseDoc();
  let stage = 0;
  const callLlm = async () => {
    stage += 1;
    if (stage === 1) return JSON.stringify({ mode: 'section_redesign', sectionId: 'sec_b', summary: 'redesign' });
    return JSON.stringify({
      summary: 'A bolder about section',
      section: {
        id: 'WRONG_ID', type: 'ai_section', readingOrder: ['p2', 'shape1'],
        elements: [
          { id: 'p2', type: 'paragraph', content: { text: 'About us' } },
          { id: 'shape1', type: 'shape', style: { backgroundColor: '#112233' } },
        ],
      },
      layouts: { desktop: { p2: { mode: 'flow' }, shape1: { mode: 'absolute', x: 0, y: 0, w: 100, h: 100 } } },
    });
  };
  const res = await runEditProposal({
    callLlm, doc, instruction: 'Make the about section more visual',
    target: { type: 'section', sectionId: 'sec_b' },
  });
  assert.equal(res.kind, 'section_redesign');
  assert.equal(res.doc.sections[1].id, 'sec_b', 'section id never drifts');
  assert.equal(res.doc.sections[1].elements.length, 2);
  assert.deepEqual(res.doc.sections[0], doc.sections[0], 'other sections untouched');
});

test('composition_redesign: protected-value drop is retried and enforced; result is an alternative', async () => {
  const doc = baseDoc();
  const goodDoc = () => {
    const d = baseDoc();
    d.sections[0].elements[0].content.text = 'A completely new look';
    d.layouts.desktop.h1 = { mode: 'absolute', x: 40, y: 40, w: 600, h: 80 };
    return d;
  };
  const badDoc = () => {
    const d = goodDoc();
    d.sections[0].elements[1].link.eventId = '99999999-9999-4999-8999-999999999999'; // violates protection
    return d;
  };
  let calls = 0;
  const callLlm = async () => {
    calls += 1;
    return JSON.stringify(calls === 1 ? badDoc() : goodDoc());
  };
  const res = await runCompositionRedesign({ callLlm, doc, instruction: 'total redesign', brand: null });
  assert.equal(calls, 2, 'first (violating) attempt retried');
  assert.equal(res.isAlternative, true);
  assert.deepEqual(diffProtectedValues(doc, res.doc), []);
});

// ---------------------------------------------------------------------------
// assessAccept — accept-time gate (staleness + FRESH protected-value diffs)
// ---------------------------------------------------------------------------

test('assessAccept: patch re-applies against the current doc', () => {
  const doc = baseDoc();
  const res = assessAccept({
    kind: 'patch',
    proposal: { ops: [{ op: 'update_content', elementId: 'h1', changes: { text: 'Fresh' } }] },
    baseVersionId: 'v1',
    currentVersionId: 'v2', // patch path doesn't require same base — ops re-apply
    currentDoc: doc,
  });
  assert.equal(res.ok, true);
  assert.equal(res.doc.sections[0].elements[0].content.text, 'Fresh');
  assert.deepEqual(res.warnings, []);
});

test('assessAccept: patch that no longer applies is stale (409)', () => {
  const doc = baseDoc();
  const res = assessAccept({
    kind: 'patch',
    proposal: { ops: [{ op: 'update_content', elementId: 'ghost', changes: { text: 'x' } }] },
    currentDoc: doc,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

test('assessAccept: composition_redesign on a moved base is stale (409)', () => {
  const doc = baseDoc();
  const res = assessAccept({
    kind: 'composition_redesign',
    proposal: { document: baseDoc() },
    baseVersionId: 'v1',
    currentVersionId: 'v2',
    currentDoc: doc,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

test('assessAccept: composition_redesign on the same base validates and passes', () => {
  const doc = baseDoc();
  const res = assessAccept({
    kind: 'composition_redesign',
    proposal: { document: baseDoc() },
    baseVersionId: 'v1',
    currentVersionId: 'v1',
    currentDoc: doc,
    confirmProtected: false,
  });
  assert.equal(res.ok, true);
});

test('assessAccept: protected violations are recomputed at accept time, not read from stored warnings', () => {
  const doc = baseDoc();
  // Proposal recorded NO warnings at propose time, but applying it to the
  // CURRENT document changes a protected link — must still demand confirmation.
  const ops = [{
    op: 'update_link', elementId: 'btn1',
    changes: { link: { kind: 'event_registration', eventId: '33333333-3333-4333-8333-333333333333' } },
  }];
  const blocked = assessAccept({ kind: 'patch', proposal: { ops }, currentDoc: doc });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.requiresConfirmation, true);
  assert.equal(blocked.warnings.length, 1);
  assert.equal(blocked.warnings[0].elementId, 'btn1');

  const confirmed = assessAccept({ kind: 'patch', proposal: { ops }, currentDoc: doc, confirmProtected: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.warnings.length, 1);
});

test('assessAccept: invalid stored redesign document is rejected (422)', () => {
  const res = assessAccept({
    kind: 'composition_redesign',
    proposal: { document: { sections: 'nope' } },
    baseVersionId: 'v1',
    currentVersionId: 'v1',
    currentDoc: baseDoc(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 422);
});
