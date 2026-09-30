import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const Details = (await import('./DirectDebitCommitmentDetails.jsx')).default;

async function rendered(commitment, check) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Details commitment={{ id: 'fixture', currency: 'GBP', ...commitment }} />));
    check(container.textContent);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

test('legacy display is a review state and no amount is invented', async () => {
  await rendered({}, text => {
    assert.match(text, /Existing agreement needs review/);
    assert.match(text, /Not available/);
    assert.doesNotMatch(text, /£0.00/);
    assert.doesNotMatch(text, /Monthly price at signup|Authorisation completed/);
  });
});

test('completed authorisation retains historical signup price without inventing a collection', async () => {
  await rendered({
    signupMonthlyPrice: { amount: 13, currency: 'GBP', variable: true },
    authorisationStatus: 'completed_awaiting_bank_activation',
    collectionPolicy: { version: 1, end_policy: 'continue', pricing_policy: 'dynamic' },
    collectionDetails: { state: 'unknown', amount: null, dueDate: null },
  }, text => {
    assert.match(text, /Monthly price at signup£13.00/);
    assert.match(text, /variable, not a confirmed charge/);
    assert.match(text, /Authorisation completed; awaiting bank activation/);
    assert.match(text, /Current monthly collection amountNot available/);
    assert.doesNotMatch(text, /Collection date/);
  });
});

test('signup, estimate and provider charge remain distinct', async () => {
  await rendered({
    signupMonthlyPrice: { amount: 13, currency: 'GBP', variable: true },
    collectionDetails: {
      state: 'provider_scheduled', amount: 17, currency: 'GBP', dueDate: '2026-11-01',
      pricePreview: { amount: 19, currency: 'GBP' },
    },
  }, text => {
    assert.match(text, /Monthly price at signup£13.00/);
    assert.match(text, /Current monthly collection amount£17.00/);
    assert.match(text, /Current price preview — not a confirmed charge£19.00/);
    assert.doesNotMatch(text, /Authorisation completed/);
  });
});

test('scheduled bank debit uses UK date and plain-language pending status', async () => {
  await rendered({ collectionDetails: {
    state: 'provider_scheduled', amount: 13, dueDate: '2026-10-06',
    providerStatus: 'pending_submission',
  } }, text => {
    assert.match(text, /£13.00/);
    assert.match(text, /Scheduled bank debit6 Oct 2026/);
    assert.match(text, /Payment created — awaiting bank submission/);
    assert.doesNotMatch(text, /2026-10-06|pending_submission/);
  });
});

for (const end_policy of ['stop', 'continue']) {
  test(`explicit legacy auto-renew evidence displays ${end_policy}/fixed without a review warning`, async () => {
    await rendered({
      collectionPolicy: { version: null, end_policy, pricing_policy: 'fixed', evidence: 'legacy_auto_renew', needs_review: false },
    }, text => {
      assert.match(text, end_policy === 'continue' ? /Continue collections/ : /Stop collections/);
      assert.match(text, /Fixed for the membership term/);
      assert.match(text, /Based on saved legacy consent/);
      assert.doesNotMatch(text, /needs review|Policy not recorded|administrator must review/);
    });
  });
}

for (const end_policy of ['stop', 'continue']) {
  for (const pricing_policy of ['fixed', 'dynamic']) {
    test(`commitment distinguishes ${end_policy}/${pricing_policy} from provider scheduling`, async () => {
      await rendered({
        collectionPolicy: { version: 1, end_policy, pricing_policy },
        collectionDetails: { state: 'provider_scheduled', amount: 23, currency: 'GBP', dueDate: '2026-10-01', providerStatus: 'pending_submission', blockers: [] },
      }, text => {
        assert.match(text, end_policy === 'stop' ? /Stop collections/ : /Continue collections/);
        assert.match(text, pricing_policy === 'dynamic' ? /current active membership structure price/ : /Fixed for the membership term/);
        assert.match(text, /£23.00/);
        assert.match(text, /Accepted by provider — not yet collected/);
        assert.match(text, /1 Oct 2026/);
      });
    });
  }
}

test('blocked collections and price previews are not presented as paid charges', async () => {
  await rendered({
    collectionPolicy: { version: 1, end_policy: 'continue', pricing_policy: 'dynamic' },
    collectionDetails: { state: 'blocked', amount: null, pricePreview: { amount: 30 }, blockers: ['No active pricing structure'] },
  }, text => {
    assert.match(text, /Collection blocked/);
    assert.match(text, /Current price preview — not a confirmed charge/);
    assert.match(text, /No active pricing structure/);
  });
});