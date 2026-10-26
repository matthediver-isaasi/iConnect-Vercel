// Run: node --test client/src/components/canvas/blocks/directoryDetails.test.mjs
// Mount the actual renderer, cards, guest dialog and detail query. Only unrelated
// Canvas registry/field controls and file-upload plumbing are replaced.
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build, transform } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BLOCK_TYPES, createBlock, normalizeCanvasDesign } from "../../../lib/canvasDesign.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "getComputedStyle"]) {
  globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const source = await readFile(new URL("./dynamicBlocks.jsx", import.meta.url), "utf8");
const page = await readFile(new URL("../../../pages/DynamicDirectoryView.jsx", import.meta.url), "utf8");
const getFunction = name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
};
const directory = { slug: "partner-directory", id: "directory-a", custom_fields_label: "Specialisms" };
const stubs = {
  "@/api/publicClient": "export const publicClient = { getTenantSlug: () => 'westhaven' };",
  "@/components/CustomFieldFileUpload": "export const CustomFieldFileDisplay = ({value}) => <span>{String(value || '')}</span>;",
};
const temporary = await mkdtemp(path.join(process.cwd(), ".directory-details-test-"));
const outfile = path.join(temporary, "bundle.mjs");
await build({
  stdin: {
    contents: `
       import { useMemo, useState, useEffect, useRef, useId, useContext, createContext } from 'react';
       import { Search, ChevronLeft, ChevronRight, User } from 'lucide-react';
      import { Input } from '@/components/ui/input';
      import { Button } from '@/components/ui/button';
      import { DirectoryMemberCard, DirectoryOrganizationCard } from '@/components/directory/DirectoryCards';
      import CanvasDirectoryDetails from '@/components/canvas/blocks/CanvasDirectoryDetails';
       import DirectoryDetailsToggle from '@/components/canvas/blocks/DirectoryDetailsToggle';
       import DirectoryVisitorFilterDropdown from '@/components/canvas/blocks/DirectoryVisitorFilterDropdown';
       import { normalizeVisitorFilterFields, pruneVisitorFilters, visitorFiltersKey } from '@/components/canvas/blocks/directoryVisitorFilters.mjs';
       import { useQuery } from '@tanstack/react-query';
       import { resolveDirectoryCarouselSource, presentDirectoryCarouselRecord, resolveDirectoryCarouselPerView, resolveDirectoryCarouselOrganisationNameDisplay } from '@/components/canvas/blocks/directoryCarouselSource.mjs';
       import { resolveResponsiveValue, hasAnyResponsiveValue, resolveBlockAtBreakpoint } from '@/lib/canvasDesign';
      import { BLOCK_TYPES } from '@/lib/canvasDesign';
       ${getFunction("parseFilterOverrides")}
       ${getFunction("useDirectoryRecords").replace("function useDirectoryRecords(", "function actualDirectoryRecords(")}
       const useDirectoryRecords = props => {
         globalThis.__directoryQueryArguments = props;
         globalThis.__directoryQueryHistory.push(props);
         return globalThis.__useActualDirectoryQuery ? actualDirectoryRecords(props) : globalThis.__directoryDetailsRecords;
       };
       const useDirectoryCarouselRecords = useDirectoryRecords;
       const useLayoutContext = () => ({});
       const publicClient = { getTenantSlug: () => 'westhaven' };
       const DirectoryCarouselBootstrapContext = createContext(null);
       const directoryCarouselViewerIdentity = () => 'guest';
       const directoryCarouselBlockKey = () => 'carousel';
       const createDirectoryCarouselVisitSeed = () => 'visit';
       const useCarouselBreakpoint = breakpoint => breakpoint || 'desktop';
       const CarouselStage = ({children}) => children;
       const DirectoryCarouselImage = () => <img alt="" src="/logo.png" />;
       const DirectoryCarouselSourceField = () => null;
       const resolveNewTab = (value, fallback) => value.newTab ?? fallback;
       const ResponsiveNumberField = () => null;
       const Label = ({children}) => <label>{children}</label>;
      const TooltipProvider = ({children}) => children;
      const Select = ({children}) => <div>{children}</div>;
      const SelectTrigger = ({children}) => <div>{children}</div>;
      const SelectContent = () => null;
      const SelectValue = () => null;
      const SelectItem = () => null;
      const ListSkeleton = () => <div aria-busy="true" />;
      const EmptyState = ({text}) => <p>{text}</p>;
      const ErrorState = ({message}) => <p role="alert">{message}</p>;
      const Heading = ({children}) => <h2>{children}</h2>;
      const buildResponsiveListGridCss = () => '';
      const DirectoryPickerField = () => null;
      const TextField = () => null;
      const SelectField = () => null;
      const NumberField = () => null;
      const PerBreakpointColumns = () => null;
      const ToggleField = ({label, value, onChange, testId}) =>
        <button role="switch" aria-label={label} aria-checked={value}
          data-testid={testId} onClick={() => onChange(!value)}>{label}</button>;
      ${getFunction("columnsForBreakpoint")}
      ${getFunction("gridStyle")}
      ${getFunction("isEditorPreviewBreakpoint")}
       ${getFunction("DirectoryCarouselCard")}
       ${getFunction("DirectoryCarouselRender")}
       ${getFunction("DirectoryCarouselInspector")}
       ${getFunction("resolveDirectoryCarouselWebsiteUrl")}
       const buildDirectoryCarouselIndicatorItems = () => [];
      ${getFunction("DirectoryCardsRender")}
      ${getFunction("DynamicDirectoryEmbedInspector")}
       export { DirectoryCardsRender, DynamicDirectoryEmbedInspector, DirectoryCarouselRender, DirectoryCarouselInspector };
    `,
    loader: "jsx", resolveDir: process.cwd(),
  },
  outfile, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic",
  alias: { "@": path.join(process.cwd(), "client/src") },
  plugins: [{
    name: "directory-test-boundaries",
    setup(api) {
      api.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: "stub" } : undefined);
      api.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: stubs[args.path], loader: "jsx", resolveDir: process.cwd() }));
    },
  }],
  logLevel: "silent",
});
const { DirectoryCardsRender, DynamicDirectoryEmbedInspector, DirectoryCarouselRender, DirectoryCarouselInspector } = await import(pathToFileURL(outfile).href);
let container, root, client, block, requests, parentClicks;
const originalFetch = globalThis.fetch;
const member = {
  id: "member-a", first_name: "Mara", last_name: "Ellis", job_title: "Coordinator",
  organization_name: "Westhaven Network", organization_id: "org-a",
  email: "private@example.test", linkedin_url: "#profile",
  customValues: { hidden: "PRIVATE FIELD", second: "Second detail", first: false },
};
const config = {
  directory: { ...directory, back_field_order: ["custom:first", "custom:second", "show_organization"] },
  displaySettings: { show_job_title: { front: true, back: false } },
  roles: [],
  directoryCustomFields: [
    { id: "hidden", label: "Hidden", field_type: "text", _visBack: false, _visFront: false },
    { id: "second", label: "Second field", field_type: "text", _visBack: true },
    { id: "first", label: "First field", field_type: "boolean", _visBack: true },
  ],
};
const pause = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); }); };
const card = () => container.querySelector('[data-testid^="card-member-"],[data-testid^="card-organisation-"],[data-testid^="button-directory-carousel-member"],[data-testid^="button-directory-carousel-org"]');
const dialog = () => document.querySelector('[role="dialog"]');
const click = async element => { await act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); }); await pause(); };
const key = async (element, value) => {
  const event = new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  await act(async () => element.dispatchEvent(event));
  await pause();
  return event;
};
const render = async props => {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement("div", { onClick: () => parentClicks++ },
       React.createElement(block.type === BLOCK_TYPES.DIRECTORY_CAROUSEL ? DirectoryCarouselRender : DirectoryCardsRender, { block, fallbackTitle: "Directory", ...props })))));
  await pause();
};
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  block = createBlock(BLOCK_TYPES.DYNAMIC_DIRECTORY_EMBED, { content: { directorySlug: directory.slug } });
  requests = [];
  parentClicks = 0;
  globalThis.__directoryDetailsRecords = { data: { records: [member], entityType: "member", config } };
  globalThis.__useActualDirectoryQuery = false;
  globalThis.__directoryQueryHistory = [];
  globalThis.fetch = async (...args) => { requests.push(args); throw new Error("Unexpected request"); };
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  globalThis.fetch = originalFetch;
});
after(async () => { await rm(temporary, { recursive: true, force: true }); dom.window.close(); });

test("new and legacy documents default off; explicit opt-in round trips; both canonical guest branches share the dialog", async () => {
  assert.equal(block.content.enableDetails, false);
  const legacy = { ...block, content: { directorySlug: directory.slug } };
  const normalized = normalizeCanvasDesign({ version: 1, root: { sections: [{ id: "root", children: [legacy] }] } });
  assert.equal(normalized.root.sections[0].children[0].content.enableDetails, false);
  assert.equal(createBlock(BLOCK_TYPES.DYNAMIC_DIRECTORY_EMBED, { content: { enableDetails: true } }).content.enableDetails, true);
  assert.equal((page.match(/<DirectoryGuestDetailDialog/g) || []).length, 2);
  await transform(page, { loader: "jsx" });
  await transform(source, { loader: "jsx" });
});

test("inspector updates the persisted flag without replacing other content", async () => {
  let changed;
  await act(async () => root.render(React.createElement(DynamicDirectoryEmbedInspector, {
    block, update: fn => { changed = fn(block); },
  })));
  const toggle = container.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  await click(toggle);
  assert.equal(changed.content.enableDetails, true);
  assert.equal(changed.content.directorySlug, directory.slug);
});

test("legacy/off cards have no detail action, hover affordance or network; clicks still reach editor selection", async () => {
  await render();
  assert.equal(card().getAttribute("role"), null);
  assert.equal(card().getAttribute("tabindex"), null);
  assert.doesNotMatch(card().className, /cursor-pointer|hover:shadow/);
  await click(card());
  assert.equal(parentClicks, 1);
  assert.equal(dialog(), null);
  assert.equal(requests.length, 0);
  block.content.enableDetails = true;
  await render({ asEditor: true, breakpoint: "desktop" });
  await click(card());
  assert.equal(parentClicks, 2);
  assert.equal(dialog(), null);
  assert.equal(card().getAttribute("tabindex"), null);
});

test("preview and published member cards open with keyboard, preserve back visibility/order and guest restrictions", async () => {
  block.content.enableDetails = true;
  for (const breakpoint of ["mobile", undefined]) {
    await render({ breakpoint });
    const trigger = card();
    trigger.focus();
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
    assert.match(trigger.className, /hover:shadow-lg/);
    assert.equal((await key(trigger, breakpoint ? " " : "Enter")).defaultPrevented, true);
    assert.ok(dialog());
    const content = dialog().textContent;
    assert.match(content, /Mara Ellis|Member Information/);
    assert.match(content, /Specialisms/);
    assert.match(content, /First fieldNo/);
    assert.ok(content.indexOf("First field") < content.indexOf("Second field"));
    assert.doesNotMatch(content, /PRIVATE FIELD|private@example|Coordinator|Events Attended|Articles Published|Send Email|LinkedIn Profile/);
    await key(dialog(), "Escape");
    assert.equal(dialog(), null);
    await pause();
    assert.equal(document.activeElement, trigger);
  }
  assert.equal(requests.length, 0, "member details reuse the projected page data");
});

test("nested links do not activate the card; disabling or changing directory closes an open dialog", async () => {
  block.content.enableDetails = true;
  await render();
  const link = card().querySelector('a[href="#profile"]');
  await key(link, "Enter");
  await click(link);
  assert.equal(dialog(), null);
  await click(card());
  assert.ok(dialog());
  block = { ...block, content: { ...block.content, enableDetails: false } };
  await render();
  assert.equal(dialog(), null);
  block = { ...block, content: { ...block.content, enableDetails: true } };
  await render();
  await click(card());
  assert.ok(dialog());
  block = { ...block, content: { ...block.content, directorySlug: "another-directory" } };
  await render();
  assert.equal(dialog(), null);
  assert.equal(card().getAttribute("role"), null, "old-source records cannot activate for a new directory");
});

test("organisation hover obeys settings; scoped canonical details fail closed and can retry", async () => {
  block.content.enableDetails = true;
  globalThis.__directoryDetailsRecords = { data: {
    records: [{ id: "org-a", name: "Westhaven Network", logo_url: "/logo.png" }],
    entityType: "organization",
    config: { directory, displaySettings: { showLogo: true, showNameTooltip: true } },
  } };
  let denied = true;
  globalThis.fetch = async (url, options) => {
    requests.push([url, options]);
    return {
      ok: !denied,
      json: async () => ({
        directory: { ...directory, back_field_order: ["org_phone", "custom:allowed", "custom:hidden", "org_description"] },
        organizations: [{ id: "org-a", name: "Westhaven Network", phone: "+44 20 7946 0823", description: "Member-led network", invoicing_address: "PRIVATE ADDRESS" }],
        displaySettings: {},
        orgCustomFields: [
          { id: "allowed", label: "Focus", field_type: "text", _visBack: true },
          { id: "hidden", label: "Hidden", field_type: "text", _visBack: false },
        ],
        allOrgPreferenceValues: [
          { organization_id: "org-a", field_id: "allowed", value: "Archives" },
          { organization_id: "org-a", field_id: "hidden", value: "PRIVATE VALUE" },
          { organization_id: "other-org", field_id: "allowed", value: "OTHER ORG" },
        ],
      }),
    };
  };
  await render();
  assert.ok(card().querySelector(".group-hover\\:opacity-100"));
  card().focus();
  await key(card(), "Enter");
  assert.match(dialog().textContent, /Couldn't load directory details/);
  assert.doesNotMatch(dialog().textContent, /PRIVATE|Archives/);
  denied = false;
  await click([...dialog().querySelectorAll("button")].find(button => button.textContent === "Retry"));
  assert.match(dialog().textContent, /Archives|Member-led network/);
  assert.doesNotMatch(dialog().textContent, /PRIVATE|OTHER ORG|View Members|Contacts/);
  const text = dialog().textContent;
  assert.ok(text.indexOf("Phone") < text.indexOf("Focus"));
  assert.ok(text.indexOf("Focus") < text.indexOf("Description"));
  assert.equal(requests.length, 2);
  for (const [url, options] of requests) {
    const parsed = new URL(url, window.location.origin);
    assert.equal(parsed.pathname, "/api/dynamic-directory/config");
    assert.equal(parsed.searchParams.get("slug"), directory.slug);
    assert.equal(parsed.searchParams.get("organizationId"), "org-a");
    assert.equal(parsed.searchParams.get("tenant"), "westhaven");
    assert.equal(options.credentials, "include");
  }
  // A renewed authority check must hide the previous public projection while
  // loading, and must not retain it when the selected record is removed.
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  let refresh;
  await act(async () => {
    refresh = client.refetchQueries({ queryKey: ["canvas", "directory-details"] });
  });
  await pause();
  assert.ok(dialog().querySelector('[aria-busy="true"]'));
  assert.match(dialog().querySelector('[role="status"]').textContent, /Loading details/);
  assert.ok(dialog().querySelector('[role="status"] .animate-spin'));
  assert.doesNotMatch(dialog().textContent, /Archives|Member-led network/);
  await act(async () => {
    finish({ ok: true, json: async () => ({ directory, organizations: [] }) });
    await refresh;
  });
  await pause();
  assert.match(dialog().textContent, /Couldn't load directory details/);
  assert.doesNotMatch(dialog().textContent, /Archives|Member-led network/);
  await key(dialog(), "Escape");
  globalThis.__directoryDetailsRecords.data.config.displaySettings.showNameTooltip = false;
  await render();
  assert.equal(card().querySelector(".group-hover\\:opacity-100"), null, "the opt-in does not override tenant hover settings");
  block.content.enableDetails = false;
  await render();
  assert.equal(card().querySelector(".group-hover\\:opacity-100"), null);
});

test("initial click immediately displays a visible loading status while the request is pending", async () => {
  block.content.enableDetails = true;
  globalThis.__directoryDetailsRecords = { data: {
    records: [{ id: "org-a", name: "Westhaven Network" }],
    entityType: "organization",
    config: { directory, displaySettings: {} },
  } };
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  await render();
  await click(card());
  assert.ok(dialog());
  assert.match(dialog().textContent, /Westhaven Network/);
  assert.match(dialog().querySelector('[role="status"]').textContent, /Loading details/);
  assert.ok(dialog().querySelector('.animate-spin'));
  await act(async () => finish({ ok: true, json: async () => ({
    directory, organizations: [{ id: "org-a", name: "Westhaven Network" }],
  }) }));
  await pause();
  assert.equal(dialog().querySelector('[role="status"]'), null);
});

test("a detail response for another directory is rejected, never used as generic entity detail", async () => {
  block.content.enableDetails = true;
  globalThis.__directoryDetailsRecords = { data: {
    records: [{ id: "org-a", name: "Westhaven Network" }],
    entityType: "organization", config: { directory },
  } };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      directory: { slug: "other-directory" },
      organizations: [{ id: "org-a", name: "PRIVATE OTHER DIRECTORY", description: "UNRELATED DETAILS" }],
    }),
  });
  await render();
  await click(card());
  assert.match(dialog().textContent, /Couldn't load directory details/);
  assert.doesNotMatch(dialog().textContent, /PRIVATE|UNRELATED/);
});

test("carousel inspector persists the shared strict opt-in and legacy carousel defaults off", async () => {
  block = createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL, { content: { directorySlug: directory.slug } });
  assert.equal(block.content.enableDetails, false);
  let changed;
  await act(async () => root.render(React.createElement(DirectoryCarouselInspector, {
    block, update: fn => { changed = fn(block); },
  })));
  await click(container.querySelector('[data-testid="toggle-directory-carousel-details"]'));
  assert.equal(changed.content.enableDetails, true);
  assert.equal(changed.content.directorySlug, directory.slug);
  assert.equal(changed.content.perView.desktop, 3);
});

test("carousel off/editor keep selection and logo-only geometry without a detail read", async () => {
  block = createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL, { content: { directorySlug: directory.slug } });
  globalThis.__directoryDetailsRecords = { data: {
    entityType: "organization", records: [{ id: "org-a", name: null, logo_url: "/logo.png" }], total: 1,
  } };
  await render();
  assert.equal(card().tagName, "DIV");
  assert.match(card().querySelector('[data-testid^="directory-carousel-image"]').className, /flex-1/);
  await click(card());
  assert.equal(parentClicks, 1);
  block.content.enableDetails = true;
  await render({ asEditor: true });
  await click(card());
  assert.equal(parentClicks, 2);
  assert.equal(dialog(), null);
  assert.equal(requests.length, 0);
});

test("all carousel sources hydrate the canonical rich dialog on click and keyboard, not the partial card", async () => {
  for (const sourceType of ["dynamic", "primary-member", "primary-organization"]) {
    const entityType = sourceType === "primary-organization" ? "organization" : "member";
    const record = entityType === "member" ? member : { id: "org-a", name: "Westhaven Network" };
    block = createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL, { content: {
      source: sourceType, directoryId: sourceType === "dynamic" ? directory.id : "",
      directorySlug: directory.slug, enableDetails: true, autoplay: false,
    } });
    globalThis.__directoryDetailsRecords = { data: {
      records: [{ id: record.id, name: "Partial card" }], entityType, total: 1,
    } };
    globalThis.fetch = async (url, options) => {
      requests.push([url, options]);
      return { ok: true, json: async () => ({ source: sourceType, detail: {
        record: { ...record, customValues: { second: "Rich reverse-card content" } },
        entityType,
        config: { ...config, orgCustomFields: config.directoryCustomFields },
      } }) };
    };
    await render();
    if (sourceType === "dynamic") await click(card());
    else await key(card(), sourceType === "primary-member" ? "Enter" : " ");
    assert.ok(dialog());
    assert.match(dialog().textContent, /Rich reverse-card content/);
    assert.doesNotMatch(dialog().textContent, /Partial card|PRIVATE FIELD|private@example/);
    const [url, options] = requests.at(-1);
    const params = new URL(url, window.location.origin).searchParams;
    assert.equal(params.get("source"), sourceType);
    assert.equal(params.get("detail_id"), record.id);
    assert.equal(params.get("directory_id"), sourceType === "dynamic" ? directory.id : null);
    assert.equal(params.has("slug"), false, "primary identity and dynamic immutable id win over legacy slug");
    assert.equal(options.credentials, "include");
    await key(dialog(), "Escape");
  }
});

test("carousel rejects old logo-only responses, can retry, and never retains denied rich content", async () => {
  block = createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL, { content: {
    directorySlug: directory.slug, enableDetails: true,
  } });
  globalThis.__directoryDetailsRecords = { data: {
    records: [{ id: member.id, name: "Partial card" }], entityType: "member", total: 1,
  } };
  globalThis.fetch = async () => ({ ok: true, json: async () => globalThis.__directoryDetailsRecords.data });
  await render();
  await click(card());
  assert.match(dialog().textContent, /Couldn't load directory details/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    source: "dynamic", detail: { record: member, entityType: "member", config },
  }) });
  await click([...dialog().querySelectorAll("button")].find(button => button.textContent === "Retry"));
  assert.match(dialog().textContent, /Second detail/);
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  let refresh;
  await act(async () => { refresh = client.refetchQueries({ queryKey: ["canvas", "directory-details"] }); });
  await pause();
  assert.match(dialog().textContent, /Loading details/);
  assert.doesNotMatch(dialog().textContent, /Second detail|Mara Ellis/);
  await act(async () => { finish({ ok: false }); await refresh; });
  await pause();
  assert.doesNotMatch(dialog().textContent, /Second detail|Mara Ellis/);
  assert.match(dialog().textContent, /Couldn't load directory details/);
  block = { ...block, content: { ...block.content, enableDetails: false } };
  await render();
  assert.equal(dialog(), null);
});

test("carousel rejects rich details from another source or directory and closes on source changes", async () => {
  block = createBlock(BLOCK_TYPES.DIRECTORY_CAROUSEL, { content: {
    directoryId: directory.id, directorySlug: directory.slug, enableDetails: true,
  } });
  globalThis.__directoryDetailsRecords = { data: {
    records: [{ id: member.id, name: "Partial card" }], entityType: "member", total: 1,
  } };
  for (const [sourceType, configDirectory] of [["primary-member", directory], ["dynamic", { ...directory, id: "another" }]]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({
      source: sourceType, detail: { record: member, entityType: "member", config: { ...config, directory: configDirectory } },
    }) });
    await render();
    await click(card());
    assert.match(dialog().textContent, /Couldn't load directory details/);
    assert.doesNotMatch(dialog().textContent, /Mara Ellis|Second detail/);
    await key(dialog(), "Escape");
  }
  await click(card());
  block = { ...block, content: { ...block.content, source: "primary-member" } };
  await render();
  assert.equal(dialog(), null);
});

const visitorFields = [
  { id: "region", label: "Region", field_type: "multi_select", options: [
    { value: "north", label: "Northern region" }, { value: "south", label: "Southern region" },
  ] },
  { id: "focus", label: "Focus", field_type: "select", options: [{ value: "arts", label: "Arts and archives" }] },
];
const filterTrigger = () => container.querySelector('[data-testid="button-directory-filters"]');
const filterPopup = () => document.querySelector('[data-testid="directory-filter-popover"]');
const filterChoice = value => [...filterPopup().querySelectorAll("label")].find(label => label.textContent === value).querySelector("input");
const withVisitorMetadata = (fields = visitorFields, extra = {}) => {
  globalThis.__directoryDetailsRecords = { data: {
    records: [member], total: 25, entityType: "member",
    config: { ...config, visitorFilterFields: fields }, ...extra,
  } };
};

test("visitor dropdown groups multiple checkbox choices, summary and clear without changing author filters or editor selection", async () => {
  block.content.filterOverrides = '{"fixed":["author"]}';
  withVisitorMetadata();
  await render({ asEditor: true });
  await click(filterTrigger());
  assert.ok(filterPopup(), "editor guard must not swallow the trigger");
  assert.equal(container.contains(filterPopup()), false, "popup must be portalled");
  assert.equal(filterPopup().querySelectorAll("fieldset").length, 2);
  await click(filterChoice("Northern region"));
  await click(filterChoice("Southern region"));
  await click(filterChoice("Arts and archives"));
  assert.deepEqual(globalThis.__directoryQueryArguments.visitorFilters, { region: ["north", "south"], focus: ["arts"] });
  assert.match(filterTrigger().textContent, /3/);
  assert.match(container.querySelector('[data-testid="directory-filter-summary"]').textContent, /Northern region, Southern region, Arts and archives/);
  assert.equal(block.content.filterOverrides, '{"fixed":["author"]}');
  assert.equal(parentClicks, 0);
  await click(filterPopup().querySelector('[data-testid="button-directory-filters-clear"]'));
  assert.deepEqual(globalThis.__directoryQueryArguments.visitorFilters, {});
  assert.equal(container.querySelector('[data-testid="directory-filter-summary"]'), null);
});

test("visitor change closes details and resets pagination; source changes never query a stale selection or page", async () => {
  block.content.enableDetails = true;
  withVisitorMetadata();
  await render();
  await click(container.querySelector('[data-testid="button-directory-next"]'));
  assert.equal(globalThis.__directoryQueryArguments.page, 2);
  await click(card());
  assert.ok(dialog());
  await click(filterTrigger());
  await click(filterChoice("Northern region"));
  assert.equal([...document.querySelectorAll('[role="dialog"]')].filter(el => el !== filterPopup()).length, 0);
  assert.equal(globalThis.__directoryQueryArguments.page, 1);
  block = { ...block, content: { ...block.content, directorySlug: "new-source" } };
  await render();
  assert.deepEqual(globalThis.__directoryQueryArguments.visitorFilters, {});
  assert.equal(globalThis.__directoryQueryArguments.page, 1);
  assert.equal(filterTrigger(), null, "old metadata must not leak across sources");
  for (const args of globalThis.__directoryQueryHistory.filter(args => args.directorySlug === "new-source")) {
    assert.equal(args.page, 1);
    assert.deepEqual(args.visitorFilters, {});
  }
});

test("fresh metadata prunes removed values and empty metadata clears every choice; previous response metadata does not prune", async () => {
  withVisitorMetadata();
  await render();
  await click(filterTrigger());
  await click(filterChoice("Northern region"));
  await click(filterChoice("Southern region"));
  globalThis.__directoryDetailsRecords.isPreviousData = true;
  globalThis.__directoryDetailsRecords.data.config = { ...config, visitorFilterFields: [] };
  await render();
  assert.deepEqual(globalThis.__directoryQueryArguments.visitorFilters, { region: ["north", "south"] });
  withVisitorMetadata([{ ...visitorFields[0], options: [visitorFields[0].options[1]] }]);
  await render();
  assert.deepEqual(globalThis.__directoryQueryArguments.visitorFilters, { region: ["south"] });
  withVisitorMetadata([]);
  await render();
  assert.deepEqual(globalThis.__directoryQueryArguments.visitorFilters, {});
  assert.equal(filterTrigger(), null);
});

test("toolbar survives loading and zero results; only Dynamic Directory Embed receives visitor controls", async () => {
  withVisitorMetadata();
  await render();
  globalThis.__directoryDetailsRecords.isLoading = true;
  await render();
  assert.ok(filterTrigger());
  withVisitorMetadata(visitorFields, { records: [], total: 0 });
  await render();
  assert.ok(filterTrigger());
  assert.match(container.textContent, /No records/);
  for (const type of [BLOCK_TYPES.MEMBER_DIRECTORY_EMBED, BLOCK_TYPES.DIRECTORY_CAROUSEL]) {
    block = createBlock(type, { content: { directorySlug: directory.slug } });
    await render();
    assert.equal(filterTrigger(), null);
  }
});

test("actual query sends visitor_filters separately from fixed overrides and separates cache entries", async () => {
  client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  globalThis.__useActualDirectoryQuery = true;
  block.content.filterOverrides = '{"fixed":["author"]}';
  globalThis.fetch = async url => {
    requests.push(String(url));
    return { ok: true, json: async () => ({
      records: [], total: 0, entityType: "member", config: { ...config, visitorFilterFields: visitorFields },
    }) };
  };
  await render();
  await click(filterTrigger());
  await click(filterChoice("Northern region"));
  const first = new URL(requests.at(-1), window.location.origin);
  assert.deepEqual(JSON.parse(first.searchParams.get("filters")), { fixed: ["author"] });
  assert.deepEqual(JSON.parse(first.searchParams.get("visitor_filters")), { region: ["north"] });
  await click(filterChoice("Southern region"));
  assert.deepEqual(JSON.parse(new URL(requests.at(-1), window.location.origin).searchParams.get("visitor_filters")), { region: ["north", "south"] });
  const entries = client.getQueryCache().getAll().filter(query => query.queryKey[1] === "public-dynamic-directory");
  assert.equal(entries.length, 3);
});

test("only the precise unavailable-visitor 400 prunes and retries; fixed overrides remain untouched", async () => {
  client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  globalThis.__useActualDirectoryQuery = true;
  block.content.filterOverrides = '{"fixed":["author"]}';
  let removed = false;
  globalThis.fetch = async url => {
    requests.push(String(url));
    const params = new URL(url, window.location.origin).searchParams;
    if (params.has("visitor_filters")) {
      removed = true;
      return { ok: false, status: 400, json: async () => ({ error: "Unavailable visitor filter", visitorFilterFields: [] }) };
    }
    return { ok: true, json: async () => ({
      records: [], total: 0, entityType: "member",
      config: { ...config, visitorFilterFields: removed ? [] : visitorFields },
    }) };
  };
  await render();
  await click(filterTrigger());
  await click(filterChoice("Northern region"));
  await pause();
  assert.ok(removed);
  assert.deepEqual(globalThis.__directoryQueryArguments.visitorFilters, {});
  assert.equal(filterTrigger(), null);
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(new URL(requests.at(-1), window.location.origin).searchParams.has("visitor_filters"), false);
  for (const url of requests) assert.equal(new URL(url, window.location.origin).searchParams.get("filters"), '{"fixed":["author"]}');
});

test("fixed-source changes synchronously clear visitor choices; ordinary errors do not broaden the visitor query", async () => {
  withVisitorMetadata();
  await render();
  await click(filterTrigger());
  await click(filterChoice("Northern region"));
  globalThis.__directoryDetailsRecords = {
    ...globalThis.__directoryDetailsRecords, isError: true,
    error: Object.assign(new Error("Permission denied"), { unrelatedFields: [] }),
  };
  await render();
  assert.deepEqual(globalThis.__directoryQueryArguments.visitorFilters, { region: ["north"] });
  assert.match(container.querySelector('[role="alert"]').textContent, /Permission denied/);
  block = { ...block, content: { ...block.content, filterOverrides: '{"scope":"changed"}' } };
  await render();
  for (const args of globalThis.__directoryQueryHistory.filter(args => args.filterOverrides === '{"scope":"changed"}')) {
    assert.equal(args.page, 1);
    assert.deepEqual(args.visitorFilters, {});
  }
});
