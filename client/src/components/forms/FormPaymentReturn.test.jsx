import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/example',
});
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  history: window.history,
  location: window.location,
  sessionStorage: window.sessionStorage,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Event: window.Event,
  getComputedStyle: window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const {
  FormPaymentReturnScreen,
  useFormPaymentReturn,
  PAYMENT_RETURN_POLL_DELAYS_MS,
  PAYMENT_RETURN_POLL_WINDOW_MS,
} = await import('./FormPaymentReturn.jsx');
const {
  savePaymentSubmissionContext,
} = await import('../../lib/formPaymentReturn.js');

test('extended Stripe polling is deterministic, bounded, and backs off to 15 seconds', () => {
  assert.deepEqual(PAYMENT_RETURN_POLL_DELAYS_MS.slice(0, 3), [1500, 3000, 5000]);
  assert.ok(PAYMENT_RETURN_POLL_DELAYS_MS.length > 3);
  assert.ok(PAYMENT_RETURN_POLL_DELAYS_MS.some((delay, index) => (
    PAYMENT_RETURN_POLL_DELAYS_MS.slice(0, index + 1).reduce((sum, value) => sum + value, 0) > 60_000
  )));
  assert.ok(PAYMENT_RETURN_POLL_DELAYS_MS.every(delay => delay <= 15_000));
  const total = PAYMENT_RETURN_POLL_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  assert.ok(total <= PAYMENT_RETURN_POLL_WINDOW_MS);
  assert.ok(total + 15_000 > PAYMENT_RETURN_POLL_WINDOW_MS);
});

function HookProbe() {
  const paymentReturn = useFormPaymentReturn();
  if (!paymentReturn.active) return React.createElement('output', { 'data-testid': 'inactive' });
  return React.createElement(FormPaymentReturnScreen, {
    ...paymentReturn,
    onRecheck: paymentReturn.recheck,
    onReturnToForm: paymentReturn.dismiss,
  });
}

test('hook resumes a path-scoped refresh and preserves setup_complete truthfully', async () => {
  window.sessionStorage.clear();
  savePaymentSubmissionContext({
    submissionId: 'submission-1',
    provider: 'stripe_monthly_card',
    pathname: '/forms/example',
  });
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        provider: 'stripe_monthly_card',
        status: 'setup_complete',
        paymentSucceeded: true,
      }),
    };
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(React.StrictMode, null, React.createElement(HookProbe)));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  assert.equal(calls.length, 1, 'StrictMode effect probe shares the in-flight confirmation');
  assert.equal(calls[0].submission_id, 'submission-1');
  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Payment setup complete');
  assert.match(container.textContent, /first collection has not yet been confirmed/i);
  assert.doesNotMatch(container.textContent, /submission is complete/i);
  assert.doesNotMatch(container.textContent, /Payment received/);
  assert.ok(window.sessionStorage.length > 0, 'setup_complete remains resumable on refresh');
  assert.ok(container.querySelector('[data-testid="button-payment-return-recheck"]'));

  await act(async () => root.unmount());
  const refreshedRoot = createRoot(container);
  await act(async () => {
    refreshedRoot.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.length, 2, 'refresh safely rechecks the same setup');
  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Payment setup complete');
  await act(async () => refreshedRoot.unmount());
  container.remove();
});

test('completed GoCardless setup is an application submission, not a paid outcome', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example');
  savePaymentSubmissionContext({
    submissionId: 'submission-dd-complete',
    provider: 'gocardless',
    status: 'setup_complete',
    pathname: '/forms/example',
  });
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        provider: 'gocardless',
        status: 'setup_complete',
        paymentSucceeded: false,
      }),
    };
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  assert.equal(calls.length, 1, 'a refresh revalidates the server-confirmed DD setup');
  assert.equal(
    container.querySelector('[data-testid="payment-return-title"]').textContent,
    'Application submitted',
  );
  assert.equal(
    container.querySelector('[data-testid="payment-return-body"]').textContent,
    'Your application has been submitted and your Direct Debit is set up.\nYour first payment will be collected separately.\nYou can now leave this page.',
  );
  assert.equal(container.querySelector('[data-testid="button-payment-return-recheck"]'), null);
  assert.ok(container.querySelector('[data-testid="button-payment-return-continue"]'));

  await act(async () => root.unmount());
  container.remove();
});

test('verified annual Stripe payment stays non-terminal while completion is queued', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(FormPaymentReturnScreen, {
      status: 'finalizing',
      provider: 'stripe',
      continueHref: '/',
    }));
  });
  assert.equal(
    container.querySelector('[data-testid="payment-return-title"]').textContent,
    'Payment received — finishing submission',
  );
  assert.match(container.textContent, /payment was verified/i);
  assert.equal(container.querySelector('[data-testid="button-return-to-form"]'), null);
  await act(async () => root.unmount());
  container.remove();
});

test('trusted Stripe payment is accepted immediately for every server completion stage', async () => {
  for (const status of ['finalizing', 'accounting_pending', 'attention']) {
    window.sessionStorage.clear();
    window.history.replaceState({}, '', `/forms/accepted-${status}`);
    savePaymentSubmissionContext({
      submissionId: `accepted-${status}`,
      provider: 'stripe',
      pathname: `/forms/accepted-${status}`,
    });
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return {
        ok: status === 'attention' ? true : false,
        json: async () => ({
          provider: 'stripe',
          status,
          paymentSucceeded: true,
          retryable: true,
        }),
      };
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(HookProbe));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    assert.equal(calls.length, 1);
    assert.equal(
      container.querySelector('[data-testid="payment-return-title"]').textContent,
      'Payment received — application submitted',
    );
    assert.equal(container.querySelector('[data-testid="button-payment-return-recheck"]'), null);
    assert.match(
      container.querySelector('[data-testid="payment-return-body"]').textContent,
      /login instructions when your membership is ready/,
    );
    await act(async () => root.unmount());

    const refreshedRoot = createRoot(container);
    await act(async () => {
      refreshedRoot.render(React.createElement(HookProbe));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(calls.length, 1, `${status} acknowledgement must not confirm again on refresh`);
    assert.equal(
      container.querySelector('[data-testid="payment-return-title"]').textContent,
      'Payment received — application submitted',
    );
    await act(async () => refreshedRoot.unmount());
    container.remove();
  }
});

test('verified-payment boolean without trusted Stripe provider stays safely unaccepted', async () => {
  window.sessionStorage.clear();
  window.history.replaceState(
    {},
    '',
    '/forms/unknown-provider?form_payment_submission=unknown-provider&form_payment_provider=stripe',
  );
  savePaymentSubmissionContext({
    submissionId: 'unknown-provider',
    pathname: '/forms/unknown-provider',
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      json: async () => ({
        status: 'accounting_pending',
        paymentSucceeded: true,
        retryable: false,
      }),
    };
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls, 1);
  assert.notEqual(
    container.querySelector('[data-testid="payment-return-title"]').textContent,
    'Payment received — application submitted',
  );
  assert.ok(container.querySelector('[data-testid="button-payment-return-recheck"]'));
  await act(async () => root.unmount());
  container.remove();
});

test('inline completion can adopt the verified DD outcome into the page-level screen', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/inline-dd');
  let adoptCompletion;
  function AdoptProbe() {
    const paymentReturn = useFormPaymentReturn();
    adoptCompletion = paymentReturn.adoptCompletion;
    if (!paymentReturn.active) return React.createElement('output', { 'data-testid': 'inactive' });
    return React.createElement(FormPaymentReturnScreen, {
      ...paymentReturn,
      onRecheck: paymentReturn.recheck,
      onReturnToForm: paymentReturn.dismiss,
    });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(AdoptProbe)));
  await act(async () => {
    adoptCompletion({ submissionId: 'inline-dd-complete', provider: 'gocardless' });
  });

  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Application submitted');
  assert.equal(container.querySelector('[data-testid="button-payment-return-recheck"]'), null);
  assert.match(container.textContent, /first payment will be collected separately/i);

  await act(async () => root.unmount());
  container.remove();
});

test('inline verified Stripe acceptance uses the same receipt and copy', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/inline-stripe');
  let adoptPaymentAcceptance;
  function AcceptProbe() {
    const paymentReturn = useFormPaymentReturn();
    adoptPaymentAcceptance = paymentReturn.adoptPaymentAcceptance;
    if (!paymentReturn.active) return React.createElement('output', { 'data-testid': 'inactive' });
    return React.createElement(FormPaymentReturnScreen, {
      ...paymentReturn,
      onRecheck: paymentReturn.recheck,
      onReturnToForm: paymentReturn.dismiss,
    });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(AcceptProbe)));
  await act(async () => {
    adoptPaymentAcceptance({
      submissionId: 'inline-stripe-accepted',
      provider: 'stripe',
      status: 'finalizing',
      paymentSucceeded: true,
    });
  });
  assert.equal(
    container.querySelector('[data-testid="payment-return-title"]').textContent,
    'Payment received — application submitted',
  );
  assert.match(container.textContent, /login instructions when your membership is ready/);
  assert.equal(container.querySelector('[data-testid="button-payment-return-recheck"]'), null);
  assert.match(
    window.sessionStorage.getItem('form_payment_pending_submission') || '',
    /"presentationAccepted":true/,
  );
  await act(async () => root.unmount());
  container.remove();
});

test('verified paid receipt survives refresh without confirming or reopening payment', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example');
  savePaymentSubmissionContext({
    submissionId: 'submission-paid',
    provider: 'stripe',
    terminalStatus: 'paid',
    presentationAccepted: true,
    pathname: '/forms/example',
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('a paid receipt must not call confirm');
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  assert.equal(calls, 0);
  assert.equal(
    container.querySelector('[data-testid="payment-return-title"]').textContent,
    'Payment received — application submitted',
  );
  assert.ok(container.querySelector('[data-testid="button-payment-return-continue"]'));
  assert.equal(container.querySelector('[data-testid="button-return-to-form"]'), null);

  await act(async () => root.unmount());
  container.remove();
});

test('terminal attention receipt survives refresh without polling or confirmation replay', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example');
  savePaymentSubmissionContext({
    submissionId: 'submission-attention',
    provider: 'stripe',
    status: 'attention',
    terminalStatus: 'attention',
    pathname: '/forms/example',
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('an attention receipt must not call confirm');
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls, 0);
  assert.equal(
    container.querySelector('[data-testid="payment-return-title"]').textContent,
    'Payment received — submission needs attention',
  );
  assert.equal(container.querySelector('[data-testid="button-payment-return-recheck"]'), null);
  await act(async () => root.unmount());
  container.remove();
});

test('a paid confirmation writes the terminal receipt used by refresh', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example?form_payment_submission=sub-confirmed&form_payment_provider=stripe');
  savePaymentSubmissionContext({
    submissionId: 'sub-confirmed',
    provider: 'stripe',
    pathname: '/forms/example',
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ status: 'paid', provider: 'stripe', paymentSucceeded: true }),
    };
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls, 1);
  assert.match(window.sessionStorage.getItem('form_payment_pending_submission'), /"terminalStatus":"paid"/);

  await act(async () => root.unmount());
  const refreshedRoot = createRoot(container);
  await act(async () => {
    refreshedRoot.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls, 1, 'the receipt restores paid UI without a second confirm');
  assert.equal(
    container.querySelector('[data-testid="payment-return-title"]').textContent,
    'Payment received — application submitted',
  );
  await act(async () => refreshedRoot.unmount());
  container.remove();
});

test('a matching paid return receipt is synchronous and never re-confirms', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example?form_payment_submission=sub-returned&form_payment_provider=stripe');
  savePaymentSubmissionContext({
    submissionId: 'sub-returned',
    provider: 'stripe',
    terminalStatus: 'paid',
    pathname: '/forms/example',
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('a matching terminal return must not confirm again');
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(calls, 0);
  assert.equal(
    container.querySelector('[data-testid="payment-return-title"]')?.textContent,
    'Payment received',
    'the scoped receipt must initialize the visible outcome before any confirm can resolve',
  );
  assert.equal(window.location.search, '');
  assert.equal(container.querySelector('[data-testid="button-payment-return-recheck"]'), null);

  await act(async () => root.unmount());
  container.remove();
});

test('a resumed authoritative outcome remains visible while its recheck is pending', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example');
  savePaymentSubmissionContext({
    submissionId: 'sub-resume-pending',
    provider: 'gocardless',
    status: 'pending',
    pathname: '/forms/example',
  });
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Checking payment status');
  assert.match(container.textContent, /Direct Debit set-up is being confirmed/i);

  await act(async () => {
    resolveFetch({
      ok: true,
      json: async () => ({
        provider: 'gocardless',
        status: 'setup_complete',
        paymentSucceeded: true,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Application submitted');
  assert.match(container.textContent, /first payment will be collected separately/i);
  assert.doesNotMatch(container.textContent, /submission is complete/i);

  await act(async () => root.unmount());
  container.remove();
});

test('a stale confirmation cannot write a receipt after unmount', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example');
  savePaymentSubmissionContext({
    submissionId: 'sub-stale',
    provider: 'stripe',
    pathname: '/forms/example',
  });
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => root.unmount());
  resolveFetch({
    ok: true,
    json: async () => ({ status: 'paid', provider: 'stripe' }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const receipt = window.sessionStorage.getItem('form_payment_pending_submission');
  assert.doesNotMatch(receipt || '', /"terminalStatus":"paid"/);
  container.remove();
});

test('accounting_pending polling keeps its authoritative title through each delayed fetch and is bounded', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example');
  savePaymentSubmissionContext({
    submissionId: 'sub-accounting-poll',
    provider: 'stripe',
    pathname: '/forms/example',
  });

  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pollTimers = new Set();
  const deferredResolvers = [];
  const calls = [];
  const accountingResponse = () => ({
    ok: true,
    json: async () => ({
      provider: 'stripe',
      status: 'accounting_pending',
      paymentSucceeded: false,
      pending: true,
      retryable: true,
    }),
  });
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) return accountingResponse();
    return new Promise((resolve) => deferredResolvers.push(resolve));
  };
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (PAYMENT_RETURN_POLL_DELAYS_MS.includes(delay)) {
      const timer = { callback, delay, args };
      pollTimers.add(timer);
      return timer;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (timer) => {
    if (pollTimers.delete(timer)) return;
    return originalClearTimeout(timer);
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const title = () => container.querySelector('[data-testid="payment-return-title"]')?.textContent;
  const responseForPoll = async () => {
    await act(async () => {
      deferredResolvers.shift()?.(accountingResponse());
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    });
  };
  const triggerPoll = async () => {
    const timer = [...pollTimers][0];
    assert.ok(timer, 'each retryable accounting response should schedule one bounded poll');
    await act(async () => {
      timer.callback(...timer.args);
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    });
  };

  try {
    await act(async () => {
      root.render(React.createElement(HookProbe));
      await new Promise((resolve) => originalSetTimeout(resolve, 20));
    });
    assert.equal(title(), 'Payment received — finishing submission');
    assert.equal(calls.length, 1);
    assert.equal(pollTimers.size, 1);

    // The delayed request is genuinely unresolved. Every render during it
    // must retain the server-authoritative accounting outcome, not flash the
    // generic "Confirming your payment…" state.
    for (let attempt = 0; attempt < PAYMENT_RETURN_POLL_DELAYS_MS.length; attempt += 1) {
      await triggerPoll();
      assert.equal(calls.length, attempt + 2);
      assert.equal(title(), 'Payment received — finishing submission');
      await responseForPoll();
    }

    assert.equal(
      calls.length,
      PAYMENT_RETURN_POLL_DELAYS_MS.length + 1,
      'polling must stop after the bounded extended retry window',
    );
    assert.equal(pollTimers.size, 0, 'no retry timer may survive the bounded window');
    assert.match(container.textContent, /automatic status checks are paused/i);
    assert.ok(calls.every((body) => body.action === 'confirm'));

    // Manual checking starts a fresh bounded window after automatic checks
    // have paused; it must not open a payment control or silently remain done.
    const manualCheck = container.querySelector('[data-testid="button-payment-return-recheck"]');
    assert.ok(manualCheck);
    await act(async () => {
      manualCheck.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    });
    assert.equal(calls.length, PAYMENT_RETURN_POLL_DELAYS_MS.length + 2);
    await responseForPoll();
    assert.equal(pollTimers.size, 1, 'manual checking starts a new automatic window');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    container.remove();
  }
});

test('blocked screen has safe recheck but no return-to-payment affordance', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(FormPaymentReturnScreen, {
    status: 'blocked',
    provider: null,
    error: 'The result is not yet clear.',
    canRecheck: true,
    onRecheck: () => {},
    onReturnToForm: () => {},
    embedded: true,
  })));

  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Payment status needs attention');
  assert.ok(container.querySelector('[data-testid="button-payment-return-recheck"]'));
  assert.equal(container.querySelector('[data-testid="button-return-to-form"]'), null);
  assert.ok(container.querySelector('[data-testid="button-payment-return-continue"]'));

  await act(async () => root.unmount());
  container.remove();
});

test('failed provider returns stay distinct from an intentional cancellation', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(FormPaymentReturnScreen, {
    status: 'failed',
    error: 'Payment was not completed. Nothing has been confirmed as charged.',
    onReturnToForm: () => {},
    embedded: true,
  })));

  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Payment not completed');
  assert.match(container.textContent, /Nothing has been confirmed as charged/i);
  assert.ok(container.querySelector('[data-testid="button-return-to-form"]'));
  assert.equal(container.querySelector('[data-testid="button-payment-return-continue"]'), null);

  await act(async () => root.unmount());
  container.remove();
});

test('unknown-provider pending copy stays payment-neutral', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(FormPaymentReturnScreen, {
    status: 'pending',
    provider: null,
    embedded: true,
  })));

  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Checking payment status');
  assert.doesNotMatch(container.textContent, /Direct Debit|card set-up/);
  assert.ok(container.querySelector('[data-testid="button-payment-return-continue"]'));

  await act(async () => root.unmount());
  container.remove();
});

test('paid member return provides a non-payment onward destination', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(FormPaymentReturnScreen, {
    status: 'paid',
    continueHref: '/Dashboard',
    continueLabel: 'Go to member area',
  })));

  const onward = container.querySelector('[data-testid="button-payment-return-continue"]');
  assert.equal(onward?.getAttribute('href'), '/Dashboard');
  assert.match(onward?.textContent || '', /member area/i);
  assert.equal(container.querySelector('[data-testid="button-return-to-form"]'), null);

  await act(async () => root.unmount());
  container.remove();
});

test('same-origin embedded continuation uses the explicit parent callback', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let continued = 0;
  await act(async () => root.render(React.createElement(FormPaymentReturnScreen, {
    status: 'paid',
    embedded: true,
    continueHref: '/microsite',
    onContinue: () => { continued += 1; },
  })));

  const onward = container.querySelector('[data-testid="button-payment-return-continue"]');
  assert.equal(onward?.tagName, 'BUTTON');
  await act(async () => onward.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.equal(continued, 1);

  await act(async () => root.unmount());
  container.remove();
});

test('unmount clears a scheduled bounded poll', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/example');
  savePaymentSubmissionContext({
    submissionId: 'submission-pending',
    provider: 'gocardless',
    pathname: '/forms/example',
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      provider: 'gocardless',
      status: 'pending',
      pending: true,
      retryable: true,
    }),
  });

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pollTimers = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 1500 || delay === 3000 || delay === 5000) {
      const id = { callback, delay };
      pollTimers.add(id);
      return id;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (id) => {
    if (pollTimers.delete(id)) return;
    originalClearTimeout(id);
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(HookProbe));
      await new Promise((resolve) => originalSetTimeout(resolve, 20));
    });
    assert.equal(pollTimers.size, 1);
    await act(async () => root.unmount());
    assert.equal(pollTimers.size, 0, 'poll timer must not survive unmount');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    container.remove();
  }
});

test('verified monthly card setup uses dedicated copy, persists collection state, and does not poll', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/monthly-card?form_payment_submission=monthly-card-submission&form_payment_provider=stripe_monthly_card');
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        status: 'setup_complete',
        provider: 'stripe',
        paymentProvider: 'stripe_monthly_card',
        setupVerified: true,
        paymentSucceeded: false,
        retryable: true,
      }),
    };
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].acknowledge_setup, true);
  assert.equal(
    container.querySelector('[data-testid="payment-return-title"]').textContent,
    'Application submitted — monthly payments set up',
  );
  assert.match(container.textContent, /login instructions when your membership is ready/i);
  assert.doesNotMatch(container.textContent, /payment has been received/i);
  assert.equal(container.querySelector('[data-testid="button-payment-return-recheck"]'), null);
  assert.match(window.sessionStorage.getItem('form_payment_pending_submission') || '', /"paymentCollected":false/);

  await act(async () => root.unmount());
  const refreshedRoot = createRoot(container);
  await act(async () => {
    refreshedRoot.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls.length, 1, 'verified monthly setup receipt must not reconfirm on refresh');
  assert.equal(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Application submitted — monthly payments set up');
  await act(async () => refreshedRoot.unmount());
  container.remove();
});

test('monthly setup proof rejects a mismatched payment type', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/monthly-mismatch?form_payment_submission=monthly-mismatch&form_payment_provider=stripe_monthly_card');
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      status: 'setup_complete',
      provider: 'stripe',
      paymentProvider: 'gocardless_monthly_dd',
      setupVerified: true,
      paymentSucceeded: false,
      retryable: false,
    }),
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.notEqual(container.querySelector('[data-testid="payment-return-title"]').textContent, 'Application submitted — monthly payments set up');
  assert.doesNotMatch(container.textContent, /monthly payments are set up/i);
  await act(async () => root.unmount());
  container.remove();
});

test('monthly paymentProvider blocks one-off acceptance even without a matching URL hint', async () => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/forms/monthly-authority?form_payment_submission=monthly-authority');
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).acknowledge_setup, true);
    return {
      ok: true,
      json: async () => ({
        status: 'finalizing',
        provider: 'stripe',
        paymentProvider: 'stripe_monthly_card',
        setupVerified: false,
        paymentSucceeded: true,
        retryable: true,
      }),
    };
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HookProbe));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(
    container.querySelector('[data-testid="payment-return-screen"]').getAttribute('data-payment-status'),
    'pending',
  );
  assert.notEqual(
    container.querySelector('[data-testid="payment-return-title"]').textContent,
    'Payment received — application submitted',
  );
  assert.doesNotMatch(container.textContent, /payment has been received and your application has been submitted/i);
  await act(async () => root.unmount());
  container.remove();
});