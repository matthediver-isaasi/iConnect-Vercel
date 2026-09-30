import { test, expect } from "@playwright/test";

// All API traffic is intercepted, including writes. No production recipients or email.
async function fixture(page, baseURL, mode = "normal") {
  const origin = new URL(baseURL).origin;
  const user = { id: "fixture-user", tenant_id: "fixture-tenant", organization_id: "fixture-org", role_id: "fixture-role", email: "tester@example.invalid", first_name: "Test", last_name: "Admin", member_excluded_features: [] };
  const events = ["event", "complex_event"].map(event_type => ({ event_id: event_type, event_type, event_title: `${event_type} conference` }));
  const assignments = event => [
    ...[1, 2].map(n => ({ ...event, id: `${event.event_type}-${n}`, form_id: "shared-survey", survey_name: "Feedback", status: "active", created_date: `2026-01-0${n}`, supported: true })),
    { ...event, id: `${event.event_type}-other`, form_id: "other-survey", survey_name: "Session evaluation", status: "active", created_date: "2026-01-03", supported: true },
    { ...event, id: "unsupported", form_id: "old", survey_name: "Old survey", supported: false, unsupported_reason: "Unverifiable participation" },
  ];
  const state = { lists: [], saves: [], previews: [], unexpectedWrites: [] };
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); URL.parse ??= (value, base) => { try { return new URL(value, base); } catch { return null; } }; });
  await page.context().routeWebSocket("**/*", socket => socket.close());
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== origin) return route.fulfill({ status: 204, body: "" });
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/audience-lists" && ["POST", "PATCH"].includes(method)) {
      const body = request.postDataJSON();
      state.saves.push(body); state.lists = [{ ...body, id: "saved" }]; return json(state.lists[0]);
    }
    if (path === "/api/audience-lists/preview" && method === "POST") {
      state.previews.push(request.postDataJSON()); return json({ success: true, totalCount: 0, recipients: [] });
    }
    if (path === "/api/audience-lists/counts") return json({ counts: { saved: 0 } });
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`); return json({ error: "Blocked unexpected write" }, 599);
    }
    if (path === "/api/auth/me") return json(user);
    if (path === "/api/auth/tenant-user-me") return json({ authenticated: true, user, tenant: { id: user.tenant_id, slug: "fixture" }, tenantId: user.tenant_id, memberId: user.id });
    if (path === "/api/entities/Role/fixture-role") return json({ id: user.role_id, name: "Administrator", excluded_features: [] });
    if (path === "/api/entities/Role") return json([{ id: user.role_id, name: "Administrator", excluded_features: [] }]);
    if (path === "/api/entities/Member/fixture-user") return json(user);
    if (path === "/api/entities/Organization") return json([{ id: user.organization_id, name: "Fixture" }]);
    if (path === "/api/entities/Form") return json([{ id: "ordinary", name: "Registration details", is_event_related: true, is_active: true, related_event_id: "event", form_type: "form" }]);
    if (path === "/api/audience-lists") return json(state.lists);
    if (path === "/api/audience-lists/event-surveys") {
      if (mode === "error") return json({ error: "Survey service unavailable" }, 503);
      if (mode === "empty") return json([]);
      const event = events.find(e => e.event_id === url.searchParams.get("event_id"));
      return json(event ? assignments(event).map(a => mode === "anonymous" && a.supported ? {
        ...a, no_response_supported: false,
        no_response_unsupported_reason: "Public anonymous submissions may lack completion identities; the ledger cannot prove completeness.",
      } : a) : events);
    }
    if (path === "/api/zoho-campaigns/oauth") return json({ connected: false, credentialsConfigured: false });
    if (path.includes("unread-count")) return json({ count: 0 });
    if (path.startsWith("/api/public/")) return json({});
    return json([]);
  });
  return state;
}

async function start(page) {
  await page.goto("/CommunicationsManagement");
  await page.getByTestId("tab-lists").click();
  await page.getByTestId("button-create-list").click();
  await page.getByTestId("input-edit-list-name").fill("Survey audience");
  await page.getByTestId("button-add-list-segment").click();
  await chooseType(page, "Event Survey");
}
async function chooseType(page, type) {
  await page.getByTestId("select-add-list-segment-type").click();
  await page.getByRole("option", { name: type, exact: true }).click();
}

for (const eventType of ["event", "complex_event"]) {
  for (const response of ["yes", "no"]) {
    test(`${eventType}: ${response} survives save, reopen and preview`, async ({ page, baseURL }) => {
      const state = await fixture(page, baseURL);
      await start(page);
      const add = page.getByTestId("button-confirm-add-list-segment");
      await expect(add).toBeDisabled();
      await page.getByLabel("Survey event", { exact: true }).selectOption(`${eventType}:${eventType}`);
      await expect(page.getByLabel("Event survey assignment")).toHaveValue("");
      await expect(page.getByText("Old survey: Unverifiable participation", { exact: true })).toBeVisible();
      await page.getByLabel("Event survey assignment").selectOption(`${eventType}-2`);
      await expect(add).toBeDisabled();
      await page.getByLabel("Survey response").selectOption(response);
      await add.click();
      await page.getByTestId("button-save-edit-list").click();
      await expect(page.getByTestId("button-edit-list-saved")).toBeVisible();
      expect(state.saves[0].target_audiences[0]).toMatchObject({
        type: "event_form", form_id: "shared-survey", survey_assignment_id: `${eventType}-2`,
        event_id: eventType, event_type: eventType, received: response === "yes", survey_name: "Feedback", event_title: `${eventType} conference`,
      });
      await page.getByTestId("button-edit-list-saved").click();
      await expect(page.getByRole("dialog")).toContainText(`${eventType}-2`);
      await expect(page.getByRole("dialog")).toContainText(response === "yes" ? "Responded" : "No response");
      await page.getByTestId("button-cancel-edit-list").click();
      await page.getByTestId("button-preview-list-saved").click();
      await expect.poll(() => state.previews.length).toBe(1);
      expect(state.previews[0]).toEqual({ listId: "saved" });
      expect(state.unexpectedWrites).toEqual([]);
    });
  }
}

for (const eventType of ["event", "complex_event"]) {
  test(`${eventType}: different surveys and reused form assignments preserve independent response criteria`, async ({ page, baseURL }) => {
    const state = await fixture(page, baseURL);
    await start(page);
    const selections = [
      { assignment: `${eventType}-1`, form: "shared-survey", response: "yes", name: "Feedback" },
      { assignment: `${eventType}-other`, form: "other-survey", response: "no", name: "Session evaluation" },
      { assignment: `${eventType}-2`, form: "shared-survey", response: "no", name: "Feedback" },
    ];
    for (const [index, selection] of selections.entries()) {
      if (index) {
        await page.getByTestId("button-add-list-segment").click();
        await chooseType(page, "Event Survey");
      }
      await page.getByLabel("Survey event", { exact: true }).selectOption(`${eventType}:${eventType}`);
      await page.getByLabel("Event survey assignment").selectOption(selection.assignment);
      await page.getByLabel("Survey response").selectOption(selection.response);
      await page.getByTestId("button-confirm-add-list-segment").click();
    }
    await page.getByTestId("button-save-edit-list").click();
    await expect(page.getByTestId("button-edit-list-saved")).toBeVisible();
    const segments = state.saves[0].target_audiences;
    expect(segments).toHaveLength(3);
    selections.forEach((selection, index) => expect(segments[index]).toMatchObject({
      type: "event_form", form_id: selection.form, survey_assignment_id: selection.assignment,
      event_id: eventType, event_type: eventType, survey_name: selection.name,
      received: selection.response === "yes",
    }));
    await page.getByTestId("button-edit-list-saved").click();
    const dialog = page.getByRole("dialog");
    for (const selection of selections) {
      await expect(dialog).toContainText(`${selection.name} [${selection.assignment}] — ${selection.response === "yes" ? "Responded" : "No response"}`);
    }
    await page.screenshot({ path: `/tmp/task4885-${eventType}-reopened.png`, animations: "disabled" });
    await page.getByTestId("button-cancel-edit-list").click();
    await page.getByTestId("button-preview-list-saved").click();
    await expect.poll(() => state.previews.length).toBe(1);
    expect(state.previews[0]).toEqual({ listId: "saved" });
    expect(state.unexpectedWrites).toEqual([]);
  });
}

test("switching event, assignment and segment type clears incompatible choices; ordinary forms remain usable", async ({ page, baseURL }) => {
  const state = await fixture(page, baseURL);
  await start(page);
  const add = page.getByTestId("button-confirm-add-list-segment");
  await page.getByLabel("Survey event", { exact: true }).selectOption("event:event");
  await page.getByLabel("Event survey assignment").selectOption("event-1");
  await page.getByLabel("Survey response").selectOption("yes");
  await page.getByLabel("Event survey assignment").selectOption("event-2");
  await expect(add).toBeDisabled();
  await page.getByLabel("Survey response").selectOption("no");
  await page.getByLabel("Survey event", { exact: true }).selectOption("complex_event:complex_event");
  await expect(page.getByLabel("Event survey assignment")).toHaveValue("");
  await expect(add).toBeDisabled();
  await chooseType(page, "Event Form");
  await page.getByTestId("event-form-result-ordinary").click();
  await expect(add).toBeEnabled();
  await chooseType(page, "Event Survey");
  await expect(page.getByLabel("Survey event", { exact: true })).toHaveValue("");
  await expect(add).toBeDisabled();
  expect(state.unexpectedWrites).toEqual([]);
});

for (const mode of ["empty", "error"]) {
  test(`${mode} event surveys have actionable state and cannot be added`, async ({ page, baseURL }) => {
    await fixture(page, baseURL, mode);
    await start(page);
    await expect(page.getByText(mode === "empty" ? "No events with survey assignments available." : "Survey service unavailable", { exact: mode === "empty" })).toBeVisible();
    await expect(page.getByTestId("button-confirm-add-list-segment")).toBeDisabled();
  });
}

test("enhanced anonymous history permits Responded but disables and explains No response", async ({ page, baseURL }) => {
  const state = await fixture(page, baseURL, "anonymous");
  await start(page);
  await page.getByLabel("Survey event", { exact: true }).selectOption("event:event");
  await page.getByLabel("Event survey assignment").selectOption("event-1");
  const response = page.getByLabel("Survey response");
  await expect(response.locator('option[value="no"]')).toHaveJSProperty("disabled", true);
  await expect(response.locator('option[value="yes"]')).toHaveJSProperty("disabled", false);
  await expect(page.getByText("No response is unavailable: Public anonymous submissions may lack completion identities; the ledger cannot prove completeness.")).toBeVisible();
  await expect(page.getByTestId("button-confirm-add-list-segment")).toBeDisabled();
  await response.selectOption("yes");
  await page.locator("#survey-no-response-reason").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/task4885-anonymous-response-safety.png", animations: "disabled" });
  await page.getByTestId("button-confirm-add-list-segment").click();
  await page.getByTestId("button-save-edit-list").click();
  await expect(page.getByTestId("button-edit-list-saved")).toBeVisible();
  expect(state.saves[0].target_audiences[0]).toMatchObject({
    form_id: "shared-survey", survey_assignment_id: "event-1", received: true,
    event_id: "event", event_type: "event",
  });
  expect(state.unexpectedWrites).toEqual([]);
});