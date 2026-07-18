// Style Reference & Design DNA tests (Task #2873).
//
// Covers: reference-URL SSRF validation, Design DNA normalisation, style
// reference normalisation (tenant-prefix screenshot enforcement), influence
// prompt variants, and the byte-identity guarantee — generation without a
// reference must produce EXACTLY the same options and prompts as before the
// feature existed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateReferenceUrl,
  isPrivateIpAddress,
  assertPublicUrlTarget,
  normalizeDesignDna,
  normalizeStyleReference,
  buildStyleReferenceSummary,
  styleReferenceImageUrls,
  styleReferenceImageInputs,
  INFLUENCE_LEVELS,
  DEFAULT_INFLUENCE,
  MAX_REFERENCE_SCREENSHOTS,
  DESIGN_DNA_FIELDS,
} from './styleReference.js';
import { normalizeOptions, buildPlanPrompt, buildDocumentPrompt } from './aiCompositionPipeline.js';

test('styleReferenceImageInputs returns curated labelled inputs with detail levels', () => {
  const prefix = 'https://cdn.example.com/storage/v1/object/public/public-assets/tenant-1/';
  const ref = {
    sourceType: 'url',
    influence: 'strong',
    screenshots: [
      { viewport: 'desktop', label: 'desktop_full_page', url: `${prefix}fp.jpg` },
      { viewport: 'desktop', label: 'desktop_card_cluster_1', url: `${prefix}cc.jpg` },
      { viewport: 'mobile', label: 'mobile_full_page', url: `${prefix}mfp.jpg` },
    ],
  };
  const inputs = styleReferenceImageInputs(ref);
  assert.equal(inputs.length, 3);
  // Curated ordering: card cluster first when all shots are labelled.
  assert.equal(inputs[0].label, 'desktop_card_cluster_1');
  assert.equal(inputs[0].detail, 'high');
  const fp = inputs.find((i) => i.label === 'desktop_full_page');
  assert.equal(fp.detail, 'low');
  const mfp = inputs.find((i) => i.label === 'mobile_full_page');
  assert.equal(mfp.viewport, 'mobile');
  // Unlabelled (legacy/upload) shots pass through in stored order.
  const legacy = styleReferenceImageInputs({
    screenshots: [{ viewport: 'desktop', url: `${prefix}x.jpg` }],
  });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].label, 'reference screenshot 1');
  assert.equal(legacy[0].detail, 'high');
  // No reference → [].
  assert.deepEqual(styleReferenceImageInputs(null), []);
});

const PREFIX = 'https://cdn.example.com/storage/v1/object/public/public-assets/tenant-1/';

function validRef(overrides = {}) {
  return {
    sourceType: 'url',
    sourceUrl: 'https://example.com',
    screenshots: [
      { viewport: 'desktop', url: `${PREFIX}style-refs/a-desktop.jpg` },
      { viewport: 'mobile', url: `${PREFIX}style-refs/a-mobile.jpg` },
    ],
    designDna: { composition: 'Bold hero, modular grid', layoutRhythm: 'Alternating bands' },
    influence: 'strong',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateReferenceUrl
// ---------------------------------------------------------------------------

test('validateReferenceUrl accepts public http(s) URLs', () => {
  assert.equal(validateReferenceUrl('https://stripe.com/pricing').ok, true);
  assert.equal(validateReferenceUrl('http://example.org').ok, true);
});

test('validateReferenceUrl rejects non-http schemes, credentials, and private hosts', () => {
  for (const bad of [
    '', 'not a url', 'ftp://example.com', 'file:///etc/passwd',
    'https://user:pass@example.com', 'http://localhost:3000',
    'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1',
    'http://172.16.0.1', 'http://169.254.169.254/latest/meta-data',
    'http://[::1]/', 'http://myhost.local', 'http://db.internal',
  ]) {
    assert.equal(validateReferenceUrl(bad).ok, false, `should reject: ${bad}`);
  }
});

test('isPrivateIpAddress rejects private/loopback/link-local/special ranges', () => {
  for (const bad of [
    '127.0.0.1', '127.255.255.255', '0.0.0.0', '10.1.2.3', '192.168.0.1',
    '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '192.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:10.0.0.1',
    '::ffff:127.0.0.1', '64:ff9b::a00:1', 'not-an-ip',
  ]) {
    assert.equal(isPrivateIpAddress(bad), true, `should be private: ${bad}`);
  }
});

test('isPrivateIpAddress accepts public addresses', () => {
  for (const ok of ['8.8.8.8', '1.1.1.1', '151.101.1.140', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIpAddress(ok), false, `should be public: ${ok}`);
  }
});

test('assertPublicUrlTarget rejects non-canonical private IP encodings via resolution', async () => {
  // getaddrinfo canonicalises decimal/hex/octal literals before we test them.
  for (const bad of [
    'http://2130706433/', // 127.0.0.1 decimal
    'http://0x7f000001/', // hex
    'http://017700000001/', // octal
    'http://127.1/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    const out = await assertPublicUrlTarget(bad);
    assert.equal(out.ok, false, `should reject: ${bad}`);
  }
});

test('assertPublicUrlTarget rejects unresolvable hosts, accepts literal public IPs', async () => {
  assert.equal((await assertPublicUrlTarget('http://definitely-not-a-real-host-xyz123.example')).ok, false);
  assert.equal((await assertPublicUrlTarget('http://8.8.8.8/')).ok, true);
});

// ---------------------------------------------------------------------------
// normalizeDesignDna
// ---------------------------------------------------------------------------

test('normalizeDesignDna keeps known fields, drops unknown, caps length', () => {
  const dna = normalizeDesignDna({
    composition: '  Big   hero  ',
    layoutRhythm: 'x'.repeat(1000),
    hacker: 'ignore me',
  });
  assert.equal(dna.composition, 'Big hero');
  assert.equal(dna.layoutRhythm.length, 400);
  assert.equal('hacker' in dna, false);
});

test('normalizeDesignDna returns null for empty/invalid input', () => {
  assert.equal(normalizeDesignDna(null), null);
  assert.equal(normalizeDesignDna('str'), null);
  assert.equal(normalizeDesignDna([]), null);
  assert.equal(normalizeDesignDna({ junk: 'x' }), null);
  assert.equal(normalizeDesignDna({ composition: '   ' }), null);
});

test('DESIGN_DNA_FIELDS covers the 8 spec fields', () => {
  assert.equal(DESIGN_DNA_FIELDS.length, 8);
});

// ---------------------------------------------------------------------------
// normalizeStyleReference
// ---------------------------------------------------------------------------

test('normalizeStyleReference accepts a valid reference', () => {
  const out = normalizeStyleReference(validRef(), { allowedScreenshotPrefix: PREFIX });
  assert.equal(out.sourceType, 'url');
  assert.equal(out.screenshots.length, 2);
  assert.equal(out.influence, 'strong');
  assert.equal(out.designDna.composition, 'Bold hero, modular grid');
  assert.equal(out.sourceUrl, 'https://example.com');
});

test('normalizeStyleReference drops screenshots outside the tenant prefix', () => {
  const ref = validRef({
    screenshots: [
      { viewport: 'desktop', url: 'https://evil.example.com/injected.jpg' },
      { viewport: 'desktop', url: `${PREFIX.replace('tenant-1', 'tenant-2')}x.jpg` },
      { viewport: 'desktop', url: `${PREFIX}ok.jpg` },
    ],
  });
  const out = normalizeStyleReference(ref, { allowedScreenshotPrefix: PREFIX });
  assert.equal(out.screenshots.length, 1);
  assert.equal(out.screenshots[0].url, `${PREFIX}ok.jpg`);
});

test('normalizeStyleReference returns null when no screenshot survives', () => {
  const ref = validRef({ screenshots: [{ viewport: 'desktop', url: 'https://evil.example.com/x.jpg' }] });
  assert.equal(normalizeStyleReference(ref, { allowedScreenshotPrefix: PREFIX }), null);
  assert.equal(normalizeStyleReference(validRef({ screenshots: [] }), { allowedScreenshotPrefix: PREFIX }), null);
});

test('normalizeStyleReference returns null for missing/invalid input or sourceType', () => {
  assert.equal(normalizeStyleReference(null, { allowedScreenshotPrefix: PREFIX }), null);
  assert.equal(normalizeStyleReference('x', { allowedScreenshotPrefix: PREFIX }), null);
  assert.equal(normalizeStyleReference(validRef({ sourceType: 'evil' }), { allowedScreenshotPrefix: PREFIX }), null);
});

test('normalizeStyleReference caps screenshots and dedupes, defaults influence', () => {
  const shots = Array.from({ length: 8 }, (_, i) => ({ viewport: 'weird', url: `${PREFIX}s${i}.jpg` }));
  shots.push({ viewport: 'desktop', url: `${PREFIX}s0.jpg` }); // dupe
  const out = normalizeStyleReference(validRef({ screenshots: shots, influence: 'bananas' }), { allowedScreenshotPrefix: PREFIX });
  assert.equal(out.screenshots.length, MAX_REFERENCE_SCREENSHOTS);
  assert.equal(out.screenshots[0].viewport, 'desktop'); // unknown viewport coerced
  assert.equal(out.influence, DEFAULT_INFLUENCE);
});

// ---------------------------------------------------------------------------
// Prompt builders + influence variants
// ---------------------------------------------------------------------------

test('buildStyleReferenceSummary returns empty string with no reference', () => {
  assert.equal(buildStyleReferenceSummary(null), '');
  assert.equal(buildStyleReferenceSummary(undefined), '');
});

test('buildStyleReferenceSummary includes DNA, influence and guardrails', () => {
  const ref = normalizeStyleReference(validRef(), { allowedScreenshotPrefix: PREFIX });
  const summaries = INFLUENCE_LEVELS.map((influence) =>
    buildStyleReferenceSummary({ ...ref, influence }));
  for (const s of summaries) {
    assert.match(s, /STYLE REFERENCE/);
    assert.match(s, /Overall composition: Bold hero, modular grid/);
    assert.match(s, /branding.*ALWAYS takes precedence/i);
    assert.match(s, /NEVER copy the reference's text/);
  }
  assert.match(summaries[0], /LIGHT/);
  assert.match(summaries[1], /STRONG/);
  assert.match(summaries[2], /VERY STRONG/);
  assert.equal(new Set(summaries).size, 3);
});

test('styleReferenceImageUrls returns screenshot urls, [] with no ref', () => {
  const ref = normalizeStyleReference(validRef(), { allowedScreenshotPrefix: PREFIX });
  assert.deepEqual(styleReferenceImageUrls(ref), ref.screenshots.map((s) => s.url));
  assert.deepEqual(styleReferenceImageUrls(null), []);
});

// ---------------------------------------------------------------------------
// Byte-identity: no reference ⇒ options and prompts identical to before
// ---------------------------------------------------------------------------

const BRAND = { name: 'Acme Society' };
const PAGE_CTX = { title: 'Home' };

test('normalizeOptions without a reference has no styleReference key', () => {
  const opts = normalizeOptions({ brief: 'x', creativity: 'brand_led' }, { screenshotPrefix: PREFIX });
  assert.equal('styleReference' in opts, false);
  // Invalid reference also stays absent (byte-identity).
  const opts2 = normalizeOptions(
    { styleReference: validRef({ screenshots: [{ url: 'https://evil.example.com/a.jpg' }] }) },
    { screenshotPrefix: PREFIX },
  );
  assert.equal('styleReference' in opts2, false);
  assert.deepEqual(opts, normalizeOptions({ brief: 'x', creativity: 'brand_led' }));
});

test('plan & document prompts are byte-identical without a reference', () => {
  const options = normalizeOptions({}, { screenshotPrefix: PREFIX });
  const plan = buildPlanPrompt({ brief: 'A page', options, brand: BRAND, pageContext: PAGE_CTX, compositionType: 'section' });
  assert.equal(plan.user.includes('STYLE REFERENCE'), false);
  assert.deepEqual(plan.images, []);
  const docP = buildDocumentPrompt({ plan: { sections: [] }, copy: {}, brand: BRAND, compositionType: 'section', brief: 'A page' });
  assert.equal(docP.user.includes('STYLE REFERENCE'), false);
  assert.deepEqual(docP.images, []);
  // And with a reference, both prompts carry the block + image urls.
  const withRef = normalizeOptions({ styleReference: validRef() }, { screenshotPrefix: PREFIX });
  const plan2 = buildPlanPrompt({ brief: 'A page', options: withRef, brand: BRAND, pageContext: PAGE_CTX, compositionType: 'section' });
  assert.match(plan2.user, /STYLE REFERENCE/);
  assert.equal(plan2.images.length, 2);
  const docP2 = buildDocumentPrompt({ plan: { sections: [] }, copy: {}, brand: BRAND, compositionType: 'section', brief: 'A page', styleReference: withRef.styleReference });
  assert.match(docP2.user, /STYLE REFERENCE/);
  assert.equal(docP2.images.length, 2);
  // Identical inputs minus the reference ⇒ identical prompt text.
  const planBaseline = buildPlanPrompt({ brief: 'A page', options: normalizeOptions({}), brand: BRAND, pageContext: PAGE_CTX, compositionType: 'section' });
  assert.equal(plan.user, planBaseline.user);
  assert.equal(plan.system, planBaseline.system);
});
