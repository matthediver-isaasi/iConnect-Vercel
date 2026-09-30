import { test, expect } from "@playwright/test";

const TENANT_ID = "ff2df806-b321-4254-b651-3af11fccf1db";
const ADMIN = {
  id: "task-4588-admin",
  tenant_id: TENANT_ID,
  role_id: "task-4588-admin-role",
  email: "admin@bnms.example.invalid",
  first_name: "BNMS",
  last_name: "Administrator",
  member_excluded_features: [],
  is_team_member: true,
  viewer_kind: "administrator",
};
const GUEST_KEYS = [
  "org_directory_guest_heading",
  "org_directory_guest_description",
  "org_directory_guest_join_link",
];
const PUBLIC_GUEST_KEYS = [...GUEST_KEYS, "org_directory_guest_join_action_id"];
const LEGACY_JOIN_ACTION_ID = "task-4588-legacy-join-action";
const EXTERNAL_JOIN_LINK = "https://www.bnms.org.uk/join";
const INTERNAL_JOIN_LINK = "/Membership";
const LOGIN_LINK_BRANDING = {
  label: "Member login",
  asButton: true,
  backgroundMode: "gradient",
  gradientStops: [
    { color: "#7c3aed", position: 0 },
    { color: "#db2777", position: 100 },
  ],
  cornerRadius: 13,
  borderWidth: 2,
  borderColor: "#fbbf24",
  borderStyle: "solid",
  labelColor: "#fef3c7",
  height: 42,
  width: 156,
};
const HERO = {
  id: "task-4588-hero",
  name: "BNMS organisation directory hero",
  banner_type: "hero",
  page_position: "top",
  display_order: 1,
  is_active: true,
  associated_pages: ["portal_org_directory"],
  hero_content: {
    heading: "BNMS member organisations",
    subheading: "The professional community for nuclear medicine.",
    background_type: "color",
    background_color: "#312e81",
    padding_top: 32,
    padding_bottom: 32,
    text_color: "#ffffff",
  },
};
const DEFAULT_SETTINGS = [
  ["org_directory_header", "Organisation Directory"],
  ["org_directory_show_logo", "true"],
  ["org_directory_show_title", "true"],
  ["org_directory_show_domains", "true"],
  ["org_directory_show_member_count", "true"],
  ["org_directory_show_name_tooltip", "false"],
  ["org_directory_cards_per_row", "3"],
  ["org_directory_excluded_orgs", "[]"],
  ["org_directory_allowed_application_statuses", "[]"],
  ["org_directory_visible_org_types", "[]"],
  ["org_directory_reverse_card_role_ids", "[]"],
  ["org_directory_view_members_role_ids", "[]"],
  ["org_directory_back_field_order", "[]"],
  ["org_directory_custom_fields_label", ""],
  ["org_directory_filterable_back_fields", "{}"],
  ["org_directory_guest_heading", "BNMS Organisation Directory"],
  [
    "org_directory_guest_description",
    "Sign in to discover and connect with organisations across the BNMS community.",
  ],
  ["org_directory_guest_join_link", EXTERNAL_JOIN_LINK],
  ["org_directory_guest_join_action_id", LEGACY_JOIN_ACTION_ID],
].map(([setting_key, setting_value], index) => ({
  id: `task-4588-setting-${index}`,
  tenant_id: TENANT_ID,
  setting_key,
  setting_value,
  description: "",
}));

function publicSettings(settings, url) {
  const key = url.searchParams.get("key");
  const rows = settings.filter((setting) => PUBLIC_GUEST_KEYS.includes(setting.setting_key));
  return key ? rows.filter((setting) => setting.setting_key === key) : rows;
}

async function installFixture(page, {
  authenticated = false,
  guestSettings = "configured",
  navigationFailure = false,
  loginLinkBranding = LOGIN_LINK_BRANDING,
  joinLink,
} = {}) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (joinLink !== undefined) {
    settings.find((setting) => setting.setting_key === "org_directory_guest_join_link").setting_value = joinLink;
  }
  const state = {
    authenticated,
    settings,
    requests: [],
    writes: [],
  };

  await page.addInitScript(() => {
    localStorage.removeItem("agcas_member");
    localStorage.removeItem("agcas_organization");
  });

  await page.context().route("**/rest/v1/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": "0-0/0" },
    body: "[]",
  }));

  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    state.requests.push({ method, path, search: url.search });

    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (path === "/api/auth/me") {
      return json(state.authenticated ? ADMIN : null, state.authenticated ? 200 : 401);
    }
    if (path === "/api/auth/tenant-user-me") {
      return json(state.authenticated
        ? {
          authenticated: true,
          user: ADMIN,
          tenantUser: ADMIN,
          tenant: { id: TENANT_ID, name: "British Nuclear Medicine Society", slug: "bnms" },
        }
        : { authenticated: false }, state.authenticated ? 200 : 401);
    }
    if (path === "/api/auth/tenant-public-settings") {
      return json({
        success: true,
        settings: {
          member_google_login_enabled: false,
          member_portal_login_enabled: true,
        },
      });
    }
    if (path === "/api/auth/logout") return json({ ok: true });

    if (path === "/api/public/system-settings" && method === "GET") {
      if (guestSettings === "failure" && PUBLIC_GUEST_KEYS.includes(url.searchParams.get("key"))) {
        return json({ error: "Fixture guest settings unavailable" }, 503);
      }
      if (guestSettings === "unset") return json([]);
      return json(publicSettings(settings, url));
    }
    if (path === "/api/public/navigation-items" && method === "GET") {
      if (navigationFailure) return json({ error: "Fixture navigation unavailable" }, 503);
      return json([
        {
          id: "task-4599-account-navigation",
          parent_id: null,
          location: "top_nav",
          link_type: "content_block",
          content_block_type: "account",
          display_order: 0,
        },
        {
          id: LEGACY_JOIN_ACTION_ID,
          title: "Legacy Join action",
          location: "top_nav",
          display_type: "button",
          link_type: "external",
          link_url: "https://legacy.example.invalid/should-not-be-used",
          display_order: 1,
        },
      ]);
    }
    if (path === "/api/public/tenant-branding") {
      return json({
        success: true,
        branding: {
          id: TENANT_ID,
          name: "British Nuclear Medicine Society",
          primaryColor: "#312e81",
          logoUrl: null,
          headerConfig: {
            topNavTextColor: "#ffffff",
            loginLink: loginLinkBranding,
          },
          footerConfig: {},
          platformBranding: { enabled: false },
        },
      });
    }
    if (path === "/api/public/portal-branding") return json({ homePageSlug: "home" });
    if (path === "/api/public/microsites") return json({ microsites: [] });
    if (path === "/api/public/banners") return json([HERO]);
    if (path === "/api/public/typography-styles") return json([]);
    if (path === "/api/public/installed-fonts") return json([]);
    if (path === "/api/public/favicon-url") return json({ faviconUrl: null });
    if (path === "/api/public/platform-defaults") {
      return json({ platformBrandingText: "", platformBrandingUrl: "" });
    }

    if (path === "/api/entities/SystemSettings" && method === "GET") {
      return json(structuredClone(settings));
    }
    if (path === "/api/entities/SystemSettings" && method === "POST") {
      const row = {
        id: `task-4588-created-${settings.length}`,
        tenant_id: TENANT_ID,
        ...request.postDataJSON(),
      };
      settings.push(row);
      state.writes.push({ method, key: row.setting_key, value: row.setting_value });
      return json(row);
    }
    if (path.startsWith("/api/entities/SystemSettings/") && ["PUT", "PATCH"].includes(method)) {
      const id = decodeURIComponent(path.split("/").pop());
      const patch = request.postDataJSON();
      const row = settings.find((setting) => setting.id === id);
      if (row) Object.assign(row, patch);
      state.writes.push({ method, key: row?.setting_key, value: patch.setting_value });
      return json(row || { id, ...patch });
    }

    if (path === "/api/organisation-directory/filters") {
      if (url.searchParams.get("settings") === "true") {
        if (method === "GET") return json({ fields: [], overrides: {} });
        if (method === "PUT") return json({ overrides: {} });
      }
      if (method === "GET") return json({ fields: [], allowCsvDownload: false });
      if (method === "POST") {
        return json({ fields: [], organizations: [], total: 0, page: 1, pageSize: 12 });
      }
    }
    if (path === "/api/organisation-directory/custom-object-fields") {
      return json({ sources: [] });
    }
    if (path === "/api/organisation-directory/csv-settings") {
      return json({ allowCsvDownload: false });
    }

    if (path === "/api/entities/Organization" && method === "GET") return json([]);
    if (path === "/api/entities/PreferenceField" && method === "GET") return json([]);
    if (path === "/api/entities/Role" && method === "GET") {
      return json([{ id: ADMIN.role_id, name: "Administrator", excluded_features: [] }]);
    }
    if (path.startsWith("/api/entities/Role/") && method === "GET") {
      return json({ id: ADMIN.role_id, name: "Administrator", excluded_features: [] });
    }
    if (path === "/api/entities/Member" && method === "GET") {
      return json(url.searchParams.has("filter") ? [] : [ADMIN]);
    }
    if (path.startsWith("/api/entities/Member/") && method === "GET") return json(ADMIN);

    return json([]);
  });

  return state;
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`guest directory renders a compact introduction below public chrome on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const state = await installFixture(page);
    await page.goto("/OrganisationDirectory");

    const heading = page.getByRole("heading", { name: "BNMS Organisation Directory", exact: true });
    const description = page.getByText(
      "Sign in to discover and connect with organisations across the BNMS community.",
      { exact: true },
    );
    await expect(heading).toBeVisible();
    await expect(description).toBeVisible();
    const join = page.getByTestId("link-organisation-directory-guest-join");
    await expect(join).toBeVisible();
    await expect(join).toHaveAccessibleName("Join");
    await expect(join).toHaveAttribute("href", EXTERNAL_JOIN_LINK);
    await expect(join).not.toHaveAttribute("target");

    const intro = page.getByTestId("organisation-directory-guest");
    const hero = page.locator(".hero-heading").filter({ hasText: "BNMS member organisations" });
    await expect(hero).toBeVisible();
    const introBox = await intro.boundingBox();
    const heroBox = await hero.locator("xpath=ancestor::*[contains(@class, 'hero-container')][1]").boundingBox();
    const headingBox = await heading.boundingBox();
    expect(introBox).not.toBeNull();
    expect(heroBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    expect(introBox.y).toBeGreaterThanOrEqual(heroBox.y + heroBox.height - 1);
    expect(introBox.width).toBeLessThanOrEqual(viewport.width);
    if (viewport.name === "desktop") {
      expect(introBox.width).toBeLessThan(viewport.width * 0.8);
    } else {
      expect(introBox.x).toBeGreaterThanOrEqual(0);
      expect(introBox.x + introBox.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(introBox.height).toBeLessThan(viewport.height * 0.75);
    }

    const authenticatedDirectoryRequests = state.requests.filter(({ path }) =>
      path.startsWith("/api/organisation-directory/")
      || path === "/api/entities/SystemSettings"
      || path === "/api/entities/Organization"
      || path === "/api/entities/PreferenceField"
    );
    expect(authenticatedDirectoryRequests).toEqual([]);
  });
}

for (const guestSettings of ["unset", "failure"]) {
  test(`guest directory uses safe copy fallbacks when public settings are ${guestSettings}`, async ({ page }) => {
    await installFixture(page, { guestSettings });
    await page.goto("/OrganisationDirectory");

    await expect(page.getByTestId("organisation-directory-guest")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Organisation Directory", exact: true }))
      .toBeVisible();
    await expect(page.getByText("Sign in to view the organisation directory.", { exact: true }))
      .toBeVisible();
  });
}

test("signed-in members mount the authenticated directory instead of the guest introduction", async ({ page }) => {
  const state = await installFixture(page, { authenticated: true });
  await page.goto("/OrganisationDirectory");

  await expect(page.getByTestId("organisation-directory-guest")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Organisation Directory", exact: true }))
    .toBeVisible();
  await expect.poll(() => state.requests.some(({ path }) =>
    path === "/api/organisation-directory/filters",
  )).toBe(true);
});

test("BNMS guest introduction copy saves and survives a settings-page reload", async ({ page }) => {
  const state = await installFixture(page, { authenticated: true });
  await page.goto("/OrganisationDirectorySettings");

  const heading = page.getByTestId("input-org-directory-guest-heading");
  const description = page.getByTestId("textarea-org-directory-guest-description");
  const joinLink = page.getByTestId("input-org-directory-guest-join-link");
  await expect(heading).toHaveValue("BNMS Organisation Directory");
  await expect(description).toHaveValue(
    "Sign in to discover and connect with organisations across the BNMS community.",
  );
  await expect(joinLink).toHaveValue(EXTERNAL_JOIN_LINK);

  await heading.fill("Explore the Nuclear Medicine Department Directory");
  await description.fill(
    "Find nuclear medicine departments and their contact details. Access is available to BNMS members.",
  );
  await joinLink.fill(INTERNAL_JOIN_LINK);
  await page.getByTestId("button-save-org-directory-guest-introduction").click();
  await expect(page.getByText("Settings saved successfully")).toBeVisible();

  await expect.poll(() => Object.fromEntries(
    state.settings
      .filter((setting) => GUEST_KEYS.includes(setting.setting_key))
      .map((setting) => [setting.setting_key, setting.setting_value]),
  )).toMatchObject({
    org_directory_guest_heading: "Explore the Nuclear Medicine Department Directory",
    org_directory_guest_description:
      "Find nuclear medicine departments and their contact details. Access is available to BNMS members.",
    org_directory_guest_join_link: INTERNAL_JOIN_LINK,
  });

  await page.reload();
  await expect(page.getByTestId("input-org-directory-guest-heading"))
    .toHaveValue("Explore the Nuclear Medicine Department Directory");
  await expect(page.getByTestId("textarea-org-directory-guest-description"))
    .toHaveValue(
      "Find nuclear medicine departments and their contact details. Access is available to BNMS members.",
    );
  await expect(page.getByTestId("input-org-directory-guest-join-link")).toHaveValue(INTERNAL_JOIN_LINK);

  const guestWrites = state.writes.filter((write) => GUEST_KEYS.includes(write.key));
  expect(guestWrites.map((write) => write.key).sort()).toEqual([...GUEST_KEYS].sort());
});

test("external Join link saves, reloads, and is rendered in the same tab", async ({ page }) => {
  const state = await installFixture(page, { authenticated: true, joinLink: INTERNAL_JOIN_LINK });
  await page.goto("/OrganisationDirectorySettings");

  const joinLink = page.getByTestId("input-org-directory-guest-join-link");
  await expect(joinLink).toHaveValue(INTERNAL_JOIN_LINK);
  await joinLink.fill(EXTERNAL_JOIN_LINK);
  await page.getByTestId("button-save-org-directory-guest-introduction").click();
  await expect(page.getByText("Settings saved successfully")).toBeVisible();
  await expect.poll(() => state.settings.find(
    ({ setting_key }) => setting_key === "org_directory_guest_join_link",
  )?.setting_value).toBe(EXTERNAL_JOIN_LINK);

  await page.reload();
  await expect(page.getByTestId("input-org-directory-guest-join-link")).toHaveValue(EXTERNAL_JOIN_LINK);

  state.authenticated = false;
  const guestPage = await page.context().newPage();
  await guestPage.goto("/OrganisationDirectory");
  const join = guestPage.getByTestId("link-organisation-directory-guest-join");
  await expect(join).toHaveAttribute("href", EXTERNAL_JOIN_LINK);
  await expect(join).not.toHaveAttribute("target");
  await expect(join).not.toHaveAttribute("rel");
});

test("a blank Join link saves and survives a settings-page reload", async ({ page }) => {
  const state = await installFixture(page, { authenticated: true });
  await page.goto("/OrganisationDirectorySettings");

  const joinLink = page.getByTestId("input-org-directory-guest-join-link");
  await joinLink.fill("");
  await page.getByTestId("button-save-org-directory-guest-introduction").click();
  await expect(page.getByText("Settings saved successfully")).toBeVisible();
  await expect.poll(() => state.settings.find(
    ({ setting_key }) => setting_key === "org_directory_guest_join_link",
  )?.setting_value).toBe("");

  await page.reload();
  await expect(page.getByTestId("input-org-directory-guest-join-link")).toHaveValue("");
});

test("internal Join link uses client routing without opening another tab", async ({ page }) => {
  await installFixture(page, { joinLink: INTERNAL_JOIN_LINK });
  await page.goto("/OrganisationDirectory");

  const join = page.getByTestId("link-organisation-directory-guest-join");
  await expect(join).toHaveAttribute("href", INTERNAL_JOIN_LINK);
  await expect(join).not.toHaveAttribute("target");
  await expect(join).not.toHaveAttribute("rel");
});

for (const joinLink of ["", "not a valid join destination"]) {
  test(`guest directory hides Join for ${joinLink ? "an invalid" : "a blank"} link and ignores the legacy action ID`, async ({ page }) => {
    await installFixture(page, { joinLink });
    await page.goto("/OrganisationDirectory");

    await expect(page.getByTestId("organisation-directory-guest")).toBeVisible();
    await expect(page.getByTestId("link-organisation-directory-guest-join")).toHaveCount(0);
  });
}

test("navigation failure does not block guest settings or its Join CTA", async ({ page }) => {
  const state = await installFixture(page, { authenticated: true, navigationFailure: true });
  await page.goto("/OrganisationDirectorySettings");

  const joinLink = page.getByTestId("input-org-directory-guest-join-link");
  await expect(joinLink).toHaveValue(EXTERNAL_JOIN_LINK);
  await joinLink.fill(INTERNAL_JOIN_LINK);
  await page.getByTestId("button-save-org-directory-guest-introduction").click();
  await expect(page.getByText("Settings saved successfully")).toBeVisible();
  await expect.poll(() => state.writes.some(
    ({ key, value }) => key === "org_directory_guest_join_link" && value === INTERNAL_JOIN_LINK,
  )).toBe(true);

  state.authenticated = false;
  const guestPage = await page.context().newPage();
  await guestPage.goto("/OrganisationDirectory");
  const join = guestPage.getByTestId("link-organisation-directory-guest-join");
  await expect(join).toHaveAttribute("href", INTERNAL_JOIN_LINK);
  await expect(join).not.toHaveAttribute("target");
});

test("Join CTA has style parity with the branded desktop header login action", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installFixture(page);
  await page.goto("/OrganisationDirectory");

  const headerLogin = page.getByTestId("link-header-login");
  const join = page.getByTestId("link-organisation-directory-guest-join");
  await expect(headerLogin).toBeVisible();
  await expect(join).toBeVisible();

  const styleSnapshot = (locator) => locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundImage: style.backgroundImage,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      borderStyle: style.borderStyle,
      borderWidth: style.borderWidth,
      color: style.color,
      height: style.height,
      width: style.width,
    };
  });
  expect(await styleSnapshot(join)).toEqual(await styleSnapshot(headerLogin));
});

test("default plain Join link contrasts with the light guest surface without changing header login", async ({ page }) => {
  await installFixture(page, { loginLinkBranding: {} });
  await page.goto("/OrganisationDirectory");
  const join = page.getByTestId("link-organisation-directory-guest-join");
  await expect(join).toBeVisible();
  await expect(join).toHaveText("Join");
  await expect(join).toHaveCSS("color", "rgb(15, 23, 42)");
  const headerLogin = page.getByTestId("link-header-login");
  await expect(headerLogin).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(headerLogin).toHaveAttribute("href", "/login?returnTo=%2FOrganisationDirectory");
});
