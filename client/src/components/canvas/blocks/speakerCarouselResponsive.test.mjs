import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BREAKPOINT_MAX_PX, resolveResponsiveValue, writeResponsiveValue, BLOCK_DEFAULTS, BLOCK_TYPES } from '../../../lib/canvasDesign.js';

const source = fs.readFileSync(new URL('./dynamicBlocks.jsx', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('function SpeakerCarouselRender('), source.indexOf('function SpeakerCarouselInspector('));
const perViewExpression = renderer.match(/const perView = (.*);/)[1];
const getPerView = new Function('c', 'effBreakpoint', 'resolveResponsiveValue', `return ${perViewExpression}`);
const countFor = (value, bp) => getPerView({ speakersPerView: value }, bp, resolveResponsiveValue);

test('speaker counts resolve overrides, inheritance, legacy defaults and integers', () => {
  const counts = { desktop: 4, tablet: 2, mobile: 1 };
  assert.deepEqual(['desktop', 'tablet', 'mobile'].map(bp => countFor(counts, bp)), [4, 2, 1]);
  assert.equal(countFor({ desktop: 4, tablet: 2 }, 'mobile'), 2);
  for (const bp of ['desktop', 'tablet', 'mobile']) {
    assert.equal(countFor(4, bp), 4);
    assert.equal(countFor(undefined, bp), 1);
    assert.equal(countFor({ desktop: 0 }, bp), 1);
    assert.equal(countFor({ desktop: 2.8 }, bp), 2);
  }
  assert.equal(BLOCK_DEFAULTS[BLOCK_TYPES.SPEAKER_CAROUSEL].content.speakersPerView, 1);
});

test('authoring mobile overrides preserves desktop and supports clearing to inherit', () => {
  const value = writeResponsiveValue(4, 'mobile', 1);
  assert.equal(countFor(value, 'desktop'), 4);
  assert.equal(countFor(value, 'mobile'), 1);
  assert.equal(countFor(writeResponsiveValue(value, 'mobile', null), 'mobile'), 4);
  const inspector = source.slice(source.indexOf('function SpeakerCarouselInspector('));
  assert.match(inspector, /<ResponsiveNumberField\s+label="Speakers per view"[\s\S]*?breakpoint=\{breakpoint\}[\s\S]*?speakersPerView: v/);
});

test('public breakpoint follows viewport changes and forced preview wins', () => {
  let width = 1200;
  let state;
  let cleanup;
  const listeners = new Set();
  const window = {
    matchMedia(query) {
      const max = Number(query.match(/max-width: ([\d.]+)/)[1]);
      return {
        get matches() { return width <= max; },
        addEventListener: (_, callback) => listeners.add(callback),
        removeEventListener: (_, callback) => listeners.delete(callback),
      };
    },
  };
  const hookSource = source.slice(source.indexOf('function resolveRuntimeBreakpoint('), source.indexOf('function SponsorCarouselRender('));
  const hook = new Function('window', 'BREAKPOINT_MAX_PX', 'useState', 'useEffect', `${hookSource}; return useCarouselBreakpoint;`)(
    window, BREAKPOINT_MAX_PX,
    init => { state ??= init(); return [state, value => { state = value; }]; },
    effect => { if (!cleanup) cleanup = effect(); },
  );
  assert.equal(hook(), 'desktop');
  for (const [nextWidth, expected] of [[800, 'tablet'], [375, 'mobile'], [1200, 'desktop']]) {
    width = nextWidth;
    listeners.forEach(callback => callback());
    assert.equal(hook(), expected);
    assert.equal(hook('mobile'), 'mobile');
  }
  cleanup();
  assert.equal(listeners.size, 0);
});

test('paging, navigation, autoplay and indicators share the resolved count', () => {
  assert.match(renderer, /effBreakpoint = useCarouselBreakpoint\(breakpoint\)/);
  assert.match(renderer, /Math\.ceil\(count \/ perView\)/);
  assert.match(renderer, /speakers\.slice\(index \* perView, index \* perView \+ perView\)/);
  assert.match(renderer, /\(i \+ 1\) % pageCount/);
  assert.match(renderer, /\(i - 1 \+ pageCount\) % pageCount/);
  assert.match(renderer, /length: pageCount/);
  assert.match(renderer, /if \(index > Math\.max\(0, pageCount - 1\)\) setIndex\(0\)/);
  assert.deepEqual(['desktop', 'tablet', 'mobile'].map(bp => Math.ceil(7 / countFor({ desktop: 4, tablet: 2, mobile: 1 }, bp))), [2, 4, 7]);
});