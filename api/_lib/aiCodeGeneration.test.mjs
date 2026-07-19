// Tests for AI Design Studio V2 Phase 1 code-first generation (Task #2905):
// brand token building, prompt content, deterministic rejection gates and the
// single-attempt runner (with a stubbed LLM — no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
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

test('gate: <img> rejected (Phase 1 is inline SVG only)', () => {
  const pkg = goodPackage();
  const res = runCodeRejectionGates(
    { html: pkg.html + '<img src="https://x/y.png">', css: pkg.css },
    REPORT,
    { brief: 'plain brief', options: {} },
  );
  assert.match(res.errors.join(' '), /<img>/);
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

test('runCodeAttempt propagates provider errors (thrown by callLlm)', async () => {
  const callLlm = async () => { throw Object.assign(new Error('down'), { providerError: true }); };
  await assert.rejects(
    () => runCodeAttempt({ callLlm, compositionId: COMP_ID, brief: 'x', brand: BRAND }),
    /down/,
  );
});
