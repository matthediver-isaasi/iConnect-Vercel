import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/empty-card',
});
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  location: window.location,
  history: window.history,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  DocumentFragment: window.DocumentFragment,
  Node: window.Node,
  Event: window.Event,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: LayoutContext } = await import('../contexts/LayoutContext.jsx');
const { publicClient } = await import('../api/publicClient.js');
const { default: FormViewPage } = await import('./FormView.jsx');
const { default: EmbedFormPage } = await import('./EmbedForm.jsx');
const { MemoryRouter, Route, Routes } = await import('react-router-dom');

const form = {
  id: 'empty-card-form',
  slug: 'empty-card',
  name: 'Empty card form',
  layout_type: 'card_swipe',
  allow_save_continue_later: false,
  fields: [{
    id: 'people',
    type: 'repeatable_rows',
    label: 'Organisations',
    hide_when_first_column_empty: true,
    min_rows: 1,
    children: [{
      id: 'organisation',
      type: 'organisation_dropdown',
      label: 'Organisation',
    }],
  }],
};

const originalGetForm = publicClient.getForm;
const originalConsent = publicClient.getFormConsentMessage;
const originalOrganisationOptions = publicClient.listFormOrganizationOptions;
const originalFetch = globalThis.fetch;
publicClient.getForm = async () => form;
publicClient.getFormConsentMessage = async () => ({ message: '' });
publicClient.listFormOrganizationOptions = async () => [];
globalThis.fetch = async () => ({
  ok: false,
  status: 401,
  statusText: 'Unauthorized',
  json: async () => ({}),
});

after(() => {
  publicClient.getForm = originalGetForm;
  publicClient.getFormConsentMessage = originalConsent;
  publicClient.listFormOrganizationOptions = originalOrganisationOptions;
  globalThis.fetch = originalFetch;
});

const layoutValue = {
  authResolved: true,
  sessionValidated: false,
  memberInfo: null,
  organizationInfo: null,
  setForceBlankLayout: () => {},
};

async function settlePage() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createOrganisationAvailabilityController() {
  const requests = [];
  const listFormOrganizationOptions = async (...args) => {
    const request = {
      scope: args[3]?.scope || 'scope-empty',
      answers: args[3],
      gate: deferred(),
      settled: false,
    };
    requests.push(request);
    return request.gate.promise;
  };
  const latestPending = (scope) => [...requests].reverse().find(request => (
    !request.settled && request.scope === scope
  ));
  const settleLatest = (scope, result, failed = false) => {
    const request = latestPending(scope);
    assert.ok(request, `expected a pending organisation request for ${scope}`);
    request.settled = true;
    if (failed) request.gate.reject(result);
    else request.gate.resolve(result);
  };
  return { listFormOrganizationOptions, requests, latestPending, settleLatest };
}

function dynamicForm(layout) {
  const standard = layout === 'standard';
  const pageId = standard ? 'dynamic-page' : undefined;
  return {
    id: `dynamic-empty-${layout}`,
    slug: `dynamic-empty-${layout}`,
    name: `Dynamic ${layout} form`,
    layout_type: standard ? 'standard' : 'card_swipe',
    allow_save_continue_later: false,
    pages: standard ? [{ id: pageId, title: 'Dynamic page' }] : [],
    fields: [{
      id: 'scope',
      type: 'radio',
      label: 'Organisation scope',
      options: ['scope-empty', 'scope-available', 'scope-error', 'scope-empty-again'],
      default_value: 'scope-empty',
      ...(pageId ? { page_id: pageId } : {}),
    }, {
      id: 'people',
      type: 'repeatable_rows',
      label: 'Organisations',
      description: 'Retained answers must survive resolver transitions.',
      hide_when_first_column_empty: true,
      min_rows: 1,
      default_value: [{
        _row_id: `retained-${layout}`,
        organisation: 'org-1',
        notes: 'Retained dynamic row',
      }],
      ...(pageId ? { page_id: pageId } : {}),
      children: [{
        id: 'organisation',
        type: 'organisation_dropdown',
        label: 'Organisation',
        organisation_group_parent_field_id: 'scope',
        organisation_group_parent_scope: 'form',
      }, {
        id: 'notes',
        type: 'text',
        label: 'Notes',
        default_value: 'Retained dynamic row',
      }],
    }],
  };
}

async function settleAvailability(controller, scope, result, failed = false, expected) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const request = controller.latestPending(scope);
    if (request) {
      controller.settleLatest(scope, result, failed);
    }
    await settlePage();
    if (!expected && !controller.latestPending(scope)) return;
    if (expected?.()) return;
  }
  assert.fail(`organisation availability did not settle for ${scope}: ${JSON.stringify(controller.requests.map(request => ({ scope: request.scope, settled: request.settled })))}; ${expected ? 'expectation not met' : ''}`);
}

async function runDynamicProjectionScenario({ layout, embedded }) {
  const activeForm = dynamicForm(layout);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const availability = createOrganisationAvailabilityController();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalGetForm = publicClient.getForm;
  const originalOrganisationOptions = publicClient.listFormOrganizationOptions;
  publicClient.getForm = async () => activeForm;
  publicClient.listFormOrganizationOptions = availability.listFormOrganizationOptions;
  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          embedded
            ? React.createElement(
              MemoryRouter,
              { initialEntries: [`/embed/form/${activeForm.slug}`] },
              React.createElement(
                Routes,
                null,
                React.createElement(
                  Route,
                  { path: '/embed/form/:slug', element: React.createElement(EmbedFormPage) },
                ),
              ),
            )
            : React.createElement(
              LayoutContext.Provider,
              { value: layoutValue },
              React.createElement(FormViewPage, { slug: activeForm.slug }),
            ),
        ),
      );
    });
    await settlePage();

    const buttonWithLabel = (label) => [...container.querySelectorAll('button')]
      .find(button => button.textContent.trim() === label);
    const clickButton = async (label) => {
      const button = buttonWithLabel(label);
      assert.ok(button, `expected a ${label} button`);
      await act(async () => button.click());
      await settlePage();
    };

    const scopeOption = (scope) => [...container.querySelectorAll('label')]
      .find(label => label.textContent.trim() === scope);
    const selectScope = async (scope) => {
      const option = scopeOption(scope);
      assert.ok(option, `expected ${scope} scope option`);
      await act(async () => option.click());
      await settlePage();
    };
    assert.ok(scopeOption('scope-empty'), `${embedded ? 'embed' : 'standalone'} ${layout} rendered its scope options`);
    await selectScope('scope-empty');
    if (layout === 'card_swipe') {
      await clickButton('Next');
    }
    assert.ok(
      availability.latestPending('scope-empty'),
      'the initial resolver remains pending before the empty result arrives',
    );
    assert.equal(
      container.querySelector('[data-testid="repeatable-empty-container-people"]'),
      null,
      'an unresolved domain remains visible',
    );

    await settleAvailability(
      availability,
      'scope-empty',
      [],
      false,
      () => !!container.querySelector('[data-testid="repeatable-empty-container-people"]'),
    );
    assert.ok(
      container.querySelector('[data-testid="repeatable-empty-container-people"]'),
      'the authoritative empty domain hides the repeatable field',
    );

    if (layout === 'card_swipe') {
      await clickButton('Previous');
    }
    await selectScope('scope-available');
    assert.ok(
      availability.latestPending('scope-available'),
      'the changed scope starts a pending availability request',
    );
    assert.equal(
      container.querySelector('[data-testid="repeatable-empty-container-people"]'),
      null,
      'a newly unresolved scope is visible instead of preserving the stale hidden state',
    );
    assert.ok(
      availability.latestPending('scope-available'),
      'the new scope starts a pending availability request',
    );
    await settleAvailability(
      availability,
      'scope-available',
      [{ id: 'org-1', name: 'One Organisation' }],
      false,
      () => !container.querySelector('[data-testid="repeatable-empty-container-people"]'),
    );
    if (layout !== 'card_swipe') {
      assert.ok(container.querySelector('[data-testid="repeatable-row-people-0"]'));
    }

    if (layout === 'card_swipe') {
      await clickButton('Next');
      await settleAvailability(
        availability,
        'scope-available',
        [{ id: 'org-1', name: 'One Organisation' }],
        false,
        () => !!container.querySelector('[data-testid="repeatable-row-people-0"]'),
      );
      await clickButton('Previous');
    }
    await selectScope('scope-error');
    assert.equal(
      container.querySelector('[data-testid="repeatable-empty-container-people"]'),
      null,
      'the field remains visible while the new scope is unresolved',
    );
    if (layout === 'card_swipe') {
      await clickButton('Next');
    }
    await settleAvailability(
      availability,
      'scope-error',
      new Error('organisation resolver unavailable'),
      true,
      () => !container.querySelector('[data-testid="repeatable-empty-container-people"]'),
    );
    assert.ok(container.querySelector('[data-testid="repeatable-row-people-0"]'));

    if (layout === 'card_swipe') {
      await clickButton('Previous');
    }
    await selectScope('scope-empty-again');
    assert.equal(
      container.querySelector('[data-testid="repeatable-empty-container-people"]'),
      null,
      'an available field remains visible during the next pending scope',
    );
    if (layout === 'card_swipe') {
      await clickButton('Next');
    }
    await settleAvailability(
      availability,
      'scope-empty-again',
      [],
      false,
      () => !!container.querySelector('[data-testid="repeatable-empty-container-people"]'),
    );
    const notesInput = container.querySelector(
      '[data-testid="repeatable-row-people-0"] input[type="text"]',
    );
    assert.ok(notesInput, 'the retained sibling field remains mounted in the hidden probe');
    assert.equal(notesInput.value, 'Retained dynamic row');
  } finally {
    publicClient.getForm = originalGetForm;
    publicClient.listFormOrganizationOptions = originalOrganisationOptions;
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
}

for (const layout of ['card_swipe', 'standard']) {
  for (const embedded of [false, true]) {
    test(`${embedded ? 'embedded' : 'standalone'} ${layout} resolves dynamic empty repeatable visibility`, {
      concurrency: false,
    }, async () => {
      await runDynamicProjectionScenario({ layout, embedded });
    });
  }
}

test('standalone card reaches submit when its only repeatable field is hidden', {
  concurrency: false,
}, async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(
            LayoutContext.Provider,
            { value: layoutValue },
            React.createElement(FormViewPage, { slug: form.slug }),
          ),
        ),
      );
    });
    await settlePage();
    assert.ok(container.querySelector('[data-testid="button-submit-form"]'));
    assert.equal(container.querySelector('[data-testid="button-next-step"]'), null);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test('embedded card reaches submit when its only repeatable field is hidden', {
  concurrency: false,
}, async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/embed/form/empty-card'] },
            React.createElement(
              Routes,
              null,
              React.createElement(
                Route,
                { path: '/embed/form/:slug', element: React.createElement(EmbedFormPage) },
              ),
            ),
          ),
        ),
      );
    });
    await settlePage();
    assert.ok(container.querySelector('[data-testid="button-submit-form"]'));
    assert.equal(container.querySelector('[data-testid="button-next-step"]'), null);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});