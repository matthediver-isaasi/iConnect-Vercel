import { test, expect } from '@playwright/test';
import { installCommunicationReportFixture } from './member-communication-status.fixture.mjs';

async function fixture(page, baseURL, { failure, delayPreferences = false } = {}) {
  await installCommunicationReportFixture(page, baseURL);
  await page.route('**/dougal-avatar.webp?import', route => route.continue());
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const state = { failure, reads: [], externalReads: 0, release };
  const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/email-campaigns?summary=true', route => respond(route, { totalSent: 0, totalOpened: 0, totalClicked: 0 }));
  await page.route('**/api/entities/CommunicationCategory?*', route => respond(route, [{ id: 'news', name: 'News updates', is_active: true }]));
  await page.route('**/api/entities/Member?*', route => {
    state.reads.push('members');
    return respond(route, state.failure === 'members' ? { error: 'fixture' } : [{ id: 'm1', email: 'member@example.invalid', first_name: 'Sample' }], state.failure === 'members' ? 500 : 200);
  });
  await page.route('**/api/entities/MemberCommunicationPreference?*', async route => {
    state.reads.push('preferences');
    if (delayPreferences) await wait;
    return respond(route, state.failure === 'preferences' ? { error: 'fixture' } : [{ id: 'p1', member_id: 'm1', category_id: 'news', is_subscribed: true }], state.failure === 'preferences' ? 500 : 200);
  });
  await page.route('**/api/admin/external-subscribers*', route => {
    state.externalReads++;
    return respond(route, route.request().url().includes('category_id')
      ? { subscribers: [{ id: 'ext', email: 'external@example.invalid' }], total: 1 }
      : { counts: { news: 1 } });
  });
  return state;
}

async function open(page) {
  await page.goto('/CommunicationsManagement');
  await page.getByTestId('tab-categories').click();
  return page.getByTestId('card-category-news');
}

test('external one arrives first; card, dialog and export wait for preferences', async ({ page, baseURL }) => {
  const state = await fixture(page, baseURL, { delayPreferences: true });
  const card = await open(page);
  await expect.poll(() => state.externalReads).toBe(1);
  await expect(card).toContainText('Loading subscribers');
  await expect(card).not.toContainText('1 subscriber');
  await page.getByTestId('button-toggle-category-news').click();
  await expect(page.getByTestId('button-export-category-news')).toBeDisabled();
  state.release();
  await expect(card).toContainText('2 subscribers');
  const reads = state.reads.length;
  await page.getByTestId('button-view-subscribers-news').click();
  await expect(page.getByRole('dialog')).toContainText('2 total subscribers');
  await expect(page.getByRole('dialog')).toContainText('Sample');
  expect(state.reads.length).toBe(reads); // Dialog derives counts; no count request.
  const download = page.waitForEvent('download');
  await page.getByTestId('button-export-from-dialog').click();
  await download;
});

for (const failure of ['members', 'preferences']) {
  test(`${failure} failure hides totals and offers retry`, async ({ page, baseURL }) => {
    const state = await fixture(page, baseURL, { failure });
    const card = await open(page);
    await expect(card).toContainText('Subscriber count unavailable');
    await expect(card).not.toContainText('1 subscriber');
    state.failure = null;
    await card.getByRole('button', { name: 'Retry subscriber counts' }).click();
    await expect(card).toContainText('2 subscribers');
  });
}
