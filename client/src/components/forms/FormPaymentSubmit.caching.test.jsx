/**
 * Payment discovery cache contract (Task #4334).
 *
 * Keep this deliberately at the component boundary: a payment field is often
 * rebuilt from normalized form state on every render, while provider
 * discovery is scoped only to its payment purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  DOMParser: window.DOMParser,
  MutationObserver: window.MutationObserver,
  DocumentFragment: window.DocumentFragment,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  getComputedStyle: window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const FormPaymentSubmit = (await import('./FormPaymentSubmit.jsx')).default;
const { useMembershipFeeQuote } = await import('../../lib/useMembershipFeeQuote.js');

const field = () => ({
  id: 'payment-1',
  payment_providers: ['stripe'],
  price_field_id: 'price',
  payment_currency: 'GBP',
});

const membershipForm = {
  id: 'membership-form',
  fields: [],
  visibility_rules: [{
    id: 'membership-rule',
    trigger_field_id: 'class',
    operator: 'equals',
    value: 'member',
    actions: [{
      action_type: 'membership_structure',
      config_id: 'membership-config',
      field_mappings: { 'core:member_count': 'count' },
    }],
  }],
};

test('provider discovery is once per purpose across equivalent rerenders and switching back', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ providers: [{ id: 'stripe', configured: true }] }) };
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 300_000 } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (membership = false) => root.render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(FormPaymentSubmit, {
        field: field(),
        formValues: { price: '10' },
        buildPayload: async () => null,
        membershipQuote: membership
          ? { matched: true, quote: { required: true, amount: 10, currency: 'GBP' } }
          : { matched: false },
      }),
    ),
  );

  await act(async () => { render(false); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { render(true); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { render(false); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  assert.equal(calls.filter((url) => url.includes('purpose=forms')).length, 1);
  assert.equal(calls.filter((url) => url.includes('purpose=membership')).length, 1);
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

function QuoteProbe({ form, values }) {
  const quote = useMembershipFeeQuote({ form, formValues: values });
  return React.createElement('output', { 'data-loading': String(quote.loading) });
}

test('membership quote discovery is once per scalar key and refetches once on key change', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'quote') calls.push(body.submission_data.count);
    return { ok: true, json: async () => ({ required: true, amount: 20, currency: 'GBP' }) };
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 300_000 } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (count) => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(QuoteProbe, {
        form: { ...membershipForm, fields: [] },
        values: { class: 'member', count },
      })),
  );

  await act(async () => { render('10'); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { render('10'); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { render('25'); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  assert.deepEqual(calls, ['10', '25']);
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});