import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

const React = (await import("react")).default;
globalThis.React = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { MemberCpdPointsHistoryView } = await import("./MemberCpdPointsTab.jsx");
const { default: MemberCpdPointsTab } = await import("./MemberCpdPointsTab.jsx");
const { createRoot } = await import("react-dom/client");
const { act } = React;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
for (const key of ["HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event"]) {
  globalThis[key] = dom.window[key];
}
globalThis.getComputedStyle = dom.window.getComputedStyle;

test("Activity retains member since and timeline but no CPD; dedicated tab keeps permission readiness", () => {
  const source = readFileSync(new URL("../pages/MemberDetail.jsx", import.meta.url), "utf8");
  const activity = source.split('<TabsContent value="activity"')[1].split("</TabsContent>")[0];
  assert.match(activity, /text-member-created-date/);
  assert.match(activity, /MemberActivityTimeline/);
  assert.doesNotMatch(activity, /Cpd|cpd|CPD/);
  const cpd = source.split('<TabsContent value="cpd-points"')[1].split("</TabsContent>")[0];
  assert.match(cpd, /enabled=\{isAccessReady && activeTab === 'cpd-points'\}/);
  assert.match(cpd, /canCorrect=\{isAccessReady && isFeatureExcluded && !isFeatureExcluded\('cpd.points-corrections'\)\}/);
});

async function mountTab(run) {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 },
    mutations: { retry: false, gcTime: 0 },
  } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const render = async (props = {}) => {
    await act(async () => root.render(
      <QueryClientProvider client={client}><MemberCpdPointsTab memberId="member" {...props} /></QueryClientProvider>,
    ));
    await settle();
  };
  try { await run({ render, client, container }); }
  finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
}
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
function button(text) {
  return [...document.querySelectorAll("button")].find(el => el.textContent.trim() === text);
}
async function click(text) {
  assert.ok(button(text), `Missing button: ${text}`);
  await act(async () => button(text).click());
  await settle();
}
async function fill(id, value) {
  const input = document.getElementById(id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
const award = { id: "award", entry_kind: "event_award", points_value: 5, event_name: "Conference" };
const json = (data, ok = true) => ({ ok, json: async () => data });

test("disabled tabs make no requests; viewers have history only; pagination and empty/error retry survive", async () => {
  await mountTab(async ({ render, container }) => {
    const calls = [];
    let failure = false;
    globalThis.fetch = async (url) => {
      calls.push(url);
      if (failure) return json({ error: "unavailable" }, false);
      return json({ balance: 5, total: 21, pageSize: 20, items: url.includes("page=2") ? [] : [award] });
    };
    await render({ enabled: false, canCorrect: true });
    assert.equal(calls.length, 0);
    await render();
    assert.equal(calls.length, 1);
    assert.equal(button("Adjust"), undefined);
    await click("Next");
    assert.match(container.textContent, /Page 2 of 2/);
    assert.match(container.textContent, /No CPD points recorded yet/);
    failure = true;
    await click("Previous");
    assert.match(container.textContent, /Couldn't load CPD points history/);
    failure = false;
    await click("Try again");
    assert.match(container.textContent, /Conference/);
    await render({ enabled: false });
    const count = calls.length;
    await settle();
    assert.equal(calls.length, count);
    assert.ok(calls.every(url => !url.includes("/admin/")));
  });
});

test("corrections preserve reason validation and retry key, refreshing both caches and reversal eligibility", async () => {
  await mountTab(async ({ render, container }) => {
    const posts = [];
    let balance = 5;
    let failPost = true;
    let entries = [award];
    let historyReads = 0;
    let correctionReads = 0;
    globalThis.fetch = async (url, options) => {
      if (options?.method === "POST") {
        const payload = JSON.parse(options.body);
        posts.push(payload);
        if (failPost) return json({ error: "Retry this correction" }, false);
        balance = payload.action === "adjust" ? 7 : 2;
        if (payload.action === "reverse") entries = [award, { id: "rev", reversal_of: "award", entry_kind: "reversal" }];
        return json({ ok: true });
      }
      if (url.includes("/admin/")) {
        correctionReads++;
        return json({ entries });
      }
      historyReads++;
      return json({ balance, total: 1, items: [{ ...award, is_reversed: entries.length > 1 }] });
    };
    await render({ canCorrect: true });
    assert.equal(container.querySelectorAll('[data-testid="member-cpd-points-balance"]').length, 1);
    assert.equal(container.querySelector('[data-testid="cpd-points-total"]'), null);
    await click("Adjust");
    assert.equal(button("Record correction").disabled, true);
    await fill("cpd-adjustment", "2");
    await fill("cpd-reason", "   ");
    assert.equal(button("Record correction").disabled, true);
    await fill("cpd-reason", "Correct attendance evidence");
    await click("Record correction");
    assert.equal(posts.length, 1);
    failPost = false;
    await click("Record correction");
    assert.deepEqual(posts[0], posts[1]);
    assert.ok(posts[0].correction_key);
    assert.equal(container.querySelector('[data-testid="member-cpd-points-balance"]').textContent, "7");
    assert.ok(historyReads >= 2 && correctionReads >= 2);
    await click("Reverse");
    await fill("cpd-reason", "Incorrect award");
    await click("Record correction");
    assert.equal(posts[2].action, "reverse");
    assert.equal(posts[2].ledger_entry_id, "award");
    assert.equal(container.querySelector('[data-testid="member-cpd-points-balance"]').textContent, "2");
    assert.equal(button("Reversed").disabled, true);
  });
});

test("history loading and correction lookup failures keep controls unavailable without hiding history", async () => {
  await mountTab(async ({ render, container }) => {
    let resolveHistory;
    globalThis.fetch = async (url) => {
      if (url.includes("/admin/")) return json({ error: "Permission denied" }, false);
      return new Promise(resolve => { resolveHistory = resolve; });
    };
    await render({ canCorrect: true });
    assert.ok(container.querySelector('[aria-label="Loading CPD points history"]'));
    await act(async () => resolveHistory(json({ balance: 5, total: 1, items: [award] })));
    await settle();
    assert.match(container.textContent, /Conference/);
    assert.match(container.textContent, /Could not load correction controls: Permission denied/);
    assert.equal(button("Adjust"), undefined);
    assert.equal(button("Reverse"), undefined);
  });
});

test("older paginated awards remain correctable and recent corrections retain admin audit details", async () => {
  await mountTab(async ({ render, container }) => {
    globalThis.fetch = async (url) => json(url.includes("/admin/") ? {
      entries: [{ id: "adjust", entry_kind: "manual_adjustment", points_value: 2,
        created_at: "2026-09-25T12:00:00Z", reason: "Old award corrected today", created_by: "admin-actor" }],
    } : { balance: 7, total: 1, items: [{ ...award, evidence_date: "2020-01-01" }] });
    await render({ canCorrect: true });
    assert.ok(button("Adjust"));
    assert.ok(button("Reverse"));
    assert.match(container.textContent, /Old award corrected today/);
    assert.match(container.textContent, /Recorded:/);
    assert.match(container.textContent, /Actor: admin-actor/);
    await click("Adjust");
    assert.ok(document.getElementById("cpd-reason"));
  });
});

test("renders signed balance, reversal states, snapshot fields and pagination", () => {
  const html = renderToStaticMarkup(
    <MemberCpdPointsHistoryView
      page={1}
      setPage={() => {}}
      data={{
        balance: "3.5",
        total: 21,
        pageSize: 20,
        items: [
          {
            id: "award",
            entry_kind: "event_award",
            points_value: "5",
            event_name: "Snapshotted conference",
            ticket_name_snapshot: "Member ticket",
            award_trigger: "attendance",
            evidence_date: "2026-09-01T10:00:00Z",
            is_reversed: true,
          },
          {
            id: "reversal",
            entry_kind: "reversal",
            points_value: "-1.5",
            event_name: "Historical activity",
            activity_description: "Imported evidence",
            evidence_date: "2025-05-01",
          },
        ],
      }}
    />,
  );
  assert.match(html, /3\.5/);
  assert.match(html, /Snapshotted conference/);
  assert.match(html, /Member ticket/);
  assert.match(html, /Attendance/);
  assert.match(html, /Reversed/);
  assert.match(html, /Historical activity/);
  assert.match(html, /Imported evidence/);
  assert.match(html, /Reversal/);
  assert.match(html, /Page 1 of 2/);
  assert.match(html, />Next</);
});