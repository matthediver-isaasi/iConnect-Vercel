import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://funnel-builder.test/events',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const built = await build({
  entryPoints: ['client/src/components/events/EventFunnelBuilder.jsx'],
  bundle: true,
  write: false,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  logLevel: 'silent',
  plugins: [{
    name: 'funnel-builder-test-controls',
    setup(builder) {
      builder.onResolve({ filter: /^react(\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\/components\/ui\/button$/ }, () => ({ path: 'button', namespace: 'funnel-test' }));
      builder.onResolve({ filter: /^@xyflow\/react$/ }, () => ({ path: 'flow', namespace: 'funnel-test' }));
      builder.onResolve({ filter: /^lucide-react$/ }, () => ({ path: 'icons', namespace: 'funnel-test' }));
      builder.onResolve({ filter: /\.css$/ }, () => ({ path: 'empty-css', namespace: 'funnel-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'funnel-test' }, ({ path }) => ({
        loader: path === 'button' || path === 'flow' || path === 'icons' ? 'jsx' : 'js',
        contents: path === 'button'
          ? 'export function Button({children, ...props}) { return <button {...props}>{children}</button>; }'
          : path === 'flow'
            ? `export const Position = {Top: 'top', Bottom: 'bottom'};
               export const MarkerType = {ArrowClosed: 'arrowclosed'};
               export const Handle = () => null, Background = () => null, Controls = () => null, MiniMap = () => null;
               export const BaseEdge = () => null;
               export const NodeResizeControl = () => null;
               export const EdgeLabelRenderer = ({children}) => <>{children}</>;
               export const useReactFlow = () => ({screenToFlowPosition: point => point});
               export function ReactFlow({children}) { return <div data-testid="flow-canvas">{children}</div>; }`
            : path === 'icons'
              ? `import React from 'react';
                 const Icon = props => React.createElement('span', props);
                 export const GitBranch = Icon, Plus = Icon, Save = Icon, Upload = Icon, Trash2 = Icon, Play = Icon, CheckCircle2 = Icon;`
              : '',
      }));
    },
  }],
});
const fixture = new Module(`${process.cwd()}/event-funnel-builder-search-fixture.cjs`);
fixture.filename = `${process.cwd()}/event-funnel-builder-search-fixture.cjs`;
fixture.paths = Module._nodeModulePaths(process.cwd());
fixture._compile(built.outputFiles[0].text, fixture.filename);
const EventFunnelBuilder = fixture.exports.default;
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
after(async () => {
  await act(async () => root.unmount());
  dom.window.close();
});

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const click = async element => {
  assert.ok(element);
  await act(async () => element.click());
  await settle();
};
const typeInto = async (element, value) => {
  assert.ok(element);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await settle();
};

test('event picker filters alphabetized future choices and never shows internal event IDs', async () => {
  const catalog = [
    { id: 'event-zeta-id', kind: 'public', title: 'Zeta workshop', selectable: true, tickets: [] },
    { id: 'expired-event-id', kind: 'public', title: 'Earlier seminar', selectable: false, tickets: [] },
    { id: 'event-alpha-id', kind: 'public', title: 'Alpha conference', selectable: true, tickets: [] },
  ];
  await act(async () => root.render(React.createElement(EventFunnelBuilder, { tenantId: 'member-org', catalog })));
  await click(container.querySelector('[data-testid="funnel-new"]'));

  const picker = container.querySelector('[data-testid="funnel-event-choice"]');
  const search = container.querySelector('[data-testid="funnel-event-search"]');
  assert.ok(picker);
  assert.ok(search);
  assert.deepEqual(Array.from(picker.options, option => option.textContent.trim()), [
    'Choose an event',
    'Alpha conference',
    'Zeta workshop',
  ]);
  assert.equal(picker.textContent.includes('expired-event-id'), false);

  await typeInto(search, 'ze');
  assert.deepEqual(Array.from(picker.options, option => option.textContent.trim()), [
    'Choose an event',
    'Zeta workshop',
  ]);
  await typeInto(search, 'no future match');
  assert.match(container.textContent, /No selectable future events match “no future match”/);
  assert.doesNotMatch(container.textContent, /event-zeta-id|event-alpha-id|expired-event-id/);
});
