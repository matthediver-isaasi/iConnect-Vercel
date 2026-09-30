import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickResponsiveTypoValue,
  hasResponsiveTypographyOverride,
  buildTenantTypographyResponsiveCss,
  buildTextResponsiveTypographyCss,
  textTypographySelector,
  TEXT_ROOT_ATTR,
  TEXT_ROOT_VALUE,
} from './canvasTypographyResponsive.js';
import { BREAKPOINT_MAX_PX } from './canvasDesign.js';

const H2_HERO = {
  font_size: 55,
  font_size_tablet: null,
  font_size_mobile: 30,
  line_height: 1.2,
  margin_bottom: 24,
};

test('pickResponsiveTypoValue cascades mobile -> tablet -> desktop', () => {
  assert.equal(pickResponsiveTypoValue(H2_HERO, 'font_size', 'desktop'), 55);
  // mobile set, tablet null: mobile wins at mobile, desktop at tablet
  assert.equal(pickResponsiveTypoValue(H2_HERO, 'font_size', 'mobile'), 30);
  assert.equal(pickResponsiveTypoValue(H2_HERO, 'font_size', 'tablet'), 55);
  // no breakpoint (legacy callers) falls back to desktop
  assert.equal(pickResponsiveTypoValue(H2_HERO, 'font_size', undefined), 55);
});

test('hasResponsiveTypographyOverride detects a mobile-only font size', () => {
  assert.equal(hasResponsiveTypographyOverride(H2_HERO), true);
  assert.equal(hasResponsiveTypographyOverride({ font_size: 55 }), false);
  assert.equal(
    hasResponsiveTypographyOverride({ font_size: 55, font_size_mobile: 55 }),
    false,
  );
  assert.equal(hasResponsiveTypographyOverride(null), false);
});

test('mobile-only override emits only a mobile @media block with !important', () => {
  const css = buildTenantTypographyResponsiveCss('[data-cb="b1"] [data-tg-r="text-root"]', H2_HERO);
  assert.ok(css.includes(`@media (max-width:${BREAKPOINT_MAX_PX.mobile}px)`));
  assert.ok(css.includes('font-size:30px !important;'));
  assert.ok(!css.includes(`@media (max-width:${BREAKPOINT_MAX_PX.tablet}px)`));
});

test('tablet + mobile overrides emit both blocks; mobile only when it differs from tablet', () => {
  const style = { font_size: 40, font_size_tablet: 32, font_size_mobile: 32 };
  const css = buildTenantTypographyResponsiveCss('[data-x]', style);
  assert.ok(css.includes(`@media (max-width:${BREAKPOINT_MAX_PX.tablet}px){[data-x]{font-size:32px !important;}}`));
  // mobile equals the effective tablet value -> no mobile block
  assert.ok(!css.includes(`@media (max-width:${BREAKPOINT_MAX_PX.mobile}px)`));
});

// Task #2839 regression: the Text block's responsive rules MUST target the
// element that carries the inline desktop typography style, not the bare
// [data-cb] wrapper. An !important rule on the wrapper cannot beat the inner
// element's inline font-size (inline beats inherited values), and
// margin-bottom does not inherit at all — so a wrapper-only selector means
// public visitors keep the desktop size on phones.
test('Text block selector targets the tagged inner element, never the bare wrapper', () => {
  const sel = textTypographySelector('blk-1');
  assert.equal(sel, `[data-cb="blk-1"] [${TEXT_ROOT_ATTR}="${TEXT_ROOT_VALUE}"]`);

  const css = buildTextResponsiveTypographyCss('blk-1', H2_HERO);
  assert.ok(css.includes(sel));
  // The rule block must not apply to the wrapper element itself.
  assert.ok(!css.includes('[data-cb="blk-1"]{'));
});

test('Text block selector escapes quotes/backslashes in block ids', () => {
  const sel = textTypographySelector('a"b\\c');
  assert.ok(!sel.includes('"a"b'));
  assert.equal(sel, `[data-cb="abc"] [${TEXT_ROOT_ATTR}="${TEXT_ROOT_VALUE}"]`);
});

test('buildTextResponsiveTypographyCss returns null without style or id', () => {
  assert.equal(buildTextResponsiveTypographyCss(null, H2_HERO), null);
  assert.equal(buildTextResponsiveTypographyCss('b1', null), null);
});

test('all four properties are emitted with their units at mobile', () => {
  const style = {
    font_size: 20, font_size_mobile: 16,
    line_height: 1.5, line_height_mobile: 1.3,
    letter_spacing: 1, letter_spacing_mobile: 0.5,
    margin_bottom: 24, margin_bottom_mobile: 12,
  };
  const css = buildTenantTypographyResponsiveCss('[data-x]', style);
  assert.ok(css.includes('font-size:16px !important;'));
  assert.ok(css.includes('line-height:1.3 !important;'));
  assert.ok(css.includes('letter-spacing:0.5px !important;'));
  assert.ok(css.includes('margin-bottom:12px !important;'));
});

test('table typography rules can target the semantic header and cell elements', () => {
  const headerSelector = '[data-cb="table-1"] [data-tg-r="table-header"]';
  const cellSelector = '[data-cb="table-1"] [data-tg-r="table-cell"]';
  const headerCss = buildTenantTypographyResponsiveCss(headerSelector, H2_HERO);
  const cellCss = buildTenantTypographyResponsiveCss(cellSelector, H2_HERO);
  assert.ok(headerCss.includes(headerSelector));
  assert.ok(cellCss.includes(cellSelector));
  assert.ok(!headerCss.includes('[data-cb="table-1"]{'));
});
