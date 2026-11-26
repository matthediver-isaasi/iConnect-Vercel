import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { outputFiles } = await build({
  entryPoints: ['client/src/components/forms/OrganisationActivityPurchaseSummary.jsx'],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  alias: { '@': `${process.cwd()}/client/src` }, external: ['react', 'react/*'],
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(require, compiled, compiled.exports);
const Summary = compiled.exports.default;
const props = {
  canView: true, tenantId: 'tenant', organizationId: 'org',
  submission: { id: 'submission', tenant_id: 'tenant', organization_id: 'org',
    payment_provider: 'invoice', payment_amount: 120, payment_currency: 'GBP', payment_status: 'unpaid',
    payment_meta: { invoice_order: { version: 1, snapshot: { lines: [{ description: 'Stand <script>', quantity: 2 }] } },
      invoice_result: { invoiceNumber: 'INV-42' } } },
};
const render = overrides => renderToStaticMarkup(createElement(Summary, { ...props, ...overrides }));

test('activity summary renders recorded order details without asserting payment', () => {
  const html = render({});
  assert.match(html, /2 × Stand &lt;script&gt;/);
  assert.match(html, /Recorded order amount: GBP 120.00/);
  assert.match(html, /Invoice INV-42/);
  assert.match(html, /Recorded payment status: unpaid/);
  assert.doesNotMatch(html, /<script>|Payment received|Paid /);
});

test('inaccessible invoice details and ordinary forms render no summary', () => {
  for (const overrides of [
    { canView: false }, { tenantId: 'other' }, { organizationId: 'other' },
    { submission: { ...props.submission, payment_provider: null } },
  ]) assert.equal(render(overrides), '');
});

test('missing invoice and item details have explicit non-financial fallback text', () => {
  const html = render({ submission: { ...props.submission, payment_meta: {} } });
  assert.match(html, /Item details not recorded/);
  assert.match(html, /accounting processing pending/);
  assert.match(html, /unpaid/);
});

test('organisation activity preserves submission navigation and uses validated permissions', () => {
  const source = readFileSync('client/src/components/OrganisationDetailView.jsx', 'utf8');
  assert.match(source, /canViewPurchaseDetails = !!memberInfo && sessionValidated && isAccessReady\s*&& !isFeatureExcluded\('page_FormSubmissions'\)/);
  const row = source.slice(source.indexOf('key={`submission-${submission.id}`}'), source.indexOf('<RelatedOpportunityActivity'));
  assert.match(row, /onClick=\{\(\) => setPreviewSubmission\(submission\)\}/);
  assert.match(row, /<OrganisationActivityPurchaseSummary[\s\S]*?canView=\{canViewPurchaseDetails\}/);
  assert.match(row, /to=\{`\/FormSubmission\/\$\{submission.id\}\?from=org&orgId=\$\{organization.id\}`\}/);
  assert.match(row, /onClick=\{\(e\) => e.stopPropagation\(\)\}/);
});
