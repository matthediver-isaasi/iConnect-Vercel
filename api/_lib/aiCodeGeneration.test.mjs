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
  autoRepairMissingAiIds,
  decideCarryForward,
  classifyGateErrorSide,
  MAX_CODE_RETRIES,
  MAX_PAGE_CODE_RETRIES,
  PAGE_HTML_MIN_CHARS,
  PAGE_CSS_MIN_CHARS,
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

test('runCodeAttempt: final attempt records auto-declared keys in the report', async () => {
  const callLlm = async () => JSON.stringify(undeclaredActionPackage());
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND, attempt: MAX_CODE_RETRIES,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.autoDeclaredActionKeys, ['anchor']);
  assert.deepEqual(res.report.autoDeclaredActionKeys, ['anchor']);
});

test('runCodeAttempt: no reconciliation means no autoDeclared metadata', async () => {
  const callLlm = async () => JSON.stringify(goodPackage());
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND, attempt: MAX_CODE_RETRIES,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.autoDeclaredActionKeys, []);
  assert.equal(res.report.autoDeclaredActionKeys, undefined);
});

test('runCodeAttempt: malformed (non-array) actions manifest stays fatal on the final attempt', async () => {
  const pkg = undeclaredActionPackage();
  pkg.actions = { key: 'join', type: 'anchor' }; // object, not an array
  const callLlm = async () => JSON.stringify(pkg);
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND, attempt: MAX_CODE_RETRIES,
  });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /actions must be an array/);
});

test('cross-check retry feedback teaches the key-vs-type distinction', async () => {
  const callLlm = async () => JSON.stringify(undeclaredActionPackage());
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND, attempt: 0,
  });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /action TYPE name .* is not a key/);
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
  const cards = (key) => `<div data-ai-id="${key}-cards" class="${key}-cards">${[1, 2, 3].map((n) => `
      <article data-ai-id="${key}-card-${n}" class="card">
        <h3 data-ai-id="${key}-card-${n}-title">Card ${n} title for the ${key} section</h3>
        <p data-ai-id="${key}-card-${n}-copy">Substantive supporting copy for card ${n}: it explains a concrete benefit in plain language, uses real detail from the content manifest, and gives the visitor a reason to keep reading down the page.</p>
      </article>`).join('')}
  </div>`;
  const sect = (key, heading, extra = '') => `<section data-ai-id="${key}" class="section-${key}">
    <h2 data-ai-id="${key}-heading">${heading}</h2>
    <p data-ai-id="${key}-copy">Real copy for the ${heading} section that says something concrete and useful to visitors, written out at full paragraph length so the section reads as finished content rather than a placeholder skeleton.</p>
    ${cards(key)}
    ${extra}
  </section>`;
  const cssSections = ['hero', 'benefits', 'events', 'join'].map((key) => `
.section-${key} { padding: 64px 24px; background: var(--iconnect-primary, #f6f8fa); }
.section-${key} h2 { font-size: 2.25rem; line-height: 1.15; margin-bottom: 16px; letter-spacing: -0.01em; }
.section-${key} p { max-width: 62ch; color: #333a45; margin-bottom: 24px; }
.${key}-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
.${key}-cards .card { border-radius: 8px; padding: 24px; background: #fff; box-shadow: 0 1px 3px rgba(16, 24, 40, 0.08); }
@media (max-width: 1024px) { .${key}-cards { grid-template-columns: 1fr 1fr; } }
@media (max-width: 390px) { .${key}-cards { grid-template-columns: 1fr; } .section-${key} { padding: 40px 16px; } }`).join('\n');
  return {
    compositionType: 'page_body',
    html: [
      sect('hero', 'Welcome', '<a data-ai-id="hero-cta" data-ai-action="join">Join now</a><svg data-ai-id="hero-art" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>'),
      sect('benefits', 'Benefits'),
      sect('events', 'Events', '<div data-iconnect-slot="event_listing" data-slot-key="events-slot"></div>'),
      sect('join', 'Become a member'),
    ].join('\n'),
    css: `.x { display: grid; } ${cssSections} @media (max-width: 1024px) { .x { display: block; } }`,
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

test('anti-bland gate: thin page HTML and CSS rejected with instructive errors', () => {
  const doc = goodPageDocument();
  doc.html = ['hero', 'benefits', 'events', 'join'].map((k) => `<section data-ai-id="${k}"><h2 data-ai-id="${k}-h">Heading ${k}</h2><p data-ai-id="${k}-p">Enough copy to dodge the near-blank gate but nothing more.</p>${k === 'events' ? '<div data-iconnect-slot="event_listing" data-slot-key="events-slot"></div>' : ''}${k === 'hero' ? '<a data-ai-id="cta" data-ai-action="join">Join</a>' : ''}</section>`).join('');
  doc.css = '.x { display: grid; } @media (max-width: 1024px) { .x { display: block; } }';
  const res = runCodeRejectionGates(doc, { actionKeys: ['join'], slotKeys: ['events-slot'], htmlRemoved: [] }, { plan: goodPlan() });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /markup is far too thin/.test(e)));
  assert.ok(res.errors.some((e) => /CSS is far too thin/.test(e)));
});

test('anti-bland gate: page CSS without grid/flex rejected', () => {
  const doc = goodPageDocument();
  doc.css = `body { color: #111; } ${'.pad { padding: 24px; margin: 12px; border: 1px solid #eee; background: #fafafa; } '.repeat(40)} @media (max-width: 1024px) { .pad { padding: 12px; } }`;
  const res = runCodeRejectionGates(doc, { actionKeys: ['join'], slotKeys: ['events-slot'], htmlRemoved: [] }, { plan: goodPlan() });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /no grid or flex layout/.test(e)));
});

test('anti-bland gate: imagery promised by the plan but none delivered rejected', () => {
  const doc = goodPageDocument();
  // Strip the inline SVG so the page has zero visual richness.
  doc.html = doc.html.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  const plan = goodPlan();
  plan.creativeDirection = 'A warm, photographic page with hero imagery of patients and carers.';
  const res = runCodeRejectionGates(doc, { actionKeys: ['join'], slotKeys: ['events-slot'], htmlRemoved: [] }, { plan });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /calls for imagery/.test(e)));

  // Same page WITH an asset request passes the imagery gate.
  const withAsset = goodPageDocument();
  withAsset.html = withAsset.html.replace(/<svg[\s\S]*?<\/svg>/gi, '<img data-ai-id="hero-img" data-ai-asset="hero-photo" alt="Patients and carers">');
  withAsset.assets = [{ key: 'hero-photo', type: 'image_request', subject: 'patients and carers', alt: 'Patients and carers' }];
  const ok = runCodeRejectionGates(withAsset, { actionKeys: ['join'], slotKeys: ['events-slot'], assetKeys: ['hero-photo'], htmlRemoved: [] }, { plan });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('anti-bland gate: style reference attached but zero visual richness rejected', () => {
  const doc = goodPageDocument();
  doc.html = doc.html.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  const res = runCodeRejectionGates(
    doc,
    { actionKeys: ['join'], slotKeys: ['events-slot'], htmlRemoved: [] },
    { plan: goodPlan(), options: { styleReference: { screenshots: [{ url: 'https://x/shot.png' }] } } },
  );
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /calls for imagery/.test(e)));
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

// ---------------------------------------------------------------------------
// Quality bar in the prompt + measured-size retry feedback + page retry budget
// (jobId 2c2b4a4e follow-up: gates existed only post-hoc; state them up front)
// ---------------------------------------------------------------------------

test('buildCodePrompt (page_body) states the richness/layout/imagery bar up front', () => {
  const { system } = buildCodePrompt({
    brief: 'A welcome page', brand: BRAND, options: {},
    compositionType: 'page_body', plan: goodPlan(),
  });
  assert.match(system, new RegExp(`at least \\$?${PAGE_HTML_MIN_CHARS} characters`));
  assert.match(system, new RegExp(`at least \\$?${PAGE_CSS_MIN_CHARS} characters`));
  assert.match(system, /RICHNESS BAR/);
  assert.match(system, /LAYOUT BAR/);
  assert.match(system, /IMAGERY BAR/);
});

test('buildCodePrompt (section) omits the page richness bar', () => {
  const { system } = buildCodePrompt({ brief: 'A hero', brand: BRAND, options: {} });
  assert.doesNotMatch(system, /RICHNESS BAR/);
});

test('buildCodePrompt (page_body retry) includes previous measured sizes next to the floors', () => {
  const { user } = buildCodePrompt({
    brief: 'A welcome page', brand: BRAND, options: {},
    compositionType: 'page_body', plan: goodPlan(),
    attempt: 1,
    lastErrors: ['The page markup is far too thin (1952 characters)'],
    lastStats: { htmlChars: 1952, cssChars: 800 },
  });
  assert.match(user, /html 1952 characters \(minimum 3000\)/);
  assert.match(user, /css 800 characters \(minimum 1500\)/);
  assert.match(user, /SUBSTANTIALLY richer/);
});

test('buildCodePrompt (section retry) never includes the measured-size line', () => {
  const { user } = buildCodePrompt({
    brief: 'A hero', brand: BRAND, options: {},
    attempt: 1, lastErrors: ['too thin'], lastStats: { htmlChars: 500, cssChars: 200 },
  });
  assert.doesNotMatch(user, /characters \(minimum/);
});

test('runCodeAttempt returns measured stats on a gate rejection', async () => {
  const pkg = goodPackage();
  pkg.compositionType = 'page_body'; // mismatch → hard reject, but stats present
  const callLlm = async () => JSON.stringify(goodPackage());
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND, compositionType: 'page_body', plan: goodPlan(),
  });
  assert.equal(res.ok, false);
  assert.ok(res.stats);
  assert.equal(typeof res.stats.htmlChars, 'number');
  assert.equal(typeof res.stats.cssChars, 'number');
});

test('page retry budget exceeds the section budget', () => {
  assert.ok(MAX_PAGE_CODE_RETRIES > MAX_CODE_RETRIES);
});

test('runCodeAttempt final-attempt reconciliation honours a custom maxRetries', async () => {
  // Package with an undeclared action key; at attempt === MAX_CODE_RETRIES it
  // would normally reconcile — but with a HIGHER maxRetries it must still be
  // treated as a non-final attempt and hard-reject.
  const pkg = goodPackage();
  pkg.html = pkg.html.replace('data-ai-action="join"', 'data-ai-action="mystery-key"');
  pkg.actions = [];
  const callLlm = async () => JSON.stringify(pkg);
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND,
    attempt: MAX_CODE_RETRIES, maxRetries: MAX_PAGE_CODE_RETRIES,
  });
  assert.equal(res.ok, false);
  // And at the custom final attempt it reconciles.
  const final = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND,
    attempt: MAX_PAGE_CODE_RETRIES, maxRetries: MAX_PAGE_CODE_RETRIES,
  });
  assert.equal(final.ok, true, JSON.stringify(final.errors));
  assert.deepEqual(final.autoDeclaredActionKeys, ['mystery-key']);
});

// ---------------------------------------------------------------------------
// Task #2938: anti-oscillation — id auto-repair, per-gate verdicts,
// carry-forward.
// ---------------------------------------------------------------------------

test('autoRepairMissingAiIds injects unique ids only where missing', () => {
  const html = '<h2>No id</h2><a data-ai-id="keep" href="#">ok</a><button class="x">Go</button><a href="#">two</a>';
  const { html: out, injected } = autoRepairMissingAiIds(html);
  assert.equal(injected, 3);
  assert.match(out, /<h2 data-ai-id="auto-h2-1">/);
  assert.match(out, /<button data-ai-id="auto-button-1" class="x">/);
  assert.match(out, /<a data-ai-id="auto-a-1" href="#">two<\/a>/);
  assert.match(out, /<a data-ai-id="keep" href="#">ok<\/a>/);
});

test('autoRepairMissingAiIds is collision-safe against existing ids', () => {
  const html = '<h2 data-ai-id="auto-h2-1">taken</h2><h2>needs one</h2>';
  const { html: out, injected } = autoRepairMissingAiIds(html);
  assert.equal(injected, 1);
  assert.match(out, /<h2 data-ai-id="auto-h2-2">needs one<\/h2>/);
});

test('autoRepairMissingAiIds no-ops when everything is labelled', () => {
  const html = '<h2 data-ai-id="h">Hi</h2>';
  const res = autoRepairMissingAiIds(html);
  assert.equal(res.injected, 0);
  assert.equal(res.html, html);
});

test('runCodeAttempt (page_body) auto-repairs missing data-ai-id instead of rejecting', async () => {
  const doc = goodPageDocument();
  const pkg = {
    schemaVersion: '2.0',
    compositionType: 'page_body',
    title: 'Page',
    html: doc.html + '<section data-ai-id="extra"><h2>Unlabelled heading</h2><p data-ai-id="extra-p">Enough copy to keep every other gate perfectly happy in this section too.</p></section>',
    css: doc.css,
    actions: [{ key: 'join', type: 'anchor', target: 'hero' }],
    slots: [{ key: 'events-slot', type: 'event_listing', hint: 'events' }],
    responsiveTargets: { desktop: 1440, tablet: 1024, mobile: 390 },
    generationSummary: 'x',
  };
  const callLlm = async () => JSON.stringify(pkg);
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND,
    compositionType: 'page_body', plan: goodPlan(),
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors || []));
  assert.equal(res.autoInjectedAiIds, 1);
  assert.equal(res.report.autoInjectedAiIds, 1);
  assert.match(res.document.html, /data-ai-id="auto-h2-1"/);
});

test('runCodeAttempt (section) does NOT auto-repair missing data-ai-id', async () => {
  const pkg = goodPackage();
  pkg.html += '<a href="#unlabelled">No id</a>';
  const callLlm = async () => JSON.stringify(pkg);
  const res = await runCodeAttempt({ callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /missing a stable data-ai-id/);
});

test('runCodeAttempt (page_body) failure carries per-side verdicts and raw sides', async () => {
  const doc = goodPageDocument();
  const pkg = {
    schemaVersion: '2.0',
    compositionType: 'page_body',
    title: 'Page',
    html: doc.html,
    css: '.thin { display: grid; } @media (max-width: 1024px) { .thin { display: block; } }',
    actions: [{ key: 'join', type: 'anchor', target: 'hero' }],
    slots: [{ key: 'events-slot', type: 'event_listing', hint: 'events' }],
    responsiveTargets: { desktop: 1440, tablet: 1024, mobile: 390 },
    generationSummary: 'x',
  };
  const callLlm = async () => JSON.stringify(pkg);
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND,
    compositionType: 'page_body', plan: goodPlan(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.stats.htmlOk, true);
  assert.equal(res.stats.cssOk, false);
  assert.equal(res.raw.html, pkg.html);
  assert.equal(res.raw.css, pkg.css);
});

test('classifyGateErrorSide maps gate messages to the fixable side', () => {
  assert.equal(classifyGateErrorSide('The page CSS is far too thin (600 characters) — style every section deliberately.'), 'css');
  assert.equal(classifyGateErrorSide('The page CSS uses no grid or flex layout — a full page body must use real layout structure.'), 'css');
  assert.equal(classifyGateErrorSide('The CSS has no @media (max-width: …) rules — the section must genuinely adapt.'), 'css');
  assert.equal(classifyGateErrorSide('The page markup is far too thin (2000 characters) — a full page body needs rich structure.'), 'html');
  assert.equal(classifyGateErrorSide('Disallowed markup was found and is forbidden: element "script".'), 'html');
  assert.equal(classifyGateErrorSide('3 heading/button/link element(s) are missing a stable data-ai-id attribute — every meaningful element needs one.'), 'html');
  assert.equal(classifyGateErrorSide('Planned section(s) missing from the markup: hero.'), 'html');
  assert.equal(classifyGateErrorSide('The design is too generic for this visually-led brief — use real layout structure.'), 'both');
  assert.equal(classifyGateErrorSide(''), 'both');
});

test('runCodeAttempt (page_body) downgrades htmlOk when an html-side gate also fails', async () => {
  const doc = goodPageDocument();
  const pkg = {
    schemaVersion: '2.0',
    compositionType: 'page_body',
    title: 'Page',
    // Big enough HTML to pass the size heuristic, but with a data-ai-asset
    // declaration that is never placed — an html-side gate failure.
    html: doc.html,
    css: '.thin { display: grid; } @media (max-width: 1024px) { .thin { display: block; } }',
    actions: [{ key: 'join', type: 'anchor', target: 'hero' }],
    slots: [{ key: 'events-slot', type: 'event_listing', hint: 'events' }],
    assets: [{ key: 'never-used', kind: 'photo', prompt: 'x', alt: 'x' }],
    responsiveTargets: { desktop: 1440, tablet: 1024, mobile: 390 },
    generationSummary: 'x',
  };
  const callLlm = async () => JSON.stringify(pkg);
  const res = await runCodeAttempt({
    callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND,
    compositionType: 'page_body', plan: goodPlan(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.stats.htmlOk, false); // heuristic passed but a real html-side gate failed
  assert.equal(res.stats.cssOk, false);
  assert.equal(decideCarryForward(res.stats, res.raw), null); // nothing carried when both dirty
});

test('decideCarryForward picks the passing side only', () => {
  const raw = { html: '<section>x</section>', css: '.x{display:grid}' };
  assert.deepEqual(decideCarryForward({ htmlOk: true, cssOk: false }, raw), { html: raw.html });
  assert.deepEqual(decideCarryForward({ htmlOk: false, cssOk: true }, raw), { css: raw.css });
  assert.equal(decideCarryForward({ htmlOk: false, cssOk: false }, raw), null);
  assert.equal(decideCarryForward({ htmlOk: true, cssOk: true }, raw), null);
  assert.equal(decideCarryForward(null, raw), null);
  assert.equal(decideCarryForward({ htmlChars: 100, cssChars: 100 }, raw), null); // sections: no verdicts
  assert.equal(decideCarryForward({ htmlOk: true, cssOk: false }, null), null);
});

test('buildCodePrompt (page_body retry) reports per-gate verdicts and preservation rule', () => {
  const { user } = buildCodePrompt({
    brief: 'A welcome page', brand: BRAND, options: {},
    compositionType: 'page_body', plan: goodPlan(),
    attempt: 1,
    lastErrors: ['The page CSS is far too thin (660 characters)'],
    lastStats: { htmlChars: 4364, cssChars: 660, htmlOk: true, cssOk: false },
  });
  assert.match(user, /HTML 4364 characters — PASSED/);
  assert.match(user, /CSS 660 characters — FAILED/);
  assert.match(user, /PRESERVE everything that PASSED/);
});

test('buildCodePrompt (page_body retry) embeds carried-forward HTML with keep-it instructions', () => {
  const { user } = buildCodePrompt({
    brief: 'A welcome page', brand: BRAND, options: {},
    compositionType: 'page_body', plan: goodPlan(),
    attempt: 1,
    lastErrors: ['The page CSS is far too thin (660 characters)'],
    lastStats: { htmlChars: 4364, cssChars: 660, htmlOk: true, cssOk: false },
    carryForward: { html: '<section data-ai-id="hero">KEEP-THIS-MARKUP</section>' },
  });
  assert.match(user, /HTML PASSED all HTML checks/);
  assert.match(user, /REUSE IT EXACTLY/);
  assert.match(user, /KEEP-THIS-MARKUP/);
  assert.match(user, /CSS ONLY/);
});

test('buildCodePrompt (page_body retry) embeds carried-forward CSS symmetrically', () => {
  const { user } = buildCodePrompt({
    brief: 'A welcome page', brand: BRAND, options: {},
    compositionType: 'page_body', plan: goodPlan(),
    attempt: 1,
    lastErrors: ['The page markup is far too thin (2665 characters)'],
    lastStats: { htmlChars: 2665, cssChars: 2100, htmlOk: false, cssOk: true },
    carryForward: { css: '.keep-this-css { display: grid; }' },
  });
  assert.match(user, /CSS PASSED all CSS checks/);
  assert.match(user, /keep-this-css/);
  assert.match(user, /HTML ONLY/);
});

test('buildCodePrompt (section) ignores carryForward entirely', () => {
  const { user } = buildCodePrompt({
    brief: 'A hero', brand: BRAND, options: {},
    attempt: 1, lastErrors: ['too thin'],
    carryForward: { html: '<section>SHOULD-NOT-APPEAR</section>' },
  });
  assert.doesNotMatch(user, /SHOULD-NOT-APPEAR/);
});
