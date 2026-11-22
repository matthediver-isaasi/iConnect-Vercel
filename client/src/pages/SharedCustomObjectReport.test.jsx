import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { matchesReportViewerQuery, normalizeReportViewerQuery } from "../../../shared/reportViewerQuery.mjs";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://example.test/shared-reports/test-capability" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.URL.createObjectURL = () => "blob:fixture";
globalThis.URL.revokeObjectURL = () => {};
dom.window.HTMLAnchorElement.prototype.click = function click() {};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Routes, Route } = await import("react-router-dom");
const { default: SharedCustomObjectReport } = await import("./SharedCustomObjectReport.jsx");
const { default: ReportSharingControls, InternalReportLink } = await import("./customObjects/ReportSharingControls.jsx");

async function mount(fetchMock) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/shared-reports/test-capability"]}>
      <Routes><Route path="/shared-reports/:token" element={<SharedCustomObjectReport />} /></Routes>
    </MemoryRouter>,
  ));
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

async function mountInternal(fetchMock) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/internal-reports/object-9/report-4?from=nav"]}>
      <Routes><Route path="/internal-reports/:objectId/:reportId" element={<SharedCustomObjectReport internalMode />} /></Routes>
    </MemoryRouter>,
  ));
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const click = (element) => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const type = (element, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
};
const wait = (delay = 15) => new Promise((resolve) => setTimeout(resolve, delay));

for (const internal of [false, true]) test(`${internal ? 'internal' : 'external'} viewer debounces search, filters by projected fields, and exports matching CSV`, async () => {
  const requests = [];
  const source = Array.from({ length: 55 }, (_, index) => ({ id: `r${index}`, values: [
    `Department ${index}`, index >= 50 ? "Oxford" : "London",
  ] }));
  let exportQuery, exportedBlob;
  const oldCreateUrl = URL.createObjectURL;
  URL.createObjectURL = blob => { exportedBlob = blob; return "blob:fixture"; };
  const fetchMock = async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.action === "unlock") return jsonResponse({ access_grant: "grant-query", report: { name: "Locations", allow_csv: true } });
    if (body.action === "preview") {
      const criteria = normalizeReportViewerQuery(body.viewer_query, 2);
      const data = source.filter(row => matchesReportViewerQuery(row.values, criteria));
      const page = body.page || 1;
      return jsonResponse({ sort_job: { id: "query-snapshot", status: "complete" },
        columns: [{ label: "Name" }, { label: "City" }], data: data.slice((page - 1) * 50, page * 50),
        total: data.length, page, pageSize: 50, has_more: page * 50 < data.length });
    }
    if (body.action === "export") {
      if (body.export_action === "start") exportQuery = body.viewer_query;
      if (body.export_action === "chunk") return jsonResponse({ csv_text: "Name,City\r\n" + source
        .filter(row => matchesReportViewerQuery(row.values, exportQuery)).map(row => row.values.join(",")).join("\r\n") });
      return jsonResponse({ id: "query-export", status: "complete", chunk_count: 1, filename: "locations.csv" });
    }
    return jsonResponse({ report: { name: "Locations", allow_csv: true } });
  };
  const fixture = await (internal ? mountInternal(fetchMock) : mount(fetchMock));
  try {
    if (!internal) {
      assert.equal(fixture.container.querySelector('input[type="search"]'), null, "locked reports reveal no search fields");
      await act(async () => click([...fixture.container.querySelectorAll("button")].find(button => button.textContent.includes("Open report"))));
    }
    await act(async () => wait());
    const search = fixture.container.querySelector('input[type="search"]');
    assert.ok(search);
    const before = requests.filter(body => body.action === "preview").length;
    await act(async () => type(search, "Oxf"));
    await act(async () => type(search, "OXFORD"));
    await act(async () => wait(420));
    assert.equal(requests.filter(body => body.action === "preview").length, before + 1);
    assert.match(fixture.container.textContent, /5 matching rows/);
    assert.doesNotMatch(fixture.container.querySelector("tbody").textContent, /London/);
    assert.equal(requests.at(-1).job_id, "query-snapshot", "search reuses the full server snapshot");

    const details = fixture.container.querySelector("details"); details.open = true;
    const matchType = fixture.container.querySelector('select[aria-label="Match type for Name"]');
    await act(async () => { matchType.value = "equals"; matchType.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await act(async () => type(fixture.container.querySelector('input[aria-label="Filter Name"]'), "Department 54"));
    await act(async () => wait(420));
    assert.match(fixture.container.textContent, /1 matching rows/);
    assert.match(fixture.container.querySelector("tbody").textContent, /Department 54/);
    await act(async () => click([...fixture.container.querySelectorAll("button")].find(button => button.textContent.includes("Download CSV"))));
    assert.deepEqual(exportQuery, { search: "OXFORD", filters: [{ column: 0, operator: "equals", value: "Department 54" }] });
    const csv = await exportedBlob.text();
    assert.match(csv, /Department 54,Oxford/);
    assert.doesNotMatch(csv, /Department 53/);
    await act(async () => type(search, "no-such-value"));
    await act(async () => wait(420));
    assert.match(fixture.container.textContent, /0 matching rows/);
    assert.match(fixture.container.textContent, /No rows match/);
    await act(async () => click([...fixture.container.querySelectorAll("button")].find(button => button.textContent.includes("Clear search and filters"))));
    await act(async () => wait(420));
    assert.match(fixture.container.textContent, /55 rows/);
  } finally { URL.createObjectURL = oldCreateUrl; await fixture.cleanup(); }
});

test("a delayed search response cannot overwrite newer report criteria", async () => {
  let resolveOld;
  const fixture = await mount(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === "unlock") return jsonResponse({ access_grant: "grant-race", report: { name: "Search race", allow_csv: false } });
    const response = label => jsonResponse({ sort_job: { id: "race-snapshot", status: "complete" },
      columns: [{ label: "Name" }], data: [{ id: "row", values: [label] }], total: 1, page: 1, has_more: false });
    if (body.action === "preview") {
      if (body.viewer_query?.search === "old") return new Promise(resolve => { resolveOld = () => resolve(response("Old result")); });
      return response(body.viewer_query?.search === "new" ? "New result" : "Initial result");
    }
    return jsonResponse({ report: { name: "Search race", allow_csv: false } });
  });
  try {
    await act(async () => click([...fixture.container.querySelectorAll("button")].find(button => button.textContent.includes("Open report"))));
    await act(async () => wait());
    const input = fixture.container.querySelector('input[type="search"]');
    await act(async () => type(input, "old"));
    await act(async () => wait(420));
    assert.equal(typeof resolveOld, "function");
    await act(async () => type(input, "new"));
    await act(async () => wait(420));
    assert.match(fixture.container.querySelector("tbody").textContent, /New result/);
    await act(async () => { resolveOld(); await wait(); });
    assert.match(fixture.container.querySelector("tbody").textContent, /New result/);
    assert.doesNotMatch(fixture.container.querySelector("tbody").textContent, /Old result/);
  } finally { await fixture.cleanup(); }
});

test("guest password gate hides report name until unlock and paginates the bounded snapshot", async () => {
  const requests = [];
  const fixture = await mount(async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.action === "unlock") return jsonResponse({ access_grant: "grant-memory", expires_at: "soon", report: { name: "Department roster", allow_csv: true } });
    if (body.action === "preview" && body.preview_action === "start") return jsonResponse({ sort_job: { id: "job-1", status: "queued", processed: 0, total: 2 } });
    if (body.action === "preview" && body.preview_action === "process") return jsonResponse({
      sort_job: { id: "job-1", status: "complete" }, columns: [{ label: "Department" }],
      data: [{ id: "r1", values: ["Clinical"] }], total: 2, page: 1, pageSize: 50, has_more: true,
    });
    if (body.action === "preview" && body.preview_action === "page") return jsonResponse({
      sort_job: { id: "job-1", status: "complete" }, columns: [{ label: "Department" }],
      data: [{ id: "r2", values: ["Imaging"] }], total: 2, page: 2, pageSize: 50, has_more: false,
    });
    return jsonResponse({ report: { name: "Department roster", allow_csv: true } });
  });
  try {
    assert.doesNotMatch(fixture.container.textContent, /Department roster/);
    const input = fixture.container.querySelector("#shared-report-password");
    await act(async () => type(input, "secret"));
    await act(async () => click([...fixture.container.querySelectorAll("button")].find((button) => button.textContent.includes("Open report"))));
    await act(async () => wait(360));
    assert.match(fixture.container.textContent, /Department roster/);
    assert.match(fixture.container.textContent, /Clinical/);
    assert.ok(fixture.container.querySelector('button')?.textContent);
    const next = [...fixture.container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Next");
    await act(async () => click(next));
    await act(async () => wait());
    assert.match(fixture.container.textContent, /Imaging/);
    assert.ok(requests.some((request) => request.pageSize === 50 && request.preview_action === "page" && request.job_id === "job-1"));
    assert.equal(requests[0].token, "test-capability");
  } finally { await fixture.cleanup(); }
});

test("CSV availability follows authenticated report settings and revocation clears displayed rows", async () => {
  let allowCsv = false;
  let revoke = false;
  let fixture;
  fixture = await mount(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === "unlock") return jsonResponse({ access_grant: "grant-memory", report: { name: "Members", allow_csv: allowCsv } });
    if (body.action === "preview") {
      if (revoke) return jsonResponse({ message: "Not found" }, 404);
      return jsonResponse({ sort_job: { id: "job-2", status: "complete" },
        columns: [{ label: "Name" }], data: [{ id: "r1", values: ["Mina"] }],
        total: 1, page: 1, pageSize: 50, has_more: false });
    }
    return jsonResponse({ report: { name: "Members", allow_csv: allowCsv } });
  });
  try {
    assert.equal([...fixture.container.querySelectorAll("button")].some((button) => button.textContent.includes("Download CSV")), false);
    await act(async () => click([...fixture.container.querySelectorAll("button")].find((button) => button.textContent.includes("Open report"))));
    await act(async () => wait());
    assert.match(fixture.container.textContent, /Mina/);
    assert.equal([...fixture.container.querySelectorAll("button")].some((button) => button.textContent.includes("Download CSV")), false);
    revoke = true;
    const refresh = [...fixture.container.querySelectorAll("button")].find((button) => button.textContent.includes("Refresh data"));
    await act(async () => click(refresh));
    await act(async () => wait());
    assert.doesNotMatch(fixture.container.textContent, /Mina/);
    assert.match(fixture.container.textContent, /Link unavailable/);
  } finally { await fixture.cleanup(); }
});

test("CSV export is exposed only for an authenticated report that allows CSV", async () => {
  const actions = [];
  const fixture = await mount(async (_url, options) => {
    const body = JSON.parse(options.body);
    actions.push(body.export_action || body.action);
    if (body.action === "unlock") return jsonResponse({ access_grant: "grant-only-in-memory", report: { name: "Allowed report", allow_csv: true } });
    if (body.action === "preview") return jsonResponse({ sort_job: { id: "job-3", status: "complete" },
      columns: [{ label: "Department" }], data: [{ id: "r1", values: ["Clinical"] }], total: 1, page: 1, pageSize: 50, has_more: false });
    if (body.export_action === "start") return jsonResponse({ id: "export-1", status: "queued", chunk_count: 1, filename: "report.csv" });
    if (body.export_action === "process") return jsonResponse({ id: "export-1", status: "complete", chunk_count: 1, filename: "report.csv" });
    if (body.export_action === "chunk") return jsonResponse({ csv_text: "Department\\nClinical\\n" });
    if (body.export_action === "status") return jsonResponse({ status: "complete", filename: "report.csv" });
    return jsonResponse({});
  });
  try {
    await act(async () => click([...fixture.container.querySelectorAll("button")].find((button) => button.textContent.includes("Open report"))));
    await act(async () => wait());
    const download = [...fixture.container.querySelectorAll("button")].find((button) => button.textContent.includes("Download CSV"));
    assert.ok(download);
    await act(async () => click(download));
    await act(async () => wait());
    assert.deepEqual(actions.filter((action) => ["start", "process", "chunk", "status"].includes(action)), ["start", "process", "chunk", "status"]);
  } finally { await fixture.cleanup(); }
});

test("sharing admin control requires a strong first password and explicit acknowledgement before public access", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    if (!options.method) return jsonResponse({ enabled: false, password_required: true, allow_csv: false, url: null, can_manage: true });
    const body = JSON.parse(options.body);
    calls.push(body);
    return jsonResponse({ enabled: body.enabled, password_required: body.password_required,
      allow_csv: body.allow_csv, url: body.enabled ? "https://example.test/shared-reports/capability" : null, can_manage: true });
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ReportSharingControls objectId="department" report={{ id: "saved-1", name: "Roster" }} dirty={false} />));
    await act(async () => wait());
    const toggles = container.querySelectorAll('input[type="checkbox"]');
    await act(async () => click(toggles[0]));
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Save sharing"));
    assert.equal(save.disabled, true);
    const password = container.querySelector('input[type="password"]');
    await act(async () => type(password, "abcdefghijkl"));
    assert.equal(save.disabled, false);
    await act(async () => click(save));
    await act(async () => wait());
    assert.equal(calls[0].action, "save");
    assert.equal(calls[0].password, "abcdefghijkl");

    const passwordToggle = container.querySelectorAll('input[type="checkbox"]')[1];
    await act(async () => click(passwordToggle));
    const ack = [...container.querySelectorAll("label")].find((label) => label.textContent.includes("I understand this link"));
    assert.ok(ack);
    const acknowledgement = ack.querySelector("input");
    const saveAgain = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Save sharing"));
    assert.equal(saveAgain.disabled, true);
    await act(async () => click(acknowledgement));
    assert.equal(saveAgain.disabled, false);
    await act(async () => click(saveAgain));
    await act(async () => wait());
    assert.equal(calls[1].acknowledge_public, true);
    assert.equal(calls[1].password_required, false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test("sharing copies only the server capability URL and rotation/revocation update that external link", async () => {
  const originalFetch = globalThis.fetch;
  const originalConfirm = window.confirm;
  const originalClipboard = window.navigator.clipboard;
  const copied = [];
  const requests = [];
  const internalUrl = "https://association.example/CustomObjectsAdmin/department/reports?report_id=saved-2";
  let settings = { enabled: true, password_required: true, allow_csv: false,
    url: "https://association.example/shared-reports/capability-one", can_manage: true };
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (value) => copied.push(value) } });
  window.confirm = () => true;
  globalThis.fetch = async (_url, options = {}) => {
    if (!options.method) return jsonResponse(settings);
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.action === "rotate") settings = { ...settings, url: "https://association.example/shared-reports/capability-two" };
    if (body.action === "revoke") settings = { ...settings, enabled: false, url: null };
    return jsonResponse(settings);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ReportSharingControls objectId="department" report={{ id: "saved-2" }} dirty={false} />));
    await act(async () => wait());
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("Copy external link"))));
    await act(async () => wait());
    assert.deepEqual(copied, ["https://association.example/shared-reports/capability-one"]);
    assert.notEqual(copied[0], internalUrl);
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent.includes("Rotate link"))));
    await act(async () => wait());
    assert.equal(requests.at(-1).action, "rotate");
    assert.match(container.textContent, /capability-two/);
    await act(async () => click([...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Revoke")));
    await act(async () => wait());
    assert.equal(requests.at(-1).action, "revoke");
    assert.doesNotMatch(container.textContent, /capability-two/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    window.confirm = originalConfirm;
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: originalClipboard });
  }
});

test("internal link publishing uses its own endpoint and never changes external sharing", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) return jsonResponse({ url: "/internal-reports/object-a/report-b", ready: false });
    return jsonResponse({ url: "/internal-reports/object-a/report-b", ready: true });
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<InternalReportLink objectId="object-a" report={{ id: "report-b" }} dirty={false} />));
    await act(async () => wait());
    assert.match(container.textContent, /\/internal-reports\/object-a\/report-b/);
    const publish = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Prepare internal report"));
    assert.ok(publish);
    await act(async () => click(publish));
    await act(async () => wait());
    assert.ok(container.querySelector("button")?.textContent.includes("Copy internal link"));
    assert.deepEqual(calls.map((call) => call.url), [
      "/api/internal-reports/link?object_id=object-a&report_id=report-b",
      "/api/internal-reports/link",
    ]);
    assert.deepEqual(JSON.parse(calls[1].options.body), { object_id: "object-a", report_id: "report-b" });
    assert.ok(calls.every((call) => !call.url.includes("report-sharing")));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test("CSV chunks are discarded when access expires before the final status fence", async () => {
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const createdBlobs = [];
  globalThis.URL.createObjectURL = (blob) => { createdBlobs.push(blob); return "blob:should-not-download"; };
  const fetchMock = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === "unlock") return jsonResponse({ access_grant: "grant-memory", report: { name: "Allowed report", allow_csv: true } });
    if (body.action === "preview") return jsonResponse({ sort_job: { id: "job-fence", status: "complete" },
      columns: [{ label: "Department" }], data: [{ id: "r1", values: ["Clinical"] }], total: 1, page: 1, pageSize: 50, has_more: false });
    if (body.export_action === "start") return jsonResponse({ id: "export-fence", status: "complete", chunk_count: 2 });
    if (body.export_action === "chunk" && body.chunk_index === 0) return jsonResponse({ csv_text: "Department\\nClinical\\n" });
    if (body.export_action === "chunk") return jsonResponse({ message: "Access expired" }, 401);
    return jsonResponse({ status: "complete" });
  };
  const fixture = await mount(fetchMock);
  try {
    await act(async () => click([...fixture.container.querySelectorAll("button")].find((button) => button.textContent.includes("Open report"))));
    await act(async () => wait());
    await act(async () => click([...fixture.container.querySelectorAll("button")].find((button) => button.textContent.includes("Download CSV"))));
    await act(async () => wait());
    assert.equal(createdBlobs.length, 0);
    assert.match(fixture.container.textContent, /Private report/);
  } finally {
    await fixture.cleanup();
    globalThis.URL.createObjectURL = originalCreateObjectURL;
  }
});

test("internal report opens with session credentials and a 409 offers a fresh unlock without a password gate", async () => {
  const requests = [];
  let unlocks = 0;
  const fixture = await mountInternal(async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    if (body.action === "unlock") {
      unlocks += 1;
      return jsonResponse({ access_grant: `session-${unlocks}`, expires_at: "soon", report: { name: "Committee roster", allow_csv: false } });
    }
    if (body.action === "preview" && unlocks === 1) return jsonResponse({ message: "Permission revision changed" }, 409);
    if (body.action === "preview") return jsonResponse({ sort_job: { id: "internal-snapshot", status: "complete" },
      columns: [{ label: "Committee" }], data: [{ id: "row-1", values: ["Finance"] }], total: 1, page: 1, pageSize: 50, has_more: false });
    return jsonResponse({ report: { name: "Committee roster", allow_csv: false } });
  });
  try {
    await act(async () => wait());
    assert.match(fixture.container.textContent, /Report access changed/);
    assert.equal(fixture.container.querySelector('input[type="password"]'), null);
    assert.equal(fixture.container.querySelector("table"), null);
    assert.equal(unlocks, 1);
    const retry = [...fixture.container.querySelectorAll("button")].find((button) => button.textContent.includes("Retry access check"));
    await act(async () => click(retry));
    await act(async () => wait());
    assert.equal(unlocks, 2);
    assert.match(fixture.container.textContent, /Finance/);
    assert.ok(requests.every(({ url, options, body }) => url === "/api/internal-reports/view"
      && options.credentials === "include" && body.object_id === "object-9" && body.report_id === "report-4"));
    assert.ok(requests.every(({ body }) => !("password" in body) && !("token" in body)));
  } finally { await fixture.cleanup(); }
});

test("internal 403 reveals no report data and no report controls", async () => {
  const fixture = await mountInternal(async () => jsonResponse({ message: "Forbidden" }, 403));
  try {
    await act(async () => wait());
    assert.match(fixture.container.textContent, /do not have access/);
    assert.doesNotMatch(fixture.container.textContent, /Committee roster|Download CSV|Refresh data/);
    assert.equal(fixture.container.querySelector("table"), null);
    assert.equal([...fixture.container.querySelectorAll("button")].some((button) => button.textContent.includes("Retry access check")), false);
  } finally { await fixture.cleanup(); }
});
