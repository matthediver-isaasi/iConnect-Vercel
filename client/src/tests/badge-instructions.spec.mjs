import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { readFile } from "node:fs/promises";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig.js";

let script;
let css;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ["client/src/test-fixtures/badge-instructions.jsx"],
    bundle: true, write: false, jsx: "automatic", loader: { ".css": "empty" },
    alias: { "@": path.resolve("client/src") },
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env": "{}" },
  });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    ...loadConfig(path.resolve("tailwind.config.ts")),
    content: ["client/src/components/BadgeInstructions*.jsx", "client/src/components/ui/{card,button,input,dialog}.jsx"],
    corePlugins: { preflight: true },
  })]).process(await readFile("client/src/index.css", "utf8"), { from: undefined })).css;
});

async function fixture(page) {
  const states = new Map();
  const requests = [];
  const control = { fail: null, documentFailure: false, warning: null };
  await page.route("**/api/badge-instructions*", async (route) => {
    const request = route.request();
    const tenantId = request.headers()["x-tenant-id"];
    expect(tenantId).toMatch(/^badge-fixture-[ab]$/);
    if (new URL(request.url()).searchParams.has("document")) {
      expect(new URL(request.url()).searchParams.get("tenantId")).toBe(tenantId);
      return route.fulfill(control.documentFailure
        ? { status: 404, contentType: "text/html", body: "<p>Unavailable</p>" }
        : { contentType: "application/pdf", body: Buffer.from("%PDF-1.4\n%%EOF") });
    }
    const method = request.method();
    const body = request.postDataJSON();
    requests.push({ tenantId, method, body });
    if (control.fail) {
      const status = control.fail; control.fail = null;
      return route.fulfill({ status, json: { error: "Fixture failure. Retry this action.", ...(control.warning ? { warning: control.warning } : {}) } });
    }
    let state = states.get(tenantId) || { tenantId, mode: "standard", revision: null, document: null, canManage: true };
    if (method !== "GET") {
      expect(body.revision).toBe(state.revision);
      if (method === "POST") {
        expect(body.action).toBe("upload");
        expect(body.mimeType).toBe("application/pdf");
        expect(Buffer.from(body.contentBase64, "base64").toString()).toContain("%PDF");
        state = { ...state, document: { filename: body.filename, size: 19 } };
      } else if (method === "PATCH") state = { ...state, mode: body.mode };
      else {
        expect(body.confirm).toBe(true);
        state = { ...state, mode: "standard", document: null };
      }
      state.revision = `revision-${requests.length}`;
      states.set(tenantId, state);
    }
    return route.fulfill({ json: { ...state, ...(control.warning ? { warning: control.warning } : {}) } });
  });
  await page.route("**/src/test-fixtures/badge-instructions.html", (route) => route.fulfill({
    contentType: "text/html", body: '<!doctype html><html lang="en"><head><title>Badge instructions fixture</title></head><body><div id="root"></div></body></html>',
  }));
  await page.goto("/src/test-fixtures/badge-instructions.html");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("button", { name: "Save instructions", exact: true })).toBeVisible();
  return { states, requests, control };
}

const pdf = (name = "member-guide.pdf") => ({ name, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nfixture") });

test("upload, preview, select, replace, remove from use, cancel then permanently delete", async ({ page }) => {
  const f = await fixture(page);
  const help = page.getByRole("link", { name: "How to share your badge" });
  await expect(help).toHaveAttribute("href", "/help/sharing-your-membership-badge");
  await page.getByRole("radio", { name: "Tenant PDF" }).check();
  await expect(page.getByRole("button", { name: "Save instructions", exact: true })).toBeDisabled();
  await page.getByLabel("Upload PDF", { exact: true }).setInputFiles(pdf());
  await page.locator("button").filter({ hasText: /^Upload PDF$/ }).click();
  const filename = page.getByRole("link", { name: /member-guide.pdf/ });
  await expect(filename).toHaveAttribute("target", "_blank");
  await expect(filename).toHaveAttribute("href", "/api/badge-instructions?document=true&tenantId=badge-fixture-a");
  f.control.documentFailure = true;
  const popupEvent = page.waitForEvent("popup");
  await filename.click();
  const popup = await popupEvent;
  await expect(popup.getByRole("link", { name: "Open standard badge help" })).toHaveAttribute("href", /\/help\/sharing-your-membership-badge$/);
  await popup.close();
  await page.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(help).toHaveAttribute("href", "/api/badge-instructions?document=true&tenantId=badge-fixture-a");
  await expect(help).toHaveAttribute("target", "_blank");
  await page.getByLabel("Replace PDF", { exact: true }).setInputFiles(pdf("replacement.pdf"));
  await page.getByRole("button", { name: "Upload replacement" }).click();
  await expect(page.getByRole("link", { name: /replacement.pdf/ })).toBeVisible();
  await page.getByRole("button", { name: "Remove PDF from use", exact: true }).click();
  await expect(help).toHaveAttribute("href", "/help/sharing-your-membership-badge");
  await expect(page.getByRole("link", { name: /replacement.pdf/ })).toBeVisible();
  await page.getByRole("button", { name: "Permanently delete PDF", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(f.requests.some((r) => r.method === "DELETE")).toBe(false);
  await page.getByRole("button", { name: "Permanently delete PDF", exact: true }).click();
  await page.getByRole("button", { name: "Confirm permanent deletion", exact: true }).click();
  await expect(page.getByText("No PDF uploaded.", { exact: false })).toBeVisible();
  expect(f.states.get("badge-fixture-a").document).toBeNull();
});

test("validation, upload/save/delete errors retain state; tenant switch has no leaked document", async ({ page }) => {
  const f = await fixture(page);
  await page.getByLabel("Upload PDF", { exact: true }).setInputFiles({ name: "too-large.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(2097153) });
  await page.locator("button").filter({ hasText: /^Upload PDF$/ }).click();
  await expect(page.getByRole("alert")).toContainText("2 MB");
  await page.getByLabel("Upload PDF", { exact: true }).setInputFiles(pdf());
  f.control.fail = 500;
  await page.locator("button").filter({ hasText: /^Upload PDF$/ }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture failure");
  await expect(page.getByText("Selected: member-guide.pdf", { exact: true })).toBeVisible();
  await page.locator("button").filter({ hasText: /^Upload PDF$/ }).click();
  await page.getByRole("radio", { name: "Tenant PDF" }).check();
  f.control.fail = 409;
  await page.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  await expect(page.getByRole("radio", { name: "Tenant PDF" })).toBeChecked();
  await page.getByRole("button", { name: "Reload saved settings" }).click();
  await page.getByRole("radio", { name: "Tenant PDF" }).check();
  await page.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(page.getByText("Badge instructions saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Permanently delete PDF", exact: true }).click();
  f.control.fail = 500;
  await page.getByRole("button", { name: "Confirm permanent deletion", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Fixture failure");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Switch fixture tenant" }).click();
  await expect(page.getByText("No PDF uploaded.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: /member-guide.pdf/ })).toHaveCount(0);
});

test("cleanup warnings never claim permanent deletion and offer a revision-aware retry", async ({ page }) => {
  const f = await fixture(page);
  await page.getByLabel("Upload PDF", { exact: true }).setInputFiles(pdf());
  await page.locator("button").filter({ hasText: /^Upload PDF$/ }).click();
  await expect(page.getByRole("link", { name: /member-guide.pdf/ })).toBeVisible();
  await page.getByRole("button", { name: "Permanently delete PDF", exact: true }).click();
  f.control.warning = "Unused file cleanup is pending. Retry from settings; storage usage remains reserved until cleanup succeeds.";
  await page.getByRole("button", { name: "Confirm permanent deletion", exact: true }).click();
  await expect(page.getByText("PDF permanently deleted.", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("storage usage remains reserved");
  f.control.fail = 500;
  await page.getByRole("button", { name: "Retry file cleanup" }).click();
  await expect(page.getByRole("button", { name: "Retry file cleanup" })).toBeEnabled();
  f.control.warning = null;
  await page.getByRole("button", { name: "Retry file cleanup" }).click();
  await expect(page.getByText("Unused file cleanup completed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry file cleanup" })).toHaveCount(0);
  expect(f.requests.at(-1).method).toBe("PATCH");
  expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
});
