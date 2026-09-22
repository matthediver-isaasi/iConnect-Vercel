import { test, expect } from "@playwright/test";
import {
  categories,
  installCommunicationReportFixture,
} from "./member-communication-status.fixture.mjs";

const PAGE_PATH = "/CommunicationsManagement";

async function openReport(page) {
  await page.goto(PAGE_PATH);
  await expect(page.getByTestId("tab-campaigns")).toBeVisible();
  await page.getByTestId("tab-member-communication-status").click();
  return page.getByTestId("member-communication-status-report");
}

async function choose(report, label, option) {
  const wrapper = report.locator("label", { hasText: label }).locator("..");
  await wrapper.getByRole("combobox").click();
  await report.page().getByRole("option", { name: option, exact: true }).first().click();
}

test("tab is additive, report reads are scoped, and the consent matrix preserves explicit status", async ({ page, baseURL }) => {
  const state = await installCommunicationReportFixture(page, baseURL);
  await page.goto(PAGE_PATH);
  await expect(page.getByTestId("tab-campaigns")).toBeVisible();
  await expect(page.getByTestId("tab-lists")).toBeVisible();
  await expect(page.getByTestId("tab-categories")).toBeVisible();
  await expect(page.getByTestId("tab-opt-outs")).toBeVisible();
  await expect(page.getByTestId("tab-member-communication-status")).toBeVisible();
  expect(state.reportReads).toHaveLength(0);

  const baselineWholeTenantReads = state.wholeTenantReads.length;
  await page.getByTestId("tab-member-communication-status").click();
  const report = page.getByTestId("member-communication-status-report");
  await expect(report.getByRole("heading", { name: "Member Communication Status" })).toBeVisible();
  await expect.poll(() => state.reportReads.length).toBe(1);
  expect(state.wholeTenantReads.length).toBe(baselineWholeTenantReads);

  await expect(report.getByText("53", { exact: true }).first()).toBeVisible();
  await expect(report.getByText("11", { exact: true })).toBeVisible();
  await expect(report.getByText("42", { exact: true })).toBeVisible();
  await expect(report.getByText("19", { exact: true })).toBeVisible();
  await expect(report).toContainText("consent counts, not delivery-eligibility counts");
  await expect(report).toContainText("Global opt-out overrides category preferences");

  // Disabled-login members remain reportable, duplicate labels are keyed by
  // visible category IDs, and unavailable categories retain stored consent.
  await expect(report.getByText("Disabled 01", { exact: true })).toBeVisible();
  await expect(report.getByText(`ID: ${categories[0].id}`, { exact: false })).toBeVisible();
  await expect(report.getByText(`ID: ${categories[1].id}`, { exact: false })).toBeVisible();
  await expect(report.getByText("inactive", { exact: false }).first()).toBeVisible();
  await expect(report.getByText("public only", { exact: false }).first()).toBeVisible();
  const disabledRow = report.getByRole("row", { name: /Disabled 01/ });
  await expect(disabledRow.getByRole("cell", { name: "Opted in Unavailable — inactive", exact: true })).toBeVisible();
  await expect(disabledRow.getByRole("cell", { name: "Opted in Unavailable — public only", exact: true })).toBeVisible();
  const roleIneligibleRow = report.getByRole("row", { name: /Member 02/ });
  await expect(roleIneligibleRow.getByRole("cell", { name: "Opted in Unavailable — role ineligible", exact: true })).toBeVisible();
  await expect(roleIneligibleRow.getByRole("cell", { name: "Not opted in Unavailable — inactive", exact: true })).toBeVisible();
  const nullEmailRow = report.getByRole("row", { name: /Member 03/ });
  await expect(nullEmailRow.getByText("No email", { exact: true })).toBeVisible();
  await expect(report).toContainText("Showing 1–50 of 53 members");
  await page.screenshot({ path: "/tmp/communication-report-final.png", fullPage: false });
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.unexpectedRequests).toEqual([]);
});

test("pagination and intersecting filters issue bounded server reads; reset clears every filter", async ({ page, baseURL }) => {
  const state = await installCommunicationReportFixture(page, baseURL);
  const report = await openReport(page);
  await expect(report).toContainText("Showing 1–50 of 53 members");

  await report.getByRole("button", { name: /Next/ }).click();
  await expect(report).toContainText("Showing 51–53 of 53 members");
  expect(state.reportReads.at(-1)).toMatchObject({ page: "2", limit: "50" });

  await report.getByPlaceholder("Name or email").fill("member");
  await expect.poll(() => state.reportReads.at(-1)?.search).toBe("member");
  expect(state.reportReads.at(-1).page).toBe("1");
  await choose(report, "Organisation", "North Association");
  await choose(report, "Member role", "Administrator");
  await choose(report, "Global opt-out", "Yes");
  await choose(report, "Category consent", "News");
  await choose(report, "Category status", "Opted in");
  await expect.poll(() => state.reportReads.at(-1)).toMatchObject({
    page: "1",
    search: "member",
    organizationId: "org-north",
    roleId: "role-admin",
    globalOptOut: "yes",
    categoryId: "category-news-active",
    categoryStatus: "opted_in",
  });

  await report.getByRole("button", { name: "Reset filters" }).click();
  await expect(report.getByPlaceholder("Name or email")).toHaveValue("");
  await expect(report.locator("label", { hasText: "Organisation" }).locator("..").getByRole("combobox")).toHaveText("All organisations");
  await expect(report.locator("label", { hasText: "Member role" }).locator("..").getByRole("combobox")).toHaveText("All roles");
  await expect(report.locator("label", { hasText: "Global opt-out" }).locator("..").getByRole("combobox")).toHaveText("All statuses");
  await expect(report.locator("label", { hasText: "Category consent" }).locator("..").getByRole("combobox")).toHaveText("All categories");
  await expect(report.locator("label", { hasText: "Category status" }).locator("..").getByRole("combobox")).toHaveText("All statuses");
  // React Query may satisfy the reset from the already-cached unfiltered page.
  // The rendered population and controls are authoritative; a redundant request
  // is neither required nor desirable.
  await expect(report).toContainText("Showing 1–50 of 53 members");
  await expect(report.getByRole("button", { name: "Reset filters" })).toBeDisabled();
  expect(state.unexpectedWrites).toEqual([]);
});

test("loading failures are retryable and empty members differ from no categories", async ({ page, baseURL }) => {
  const state = await installCommunicationReportFixture(page, baseURL, { reportFailures: 1 });
  const report = await openReport(page);
  await expect(report.getByText("Unable to load this report", { exact: true })).toBeVisible();
  await expect(report.getByText("Fixture report failure", { exact: true })).toBeVisible();
  await report.getByRole("button", { name: "Try again" }).click();
  await expect(report).toContainText("Showing 1–50 of 53 members");
  expect(state.reportReads.length).toBeGreaterThanOrEqual(2);

  state.forceEmpty = true;
  await report.getByPlaceholder("Name or email").fill("no result");
  await expect(report.getByText("No members match these filters", { exact: true })).toBeVisible();

  state.forceEmpty = false;
  state.noCategories = true;
  await report.getByPlaceholder("Name or email").fill("");
  // Use a fresh page-size query rather than the cached initial response.
  await report.getByRole("combobox").filter({ hasText: "50 / page" }).click();
  await page.getByRole("option", { name: "25 / page", exact: true }).click();
  await expect(report.getByText("No communication categories exist yet.", { exact: false })).toBeVisible();
  await expect(report.getByRole("columnheader", { name: "Member", exact: true })).toBeVisible();
  await expect(report.getByRole("columnheader", { name: "Organisation", exact: true })).toBeVisible();
  await expect(report.getByRole("columnheader", { name: "Global opt-out", exact: true })).toBeVisible();
  await expect(report.getByText("Disabled 01", { exact: true })).toBeVisible();
  await expect(report).toContainText("Showing 1–25 of 53 members");
  await expect(report.getByRole("button", { name: /Next/ })).toBeEnabled();
  await expect(report.getByText("category-news-active", { exact: false })).toHaveCount(0);
  expect(state.unexpectedWrites).toEqual([]);
});

test("complete CSV download shows progress, sends the same filters and validates more than 1,000 rows", async ({ page, baseURL }) => {
  const state = await installCommunicationReportFixture(page, baseURL, {
    exportScale: true,
    holdExport: true,
  });
  const report = await openReport(page);
  await expect(report).toContainText("Showing 1–50 of 1,005 members");
  await choose(report, "Global opt-out", "No");
  await expect.poll(() => state.reportReads.at(-1)?.globalOptOut).toBe("no");

  const downloadPromise = page.waitForEvent("download");
  await report.getByTestId("button-download-communication-status").click();
  await expect(report.getByText("Preparing the complete filtered CSV…", { exact: true })).toBeVisible();
  await expect.poll(() => state.exportRequests.length).toBe(1);
  expect(state.exportRequests[0]).toEqual({
    filters: { globalOptOut: "no" },
    expectedCount: 1005,
  });
  state.releaseExport();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("member_communication_status_fixture.csv");
  const stream = await download.createReadStream();
  let csv = "";
  for await (const chunk of stream) csv += chunk.toString("utf8");
  expect(csv.split("\r\n")).toHaveLength(1006);
  expect(csv).toContain("export-1005");
  await expect(report.getByText("Downloaded 1005 matching members.", { exact: true })).toBeVisible();
  expect(state.unexpectedWrites).toEqual([]);
});

test("a failed CSV request reports an error and never creates a partial download", async ({ page, baseURL }) => {
  const state = await installCommunicationReportFixture(page, baseURL, { exportFailure: true });
  const report = await openReport(page);
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  await report.getByTestId("button-download-communication-status").click();
  await expect(report.getByText("Fixture export failure", { exact: true })).toBeVisible();
  await page.waitForTimeout(100);
  expect(downloaded).toBe(false);
  expect(state.unexpectedWrites).toEqual([]);
});