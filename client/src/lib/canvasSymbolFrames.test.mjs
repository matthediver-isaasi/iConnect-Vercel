// Task #3465 — symbol mobile/tablet frame normalization.
// Symbols saved from a selection historically translated only the DESKTOP
// frame to the symbol-local origin; tablet/mobile overrides were copied
// verbatim with page-absolute coordinates, so instances rendered the desktop
// layout at those breakpoints. These tests cover the shared normalizer plus
// its integration into extent measurement and symbol resolution.
// Run with: node --test client/src/lib/canvasSymbolFrames.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSymbolDesignFrames,
  symbolContentExtent,
  resolveSymbolsInDesign,
  resolveBlockAtBreakpoint,
  BLOCK_TYPES,
} from './canvasDesign.js';

const design = (children) => ({
  version: 1,
  root: { background: null, sections: [{ id: 'root-section', children }] },
});

const kidsOf = (d) => d?.root?.sections?.[0]?.children || [];

test('translates every breakpoint by its own bounding origin', () => {
  const d = design([
    {
      id: 'a', type: 'text',
      bp: {
        desktop: { x: 100, y: 200, w: 300, h: 50 },
        mobile: { x: 20, y: 500, w: 335, h: 60 },
      },
    },
    {
      id: 'b', type: 'text',
      bp: {
        desktop: { x: 400, y: 250, w: 300, h: 50 },
        mobile: { x: 20, y: 580, w: 335, h: 60 },
      },
    },
  ]);
  const out = normalizeSymbolDesignFrames(d);
  const [a, b] = kidsOf(out);
  // Desktop translated by desktop origin (100, 200)
  assert.deepEqual([a.bp.desktop.x, a.bp.desktop.y], [0, 0]);
  assert.deepEqual([b.bp.desktop.x, b.bp.desktop.y], [300, 50]);
  // Mobile translated by MOBILE origin (20, 500), not the desktop one
  assert.deepEqual([a.bp.mobile.x, a.bp.mobile.y], [0, 0]);
  assert.deepEqual([b.bp.mobile.x, b.bp.mobile.y], [0, 80]);
  // w/h untouched
  assert.equal(a.bp.mobile.w, 335);
});

test('frames without explicit x/y keep cascading from desktop', () => {
  const d = design([
    {
      id: 'a', type: 'text',
      bp: {
        desktop: { x: 100, y: 200, w: 300, h: 50 },
        // mobile override for size only — no explicit x/y
        mobile: { w: 335, h: 60 },
      },
    },
    {
      id: 'b', type: 'text',
      bp: {
        desktop: { x: 150, y: 300, w: 300, h: 50 },
        mobile: { x: 40, y: 700, w: 335, h: 60 },
      },
    },
  ]);
  const out = normalizeSymbolDesignFrames(d);
  const [a, b] = kidsOf(out);
  // a's mobile frame carries no x/y — untouched, so resolveBlockAtBreakpoint
  // cascades from the translated desktop frame.
  assert.equal(a.bp.mobile.x, undefined);
  assert.equal(a.bp.mobile.y, undefined);
  const g = resolveBlockAtBreakpoint(a, 'mobile');
  assert.deepEqual([g.x, g.y, g.w, g.h], [0, 0, 335, 60]);
  // b's explicit mobile frame translated by the mobile origin (40, 700)
  assert.deepEqual([b.bp.mobile.x, b.bp.mobile.y], [0, 0]);
});

test('idempotent: correctly saved symbols are untouched', () => {
  const d = design([
    {
      id: 'a', type: 'text',
      bp: {
        desktop: { x: 0, y: 0, w: 300, h: 50 },
        tablet: { x: 0, y: 0, w: 200, h: 50 },
        mobile: { x: 0, y: 0, w: 100, h: 50 },
      },
    },
    {
      id: 'b', type: 'text',
      bp: {
        desktop: { x: 50, y: 100, w: 300, h: 50 },
        mobile: { x: 10, y: 60, w: 100, h: 50 },
      },
    },
  ]);
  const once = normalizeSymbolDesignFrames(d);
  const twice = normalizeSymbolDesignFrames(once);
  assert.deepEqual(kidsOf(twice).map((c) => c.bp), kidsOf(once).map((c) => c.bp));
  // Origins already at 0 — frames unchanged from input
  assert.deepEqual(kidsOf(once)[1].bp.mobile, { x: 10, y: 60, w: 100, h: 50 });
});

test('symbolContentExtent measures re-origined tablet/mobile frames', () => {
  // Legacy symbol: desktop translated, mobile page-absolute.
  const d = design([
    {
      id: 'a', type: 'text',
      bp: {
        desktop: { x: 0, y: 0, w: 300, h: 50 },
        mobile: { x: 20, y: 900, w: 335, h: 60 },
      },
    },
  ]);
  assert.deepEqual(symbolContentExtent(d, 'desktop'), { w: 300, h: 50 });
  // Without normalization this would be 355 x 960; re-origined it wraps content.
  assert.deepEqual(symbolContentExtent(d, 'mobile'), { w: 335, h: 60 });
});

test('resolveSymbolsInDesign offsets re-origined frames by the host per breakpoint', () => {
  const symDesign = design([
    {
      id: 'child', type: 'text',
      bp: {
        desktop: { x: 0, y: 0, w: 300, h: 50 },
        // legacy page-absolute mobile frame
        mobile: { x: 20, y: 800, w: 335, h: 60 },
      },
    },
  ]);
  const page = design([
    {
      id: 'host', type: BLOCK_TYPES.SYMBOL,
      content: { symbolId: 'sym-1' },
      bp: {
        desktop: { x: 100, y: 400, w: 600, h: 240 },
        mobile: { x: 10, y: 1000, w: 355, h: 240 },
      },
    },
  ]);
  const symbolsById = new Map([['sym-1', { id: 'sym-1', design: symDesign }]]);
  const resolved = resolveSymbolsInDesign(page, symbolsById);
  const host = kidsOf(resolved)[0];
  assert.ok(Array.isArray(host.__symbolChildren));
  const child = host.__symbolChildren[0];
  // Desktop: local 0 + host 100/400
  assert.deepEqual([child.bp.desktop.x, child.bp.desktop.y], [100, 400]);
  // Mobile: legacy frame re-origined to local (0,0) then offset by the
  // host's mobile position — NOT 20+10 / 800+1000.
  assert.deepEqual([child.bp.mobile.x, child.bp.mobile.y], [10, 1000]);
  assert.deepEqual([child.bp.mobile.w, child.bp.mobile.h], [335, 60]);
  // Host box fitted to the content extent per breakpoint
  assert.deepEqual([host.bp.mobile.w, host.bp.mobile.h], [335, 60]);
});
