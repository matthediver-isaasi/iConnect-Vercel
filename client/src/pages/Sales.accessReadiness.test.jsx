import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { unlink } from "node:fs/promises";
import path from "node:path";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.example.test/sales/dashboard",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const bundlePath = path.join(process.cwd(), `.sales-access-readiness-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      export { default as Sales } from "./client/src/pages/Sales.jsx";
      export { LayoutProvider, useLayoutContext } from "./client/src/contexts/LayoutContext.jsx";
      export { default as PortalReadiness } from "./client/src/components/layouts/PortalReadiness.jsx";
      export { base44 } from "./client/src/api/base44Client.js";
    `,
    resolveDir: process.cwd(),
    loader: "jsx",
  },
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  alias: { "@": path.join(process.cwd(), "client/src") },
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
  plugins: [{
    name: "sales-workspace-stubs",
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /(pages\/sales\/Catalogue|components\/sales\/(OpportunitiesWorkspace|QuotesWorkspace|SalesReportingWorkspace))$/ },
        args => ({ path: args.path, namespace: "sales-stub" }),
      );
      buildApi.onLoad({ filter: /.*/, namespace: "sales-stub" }, args => {
        if (args.path.endsWith("SalesReportingWorkspace")) {
          return {
            loader: "jsx",
            contents: `
              export const SalesDashboard = () => <div data-testid="sales-dashboard">dashboard workspace</div>;
              export const SalesReports = () => <div data-testid="sales-reports">reports workspace</div>;
            `,
          };
        }
        if (args.path.endsWith("OpportunitiesWorkspace")) {
          return {
            loader: "jsx",
            contents: `export default ({ destination }) => <div data-testid={"sales-" + destination}>{destination} workspace</div>;`,
          };
        }
        const marker = args.path.endsWith("Catalogue") ? "catalogue" : "quotes";
        return {
          loader: "jsx",
          contents: `export default () => <div data-testid="sales-${marker}">${marker} workspace</div>;`,
        };
      });
    },
  }],
});

const bundled = await import(pathToFileURL(bundlePath).href);
const {
  Sales,
  LayoutProvider,
  useLayoutContext,
  PortalReadiness,
  base44,
} = bundled;

after(async () => {
  await unlink(bundlePath).catch(() => {});
});

const member = (overrides = {}) => ({
  id: "member-a",
  tenant_id: "tenant-a",
  role_id: "role-a",
  member_excluded_features: [],
  ...overrides,
});

const role = (excluded_features = [], overrides = {}) => ({
  id: "role-a",
  tenant_id: "tenant-a",
  name: "Member",
  excluded_features,
  ...overrides,
});

const snapshot = (roleValue, overrides = {}) => ({
  status: "ready",
  member_id: "member-a",
  tenant_id: "tenant-a",
  role_id: "role-a",
  session_key: "session-a",
  role: roleValue,
  ...overrides,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(delay = 0) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, delay));
  });
}

async function mountSales(destination, { portalReady = true } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  let layout;
  let pathname;

  function Capture() {
    layout = useLayoutContext();
    pathname = useLocation().pathname;
    return null;
  }

  const render = ready => act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <LayoutProvider>
        <MemoryRouter initialEntries={[`/sales/${destination}`]}>
          <Capture />
          <PortalReadiness ready={ready}>
            <Routes>
              <Route path="/sales/:destination" element={<Sales destination={destination} />} />
              <Route path="/Preferences" element={<div data-testid="preferences">preferences</div>} />
            </Routes>
          </PortalReadiness>
        </MemoryRouter>
      </LayoutProvider>
    </QueryClientProvider>,
  ));

  await render(portalReady);
  return {
    container,
    queryClient,
    get layout() { return layout; },
    get pathname() { return pathname; },
    render,
    async authenticate(memberValue, snapshotValue) {
      await act(async () => {
        layout.setMemberInfo(memberValue);
        layout.setSessionRoleSnapshot(snapshotValue);
        layout.setSessionValidated(true);
        layout.setAuthResolved(true);
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    },
  };
}

for (const destination of ["dashboard", "pipeline"]) {
  test(`${destination} cold entry waits for a delayed role without redirecting hidden portal children`, async () => {
    const request = deferred();
    const roleProxy = base44.entities.Role;
    const originalGet = roleProxy.get;
    let gets = 0;
    roleProxy.get = async () => {
      gets += 1;
      return request.promise;
    };
    const mounted = await mountSales(destination, { portalReady: false });
    try {
      // Reproduce Layout's effect-published callback still containing its
      // fail-closed value. Sales must use the direct role observer instead.
      await act(async () => mounted.layout.setIsFeatureExcluded(() => true));
      await mounted.authenticate(member(), snapshot(null, {
        status: "legacy",
        role: undefined,
      }));
      await settle();

      assert.equal(mounted.pathname, `/sales/${destination}`);
      assert.equal(mounted.container.querySelector("[data-testid^='sales-']"), null);
      assert.ok(mounted.container.querySelector("[aria-label='Loading navigation']"));
      assert.ok(mounted.container.querySelector("[aria-label='Loading navigation']").closest("[hidden]"));
      assert.equal(gets, 1);

      await act(async () => request.resolve(role()));
      await settle();
      await mounted.render(true);
      assert.equal(mounted.pathname, `/sales/${destination}`);
      assert.ok(mounted.container.querySelector(`[data-testid='sales-${destination}']`));
      assert.equal(mounted.container.querySelector("[data-testid='preferences']"), null);
    } finally {
      roleProxy.get = originalGet;
      await mounted.cleanup();
    }
  });
}

test("failed role resolution is recoverable and Retry restores the requested Sales route", async () => {
  const roleProxy = base44.entities.Role;
  const originalGet = roleProxy.get;
  let attempts = 0;
  roleProxy.get = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Role service unavailable");
    return role();
  };
  const mounted = await mountSales("dashboard");
  try {
    await mounted.authenticate(member(), snapshot(null, {
      status: "legacy",
      role: undefined,
    }));
    await settle(10);
    assert.equal(mounted.pathname, "/sales/dashboard");
    assert.match(mounted.container.querySelector("[role='alert']").textContent, /Role service unavailable/);
    assert.equal(mounted.container.querySelector("[data-testid='sales-dashboard']"), null);

    await act(async () => mounted.container.querySelector("button").click());
    await settle(10);
    assert.equal(attempts, 2);
    assert.equal(mounted.pathname, "/sales/dashboard");
    assert.ok(mounted.container.querySelector("[data-testid='sales-dashboard']"));
  } finally {
    roleProxy.get = originalGet;
    await mounted.cleanup();
  }
});

test("permission invalidation gates the workspace, then applies refreshed allow and deny decisions", async () => {
  const roleProxy = base44.entities.Role;
  const originalGet = roleProxy.get;
  const responses = [];
  roleProxy.get = async () => {
    const next = deferred();
    responses.push(next);
    return next.promise;
  };
  const mounted = await mountSales("dashboard");
  try {
    await mounted.authenticate(member(), snapshot(role()));
    assert.ok(mounted.container.querySelector("[data-testid='sales-dashboard']"));

    let refreshing;
    await act(async () => {
      refreshing = mounted.queryClient.invalidateQueries({ queryKey: ["memberRole"] });
      await settle();
    });
    assert.equal(mounted.pathname, "/sales/dashboard");
    assert.equal(mounted.container.querySelector("[data-testid='sales-dashboard']"), null);
    assert.ok(mounted.container.querySelector("[aria-label='Loading navigation']"));
    await act(async () => responses[0].resolve(role()));
    await refreshing;
    await settle();
    assert.ok(mounted.container.querySelector("[data-testid='sales-dashboard']"));

    await act(async () => {
      refreshing = mounted.queryClient.invalidateQueries({ queryKey: ["memberRole"] });
      await settle();
    });
    assert.equal(mounted.pathname, "/sales/dashboard");
    assert.equal(mounted.container.querySelector("[data-testid='sales-dashboard']"), null);
    await act(async () => responses[1].resolve(role(["sales.dashboard"])));
    await refreshing;
    await settle();
    assert.equal(mounted.pathname, "/Preferences");
    assert.ok(mounted.container.querySelector("[data-testid='preferences']"));
  } finally {
    roleProxy.get = originalGet;
    await mounted.cleanup();
  }
});

test("ready role, member, destination, and hierarchical exclusions remain definitive denials", async t => {
  const cases = [
    ["role baseline", "dashboard", member(), role(["sales.view"])],
    ["role destination", "dashboard", member(), role(["sales.dashboard"])],
    ["member destination", "pipeline", member({ member_excluded_features: ["sales.pipeline"] }), role()],
    ["hierarchical module", "pipeline", member(), role(["sales"])],
  ];
  for (const [name, destination, memberValue, roleValue] of cases) {
    await t.test(name, async () => {
      const mounted = await mountSales(destination);
      try {
        await mounted.authenticate(memberValue, snapshot(roleValue));
        assert.equal(mounted.pathname, "/Preferences");
        assert.ok(mounted.container.querySelector("[data-testid='preferences']"));
      } finally {
        await mounted.cleanup();
      }
    });
  }
});

test("identity changes reject a stale trusted snapshot without redirecting or fetching it", async () => {
  const roleProxy = base44.entities.Role;
  const originalGet = roleProxy.get;
  let gets = 0;
  roleProxy.get = async () => {
    gets += 1;
    return role();
  };
  const mounted = await mountSales("dashboard");
  const memberB = member({ id: "member-b", role_id: "role-b" });
  const roleB = role([], { id: "role-b", name: "Second role" });
  try {
    await mounted.authenticate(member(), snapshot(role()));
    assert.ok(mounted.container.querySelector("[data-testid='sales-dashboard']"));

    await act(async () => {
      mounted.layout.setMemberInfo(memberB);
      mounted.layout.setSessionRoleSnapshot(snapshot(role()));
    });
    assert.equal(mounted.pathname, "/sales/dashboard");
    assert.equal(mounted.container.querySelector("[data-testid='sales-dashboard']"), null);
    assert.match(
      mounted.container.querySelector("[data-testid='navigation-unavailable']").textContent,
      /has not been validated/,
    );
    assert.equal(gets, 0, "a role belonging to the previous identity must not be requested or trusted");

    await act(async () => mounted.layout.setSessionRoleSnapshot(snapshot(roleB, {
      member_id: "member-b",
      role_id: "role-b",
      session_key: "session-b",
    })));
    assert.equal(mounted.pathname, "/sales/dashboard");
    assert.ok(mounted.container.querySelector("[data-testid='sales-dashboard']"));
    assert.equal(gets, 0);
  } finally {
    roleProxy.get = originalGet;
    await mounted.cleanup();
  }
});