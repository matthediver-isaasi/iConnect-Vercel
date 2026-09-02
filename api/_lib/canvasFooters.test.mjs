import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseEffectiveFooterSelection, normalizeCanvasFooterDesign } from './canvasFooters.js';
import { buildTenantBrandingPayload } from './tenantBranding.js';

test('legacy main site remains configured', () => {
  assert.deepEqual(chooseEffectiveFooterSelection({ id: 'tenant-1' }), {
    source: 'configured',
    footerId: null,
  });
});

test('microsite inheritance follows the main Canvas footer', () => {
  assert.deepEqual(
    chooseEffectiveFooterSelection(
      { footer_source: 'canvas', canvas_footer_id: 'footer-1' },
      { footer_source: 'inherit', canvas_footer_id: 'footer-2' },
    ),
    { source: 'canvas', footerId: 'footer-1' },
  );
});

test('configured microsite ignores retained Canvas assignment', () => {
  assert.deepEqual(
    chooseEffectiveFooterSelection(
      { footer_source: 'canvas', canvas_footer_id: 'footer-1' },
      { footer_source: 'configured', canvas_footer_id: 'footer-2' },
    ),
    { source: 'configured', footerId: null },
  );
});

test('normalizer rejects malformed roots and repairs missing sections', () => {
  assert.equal(normalizeCanvasFooterDesign(null), null);
  assert.deepEqual(normalizeCanvasFooterDesign({ version: 1, root: {} }).root.sections, []);
});

test('branding payload carries the resolved footer without changing legacy config', () => {
  const configured = { columns: 4, legalText: 'Keep me' };
  const footer = { id: 'footer-1', name: 'Main', design: { version: 1, root: { sections: [] } } };
  const payload = buildTenantBrandingPayload(
    { id: 'tenant-1', name: 'Tenant', footer_config: configured },
    null,
    { source: 'canvas', footer },
  );
  assert.deepEqual(payload.footerConfig, configured);
  assert.equal(payload.footerSource, 'canvas');
  assert.deepEqual(payload.canvasFooter, footer);
});

test('microsite inherit uses the main configured footer and keeps overrides dormant', () => {
  const tenantFooter = { legalText: 'Main', columns: 4 };
  const payload = buildTenantBrandingPayload(
    { id: 'tenant-1', name: 'Tenant', footer_config: tenantFooter },
    { id: 'ms-1', footer_source: 'inherit', footer_config: { legalText: 'Dormant override' } },
    { source: 'configured', footer: null },
  );
  assert.deepEqual(payload.footerConfig, tenantFooter);
});