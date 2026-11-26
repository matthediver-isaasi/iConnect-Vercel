import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

const id = 'synthetic-invoice-submission';
const form = { id: 'fixture-form', name: 'Invoice order', fields: [] };
const invoiceSubmission = {
  id, form_id: form.id, form_name: form.name, created_date: '2026-10-01T12:00:00Z',
  submission_data: {}, payment_status: 'unpaid', payment_provider: 'invoice',
  payment_amount: 120, payment_currency: 'GBP', payment_reference: 'reference-123',
  payment_meta: { invoice_order: { version: 1, provider: 'xero' },
    invoice_result: { id: 'invoice-123', invoiceNumber: 'INV-123' } },
};

async function fixture(page, overrides = {}, options = {}) {
  const state = { pdfRequests: [], writes: [] };
  const member = { id: 'fixture-admin', tenant_id: 'fixture', role_id: 'fixture-role', email: 'admin@example.invalid' };
  const role = { id: member.role_id, excluded_features: [] };
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(test.info().project.use.baseURL).origin) return route.abort();
    const path = url.pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    if (path === `/api/entities/Member/${member.id}` && request.method() === 'PATCH'
      && Object.keys(request.postDataJSON()).join() === 'last_activity') return json(member);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      state.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 599, json: { error: 'No fixture writes allowed' } });
    }
    if (path === `/api/form-submission-invoice/${id}`) {
      state.pdfRequests.push(url.searchParams.get('inline'));
      if (options.wait) await options.wait;
      if (options.fail) return route.fulfill({ status: 502, json: { error: 'Unable to retrieve the invoice PDF. Please try again later.' } });
      if (options.invalid) return route.fulfill({ contentType: 'application/pdf', body: '<html>Not a PDF</html>' });
      return route.fulfill({ contentType: 'application/pdf', body: bytes });
    }
    if (path === '/api/auth/me') return json(member);
    if (path === '/api/auth/tenant-user-me') return json({ user: member, tenant: { id: member.tenant_id } });
    if (path === '/api/entities/Member') return json([member]);
    if (path === `/api/entities/Member/${member.id}`) return json(member);
    if (path === '/api/entities/Role') return json([role]);
    if (path === `/api/entities/Role/${role.id}`) return json(role);
    if (path === `/api/entities/Form/${form.id}`) return json(form);
    if (path === `/api/entities/FormSubmission/${id}`) return json({ ...invoiceSubmission, ...overrides });
    return json([]);
  });
  return state;
}

test('both actions retrieve the same invoice; viewing opens a tab and downloading uses an invoice filename', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/FormSubmission/${id}?back=${encodeURIComponent('/FormSubmissions?status=new')}`);
  const details = page.getByTestId('submission-payment-details');
  await expect(details).toContainText('unpaid — GBP 120.00 (Invoice)');
  await expect(details).toContainText('reference-123');
  await expect(details).toContainText('Invoice INV-123');
  await expect(details).not.toContainText('The order is confirmed.');
  await expect(details).not.toContainText('Invoice creation does not mean payment has been received.');
  await details.screenshot({ path: test.info().outputPath('desktop-invoice-actions.png') });
  let viewedPdf;
  let viewedBytes;
  page.context().once('page', tab => tab.once('download', download => { viewedPdf = download; }));
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'View invoice', exact: true }).click();
  const popup = await popupPromise;
  // This environment's headless Chromium has no built-in PDF viewer and
  // downloads navigated PDFs. Confirm the new tab received the real PDF rather
  // than replacing browser APIs with a fake window or fake document.
  await expect.poll(() => popup.url().startsWith('blob:') || !!viewedPdf).toBe(true);
  if (viewedPdf) {
    const chunks = [];
    for await (const chunk of await viewedPdf.createReadStream()) chunks.push(chunk);
    viewedBytes = Buffer.concat(chunks);
    assertPdf(viewedBytes);
  }
  await popup.close();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download invoice', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('invoice-INV-123.pdf');
  expect(await download.failure()).toBeNull();
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const downloadedBytes = Buffer.concat(chunks);
  assertPdf(downloadedBytes);
  if (viewedBytes) expect(downloadedBytes.equals(viewedBytes)).toBe(true);
  expect(state.pdfRequests).toEqual(['true', null]);
  await page.getByTestId('button-back').click();
  await expect(page).toHaveURL(/FormSubmissions\?status=new$/);
  expect(state.writes).toEqual([]);
});

function assertPdf(bytes) {
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(100);
}

for (const [name, overrides, text] of [
  ['pending invoice', { payment_meta: { invoice_order: { version: 1, provider: 'xero' } } }, 'Invoice requested — accounting processing is pending.'],
  ['number without linkage', { payment_meta: { invoice_result: { invoice_number: 'OLD-1' } } }, 'Invoice OLD-1'],
  ['card payment', { payment_provider: 'stripe', payment_status: 'paid' }, 'Paid — GBP 120.00 (Card)'],
  ['direct debit', { payment_provider: 'gocardless', payment_status: 'pending_payment' }, 'Awaiting payment — GBP 120.00 (Direct Debit)'],
]) test(`${name} does not offer broken invoice actions`, async ({ page }) => {
  const state = await fixture(page, overrides);
  await page.goto(`/FormSubmission/${id}`);
  await expect(page.getByTestId('submission-payment-details')).toContainText(text);
  await expect(page.getByRole('button', { name: 'View invoice', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download invoice', exact: true })).toHaveCount(0);
  expect(state.pdfRequests).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('retrieval disables both actions and restores them with a useful error', async ({ page }) => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const state = await fixture(page, {}, { wait, fail: true });
  await page.goto(`/FormSubmission/${id}`);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'View invoice', exact: true }).click();
  const popup = await popupPromise;
  await expect(page.getByRole('button', { name: 'Opening invoice…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download invoice', exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toContainText('Unable to retrieve the invoice PDF');
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(page.getByRole('button', { name: 'View invoice', exact: true })).toBeEnabled();
  expect(state.writes).toEqual([]);
});

test('invalid PDF is not downloaded; genuine review warning remains visible on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { payment_meta: { ...invoiceSubmission.payment_meta,
    gc_reconciliation: { status: 'blocked', requires_review: true } } }, { invalid: true });
  await page.goto(`/FormSubmission/${id}`);
  await expect(page.getByText('The Direct Debit payment needs administrator review before processing can continue.')).toBeVisible();
  const download = page.getByRole('button', { name: 'Download invoice', exact: true });
  await download.scrollIntoViewIfNeeded();
  await expect(download).toBeInViewport();
  let downloads = 0;
  page.on('download', () => downloads++);
  await download.click();
  await expect(page.getByRole('alert').filter({ hasText: 'did not return a PDF' })).toBeVisible();
  expect(downloads).toBe(0);
  const box = await download.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath('mobile-invoice-actions.png') });
});
