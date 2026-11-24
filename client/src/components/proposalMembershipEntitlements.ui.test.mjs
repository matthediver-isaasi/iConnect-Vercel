import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

async function component(entry) {
  const built = await build({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` },
    plugins: [{ name: 'isolated-proposal-membership-ui', setup(b) {
      b.onResolve({ filter: /^@tanstack\/react-query$/ }, () => ({ path: 'query', namespace: 'fixture' }));
      b.onResolve({ filter: /useSalesSettings$/ }, () => ({ path: 'scope', namespace: 'fixture' }));
      b.onResolve({ filter: /base44Client$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'query'
        ? 'export const useQuery = () => globalThis.proposalMembershipUiFixture;'
        : args.path === 'scope' ? 'export const useSalesSettingsScope = () => ({scopeKey:"fixture",ready:true});'
          : 'export const base44 = {};'
      }));
    } }],
  });
  const compiled = new Module(entry);
  compiled.filename = `${process.cwd()}/${entry}`;
  compiled.paths = Module._nodeModulePaths(process.cwd());
  compiled._compile(built.outputFiles[0].text, compiled.filename);
  return compiled.exports.default;
}
const Product = await component('client/src/components/sales/ProductMembershipSchedule.jsx');
const Entitlements = await component('client/src/components/ProposalMembershipEntitlements.jsx');
function render(Component, data, props = {}) {
  globalThis.proposalMembershipUiFixture = { data, isPending: false, isError: false };
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Component, props)));
}
test('catalogue selection identifies schedule and explains one-period/add-on limits', () => {
  const html = render(Product, { enabled: true, items: [{ id: 'schedule', name: 'Organisation annual' }] }, { value: 'schedule', onChange() {} });
  assert.match(html, /Organisation annual/);
  assert.match(html, /quantity 1/);
  assert.match(html, /Add-ons remain payable/);
  assert.match(html, /Later renewals are not covered/);
});
test('unavailable saved schedules are retained and rollout-disabled selector cannot author benefits', () => {
  const html = render(Product, { enabled: false, items: [] }, { value: 'schedule', onChange() {} });
  assert.match(html, /Saved schedule \(unavailable\)/);
  assert.match(html, /disabled/);
  assert.match(html, /awaiting rollout/);
});
test('pending benefits distinguish missing invoices from denied Sales access', () => {
  const base = { id: 'entitlement', scheduleName: 'Annual', state: 'available', consumption: null };
  assert.match(render(Entitlements, { items: [{ ...base, invoiceState: 'not_issued' }] }), /No proposal invoice has been issued/);
  const restricted = render(Entitlements, { items: [{ ...base, invoiceState: 'restricted' }] });
  assert.match(restricted, /Sales access is required/);
  assert.doesNotMatch(restricted, /href=/);
});
test('consumed benefit renders original value, remaining add-ons and every provider invoice', () => {
  const html = render(Entitlements, { items: [{
    id: 'entitlement', scheduleName: 'Annual', state: 'consumed', sourceProposalId: 'proposal',
    consumption: { membership_year: '2027', original_base_net_minor: 10000, original_base_vat_minor: 2000 },
    history: { currency: 'GBP', total_with_vat: 36 }, invoiceState: 'issued',
    invoices: [{ id: 'a', provider: 'xero', number: 'INV-1', status: 'open', url: 'https://example.invalid/1' },
      { id: 'b', provider: 'quickbooks', number: 'INV-2', status: 'paid', url: null }],
  }] });
  for (const text of ['2027', '100.00', '20.00', '36.00', 'INV-1', 'INV-2', 'Source proposal']) assert.ok(html.includes(text), text);
});
