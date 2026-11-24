import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const ORIGIN = "http://127.0.0.1:5000";
const role = { id: "badge-role", tenant_id: "badge-tenant", name: "Member", excluded_features: [] };
const member = {
  id: "badge-member", tenant_id: role.tenant_id, role_id: role.id,
  first_name: "Badge", last_name: "Fixture", email: "badge@example.invalid",
  sessionExpiry: "2099-01-01T00:00:00Z",
  sessionRole: { status: "ready", member_id: "badge-member", tenant_id: role.tenant_id, role_id: role.id, session_key: "badge-fixture", role },
};
const events = [
  { event_type: "event", event_id: "simple", event_name: "Simple event", event_start_date: "2026-04-01T23:30:00Z", event_timezone: "Europe/London" },
  { event_type: "complex_event", event_id: "complex", event_name: "Complex event", event_start_date: "2026-05-01" },
  { event_type: "event", event_id: "training", event_name: "Training event with a long name that should wrap on narrow screens", event_start_date: "2026-06-01" },
  { event_type: "event", event_id: "gone", event_name: null, event_start_date: null },
];
const badge = { id: "speaker", name: "Speaker credential", image_url: "/fixture-badge.svg", awarded_at: "2026-01-02T12:00:00Z", speaker_events: events };
const groupOnly = { id: "group-only", name: "Group-only credential", image_url: "/fixture-badge.svg" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function aboutMeFixture(page) {
  const unexpected = [];
  await page.addInitScript(member => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem("agcas_member", JSON.stringify(member));
  }, member);
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    if (url.origin === ORIGIN && p === "/fixture-badge.svg") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="45" fill="gold"/></svg>' });
    if (url.origin === ORIGIN && !p.startsWith("/api/")) return route.continue();
    if (url.hostname.endsWith(".supabase.co") && p.startsWith("/rest/v1/") && request.method() === "GET") {
      const table = p.split("/").at(-1);
      if (table === "member_group_assignment") return json(route, [{ id: "a", group_id: "g", group_role: "Speaker" }, { id: "b", group_id: "g", group_role: "Member" }]);
      if (table === "member_group") return json(route, [{ id: "g", name: "Fixture group", role_badge_ids: { Speaker: badge.id, Member: groupOnly.id } }]);
      if (table === "badge") return json(route, [{ id: badge.id, name: badge.name, image_url: badge.image_url }, groupOnly]);
      return json(route, []);
    }
    if (url.origin === ORIGIN && p.startsWith("/api/")) {
      if (request.method() === "PATCH" && p === `/api/entities/Member/${member.id}` && Object.keys(request.postDataJSON() || {}).join() === "last_activity") return json(route, member);
      if (request.method() !== "GET") { unexpected.push(`${request.method()} ${p}`); return json(route, { error: "Blocked fixture mutation" }, 599); }
      if (p === "/api/auth/me") return json(route, member);
      if (p === "/api/auth/tenant-user-me") return json(route, { authenticated: false }, 401);
      if (p === `/api/entities/Role/${role.id}`) return json(route, role);
      if (p === "/api/entities/Role") return json(route, [role]);
      if (p === "/api/entities/Member") return json(route, [member]);
      if (p === "/api/my-member-field-permissions") return json(route, {});
      if (p === "/api/member/communication-preferences") return json(route, { categories: [], preferences: [] });
      if (p === "/api/public/tenant-branding") return json(route, { success: true, branding: { id: role.tenant_id, name: "Badge fixture", headerConfig: {}, footerConfig: {} } });
      if (p === "/api/public/portal-branding") return json(route, { tenantName: "Badge fixture" });
      if (p === "/api/communication/inbox/unread-count") return json(route, { unreadCount: 0 });
      if (p === "/api/custom-objects") return json(route, { objects: [], total: 0 });
      if (p === "/api/my-badges") return json(route, { badges: [badge, { id: "manual", name: "Manual credential", image_url: badge.image_url, awarded_at: badge.awarded_at, speaker_events: [] }] });
      if (p === "/api/member-affiliations") return json(route, { active: false });
      return json(route, []);
    }
    // All provider traffic is intercepted, including image/font loads.
    if (!["GET", "HEAD"].includes(request.method())) unexpected.push(`${request.method()} ${url.origin}${p}`);
    return route.abort("blockedbyclient");
  });
  await page.goto("/about-me");
  return unexpected;
}

async function assertEvents(card) {
  await expect(card).toContainText("Event: Simple event");
  await expect(card).toContainText("Event start date: 2 Apr 2026");
  await expect(card).toContainText("Event start date: 1 May 2026");
  await expect(card).toContainText("Event start date: 1 Jun 2026");
  await expect(card).toContainText("Event no longer available");
  await expect(card).toContainText("Event start date: Unavailable");
  await expect(card).toContainText("Awarded date:");
  await expect(card).toContainText(/2 Jan 2026|Jan 2, 2026/);
}

for (const width of [1280, 375]) {
  test(`About Me preserves one credential, group badges and downloads at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const unexpected = await aboutMeFixture(page);
    const card = page.getByTestId("group-role-badge-speaker");
    await expect(card).toBeVisible();
    await assertEvents(card);
    await expect(card.locator("img")).toHaveCount(1);
    await expect(page.getByTestId("group-role-badge-group-only")).toContainText("Group-only credential");
    await expect(page.getByTestId("group-role-badge-manual")).not.toContainText("Event start date");
    await page.evaluate(() => {
      window.__badgeDownloads = [];
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        window.__badgeDownloads.push({ href: this.getAttribute("href"), download: this.download });
        // Intercept only the browser navigation, preserving the real handler.
        if (!this.download) click.call(this);
      };
    });
    await page.getByTestId("download-group-role-badge-speaker").click();
    expect(await page.evaluate(() => window.__badgeDownloads)).toEqual([{ href: badge.image_url, download: "speaker-credential-badge.png" }]);
    const box = await card.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(unexpected).toEqual([]);
    await card.screenshot({ path: `generated-artifacts/speaker-badge-events/about-me-${width}.png` });
  });
}

let staffScript, staffCss;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import React from "react"; import {createRoot} from "react-dom/client";
        import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
        import MemberBadgesTab from "./client/src/components/MemberBadgesTab.jsx";
        const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
        createRoot(document.getElementById("root")).render(<QueryClientProvider client={client}><MemberBadgesTab memberId="badge-member"/></QueryClientProvider>);`,
      resolveDir: process.cwd(), loader: "jsx",
    },
    bundle: true, write: false, jsx: "automatic",
    alias: { "@": path.resolve("client/src") },
    define: { "process.env.NODE_ENV": '"test"' },
  });
  staffScript = result.outputFiles[0].text;
  staffCss = (await postcss([tailwindcss({
    content: ["client/src/components/{MemberBadgesTab,BadgeEventDetails}.jsx", "client/src/components/ui/*.jsx"],
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
});

for (const width of [1280, 375]) {
  test(`staff history preserves attribution, revoked context and award/revoke controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const writes = [];
    let awards = [
      { id: "active", badge, awarded_at: badge.awarded_at, awarded_by_label: "Speaker awards automation", status: "active", speaker_events: events },
      { id: "revoked", badge: { ...badge, name: "Earlier credential" }, awarded_at: badge.awarded_at, awarded_by_label: "Original staff", revoked_at: "2026-02-01T12:00:00Z", revoked_by_label: "Revoking staff", status: "revoked", speaker_events: events },
    ];
    await page.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === "/staff-fixture") return route.fulfill({ contentType: "text/html", body: '<div id="root" style="padding:16px"></div>' });
      if (url.pathname === "/fixture-badge.svg") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
      if (url.pathname !== "/api/admin/members/badge-member/badges") throw new Error(`Unexpected fixture request ${url.pathname}`);
      if (req.method() !== "GET") {
        writes.push({ method: req.method(), body: req.postDataJSON() });
        if (req.method() === "DELETE") awards = awards.map(a => a.id === req.postDataJSON().assignmentId ? { ...a, status: "revoked" } : a);
        else if (req.method() === "POST") awards.push({ id: "manual", badge: { name: "Manual credential" }, status: "active", awarded_at: badge.awarded_at, awarded_by_label: "Fixture staff" });
      }
      return json(route, { awards, availableBadges: [{ id: "manual-badge", name: "Manual credential" }], canManage: true });
    });
    await page.goto(`${ORIGIN}/staff-fixture`);
    await page.addStyleTag({ content: staffCss });
    await page.addScriptTag({ content: staffScript });
    const active = page.getByTestId("member-badge-active");
    await assertEvents(active);
    await expect(active).toContainText("Speaker awards automation");
    await expect(active.locator("img")).toHaveCount(1);
    const revoked = page.getByTestId("member-badge-revoked");
    await assertEvents(revoked);
    await expect(revoked).toContainText("Revoking staff");
    await expect(revoked.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `generated-artifacts/speaker-badge-events/staff-${width}.png`, fullPage: true });
    await page.getByTestId("button-award-member-badge").click();
    await page.getByTestId("select-member-badge").click();
    await page.getByRole("option", { name: "Manual credential" }).click();
    await page.getByTestId("button-confirm-award-member-badge").click();
    await expect(page.getByTestId("member-badge-manual")).toBeVisible();
    await page.getByTestId("button-revoke-member-badge-active").click();
    await page.getByTestId("button-confirm-revoke-member-badge").click();
    await expect(active).toContainText("Revoked");
    expect(writes).toEqual([
      { method: "POST", body: { badgeId: "manual-badge" } },
      { method: "DELETE", body: { assignmentId: "active" } },
    ]);
  });
}
