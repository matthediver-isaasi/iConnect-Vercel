import { test, expect } from "@playwright/test";

const FORM_SLUG = "membership-return-fixture";
const FORM_ID = "membership-return-form";
const SUBMISSION_ID = "membership-return-submission";

const member = {
  id: "membership-return-member",
  tenant_id: "membership-return-tenant",
  organization_id: "membership-return-org",
  role_id: "membership-return-role",
  email: "member@return-fixture.invalid",
  first_name: "Member",
  last_name: "Fixture",
  member_excluded_features: [],
};

const role = {
  id: member.role_id,
  name: "Member",
  excluded_features: [],
};

const branding = {
  name: "Membership return fixture",
  primaryColor: "#155e75",
  footerConfig: { backgroundColor: "#102a43", textColor: "#ffffff" },
  footerSource: "standard",
};

function formFixture({ blank = false, payment = false } = {}) {
  return {
    id: FORM_ID,
    slug: FORM_SLUG,
    name: "Membership return fixture form",
    description: "A fixture form used only to exercise payment returns.",
    fields: payment ? [
      // This hidden value makes the genuine membership-structure action match
      // on first render, without asking the browser test to use an invented
      // wrapper around FormPaymentSubmit.
      {
        id: "fixture-membership-choice",
        type: "text",
        starts_hidden: true,
        default_value: "monthly",
      },
      {
        id: "fixture-payment",
        type: "payment",
        payment_currency: "GBP",
        payment_providers: ["stripe", "gocardless"],
      },
    ] : [],
    pages: [],
    visibility_rules: payment ? [{
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
    blank_layout: blank,
    success_message: "Fixture membership application received.",
  };
}

function canvasPageFixture({ twoEmbeds = false } = {}) {
  const embed = (id) => ({
    id,
    type: "form-embed",
    geom: { x: 0, y: 0, w: 1000, h: 650 },
    bp: {
      desktop: { x: 0, y: 0, w: 1000, h: 650 },
      tablet: { x: 0, y: 0, w: 768, h: 650 },
      mobile: { x: 0, y: 0, w: 375, h: 650 },
    },
    content: {
      formSlug: FORM_SLUG,
      mode: "iframe",
      title: "Embedded membership application",
    },
  });
  return {
    id: "membership-return-canvas-page",
    slug: "membership-return-canvas",
    name: "Membership return Canvas",
    status: "published",
    builder_type: "canvas",
    public_chrome: "both",
    canvas_design: {
      version: 1,
      root: {
        sections: [{
          id: "root",
          children: twoEmbeds
            ? [embed("membership-return-form-embed-a"), {
              ...embed("membership-return-form-embed-b"),
              geom: { x: 0, y: 660, w: 1000, h: 650 },
              bp: {
                desktop: { x: 0, y: 660, w: 1000, h: 650 },
                tablet: { x: 0, y: 660, w: 768, h: 650 },
                mobile: { x: 0, y: 660, w: 375, h: 650 },
              },
            }]
            : [embed("membership-return-form-embed-a")],
        }],
      },
    },
  };
}

/**
 * This intentionally handles every API/Supabase/provider request. A browser
 * test for a redirect return must not accidentally turn into a live payment,
 * a Supabase mutation, or a provider-widget request if an integration changes.
 */
async function installFixtures(page, {
  signedIn = false,
  blank = false,
  paymentForm = false,
  goCardlessModal = false,
  twoEmbeds = false,
  microsite = false,
  monthlyCheckoutOutcome = "success",
  monthlyReturnSubmissionId = SUBMISSION_ID,
  externalStripeCheckout = false,
  appOrigin = null,
  confirmations = [{ success: true, status: "paid", provider: "stripe_monthly_card", paymentSucceeded: true }],
  directDebitAgreement = {
    id: "membership-return-dd-agreement",
    status: "pending_provider",
    terms: { instalment_count: 12, monthly_amount: 10, currency: "GBP" },
  },
  directDebitError = false,
} = {}) {
  const state = {
    confirmationCalls: [],
    monthlyCardCreates: [],
    goCardlessCreates: [],
    unexpectedWrites: [],
    providerRequests: [],
    apiRequests: [],
  };
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  if (goCardlessModal) {
    // The genuine Drop-in hook sees this exactly as it sees the provider
    // initialise script. It cannot charge anything: it only invokes the
    // official completion callback, which the app must server-confirm.
    await page.addInitScript(() => {
      window.GoCardlessDropin = {
        create(options) {
          return {
            open() {
              document.documentElement.dataset.fixtureGoCardlessModal = "opened";
              setTimeout(() => options.onSuccess?.({ id: "BR_fixture" }, { id: "BRF_fixture" }), 0);
            },
            exit() {},
          };
        },
      };
    });
  }

  await page.context().route(/\/(?:rest|auth)\/v1\//, async (route) => {
    const method = route.request().method();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`Supabase ${method} ${route.request().url()}`);
      return json(route, { error: "No fixture permits a Supabase mutation" }, 599);
    }
    return json(route, []);
  });

  await page.context().route(/^https?:\/\/[^/]*(?:stripe|gocardless)\./i, async (route) => {
    const providerUrl = route.request().url();
    state.providerRequests.push(providerUrl);
    if (externalStripeCheckout && providerUrl.startsWith("https://checkout.stripe.test/") && appOrigin) {
      return route.fulfill({
        status: 302,
        headers: {
          location: `${appOrigin}/embed/form/${FORM_SLUG}?form_payment_submission=${SUBMISSION_ID}`
            + "&form_payment_provider=stripe_monthly_card&payment_intent=pi_external&redirect_status=succeeded",
        },
      });
    }
    // A deliberately inert response prevents a newly introduced live widget
    // from loading while still making accidental provider traffic observable.
    return route.fulfill({ status: 204, body: "" });
  });

  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname: path } = url;
    const method = request.method();
    // Vite serves source modules such as /src/api/base44Client.js. The broad
    // glob is needed for API query strings but must never turn those modules
    // into JSON fixture responses.
    if (!path.startsWith("/api/")) return route.continue();
    state.apiRequests.push(`${method} ${path}${url.search}`);

    if (path === "/api/auth/me") return json(route, signedIn ? member : null, signedIn ? 200 : 401);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, signedIn
        ? { user: member, tenant: { id: member.tenant_id, slug: "membership-return-fixture" } }
        : { user: null }, signedIn ? 200 : 401);
    }
    if (path === `/api/entities/Role/${role.id}`) return json(route, role);
    if (path === "/api/entities/Role") return json(route, [role]);

    if (path === `/api/public/form/${FORM_SLUG}`) return json(route, formFixture({ blank, payment: paymentForm }));
    if (path === "/api/public/page/membership-return-canvas") {
      return json(route, { page: canvasPageFixture({ twoEmbeds }), elements: [], symbols: [] });
    }
    if (path === "/api/public/microsites") {
      return json(route, { microsites: microsite ? [{
        id: "membership-return-microsite",
        path_prefix: "return-site",
        home_slug: "membership-return-canvas",
      }] : [] });
    }
    if (path === "/api/public/tenant-branding") return json(route, { success: true, branding });
    if (path === "/api/public/navigation-items") {
      return json(route, [
        { id: "fixture-main-nav", label: "Fixture site navigation", url: "/membership-return-canvas", location: "header", is_active: true },
        { id: "fixture-footer-nav", label: "Fixture footer navigation", url: "/membership-return-canvas", location: "footer", is_active: true },
      ]);
    }
    if (path === "/api/public/form-payment-providers") {
      return json(route, { providers: [
        { id: "stripe", configured: true },
        { id: "gocardless", configured: true },
      ] });
    }
    if (path === "/api/membership/direct-debit" && method === "GET") {
      return directDebitError
        ? json(route, { error: "Fixture Direct Debit status unavailable" }, 503)
        : json(route, { agreement: directDebitAgreement });
    }
    if (path === "/api/membership/monthly-card" && method === "GET") {
      return json(route, { agreement: { id: "membership-return-card-agreement", status: "active" } });
    }
    if (path === "/api/public/form-payment" && method === "POST") {
      const body = request.postDataJSON();
      if (body?.action === "quote" && body.form_id === FORM_ID) {
        return json(route, {
          required: true,
          amount: 120,
          currency: "GBP",
          membership: {
            config_name: "Fixture monthly membership",
            direct_debit_allowed: true,
            monthly_card: {
              monthlyAmount: 10,
              instalmentCount: 12,
              planTotal: 120,
              currency: "GBP",
            },
            direct_debit: {
              monthlyAmount: 10,
              instalmentCount: 12,
              planTotal: 120,
              currency: "GBP",
            },
          },
        });
      }
      if (body?.action === "create_monthly_card" && body.form_id === FORM_ID) {
        state.monthlyCardCreates.push(body);
        // This is the provider's synthetic top-window return. It intentionally
        // lands on the Canvas parent; FormEmbedIframe must relay only these
        // params back into the iframe that stored the scoped context.
        const returnUrl = new URL(body.return_path, "https://fixture-return.invalid");
        returnUrl.searchParams.set("form_payment_submission", monthlyReturnSubmissionId);
        returnUrl.searchParams.set("form_payment_provider", "stripe_monthly_card");
        if (monthlyCheckoutOutcome === "cancelled") {
          returnUrl.searchParams.set("form_payment_cancelled", "1");
        } else {
          returnUrl.searchParams.set("payment_intent", "pi_canvas");
          returnUrl.searchParams.set("redirect_status", "succeeded");
        }
        return json(route, {
          submissionId: SUBMISSION_ID,
          checkoutUrl: externalStripeCheckout
            ? "https://checkout.stripe.test/fixture-monthly-card"
            : `${returnUrl.pathname}${returnUrl.search}`,
        });
      }
      if (body?.action === "create" && body.provider === "gocardless" && body.form_id === FORM_ID) {
        state.goCardlessCreates.push(body);
        return json(route, {
          submissionId: SUBMISSION_ID,
          ...(goCardlessModal ? { flowId: "BRF_fixture", environment: "sandbox" } : {}),
          // Omit flowId to force the documented hosted fallback rather than
          // requiring a real Drop-in script/modal in a browser fixture.
          authorisationUrl: `/FormView?slug=${FORM_SLUG}&form_payment_submission=${SUBMISSION_ID}`
            + "&form_payment_provider=gocardless",
        });
      }
      if (body?.action === "confirm" && body.submission_id === SUBMISSION_ID) {
        state.confirmationCalls.push({
          body,
          frameUrl: request.frame()?.url() || "",
        });
        const reply = confirmations[Math.min(state.confirmationCalls.length - 1, confirmations.length - 1)];
        return json(route, reply.body || reply, reply.httpStatus || 200);
      }
      state.unexpectedWrites.push(`POST ${path} ${JSON.stringify(body)}`);
      return json(route, { error: "Fixture rejected an unexpected payment mutation" }, 599);
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected fixture mutation: ${method} ${path}` }, 599);
    }

    // Public chrome makes several best-effort GET requests. Empty fixture
    // arrays are sufficient for those optional resources, but no endpoint is
    // allowed to escape the interception above.
    return json(route, []);
  });
  return state;
}

function formReturnPath(extra = "") {
  return `/FormView?slug=${FORM_SLUG}&form_payment_submission=${SUBMISSION_ID}`
    + `&form_payment_provider=stripe_monthly_card${extra}`;
}

async function capture(page, testInfo, name) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

function onwardLinks(scope) {
  return scope.getByRole("link", { name: /continue|member area|dashboard|sign in|log in|return to site|home/i });
}

test("anonymous full-page Stripe monthly return retains tenant chrome, removes secrets, and offers a safe onward link", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  await page.goto(`${formReturnPath("&payment_intent=pi_fixture&payment_intent_client_secret=never-store-this")}&redirect_status=succeeded`);

  const screen = page.getByTestId("payment-return-screen");
  await expect(screen).toHaveAttribute("data-payment-status", "paid");
  await expect(screen).toContainText("Payment received");
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator("footer")).toBeVisible();
  await expect(onwardLinks(screen)).toHaveCount(1);
  await expect(onwardLinks(screen)).toHaveAttribute("href", "/");
  await expect(page.getByTestId("button-return-to-form")).toHaveCount(0);
  expect(page.url()).not.toContain("form_payment_");
  expect(page.url()).not.toContain("client_secret");
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).not.toContain("never-store-this");
  expect(state.confirmationCalls).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "anonymous-full-page-paid");
});

test("signed-in and deliberately blank form returns keep their distinct safe presentation and never re-confirm after refresh", async ({ page }, testInfo) => {
  const state = await installFixtures(page, {
    signedIn: true,
    blank: true,
    confirmations: [{ success: true, status: "paid", provider: "stripe_monthly_card", paymentSucceeded: true }],
  });
  await page.goto(formReturnPath());

  const screen = page.getByTestId("payment-return-screen");
  await expect(screen).toHaveAttribute("data-payment-status", "paid");
  await expect(page.locator("header")).toHaveCount(0);
  await expect(page.locator("footer")).toHaveCount(0);
  await expect(onwardLinks(screen)).toHaveCount(1);
  await expect(onwardLinks(screen)).toHaveAttribute("href", "/Dashboard");
  await page.reload();
  await expect(screen).toHaveAttribute("data-payment-status", "paid");
  expect(state.confirmationCalls).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "signed-in-blank-paid");
});

test("same-origin Canvas Stripe top return relays only to its originating iframe and preserves the surrounding Canvas page", async ({ page }, testInfo) => {
  const state = await installFixtures(page, { paymentForm: true });
  await page.goto("/membership-return-canvas");

  const iframe = page.getByTestId("iframe-form-embed");
  await expect(iframe).toBeVisible();
  const frame = page.frameLocator('[data-testid="iframe-form-embed"]');
  await expect(frame.getByTestId("button-form-payment-monthly-card-fixture-payment")).toBeVisible();

  // Exercise the actual FormPaymentSubmit start flow. The fixture's
  // checkoutUrl represents Stripe's top-window redirect back to the parent
  // Canvas path, not a direct navigation of the iframe.
  await frame.getByTestId("button-form-payment-monthly-card-fixture-payment").click();

  const screen = frame.getByTestId("payment-return-screen");
  await expect(screen).toHaveAttribute("data-payment-status", "paid");
  await expect(page).toHaveURL(/\/membership-return-canvas$/);
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator("footer")).toBeVisible();
  expect(state.monthlyCardCreates).toHaveLength(1);
  expect(state.monthlyCardCreates[0].return_path).toBe("/membership-return-canvas");
  expect(state.confirmationCalls).toHaveLength(1);
  expect(state.confirmationCalls[0].frameUrl).toContain(`/embed/form/${FORM_SLUG}`);
  expect(state.confirmationCalls[0].frameUrl).not.toContain("membership-return-canvas");
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "canvas-iframe-stripe-return");
});

test("two copies of the same Canvas form isolate a Stripe success relay to its originating iframe", async ({ page }, testInfo) => {
  const state = await installFixtures(page, { paymentForm: true, twoEmbeds: true });
  await page.goto("/membership-return-canvas");

  const embeds = page.getByTestId("iframe-form-embed");
  await expect(embeds).toHaveCount(2);
  const first = page.frameLocator('[data-testid="iframe-form-embed"]').nth(0);
  const second = page.frameLocator('[data-testid="iframe-form-embed"]').nth(1);
  await first.getByTestId("button-form-payment-monthly-card-fixture-payment").click();
  await expect(first.getByTestId("payment-return-screen")).toHaveAttribute("data-payment-status", "paid");
  await expect(second.getByTestId("payment-return-screen")).toHaveCount(0);
  await expect(second.getByTestId("button-form-payment-monthly-card-fixture-payment")).toBeVisible();
  expect(state.confirmationCalls).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "canvas-same-form-success-isolation");
});

test("two copies of the same Canvas form isolate a Stripe cancellation relay to its originating iframe", async ({ page }, testInfo) => {
  const state = await installFixtures(page, {
    paymentForm: true,
    twoEmbeds: true,
    monthlyCheckoutOutcome: "cancelled",
  });
  await page.goto("/membership-return-canvas");

  const first = page.frameLocator('[data-testid="iframe-form-embed"]').nth(0);
  const second = page.frameLocator('[data-testid="iframe-form-embed"]').nth(1);
  await first.getByTestId("button-form-payment-monthly-card-fixture-payment").click();
  await expect(first.getByTestId("payment-return-screen")).toHaveAttribute("data-payment-status", "cancelled");
  await expect(second.getByTestId("payment-return-screen")).toHaveCount(0);
  await expect(second.getByTestId("button-form-payment-monthly-card-fixture-payment")).toBeVisible();
  expect(state.confirmationCalls).toHaveLength(0);
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "canvas-same-form-cancel-isolation");
});

test("a mismatched Stripe cancellation is not relayed into any Canvas form instance", async ({ page }) => {
  const state = await installFixtures(page, {
    paymentForm: true,
    twoEmbeds: true,
    monthlyCheckoutOutcome: "cancelled",
    monthlyReturnSubmissionId: "unrelated-provider-submission",
  });
  await page.goto("/membership-return-canvas");

  const first = page.frameLocator('[data-testid="iframe-form-embed"]').nth(0);
  const second = page.frameLocator('[data-testid="iframe-form-embed"]').nth(1);
  await first.getByTestId("button-form-payment-monthly-card-fixture-payment").click();
  await expect(first.getByTestId("payment-return-screen")).toHaveCount(0);
  await expect(second.getByTestId("payment-return-screen")).toHaveCount(0);
  expect(state.confirmationCalls).toHaveLength(0);
  expect(state.unexpectedWrites).toEqual([]);
});

test("a Canvas Stripe relay retains microsite path and its single public chrome while the iframe stays chrome-free", async ({ page }, testInfo) => {
  const state = await installFixtures(page, { paymentForm: true, microsite: true });
  await page.goto("/return-site/membership-return-canvas");

  const frame = page.frameLocator('[data-testid="iframe-form-embed"]');
  await expect(frame.getByTestId("button-form-payment-monthly-card-fixture-payment")).toBeVisible();
  await frame.getByTestId("button-form-payment-monthly-card-fixture-payment").click();
  await expect(frame.getByTestId("payment-return-screen")).toHaveAttribute("data-payment-status", "paid");
  await expect(page).toHaveURL(/\/return-site\/membership-return-canvas$/);
  await expect(page.locator("header")).toHaveCount(1);
  await expect(page.locator("footer")).toHaveCount(1);
  await expect(frame.locator("header")).toHaveCount(0);
  await expect(frame.locator("footer")).toHaveCount(0);
  expect(state.monthlyCardCreates[0].return_path).toBe("/return-site/membership-return-canvas");
  expect(state.confirmationCalls).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "canvas-microsite-stripe-return");
});

test("an encoded Canvas parent query remains the Stripe return path and survives provider-param cleanup", async ({ page }, testInfo) => {
  const state = await installFixtures(page, { paymentForm: true });
  await page.goto("/membership-return-canvas?next=%2Fpricing&campaign=a+b");

  const frame = page.frameLocator('[data-testid="iframe-form-embed"]');
  await frame.getByTestId("button-form-payment-monthly-card-fixture-payment").click();
  await expect(frame.getByTestId("payment-return-screen")).toHaveAttribute("data-payment-status", "paid");
  expect(state.monthlyCardCreates).toHaveLength(1);
  expect(state.monthlyCardCreates[0].return_path).toBe("/membership-return-canvas?next=%2Fpricing&campaign=a+b");
  await expect(page).toHaveURL(/\/membership-return-canvas\?next=%2Fpricing&campaign=a\+b$/);
  expect(state.confirmationCalls).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "canvas-encoded-parent-query-return");
});

test("a cross-origin embed opens Stripe in a separate secure-checkout tab without navigating its host", async ({ page }, testInfo) => {
  const appOrigin = new URL(testInfo.project.use.baseURL).origin;
  const state = await installFixtures(page, {
    paymentForm: true,
    externalStripeCheckout: true,
    appOrigin,
  });
  await page.context().route("https://external.example.invalid/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><title>External fixture host</title>
      <header>External fixture header</header>
      <main><iframe data-testid="external-form-host" src="${appOrigin}/embed/form/${FORM_SLUG}"></iframe></main>
      <footer>External fixture footer</footer>`,
  }));
  await page.goto("https://external.example.invalid/membership");

  const frame = page.frameLocator('[data-testid="external-form-host"]');
  await expect(frame.getByTestId("button-form-payment-monthly-card-fixture-payment")).toBeVisible();
  await frame.getByTestId("button-form-payment-monthly-card-fixture-payment").click();
  const secureCheckout = frame.getByTestId("button-form-payment-external-checkout-fixture-payment");
  await expect(secureCheckout).toHaveAttribute("target", "_blank");
  await expect(secureCheckout).toHaveAttribute("href", "https://checkout.stripe.test/fixture-monthly-card");
  await expect(page).toHaveURL("https://external.example.invalid/membership");

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    secureCheckout.click(),
  ]);
  await expect(popup.getByTestId("payment-return-screen")).toHaveAttribute("data-payment-status", "paid");
  await expect(popup).toHaveURL(new RegExp(`/embed/form/${FORM_SLUG}$`));
  await expect(popup.locator("header")).toHaveCount(0);
  await expect(popup.locator("footer")).toHaveCount(0);
  await expect(onwardLinks(popup.getByTestId("payment-return-screen"))).toHaveAttribute("href", "/");
  expect(state.monthlyCardCreates[0].return_path).toBe(`/embed/form/${FORM_SLUG}`);
  expect(state.providerRequests).toContain("https://checkout.stripe.test/fixture-monthly-card");
  expect(state.providerRequests.every((url) => /^https:\/\/(?:checkout\.stripe\.test|js\.stripe\.com)\//.test(url))).toBe(true);
  expect(state.confirmationCalls).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
  await capture(popup, testInfo, "cross-origin-popup-return");
  await popup.close();
});

test("GoCardless Drop-in modal completion remains pending and does not claim a collection", async ({ page }, testInfo) => {
  const state = await installFixtures(page, {
    paymentForm: true,
    goCardlessModal: true,
    confirmations: [
      { success: false, status: "pending", provider: "gocardless", pending: true, retryable: false },
    ],
  });
  await page.goto(`/FormView?slug=${FORM_SLUG}`);
  await page.getByTestId("button-form-payment-gocardless-fixture-payment").click();

  const captured = page.getByTestId("form-payment-captured-fixture-payment");
  await expect(captured).toHaveAttribute("data-payment-status", "pending");
  await expect(captured).toContainText(/status is being confirmed|do not make another payment/i);
  await expect(page.locator("html")).toHaveAttribute("data-fixture-go-cardless-modal", "opened");
  await expect(captured).not.toContainText(/payment received/i);

  await page.goto(`/FormView?slug=${FORM_SLUG}&form_payment_submission=${SUBMISSION_ID}&form_payment_provider=gocardless&form_payment_cancelled=1`);
  const screen = page.getByTestId("payment-return-screen");
  await expect(screen).toHaveAttribute("data-payment-status", "cancelled");
  await expect(page.getByTestId("button-return-to-form")).toBeVisible();
  expect(state.goCardlessCreates).toHaveLength(1);
  expect(state.goCardlessCreates[0].return_path).toBe(`/FormView?slug=${FORM_SLUG}`);
  expect(state.confirmationCalls).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "gocardless-modal-pending-and-cancelled");
});

test("GoCardless hosted fallback returns through the full-page pending screen with a safe onward action", async ({ page }, testInfo) => {
  const state = await installFixtures(page, {
    paymentForm: true,
    confirmations: [
      { success: false, status: "pending", provider: "gocardless", pending: true, retryable: false },
    ],
  });
  await page.goto(`/FormView?slug=${FORM_SLUG}`);
  await page.getByTestId("button-form-payment-gocardless-fixture-payment").click();

  const screen = page.getByTestId("payment-return-screen");
  await expect(screen).toHaveAttribute("data-payment-status", "pending");
  await expect(screen).toContainText(/Direct Debit set-up is being confirmed/i);
  await expect(screen).not.toContainText(/payment received/i);
  await expect(onwardLinks(screen)).toHaveCount(1);
  expect(state.goCardlessCreates).toHaveLength(1);
  expect(state.goCardlessCreates[0].return_path).toBe(`/FormView?slug=${FORM_SLUG}`);
  expect(state.confirmationCalls).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "gocardless-hosted-pending");
});

test("dedicated monthly-card and Direct Debit complete, cancel, and unavailable-status routes are registered and have onward navigation", async ({ page }, testInfo) => {
  const state = await installFixtures(page, { directDebitError: true });

  for (const [path, title] of [
    ["/membership/monthly-card/complete?member_id=membership-return-member", /card|membership|payment/i],
    ["/membership/monthly-card/cancelled?member_id=membership-return-member", /not completed|cancelled|card/i],
    ["/membership/direct-debit/complete?member_id=membership-return-member", /Direct Debit/i],
    ["/membership/direct-debit/cancelled?member_id=membership-return-member", /Direct Debit/i],
  ]) {
    await page.goto(path);
    const heading = page.locator("main, body").getByText(title).first();
    await expect(heading).toBeVisible();
    await expect(onwardLinks(page.locator("main, body"))).toHaveCount(1);
    await expect(page.locator("header")).toHaveCount(1);
    await expect(page.locator("footer")).toHaveCount(1);
  }

  // An unavailable verification endpoint must still leave a visible, safe
  // route onward; it must never manufacture a mandate/payment or retry a
  // provider mutation in the browser.
  await page.goto("/membership/direct-debit/complete?member_id=membership-return-member");
  await expect(onwardLinks(page.locator("main, body"))).toHaveCount(1);
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "dedicated-return-routes");
});

test("signed-in dedicated returns use member navigation rather than anonymous public chrome", async ({ page }, testInfo) => {
  const state = await installFixtures(page, { signedIn: true });
  for (const [path, card, memberButton] of [
    ["/membership/monthly-card/complete?member_id=membership-return-member", "card-monthly-card-return", "button-monthly-card-return-member-area"],
    ["/membership/direct-debit/complete?member_id=membership-return-member", "card-dd-return", "button-dd-return-member-area"],
  ]) {
    await page.goto(path);
    await expect(page.getByTestId(card)).toBeVisible();
    await expect(page.locator('[data-sidebar="sidebar"]')).toBeVisible();
    await expect(page.getByTestId(memberButton)).toHaveAttribute("href", "/Dashboard");
  }
  expect(state.unexpectedWrites).toEqual([]);
  await capture(page, testInfo, "signed-in-dedicated-member-navigation");
});