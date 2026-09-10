import { test, expect } from '@playwright/test';

const campaignId = 'campaign-visual-regression';
const audienceListId = 'campaign-browser-audience';
const savedDesign = {
  type: 'custom-email-builder',
  version: 1,
  globalStyles: { backgroundColor: '#123456', contentWidth: '680px' },
  blocks: [{
    id: 'saved-columns',
    type: 'columns',
    styles: { paddingTop: '19' },
    columns: [{
      id: 'saved-left',
      width: '50%',
      backgroundColor: '#fedcba',
      blocks: [{
        id: 'saved-nested-image',
        type: 'image',
        src: 'https://images.example.invalid/saved-campaign.png',
        alt: 'Saved campaign image',
        styles: { imageSize: '61%', textAlign: 'right' },
      }],
    }, {
      id: 'saved-right',
      width: '50%',
      blocks: [{
        id: 'saved-nested-text',
        type: 'text',
        content: '<p>Saved campaign design, not current template</p>',
        styles: { color: '#654321' },
      }],
    }],
  }],
};
const replacementDesign = {
  type: 'custom-email-builder',
  version: 1,
  blocks: [{
    id: 'replacement-image',
    type: 'image',
    src: 'https://images.example.invalid/replacement.png',
    alt: 'Replacement template image',
    styles: { width: '73%', paddingLeft: '22' },
  }],
};
const templates = [{
  id: 'linked-template',
  name: 'Linked template (newer version)',
  subject: 'Changed linked subject',
  from_name: 'Changed linked sender',
  from_email: 'changed@example.invalid',
  body: '<p>Changed linked HTML</p>',
  editor_type: 'visual',
  design_json: replacementDesign,
  is_active: true,
}, {
  id: 'replacement-template',
  name: 'Replacement visual template',
  subject: 'Replacement subject',
  from_name: 'Replacement sender',
  from_email: 'replacement@example.invalid',
  body: '<p>Replacement generated HTML</p>',
  editor_type: 'visual',
  design_json: JSON.stringify(replacementDesign),
  is_active: true,
}, {
  id: 'html-template',
  name: 'Replacement HTML template',
  subject: 'HTML subject',
  body: '<h1>Replacement raw HTML</h1>',
  editor_type: 'html',
  design_json: replacementDesign,
  is_active: true,
}];

function campaign(overrides = {}) {
  return {
    id: campaignId,
    name: 'Campaign visual regression',
    subject: 'Saved campaign subject',
    from_name: 'Saved sender',
    from_email: 'saved@example.invalid',
    reply_to: 'reply@example.invalid',
    email_template_id: 'linked-template',
    html_content: '<p>Saved campaign HTML snapshot</p>',
    design_json: JSON.stringify(savedDesign),
    target_audiences: [{ type: 'audience_list', ids: [audienceListId] }],
    communication_category_id: null,
    scheduled_at: null,
    is_test_mode: false,
    ...overrides,
  };
}

async function installFixtures(page, campaignFixture) {
  const state = {
    campaign: campaignFixture,
    writes: [],
    escapedWrites: [],
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
  };
  const isKnownBenignConsole = text =>
    text.includes("Blocked script execution in 'about:srcdoc'")
    || text.includes('`DialogContent` requires a `DialogTitle`')
    || text.includes('Unexpected error updating last_activity: Error: Network Error: Failed to fetch');
  page.on('console', message => {
    if (message.type() === 'error') {
      if (!isKnownBenignConsole(message.text())) {
        state.consoleErrors.push(message.text());
        console.error(`[browser console] ${message.text()}`);
      }
    }
  });
  page.on('pageerror', error => {
    state.pageErrors.push(error.message);
    console.error(`[browser pageerror] ${error.message}`);
  });
  page.on('requestfailed', request => {
    const failure = `${request.method()} ${request.url()}: ${request.failure()?.errorText}`;
    // In-flight React Query requests are expected to be aborted by a deliberate
    // page reload; other transport failures remain test failures.
    if (!failure.includes('net::ERR_ABORTED')) {
      state.requestFailures.push(failure);
      console.error(`[browser requestfailed] ${failure}`);
    }
  });
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.context().route('https://images.example.invalid/**', route => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#369"/></svg>',
  }));
  await page.context().route('**/rest/v1/**', async route => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      state.escapedWrites.push(`${route.request().method()} ${route.request().url()}`);
      return json(route, { error: 'Unexpected direct mutation' }, 599);
    }
    return json(route, []);
  });
  await page.context().route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/auth/me') return json(route, {
      id: 'campaign-test-user',
      tenant_id: 'campaign-test-tenant',
      organization_id: 'campaign-test-org',
      role_id: 'campaign-test-role',
      email: 'campaign-test@example.invalid',
      first_name: 'Campaign',
      last_name: 'Tester',
      is_team_member: false,
      member_excluded_features: [],
    });
    if (path === '/api/auth/tenant-user-me') return json(route, {
      user: { id: 'campaign-test-user' },
      tenant: { id: 'campaign-test-tenant' },
    });
    if (path === `/api/email-campaigns/${campaignId}` && method === 'GET') {
      return json(route, state.campaign);
    }
    if (path === `/api/email-campaigns/${campaignId}` && method === 'PATCH') {
      const body = request.postDataJSON();
      state.writes.push(body);
      state.campaign = { ...state.campaign, ...body };
      return json(route, state.campaign);
    }
    if (path === '/api/email-campaigns' && method === 'POST') {
      const body = request.postDataJSON();
      state.writes.push(body);
      state.campaign = { id: campaignId, ...body };
      return json(route, state.campaign);
    }
    if (path === '/api/email-campaigns/send' && method === 'POST') {
      return json(route, {
        recipientCount: 1,
        stats: {
          totalAudience: 1,
          globalOptOuts: 0,
          categoryOptOuts: 0,
          duplicatesRemoved: 0,
          finalCount: 1,
        },
      });
    }
    if (path === '/api/email-campaigns/preview-footer') {
      return json(route, { footer: null, hasFooter: false });
    }
    if (path === '/api/entities/EmailTemplate') return json(route, templates);
    if (path === '/api/audience-lists') return json(route, [{
      id: audienceListId,
      name: 'Browser regression audience',
      member_count: 1,
    }]);
    if (path === '/api/entities/Role') return json(route, [{
      id: 'campaign-test-role',
      name: 'Administrator',
      excluded_features: [],
    }]);
    if (path === '/api/entities/Organization') return json(route, [{
      id: 'campaign-test-org',
      name: 'Campaign test organisation',
    }]);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      state.escapedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });
  return state;
}

function expectNoBrowserErrors(state) {
  expect(state.pageErrors, `page errors: ${state.pageErrors.join('\n')}`).toEqual([]);
  expect(state.consoleErrors, `console errors: ${state.consoleErrors.join('\n')}`).toEqual([]);
  expect(state.requestFailures, `request failures: ${state.requestFailures.join('\n')}`).toEqual([]);
}

test('saved campaign design wins over its linked template in the real builder', async ({ page }, testInfo) => {
  const state = await installFixtures(page, campaign());
  await page.goto(`/EmailCampaignEdit/${campaignId}`);
  await expect(page.getByRole('heading', { name: 'Edit Campaign' })).toBeVisible();
  await expect(page.getByTestId('input-campaign-subject')).toHaveValue('Saved campaign subject');
  await expect(page.getByTestId('button-open-visual-editor')).toContainText('Edit Design');

  await page.getByTestId('button-open-visual-editor').click();
  await expect(page.getByTestId('email-builder-layout')).toBeVisible();
  await expect(page.getByTestId('block-saved-columns')).toBeVisible();
  await expect(page.getByTestId('column-child-saved-nested-image')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Saved campaign image' })).toHaveAttribute(
    'src',
    'https://images.example.invalid/saved-campaign.png',
  );
  await expect(page.getByText('Saved campaign design, not current template')).toBeVisible();
  await expect(page.getByTestId('block-replacement-image')).toHaveCount(0);
  const builderScreenshot = testInfo.outputPath('campaign-visual-builder.png');
  await page.screenshot({ path: builderScreenshot, fullPage: false });
  await testInfo.attach('campaign-visual-builder.png', {
    path: builderScreenshot,
    contentType: 'image/png',
  });
  expect(state.escapedWrites).toEqual([]);
  expectNoBrowserErrors(state);
});

test('replacement confirmations cover visual to HTML clearing and start-new', async ({ page }) => {
  const state = await installFixtures(page, campaign());
  await page.goto(`/EmailCampaignEdit/${campaignId}`);
  await expect(page.getByTestId('button-open-visual-editor')).toBeVisible();

  await page.getByTestId('select-template').click();
  await page.getByRole('option', { name: 'Replacement visual template' }).click();
  await expect(page.getByTestId('button-confirm-content-replacement')).toBeVisible();
  await page.getByTestId('button-confirm-content-replacement').click();
  await page.getByTestId('button-open-visual-editor').click();
  await expect(page.getByTestId('block-replacement-image')).toBeVisible();
  await page.getByTestId('button-cancel-visual-editor').click();

  await page.getByTestId('select-template').click();
  await page.getByRole('option', { name: 'Replacement HTML template' }).click();
  await expect(page.getByTestId('button-confirm-content-replacement')).toBeVisible();
  await page.getByTestId('button-confirm-content-replacement').click();
  await expect(page.getByTestId('textarea-html-content')).toHaveValue('<h1>Replacement raw HTML</h1>');
  await page.getByTestId('button-save-campaign').click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].design_json).toBeNull();
  expect(state.writes[0].html_content).toBe('<h1>Replacement raw HTML</h1>');

  await page.getByTestId('button-start-new-design').click();
  await expect(page.getByTestId('button-confirm-content-replacement')).toBeVisible();
  await page.getByTestId('button-confirm-content-replacement').click();
  await expect(page.getByTestId('email-builder-layout')).toBeVisible();
  await expect(page.getByText('Drag blocks here to build your email')).toBeVisible();
  expect(state.escapedWrites).toEqual([]);
  expectNoBrowserErrors(state);
});

test('HTML-only campaign preserves HTML, explains visual mode, and can reload its linked visual template', async ({ page }) => {
  const rawHtml = '<article><h1>Hand-authored campaign</h1></article>';
  const state = await installFixtures(page, campaign({
    email_template_id: 'linked-template',
    html_content: rawHtml,
    design_json: '{"blocks":"malformed"}',
  }));
  await page.goto(`/EmailCampaignEdit/${campaignId}`);
  await expect(page.getByTestId('textarea-html-content')).toHaveValue(rawHtml);
  await page.getByTestId('button-save-campaign').click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].html_content).toBe(rawHtml);
  expect(state.writes[0].design_json).toBeNull();
  await page.reload();
  await expect(page.getByTestId('textarea-html-content')).toHaveValue(rawHtml);

  await page.getByTestId('button-visual-mode').click();
  await expect(page.getByTestId('button-start-new-design')).toBeVisible();
  await expect(page.getByTestId('email-builder-layout')).toHaveCount(0);
  await expect(page.getByTestId('iframe-visual-preview')).toBeVisible();

  await page.getByTestId('button-reload-template').click();
  await expect(page.getByTestId('button-confirm-content-replacement')).toBeVisible();
  await page.getByTestId('button-confirm-content-replacement').click();
  await page.getByTestId('button-open-visual-editor').click();
  await expect(page.getByTestId('block-replacement-image')).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.escapedWrites).toEqual([]);
  expectNoBrowserErrors(state);
});

test('new blank campaign edits the real builder, saves, and reopens its design snapshot', async ({ page }) => {
  const state = await installFixtures(page, null);
  await page.goto('/EmailCampaignEdit/new');
  await expect(page.getByRole('heading', { name: 'Create Campaign' })).toBeVisible();
  await page.getByTestId('input-campaign-name').fill('New browser campaign');
  await page.getByTestId('input-campaign-subject').fill('New browser subject');
  await page.getByTestId(`list-option-${audienceListId}`).locator('input').check();

  await page.getByTestId('button-open-visual-editor').click();
  await expect(page.getByTestId('email-builder-layout')).toBeVisible();
  const emptyCanvas = page.getByText('Drag blocks here to build your email');
  await expect(emptyCanvas).toBeVisible();
  const paletteBox = await page.getByTestId('palette-block-text').boundingBox();
  const canvasBox = await emptyCanvas.boundingBox();
  expect(paletteBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move(
    paletteBox.x + paletteBox.width / 2,
    paletteBox.y + paletteBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    paletteBox.x + paletteBox.width / 2 + 12,
    paletteBox.y + paletteBox.height / 2 + 12,
    { steps: 4 },
  );
  await page.mouse.move(
    canvasBox.x + canvasBox.width / 2,
    canvasBox.y + canvasBox.height / 2,
    { steps: 20 },
  );
  await page.mouse.up();
  await expect(page.locator('[data-testid^="block-block-"]')).toHaveCount(1);
  // EmailBuilder intentionally debounces its parent onChange notification.
  // Wait for the campaign form to own the edited design before saving.
  await page.waitForTimeout(500);
  await page.getByTestId('button-save-visual-editor').click();

  await expect(page).toHaveURL(new RegExp(`/EmailCampaignEdit/${campaignId}$`));
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].design_json.blocks).toHaveLength(1);
  expect(state.writes[0].design_json.blocks[0].type).toBe('text');
  expect(state.writes[0].html_content).toContain('Click to edit text');

  await page.reload();
  await expect(page.getByTestId('button-open-visual-editor')).toContainText('Edit Design');
  await page.getByTestId('button-open-visual-editor').click();
  await expect(page.locator('[data-testid^="block-block-"]')).toHaveCount(1);
  await expect(page.getByText('Click to edit text...', { exact: true }).first()).toBeVisible();
  expect(state.escapedWrites).toEqual([]);
  expectNoBrowserErrors(state);
});