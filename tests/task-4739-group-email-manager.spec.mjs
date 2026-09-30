// Isolated browser coverage for Task 4739. The real manager is bundled, while
// auth, templates, notifications, and every HTTP response are fixture-local.
import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let script;

test.beforeAll(async () => {
  const mocks = {
    "@/hooks/useMemberAccess": `export const useMemberAccess=()=>({memberInfo:{email:"admin@fixture.invalid"},isAccessReady:true,isFeatureExcluded:()=>false});`,
    "@/api/base44Client": `export const base44={entities:{EmailTemplate:{list:async()=>[]}}};`,
    "@/components/email-builder/BlockRenderer": `import React from "react"; export const SlotEditContext=React.createContext({}); export const ReadOnlyBlockPreview=()=>null;`,
    "@/components/email-builder/types": `export const extractDynamicSlots=(design)=>design?.fixtureSlots||[];`,
    "@/components/email-builder/sanitize": `export const sanitizeHtml=v=>v;`,
    "sonner": `export const toast={success:(m)=>window.fixture.toasts.push(["success",m]),error:(m)=>window.fixture.toasts.push(["error",m])};`,
  };
  const result = await build({
    stdin: {
      contents: `import React from "react"; import {createRoot} from "react-dom/client";
        import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
        import Manager from "./client/src/components/group-email/GroupEmailManager.jsx";
        import GroupEmailPage from "./client/src/pages/GroupEmail.jsx";
        const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
        const Entry=location.pathname==="/entry" ? GroupEmailPage : ()=><Manager group={{id:"group-a",name:"Fixture Group",roles:["Chair"],callerRole:"Admin"}} />;
        createRoot(document.getElementById("root")).render(<QueryClientProvider client={client}><Entry /></QueryClientProvider>);`,
      resolveDir: process.cwd(), loader: "jsx",
    },
    bundle: true, write: false, jsx: "automatic",
    alias: { "@": path.resolve("client/src") },
    plugins: [{
      name: "task-4739-fixture-mocks",
      setup(b) {
        b.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : null);
        b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
          contents: mocks[args.path], loader: "jsx", resolveDir: process.cwd(),
        }));
      },
    }],
  });
  script = result.outputFiles[0].text;
});

async function mount(page, { duplicateFailure = false } = {}) {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (!url.pathname.startsWith("/api/member-campaigns")) {
      return route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script src="/fixture.js"></script>` });
    }
    const request = route.request();
    const id = url.pathname.split("/").at(-1);
    const json = value => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (request.method() === "GET" && url.pathname === "/api/member-campaigns/qualifying-groups") {
      return json({ groups: [
        { id: "group-a", name: "Fixture Group", roles: ["Chair"], callerRole: "Admin" },
        { id: "group-b", name: "Second Fixture Group", roles: ["Secretary"], callerRole: "Admin" },
      ] });
    }
    if (request.method() === "GET" && url.pathname === "/api/member-campaigns") {
      return json({ campaigns: url.searchParams.get("groupId") === "group-b" ? [] : windowState.campaigns });
    }
    if (request.method() === "GET") return json(windowState.full[id]);
    const body = JSON.parse(request.postData() || "{}");
    windowState.writes.push({ id, method: request.method(), body });
    if (body.action === "edit-scheduled") return json({ ...windowState.full[id], status: "draft", scheduled_at: null });
    if (body.action === "duplicate" && windowState.duplicateFailure) {
      await new Promise(resolve => setTimeout(resolve, 100));
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Campaign can no longer be copied" }) });
    }
    if (body.action === "duplicate") return json(windowState.full.copy);
    if (request.method() === "DELETE") return json({ ok: true });
    return json({ ok: true });
  });
  const windowState = {
    writes: [],
    duplicateFailure,
    campaigns: [
      { id: "draft", name: "Other admin draft", subject: "Draft", status: "draft" },
      { id: "scheduled", name: "Scheduled update", subject: "Schedule", status: "scheduled", scheduled_at: "2030-01-01T10:00:00Z" },
      { id: "sent", name: "Already sent", subject: "Sent", status: "sent", sent_count: 0 },
      { id: "failed", name: "Failed campaign", subject: "Failed", status: "failed", sent_count: 0 },
    ],
    full: {
      draft: { id: "draft", name: "Other admin draft", subject: "Draft", html_content: "<p>draft</p>", target_audiences: [{ roles: ["Chair"] }] },
      scheduled: { id: "scheduled", name: "Scheduled update", subject: "Schedule", html_content: "<p>scheduled</p>", target_audiences: [{ roles: ["Chair"] }] },
      sent: {
        id: "sent", name: "Already sent", subject: "Sent", html_content: "<p>sent</p>",
        target_audiences: [{ roles: ["Chair"] }],
        design_json: {
          blocks: [],
          fixtureSlots: [{ token: "headline", defaultValue: "default" }],
          slotValues: { headline: "Copied slot value" },
          hiddenSlots: ["headline"],
          richSlots: ["headline"],
        },
      },
      failed: { id: "failed", name: "Failed campaign", subject: "Failed", html_content: "<p>failed</p>", target_audiences: [{ roles: ["Chair"] }] },
      copy: {
        id: "copy", name: "Already sent (copy)", subject: "Sent", html_content: "<p>sent</p>",
        target_audiences: [{ roles: ["Chair"] }],
        design_json: {
          blocks: [],
          fixtureSlots: [{ token: "headline", defaultValue: "default" }],
          slotValues: { headline: "Copied slot value" },
          hiddenSlots: ["headline"],
          richSlots: ["headline"],
        },
      },
    },
  };
  await page.goto("https://task4739.fixture.invalid/group-email");
  await page.evaluate(() => { window.fixture = { toasts: [] }; });
  await expect(page.getByTestId("row-member-campaign-draft")).toBeVisible();
  return windowState;
}

test("standalone entry describes shared campaigns and mounts the shared lifecycle manager", async ({ page }) => {
  await mount(page);
  await page.goto("https://task4739.fixture.invalid/entry");
  await expect(page.getByTestId("page-group-email")).toContainText("shared with your group's eligible email admins");
  await expect(page.getByTestId("text-group-email-heading")).toContainText("shared group campaigns");
  await expect(page.getByTestId("row-member-campaign-scheduled")).toBeVisible();
  await expect(page.getByTestId("button-edit-scheduled-scheduled")).toBeVisible();
  await page.getByTestId("select-active-group").click();
  await page.getByTestId("option-group-group-b").click();
  await expect(page.getByTestId("empty-campaigns")).toBeVisible();
  await expect(page.getByTestId("row-member-campaign-scheduled")).toHaveCount(0);
});

test("draft-only destructive controls, scheduled confirmation, and duplicate use fixture-only lifecycle requests", async ({ page }) => {
  const state = await mount(page);
  await expect(page.getByTestId("button-edit-scheduled-scheduled")).toBeVisible();
  await expect(page.getByTestId("button-edit-sent")).toHaveCount(0);
  await expect(page.getByTestId("button-delete-failed")).toHaveCount(0);
  for (const id of ["draft", "scheduled", "sent", "failed"]) await expect(page.getByTestId(`button-duplicate-${id}`)).toBeVisible();

  page.once("dialog", dialog => dialog.dismiss());
  await page.getByTestId("button-edit-scheduled-scheduled").click();
  await expect.poll(() => state.writes).toHaveLength(0);

  page.once("dialog", dialog => dialog.accept());
  await page.getByTestId("button-edit-scheduled-scheduled").click();
  await expect(page.getByTestId("input-campaign-name")).toHaveValue("Scheduled update");
  expect(state.writes).toContainEqual({ id: "scheduled", method: "POST", body: { action: "edit-scheduled" } });
  await page.getByTestId("button-cancel-compose").click();

  await page.getByTestId("button-duplicate-sent").click();
  await expect(page.getByTestId("input-campaign-name")).toHaveValue("Already sent (copy)");
  await expect(page.getByTestId("checkbox-audience-role-Chair")).toBeChecked();
  expect(state.writes).toContainEqual({ id: "sent", method: "POST", body: { action: "duplicate" } });
  await page.getByTestId("button-save-draft").click();
  await expect.poll(() => state.writes.some(write => write.id === "copy" && write.method === "PATCH")).toBe(true);
  const savedCopy = state.writes.find(write => write.id === "copy" && write.method === "PATCH").body;
  expect(savedCopy.audience_roles).toEqual(["Chair"]);
  expect(savedCopy.design_json.slotValues).toEqual({ headline: "Copied slot value" });
  expect(savedCopy.design_json.hiddenSlots).toEqual(["headline"]);
  expect(savedCopy.design_json.richSlots).toEqual(["headline"]);

  await page.getByTestId("button-cancel-compose").click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByTestId("button-delete-draft").click();
  expect(state.writes).toContainEqual({ id: "draft", method: "DELETE", body: {} });
});

test("a pending duplicate is disabled and an API error leaves the source row intact", async ({ page }) => {
  const state = await mount(page, { duplicateFailure: true });
  const duplicate = page.getByTestId("button-duplicate-sent");
  await duplicate.click();
  await expect(duplicate).toBeDisabled();
  await expect.poll(() => state.writes.some(write => write.body.action === "duplicate")).toBe(true);
  await expect(duplicate).toBeEnabled();
  await expect(page.getByTestId("row-member-campaign-sent")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.fixture.toasts)).toContainEqual([
    "error", "Campaign can no longer be copied",
  ]);
});