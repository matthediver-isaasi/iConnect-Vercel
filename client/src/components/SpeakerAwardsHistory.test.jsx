import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
const React = (await import("react")).default;
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { default: SpeakerAwardsHistory, SpeakerAwardsHistoryView } = await import("./SpeakerAwardsHistory.jsx");

const award = {
  id: "award /1", event_title: "Speaker Forum", status: "granted",
  certificate: { available: true, status: "issued" },
};
const history = (awards = [award], totalPages = 1) => ({
  awards, pagination: { total: awards.length, total_pages: totalPages },
});
const json = (body, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body });
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
async function mounted(run) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const render = async (props = {}) => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <SpeakerAwardsHistory endpoint="/api/members/a/speaker-awards" showEmpty {...props} />
    </QueryClientProvider>));
    await settle();
  };
  const click = async (text) => {
    const button = [...container.querySelectorAll("button")].find(el => el.textContent.trim() === text);
    assert.ok(button, `Missing ${text}`);
    await act(async () => button.click());
    await settle();
  };
  try { await run({ render, click, container, root }); }
  finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
}

test("member CPD tab preserves existing history and adds independently gated speaker history", () => {
  const source = readFileSync(new URL("../pages/MemberDetail.jsx", import.meta.url), "utf8");
  const cpd = source.split('<TabsContent value="cpd-points"')[1].split("</TabsContent>")[0];
  assert.match(cpd, /<MemberCpdPointsTab[\s\S]*certificates/);
  const speaker = cpd.split("<SpeakerAwardsHistory")[1];
  assert.match(speaker, /key=\{id\}/);
  assert.match(speaker, /\/api\/members\/\$\{encodeURIComponent\(id\)\}\/speaker-awards/);
  assert.match(speaker, /\/api\/members\/\$\{encodeURIComponent\(id\)\}\/speaker-certificate/);
  assert.match(speaker, /enabled=\{isAccessReady && activeTab === 'cpd-points'\}/);
  assert.match(speaker, /showEmpty/);
});

test("disabled queries never fetch; speaker loading, error/retry and empty states stay visible", async () => {
  await mounted(async ({ render, click, container }) => {
    const calls = [];
    let resolve;
    globalThis.fetch = (url, options) => {
      calls.push({ url, options });
      return new Promise(done => { resolve = done; });
    };
    await render({ enabled: false });
    assert.equal(calls.length, 0);
    assert.match(container.textContent, /Speaker Awards.*Loading speaker awards/);
    await render();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.credentials, "include");
    assert.match(container.textContent, /Loading speaker awards/);
    await act(async () => resolve(json({ error: "Service unavailable" }, false)));
    await settle();
    assert.match(container.textContent, /Speaker Awards.*Could not load speaker awards.*Service unavailable/);
    globalThis.fetch = async () => json(history([]));
    await click("Try again");
    assert.match(container.textContent, /Speaker Awards.*No speaker awards recorded yet/);
  });
});

test("changing member resets pagination, previous records and file errors even while disabled", async () => {
  await mounted(async ({ render, click, container }) => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      if (url.includes("certificate")) return json({ error: "Old member file error" }, false);
      if (url.includes("/b/")) return json(history([{ ...award, id: "b-award", event_title: "Member B Forum" }]));
      return json(history([award], 2));
    };
    await render();
    await click("Next");
    assert.match(container.textContent, /Page 2 of 2/);
    await click("Preview");
    assert.match(container.textContent, /Old member file error/);
    await render({ endpoint: "/api/members/b/speaker-awards", enabled: false });
    assert.doesNotMatch(container.textContent, /Speaker Forum|Old member file error|Page 2/);
    assert.equal(calls.some(url => url.includes("/b/")), false);
    await render({ endpoint: "/api/members/b/speaker-awards" });
    assert.ok(calls.includes("/api/members/b/speaker-awards?page=1&page_size=20"));
    assert.match(container.textContent, /Member B Forum/);
    assert.doesNotMatch(container.textContent, /Speaker Forum|Old member file error/);
  });
});

test("preview/download use custom certificate endpoints and retain default URLs", async () => {
  await mounted(async ({ root, container }) => {
    for (const endpoint of [undefined, "/api/members/a/speaker-certificate", "/custom?scope=member"]) {
      const calls = [];
      await act(async () => root.render(<SpeakerAwardsHistoryView
        data={history()} page={1} setPage={() => {}}
        certificateEndpoint={endpoint} onFile={(...args) => calls.push(args)}
      />));
      for (const text of ["Preview", "Download"]) {
        await act(async () => [...container.querySelectorAll("button")].find(el => el.textContent.trim() === text).click());
      }
      const base = endpoint || "/api/speaker-awards/certificate";
      const url = `${base}${base.includes("?") ? "&" : "?"}id=award%20%2F1`;
      assert.deepEqual(calls, [
        [url, "speaker-certificate-award /1.pdf", false],
        [`${url}&download=1`, "speaker-certificate-award /1.pdf", true],
      ]);
    }
  });
});
