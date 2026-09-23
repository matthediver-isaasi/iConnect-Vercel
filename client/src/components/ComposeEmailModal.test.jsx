import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.example.test/admin',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.PointerEvent = dom.window.PointerEvent || dom.window.MouseEvent;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ComposeEmailModal } = await import('./ComposeEmailModal.jsx');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function change(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
    'value',
  ).set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function mount(overrides = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const changes = [];
  let successCount = 0;
  let props = {
    open: true,
    tenantId: 'tenant-a',
    memberId: 'member-a',
    memberEmail: 'member.a@example.com',
    memberName: 'Member A',
    onOpenChange: value => changes.push(value),
    onSuccess: () => { successCount += 1; },
    ...overrides,
  };
  const render = async next => {
    props = { ...props, ...next };
    await act(async () => root.render(<ComposeEmailModal {...props} />));
    await settle();
  };
  await render({});
  return {
    changes,
    render,
    get successCount() { return successCount; },
    async cleanup() {
      await act(async () => root.unmount());
      document.body.innerHTML = '';
    },
  };
}

test('shows exact recipients and sends the pinned mailbox with parsed CC', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return response({ success: true, warning: 'Accepted with a provider warning.' });
  };
  const view = await mount();
  try {
    const to = document.querySelector('[data-testid="input-email-to"]');
    const cc = document.querySelector('[data-testid="input-email-cc"]');
    assert.equal(to.disabled, true);
    assert.equal(to.value, 'member.a@example.com');

    await act(async () => {
      change(cc, 'copy.one@example.com; copy.two@example.com');
      change(document.querySelector('[data-testid="input-email-subject"]'), 'Subject');
      change(document.querySelector('[data-testid="input-email-body"]'), 'Message');
    });
    assert.match(
      document.querySelector('[data-testid="email-recipient-summary"]').textContent,
      /To:\s*member\.a@example\.comCC:\s*copy\.one@example\.com, copy\.two@example\.com/,
    );

    await act(async () => {
      document.querySelector('[data-testid="button-send-email"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/crm/send');
    assert.notEqual(requests[0].url, '/api/outlook/send');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      tenantId: 'tenant-a',
      memberId: 'member-a',
      to: 'member.a@example.com',
      cc: 'copy.one@example.com, copy.two@example.com',
      subject: 'Subject',
      body: 'Message',
      bodyType: 'text',
    });
    assert.equal(view.successCount, 1);
  } finally {
    await view.cleanup();
  }
});

test('rejects display names and header characters in CC before sending', async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return response({ success: true });
  };
  const view = await mount();
  try {
    await act(async () => {
      change(document.querySelector('[data-testid="input-email-cc"]'), 'Person <copy@example.com>');
    });
    assert.match(document.body.textContent, /CC contains an invalid email address/);
    assert.equal(document.querySelector('[data-testid="button-send-email"]').disabled, true);
    assert.equal(fetchCount, 0);
  } finally {
    await view.cleanup();
  }
});

test('tenant/member context changes close and clear the draft', async () => {
  const view = await mount();
  try {
    await act(async () => {
      change(document.querySelector('[data-testid="input-email-cc"]'), 'copy@example.com');
      change(document.querySelector('[data-testid="input-email-subject"]'), 'Do not carry');
    });
    await view.render({
      tenantId: 'tenant-b',
      memberId: 'member-b',
      memberEmail: 'member.b@example.com',
    });
    assert.ok(view.changes.includes(false));
    assert.equal(document.querySelector('[data-testid="input-email-subject"]').value, '');
    assert.equal(document.querySelector('[data-testid="input-email-cc"]').value, '');
    assert.equal(document.querySelector('[data-testid="input-email-to"]').value, '');
  } finally {
    await view.cleanup();
  }
});

test('tenant-only context changes close and clear the draft', async () => {
  const view = await mount();
  try {
    await act(async () => {
      change(document.querySelector('[data-testid="input-email-cc"]'), 'copy@example.com');
      change(document.querySelector('[data-testid="input-email-subject"]'), 'Do not carry');
    });
    await view.render({ tenantId: 'tenant-b' });
    assert.ok(view.changes.includes(false));
    assert.equal(document.querySelector('[data-testid="input-email-subject"]').value, '');
    assert.equal(document.querySelector('[data-testid="input-email-cc"]').value, '');
    assert.equal(document.querySelector('[data-testid="input-email-to"]').value, '');
  } finally {
    await view.cleanup();
  }
});

test('ignores a late send response after recipient context changes', async () => {
  let resolveRequest;
  globalThis.fetch = () => new Promise(resolve => { resolveRequest = resolve; });
  const view = await mount();
  try {
    await act(async () => {
      change(document.querySelector('[data-testid="input-email-subject"]'), 'Subject');
      change(document.querySelector('[data-testid="input-email-body"]'), 'Message');
      document.querySelector('[data-testid="button-send-email"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await view.render({
      tenantId: 'tenant-b',
      memberId: 'member-b',
      memberEmail: 'member.b@example.com',
    });
    await act(async () => resolveRequest(response({ success: true })));
    await settle();
    assert.equal(view.successCount, 0);
  } finally {
    await view.cleanup();
  }
});

test('locks the draft when the server reports unknown provider acceptance', async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return response({
      error: 'Microsoft delivery could not be confirmed',
      deliveryUnknown: true,
    }, 502);
  };
  const view = await mount();
  try {
    await act(async () => {
      change(document.querySelector('[data-testid="input-email-subject"]'), 'Subject');
      change(document.querySelector('[data-testid="input-email-body"]'), 'Message');
      document.querySelector('[data-testid="button-send-email"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    assert.equal(fetchCount, 1);
    assert.equal(view.successCount, 0);
    assert.match(document.body.textContent, /Refresh email history before composing another message/i);
    assert.equal(document.querySelector('[data-testid="button-send-email"]').disabled, true);

    await act(async () => {
      document.querySelector('[data-testid="button-send-email"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(fetchCount, 1);
  } finally {
    await view.cleanup();
  }
});

test('locks the draft when Mailgun reports an ambiguous acceptance effect', async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return response({
      error: 'Mailgun acceptance could not be confirmed',
      ambiguousEffect: true,
    }, 502);
  };
  const view = await mount();
  try {
    await act(async () => {
      change(document.querySelector('[data-testid="input-email-subject"]'), 'Subject');
      change(document.querySelector('[data-testid="input-email-body"]'), 'Message');
      document.querySelector('[data-testid="button-send-email"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    assert.equal(fetchCount, 1);
    assert.equal(view.successCount, 0);
    assert.match(document.body.textContent, /Mailgun acceptance could not be confirmed/i);
    assert.equal(document.querySelector('[data-testid="button-send-email"]').disabled, true);
  } finally {
    await view.cleanup();
  }
});

test('suppresses a late send callback after unmount', async () => {
  let resolveRequest;
  globalThis.fetch = () => new Promise(resolve => { resolveRequest = resolve; });
  const view = await mount();
  await act(async () => {
    change(document.querySelector('[data-testid="input-email-subject"]'), 'Subject');
    change(document.querySelector('[data-testid="input-email-body"]'), 'Message');
    document.querySelector('[data-testid="button-send-email"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await view.cleanup();
  await act(async () => resolveRequest(response({ success: true })));
  assert.equal(view.successCount, 0);
});

test('built-in close cannot clear the duplicate-send fence while sending', async () => {
  let requestCount = 0;
  let resolveRequest;
  globalThis.fetch = () => {
    requestCount += 1;
    return new Promise(resolve => { resolveRequest = resolve; });
  };
  const view = await mount();
  try {
    await act(async () => {
      change(document.querySelector('[data-testid="input-email-subject"]'), 'Subject');
      change(document.querySelector('[data-testid="input-email-body"]'), 'Message');
      document.querySelector('[data-testid="button-send-email"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(requestCount, 1);

    const builtInClose = [...document.querySelectorAll('button')]
      .find(button => button.textContent.trim() === 'Close');
    assert.ok(builtInClose, 'expected the Radix built-in close button');
    await act(async () => {
      builtInClose.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.ok(!view.changes.includes(false));

    // A parent rerender/reopen attempt must preserve the pending request and
    // keep the Send control fenced until that request resolves.
    await view.render({ open: true });
    assert.equal(document.querySelector('[data-testid="button-send-email"]').disabled, true);
    await act(async () => {
      document.querySelector('[data-testid="button-send-email"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(requestCount, 1);

    await act(async () => resolveRequest(response({ success: true })));
    await settle();
    assert.equal(requestCount, 1);
    assert.equal(view.successCount, 1);
  } finally {
    await view.cleanup();
  }
});