import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { act } = React;
const { createRoot } = await import('react-dom/client');
after(() => dom.window.close());

// Mount the real dialog and workflow. Only visual primitives and evidence
// presentation are stubbed; all effects, handlers, fetches and checkpoints run.
const bundle = await build({
  entryPoints: ['client/src/components/events/ChangeZoomDialog.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{
    name: 'dialog-test-primitives',
    setup(builder) {
      builder.onResolve({ filter: /^@\/components\/ui\/|ZoomRegistrationEvidence$|^sonner$/ }, args => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => {
        if (args.path === 'sonner') return { contents: 'export const toast = {success(){}, error(){}, warning(){}};' };
        if (args.path.endsWith('ZoomRegistrationEvidence')) return { contents: 'export default () => null;' };
        return { loader: 'jsx', resolveDir: process.cwd(), contents: `
          import React from 'react';
          const Wrap = ({children, shouldFilter, onValueChange, onOpenChange, ...props}) => <div {...props}>{children}</div>;
          export const Dialog = ({open, children, onOpenChange}) => open ? <div><button data-testid="outside-close" onClick={() => onOpenChange(false)}>Outside</button>{children}</div> : null;
          export const DialogContent=Wrap, DialogDescription=Wrap, DialogFooter=Wrap, DialogHeader=Wrap, DialogTitle=Wrap;
          export const Button = ({variant, size, ...props}) => <button {...props}/>;
          export const Label = props => <label {...props}/>;
          export const Input = props => <input {...props}/>;
          export const Checkbox = ({checked, onCheckedChange, ...props}) => <input type="checkbox" checked={checked} onChange={e => onCheckedChange(e.target.checked)} {...props}/>;
          export const Switch = Checkbox;
          export const RadioGroup=Wrap, RadioGroupItem=Wrap, Command=Wrap, CommandEmpty=Wrap, CommandList=Wrap;
          export const CommandInput = ({onValueChange, ...props}) => <input {...props} onChange={e => onValueChange(e.target.value)}/>;
          export const CommandItem = ({onSelect, ...props}) => <button {...props} onClick={onSelect}/>;
        ` };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/zoom-dialog-fixture.cjs`);
compiled.filename = `${process.cwd()}/zoom-dialog-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const ChangeZoomDialog = compiled.exports.default;
const empty = { zoom_webinar_id: null, zoom_meeting_id: null };
const target = { zoom_webinar_id: 'selected', zoom_meeting_id: null };
const byId = id => document.querySelector(`[data-testid="${id}"]`);
const click = async id => { assert.ok(byId(id), id); await act(async () => byId(id).click()); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (data, ok = true) => ({ ok, json: async () => data });

async function mount({ endpoint = '/api/events/event-1', mode = 'attach', current = empty, post, confirm = () => true } = {}) {
  const requests = [];
  let success = 0, closes = 0, confirmations = 0;
  globalThis.confirm = () => { confirmations++; return confirm(); };
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, 'include');
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      requests.push(body);
      return post(body, requests.length);
    }
    if (url.startsWith('/api/zoom/')) return response([{ id: 'selected', topic: 'Selected webinar' }, { id: 'other', topic: 'Other webinar' }]);
    return response({ current, confirmedBookings: 43, live: { registration_required: true } });
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(ChangeZoomDialog, {
    open: true, endpointBase: endpoint, mode,
    currentTarget: empty, // Deliberately stale: GET must be authoritative.
    onSuccess: () => { success++; },
    onOpenChange: () => { closes++; },
  })));
  if (mode !== 'reconcile') await click('option-zoom-selected');
  return {
    requests, get success() { return success; }, get closes() { return closes; }, get confirmations() { return confirmations; },
    cleanup: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

for (const endpoint of ['/api/events/event-1', '/api/complex-event-sessions/session-1']) {
  test(`${endpoint}: attach progress, locked controls, no intermediate callback, 43 attendees`, async () => {
    const attach = deferred(), firstBatch = deferred();
    const fixture = await mount({ endpoint, post: (_, n) => n === 1 ? attach.promise : n === 2 ? firstBatch.promise : response({ registered: 18 }) });
    try {
      await click('button-change-zoom-confirm');
      assert.match(byId('zoom-action-progress').textContent, /Attaching Zoom/);
      assert.equal(byId('checkbox-change-zoom-register-new').closest('fieldset').disabled, true);
      await click('button-change-zoom-confirm');
      await click('outside-close');
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.closes, 0);
      await act(async () => attach.resolve(response({ nextCursor: 'must-ignore' })));
      assert.match(byId('zoom-action-progress').textContent, /batch 1/);
      assert.equal(fixture.requests[1].afterBookingId, null);
      assert.equal(fixture.success, 0);
      await act(async () => firstBatch.resolve(response({ registered: 25, nextCursor: '25' })));
      assert.equal(fixture.requests.length, 3);
      assert.equal(fixture.requests[2].afterBookingId, '25');
      assert.equal(fixture.success, 1);
      assert.equal(fixture.confirmations, 0);
      assert.match(byId('zoom-action-outcome').textContent, /Newly registered: 43/);
      assert.ok(fixture.requests.every(r => r.resendConfirmations === false && r.cancelOld === false));
      await click('button-change-zoom-confirm');
      assert.equal(fixture.requests.length, 3);
    } finally { await fixture.cleanup(); }
  });
}

for (const failAt of [2, 3]) {
  test(`mounted retry after request ${failAt} preserves partial success and email checkpoint`, async () => {
    const fixture = await mount({ post: (body, n) => {
      if (n === failAt) return response({ error: 'batch unavailable' }, false);
      if (n === 1) return response({});
      return response(body.afterBookingId ? { registered: 18, emailed: 18 } : { registered: 25, emailed: 25, nextCursor: '25' });
    } });
    try {
      await click('checkbox-change-zoom-resend');
      await click('button-change-zoom-confirm');
      assert.equal(fixture.confirmations, 1);
      assert.equal(fixture.requests[0].resendConfirmations, false);
      assert.equal(fixture.requests[1].resendConfirmations, true);
      assert.match(byId('zoom-action-error').textContent, /Zoom link attached successfully/);
      assert.equal(fixture.success, 0);
      assert.match(byId('zoom-action-outcome').textContent, new RegExp(`emailed: ${failAt === 3 ? 25 : 0}`));
      await click('button-change-zoom-confirm');
      assert.equal(fixture.confirmations, 1, 'retry uses the confirmed frozen email choice');
      assert.equal(fixture.requests[failAt].afterBookingId, failAt === 3 ? '25' : null);
      assert.match(byId('zoom-action-outcome').textContent, /emailed: 43/);
      assert.equal(fixture.success, 1);
    } finally { await fixture.cleanup(); }
  });
}

test('declining explicit email confirmation sends no POST', async () => {
  const fixture = await mount({ confirm: () => false, post: () => { throw new Error('must not post'); } });
  try {
    await click('checkbox-change-zoom-resend');
    await click('button-change-zoom-confirm');
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.confirmations, 1);
  } finally { await fixture.cleanup(); }
});

test('authoritative existing target in attach mode cannot bypass replacement guard', async () => {
  const fixture = await mount({
    current: { ...empty, zoom_meeting_id: 'old' },
    post: body => {
      assert.equal(body.registerNew, true, 'no attach-only bypass');
      return response({ error: 'For more than 25 bookings, attach without attendee actions first' }, false);
    },
  });
  try {
    await click('button-change-zoom-confirm');
    assert.equal(fixture.requests.length, 1);
    assert.match(byId('zoom-action-error').textContent, /more than 25/);
    assert.doesNotMatch(byId('zoom-action-error').textContent, /attached successfully/);
  } finally { await fixture.cleanup(); }
});

test('same-target reconcile uses GET target despite stale parent and batches directly', async () => {
  const fixture = await mount({ mode: 'reconcile', current: target, post: (_, n) => response({ existing: n === 1 ? 25 : 18, nextCursor: n === 1 ? '25' : null }) });
  try {
    await click('button-change-zoom-confirm');
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[0].registerNew, true);
    assert.equal(fixture.requests[0].cancelOld, false);
    assert.match(byId('zoom-action-outcome').textContent, /already registered: 43/);
  } finally { await fixture.cleanup(); }
});

test('mounted attach-only calls once and does not register or email', async () => {
  const fixture = await mount({ post: () => response({ nextCursor: 'ignore' }) });
  try {
    await click('checkbox-change-zoom-register-new');
    await click('button-change-zoom-confirm');
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].registerNew, false);
    assert.equal(fixture.requests[0].enableRegistration, false);
    assert.equal(fixture.requests[0].resendConfirmations, false);
  } finally { await fixture.cleanup(); }
});

test('replacement with cancellation retains the server guard and is never split', async () => {
  const fixture = await mount({
    mode: 'change', current: { ...empty, zoom_meeting_id: 'old-meeting' },
    post: body => {
      assert.equal(body.cancelOld, true);
      assert.equal(body.registerNew, true);
      return response({ error: 'For more than 25 bookings, attach without attendee actions first' }, false);
    },
  });
  try {
    await click('button-change-zoom-confirm');
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.success, 0);
    assert.match(byId('zoom-action-error').textContent, /more than 25/);
  } finally { await fixture.cleanup(); }
});

test('closing after partial failure refreshes parent once, never during batches', async () => {
  const fixture = await mount({ post: (_, n) => n === 1 ? response({ eventPatch: target }) : response({ error: 'Unavailable' }, false) });
  try {
    await click('button-change-zoom-confirm');
    assert.equal(fixture.success, 0);
    assert.match(byId('zoom-action-error').textContent, /attached successfully/);
    await click('button-change-zoom-cancel');
    assert.equal(fixture.success, 1);
    assert.equal(fixture.closes, 1);
    assert.equal(fixture.requests.length, 2);
  } finally { await fixture.cleanup(); }
});
