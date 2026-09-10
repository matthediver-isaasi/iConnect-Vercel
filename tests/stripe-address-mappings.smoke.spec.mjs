import { test, expect } from "@playwright/test";

const formId = "stripe-address-smoke-form";
const formSlug = "stripe-address-smoke";
const emailField = {
  id: "email-field",
  type: "email",
  label: "Email",
};
const organisationNameField = {
  id: "organisation-name-field",
  type: "text",
  label: "Organisation name",
};
const priceField = {
  id: "price-field",
  type: "number",
  label: "Amount",
  required: true,
};
const paymentField = {
  id: "payment-field",
  type: "payment",
  label: "Card payment",
  payment_providers: ["stripe"],
  price_field_id: priceField.id,
  payment_currency: "GBP",
};
const memberAddressField = {
  id: "member-address-field",
  label: "Member billing address",
  name: "member_billing_address",
  field_type: "textarea",
  entity_scope: "member",
  is_active: true,
};
const organisationCountryField = {
  id: "organisation-country-field",
  label: "Organisation country",
  name: "organisation_country",
  field_type: "country",
  entity_scope: "organization",
  is_active: true,
};

function makeForm(mappings) {
  return {
    id: formId,
    tenant_id: "stripe-address-smoke-tenant",
    name: "Stripe address browser regression",
    slug: formSlug,
    description: "A browser-only mocked form",
    form_type: "standard",
    layout_type: "standard",
    submit_button_text: "Submit",
    success_message: "Submitted",
    is_active: true,
    access_level: "public",
    application_level: "member",
    fields: [
      emailField,
      organisationNameField,
      priceField,
      {
        ...paymentField,
        ...(mappings === undefined ? {} : { stripe_billing_address_mappings: mappings }),
      },
    ],
    pages: [],
    logic_rules: [],
    conditional_actions: [],
    field_mappings: [],
    entity_pipelines: {
      members: [{
        id: "primary-member",
        label: "Primary member",
        mappings: [{
          source_field_id: emailField.id,
          target_type: "core",
          target_field: "email",
        }],
      }],
      organisations: [{
        id: "primary-organisation",
        label: "Primary organisation",
        mappings: [{
          source_field_id: organisationNameField.id,
          target_type: "core",
          target_field: "name",
        }],
      }],
    },
  };
}

const browserUser = {
  id: "stripe-address-smoke-user",
  tenant_id: "stripe-address-smoke-tenant",
  organization_id: "stripe-address-smoke-org",
  role_id: "stripe-address-smoke-role",
  email: "stripe-address-smoke@example.invalid",
  first_name: "Stripe",
  last_name: "Tester",
  member_excluded_features: [],
  is_team_member: false,
};

async function mockCommonNetwork(page, state) {
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.addInitScript(() => {
    window.__stripeConfirmCalls = 0;
    const mockStripe = function () {
      window.__stripeElementCalls = [];
      return {
        elements: function () {
          return {
            create: function (type, options) {
              window.__stripeElementCalls.push({ type: type, options: options || null });
              return {
                mount: function (element) {
                  element.dataset.mockStripeElement = type;
                  window.__stripeElementCalls.push({ type: type, mounted: true });
                }
              };
            },
            submit: async function () { return {}; }
          };
        },
        confirmPayment: async function () {
          window.__stripeConfirmCalls += 1;
          return { paymentIntent: { id: "pi_browser_smoke", status: "succeeded" } };
        }
      };
    };
    Object.defineProperty(window, "Stripe", {
      configurable: false,
      writable: false,
      value: mockStripe,
    });
  });
  await page.context().route("https://js.stripe.com/**", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "",
  }));

  await page.context().route("**/rest/v1/**", route => json(route, []));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/auth/me") return json(route, browserUser);
    if (path === "/api/auth/tenant-user-me") {
      return json(route, { user: browserUser, tenant: { id: browserUser.tenant_id } });
    }
    if (path === "/api/public/form-payment-providers") {
      return json(route, { providers: [{ id: "stripe", name: "Card", configured: true }] });
    }
    if (path === `/api/public/form/${formSlug}`) return json(route, state.form);
    if (path === "/api/public/form-payment" && method === "POST") {
      const body = request.postDataJSON();
      state.paymentRequests.push(body);
      if (body.action === "confirm") {
        state.confirmRequests.push(body);
        if (state.processingFailures > 0) {
          state.processingFailures -= 1;
          return json(route, {
            error: "Payment succeeded but record processing needs retry",
            paymentSucceeded: true,
          }, 500);
        }
        return json(route, {
          success: true,
          status: "paid",
          submissionId: body.submission_id,
        });
      }
      const configuredMappings = state.form.fields
        .find(field => field.id === paymentField.id)
        ?.stripe_billing_address_mappings;
      return json(route, {
        submissionId: "stripe-address-submission",
        clientSecret: "pi_browser_smoke_secret_mocked",
        publishableKey: "pk_test_browser_mocked",
        requiresBillingAddress: Array.isArray(configuredMappings) && configuredMappings.length > 0,
      });
    }
    if (path === "/api/entities/Form" && method === "GET") return json(route, [state.form]);
    if (path === `/api/entities/Form/${formId}` && method === "PATCH") {
      const patch = request.postDataJSON();
      state.form = { ...state.form, ...patch };
      state.formWrites.push(patch);
      return json(route, state.form);
    }
    if (path === "/api/entities/PreferenceField") {
      state.preferenceReads += 1;
      return json(route, [memberAddressField, organisationCountryField]);
    }
    if (path === "/api/entities/FormSubmission") return json(route, []);
    if (path === "/api/entities/Role") {
      return json(route, [{
        id: browserUser.role_id,
        name: "Administrator",
        excluded_features: [],
      }]);
    }
    if (path === "/api/admin/integrations") return json(route, { integrations: [] });
    if (path === "/api/custom-objects") return json(route, { data: [] });
    if (path === "/api/public/resource-categories") return json(route, []);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.escapedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected mutation: ${method} ${path}` }, 599);
    }
    return json(route, []);
  });
}

async function openCheckout(page, mappings) {
  const state = {
    form: makeForm(mappings),
    paymentRequests: [],
    formWrites: [],
    escapedWrites: [],
    preferenceReads: 0,
    confirmRequests: [],
    processingFailures: 0,
  };
  await mockCommonNetwork(page, state);
  await page.goto(`/FormView?slug=${formSlug}`);
  await page.locator('input[inputmode="numeric"]').fill("1234");
  await page.getByTestId(`button-form-payment-stripe-${paymentField.id}`).click();
  await expect.poll(() => state.paymentRequests.length).toBe(1);
  return state;
}

async function selectRadixOption(page, triggerTestId, optionName) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

test("builder adds, edits, removes, saves, and reloads Stripe address mappings", async ({ page }) => {
  const state = {
    form: makeForm([]),
    paymentRequests: [],
    formWrites: [],
    escapedWrites: [],
    preferenceReads: 0,
    confirmRequests: [],
    processingFailures: 0,
  };
  await mockCommonNetwork(page, state);
  await page.goto(`/FormBuilder?formId=${formId}`);
  await expect(page.getByRole("heading", { name: state.form.name })).toBeVisible();
  await page.getByTestId(`button-configure-field-${paymentField.id}`).click();
  await expect(page.getByTestId(`stripe-address-mappings-${paymentField.id}`)).toBeVisible();
  await expect.poll(() => state.preferenceReads).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await page.getByTestId(`button-configure-field-${paymentField.id}`).click();

  await page.getByTestId("add-stripe-address-mapping").click();
  await selectRadixOption(page, "stripe-address-entity-0", "Organisation");
  await selectRadixOption(page, "stripe-address-target-0", `${organisationCountryField.label} (custom)`);
  await selectRadixOption(page, "stripe-address-source-0", "Country");

  // A second row is configured and then removed before saving. This catches
  // accidental index/key coupling in the editor without persisting invalid
  // duplicate sources or destinations.
  await page.getByTestId("add-stripe-address-mapping").click();
  await selectRadixOption(page, "stripe-address-target-1", `${memberAddressField.label} (custom)`);
  await page.getByTestId("remove-stripe-address-mapping-1").click();

  await page.getByTestId("save-stripe-address-mappings").click();
  await expect(page.getByText("Stripe billing address mappings saved to this payment field.")).toBeVisible();

  // Reload saved is an editor-local reset, distinct from a browser reload.
  await selectRadixOption(page, "stripe-address-source-0", "City");
  await page.getByTestId("reload-stripe-address-mappings").click();
  await expect(page.getByTestId("stripe-address-source-0")).toContainText("Country");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save Form", exact: true }).click();
  await expect.poll(() => state.formWrites.length).toBe(1);
  expect(state.formWrites[0].fields.find(field => field.id === paymentField.id)
    .stripe_billing_address_mappings).toEqual([{
      source: "country",
      target_entity: "organization",
      target_type: "custom",
      target_field: organisationCountryField.id,
    }]);

  await page.reload();
  await page.getByTestId(`button-configure-field-${paymentField.id}`).click();
  await expect(page.getByTestId("stripe-address-source-0")).toContainText("Country");
  await expect(page.getByTestId("stripe-address-target-0")).toContainText(organisationCountryField.label);
  await page.screenshot({
    path: "screenshots/stripe-address-mappings-builder.png",
    fullPage: true,
  });

  await page.getByTestId("remove-stripe-address-mapping-0").click();
  await page.getByTestId("save-stripe-address-mappings").click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Save Form", exact: true }).click();
  await expect.poll(() => state.formWrites.length).toBe(2);
  expect(state.formWrites[1].fields.find(field => field.id === paymentField.id)
    .stripe_billing_address_mappings).toEqual([]);

  await page.reload();
  await page.getByTestId(`button-configure-field-${paymentField.id}`).click();
  await expect(page.getByText("No billing address details are mapped.")).toBeVisible();
  expect(state.escapedWrites).toEqual([]);
});

test("mapped non-membership Stripe checkout mounts AddressElement and suppresses PaymentElement address", async ({ page }) => {
  const state = await openCheckout(page, [{
    source: "formatted",
    target_entity: "member",
    target_type: "custom",
    target_field: memberAddressField.id,
  }]);

  const address = page.getByTestId(`form-payment-stripe-address-element-${paymentField.id}`);
  await expect(address).toBeVisible();
  await expect(address).toHaveAttribute("data-mock-stripe-element", "address");
  await expect(page.getByTestId(`form-payment-stripe-element-${paymentField.id}`))
    .toHaveAttribute("data-mock-stripe-element", "payment");
  await page.screenshot({
    path: "screenshots/stripe-address-mappings-checkout.png",
    fullPage: true,
  });
  const creates = await page.evaluate(() =>
    window.__stripeElementCalls.filter(call => !call.mounted)
  );
  expect(creates).toEqual([
    { type: "address", options: { mode: "billing" } },
    { type: "payment", options: { fields: { billingDetails: { address: "never" } } } },
  ]);
  expect(state.escapedWrites).toEqual([]);
});

test("unmapped non-membership Stripe checkout remains PaymentElement-only", async ({ page }) => {
  const state = await openCheckout(page, undefined);

  await expect(page.getByTestId(`form-payment-stripe-address-element-${paymentField.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`form-payment-stripe-element-${paymentField.id}`))
    .toHaveAttribute("data-mock-stripe-element", "payment");
  const creates = await page.evaluate(() =>
    window.__stripeElementCalls.filter(call => !call.mounted)
  );
  expect(creates).toEqual([{ type: "payment", options: null }]);
  expect(state.escapedWrites).toEqual([]);
});

test("paid processing failure offers retry without creating or confirming another charge", async ({ page }) => {
  const state = await openCheckout(page, [{
    source: "country",
    target_entity: "organization",
    target_type: "custom",
    target_field: organisationCountryField.id,
  }]);
  state.processingFailures = 1;

  await expect(page.getByTestId(`form-payment-stripe-element-${paymentField.id}`))
    .toHaveAttribute("data-mock-stripe-element", "payment");
  await page.getByTestId(`button-form-payment-confirm-${paymentField.id}`).click();

  const captured = page.getByTestId(`form-payment-captured-${paymentField.id}`);
  await expect(captured).toContainText("Your card payment was successful");
  await expect(captured).toContainText("do not pay again");
  await expect(page.getByText("Payment succeeded but record processing needs retry")).toBeVisible();
  await expect(page.getByTestId(`button-form-payment-stripe-${paymentField.id}`)).toHaveCount(0);
  expect(state.paymentRequests.filter(request => request.action === "create")).toHaveLength(1);
  expect(state.confirmRequests).toHaveLength(1);
  expect(await page.evaluate(() => window.__stripeConfirmCalls)).toBe(1);

  await page.getByTestId(`button-form-payment-retry-processing-${paymentField.id}`).click();
  await expect.poll(() => state.confirmRequests.length).toBe(2);
  await expect(captured).toHaveCount(0);
  expect(state.paymentRequests.filter(request => request.action === "create")).toHaveLength(1);
  expect(await page.evaluate(() => window.__stripeConfirmCalls)).toBe(1);
  expect(state.escapedWrites).toEqual([]);
});