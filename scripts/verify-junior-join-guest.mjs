// Read-only guest check: abort all non-quote payment/submission requests.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// --local-quote runs only the patched quote handler against DEST. The page and
// pickers remain deployed. This is NOT proof that the fix has been deployed.
const localQuote = process.argv.includes('--local-quote');
let quoteHandler;
if (localQuote) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
  quoteHandler = (await import('../api/public/form-payment.js')).default;
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'chromium',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
page.setDefaultTimeout(10000);
await page.route('**/api/public/form-payment', async route => {
  const body = route.request().postDataJSON();
  if (body.action !== 'quote') return route.abort();
  assert.equal(body.submission_data.field_1788075690796, '4f5b6a3c-927c-41a3-aba3-6fa8a98736ea');
  assert.deepEqual(body.submission_data.field_1788075892819, []);
  assert.equal(body.submission_data.field_1788675459698, 'No');
  if (localQuote) {
    let status = 200;
    let result;
    await quoteHandler({
      method: 'POST', body, headers: { host: 'www.bnms.org.uk' },
    }, {
      setHeader() {},
      status(code) { status = code; return this; },
      json(value) { result = value; return this; },
    }, {
      tenantData: { id: 'ff2df806-b321-4254-b651-3af11fccf1db', slug: 'bnms', domain: 'bnms.org.uk' },
    });
    assert.equal(status, 200);
    assert.equal(result.required, true);
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  }
  return route.continue();
});
await page.route('**/api/public/form-submission', route => route.abort());
try {
  await page.goto('https://www.bnms.org.uk/FormView?slug=full-member-junior-join-v2');
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await page.locator('input[type=text]:visible').nth(0).fill('Guest');
  await page.locator('input[type=text]:visible').nth(1).fill('Validation');
  await page.locator('input[type=email]').first().fill('guest-validation@example.invalid');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: 'Select an organisation group' }).click();
  await page.getByRole('option', { name: "Ashford and St Peter's Hospitals NHS Foundation Trust", exact: true }).click();
  await page.getByRole('radio', { name: 'Yes', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: 'Select an organisation' }).click();
  await page.getByRole('option', { name: "St Peter's Hospital", exact: true }).click();
  await page.getByRole('radio', { name: 'No', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  for (const [index, choice] of [[0, 'Technologist'], [1, 'No'], [2, 'No']]) {
    await page.getByRole('combobox').nth(index).click();
    await page.getByRole('option', { name: choice, exact: true }).click();
  }
  for (const input of await page.locator('textarea').all()) await input.fill('No-charge guest form validation only.');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByText('I accept the Terms & Conditions', { exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForTimeout(4000);
  console.log((await page.locator('body').innerText()).slice(0,5000));
  if (localQuote) {
    assert.equal(await page.getByText('Invalid relationship selection', { exact: true }).count(), 0);
    await page.getByText('£128.00', { exact: false }).first().waitFor();
  }
} finally {
  await browser.close();
}