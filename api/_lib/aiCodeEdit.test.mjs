// AI Design Studio V2 — Phase 4 prompt-led editing tests (Task #2908).
// Pure-library tests with an injected callLlm stub — no network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeV2Instruction,
  normalizeV2Breakpoint,
  resolveV2Target,
  extractElementContext,
  collectContentKeyTexts,
  diffV2ContentIntegrity,
  diffV2RemovedElements,
  checkV2AccessibilityCritical,
  newCriticalIssues,
  checkV2CssBreakpointIsolation,
  applyV2ElementPatch,
  parseV2EditResponse,
  runV2EditProposal,
  assessV2Accept,
} from './aiCodeEdit.js';

const COMP_ID = '9f8a7b6c-1234-4abc-9def-0123456789ab';
const SCOPE = `[data-ai-composition="${COMP_ID}"]`;

function makeDoc(overrides = {}) {
  const html = [
    '<section data-ai-id="hero" class="hero">',
    '<h2 data-ai-id="hero-title" class="title">Spring Networking Evening</h2>',
    '<p data-ai-id="hero-copy" class="copy">Join fellow members for an evening of conversation and connection at our flagship spring gathering.</p>',
    '<p data-ai-id="hero-price"><span data-content-key="ticket-price">£25.00</span> per ticket</p>',
    '<a data-ai-id="hero-cta" data-ai-action="book-now" class="cta" href="#">Book your place</a>',
    '</section>',
  ].join('');
  const css = [
    `${SCOPE} .hero { padding: 48px; background: #123456; }`,
    `${SCOPE} .title { font-size: 40px; color: #ffffff; }`,
    `${SCOPE} .cta { background: #ff6600; }`,
    `@media (max-width: 1024px) { ${SCOPE} .hero { padding: 32px; } }`,
    `@media (max-width: 390px) { ${SCOPE} .hero { padding: 16px; } }`,
  ].join('\n');
  return {
    schemaVersion: '2.0',
    compositionType: 'section',
    compositionId: COMP_ID,
    title: 'Hero',
    html,
    css,
    actions: [{ key: 'book-now', type: 'event_registration', label: 'Book your place', resolved: true, href: '/event/spring', recordId: 'evt-1', recordTitle: 'Spring Networking Evening', slug: 'spring' }],
    slots: [],
    contentManifest: [],
    protectedValues: [
      { key: 'ticket-price', kind: 'price', label: 'Ticket price', value: '£25.00' },
      { key: 'event-date', kind: 'date', label: 'Event date', value: '12 May 2026' },
    ],
    responsiveTargets: { desktop: 1280, tablet: 1024, mobile: 390 },
    sanitisation: { aiIds: ['hero', 'hero-title', 'hero-copy', 'hero-price', 'hero-cta'] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
test('normalizeV2Instruction trims, collapses whitespace, caps length', () => {
  assert.equal(normalizeV2Instruction('  make it   bolder \n please '), 'make it bolder please');
  assert.equal(normalizeV2Instruction(null), '');
  assert.equal(normalizeV2Instruction('x'.repeat(3000)).length, 2000);
});

test('normalizeV2Breakpoint falls back to all', () => {
  assert.equal(normalizeV2Breakpoint('TABLET'), 'tablet');
  assert.equal(normalizeV2Breakpoint('nope'), 'all');
  assert.equal(normalizeV2Breakpoint(undefined), 'all');
});

test('resolveV2Target: element must exist; composition fallback', () => {
  const doc = makeDoc();
  assert.deepEqual(resolveV2Target(doc, { type: 'element', elementId: 'hero-title' }),
    { type: 'element', elementId: 'hero-title' });
  assert.ok(resolveV2Target(doc, { type: 'element', elementId: 'ghost' }).error);
  assert.deepEqual(resolveV2Target(doc, {}), { type: 'composition' });
});

// ---------------------------------------------------------------------------
test('extractElementContext returns breadcrumb, outerHTML and relevant CSS only', () => {
  const ctx = extractElementContext(makeDoc(), 'hero-title');
  assert.equal(ctx.tag, 'h2');
  assert.deepEqual(ctx.breadcrumb, ['section[data-ai-id="hero"]']);
  assert.match(ctx.outerHtml, /Spring Networking Evening/);
  assert.match(ctx.relevantCss, /\.title/);
  assert.doesNotMatch(ctx.relevantCss, /\.cta/);
  assert.deepEqual(ctx.subtreeAiIds, ['hero-title']);
  assert.equal(extractElementContext(makeDoc(), 'nope'), null);
});

// ---------------------------------------------------------------------------
test('content integrity: locked content-key text must survive byte-identical', () => {
  const doc = makeDoc();
  const same = doc.html.replace('conversation and connection', 'great conversation');
  assert.deepEqual(diffV2ContentIntegrity(doc.html, same, doc.protectedValues), []);

  const changedPrice = doc.html.replace('£25.00', '£30.00');
  const v = diffV2ContentIntegrity(doc.html, changedPrice, doc.protectedValues);
  assert.ok(v.some((x) => x.type === 'content_key' && x.key === 'ticket-price'));
  assert.ok(v.some((x) => x.type === 'protected_value'));

  const removedKey = doc.html.replace(/<span data-content-key="ticket-price">£25\.00<\/span>/, '£25.00');
  const v2 = diffV2ContentIntegrity(doc.html, removedKey, doc.protectedValues);
  assert.ok(v2.some((x) => x.type === 'content_key' && x.after === null));
});

test('protected value not present before does not violate after', () => {
  const doc = makeDoc();
  // '12 May 2026' never appears in the html — its removal cannot be flagged.
  assert.deepEqual(diffV2ContentIntegrity(doc.html, doc.html, doc.protectedValues), []);
});

test('collectContentKeyTexts normalises whitespace', () => {
  const map = collectContentKeyTexts('<p data-content-key="k">  a   b </p>');
  assert.equal(map.get('k'), 'a b');
});

// ---------------------------------------------------------------------------
test('accessibility: criticals detected; only NEW ones block', () => {
  const bad = '<a data-ai-id="x" href="#"></a><h2 data-ai-id="y"></h2><img>';
  const issues = checkV2AccessibilityCritical(bad);
  assert.ok(issues.some((i) => i.check === 'interactive_no_name'));
  assert.ok(issues.some((i) => i.check === 'empty_heading'));
  assert.ok(issues.some((i) => i.check === 'img_no_alt'));

  // Pre-existing issue does not block an unrelated change.
  assert.deepEqual(newCriticalIssues(bad, bad), []);
  const doc = makeDoc();
  const broken = doc.html.replace('Book your place', '');
  const fresh = newCriticalIssues(doc.html, broken);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].check, 'interactive_no_name');
});

// ---------------------------------------------------------------------------
test('breakpoint isolation for CSS additions', () => {
  assert.deepEqual(checkV2CssBreakpointIsolation('.x{color:red}', 'all'), []);
  assert.ok(checkV2CssBreakpointIsolation('.x{color:red}', 'mobile').length);
  assert.deepEqual(checkV2CssBreakpointIsolation('@media (max-width: 390px){.x{color:red}}', 'mobile'), []);
  assert.ok(checkV2CssBreakpointIsolation('@media (max-width: 1024px){.x{color:red}}', 'mobile').length);
  assert.deepEqual(checkV2CssBreakpointIsolation('@media (max-width: 1024px){.x{color:red}}', 'tablet'), []);
  assert.deepEqual(checkV2CssBreakpointIsolation('.x{color:red}', 'desktop'), []);
  assert.ok(checkV2CssBreakpointIsolation('@media (max-width: 390px){.x{color:red}}', 'desktop').length);
});

// ---------------------------------------------------------------------------
test('applyV2ElementPatch: happy path splices html and appends scoped css', () => {
  const doc = makeDoc();
  const r = applyV2ElementPatch(doc, {
    elementId: 'hero-title',
    html: '<h2 data-ai-id="hero-title" class="title">A Bolder Spring Evening</h2>',
    cssAdd: '.title { letter-spacing: 1px; }',
  });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.match(r.doc.html, /A Bolder Spring Evening/);
  assert.match(r.doc.html, /£25\.00/); // rest untouched
  assert.match(r.doc.css, new RegExp(`${SCOPE.replace(/[[\]"\\]/g, '\\$&')} \\.title \\{ letter-spacing: 1px; \\}`));
  // Appended, never re-scoped: original css still first.
  assert.ok(r.doc.css.indexOf('font-size: 40px') < r.doc.css.indexOf('letter-spacing'));
  // Sanitisation report refreshed.
  assert.ok(r.doc.sanitisation.aiIds.includes('hero-title'));
  // Input untouched.
  assert.doesNotMatch(doc.html, /Bolder/);
});

test('applyV2ElementPatch: replacement must keep same data-ai-id root', () => {
  const r = applyV2ElementPatch(makeDoc(), {
    elementId: 'hero-title',
    html: '<h2 data-ai-id="other" class="title">X</h2>',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /same data-ai-id/);
});

test('applyV2ElementPatch: reject-don\'t-repair on unsafe markup', () => {
  const r = applyV2ElementPatch(makeDoc(), {
    elementId: 'hero-title',
    html: '<h2 data-ai-id="hero-title"><script>alert(1)</script>Hi</h2>',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /sanitiser/i);
});

test('applyV2ElementPatch: cannot invent new action or slot keys', () => {
  const r = applyV2ElementPatch(makeDoc(), {
    elementId: 'hero-cta',
    html: '<a data-ai-id="hero-cta" data-ai-action="join-today" href="#">Join today</a>',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /invented a new action "join-today"/);
});

test('applyV2ElementPatch: duplicate data-ai-id in fragment is rejected', () => {
  const r = applyV2ElementPatch(makeDoc(), {
    elementId: 'hero-title',
    html: '<h2 data-ai-id="hero-title">Hi<span data-ai-id="hero-copy">dup</span></h2>',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /[Dd]uplicate/);
});

test('applyV2ElementPatch: breakpoint-scoped edits are CSS-only and enveloped', () => {
  const doc = makeDoc();
  const htmlAttempt = applyV2ElementPatch(doc, {
    elementId: 'hero-title',
    html: '<h2 data-ai-id="hero-title">X</h2>',
  }, { breakpoint: 'mobile' });
  assert.equal(htmlAttempt.ok, false);
  assert.match(htmlAttempt.errors[0], /only change styling/);

  const wrongMedia = applyV2ElementPatch(doc, {
    elementId: 'hero-title',
    cssAdd: '.title { font-size: 20px; }',
  }, { breakpoint: 'mobile' });
  assert.equal(wrongMedia.ok, false);

  const good = applyV2ElementPatch(doc, {
    elementId: 'hero-title',
    cssAdd: '@media (max-width: 390px) { .title { font-size: 20px; } }',
  }, { breakpoint: 'mobile' });
  assert.ok(good.ok, JSON.stringify(good.errors));
  assert.equal(good.doc.html, doc.html);
});

test('applyV2ElementPatch: hard CSS policy violations reject the patch', () => {
  const r = applyV2ElementPatch(makeDoc(), {
    elementId: 'hero-title',
    cssAdd: '.x body { background: red; }',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /CSS rejected/);
});

test('applyV2ElementPatch: missing target element (stale doc)', () => {
  const r = applyV2ElementPatch(makeDoc(), {
    elementId: 'ghost',
    html: '<div data-ai-id="ghost">x</div>',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /no longer exists/);
});

// ---------------------------------------------------------------------------
test('parseV2EditResponse shapes', () => {
  assert.equal(parseV2EditResponse('not json').ok, false);
  assert.equal(parseV2EditResponse(JSON.stringify({ mode: 'weird' })).ok, false);
  assert.equal(parseV2EditResponse(JSON.stringify({ mode: 'patch', elementId: '' })).ok, false);
  assert.equal(parseV2EditResponse(JSON.stringify({ mode: 'patch', elementId: 'a' })).ok, false);
  const p = parseV2EditResponse('```json\n' + JSON.stringify({ mode: 'patch', summary: 's', elementId: 'a', html: '<div data-ai-id="a">x</div>', cssAdd: '' }) + '\n```');
  assert.ok(p.ok);
  assert.equal(p.patch.cssAdd, '');
  const r = parseV2EditResponse(JSON.stringify({ mode: 'revision', summary: 'redo' }));
  assert.ok(r.ok);
  assert.equal(r.mode, 'revision');
});

// ---------------------------------------------------------------------------
test('runV2EditProposal: patch proposal happy path', async () => {
  const doc = makeDoc();
  const calls = [];
  const callLlm = async ({ system, user }) => {
    calls.push({ system, user });
    return JSON.stringify({
      mode: 'patch',
      summary: 'Made the title punchier',
      elementId: 'hero-title',
      html: '<h2 data-ai-id="hero-title" class="title">An Unmissable Spring Evening</h2>',
      cssAdd: '',
    });
  };
  const res = await runV2EditProposal({
    callLlm, doc, instruction: 'make the title punchier',
    target: { type: 'element', elementId: 'hero-title' }, compositionId: COMP_ID,
  });
  assert.equal(res.kind, 'v2_patch');
  assert.equal(res.isAlternative, false);
  assert.match(res.doc.html, /Unmissable/);
  assert.deepEqual(res.warnings, []);
  // Element-scoped prompt contains the element, not the whole doc.
  assert.match(calls[0].user, /SELECTED ELEMENT/);
  assert.match(calls[0].system, /£25\.00/); // protected values in prompt
});

test('runV2EditProposal: retries with rejection feedback, then succeeds', async () => {
  const doc = makeDoc();
  let n = 0;
  const seen = [];
  const callLlm = async ({ user }) => {
    seen.push(user);
    n += 1;
    if (n === 1) {
      return JSON.stringify({ mode: 'patch', elementId: 'hero-title', html: '<h2 data-ai-id="wrong">X</h2>', cssAdd: '' });
    }
    return JSON.stringify({ mode: 'patch', elementId: 'hero-title', html: '<h2 data-ai-id="hero-title">Fixed</h2>', cssAdd: '' });
  };
  const res = await runV2EditProposal({
    callLlm, doc, instruction: 'tweak', target: { type: 'composition' }, compositionId: COMP_ID,
  });
  assert.equal(n, 2);
  assert.match(seen[1], /REJECTED FOR/);
  assert.match(res.doc.html, /Fixed/);
});

test('runV2EditProposal: element target rejects patch outside its subtree', async () => {
  const doc = makeDoc();
  const callLlm = async () => JSON.stringify({
    mode: 'patch', elementId: 'hero-copy',
    html: '<p data-ai-id="hero-copy">off-target</p>', cssAdd: '',
  });
  await assert.rejects(
    runV2EditProposal({
      callLlm, doc, instruction: 'x',
      target: { type: 'element', elementId: 'hero-title' },
      compositionId: COMP_ID, maxAttempts: 1,
    }),
    (err) => err.httpStatus === 422 && /target the selected element/.test(err.validationErrors[0]),
  );
});

test('runV2EditProposal: exhausted retries throw 422 with details', async () => {
  const callLlm = async () => 'garbage';
  await assert.rejects(
    runV2EditProposal({ callLlm, doc: makeDoc(), instruction: 'x', target: { type: 'composition' }, compositionId: COMP_ID }),
    (err) => err.httpStatus === 422 && err.validationErrors.length > 0,
  );
});

test('runV2EditProposal: missing element target throws 409', async () => {
  await assert.rejects(
    runV2EditProposal({
      callLlm: async () => '', doc: makeDoc(), instruction: 'x',
      target: { type: 'element', elementId: 'ghost' }, compositionId: COMP_ID,
    }),
    (err) => err.httpStatus === 409,
  );
});

// ---------------------------------------------------------------------------
// Revision path: model asks for a revision, then returns a full package that
// runs the real Phase 0 pipeline + rejection gates.
function makeRevisionPackage(doc) {
  return {
    schemaVersion: '2.0',
    compositionType: 'section',
    title: 'Hero (redesigned)',
    html: [
      '<section data-ai-id="hero" class="hero hero--split">',
      '<div class="col"><h2 data-ai-id="hero-title" class="title">Spring Networking Evening</h2>',
      '<p data-ai-id="hero-copy">Join fellow members for an evening of conversation and connection at our flagship spring gathering.</p></div>',
      '<div class="col"><p data-ai-id="hero-price"><span data-content-key="ticket-price">£25.00</span> per ticket</p>',
      '<a data-ai-id="hero-cta" data-ai-action="book-now" class="cta" href="#">Book your place</a></div>',
      '</section>',
    ].join(''),
    css: '.hero--split { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }\n.title { font-size: 44px; }\n@media (max-width: 1024px) { .hero--split { grid-template-columns: 1fr; } }\n@media (max-width: 390px) { .title { font-size: 28px; } }',
    actions: [{ key: 'book-now', type: 'event_registration', label: 'Book your place' }],
    slots: [],
    contentManifest: doc.contentManifest,
    protectedValues: doc.protectedValues,
    responsiveTargets: { desktop: 1280, tablet: 1024, mobile: 390 },
    generationSummary: 'Two-column redesign.',
  };
}

test('runV2EditProposal: revision runs pipeline, is alternative, keeps resolved actions', async () => {
  const doc = makeDoc();
  let call = 0;
  const callLlm = async () => {
    call += 1;
    if (call === 1) return JSON.stringify({ mode: 'revision', summary: 'Two-column redesign' });
    return JSON.stringify(makeRevisionPackage(doc));
  };
  const res = await runV2EditProposal({
    callLlm, doc, instruction: 'redesign as two columns', target: { type: 'composition' }, compositionId: COMP_ID,
  });
  assert.equal(res.kind, 'v2_revision');
  assert.equal(res.isAlternative, true);
  assert.match(res.doc.css, /data-ai-composition/); // pipeline scoped it
  assert.equal(res.doc.compositionId, COMP_ID);
  // Full resolution payload carried over from the stored manifest — accepted
  // revisions must keep navigable CTAs (resolved === true AND a real href).
  const carried = res.doc.actions.find((a) => a.key === 'book-now');
  assert.equal(carried.resolved, true);
  assert.equal(carried.href, '/event/spring');
  assert.equal(carried.recordId, 'evt-1');
  assert.equal(carried.slug, 'spring');
  assert.deepEqual(res.warnings, []);
  assert.equal(typeof res.rawCss, 'string');
});

test('runV2EditProposal: revision inventing a new action key is rejected', async () => {
  const doc = makeDoc();
  let call = 0;
  const callLlm = async () => {
    call += 1;
    if (call === 1) return JSON.stringify({ mode: 'revision', summary: 'x' });
    const pkg = makeRevisionPackage(doc);
    pkg.actions.push({ key: 'new-action', type: 'external_url', label: 'New' });
    pkg.html = pkg.html.replace('data-ai-action="book-now"', 'data-ai-action="new-action"');
    return JSON.stringify(pkg);
  };
  await assert.rejects(
    runV2EditProposal({ callLlm, doc, instruction: 'x', target: { type: 'composition' }, compositionId: COMP_ID, maxAttempts: 1 }),
    (err) => err.httpStatus === 422 && /invented a new action/.test(err.validationErrors.join(' ')),
  );
});

// ---------------------------------------------------------------------------
test('assessV2Accept: patch re-applied against CURRENT doc, not proposal-time doc', () => {
  const doc = makeDoc();
  const patch = { elementId: 'hero-title', html: '<h2 data-ai-id="hero-title" class="title">New Title Here</h2>', cssAdd: '' };
  // Current doc drifted but element still exists → still applies.
  const drifted = { ...doc, html: doc.html.replace('flagship', 'famous') };
  const r = assessV2Accept({
    kind: 'v2_patch', proposal: { patch }, baseVersionId: 'v1', currentVersionId: 'v2',
    currentDoc: drifted,
  });
  assert.ok(r.ok);
  assert.match(r.doc.html, /New Title Here/);
  assert.match(r.doc.html, /famous/);
});

test('assessV2Accept: patch whose element vanished → 409', () => {
  const doc = makeDoc();
  const gone = { ...doc, html: doc.html.replace(/<h2[^>]*>.*?<\/h2>/, '') };
  const r = assessV2Accept({
    kind: 'v2_patch',
    proposal: { patch: { elementId: 'hero-title', html: '<h2 data-ai-id="hero-title">X</h2>', cssAdd: '' } },
    baseVersionId: 'v1', currentVersionId: 'v2', currentDoc: gone,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
});

test('assessV2Accept: revision requires base version to still be current', () => {
  const doc = makeDoc();
  const stale = assessV2Accept({
    kind: 'v2_revision', proposal: { document: makeDoc() },
    baseVersionId: 'v1', currentVersionId: 'v2', currentDoc: doc,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);

  const fresh = assessV2Accept({
    kind: 'v2_revision', proposal: { document: makeDoc() },
    baseVersionId: 'v1', currentVersionId: 'v1', currentDoc: doc,
  });
  assert.ok(fresh.ok);
});

test('assessV2Accept: protected change needs explicit confirmation', () => {
  const doc = makeDoc();
  const patch = {
    elementId: 'hero-price',
    html: '<p data-ai-id="hero-price"><span data-content-key="ticket-price">£30.00</span> per ticket</p>',
    cssAdd: '',
  };
  const blocked = assessV2Accept({
    kind: 'v2_patch', proposal: { patch }, baseVersionId: 'v1', currentVersionId: 'v1', currentDoc: doc,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.requiresConfirmation, true);
  assert.ok(blocked.warnings.length >= 1);

  const confirmed = assessV2Accept({
    kind: 'v2_patch', proposal: { patch }, baseVersionId: 'v1', currentVersionId: 'v1',
    currentDoc: doc, confirmProtected: true,
  });
  assert.ok(confirmed.ok);
  assert.ok(confirmed.warnings.length >= 1);
});

test('assessV2Accept: unknown kind → 400', () => {
  const r = assessV2Accept({ kind: 'nope', proposal: {}, baseVersionId: 'a', currentVersionId: 'a', currentDoc: makeDoc() });
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// Review hardening: stable-ID survival + expanded accessibility criticals.
test('accessibility: fake interactive, summary-less details, positive tabindex', () => {
  const issues = checkV2AccessibilityCritical(
    '<div data-ai-id="c" data-ai-action="book-now">Book</div>'
    + '<details data-ai-id="faq"><p>Answer only</p></details>'
    + '<span data-ai-id="t" tabindex="3">x</span>',
  );
  assert.ok(issues.some((i) => i.check === 'fake_interactive' && i.elementId === 'c'));
  assert.ok(issues.some((i) => i.check === 'details_no_summary' && i.elementId === 'faq'));
  assert.ok(issues.some((i) => i.check === 'positive_tabindex' && i.elementId === 't'));
  // Real controls / roles / summaries / tabindex 0 are fine.
  assert.deepEqual(checkV2AccessibilityCritical(
    '<a data-ai-action="a" href="#">Go</a>'
    + '<div data-ai-action="b" role="button">Go</div>'
    + '<details><summary>Q</summary><p>A</p></details>'
    + '<span tabindex="0">x</span><span tabindex="-1">y</span>',
  ), []);
});

test('applyV2ElementPatch: replacement may not drop descendant data-ai-ids', () => {
  const doc = makeDoc();
  const r = applyV2ElementPatch(doc, {
    elementId: 'hero',
    html: [
      '<section data-ai-id="hero" class="hero">',
      '<h2 data-ai-id="hero-title" class="title">Spring Networking Evening</h2>',
      // hero-copy, hero-price and hero-cta silently dropped.
      '</section>',
    ].join(''),
    cssAdd: '',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /dropped stable data-ai-id/);
  assert.match(r.errors[0], /hero-copy/);
  assert.match(r.errors[0], /hero-cta/);

  // Keeping every descendant id (even reordered/rewrapped) is fine.
  const ok = applyV2ElementPatch(doc, {
    elementId: 'hero',
    html: [
      '<section data-ai-id="hero" class="hero hero--flip">',
      '<a data-ai-id="hero-cta" data-ai-action="book-now" class="cta" href="#">Book your place</a>',
      '<div><h2 data-ai-id="hero-title" class="title">Spring Networking Evening</h2>',
      '<p data-ai-id="hero-copy" class="copy">Join fellow members for an evening of conversation and connection at our flagship spring gathering.</p></div>',
      '<p data-ai-id="hero-price"><span data-content-key="ticket-price">£25.00</span> per ticket</p>',
      '</section>',
    ].join(''),
    cssAdd: '',
  });
  assert.ok(ok.ok, JSON.stringify(ok.errors));
});

test('diffV2RemovedElements flags removed stable ids only', () => {
  const doc = makeDoc();
  assert.deepEqual(diffV2RemovedElements(doc.html, doc.html), []);
  const without = doc.html.replace(/<p data-ai-id="hero-copy"[^>]*>.*?<\/p>/, '');
  const w = diffV2RemovedElements(doc.html, without);
  assert.equal(w.length, 1);
  assert.equal(w[0].type, 'removed_element');
  assert.equal(w[0].key, 'hero-copy');
});

test('revision proposal surfaces removed elements as warnings', async () => {
  const doc = makeDoc();
  let call = 0;
  const callLlm = async () => {
    call += 1;
    if (call === 1) return JSON.stringify({ mode: 'revision', summary: 'Drop the copy' });
    const pkg = makeRevisionPackage(doc);
    pkg.html = pkg.html.replace(/<p data-ai-id="hero-copy">.*?<\/p>/, '');
    return JSON.stringify(pkg);
  };
  const res = await runV2EditProposal({
    callLlm, doc, instruction: 'remove the intro paragraph', target: { type: 'composition' }, compositionId: COMP_ID,
  });
  assert.equal(res.kind, 'v2_revision');
  assert.ok(res.warnings.some((w) => w.type === 'removed_element' && w.key === 'hero-copy'));
});

test('assessV2Accept: revision removing a stable id requires confirmation', () => {
  const doc = makeDoc();
  const revisedDoc = { ...makeDoc(), html: doc.html.replace(/<p data-ai-id="hero-copy"[^>]*>.*?<\/p>/, '') };
  const blocked = assessV2Accept({
    kind: 'v2_revision', proposal: { document: revisedDoc },
    baseVersionId: 'v1', currentVersionId: 'v1', currentDoc: doc,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.requiresConfirmation, true);
  assert.ok(blocked.warnings.some((w) => w.type === 'removed_element'));

  const confirmed = assessV2Accept({
    kind: 'v2_revision', proposal: { document: revisedDoc },
    baseVersionId: 'v1', currentVersionId: 'v1', currentDoc: doc, confirmProtected: true,
  });
  assert.ok(confirmed.ok);
});

test('runV2EditProposal forwards screenshot context to the model call', async () => {
  const doc = makeDoc();
  const seen = [];
  const callLlm = async ({ images }) => {
    seen.push(images);
    return JSON.stringify({
      mode: 'patch', summary: 's', elementId: 'hero-title',
      html: '<h2 data-ai-id="hero-title" class="title">New</h2>', cssAdd: '',
    });
  };
  await runV2EditProposal({
    callLlm, doc, instruction: 'x', target: { type: 'composition' }, compositionId: COMP_ID,
    screenshots: [{ url: 'https://cdn.example/shot-desktop.png', breakpoint: 'desktop' }],
  });
  assert.deepEqual(seen[0], [{ url: 'https://cdn.example/shot-desktop.png', detail: 'low' }]);
});
