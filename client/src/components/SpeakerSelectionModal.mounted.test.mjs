import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import Module from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { persistAgendaLinesWithRollback } from "../lib/eventAgendaPersistence.js";

// Real picker, Radix dismissal, and agenda editor; no live API or credentials.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://isolated.example.test" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "DocumentFragment", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = Module.createRequire(import.meta.url)("@tanstack/react-query");
after(() => dom.window.close());

// Extract the actual shared-picker JSX from each page, not a copy of its wiring.
const pageFixtures = ["CreateEvent", "EditEvent", "CreateComplexEvent"].map(name => {
  const source = readFileSync(`client/src/pages/${name}.jsx`, "utf8");
  const picker = source.match(/<SpeakerSelectionModal[\s\S]*?\/>/)?.[0];
  assert.ok(picker, name);
  return `export function ${name}Fixture({initial, speakers}) {
    const [speakerModalOpen, setSpeakerModalOpen] = useState(false);
    const [sessionSpeakerModalOpen, setSessionSpeakerModalOpen] = useState(false);
    const [selectedSpeakers, setSelectedSpeakers] = useState(initial);
    const [sessionForm, setSessionForm] = useState({speaker_ids: initial});
    return <><button data-testid="open" onClick={() => {setSpeakerModalOpen(true); setSessionSpeakerModalOpen(true);}}>Open</button>
      <output data-testid="value">{JSON.stringify(${name === "CreateComplexEvent" ? "sessionForm.speaker_ids" : "selectedSpeakers"})}</output>
      ${picker}</>;
  }`;
}).join("\n");
const bundle = await build({
  stdin: { contents: `
    import React, {useState} from "react";
    import {SpeakerSelectionModal} from "@/components/SpeakerSelectionModal";
    export {SpeakerSelectionModal};
    export {default as TrainingAgendaEditor} from "@/components/events/TrainingAgendaEditor";
    ${pageFixtures}`, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, write: false, packages: "external", platform: "node", format: "cjs", jsx: "automatic",
  plugins: [{
    name: "isolated-agenda",
    setup(builder) {
      builder.onResolve({ filter: /^@\/components\/events\/(EventSponsorSelector|AttendancePolicyEditor|TeamsMeetingConfig)$/ },
        args => ({ path: args.path, namespace: "empty" }));
      builder.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default () => null;" }));
      builder.onResolve({ filter: /^@\/hooks\/useAgendaItemTypes$/ }, args => ({ path: args.path, namespace: "types" }));
      builder.onLoad({ filter: /.*/, namespace: "types" }, () => ({ contents: 'export const inferAgendaTypeBehaviour = () => "none";' }));
      builder.onResolve({ filter: /^@\// }, args => {
        const base = `${process.cwd()}/client/src/${args.path.slice(2)}`;
        return { path: [base, `${base}.jsx`, `${base}.js`].find(existsSync) };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/speaker-fixtures.cjs`);
compiled.filename = `${process.cwd()}/speaker-fixtures.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { SpeakerSelectionModal, TrainingAgendaEditor, ...pages } = compiled.exports;
const speakers = [
  { id: "external", full_name: "External speaker fixture", member_id: null },
  { id: "member", full_name: "Member speaker fixture", member_id: "fixture-member" },
];
const byId = id => document.querySelector(`[data-testid="${id}"]`);
const click = async id => { const el = typeof id === "string" ? byId(id) : id; assert.ok(el); await act(async () => el.click()); };
async function mount(Component, initialProps) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const renderNow = props => root.render(React.createElement(QueryClientProvider, { client: queryClient },
    React.createElement(React.StrictMode, null, React.createElement(Component, props))));
  const render = props => act(async () => renderNow(props));
  await render(initialProps);
  return { render, renderNow, cleanup: async () => { await act(async () => root.unmount()); queryClient.clear(); host.remove(); } };
}
const selected = id => assert.ok(byId(`speaker-selected-${id}`));

test("controlled opening snapshots current IDs, preserves drafts across rerenders and late catalogue loading", async () => {
  let confirmed;
  let props = { open: false, speakers: [], selectedSpeakerIds: [], onOpenChange: () => {}, onConfirm: ids => { confirmed = ids; } };
  const fixture = await mount(SpeakerSelectionModal, props);
  try {
    props = { ...props, open: true, selectedSpeakerIds: ["external"] };
    await fixture.render(props);
    await fixture.render({ ...props, speakers });
    selected("external");
    assert.match(document.body.textContent, /Selected Speakers \(1\)/);
    await click("speaker-available-member");
    await fixture.render({ ...props, speakers: speakers.map(s => ({ ...s })), selectedSpeakerIds: ["external"] });
    selected("member");
    await click("button-confirm-speakers");
    assert.deepEqual(confirmed, ["external", "member"]);
  } finally { await fixture.cleanup(); }
});

for (const dismissal of ["cancel", "escape", "close", "parent"]) {
  test(`${dismissal} discards edits and search; reopening uses latest parent selection`, async () => {
    let props = { open: true, speakers, selectedSpeakerIds: ["external"], onConfirm: () => assert.fail("Dismissal must not commit") };
    let fixture;
    props.onOpenChange = open => { props = { ...props, open }; fixture.renderNow(props); };
    fixture = await mount(SpeakerSelectionModal, props);
    try {
      await click("button-remove-speaker-external");
      await click("speaker-available-member");
      await act(async () => {
        const input = byId("input-search-speakers");
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "no match");
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      if (dismissal === "cancel") await click("button-cancel-speakers");
      if (dismissal === "close") await click([...document.querySelectorAll("button")].find(el => el.textContent === "Close"));
      if (dismissal === "escape") await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      if (dismissal === "parent") { props = { ...props, open: false }; await fixture.render(props); }
      assert.equal(document.querySelector('[role="dialog"]'), null);
      props = { ...props, open: true, selectedSpeakerIds: ["external"] };
      await fixture.render(props);
      selected("external");
      assert.equal(byId("speaker-selected-member"), null);
      assert.equal(byId("input-search-speakers").value, "");
      props = { ...props, open: false }; await fixture.render(props);
      props = { ...props, open: true, selectedSpeakerIds: ["member"] }; await fixture.render(props);
      selected("member");
      assert.equal(byId("speaker-selected-external"), null);
    } finally { await fixture.cleanup(); }
  });
}

test("actual agenda chip/picker agree, item edits stay isolated and survive isolated save/reload", async () => {
  const initial = [
    { id: "agenda-a", item_type: "Discussion", speaker_ids: ["external"] },
    { id: "agenda-b", item_type: "Discussion", speaker_ids: ["member"] },
  ];
  let lines = structuredClone(initial);
  let fixture;
  const props = () => ({ lines, speakers, agendaItemTypes: [{ name: "Discussion", behaviour: "none" }],
    onChange: value => { lines = value; fixture.renderNow(props()); } });
  fixture = await mount(TrainingAgendaEditor, props());
  try {
    assert.match(byId("chip-agenda-speaker-0-external").textContent, /External speaker fixture/);
    await click("button-agenda-speakers-0");
    selected("external");
    await click("button-confirm-speakers");
    assert.deepEqual(lines, initial);
    await click("button-agenda-speakers-1");
    selected("member");
    assert.equal(byId("speaker-selected-external"), null);
    await click("button-remove-speaker-member");
    await click("speaker-available-external");
    await click("button-confirm-speakers");
    assert.deepEqual(lines.map(l => l.speaker_ids), [["external"], ["external"]]);
    const store = new Map(initial.map(row => [row.id, structuredClone(row)]));
    await persistAgendaLinesWithRollback({
      api: { update: async (id, payload) => store.set(id, structuredClone({ id, ...payload })),
        create: () => assert.fail("Unexpected create"), delete: () => assert.fail("Unexpected delete") },
      initialRows: initial, orderedLines: lines,
      buildPayload: line => ({ item_type: line.item_type, speaker_ids: line.speaker_ids }),
    });
    await fixture.cleanup();
    lines = [...store.values()];
    fixture = await mount(TrainingAgendaEditor, props());
    await click("button-agenda-speakers-1");
    selected("external");
    await click("button-cancel-speakers");
    await click("button-agenda-speakers-0");
    selected("external");
  } finally { await fixture.cleanup(); }
});

for (const [name, Surface] of Object.entries(pages)) {
  test(`${name} actual picker wiring preserves unchanged confirmation and add/remove on reopen`, async () => {
    const fixture = await mount(Surface, { initial: ["external"], speakers });
    try {
      await click("open"); selected("external");
      await click("button-confirm-speakers");
      assert.deepEqual(JSON.parse(byId("value").textContent), ["external"]);
      await click("open");
      await click("button-remove-speaker-external");
      await click("speaker-available-member");
      await click("button-confirm-speakers");
      assert.deepEqual(JSON.parse(byId("value").textContent), ["member"]);
      await click("open"); selected("member");
    } finally { await fixture.cleanup(); }
  });
}
