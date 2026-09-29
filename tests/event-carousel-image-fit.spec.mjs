import { test, expect } from "@playwright/test";

// All page, authentication and event data is fixture-backed. Only the real
// Canvas editor, published page and shared EventCarouselRender are exercised.
const PAGE_ID = "event-carousel-image-fit-fixture";
const PAGE_SLUG = "event-carousel-image-fit-fixture";
const BLOCK_ID = "event-carousel-image-fit-block";
const TENANT = { id: "event-fit-tenant", slug: "event-fit-fixture", name: "Event fit fixture" };
const MEMBER = {
  id: "event-fit-member",
  email: "event-fit@example.invalid",
  first_name: "Event",
  last_name: "Fit",
  tenant_id: TENANT.id,
  role_id: "event-fit-role",
  organization_id: "event-fit-org",
  member_excluded_features: [],
  is_team_member: true,
};
const ROLE = { id: MEMBER.role_id, name: "Fixture editor", excluded_features: [] };

// Deliberately put labels at both extremes of the wide artwork. With cover
// those labels are outside the painted region; contain keeps both in frame.
const svgImage = (width, height, label) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#e7f3ff"/>
    <rect x="0" y="0" width="12" height="${height}" fill="#e11d48"/>
    <rect x="${width - 12}" y="0" width="12" height="${height}" fill="#2563eb"/>
    <text x="14" y="${height / 2}" font-size="32" fill="#111">LEFT ${label}</text>
    <text x="${width - 260}" y="${height / 2}" font-size="32" fill="#111">RIGHT ${label}</text>
  </svg>`,
)}`;
const EVENTS = [
  {
    id: "fit-wide",
    slug: "fit-wide",
    title: "Wide edge artwork",
    summary: "Both edge labels must survive contain mode.",
    start_date: "2026-07-20T10:00:00Z",
    image_url: svgImage(1200, 300, "WIDE"),
  },
  {
    id: "fit-portrait",
    slug: "fit-portrait",
    title: "Portrait artwork",
    summary: "Tall image for alternate slide.",
    start_date: "2026-07-21T10:00:00Z",
    image_url: svgImage(300, 900, "TALL"),
  },
];

function fixturePage(content = {}) {
  return {
    id: PAGE_ID,
    title: "Event carousel fit fixture",
    slug: PAGE_SLUG,
    status: "published",
    builder_type: "canvas",
    layout_type: "public",
    public_chrome: "none",
    tenant_id: TENANT.id,
    canvas_design: {
      version: 1,
      root: {
        background: null,
        groups: [],
        guides: { vertical: [], horizontal: [] },
        sections: [{
          id: "event-fit-section",
          children: [{
            id: BLOCK_ID,
            type: "event-carousel",
            name: "Event fit fixture",
            geom: { x: 0, y: 0, w: 900, h: 420 },
            bp: {
              desktop: { x: 0, y: 0, w: 900, h: 420 },
              tablet: { x: 0, y: 0, w: 700, h: 420 },
              mobile: { x: 0, y: 0, w: 375, h: 420 },
            },
            style: { background: "#fff", borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8 },
            content: {
              eventIds: EVENTS.map(({ id }) => id),
              imageSide: "left",
              imageAspect: "4/3",
              autoplay: false,
              showArrows: true,
              showIndicators: true,
              ...content,
            },
          }],
        }],
      },
    },
  };
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installFixtures(page, content = {}) {
  const fixture = fixturePage(content);
  const writes = [];
  await page.addInitScript(({ member, tenant }) => {
    localStorage.setItem("agcas_member", JSON.stringify(member));
    localStorage.setItem("tenant_slug", tenant);
  }, { member: MEMBER, tenant: TENANT.slug });
  await page.route("**/*", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/auth/me") return json(route, MEMBER);
    if (path === "/api/auth/tenant-user-me") return json(route, {
      authenticated: true,
      tenantUser: { id: "event-fit-tenant-user", email: MEMBER.email, role: ROLE, tenant: TENANT },
      user: MEMBER, member: MEMBER, tenant: TENANT, tenantId: TENANT.id, memberId: MEMBER.id,
    });
    if (path === `/api/entities/Role/${ROLE.id}`) return json(route, ROLE);
    if (path === `/api/entities/Member/${MEMBER.id}`) return json(route, MEMBER);
    if (path === `/api/entities/Organization/${MEMBER.organization_id}`) {
      return json(route, { id: MEMBER.organization_id, name: "Event fit org" });
    }
    if (path === "/api/entities/Role") return json(route, [ROLE]);
    if (path === "/api/entities/Member") return json(route, [MEMBER]);
    if (path === "/api/entities/Organization") return json(route, [{ id: MEMBER.organization_id, name: "Event fit org" }]);
    if (path === "/api/entities/IEditPage") return json(route, [fixture]);
    if (path === "/api/public/events") return json(route, EVENTS);
    if (path === `/api/public/page/${PAGE_SLUG}`) {
      return json(route, { success: true, page: fixture, elements: [], symbols: [] });
    }
    if (path === `/api/canvas-design/${PAGE_ID}` && method === "GET") return json(route, { page: fixture });
    if (path === `/api/canvas-design/${PAGE_ID}` && method === "PUT") {
      const body = request.postDataJSON();
      writes.push({ path, body });
      fixture.canvas_design = body.canvas_design;
      return json(route, { page: fixture });
    }
    if (path.startsWith("/api/canvas-page-audits/")) return json(route, method === "GET" ? { audits: [] } : { audit: {} });
    if (path.startsWith("/api/canvas-versions/")) return json(route, method === "GET" ? { versions: [] } : { version: {} });
    if (method === "GET") return json(route, []);
    writes.push({ path, body: request.postDataJSON?.() });
    return json(route, { error: "Unexpected fixture mutation" }, 405);
  });
  return { fixture, writes };
}

function savedContent(state) {
  return state.writes.at(-1)?.body?.canvas_design?.root?.sections?.[0]?.children?.[0]?.content;
}

async function imageMetrics(carousel) {
  return carousel.locator("img").evaluate((img) => {
    const frame = img.parentElement;
    const imageStyle = getComputedStyle(img);
    const frameStyle = getComputedStyle(frame);
    const imgBox = img.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    const sourceRatio = img.naturalWidth / img.naturalHeight;
    const frameRatio = frameBox.width / frameBox.height;
    // Whether the painted bitmap includes its extreme edges. This geometric
    // check derives from the actual image intrinsic size, measured frame and
    // browser-computed object-fit; it does not pretend DOM text finds SVG text.
    const wholeImageVisible = imageStyle.objectFit !== "cover" ||
      Math.abs(sourceRatio - frameRatio) < 0.01;
    return {
      fit: imageStyle.objectFit,
      position: imageStyle.objectPosition,
      source: [img.naturalWidth, img.naturalHeight],
      frame: [frameBox.width, frameBox.height],
      image: [imgBox.width, imgBox.height],
      wholeImageVisible,
      order: frameStyle.order,
      direction: getComputedStyle(frame.parentElement).flexDirection,
      aspect: frameStyle.aspectRatio,
    };
  });
}

async function expectImage(carousel, { fit, source, whole }) {
  await expect(carousel.locator("img")).toBeVisible();
  await expect.poll(async () => (await imageMetrics(carousel)).source).toEqual(source);
  const metrics = await imageMetrics(carousel);
  expect(metrics.fit).toBe(fit);
  expect(metrics.position).toBe("50% 50%");
  expect(metrics.frame[0]).toBeGreaterThan(0);
  expect(metrics.frame[1]).toBeGreaterThan(0);
  expect(metrics.image[0]).toBeCloseTo(metrics.frame[0], 0);
  expect(metrics.image[1]).toBeCloseTo(metrics.frame[1], 0);
  expect(metrics.wholeImageVisible).toBe(whole);
  return metrics;
}

test("published route preserves legacy cover, renders wide/portrait fit modes, sides and navigation", async ({ page }) => {
  const state = await installFixtures(page); // legacy page has no imageFit
  await page.goto(`/${PAGE_SLUG}`);
  const carousel = page.getByTestId("event-carousel");
  await expect(carousel).toBeVisible();
  let m = await expectImage(carousel, { fit: "cover", source: [1200, 300], whole: false });
  expect(m.direction).toBe("row");
  expect(m.order).toBe("1");
  await carousel.getByTestId("button-event-carousel-next").click();
  await expect(carousel.getByText("Portrait artwork")).toBeVisible();
  await expectImage(carousel, { fit: "cover", source: [300, 900], whole: false });
  await expect(carousel.getByTestId("button-event-carousel-indicator-1")).toHaveAttribute("aria-current", "true");
  await carousel.getByTestId("button-event-carousel-prev").click();
  await expect(carousel.getByText("Wide edge artwork")).toBeVisible();

  for (const fit of ["contain", "fill"]) {
    for (const side of ["left", "right"]) {
      state.fixture.canvas_design.root.sections[0].children[0].content.imageFit = fit;
      state.fixture.canvas_design.root.sections[0].children[0].content.imageSide = side;
      await page.reload();
      await expect(carousel).toBeVisible();
      m = await expectImage(carousel, { fit, source: [1200, 300], whole: true });
      expect(m.order).toBe(side === "left" ? "1" : "2");
      expect(m.direction).toBe("row");
      if (fit === "contain" && side === "left") {
        await carousel.screenshot({ path: "/tmp/event-carousel-image-fit-contained-wide.png" });
      }
      await carousel.getByTestId("button-event-carousel-next").click();
      await expect(carousel.getByText("Portrait artwork")).toBeVisible();
      await expectImage(carousel, { fit, source: [300, 900], whole: true });
    }
  }
  expect(state.writes).toEqual([]);
});

test("narrow public viewport stacks image first and retains aspect, fit and controls", async ({ page }) => {
  const state = await installFixtures(page, { imageFit: "contain", imageSide: "right", imageAspect: "16/9" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${PAGE_SLUG}`);
  const carousel = page.getByTestId("event-carousel");
  await expect(carousel).toBeVisible();
  const m = await expectImage(carousel, { fit: "contain", source: [1200, 300], whole: true });
  expect(m.direction).toBe("column");
  expect(m.order).toBe("1");
  expect(m.aspect).toMatch(/16\s*\/\s*9|1\.777/);
  await carousel.getByTestId("button-event-carousel-next").click();
  await expectImage(carousel, { fit: "contain", source: [300, 900], whole: true });
  expect(state.writes).toEqual([]);
});

test("editor inspector changes fit immediately, persists it, normalizes and reopens without touching aspect or navigation", async ({ page }) => {
  const state = await installFixtures(page, { imageFit: "unrecognized-legacy-fit", imageSide: "right", imageAspect: "3/2" });
  await page.goto(`/CanvasPageEditor?pageId=${PAGE_ID}`);
  await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
  const block = page.getByTestId(`canvas-block-${BLOCK_ID}`);
  await expect(block).toBeVisible();
  await block.click();
  const carousel = block.getByTestId("event-carousel");
  const select = page.getByTestId("select-event-carousel-image-fit");
  await expect(select).toBeVisible();
  await expect(select).toContainText("Cover");
  await expectImage(carousel, { fit: "cover", source: [1200, 300], whole: false });

  for (const [label, fit] of [
    ["Contain (show whole image)", "contain"],
    ["Fill (stretch)", "fill"],
    ["Cover (crop to fill)", "cover"],
    ["Contain (show whole image)", "contain"],
  ]) {
    await select.click();
    await page.getByRole("option", { name: label }).click();
    await expect.poll(async () => (await imageMetrics(carousel)).fit).toBe(fit);
    await expectImage(carousel, { fit, source: [1200, 300], whole: fit !== "cover" });
  }
  await page.getByTestId("button-save").click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(savedContent(state)).toMatchObject({
    imageFit: "contain", imageSide: "right", imageAspect: "3/2",
    autoplay: false, showArrows: true, showIndicators: true,
    eventIds: ["fit-wide", "fit-portrait"],
  });
  await page.reload();
  await expect(page.getByTestId("canvas-page-editor")).toBeVisible();
  const reopenedBlock = page.getByTestId(`canvas-block-${BLOCK_ID}`);
  await expect(reopenedBlock).toBeVisible();
  await reopenedBlock.click();
  await expect(page.getByTestId("select-event-carousel-image-fit")).toContainText("Contain");
  await expectImage(reopenedBlock.getByTestId("event-carousel"), { fit: "contain", source: [1200, 300], whole: true });
  expect(state.writes).toHaveLength(1);
});