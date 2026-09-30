import { test, expect } from "@playwright/test";

const FORM_ID = "form-width-fixture";
const FORM_SLUG = "form-width-fixture";
const PAGE_ONE_ID = "form-width-page-one";
const PAGE_TWO_ID = "form-width-page-two";
const PAGE_TWO_LEFT_ID = "form-width-page-two-left";
const PAGE_TWO_RIGHT_ID = "form-width-page-two-right";
const PRICE_FIELD_ID = "form-width-price";
const PAYMENT_ID = "form-width-payment";

const WIDTHS = {
  narrow: 768,
  medium: 1024,
  wide: 1280,
};

const ADMIN_MEMBER = {
  id: "form-width-admin",
  tenant_id: "form-width-tenant",
  organization_id: "form-width-organisation",
  role_id: "form-width-admin-role",
  email: "form-width-admin@example.invalid",
  first_name: "Form",
  last_name: "Width",
  member_excluded_features: [],
};

const ADMIN_ROLE = {
  id: ADMIN_MEMBER.role_id,
  name: "Administrator",
  excluded_features: [],
};

function formFixture(formWidth = "narrow") {
  return {
    id: FORM_ID,
    slug: FORM_SLUG,
    name: "Form width fixture",
    description: "A fixture used to verify responsive form width behavior.",
    layout_type: "standard",
    form_width: formWidth,
    fields: [
      {
        id: "form-width-page-one-name",
        type: "text",
        label: "Page one field",
        page_id: PAGE_ONE_ID,
        column_index: 0,
        required: false,
      },
      {
        id: "form-width-page-one-notes",
        type: "text",
        label: "Page one notes",
        page_id: PAGE_ONE_ID,
        column_index: 1,
        required: false,
      },
      {
        id: PRICE_FIELD_ID,
        type: "currency",
        label: "Price",
        page_id: PAGE_ONE_ID,
        column_index: 0,
        required: false,
      },
      {
        id: PAGE_TWO_LEFT_ID,
        type: "email",
        label: "Column one",
        page_id: PAGE_TWO_ID,
        column_index: 0,
        required: false,
      },
      {
        id: PAGE_TWO_RIGHT_ID,
        type: "email",
        label: "Column two",
        page_id: PAGE_TWO_ID,
        column_index: 1,
        required: false,
      },
      {
        id: PAYMENT_ID,
        type: "payment",
        label: "Payment",
        payment_label: "Payment",
        payment_description: "Payment details",
        payment_currency: "GBP",
        payment_providers: ["stripe"],
        price_field_id: PRICE_FIELD_ID,
        page_id: PAGE_TWO_ID,
        // Payment is deliberately assigned to a column. FormView extracts it
        // below its desktop grid; EmbedForm preserves its existing stacked
        // field layout rather than inventing columns.
        column_index: 1,
        required: false,
      },
    ],
    pages: [
      {
        id: PAGE_ONE_ID,
        title: "Details",
        column_count: 2,
      },
      {
        id: PAGE_TWO_ID,
        title: "Payment",
        column_count: 2,
      },
    ],
    visibility_rules: [],
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    require_authentication: false,
    access_policy: null,
    is_active: true,
    form_type: "standard",
    submit_button_text: "Submit fixture",
    success_message: "Form width fixture submitted.",
    allow_save_continue_later: false,
    prefill_source: "none",
    is_contract: false,
    blank_layout: true,
    survey_settings: {},
  };
}

function cardSwipeFixture(formWidth = "narrow") {
  const form = formFixture(formWidth);
  return {
    ...form,
    layout_type: "card_swipe",
    pages: [],
    fields: [
      {
        id: "form-width-card-swipe-first",
        type: "text",
        label: "Card swipe first field",
        required: false,
      },
      {
        id: "form-width-card-swipe-second",
        type: "text",
        label: "Card swipe second field",
        required: false,
      },
    ],
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
 * Keep every request in this suite local. The builder and both public form
 * surfaces use the same mutable fixture object, which makes the builder test
 * exercise the actual saved form shape rather than a second injected preview.
 */
async function installFixtures(page) {
  const state = {
    form: formFixture(),
    saves: [],
    unexpectedWrites: [],
    supabaseWrites: [],
    pageErrors: [],
  };

  page.on("pageerror", (error) => state.pageErrors.push(error.message));

  await page.context().route("**/rest/v1/**", async (route) => {
    const method = route.request().method();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.supabaseWrites.push(`${method} ${route.request().url()}`);
      return json(route, { error: "Supabase mutations are blocked in browser fixtures" }, 599);
    }
    return json(route, []);
  });

  await page.context().route("**/auth/v1/**", async (route) => {
    const method = route.request().method();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.supabaseWrites.push(`${method} ${route.request().url()}`);
      return json(route, { error: "Supabase mutations are blocked in browser fixtures" }, 599);
    }
    return json(route, []);
  });

  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname: path } = url;
    const method = request.method();

    // Vite source imports such as /src/api/base44Client.js must retain their
    // JavaScript response and are not fixture API requests.
    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/auth/me") return json(route, ADMIN_MEMBER);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, {
        user: ADMIN_MEMBER,
        tenant: { id: ADMIN_MEMBER.tenant_id, slug: FORM_SLUG },
      });
    }
    if (path === `/api/entities/Member/${ADMIN_MEMBER.id}`) return json(route, ADMIN_MEMBER);
    if (path === `/api/entities/Role/${ADMIN_ROLE.id}`) return json(route, ADMIN_ROLE);
    if (path === "/api/entities/Role") return json(route, [ADMIN_ROLE]);

    if (path === "/api/entities/Form" && method === "GET") {
      return json(route, [state.form]);
    }
    if (path === `/api/entities/Form/${FORM_ID}` && method === "PATCH") {
      const patch = request.postDataJSON() || {};
      state.form = { ...state.form, ...patch };
      state.saves.push(patch);
      return json(route, state.form);
    }

    if (path === `/api/public/form/${FORM_SLUG}` && method === "GET") {
      return json(route, state.form);
    }
    if (path === "/api/public/form-payment-providers" && method === "GET") {
      return json(route, { providers: [] });
    }
    if (path === "/api/public/form-consent-message" && method === "GET") {
      return json(route, { message: "" });
    }
    if (path === "/api/public/tenant-branding" && method === "GET") {
      return json(route, {
        success: true,
        branding: {
          name: "Form width fixture",
          primaryColor: "#155e75",
          footerConfig: { backgroundColor: "#102a43", textColor: "#ffffff" },
          footerSource: "standard",
        },
      });
    }
    if (path === "/api/public/navigation-items" && method === "GET") return json(route, []);
    if (path === "/api/public/microsites" && method === "GET") {
      return json(route, { microsites: [] });
    }
    if (path === "/api/public/resource-categories" && method === "GET") return json(route, []);
    if (path === "/api/admin/integrations" && method === "GET") {
      return json(route, { integrations: [] });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected fixture mutation: ${method} ${path}` }, 599);
    }

    // Optional builder metadata reads are intentionally inert.
    return json(route, []);
  });

  return state;
}

async function formWidthBox(page) {
  const container = page.getByTestId("form-width-container");
  await expect(container).toBeVisible();
  const box = await container.boundingBox();
  expect(box, "form width container should have a layout box").not.toBeNull();
  return box;
}

async function expectNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

async function expectConstrainedContainer(page, viewportWidth) {
  const box = await formWidthBox(page);
  // FormView and EmbedForm both have a 16px outer inset at mobile widths.
  expect(box.width).toBeLessThanOrEqual(viewportWidth - 32 + 1);
  await expectNoHorizontalOverflow(page);
}

async function openSurface(page, surface) {
  const path = surface === "embed"
    ? `/embed/form/${FORM_SLUG}`
    : `/FormView?slug=${FORM_SLUG}`;
  // FormView can keep optional branding/navigation requests alive while the
  // interactive form is already rendered. Waiting for the document shell is
  // enough for this fixture and avoids coupling the test to those requests.
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await formWidthBox(page);
}

function pageIndicator(surface, pageNumber) {
  return surface === "embed"
    ? `Page ${pageNumber} of 2`
    : `${pageNumber} of 2`;
}

async function assertWidthMatrix(page, state, surface) {
  for (const [formWidth, expectedWidth] of Object.entries(WIDTHS)) {
    state.form = { ...state.form, form_width: formWidth };
    await openSurface(page, surface);
    const box = await formWidthBox(page);
    expect(Math.round(box.width), `${surface} ${formWidth} width`).toBe(expectedWidth);
    await expect(page.getByTestId("form-width-container")).toHaveCSS(
      "max-width",
      `${expectedWidth}px`,
    );
  }
}

async function assertPageTwoLayout(page, surface) {
  if (surface === "embed") {
    await expect(page.getByTestId("button-next-page")).toBeVisible();
    await page.getByTestId("button-next-page").click();
  } else {
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }

  await expect(page.getByText(pageIndicator(surface, 2), { exact: true })).toBeVisible();
  const left = page.getByTestId(`input-email-${PAGE_TWO_LEFT_ID}`);
  const right = page.getByTestId(`input-email-${PAGE_TWO_RIGHT_ID}`);
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await expect(page.getByTestId(`payment-summary-${PAYMENT_ID}`)).toBeVisible();

  const [leftBox, rightBox, paymentBox, paymentAreaBox] = await Promise.all([
    left.boundingBox(),
    right.boundingBox(),
    page.getByTestId(`payment-summary-${PAYMENT_ID}`).boundingBox(),
    page.getByTestId(surface === "embed" ? "embed-form-payment-area" : "form-payment-area").boundingBox(),
  ]);
  expect(leftBox).not.toBeNull();
  expect(rightBox).not.toBeNull();
  expect(paymentBox).not.toBeNull();
  expect(paymentAreaBox).not.toBeNull();

  if (surface === "embed") {
    // EmbedForm's established standard renderer is a vertical stack. Keep
    // this assertion intentionally explicit so a width change cannot
    // accidentally turn the embed into a new column layout.
    expect(Math.abs(leftBox.x - rightBox.x)).toBeLessThanOrEqual(2);
    expect(rightBox.y).toBeGreaterThan(leftBox.y);
    expect(Math.abs(leftBox.width - rightBox.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(paymentBox.width - leftBox.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(paymentAreaBox.width - leftBox.width)).toBeLessThanOrEqual(2);
  } else {
    // FormView's standard renderer preserves configured desktop columns.
    expect(Math.abs(leftBox.width - rightBox.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(leftBox.y - rightBox.y)).toBeLessThanOrEqual(2);
    // Payment is taken out of the grid and spans the content rail.
    expect(paymentBox.width).toBeGreaterThan(leftBox.width + 100);
    expect(paymentAreaBox.width).toBeGreaterThan(leftBox.width + 100);
    expect(paymentAreaBox.width).toBeGreaterThanOrEqual(paymentBox.width - 2);
  }
}

test("FormView applies narrow, medium, and wide widths at a wide desktop viewport", async ({ page }) => {
  const state = await installFixtures(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await assertWidthMatrix(page, state, "form-view");

  state.form = { ...state.form, form_width: "wide" };
  await page.setViewportSize({ width: 390, height: 844 });
  await openSurface(page, "form-view");
  await expectConstrainedContainer(page, 390);

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("EmbedForm applies width limits independently and has no overflow in a constrained frame", async ({ page }) => {
  const state = await installFixtures(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await assertWidthMatrix(page, state, "embed");

  state.form = { ...state.form, form_width: "wide" };
  await page.setViewportSize({ width: 420, height: 760 });
  await openSurface(page, "embed");
  await expectConstrainedContainer(page, 420);

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("FormView keeps multipage navigation, columns, and payment full-width at desktop", async ({ page }) => {
  const state = await installFixtures(page);
  state.form = { ...state.form, form_width: "wide" };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSurface(page, "form-view");
  await expect(page.getByText(pageIndicator("form-view", 1), { exact: true })).toBeVisible();
  await assertPageTwoLayout(page, "form-view");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByText(pageIndicator("form-view", 1), { exact: true })).toBeVisible();

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("EmbedForm keeps multipage navigation, stacked fields, and payment width at desktop", async ({ page }) => {
  const state = await installFixtures(page);
  state.form = { ...state.form, form_width: "wide" };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSurface(page, "embed");
  await expect(page.getByText(pageIndicator("embed", 1), { exact: true })).toBeVisible();
  await assertPageTwoLayout(page, "embed");
  await page.getByTestId("button-previous-page").click();
  await expect(page.getByText(pageIndicator("embed", 1), { exact: true })).toBeVisible();

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("FormView card-swipe applies every width preset and shrinks without mobile overflow", async ({ page }) => {
  const state = await installFixtures(page);
  state.form = cardSwipeFixture();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await assertWidthMatrix(page, state, "form-view");

  state.form = { ...cardSwipeFixture("wide") };
  await page.setViewportSize({ width: 390, height: 844 });
  await openSurface(page, "form-view");
  await expectConstrainedContainer(page, 390);

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("EmbedForm card-swipe applies every width preset and shrinks without mobile overflow", async ({ page }) => {
  const state = await installFixtures(page);
  state.form = cardSwipeFixture();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await assertWidthMatrix(page, state, "embed");

  state.form = { ...cardSwipeFixture("wide") };
  await page.setViewportSize({ width: 420, height: 760 });
  await openSurface(page, "embed");
  await expectConstrainedContainer(page, 420);

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("FormBuilder saves and reopens form width, and the public form uses the persisted value", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/FormBuilder?formId=${FORM_ID}`, { waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("tab-settings")).toBeVisible();
  await page.getByTestId("tab-settings").click();
  const widthSelect = page.getByTestId("select-form-width");
  await expect(widthSelect).toContainText("Narrow");
  await widthSelect.click();
  await page.getByRole("option", { name: "Wide", exact: true }).click();
  await expect(widthSelect).toContainText("Wide");

  await page.getByRole("button", { name: "Save Form", exact: true }).click();
  await expect.poll(() => state.saves.length).toBeGreaterThan(0);
  expect(state.saves.at(-1).form_width).toBe("wide");
  expect(state.form.form_width).toBe("wide");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("tab-settings").click();
  await expect(page.getByTestId("select-form-width")).toContainText("Wide");

  await page.goto(`/FormView?slug=${FORM_SLUG}`, { waitUntil: "domcontentloaded" });
  const box = await formWidthBox(page);
  expect(Math.round(box.width)).toBe(WIDTHS.wide);
  await expect(page.getByTestId("form-width-container")).toHaveCSS("max-width", "1280px");
  await page.screenshot({
    path: testInfo.outputPath("form-width-success.png"),
    fullPage: true,
  });

  expect(state.saves).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});