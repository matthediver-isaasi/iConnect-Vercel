// Icon-only Button helpers (Task #3167).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFaIconName,
  sanitizeFaIconClass,
  resolveStoredIconName,
  readIconOnly,
  buildIconOnlyAnchorStyle,
  resolveIconOnlyAriaLabel,
} from './canvasButtonIcon.js';

test('resolveStoredIconName: Lucide names pass through, FA classes survive, junk drops', () => {
  assert.equal(resolveStoredIconName('arrow-right'), 'arrow-right');
  assert.equal(resolveStoredIconName('ArrowRight'), 'ArrowRight');
  assert.equal(resolveStoredIconName('fa-solid fa-star'), 'fa-solid fa-star');
  assert.equal(resolveStoredIconName('fas fa-star'), 'fas fa-star');
  // Legacy bare fa- token gets a solid style prefix.
  assert.equal(resolveStoredIconName('fa-star'), 'fa-solid fa-star');
  // Single-token Lucide names that start like FA styles stay Lucide.
  assert.equal(resolveStoredIconName('factory'), 'factory');
  for (const v of ['', null, undefined, '  ', '<script>', 'fa-solid onclick=x']) {
    assert.equal(resolveStoredIconName(v), v === 'fa-solid onclick=x' ? '' : '');
  }
});

test('isFaIconName / sanitizeFaIconClass: multi-token FA only, injection stripped', () => {
  assert.equal(isFaIconName('fa-solid fa-star'), true);
  assert.equal(isFaIconName('fa-star'), false); // single token
  assert.equal(isFaIconName('factory'), false);
  assert.equal(sanitizeFaIconClass('fa-solid fa-star evil-class'), 'fa-solid fa-star');
});

test('readIconOnly: strict-true gating; circle only when icon-only is on', () => {
  assert.deepEqual(readIconOnly({}), { iconOnly: false, circle: false });
  assert.deepEqual(readIconOnly(null), { iconOnly: false, circle: false });
  assert.deepEqual(readIconOnly({ iconOnly: 1, iconShape: 'circle' }), { iconOnly: false, circle: false });
  assert.deepEqual(readIconOnly({ iconOnly: true }), { iconOnly: true, circle: false });
  assert.deepEqual(readIconOnly({ iconOnly: true, iconShape: 'circle' }), { iconOnly: true, circle: true });
  // circle is never reported when icon-only is off (legacy byte-identity).
  assert.deepEqual(readIconOnly({ iconShape: 'circle' }), { iconOnly: false, circle: false });
});

test('buildIconOnlyAnchorStyle: symmetric padding on all four sides, fills box', () => {
  const s = buildIconOnlyAnchorStyle('12px', false);
  assert.equal(s.paddingTop, '12px');
  assert.equal(s.paddingBottom, '12px');
  assert.equal(s.paddingLeft, '12px');
  assert.equal(s.paddingRight, '12px');
  // No max-content label growth — the anchor fills the stored block box.
  assert.equal(s.width, '100%');
  assert.equal(s.minWidth, '100%');
  assert.equal('borderRadius' in s, false); // square keeps the variant radius
  // CSS var padding values (public path) pass through untouched.
  assert.equal(buildIconOnlyAnchorStyle('var(--cb-btn-py, 10px)', false).paddingLeft, 'var(--cb-btn-py, 10px)');
});

test('buildIconOnlyAnchorStyle: circle shape wins over the variant radius', () => {
  assert.equal(buildIconOnlyAnchorStyle('8px', true).borderRadius, '9999px');
});

test('buildIconOnlyAnchorStyle: fillBox:false (embedded CTAs) sizes to the icon', () => {
  // Card/Hero CTAs (Task #3174): symmetric padding but NO width stretch —
  // the intrinsic inline-flex anchor stays a natural square around the icon.
  const s = buildIconOnlyAnchorStyle('12px', true, { fillBox: false });
  assert.equal(s.paddingLeft, '12px');
  assert.equal(s.paddingRight, '12px');
  assert.equal('width' in s, false);
  assert.equal('minWidth' in s, false);
  assert.equal(s.borderRadius, '9999px');
  // Default stays fillBox:true for the standalone Button block.
  assert.equal(buildIconOnlyAnchorStyle('12px', false).width, '100%');
});

test('buildIconOnlyAnchorStyle: autoHeight neutralises class-driven fixed height (Card/Hero legacy circle)', () => {
  // Card fallback + Hero legacy CTAs render with buttonClasses (fixed h-9/
  // h-10); autoHeight must emit height:'auto' so circle mode is truly round,
  // not an oval clamped to the class height.
  const s = buildIconOnlyAnchorStyle('10px', true, { fillBox: false, autoHeight: true });
  assert.equal(s.height, 'auto');
  assert.equal(s.borderRadius, '9999px');
  assert.equal(s.paddingTop, '10px');
  assert.equal(s.paddingBottom, '10px');
  assert.equal('width' in s, false);
  // Not emitted unless requested.
  assert.equal('height' in buildIconOnlyAnchorStyle('10px', true, { fillBox: false }), false);
});

test('resolveIconOnlyAriaLabel: ariaLabel → label → generic fallback', () => {
  assert.equal(resolveIconOnlyAriaLabel({ ariaLabel: 'Next page', label: 'Go' }), 'Next page');
  assert.equal(resolveIconOnlyAriaLabel({ ariaLabel: '  ', label: 'Go' }), 'Go');
  assert.equal(resolveIconOnlyAriaLabel({ label: '' }), 'Button');
  assert.equal(resolveIconOnlyAriaLabel(null), 'Button');
});
