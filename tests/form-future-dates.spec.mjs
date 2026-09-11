import { test, expect } from "@playwright/test";

const FORM_ID = "form-future-dates-fixture";
const FORM_SLUG = "form-future-dates-fixture";
const TOP_DATE_ID = "future-date";
const HIDDEN_DATE_ID = "hidden-optional-date";
const ROWS_ID = "future-date-rows";
const CHILD_DATE_ID = "repeatable-future-date";

// Deliberately put the fixture just before UTC midnight. The test project uses
// a timezone west of UTC, so local-date implementations will choose the wrong
// minimum date.
const CLOCK = {
  initial: "2040-02-29T23:59:00.000Z",
  afterMidnight: "2040-03-01T00:01:00.000Z",
  yesterday: "2040-02-28",
  today: "2040-02-29",
  tomorrow: "2040-03-01",
  dayAfterTomorrow: "2040-03-02",
};

const adminMember = {
  id: "future-dates-admin",
  tenant_id: "future-dates-tenant",
  organization_id: "future-dates-organisation",
  role_id: "future-dates-admin-role",
  email: "future-dates-admin@example.invalid",
  first_name: "Future",
  last_name: "Dates",
  member_excluded_features: [],
};

const adminRole = {
  id: adminMember.role_id,
  name: "Administrator",
  excluded_features: [],
};

function formFixture({ futureOnly = true } = {}) {
  return {
    id: FORM_ID,
    slug: FORM_SLUG,
    name: "Future dates fixture",
    description: "A fixture form for future-only native dates.",
    blank_layout: true,
    layout_type: "standard",
    fields: [
      {
        id: TOP_DATE_ID,
        type: "date",
        label: "Future date",
        required: true,
        future_only: futureOnly,
      },
      {
        id: HIDDEN_DATE_ID,
        type: "date",
        label: "Hidden optional date",
        required: false,
        starts_hidden: true,
        future_only: futureOnly,
        // This represents a restored value which is now invalid under the
        // future-only policy. It is optional and hidden, so it must not block
        // an otherwise valid submission.
        default_value: CLOCK.yesterday,
      },
      {
        id: ROWS_ID,
        type: "repeatable_rows",
        label: "Future-date rows",
        min_rows: 0,
        max_rows: 2,
        add_row_label: "Add date row",
        repeatable_rows_version: 1,
        children: [
          {
            id: CHILD_DATE_ID,
            type: "date",
            label: "Repeatable child date",
            required: true,
            // Keep the nested future-only field enabled while the builder test
            // toggles the top-level field. This proves the child survives the
            // same persisted form shape and is exercised on both public
            // renderers below.
            future_only: true,
          },
        ],
      },
    ],
    pages: [],
    visibility_rules: [],
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    require_authentication: false,
    is_active: true,
    form_type: "application",
    submit_button_text: "Submit fixture",
    success_message: "Future date fixture submitted.",
    allow_save_continue_later: false,
    prefill_source: "none",
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
 * Keep the browser test entirely local. The broad /api/ route intentionally
 * has the same shape as the membership-return harness: source modules such as
 * /src/api/... are continued, while only request pathnames beginning with
 * /api/ are fixture responses.
 */
async function installFixtures(page, { futureOnly = true } = {}) {
  const state = {
    form: formFixture({ futureOnly }),
    saves: [],
    submissions: [],
    apiRequests: [],
    unexpectedWrites: [],
    supabaseWrites: [],
    pageErrors: [],
  };

  page.on("pageerror", error => state.pageErrors.push(error.message));

  await page.addInitScript(({ initial }) => {
    const NativeDate = Date;
    let now = NativeDate.parse(initial);

    class FixtureDate extends NativeDate {
      constructor(...args) {
        super(...(args.length === 0 ? [now] : args));
      }

      static now() {
        return now;
      }
    }

    // Date.parse/UTC are inherited by the subclass, but keeping the explicit
    // references makes the fixture robust across Chromium versions.
    FixtureDate.parse = NativeDate.parse;
    FixtureDate.UTC = NativeDate.UTC;
    window.Date = FixtureDate;
    window.__setFutureDatesFixtureNow = (iso) => {
      const parsed = NativeDate.parse(iso);
      if (!Number.isNaN(parsed)) now = parsed;
    };
  }, { initial: CLOCK.initial });

  await page.context().route("**/rest/v1/**", async route => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.supabaseWrites.push(`${request.method()} ${request.url()}`);
      return json(route, { error: "Supabase mutations are blocked in browser fixtures" }, 599);
    }
    return json(route, []);
  });

  await page.context().route("**/auth/v1/**", async route => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.supabaseWrites.push(`${request.method()} ${request.url()}`);
      return json(route, { error: "Supabase mutations are blocked in browser fixtures" }, 599);
    }
    return json(route, []);
  });

  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname: path } = url;
    const method = request.method();

    // Vite source imports can contain /src/api/ in the path. Never answer
    // those module requests with JSON; only real /api/ endpoint paths belong
    // to this harness.
    if (!path.startsWith("/api/")) return route.continue();

    state.apiRequests.push(`${method} ${path}${url.search}`);

    if (path === "/api/auth/me") {
      return json(route, adminMember);
    }
    if (path === "/api/auth/tenant-user-me") {
      return json(route, {
        user: adminMember,
        tenant: { id: adminMember.tenant_id, slug: FORM_SLUG },
      });
    }
    if (path === `/api/entities/Role/${adminRole.id}`) return json(route, adminRole);
    if (path === "/api/entities/Role") return json(route, [adminRole]);

    if (path === "/api/entities/Form" && method === "GET") {
      return json(route, [state.form]);
    }
    if (path === `/api/entities/Form/${FORM_ID}` && method === "PATCH") {
      const patch = request.postDataJSON() || {};
      state.saves.push(patch);
      state.form = { ...state.form, ...patch };
      return json(route, state.form);
    }

    if (path === `/api/public/form/${FORM_SLUG}` && method === "GET") {
      return json(route, state.form);
    }
    if (path === "/api/public/form-consent-message" && method === "GET") {
      return json(route, { message: "" });
    }
    if (path === "/api/public/form-draft" && method === "GET") {
      return json(route, {
        success: true,
        draft: {
          draft_data: {
            [HIDDEN_DATE_ID]: CLOCK.yesterday,
          },
          current_page_index: 0,
        },
      });
    }
    if (path === "/api/public/form-submission" && method === "POST") {
      const body = request.postDataJSON() || {};
      state.submissions.push(body);
      return json(route, { success: true, submission_id: "future-dates-submission" });
    }
    // FormView retains a legacy client-side diagnostic call after a successful
    // submission. The server-side sender is already mocked by the submission
    // response above, so acknowledge this expected follow-up without allowing
    // it to become an unmocked production write.
    if (path === "/api/forms/send-submission-email" && method === "POST") {
      return json(route, { success: true, skipped: true });
    }

    if (path === `/api/forms/${FORM_ID}/relationship-definitions` && method === "GET") {
      return json(route, { data: [], custom_objects: [] });
    }
    if (path === "/api/admin/integrations" && method === "GET") {
      return json(route, { integrations: [] });
    }
    if (path === "/api/public/tenant-branding" && method === "GET") {
      return json(route, {
        success: true,
        branding: {
          name: "Future dates fixture",
          primaryColor: "#155e75",
          footerConfig: { backgroundColor: "#102a43", textColor: "#ffffff" },
          footerSource: "standard",
        },
      });
    }
    if (path === "/api/public/navigation-items" && method === "GET") return json(route, []);
    if (path === "/api/public/microsites" && method === "GET") return json(route, { microsites: [] });
    if (path === "/api/public/resource-categories" && method === "GET") return json(route, []);

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected fixture mutation: ${method} ${path}` }, 599);
    }

    // Optional admin/public reads are deliberately inert, but remain inside
    // the /api/ pathname guard above so no real API can be reached.
    return json(route, []);
  });

  return state;
}

function dateInput(scope, fieldId) {
  return scope.getByTestId(`input-date-${fieldId}`);
}

function futureToggle(scope, fieldId) {
  return scope.getByTestId(`switch-future-only-${fieldId}`);
}

async function submitAndExpectNoWrite(page, state, input, value, baseline) {
  await input.fill(value);
  await expect(input).toHaveJSProperty("validity.valid", false);
  const inputId = await input.getAttribute("id");
  const fieldId = inputId?.replace(/^input-date-/, "");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId(`error-date-${fieldId}`)).toBeVisible();
  await page.getByTestId("button-submit-form").click();
  // The submit path is synchronous with respect to the native-date validity,
  // but allow React's controlled input/effect turn to settle before checking
  // the mocked endpoint.
  await page.waitForTimeout(150);
  expect(state.submissions).toHaveLength(baseline);
}

async function exerciseFutureSurface(page, state, path, testInfo, { draft = false } = {}) {
  const destination = draft ? `${path}&draft=future-dates-draft` : path;
  await page.goto(destination);

  const topDate = dateInput(page, TOP_DATE_ID);
  await expect(topDate).toBeVisible();
  await expect(topDate).toHaveAttribute("type", "date");
  await expect(topDate).toHaveAttribute("min", CLOCK.tomorrow);

  // The optional hidden date is restored from the mocked draft/default data,
  // but must not be rendered or participate in validation.
  await expect(dateInput(page, HIDDEN_DATE_ID)).toHaveCount(0);

  await page.getByTestId(`button-add-repeatable-row-${ROWS_ID}`).click();
  const row = page.getByTestId(`repeatable-row-${ROWS_ID}-0`);
  // Repeatable child controls are rendered through the nested renderer. Use
  // the native type within the row so this remains stable across the
  // renderer's row-specific test-id normalization.
  const childDate = row.locator('input[type="date"]').first();
  await expect(childDate).toBeVisible();
  await expect(childDate).toHaveAttribute("type", "date");
  await expect(childDate).toHaveAttribute("min", CLOCK.tomorrow);

  const baseline = state.submissions.length;

  // Both dates are required in this active row. Exercise both sides of the
  // date-only boundary: yesterday and today reject, while strict UTC tomorrow
  // is accepted.
  await childDate.fill(CLOCK.tomorrow);
  await submitAndExpectNoWrite(page, state, topDate, CLOCK.yesterday, baseline);
  await submitAndExpectNoWrite(page, state, topDate, CLOCK.today, baseline);

  await topDate.fill(CLOCK.tomorrow);
  await submitAndExpectNoWrite(page, state, childDate, CLOCK.yesterday, baseline);
  await submitAndExpectNoWrite(page, state, childDate, CLOCK.today, baseline);

  await childDate.fill(CLOCK.tomorrow);
  await page.getByTestId("button-submit-form").click();
  await expect.poll(() => state.submissions.length).toBe(baseline + 1);

  const submission = state.submissions.at(-1);
  expect(submission.submission_data?.[TOP_DATE_ID]).toBe(CLOCK.tomorrow);
  expect(submission.submission_data?.[ROWS_ID]?.[0]?.[CHILD_DATE_ID]).toBe(CLOCK.tomorrow);
  expect(submission.submission_data?.[HIDDEN_DATE_ID]).toBe(CLOCK.yesterday);

  if (path.startsWith("/embed/")) {
    await expect(page.getByTestId("embed-form-success")).toBeVisible();
  } else {
    await expect(page.getByText("Success!", { exact: true })).toBeVisible();
  }

  await page.screenshot({
    path: testInfo.outputPath(path.startsWith("/embed/")
      ? "embed-future-date-preview.png"
      : "form-view-future-date-preview.png"),
    fullPage: true,
  });
}

test("FormBuilder future-only toggle persists and its saved form preview enforces strict UTC tomorrow", async ({ page }, testInfo) => {
  const state = await installFixtures(page, { futureOnly: false });
  await page.goto(`/FormBuilder?formId=${FORM_ID}`);

  const configure = page.getByTestId(`button-configure-field-${TOP_DATE_ID}`);
  await expect(configure).toBeVisible();
  await configure.click();

  const toggle = futureToggle(page, TOP_DATE_ID);
  await expect(toggle).toHaveAttribute("role", "switch");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // The field editor is a modal; close it before interacting with the
  // page-level save action underneath the dialog.
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Save Form", exact: true }).click();
  await expect.poll(() => state.saves.length).toBeGreaterThan(0);

  const savedFields = state.saves.at(-1).fields;
  expect(savedFields.find(field => field.id === TOP_DATE_ID)?.future_only).toBe(true);
  // The repeatable child is persisted by the same form save and exercises the
  // nested schema without relying on a second invented API.
  expect(savedFields.find(field => field.id === ROWS_ID)?.children
    .find(field => field.id === CHILD_DATE_ID)?.future_only).toBe(true);

  await page.reload();
  await page.getByTestId(`button-configure-field-${TOP_DATE_ID}`).click();
  await expect(futureToggle(page, TOP_DATE_ID)).toHaveAttribute("aria-checked", "true");

  // This is the real public FormView preview of the persisted builder state,
  // not a second injected form object.
  await page.goto(`/FormView?slug=${FORM_SLUG}`);
  await expect(dateInput(page, TOP_DATE_ID)).toHaveAttribute("min", CLOCK.tomorrow);
  await page.screenshot({
    path: testInfo.outputPath("builder-persisted-future-date-preview.png"),
    fullPage: true,
  });

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("FormView and EmbedForm reject yesterday/today, accept UTC tomorrow, and ignore a restored hidden optional invalid date", async ({ page }, testInfo) => {
  const state = await installFixtures(page, { futureOnly: true });

  await exerciseFutureSurface(
    page,
    state,
    `/FormView?slug=${FORM_SLUG}`,
    testInfo,
    { draft: true },
  );

  await exerciseFutureSurface(
    page,
    state,
    `/embed/form/${FORM_SLUG}`,
    testInfo,
  );

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("turning future-only off removes the native minimum and permits an otherwise unrestricted historical date", async ({ page }) => {
  const state = await installFixtures(page, { futureOnly: true });
  await page.goto(`/FormBuilder?formId=${FORM_ID}`);
  await page.getByTestId(`button-configure-field-${TOP_DATE_ID}`).click();

  const toggle = futureToggle(page, TOP_DATE_ID);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Save Form", exact: true }).click();
  await expect.poll(() => state.saves.length).toBeGreaterThan(0);
  expect(state.saves.at(-1).fields.find(field => field.id === TOP_DATE_ID)?.future_only).toBe(false);

  await page.goto(`/FormView?slug=${FORM_SLUG}`);
  const topDate = dateInput(page, TOP_DATE_ID);
  await expect(topDate).not.toHaveAttribute("min");
  await topDate.fill(CLOCK.yesterday);
  await expect(topDate).toHaveJSProperty("validity.valid", true);
  await page.getByTestId("button-submit-form").click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].submission_data?.[TOP_DATE_ID]).toBe(CLOCK.yesterday);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
});

test("future-only native date refreshes its UTC minimum when focused after midnight", async ({ page }) => {
  const state = await installFixtures(page, { futureOnly: true });
  await page.goto(`/FormView?slug=${FORM_SLUG}`);

  const input = dateInput(page, TOP_DATE_ID);
  await expect(input).toHaveAttribute("min", CLOCK.tomorrow);

  await page.evaluate((iso) => window.__setFutureDatesFixtureNow(iso), CLOCK.afterMidnight);
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.dispatchEvent(new Event("focus"));
  });
  await input.focus();
  await expect(input).toHaveAttribute("min", CLOCK.dayAfterTomorrow);

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
});