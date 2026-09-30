import { test, expect } from "@playwright/test";

const tenantId = "stripe-webhook-fixture-tenant";
const viewer = {
  id: "stripe-webhook-fixture-admin",
  tenant_id: tenantId,
  organization_id: "stripe-webhook-fixture-org",
  role_id: "stripe-webhook-fixture-role",
  email: "stripe-webhook-admin@example.invalid",
  first_name: "Webhook",
  last_name: "Administrator",
  member_excluded_features: [],
  is_super_admin: true,
};
const role = {
  id: viewer.role_id,
  name: "Administrator",
  excluded_features: [],
};
const webhookUrl = `https://fixture.example.invalid/api/webhooks/stripe-membership?tenant=${tenantId}`;
const events = [
  "payment_intent.succeeded",
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "customer.subscription.deleted",
];

function settings({
  url = webhookUrl,
  requiredEvents = events,
  liveStored = true,
  testStored = false,
} = {}) {
  return {
    url,
    events: requiredEvents,
    modes: {
      live: { secret_configured: liveStored, api_key_configured: true },
      test: { secret_configured: testStored, api_key_configured: true },
    },
  };
}

async function installFixtures(page, {
  initialSettings = settings(),
  stripeEnabled = true,
  saveFailure = "",
  checkResponses = {},
} = {}) {
  const state = {
    currentSettings: structuredClone(initialSettings),
    posts: [],
    checks: [],
    escapedWrites: [],
    requests: [],
  };
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.context().route("https://js.stripe.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "",
  }));
  await page.context().route("**/rest/v1/**", async (route) => {
    const method = route.request().method();
    state.requests.push(`${method} ${route.request().url()} [mocked Supabase]`);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${route.request().url()}`);
      return json(route, { error: "Unexpected direct data mutation" }, 599);
    }
    return json(route, []);
  });
  await page.context().route("**/auth/v1/**", async (route) => {
    const method = route.request().method();
    state.requests.push(`${method} ${route.request().url()} [mocked Supabase auth]`);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${route.request().url()}`);
      return json(route, { error: "Unexpected Supabase auth mutation" }, 599);
    }
    return json(route, { user: null });
  });
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    state.requests.push(`${method} ${path}${url.search}`);

    if (path === "/api/auth/me") return json(route, viewer);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, {
        authenticated: true,
        user: viewer,
        tenantUser: viewer,
        tenant: { id: tenantId, slug: "stripe-webhook-fixture", name: "Webhook Fixture Tenant", settings: {} },
      });
    }
    if (path === `/api/entities/Role/${role.id}`) return json(route, role);
    if (path === "/api/entities/Role") return json(route, [role]);
    if (path === "/api/entities/SystemSettings") return json(route, []);

    if (path === "/api/admin/integrations" && method === "GET") {
      return json(route, {
        integrations: [{
          integration_type: "stripe",
          is_enabled: stripeEnabled,
          has_credentials: true,
          credentials: {
            secret_key: "",
            publishable_key: "",
            test_secret_key: "",
            test_publishable_key: "",
            stripe_mode_membership: "live",
          },
        }],
        stripe_membership_webhook: state.currentSettings,
      });
    }
    if (path === "/api/admin/integrations" && method === "POST") {
      const body = request.postDataJSON();
      state.posts.push(body);
      if (saveFailure) return json(route, { error: saveFailure }, 500);
      if (body.credentials?.membership_webhook_secret) {
        state.currentSettings.modes.live.secret_configured = true;
      }
      if (body.credentials?.test_membership_webhook_secret) {
        state.currentSettings.modes.test.secret_configured = true;
      }
      return json(route, { success: true });
    }
    if (path === "/api/admin/stripe-membership-webhooks" && method === "POST") {
      const body = request.postDataJSON();
      state.checks.push(body);
      const response = checkResponses[body.mode];
      if (response instanceof Error) return json(route, { error: response.message }, 503);
      if (response) return json(route, response);
      return json(route, { error: `No check fixture for ${body.mode}` }, 500);
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });
  return state;
}

async function openSettings(page) {
  await page.goto("/admin/integrations");
  const card = page.getByTestId("card-stripe-membership-webhook");
  await expect(card).toBeVisible();
  return card;
}

test("renders safe server settings, copies the exact URL, and links the guide", async ({ page }) => {
  const state = await installFixtures(page, {
    initialSettings: settings({ liveStored: true, testStored: false }),
  });
  const card = await openSettings(page);

  const urlInput = card.getByTestId("input-stripe-membership-webhook-url");
  await expect(urlInput).toHaveValue(webhookUrl);
  await card.getByTestId("button-copy-stripe-membership-webhook-url").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(webhookUrl);

  await expect(card.getByText("Signing secret stored")).toHaveCount(1);
  await expect(card.getByText("Signing secret not stored")).toHaveCount(1);
  await expect(card.getByText("invoice.paid", { exact: true })).toBeVisible();
  const guide = card.getByRole("link", { name: "Open the tenant-admin setup guide" });
  await expect(guide).toHaveAttribute("href", "/guides/stripe-membership-payments.html");
  await expect(guide).toHaveAttribute("target", "_blank");

  await card.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "screenshots/stripe-membership-webhooks-settings.png",
    fullPage: true,
  });
  expect(state.posts).toEqual([]);
  expect(state.escapedWrites).toEqual([]);
});

test("saving one replacement omits the blank secret, preserves enabled state, and clears input", async ({ page }) => {
  const state = await installFixtures(page, {
    initialSettings: settings({ liveStored: false, testStored: true }),
    stripeEnabled: true,
  });
  const card = await openSettings(page);
  const liveSecret = card.getByTestId("input-stripe-membership-webhook-secret-live");
  const testSecret = card.getByTestId("input-stripe-membership-webhook-secret-test");

  await liveSecret.fill("  whsec_fixture_live  ");
  await expect(card.getByTestId("button-check-stripe-membership-webhook-live")).toBeDisabled();
  await card.getByTestId("button-save-stripe-membership-webhook-secrets").click();
  await expect.poll(() => state.posts.length).toBe(1);

  expect(state.posts[0]).toEqual({
    integration_type: "stripe",
    credentials: { membership_webhook_secret: "whsec_fixture_live" },
    is_enabled: true,
  });
  expect(state.posts[0].credentials).not.toHaveProperty("test_membership_webhook_secret");
  await expect(liveSecret).toHaveValue("");
  await expect(testSecret).toHaveValue("");
  await expect(card.getByText("Signing secret stored")).toHaveCount(2);
  expect(state.escapedWrites).toEqual([]);
});

test("unsaved secrets disable checks and save/check failures remain visible", async ({ page }) => {
  const state = await installFixtures(page, {
    initialSettings: settings({ liveStored: true, testStored: true }),
    saveFailure: "Fixture refused signing-secret save",
    checkResponses: {
      test: new Error("Fixture Stripe configuration check failed"),
    },
  });
  const card = await openSettings(page);

  const liveSecret = card.getByTestId("input-stripe-membership-webhook-secret-live");
  const liveCheck = card.getByTestId("button-check-stripe-membership-webhook-live");
  await expect(liveCheck).toBeEnabled();
  await liveSecret.fill("whsec_fixture_replacement");
  await expect(liveCheck).toBeDisabled();
  await expect(card.getByText("Save the new secret before checking this configuration.")).toBeVisible();

  await card.getByTestId("button-save-stripe-membership-webhook-secrets").click();
  await expect(page.getByText("Fixture refused signing-secret save")).toBeVisible();
  await expect(liveSecret).toHaveValue("whsec_fixture_replacement");

  await card.getByTestId("button-check-stripe-membership-webhook-test").click();
  const result = card.getByTestId("stripe-membership-webhook-result-test");
  await expect(result).toContainText("Configuration check unavailable");
  await expect(result).toContainText("Fixture Stripe configuration check failed");
  expect(state.checks).toEqual([{ mode: "test" }]);
  expect(state.escapedWrites).toEqual([]);
});

test("live and test checks are independent and do not claim webhook delivery proof", async ({ page }) => {
  const state = await installFixtures(page, {
    initialSettings: settings({ liveStored: true, testStored: true }),
    checkResponses: {
      live: {
        mode: "live",
        status: "incomplete",
        checks: {
          api_key_configured: true,
          endpoint_found: false,
          endpoint_enabled: false,
          events_complete: false,
        },
        missing_events: ["invoice.paid", "customer.subscription.updated"],
        message: "No matching live endpoint was found.",
      },
      test: {
        mode: "test",
        status: "configured",
        checks: {
          api_key_configured: true,
          endpoint_found: true,
          endpoint_enabled: true,
          events_complete: true,
        },
        missing_events: [],
        message: "The required test endpoint configuration was found.",
      },
    },
  });
  const card = await openSettings(page);

  await card.getByTestId("button-check-stripe-membership-webhook-live").click();
  const liveResult = card.getByTestId("stripe-membership-webhook-result-live");
  await expect(liveResult).toContainText("Configuration incomplete");
  await expect(liveResult).toContainText("No matching live endpoint was found.");
  await expect(liveResult).toContainText("Missing events");
  await expect(liveResult).toContainText("invoice.paid, customer.subscription.updated");

  await card.getByTestId("button-check-stripe-membership-webhook-test").click();
  const testResult = card.getByTestId("stripe-membership-webhook-result-test");
  await expect(testResult).toContainText("Configuration found");
  await expect(testResult.locator("li").filter({ hasText: "Endpoint found" })).toContainText("Yes");
  await expect(testResult.locator("li").filter({ hasText: "Required events selected" })).toContainText("Yes");
  await expect(liveResult).toBeVisible();

  expect(state.checks).toEqual([{ mode: "live" }, { mode: "test" }]);
  await expect(card).toContainText("do not create a webhook endpoint");
  await expect(card).toContainText("prove that Stripe has delivered an event");
  await expect(card).toContainText("stored signing secret matches the endpoint");
  expect(state.escapedWrites).toEqual([]);
});