import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://tenant.example.test" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { act, useState } = React;
const { createRoot } = await import("react-dom/client");
const Editor = (await import("./DirectoryExpressionEditor.jsx")).default;
const {
  emptyDirectoryExpression, countExpressionNodes, directoryExpressionError,
  directoryExpressionSaveFields, readDirectoryExpression, expressionSummary, draftExpressionFieldIds, loadDirectoryRuleFields,
} = await import("../../utils/directoryExpressionEditor.js");

const fields = [
  { id: "approved", label: "Approved", field_type: "boolean" },
  { id: "sector", label: "Sector", field_type: "dropdown", options: [{ value: "health", label: "Healthcare" }] },
];
const leaf = (field_id = "approved", value = false) => ({ field_id, value });
const expr = root => ({ version: 1, root });

async function mount(initial, props = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function Harness() {
    const [value, setValue] = useState(initial);
    return <><Editor expression={value} fields={fields} onChange={setValue} {...props} /><output>{JSON.stringify(value)}</output></>;
  }
  await act(async () => root.render(<Harness />));
  return {
    container,
    value: () => JSON.parse(container.querySelector("output").textContent),
    async click(label) {
      await act(async () => container.querySelector(`button[aria-label="${label}"]`).click());
    },
    async select(label, value) {
      const control = container.querySelector(`select[aria-label="${label}"]`);
      await act(async () => {
        control.value = value;
        control.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    async cleanup() { await act(async () => root.unmount()); container.remove(); },
  };
}

test("nested All/Any editing preserves sibling conditions and saves boolean false", async () => {
  const view = await mount(expr({ op: "and", children: [leaf()] }));
  await view.click("Add group to group root");
  await view.select("Match conditions in group 2", "or");
  await view.select("Condition 2.1 field", "sector");
  await view.select("Condition 2.1 value", "health");
  await view.click("Add condition to group 2");
  await view.select("Condition 2.2 field", "approved");
  await view.select("Condition 2.2 value", "false");
  assert.equal(view.value().root.children[0].value, false);
  assert.equal(view.value().root.children[1].op, "or");
  assert.equal(view.value().root.children[1].children[1].value, false);
  assert.equal(directoryExpressionError(view.value(), fields), null);
  assert.match(expressionSummary(view.value(), fields), /Any of.*Healthcare.*No/);
  await view.click("Remove condition 2.1");
  assert.deepEqual(view.value().root.children[1].children, [leaf()]);
  await view.click("Remove group 2");
  assert.deepEqual(view.value().root.children, [leaf()]);
  await view.cleanup();
});

test("changing a field clears only its value; empty groups remain editable but invalid", async () => {
  const view = await mount(expr({ op: "and", children: [leaf()] }));
  await view.select("Condition 1 field", "sector");
  assert.deepEqual(view.value().root.children[0], { field_id: "sector", value: "" });
  assert.ok(directoryExpressionError(view.value(), fields));
  await view.click("Remove condition 1");
  assert.match(view.container.textContent, /Empty groups cannot be saved/);
  assert.ok(directoryExpressionError(view.value(), fields));
  await view.click("Add condition to group root");
  assert.equal(view.value().root.children.length, 1);
  await view.cleanup();
});

test("add controls enforce depth five including leaves and 100 total nodes", async () => {
  const nested = { op: "and", children: [{ op: "and", children: [{ op: "or", children: [{ op: "and", children: [leaf()] }] }] }] };
  let view = await mount(expr(nested));
  assert.equal(view.container.querySelector('button[aria-label="Add group to group 1.1.1"]').disabled, true);
  assert.equal(view.container.querySelector('button[aria-label="Add condition to group 1.1.1"]').disabled, false);
  await view.cleanup();
  view = await mount(expr({ op: "and", children: Array.from({ length: 99 }, () => leaf()) }));
  assert.equal(countExpressionNodes(view.value().root), 100);
  assert.equal(view.container.querySelector('button[aria-label="Add condition to group root"]').disabled, true);
  assert.equal(view.container.querySelector('button[aria-label="Add group to group root"]').disabled, true);
  await view.cleanup();
  assert.ok(directoryExpressionError(expr({ op: "and", children: Array.from({ length: 100 }, () => leaf()) }), fields));
  assert.ok(directoryExpressionError(expr({ op: "and", children: [nested] }), fields));
});

test("missing saved fields block validation while unlisted saved choice values remain valid", async () => {
  const saved = expr({ op: "and", children: [leaf("deleted", "original"), leaf("sector", "removed")] });
  const view = await mount(saved);
  assert.match(view.container.textContent, /Unavailable: deleted/);
  assert.match(view.container.textContent, /Unavailable: removed/);
  assert.deepEqual(view.value(), saved);
  assert.ok(directoryExpressionError(saved, fields));
  await view.select("Condition 1 field", "approved");
  await view.select("Condition 1 value", "false");
  assert.equal(directoryExpressionError(view.value(), fields), null);
  assert.equal(view.value().root.children[1].value, "removed");
  await view.select("Condition 2 value", "health");
  assert.equal(directoryExpressionError(view.value(), fields), null);
  await view.cleanup();
});

test("field discovery errors expose retry without dropping saved selections", async () => {
  let retries = 0;
  const saved = expr({ op: "and", children: [leaf()] });
  const view = await mount(saved, { fields: [], loadError: true, onRetry: () => retries++ });
  assert.equal(view.container.querySelector('select[aria-label="Condition 1 field"]').disabled, true);
  await act(async () => [...view.container.querySelectorAll("button")].find(b => b.textContent === "Retry fields").click());
  assert.equal(retries, 1);
  assert.deepEqual(view.value(), saved);
  await view.cleanup();
});

test("malformed expressions require explicit replacement and never silently fall back", async () => {
  assert.throws(() => readDirectoryExpression({ filter_expression: { version: 9, root: {} }, filter_field_id: "approved", filter_value: "true" }));
  let replaced = 0;
  const view = await mount(null, { savedError: "Unsupported version", onReplace: () => replaced++ });
  assert.match(view.container.textContent, /Saving is blocked/);
  await act(async () => [...view.container.querySelectorAll("button")].find(b => b.textContent === "Replace invalid rules").click());
  assert.equal(replaced, 1);
  assert.equal(view.value(), null);
  await view.cleanup();
});

test("legacy false migrates, expression is authoritative, and null search inheritance survives saves", () => {
  const migrated = readDirectoryExpression({ filter_expression: null, filter_field_id: "approved", filter_value: false });
  assert.equal(String(migrated.root.children[0].value), "false");
  const authoritative = expr({ op: "or", children: [leaf()] });
  assert.deepEqual(readDirectoryExpression({ filter_expression: authoritative, filter_field_id: "sector", filter_value: "health" }), authoritative);
  const payload = directoryExpressionSaveFields(authoritative, null);
  assert.equal(payload.selected_filter_fields, null);
  assert.equal(payload.filter_value, "false");
  assert.equal(payload.filter_field_id, "approved");
  assert.deepEqual(payload.filter_expression, authoritative);
  assert.deepEqual(directoryExpressionSaveFields(authoritative, []).selected_filter_fields, []);
  assert.ok(directoryExpressionError(emptyDirectoryExpression(), fields));
});

test("draft field exclusions tolerate empty groups and unfinished conditions", () => {
  assert.deepEqual(draftExpressionFieldIds(emptyDirectoryExpression()), []);
  assert.deepEqual(draftExpressionFieldIds(expr({ op: "and", children: [leaf(), { op: "or", children: [] }, { field_id: "sector", value: "" }] })), ["approved", "sector"]);
  assert.deepEqual(draftExpressionFieldIds(null), []);
});

test("discovery continues through cap37 pages beyond 1000 records with tenant/entity scoping", async () => {
  const calls = [];
  const records = Array.from({ length: 1007 }, (_, index) => ({
    id: `field-${index}`, tenant_id: "tenant-a", entity_scope: "member", is_active: true, field_type: "boolean",
  }));
  const available = [...records,
        { id: "foreign", tenant_id: "tenant-b", entity_scope: "member", field_type: "boolean" },
        { id: "org", tenant_id: "tenant-a", entity_scope: "organization", field_type: "boolean" },
        { id: "inactive", tenant_id: "tenant-a", entity_scope: "member", field_type: "boolean", is_active: false },
        { id: "text", tenant_id: "tenant-a", entity_scope: "member", field_type: "text" }];
  const result = await loadDirectoryRuleFields({
    async list(value) {
      calls.push(value);
      return available.slice(value.offset, value.offset + 37);
    },
  }, "tenant-a", "member");
  assert.deepEqual(calls[0], { filter: { tenant_id: "tenant-a", entity_scope: "member", is_active: true }, sort: { display_order: "asc", id: "asc" }, limit: 500, offset: 0 });
  assert.equal(calls[1].offset, 37);
  assert.equal(calls.at(-1).offset, available.length);
  assert.equal(result.length, 1007);
  assert.equal(result.at(-1).id, "field-1006");
  await assert.rejects(loadDirectoryRuleFields({ async list() { throw new Error("Network unavailable"); } }, "tenant-a", "member"), /Network unavailable/);
  await assert.rejects(loadDirectoryRuleFields({ async list() { return null; } }, "tenant-a", "member"), /Invalid field discovery/);
  await assert.rejects(loadDirectoryRuleFields({ async list() { return Array.from({ length: 500 }, () => records[0]); } }, "tenant-a", "member"), /safety limit/);
});
