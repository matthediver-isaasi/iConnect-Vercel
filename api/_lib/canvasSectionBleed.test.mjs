// Task #3154 — Section left/right directional bleed.
//
// Sections can bleed to only ONE viewport edge (content.bleed =
// 'left'|'right') while the other side stays at the centered page column.
// Legacy docs carry only the boolean content.fullBleed, which must keep
// rendering byte-identically. These tests lock in:
//  - getBlockBleed precedence (bleed key wins over fullBleed; directional
//    values only honoured on Sections),
//  - geomRule output via buildCanvasCss for full/left/right,
//  - setBlockContentBleed snapshot-on-release semantics and the
//    "don't add a bleed key unless needed" doc-stability rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_TYPES,
  BREAKPOINT_WIDTHS,
  buildCanvasCss,
  createBlock,
  getBlockBleed,
  blockIsFullWidthLike,
  setBlockContentBleed,
  setBlockContentFullBleed,
  resolveBlockAtBreakpoint,
} from '../../client/src/lib/canvasDesign.js';

function section(content = {}, geom = {}) {
  const b = createBlock(BLOCK_TYPES.SECTION, { desktop: { x: 100, y: 50, w: 600, h: 240, ...geom } });
  b.content = { ...b.content, ...content };
  return b;
}

function ruleFor(css, id) {
  const m = css.match(new RegExp(`\\[data-cb="${id}"\\]\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

test('getBlockBleed: legacy boolean and new key precedence', () => {
  assert.equal(getBlockBleed(section()), null);
  assert.equal(getBlockBleed(section({ fullBleed: true })), 'full');
  assert.equal(getBlockBleed(section({ bleed: 'left' })), 'left');
  assert.equal(getBlockBleed(section({ bleed: 'right' })), 'right');
  assert.equal(getBlockBleed(section({ bleed: 'full' })), 'full');
  // Explicit 'off' wins over a stale fullBleed boolean.
  assert.equal(getBlockBleed(section({ bleed: 'off', fullBleed: true })), null);
  // Directional degrades to 'full' on non-section full-bleed types.
  const hero = createBlock(BLOCK_TYPES.HERO);
  hero.content = { ...hero.content, bleed: 'left' };
  assert.equal(getBlockBleed(hero), 'full');
  // Unsupported types never bleed.
  const text = createBlock(BLOCK_TYPES.TEXT);
  text.content = { ...text.content, bleed: 'left', fullBleed: true };
  assert.equal(getBlockBleed(text), null);
});

test('directional bleed pins editor geometry like full bleed', () => {
  assert.equal(blockIsFullWidthLike(section({ bleed: 'left' })), true);
  assert.equal(blockIsFullWidthLike(section({ bleed: 'right' })), true);
  assert.equal(blockIsFullWidthLike(section({ fullBleed: true })), true);
  assert.equal(blockIsFullWidthLike(section()), false);
});

test('buildCanvasCss: full bleed via new key is byte-identical to legacy boolean', () => {
  const legacy = section({ fullBleed: true });
  const modern = section({ bleed: 'full', fullBleed: true });
  modern.id = legacy.id;
  assert.equal(buildCanvasCss([legacy], '#s'), buildCanvasCss([modern], '#s'));
});

test('buildCanvasCss: left bleed emits asymmetric breakout', () => {
  const b = section({ bleed: 'left' });
  const rule = ruleFor(buildCanvasCss([b], '#s'), b.id);
  assert.ok(rule.includes('left:calc(50% - 50vw);'));
  assert.ok(rule.includes('width:calc(50% + 50vw);'));
  assert.ok(!rule.includes('transform'));
});

test('buildCanvasCss: right bleed anchors left edge at the stage', () => {
  const b = section({ bleed: 'right' });
  const rule = ruleFor(buildCanvasCss([b], '#s'), b.id);
  assert.ok(rule.includes('left:0;'));
  assert.ok(rule.includes('width:calc(50% + 50vw);'));
});

test('buildCanvasCss: non-bleed section unchanged', () => {
  const b = section();
  const rule = ruleFor(buildCanvasCss([b], '#s'), b.id);
  assert.ok(rule.includes('left:100px;'));
  assert.ok(rule.includes('width:600px;'));
});

test('setBlockContentBleed: turning off snapshots the pinned frame', () => {
  const on = setBlockContentBleed(section(), 'desktop', 'left');
  assert.equal(getBlockBleed(on), 'left');
  assert.equal(on.content.fullBleed, false);
  const off = setBlockContentBleed(on, 'desktop', 'off');
  assert.equal(getBlockBleed(off), null);
  const g = resolveBlockAtBreakpoint(off, 'desktop');
  assert.equal(g.x, 0);
  assert.equal(g.w, BREAKPOINT_WIDTHS.desktop);
});

test('setBlockContentBleed: switching between non-off directions keeps stored frames', () => {
  const left = setBlockContentBleed(section(), 'desktop', 'left');
  const full = setBlockContentBleed(left, 'desktop', 'full');
  assert.equal(getBlockBleed(full), 'full');
  assert.equal(full.content.fullBleed, true);
  // Underlying STORED frame untouched (pin is display-only until release;
  // resolveBlockAtBreakpoint reports the pinned x=0 while bleed is on).
  assert.equal(full.bp.desktop.x, 100);
  assert.equal(resolveBlockAtBreakpoint(full, 'desktop').x, 0);
});

test('setBlockContentFullBleed: does not introduce a bleed key on legacy docs', () => {
  const hero = createBlock(BLOCK_TYPES.HERO);
  const on = setBlockContentFullBleed(hero, 'desktop', true);
  assert.ok(!('bleed' in on.content));
  assert.equal(on.content.fullBleed, true);
  const off = setBlockContentFullBleed(on, 'desktop', false);
  assert.ok(!('bleed' in off.content));
  assert.equal(off.content.fullBleed, false);
  // But once a doc HAS the key, the boolean toggle keeps it in sync.
  const dir = setBlockContentBleed(section(), 'desktop', 'right');
  const cleared = setBlockContentFullBleed(dir, 'desktop', false);
  assert.equal(cleared.content.bleed, 'off');
  assert.equal(getBlockBleed(cleared), null);
});
