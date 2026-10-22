import { expect } from "@playwright/test";

export const endpoint = "/api/article-briefs/publication-import";
export const workbookBytes = Buffer.from("Synthetic XLSX upload bytes: only intercepted preview requests may read this fixture.");
export const resolvedRow = {
  row: 2, title: "Regional careers report", action: "create", errors: [],
  warnings: ["Check the contributor's publication consent."],
  writer: { id: "fixture-writer", name: "Mira Osei", email: "mira@example.invalid" },
  editor: { id: "fixture-editor", name: "Robin Patel", email: "robin@example.invalid" },
  payload: {
    title: "Regional careers report", status: "new", category: "Research",
    assigned_writer_id: "fixture-writer", review_owner_id: "fixture-editor",
    deadline: "2027-08-19", writer_deadline: "2027-08-09", editor_deadline: "2027-08-14",
    sla: "2026-2028", contract: "Prospects", notes: "Include the regional findings.",
    contributor_type: "member", member_job_title: "Careers adviser",
    member_organisation_name: "Northshore University", copyright_required: true,
    case_study_required: false,
  },
};
export const skippedRow = { row: 3, title: "Existing publication", action: "skip", errors: [], warnings: [], payload: { title: "Existing publication" } };

export function previewResponse(planId = "fixture-plan-1", rows = [resolvedRow, skippedRow]) {
  return { sheets: ["Instructions", "Publications"], sheetName: "Publications", rows, planId, canApply: true };
}

export function receipt(rows = [resolvedRow, skippedRow]) {
  return {
    created: rows.filter(row => row.action === "create").length,
    skipped: rows.filter(row => row.action === "skip").length,
    failed: 0, done: true,
    rows: rows.map(row => ({ row: row.row, title: row.title, action: row.action, id: `brief-${row.row}` })),
  };
}

export async function installPublicationFixture(page, { manage = true, multiple = false, rows = [resolvedRow, skippedRow] } = {}) {
  const member = {
    id: "publication-import-member", tenant_id: "publication-import-tenant",
    role_id: "publication-import-role", email: "publication-editor@example.invalid",
    first_name: "Mira", last_name: "Osei", member_excluded_features: [],
    page_tours_seen: { BriefManagement: true },
  };
  const role = {
    id: member.role_id, tenant_id: member.tenant_id, name: "Publication editor",
    excluded_features: manage ? [] : ["content.briefs.manage"],
    show_tours: false,
  };
  const state = {
    previews: [], applies: [], templates: 0, briefReads: 0,
    denied: [], errors: [], applyResponses: [], previewResponses: [],
    gate: null, templateError: false,
  };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.addInitScript(cached => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("agcas_member", JSON.stringify(cached));
  }, member);
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5000").origin;
  // ALL backend/provider traffic is synthetic. Only same-origin source assets
  // reach the dev server; no real auth, upload, entity write or email is used.
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (!path.startsWith("/api/")) return route.continue();
    const json = (body, status = 200) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(body),
      headers: { "Cache-Control": "no-store" },
    });
    if (path === endpoint) {
      if (request.method() === "GET" && url.searchParams.get("action") === "template") {
        state.templates++;
        if (state.templateError) return json({ error: "Fixture download unavailable" }, 503);
        return route.fulfill({
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          headers: { "Content-Disposition": 'attachment; filename="publication-import-template.xlsx"' },
          body: workbookBytes,
        });
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        if (body.action === "preview") {
          state.previews.push(body);
          const response = state.previewResponses.shift();
          if (response) return json(response.body ?? response, response.status || 200);
          if (multiple && !body.sheetName) return json({
            sheets: ["Instructions", "Publications"], sheetName: null,
            needsSheetSelection: true, rows: [], planId: null, canApply: false,
          });
          return json(previewResponse(`fixture-plan-${state.previews.length}`, rows));
        }
        if (body.action === "apply") {
          state.applies.push(body);
          if (state.gate) await state.gate;
          const response = state.applyResponses.shift();
          if (response?.abort) return route.abort("failed");
          if (response) return json(response.body ?? response, response.status || 200);
          return json(receipt(rows));
        }
      }
    }
    if (request.method() === "POST" && path === "/api/members/by-ids") return json([]);
    if (request.method() === "PATCH" && path === `/api/entities/Member/${member.id}` &&
      Object.keys(request.postDataJSON() || {}).every(key => ["last_activity", "last_seen", "page_tours_seen"].includes(key))) return json(member);
    if (request.method() !== "GET") {
      state.denied.push(`${request.method()} ${path}`);
      return json({ error: "Unexpected fixture mutation denied" }, 599);
    }
    if (path === "/api/auth/me") return json({
      ...member,
      sessionRole: {
        status: "ready", member_id: member.id, tenant_id: member.tenant_id,
        role_id: role.id, role,
      },
    });
    if (path === "/api/auth/tenant-user-me") return json({ authenticated: false }, 401);
    if (path === `/api/entities/Member/${member.id}`) return json(member);
    if (path === `/api/entities/Role/${role.id}`) return json(role);
    if (path === "/api/entities/Role") return json([role]);
    if (path === "/api/entities/ArticleBrief") { state.briefReads++; return json([]); }
    if (path === "/api/article-briefs/inbox") return json({ items: [], unread_count: 0 });
    if (path === "/api/article-briefs/settings") return json({ stages: [{ key: "new", label: "New", color: "#64748b" }], categories: ["Research"] });
    if (path === "/api/public/tenant-branding") return json({
      success: true, branding: { id: member.tenant_id, name: "Publication fixture", headerConfig: {}, footerConfig: {} },
    });
    if (path === "/api/public/portal-branding") return json({ tenantName: "Publication fixture" });
    if (path.includes("/unread-count")) return json({ unreadCount: 0 });
    if (path.includes("/page/")) return json({ success: true, page: null });
    return json([]);
  });
  await page.goto("/BriefManagement");
  await expect(page.getByTestId("button-export-briefs")).toBeVisible();
  return state;
}

export async function uploadAndPreview(page, name = "publications.xlsx") {
  await page.getByTestId("button-import-publications").click();
  await uploadWorkbook(page, name);
  await page.getByTestId("button-preview-publication-import").click();
  await expect(page.getByTestId("publication-import-preview")).toBeVisible();
}

export async function uploadWorkbook(page, name = "publications.xlsx", buffer = workbookBytes) {
  await page.getByLabel("Publication workbook").setInputFiles({
    name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer,
  });
  if (/\.xlsx$/i.test(name) && buffer.length && buffer.length <= 1024 * 1024) {
    await expect(page.getByTestId("button-preview-publication-import")).toBeEnabled();
  }
}

export function assertIsolated(state) {
  expect(state.denied).toEqual([]);
  expect(state.errors).toEqual([]);
}
