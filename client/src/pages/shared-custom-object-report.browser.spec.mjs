import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("public shared report gates the title, pages a snapshot, respects CSV permission, and clears on revocation", async ({ page, baseURL }) => {
  let revoked = false;
  await page.route("**/api/public/custom-object-report", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "unlock" && body.password !== "A browser test password") return route.fulfill({
      status: 401, contentType: "application/json", body: '{"error":"Access is not valid","password_required":true}',
    });
    if (body.action === "unlock") return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      access_grant: "fixture-grant", expires_at: "later", report: { name: "Department snapshot", allow_csv: true },
    }) });
    if (body.action === "check") return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      report: { name: "Department snapshot", allow_csv: true },
    }) });
    if (body.action === "preview" && revoked) return route.fulfill({ status: 404, contentType: "application/json", body: '{"message":"Unavailable"}' });
    if (body.action === "preview" && body.preview_action === "start") return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      sort_job: { id: "browser-job", status: "queued", processed: 0, total: 2 },
    }) });
    if (body.action === "preview" && body.preview_action === "process") return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      sort_job: { id: "browser-job", status: "complete" }, columns: [{ label: "Department" }],
      data: [{ id: "r1", values: ["Clinical"] }], total: 2, page: 1, pageSize: 50, has_more: true,
    }) });
    if (body.action === "preview" && body.preview_action === "page") return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      sort_job: { id: "browser-job", status: "complete" }, columns: [{ label: "Department" }],
      data: [{ id: "r2", values: ["Imaging"] }], total: 2, page: 2, pageSize: 50, has_more: false,
    }) });
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.goto(new URL("/shared-reports/fixture-token", baseURL).toString());
  await expect(page.getByText("Department snapshot")).toHaveCount(0);
  await page.getByLabel("Access password").fill("wrong password");
  await page.getByRole("button", { name: "Open report" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("Department snapshot")).toHaveCount(0);
  await page.getByLabel("Access password").fill("A browser test password");
  await page.getByRole("button", { name: "Open report" }).click();
  await expect(page.getByRole("heading", { name: "Department snapshot" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Clinical" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download CSV" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("cell", { name: "Imaging" })).toBeVisible();
  revoked = true;
  await page.getByRole("button", { name: "Refresh data" }).click();
  await expect(page.getByRole("heading", { name: "Link unavailable" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Imaging" })).toHaveCount(0);
});

test("an account-free viewer downloads only permitted server-ordered CSV without mounting CRM providers", async ({ page, baseURL }, testInfo) => {
  const requests = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(new URL(request.url()).pathname); });
  await page.route("**/api/public/custom-object-report", async route => {
    const body = route.request().postDataJSON();
    let result;
    if (body.action === "unlock") result = {
      access_grant: "fixture-grant", report: { name: "Shared department report", allow_csv: true },
    };
    else if (body.action === "check") result = { report: { name: "Shared department report", allow_csv: true } };
    else if (body.action === "preview") result = {
      sort_job: { id: "preview", status: "complete" }, columns: [{ label: "Department" }],
      data: [{ id: "r1", values: ["Zebra"] }, { id: "r2", values: ["Alpha"] }],
      total: 2, page: 1, pageSize: 50, has_more: false,
    };
    else if (body.export_action === "chunk") result = { csv_text: body.chunk_index === 0 ? "\uFEFFDepartment\r\nZebra\r\n" : "Alpha\r\n" };
    else result = { id: "export", status: body.export_action === "start" ? "queued" : "complete",
      processed: 2, total: 2, chunk_count: 2, filename: "shared-departments.csv" };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
  });
  await page.goto(new URL("/shared-reports/fixture-token", baseURL).toString());
  await page.getByRole("button", { name: "Open report" }).click();
  await expect(page.getByRole("cell", { name: "Zebra" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("shared-report.png"), fullPage: true });
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  const download = await downloaded;
  const file = testInfo.outputPath("shared-departments.csv");
  await download.saveAs(file);
  expect((await readFile(file, "utf8")).replace(/^\uFEFF/, "")).toBe("Department\r\nZebra\r\nAlpha\r\n");
  expect(requests.filter(path => /^\/api\/(?:auth|entities|custom-objects)(?:\/|$)/.test(path))).toEqual([]);
});
