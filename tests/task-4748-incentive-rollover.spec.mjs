import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

let script;
test.beforeAll(async () => {
  const mocks = {
    '@/api/base44Client': 'export const base44 = {};',
    '@/contexts/MemberTerminologyContext': 'export const useMemberTerminology = () => ({memberLabel:"Member"});',
    '@/components/MemberJoinLinkSection': 'export default () => null;',
    '@/components/FormInvoiceSettlementControl': 'export default () => null;',
  };
  const result = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { YearCostSection } from './client/src/components/OrgMembershipTab.jsx';
      const evidence = { source:'commitment_snapshot', originalEntitlement:400, usedInYear1:100, remainingEntitlement:300, appliedDiscount:300, unit:'percent' };
      const shared = { currency:'GBP', periodLabel:'year', fieldLabel:'Members', hideInvoicing:true, onSimulate:()=>{}, onOpenOverride:()=>{} };
      const base = { membershipYear:'2027', annualCost:1200, finalCost:900, totalWithVat:1080, vatAmount:180, vatRatePercent:20, yearNumber:2, freeDiscount:0, rolloverDiscount:300, incentiveRollover:evidence };
      createRoot(document.getElementById('root')).render(<main>
        <h1>New-member incentive rollover — isolated fixture</h1>
        <section><YearCostSection {...shared} yearLabel="Live Year 2 preview" testIdPrefix="preview" yearData={base}/></section>
        <section><YearCostSection {...shared} yearLabel="Recorded Year 2" testIdPrefix="recorded" currentYearRecorded yearData={{...base, recordedFromHistory:true}}/></section>
      </main>);`, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, jsx: 'automatic', alias: { '@': path.resolve('client/src') },
    plugins: [{ name: 'isolated-boundaries', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: 'fixture' } : null);
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'jsx' }));
    } }],
  });
  script = result.outputFiles[0].text;
});

test('live and recorded cards show the explicit rollover amount, once, with correct VAT totals', async ({ page }, testInfo) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    return route.fulfill({ contentType: 'text/html', body: `<style>
      body{font:16px system-ui;color:#172033;background:#f6f8fb;margin:30px}main{max-width:960px}
      section{background:white;padding:24px;margin:20px 0;border:1px solid #ddd;border-radius:8px}
      .flex{display:flex}.justify-between{justify-content:space-between}.items-center{align-items:center}
      .text-green-600{color:#16803c}.text-muted-foreground{color:#627084}svg{width:16px;height:16px}
      button{padding:6px 12px;margin:4px}h1{font-size:24px}.font-semibold{font-weight:600}
      </style><div id="root"></div><script src="/fixture.js"></script>` });
  });
  await page.goto('https://task4748.fixture.invalid');
  for (const prefix of ['preview', 'recorded']) {
    const row = page.getByTestId(`rollover-discount-${prefix}`);
    await expect(row).toContainText('New Member Discount (rollover from Y1)');
    await expect(row).toContainText('-£300.00');
  }
  await expect(page.getByText('-£300.00', { exact: true })).toHaveCount(2);
  await expect(page.getByText('£900.00', { exact: true })).toHaveCount(2);
  await expect(page.getByText('£1,080.00', { exact: true })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('live-and-recorded-rollover.png'), fullPage: true });
});