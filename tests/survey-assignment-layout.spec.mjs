import { test, expect } from "@playwright/test";

for (const width of [375, 768, 1024, 1440]) {
  test(`cards retain readable full content without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const card = page.getByTestId("assignment-row-active");
    await expect(card).toContainText("international membership community");
    await expect(card).toContainText("Link serves current published Version 2");
    await expect(card).toContainText("older than current Version 2");
    await expect(card).toContainText("Unpublished draft edits are not live");
    await expect(card).toContainText("Accepting responses");
    await expect(card).toContainText("Members only");
    await expect(card).toContainText("First:");
    await expect(card).toContainText("Last:");
    await expect(page.getByTestId("assignment-row-removed")).toContainText("Removed · history retained");
    const deleted = page.getByTestId("assignment-row-deleted");
    await expect(deleted).toContainText("event deleted");
    await expect(deleted.getByRole("link", { name: "View event" })).toHaveCount(0);
    await expect(deleted).toContainText("Not recorded");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const id of ["active", "removed", "deleted"]) {
      const box = await page.getByTestId(`assignment-row-${id}`).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await expect(page.locator("a button, button a, table")).toHaveCount(0);
  });
}

test("labelled links, clipboard feedback, edit and lifecycle review preserve their contracts", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const previews = [];
  await page.route("**/api/**", async route => {
    const body = route.request().postDataJSON();
    expect(new URL(route.request().url()).pathname).toBe("/api/surveys/lifecycle");
    expect(body.operation).toBe("preview");
    previews.push(body);
    await route.fulfill({ json: { confirmation_token: "fixture-only", impact: {
      form_id: body.form_id, assignment_id: body.assignment_id, action: body.action,
      reversible: true, events: [], stops_submissions: body.action === "remove_assignment",
    } } });
  });
  await page.goto("/");
  const card = page.getByTestId("assignment-row-active");
  await card.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Assignment link copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("http://127.0.0.1:5188/survey/fixture-active");
  const open = card.getByRole("link", { name: "Open survey" });
  await expect(open).toHaveAttribute("rel", "noopener noreferrer");
  const popupPromise = page.waitForEvent("popup");
  await open.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/survey\/fixture-active$/);
  await popup.close();
  await expect(card.getByRole("link", { name: "View event" })).toHaveAttribute("href", "/EditEvent?id=event");
  await expect(page.getByTestId("assignment-row-removed").getByRole("link", { name: "View event" })).toHaveAttribute("href", "/CreateComplexEvent?id=complex");
  await page.getByTestId("link-responses-active").click();
  await expect(page).toHaveURL(/\/FormSubmissions\?form=survey&assignment=active$/);
  await page.getByTestId("button-edit-active").click();
  await expect(page.getByRole("dialog")).toContainText("Edit assignment");
  await page.getByRole("button", { name: "Review impact", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Update Event Survey Access");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const [id, action] of [["active", "remove"], ["removed", "reattach"]]) {
    await page.getByTestId(`button-${action}-${id}`).click();
    await page.getByRole("button", { name: "Continue to acknowledgement" }).click();
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    await expect(page.getByRole("button", { name: action === "remove" ? "Remove from Event" : "Reattach to Event", exact: true }).last()).toBeDisabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  expect(previews.map(p => p.action)).toEqual(["update_assignment", "remove_assignment", "reattach_assignment"]);
  expect(previews[0].changes.access_mode).toBe("authenticated");
});

for (const [mode, text] of [
  ["loading", "Loading assignments..."], ["error", "Failed to load assignments."],
  ["empty", "No events assigned yet."], ["version-error", "Version details could not be loaded. Retry"],
]) {
  test(`${mode} state remains explicit`, async ({ page }) => {
    await page.goto(`/?mode=${mode}`);
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    if (mode === "version-error") {
      await page.getByRole("button", { name: "Version details could not be loaded. Retry" }).first().click();
      await expect(page.getByText("Current published version unavailable.").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry availability check" }).first()).toBeVisible();
    }
  });
}
