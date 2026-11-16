import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

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
const bundleOptions = {
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
};
const bundle = await build(bundleOptions);
const compiled = new Module(`${process.cwd()}/zoom-dialog-fixture.cjs`);
compiled.filename = `${process.cwd()}/zoom-dialog-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const ChangeZoomDialog = compiled.exports.default;
// Mount the actual schedule entry-point wrapper with the real shared dialog.
const scheduleSource = readFileSync('client/src/components/events/ComplexEventSchedule.jsx', 'utf8');
const scheduleWrapper = scheduleSource.slice(scheduleSource.indexOf('function ChangeSessionZoomDialog('),
  scheduleSource.indexOf('function ExpandedSessionModal('));
const scheduleBundle = await build({
  ...bundleOptions, entryPoints: undefined,
  stdin: {
    contents: `import React from 'react'; import ChangeZoomDialog from './client/src/components/events/ChangeZoomDialog.jsx'; ${scheduleWrapper}; export default ChangeSessionZoomDialog;`,
    loader: 'jsx', resolveDir: process.cwd(),
  },
});
const scheduleModule = new Module(`${process.cwd()}/zoom-schedule-fixture.cjs`);
scheduleModule.filename = `${process.cwd()}/zoom-schedule-fixture.cjs`;
scheduleModule.paths = Module._nodeModulePaths(process.cwd());
scheduleModule._compile(scheduleBundle.outputFiles[0].text, scheduleModule.filename);
const ScheduleZoomDialog = scheduleModule.exports.default;
const empty = { zoom_webinar_id: null, zoom_meeting_id: null };
const target = { zoom_webinar_id: 'selected', zoom_meeting_id: null };
const byId = id => document.querySelector(`[data-testid="${id}"]`);
const click = async id => { assert.ok(byId(id), id); await act(async () => byId(id).click()); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (data, ok = true) => ({ ok, json: async () => data });

async function mount({ endpoint = '/api/events/event-1', mode = 'attach', current = empty, post, job = null, confirm = () => true, schedule = false } = {}) {
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
    if (url.includes('jobStatus=true')) return response({ job });
    return response({ current, confirmedBookings: 43, live: { registration_required: true } });
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(schedule ? ScheduleZoomDialog : ChangeZoomDialog, {
    session: { id: 'session-1', zoom_webinar_id: 'external-zoom-id' },
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

test('schedule admin entry uses explicit consent and retains delivery identity after a lost response', async () => {
  assert.match(scheduleSource, /\{isAdmin && \(\s*<ChangeSessionZoomDialog/);
  const f = await mount({
    schedule: true, endpoint: '/api/complex-event-sessions/session-1',
    current: target,
    post: async (_, n) => {
      if (n === 1) throw new Error('Response lost after send');
      return response({ emailed: 1, nextCursor: null });
    },
  });
  try {
    assert.equal(byId('checkbox-change-zoom-resend').checked, false);
    // Email-only actions use the interactive delivery ledger; registration
    // jobs have their own durable request key and worker delivery claims.
    await click('checkbox-change-zoom-register-new');
    await click('checkbox-change-zoom-resend');
    await click('button-change-zoom-confirm');
    assert.equal(f.confirmations, 1);
    assert.match(f.requests[0].confirmationOperationId, /^[a-f0-9-]{36}$/);
    await click('button-change-zoom-confirm');
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].confirmationOperationId, f.requests[0].confirmationOperationId);
    assert.equal(f.confirmations, 1);
  } finally { await f.cleanup(); }
});

test('schedule admin entry declining confirmation consent makes no request', async () => {
  const f = await mount({
    schedule: true, current: target, confirm: () => false,
    post: () => { throw new Error('Must not post'); },
  });
  try {
    await click('checkbox-change-zoom-resend');
    await click('button-change-zoom-confirm');
    assert.equal(f.confirmations, 1);
    assert.equal(f.requests.length, 0);
  } finally { await f.cleanup(); }
});

for (const endpoint of ['/api/events/event-1', '/api/complex-event-sessions/session-1']) {
  test(`${endpoint}: one durable request, close allowed after acceptance, no browser batching`, async () => {
    const attach = deferred();
    const job = { id: 'job', status: 'queued', processed: 0, total: 43, totals: {} };
    const fixture = await mount({ endpoint, post: () => attach.promise });
    try {
      await click('button-change-zoom-confirm');
      assert.equal(byId('checkbox-change-zoom-register-new').closest('fieldset').disabled, true);
      await click('button-change-zoom-confirm');
      await click('outside-close');
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.closes, 0);
      await act(async () => attach.resolve(response({ job })));
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.requests[0].background, true);
      assert.equal(fixture.success, 1);
      assert.equal(fixture.confirmations, 0);
      assert.match(byId('zoom-background-status').textContent, /Processed 0 of 43/);
      assert.ok(fixture.requests.every(r => r.resendConfirmations === false && r.cancelOld === false));
      await click('button-change-zoom-confirm');
      assert.equal(fixture.requests.length, 1);
      await click('outside-close');
      assert.equal(fixture.closes, 1);
    } finally { await fixture.cleanup(); }
    const reloaded = await mount({ endpoint, job: { ...job, processed: 25, totals: { registered: 25 } }, post: () => { throw new Error('Reload must not enqueue'); } });
    try {
      assert.match(byId('zoom-background-status').textContent, /Processed 25 of 43/);
      await click('button-change-zoom-confirm');
      assert.equal(reloaded.requests.length, 0);
    } finally { await reloaded.cleanup(); }
  });
}

  test('lost enqueue response retries the same durable request key and explicit email choice', async () => {
    const fixture = await mount({ post: (body, n) => {
      if (n === 1) return response({ error: 'Response lost' }, false);
      return response({ job: { id: 'job', status: 'queued', processed: 0, total: 43, totals: {} } });
    } });
    try {
      await click('checkbox-change-zoom-resend');
      await click('button-change-zoom-confirm');
      assert.equal(fixture.confirmations, 1);
      assert.equal(fixture.requests[0].resendConfirmations, true);
      assert.match(byId('zoom-action-error').textContent, /Response lost/);
      assert.equal(fixture.success, 0);
      await click('button-change-zoom-confirm');
      assert.equal(fixture.requests[1].requestKey, fixture.requests[0].requestKey);
      assert.equal(fixture.requests[1].resendConfirmations, true);
      assert.equal(fixture.success, 1);
    } finally { await fixture.cleanup(); }
  });

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

test('same-target reconcile uses GET target despite stale parent and queues once', async () => {
  const fixture = await mount({ mode: 'reconcile', current: target, post: () => response({ job: { id: 'job', status: 'completed', processed: 43, total: 43, totals: { existing: 43 } } }) });
  try {
    await click('button-change-zoom-confirm');
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].registerNew, true);
    assert.equal(fixture.requests[0].cancelOld, false);
    assert.equal(fixture.requests[0].zoom_webinar_id, 'selected');
    assert.match(byId('zoom-background-status').textContent, /already registered: 43/);
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
    await click('checkbox-change-zoom-cancel-old');
    await click('button-change-zoom-confirm');
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.success, 0);
    assert.match(byId('zoom-action-error').textContent, /more than 25/);
  } finally { await fixture.cleanup(); }
});

test('closing after enqueue failure does not claim the change succeeded', async () => {
  const fixture = await mount({ post: () => response({ error: 'Unavailable' }, false) });
  try {
    await click('button-change-zoom-confirm');
    assert.equal(fixture.success, 0);
    assert.match(byId('zoom-action-error').textContent, /Unavailable/);
    await click('button-change-zoom-cancel');
    assert.equal(fixture.success, 0);
    assert.equal(fixture.closes, 1);
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.cleanup(); }
});
