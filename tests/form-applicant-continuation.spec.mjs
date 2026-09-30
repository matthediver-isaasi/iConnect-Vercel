import { test, expect } from "@playwright/test";

const FORM_ID = "applicant-continuation-form";
const SLUG = "applicant-continuation";
const ORG_ID = "applicant-organisation";
const ORG_ID_2 = "second-applicant-organisation";
const TOKEN = "secure-applicant-capability";
const RESUME = "secure-draft-resume";
const PREFILL_ORG_ID = "40bf035b-d93d-4384-ae5e-6d6af513af73";
const PREFILL_ORG_NAME = "North Harbour Arts";
const PREFILL_ORG_CUSTOM = "Established in 1984";

const updateForm = {
  id: FORM_ID,
  slug: SLUG,
  name: "Applicant continuation fixture",
  description: "Secure continuation browser fixture",
  blank_layout: true,
  layout_type: "standard",
  fields: [{ id: "answer", type: "text", label: "Application answer", required: true }],
  pages: [],
  visibility_rules: [],
  entity_pipelines: { members: [], organisations: [{ id: "org-update" }] },
  mutation_access_policy: { version: 1, mode: "applicant_continuation" },
  mutation_contract: {
    mutationTargets: ["organization"],
    hasExistingRecordMutation: true,
    canIssueApplicantContinuation: true,
    targets: { organization: { classification: "may_mutate_existing" } },
  },
  require_authentication: false,
  is_active: true,
  submit_button_text: "Submit application",
  allow_save_continue_later: true,
  prefill_source: "none",
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const answerInput = page => page.locator('input[type="text"]:visible').first();
const orgNameInput = page => page.getByRole("textbox").first();
const orgHistoryInput = page => page.getByRole("textbox").nth(1);

async function fixture(page, {
  invalidToken = false,
  referenceOnly = false,
  legacyPublicApplication = false,
  membershipPayment = false,
  boundDraft = false,
  authenticatedOwner = false,
  organisationField = null,
  holdVerification = false,
  holdEntity = false,
} = {}) {
  let releaseVerification;
  let releaseEntity;
  const verificationGate = holdVerification
    ? new Promise(resolve => { releaseVerification = resolve; }) : null;
  const entityGate = holdEntity
    ? new Promise(resolve => { releaseEntity = resolve; }) : null;
  const state = {
    verifications: [], draftSaves: [], submissions: [], unexpectedWrites: [],
    orgPrefills: [], draftBound: boundDraft, quotes: [], paymentCreates: [],
    releaseVerification: () => releaseVerification?.(),
    releaseEntity: () => releaseEntity?.(),
  };
  const baseForm = organisationField ? {
    ...updateForm,
    prefill_source: "organization",
    fields: [
      { id: "org-name", type: "text", label: "Organisation name", prefill_field: "org:name" },
      { id: "org-history", type: "text", label: "Organisation history", prefill_field: "org_custom:history" },
      ...(organisationField === "dropdown"
        ? [{ id: "org-selector", type: "organisation_dropdown", label: "Organisation" }]
        : []),
    ],
    entity_pipelines: {
      members: [],
      organisations: [{
        id: "org-update",
        uniqueness_key: organisationField === "custom" ? "registered_name" : "name",
        mappings: [{
          source_type: "field",
          source_field_id: organisationField === "dropdown" ? "org-selector" : "org-name",
          target_field: organisationField === "custom" ? "registered_name" : "name",
        }],
      }],
    },
  } : membershipPayment ? {
    ...updateForm,
    fields: [
      updateForm.fields[0],
      { id: "membership-choice", type: "text", starts_hidden: true, default_value: "monthly" },
      {
        id: "membership-payment",
        type: "payment",
        label: "Membership payment",
        payment_currency: "GBP",
        payment_providers: ["stripe"],
      },
    ],
    visibility_rules: [{
      id: "membership-rule",
      trigger_field_id: "membership-choice",
      operator: "equals",
      value: "monthly",
      actions: [{
        id: "membership-action",
        action_type: "membership_structure",
        config_id: "membership-config",
      }],
    }],
  } : updateForm;
  const form = legacyPublicApplication ? {
    ...baseForm,
    mutation_access_policy: { version: 1, mode: "legacy_public_application" },
  } : referenceOnly ? {
    ...baseForm,
    id: `${FORM_ID}-reference`,
    slug: `${SLUG}-reference`,
    entity_pipelines: { members: [], organisations: [] },
    mutation_access_policy: null,
    mutation_contract: {
      mutationTargets: [],
      hasExistingRecordMutation: false,
      canIssueApplicantContinuation: false,
      targets: { organization: { classification: "reference_only" } },
    },
  } : baseForm;

  await page.context().route("**/rest/v1/**", route => json(route, []));
  await page.context().route("**/auth/v1/**", route => json(route, []));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();

    if (path === "/api/auth/me" || path === "/api/auth/tenant-user-me") {
      return json(route, authenticatedOwner ? {
        id: "owner-member",
        tenant_id: "owner-tenant",
        organization_id: ORG_ID,
        role_id: "owner-role",
        email: "owner@example.invalid",
        first_name: "Owner",
        last_name: "Member",
        member_excluded_features: [],
      } : null);
    }
    if (path === "/api/entities/Role/owner-role") {
      return json(route, { id: "owner-role", name: "Owner", excluded_features: [] });
    }
    if (path === `/api/public/form/${form.slug}` && method === "GET") return json(route, form);
    if (path === "/api/public/form-consent-message") return json(route, { message: "" });
    if (path === "/api/public/tenant-branding") return json(route, { branding: {} });
    if (path === "/api/public/form-payment-providers" && method === "GET") {
      return json(route, { providers: [{ id: "stripe", configured: true }] });
    }
    if (path === "/api/public/form-payment" && method === "POST") {
      const body = request.postDataJSON();
      if (body.action === "quote") {
        state.quotes.push(body);
        return json(route, {
          required: true,
          amount: 120,
          currency: "GBP",
          membership: { config_name: "Membership", tier_label: "Member" },
        });
      }
      state.paymentCreates.push(body);
      return json(route, { error: "Fixture stops after credential assertion" }, 409);
    }
    if (path === "/api/public/form-applicant-continuation" && method === "POST") {
      const body = request.postDataJSON();
      state.verifications.push(body);
      if (verificationGate) await verificationGate;
      if (invalidToken) return json(route, { error: "Applicant link is invalid or expired" }, 403);
      return json(route, {
        form_id: form.id,
        organization_id: organisationField ? PREFILL_ORG_ID
          : body.applicant_continuation_token === `${TOKEN}-2` ? ORG_ID_2 : ORG_ID,
        expires_at: "2099-01-01T00:00:00.000Z",
      });
    }
    if (path === "/api/public/form-draft" && method === "POST") {
      const body = request.postDataJSON();
      state.draftSaves.push(body);
      if (body.applicant_continuation_token) state.draftBound = true;
      return json(route, { success: true, resume_token: RESUME, expires_at: "2099-01-01T00:00:00.000Z" });
    }
    if (path === "/api/public/form-draft" && method === "GET") {
      expect(url.searchParams.get("token")).toBe(RESUME);
      return json(route, {
        success: true,
        ...(state.draftBound ? { applicant_continuation: {
          form_id: form.id,
          organization_id: ORG_ID,
          expires_at: "2099-01-01T00:00:00.000Z",
        } } : {}),
        draft: { draft_data: { answer: "Preserved answer" }, current_page_index: 0 },
        form: { id: form.id, slug: form.slug, name: form.name },
        schema_changed: false,
      });
    }
    if (path.startsWith("/api/public/organisation/") && method === "GET") {
      const id = decodeURIComponent(path.split("/").pop());
      if (path.endsWith("/preference-values")) {
        return json(route, [{ field_id: "history", value: PREFILL_ORG_CUSTOM }]);
      }
      state.orgPrefills.push(id);
      if (entityGate) await entityGate;
      return json(route, { id, name: id === PREFILL_ORG_ID ? PREFILL_ORG_NAME : `Organisation ${id}` });
    }
    if (path === "/api/public/organisations" && method === "POST") {
      return json(route, [{ id: PREFILL_ORG_ID, name: PREFILL_ORG_NAME }]);
    }
    if (path === "/api/public/form-submission" && method === "POST") {
      state.submissions.push(request.postDataJSON());
      return json(route, { success: true, submission_id: "submission-fixture" });
    }
    if (path === "/api/forms/send-submission-email" && method === "POST") {
      return json(route, { success: true, skipped: true });
    }
    if (method === "POST" || method === "PATCH" || method === "DELETE") {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: "Unexpected fixture write" }, 599);
    }
    return json(route, []);
  });
  return { state, form };
}

test("verifies, scrubs, and scope-restores only the same form capability", async ({ page }) => {
  const { state, form } = await fixture(page);
  await page.goto(`/FormView?slug=${form.slug}&applicant_continuation_token=${TOKEN}`);
  await expect(answerInput(page)).toBeVisible();
  await expect.poll(() => state.verifications.length).toBe(1);
  expect(state.verifications[0]).toEqual({ form_id: form.id, applicant_continuation_token: TOKEN });
  await expect.poll(() => new URL(page.url()).searchParams.has("applicant_continuation_token")).toBe(false);
  expect(new URL(page.url()).searchParams.get("applicant_continuation")).toBe("1");

  await page.reload();
  await expect(answerInput(page)).toBeVisible();
  await expect.poll(() => state.verifications.length).toBe(2);
  expect(state.verifications[1]).toEqual({ form_id: form.id, applicant_continuation_token: TOKEN });

  await page.evaluate(({ slug, token }) => {
    window.history.pushState({}, "", `/FormView?slug=${slug}&applicant_continuation_token=${token}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, { slug: form.slug, token: `${TOKEN}-2` });
  await expect.poll(() => state.verifications.length).toBe(3);
  expect(state.verifications[2]).toEqual({
    form_id: form.id,
    applicant_continuation_token: `${TOKEN}-2`,
  });
  await expect.poll(() => state.orgPrefills.includes(ORG_ID_2)).toBe(true);
  expect(state.orgPrefills).toContain(ORG_ID_2);
  expect(state.unexpectedWrites).toEqual([]);
});

test("bound draft resume preserves answers without putting applicant token in its link", async ({ page }) => {
  const { state, form } = await fixture(page);
  // This represents a pre-feature, unbound draft plus a newly issued secure
  // applicant capability. The draft restores answers but is not authority.
  await page.goto(`/FormView?slug=${form.slug}&draft=${RESUME}&applicant_continuation_token=${TOKEN}`);
  await expect(answerInput(page)).toHaveValue("Preserved answer");
  await page.getByTestId("button-save-draft").click();
  const resumeUrl = await page.getByTestId("input-resume-link").inputValue();
  expect(resumeUrl).toContain(`draft=${RESUME}`);
  expect(resumeUrl).not.toContain("applicant_continuation_token");
  expect(resumeUrl).not.toContain("applicant_continuation=1");
  expect(state.draftSaves[0].applicant_continuation_token).toBe(TOKEN);
  expect(state.draftSaves[0].resume_token).toBe(RESUME);
  expect(state.draftBound).toBe(true);

  await page.goto(resumeUrl);
  await expect(answerInput(page)).toHaveValue("Preserved answer");
  await expect(page.getByTestId("applicant-continuation-error")).toHaveCount(0);
  expect(state.unexpectedWrites).toEqual([]);
});

test("missing and invalid credentials warn before submit", async ({ page }) => {
  const missing = await fixture(page);
  await page.goto(`/FormView?slug=${missing.form.slug}`);
  await expect(page.getByTestId("applicant-continuation-error")).toContainText("fresh secure applicant link");
  await expect(page.getByTestId("button-submit-form")).toBeDisabled();
  expect(missing.state.submissions).toHaveLength(0);

  const invalidPage = await page.context().newPage();
  const invalid = await fixture(invalidPage, { invalidToken: true });
  await invalidPage.goto(`/FormView?slug=${invalid.form.slug}&applicant_continuation_token=invalid`);
  await expect(invalidPage.getByTestId("applicant-continuation-error")).toContainText("invalid or has expired");
  await expect(invalidPage.getByTestId("button-submit-form")).toBeDisabled();
  expect(invalid.state.submissions).toHaveLength(0);
});

test("legacy public application accepts an ordinary organisation link without a token", async ({ page }) => {
  const { state, form } = await fixture(page, { legacyPublicApplication: true });
  await page.goto(`/FormView?slug=${form.slug}&organization_id=${ORG_ID}`);
  await expect(answerInput(page)).toBeVisible();
  await answerInput(page).fill("Ordinary organisation application");
  await expect(page.getByTestId("applicant-continuation-error")).toHaveCount(0);
  await expect(page.getByTestId("button-submit-form")).toBeEnabled();
  await page.getByTestId("button-submit-form").click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].prefill_organization_id).toBe(ORG_ID);
  expect(state.submissions[0].applicant_continuation_token).toBeUndefined();
  expect(state.submissions[0].resume_token).toBeUndefined();
  expect(state.verifications).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  await expect(page.getByText("Success!", { exact: true })).toBeVisible();
  await page.screenshot({ path: "screenshots/legacy-public-application.jpg", type: "jpeg", fullPage: true });
});

for (const credential of ["stored marker", "URL token"]) {
  test(`legacy public application ignores ${credential} for prefill, draft, submission and payment`, async ({ page }) => {
    const { state, form } = await fixture(page, {
      legacyPublicApplication: true,
      membershipPayment: true,
      invalidToken: true,
      boundDraft: true,
    });
    await page.addInitScript(({ key, token }) => {
      window.sessionStorage.setItem(key, token);
    }, { key: `form-applicant-continuation:${form.slug}`, token: "expired-stored-token" });
    const credentials = credential === "stored marker"
      ? "&applicant_continuation=1"
      : "&applicant_continuation_token=expired-url-token";
    await page.goto(`/FormView?slug=${form.slug}&organization_id=${ORG_ID}&draft=${RESUME}${credentials}`);
    await expect(answerInput(page)).toHaveValue("Preserved answer");
    await expect(page.getByTestId("applicant-continuation-error")).toHaveCount(0);
    await expect.poll(() => state.quotes.length).toBeGreaterThan(0);
    expect(state.quotes.at(-1).prefill_organization_id).toBe(ORG_ID);
    expect(state.quotes.at(-1).applicant_continuation_token).toBeUndefined();
    expect(state.quotes.at(-1).resume_token).toBeUndefined();
    await expect.poll(() => new URL(page.url()).searchParams.has("applicant_continuation")).toBe(false);
    expect(new URL(page.url()).searchParams.has("applicant_continuation_token")).toBe(false);
    expect(await page.evaluate(slug =>
      window.sessionStorage.getItem(`form-applicant-continuation:${slug}`), form.slug)).toBeNull();
    await page.getByTestId("button-save-draft").click();
    await expect.poll(() => state.draftSaves.length).toBe(1);
    expect(state.draftSaves[0].applicant_continuation_token).toBeUndefined();
    await page.getByTestId("button-form-payment-stripe-membership-payment").click();
    await expect.poll(() => state.paymentCreates.length).toBe(1);
    expect(state.paymentCreates[0].prefill_organization_id).toBe(ORG_ID);
    expect(state.paymentCreates[0].applicant_continuation_token).toBeNull();
    expect(state.paymentCreates[0].resume_token).toBeNull();
    expect(state.verifications).toEqual([]);
    expect(state.unexpectedWrites).toEqual([]);
  });
}

for (const credential of ["applicant_continuation=1", "applicant_continuation_token=expired-url-token"]) {
  test(`legacy public application submits with ${credential} and no capability`, async ({ page }) => {
    const { state, form } = await fixture(page, { legacyPublicApplication: true, invalidToken: true });
    await page.addInitScript(slug =>
      window.sessionStorage.setItem(`form-applicant-continuation:${slug}`, "expired-stored-token"), form.slug);
    await page.goto(`/FormView?slug=${form.slug}&organization_id=${ORG_ID}&${credential}`);
    await answerInput(page).fill("Existing public link");
    await expect(page.getByTestId("button-submit-form")).toBeEnabled();
    await page.getByTestId("button-submit-form").click();
    await expect.poll(() => state.submissions.length).toBe(1);
    expect(state.submissions[0].prefill_organization_id).toBe(ORG_ID);
    expect(state.submissions[0].applicant_continuation_token).toBeUndefined();
    expect(state.submissions[0].resume_token).toBeUndefined();
    expect(state.verifications).toEqual([]);
  });
}

test("legacy public application carries an ordinary member ID without a token", async ({ page }) => {
  const memberId = "existing-applicant-member";
  const { state, form } = await fixture(page, { legacyPublicApplication: true });
  await page.goto(`/FormView?slug=${form.slug}&member_id=${memberId}`);
  await expect(answerInput(page)).toBeVisible();
  await answerInput(page).fill("Ordinary member application");
  await expect(page.getByTestId("applicant-continuation-error")).toHaveCount(0);
  await expect(page.getByTestId("button-submit-form")).toBeEnabled();
  await page.getByTestId("button-submit-form").click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].prefill_member_id).toBe(memberId);
  expect(state.submissions[0].applicant_continuation_token).toBeUndefined();
  expect(state.submissions[0].resume_token).toBeUndefined();
  expect(state.verifications).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("reference-only form is unaffected by disabled credential query", async ({ page }) => {
  const { state, form } = await fixture(page, { referenceOnly: true });
  await page.goto(`/FormView?slug=${form.slug}`);
  await answerInput(page).fill("Reference only");
  await expect(page.getByTestId("applicant-continuation-error")).toHaveCount(0);
  await expect(page.getByTestId("button-submit-form")).toBeEnabled();
  await page.getByTestId("button-submit-form").click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].applicant_continuation_token).toBeUndefined();
  expect(state.submissions[0].resume_token).toBeUndefined();
  expect(state.unexpectedWrites).toEqual([]);
});

test("validated owner session can request no-token existing-organisation submission", async ({ page }) => {
  const { state, form } = await fixture(page, { authenticatedOwner: true });
  await page.goto(`/FormView?slug=${form.slug}`);
  await answerInput(page).fill("Owner-authorized update");
  await expect(page.getByTestId("applicant-continuation-error")).toHaveCount(0);
  await expect(page.getByTestId("button-submit-form")).toBeEnabled();
  await page.getByTestId("button-submit-form").click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].applicant_continuation_token).toBeUndefined();
  expect(state.submissions[0].resume_token).toBeUndefined();
});

test("fresh applicant credential reaches membership quote and payment create", async ({ page }) => {
  const { state, form } = await fixture(page, { membershipPayment: true });
  await page.goto(`/FormView?slug=${form.slug}&applicant_continuation_token=${TOKEN}`);
  await expect.poll(() => state.quotes.length).toBeGreaterThan(0);
  expect(state.quotes.at(-1).applicant_continuation_token).toBe(TOKEN);
  expect(state.quotes.at(-1).resume_token).toBeUndefined();

  await answerInput(page).fill("Paid continuation");
  await page.getByTestId("button-form-payment-stripe-membership-payment").click();
  await expect.poll(() => state.paymentCreates.length).toBe(1);
  expect(state.paymentCreates[0].applicant_continuation_token).toBe(TOKEN);
  expect(state.paymentCreates[0].resume_token).toBeNull();
});

test("bound resumed credential reaches membership quote and payment create", async ({ page }) => {
  const { state, form } = await fixture(page, {
    membershipPayment: true,
    boundDraft: true,
  });
  await page.goto(`/FormView?slug=${form.slug}&draft=${RESUME}`);
  await expect(answerInput(page)).toHaveValue("Preserved answer");
  await expect.poll(() => state.quotes.some(quote => quote.resume_token === RESUME)).toBe(true);
  const authorizedQuote = state.quotes.findLast(quote => quote.resume_token === RESUME);
  expect(authorizedQuote.applicant_continuation_token).toBeUndefined();

  await page.getByTestId("button-form-payment-stripe-membership-payment").click();
  await expect.poll(() => state.paymentCreates.length).toBe(1);
  expect(state.paymentCreates[0].resume_token).toBe(RESUME);
  expect(state.paymentCreates[0].applicant_continuation_token).toBeNull();
});

for (const order of ["grant before entity", "entity before grant"]) {
  test(`text org:name uniqueness preserves prefilled name and later edits (${order})`, async ({ page }) => {
    const { state, form } = await fixture(page, {
      organisationField: "text",
      holdVerification: order === "entity before grant",
      holdEntity: order === "grant before entity",
    });
    const url = `/FormView?slug=${form.slug}&organization_id=${PREFILL_ORG_ID}&applicant_continuation_token=${TOKEN}`;
    try {
      await page.goto(url);
      if (order === "entity before grant") {
        await expect(orgNameInput(page)).toHaveValue(PREFILL_ORG_NAME);
        state.releaseVerification();
      } else {
        await expect.poll(() => state.verifications.length).toBe(1);
        await expect.poll(() => state.orgPrefills.includes(PREFILL_ORG_ID)).toBe(true);
        state.releaseEntity();
      }
      await expect(orgNameInput(page)).toHaveValue(PREFILL_ORG_NAME);
      await expect(orgHistoryInput(page)).toHaveValue(PREFILL_ORG_CUSTOM);
      await orgNameInput(page).fill("Revised North Harbour Arts");
      await orgHistoryInput(page).fill("Updated supporting answer");
      await expect(orgNameInput(page)).toHaveValue("Revised North Harbour Arts");
      await page.getByTestId("button-submit-form").click();
      await expect.poll(() => state.submissions.length).toBe(1);
      expect(state.submissions[0].submission_data["org-name"]).toBe("Revised North Harbour Arts");
      expect(state.submissions[0].submission_data["org-history"]).toBe("Updated supporting answer");
      expect(state.submissions[0].prefill_organization_id).toBe(PREFILL_ORG_ID);
      expect(state.unexpectedWrites).toEqual([]);
    } finally {
      state.releaseVerification();
      state.releaseEntity();
    }
  });
}

test("custom uniqueness text mapping never receives the continuation organisation ID", async ({ page }) => {
  const { state, form } = await fixture(page, { organisationField: "custom" });
  await page.goto(`/FormView?slug=${form.slug}&applicant_continuation_token=${TOKEN}`);
  await expect(orgNameInput(page)).toHaveValue(PREFILL_ORG_NAME);
  await page.getByTestId("button-submit-form").click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].submission_data["org-name"]).toBe(PREFILL_ORG_NAME);
  expect(state.submissions[0].prefill_organization_id).toBe(PREFILL_ORG_ID);
  expect(state.unexpectedWrites).toEqual([]);
});

test("real organisation dropdown retains its ID while text org:name retains its name", async ({ page }) => {
  const { state, form } = await fixture(page, { organisationField: "dropdown" });
  await page.goto(`/FormView?slug=${form.slug}&applicant_continuation_token=${TOKEN}`);
  await expect(orgNameInput(page)).toHaveValue(PREFILL_ORG_NAME);
  await expect(page.getByTestId("select-organisation-org-selector")).toContainText(PREFILL_ORG_NAME);
  await page.getByTestId("button-submit-form").click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].submission_data["org-name"]).toBe(PREFILL_ORG_NAME);
  expect(state.submissions[0].submission_data["org-selector"]).toBe(PREFILL_ORG_ID);
  expect(state.submissions[0].prefill_organization_id).toBe(PREFILL_ORG_ID);
  expect(state.unexpectedWrites).toEqual([]);
});

test("non-continuation org:name prefill remains editable without a capability", async ({ page }) => {
  const { state, form } = await fixture(page, { organisationField: "text", referenceOnly: true });
  await page.goto(`/FormView?slug=${form.slug}&organization_id=${PREFILL_ORG_ID}`);
  await expect(orgNameInput(page)).toHaveValue(PREFILL_ORG_NAME);
  await orgNameInput(page).fill("Independent Arts");
  await page.getByTestId("button-submit-form").click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].submission_data["org-name"]).toBe("Independent Arts");
  expect(state.submissions[0].prefill_organization_id).toBe(PREFILL_ORG_ID);
  expect(state.submissions[0].applicant_continuation_token).toBeUndefined();
  expect(state.unexpectedWrites).toEqual([]);
});