import { test, expect } from "@playwright/test";

const TENANT = "17b393d1-b8c7-456c-a1ec-628e849c2461";
const MEMBER = {
  id: "alert-fixture-admin", tenant_id: TENANT, role_id: "alert-fixture-role",
  email: "admin@example.invalid", first_name: "Alert", last_name: "Administrator",
  member_excluded_features: [],
};
const FORM = {
  id: "alert-form-one", name: "Feedback alert fixture", slug: "alert-form-one",
  form_type: "survey", is_active: true, layout_type: "standard",
  require_authentication: false, fields: [{ id: "comments", type: "textarea", label: "Comments" }],
  pages: [], visibility_rules: [], prefill_source: "none",
  entity_pipelines: { members: [], organisations: [] },
  structured_actions: { version: 1, actions: [] },
  survey_settings: { status: "draft", response_identity: "anonymous" },
  submission_emails: [],
};

async function fixture(page, { admin = true, allowed = true, dashboard = false, available = true, getFailures = 0, putFailures = 0, revokeFailures = 0, authDelay = 0 } = {}) {
  await page.addInitScript(() => {
    URL.parse ||= (input, base) => { try { return new URL(input, base); } catch { return null; } };
  });
  const role = { id: MEMBER.role_id, tenant_id: TENANT, name: admin ? "Tenant administrator" : "Form owner",
    excluded_features: allowed ? [] : ["forms.form-builder"], is_tenant_admin: admin, is_admin: false };
  const state = {
    forms: [structuredClone(FORM), { ...structuredClone(FORM), id: "alert-form-two", name: "Second form", slug: "alert-form-two" }],
    settings: new Map(), reads: [], writes: [], formSaves: [], revokes: [],
    unexpectedWrites: [], errors: [], getFailures, putFailures, revokeFailures,
    denied: false, revokedSession: false, dashboardOnly: false, authReads: 0, holdRead: null, holdWrite: null,
  };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.context().routeWebSocket("**/*", socket => socket.onMessage(() => {}));
  // Local application code/assets only. No API, auth, database or third-party
  // request is allowed through this browser fixture.
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (url.origin !== "http://127.0.0.1:5000") return route.fulfill({ status: 204, body: "" });
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    const method = request.method();
    if (path === "/api/admin/form-alerts") {
      const formId = url.searchParams.get("form_id");
      if (state.denied) return json({ error: "FormBuilder access required." }, 403);
      expect(request.headers()["x-tenant-id"]).toBe(TENANT);
      if (method === "GET") {
        state.reads.push(formId);
        if (state.holdRead) await state.holdRead;
        if (state.getFailures-- > 0) return json({ error: "Fixture settings unavailable." }, 503);
        return json(state.settings.get(formId) || { enabled: false, recipients: [], expires_in_days: 7, available });
      }
      if (method === "PUT") {
        const body = request.postDataJSON();
        state.writes.push({ formId, body });
        if (state.holdWrite) await state.holdWrite;
        if (state.putFailures-- > 0) return json({ error: "Fixture save failed." }, 503);
        const settings = { ...body, expires_in_days: 7, available };
        state.settings.set(formId, settings);
        return json(settings);
      }
      if (method === "POST") {
        state.revokes.push(request.postDataJSON());
        if (state.revokeFailures-- > 0) return json({ error: "Fixture revoke failed." }, 503);
        return json({ revoked: true });
      }
    }
    if (path.startsWith("/api/entities/Form/") && method === "PATCH") {
      const patch = request.postDataJSON();
      state.formSaves.push(patch);
      const form = state.forms.find(item => item.id === path.split("/").at(-1));
      Object.assign(form, patch);
      return json(form);
    }
    if (path === `/api/entities/Member/${MEMBER.id}` && method === "PATCH") {
      const body = request.postDataJSON();
      if (Object.keys(body).length === 1 && typeof body.last_activity === "string") return json(MEMBER);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json({ error: "Fixture forbids this mutation." }, 599);
    }
    if (path === "/api/auth/me") {
      state.authReads++;
      if (authDelay) await new Promise(resolve => setTimeout(resolve, authDelay));
      return json(state.revokedSession || state.dashboardOnly ? null : MEMBER);
    }
    if (path === "/api/auth/tenant-user-me") return json(dashboard && !state.revokedSession
      ? { authenticated: true, user: MEMBER, tenant: { id: TENANT, slug: "alerts-fixture" } }
      : { authenticated: false });
    if (path === "/api/entities/Member") return json([MEMBER]);
    if (path === `/api/entities/Member/${MEMBER.id}`) return json(MEMBER);
    if (path === "/api/entities/Role") return json([role]);
    if (path === `/api/entities/Role/${role.id}`) return json(role);
    if (path === "/api/entities/Form") return json(state.forms);
    if (path.startsWith("/api/entities/Form/")) return json(state.forms.find(item => item.id === path.split("/").at(-1)));
    if (path === "/api/entities/FormSubmission") return json([{
      id: "alert-submission", form_id: FORM.id, status: "new", created_date: "2026-02-04T12:23:00Z",
      submission_data: { comments: "Synthetic anonymous feedback" },
    }]);
    if (path === "/api/public/tenant-branding") return json({ success: true,
      branding: { name: "Alerts fixture", primaryColor: "#155e75", footerConfig: {} } });
    return json([]);
  });
  return state;
}

async function openAlerts(page, formId = FORM.id) {
  await page.goto(`/FormBuilder${formId ? `?formId=${formId}` : ""}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Save Form", exact: true })).toBeVisible();
  await page.getByTestId("tab-alerts").click();
}

function clean(state) {
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.errors).toEqual([]);
}

test("settings save independently, reopen accurately, and stay isolated per form", async ({ page }) => {
  const state = await fixture(page);
  await openAlerts(page);
  const recipients = page.getByTestId("input-submission-alert-recipients");
  await expect(recipients).toHaveValue("");
  await page.getByTestId("switch-submission-alerts").click();
  await recipients.fill(" First@Example.org ; first@example.org\n Second@Example.org ");
  await page.getByTestId("button-save-submission-alerts").click();
  await expect(recipients).toHaveValue("first@example.org\nsecond@example.org");
  expect(state.writes).toEqual([{ formId: FORM.id, body: {
    enabled: true, recipients: ["first@example.org", "second@example.org"],
  } }]);
  expect(state.formSaves).toEqual([]);
  await openAlerts(page, "alert-form-two");
  await expect(page.getByTestId("switch-submission-alerts")).toHaveAttribute("aria-checked", "false");
  await expect(recipients).toHaveValue("");
  await openAlerts(page);
  await expect(page.getByTestId("switch-submission-alerts")).toHaveAttribute("aria-checked", "true");
  await expect(recipients).toHaveValue("first@example.org\nsecond@example.org");
  await expect(page.getByTestId("form-submission-alerts")).toContainText("seven days");
  await expect(page.getByTestId("form-submission-alerts")).toContainText("Free-text answers");
  await page.getByTestId("switch-submission-alerts").click();
  await page.getByTestId("button-save-submission-alerts").click();
  await expect(page.getByTestId("button-save-submission-alerts")).toBeDisabled();
  await openAlerts(page);
  await expect(page.getByTestId("switch-submission-alerts")).toHaveAttribute("aria-checked", "false");
  await expect(recipients).toHaveValue("first@example.org\nsecond@example.org");
  clean(state);
});

test("recipient validation blocks empty enabled, invalid, and over-limit drafts; twenty addresses save", async ({ page }) => {
  const state = await fixture(page);
  await openAlerts(page);
  await page.getByTestId("switch-submission-alerts").click();
  await page.getByTestId("button-save-submission-alerts").click();
  await expect(page.getByRole("alert")).toContainText("at least one");
  await page.getByTestId("input-submission-alert-recipients").fill("not-an-email");
  await page.getByTestId("button-save-submission-alerts").click();
  await expect(page.getByRole("alert")).toContainText("valid email");
  const addresses = Array.from({ length: 21 }, (_, index) => `admin${index}@example.org`);
  await page.getByTestId("input-submission-alert-recipients").fill(addresses.join("\n"));
  await page.getByTestId("button-save-submission-alerts").click();
  await expect(page.getByRole("alert")).toContainText("up to 20");
  expect(state.writes).toEqual([]);
  await page.getByTestId("input-submission-alert-recipients").fill(addresses.slice(0, 20).join("\n"));
  await page.getByTestId("button-save-submission-alerts").click();
  await expect(page.getByTestId("button-save-submission-alerts")).toBeDisabled();
  expect(state.writes[0].body.recipients).toHaveLength(20);
  clean(state);
});

test("Emails remains separate and form saves contain no private alert settings", async ({ page }) => {
  const state = await fixture(page);
  await openAlerts(page);
  await page.getByTestId("input-submission-alert-recipients").fill("alerts@example.org");
  await page.getByTestId("button-save-submission-alerts").click();
  await expect(page.getByTestId("button-save-submission-alerts")).toBeDisabled();
  await page.getByTestId("tab-emails").click();
  await expect(page.getByTestId("form-submission-alerts")).toHaveCount(0);
  await expect(page.getByText("No emails configured", { exact: true })).toBeVisible();
  await page.getByTestId("button-add-email").click();
  await expect(page.getByText("Email 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save Form", exact: true }).click();
  await expect.poll(() => state.formSaves.length).toBe(1);
  expect(state.formSaves[0].submission_emails).toHaveLength(1);
  expect(state.formSaves[0]).not.toHaveProperty("recipients");
  expect(state.formSaves[0]).not.toHaveProperty("form_alerts");
  expect(state.writes).toHaveLength(1);
  await page.getByTestId("tab-alerts").click();
  await expect(page.getByTestId("input-submission-alert-recipients")).toHaveValue("alerts@example.org");
  clean(state);
});

test("new forms require saving before fetching or changing alerts", async ({ page }) => {
  const state = await fixture(page);
  await openAlerts(page, null);
  await expect(page.getByText("Save this form first", { exact: true })).toBeVisible();
  await expect(page.getByTestId("switch-submission-alerts")).toHaveCount(0);
  expect(state.reads).toEqual([]);
  expect(state.writes).toEqual([]);
  clean(state);
});

test("dashboard bootstrap resolves normally and tenant removal clears private drafts", async ({ page }) => {
  const state = await fixture(page, { dashboard: true });
  await openAlerts(page);
  await expect(page.getByTestId("input-submission-alert-recipients")).toBeVisible();
  await page.getByTestId("input-submission-alert-recipients").fill("private@example.org");
  await page.evaluate(async () => {
    const { setActiveTenantId } = await import("/src/api/base44Client.js");
    setActiveTenantId(null);
  });
  await expect(page.getByTestId("input-submission-alert-recipients")).toHaveCount(0);
  await expect(page.getByTestId("form-submission-alerts")).toContainText("active tenant changed");
  await openAlerts(page);
  await expect(page.getByTestId("input-submission-alert-recipients")).toHaveValue("");
  expect(state.writes).toEqual([]);
  clean(state);
});

test("release-unavailable fixture cannot enable alerts but can save disabled recipients", async ({ page }) => {
  const state = await fixture(page, { available: false });
  await openAlerts(page);
  await expect(page.getByTestId("switch-submission-alerts")).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "not available yet" })).toBeVisible();
  await page.getByTestId("input-submission-alert-recipients").fill("later@example.org");
  await page.getByTestId("button-save-submission-alerts").click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body.enabled).toBe(false);
  clean(state);
});

test("load and save failures offer retry without losing the administrator draft", async ({ page }) => {
  const state = await fixture(page, { getFailures: 1, putFailures: 1 });
  await openAlerts(page);
  await expect(page.getByRole("alert")).toContainText("Fixture settings unavailable");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByTestId("input-submission-alert-recipients").fill("retry@example.org");
  await page.getByTestId("button-save-submission-alerts").click();
  await expect(page.getByRole("alert")).toContainText("Fixture save failed");
  await expect(page.getByTestId("input-submission-alert-recipients")).toHaveValue("retry@example.org");
  await page.getByTestId("button-save-submission-alerts").click();
  await expect(page.getByTestId("button-save-submission-alerts")).toBeDisabled();
  expect(state.writes).toHaveLength(2);
  clean(state);
});

test("tenant administrator revokes with confirmation, retry and exact submission context", async ({ page }) => {
  const state = await fixture(page, { revokeFailures: 1 });
  await page.goto(`/FormSubmissions?form=${FORM.id}`);
  await page.getByTestId("button-preview-submission-alert-submission").click();
  await page.getByTestId("button-revoke-submission-alert").click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.revokes).toEqual([]);
  await page.getByTestId("button-revoke-submission-alert").click();
  await page.getByTestId("button-confirm-revoke-submission-alert").click();
  await expect(page.getByRole("alertdialog")).toContainText("Fixture revoke failed");
  await page.getByTestId("button-confirm-revoke-submission-alert").click();
  await expect(page.getByTestId("button-revoke-submission-alert")).toHaveText("Links revoked");
  await expect(page.getByTestId("button-revoke-submission-alert")).toBeDisabled();
  expect(state.revokes).toEqual(Array.from({ length: 2 }, () => ({
    action: "revoke", form_id: FORM.id, submission_id: "alert-submission",
  })));
  state.revokedSession = true;
  await page.evaluate(() => window.dispatchEvent(new Event("viewer-session-rejected")));
  await expect(page.getByRole("dialog", { name: "Submission Details", exact: true })).toHaveCount(0);
  clean(state);
});

test("authorized portal form owners need no administrator flag for settings or revocation", async ({ page }) => {
  const state = await fixture(page, { admin: false });
  await openAlerts(page);
  await expect(page.getByTestId("input-submission-alert-recipients")).toBeVisible();
  await page.goto(`/FormSubmissions?form=${FORM.id}`);
  await page.getByTestId("button-preview-submission-alert-submission").click();
  await expect(page.getByRole("dialog", { name: "Submission Details", exact: true })).toBeVisible();
  await page.getByTestId("button-revoke-submission-alert").click();
  await page.getByTestId("button-confirm-revoke-submission-alert").click();
  await expect(page.getByTestId("button-revoke-submission-alert")).toHaveText("Links revoked");
  expect(state.revokes).toHaveLength(1);
  clean(state);
});

test("delayed verified portal identity sends no alert request before resolution", async ({ page }) => {
  const state = await fixture(page, { authDelay: 1200 });
  await page.goto(`/FormBuilder?formId=${FORM.id}`, { waitUntil: "domcontentloaded" });
  await expect.poll(() => state.authReads).toBeGreaterThan(0);
  expect(state.reads).toEqual([]);
  await page.getByTestId("tab-alerts").click();
  await expect(page.getByTestId("input-submission-alert-recipients")).toBeVisible();
  clean(state);
});

test("server access denial is an error, not indefinite tenant waiting", async ({ page }) => {
  const state = await fixture(page);
  state.denied = true;
  await openAlerts(page);
  await expect(page.getByTestId("form-submission-alerts")).toContainText("FormBuilder access required");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  clean(state);
});

test("late alert response cannot restore private controls after session revocation", async ({ page }) => {
  const state = await fixture(page);
  let release;
  state.holdRead = new Promise(resolve => { release = resolve; });
  await openAlerts(page);
  await expect.poll(() => state.reads.length).toBe(1);
  state.revokedSession = true;
  await page.evaluate(() => window.dispatchEvent(new Event("viewer-session-rejected")));
  release();
  await expect(page.getByTestId("input-submission-alert-recipients")).toHaveCount(0);
  expect(state.writes).toEqual([]);
  clean(state);
});

test("excluded members never receive alert controls or issue alert requests", async ({ page }) => {
  const state = await fixture(page, { admin: false, allowed: false });
  await page.goto(`/FormSubmissions?form=${FORM.id}`);
  await page.getByTestId("button-preview-submission-alert-submission").click();
  await expect(page.getByRole("dialog", { name: "Submission Details", exact: true })).toBeVisible();
  await expect(page.getByTestId("button-revoke-submission-alert")).toHaveCount(0);
  expect(state.reads).toEqual([]);
  expect(state.revokes).toEqual([]);
  clean(state);
});

test("dashboard-only context preserves unsaved settings and an open submission dialog on tab return", async ({ page, context, request }) => {
  const state = await fixture(page, { dashboard: true });
  state.dashboardOnly = true;
  const source = await (await request.get('/src/hooks/useFormAlerts.js')).text();
  const react = source.match(/"([^"]*\/react\.js\?[^"]*)"/)?.[1];
  expect(react).toBeTruthy();
  const dependency = name => react.replace(/react\.js\?/, `${name}.js?`);
  // A component browser fixture for the dashboard-only branch (no portal member
  // projection). Identity comes from the same intercepted authentication HTTP
  // responses as the app; never seed the active-tenant singleton.
  await page.route("**/dashboard-alert-fixture", route => route.fulfill({
    contentType: "text/html",
    body: `<html><body><div id="fixture"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module">
      import React from '${react}';
      import ReactDOM from '${dependency("react-dom_client")}';
      import { QueryClient, QueryClientProvider } from '${dependency("@tanstack_react-query")}';
      import '/src/index.css';
      import { LayoutProvider, useLayoutContext } from '/src/contexts/LayoutContext.jsx';
      import { installFetchInterceptor } from '/src/lib/fetchInterceptor.js';
      import { useFormAlertTenant } from '/src/hooks/useFormAlerts.js';
      import FormSubmissionAlerts from '/src/components/forms/FormSubmissionAlerts.jsx';
      import RevokeSubmissionAlert from '/src/components/forms/RevokeSubmissionAlert.jsx';
      import { Dialog, DialogContent, DialogTitle } from '/src/components/ui/dialog.jsx';
      const h = React.createElement;
      const client = new QueryClient();
      installFetchInterceptor();
      function Harness() {
        const layout = useLayoutContext();
        const tenant = useFormAlertTenant();
        const [open, setOpen] = React.useState(false);
        React.useEffect(() => {
          Promise.all([
            fetch('/api/auth/tenant-user-me', { credentials: 'include' }).then(r => r.json()),
            fetch('/api/auth/me', { credentials: 'include' }).then(r => r.json()),
          ]).then(([, member]) => {
            if (member !== null) throw new Error('Dashboard fixture must not have a portal member');
            layout.setAuthResolved(true);
          });
        }, []);
        React.useEffect(() => setOpen(false), [tenant.scopeKey]);
        return h(React.Fragment, null,
          h(FormSubmissionAlerts, { formId: '${FORM.id}', tenantId: tenant, canManage: true }),
          h('button', { onClick: () => setOpen(true) }, 'Open submission'),
          h('button', { onClick: () => client.invalidateQueries({ queryKey: ['form-alert-dashboard-session'] }) }, 'Revalidate dashboard'),
          h(Dialog, { open, onOpenChange: setOpen },
            h(DialogContent, null, h(DialogTitle, null, 'Submission Details'),
              h(RevokeSubmissionAlert, { formId: '${FORM.id}', submissionId: 'alert-submission', tenantId: tenant }))));
      }
      ReactDOM.createRoot(document.getElementById('fixture')).render(
        h(QueryClientProvider, { client }, h(LayoutProvider, null, h(Harness))));
    </script></body></html>`,
  }));
  await page.goto("/dashboard-alert-fixture");
  const recipients = page.getByTestId("input-submission-alert-recipients");
  await expect(recipients).toHaveValue("");
  await recipients.fill("unsaved@example.invalid");
  await page.getByTestId("switch-submission-alerts").click();
  // Force an unchanged successful verification too, not just a focus event.
  await page.getByRole("button", { name: "Revalidate dashboard", exact: true }).click();
  await expect(recipients).toHaveValue("unsaved@example.invalid");
  await page.getByRole("button", { name: "Open submission", exact: true }).click();
  const otherTab = await context.newPage();
  await otherTab.bringToFront();
  await page.bringToFront();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("dialog", { name: "Submission Details", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(recipients).toHaveValue("unsaved@example.invalid");
  await expect(page.getByTestId("switch-submission-alerts")).toHaveAttribute("aria-checked", "true");
  expect(state.writes).toEqual([]);
  await otherTab.close();
  clean(state);
});
