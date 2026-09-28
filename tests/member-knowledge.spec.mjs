import { test, expect } from '@playwright/test';

test('mounted assistant fixture validates inline links and persists only the signed answer envelope', async ({page}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/__fixtures/member-ai');
  await expect(page.getByText('ISOLATED UI FIXTURE · mocked tenant/session, answers and persistence · no real provider',{exact:true})).toBeVisible();
  await expect(page.getByTestId('text-member-ai-title')).toHaveText('Ask Fixture Assistant');
  await expect(page.getByTestId('text-member-ai-description')).toHaveText('Isolated UI fixture — not real authentication or provider output');
  await page.getByTestId('input-member-ai-ask').fill('What is the approved process?');
  await page.getByTestId('button-member-ai-send').click();
  await expect(page.getByTestId('link-member-ai-inline-citation-S1')).toHaveAttribute('href','/Resources');
  await expect(page.getByTestId('link-member-ai-inline-citation-S2')).toHaveAttribute('href','/partners/welcome');
  await expect.poll(()=>page.evaluate(()=>window.__memberAiFixture.persisted.length)).toBe(1);
  const saved = await page.evaluate(()=>window.__memberAiFixture.persisted[0]);
  expect(saved.messages[1].answerProvenance).toBe('fixture-only-signed-envelope-not-valid-on-server');
  expect(saved.messages[1]).not.toHaveProperty('sources');
  const request = await page.evaluate(()=>window.__memberAiFixture.requests.find(r=>r.path==='/api/member-ai/ask'));
  expect(request.headers['X-Tenant-Id']).toBe('fixture-tenant');
  await page.getByTestId('input-member-ai-ask').fill('And the next steps?');
  await page.getByTestId('button-member-ai-send').click();
  await expect.poll(()=>page.evaluate(()=>window.__memberAiFixture.persisted.length)).toBe(2);
  const requests = await page.evaluate(()=>window.__memberAiFixture.requests);
  expect(requests.some(r=>r.path==='/api/member-ai/conversations/fixture-conversation' && r.method==='POST')).toBe(true);
  expect(pageErrors).toEqual([]);
  await page.screenshot({path:'test-results/member-knowledge-mounted-fixture.png',fullPage:true});
});