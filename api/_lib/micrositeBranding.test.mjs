import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  mergeMicrositeConfig,
  sanitizeMicrositeBrandingConfig,
  micrositeBrandingValue,
  MICROSITE_BRANDING_KEYS,
  validateMicrositeHeaderLogoConfig,
  resolveMicrositeHeaderConfigUpdate,
} from './microsites.js';

/**
 * Regression coverage for the per-microsite branding override plumbing
 * (Task #2525). These helpers are the shared merge/sanitize layer used by
 * BOTH public surfaces — /api/public/tenant-branding (client chrome) and
 * api/_lib/renderHtml.js (SSR link previews) — so the tests below encode the
 * inherit-by-default contract: a key the microsite leaves unset must fall
 * back to the tenant value on every surface.
 */

// --- mergeMicrositeConfig: per-key inherit semantics -------------------------

test('merge: microsite keys override, unset keys inherit from tenant', () => {
  const tenant = { gradientStops: [{ color: '#111111', position: 0 }], loginLink: { label: 'Login' }, other: 'keep' };
  const ms = { gradientStops: [{ color: '#222222', position: 0 }] };
  const out = mergeMicrositeConfig(tenant, ms);
  assert.deepEqual(out.gradientStops, [{ color: '#222222', position: 0 }]);
  assert.deepEqual(out.loginLink, { label: 'Login' }); // inherited
  assert.equal(out.other, 'keep');
});

test('merge: empty microsite values do NOT clobber tenant values', () => {
  const tenant = { textColor: '#FFFFFF', gradientStops: [{ color: '#111111', position: 0 }], secondaryBar: { enabled: true } };
  const ms = { textColor: '', gradientStops: [], secondaryBar: {} };
  const out = mergeMicrositeConfig(tenant, ms);
  assert.equal(out.textColor, '#FFFFFF');
  assert.deepEqual(out.gradientStops, [{ color: '#111111', position: 0 }]);
  assert.deepEqual(out.secondaryBar, { enabled: true });
});

test('merge: boolean false is a real override (explicitly disabled bar)', () => {
  const tenant = { secondaryBar: { enabled: true, textColor: '#FFFFFF' } };
  const ms = { secondaryBar: { enabled: false } };
  const out = mergeMicrositeConfig(tenant, ms);
  // secondaryBar is replaced whole-object, so an explicit "off" wins.
  assert.deepEqual(out.secondaryBar, { enabled: false });
});

test('merge: footer keys override independently (per-card inherit)', () => {
  const tenantFooter = {
    columns: 4,
    backgroundColor: '#000000',
    textColor: '#FFFFFF',
    address: { name: 'Tenant HQ', lines: ['1 Tenant Way'] },
    legalText: '(c) Tenant',
  };
  const msFooter = {
    backgroundColor: '#101010',
    address: { name: 'Microsite Office', lines: ['2 Microsite Rd'] },
  };
  const out = mergeMicrositeConfig(tenantFooter, msFooter);
  assert.equal(out.backgroundColor, '#101010'); // overridden
  assert.deepEqual(out.address, { name: 'Microsite Office', lines: ['2 Microsite Rd'] }); // overridden
  assert.equal(out.columns, 4); // inherited
  assert.equal(out.textColor, '#FFFFFF'); // inherited
  assert.equal(out.legalText, '(c) Tenant'); // inherited
});

test('merge: tolerates null/undefined configs on either side', () => {
  assert.deepEqual(mergeMicrositeConfig(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeMicrositeConfig({ a: 1 }, null), { a: 1 });
  assert.deepEqual(mergeMicrositeConfig(null, null), {});
});

// --- Header logo dimensions / scroll shrink ---------------------------------

test('header logo config normalizes valid dimensions and preserves explicit false', () => {
  const result = validateMicrositeHeaderLogoConfig({
    logoHeight: '160',
    logoWidth: 240,
    logoShrinkOnScroll: false,
    logoScrolledHeight: '80',
  });
  assert.deepEqual(result, {
    ok: true,
    values: {
      logoHeight: 160,
      logoWidth: 240,
      logoScrolledHeight: 80,
      logoShrinkOnScroll: false,
    },
  });
});

test('header logo config rejects non-positive and non-numeric dimensions', () => {
  for (const bad of ['-1', '0', '12.5', '120px', Number.NaN]) {
    const result = validateMicrositeHeaderLogoConfig({ logoHeight: bad });
    assert.equal(result.ok, false, `expected ${String(bad)} to be rejected`);
  }
});

test('header logo config rejects a scrolled height above local or inherited full height', () => {
  assert.equal(validateMicrositeHeaderLogoConfig({
    logoHeight: 100,
    logoScrolledHeight: 101,
  }).ok, false);
  assert.equal(validateMicrositeHeaderLogoConfig({
    logoScrolledHeight: 121,
  }, {
    logoHeight: 120,
  }).ok, false);
  assert.equal(validateMicrositeHeaderLogoConfig({
    logoScrolledHeight: 159,
  }).ok, false);
});

test('header logo config keeps empty dimensions as inherited values', () => {
  assert.deepEqual(validateMicrositeHeaderLogoConfig({
    logoHeight: '',
    logoWidth: null,
    logoShrinkOnScroll: true,
    logoScrolledHeight: undefined,
  }), {
    ok: true,
    values: {
      logoHeight: null,
      logoWidth: null,
      logoScrolledHeight: null,
      logoShrinkOnScroll: true,
    },
  });
});

test('microsite editor exposes and persists every header logo control', () => {
  const source = readFileSync(
    new URL('../../client/src/components/microsites/MicrositeChromeEditor.jsx', import.meta.url),
    'utf8',
  );
  for (const marker of [
    'input-ms-header-logo-height',
    'input-ms-header-logo-width',
    'switch-ms-logo-shrink-on-scroll',
    'input-ms-header-logo-scrolled-height',
    'validateMicrositeHeaderLogoConfig',
  ]) {
    assert.match(source, new RegExp(marker));
  }
  assert.match(source, /delete headerOut\[key\]/);
  assert.match(source, /replace_header_config:\s*true/);
});

test('partial header config updates preserve unrelated settings unless replacement is explicit', () => {
  const existing = {
    gradientStops: [{ color: '#123456', position: 0 }],
    secondaryBar: { enabled: true },
    logoHeight: 120,
  };
  assert.deepEqual(resolveMicrositeHeaderConfigUpdate(existing, { logoWidth: 240 }), {
    ...existing,
    logoWidth: 240,
  });
  assert.deepEqual(resolveMicrositeHeaderConfigUpdate(existing, { logoWidth: 240 }, true), {
    logoWidth: 240,
  });
});

test('partial header config can clear shrink back to inheritance without losing unrelated settings', () => {
  const existing = {
    gradientStops: [{ color: '#123456', position: 0 }],
    logoShrinkOnScroll: true,
    logoScrolledHeight: 80,
  };
  const updated = resolveMicrositeHeaderConfigUpdate(existing, {
    logoShrinkOnScroll: null,
  });
  assert.deepEqual(updated, {
    gradientStops: existing.gradientStops,
    logoScrolledHeight: 80,
  });
  assert.equal(validateMicrositeHeaderLogoConfig(updated).ok, true);
  assert.deepEqual(validateMicrositeHeaderLogoConfig({ logoShrinkOnScroll: null }), {
    ok: true,
    values: {
      logoHeight: null,
      logoWidth: null,
      logoScrolledHeight: null,
    },
  });
});

// --- sanitizeMicrositeBrandingConfig -----------------------------------------

test('sanitize: keeps only whitelisted, non-empty string keys (trimmed)', () => {
  const out = sanitizeMicrositeBrandingConfig({
    primary_color: '  #AB00CD ',
    tagline: 'A tagline',
    description: '',
    logo_url: null,
    social_image_url: 42,
    not_a_real_key: 'evil',
    socialIconCustomSvgs: { x: '<svg/>' }, // tenant-only, must be dropped
  });
  assert.deepEqual(out, { primary_color: '#AB00CD', tagline: 'A tagline' });
});

test('sanitize: non-object input yields empty object', () => {
  assert.deepEqual(sanitizeMicrositeBrandingConfig(null), {});
  assert.deepEqual(sanitizeMicrositeBrandingConfig('str'), {});
  assert.deepEqual(sanitizeMicrositeBrandingConfig(['a']), {});
});

test('sanitize: every whitelisted key round-trips', () => {
  const input = Object.fromEntries(MICROSITE_BRANDING_KEYS.map((k) => [k, `v-${k}`]));
  assert.deepEqual(sanitizeMicrositeBrandingConfig(input), input);
});

// --- micrositeBrandingValue: override-or-inherit used by BOTH public surfaces

test('brandingValue: set key returns override, unset returns null (inherit)', () => {
  const microsite = { branding_config: { tagline: ' Microsite tagline ', description: '' } };
  assert.equal(micrositeBrandingValue(microsite, 'tagline'), 'Microsite tagline');
  assert.equal(micrositeBrandingValue(microsite, 'description'), null); // empty -> inherit
  assert.equal(micrositeBrandingValue(microsite, 'social_image_url'), null); // unset -> inherit
  assert.equal(micrositeBrandingValue(null, 'tagline'), null); // no microsite
  assert.equal(micrositeBrandingValue({ branding_config: null }, 'tagline'), null);
});

// --- SSR / tenant-branding parity --------------------------------------------
// Both surfaces resolve each field as: microsite override -> tenant value.
// renderHtml.js additionally documents that a microsite TAGLINE override must
// never displace an existing tenant DESCRIPTION. These tests pin that
// resolution order using the same helper both surfaces call.

function resolveField(microsite, tenantValue, key) {
  return micrositeBrandingValue(microsite, key) || tenantValue || null;
}

test('parity: description resolves override-first, tenant fallback', () => {
  const ms = { branding_config: { description: 'MS description' } };
  assert.equal(resolveField(ms, 'Tenant description', 'description'), 'MS description');
  assert.equal(resolveField({ branding_config: {} }, 'Tenant description', 'description'), 'Tenant description');
});

test('parity: SSR description ignores tagline override when tenant description exists', () => {
  // Mirrors renderHtml.js: msDescription || tenant.description || effectiveTagline
  const ms = { branding_config: { tagline: 'MS tagline only' } };
  const msDescription = micrositeBrandingValue(ms, 'description');
  const tenantDescription = 'Tenant description';
  const effectiveTagline = micrositeBrandingValue(ms, 'tagline') || 'Tenant tagline';
  const resolved = msDescription || tenantDescription || effectiveTagline;
  assert.equal(resolved, 'Tenant description');
});

test('parity: social image falls back microsite logo -> tenant image', () => {
  // Mirrors renderHtml.js: msSocialImage || msLogo || tenant.social_image_url
  const ms = { branding_config: { logo_url: 'https://cdn/ms-logo.png' }, logo_url: null };
  const msSocialImage = micrositeBrandingValue(ms, 'social_image_url');
  const msLogo = micrositeBrandingValue(ms, 'logo_url') || ms.logo_url || null;
  assert.equal(msSocialImage, null);
  assert.equal(msSocialImage || msLogo || 'https://cdn/tenant.png', 'https://cdn/ms-logo.png');
});
