import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formPickerCollisionPadding,
  formPickerDialogStyle,
  getFormPickerPlacement,
  readFormPickerViewport,
  subscribeFormPickerViewport,
} from './formPickerGeometry.js';

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, callback, capture = false) {
      const key = `${type}:${capture}`;
      const callbacks = listeners.get(key) || new Set();
      callbacks.add(callback);
      listeners.set(key, callbacks);
    },
    removeEventListener(type, callback, capture = false) {
      listeners.get(`${type}:${capture}`)?.delete(callback);
    },
    dispatch(type) {
      for (const [key, callbacks] of listeners) {
        if (key.startsWith(`${type}:`)) {
          for (const callback of callbacks) callback();
        }
      }
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, callbacks) => total + callbacks.size, 0);
    },
  };
}

function viewportWindow({ width, height, visualViewport = null } = {}) {
  return {
    ...eventTarget(),
    innerWidth: width,
    innerHeight: height,
    visualViewport,
    frameElement: null,
  };
}

test('visible iframe viewport intersects its ancestor viewport through scaled borders', () => {
  const visualViewport = {
    ...eventTarget(),
    offsetLeft: 100,
    offsetTop: 50,
    width: 700,
    height: 600,
  };
  const parent = viewportWindow({ width: 1000, height: 800, visualViewport });
  const child = viewportWindow({ width: 200, height: 500 });
  child.frameElement = {
    ownerDocument: { defaultView: parent },
    offsetWidth: 200,
    offsetHeight: 150,
    clientLeft: 5,
    clientTop: 3,
    getBoundingClientRect: () => ({
      left: -50,
      top: 100,
      right: 350,
      bottom: 400,
      width: 400,
      height: 300,
    }),
  };

  assert.deepEqual(readFormPickerViewport(child), {
    left: 70,
    top: 0,
    right: 200,
    bottom: 272,
    width: 130,
    height: 272,
  });
});

test('local visual viewport offsets and cross-origin frame access are safe', () => {
  const visualViewport = {
    offsetLeft: 12,
    offsetTop: 30,
    width: 320,
    height: 400,
  };
  const standalone = viewportWindow({ width: 500, height: 600, visualViewport });
  assert.deepEqual(readFormPickerViewport(standalone), {
    left: 12,
    top: 30,
    right: 332,
    bottom: 430,
    width: 320,
    height: 400,
  });

  const nullFrame = viewportWindow({ width: 240, height: 360 });
  assert.deepEqual(readFormPickerViewport(nullFrame), {
    left: 0, top: 0, right: 240, bottom: 360, width: 240, height: 360,
  });

  const throwingFrame = viewportWindow({ width: 260, height: 380 });
  Object.defineProperty(throwingFrame, 'frameElement', {
    get() { throw new Error('cross-origin access denied'); },
  });
  assert.deepEqual(readFormPickerViewport(throwingFrame), {
    left: 0, top: 0, right: 260, bottom: 380, width: 260, height: 380,
  });
});

test('placement prefers useful space below, flips above, and requests a cramped dialog', () => {
  const viewport = { left: 0, top: 0, right: 400, bottom: 500, width: 400, height: 500 };
  assert.deepEqual(
    getFormPickerPlacement({ top: 60, bottom: 100 }, viewport),
    { side: 'bottom', maxHeight: 384, dialog: false },
  );
  assert.deepEqual(
    getFormPickerPlacement({ top: 400, bottom: 430 }, viewport),
    { side: 'top', maxHeight: 384, dialog: false },
  );

  const cramped = { left: 20, top: 30, right: 320, bottom: 230, width: 300, height: 200 };
  assert.deepEqual(
    getFormPickerPlacement({ top: 110, bottom: 140 }, cramped, { searchable: true }),
    { side: 'bottom', maxHeight: 78, dialog: true },
  );
  assert.deepEqual(formPickerDialogStyle(cramped), {
    position: 'fixed',
    left: 28,
    top: 38,
    width: 284,
    maxHeight: 184,
    transform: 'none',
  });

  const win = viewportWindow({ width: 360, height: 300 });
  assert.deepEqual(formPickerCollisionPadding(cramped, win), {
    top: 38,
    bottom: 78,
    left: 28,
    right: 48,
  });
});

test('subscription follows local, parent, visual viewport, and RAF layout changes then cleans up', () => {
  const parentVisual = {
    ...eventTarget(),
    offsetLeft: 0,
    offsetTop: 0,
    width: 800,
    height: 600,
  };
  const childVisual = {
    ...eventTarget(),
    offsetLeft: 0,
    offsetTop: 0,
    width: 300,
    height: 500,
  };
  const parent = viewportWindow({ width: 800, height: 600, visualViewport: parentVisual });
  const child = viewportWindow({ width: 300, height: 500, visualViewport: childVisual });
  let frameLeft = 100;
  child.frameElement = {
    ownerDocument: { defaultView: parent },
    offsetWidth: 300,
    offsetHeight: 500,
    clientLeft: 0,
    clientTop: 0,
    getBoundingClientRect: () => ({
      left: frameLeft, top: 50, right: frameLeft + 300, bottom: 550, width: 300, height: 500,
    }),
  };
  const animationFrames = new Map();
  let frameId = 0;
  child.requestAnimationFrame = callback => {
    animationFrames.set(++frameId, callback);
    return frameId;
  };
  child.cancelAnimationFrame = id => animationFrames.delete(id);
  let triggerTop = 100;
  const trigger = {
    ownerDocument: { defaultView: child },
    getBoundingClientRect: () => ({
      left: 20, right: 120, top: triggerTop, bottom: triggerTop + 30,
    }),
  };
  const updates = [];
  const dispose = subscribeFormPickerViewport(
    trigger,
    (viewport, rect) => updates.push({ viewport, top: rect.top }),
  );

  assert.equal(updates.length, 1, 'initial tick measures immediately');
  child.innerHeight = 480;
  child.dispatch('resize');
  assert.equal(updates.length, 2, 'local window resize is observed');

  parent.innerHeight = 500;
  parent.dispatch('resize');
  assert.equal(updates.length, 3, 'ancestor window resize is observed');

  parentVisual.offsetTop = 40;
  parentVisual.height = 420;
  parentVisual.dispatch('scroll');
  assert.equal(updates.length, 4, 'ancestor visual viewport scroll is observed');

  childVisual.offsetTop = 10;
  childVisual.dispatch('resize');
  assert.equal(updates.length, 5, 'local visual viewport resize is observed');

  frameLeft = -40;
  triggerTop = 115;
  const pending = [...animationFrames.values()];
  animationFrames.clear();
  pending.forEach(callback => callback());
  assert.equal(updates.length, 6, 'RAF detects iframe and trigger layout movement');
  assert.equal(updates.at(-1).top, 115);

  dispose();
  assert.equal(animationFrames.size, 0, 'scheduled animation frame is cancelled');
  assert.equal(child.listenerCount(), 0);
  assert.equal(childVisual.listenerCount(), 0);
  assert.equal(parent.listenerCount(), 0);
  assert.equal(parentVisual.listenerCount(), 0);
  child.dispatch('resize');
  parentVisual.dispatch('scroll');
  pending.forEach(callback => callback());
  assert.equal(updates.length, 6, 'disposed subscription cannot report stale changes');
});