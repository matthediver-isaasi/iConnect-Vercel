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
const JOIN_ACTION = {
  id: "task-4588-join-action",
  title: "Join BNMS",
  location: "top_nav",
  display_type: "button",
  link_type: "external",
  link_url: "https://www.bnms.org.uk/join",
  display_order: 1,
};
const GUEST_KEYS = [
  "org_directory_guest_heading",
  "org_directory_guest_description",
  "org_directory_guest_join_action_id",
];
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
  ["org_directory_guest_join_action_id", JOIN_ACTION.id],
].map(([setting_key, setting_value], index) => ({
  id: `task-4588-setting-${index}`,
  tenant_id: TENANT_ID,
  setting_key,
  setting_value,
  description: "",
}));

function publicSettings(settings, url) {
  const key = url.searchParams.get("key");
  const rows = settings.filter((setting) => GUEST_KEYS.includes(setting.setting_key));
  return key ? rows.filter((setting) => setting.setting_key === key) : rows;
}

async function installFixture(page, {
  authenticated = false,
  guestSettings = "configured",
} = {}) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const state = {
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

    if (path === "/api/auth/me") return json(authenticated ? ADMIN : null, authenticated ? 200 : 401);
    if (path === "/api/auth/tenant-user-me") {
      return json(authenticated
        ? {
          authenticated: true,
          user: ADMIN,
          tenantUser: ADMIN,
          tenant: { id: TENANT_ID, name: "British Nuclear Medicine Society", slug: "bnms" },
        }
        : { authenticated: false }, authenticated ? 200 : 401);
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
      if (guestSettings === "failure" && GUEST_KEYS.includes(url.searchParams.get("key"))) {
        return json({ error: "Fixture guest settings unavailable" }, 503);
      }
      if (guestSettings === "unset") return json([]);
      return json(publicSettings(settings, url));
    }
    if (path === "/api/public/navigation-items" && method === "GET") {
      return json([JOIN_ACTION]);
    }
    if (path === "/api/public/tenant-branding") {
      return json({
        success: true,
        branding: {
          id: TENANT_ID,
          name: "British Nuclear Medicine Society",
          primaryColor: "#312e81",
          logoUrl: null,
          headerConfig: {},
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
    await expect(page.getByRole("link", { name: "Join BNMS", exact: true })).toBeVisible();

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
  await expect(heading).toHaveValue("BNMS Organisation Directory");
  await expect(description).toHaveValue(
    "Sign in to discover and connect with organisations across the BNMS community.",
  );

  await heading.fill("Explore the Nuclear Medicine Department Directory");
  await description.fill(
    "Find nuclear medicine departments and their contact details. Access is available to BNMS members.",
  );
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
    org_directory_guest_join_action_id: JOIN_ACTION.id,
  });

  await page.reload();
  await expect(page.getByTestId("input-org-directory-guest-heading"))
    .toHaveValue("Explore the Nuclear Medicine Department Directory");
  await expect(page.getByTestId("textarea-org-directory-guest-description"))
    .toHaveValue(
      "Find nuclear medicine departments and their contact details. Access is available to BNMS members.",
    );

  const guestWrites = state.writes.filter((write) => GUEST_KEYS.includes(write.key));
  expect(guestWrites.map((write) => write.key).sort()).toEqual([...GUEST_KEYS].sort());
});