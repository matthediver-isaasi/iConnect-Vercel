import { test, expect } from "@playwright/test";

const WIDGET_ID = "annual-membership-value-4771";
const STRUCTURE_ID = "structure-core-4771";
const BAND_ID = "band-standard-4771";
const ORG_TYPE_FIELD_ID = "field-org-type-4771";

const sources = {
  sources: [
    {
      id: "organization",
      label: "Organisations",
      systemFields: [{ name: "id", label: "ID", type: "id" }],
      customFields: [],
    },
    {
      id: "organisation_membership",
      label: "Annual Membership Value",
      isOrganisationMembershipValue: true,
      systemFields: [],
      customFields: [{
        id: ORG_TYPE_FIELD_ID,
        name: "org_type",
        label: "Organisation type",
        type: "enum",
        fieldType: "enum",
        options: [
          { value: "Charity", label: "Charity" },
          { value: "Corporate", label: "Corporate" },
        ],
      }],
      membershipCatalog: {
        configs: [{
          id: STRUCTURE_ID,
          label: "Core membership",
          currency: "GBP",
          effectiveFrom: "2026-08-01",
          effectiveTo: null,
        }],
        bands: [{
          id: BAND_ID,
          configId: STRUCTURE_ID,
          label: "Core membership — Standard",
        }],
        currencies: ["GBP", "EUR"],
      },
    },
  ],
};

const membershipData = {
  type: "scalar",
  value: 12345.67,
  total: 3,
  rows: [{ key: "total", value: 12345.67 }],
  membershipValue: {
    source: "organisation_membership",
    period: {
      start: "2026-08-01",
      endExclusive: "2027-08-01",
      label: "2026-08-01 – 2027-07-31",
    },
    allocation: "membership_structure_effective_from_half_open",
    currency: "GBP",
    exactValue: "12345.67",
    netOfVat: true,
    includedRecords: 3,
    excludedRecords: {
      lifecycle: 1,
      period: 2,
      selection: 1,
      classification: 4,
    },
    warnings: [{
      code: "missing_structure_evidence",
      message: "Some saved memberships have no snapshot or tenant-verified structure and were not valued.",
      count: 1,
    }],
  },
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function viteModules(request) {
  const response = await request.get("/src/components/dashboard/WidgetBuilderModal.jsx");
  expect(response.ok()).toBeTruthy();
  const transformed = await response.text();
  const react = transformed.match(/"([^"]*\/react\.js\?[^"]*)"/)?.[1];
  if (!react) throw new Error("The existing preview must serve Vite-transformed React modules.");
  const dependency = name => react.replace(/react\.js\?/, `${name}.js?`);
  const paths = [
    "/@react-refresh",
    "/@vite/client",
    "/src/index.css",
    "/src/components/dashboard/WidgetBuilderModal.jsx",
    "/src/components/dashboard/WidgetCard.jsx",
    react,
    dependency("react-dom_client"),
    dependency("@tanstack_react-query"),
    dependency("react-router-dom"),
  ];
  for (const warmed of await Promise.all(paths.map(path => request.get(path)))) {
    expect(warmed.ok()).toBeTruthy();
  }
  return { react, dependency };
}

function fixtureHtml({ react, dependency }) {
  return `<!doctype html>
<html>
  <head><title>Annual membership value widget fixture</title></head>
  <body>
    <div id="root"></div>
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import("/@vite/client");
      await import("/src/index.css");
      const React = (await import(${JSON.stringify(react)})).default;
      const { createRoot } = (await import(${JSON.stringify(dependency("react-dom_client"))})).default;
      const { QueryClient, QueryClientProvider } =
        await import(${JSON.stringify(dependency("@tanstack_react-query"))});
      const { MemoryRouter } = await import(${JSON.stringify(dependency("react-router-dom"))});
      const { default: WidgetBuilderModal } =
        await import("/src/components/dashboard/WidgetBuilderModal.jsx");
      const { default: WidgetCard } =
        await import("/src/components/dashboard/WidgetCard.jsx");

      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
      });
      function Fixture() {
        const [widget, setWidget] = React.useState(null);
        const [open, setOpen] = React.useState(true);
        const save = payload => {
          window.__savedPayload = payload;
          setWidget({ ...payload, id: ${JSON.stringify(WIDGET_ID)} });
          setOpen(false);
        };
        return React.createElement("main", { className: "mx-auto max-w-6xl p-6" },
          widget && React.createElement("div", { className: "mb-5 space-y-3" },
            React.createElement("button", {
              type: "button",
              "data-testid": "button-reopen-membership-value",
              className: "rounded border px-3 py-2",
              onClick: () => setOpen(true),
            }, "Edit saved widget"),
            React.createElement(WidgetCard, {
              widget,
              queryScope: "task-4771-fixture",
              palette: [],
            }),
          ),
          React.createElement(WidgetBuilderModal, {
            open,
            onClose: () => setOpen(false),
            onSave: save,
            initialWidget: widget,
            defaultScope: "personal",
            canSavePersonal: true,
            canSaveShared: true,
            palette: [],
          }),
        );
      }
      createRoot(document.getElementById("root")).render(
        React.createElement(QueryClientProvider, { client },
          React.createElement(MemoryRouter, null, React.createElement(Fixture)),
        ),
      );
    </script>
  </body>
</html>`;
}

async function choose(page, testId, optionName) {
  await page.getByTestId(testId).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

test("builds, saves, reopens and renders the annual membership value KPI", async ({
  page,
  request,
}, testInfo) => {
  const modules = await viteModules(request);
  const fixturePath = "/__fixtures/task-4771-annual-membership-value";
  const previewRequests = [];
  const unexpectedWrites = [];
  const escapedTransports = [];
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.context().route(/\/(?:rest|auth)\/v1\//, route => {
    escapedTransports.push(route.request().url());
    return route.abort();
  });
  await page.context().route(/^https?:\/\/[^/]*(?:stripe|gocardless|supabase)\./i, route => {
    escapedTransports.push(route.request().url());
    return route.abort();
  });
  await page.route("**/*", async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === fixturePath) {
      return route.fulfill({ contentType: "text/html", body: fixtureHtml(modules) });
    }
    if (url.pathname === "/api/dashboard/sources" && req.method() === "GET") {
      return json(route, sources);
    }
    if (url.pathname === "/api/dashboard/widgets/preview" && req.method() === "POST") {
      previewRequests.push(req.postDataJSON());
      return json(route, { data: membershipData });
    }
    if (url.pathname === `/api/dashboard/widgets/${WIDGET_ID}/data`
        && ["GET", "POST"].includes(req.method())) {
      return json(route, {
        widget: {
          id: WIDGET_ID,
          title: "Annual membership value 2026/27",
          widget_type: "stat",
          scope: "personal",
          config: {
            source: "organisation_membership",
            membershipValue: {
              startMonth: 8,
              startYear: 2026,
              currency: "GBP",
              configIds: [STRUCTURE_ID],
              bandIds: [BAND_ID],
            },
          },
        },
        data: membershipData,
        cache: {
          status: "current",
          pending: false,
          updatedAt: "2026-09-25T12:00:00.000Z",
        },
      });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
        unexpectedWrites.push(`${req.method()} ${url.pathname}`);
      }
      return route.abort();
    }
    if (!["GET", "HEAD"].includes(req.method())) {
      unexpectedWrites.push(`${req.method()} ${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });

  await page.goto(fixturePath);
  await expect(page.getByRole("dialog", { name: "New widget" })).toBeVisible();
  await page.getByTestId("input-widget-title").fill("Annual membership value 2026/27");
  await choose(page, "select-widget-source", "Annual Membership Value");

  await expect(page.getByTestId("membership-value-controls")).toBeVisible();
  await expect(page.getByTestId("select-widget-type")).toHaveCount(0);
  await expect(page.getByTestId("switch-widget-click-through")).toHaveCount(0);
  await choose(page, "select-membership-value-start-month", "August");
  await page.getByTestId("input-membership-value-start-year").fill("2026");
  await choose(page, "select-membership-value-currency", "GBP");

  await page.getByTestId("select-membership-value-configs").click();
  await page.getByText("Core membership", { exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByTestId("select-membership-value-bands").click();
  await page.getByText("Core membership — Standard", { exact: true }).click();
  await page.keyboard.press("Escape");

  await page.getByTestId("button-add-filter").click();
  const filter = page.getByTestId("filter-row-0");
  await filter.getByRole("combobox").nth(0).click();
  await page.getByRole("option", { name: "Organisation type (custom)", exact: true }).click();
  await choose(page, "select-filter-value-0", "Charity");

  const preview = page.getByTestId("membership-value-report").first();
  await expect(preview).toContainText("£12,345.67");
  await expect(preview).toContainText("2026-08-01 – 2027-07-31");
  await expect(preview).toContainText("Unpaid records are included");
  await expect(preview).toContainText("Payments, refunds and credits are not reconciled");
  await expect(preview.getByRole("alert")).toContainText("tenant-verified structure");

  await expect.poll(() => previewRequests.at(-1)?.config?.membershipValue).toEqual({
    startMonth: 8,
    startYear: 2026,
    currency: "GBP",
    configIds: [STRUCTURE_ID],
    bandIds: [BAND_ID],
  });
  await expect.poll(() => previewRequests.at(-1)?.config?.filters?.[0]).toMatchObject({
    fieldKind: "custom",
    fieldId: ORG_TYPE_FIELD_ID,
    operator: "eq",
    value: "Charity",
  });

  await page.getByTestId("button-save-widget").click();
  const card = page.getByTestId(`widget-card-${WIDGET_ID}`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId("membership-value-report")).toContainText("£12,345.67");
  await expect(card.getByRole("alert")).toContainText("tenant-verified structure");
  await page.screenshot({
    path: testInfo.outputPath("annual-membership-value-saved-kpi.png"),
    fullPage: true,
  });

  await page.getByTestId("button-reopen-membership-value").click();
  await expect(page.getByRole("dialog", { name: "Edit widget" })).toBeVisible();
  await expect(page.getByTestId("select-widget-source")).toContainText("Annual Membership Value");
  await expect(page.getByTestId("select-membership-value-start-month")).toContainText("August");
  await expect(page.getByTestId("input-membership-value-start-year")).toHaveValue("2026");
  await expect(page.getByTestId("select-membership-value-currency")).toContainText("GBP");
  await expect(page.getByTestId("select-membership-value-configs")).toContainText("1 selected");
  await expect(page.getByTestId("select-membership-value-bands")).toContainText("1 selected");
  await expect(page.getByTestId("select-filter-value-0")).toContainText("Charity");
  await expect(page.getByTestId("select-widget-type")).toHaveCount(0);
  await expect(page.getByTestId("switch-widget-click-through")).toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath("annual-membership-value-saved-and-reopened.png"),
    fullPage: true,
  });
  expect(unexpectedWrites).toEqual([]);
  expect(escapedTransports).toEqual([]);
  expect(pageErrors).toEqual([]);
});