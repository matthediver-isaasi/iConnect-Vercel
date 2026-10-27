import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<html><body></body></html>', { url: 'https://fixture.test' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = React;
const source = readFileSync('client/src/pages/ZoomWebinarProvisioning.jsx', 'utf8');
// Mount the actual creation state, callbacks and control with real Radix Switch.
// Unrelated authenticated queries and webinar controls are deliberately excluded.
const initial = source.match(/const \[meetingFormData, setMeetingFormData\] = useState\([\s\S]*?\n  \}\);/)[0];
const reset = source.match(/const resetMeetingForm = \(\) => \{[\s\S]*?\n  \};/)[0];
const submit = source.match(/const handleMeetingCreate = \(\) => \{[\s\S]*?\n  \};/)[0];
const control = source.match(/<div className="space-y-2">\s*<div className="flex items-center justify-between gap-4">\s*<Label htmlFor="meeting-participant-video">[\s\S]*?<\/p>\s*<\/div>/)[0];
const close = source.match(/<Dialog open=\{showMeetingCreateDialog\} onOpenChange=\{([\s\S]*?)\}>/)[1];
const bundle = await build({
  stdin: { contents: `
    import React, {useState} from 'react';
    import {Switch} from './client/src/components/ui/switch';
    import {Label} from './client/src/components/ui/label';
    export default function Harness({send}) {
      ${initial}
      ${reset}
      const [showMeetingCreateDialog, setShowMeetingCreateDialog] = useState(true);
      const createMeetingMutation = {mutate: send};
      const toast = {error: message => {throw new Error(message)}};
      ${submit}
      return <><button onClick={() => {resetMeetingForm(); setShowMeetingCreateDialog(true)}}>Open</button>
        {showMeetingCreateDialog && <>${control}
          <button onClick={() => setMeetingFormData(prev => ({...prev, topic:'Fixture', host_id:'host', start_date:'2030-01-02', start_time:'12:00'}))}>Fill</button>
          <button onClick={handleMeetingCreate}>Submit</button>
          <button onClick={() => {setShowMeetingCreateDialog(false); resetMeetingForm()}}>Cancel</button>
          <button onClick={() => (${close})(false)}>Dismiss</button>
        </>}
      </>;
    }`, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  alias: { '@': `${process.cwd()}/client/src` },
});
const compiled = new Module(`${process.cwd()}/zoom-video-fixture.cjs`);
compiled.filename = `${process.cwd()}/zoom-video-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
after(() => dom.window.close());

test('creation control defaults On, submits both booleans and resets after cancel/dismiss/success reset', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const sent = [];
  await act(async () => root.render(React.createElement(compiled.exports.default, { send: value => sent.push(value) })));
  const click = async text => act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === text).click());
  const toggle = () => container.querySelector('[role="switch"]');
  assert.equal(toggle().getAttribute('aria-checked'), 'true');
  assert.equal(container.querySelector('label').htmlFor, toggle().id);
  assert.match(document.getElementById(toggle().getAttribute('aria-describedby')).textContent, /still enable their video later/);
  await click('Fill');
  await click('Submit');
  assert.equal(sent.at(-1).participant_video, true);
  await act(async () => toggle().click());
  await click('Submit');
  assert.equal(sent.at(-1).participant_video, false);
  for (const action of ['Cancel', 'Dismiss']) {
    await click(action);
    await click('Open');
    assert.equal(toggle().getAttribute('aria-checked'), 'true');
    await act(async () => toggle().click());
  }
  await click('Open');
  assert.equal(toggle().getAttribute('aria-checked'), 'true');
  assert.match(source, /setShowMeetingCreateDialog\(false\);\s*resetMeetingForm\(\);/);
  // Both actual launch buttons reset before opening, not only the fixture.
  assert.equal([...source.matchAll(/resetMeetingForm\(\);\s*setShowMeetingCreateDialog\(true\)/g)].length, 2);
  await act(async () => root.unmount());
  container.remove();
});
