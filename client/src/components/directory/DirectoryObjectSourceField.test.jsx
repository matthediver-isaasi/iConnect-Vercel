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
  DirectoryObjectSourceGroup,
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
    client,
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
  field_label: "Office phone",
  object_label: "People",
  relationship_label: "Team members",
  field_id: fieldType,
  field: {
    field_type: fieldType,
    options: fieldType === "dropdown" ? [{ value: "a", label: "Option A" }] : [],
  },
});

const groupedSource = (fieldId, fieldType = "text", extra = {}) => ({
  ...source(fieldType),
  key: `object-field:relationship:source:object:${fieldId}`,
  relationship_id: "relationship",
  object_id: "object",
  direction: "source",
  field_id: fieldId,
  field_label: fieldId,
  field: { field_type: fieldType, options: [] },
  ...extra,
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
  assert.doesNotMatch(view.container.textContent, /Record one/);
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

test("uses concise source context and field label for a single linked record", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    source: { ...source(), field_label: "Name", object_label: "People", relationship_label: "Board" },
    values: { has_multiple_records: false },
    items: [{ record_id: "record-1", label: "Maya Chen", value: "Maya Chen" }],
    nextCursor: null,
  }), { status: 200 });
  const view = await mount(<DirectoryObjectSourceField source={source()} organizationId="org-1" />);
  assert.match(view.container.textContent, /People · Board/);
  assert.match(view.container.textContent, /Name/);
  assert.equal((view.container.textContent.match(/Maya Chen/g) || []).length, 1);
  assert.equal(view.container.querySelectorAll("svg").length, 0);
  await view.cleanup();
});

test("keeps every multiple-record value associated with its record, including equal labels", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    source: source(),
    values: { has_multiple_records: true },
    items: [
      { record_id: "record-a", label: "Alex Kim", value: "Operations" },
      { record_id: "record-b", label: "Alex Kim", value: "Finance" },
    ],
    nextCursor: null,
  }), { status: 200 });
  const view = await mount(<DirectoryObjectSourceField source={source()} organizationId="org-1" />);
  const groups = view.container.querySelectorAll(".rounded-md");
  assert.equal(groups.length, 2);
  assert.match(groups[0].textContent, /Alex Kim[\s\S]*Operations/);
  assert.match(groups[1].textContent, /Alex Kim[\s\S]*Finance/);
  await view.cleanup();
});

test("groups multiple fields by stable record id and names equal-label records once", async () => {
  const name = groupedSource("Name", "text", { is_primary_display_field: true });
  const role = groupedSource("Role");
  const alias = groupedSource("Alias", "text", { field_label: "Name" });
  globalThis.fetch = async url => {
    const decoded = decodeURIComponent(String(url));
    const isName = decoded.includes(name.key);
    const isAlias = decoded.includes(alias.key);
    return new Response(JSON.stringify({
      source: isName ? name : (isAlias ? alias : role),
      items: isName ? [
        { record_id: "record-a", label: "Alex Kim", value: "Alex Kim" },
        { record_id: "record-b", label: "Alex Kim", value: "Alex Kim" },
      ] : (isAlias ? [
        { record_id: "record-a", label: "Alex Kim", value: "A. Kim" },
      ] : [
        { record_id: "record-a", label: "Alex Kim", value: "Operations" },
        { record_id: "record-b", label: "Alex Kim", value: "Finance" },
      ]),
      nextCursor: null,
    }), { status: 200 });
  };
  const view = await mount(
    <DirectoryObjectSourceGroup sources={[name, role, alias]} organizationId="org-1" />,
  );
  const records = view.container.querySelectorAll("[data-testid^='directory-object-record-']");
  assert.equal(records.length, 2);
  assert.match(records[0].textContent, /Alex Kim[\s\S]*Operations/);
  assert.match(records[1].textContent, /Alex Kim[\s\S]*Finance/);
  assert.equal((records[0].textContent.match(/Alex Kim/g) || []).length, 1);
  assert.equal((records[1].textContent.match(/Alex Kim/g) || []).length, 1);
  assert.doesNotMatch(view.container.textContent, /NameAlex Kim/);
  assert.match(records[0].textContent, /NameA\. Kim/);
  await view.cleanup();
});

test("does not align missing field values by label or array index", async () => {
  const email = groupedSource("Email", "email");
  const phone = groupedSource("Phone");
  globalThis.fetch = async url => {
    const isEmail = decodeURIComponent(String(url)).includes(email.key);
    return new Response(JSON.stringify({
      source: isEmail ? email : phone,
      items: isEmail
        ? [{ record_id: "record-a", label: "Same label", value: "a@example.test" }]
        : [{ record_id: "record-b", label: "Same label", value: "020 1234" }],
      nextCursor: null,
    }), { status: 200 });
  };
  const view = await mount(
    <DirectoryObjectSourceGroup sources={[email, phone]} organizationId="org-1" />,
  );
  const first = view.container.querySelector("[data-testid='directory-object-record-record-a']");
  const second = view.container.querySelector("[data-testid='directory-object-record-record-b']");
  assert.match(first.textContent, /a@example\.test/);
  assert.doesNotMatch(first.textContent, /020 1234/);
  assert.match(second.textContent, /020 1234/);
  assert.doesNotMatch(second.textContent, /a@example\.test/);
  await view.cleanup();
});

test("keeps loaded records visible when one source pagination fails", async () => {
  const office = groupedSource("Office");
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        source: office,
        items: [{ record_id: "record-a", label: "Aarhus", value: "Mindet 6" }],
        nextCursor: "page-2",
      }), { status: 200 });
    }
    return new Response("failure", { status: 500 });
  };
  const view = await mount(
    <DirectoryObjectSourceGroup sources={[office]} organizationId="org-1" />,
  );
  const loadMore = [...view.container.querySelectorAll("button")]
    .find(button => button.textContent.includes("Load more Office"));
  assert.ok(loadMore);
  await act(async () => loadMore.click());
  await settle();
  assert.match(view.container.textContent, /Aarhus[\s\S]*Mindet 6/);
  assert.match(view.container.textContent, /Office unavailable/);
  assert.ok([...view.container.querySelectorAll("button")]
    .some(button => button.textContent.includes("Retry")));
  await view.cleanup();
});

test("hides stale group values while a source is revalidating", async () => {
  const office = groupedSource("Office");
  let calls = 0;
  let releaseRevalidation;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        source: office,
        items: [{ record_id: "record-a", label: "Aarhus", value: "Old address" }],
        nextCursor: null,
      }), { status: 200 });
    }
    return new Promise(resolve => {
      releaseRevalidation = () => resolve(new Response(JSON.stringify({
        source: office,
        items: [{ record_id: "record-a", label: "Aarhus", value: "New address" }],
        nextCursor: null,
      }), { status: 200 }));
    });
  };
  const view = await mount(
    <DirectoryObjectSourceGroup sources={[office]} organizationId="org-1" />,
  );
  assert.match(view.container.textContent, /Old address/);
  act(() => {
    void view.client.refetchQueries({
      queryKey: [
        "directory-object-source-values",
        "tenant-1",
        "viewer-1",
        "main",
        "org-1",
        office.key,
      ],
    });
  });
  await settle();
  assert.doesNotMatch(view.container.textContent, /Old address/);
  assert.match(view.container.textContent, /Loading Office/);
  releaseRevalidation();
  await settle();
  assert.match(view.container.textContent, /New address/);
  await view.cleanup();
});

test("never renders a previous organization snapshot after scope changes", async () => {
  const office = groupedSource("Office");
  let releaseSecondOrganization;
  globalThis.fetch = async url => {
    const organizationId = new URL(String(url), window.location.href)
      .searchParams.get("organization_id");
    if (organizationId === "org-1") {
      return new Response(JSON.stringify({
        source: office,
        items: [{ record_id: "record-a", label: "Aarhus", value: "Org one only" }],
        nextCursor: null,
      }), { status: 200 });
    }
    return new Promise(resolve => {
      releaseSecondOrganization = () => resolve(new Response(JSON.stringify({
        source: office,
        items: [{ record_id: "record-b", label: "London", value: "Org two only" }],
        nextCursor: null,
      }), { status: 200 }));
    });
  };
  function OrganizationSwitcher() {
    const [organizationId, setOrganizationId] = React.useState("org-1");
    return <>
      <button onClick={() => setOrganizationId("org-2")}>Switch organization</button>
      <DirectoryObjectSourceGroup sources={[office]} organizationId={organizationId} />
    </>;
  }
  const view = await mount(<OrganizationSwitcher />);
  assert.match(view.container.textContent, /Org one only/);
  const switchButton = [...view.container.querySelectorAll("button")]
    .find(button => button.textContent === "Switch organization");
  await act(async () => switchButton.click());
  assert.doesNotMatch(view.container.textContent, /Org one only/);
  releaseSecondOrganization();
  await settle();
  assert.match(view.container.textContent, /Org two only/);
  await view.cleanup();
});

test("never renders a previous viewer snapshot after identity changes", async () => {
  const office = groupedSource("Office");
  let calls = 0;
  let releaseSecondViewer;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        source: office,
        items: [{ record_id: "record-a", label: "Aarhus", value: "Viewer one only" }],
        nextCursor: null,
      }), { status: 200 });
    }
    return new Promise(resolve => {
      releaseSecondViewer = () => resolve(new Response(JSON.stringify({
        source: office,
        items: [{ record_id: "record-b", label: "London", value: "Viewer two only" }],
        nextCursor: null,
      }), { status: 200 }));
    });
  };
  function IdentitySwitcher() {
    const context = useLayoutContext();
    return <>
      <button onClick={() => context.setMemberInfo({ id: "viewer-2", tenant_id: "tenant-1" })}>
        Switch viewer
      </button>
      <DirectoryObjectSourceGroup sources={[office]} organizationId="org-1" />
    </>;
  }
  const view = await mount(<IdentitySwitcher />);
  assert.match(view.container.textContent, /Viewer one only/);
  const switchButton = [...view.container.querySelectorAll("button")]
    .find(button => button.textContent === "Switch viewer");
  await act(async () => switchButton.click());
  assert.doesNotMatch(view.container.textContent, /Viewer one only/);
  releaseSecondViewer();
  await settle();
  assert.match(view.container.textContent, /Viewer two only/);
  await view.cleanup();
});

test("group values retain safe link rendering and per-source revocation", async () => {
  const website = groupedSource("Website", "url");
  const unsafe = groupedSource("Unsafe", "url");
  const revoked = groupedSource("Private");
  globalThis.fetch = async url => {
    const decoded = decodeURIComponent(String(url));
    if (decoded.includes(revoked.key)) {
      return new Response(JSON.stringify({ error: "revoked" }), { status: 403 });
    }
    const isUnsafe = decoded.includes(unsafe.key);
    const current = isUnsafe ? unsafe : website;
    return new Response(JSON.stringify({
      source: current,
      items: [{
        record_id: "record-a",
        label: "Record A",
        value: isUnsafe ? "javascript:alert(1)" : "https://example.test/path",
      }],
      nextCursor: null,
    }), { status: 200 });
  };
  const view = await mount(
    <DirectoryObjectSourceGroup sources={[website, unsafe, revoked]} organizationId="org-1" />,
  );
  const links = [...view.container.querySelectorAll("a")];
  assert.ok(links.some(link => link.href === "https://example.test/path"));
  assert.ok(!links.some(link => link.href.startsWith("javascript:")));
  assert.doesNotMatch(view.container.textContent, /Private unavailable/);
  await view.cleanup();
});

test("can suppress only a repeated consecutive context without suppressing its field values", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    source: source(),
    values: { has_multiple_records: false },
    items: [{ record_id: "aarhus-office", label: "Aarhus office", value: "Mindet 6, 8000 Aarhus C" }],
    nextCursor: null,
  }), { status: 200 });
  const view = await mount(
    <DirectoryObjectSourceField source={source()} organizationId="org-1" showContext={false} />,
  );
  assert.doesNotMatch(view.container.textContent, /People · Team members/);
  assert.match(view.container.textContent, /Office phone/);
  assert.match(view.container.textContent, /Mindet 6, 8000 Aarhus C/);
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
  assert.match(view.container.textContent, /value/);
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
