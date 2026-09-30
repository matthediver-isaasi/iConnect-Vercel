import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  FIXTURE_MEMBER,
  installMemberGroupCardsFixture,
  memberGroupCardsBounds,
  expectGridColumns,
} from "./fixtures/member-group-cards-browser.fixture.mjs";
import {
  REGIONAL_SLUG,
  REGIONAL_CARD_ID,
  REGIONAL_OWNER_ID,
  REGIONAL_FOLLOWING_ID,
  REGIONAL_TERMINAL_ID,
  REGIONAL_GEOMETRY,
  regionalLeadsPage,
  regionalGroups,
} from "./fixtures/regional-leads.fixture.mjs";

const ids = {
  cardId: REGIONAL_CARD_ID,
  ownerId: REGIONAL_OWNER_ID,
  followingId: REGIONAL_FOLLOWING_ID,
  terminalId: REGIONAL_TERMINAL_ID,
};

async function install(page, options = {}) {
  return installMemberGroupCardsFixture(page, {
    fixturePage: regionalLeadsPage,
    groups: regionalGroups,
    assetPrefix: "/regional-leads-fixture/",
    ...options,
  });
}

function expectedGap(breakpoint) {
  return REGIONAL_GEOMETRY[breakpoint].effectiveFollowingGap;
}

async function expectRegionalContract(page, breakpoint) {
  const geometry = REGIONAL_GEOMETRY[breakpoint];
  await expect(page.getByTestId("member-group-cards-grid")).toBeVisible();
  await expect(page.locator(`[data-cb="${REGIONAL_FOLLOWING_ID}"]`)).toBeVisible();
  await expect(page.getByTestId("member-group-cards-grid").locator(":scope > *")).toHaveCount(15);
  await expect.poll(async () => {
    const value = await memberGroupCardsBounds(page, ids);
    return Math.round(value.following.top - value.outer.bottom);
  }).toBe(expectedGap(breakpoint));

  const value = await expectGridColumns(page, ids, geometry.columns);
  const effectiveFollowingDelta = (
    value.following.top
    - value.stage.top
    - geometry.following.y
  );
  expect(value.following.top).toBeGreaterThanOrEqual(value.outer.bottom);
  // Once the owning Section has constrained the signed shrink, every later
  // block must relay that effective delta exactly once. A raw leaf delta here
  // would double-shrink the terminal Section and the stage.
  expect(Math.abs(
    (value.terminal.top - value.stage.top)
      - (geometry.terminal.y + effectiveFollowingDelta),
  )).toBeLessThanOrEqual(2);
  expect(Math.abs(value.terminal.height - geometry.terminal.h)).toBeLessThanOrEqual(1);
  expect(Math.abs(
    value.stage.height - (geometry.stageHeight + effectiveFollowingDelta),
  )).toBeLessThanOrEqual(2);
  if (breakpoint === "desktop" && value.outer.height < geometry.cards.h - 1) {
    // The authored card extends 288px below its owning Section. The corrected
    // relay shrinks only until the measured card bottom still fits the visible
    // Section; it must not apply the raw card delta and pull content through it.
    expect(Math.abs(value.owner.bottom - value.outer.bottom)).toBeLessThanOrEqual(2);
    expect(value.owner.height).toBeLessThan(geometry.owner.h);
  }
  expect(value.stage.bottom).toBeGreaterThanOrEqual(value.following.bottom);
  return value;
}

test("Regional Leads cold guest loading becomes 15 cards and retains effective section gaps and stage bounds after late assets", async ({ page }) => {
  const state = await install(page, {
    audience: "guest",
    holdGroups: true,
    holdAssets: true,
  });
  await page.goto(`/${REGIONAL_SLUG}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("member-group-cards-loading")).toBeVisible();
  let value = await memberGroupCardsBounds(page, ids);
  expect(value.following.top).toBeGreaterThanOrEqual(value.outer.bottom);
  expect(value.stage.bottom).toBeGreaterThanOrEqual(value.following.bottom);

  state.releaseGroups();
  await expect(page.getByTestId("member-group-cards-grid")).toBeVisible();
  await page.addStyleTag({
    content: `@font-face{font-family:RegionalLate;src:url("/regional-leads-fixture/late-font.woff2")} [data-cb="${REGIONAL_CARD_ID}"]{font-family:RegionalLate,Arial,sans-serif}`,
  });
  state.releaseAssets();
  await page.evaluate(() => document.fonts?.ready);
  await expectRegionalContract(page, "desktop");

  for (const breakpoint of ["tablet", "mobile"]) {
    await page.setViewportSize(REGIONAL_GEOMETRY[breakpoint].viewport);
    await expectRegionalContract(page, breakpoint);
  }
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const audience of ["guest", "member"]) {
  test(`Regional Leads ${audience} fixture preserves 3/2/1 layout, effective gaps and stage bounds`, async ({ page }, testInfo) => {
    const state = await install(page, { audience });
    const bounds = {};
    for (const breakpoint of ["desktop", "tablet", "mobile"]) {
      await page.setViewportSize(REGIONAL_GEOMETRY[breakpoint].viewport);
      if (breakpoint === "desktop") {
        await page.goto(`/${REGIONAL_SLUG}`, { waitUntil: "domcontentloaded" });
      }
      bounds[breakpoint] = await expectRegionalContract(page, breakpoint);
      const screenshotName = `regional-${audience}-${breakpoint}-settled.png`;
      await page.screenshot({
        path: testInfo.outputPath(screenshotName),
        fullPage: true,
      });
      await testInfo.attach(screenshotName, {
        path: testInfo.outputPath(screenshotName),
        contentType: "image/png",
      });
    }
    const boundsName = `regional-${audience}-settled-bounds.json`;
    const boundsPath = testInfo.outputPath(boundsName);
    await writeFile(boundsPath, `${JSON.stringify(bounds, null, 2)}\n`);
    await testInfo.attach(boundsName, { path: boundsPath, contentType: "application/json" });
    const expectedButton = audience === "guest"
      ? "button-login-required-regional-group-1"
      : "button-find-out-more-regional-group-1";
    await expect(page.getByTestId(expectedButton)).toBeVisible();
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test("Regional Leads same-page auth transitions track member and guest card footprints", async ({ page }) => {
  const state = await install(page, { audience: "guest" });
  await page.goto(`/${REGIONAL_SLUG}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("button-login-required-regional-group-1")).toBeVisible();
  const guest = await expectRegionalContract(page, "desktop");

  state.setAudience("member");
  await page.evaluate((member) => {
    const oldValue = localStorage.getItem("agcas_member");
    localStorage.setItem("agcas_member", JSON.stringify(member));
    dispatchEvent(new StorageEvent("storage", {
      key: "agcas_member",
      oldValue,
      newValue: JSON.stringify(member),
    }));
  }, FIXTURE_MEMBER);
  await expect(page.getByTestId("button-find-out-more-regional-group-1")).toBeVisible();
  const member = await expectRegionalContract(page, "desktop");
  expect(member.outer.height).toBeGreaterThan(guest.outer.height);

  state.setAudience("guest");
  await page.evaluate(() => {
    const oldValue = localStorage.getItem("agcas_member");
    localStorage.removeItem("agcas_member");
    dispatchEvent(new StorageEvent("storage", {
      key: "agcas_member",
      oldValue,
      newValue: null,
    }));
  });
  await expect(page.getByTestId("button-login-required-regional-group-1")).toBeVisible();
  const loggedOut = await expectRegionalContract(page, "desktop");
  expect(Math.abs(loggedOut.outer.height - guest.outer.height)).toBeLessThanOrEqual(2);
  for (const value of [member, loggedOut, guest]) {
    expect(Math.abs(
      (value.following.top - value.outer.bottom) - expectedGap("desktop"),
    )).toBeLessThanOrEqual(1);
  }
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});