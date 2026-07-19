// Tests for AI Design Studio V2 Phase 1 code-first generation (Task #2905):
// brand token building, prompt content, deterministic rejection gates and the
// single-attempt runner (with a stubbed LLM — no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContentPlanPrompt,
  parsePlanResponse,
  runPlanChecks,
  PLAN_MIN_SECTIONS,
  PLAN_MAX_SECTIONS,
  buildIconnectBrandTokens,
  brandTokensCssBlock,
  buildCodePrompt,
  parseCodePackageResponse,
  isVisuallyLedBrief,
  briefWantsCta,
  runCodeRejectionGates,
  runCodeAttempt,
  MAX_CODE_RETRIES,
} from './aiCodeGeneration.js';

const COMP_ID = '12345678-1234-4321-8765-123456789abc';

const BRAND = {
  name: 'BNMS',
  primaryColor: '#0f4c81',
  secondaryColor: '#e8b34b',
  tagline: 'Together for bees',
  tone: 'Warm and expert',
  fonts: ['Fraunces', 'Inter'],
};

/** A minimal package that passes schema + pipeline + gates. */
function goodPackage() {
  return {
    schemaVersion: '2.0',
    compositionType: 'section',
    title: 'Join us hero',
    html: `<section data-ai-id="hero-root">
      <h2 data-ai-id="hero-heading">Join our community of beekeepers today</h2>
      <p data-ai-id="hero-copy">We support members with training, insurance and a thriving local network across the country.</p>
      <svg data-ai-id="hero-art" viewBox="0 0 100 100" role="img" aria-label="Decorative hexagons"><polygon points="50,5 90,25 90,75 50,95 10,75 10,25"/></svg>
      <div data-ai-id="hero-cards"><div data-ai-id="card-one">Training</div><div data-ai-id="card-two">Insurance</div></div>
      <a data-ai-id="hero-cta" data-ai-action="join" href="#">Become a member</a>
    </section>`,
    css: `:root { --iconnect-primary: #0f4c81; }
.hero { display: grid; gap: 2rem; color: var(--iconnect-primary); }
@media (max-width: 1024px) { .hero { display: flex; flex-direction: column; } }
@media (max-width: 390px) { .hero { gap: 1rem; } }`,
    actions: [{ key: 'join', type: 'anchor', target: 'hero-root' }],
    responsiveTargets: { desktop: 1440, tablet: 1024, mobile: 390 },
    generationSummary: 'A layered hero with hexagon artwork.',
  };
}

// ---------------------------------------------------------------------------
// Brand tokens
// ---------------------------------------------------------------------------

test('buildIconnectBrandTokens maps brand values to --iconnect-* variables', () => {
  const tokens = buildIconnectBrandTokens(BRAND);
  assert.equal(tokens['--iconnect-primary'], '#0f4c81');
  assert.equal(tokens['--iconnect-secondary'], '#e8b34b');
  assert.match(tokens['--iconnect-font-heading'], /Fraunces/);
  assert.match(tokens['--iconnect-font-body'], /Inter/);
});

test('buildIconnectBrandTokens rejects unsafe values', () => {
  const tokens = buildIconnectBrandTokens({
    primaryColor: 'red; } body { display:none',
    fonts: ["Ev'il\"; {font}"],
  });
  assert.equal(tokens['--iconnect-primary'], undefined);
  assert.ok(!JSON.stringify(tokens).includes('display:none'));
});

test('brandTokensCssBlock renders a :root block', () => {
  const css = brandTokensCssBlock({ '--iconnect-primary': '#111' });
  assert.match(css, /^:root \{\n {2}--iconnect-primary: #111;\n\}$/);
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

test('buildCodePrompt embeds brand tokens, brief, and retry feedback', () => {
  const { system, user } = buildCodePrompt({
    brief: 'A hero for our society',
    brand: BRAND,
    options: { creativity: 'expressive', direction: 'Layered depth' },
    attempt: 1,
    lastErrors: ['The CSS has no @media rules'],
  });
  assert.match(system, /--iconnect-primary: #0f4c81/);
  assert.match(system, /data-ai-id/);
  assert.match(system, /VISUALLY LED/);
  assert.match(system, /be bold and visually adventurous/);
  assert.match(user, /A hero for our society/);
  assert.match(user, /VISUAL DIRECTION/);
  assert.match(user, /PREVIOUS ATTEMPT WAS REJECTED/);
  assert.match(user, /no @media rules/);
});

test('buildCodePrompt includes CTA rule when the brief wants action', () => {
  const { system } = buildCodePrompt({
    brief: 'Encourage visitors to sign up for membership',
    brand: BRAND,
    options: {},
  });
  assert.match(system, /call-to-action element with data-ai-action/);
});

test('buildCodePrompt without direction on a plain brief omits visually-led rule', () => {
  const { system } = buildCodePrompt({
    brief: 'Explain our committee structure',
    brand: BRAND,
    options: {},
  });
  assert.ok(!/VISUALLY LED/.test(system));
});

// ---------------------------------------------------------------------------
// Heuristics + parsing
// ---------------------------------------------------------------------------

test('isVisuallyLedBrief and briefWantsCta heuristics', () => {
  assert.equal(isVisuallyLedBrief('A bold striking hero'), true);
  assert.equal(isVisuallyLedBrief('List of trustees', 'make it artful'), true);
  assert.equal(isVisuallyLedBrief('List of trustees'), false);
  assert.equal(briefWantsCta('Get people to register for the event'), true);
  assert.equal(briefWantsCta('Our history since 1932'), false);
  assert.equal(briefWantsCta('Our history', 'join now'), true);
});

test('parseCodePackageResponse rejects non-JSON and non-objects', () => {
  assert.equal(parseCodePackageResponse('not json').ok, false);
  assert.equal(parseCodePackageResponse('[1,2]').ok, false);
  assert.equal(parseCodePackageResponse('{"a":1}').ok, true);
});

// ---------------------------------------------------------------------------
// Rejection gates
// ---------------------------------------------------------------------------

const REPORT = { aiIds: ['a', 'b', 'c', 'd', 'e'], actionKeys: ['join'] };

test('gates pass a good document', () => {
  const pkg = goodPackage();
  const res = runCodeRejectionGates(
    { html: pkg.html, css: pkg.css },
    REPORT,
    { brief: 'A bold hero encouraging people to join', options: {} },
  );
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
});

test('gate: near-blank output rejected', () => {
  const res = runCodeRejectionGates(
    { html: '<section data-ai-id="x"><h2 data-ai-id="h">Hi</h2></section>', css: '@media (max-width: 390px){}' },
    { aiIds: ['x', 'h'], actionKeys: [] },
    { brief: 'Our history', options: {} },
  );
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /blank/);
});

// Phase 5: EVERY <img> in model output must be a declarative asset-request
// placeholder (data-ai-asset). A model-authored src — absolute OR relative —
// bypasses the manifest/provenance flow and is rejected outright.
test('gate: <img> with no data-ai-asset and no src rejected', () => {
  const pkg = goodPackage();
  const res = runCodeRejectionGates(
    { html: pkg.html + '<img data-ai-id="pic" alt="x">', css: pkg.css },
    REPORT,
    { brief: 'plain brief', options: {} },
  );
  assert.match(res.errors.join(' '), /missing a data-ai-asset request key/);
});

test('gate: model-authored <img src> without data-ai-asset rejected (absolute and relative)', () => {
  const pkg = goodPackage();
  for (const src of ['https://x/y.png', '/uploads/sneaky.png']) {
    const res = runCodeRejectionGates(
      { html: pkg.html + `<img data-ai-id="pic" src="${src}" alt="y">`, css: pkg.css },
      REPORT,
      { brief: 'plain brief', options: {} },
    );
    assert.equal(res.ok, false, `src="${src}" must be rejected`);
    assert.match(res.errors.join(' '), /missing a data-ai-asset request key/);
  }
});

test('gate: <img data-ai-asset> placeholder accepted, with or without a fulfilled src', () => {
  const pkg = goodPackage();
  const res = runCodeRejectionGates(
    {
      html: pkg.html
        + '<img data-ai-id="pic" data-ai-asset="hero" alt="x">'
        + '<img data-ai-id="pic2" data-ai-asset="team" src="https://x/y.png" alt="y">',
      css: pkg.css,
      assets: [
        { key: 'hero', type: 'image_request', subject: 's', alt: 'x' },
        { key: 'team', type: 'image_request', subject: 't', alt: 'y' },
      ],
    },
    { ...REPORT, assetKeys: ['hero', 'team'] },
    { brief: 'plain brief', options: {} },
  );
  assert.doesNotMatch(res.errors.join(' '), /data-ai-asset|<img>/);
});

test('gate: declared asset request never placed in markup rejected', () => {
  const pkg = goodPackage();
  const res = runCodeRejectionGates(
    { html: pkg.html, css: pkg.css, assets: [{ key: 'ghost', type: 'image_request', subject: 's', alt: 'x' }] },
    REPORT,
    { brief: 'plain brief', options: {} },
  );
  assert.match(res.errors.join(' '), /never placed in the markup: ghost/);
});

test('gate: meaningful elements missing data-ai-id rejected', () => {
  const pkg = goodPackage();
  const res = runCodeRejectionGates(
    { html: pkg.html + '<button>No id</button>', css: pkg.css },
    REPORT,
    { brief: 'plain', options: {} },
  );
  assert.match(res.errors.join(' '), /missing a stable data-ai-id/);
});

test('gate: missing @media responsive rules rejected', () => {
  const pkg = goodPackage();
  const res = runCodeRejectionGates(
    { html: pkg.html, css: '.hero { display: grid; }' },
    REPORT,
    { brief: 'plain', options: {} },
  );
  assert.match(res.errors.join(' '), /@media/);
});

test('gate: CTA required when the brief wants action', () => {
  const pkg = goodPackage();
  const res = runCodeRejectionGates(
    { html: pkg.html, css: pkg.css },
    { aiIds: REPORT.aiIds, actionKeys: [] },
    { brief: 'Get visitors to sign up today', options: {} },
  );
  assert.match(res.errors.join(' '), /call to action/);
});

test('gate: generic heading+paragraph+button rejected for visually-led briefs', () => {
  const res = runCodeRejectionGates(
    {
      html: '<section data-ai-id="s"><h2 data-ai-id="h">A striking headline for everyone</h2><p data-ai-id="p">Some supporting copy that is long enough to not be blank at all.</p><a data-ai-id="b" data-ai-action="go">Go</a></section>',
      css: '.s { color: red; } @media (max-width: 1024px) { .s { color: blue; } }',
    },
    { aiIds: ['s', 'h', 'p', 'b'], actionKeys: ['go'] },
    { brief: 'A bold striking hero section', options: {} },
  );
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /too generic/);
});

test('gate: generic check does not fire for plain informational briefs', () => {
  const res = runCodeRejectionGates(
    {
      html: '<section data-ai-id="s"><h2 data-ai-id="h">Committee structure explained</h2><p data-ai-id="p">Some long enough informational copy about our committee and its members.</p></section>',
      css: '.s { color: red; } @media (max-width: 1024px) { .s { color: blue; } }',
    },
    { aiIds: ['s', 'h', 'p'], actionKeys: [] },
    { brief: 'Explain our committee structure', options: {} },
  );
  assert.equal(res.ok, true);
});

// ---------------------------------------------------------------------------
// Attempt runner (stubbed LLM → real Phase 0 pipeline → gates)
// ---------------------------------------------------------------------------

test('runCodeAttempt succeeds end-to-end through the real pipeline', async () => {
  const callLlm = async () => JSON.stringify(goodPackage());
  const res = await runCodeAttempt({
    callLlm,
    compositionId: COMP_ID,
    brief: 'A bold hero encouraging visitors to join',
    brand: BRAND,
    options: {},
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors || []));
  // Sanitised + scoped output.
  assert.match(res.document.css, new RegExp(`data-ai-composition="${COMP_ID}"`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(res.document.rendererVersion, 2);
  assert.ok(res.report.aiIds.includes('hero-heading'));
});

test('runCodeAttempt rejects unsafe content via the pipeline (script)', async () => {
  const bad = goodPackage();
  bad.html += '<script>alert(1)</script>';
  const callLlm = async () => JSON.stringify(bad);
  const res = await runCodeAttempt({ callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND });
  assert.equal(res.ok, false);
  assert.ok(res.errors.length > 0);
});

test('runCodeAttempt rejects CSS trying to escape the scope', async () => {
  const bad = goodPackage();
  bad.css += '\n@import url("https://evil.example/x.css");';
  const callLlm = async () => JSON.stringify(bad);
  const res = await runCodeAttempt({ callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND });
  assert.equal(res.ok, false);
});

test('runCodeAttempt reports unreadable model output as errors', async () => {
  const callLlm = async () => 'garbage not json';
  const res = await runCodeAttempt({ callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /unreadable/);
});

test('runCodeAttempt feeds previous errors back into the retry prompt', async () => {
  let seenUser = '';
  const callLlm = async ({ user }) => { seenUser = user; return JSON.stringify(goodPackage()); };
  await runCodeAttempt({
    callLlm,
    compositionId: COMP_ID,
    brief: 'x',
    brand: BRAND,
    attempt: 1,
    lastErrors: ['Missing CTA element'],
  });
  assert.match(seenUser, /Missing CTA element/);
  assert.ok(MAX_CODE_RETRIES >= 1);
});

// Regression (Task #2929): the model wrote data-ai-action="anchor" (the TYPE
// name as the key) without a manifest entry, exhausting all retries in prod.
function undeclaredActionPackage() {
  const pkg = goodPackage();
  pkg.html = pkg.html.replace(
    'data-ai-action="join"',
    'data-ai-action="anchor"',
  );
  pkg.actions = [];
  return pkg;
}

test('runCodeAttempt: undeclared action key still hard-rejects on non-final attempts', async () => {
  const callLlm = async () => JSON.stringify(undeclaredActionPackage());
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND, attempt: 0,
  });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /missing from the actions manifest/);
});

test('runCodeAttempt: final attempt auto-declares undeclared action keys as unresolved anchors', async () => {
  const callLlm = async () => JSON.stringify(undeclaredActionPackage());
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND, attempt: MAX_CODE_RETRIES,
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors || []));
  const auto = (res.document.actions || []).find((a) => a.key === 'anchor');
  assert.ok(auto, 'auto-declared action present');
  assert.equal(auto.type, 'anchor');
  assert.equal(auto.autoDeclared, true);
});

test('buildCodePrompt spells out that the action key is never a type name', () => {
  const { system } = buildCodePrompt({ brief: 'x', brand: BRAND, options: {} });
  assert.match(system, /NEVER an action type name/);
  assert.match(system, /data-ai-action="join-cta"/);
});

test('runCodeAttempt propagates provider errors (thrown by callLlm)', async () => {
  const callLlm = async () => { throw Object.assign(new Error('down'), { providerError: true }); };
  await assert.rejects(
    () => runCodeAttempt({ callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND }),
    /down/,
  );
});

// ---------------------------------------------------------------------------
// Phase 2 (Task #2906): content-manifest + creative-plan stage
// ---------------------------------------------------------------------------

function goodPlan() {
  return {
    contentManifest: [
      { key: 'intro', role: 'hero copy', text: 'Join a thriving community of beekeepers across the country.' },
      { key: 'benefits', role: 'detail', text: 'Training, insurance and events for every member.' },
    ],
    sections: [
      { key: 'hero', purpose: 'hero', headline: 'Welcome to BNMS', contentKeys: ['intro'], slot: null, actionTypes: ['membership_application'] },
      { key: 'benefits', purpose: 'proof', headline: 'Why members join', contentKeys: ['benefits'], slot: null, actionTypes: [] },
      { key: 'events', purpose: 'detail', headline: 'Upcoming events', contentKeys: [], slot: 'event_listing', actionTypes: ['event_registration'] },
      { key: 'join', purpose: 'call-to-action', headline: 'Become a member', contentKeys: [], slot: 'membership_application', actionTypes: ['membership_application'] },
    ],
    creativeDirection: 'A warm, honey-toned page with layered hexagon motifs.',
  };
}

test('buildContentPlanPrompt embeds brief, brand and retry feedback', () => {
  const { system, user } = buildContentPlanPrompt({
    brief: 'A membership page for beekeepers',
    brand: BRAND,
    options: { desiredAction: 'Join' },
    attempt: 1,
    lastErrors: ['Sections too repetitive'],
  });
  assert.match(system, /FULL PAGE BODY/);
  assert.match(system, /never plan them/i);
  assert.match(user, /A membership page for beekeepers/);
  assert.match(user, /BNMS/);
  assert.match(user, /Sections too repetitive/);
  assert.ok(PLAN_MIN_SECTIONS >= 3 && PLAN_MAX_SECTIONS <= 10);
});

test('parsePlanResponse rejects non-JSON and non-objects', () => {
  assert.equal(parsePlanResponse('nope').ok, false);
  assert.equal(parsePlanResponse('[1,2]').ok, false);
  assert.equal(parsePlanResponse(JSON.stringify(goodPlan())).ok, true);
});

test('runPlanChecks passes a varied plan', () => {
  const res = runPlanChecks(goodPlan());
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('runPlanChecks rejects degenerate plans', () => {
  // Too few sections.
  const thin = goodPlan();
  thin.sections = thin.sections.slice(0, 2);
  assert.equal(runPlanChecks(thin).ok, false);

  // Repetitive purposes.
  const rep = goodPlan();
  rep.sections = rep.sections.map((s) => ({ ...s, purpose: 'hero' }));
  const repRes = runPlanChecks(rep);
  assert.equal(repRes.ok, false);
  assert.ok(repRes.errors.some((e) => /repetitive/.test(e)));

  // Duplicate headlines.
  const dup = goodPlan();
  dup.sections = dup.sections.map((s) => ({ ...s, headline: 'Same' }));
  assert.equal(runPlanChecks(dup).ok, false);

  // Duplicate / missing keys.
  const badKeys = goodPlan();
  badKeys.sections[1].key = 'hero';
  badKeys.sections[2].key = 'Not Kebab';
  assert.equal(runPlanChecks(badKeys).ok, false);

  // Empty content manifest.
  const noContent = goodPlan();
  noContent.contentManifest = [];
  assert.equal(runPlanChecks(noContent).ok, false);

  // No planned call to action anywhere.
  const noCta = goodPlan();
  noCta.sections = noCta.sections.map((s) => ({ ...s, actionTypes: [] }));
  const noCtaRes = runPlanChecks(noCta);
  assert.equal(noCtaRes.ok, false);
  assert.ok(noCtaRes.errors.some((e) => /call to action/.test(e)));
});

// ---------------------------------------------------------------------------
// Phase 2: page_body rejection gates
// ---------------------------------------------------------------------------

function goodPageDocument() {
  const sect = (key, heading, extra = '') => `<section data-ai-id="${key}">
    <h2 data-ai-id="${key}-heading">${heading}</h2>
    <p data-ai-id="${key}-copy">Real copy for the ${heading} section that says something concrete and useful to visitors.</p>
    ${extra}
  </section>`;
  return {
    compositionType: 'page_body',
    html: [
      sect('hero', 'Welcome', '<a data-ai-id="hero-cta" data-ai-action="join">Join now</a>'),
      sect('benefits', 'Benefits'),
      sect('events', 'Events', '<div data-iconnect-slot="event_listing" data-slot-key="events-slot"></div>'),
      sect('join', 'Become a member'),
    ].join('\n'),
    css: '.x { display: grid; } @media (max-width: 1024px) { .x { display: block; } }',
  };
}

test('page_body gates pass a good multi-section document', () => {
  const report = { actionKeys: ['join'], slotKeys: ['events-slot'], aiIds: [], htmlRemoved: [] };
  const res = runCodeRejectionGates(goodPageDocument(), report, { brief: 'x', plan: goodPlan() });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('page_body gate: header/footer/nav recreation rejected', () => {
  const doc = goodPageDocument();
  doc.html = `<header data-ai-id="site-header">My header</header>${doc.html}`;
  const res = runCodeRejectionGates(doc, { actionKeys: ['join'], slotKeys: ['events-slot'], htmlRemoved: [] }, { plan: goodPlan() });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /never recreated/.test(e)));
});

test('page_body gate: too few sections rejected', () => {
  const doc = goodPageDocument();
  doc.html = '<section data-ai-id="only"><h2 data-ai-id="h">One long enough heading here</h2><p data-ai-id="p">Some sufficiently long copy to avoid the near-blank gate firing.</p></section>';
  const res = runCodeRejectionGates(doc, { actionKeys: [], slotKeys: [], htmlRemoved: [] }, {});
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /at least/.test(e)));
});

test('page_body gate: planned section missing from markup rejected', () => {
  const plan = goodPlan();
  plan.sections.push({ key: 'faq', purpose: 'detail', headline: 'FAQ', contentKeys: [], slot: null, actionTypes: [] });
  const res = runCodeRejectionGates(goodPageDocument(), { actionKeys: ['join'], slotKeys: ['events-slot'], htmlRemoved: [] }, { plan });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /faq/.test(e)));
});

test('page_body gate: planned slots with no placeholders rejected', () => {
  const res = runCodeRejectionGates(goodPageDocument(), { actionKeys: ['join'], slotKeys: [], htmlRemoved: [] }, { plan: goodPlan() });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /data-iconnect-slot/.test(e)));
});

test('runCodeAttempt rejects a package whose compositionType mismatches the run', async () => {
  const callLlm = async () => JSON.stringify(goodPackage()); // section package
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND, compositionType: 'page_body', plan: goodPlan(),
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /compositionType/.test(e)));
});
