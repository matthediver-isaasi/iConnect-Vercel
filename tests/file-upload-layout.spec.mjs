import { test, expect } from "@playwright/test";

const FORM_ID = "file-upload-layout-form";
const FORM_SLUG = "file-upload-layout";
const FIELD_ID = "file-upload-layout-field";
const CUSTOM_FIELD_ID = "file-upload-layout-definition";
const ALL_TYPES = ["pdf", "word", "excel", "powerpoint", "images", "text", "zip", "video", "audio"];
const LONG_LABEL = "Upload the complete supporting evidence package with every requested document and attachment";
const LONG_FILE_NAME = "complete-supporting-evidence-package-with-a-very-long-descriptive-filename-for-mobile-layout-regression.pdf";

function formFixture(fieldType = "custom_field") {
  return {
    id: FORM_ID,
    slug: FORM_SLUG,
    name: "File upload layout regression",
    description: "",
    layout_type: "standard",
    form_width: "narrow",
    fields: [{
      id: FIELD_ID,
      type: fieldType,
      ...(fieldType === "custom_field" ? { custom_field_id: CUSTOM_FIELD_ID } : {
        allowed_file_types: ALL_TYPES,
        public_access: true,
      }),
      label: LONG_LABEL,
      required: false,
    }],
    pages: [],
    visibility_rules: [],
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    require_authentication: false,
    access_policy: null,
    is_active: true,
    form_type: "standard",
    submit_button_text: "Submit fixture",
    success_message: "Submitted",
    allow_save_continue_later: false,
    prefill_source: "none",
    is_contract: false,
    blank_layout: true,
    survey_settings: {},
  };
}

const customField = {
  id: CUSTOM_FIELD_ID,
  label: LONG_LABEL,
  field_type: "file",
  allowed_file_types: ALL_TYPES,
  public_access: true,
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installFixtures(page, {
  customFieldDelay = 0,
  uploadDelay = 0,
  fieldType = "custom_field",
} = {}) {
  const form = formFixture(fieldType);
  const state = { writes: [], uploads: 0, pageErrors: [] };
  page.on("pageerror", error => state.pageErrors.push(error.message));

  await page.context().route("**/fixture-file-upload", async route => {
    state.uploads += 1;
    if (uploadDelay) await new Promise(resolve => setTimeout(resolve, uploadDelay));
    return route.fulfill({ status: 200, body: "" });
  });

  await page.context().route("**/rest/v1/**", route => json(route, []));
  await page.context().route("**/auth/v1/**", route => json(route, []));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();

    // Never replace Vite source module responses.
    if (!pathname.startsWith("/api/")) return route.continue();
    if (pathname === `/api/public/form/${FORM_SLUG}` && method === "GET") return json(route, form);
    if (pathname === `/api/public/custom-field/${CUSTOM_FIELD_ID}` && method === "GET") {
      if (customFieldDelay) await new Promise(resolve => setTimeout(resolve, customFieldDelay));
      return json(route, customField);
    }
    if (pathname === "/api/storage/signed-upload-url" && method === "POST") {
      state.writes.push(`${method} ${pathname}`);
      return json(route, {
        signedUrl: `${new URL(request.url()).origin}/fixture-file-upload`,
        fileUrl: "https://files.example.invalid/uploaded-file.pdf",
        path: `forms/${LONG_FILE_NAME}`,
        bucket: "public-uploads",
      });
    }
    if (pathname === "/api/public/form-payment-providers") return json(route, { providers: [] });
    if (pathname === "/api/public/form-consent-message") return json(route, { message: "" });
    if (pathname === "/api/public/tenant-branding") {
      return json(route, { success: true, branding: { name: "Upload fixture", primaryColor: "#155e75" } });
    }
    if (pathname === "/api/public/navigation-items") return json(route, []);
    if (pathname === "/api/public/microsites") return json(route, { microsites: [] });
    if (pathname === "/api/public/resource-categories") return json(route, []);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      state.writes.push(`${method} ${pathname}`);
      return json(route, { error: `Unexpected fixture mutation: ${method} ${pathname}` }, 599);
    }
    return json(route, []);
  });
  return state;
}

function surfacePath(surface) {
  return surface === "embed" ? `/embed/form/${FORM_SLUG}` : `/FormView?slug=${FORM_SLUG}`;
}

async function openSurface(page, surface) {
  await page.goto(surfacePath(surface), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId(`button-upload-file-${FIELD_ID}`)).toBeVisible();
}

async function layoutGeometry(page) {
  return page.getByTestId(`button-upload-file-${FIELD_ID}`).evaluate(button => {
    const bounds = button.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(button);
    const textRects = [...range.getClientRects()]
      .filter(rect => rect.width > 0 && rect.height > 0)
      .map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
    return {
      bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width },
      textRects,
      scrollWidth: button.scrollWidth,
      scrollHeight: button.scrollHeight,
      clientWidth: button.clientWidth,
      clientHeight: button.clientHeight,
    };
  });
}

async function expectTextInsideTrigger(page) {
  const geometry = await layoutGeometry(page);
  expect(geometry.textRects.length).toBeGreaterThan(1);
  for (const rect of geometry.textRects) {
    expect(rect.left).toBeGreaterThanOrEqual(geometry.bounds.left - 1);
    expect(rect.right).toBeLessThanOrEqual(geometry.bounds.right + 1);
    expect(rect.top).toBeGreaterThanOrEqual(geometry.bounds.top - 1);
    expect(rect.bottom).toBeLessThanOrEqual(geometry.bounds.bottom + 1);
  }
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
}

async function expectNoPageOverflow(page) {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);
}

async function expectSelectionAndActionsInsideBounds(page) {
  const ids = [
    `button-download-file-${FIELD_ID}`,
    `button-view-file-${FIELD_ID}`,
    `button-remove-file-${FIELD_ID}`,
  ];
  const geometry = await page.evaluate(({ ids, longFileName }) => {
    const filename = [...document.querySelectorAll("p")]
      .find(node => node.textContent === longFileName);
    const card = filename?.closest(".rounded-lg");
    const cardRect = card?.getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      card: cardRect && { left: cardRect.left, right: cardRect.right },
      filename: filename && (() => {
        const rect = filename.getBoundingClientRect();
        return { left: rect.left, right: rect.right, scrollWidth: filename.scrollWidth, clientWidth: filename.clientWidth };
      })(),
      actions: ids.map(id => {
        const rect = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
        return rect && { left: rect.left, right: rect.right };
      }),
    };
  }, { ids, longFileName: LONG_FILE_NAME });

  expect(geometry.card).not.toBeNull();
  expect(geometry.filename).not.toBeNull();
  expect(geometry.filename.left).toBeGreaterThanOrEqual(geometry.card.left - 1);
  expect(geometry.filename.right).toBeLessThanOrEqual(geometry.card.right + 1);
  for (const action of geometry.actions) {
    expect(action).not.toBeNull();
    expect(action.left).toBeGreaterThanOrEqual(geometry.card.left - 1);
    expect(action.right).toBeLessThanOrEqual(geometry.card.right + 1);
    expect(action.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  }
}

async function expectNoSubmitOverlap(page, subjectTestId) {
  const subject = page.getByTestId(subjectTestId);
  const submit = page.getByRole("button", { name: "Submit fixture", exact: true });
  await expect(subject).toBeVisible();
  await expect(submit).toBeVisible();
  const [subjectBox, submitBox] = await Promise.all([subject.boundingBox(), submit.boundingBox()]);
  expect(subjectBox).not.toBeNull();
  expect(submitBox).not.toBeNull();
  const separated = (
    subjectBox.y + subjectBox.height <= submitBox.y + 1
    || submitBox.y + submitBox.height <= subjectBox.y + 1
    || subjectBox.x + subjectBox.width <= submitBox.x + 1
    || submitBox.x + submitBox.width <= subjectBox.x + 1
  );
  expect(separated, `${subjectTestId} must not overlap the adjacent Submit button`).toBe(true);
}

for (const surface of ["form-view", "embed"]) {
  for (const fieldType of ["file", "custom_field"]) {
    test(`${surface} ${fieldType} keeps long upload content visible at mobile and desktop widths`, async ({ page }, testInfo) => {
      const state = await installFixtures(page, { fieldType });
      for (const width of [320, 375, 390, 1280]) {
        await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
        await openSurface(page, surface);
        const input = page.getByTestId(`input-file-${FIELD_ID}`);
        await expect(input).toHaveAttribute("accept", /\.pdf/);
        await expect(input).toHaveAttribute("accept", /\.mp4/);
        await expect(input).toHaveAttribute("accept", /\.mp3/);

        if (surface === "form-view" && fieldType === "custom_field" && width === 320) {
          await page.screenshot({
            path: "screenshots/file-upload-after-form-view-320.png",
            fullPage: true,
          });
        }
        await expectTextInsideTrigger(page);
        await expectNoPageOverflow(page);
        await expectNoSubmitOverlap(page, `button-upload-file-${FIELD_ID}`);
        await page.screenshot({
          path: testInfo.outputPath(`file-upload-${surface}-${fieldType}-${width}.png`),
          fullPage: true,
        });
      }
      expect(state.pageErrors).toEqual([]);
    });
  }
}

for (const surface of ["form-view", "embed"]) {
  for (const fieldType of ["file", "custom_field"]) {
    test(`${surface} ${fieldType} native selection keeps loading and actions bounded at mobile widths`, async ({ page }) => {
      const state = await installFixtures(page, { uploadDelay: 300, fieldType });

      for (const width of [320, 375, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await openSurface(page, surface);
        const uploadButton = page.getByTestId(`button-upload-file-${FIELD_ID}`);
        const selection = page.getByTestId(`input-file-${FIELD_ID}`).setInputFiles({
          name: LONG_FILE_NAME,
          mimeType: "application/pdf",
          buffer: Buffer.from("%PDF-1.4 fixture"),
        });

        await expect(page.getByText("Uploading...", { exact: true })).toBeVisible();
        await expect(uploadButton).toBeDisabled();
        await expectTextInsideTrigger(page);
        await expectNoPageOverflow(page);
        await expectNoSubmitOverlap(page, `button-upload-file-${FIELD_ID}`);
        await selection;

        await expect(page.getByText(LONG_FILE_NAME, { exact: true })).toBeVisible();
        await expect(page.getByTestId(`button-download-file-${FIELD_ID}`)).toBeVisible();
        await expect(page.getByTestId(`button-view-file-${FIELD_ID}`)).toBeVisible();
        await expect(page.getByTestId(`button-remove-file-${FIELD_ID}`)).toBeVisible();
        await expectSelectionAndActionsInsideBounds(page);
        await expectNoPageOverflow(page);
        await expectNoSubmitOverlap(page, `button-remove-file-${FIELD_ID}`);

        if (surface === "form-view" && fieldType === "custom_field" && width === 320) {
          await page.screenshot({
            path: "screenshots/file-upload-after-selection-320.png",
            fullPage: true,
          });
        }

        await page.getByTestId(`button-remove-file-${FIELD_ID}`).click();
        await expect(page.getByTestId(`button-upload-file-${FIELD_ID}`)).toBeVisible();
      }

      expect(state.uploads).toBe(3);
      expect(state.writes).toEqual(Array(3).fill("POST /api/storage/signed-upload-url"));
      expect(state.pageErrors).toEqual([]);
    });
  }
}

test("custom field definition loading state resolves to the real upload control", async ({ page }) => {
  await installFixtures(page, { customFieldDelay: 500 });
  await page.goto(surfacePath("embed"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Loading options...", { exact: true })).toBeVisible();
  await expect(page.getByTestId(`button-upload-file-${FIELD_ID}`)).toBeVisible();
});

test("actual iframe constrains EmbedForm at mobile widths", async ({ page }, testInfo) => {
  const state = await installFixtures(page);
  const baseURL = testInfo.project.use.baseURL;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/file-upload-iframe-harness?width=*", route => {
    const width = Number(new URL(route.request().url()).searchParams.get("width"));
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html>
        <html>
          <body style="margin:0">
            <iframe
              title="File upload embed fixture"
              src="${baseURL}${surfacePath("embed")}"
              style="display:block;border:0;width:${width}px;height:844px"
            ></iframe>
          </body>
        </html>`,
    });
  });

  for (const width of [320, 375, 390]) {
    await page.goto(`/file-upload-iframe-harness?width=${width}`, { waitUntil: "domcontentloaded" });
    const iframe = page.locator('iframe[title="File upload embed fixture"]');
    await expect(iframe).toBeVisible();
    const embedded = page.frameLocator('iframe[title="File upload embed fixture"]');
    await expect(embedded.getByTestId(`button-upload-file-${FIELD_ID}`)).toBeVisible();
    await expectTextInsideTrigger(embedded);

    const frame = page.frames().find(candidate => candidate.url().includes(`/embed/form/${FORM_SLUG}`));
    expect(frame).toBeTruthy();
    const frameWidths = await frame.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(frameWidths.viewport).toBe(width);
    expect(frameWidths.document).toBeLessThanOrEqual(width + 1);
    expect(frameWidths.body).toBeLessThanOrEqual(width + 1);

    if (width === 320) {
      await page.screenshot({
        path: "screenshots/file-upload-after-embed-iframe-320.png",
        fullPage: true,
      });
    }
  }
  expect(state.pageErrors).toEqual([]);
});