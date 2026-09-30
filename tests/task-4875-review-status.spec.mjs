import { test, expect } from "@playwright/test";

const SUBMISSION_ID = "task-4875-isolated-review";
const TENANT_ID = "task-4875-isolated-tenant";
const member = {
  id: "task-4875-reviewer",
  tenant_id: TENANT_ID,
  role_id: "task-4875-role",
  first_name: "Isolated",
  last_name: "Reviewer",
  email: "reviewer@example.invalid",
  member_excluded_features: [],
};
const form = {
  id: "task-4875-form",
  name: "Isolated stage attention fixture",
  fields: [{ id: "review-field", name: "review_field", label: "Review field", type: "text" }],
  pages: [],
};
const config = {
  id: "task-4875-config",
  form_id: form.id,
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
    { id: "verified", label: "Verified", color: "#3b82f6", order: 1 },
    { id: "authoritative", label: "Authoritative stage", color: "#3b82f6", order: 2 },
  ],
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

for (const scenario of [
  { name: "saved stage attention", status: 409, saved: true, authoritative: "verified", label: "Verified" },
  { name: "saved stage refresh overrides stale response", status: 409, saved: true, authoritative: "authoritative", label: "Authoritative stage" },
  { name: "failed mutation refreshes authoritative status", status: 500, saved: false, authoritative: "new", label: "New" },
  { name: "lost response after commit refreshes authoritative status", status: 500, saved: false, authoritative: "verified", label: "Verified" },
]) {
  test(scenario.name, async ({ page }, testInfo) => {
    let updateCalls = 0;
    let refreshedReads = 0;
    const unexpectedWrites = [];
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));

    // Every API request is fulfilled locally. No authentication, submission
    // transition, webhook, or other write reaches the running backend.
    await page.context().route(/^https?:\/\/[^/]+\/api\//, async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path === "/api/auth/me" && method === "GET") return json(route, {
        ...member,
        sessionRole: {
          status: "ready", member_id: member.id, tenant_id: TENANT_ID, role_id: member.role_id,
          role: { id: member.role_id, tenant_id: TENANT_ID, name: "Fixture reviewer", excluded_features: [] },
        },
      });
      if (path === "/api/auth/tenant-user-me" && method === "GET") {
        return json(route, { user: member, tenant: { id: TENANT_ID, slug: "task-4875-isolated" } });
      }
      if (path === "/api/due-diligence/get-submission" && method === "GET") {
        if (updateCalls) refreshedReads++;
        return json(route, {
          form, config, organization: null,
          submission: {
            id: SUBMISSION_ID,
            form_submission_id: "task-4875-form-submission",
            original_form_values: { "review-field": "Fixture value" },
            reviewed_form_values: {}, field_review_status: {}, field_notes: {},
            static_question_responses: {}, static_question_notes: {}, static_question_not_applicable: {},
            notes: "", due_diligence_score: null, risk_level: null,
            workflow_status: updateCalls ? scenario.authoritative : "new",
            first_edit_triggered: true,
            created_at: "2040-01-02T10:00:00.000Z",
            updated_at: "2040-01-02T10:00:00.000Z",
            form_submission: {
              id: "task-4875-form-submission", form_id: form.id,
              submission_data: { "review-field": "Fixture value" }, organization_id: null,
            },
          },
        });
      }
      if (path === "/api/due-diligence/check-stage-actions" && method === "POST") {
        return json(route, { requires_agent_selection: false, requires_custom_message: false, meeting_actions: [], email_actions: [] });
      }
      if (path === "/api/due-diligence/update-status" && method === "POST") {
        updateCalls++;
        expect(request.postDataJSON()).toMatchObject({ submissionId: SUBMISSION_ID, newStatus: "verified" });
        return json(route, {
          // Deliberately hostile raw error: the review UI must not render it.
          error: "PRIVATE_PROVIDER_PAYLOAD",
          ...(scenario.saved ? {
            code: "DD_STAGE_ACTIONS_REQUIRE_ATTENTION",
            status_persisted: true,
            actions_require_attention: true,
            persisted_status: "verified",
            stage_action_occurrence_id: "task-4875-occurrence",
            diagnostic: { event_id: "older-blocker", status: "requires_attention" },
          } : {}),
        }, scenario.status);
      }
      if (path === "/api/due-diligence/documents/list") return json(route, { documents: [] });
      if (path === "/api/contracts/by-submission") return json(route, { contracts: [] });
      if (path === "/api/public/tenant-branding") return json(route, { success: true, branding: null });
      if (method === "GET") return json(route, []);
      unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: "Unexpected fixture write" }, 500);
    });

    await page.goto(`/ReviewSubmission?id=${SUBMISSION_ID}`);
    const cookieConsent = page.getByRole("dialog", { name: "Cookie consent" });
    if (await cookieConsent.isVisible()) await cookieConsent.getByRole("button", { name: "Decline" }).click();
    await expect(page.getByText(form.name, { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveText("New");
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Verified", exact: true }).click();

    const notice = page.getByTestId("stage-transition-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(scenario.saved
      ? "Stage saved, but action completion needs attention."
      : "The status update could not be confirmed.");
    await expect.poll(() => refreshedReads).toBeGreaterThan(0);
    await expect(page.getByRole("combobox")).toHaveText(scenario.label);
    await expect(page.getByText("PRIVATE_PROVIDER_PAYLOAD", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Status updated successfully", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /retry|replay|recover/i })).toHaveCount(0);
    expect(updateCalls).toBe(1);
    expect(unexpectedWrites).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("review-status.png"), fullPage: true });
  });
}