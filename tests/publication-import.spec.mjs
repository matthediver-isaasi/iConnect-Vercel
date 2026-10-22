import { test, expect } from "@playwright/test";
import {
  installPublicationFixture, uploadAndPreview, uploadWorkbook, assertIsolated,
  workbookBytes, resolvedRow, skippedRow, previewResponse,
} from "./fixtures/publication-import.fixture.mjs";

const applyButton = page => page.getByTestId("button-apply-publication-import");
const confirm = page => page.getByRole("checkbox", { name: "Confirm publication import" });

test("template download, multi-sheet preview, all resolved data, explicit confirmation, progress and final receipt", async ({ page }) => {
  const state = await installPublicationFixture(page, { multiple: true });
  const downloaded = page.waitForEvent("download");
  await page.getByTestId("button-download-publication-template").click();
  expect((await downloaded).suggestedFilename()).toBe("publication-import-template.xlsx");
  expect(state.templates).toBe(1);
  await page.getByTestId("button-import-publications").click();
  await uploadWorkbook(page);
  await page.getByTestId("button-preview-publication-import").click();
  await expect(page.getByLabel("Worksheet")).toBeVisible();
  await expect(confirm(page)).toBeHidden();
  await expect(applyButton(page)).toBeDisabled();
  await page.getByLabel("Worksheet").selectOption("Publications");
  await page.getByTestId("button-preview-publication-import").click();
  const preview = page.getByTestId("publication-import-preview");
  await expect(preview).toBeVisible();
  await preview.locator("summary").first().click();
  for (const text of [
    "Mira Osei", "Robin Patel", "2027-08-19", "2027-08-09", "2027-08-14",
    "Careers adviser", "Northshore University", "Prospects", "2026-2028",
    "Include the regional findings.", "Check the contributor's publication consent.",
  ]) await expect(preview).toContainText(text);
  await expect(preview.getByText("Yes", { exact: true })).toBeVisible();
  await expect(preview.getByText("No", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("No emails are sent and no public resources are created.");
  await expect(applyButton(page)).toBeDisabled();
  expect(state.applies).toHaveLength(0);
  expect(state.previews[0]).toMatchObject({ action: "preview", fileName: "publications.xlsx", workbook: workbookBytes.toString("base64") });
  expect(state.previews[1].sheetName).toBe("Publications");
  await confirm(page).check();
  let release;
  state.gate = new Promise(resolve => { release = resolve; });
  const before = state.briefReads;
  await applyButton(page).click();
  await expect(page.getByRole("status")).toContainText("Creating publications");
  await expect(applyButton(page)).toBeDisabled();
  release();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  await expect(page.getByTestId("publication-import-results")).toContainText("Regional careers report");
  await expect.poll(() => state.briefReads).toBeGreaterThan(before);
  expect(state.applies).toEqual([{ action: "apply", planId: "fixture-plan-2" }]);
  await expect(page.getByRole("dialog").locator("dl").first()).toContainText("Created1Skipped1Failed0");
  await page.getByRole("button", { name: "Start another import" }).click();
  await expect(confirm(page)).toBeHidden();
  await expect(page.getByLabel("Publication workbook")).toBeEnabled();
  assertIsolated(state);
});

test("file validation blocks unsupported, empty and oversized uploads without preview calls", async ({ page }) => {
  const state = await installPublicationFixture(page);
  await page.getByTestId("button-import-publications").click();
  for (const [name, buffer, message] of [
    ["publications.csv", workbookBytes, "Use an .xlsx workbook"],
    ["empty.xlsx", Buffer.alloc(0), "workbook is empty"],
    ["large.xlsx", Buffer.alloc(1024 * 1024 + 1), "exceeds 1 MB"],
  ]) {
    await uploadWorkbook(page, name, buffer);
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(page.getByTestId("button-preview-publication-import")).toBeDisabled();
    await expect(confirm(page)).toBeHidden();
  }
  expect(state.previews).toHaveLength(0);
  expect(state.applies).toHaveLength(0);
  assertIsolated(state);
});

test("download and preview request failures surface errors and can be retried", async ({ page }) => {
  const state = await installPublicationFixture(page);
  state.templateError = true;
  await page.getByTestId("button-download-publication-template").click();
  await expect(page.getByText("Could not download the template. Please try again.")).toBeVisible();
  await expect(page.getByTestId("button-download-publication-template")).toBeEnabled();
  state.templateError = false;
  const downloaded = page.waitForEvent("download");
  await page.getByTestId("button-download-publication-template").click();
  expect((await downloaded).suggestedFilename()).toBe("publication-import-template.xlsx");
  state.previewResponses.push({ status: 422, body: { error: "Workbook headers are missing" } });
  await page.getByTestId("button-import-publications").click();
  await uploadWorkbook(page);
  await page.getByTestId("button-preview-publication-import").click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Workbook headers are missing");
  await expect(confirm(page)).toBeHidden();
  await expect(applyButton(page)).toBeDisabled();
  await page.getByTestId("button-preview-publication-import").click();
  await expect(confirm(page)).toBeVisible();
  expect(state.previews).toHaveLength(2);
  expect(state.applies).toHaveLength(0);
  assertIsolated(state);
});

test("invalid rows show correction guidance, no confirmation, and permit corrected reupload", async ({ page }) => {
  const state = await installPublicationFixture(page);
  state.previewResponses.push({
    ...previewResponse(null, [{ ...resolvedRow, action: "error", errors: ["Writer email is unknown", "Deadline is invalid"] }]), canApply: false,
  });
  await uploadAndPreview(page);
  await expect(page.getByTestId("publication-import-preview")).toContainText("Writer email is unknown");
  await expect(page.getByTestId("publication-import-preview")).toContainText("Deadline is invalid");
  await expect(page.getByText("Correct this row in your workbook")).toBeVisible();
  await expect(confirm(page)).toBeHidden();
  await expect(applyButton(page)).toBeDisabled();
  expect(state.applies).toHaveLength(0);
  await uploadWorkbook(page, "corrected.xlsx");
  await page.getByTestId("button-preview-publication-import").click();
  await expect(confirm(page)).toBeVisible();
  await expect(confirm(page)).not.toBeChecked();
  assertIsolated(state);
});

test("network interruption retains confirmed plan through dialog close; retry sends the identical token", async ({ page }) => {
  const state = await installPublicationFixture(page);
  state.applyResponses.push({ abort: true });
  await uploadAndPreview(page);
  await confirm(page).check();
  await applyButton(page).click();
  await expect(page.getByRole("alert")).toContainText("outcome may be incomplete");
  await expect(page.getByLabel("Publication workbook")).toBeDisabled();
  await page.getByRole("button", { name: "Close for now" }).click();
  await page.getByTestId("button-import-publications").click();
  await expect(applyButton(page)).toHaveText("Retry same import");
  await applyButton(page).click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  expect(state.applies).toHaveLength(2);
  expect(state.applies[0]).toEqual(state.applies[1]);
  expect(state.previews).toHaveLength(1);
  expect(await page.evaluate(() => Object.values(sessionStorage).join(""))).not.toContain("fixture-plan");
  expect(await page.evaluate(() => Object.values(localStorage).join(""))).not.toContain("fixture-plan");
  assertIsolated(state);
});

for (const [status, message] of [[410, "Import plan expired"], [409, "Import data changed. Preview the workbook again."], [403, "Manage permission is required"]]) {
  test(`definitive ${status} rejection unlocks editing and requires fresh preview and confirmation`, async ({ page }) => {
    const state = await installPublicationFixture(page);
    state.applyResponses.push({ status, body: { error: message } });
    await uploadAndPreview(page);
    await confirm(page).check();
    await applyButton(page).click();
    await expect(page.getByRole("alert")).toContainText("This plan was rejected");
    await expect(page.getByLabel("Publication workbook")).toBeEnabled();
    await expect(confirm(page)).toBeHidden();
    await expect(applyButton(page)).toBeDisabled();
    await page.getByTestId("button-preview-publication-import").click();
    await expect(confirm(page)).not.toBeChecked();
    await expect(applyButton(page)).toBeDisabled();
    await confirm(page).check();
    await applyButton(page).click();
    await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
    expect(state.applies.map(request => request.planId)).toEqual(["fixture-plan-1", "fixture-plan-2"]);
    assertIsolated(state);
  });
}

test("malformed success and uncertain server failure do not show a false empty receipt or discard the token", async ({ page }) => {
  const state = await installPublicationFixture(page);
  state.applyResponses.push(
    { body: { done: true } },
    { status: 503, body: { error: "Fixture temporarily unavailable" } },
    { body: { done: true, created: 0, skipped: 0, failed: 0, rows: [] } },
  );
  await uploadAndPreview(page);
  await confirm(page).check();
  for (let i = 0; i < 3; i++) {
    await applyButton(page).click();
    await expect(page.getByRole("alert")).toContainText("outcome may be incomplete");
    await expect(page.getByRole("heading", { name: "Import complete" })).toBeHidden();
    await expect(page.getByTestId("publication-import-results")).toBeHidden();
    await expect(applyButton(page)).toHaveText("Retry same import");
  }
  await applyButton(page).click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  expect(new Set(state.applies.map(request => request.planId)).size).toBe(1);
  assertIsolated(state);
});

test("all-skipped plan can be confirmed to retrieve a zero-created receipt", async ({ page }) => {
  const state = await installPublicationFixture(page, { rows: [skippedRow] });
  await uploadAndPreview(page);
  await expect(confirm(page)).toBeVisible();
  await expect(applyButton(page)).toBeDisabled();
  await confirm(page).check();
  await applyButton(page).click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  await expect(page.getByRole("dialog").locator("dl").first()).toContainText("Created0Skipped1Failed0");
  assertIsolated(state);
});

test("manage-excluded members see neither import nor template controls", async ({ page }) => {
  const state = await installPublicationFixture(page, { manage: false });
  await expect(page.getByTestId("button-import-publications")).toBeHidden();
  await expect(page.getByTestId("button-download-publication-template")).toBeHidden();
  expect(state.templates).toBe(0);
  expect(state.previews).toHaveLength(0);
  expect(state.applies).toHaveLength(0);
  assertIsolated(state);
});
