import { test, expect } from "@playwright/test";

const FORM_SLUG = "test-page-hide";
const FORM_ID = "embed-page-visibility-fixture";
const COUNTRY_ID = "country";
const JOURNAL_ID = "journal";
const DELIVERY_ID = "nmc-journal-delivery";
const COMMUNICATIONS_ID = "communications";
const PAGE_COUNTRY_ID = "page-country-journal";
const PAGE_JOURNAL_ID = "page-nmc-journal";
const PAGE_COMMUNICATIONS_ID = "page-communications";
const TEST_URL = `/embed/form/${FORM_SLUG}?tenant=gsf`;

const guest = {
  id: null,
  tenant_id: "gsf",
  viewer_kind: "guest",
};

function formFixture() {
  return {
    id: FORM_ID,
    slug: FORM_SLUG,
    name: "Embedded page visibility fixture",
    description: "A three-page fixture for conditional page visibility.",
    form_type: "application",
    layout_type: "standard",
    require_authentication: false,
    is_active: true,
    prefill_source: "none",
    fields: [
      {
        id: COUNTRY_ID,
        type: "country",
        label: "Country",
        required: true,
        default_country: "GB",
      },
      {
        id: JOURNAL_ID,
        type: "boolean",
        label: "Would you like the NMC Journal?",
        required: false,
        default_value: false,
      },
      {
        id: DELIVERY_ID,
        type: "text",
        label: "NMC Journal delivery",
        required: true,
        placeholder: "Delivery details",
        page_id: PAGE_JOURNAL_ID,
      },
      {
        id: COMMUNICATIONS_ID,
        type: "text",
        label: "Communications",
        required: false,
        placeholder: "Optional communications details",
        page_id: PAGE_COMMUNICATIONS_ID,
      },
    ],
    pages: [
      {
        id: PAGE_COUNTRY_ID,
        title: "Country and Journal",
        starts_hidden: false,
      },
      {
        id: PAGE_JOURNAL_ID,
        title: "NMC Journal",
        starts_hidden: false,
      },
      {
        id: PAGE_COMMUNICATIONS_ID,
        title: "Communications",
        starts_hidden: false,
      },
    ],
    // This intentionally mirrors the mixed action shape from rule 15: the
    // condition both writes a value and hides a page. The page action targets
    // the page id (not the required field id), so a hidden page must disappear
    // from pagination and its required field must not block Next.
    visibility_rules: [
      {
        id: "rule15",
        conditions: [
          {
            field_id: COUNTRY_ID,
            operator: "equals",
            value: "United Kingdom",
          },
          {
            field_id: JOURNAL_ID,
            operator: "equals",
            value: "false",
          },
        ],
        logic: "and",
        actions: [
          {
            id: "rule15-set-delivery",
            action_type: "set_value",
            target_field_id: DELIVERY_ID,
            set_value_source: "static",
            set_value: "No",
          },
          {
            id: "rule15-hide-journal-page",
            action_type: "visibility",
            field_states: {
              [PAGE_JOURNAL_ID]: { visible: false },
            },
          },
        ],
      },
    ],
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    submit_button_text: "Submit fixture",
    success_message: "Fixture submitted.",
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * Install a completely local browser fixture. The API route answers every
 * /api request, while the catch-all route prevents accidental calls to
 * Supabase, payment providers, fonts, or any other external service.
 */
async function installFixtures(page) {
  const state = {
    form: formFixture(),
    apiRequests: [],
    blockedWrites: [],
    unexpectedWrites: [],
    externalRequests: [],
    submissions: [],
    pageErrors: [],
  };
  const localBaseURL = process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://127.0.0.1:5000");
  const localOrigin = new URL(localBaseURL).origin;

  page.on("pageerror", error => state.pageErrors.push(error.message));

  // Register the broad guard first. Playwright checks the later, more
  // specific /api route before this fallback.
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.blockedWrites.push(`${method} ${url.href}`);
      return json(route, { error: "Browser fixture blocks all network writes" }, 599);
    }
    if (url.origin !== localOrigin) {
      // The development shell injects these read-only assets before the
      // embedded form mounts. They are unrelated to form behavior and are
      // still aborted below; keep the assertion focused on unexpected
      // external API/data calls.
      const expectedStaticAsset = (
        url.hostname === "cdnjs.cloudflare.com"
        || url.hostname === "fonts.googleapis.com"
        || url.hostname === "js.stripe.com"
        || url.hostname === "va.vercel-scripts.com"
      );
      if (!expectedStaticAsset) {
        state.externalRequests.push(`${method} ${url.href}`);
      }
      return route.abort();
    }
    return route.continue();
  });

  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (!path.startsWith("/api/")) return route.continue();
    state.apiRequests.push(`${method} ${path}${url.search}`);

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: "Fixture mutation blocked" }, 599);
    }

    // Auth is deliberately guest/anonymous. EmbedForm should still fetch the
    // public form shape and must not redirect or ask for member prefill.
    if (path === "/api/auth/me") {
      return json(route, guest, 401);
    }
    if (path === `/api/public/form/${FORM_SLUG}`) {
      return json(route, state.form);
    }

    // Keep every optional API read local and inert. This makes newly mounted
    // form helpers fail closed instead of reaching a real provider.
    return json(route, []);
  });

  return state;
}

async function expectPageCounter(page, counter) {
  await expect(page.getByText(counter, { exact: true })).toBeVisible();
}

function fieldInput(page) {
  return page.locator('input[type="text"]').first();
}

test("guest embedded form skips and restores a conditionally hidden page", async ({ page }, testInfo) => {
  const state = await installFixtures(page);

  await page.goto(TEST_URL);
  await expect(page.getByTestId("embed-form-container")).toBeVisible();

  // GB is stored as the display name before conditions are evaluated. The
  // boolean defaults to No, so rule 15 is active without user setup.
  await expect(page.getByTestId(`select-country-${COUNTRY_ID}`))
    .toContainText("United Kingdom");
  await expect(page.getByTestId(`switch-boolean-${JOURNAL_ID}`))
    .toHaveAttribute("aria-checked", "false");
  await expectPageCounter(page, "Page 1 of 2");
  await expect(page.getByText("NMC Journal delivery", { exact: true })).toHaveCount(0);

  // The hidden required page is omitted entirely. Next goes directly to
  // Communications, and its optional field is the only text input on that
  // page.
  await page.getByTestId("button-next-page").click();
  await expectPageCounter(page, "Page 2 of 2");
  await expect(page.getByText("Communications", { exact: true })).toBeVisible();
  await expect(page.getByText("NMC Journal delivery", { exact: true })).toHaveCount(0);
  await expect(fieldInput(page)).toHaveAttribute("placeholder", "Optional communications details");

  // Restore Yes. The page count and required page must come back, and an
  // empty required delivery field must prevent navigation.
  await page.getByTestId("button-previous-page").click();
  await expectPageCounter(page, "Page 1 of 2");
  await page.getByTestId(`switch-boolean-${JOURNAL_ID}`).click();
  await expect(page.getByTestId(`switch-boolean-${JOURNAL_ID}`))
    .toHaveAttribute("aria-checked", "true");
  await expectPageCounter(page, "Page 1 of 3");

  await page.getByTestId("button-next-page").click();
  await expectPageCounter(page, "Page 2 of 3");
  await expect(page.getByText("NMC Journal delivery", { exact: false })).toBeVisible();
  await expect(fieldInput(page)).toHaveAttribute("placeholder", "Delivery details");

  await page.getByTestId("button-next-page").click();
  await expectPageCounter(page, "Page 2 of 3");
  await expect(page.getByText("NMC Journal delivery", { exact: false })).toBeVisible();
  await expect(page.getByText("Communications", { exact: true })).toHaveCount(0);

  // A completed required page can advance normally.
  await fieldInput(page).fill("Fixture delivery details");
  await page.getByTestId("button-next-page").click();
  await expectPageCounter(page, "Page 3 of 3");
  await expect(page.getByText("Communications", { exact: true })).toBeVisible();

  // Return to page 1 and select No again. The page hidden from the current
  // pagination is removed, and the resulting index stays clamped to a valid
  // visible page when navigating forward.
  await page.getByTestId("button-previous-page").click();
  await expectPageCounter(page, "Page 2 of 3");
  await page.getByTestId("button-previous-page").click();
  await expectPageCounter(page, "Page 1 of 3");
  await page.getByTestId(`switch-boolean-${JOURNAL_ID}`).click();
  await expect(page.getByTestId(`switch-boolean-${JOURNAL_ID}`))
    .toHaveAttribute("aria-checked", "false");
  await expectPageCounter(page, "Page 1 of 2");
  await expect(page.getByText("NMC Journal delivery", { exact: true })).toHaveCount(0);

  // Show the page again and verify the previously entered local answer was
  // retained while the hidden page was absent from pagination.
  await page.getByTestId(`switch-boolean-${JOURNAL_ID}`).click();
  await expect(page.getByTestId(`switch-boolean-${JOURNAL_ID}`))
    .toHaveAttribute("aria-checked", "true");
  await expectPageCounter(page, "Page 1 of 3");
  await page.getByTestId("button-next-page").click();
  await expectPageCounter(page, "Page 2 of 3");
  await expect(page.getByText("NMC Journal delivery", { exact: false })).toBeVisible();
  await expect(fieldInput(page)).toHaveValue("Fixture delivery details");

  await page.screenshot({
    path: testInfo.outputPath("embed-page-visibility-fix.png"),
    fullPage: true,
  });
  await testInfo.attach("fixture-network.json", {
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(state, null, 2)),
  });

  expect(state.submissions).toEqual([]);
  expect(state.blockedWrites).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.externalRequests).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  expect(state.apiRequests.some(request => (
    request.startsWith(`GET /api/public/form/${FORM_SLUG}?tenant=`)
  ))).toBe(true);
});
