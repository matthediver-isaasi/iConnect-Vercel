import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.test/FormSubmissions' });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'NodeFilter',
  'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'CustomEvent',
  'MutationObserver', 'localStorage', 'sessionStorage', 'location', 'DocumentFragment']) {
  globalThis[key] = dom.window[key];
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.PointerEvent = dom.window.PointerEvent || dom.window.MouseEvent;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0 });
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { setActiveTenantId } = await import('@/api/base44Client');
const { default: SubmissionReplies } = await import('./SubmissionReplies.jsx');

const senderOptions = {
  defaultSender: { email: 'forms@mail.tenant.test', from: 'Tenant <forms@mail.tenant.test>' },
  personalSender: { name: 'Alex Example', email: 'alex@personal.test' },
};
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
function change(input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function senderSelect() { return document.querySelector('select'); }
function sendButton() { return document.querySelector('[data-testid="button-send-reply"]'); }
async function selectMode(value) {
  await act(async () => {
    senderSelect().value = value;
    senderSelect().dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function fillDraft() {
  await act(async () => {
    change(document.querySelector('[data-testid="input-reply-cc"]'), 'copy@example.test');
    change(document.querySelector('[data-testid="input-reply-bcc"]'), 'blind@example.test');
    const editor = document.querySelector('[data-testid="rte-content"] .tiptap');
    assert.ok(editor);
    editor.innerHTML = '<p>A reply</p>';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
async function mount(options = {}) {
  const requests = [], discoveries = [];
  const originalFetch = globalThis.fetch;
  setActiveTenantId('tenant-a');
  let discover = options.discover || (async () => response(senderOptions));
  globalThis.fetch = async (url, init = {}) => {
    if (url.startsWith('/api/forms/send-submission-reply')) {
      if (init.method === 'POST') {
        requests.push({ body: JSON.parse(init.body), init });
        return options.send ? options.send() : response({ success: true });
      }
      discoveries.push({ url, init });
      return discover();
    }
    if (url.includes('FormSubmissionEmail')) return response(options.replies || []);
    throw new Error(`Unexpected request: ${url}`);
  };
  const queryClient = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 },
  } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let props = { submissionId: 'submission-a', defaultEmail: 'recipient@example.test', formName: 'Application' };
  async function render(next = {}) {
    props = { ...props, ...next };
    await act(async () => root.render(<QueryClientProvider client={queryClient}><SubmissionReplies {...props} /></QueryClientProvider>));
    await settle();
  }
  await render();
  async function open() {
    await act(async () => document.querySelector(`[data-testid="button-reply-submission-${props.submissionId}"]`).click());
    await settle();
  }
  await open();
  return {
    requests, discoveries, render, open,
    setDiscover(value) { discover = value; },
    async cleanup() {
      await act(async () => root.unmount());
      queryClient.clear();
      globalThis.fetch = originalFetch;
      setActiveTenantId(null);
      document.body.innerHTML = '';
    },
  };
}

test('default is preselected, shows both addresses, and sends the unchanged draft with only a sender mode', async () => {
  const view = await mount();
  try {
    assert.equal(senderSelect().value, 'default');
    assert.match(senderSelect().textContent, /Default sender — forms@mail.tenant.test/);
    assert.match(senderSelect().textContent, /Send as me — alex@personal.test/);
    assert.match(document.body.textContent, /Sending From: Tenant <forms@mail.tenant.test>/);
    await fillDraft();
    assert.equal(sendButton().disabled, false);
    await act(async () => sendButton().click());
    assert.deepEqual(view.requests[0].body, {
      submission_id: 'submission-a', to: 'recipient@example.test', cc: 'copy@example.test',
      bcc: 'blind@example.test', subject: 'Re: Application', html: '<p>A reply</p>', senderMode: 'default',
    });
    assert.equal(view.requests[0].init.headers['X-Tenant-Id'], 'tenant-a');
    assert.equal(view.discoveries[0].init.cache, 'no-store');
  } finally { await view.cleanup(); }
});

test('self explains From and Reply-To, posts only a mode, and reopening resets the selection', async () => {
  const view = await mount();
  try {
    await selectMode('me');
    assert.match(document.body.textContent, /Sending From: Alex Example <forms@mail.tenant.test>/);
    assert.match(document.body.textContent, /Replies go to: alex@personal.test/);
    assert.match(document.body.textContent, /not your personal mailbox/);
    await fillDraft();
    await act(async () => sendButton().click());
    assert.equal(view.requests[0].body.senderMode, 'me');
    assert.equal(view.requests[0].body.from, undefined);
    assert.equal(view.requests[0].body.replyTo, undefined);
    await view.open();
    assert.equal(senderSelect().value, 'default');
    assert.equal(view.discoveries.length, 2);
  } finally { await view.cleanup(); }
});

test('cancel and reopen reset self to default', async () => {
  const view = await mount();
  try {
    await selectMode('me');
    await act(async () => document.querySelector('[data-testid="button-cancel-reply"]').click());
    await view.open();
    assert.equal(senderSelect().value, 'default');
  } finally { await view.cleanup(); }
});

test('loading and discovery errors block send without invented addresses or lost draft; retry recovers', async () => {
  let resolveDiscovery;
  const view = await mount({ discover: () => new Promise(resolve => { resolveDiscovery = resolve; }) });
  try {
    await fillDraft();
    assert.equal(sendButton().disabled, true);
    assert.equal(senderSelect().disabled, true);
    assert.match(document.body.textContent, /Loading sender addresses/);
    assert.doesNotMatch(senderSelect().textContent, /@/);
    await act(async () => resolveDiscovery(response({ error: 'Unavailable' }, 503)));
    assert.equal(sendButton().disabled, true);
    assert.match(document.body.textContent, /draft is preserved/);
    assert.equal(document.querySelector('[data-testid="input-reply-cc"]').value, 'copy@example.test');
    view.setDiscover(async () => response(senderOptions));
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry sender lookup').click());
    await settle();
    assert.equal(sendButton().disabled, false);
    assert.match(document.querySelector('.tiptap').textContent, /A reply/);
    assert.equal(view.requests.length, 0);
  } finally { await view.cleanup(); }
});

test('missing personal details disable self with a reason but allow resolved default', async () => {
  const view = await mount({ discover: async () => response({
    ...senderOptions, personalSender: null, personalUnavailableReason: 'Your name and a valid email address are required to send as you.',
  }) });
  try {
    assert.equal(senderSelect().querySelector('option[value="me"]').disabled, true);
    assert.match(document.body.textContent, /name and a valid email address are required/);
    await fillDraft();
    assert.equal(sendButton().disabled, false);
    await selectMode('me'); // Even synthetic events cannot send under an unavailable identity.
    assert.equal(sendButton().disabled, true);
  } finally { await view.cleanup(); }
});

test('tenant changes invalidate selected self immediately and do not silently switch identity on failure', async () => {
  const view = await mount();
  try {
    await selectMode('me');
    await fillDraft();
    view.setDiscover(async () => response({ error: 'Unavailable' }, 503));
    await act(async () => setActiveTenantId('tenant-b'));
    assert.equal(sendButton().disabled, true);
    assert.equal(senderSelect().value, 'me');
    assert.equal(view.discoveries.at(-1).init.headers['X-Tenant-Id'], 'tenant-b');
    assert.equal(view.requests.length, 0);
    assert.match(document.querySelector('.tiptap').textContent, /A reply/);
  } finally { await view.cleanup(); }
});

test('history calls the recorded user Sent by, not the delivery From address', async () => {
  const view = await mount({ replies: [{
    id: 'email-a', to_email: 'recipient@example.test', subject: 'Old reply',
    sent_by_email: 'historical@personal.test', created_at: '2026-11-27T12:00:00Z', delivery_status: 'sent',
  }] });
  try {
    await act(async () => document.querySelector('[data-testid="button-cancel-reply"]').click());
    await act(async () => document.querySelector('[data-testid="button-toggle-replies-submission-a"]').click());
    const history = document.querySelector('[data-testid="list-replies-submission-a"]').textContent;
    assert.match(history, /Sent by: historical@personal.test/);
    assert.doesNotMatch(history, /From:/);
  } finally { await view.cleanup(); }
});

test('late discovery from a closed composer cannot replace newly resolved options', async () => {
  let resolveOld;
  const view = await mount({ discover: () => new Promise(resolve => { resolveOld = resolve; }) });
  try {
    await act(async () => document.querySelector('[data-testid="button-cancel-reply"]').click());
    view.setDiscover(async () => response({
      defaultSender: { email: 'new@mail.tenant.test', from: 'New <new@mail.tenant.test>' },
      personalSender: null,
    }));
    await view.open();
    await act(async () => resolveOld(response(senderOptions)));
    assert.match(senderSelect().textContent, /new@mail.tenant.test/);
    assert.doesNotMatch(senderSelect().textContent, /forms@mail.tenant.test|alex@personal.test/);
    assert.equal(senderSelect().value, 'default');
  } finally { await view.cleanup(); }
});

test('fallback address is shown exactly as resolved by the server', async () => {
  const view = await mount({ discover: async () => response({
    ...senderOptions,
    defaultSender: { email: 'noreply@mail.platform.test', from: 'Platform <noreply@mail.platform.test>' },
  }) });
  try {
    assert.match(senderSelect().textContent, /Default sender — noreply@mail.platform.test/);
    await selectMode('me');
    assert.match(document.body.textContent, /Sending From: Alex Example <noreply@mail.platform.test>/);
    assert.match(document.body.textContent, /Replies go to: alex@personal.test/);
  } finally { await view.cleanup(); }
});

test('a persisted delivery failure preserves the selected sender and draft while refreshing history', async () => {
  const view = await mount({ send: async () => response({ error: 'Rejected', record: { id: 'failed-a' } }, 502) });
  try {
    await selectMode('me');
    await fillDraft();
    await act(async () => sendButton().click());
    assert.equal(senderSelect().value, 'me');
    assert.match(document.querySelector('.tiptap').textContent, /A reply/);
    assert.equal(sendButton().disabled, false);
  } finally { await view.cleanup(); }
});

test('self becoming unavailable at send time requires refreshed discovery without erasing the draft', async () => {
  const view = await mount({ send: async () => response({ error: 'Your details are unavailable', code: 'SENDER_UNAVAILABLE' }, 409) });
  try {
    await selectMode('me');
    await fillDraft();
    await act(async () => sendButton().click());
    assert.equal(sendButton().disabled, true);
    assert.equal(senderSelect().value, 'me');
    view.setDiscover(async () => response({ ...senderOptions, personalSender: null }));
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry sender lookup').click());
    await settle();
    assert.equal(sendButton().disabled, true);
    await selectMode('default');
    assert.equal(sendButton().disabled, false);
    assert.match(document.querySelector('.tiptap').textContent, /A reply/);
  } finally { await view.cleanup(); }
});
