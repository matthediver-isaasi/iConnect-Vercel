import { expect } from "@playwright/test";

export const FIXTURE_MEMBER = {
  id: "fixture-member",
  email: "member@example.invalid",
  tenant_id: "fixture-tenant",
  role_id: "fixture-role",
  member_excluded_features: [],
};

export const FIXTURE_RESTRICTED_MEMBER = {
  ...FIXTURE_MEMBER,
  id: "fixture-restricted-member",
  email: "restricted@example.invalid",
  role_id: "fixture-restricted-role",
};

export function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

export async function installMemberGroupCardsFixture(page, {
  fixturePage,
  fixtureSymbols = [],
  groups,
  audience = "guest",
  holdGroups = false,
  holdAssets = false,
  assetPrefix = "/member-group-cards-fixture/",
} = {}) {
  const groupGate = deferred();
  const assetGate = deferred();
  if (!holdGroups) groupGate.release();
  if (!holdAssets) assetGate.release();
  const state = {
    audience,
    reads: [],
    writes: [],
    errors: [],
    releaseGroups: groupGate.release,
    releaseAssets: assetGate.release,
    setAudience(nextAudience) {
      state.audience = nextAudience;
    },
  };
  page.on("pageerror", (error) => state.errors.push(error.message));

  if (audience !== "guest") {
    await page.addInitScript((member) => {
      localStorage.setItem("agcas_member", JSON.stringify(member));
    }, audience === "restricted" ? FIXTURE_RESTRICTED_MEMBER : FIXTURE_MEMBER);
  }

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.startsWith(`${assetPrefix}image-`)) {
      await assetGate.promise;
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="200"><rect width="500" height="200" fill="#dbeafe"/></svg>',
      });
    }
    if (path === `${assetPrefix}late-font.woff2`) {
      await assetGate.promise;
      return route.fulfill({
        status: 200,
        contentType: "font/woff2",
        path: "node_modules/@fortawesome/fontawesome-free/webfonts/fa-regular-400.woff2",
      });
    }
    if (!path.startsWith("/api/")) return route.continue();
    state.reads.push(`${request.method()} ${path}${url.search}`);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.writes.push(`${request.method()} ${path}`);
      return json(route, { error: "read-only fixture" }, 405);
    }

    const activeMember = state.audience === "restricted"
      ? FIXTURE_RESTRICTED_MEMBER
      : FIXTURE_MEMBER;
    if (path === "/api/auth/me") {
      return state.audience === "guest" ? json(route, null, 401) : json(route, activeMember);
    }
    if (path === "/api/auth/tenant-user-me") {
      return state.audience === "guest"
        ? json(route, { authenticated: false }, 401)
        : json(route, { user: activeMember, tenant: { id: activeMember.tenant_id } });
    }
    if (path === `/api/entities/Member/${activeMember.id}`) return json(route, activeMember);
    if (path === `/api/entities/Role/${activeMember.role_id}`) {
      return json(route, {
        id: activeMember.role_id,
        name: "Fixture role",
        excluded_features: state.audience === "restricted"
          ? ["membership.member-group-access"]
          : [],
      });
    }
    if (path === "/api/entities/Role") return json(route, []);
    if (path === "/api/entities/MemberGroup" || path === "/api/public/member-groups") {
      await groupGate.promise;
      return json(route, groups);
    }
    if (path === "/api/entities/Vacancy" || path === "/api/entities/MemberGroupAssignment") {
      return json(route, []);
    }
    if (path.startsWith("/api/public/page/")) {
      return json(route, {
        success: true,
        page: fixturePage,
        elements: [],
        symbols: fixtureSymbols,
      });
    }
    if (path === "/api/public/tenant-branding") {
      return json(route, {
        success: true,
        branding: {
          id: "fixture-tenant",
          name: "Browser fixture",
          headerConfig: {},
          footerConfig: {},
        },
      });
    }
    if (path === "/api/public/microsites") return json(route, { microsites: [] });
    if (path === "/api/public/navigation-items"
      || path === "/api/public/canvas-symbols"
      || path === "/api/public/typography-styles"
      || path === "/api/public/installed-fonts"
      || path === "/api/public/system-settings"
      || path === "/api/entities/TypographyStyle"
      || path === "/api/public/banners") return json(route, []);
    if (path === "/api/public/favicon-url") return json(route, { faviconUrl: null });
    if (path === "/api/public/platform-defaults"
      || path === "/api/public/portal-branding"
      || path === "/api/tenant-canvas-theme") return json(route, {});
    return json(route, []);
  });
  return state;
}

export async function memberGroupCardsBounds(page, {
  cardId,
  ownerId,
  followingId,
  terminalId,
}) {
  return page.evaluate(({
    cardId: card,
    ownerId: owner,
    followingId: following,
    terminalId: terminal,
  }) => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value && {
        top: value.top + scrollY,
        bottom: value.bottom + scrollY,
        left: value.left,
        height: value.height,
        width: value.width,
      };
    };
    const outer = document.querySelector(`[data-cb="${card}"]`);
    const style = outer && getComputedStyle(outer);
    const cardRects = [...document.querySelectorAll(
      `[data-cb="${card}"] [data-member-group-cards-grid] > *`,
    )].map((element) => {
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top };
    });
    return {
      outer: rect(`[data-cb="${card}"]`),
      grid: rect(`[data-cb="${card}"] [data-member-group-cards-grid]`),
      owner: rect(`[data-cb="${owner}"]`),
      following: rect(`[data-cb="${following}"]`),
      terminal: terminal ? rect(`[data-cb="${terminal}"]`) : null,
      stage: rect(".canvas-stage"),
      cardRects,
      paddingTop: style ? parseFloat(style.paddingTop) : NaN,
      paddingBottom: style ? parseFloat(style.paddingBottom) : NaN,
    };
  }, {
    cardId,
    ownerId,
    followingId,
    terminalId,
  });
}

export async function expectGridColumns(page, ids, expectedColumns) {
  const value = await memberGroupCardsBounds(page, ids);
  const firstTop = value.cardRects[0]?.top;
  const firstRow = value.cardRects.filter((rect) => Math.abs(rect.top - firstTop) < 2);
  expect(firstRow).toHaveLength(expectedColumns);
  expect(new Set(firstRow.map((rect) => Math.round(rect.left))).size).toBe(expectedColumns);
  return value;
}