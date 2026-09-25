import { test, expect } from "@playwright/test";

/*
 * Task 4511 isolated browser evidence.
 *
 * Every root-level /api request is intercepted below. The people, membership
 * dates and payment arrangements in this file are synthetic fixture records;
 * this suite never reads or mutates production membership data.
 */
const TENANT = { id: "tenant-task4511", slug: "task4511-fixture", name: "Canvas membership fixture" };
const MICROSITE = { id: "microsite-task4511", path_prefix: "members", name: "Fixture members site" };
const ROLE = { id: "role-task4511", name: "Fixture member", excluded_features: [] };
const VIEWERS = {
  alpha: {
    id: "member-task4511-alpha", email: "alpha.task4511@example.invalid",
    first_name: "Alpha", last_name: "Fixture", tenant_id: TENANT.id,
    role_id: ROLE.id, organization_id: "org-task4511", member_excluded_features: [],
  },
  beta: {
    id: "member-task4511-beta", email: "beta.task4511@example.invalid",
    first_name: "Beta", last_name: "Fixture", tenant_id: TENANT.id,
    role_id: ROLE.id, organization_id: "org-task4511", member_excluded_features: [],
  },
};
const SUMMARIES = {
  alpha: {
    membership: { state: "active", memberSince: null, membershipType: "Professional — Alpha" },
    payment: {
      state: "active", method: "monthly_direct_debit", nextPayment: "2031-11-03",
      amount: 18.5, currency: "GBP", collectionStatus: "confirmed",
      nextCollection: { date: "2031-11-03", amount: 18.5, currency: "GBP", status: "confirmed" },
      plannedPayment: null, confirmedPayment: null, mandateStatus: "active",
    },
  },
  beta: {
    membership: { state: "paused", memberSince: null, membershipType: "Associate — Beta" },
    payment: {
      state: "failed", method: "card", nextPayment: null, amount: 22, currency: "GBP",
      collectionStatus: "unscheduled", plannedPayment: null, confirmedPayment: null,
      nextCollection: null, mandateStatus: null,
    },
  },
};
const TYPOGRAPHY = [
  {
    id: "type-task4511-heading", name: "Fixture display", style_name: "Fixture display",
    style_type: "h2", is_active: true, microsite_id: null,
    font_family: "Georgia", font_size: 34, font_size_mobile: 23,
    font_weight: "700", line_height: 1.15, color: "#243b53",
  },
  {
    id: "type-task4511-body", name: "Fixture body", style_name: "Fixture body",
    style_type: "paragraph", is_active: true, microsite_id: null,
    font_family: "Arial", font_size: 18, font_size_mobile: 15,
    font_weight: "400", line_height: 1.55, color: "#334e68",
  },
];
const MICROSITE_TYPOGRAPHY = [
  ...TYPOGRAPHY,
  {
    id: "type-task4511-microsite-heading", name: "Members site display", style_name: "Members site display",
    style_type: "h2", is_active: true, microsite_id: MICROSITE.id,
    font_family: "Courier New", font_size: 32, font_size_mobile: 21,
    font_weight: "600", line_height: 1.25, color: "#6b214e",
  },
  {
    id: "type-task4511-other-site", name: "Other site display", style_name: "Other site display",
    style_type: "h2", is_active: true, microsite_id: "microsite-other-task4511",
    font_family: "Impact", font_size: 41, font_size_mobile: 27,
    font_weight: "700", line_height: 1.1, color: "#111111",
  },
];

function json(route, body, status = 200, headers = {}) {
  return route.fulfill({
    status, contentType: "application/json", headers, body: JSON.stringify(body),
  });
}

function membershipContent(type, overrides = {}) {
  const payment = type === "payment-details";
  return {
    eyebrow: payment ? "PAYMENT DETAILS" : "YOUR MEMBERSHIP",
    states: Object.fromEntries([
      ["active", payment
        ? { heading: "Your payment method", supporting: "Your membership payment is set up", status: "Active" }
        : { heading: "Membership Active", supporting: "Thank you for being a valued member.", status: "Active" }],
      ["pending", { heading: payment ? "Payment setup pending" : "Membership pending", supporting: "Pending details.", status: "Pending" }],
      ["paused", { heading: payment ? "Payments paused" : "Membership paused", supporting: "This arrangement is currently paused.", status: "Paused" }],
      ["expired", { heading: payment ? "Payment arrangement expired" : "Membership expired", supporting: "This arrangement has expired.", status: "Expired" }],
      ["failed", { heading: payment ? "Payment needs attention" : "Membership needs attention", supporting: "Please review your payment details.", status: "Payment failed" }],
      ["unavailable", { heading: payment ? "Payment details unavailable" : "Membership details unavailable", supporting: "Details are unavailable.", status: "Unavailable" }],
      ["none", { heading: payment ? "No payment arrangement" : "No current membership", supporting: "Nothing to display.", status: payment ? "Not set up" : "No membership" }],
    ]),
    fields: {
      memberSince: "Member since", membershipType: "Membership type",
      method: "Payment method", nextPayment: "Next payment",
    },
    methods: {
      direct_debit: "Direct Debit", monthly_direct_debit: "Monthly Direct Debit",
      card: "Card", monthly_card: "Monthly card", bank_transfer: "Bank transfer",
      invoice: "Invoice", unavailable: "Unavailable",
    },
    messages: {
      loading: "Loading your membership details…",
      guest: "Sign in to view your membership details.",
      denied: "You do not have permission to view these details.",
      error: "Your membership details could not be loaded. Please try again later.",
      missing: "Not available",
    },
    typography: {
      eyebrow: "", heading: "type-task4511-heading", supporting: "type-task4511-body",
      fieldLabel: "", value: "", status: "", link: "",
    },
    manageLink: payment ? "/MembershipFees" : "",
    manageLinkText: "Manage payments",
    manageLinkNewTab: false,
    panel: { background: "#f4faf6", borderColor: "#c4e6d1", borderWidth: 2, borderRadius: 6 },
    ...overrides,
  };
}

function block(type, id, y = 0, overrides = {}) {
  const h = type === "payment-details" ? 330 : 300;
  return {
    id, type, name: type === "payment-details" ? "Payment Details" : "Membership Summary",
    geom: { x: 0, y, w: 940, h },
    bp: {
      desktop: { x: 0, y, w: 940, h },
      tablet: { x: 0, y, w: 700, h },
      mobile: { x: 0, y, w: 343, h },
    },
    style: {
      background: "#ffffff", borderColor: "#d7dde5", borderWidth: 1,
      borderStyle: "solid", borderRadius: 10, boxShadow: "sm", opacity: 1, zIndex: 1,
      paddingTop: 28, paddingRight: 28, paddingBottom: 28, paddingLeft: 28,
    },
    content: membershipContent(type),
    ...overrides,
  };
}

function design(version, {
  empty = false, duplicate = false, symbol = false, microsite = false,
  membershipMinHeight, longMembershipContent = false,
} = {}) {
  let children = empty ? [] : [
    block("membership-summary", `membership-v${version}`, 0),
    block("payment-details", `payment-v${version}`, 350),
  ];
  if (membershipMinHeight !== undefined) {
    children = children.map(item => (
      item.type === "membership-summary" || item.type === "payment-details"
        ? { ...item, content: { ...item.content, minHeight: membershipMinHeight } }
        : item
    ));
  }
  if (longMembershipContent) {
    children = children.map(item => {
      if (item.type !== "membership-summary") return item;
      const active = item.content.states.active;
      return { ...item, content: { ...item.content, states: {
        ...item.content.states,
        active: {
          ...active,
          heading: "A deliberately long membership heading that wraps across several lines on a narrow screen without being clipped",
          supporting: "This deliberately long supporting message verifies that content remains authoritative when it needs more room than the configured minimum height. The card must grow, settle, and push every downstream block below its final rendered edge.",
        },
      } } };
    });
  }
  if (duplicate) {
    children.push(block("membership-summary", `membership-copy-v${version}`, 700, {
      content: membershipContent("membership-summary", { eyebrow: "SECOND INDEPENDENT CARD" }),
    }));
  }
  if (microsite) {
    children = children.map(item => item.type === "membership-summary" || item.type === "payment-details"
      ? { ...item, content: { ...item.content, typography: {
        eyebrow: "", heading: "", supporting: "", fieldLabel: "", value: "", status: "", link: "",
      } } }
      : item);
  }
  if (symbol) {
    children.push({
      id: `symbol-v${version}`, type: "symbol", name: "Membership symbol",
      geom: { x: 0, y: 1050, w: 940, h: 100 },
      bp: {
        desktop: { x: 0, y: 1050, w: 940, h: 100 },
        tablet: { x: 0, y: 1050, w: 700, h: 100 },
        mobile: { x: 0, y: 1050, w: 343, h: 100 },
      },
      style: { background: "transparent", borderWidth: 0, borderStyle: "none", opacity: 1 },
      content: { symbolId: "symbol-task4511" },
    });
  }
  if (version === 2) {
    children = children.map(item => ({
      ...item, layoutMode: "flow",
      flow: { heightMode: item.type === "symbol" ? "auto" : "auto", flex: "none" },
    }));
  }
  return {
    version,
    root: {
      background: null, groups: [], guides: { vertical: [], horizontal: [] },
      ...(version === 2 ? { layout: "flow" } : {}),
      sections: [{
        id: `section-task4511-v${version}`, type: "section",
        ...(version === 2 ? {
          layoutMode: "flow", flow: { direction: "column", gap: 20, align: "stretch" },
        } : {}),
        children,
      }],
    },
  };
}

function pageFixture(version, options = {}) {
  return {
    id: `canvas-membership-task4511-v${version}`,
    title: `Canvas membership fixture V${version}`,
    slug: `task4511-membership-v${version}`,
    status: "published", builder_type: "canvas", layout_type: "public",
    public_chrome: "full", tenant_id: TENANT.id,
    ...(options.microsite ? { microsite_id: MICROSITE.id } : {}),
    canvas_design: design(version, options),
  };
}

function symbolFixture(minHeight) {
  return {
    id: "symbol-task4511",
    design: {
      version: 1,
      root: {
        sections: [{
          id: "symbol-section-task4511", type: "section",
          children: [{
            ...block("membership-summary", "symbol-membership-task4511"),
            content: membershipContent("membership-summary", {
              ...(minHeight !== undefined ? { minHeight } : {}),
              eyebrow: "SYMBOL MEMBERSHIP",
              states: {
                ...membershipContent("membership-summary").states,
                active: {
                  heading: "A deliberately long symbol membership heading which reflows",
                  supporting: "Long asynchronous member content must expand the symbol rather than clip its values.",
                  status: "Active",
                },
              },
            }),
          }],
        }],
      },
    },
  };
}

async function installFixtures(page, {
  version = 1, viewer = "alpha", apiState = "ready", empty = false,
  duplicate = false, symbol = false, microsite = false,
  summaryOverride = null, membershipMinHeight, longMembershipContent = false,
  symbolMinHeight,
} = {}) {
  const fixturePage = pageFixture(version, {
    empty, duplicate, symbol, microsite, membershipMinHeight, longMembershipContent,
  });
  const requests = [];
  const writes = [];
  const pageErrors = [];
  const consoleErrors = [];
  let savedDesign = fixturePage.canvas_design;
  let releaseLoading;
  let loadingReleased = apiState !== "loading";
  const loadingGate = new Promise(resolve => { releaseLoading = () => { loadingReleased = true; resolve(); }; });

  if (viewer !== "guest") {
    await page.addInitScript(member => {
      localStorage.setItem("agcas_member", JSON.stringify(member));
    }, VIEWERS[viewer]);
  }
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    requests.push({ path, method, tenant: request.headers()["x-tenant-id"] || null });

    const member = viewer === "guest" ? null : VIEWERS[viewer];
    if (path === "/api/auth/me") return member ? json(route, member) : json(route, {}, 401);
    if (path === "/api/auth/tenant-user-me") {
      return member
        ? json(route, { ...member, tenant: TENANT, tenantId: TENANT.id, memberId: member.id })
        : json(route, {}, 401);
    }
    if (path === "/api/auth/tenant-public-settings") {
      return json(route, { success: true, settings: { member_portal_login_enabled: true } });
    }
    if (path === `/api/entities/Role/${ROLE.id}`) return json(route, ROLE);
    if (member && path === `/api/entities/Member/${member.id}`) return json(route, member);
    if (path === "/api/entities/Member") return json(route, member ? [member] : []);
    if (path === "/api/entities/Role") return json(route, [ROLE]);
    if (path === "/api/entities/Organization" || path.includes("/Organization/")) {
      return json(route, [{ id: "org-task4511", name: "Fixture organisation" }]);
    }
    if (path === "/api/entities/TypographyStyle") return json(route, microsite ? MICROSITE_TYPOGRAPHY : TYPOGRAPHY);
    if (path === "/api/entities/IEditPage") return json(route, [{ ...fixturePage, canvas_design: savedDesign }]);
    if (path === `/api/public/page/${fixturePage.slug}`) {
      return json(route, {
        success: true, page: { ...fixturePage, canvas_design: savedDesign },
        elements: [], symbols: symbol ? [symbolFixture(symbolMinHeight)] : [],
      }, 200, { "Cache-Control": "private, no-store" });
    }
    if (path === "/api/public/canvas-symbols") {
      return json(route, { symbols: symbol ? [symbolFixture(symbolMinHeight)] : [] });
    }
    if (path === "/api/public/typography-styles") return json(route, microsite ? MICROSITE_TYPOGRAPHY : TYPOGRAPHY);
    if (path === "/api/public/microsites") return json(route, microsite ? [MICROSITE] : []);
    if (path === "/api/public/navigation-items") return json(route, []);
    if (path === "/api/public/tenant-branding") {
      return json(route, { success: true, branding: { tenant: TENANT, tenantSlug: TENANT.slug } });
    }
    if (path === "/api/public/system-settings") return json(route, []);
    if (path === `/api/canvas-design/${fixturePage.id}` && method === "GET") {
      return json(route, { page: { ...fixturePage, canvas_design: savedDesign } });
    }
    if (path === `/api/canvas-design/${fixturePage.id}` && method === "PUT") {
      const body = request.postDataJSON();
      writes.push({ path, method, body });
      savedDesign = body.canvas_design;
      return json(route, { page: { ...fixturePage, canvas_design: savedDesign } });
    }
    if (path === "/api/membership/canvas-summary") {
      if (apiState === "loading" && !loadingReleased) await loadingGate;
      if (apiState === "denied") return json(route, { error: "Forbidden" }, 403);
      if (apiState === "error") return json(route, { error: "Fixture failure" }, 500);
      if (apiState === "none") {
        return json(route, {
          membership: { state: "none", memberSince: null, membershipType: null },
          payment: { state: "none", method: "unavailable", nextPayment: null },
        });
      }
      return member ? json(route, summaryOverride || SUMMARIES[viewer]) : json(route, { error: "Sign in required" }, 401);
    }
    if (path.startsWith("/api/canvas-versions/")) {
      if (method !== "GET") writes.push({ path, method, body: request.postDataJSON?.() });
      return json(route, method === "GET" ? { versions: [] } : { version: {} });
    }
    if (path.startsWith("/api/canvas-page-audits/")) {
      return json(route, method === "GET" ? { audits: [] } : { audit: {} });
    }
    if (method === "GET") {
      if (path.includes("branding") || path.includes("settings")) return json(route, { tenant: TENANT, branding: {} });
      return json(route, []);
    }
    writes.push({ path, method, body: request.postDataJSON?.() });
    return json(route, { error: "Unexpected isolated-fixture mutation" }, 405);
  });
  return {
    fixturePage, requests, writes, pageErrors, consoleErrors,
    releaseLoading, getSavedDesign: () => savedDesign,
  };
}

function diagnostics(fixture) {
  return `\nPage errors: ${JSON.stringify(fixture.pageErrors)}`
    + `\nConsole errors: ${JSON.stringify(fixture.consoleErrors)}`
    + `\nFixture requests: ${JSON.stringify(fixture.requests.slice(-50))}`;
}

async function openPublished(page, fixture) {
  await page.goto(`/${fixture.fixturePage.slug}`);
  try {
    await expect(page.locator("[data-block-type='membership-summary']").first()).toBeVisible();
  } catch (error) {
    error.message += diagnostics(fixture);
    throw error;
  }
}

async function assertAlphaData(page) {
  const membership = page.getByTestId("canvas-membership-summary").first();
  const payment = page.getByTestId("canvas-payment-details").first();
  await expect(membership).toContainText("Your membership");
  await expect(membership).toContainText("Join date not recorded");
  await expect(membership).toContainText("£18.50");
  await expect(membership).toContainText("Monthly Direct Debit");
  await expect(membership).toContainText("3 November 2031");
  await expect(payment).toContainText("Payment details");
  await expect(payment.getByTestId("membership-payment-panel")).toContainText("Confirmed payment date");
  await expect(payment.getByTestId("membership-payment-panel")).toContainText("Direct Debit status");
  await expect(payment.getByRole("link", { name: /Manage payments/ })).toHaveAttribute("href", "/MembershipFees");
}

async function membershipLayout(page) {
  const membership = page.locator("[data-block-type='membership-summary']").first();
  const payment = page.locator("[data-block-type='payment-details']").first();
  return page.evaluate(({ membershipNode, paymentNode }) => {
    const box = node => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top, bottom: rect.bottom, height: rect.height,
        clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
      };
    };
    return {
      membership: box(membershipNode),
      payment: box(paymentNode),
      membershipMinHeight: getComputedStyle(
        membershipNode.querySelector("[data-membership-card]"),
      ).minHeight,
      paymentMinHeight: getComputedStyle(
        paymentNode.querySelector("[data-membership-card]"),
      ).minHeight,
    };
  }, {
    membershipNode: await membership.elementHandle(),
    paymentNode: await payment.elementHandle(),
  });
}

async function dragPaletteBlock(page, type, targetY) {
  const source = page.getByTestId(`palette-item-${type}`);
  const target = page.getByTestId("canvas-stage");
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).toBeTruthy();
  expect(targetBox).toBeTruthy();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  // dnd-kit uses pointer sensors; several intermediate moves are required to
  // cross its activation threshold and establish a real stage drop position.
  await page.mouse.move(targetBox.x + Math.min(300, targetBox.width / 2), targetBox.y + targetY, { steps: 20 });
  await page.mouse.up();
}

for (const version of [1, 2]) {
  test(`isolated V${version} current dynamic DD projects collection without implying payment confirmation`, async ({ page }, testInfo) => {
    const fixture = await installFixtures(page, { version, summaryOverride: {
      membership: { state: "active", memberSince: null, membershipType: "Flat Rate" },
      payment: {
        state: "current_direct_debit", method: "monthly_direct_debit", mandateStatus: "active",
        amount: 13, currency: "GBP", nextPayment: "2026-10-01", collectionStatus: "planned",
        nextCollection: { date: "2026-10-01", amount: 13, currency: "GBP", status: "planned" },
        collectionBasis: "projected", collectionNotice: "Projected collection amount — not yet bank scheduled",
        collectionStructure: "2026-2027 Full member with NMC",
        structureNotice: "Structure effective on planned collection date",
      },
    } });
    await openPublished(page, fixture);
    const payment = page.getByTestId("canvas-payment-details").first();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(payment).toContainText("Projected next payment amount");
      await expect(payment).toContainText("£13.00");
      await expect(payment).toContainText("1 October 2026");
      await expect(payment).toContainText("Planned payment date");
      await expect(payment).toContainText("2026-2027 Full member with NMC");
      // The simplified card retains the projected label, not supporting copy.
      await expect(payment).not.toContainText("not yet bank scheduled");
      await expect(payment).not.toContainText("Your membership is current");
      await expect(payment).not.toContainText("awaiting confirmation");
      await expect(payment).not.toContainText("paid in full");
      await page.screenshot({ path: testInfo.outputPath(`dynamic-dd-v${version}-${width}.png`), fullPage: true });
    }
    expect(fixture.writes).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  });

  test(`isolated V${version} attested upfront membership displays valid until without a renewal promise`, async ({ page }, testInfo) => {
    const fixture = await installFixtures(page, { version, summaryOverride: {
      membership: { state: "active", memberSince: null, membershipType: "Full Membership UK", expiryDate: "2026-10-16", renewalDate: null },
      payment: { state: "paid", method: "upfront", amount: null, nextPayment: null },
    } });
    await openPublished(page, fixture);
    const payment = page.getByTestId("canvas-payment-details").first();
    const membership = page.getByTestId("canvas-membership-summary").first();
    for (const card of [payment, membership]) {
      await expect(card).toContainText("Membership valid until");
      await expect(card).toContainText("16 October 2026");
      await expect(card).not.toContainText("unavailable");
      await expect(card).not.toContainText("Renewal date");
      await expect(card).not.toContainText("Next payment amount");
    }
    await expect(payment).toContainText("Upfront");
    await page.screenshot({ path: testInfo.outputPath(`attested-upfront-v${version}.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(payment).toContainText("16 October 2026");
    expect(fixture.writes).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  });

  test(`isolated V${version} paid upfront membership shows settlement and renewal, not an unavailable plan`, async ({ page }, testInfo) => {
    const fixture = await installFixtures(page, { version, summaryOverride: {
      membership: { state: "active", memberSince: "2026-09-18", membershipType: "Flat Rate", renewalDate: "2027-09-18" },
      payment: { state: "paid", method: "card", nextPayment: null },
    } });
    await openPublished(page, fixture);
    const membership = page.getByTestId("canvas-membership-summary").first();
    const payment = page.getByTestId("canvas-payment-details").first();
    await expect(membership).toContainText("Your membership");
    await expect(membership).not.toContainText("Next payment amount");
    await expect(membership).not.toContainText("18 September 2027");
    await expect(payment).toContainText("Payment details");
    await expect(payment).not.toContainText("Next payment amount");
    await expect(payment).not.toContainText("payment is set up");
    await page.screenshot({ path: testInfo.outputPath(`paid-upfront-v${version}.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(payment).not.toContainText("Next payment amount");
    expect(fixture.writes).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  });

  test(`isolated V${version} desktop/mobile published cards use live fixture data`, async ({ page }, testInfo) => {
    const fixture = await installFixtures(page, { version, viewer: "alpha" });
    await openPublished(page, fixture);
    await assertAlphaData(page);
    expect(fixture.requests.filter(item => item.path === "/api/membership/canvas-summary").length).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath(`isolated-v${version}-desktop-membership-reference.png`),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await assertAlphaData(page);
    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: window.innerWidth,
      cards: [...document.querySelectorAll("[data-membership-card]")]
        .map(node => ({ width: node.scrollWidth, client: node.clientWidth })),
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);
    expect(overflow.cards.every(card => card.width <= card.client + 1)).toBe(true);
    const fields = page.getByTestId("canvas-membership-summary").first().locator(".membership-fields");
    const columns = await fields.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath(`isolated-v${version}-mobile-membership-reference.png`),
      fullPage: true,
    });
    expect(fixture.writes).toEqual([]);
  });

  test(`isolated V${version} responsive minimum height equalises outer cards and reflows downstream`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const fixture = await installFixtures(page, {
      version,
      membershipMinHeight: { desktop: 700, tablet: 680, mobile: 700 },
    });
    await openPublished(page, fixture);
    let layout = await membershipLayout(page);
    expect(layout.membership.height).toBeGreaterThanOrEqual(700);
    expect(Math.abs(layout.membership.height - layout.payment.height)).toBeLessThanOrEqual(1);
    expect(layout.payment.top).toBeGreaterThanOrEqual(layout.membership.bottom - 1);
    expect(layout.membership.scrollHeight).toBeLessThanOrEqual(layout.membership.clientHeight + 1);
    expect(layout.payment.scrollHeight).toBeLessThanOrEqual(layout.payment.clientHeight + 1);
    await page.screenshot({
      path: testInfo.outputPath(`responsive-minimum-height-v${version}-desktop.png`),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await assertAlphaData(page);
    layout = await membershipLayout(page);
    expect(layout.membership.height).toBeGreaterThanOrEqual(700);
    expect(Math.abs(layout.membership.height - layout.payment.height)).toBeLessThanOrEqual(1);
    expect(layout.payment.top).toBeGreaterThanOrEqual(layout.membership.bottom - 1);
    await page.screenshot({
      path: testInfo.outputPath(`responsive-minimum-height-v${version}-mobile.png`),
      fullPage: true,
    });
    expect(fixture.writes).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  });
}

test("isolated published payment details with no arrangement remove outer chrome and layout slot while editor remains selectable", async ({ browser }) => {
  for (const version of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const fixture = await installFixtures(page, {
      version,
      viewer: "alpha",
      duplicate: true,
      summaryOverride: {
        membership: { state: "active", memberSince: null, membershipType: "Professional — Alpha" },
        payment: {
          state: "none", method: "unavailable", nextPayment: null, amount: null,
          currency: null, collectionStatus: "unavailable", plannedPayment: null,
          confirmedPayment: null, nextCollection: null, mandateStatus: null,
        },
      },
    });

    await openPublished(page, fixture);
    const firstCard = page.locator("[data-block-type='membership-summary']").first();
    const paymentWrapper = page.locator("[data-block-type='payment-details']").first();
    const followingCard = page.locator("[data-block-type='membership-summary']").nth(1);
    await expect(paymentWrapper).toBeHidden();
    await expect(followingCard).toBeVisible();
    const gapAfterFirstCard = async () => {
      const [first, following] = await Promise.all([
        firstCard.boundingBox(),
        followingCard.boundingBox(),
      ]);
      return following.y - (first.y + first.height);
    };
    // V1 closes the removed signed-auto-height row through reflow; V2 removes
    // the hidden flex item. Neither layout should retain the 330px payment slot.
    await expect.poll(gapAfterFirstCard).toBeLessThan(250);
    const desktop = await paymentWrapper.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        display: style.display,
        width: rect.width,
        height: rect.height,
        background: style.backgroundColor,
        borderWidth: style.borderWidth,
        shadow: style.boxShadow,
      };
    });
    expect(desktop).toMatchObject({ display: "none", width: 0, height: 0 });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(paymentWrapper).toBeHidden();
    await expect.poll(gapAfterFirstCard).toBeLessThan(250);
    expect(await paymentWrapper.evaluate(node => ({
      display: getComputedStyle(node).display,
      height: node.getBoundingClientRect().height,
    }))).toEqual({ display: "none", height: 0 });

    await page.goto(`/CanvasPageEditor?pageId=${fixture.fixturePage.id}`);
    await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
    const editorPayment = page.locator("[data-block-type='payment-details']").first();
    await expect(editorPayment).toBeVisible();
    await expect(editorPayment.getByTestId("membership-editor-sample")).toBeVisible();
    await editorPayment.click();
    await expect(page.getByTestId("membership-data-inspector")).toBeVisible();

    expect(fixture.writes).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
    await context.close();
  }
});

test("isolated Auto height remains content-driven and long mobile content settles without clipping", async ({ browser }) => {
  for (const version of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const fixture = await installFixtures(page, {
      version, membershipMinHeight: 0, longMembershipContent: true,
    });
    await openPublished(page, fixture);
    await expect(page.getByTestId("canvas-membership-summary")).toContainText(
      "content remains authoritative",
    );
    const samples = await page.evaluate(async () => {
      const layouts = [];
      for (let frame = 0; frame < 8; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const membership = document.querySelector("[data-block-type='membership-summary']");
        const payment = document.querySelector("[data-block-type='payment-details']");
        layouts.push({
          height: membership.getBoundingClientRect().height,
          clientHeight: membership.clientHeight,
          scrollHeight: membership.scrollHeight,
          bottom: membership.getBoundingClientRect().bottom,
          nextTop: payment.getBoundingClientRect().top,
          minHeight: getComputedStyle(membership.querySelector("[data-membership-card]")).minHeight,
        });
      }
      return layouts;
    });
    const final = samples.at(-1);
    expect(final.minHeight).toBe("0px");
    expect(final.scrollHeight).toBeLessThanOrEqual(final.clientHeight + 1);
    expect(final.nextTop).toBeGreaterThanOrEqual(final.bottom - 1);
    expect(samples.slice(-4).every(sample => JSON.stringify(sample) === JSON.stringify(final))).toBe(true);
    expect(fixture.writes).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
    await context.close();
  }
});

test("isolated editor inserts both palette blocks, duplicates independently, edits, saves and reopens", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 1, viewer: "alpha", empty: true });
  await page.goto(`/CanvasPageEditor?pageId=${fixture.fixturePage.id}`);
  await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
  const stage = page.getByTestId("canvas-stage");
  await expect(stage).toBeVisible();

  await dragPaletteBlock(page, "membership-summary", 180);
  await expect(page.locator("[data-block-type='membership-summary']")).toHaveCount(1);
  await dragPaletteBlock(page, "payment-details", 540);
  await expect(page.locator("[data-block-type='payment-details']")).toHaveCount(1);

  const summary = page.locator("[data-block-type='membership-summary']").first();
  await summary.click();
  await expect(page.getByTestId("membership-editor-sample").first()).toContainText("sample data");
  await page.getByTestId("membership-min-height-mode").selectOption("custom");
  await page.getByTestId("membership-min-height").fill("460");
  await page.getByTestId("button-duplicate-selected").click();
  await expect(page.locator("[data-block-type='membership-summary']")).toHaveCount(2);
  const copies = page.locator("[data-block-type='membership-summary']");
  await copies.nth(1).click();
  await page.getByTestId("button-breakpoint-mobile").first().click();
  await expect(page.getByTestId("membership-min-height-mode")).toHaveValue("custom");
  await page.getByTestId("membership-min-height").fill("520");
  await page.getByTestId("button-breakpoint-desktop").first().click();
  await page.getByTestId("membership-input-eyebrow").fill("INDEPENDENT COPY WORDING");
  await expect(copies.nth(1)).toContainText("INDEPENDENT COPY WORDING");
  await expect(copies.nth(0)).toContainText("YOUR MEMBERSHIP");
  await expect(copies.nth(0)).not.toContainText("INDEPENDENT COPY WORDING");

  await page.getByTestId("membership-state-wording").selectOption("paused");
  await page.getByTestId("membership-input-paused-heading").fill("Temporarily on hold");
  await page.getByText("Field and payment-method labels", { exact: true }).click();
  await page.getByTestId("membership-input-field-memberSince").fill("Joined in");
  await page.getByTestId("input-bg-color").fill("#fff8ed");
  await page.getByTestId("input-border-width").fill("3");
  await page.getByTestId("input-border-radius").fill("18");
  await page.getByTestId("input-padding-top").fill("36");
  await page.getByTestId("select-shadow").click();
  await page.getByRole("option", { name: "Large", exact: true }).click();
  await page.getByTestId("membership-typography-heading").click();
  await page.getByRole("option", { name: /Fixture display/i }).click();

  const payment = page.locator("[data-block-type='payment-details']").first();
  await payment.click();
  await page.getByTestId("membership-input-manage-payments-link-text").fill("Review billing");
  const linkInput = page.getByTestId("membership-manage-link");
  await linkInput.fill("/account/payments");
  await page.getByTestId("membership-panel-background").fill("#eaf8ef");
  await page.getByTestId("membership-panel-border").fill("#237249");

  await page.getByTestId("button-save").click();
  await expect.poll(() => fixture.writes.filter(write => write.method === "PUT").length).toBeGreaterThan(0);
  const saved = fixture.getSavedDesign();
  const children = saved.root.sections[0].children;
  expect(children.filter(item => item.type === "membership-summary")).toHaveLength(2);
  expect(children.filter(item => item.type === "payment-details")).toHaveLength(1);
  const independent = children.find(item => item.content?.eyebrow === "INDEPENDENT COPY WORDING");
  expect(independent.content.states.paused.heading).toBe("Temporarily on hold");
  expect(independent.content.fields.memberSince).toBe("Joined in");
  expect(independent.content.typography.heading).toBe("type-task4511-heading");
  expect(independent.content.minHeight).toMatchObject({ desktop: 460, mobile: 520 });
  expect(independent.style).toMatchObject({
    background: "#fff8ed", borderWidth: 3, borderRadius: 18, paddingTop: 36, boxShadow: "lg",
  });
  const savedPayment = children.find(item => item.type === "payment-details");
  const originalSummary = children.find(item => (
    item.type === "membership-summary" && item.content?.eyebrow === "YOUR MEMBERSHIP"
  ));
  expect(originalSummary.content.minHeight).toBe(460);
  expect(savedPayment.content).toMatchObject({
    manageLink: "/account/payments", manageLinkText: "Review billing",
    panel: { background: "#eaf8ef", borderColor: "#237249" },
  });
  for (const item of children) {
    expect(JSON.stringify(item)).not.toContain("Professional — Alpha");
    expect(JSON.stringify(item)).not.toContain("2019-04-12");
    expect(item.content.membership).toBeUndefined();
    expect(item.content.payment).toBeUndefined();
    expect(item.content.memberId).toBeUndefined();
  }

  await page.reload();
  await expect(page.locator("[data-block-type='membership-summary']")).toHaveCount(2);
  await expect(page.getByText("INDEPENDENT COPY WORDING", { exact: true })).toBeVisible();
  await expect(page.getByText("Review billing", { exact: true })).toBeVisible();
  await page.locator("[data-block-type='membership-summary']").filter({
    hasText: "INDEPENDENT COPY WORDING",
  }).click();
  await expect(page.getByTestId("membership-min-height")).toHaveValue("460");
  await page.getByTestId("button-breakpoint-mobile").first().click();
  await expect(page.getByTestId("membership-min-height")).toHaveValue("520");
  // Editor preview is explicit sample data and must not call the private API.
  expect(fixture.requests.filter(item => item.path === "/api/membership/canvas-summary")).toHaveLength(0);
});

test("isolated viewer identities, guest, denied, errors and no-membership states never leak success data", async ({ browser }) => {
  const cases = [
    { viewer: "alpha", apiState: "ready", text: "Monthly Direct Debit", absent: "Associate — Beta" },
    { viewer: "beta", apiState: "ready", text: "Card", absent: "Monthly Direct Debit" },
    { viewer: "guest", apiState: "ready", text: "Sign in to view your membership details.", absent: "Your membership is active." },
    { viewer: "alpha", apiState: "denied", text: "You do not have permission", absent: "Your membership is active." },
    { viewer: "alpha", apiState: "error", text: "could not be loaded", absent: "Your membership is active." },
    { viewer: "alpha", apiState: "none", text: "Nothing to display.", absent: "Your membership is active." },
  ];
  for (const item of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const fixture = await installFixtures(page, { version: 2, viewer: item.viewer, apiState: item.apiState });
    await openPublished(page, fixture);
    await expect(page.getByTestId("canvas-membership-summary").first()).toContainText(item.text);
    await expect(page.locator("body")).not.toContainText(item.absent);
    if (item.viewer === "guest") {
      expect(fixture.requests.filter(request => request.path === "/api/membership/canvas-summary")).toHaveLength(0);
    }
    expect(fixture.writes).toEqual([]);
    await context.close();
  }
});

for (const version of [1, 2]) for (const upfront of [false, true]) test(`V${version} ${upfront ? "upfront" : "dynamic DD"} payment Section preserves bottom inset through asynchronous growth`, async ({ page }, testInfo) => {
  const fixture = await installFixtures(page, {
    version, viewer: "alpha", apiState: "loading",
    summaryOverride: {
      membership: { state: "active", expiryDate: "2026-10-16" },
      payment: upfront ? { state: "paid", method: "upfront" } : {
        state: "current_direct_debit", method: "monthly_direct_debit",
        amount: 13, currency: "GBP", mandateStatus: "active", collectionBasis: "projected",
        collectionStatus: "planned", nextCollection: { date: "2026-10-01", status: "planned" },
        collectionStructure: "2026-2027 Full member with NMC",
      },
    },
  });
  const section = fixture.fixturePage.canvas_design.root.sections[0];
  const payment = section.children.find(item => item.type === "payment-details");
  payment.content.minHeight = { desktop: 620, tablet: 620, mobile: 720 };
  if (version === 1) {
    const background = {
      id: "payment-background", type: "section",
      geom: { x: 0, y: 330, w: 940, h: 390 },
      bp: {
        desktop: { x: 0, y: 330, w: 940, h: 390 },
        tablet: { x: 0, y: 330, w: 700, h: 390 },
        mobile: { x: 0, y: 330, w: 343, h: 390 },
      },
      style: { background: "#456378", zIndex: 0 },
      content: { bgType: "color" },
    };
    section.children.unshift(background);
  } else {
    section.style = { background: "#456378" };
    section.flow.padTop = 20;
    section.flow.padBottom = 40;
  }
  await openPublished(page, fixture);
  fixture.releaseLoading();
  const cookieDecline = page.getByRole("button", { name: "Decline", exact: true });
  if (await cookieDecline.isVisible().catch(() => false)) await cookieDecline.click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const card = page.locator("[data-block-type='payment-details']").first();
    const background = page.locator(`[data-block-id='${version === 1 ? "payment-background" : section.id}']`).first();
    await expect.poll(async () => {
      const cardBox = await card.boundingBox();
      const sectionBox = await background.boundingBox();
      return sectionBox && cardBox ? Math.round(sectionBox.y + sectionBox.height - cardBox.y - cardBox.height) : null;
    }).toBe(40);
    await page.screenshot({ path: testInfo.outputPath(`payment-section-v${version}-${width}.png`), fullPage: true });
  }
  expect(fixture.writes).toEqual([]);
});

test("simplified payment details preserve facts at desktop and mobile sizes", async ({ page }, testInfo) => {
  const fixture = await installFixtures(page, {
    version: 2, viewer: "alpha",
    summaryOverride: {
      membership: { state: "active", expiryDate: "2027-09-30" },
      payment: {
        state: "current_direct_debit", method: "monthly_direct_debit",
        amount: 13, currency: "GBP", mandateStatus: "active", collectionBasis: "projected",
        collectionStatus: "planned", nextCollection: { date: "2026-10-01", status: "planned" },
        collectionNotice: "Projected collection amount — not yet bank scheduled",
        collectionStructure: "2026-2027 Full member with NMC",
        structureNotice: "Structure effective on planned collection date",
      },
    },
  });
  const origin = new URL(testInfo.project.use.baseURL).origin;
  await page.route("**/*", route => new URL(route.request().url()).origin === origin
    ? route.fallback() : route.abort());
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await openPublished(page, fixture);
    const payment = page.getByTestId("canvas-payment-details");
    await expect(payment).toContainText("2026-2027 Full member with NMC");
    for (const text of ["£13.00", "Projected next payment amount", "Planned payment date",
      "1 October 2026", "Monthly Direct Debit", "Direct Debit status", "30 September 2027"]) {
      await expect(payment).toContainText(text);
    }
    await expect(payment).not.toContainText("not yet bank scheduled");
    await expect(payment).not.toContainText("Structure effective on planned collection date");
    await expect(payment).not.toContainText("Your membership is current.");
    await expect(payment.locator('[data-testid="membership-payment-panel"] p')).toHaveCount(0);
    const bounds = await payment.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    await payment.screenshot({ path: testInfo.outputPath(`simplified-payment-${width}.png`) });
  }
});

test("isolated administrative recognition shows current membership with collections still held", async ({ page }, testInfo) => {
  const fixture = await installFixtures(page, {
    version: 2, viewer: "alpha",
    summaryOverride: {
      membership: {
        state: "active", memberSince: null, membershipType: "Recognised Alpha membership",
        renewalDate: "2027-10-01", paymentHistoryFrom: null,
        recognition: { effectiveFrom: "2026-09-21", effectiveUntil: "2027-10-01" },
      },
      payment: {
        state: "paused", method: "monthly_direct_debit", nextPayment: null,
        amount: null, currency: "GBP", collectionStatus: "unscheduled",
        plannedPayment: null, confirmedPayment: null, nextCollection: null, mandateStatus: "active",
      },
    },
  });
  // In addition to intercepting every API above, prevent all off-origin network
  // traffic (including fonts/analytics/provider URLs) in this recognition proof.
  const origin = new URL(testInfo.project.use.baseURL).origin;
  await page.route("**/*", route => new URL(route.request().url()).origin === origin
    ? route.fallback() : route.abort());
  await openPublished(page, fixture);
  const membership = page.getByTestId("canvas-membership-summary");
  const payment = page.getByTestId("canvas-payment-details");
  await expect(membership).toContainText("Active");
  await expect(membership).toContainText("Your membership is active.");
  await expect(membership).not.toContainText("Membership pending");
  await expect(membership).not.toContainText("No current membership");
  await expect(payment).toHaveAttribute("data-membership-state", "paused");
  await expect(payment).toContainText("This arrangement is currently paused.");
  await expect(payment).not.toContainText("Paid in full");
  await expect(payment).not.toContainText("Confirmed payment");
  expect(fixture.requests.filter(item => item.path === "/api/membership/canvas-summary")).toHaveLength(1);
  expect(fixture.writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("alpha-recognition-collections-held.png"), fullPage: true });
});

test("isolated loading response is explicit and shared, then resolves both blocks", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 2, viewer: "alpha", apiState: "loading" });
  await page.goto(`/${fixture.fixturePage.slug}`);
  await expect(page.getByTestId("canvas-membership-summary")).toContainText("Loading your membership details");
  await expect(page.getByTestId("canvas-payment-details")).toContainText("Loading your membership details");
  fixture.releaseLoading();
  await assertAlphaData(page);
  expect(fixture.requests.filter(item => item.path === "/api/membership/canvas-summary")).toHaveLength(1);
  expect(fixture.writes).toEqual([]);
});

test("isolated duplicate instances and symbol membership content auto-height without clipping", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await installFixtures(page, {
    version: 1, viewer: "alpha", duplicate: true, symbol: true,
    symbolMinHeight: { desktop: 480, tablet: 440, mobile: 420 },
  });
  await openPublished(page, fixture);
  await expect(page.getByTestId("canvas-membership-summary")).toHaveCount(3);
  await expect(page.getByText("SECOND INDEPENDENT CARD", { exact: true })).toBeVisible();
  await expect(page.getByText("SYMBOL MEMBERSHIP", { exact: true })).toBeVisible();
  const symbolCard = page.getByTestId("canvas-membership-summary").filter({ hasText: "SYMBOL MEMBERSHIP" });
  await expect(symbolCard).toContainText("A deliberately long symbol membership heading");
  const symbolChild = symbolCard.locator("xpath=ancestor::*[@data-block-type='membership-summary'][1]");
  const dimensions = await symbolChild.evaluate(node => ({
    clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
    childBottom: Math.max(...[...node.querySelectorAll("*")].map(child => child.getBoundingClientRect().bottom)),
    symbolBottom: node.getBoundingClientRect().bottom,
  }));
  expect(dimensions.clientHeight).toBeGreaterThanOrEqual(420);
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.clientHeight + 1);
  expect(dimensions.childBottom).toBeLessThanOrEqual(dimensions.symbolBottom + 1);
  expect(fixture.requests.filter(item => item.path === "/api/membership/canvas-summary")).toHaveLength(1);
  await page.screenshot({
    path: testInfo.outputPath("isolated-mobile-symbol-autoheight-reference.png"),
    fullPage: true,
  });
  expect(fixture.writes).toEqual([]);
});

test("isolated configured links remain safe and hidden when absent", async ({ page }) => {
  const fixture = await installFixtures(page, { version: 1, viewer: "alpha" });
  const current = fixture.fixturePage.canvas_design;
  const payment = current.root.sections[0].children.find(item => item.type === "payment-details");
  payment.content.manageLink = "javascript:alert(document.domain)";
  await openPublished(page, fixture);
  await expect(page.getByTestId("canvas-payment-details").getByRole("link")).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
});

test("isolated microsite typography options and computed editor/published forced-breakpoint styles stay in parity", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const expected = {
    desktop: { fontFamily: '"Courier New"', fontSize: "32px", fontWeight: "600", color: "rgb(107, 33, 78)" },
    mobile: { fontFamily: '"Courier New"', fontSize: "21px", fontWeight: "600", color: "rgb(107, 33, 78)" },
  };
  const computedHeading = locator => locator.locator('[data-membership-role="heading"]').evaluate(node => {
    const style = getComputedStyle(node);
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      color: style.color,
    };
  });

  for (const version of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const fixture = await installFixtures(page, { version, viewer: "alpha", microsite: true });
    await page.goto(`/CanvasPageEditor?pageId=${fixture.fixturePage.id}`);
    await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
    const editorCard = page.locator("[data-block-type='membership-summary']").first();
    await editorCard.click();

    const picker = page.getByTestId("membership-typography-heading");
    await picker.click();
    await expect(page.getByRole("option", { name: /Members site display/ })).toBeVisible();
    // Main-site and another microsite's styles are not choices for this page.
    await expect(page.getByRole("option", { name: /Fixture display/ })).toHaveCount(0);
    await expect(page.getByRole("option", { name: /Other site display/ })).toHaveCount(0);
    await page.getByRole("option", { name: /Members site display/ }).click();

    const currentEditorCard = () => page.getByTestId("canvas-membership-summary").first();
    await expect.poll(() => computedHeading(currentEditorCard())).toEqual(expected.desktop);
    await page.getByTestId("button-breakpoint-mobile").first().click();
    await expect(currentEditorCard()).toBeVisible();
    expect(await computedHeading(currentEditorCard())).toEqual(expected.mobile);
    if (version === 2) {
      // Container-query cards must settle, not merely move a synchronous ref
      // update loop into ResizeObserver callbacks on successive animation frames.
      const layouts = await page.evaluate(async () => {
        const samples = [];
        for (let frame = 0; frame < 8; frame++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const membership = document.querySelector("[data-block-type='membership-summary']");
          const payment = document.querySelector("[data-block-type='payment-details']");
          samples.push({
            height: membership.offsetHeight,
            scrollHeight: membership.scrollHeight,
            clientHeight: membership.clientHeight,
            bottom: membership.offsetTop + membership.offsetHeight,
            nextTop: payment.offsetTop,
          });
        }
        return samples;
      });
      expect(layouts.at(-1).height).toBeGreaterThan(300);
      expect(layouts.at(-1).scrollHeight).toBeLessThanOrEqual(layouts.at(-1).clientHeight + 1);
      expect(layouts.at(-1).nextTop).toBeGreaterThanOrEqual(layouts.at(-1).bottom);
      expect(layouts.slice(-4).every(layout => JSON.stringify(layout) === JSON.stringify(layouts.at(-1)))).toBe(true);
    }
    await page.getByTestId("button-breakpoint-desktop").first().click();
    await expect.poll(() => computedHeading(currentEditorCard())).toEqual(expected.desktop);

    await page.getByTestId("button-save").click();
    await expect.poll(() => fixture.writes.filter(write => write.method === "PUT").length).toBeGreaterThan(0);
    let savedSummary = fixture.getSavedDesign().root.sections[0].children
      .find(item => item.type === "membership-summary");
    expect(savedSummary.content.typography.heading).toBe("type-task4511-microsite-heading");

    await page.reload();
    const reopened = page.locator("[data-block-type='membership-summary']").first();
    await expect(reopened).toBeVisible();
    await reopened.click();
    await expect(page.getByTestId("membership-typography-heading")).toContainText("Members site display");
    savedSummary = fixture.getSavedDesign().root.sections[0].children
      .find(item => item.type === "membership-summary");
    expect(savedSummary.content.typography.heading).toBe("type-task4511-microsite-heading");

    await page.goto(`/${fixture.fixturePage.slug}?_bp=desktop`);
    const publishedDesktop = page.getByTestId("canvas-membership-summary").first();
    await expect(publishedDesktop).toBeVisible();
    expect(await computedHeading(publishedDesktop)).toEqual(expected.desktop);

    await page.goto(`/${fixture.fixturePage.slug}?_bp=mobile`);
    const publishedMobile = page.getByTestId("canvas-membership-summary").first();
    await expect(publishedMobile).toBeVisible();
    expect(await computedHeading(publishedMobile)).toEqual(expected.mobile);

    const cookieDecline = page.getByRole("button", { name: "Decline", exact: true });
    if (await cookieDecline.isVisible().catch(() => false)) await cookieDecline.click();
    await page.screenshot({
      path: testInfo.outputPath(`isolated-v${version}-microsite-forced-mobile-typography.png`),
      fullPage: true,
    });
    expect(fixture.writes.filter(write => (
      write.path !== `/api/canvas-design/${fixture.fixturePage.id}`
      && !write.path.startsWith("/api/canvas-versions/")
    ))).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
    await context.close();
  }
});