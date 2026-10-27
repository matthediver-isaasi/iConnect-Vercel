import { test, expect } from '@playwright/test';
test('disabled registration requires explicit consent, retries pages without emails or cancellation, retains draft', async ({ page }) => {
  const posts = [];
  await page.route('**/api/**', route => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      return route.fulfill({json:{ registered: posts.length === 1 ? 1 : 0, existing: 1, missingEmail: 1, errors: [], nextCursor: posts.length === 1 ? 'booking-1' : null }});
    }
    return route.fulfill({json:{ confirmedBookings:3, cached:{topic:'Meeting',numericId:'123'},live:{topic:'Meeting',numericId:'123',registration_required:false,timezone:'Europe/London',join_url:'https://zoom.us/j/123'},counts:null }});
  });
  await page.goto('/tests/fixtures/zoom-registration.html');
  await page.getByLabel('Event title').fill('Keep my edits');
  await page.getByText('Manage Zoom').click();
  const action = page.getByTestId('button-change-zoom-confirm');
  await expect(action).toBeDisabled();
  await expect(page.getByText('Registration counts unavailable.', {exact:false})).toBeVisible();
  await expect(page.getByRole('link',{name:'Open attendee join link'})).toHaveAttribute('href','https://zoom.us/j/123');
  await page.getByText('Enable registration and register confirmed attendees',{exact:true}).click();
  await action.click();
  await expect(page.getByTestId('zoom-action-outcome')).toContainText('already registered: 2');
  expect(posts).toHaveLength(2);
  expect(posts.every(p => p.enableRegistration && !p.cancelOld && !p.resendConfirmations)).toBe(true);
  await page.getByTestId('button-change-zoom-cancel').click();
  await expect(page.getByLabel('Event title')).toHaveValue('Keep my edits');
});
test('provider failure blocks event action; shared session dialog still selects targets', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({json: route.request().url().includes('/meetings') ? [{id:'local',topic:'Shared meeting',zoom_meeting_id:'123'}] : {confirmedBookings:1,cached:{topic:'Meeting'},error:'Provider unavailable'}}));
  await page.goto('/tests/fixtures/zoom-registration.html');
  await page.getByText('Manage Zoom').click();
  await expect(page.getByTestId('button-change-zoom-confirm')).toBeDisabled();
  await expect(page.getByText('Provider unavailable')).toBeVisible();
  await page.goto('/tests/fixtures/zoom-registration.html?session');
  await page.getByText('Manage Zoom').click();
  await page.getByTestId('option-zoom-local').click();
  await expect(page.getByTestId('button-change-zoom-confirm')).toBeEnabled();
});
