import { test, expect } from "@playwright/test";

const FORM_ID = "task-4422-address-review-form";
const FORM_SLUG = "task-4422-address-review";
const SUBMISSION_ID = "task-4422-address-review-submission";
const ADDRESS_FIELD_ID = "application-address";
const REVIEWER_ADDRESS_FIELD_ID = "reviewer-address";
const DECISION_FIELD_ID = "decision";
const VALID_POSTCODE = "SW1A 1AA";

const originalAddress = {
  line_1: "12 <Oak> Street",
  line_2: "Flat <West> & Co",
  line_3: "Building 3",
  post_town: "London",
  county: "Greater London",
  postcode: VALID_POSTCODE,
  country: "United Kingdom",
};

const reviewerAddress = {
  line_1: "Reviewer Room",
  post_town: "Bristol",
  postcode: "BS1 1AA",
};

const lookupResult = {
  line_1: "1 Lookup Road",
  line_2: "",
  line_3: "",
  post_town: "London",
  county: "Greater London",
  postcode: VALID_POSTCODE,
  country: "United Kingdom",
};

const adminMember = {
  id: "task-4422-reviewer",
  tenant_id: "task-4422-tenant",
  organization_id: null,
  role_id: "task-4422-admin-role",
  email: "task-4422-reviewer@example.invalid",
  first_name: "Address",
  last_name: "Reviewer",
  member_excluded_features: [],
};

const adminRole = {
  id: adminMember.role_id,
  name: "Administrator",
  excluded_features: [],
};

const addressField = {
  id: ADDRESS_FIELD_ID,
  name: "application_address",
  type: "address_lookup",
  label: "Application address",
  required: true,
};

const reviewerAddressField = {
  id: REVIEWER_ADDRESS_FIELD_ID,
  name: "reviewer_address",
  type: "address_lookup",
  label: "Reviewer address",
  due_diligence: true,
  locked: true,
  required: true,
  visible_components: ["line_1", "post_town", "postcode"],
  required_components: ["line_1", "postcode"],
  component_labels: {
    line_1: "Street address",
    post_town: "Town / city",
    postcode: "Postal code",
  },
};

const decisionField = {
  id: DECISION_FIELD_ID,
  name: "decision",
  type: "text",
  label: "Decision",
  required: false,
};

function formFixture({ reviewerLocked = true } = {}) {
  return {
    id: FORM_ID,
    slug: FORM_SLUG,
    name: "Task 4422 address review fixture",
    description: "Fixture form for Due Diligence address review.",
    fields: [
      addressField,
      { ...reviewerAddressField, locked: reviewerLocked },
      decisionField,
    ],
    pages: [],
    visibility_rules: [],
    layout_type: "standard",
    blank_layout: true,
    form_type: "application",
    require_authentication: false,
    is_active: true,
    submit_button_text: "Submit fixture",
    success_message: "Submitted",
    allow_save_continue_later: false,
    prefill_source: "none",
  };
}

function submissionFixture({
  applicationAddress = originalAddress,
  reviewedFormValues = {
    [REVIEWER_ADDRESS_FIELD_ID]: { ...reviewerAddress },
  },
} = {}) {
  return {
    id: SUBMISSION_ID,
    form_submission_id: "task-4422-form-submission",
    original_form_values: {
      [ADDRESS_FIELD_ID]: { ...applicationAddress },
      [DECISION_FIELD_ID]: "Original decision",
    },
    reviewed_form_values: reviewedFormValues,
    field_review_status: {},
    field_notes: {},
    static_question_responses: {},
    static_question_notes: {},
    static_question_not_applicable: {},
    notes: "",
    workflow_status: "new",
    due_diligence_score: null,
    risk_level: null,
    reviewed_by: null,
    reviewed_date: null,
    history_log: [],
    created_at: "2040-01-02T10:00:00.000Z",
    updated_at: "2040-01-02T10:00:00.000Z",
    form_submission: {
      id: "task-4422-form-submission",
      form_id: FORM_ID,
      submission_data: {
        [ADDRESS_FIELD_ID]: { ...applicationAddress },
        [DECISION_FIELD_ID]: "Original decision",
      },
      status: "submitted",
      created_date: "2040-01-02T10:00:00.000Z",
      organization_id: null,
    },
  };
}

function configFixture() {
  return {
    id: "task-4422-dd-config",
    form_id: FORM_ID,
    default_review_state: "amended",
    scoring_approach: "dynamic",
    scoring_rules: {},
    static_questions: [],
    workflow_stages: [
      {
        id: "new",
        label: "New",
        color: "#f97316",
        is_initial: true,
        order: 0,
      },
    ],
    enforce_stage_sequence: false,
    owner_role_ids: [],
    show_description_fields: false,
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFixtures(page, {
  includePublicForm = false,
  reviewerLocked = true,
  submission = submissionFixture(),
} = {}) {
  const state = {
    form: formFixture({ reviewerLocked }),
    submission,
    config: configFixture(),
    saves: [],
    lookupRequests: [],
    activityUpdates: [],
    apiRequests: [],
    unexpectedWrites: [],
    supabaseWrites: [],
    pageErrors: [],
  };

  page.on("pageerror", error => state.pageErrors.push(error.message));

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

    // Vite source imports can include /src/api/ in their URL. Only real API
    // pathname requests belong to this fixture.
    if (!path.startsWith("/api/")) return route.continue();

    state.apiRequests.push(`${method} ${path}${url.search}`);

    if (path === "/api/auth/me" && method === "GET") return json(route, adminMember);
    if (path === "/api/auth/tenant-user-me" && method === "GET") {
      return json(route, {
        user: adminMember,
        tenant: { id: adminMember.tenant_id, slug: FORM_SLUG },
      });
    }
    if (path === `/api/entities/Role/${adminRole.id}` && method === "GET") return json(route, adminRole);
    if (path === "/api/entities/Role" && method === "GET") return json(route, [adminRole]);
    if (path === `/api/entities/Member/${adminMember.id}` && method === "GET") return json(route, adminMember);
    if (path === `/api/entities/Member/${adminMember.id}` && method === "PATCH") {
      const patch = request.postDataJSON() || {};
      const isExpectedActivityPatch = Object.keys(patch).length === 1
        && typeof patch.last_activity === "string";
      if (!isExpectedActivityPatch) {
        state.unexpectedWrites.push(`${method} ${path} ${JSON.stringify(patch)}`);
        return json(route, { error: "Unexpected member mutation in browser fixture" }, 599);
      }
      state.activityUpdates.push(patch);
      return json(route, { ...adminMember, ...patch });
    }
    if (path === "/api/entities/Member" && method === "GET") return json(route, [adminMember]);
    if (path === "/api/entities/Organization" && method === "GET") return json(route, []);

    if (path === "/api/due-diligence/get-submission" && method === "GET") {
      return json(route, {
        success: true,
        submission: state.submission,
        config: state.config,
        form: state.form,
        organization: null,
      });
    }
    if (path === "/api/due-diligence/save-review" && method === "POST") {
      const body = request.postDataJSON() || {};
      state.saves.push(body);
      state.submission = {
        ...state.submission,
        ...(body.reviewedFormValues !== undefined
          ? { reviewed_form_values: body.reviewedFormValues }
          : {}),
        ...(body.fieldReviewStatus !== undefined
          ? { field_review_status: body.fieldReviewStatus }
          : {}),
        ...(body.fieldNotes !== undefined
          ? { field_notes: body.fieldNotes }
          : {}),
        ...(body.staticQuestionResponses !== undefined
          ? { static_question_responses: body.staticQuestionResponses }
          : {}),
        ...(body.staticQuestionNotes !== undefined
          ? { static_question_notes: body.staticQuestionNotes }
          : {}),
        ...(body.staticQuestionNotApplicable !== undefined
          ? { static_question_not_applicable: body.staticQuestionNotApplicable }
          : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        reviewed_by: adminMember.email,
      };
      return json(route, { success: true, message: "Review saved successfully" });
    }

    if (path === "/api/due-diligence/documents/list" && method === "GET") {
      return json(route, { documents: [] });
    }
    if (path === "/api/contracts/by-submission" && method === "GET") {
      return json(route, { contracts: [] });
    }
    if (path === "/api/dd-meeting-requests/by-submission" && method === "GET") {
      return json(route, { requests: [] });
    }
    if (path === "/api/dd-meeting-requests/configured-by-form" && method === "GET") {
      return json(route, { requests: [] });
    }
    if (path === "/api/public/organisations" && method === "GET") return json(route, []);
    if (path === "/api/public/resource-categories" && method === "GET") return json(route, []);
    if (path === "/api/public/navigation-items" && method === "GET") return json(route, []);
    if (path === "/api/public/microsites" && method === "GET") return json(route, { microsites: [] });
    if (path === "/api/public/tenant-branding" && method === "GET") {
      return json(route, {
        success: true,
        branding: {
          name: "Task 4422 address review fixture",
          primaryColor: "#155e75",
          footerConfig: { backgroundColor: "#102a43", textColor: "#ffffff" },
          footerSource: "standard",
        },
      });
    }
    if (path === "/api/public/form-consent-message" && method === "GET") {
      return json(route, { message: "" });
    }
    if (path === "/api/public/form-submission" && method === "POST") {
      return json(route, { success: true, submission_id: "task-4422-public-submission" });
    }

    if (path === `/api/public/form/${FORM_SLUG}` && method === "GET") {
      return json(route, state.form);
    }
    if (path === "/api/public/address-lookup" && method === "POST") {
      state.lookupRequests.push(request.postDataJSON() || {});
      return json(route, { addresses: [lookupResult] });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: `Unexpected fixture mutation: ${method} ${path}` }, 599);
    }

    // Optional page chrome and admin reads stay local and inert.
    return json(route, []);
  });

  if (includePublicForm) {
    state.publicForm = state.form;
  }

  return state;
}

function testIdLocator(page, testId) {
  return page.getByTestId(testId);
}

function addressComponent(page, fieldId, component) {
  return testIdLocator(page, `input-address-lookup-${fieldId}-${component}`);
}

function reviewField(page, fieldId) {
  return testIdLocator(page, `review-field-${fieldId}`);
}

function originalCell(field) {
  return field.locator("div.grid.grid-cols-2 > div").first();
}

test("public address fields still perform postcode lookup", async ({ page }) => {
  const state = await installFixtures(page, { includePublicForm: true });

  await page.goto(`/FormView?slug=${FORM_SLUG}`);

  const postcode = testIdLocator(page, `input-address-lookup-postcode-${ADDRESS_FIELD_ID}`);
  await expect(postcode).toBeVisible();
  await expect(postcode).toHaveAttribute("role", "combobox");
  await postcode.fill(VALID_POSTCODE);

  await expect.poll(() => state.lookupRequests.length).toBe(1);
  expect(state.lookupRequests[0]).toEqual(expect.objectContaining({
    postcode: VALID_POSTCODE,
    form_id: FORM_ID,
    form_slug: FORM_SLUG,
    field_id: ADDRESS_FIELD_ID,
  }));
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("option")).toContainText("1 Lookup Road");

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("review addresses render ordered escaped originals, prefill amendments, and never look up", async ({ page }, testInfo) => {
  const state = await installFixtures(page);

  await page.goto(`/ReviewSubmission?id=${SUBMISSION_ID}`);

  const field = reviewField(page, ADDRESS_FIELD_ID);
  await expect(field).toBeVisible();

  const original = originalCell(field);
  const originalText = await original.textContent();
  expect(originalText).toBe(Object.values(originalAddress).join("\n"));
  expect(originalText.indexOf(originalAddress.line_1)).toBeLessThan(originalText.indexOf(originalAddress.line_2));
  expect(originalText.indexOf(originalAddress.line_2)).toBeLessThan(originalText.indexOf(originalAddress.line_3));
  expect(originalText.indexOf(originalAddress.line_3)).toBeLessThan(originalText.indexOf(originalAddress.post_town));
  expect(originalText.indexOf(originalAddress.post_town)).toBeLessThan(originalText.indexOf(originalAddress.county));
  expect(originalText.indexOf(originalAddress.county)).toBeLessThan(originalText.indexOf(originalAddress.postcode));
  expect(originalText.indexOf(originalAddress.postcode)).toBeLessThan(originalText.indexOf(originalAddress.country));
  // React must render address values as text, not interpret submitted markup.
  await expect(original.locator("script, style, iframe")).toHaveCount(0);
  expect(originalText).toContain("<Oak>");
  expect(originalText).toContain("& Co");

  await expect(field.getByTestId(`input-address-lookup-${ADDRESS_FIELD_ID}-line_1`)).toHaveValue(originalAddress.line_1);
  await expect(field.getByTestId(`input-address-lookup-${ADDRESS_FIELD_ID}-line_2`)).toHaveValue(originalAddress.line_2);
  await expect(field.getByTestId(`input-address-lookup-${ADDRESS_FIELD_ID}-line_3`)).toHaveValue(originalAddress.line_3);
  await expect(field.getByTestId(`input-address-lookup-${ADDRESS_FIELD_ID}-postcode`)).toHaveValue(VALID_POSTCODE);
  await expect(field.locator('[role="combobox"]')).toHaveCount(0);

  const baselineLookupRequests = state.lookupRequests.length;
  await field.getByTestId(`input-address-lookup-${ADDRESS_FIELD_ID}-postcode`).fill(VALID_POSTCODE);
  await page.waitForTimeout(250);
  expect(state.lookupRequests).toHaveLength(baselineLookupRequests);
  await expect.poll(() => state.activityUpdates.length).toBeGreaterThan(0);
  await page.screenshot({
    path: testInfo.outputPath("task-4422-review-addresses-fixture.png"),
    fullPage: true,
  });

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("review saves structured address clearing and notes, reloads, then approves without changing original", async ({ page }) => {
  const state = await installFixtures(page);

  await page.goto(`/ReviewSubmission?id=${SUBMISSION_ID}`);

  const field = reviewField(page, ADDRESS_FIELD_ID);
  const line1 = addressComponent(page, ADDRESS_FIELD_ID, "line_1");
  const line2 = addressComponent(page, ADDRESS_FIELD_ID, "line_2");
  await expect(line1).toHaveValue(originalAddress.line_1);
  await expect(line2).toHaveValue(originalAddress.line_2);

  await line1.fill("44 Amended Road");
  await line2.fill("");
  await testIdLocator(page, `button-toggle-note-${ADDRESS_FIELD_ID}`).click();
  await testIdLocator(page, `textarea-note-${ADDRESS_FIELD_ID}`).fill("Address checked.");
  await testIdLocator(page, "button-toggle-notes").click();
  await testIdLocator(page, "textarea-notes").fill("Approved after address review.");
  await testIdLocator(page, "button-save").click();

  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0].reviewedFormValues[ADDRESS_FIELD_ID]).toEqual({
    ...originalAddress,
    line_1: "44 Amended Road",
    line_2: "",
  });
  expect(state.saves[0].fieldNotes[ADDRESS_FIELD_ID]).toBe("Address checked.");
  expect(state.saves[0].notes).toBe("Approved after address review.");
  expect(state.submission.original_form_values[ADDRESS_FIELD_ID]).toEqual(originalAddress);

  await page.reload();
  const reloadedField = reviewField(page, ADDRESS_FIELD_ID);
  await expect(addressComponent(page, ADDRESS_FIELD_ID, "line_1")).toHaveValue("44 Amended Road");
  // An explicitly cleared optional component must not fall back to the original.
  await expect(addressComponent(page, ADDRESS_FIELD_ID, "line_2")).toHaveValue("");
  await expect(reloadedField.getByTestId(`input-address-lookup-${ADDRESS_FIELD_ID}-postcode`)).toHaveValue(VALID_POSTCODE);
  await expect(originalCell(reloadedField)).toContainText(originalAddress.line_2);

  await testIdLocator(page, `toggle-status-${ADDRESS_FIELD_ID}`).click();
  await expect(testIdLocator(page, `toggle-status-${ADDRESS_FIELD_ID}`)).toHaveAttribute("aria-checked", "false");
  await testIdLocator(page, "button-save").click();

  await expect.poll(() => state.saves.length).toBe(2);
  expect(state.saves[1].fieldReviewStatus[ADDRESS_FIELD_ID]).toBe("approved");
  expect(state.saves[1].reviewedFormValues[ADDRESS_FIELD_ID]).toBeUndefined();
  expect(state.saves[1].fieldNotes[ADDRESS_FIELD_ID]).toBe("Address checked.");
  expect(state.saves[1].notes).toBe("Approved after address review.");
  expect(state.submission.original_form_values[ADDRESS_FIELD_ID]).toEqual(originalAddress);

  await page.reload();
  const approvedField = reviewField(page, ADDRESS_FIELD_ID);
  await expect(approvedField).toContainText("Approved as original");
  await expect(originalCell(approvedField)).toContainText(originalAddress.line_1);
  await expect(originalCell(approvedField)).toContainText(originalAddress.line_2);
  await expect(testIdLocator(page, "button-toggle-notes")).toBeVisible();

  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("reviewer-only address honours manual component configuration and locked inputs", async ({ page }) => {
  const state = await installFixtures(page);

  await page.goto(`/ReviewSubmission?id=${SUBMISSION_ID}`);

  const field = testIdLocator(page, `review-field-dd-${REVIEWER_ADDRESS_FIELD_ID}`);
  await expect(field).toBeVisible();
  await expect(field).toContainText("Due Diligence Only");
  await expect(field.locator('[role="combobox"]')).toHaveCount(0);
  await expect(field.locator(`input[data-testid="input-address-lookup-${REVIEWER_ADDRESS_FIELD_ID}-line_1"]`)).toHaveValue(reviewerAddress.line_1);
  await expect(field.locator(`input[data-testid="input-address-lookup-${REVIEWER_ADDRESS_FIELD_ID}-post_town"]`)).toHaveValue(reviewerAddress.post_town);
  await expect(field.locator(`input[data-testid="input-address-lookup-${REVIEWER_ADDRESS_FIELD_ID}-postcode"]`)).toHaveValue(reviewerAddress.postcode);

  const visibleComponents = ["line_1", "post_town", "postcode"];
  for (const component of visibleComponents) {
    const input = addressComponent(page, REVIEWER_ADDRESS_FIELD_ID, component);
    await expect(input).toBeVisible();
    await expect(input).toBeDisabled();
  }
  for (const hiddenComponent of ["line_2", "line_3", "county", "country"]) {
    await expect(addressComponent(page, REVIEWER_ADDRESS_FIELD_ID, hiddenComponent)).toHaveCount(0);
  }

  await expect(field.getByText("Street address*", { exact: true })).toBeVisible();
  await expect(field.getByText("Town / city", { exact: true })).toBeVisible();
  await expect(field.getByText("Postal code*", { exact: true })).toBeVisible();
  await expect(addressComponent(page, REVIEWER_ADDRESS_FIELD_ID, "line_1")).toHaveAttribute("required", "");
  await expect(addressComponent(page, REVIEWER_ADDRESS_FIELD_ID, "postcode")).toHaveAttribute("required", "");
  await expect(addressComponent(page, REVIEWER_ADDRESS_FIELD_ID, "post_town")).not.toHaveAttribute("required");

  expect(state.lookupRequests).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("partial original address values stay ordered and prefill only the supplied components", async ({ page }) => {
  const partialAddress = {
    line_1: "Only supplied line",
    postcode: VALID_POSTCODE,
  };
  const state = await installFixtures(page, {
    submission: submissionFixture({
      applicationAddress: partialAddress,
      reviewedFormValues: {},
    }),
  });

  await page.goto(`/ReviewSubmission?id=${SUBMISSION_ID}`);

  const field = reviewField(page, ADDRESS_FIELD_ID);
  await expect(field).toBeVisible();
  await expect(originalCell(field)).toHaveText("Only supplied line SW1A 1AA");
  await expect(addressComponent(page, ADDRESS_FIELD_ID, "line_1")).toHaveValue(partialAddress.line_1);
  await expect(addressComponent(page, ADDRESS_FIELD_ID, "postcode")).toHaveValue(partialAddress.postcode);
  for (const component of ["line_2", "line_3", "post_town", "county", "country"]) {
    await expect(addressComponent(page, ADDRESS_FIELD_ID, component)).toHaveValue("");
  }
  await expect(field.locator('[role="combobox"]')).toHaveCount(0);
  expect(state.lookupRequests).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("empty original address values remain empty in the manual amendment editor", async ({ page }) => {
  const state = await installFixtures(page, {
    submission: submissionFixture({
      applicationAddress: {},
      reviewedFormValues: {},
    }),
  });

  await page.goto(`/ReviewSubmission?id=${SUBMISSION_ID}`);

  const field = reviewField(page, ADDRESS_FIELD_ID);
  await expect(field).toBeVisible();
  await expect(originalCell(field)).toContainText("No value");
  for (const component of ["line_1", "line_2", "line_3", "post_town", "county", "postcode", "country"]) {
    await expect(addressComponent(page, ADDRESS_FIELD_ID, component)).toHaveValue("");
  }
  await expect(field.locator('[role="combobox"]')).toHaveCount(0);
  expect(state.lookupRequests).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("reviewer-only address can be edited and saved when the form field is not locked", async ({ page }) => {
  const state = await installFixtures(page, { reviewerLocked: false });

  await page.goto(`/ReviewSubmission?id=${SUBMISSION_ID}`);

  const field = testIdLocator(page, `review-field-dd-${REVIEWER_ADDRESS_FIELD_ID}`);
  const line1 = addressComponent(page, REVIEWER_ADDRESS_FIELD_ID, "line_1");
  const postcode = addressComponent(page, REVIEWER_ADDRESS_FIELD_ID, "postcode");
  await expect(field).toBeVisible();
  await expect(line1).toBeEnabled();
  await line1.fill("Edited reviewer room");
  await postcode.fill("BS1 2AA");
  await testIdLocator(page, "button-save").click();

  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0].reviewedFormValues[REVIEWER_ADDRESS_FIELD_ID]).toEqual({
    ...reviewerAddress,
    line_2: "",
    line_3: "",
    county: "",
    country: "",
    line_1: "Edited reviewer room",
    postcode: "BS1 2AA",
  });
  expect(state.submission.original_form_values[REVIEWER_ADDRESS_FIELD_ID]).toBeUndefined();
  expect(state.lookupRequests).toEqual([]);

  await page.reload();
  await expect(addressComponent(page, REVIEWER_ADDRESS_FIELD_ID, "line_1")).toHaveValue("Edited reviewer room");
  await expect(addressComponent(page, REVIEWER_ADDRESS_FIELD_ID, "postcode")).toHaveValue("BS1 2AA");
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.supabaseWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});