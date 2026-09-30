import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useFlowMeasurement } from './useFlowMeasurement.js';

test('flow refs stay stable while observer-driven heights grow, shrink and reset', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const names = ['window', 'document', 'HTMLElement', 'ResizeObserver',
    'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const observers = [];
  const frames = new Map();
  let nextFrame = 0;
  class Observer {
    elements = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(el) { this.elements.add(el); }
    unobserve(el) { this.elements.delete(el); }
    disconnect() { this.elements.clear(); }
    deliver(el) { this.callback([{ target: el }]); }
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    ResizeObserver: Observer,
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let reads = 0;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
    get() { reads++; return Number(this.dataset.height); },
  });
  let current;
  function Harness({ breakpoint = 'desktop', height = 100, tag = 'div', visible = true }) {
    current = useFlowMeasurement(breakpoint);
    return visible ? React.createElement(tag, {
      ref: current.measureRef('leaf'),
      'data-height': height,
    }) : null;
  }
  const root = createRoot(document.getElementById('root'));
  const render = props => act(() => root.render(
    React.createElement(React.StrictMode, null, React.createElement(Harness, props)),
  ));
  const flushFrames = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback());
  });
  try {
    await render({});
    await flushFrames();
    const firstRef = current.measureRef('leaf');
    assert.equal(current.measured.leaf.height, 100);
    const leaf = document.getElementById('root').firstChild;
    const observer = observers.at(-1);
    assert.ok(observer.elements.has(leaf), 'StrictMode effect replay restores observation');

    const initialReads = reads;
    await render({ height: 250 });
    assert.equal(current.measureRef('leaf'), firstRef);
    assert.equal(reads, initialReads, 'ordinary commits do not detach and synchronously remeasure');
    await act(() => observer.deliver(leaf));
    assert.equal(current.measured.leaf.height, 250);
    assert.equal(reads, initialReads + 1, 'observer update does not trigger another ref measurement');
    const unchanged = current.measured;
    await act(() => observer.deliver(leaf));
    assert.equal(current.measured, unchanged, 'identical heights do not reflow');

    await render({ height: 60 });
    await act(() => observer.deliver(leaf));
    assert.equal(current.measured.leaf.height, 60, 'auto-height can shrink as well as grow');

    await render({ breakpoint: 'mobile', height: 320 });
    assert.deepEqual(current.measured, {}, 'breakpoint invalidates stale desktop heights');
    await flushFrames();
    assert.equal(current.measured.leaf.height, 320);
    assert.equal(current.measureRef('leaf'), firstRef);

    await render({ breakpoint: 'mobile', height: 80, tag: 'section' });
    const replacement = document.getElementById('root').firstChild;
    assert.equal(current.measured.leaf.height, 80, 'replacement elements measure on attachment');
    assert.equal(current.measureRef('leaf'), firstRef);
    assert.ok(!observer.elements.has(leaf));
    assert.ok(observer.elements.has(replacement));
    await render({ breakpoint: 'mobile', visible: false });
    assert.equal(observer.elements.size, 0);
    const detached = current.measured;
    await act(() => observer.deliver(replacement));
    assert.equal(current.measured, detached, 'late notifications from detached elements are ignored');
    await render({ breakpoint: 'mobile', height: 0 });
    assert.equal(current.measured.leaf.height, 0, 'empty content clears the previous height');
    assert.equal(current.measureRef('leaf'), firstRef, 'showing a hidden node retains its ref');
  } finally {
    await act(() => root.unmount());
    assert.ok(observers.every(observer => observer.elements.size === 0));
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});