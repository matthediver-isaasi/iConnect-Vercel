import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MAIN_SITE_SCOPE,
  buildCanvasFooterCreatePayload,
  canvasFooterScopeId,
} from './canvasFooterScope.js';

test('main-site footer payload has no microsite assignment', () => {
  assert.deepEqual(buildCanvasFooterCreatePayload({
    name: 'Main footer',
    design: { version: 1 },
    siteId: MAIN_SITE_SCOPE,
    assignToMicrosite: true,
  }), {
    name: 'Main footer',
    design: { version: 1 },
    microsite_id: null,
    assign_to_microsite: false,
  });
});

test('new microsite footer payload requests the live assignment', () => {
  assert.deepEqual(buildCanvasFooterCreatePayload({
    name: 'Summit footer',
    design: { version: 1 },
    siteId: 'microsite-1',
    assignToMicrosite: true,
  }), {
    name: 'Summit footer',
    design: { version: 1 },
    microsite_id: 'microsite-1',
    assign_to_microsite: true,
  });
});

test('duplicating preserves microsite context without replacing the live footer', () => {
  assert.equal(canvasFooterScopeId({ microsite_id: 'microsite-1' }), 'microsite-1');
  assert.deepEqual(buildCanvasFooterCreatePayload({
    name: 'Summit footer copy',
    design: { version: 1 },
    siteId: canvasFooterScopeId({ microsite_id: 'microsite-1' }),
    assignToMicrosite: false,
  }).assign_to_microsite, false);
});

test('footer UI passes microsite context into builder and previews', () => {
  const manager = fs.readFileSync(new URL('../pages/CanvasFooterManagement.jsx', import.meta.url), 'utf8');
  const editor = fs.readFileSync(new URL('../pages/CanvasFooterEditor.jsx', import.meta.url), 'utf8');
  const renderer = fs.readFileSync(new URL('../components/canvas/CanvasPageRenderer.jsx', import.meta.url), 'utf8');

  assert.match(manager, /data-testid="select-canvas-footer-site"/);
  assert.match(editor, /<CanvasBuilder[^>]+micrositeId=\{footer\.microsite_id\}/);
  assert.match(editor, /<CanvasPageRenderer[^>]+micrositeId=\{footer\.microsite_id\}/);
  assert.match(renderer, /<CanvasEditorPageProvider micrositeId=\{micrositeId\}>/);
});

test('database migration creates an atomic, tenant-validated assignment path', () => {
  const migration = fs.readFileSync(
    new URL('../../../supabase/migrations/20260902_reusable_footer_microsite_context.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS microsite_id uuid/);
  assert.match(migration, /m\.tenant_id::text = p_tenant_id/);
  assert.match(migration, /SET footer_source = 'canvas'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_canvas_footer_for_context/);
});

test('server requires microsite-management access before assigning a scoped footer', () => {
  const endpoint = fs.readFileSync(
    new URL('../../../api/admin/canvas-footers/index.js', import.meta.url),
    'utf8',
  );
  assert.match(endpoint, /hasFeatureAccess\(context\.roleId, 'site-builder\.micro-sites'\)/);
  assert.match(endpoint, /if \(micrositeId && !await canManageMicrosites\(context\)\)/);
  assert.match(endpoint, /\^PGRST/);
  assert.match(endpoint, /delete payload\.microsite_id/);
});