import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { addonPresentationPatch } from './addonPresentation.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://addon-fields.test/',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const built = await build({
  entryPoints: ['client/src/components/booking/AddonPresentationFields.jsx'],
  bundle: true,
  write: false,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  logLevel: 'silent',
  plugins: [{
    name: 'addon-presentation-mounted-test-controls',
    setup(builder) {
      builder.onResolve({ filter: /^react(\/.*)?$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^@\/components\/events\/EventImageUpload$/ }, () => ({
        path: 'upload-control', namespace: 'addon-test',
      }));
      builder.onResolve({ filter: /^@\/components\/SimpleRichTextEditor$/ }, () => ({
        path: 'rich-editor', namespace: 'addon-test',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'addon-test' }, ({ path }) => ({
        loader: 'jsx',
        contents: path === 'upload-control'
          ? `import React from 'react';
             export default function UploadControl({value, onChange, disabled}) {
               return <div data-testid="upload-stub">
                 {value && <img data-testid="saved-image" src={value} alt="Saved header" />}
                 <button type="button" data-testid="upload-image" disabled={disabled}
                   onClick={() => onChange('/uploads/addon-header.jpg')}>Choose image</button>
                 <button type="button" data-testid="remove-image" disabled={disabled || !value}
                   onClick={() => onChange('')}>Remove image</button>
               </div>;
             }`
          : `import React from 'react';
             export default function RichEditorStub({content, onChange, disabled}) {
               return <textarea data-testid="rich-editor-stub" aria-label="Add-on details"
                 disabled={disabled} value={content || ''}
                 onChange={event => onChange(event.target.value)} />;
             }`,
      }));
    },
  }],
});
const fixture = new Module(`${process.cwd()}/addon-presentation-fields-fixture.cjs`);
fixture.filename = `${process.cwd()}/addon-presentation-fields-fixture.cjs`;
fixture.paths = Module._nodeModulePaths(process.cwd());
fixture._compile(built.outputFiles[0].text, fixture.filename);
const AddonPresentationFields = fixture.exports.default;
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
let savedPresentation = {};
const callbacks = [];

function Harness({ initial = {}, locked = false }) {
  const [presentation, setPresentation] = React.useState(initial);
  const updatePresentation = (key, value) => {
    callbacks.push([key, value]);
    savedPresentation = addonPresentationPatch(savedPresentation, key, value) || {};
    setPresentation(current => addonPresentationPatch(current, key, value) || {});
  };
  return React.createElement(AddonPresentationFields, { presentation, locked, updatePresentation });
}

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
    const prototype = element instanceof dom.window.HTMLTextAreaElement
      ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await settle();
};

test('presentation fields edit, upload/remove, lock, and restore saved values after remount', async () => {
  await act(async () => root.render(React.createElement(Harness, { key: 'editable' })));
  await settle();

  await typeInto(container.querySelector('[data-testid="addon-heading"]'), 'Member reception');
  await typeInto(container.querySelector('[data-testid="rich-editor-stub"]'), '<p>Includes a hosted reception.</p>');
  await click(container.querySelector('[data-testid="upload-image"]'));
  assert.deepEqual(savedPresentation, {
    heading: 'Member reception',
    bodyHtml: '<p>Includes a hosted reception.</p>',
    imageUrl: '/uploads/addon-header.jpg',
  });
  assert.equal(container.querySelector('[data-testid="saved-image"]')?.getAttribute('src'), '/uploads/addon-header.jpg');

  await click(container.querySelector('[data-testid="remove-image"]'));
  assert.deepEqual(savedPresentation, {
    heading: 'Member reception',
    bodyHtml: '<p>Includes a hosted reception.</p>',
  });
  assert.equal(container.querySelector('[data-testid="saved-image"]'), null);

  await click(container.querySelector('[data-testid="upload-image"]'));
  const callbackCountBeforeLock = callbacks.length;
  await act(async () => root.render(React.createElement(Harness, {
    key: 'locked', initial: savedPresentation, locked: true,
  })));
  await settle();
  assert.equal(container.querySelector('[data-testid="addon-heading"]').disabled, true);
  assert.equal(container.querySelector('[data-testid="rich-editor-stub"]').disabled, true);
  assert.equal(container.querySelector('[data-testid="upload-image"]').disabled, true);
  assert.equal(container.querySelector('[data-testid="remove-image"]').disabled, true);
  await click(container.querySelector('[data-testid="upload-image"]'));
  await click(container.querySelector('[data-testid="remove-image"]'));
  assert.equal(callbacks.length, callbackCountBeforeLock);

  await act(async () => root.render(React.createElement(Harness, {
    key: 'saved-remount', initial: savedPresentation,
  })));
  await settle();
  assert.equal(container.querySelector('[data-testid="addon-heading"]').value, 'Member reception');
  assert.equal(container.querySelector('[data-testid="rich-editor-stub"]').value, '<p>Includes a hosted reception.</p>');
  assert.equal(container.querySelector('[data-testid="saved-image"]')?.getAttribute('src'), '/uploads/addon-header.jpg');
});
