import { test, expect } from "@playwright/test";

const FORM_ID = "payment-choice-fixture-form";
const FORM_SLUG = "fixture";
const FIELD_ID = "fixture-payment";

function formFixture({ membership = true } = {}) {
  return {
    id: FORM_ID,
    slug: FORM_SLUG,
    name: "Payment choice fixture",
    description: "An isolated payment choice presentation fixture.",
    fields: [
      { id: "fixture-name", type: "text", label: "Name", required: true },
      ...(membership ? [{
        id: "fixture-membership-choice",
        type: "text",
        starts_hidden: true,
        default_value: "monthly",
      }] : [{
        id: "fixture-price",
        type: "number",
        label: "Price",
        starts_hidden: true,
        default_value: 246,
      }]),
      {
        id: FIELD_ID,
        type: "payment",
        label: "Membership payment",
        payment_currency: "GBP",
        payment_providers: ["stripe", "gocardless"],
        ...(!membership ? { price_field_id: "fixture-price" } : {}),
      },
    ],
    pages: [],
    visibility_rules: membership ? [{
      id: "fixture-membership-rule",
      trigger_field_id: "fixture-membership-choice",
      operator: "equals",
      value: "monthly",
      actions: [{
        id: "fixture-membership-action",
        action_type: "membership_structure",
        config_id: "fixture-membership-config",
      }],
    }] : [],
    entity_pipelines: {},
    require_authentication: false,
    is_active: true,
    form_type: "application",
  };
}

function quoteFixture({
  currency = "EUR",
  amount = 246,
  monthlyCard = true,
  directDebit = true,
  count = 6,
  monthlyAmount = 41,
  firstCollectionRule = "nominated_day",
  collectionDay = 21,
} = {}) {
  return {
    required: true,
    amount,
    currency,
    membership: {
      config_name: "Fixture membership",
      tier_label: "Supporting member",
      ...(monthlyCard ? {
        monthly_card: { monthlyAmount, instalmentCount: count, planTotal: amount, currency },
      } : {}),
      ...(directDebit ? {
        direct_debit_allowed: true,
        direct_debit: {
          monthlyAmount,
          instalmentCount: count,
          planTotal: amount,
          currency,
          firstCollectionRule,
          collectionDay,
        },
      } : {}),
    },
  };
}

async function installFixtures(page, {
  providers = [
    { id: "stripe", configured: true },
    { id: "gocardless", configured: true },
  ],
  quote = quoteFixture(),
  createError = null,
  membership = true,
  createPending = false,
  goCardlessFlow = true,
} = {}) {
  // Some coverage cases deliberately reuse one BrowserContext with fresh
  // pages. Replace, rather than stack, that case's complete network contract.
  await page.context().unrouteAll({ behavior: "wait" });
  const state = {
    quoteCalls: [],
    createCalls: [],
    unexpectedWrites: [],
    providerRequests: [],
    runtimeErrors: [],
    releaseCreate: null,
  };
  let releaseCreate;
  const createGate = createPending
    ? new Promise(resolve => { releaseCreate = resolve; })
    : null;
  state.releaseCreate = releaseCreate;
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.addInitScript(() => {
    window.__fixtureGoCardlessOpenCount = 0;
    window.GoCardlessDropin = {
      create(options) {
        return {
          open() {
            window.__fixtureGoCardlessOpenCount += 1;
            document.documentElement.dataset.fixtureGoCardless = "opened";
          },
          exit() {
            options.onExit?.();
          },
        };
      },
    };
    window.Stripe = () => ({
      elements: () => ({
        create: type => ({
          mount: node => {
            node.dataset.fixtureStripeElement = type;
          },
        }),
        submit: async () => ({}),
      }),
      confirmPayment: async () => ({ paymentIntent: { id: "pi_fixture", status: "succeeded" } }),
    });
  });
  page.on("pageerror", error => state.runtimeErrors.push(error.message));

  await page.context().route(/\/(?:rest|auth)\/v1\//, route => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.unexpectedWrites.push(`${request.method()} ${request.url()}`);
      return json(route, { error: "Fixture blocks Supabase writes" }, 599);
    }
    return json(route, []);
  });
  await page.context().route(/\/functions\/v1\//, route => {
    state.unexpectedWrites.push(`${route.request().method()} ${route.request().url()}`);
    return json(route, { error: "Fixture blocks backend functions" }, 599);
  });
  await page.context().route(/^https?:\/\/[^/]*(?:stripe|gocardless)\./i, route => {
    state.providerRequests.push(route.request().url());
    return route.fulfill({ status: 204, body: "" });
  });
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();

    if (path === `/api/public/form/${FORM_SLUG}` && request.method() === "GET") {
      return json(route, formFixture({ membership }));
    }
    if (path === "/api/public/form-payment-providers" && request.method() === "GET") {
      return json(route, { providers });
    }
    if (path === "/api/public/form-payment" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body?.action === "quote" && body.form_id === FORM_ID) {
        state.quoteCalls.push(body);
        return json(route, quote);
      }
      if (["create", "create_monthly_card"].includes(body?.action) && body.form_id === FORM_ID) {
        state.createCalls.push(body);
        if (createGate) await createGate;
        if (createError) return json(route, { error: createError }, 503);
        if (body.action === "create_monthly_card") {
          return json(route, {
            submissionId: "fixture-monthly-submission",
            checkoutUrl: "https://checkout.stripe.test/payment-choice-fixture",
          });
        }
        if (body.provider === "gocardless") {
          return json(route, {
            submissionId: "fixture-dd-submission",
            ...(goCardlessFlow ? { flowId: "BRF_fixture" } : {}),
            environment: "sandbox",
            authorisationUrl: "https://pay.gocardless.test/payment-choice-fixture",
          });
        }
        if (body.provider === "stripe") {
          return json(route, {
            submissionId: "fixture-stripe-submission",
            publishableKey: "pk_test_fixture",
            clientSecret: "cs_test_fixture",
          });
        }
      }
      state.unexpectedWrites.push(`${request.method()} ${path} ${JSON.stringify(body)}`);
      return json(route, { error: "Unexpected fixture payment mutation" }, 599);
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.unexpectedWrites.push(`${request.method()} ${path}`);
      return json(route, { error: "Unexpected fixture mutation" }, 599);
    }
    if (path === "/api/auth/me") return json(route, null, 401);
    if (path === "/api/auth/tenant-user-me") return json(route, { user: null }, 401);
    return json(route, []);
  });
  return state;
}

async function openHosted(page) {
  await page.goto(`/FormView?slug=${FORM_SLUG}`);
  await expect(page.getByTestId(`form-payment-provider-choices-${FIELD_ID}`)).toBeVisible();
  const decline = page.getByRole("button", { name: "Decline" });
  if (await decline.isVisible().catch(() => false)) await decline.click();
}

async function openEmbedded(page, testInfo, width) {
  const origin = new URL(testInfo.project.use.baseURL).origin;
  // Give the synthetic containing document the app's origin. The embed route's
  // frame policy deliberately rejects unrelated about:blank/external parents.
  await page.goto("/");
  await page.setContent(`<!doctype html>
    <style>body{margin:0;padding:20px;background:#eee} iframe{display:block;width:${width}px;height:900px;border:0}</style>
    <iframe data-testid="payment-choice-frame" src="${origin}/embed/form/${FORM_SLUG}" title="Payment choice fixture"></iframe>`);
  const frame = page.frameLocator('[data-testid="payment-choice-frame"]');
  await expect(frame.getByTestId(`form-payment-provider-choices-${FIELD_ID}`)).toBeVisible();
  return frame;
}

async function assertNoOverflow(scope, viewportWidth) {
  const geometry = await scope.getByTestId(`form-payment-provider-choices-${FIELD_ID}`).evaluate(section => {
    const cards = [...section.querySelectorAll("button")];
    return {
      section: section.getBoundingClientRect().toJSON(),
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
      cards: cards.map(card => card.getBoundingClientRect().toJSON()),
      scrollWidths: cards.map(card => ({
        client: card.clientWidth,
        scroll: card.scrollWidth,
        bodyClient: card.lastElementChild?.clientWidth,
        bodyScroll: card.lastElementChild?.scrollWidth,
      })),
    };
  });
  expect(geometry.section.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.section.right).toBeLessThanOrEqual(viewportWidth + 0.5);
  expect(geometry.document.scrollWidth).toBeLessThanOrEqual(geometry.document.clientWidth);
  for (const [index, card] of geometry.cards.entries()) {
    expect(card.left).toBeGreaterThanOrEqual(geometry.section.left - 0.5);
    expect(card.right).toBeLessThanOrEqual(geometry.section.right + 0.5);
    expect(geometry.scrollWidths[index].scroll).toBeLessThanOrEqual(geometry.scrollWidths[index].client);
    expect(geometry.scrollWidths[index].bodyScroll).toBeLessThanOrEqual(geometry.scrollWidths[index].bodyClient);
  }
  return geometry;
}

test("hosted three-choice presentation uses one equal neutral row at desktop width", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  await openHosted(page);

  await expect(page.getByRole("heading", { name: "Select your desired payment method" })).toBeVisible();
  const choices = page.getByTestId(`form-payment-provider-choices-${FIELD_ID}`);
  const cards = choices.locator("button");
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId(`button-form-payment-stripe-${FIELD_ID}`)).toContainText("Pay in full by card");
  await expect(page.getByTestId(`button-form-payment-monthly-card-${FIELD_ID}`)).toContainText("Pay monthly by card");
  await expect(page.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`)).toContainText("Pay monthly by Direct Debit");
  await expect(page.getByTestId(`button-form-payment-monthly-card-${FIELD_ID}`)).toContainText("€41.00 × 6 instalments");
  await expect(page.getByTestId(`button-form-payment-monthly-card-${FIELD_ID}`)).toContainText("Plan total €246.00");
  await expect(page.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`)).toContainText("First collection: On the next applicable 21st of the month");

  const geometry = await assertNoOverflow(page, 1440);
  expect(geometry.section.width).toBeGreaterThanOrEqual(672);
  expect(Math.max(...geometry.cards.map(card => card.y)) - Math.min(...geometry.cards.map(card => card.y))).toBeLessThan(1);
  expect(Math.max(...geometry.cards.map(card => card.width)) - Math.min(...geometry.cards.map(card => card.width))).toBeLessThan(1);
  expect(Math.max(...geometry.cards.map(card => card.height)) - Math.min(...geometry.cards.map(card => card.height))).toBeLessThan(1);

  const neutralStyles = await cards.evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      borderColor: style.borderColor,
      borderStyle: style.borderStyle,
      boxShadow: style.boxShadow,
    };
  }));
  expect(new Set(neutralStyles.map(style => JSON.stringify(style))).size).toBe(1);
  expect(neutralStyles[0].borderStyle).toBe("solid");
  expect(state.createCalls).toEqual([]);
  expect(state.providerRequests).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.runtimeErrors).toEqual([]);

  await choices.screenshot({ path: testInfo.outputPath("hosted-three-neutral-cards.png") });
});

test("a genuinely narrow iframe stacks three cards without clipping on a wide host", async ({ page }, testInfo) => {
  const state = await installFixtures(page, {
    quote: quoteFixture({
      currency: "USD",
      amount: 1000,
      monthlyAmount: 83.33,
      count: 12,
      firstCollectionRule: "anniversary",
    }),
  });
  expect((await page.viewportSize()).width).toBe(1440);
  const frame = await openEmbedded(page, testInfo, 390);
  const cards = frame.getByTestId(`form-payment-provider-choices-${FIELD_ID}`).locator("button");
  await expect(cards).toHaveCount(3);
  await expect(frame.getByTestId(`button-form-payment-monthly-card-${FIELD_ID}`)).toContainText("$83.33 × 12 instalments");
  await expect(frame.getByTestId(`button-form-payment-monthly-card-${FIELD_ID}`)).toContainText("Plan total $1000.00");
  await expect(frame.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`)).toContainText(
    "First collection: On the next applicable monthly date matching the day your membership year starts",
  );

  const geometry = await assertNoOverflow(frame, 390);
  for (let index = 1; index < geometry.cards.length; index += 1) {
    expect(geometry.cards[index].y).toBeGreaterThan(geometry.cards[index - 1].bottom);
  }
  expect(state.createCalls).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  const iframe = page.locator('[data-testid="payment-choice-frame"]');
  await iframe.evaluate(element => {
    element.style.height = `${element.contentDocument.documentElement.scrollHeight}px`;
  });
  await iframe.screenshot({ path: testInfo.outputPath("embedded-narrow-three-cards.png") });
});

test("hosted and embedded one/two/three choices preserve desktop and narrow geometry", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const choiceCases = [
    {
      name: "one",
      providers: [{ id: "stripe", configured: true }],
      quote: quoteFixture({ monthlyCard: false, directDebit: false }),
      count: 1,
    },
    {
      name: "two",
      providers: [
        { id: "stripe", configured: true },
        { id: "gocardless", configured: true },
      ],
      quote: quoteFixture({ monthlyCard: true, directDebit: false }),
      count: 2,
    },
    {
      name: "three",
      providers: [
        { id: "stripe", configured: true },
        { id: "gocardless", configured: true },
      ],
      quote: quoteFixture(),
      count: 3,
    },
  ];
  for (const surface of ["hosted", "embedded"]) {
    for (const width of [1440, 375]) {
      for (const scenario of choiceCases) {
        const isolated = await page.context().newPage();
        await isolated.setViewportSize({ width: 1440, height: 1000 });
        const state = await installFixtures(isolated, scenario);
        let scope;
        let measuredWidth;
        if (surface === "hosted") {
          await isolated.setViewportSize({ width, height: 1000 });
          await openHosted(isolated);
          scope = isolated;
          measuredWidth = width;
        } else {
          scope = await openEmbedded(isolated, testInfo, width === 1440 ? 820 : 375);
          measuredWidth = width === 1440 ? 820 : 375;
        }
        const choices = scope.getByTestId(`form-payment-provider-choices-${FIELD_ID}`);
        const cards = choices.locator("button");
        await expect(cards).toHaveCount(scenario.count);
        const geometry = await assertNoOverflow(scope, measuredWidth);
        if (scenario.count === 3 && geometry.section.width >= 700) {
          expect(Math.max(...geometry.cards.map(card => card.y)) - Math.min(...geometry.cards.map(card => card.y))).toBeLessThan(1);
          expect(Math.max(...geometry.cards.map(card => card.width)) - Math.min(...geometry.cards.map(card => card.width))).toBeLessThan(1);
          expect(Math.max(...geometry.cards.map(card => card.height)) - Math.min(...geometry.cards.map(card => card.height))).toBeLessThan(1);
        }
        if (width === 375) {
          for (let index = 1; index < geometry.cards.length; index += 1) {
            expect(geometry.cards[index].y).toBeGreaterThan(geometry.cards[index - 1].bottom);
          }
        }
        expect(state.createCalls).toEqual([]);
        expect(state.unexpectedWrites).toEqual([]);
        if (surface === "embedded" && width === 1440) {
          const iframe = isolated.locator('[data-testid="payment-choice-frame"]');
          await iframe.evaluate(element => {
            element.style.height = `${element.contentDocument.documentElement.scrollHeight}px`;
          });
          await iframe.screenshot({ path: testInfo.outputPath(`embedded-wide-${scenario.name}-choices.png`) });
        }
        await isolated.close();
      }
    }
  }
});

test("keyboard activation launches only the selected existing provider action", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  const frame = await openEmbedded(page, testInfo, 820);
  await frame.locator('input:not([type="hidden"])').first().fill("Fixture Applicant");
  expect(state.createCalls).toEqual([]);

  const stripe = frame.getByTestId(`button-form-payment-stripe-${FIELD_ID}`);
  await stripe.focus();
  await expect(stripe).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.createCalls.length).toBe(1);
  expect(state.createCalls[0]).toMatchObject({ action: "create", provider: "stripe", form_id: FORM_ID });
  const stripeContent = frame.getByTestId(`form-payment-provider-content-${FIELD_ID}`);
  await expect(stripeContent).toBeVisible();
  const stripeGeometry = await stripeContent.evaluate(node => {
    const style = getComputedStyle(node);
    return { width: node.getBoundingClientRect().width, maxWidth: style.maxWidth };
  });
  expect(stripeGeometry.maxWidth).toBe("672px");
  expect(stripeGeometry.width).toBeLessThanOrEqual(672);
  expect(state.providerRequests).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("embedded-inline-stripe-max-width.png"), fullPage: true });
});

test("monthly checkout navigates to the inert route and GoCardless opens its mocked drop-in", async ({ page }, testInfo) => {
  const monthlyState = await installFixtures(page);
  await page.context().route("https://checkout.stripe.test/payment-choice-fixture", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>Mocked monthly checkout</title><main>Mocked monthly checkout</main>",
  }));
  await openHosted(page);
  await page.locator('input:not([type="hidden"])').first().fill("Fixture Applicant");
  const monthly = page.getByTestId(`button-form-payment-monthly-card-${FIELD_ID}`);
  await monthly.focus();
  await expect(monthly).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByText("Mocked monthly checkout")).toBeVisible();
  expect(page.url()).toBe("https://checkout.stripe.test/payment-choice-fixture");
  expect(monthlyState.createCalls).toHaveLength(1);
  expect(monthlyState.createCalls[0]).toMatchObject({ action: "create_monthly_card", form_id: FORM_ID });
  expect(monthlyState.unexpectedWrites).toEqual([]);

  const ddPage = await page.context().newPage();
  const ddState = await installFixtures(ddPage);
  const frame = await openEmbedded(ddPage, testInfo, 820);
  await frame.locator('input:not([type="hidden"])').first().fill("Fixture Applicant");
  await frame.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`).click();
  await expect.poll(() => ddState.createCalls.length).toBe(1);
  expect(ddState.createCalls[0]).toMatchObject({ action: "create", provider: "gocardless", form_id: FORM_ID });
  await expect.poll(() => frame.locator("html").getAttribute("data-fixture-go-cardless")).toBe("opened");
  expect(ddState.unexpectedWrites).toEqual([]);
  await ddPage.close();

  const fallbackPage = await page.context().newPage();
  const fallbackState = await installFixtures(fallbackPage, { goCardlessFlow: false });
  await fallbackPage.context().route("https://pay.gocardless.test/payment-choice-fixture", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>Mocked GoCardless fallback</title><main>Mocked GoCardless fallback</main>",
  }));
  const fallbackFrame = await openEmbedded(fallbackPage, testInfo, 820);
  await fallbackFrame.locator('input:not([type="hidden"])').first().fill("Fixture Applicant");
  await fallbackFrame.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`).click();
  await expect(fallbackPage.getByText("Mocked GoCardless fallback")).toBeVisible();
  expect(fallbackPage.url()).toBe("https://pay.gocardless.test/payment-choice-fixture");
  expect(fallbackState.createCalls[0]).toMatchObject({ action: "create", provider: "gocardless" });
  expect(fallbackState.unexpectedWrites).toEqual([]);
  await fallbackPage.close();
});

test("pending create disables every choice and a create error restores clickable cards", async ({ page }) => {
  const pending = await installFixtures(page, { createPending: true });
  await openHosted(page);
  await page.locator('input:not([type="hidden"])').first().fill("Fixture Applicant");
  await page.getByTestId(`button-form-payment-monthly-card-${FIELD_ID}`).click();
  await expect.poll(() => pending.createCalls.length).toBe(1);
  const choices = page.getByTestId(`form-payment-provider-choices-${FIELD_ID}`);
  await expect(choices.locator("button:disabled")).toHaveCount(3);
  await expect(choices.locator(".animate-spin")).toHaveCount(3);
  pending.releaseCreate();

  const errorPage = await page.context().newPage();
  const errorState = await installFixtures(errorPage, { createError: "Fixture checkout unavailable" });
  await openHosted(errorPage);
  await errorPage.locator('input:not([type="hidden"])').first().fill("Fixture Applicant");
  await errorPage.getByTestId(`button-form-payment-stripe-${FIELD_ID}`).click();
  await expect(errorPage.getByText("Fixture checkout unavailable")).toBeVisible();
  await expect(errorPage.getByTestId(`form-payment-provider-choices-${FIELD_ID}`).locator("button:enabled")).toHaveCount(3);
  expect(errorState.createCalls).toHaveLength(1);
  expect(errorState.unexpectedWrites).toEqual([]);
  await errorPage.close();
});

test("one-off Direct Debit is not presented as monthly and validation launches nothing", async ({ page }) => {
  const state = await installFixtures(page, {
    membership: false,
  });
  await openHosted(page);
  const directDebit = page.getByTestId(`button-form-payment-gocardless-${FIELD_ID}`);
  await expect(directDebit).toContainText("Pay by Direct Debit");
  await expect(directDebit).not.toContainText("Pay monthly");
  await expect(directDebit).not.toContainText("Plan total");
  await directDebit.click();
  await expect(page.getByText(/required/i).first()).toBeVisible();
  expect(state.createCalls).toEqual([]);
  expect(state.providerRequests).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});