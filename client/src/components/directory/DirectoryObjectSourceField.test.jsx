import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://tenant.example.test/directory",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
globalThis.React = React;
const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { LayoutProvider, useLayoutContext } = await import("../../contexts/LayoutContext.jsx");
const {
  DirectoryObjectSourceField,
  DirectoryObjectSourcesStatus,
} = await import("./DirectoryObjectSourceField.jsx");
const {
  useDirectoryObjectSources,
  isDirectoryEmbedLocation,
} = await import("../../hooks/useDirectoryObjectSources.js");

function Identity({ children }) {
  const context = useLayoutContext();
  useEffect(() => {
    context.setMemberInfo({ id: "viewer-1", tenant_id: "tenant-1" });
    context.setSessionValidated(true);
    context.setAuthResolved(true);
  }, []);
  return children;
}

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
  });
}

async function mount(child) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <LayoutProvider><Identity>{child}</Identity></LayoutProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

const source = (fieldType = "text") => ({
  key: `object-field:relationship:source:object:${fieldType}`,
  label: "Related details",
  field_id: fieldType,
  field: {
    field_type: fieldType,
    options: fieldType === "dropdown" ? [{ value: "a", label: "Option A" }] : [],
  },
});

test("omits an empty terminal source section", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    source: source(),
    items: [],
    nextCursor: null,
  }), { status: 200 });
  const view = await mount(
    <DirectoryObjectSourceField source={source()} organizationId="org-1" />,
  );
  assert.equal(view.container.textContent, "");
  await view.cleanup();
});

test("omits a source whose access was revoked after metadata loaded", async () => {
  for (const status of [401, 403, 404]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Source unavailable" }), { status });
    const view = await mount(
      <DirectoryObjectSourceField source={source()} organizationId="org-1" />,
    );
    assert.equal(view.container.textContent, "");
    await view.cleanup();
  }
});

test("file links use only the source-authorized download endpoint", async () => {
  const download = "/api/organisation-directory/custom-object-file?source_key=source&record_id=record";
  globalThis.fetch = async () => new Response(JSON.stringify({
    source: source("file"),
    items: [{
      record_id: "record-1", label: "Record one",
      value: [
        { file_name: "Report.pdf", file_url: download },
        { file_name: "Unsafe.pdf", file_url: "/api/storage/secure-url?path=private" },
      ],
    }],
    nextCursor: null,
  }), { status: 200 });
  const view = await mount(
    <DirectoryObjectSourceField source={source("file")} organizationId="org-1" />,
  );
  const links = view.container.querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), download);
  assert.equal(links[0].textContent, "Report.pdf");
  await view.cleanup();
});

test("unverifiable legacy files explain the required re-upload without exposing a link", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    source: source("file"),
    items: [{ record_id: "record-1", label: "Record one", value: { unavailable: true } }],
    nextCursor: null,
  }), { status: 200 });
  const view = await mount(
    <DirectoryObjectSourceField source={source("file")} organizationId="org-1" />,
  );
  assert.match(view.container.textContent, /must be re-uploaded in Data Studio/);
  assert.equal(view.container.querySelectorAll("a").length, 0);
  await view.cleanup();
});

test("keeps empty cursor pages reachable and loads the next page", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(calls === 1 ? {
      source: source("number"), items: [], nextCursor: "page-2",
    } : {
      source: source("number"),
      items: [{ record_id: "record-1", label: "Record one", value: 0 }],
      nextCursor: null,
    }), { status: 200 });
  };
  const view = await mount(
    <DirectoryObjectSourceField source={source("number")} organizationId="org-1" />,
  );
  const button = [...view.container.querySelectorAll("button")]
    .find(item => item.textContent.includes("Load more"));
  assert.ok(button, `calls=${calls}; text=${view.container.textContent}`);
  await act(async () => button.click());
  await settle();
  assert.match(view.container.textContent, /Record one/);
  assert.match(view.container.textContent, /0/);
  await view.cleanup();
});

test("renders false and dropdown values with their field types", async () => {
  globalThis.fetch = async url => {
    const isBoolean = String(url).includes("boolean");
    const fieldType = isBoolean ? "boolean" : "dropdown";
    return new Response(JSON.stringify({
      source: source(fieldType),
      items: [{
        record_id: fieldType,
        label: fieldType,
        value: isBoolean ? false : "a",
      }],
      nextCursor: null,
    }), { status: 200 });
  };
  const view = await mount(<>
    <DirectoryObjectSourceField source={source("boolean")} organizationId="org-1" />
    <DirectoryObjectSourceField source={source("dropdown")} organizationId="org-1" />
  </>);
  assert.match(view.container.textContent, /No/);
  assert.match(view.container.textContent, /Option A/);
  await view.cleanup();
});

test("shows value errors and retries successfully", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("failure", { status: 500 });
    return new Response(JSON.stringify({
      source: source(),
      items: [{ record_id: "record-1", label: "Recovered", value: "value" }],
      nextCursor: null,
    }), { status: 200 });
  };
  const view = await mount(
    <DirectoryObjectSourceField source={source()} organizationId="org-1" />,
  );
  assert.match(view.container.textContent, /Values unavailable/);
  const retry = [...view.container.querySelectorAll("button")]
    .find(item => item.textContent.includes("Retry"));
  await act(async () => retry.click());
  await settle();
  assert.match(view.container.textContent, /Recovered/);
  await view.cleanup();
});

function MetadataProbe() {
  const query = useDirectoryObjectSources();
  return <div><DirectoryObjectSourcesStatus query={query} /></div>;
}

test("metadata rejects invalid payloads and exposes retry UI", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
  const view = await mount(<MetadataProbe />);
  assert.match(view.container.textContent, /Custom object fields unavailable/);
  assert.ok([...view.container.querySelectorAll("button")]
    .some(item => item.textContent.includes("Retry")));
  await view.cleanup();
});

test("metadata hook does not fetch in embed mode", async () => {
  window.history.pushState({}, "", "/directory?embed=true");
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ sources: [] }), { status: 200 });
  };
  const view = await mount(<MetadataProbe />);
  assert.equal(calls, 0);
  await view.cleanup();
  window.history.pushState({}, "", "/directory");
});

test("embed detection ignores normal framed previews but blocks explicit embed routes", () => {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  assert.notEqual(iframe.contentWindow.self, iframe.contentWindow.top);
  assert.equal(isDirectoryEmbedLocation({
    pathname: "/OrganisationDirectory",
    search: "",
  }), false);
  assert.equal(isDirectoryEmbedLocation({ pathname: "/embed/resource/example", search: "" }), true);
  assert.equal(isDirectoryEmbedLocation({ pathname: "/directory", search: "?embed=true" }), true);
  iframe.remove();
});

test("renders only safe URL and email links", async () => {
  globalThis.fetch = async url => {
    const key = decodeURIComponent(String(url));
    const isEmail = key.includes(":email");
    const isUnsafe = key.includes(":url-unsafe");
    const fieldType = isEmail ? "email" : "url";
    return new Response(JSON.stringify({
      source: source(fieldType),
      items: [{
        record_id: key,
        label: fieldType,
        value: isEmail ? "person@example.test" : (isUnsafe ? "javascript:alert(1)" : "https://example.test/path"),
      }],
      nextCursor: null,
    }), { status: 200 });
  };
  const unsafe = { ...source("url"), key: "object-field:r:source:o:url-unsafe" };
  const view = await mount(<>
    <DirectoryObjectSourceField source={source("url")} organizationId="org-1" />
    <DirectoryObjectSourceField source={unsafe} organizationId="org-1" />
    <DirectoryObjectSourceField source={source("email")} organizationId="org-1" />
  </>);
  const links = [...view.container.querySelectorAll("a")];
  assert.ok(links.some(link => link.href === "https://example.test/path"));
  assert.ok(links.some(link => link.href === "mailto:person@example.test"));
  assert.ok(!links.some(link => link.href.startsWith("javascript:")));
  await view.cleanup();
});
