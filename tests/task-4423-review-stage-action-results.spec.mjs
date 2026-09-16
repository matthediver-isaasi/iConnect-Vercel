import { test, expect } from "@playwright/test";

const SUBMISSION_ID = "task-4423-review-results-submission";
const FORM_ID = "task-4423-review-results-form";
const TENANT_ID = "task-4423-review-results-tenant";
const adminMember = {
  id: "task-4423-review-results-admin",
  tenant_id: TENANT_ID,
  organization_id: null,
  role_id: "task-4423-review-results-admin-role",
  email: "task-4423-review-results-admin@example.invalid",
  first_name: "Review",
  last_name: "Tester",
  member_excluded_features: [],
};

const form = {
  id: FORM_ID,
  name: "Linked member result fixture",
  fields: [{
    id: "review-field",
    name: "review_field",
    label: "Review field",
    type: "text",
    required: false,
  }],
  pages: [],
};

const config = {
  id: "task-4423-review-results-config",
  form_id: FORM_ID,
  scoring_approach: "dynamic",
  default_review_state: "amended",
  scoring_rules: { rules: [], risk_thresholds: {} },
  static_questions: [],
  custom_risk_levels: [],
  status_change_webhooks: [],
  owner_role_ids: [],
  enforce_stage_sequence: false,
  workflow_stages: [
    { id: "new", label: "New", color: "#f97316", is_initial: true, order: 0 },
    { id: "verified", label: "Verified", color: "#3b82f6", is_initial: false, order: 1 },
  ],
};

const submission = {
  id: SUBMISSION_ID,
  form_submission_id: "task-4423-review-results-form-submission",
  original_form_values: { "review-field": "Original value" },
  reviewed_form_values: {},
  field_review_status: {},
  field_notes: {},
  static_question_responses: {},
  static_question_notes: {},
  static_question_not_applicable: {},
  notes: "",
  workflow_status: "new",
  due_diligence_score: null,
  risk_level: null,
  first_edit_triggered: true,
  created_at: "2040-01-02T10:00:00.000Z",
  updated_at: "2040-01-02T10:00:00.000Z",
  form_submission: {
    id: "task-4423-review-results-form-submission",
    form_id: FORM_ID,
    submission_data: { "review-field": "Original value" },
    organization_id: null,
  },
};

const memberMappingResult = {
  action: "field_mapping",
  target_entity: "member",
  field_mapping_action_id: "task-4423-invalid-member-mapping",
  status: "error",
  error: { message: "Member field mapping was rejected" },
  validation_errors: [{
    field: "job_title",
    message: "Source field is not on this form",
  }],
  mappings: [{
    field: "job_title",
    status: "error",
    error: { reason: "Invalid source field" },
  }],
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

test("mounted review transition shows structured member mapping validation details without crashing", async ({ page }, testInfo) => {
  const pageErrors = [];
  let updateStatusCalls = 0;
  page.on("pageerror", error => pageErrors.push(error.message));

  // Anchor the route after the host: a broad **/api/** glob also matches the
  // frontend module path /src/api/base44Client.js and turns it into JSON.
  await page.context().route(/^https?:\/\/[^/]+\/api\//, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/auth/me" && method === "GET") return json(route, adminMember);
    if (path === "/api/auth/tenant-user-me" && method === "GET") {
      return json(route, { user: adminMember, tenant: { id: TENANT_ID, slug: "task-4423-review-results" } });
    }
    if (path === `/api/due-diligence/get-submission` && method === "GET") {
      return json(route, { submission, config, form, organization: null });
    }
    if (path === "/api/due-diligence/documents/list" && method === "GET") return json(route, { documents: [] });
    if (path === "/api/contracts/by-submission" && method === "GET") return json(route, { contracts: [] });
    if (path === "/api/public/organisations" && method === "GET") return json(route, []);
    if (path === "/api/due-diligence/check-stage-actions" && method === "POST") {
      return json(route, {
        requires_agent_selection: false,
        requires_custom_message: false,
        meeting_actions: [],
        email_actions: [],
      });
    }
    if (path === "/api/due-diligence/update-status" && method === "POST") {
      updateStatusCalls += 1;
      return json(route, {
        success: true,
        previous_status: "new",
        new_status: "verified",
        stage_actions_results: [memberMappingResult],
        webhooks_triggered: [],
      });
    }
    if (path === "/api/due-diligence/save-review" && method === "POST") {
      return json(route, {
        success: true,
        message: "Review saved successfully",
        first_edit_transition: {
          triggered: true,
          previous_status: "new",
          new_status: "verified",
          stage_label: "Verified",
          stage_actions_results: [memberMappingResult],
        },
      });
    }
    if (path === "/api/due-diligence/members-by-roles" && method === "GET") return json(route, { members: [] });
    if (path === "/api/public/tenant-branding" && method === "GET") return json(route, { success: true, branding: null });
    if (method === "GET") return json(route, []);
    return json(route, { error: `Unexpected fixture request: ${method} ${path}` }, 500);
  });

  await page.goto(`/ReviewSubmission?id=${SUBMISSION_ID}`);
  await expect(page.getByText("Linked member result fixture", { exact: true })).toBeVisible();
  // Radix attaches the test id to its composite root rather than the
  // trigger in the mounted build; the status control is the page combobox.
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Verified", exact: true }).click();

  await expect(page.getByTestId("dialog-stage-action-results")).toBeVisible();
  await expect(page.getByText("Member Field Update Warning", { exact: true })).toBeVisible();
  await expect(page.getByTestId("text-member-mapping-error-0")).toHaveText("Member field mapping was rejected");
  await expect(page.getByTestId("list-member-mapping-validation-0")).toContainText(
    "job_title: Source field is not on this form",
  );
  await expect(page.getByTestId("text-member-mapping-detail-0-0")).toContainText(
    "job_title: Invalid source field",
  );
  expect(updateStatusCalls).toBe(1);

  // The first-edit auto-transition returned by save-review uses the same
  // action result payload and must reopen the warning dialog as well.
  await page.getByTestId("button-close-action-results").click();
  await page.getByTestId("toggle-status-review-field").click();
  await page.getByTestId("button-save").click();
  await expect(page.getByTestId("dialog-stage-action-results")).toBeVisible();
  await expect(page.getByTestId("list-member-mapping-validation-0")).toContainText(
    "job_title: Source field is not on this form",
  );
  await page.screenshot({
    path: testInfo.outputPath("task-4423-review-stage-action-results.png"),
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});