import { test, expect } from "@playwright/test";

const viewer = {
  id: "recovery-viewer",
  tenant_id: "recovery-tenant",
  organization_id: "recovery-org",
  role_id: "recovery-admin-role",
  email: "recovery@example.invalid",
  first_name: "Recovery",
  last_name: "Administrator",
  member_excluded_features: [],
};

const role = {
  id: viewer.role_id,
  name: "Administrator",
  excluded_features: [],
};

const goCardlessAgreement = {
  id: "agreement-gc-waiting",
  provider: "gocardless",
  status: "pending_provider",
  environment: "sandbox",
  supported: true,
};

const stripeAgreement = {
  id: "agreement-stripe-paid",
  provider: "stripe",
  status: "pending_recovery",
  environment: "test",
  supported: true,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function waitingPreview() {
  return {
    supported: true,
    canResume: false,
    provider: { setupStatus: "pending" },
    local: { hasPlan: false, recordedInstalments: 0 },
    terms: { invoicingMode: "monthly", activationRule: "mandate_fulfilled" },
    proposedWork: [],
    warnings: [],
  };
}

function stripePreview(disclosure = "a paid invoice will be recovered without charging it twice") {
  return {
    supported: true,
    canResume: true,
    provider: { setupStatus: "fulfilled" },
    local: { hasPlan: false, recordedInstalments: 1 },
    terms: { invoicingMode: "monthly", activationRule: "first_paid_invoice" },
    proposedWork: ["Create the missing local monthly payment plan"],
    warnings: ["The first Stripe invoice is paid, but its webhook has not been recorded locally."],
    confirmationDisclosure: disclosure,
  };
}

async function installFixtures(page, {
  agreements = [goCardlessAgreement, stripeAgreement],
  listGate,
  listError = "",
  previews = {},
  postError = "",
  postResult = { success: true, resumed: true },
} = {}) {
  const state = {
    listCalls: 0,
    previewCalls: [],
    posts: [],
    escapedWrites: [],
    requests: [],
  };
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

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
      return json(route, { user: viewer, tenant: { id: viewer.tenant_id, slug: "recovery-test" } });
    }
    if (path === `/api/entities/Role/${role.id}`) return json(route, role);
    if (path === "/api/entities/Role") return json(route, [role]);
    if (path === "/api/entities/SystemSettings") return json(route, []);
    if (path === "/api/membership/membership-settings") return json(route, {});
    if (path === "/api/membership/payment-plan") return json(route, { plans: [] });

    if (path === "/api/membership/monthly-recovery" && method === "GET") {
      const agreementId = url.searchParams.get("agreementId");
      if (agreementId) {
        state.previewCalls.push(agreementId);
        const response = previews[agreementId];
        if (response instanceof Error) return json(route, { error: response.message }, 502);
        if (!response) return json(route, { error: `No preview fixture for ${agreementId}` }, 500);
        return json(route, response);
      }
      state.listCalls += 1;
      if (listGate) await listGate.promise;
      if (listError) return json(route, { error: listError }, 503);
      return json(route, { agreements });
    }

    if (path === "/api/membership/monthly-recovery" && method === "POST") {
      state.posts.push(request.postDataJSON());
      if (postError) return json(route, { error: postError }, 409);
      return json(route, postResult);
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
  await page.goto("/MembershipSettings");
  await expect(page.getByTestId("text-page-title")).toHaveText("Membership Settings");
  return page.getByTestId("monthly-membership-recovery");
}

test("pending agreement list exposes loading and empty states", async ({ page }) => {
  const gate = deferred();
  const state = await installFixtures(page, { agreements: [], listGate: gate });
  const card = await openSettings(page);

  await expect(card.getByText("Loading pending agreements...")).toBeVisible();
  gate.resolve();
  await expect(card.getByText("No form-originated monthly agreements are available to inspect.")).toBeVisible();
  expect(state.listCalls).toBe(1);
  expect(state.escapedWrites).toEqual([]);
});

test("pending agreement list displays its API error", async ({ page }) => {
  const state = await installFixtures(page, { listError: "Recovery list fixture unavailable" });
  const card = await openSettings(page);

  await expect(card.getByRole("alert")).toContainText("Recovery list fixture unavailable");
  await expect(card.getByText("No form-originated monthly agreements are available to inspect.")).toBeVisible();
  expect(state.escapedWrites).toEqual([]);
});

test("GoCardless waiting preview cannot resume", async ({ page }) => {
  const state = await installFixtures(page, {
    agreements: [goCardlessAgreement],
    previews: { [goCardlessAgreement.id]: waitingPreview() },
  });
  const card = await openSettings(page);
  await card.getByTestId(`preview-monthly-recovery-${goCardlessAgreement.id}`).click();

  const preview = card.getByTestId("monthly-recovery-preview");
  await expect(preview).toContainText("pending");
  await expect(preview).toContainText("Provider setup is not fulfilled");
  await expect(preview.getByRole("button", { name: "Confirm and resume" })).toHaveCount(0);
  await expect(preview.locator("#confirm-monthly-recovery")).toHaveCount(0);
  expect(state.posts).toEqual([]);
  expect(state.escapedWrites).toEqual([]);
});

test("Stripe first-paid preview warns about the missing webhook", async ({ page }) => {
  const state = await installFixtures(page, {
    agreements: [stripeAgreement],
    previews: { [stripeAgreement.id]: stripePreview() },
  });
  const card = await openSettings(page);
  await card.getByTestId(`preview-monthly-recovery-${stripeAgreement.id}`).click();

  const preview = card.getByTestId("monthly-recovery-preview");
  await expect(preview).toContainText("first paid invoice");
  await expect(preview).toContainText("first Stripe invoice is paid");
  await expect(preview).toContainText("webhook has not been recorded locally");
  await expect(preview.locator("#confirm-monthly-recovery")).not.toBeChecked();
  await expect(preview.getByRole("button", { name: "Confirm and resume" })).toBeDisabled();
  expect(state.posts).toEqual([]);
  expect(state.escapedWrites).toEqual([]);
});

test("explicit consent gates POST, sends confirmation, refreshes data, and resets when switching rows", async ({ page }) => {
  const otherAgreement = {
    ...stripeAgreement,
    id: "agreement-stripe-second",
    status: "pending_recovery",
  };
  const state = await installFixtures(page, {
    agreements: [stripeAgreement, otherAgreement],
    previews: {
      [stripeAgreement.id]: stripePreview(),
      [otherAgreement.id]: stripePreview("the second agreement will be resumed"),
    },
  });
  const card = await openSettings(page);
  await card.getByTestId(`preview-monthly-recovery-${stripeAgreement.id}`).click();

  const checkbox = card.locator("#confirm-monthly-recovery");
  const confirm = card.getByRole("button", { name: "Confirm and resume" });
  await expect(confirm).toBeDisabled();
  await confirm.click({ force: true });
  expect(state.posts).toEqual([]);

  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(confirm).toBeEnabled();

  await card.getByTestId(`preview-monthly-recovery-${otherAgreement.id}`).click();
  await expect(card.getByTestId("monthly-recovery-preview")).toContainText("second agreement");
  await expect(card.locator("#confirm-monthly-recovery")).not.toBeChecked();
  await expect(card.getByRole("button", { name: "Confirm and resume" })).toBeDisabled();
  expect(state.posts).toEqual([]);

  await card.locator("#confirm-monthly-recovery").click();
  await card.getByRole("button", { name: "Confirm and resume" }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]).toEqual({
    agreementId: otherAgreement.id,
    confirmed: true,
  });
  await expect.poll(() => state.listCalls).toBeGreaterThanOrEqual(2);
  await expect.poll(() => state.previewCalls.filter((id) => id === otherAgreement.id).length).toBeGreaterThanOrEqual(2);
  expect(state.escapedWrites).toEqual([]);
});

test("preview and POST errors remain visible and no unmocked write escapes", async ({ page }) => {
  const state = await installFixtures(page, {
    previews: {
      [goCardlessAgreement.id]: new Error("Provider preview exploded"),
      [stripeAgreement.id]: stripePreview(),
    },
    postError: "Recovery mutation rejected",
  });
  const card = await openSettings(page);

  await card.getByTestId(`preview-monthly-recovery-${goCardlessAgreement.id}`).click();
  await expect(card.getByRole("alert")).toContainText("Provider preview exploded");
  await expect(card.getByTestId("monthly-recovery-preview")).toHaveCount(0);

  await card.getByTestId(`preview-monthly-recovery-${stripeAgreement.id}`).click();
  await card.locator("#confirm-monthly-recovery").click();
  await card.getByRole("button", { name: "Confirm and resume" }).click();
  await expect(card.getByRole("alert")).toContainText("Recovery mutation rejected");
  expect(state.posts).toEqual([{ agreementId: stripeAgreement.id, confirmed: true }]);
  expect(state.escapedWrites).toEqual([]);
});

test("a known older agreement omitted from the pending list can be previewed directly", async ({ page }) => {
  const historicalId = "agreement-historical-older-than-list-limit";
  const state = await installFixtures(page, {
    agreements: [stripeAgreement],
    previews: {
      [historicalId]: {
        ...stripePreview("the historical agreement will be recovered"),
        agreement: { id: historicalId, provider: "stripe" },
      },
    },
  });
  const card = await openSettings(page);

  await expect(card.getByText(historicalId, { exact: true })).toHaveCount(0);
  await card.getByTestId("input-monthly-recovery-agreement-id").fill(`  ${historicalId}  `);
  await card.getByTestId("inspect-monthly-recovery-agreement-id").click();

  const preview = card.getByTestId("monthly-recovery-preview");
  await expect(preview).toContainText(`Selected agreement: ${historicalId}`);
  await expect(preview).toContainText("historical agreement");
  expect(state.previewCalls).toEqual([historicalId]);
  expect(state.posts).toEqual([]);
  expect(state.escapedWrites).toEqual([]);
});

test("legacy HTTP 200 failed child outcome is surfaced as a blocked retryable alert", async ({ page }) => {
  const failure = "Child recovery failed: invoice finalization is blocked and retryable.";
  const state = await installFixtures(page, {
    agreements: [stripeAgreement],
    previews: { [stripeAgreement.id]: stripePreview() },
    postResult: {
      resumed: false,
      retryable: true,
      blocked: true,
      error: failure,
      childOutcome: { resumed: false, retryable: true, blocked: true },
    },
  });
  const card = await openSettings(page);
  await card.getByTestId(`preview-monthly-recovery-${stripeAgreement.id}`).click();
  await card.locator("#confirm-monthly-recovery").click();
  await card.getByRole("button", { name: "Confirm and resume" }).click();

  await expect(card.getByRole("alert")).toContainText(failure);
  expect(state.posts).toEqual([{ agreementId: stripeAgreement.id, confirmed: true }]);
  expect(state.listCalls).toBe(1);
  expect(state.previewCalls).toEqual([stripeAgreement.id]);
  expect(state.escapedWrites).toEqual([]);
});