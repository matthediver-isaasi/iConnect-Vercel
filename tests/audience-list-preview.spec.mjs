import { test, expect } from "@playwright/test";

const pagePath = "/CommunicationsManagement";
const populatedListId = "preview-populated-list";
const emptyListId = "preview-empty-list";
const reviewListId = "preview-review-required-list";
const reviewError = "This campaign references an audience list affected by a deleted communication category. Replace every disabled list with a new reviewed list before previewing, saving, scheduling, resuming, or sending.";

const viewer = {
  id: "audience-preview-viewer",
  tenant_id: "audience-preview-tenant",
  organization_id: "audience-preview-organisation",
  role_id: "audience-preview-role",
  email: "audience-preview@example.invalid",
  first_name: "Audience",
  last_name: "Previewer",
  member_excluded_features: [],
};

const audienceLists = [{
  id: populatedListId,
  name: "Twenty-five newsletter recipients",
  target_audiences: [{ type: "role", ids: ["newsletter-role"] }],
  ignore_opt_outs: false,
}, {
  id: emptyListId,
  name: "Empty newsletter audience",
  target_audiences: [],
  ignore_opt_outs: false,
}, {
  id: reviewListId,
  name: "Audience requiring review",
  target_audiences: [{ type: "communication_category", ids: ["deleted-category"] }],
  ignore_opt_outs: false,
  category_review_required: true,
  deleted_category_name: "Deleted newsletter category",
}];

const recipients = Array.from({ length: 25 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  return {
    first_name: "Recipient",
    last_name: number,
    email: `recipient-${number}@example.invalid`,
  };
});

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFixtures(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const state = {
    apiRequests: [],
    previewRequests: [],
    unexpectedWrites: [],
    unexpectedRequests: [],
    blockedExternal: [],
  };

  await page.addInitScript(() => {
    URL.parse ??= (value, base) => {
      try { return new URL(value, base); } catch { return null; }
    };
    localStorage.clear();
    sessionStorage.clear();
  });

  await page.context().routeWebSocket("**/*", socket => {
    state.blockedExternal.push(`WEBSOCKET ${socket.url()}`);
    socket.close();
  });

  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const description = `${method} ${url.origin}${path}${url.search}`;

    if (path.startsWith("/api/")) {
      if (url.origin !== origin) {
        state.unexpectedRequests.push(description);
        return json(route, { error: "Cross-origin API request blocked by fixture" }, 599);
      }
      state.apiRequests.push(`${method} ${path}${url.search}`);

      if (path === "/api/audience-lists/preview" && method === "POST") {
        const body = request.postDataJSON();
        state.previewRequests.push(body);
        if (body?.listId === populatedListId) {
          return json(route, {
            success: true,
            listName: audienceLists[0].name,
            totalCount: recipients.length,
            recipients,
          });
        }
        if (body?.listId === emptyListId) {
          return json(route, {
            success: true,
            listName: audienceLists[1].name,
            totalCount: 0,
            recipients: [],
          });
        }
        if (body?.listId === reviewListId) {
          return json(route, { error: reviewError }, 409);
        }
        state.unexpectedRequests.push(description);
        return json(route, { error: "Unknown fixture audience list" }, 599);
      }

      if (path === "/api/audience-lists/counts" && method === "POST") {
        return json(route, {
          counts: {
            [populatedListId]: 25,
            [emptyListId]: 0,
            [reviewListId]: 0,
          },
        });
      }

      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        state.unexpectedWrites.push(description);
        return json(route, { error: `Unexpected write blocked by fixture: ${description}` }, 599);
      }

      if (path === "/api/auth/me") return json(route, viewer);
      if (path === "/api/auth/tenant-user-me") return json(route, {
        authenticated: true,
        user: viewer,
        tenant: { id: viewer.tenant_id, slug: "audience-preview-fixture" },
        tenantId: viewer.tenant_id,
        memberId: viewer.id,
      });
      if (path === "/api/audience-lists") return json(route, audienceLists);
      if (path === `/api/entities/Role/${viewer.role_id}`) {
        return json(route, { id: viewer.role_id, name: "Administrator", excluded_features: [] });
      }
      if (path === "/api/entities/Role") {
        return json(route, [{ id: viewer.role_id, name: "Administrator", excluded_features: [] }]);
      }
      if (path === `/api/entities/Member/${viewer.id}`) return json(route, viewer);
      if (path === "/api/entities/Organization") {
        return json(route, [{ id: viewer.organization_id, name: "Preview Organisation" }]);
      }
      if (path === "/api/zoho-campaigns/oauth") {
        return json(route, { connected: false, credentialsConfigured: false });
      }
      if (path === "/api/communication/inbox/unread-count") return json(route, { count: 0 });
      if (path === "/api/admin/form-submissions/stats") return json(route, { total: 0, pending: 0 });
      if ([
        "/api/public/favicon-url", "/api/public/portal-branding",
        "/api/public/tenant-branding", "/api/public/ai-help-persona",
        "/api/public/form-consent-message",
      ].includes(path)) return json(route, {});

      // Every API call is fulfilled inside this fixture. Optional read-only
      // datasets used by the surrounding application shell are intentionally empty.
      return json(route, []);
    }

    if (url.origin !== origin) {
      state.blockedExternal.push(description);
      return route.fulfill({ status: 204, body: "" });
    }

    if (
      path === pagePath
      || path.startsWith("/src/")
      || path.startsWith("/@")
      || path.startsWith("/node_modules/")
      || path.startsWith("/assets/")
      || path === "/favicon.ico"
    ) {
      return route.continue();
    }

    state.unexpectedRequests.push(description);
    return route.fulfill({ status: 599, contentType: "text/plain", body: "Unexpected fixture request" });
  });

  return state;
}

test("saved-list eye preview shows totals, paginates 20 rows, handles empty and review-required results", async ({ page, baseURL }) => {
  const state = await installFixtures(page, baseURL);
  try {
    await page.goto(pagePath);
    await page.getByTestId("tab-lists").click();
    await expect(page.getByTestId("text-lists-heading")).toHaveText("Audience Lists");

    await page.getByTestId(`button-preview-list-${populatedListId}`).click();
    const populatedDialog = page.getByRole("dialog", { name: "Twenty-five newsletter recipients", exact: true });
    await expect(populatedDialog.getByTestId("text-preview-list-name"))
      .toHaveText("Twenty-five newsletter recipients");
    await expect(populatedDialog).toContainText("25 total recipients");
    await expect(populatedDialog.getByTestId("table-preview-recipients")).toBeVisible();
    await expect(populatedDialog.locator('[data-testid^="row-preview-recipient-"]')).toHaveCount(20);
    await expect(populatedDialog.getByTestId("text-recipient-email-0"))
      .toHaveText("recipient-01@example.invalid");
    await expect(populatedDialog.getByTestId("preview-pagination")).toContainText("Page 1 of 2");
    await expect(populatedDialog.getByTestId("button-preview-prev")).toBeDisabled();
    await expect(populatedDialog.getByTestId("button-preview-next")).toBeEnabled();

    await populatedDialog.getByTestId("button-preview-next").click();
    await expect(populatedDialog.getByTestId("preview-pagination")).toContainText("Page 2 of 2");
    await expect(populatedDialog.locator('[data-testid^="row-preview-recipient-"]')).toHaveCount(5);
    await expect(populatedDialog.getByText("21", { exact: true })).toBeVisible();
    await expect(populatedDialog.getByTestId("text-recipient-email-0"))
      .toHaveText("recipient-21@example.invalid");
    await expect(populatedDialog.getByTestId("button-preview-next")).toBeDisabled();
    await expect(populatedDialog.getByTestId("button-preview-prev")).toBeEnabled();

    await page.screenshot({
      path: "screenshots/audience-list-preview-pagination.png",
      fullPage: false,
    });

    await populatedDialog.getByTestId("button-preview-prev").click();
    await expect(populatedDialog.getByTestId("preview-pagination")).toContainText("Page 1 of 2");
    await expect(populatedDialog.locator('[data-testid^="row-preview-recipient-"]')).toHaveCount(20);
    await populatedDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(populatedDialog).toHaveCount(0);

    await page.getByTestId(`button-preview-list-${emptyListId}`).click();
    const emptyDialog = page.getByRole("dialog", { name: "Empty newsletter audience", exact: true });
    await expect(emptyDialog.getByTestId("text-preview-list-name")).toHaveText("Empty newsletter audience");
    await expect(emptyDialog).toContainText("0 total recipients");
    await expect(emptyDialog.getByTestId("preview-empty"))
      .toHaveText("No recipients found for this audience list.");
    await expect(emptyDialog.getByTestId("preview-pagination")).toHaveCount(0);
    await emptyDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(emptyDialog).toHaveCount(0);

    await page.getByTestId(`button-preview-list-${reviewListId}`).click();
    await expect(page.getByText(reviewError, { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog").filter({ has: page.getByTestId("text-preview-list-name") })).toHaveCount(0);

    expect(state.previewRequests).toEqual([
      { listId: populatedListId },
      { listId: emptyListId },
      { listId: reviewListId },
    ]);
    expect(state.unexpectedWrites, "Unexpected writes are blocked").toEqual([]);
    expect(state.unexpectedRequests, "Unexpected requests are blocked").toEqual([]);
  } finally {
    expect(state.unexpectedWrites, "Unexpected writes are blocked").toEqual([]);
    expect(state.unexpectedRequests, "Unexpected requests are blocked").toEqual([]);
  }
});