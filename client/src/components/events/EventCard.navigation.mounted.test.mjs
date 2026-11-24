import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.invalid/MemberGroupDetail?id=group" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => { throw new Error("No network allowed in card fixture"); };
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = Module.createRequire(import.meta.url)("@tanstack/react-query");
after(() => dom.window.close());

const bundle = await build({
  entryPoints: ["client/src/components/events/EventCard.jsx"],
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "isolated-event-card",
    setup(builder) {
      builder.onResolve({ filter: /(?:base44Client|publicClient)$/ }, args => ({ path: args.path, namespace: "api-stub" }));
      builder.onLoad({ filter: /.*/, namespace: "api-stub" }, () => ({
        contents: "export const base44 = { entities: {} }; export const publicClient = {};",
      }));
      builder.onResolve({ filter: /EventWaitingListModal$/ }, args => ({ path: args.path, namespace: "modal-stub" }));
      builder.onLoad({ filter: /.*/, namespace: "modal-stub" }, () => ({ contents: "export default () => null;" }));
      builder.onResolve({ filter: /TenantEventTimeDisplay$/ }, args => ({ path: args.path, namespace: "time-stub" }));
      builder.onLoad({ filter: /.*/, namespace: "time-stub" }, () => ({ contents: "export default ({children}) => children || null;" }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/event-card-fixture.cjs`);
compiled.filename = `${process.cwd()}/event-card-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const EventCard = compiled.exports.default;
const event = {
  id: "fixture", title: "Fixture event", slug: "fixture",
  start_date: "2099-01-15T10:00:00Z", end_date: "2099-01-15T11:00:00Z",
  status: "published", available_seats: null, event_state: "active",
};

async function withCard(props, check) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(EventCard, { event, isAdmin: false, ...props }))));
    await check(host);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
}

test("shared cards remain same-tab buttons unless the listing explicitly opts in", async () => {
  for (const overrides of [{}, { program_tag: "programme" }, { event_state: "closed" }, { is_complex: true }]) {
    await withCard({ event: { ...event, ...overrides } }, host => {
      const cta = host.querySelector('[data-testid^="button-register-event-"], [data-testid^="button-buy-tickets-"]');
      assert.ok(cta);
      assert.equal(cta.tagName, "BUTTON");
      assert.equal(cta.getAttribute("target"), null);
      assert.equal(cta.closest("a"), null);
    });
  }
});

test("listing opt-in never turns ended, sold-out, or join-locked buttons into links", async () => {
  for (const props of [
    { event: { ...event, end_date: "2000-01-15T11:00:00Z" } },
    { event: { ...event, available_seats: 0, shopping_held: 1 } },
    { joinLocked: true },
    { joinLocked: true, event: { ...event, program_tag: "programme" } },
  ]) {
    const clicks = [];
    await withCard({ ...props, navigationInNewTab: true, eventClickTrackingEnabled: true, onEventClick: (...args) => clicks.push(args) }, async host => {
      const cta = host.querySelector('[data-testid^="button-event-ended-"], [data-testid^="button-register-event-"], [data-testid^="button-join-locked-"]');
      assert.ok(cta);
      assert.equal(cta.tagName, "BUTTON");
      assert.equal(cta.disabled, true);
      assert.equal(cta.closest("a"), null);
      await act(async () => cta.click());
      assert.deepEqual(clicks, []);
    });
  }
});

test("feature-excluded card CTAs remain absent after listing opt-in", async () => {
  await withCard({ navigationInNewTab: true, isFeatureExcluded: feature => feature === "events.event-details" }, host => {
    assert.equal(host.querySelector('[data-testid^="button-register-event-"]'), null);
    assert.equal(host.querySelector("a[target='_blank']"), null);
  });
});
