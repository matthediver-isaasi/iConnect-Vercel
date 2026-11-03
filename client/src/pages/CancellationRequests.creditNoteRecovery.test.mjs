import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Isolate transport, access and UI primitives; exercise the actual page grouping
// and credit-note rendering without contacting tenant or accounting services.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const key of ['window', 'document', 'navigator']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const bundle = await build({
  entryPoints: ['client/src/pages/CancellationRequests.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node',
  format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  plugins: [{
    name: 'isolated-cancellation-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^(@\/|@tanstack\/react-query$)/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
        let contents;
        if (path === '@tanstack/react-query') {
          contents = `
            export const useQuery = ({queryKey}) => ({
              data: { requests: queryKey[0] === 'cancellation-requests'
                ? globalThis.__creditNoteRequests : globalThis.__creditNoteTransfers || [] },
              isLoading: false, refetch: () => {}
            });
            export const useQueryClient = () => ({invalidateQueries: () => {}});
          `;
        } else if (path.endsWith('useMemberAccess')) {
          contents = `const isFeatureExcluded = () => false;
            export const useMemberAccess = () => ({isFeatureExcluded, isAccessReady: true});`;
        } else if (path === '@/utils') {
          contents = 'export const createPageUrl = value => value;';
        } else {
          const names = {
            card: ['Card', 'CardContent', 'CardHeader', 'CardTitle', 'CardDescription'],
            badge: ['Badge'], button: ['Button'], input: ['Input'], textarea: ['Textarea'],
            dialog: ['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription', 'DialogFooter'],
            select: ['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue'],
            switch: ['Switch'], label: ['Label'],
          }[path.split('/').pop()];
          assert.ok(names, `Unexpected dependency: ${path}`);
          contents = `import React from 'react';\n` + names.map(name =>
            `export const ${name} = ({children}) => React.createElement('div', null, children);`
          ).join('\n');
        }
        return { contents, loader: 'js', resolveDir: process.cwd() };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/cancellation-status-isolated.cjs`);
compiled.filename = `${process.cwd()}/cancellation-status-isolated.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { default: CancellationRequests, CreditNoteRecoveryStatus } = compiled.exports;
after(() => {
  delete globalThis.__creditNoteRequests;
  delete globalThis.__creditNoteTransfers;
  dom.window.close();
});

const entry = (state, extra = {}) => ({
  state, message: `Accounting ${state}`, next_attempt_at: null,
  credit_note_number: null, updated_at: null, ...extra,
});
const render = (recovery, status = 'approved') => {
  const html = renderToStaticMarkup(React.createElement(CreditNoteRecoveryStatus, {
    request: { id: 'request-1', status, credit_note_recovery: recovery },
  }));
  return JSDOM.fragment(html);
};

test('all accounting states are persistent, distinct from cancellation approval, with no action controls', () => {
  for (const [state, label] of Object.entries({
    pending: 'Pending', retry: 'Retry scheduled', processing: 'Processing',
    review: 'Needs review', complete: 'Complete', failed: 'Failed', unavailable: 'Status unavailable',
  })) {
    const result = render([entry(state)]);
    assert.ok(result.textContent.includes(label));
    assert.ok(result.textContent.includes(`Accounting ${state}`));
    assert.ok(result.textContent.includes('Cancellation approved.'));
    assert.ok(result.textContent.includes(state === 'complete'
      ? 'Credit-note accounting complete.' : 'not confirmed complete.'));
    assert.equal(result.querySelectorAll('button, a, input').length, 0);
    if (['pending', 'retry', 'processing'].includes(state)) {
      assert.match(result.textContent, /automatically by the scheduled accounting service/);
    }
  }
});

test('empty array means no operation; null or absent status means unavailable; unapproved requests are hidden', () => {
  assert.equal(render([]).textContent, '');
  for (const recovery of [null, undefined, {}, [null], [entry('unexpected')], [entry('__proto__')]]) {
    assert.match(render(recovery).textContent, /Status unavailable/);
  }
  for (const status of ['pending', 'rejected']) {
    assert.equal(render([entry('retry')], status).textContent, '');
  }
});

test('renders every operation and credit-note number without declaring mixed outcomes complete', () => {
  const result = render([
    entry('complete', { credit_note_number: 'CN-2841' }),
    entry('retry', { credit_note_number: 'CN-2842' }),
  ]);
  assert.equal(result.querySelectorAll('li').length, 2);
  assert.match(result.textContent, /CN-2841/);
  assert.match(result.textContent, /CN-2842/);
  assert.match(result.textContent, /not confirmed complete/);
});

test('server messages and numbers remain plain text, including HTML-shaped content', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const result = render([entry('review', { message: payload, credit_note_number: '<script>alert(1)</script>' })]);
  assert.ok(result.textContent.includes(payload));
  assert.ok(result.textContent.includes('<script>alert(1)</script>'));
  assert.equal(result.querySelectorAll('img, script').length, 0);
  assert.doesNotThrow(() => render([entry('retry', { message: {}, credit_note_number: {} })]));
});

test('valid dates are readable with timezone; invalid and missing dates do not crash or render invalid text', () => {
  const iso = '2026-06-18T12:34:00Z';
  const result = render([entry('retry', { next_attempt_at: iso, updated_at: iso })]);
  assert.match(result.textContent, /Next scheduled attempt: Jun/);
  assert.match(result.textContent, /Updated: Jun/);
  assert.equal(result.querySelectorAll(`time[datetime="${iso}"]`).length, 2);
  for (const value of [null, '', 'not-a-date', {}, 123]) {
    const invalid = render([entry('retry', { next_attempt_at: value, updated_at: value })]);
    assert.equal(invalid.querySelectorAll('time').length, 0);
    assert.doesNotMatch(invalid.textContent, /Invalid Date/);
  }
});

test('grouped requests retain each approved outcome, including mixed approval status; transfers do not show accounting', async () => {
  const base = {
    booking_group_reference: 'GROUP-2841', booking_id: 'booking-1',
    request_type: 'group', created_at: '2026-06-18T12:34:00Z',
    event: { title: 'Clinical practice workshop' },
  };
  globalThis.__creditNoteRequests = [
    { ...base, id: 'a', status: 'approved', credit_note_recovery: [entry('complete', { credit_note_number: 'CN-2841' })] },
    { ...base, id: 'b', status: 'approved', credit_note_recovery: [entry('retry')] },
    { ...base, id: 'c', status: 'pending', credit_note_recovery: [entry('failed')] },
    { ...base, id: 'd', booking_group_reference: null, booking_id: 'booking-2', status: 'approved', credit_note_recovery: null },
  ];
  globalThis.__creditNoteTransfers = [
    { ...base, id: 'transfer', booking_id: 'transfer-booking', status: 'approved', credit_note_recovery: [entry('failed')] },
  ];
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(CancellationRequests)));
    assert.equal(container.querySelectorAll('[aria-label="Accounting credit-note status"]').length, 3);
    assert.match(container.querySelector('[data-testid="credit-note-recovery-a"]').textContent, /CN-2841/);
    assert.match(container.querySelector('[data-testid="credit-note-recovery-b"]').textContent, /Retry scheduled/);
    assert.match(container.querySelector('[data-testid="credit-note-recovery-d"]').textContent, /Status unavailable/);
    assert.equal(container.querySelector('[data-testid="credit-note-recovery-c"]'), null);
    assert.equal(container.querySelector('[data-testid="credit-note-recovery-transfer"]'), null);
  } finally {
    await act(async () => root.unmount());
  }
});
