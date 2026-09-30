// Runtime coverage for the THREE guards that stop a stray refresh / late
// font-or-image decode / breakpoint switch from silently baking a bad
// measurement over a saved Canvas page (Task #2643). The pure bake decision is
// covered DOM-free in ./autoHeightBake.test.mjs; these guards need refs +
// effects + the DOM, so this test mounts the extracted useAutoHeightBake hook
// in a tiny jsdom harness (react-dom/client + React.act) with a controllable
// document.fonts and a fake measurement source (we call the hook's
// commitAutoHeight directly — that is exactly what the stage ResizeObserver
// does via AccordionReflowContext's onMeasure).
//
// Run with:  node --test client/src/components/canvas/useAutoHeightBake.test.mjs
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// --- jsdom environment ---------------------------------------------------
let fontsControl;
before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.navigator = window.navigator;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.CSS = window.CSS || { escape: (s) => String(s) };
  // rAF as a macrotask so the settle effect's double-frame resolves under real
  // timers; a small delay keeps ordering deterministic.
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

// A controllable document.fonts stand-in. `status` drives Gate 3 (a font
// mid-swap is 'loading'); `ready` drives Gate 1 (the settle gate waits on it).
function installFonts() {
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const fonts = { status: 'loaded', ready, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
  return { fonts, openReady: () => resolveReady() };
}

// --- hook + deps ---------------------------------------------------------
const React = (await import('react')).default;
const { useRef, createElement } = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const useAutoHeightBake = (await import('./useAutoHeightBake.js')).default;
const { BLOCK_TYPES } = await import('../../lib/canvasDesign.js');

// Fake registry: only the two flags the bake reads.
const DEFS = {
  [BLOCK_TYPES.TEXT]: { autoHeight: true },
  [BLOCK_TYPES.BUTTON]: { autoSize: true },
  [BLOCK_TYPES.IMAGE]: {},
};
const getDefinition = (type) => DEFS[type];

const makeDesign = (children) => ({ version: 1, root: { sections: [{ id: 'root', children }] } });
const block = (id, type, { x = 0, y = 0, w = 600, h = 100 } = {}) => ({
  id, type, bp: { desktop: { x, y, w, h } },
});

// Harness: exposes commitAutoHeight + the refs/spies the test drives. designRef
// mirrors what CanvasBuilder does (designRef.current = design each render);
// setDesign is a spy that also advances designRef so re-reads stay current.
function makeHarness(initialDesign, { authorEdited = true } = {}) {
  const api = {
    commit: null,
    wrapperRef: null,
    setDesignCalls: [],
    design: initialDesign,
  };
  function Harness({ breakpoint, zoom = 1 }) {
    const designRef = useRef(api.design);
    designRef.current = api.design;
    const skipHistoryRef = useRef(false);
    const authorEditedRef = useRef(authorEdited);
    authorEditedRef.current = authorEdited;
    const stageWrapperRef = useRef(null);
    api.wrapperRef = stageWrapperRef;
    const setDesign = (updater) => {
      const next = typeof updater === 'function' ? updater(api.design) : updater;
      api.setDesignCalls.push(next);
      if (next && next !== api.design) api.design = next;
    };
    const { commitAutoHeight, commitAutoSize } = useAutoHeightBake({
      breakpoint,
      zoom,
      designRef,
      setDesign,
      skipHistoryRef,
      authorEditedRef,
      stageWrapperRef,
      getDefinition,
    });
    api.commit = commitAutoHeight;
    api.commitSize = commitAutoSize;
    return createElement('div', { ref: stageWrapperRef });
  }
  return { api, Harness };
}

// Append a block element (optionally holding an <img> with controllable
// `complete`) into the mounted stage wrapper so Gate 3's DOM read has a target.
function addBlockEl(wrapper, blockId, { withImg = false } = {}) {
  const el = document.createElement('div');
  el.setAttribute('data-block-id', blockId);
  let img = null;
  if (withImg) {
    img = document.createElement('img');
    let complete = false;
    Object.defineProperty(img, 'complete', { get: () => complete, configurable: true });
    img.__setComplete = (v) => { complete = v; };
    el.appendChild(img);
  }
  wrapper.appendChild(el);
  return { el, img };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 0) => { await act(async () => { await sleep(ms); }); };

// --- lifecycle -----------------------------------------------------------
let container, root, fontsCtl;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fontsCtl = installFonts();
  fontsControl = fontsCtl;
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount(Harness, breakpoint = 'desktop', zoom = 1) {
  await act(async () => { root.render(createElement(Harness, { breakpoint, zoom })); });
}
async function rerender(Harness, breakpoint, zoom = 1) {
  await act(async () => { root.render(createElement(Harness, { breakpoint, zoom })); });
}

// --- Gate 1: settle -----------------------------------------------------

test('Gate 1: a measurement before the settle gate opens does NOT bake', async () => {
  const { api, Harness } = makeHarness(makeDesign([
    block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 100 }),
    block('b2', BLOCK_TYPES.IMAGE, { y: 120, h: 100 }),
  ]));
  await mount(Harness);
  addBlockEl(api.wrapperRef.current, 't1');
  // Fonts.ready is still pending -> layoutSettled stays false.
  api.commit('t1', 300); // big grow; would bake if the gate were open
  await flush(300); // longer than the normal debounce window
  assert.equal(api.setDesignCalls.length, 0, 'nothing may bake before settle');
});

test('Gate 1: once fonts settle, a real measurement bakes', async () => {
  const { api, Harness } = makeHarness(makeDesign([
    block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 100 }),
    block('b2', BLOCK_TYPES.IMAGE, { y: 120, h: 100 }),
  ]));
  await mount(Harness);
  addBlockEl(api.wrapperRef.current, 't1');
  fontsCtl.openReady();
  await flush(20); // let fonts.ready + rAF double-frame open the gate
  api.commit('t1', 260);
  await flush(260);
  assert.equal(api.setDesignCalls.length, 1, 'a settled measurement must bake');
  const baked = api.setDesignCalls[0];
  const t1 = baked.root.sections[0].children.find((c) => c.id === 't1');
  assert.equal(t1.bp.desktop.h, 260, 'target baked to measured height');
});

// --- Gate 2: author intent ----------------------------------------------

test('Gate 2: a mount-time re-measure with no author edit does NOT bake (no autosave)', async () => {
  const { api, Harness } = makeHarness(
    makeDesign([block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 100 })]),
    { authorEdited: false },
  );
  await mount(Harness);
  addBlockEl(api.wrapperRef.current, 't1');
  fontsCtl.openReady();
  await flush(20); // settle gate open
  api.commit('t1', 260); // mechanical mount re-measure
  await flush(260);
  assert.equal(api.setDesignCalls.length, 0, 'mechanical re-measure must never flip dirty');
});

// --- Gate 1 re-arm: breakpoint switch -----------------------------------

test('breakpoint switch re-closes the settle gate and cancels a pending commit', async () => {
  const { api, Harness } = makeHarness(makeDesign([
    block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 100 }),
    block('b2', BLOCK_TYPES.IMAGE, { y: 120, h: 100 }),
  ]));
  await mount(Harness, 'desktop');
  addBlockEl(api.wrapperRef.current, 't1');
  fontsCtl.openReady();
  await flush(20); // desktop gate open
  api.commit('t1', 260); // schedule a bake (200ms debounce)
  await flush(50); // not yet fired
  assert.equal(api.setDesignCalls.length, 0, 'commit is still pending');
  // Give the *next* breakpoint a fresh, still-pending fonts.ready so its settle
  // gate stays closed until we explicitly open it.
  const mobileFonts = installFonts();
  // Switch breakpoint: the settle effect re-arms (gate closed) AND clears the
  // pending timer, so the in-flight commit must never fire.
  await rerender(Harness, 'mobile');
  await flush(300); // well past the original debounce
  assert.equal(api.setDesignCalls.length, 0, 'pending commit was cancelled by the switch');
  // Further commits are blocked until the NEW breakpoint settles.
  api.commit('t1', 280);
  await flush(300);
  assert.equal(api.setDesignCalls.length, 0, 'gate stays closed until the new breakpoint settles');
  // Once the new breakpoint settles, commits flow again (re-arm reopened it).
  mobileFonts.openReady();
  await flush(20);
  api.commit('t1', 280);
  await flush(300);
  assert.equal(api.setDesignCalls.length, 1, 'gate reopens after the new breakpoint settles');
});

// --- Gate 1 re-arm: zoom change (Task #2699) ----------------------------
// Editor zoom is a `transform: scale(zoom)` on the stage wrapper. A zoom change
// briefly reflows every measured element (the browser fires ResizeObserver with
// transform-inflated rects mid-transition). The settle-gate effect depends on
// `zoom`, so a zoom change must re-close the gate AND cancel any pending commit,
// exactly like a breakpoint switch, so a transient mid-zoom measurement can
// never bake.

test('zoom change re-closes the settle gate and cancels a pending commit', async () => {
  const { api, Harness } = makeHarness(makeDesign([
    block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 100 }),
    block('b2', BLOCK_TYPES.IMAGE, { y: 120, h: 100 }),
  ]));
  await mount(Harness, 'desktop', 1);
  addBlockEl(api.wrapperRef.current, 't1');
  fontsCtl.openReady();
  await flush(20); // gate open at zoom 1
  api.commit('t1', 260); // schedule a bake (200ms debounce)
  await flush(50); // not yet fired
  assert.equal(api.setDesignCalls.length, 0, 'commit is still pending');
  // Give the post-zoom render a fresh, still-pending fonts.ready so the re-armed
  // gate stays closed until we explicitly open it.
  const zoomedFonts = installFonts();
  // Zoom change (same breakpoint): the settle effect re-arms (gate closed) AND
  // clears the pending timer, so the in-flight commit must never fire.
  await rerender(Harness, 'desktop', 1.5);
  await flush(300); // well past the original debounce
  assert.equal(api.setDesignCalls.length, 0, 'pending commit was cancelled by the zoom change');
  // Further commits are blocked until the re-armed gate settles again.
  api.commit('t1', 280);
  await flush(300);
  assert.equal(api.setDesignCalls.length, 0, 'gate stays closed until it settles after the zoom change');
  // Once settled, commits flow again (re-arm reopened the gate).
  zoomedFonts.openReady();
  await flush(20);
  api.commit('t1', 280);
  await flush(300);
  assert.equal(api.setDesignCalls.length, 1, 'gate reopens after the zoom change settles');
});

// --- Gate 3: content-ready re-check --------------------------------------

test('Gate 3: a measurement while the block <img> is incomplete is dropped, then bakes once it loads', async () => {
  const { api, Harness } = makeHarness(makeDesign([
    block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 100 }),
    block('b2', BLOCK_TYPES.IMAGE, { y: 120, h: 100 }),
  ]));
  await mount(Harness);
  const { img } = addBlockEl(api.wrapperRef.current, 't1', { withImg: true });
  fontsCtl.openReady();
  await flush(20); // settle gate open (wrapper had no imgs at mount time)
  // Image still decoding -> content-ready gate drops the measurement at bake time.
  api.commit('t1', 260);
  await flush(260);
  assert.equal(api.setDesignCalls.length, 0, 'measurement dropped while img incomplete');
  // Image finishes -> the re-reported measurement now bakes.
  img.__setComplete(true);
  api.commit('t1', 260);
  await flush(260);
  assert.equal(api.setDesignCalls.length, 1, 're-bakes once the image has loaded');
});

test('Gate 3: a measurement while a web font is mid-swap is dropped', async () => {
  const { api, Harness } = makeHarness(makeDesign([
    block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 100 }),
  ]));
  await mount(Harness);
  addBlockEl(api.wrapperRef.current, 't1');
  fontsCtl.openReady();
  await flush(20);
  fontsCtl.fonts.status = 'loading'; // font swap in progress at bake time
  api.commit('t1', 260);
  await flush(260);
  assert.equal(api.setDesignCalls.length, 0, 'measurement dropped while a font is swapping');
});

// --- Gate 4: suspect-shrink long-debounce window ------------------------
// A measurement >=12px shorter than the stored height is a "suspect shrink":
// baked as a negative delta it collapses the block and pulls every block below
// it upward, silently corrupting a saved page. It gets the long 700ms window
// (vs the 200ms fast path) so a follow-up real measurement has time to RESET
// the debounce before the transient short value could ever bake. These two
// tests exercise the RUNTIME timer behaviour of that window (the pure delay
// choice is covered in autoHeightBake.test.mjs).

test('Gate 4: a flickering short measurement corrected by the real height within the long window bakes only the real height', async () => {
  const { api, Harness } = makeHarness(makeDesign([
    block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 300 }),
    block('b2', BLOCK_TYPES.IMAGE, { y: 320, h: 100 }),
  ]));
  await mount(Harness);
  addBlockEl(api.wrapperRef.current, 't1');
  fontsCtl.openReady();
  await flush(20); // settle gate open
  // Transient short measurement (>=12px shorter than stored 300) -> 700ms window.
  api.commit('t1', 150);
  await flush(250); // past the 200ms fast path but well inside the 700ms shrink window
  assert.equal(api.setDesignCalls.length, 0, 'the suspect short value must not bake inside the long window');
  // The real (taller) measurement arrives before the long window elapses and
  // resets the debounce (a grow -> 200ms normal window).
  api.commit('t1', 305);
  await flush(300);
  assert.equal(api.setDesignCalls.length, 1, 'only the corrected measurement bakes');
  const baked = api.setDesignCalls[0];
  const t1 = baked.root.sections[0].children.find((c) => c.id === 't1');
  assert.equal(t1.bp.desktop.h, 305, 'baked to the real height, never the transient short value');
});

test('Gate 4: a single genuine large shrink (no follow-up) still bakes after the long window elapses', async () => {
  const { api, Harness } = makeHarness(makeDesign([
    block('t1', BLOCK_TYPES.TEXT, { y: 0, h: 300 }),
    block('b2', BLOCK_TYPES.IMAGE, { y: 320, h: 100 }),
  ]));
  await mount(Harness);
  addBlockEl(api.wrapperRef.current, 't1');
  fontsCtl.openReady();
  await flush(20); // settle gate open
  api.commit('t1', 120); // genuine large deletion -> one correct shrink, no follow-up
  await flush(250); // still inside the 700ms window -> must not have baked yet
  assert.equal(api.setDesignCalls.length, 0, 'a suspect shrink waits the full long window before baking');
  await flush(550); // total elapsed > 700ms; no reset arrived -> now it commits
  assert.equal(api.setDesignCalls.length, 1, 'a genuine deletion still bakes after the long window');
  const baked = api.setDesignCalls[0];
  const t1 = baked.root.sections[0].children.find((c) => c.id === 't1');
  assert.equal(t1.bp.desktop.h, 120, 'baked to the genuine shrunk height');
});

// --- commitAutoSize (Button / CTA — Task #2662) -------------------------
// commitAutoSize reuses the SAME four guards as commitAutoHeight (settle,
// author-intent, content-ready, suspect-shrink debounce) but bakes width AND
// height. These tests confirm the shared gates apply to the size path and that
// a settled, author-driven measurement bakes both dimensions.

test('commitAutoSize: a measurement before the settle gate opens does NOT bake', async () => {
  const { api, Harness } = makeHarness(makeDesign([
    block('btn', BLOCK_TYPES.BUTTON, { y: 0, w: 180, h: 44 }),
  ]));
  await mount(Harness);
  addBlockEl(api.wrapperRef.current, 'btn');
  // Fonts.ready still pending -> settle gate closed.
  api.commitSize('btn', { w: 320, h: 44 });
  await flush(300);
  assert.equal(api.setDesignCalls.length, 0, 'nothing may bake before settle');
});

test('commitAutoSize: a re-measure with no author edit does NOT bake', async () => {
  const { api, Harness } = makeHarness(
    makeDesign([block('btn', BLOCK_TYPES.BUTTON, { y: 0, w: 180, h: 44 })]),
    { authorEdited: false },
  );
  await mount(Harness);
  addBlockEl(api.wrapperRef.current, 'btn');
  fontsCtl.openReady();
  await flush(20); // settle gate open
  api.commitSize('btn', { w: 320, h: 44 }); // mechanical re-measure
  await flush(260);
  assert.equal(api.setDesignCalls.length, 0, 'mechanical re-measure must never flip dirty');
});

test('commitAutoSize: once settled, an author-driven measurement bakes width AND height', async () => {
  const { api, Harness } = makeHarness(makeDesign([
    block('btn', BLOCK_TYPES.BUTTON, { y: 0, w: 180, h: 44 }),
    block('below', BLOCK_TYPES.IMAGE, { y: 60, h: 100 }),
  ]));
  await mount(Harness);
  addBlockEl(api.wrapperRef.current, 'btn');
  fontsCtl.openReady();
  await flush(20); // settle gate open
  api.commitSize('btn', { w: 320, h: 44 }); // wider label, height unchanged
  await flush(260);
  assert.equal(api.setDesignCalls.length, 1, 'a settled, author-driven measurement bakes');
  const baked = api.setDesignCalls[0];
  const btn = baked.root.sections[0].children.find((c) => c.id === 'btn');
  assert.equal(btn.bp.desktop.w, 320, 'width baked to the measured width');
  assert.equal(btn.bp.desktop.h, 44, 'height unchanged');
});
