import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./RelatedRecordsPanel.jsx", import.meta.url),
  "utf8",
);

test("full width is opt-in and does not change embedded or default consumer grids", () => {
  assert.match(source, /fullWidth = false/);
  assert.match(source, /fullWidth \? "grid min-w-0 grid-cols-1 gap-4" : embedded \? "grid min-w-0 gap-4" : "grid min-w-0 gap-4 lg:grid-cols-2"/);
  assert.match(source, /embedded \? "min-w-0 overflow-hidden border-slate-200 shadow-none" : "min-w-0 overflow-hidden"/);
});

test("wide relationship tables have a bounded scroll viewport below actions and limit messages", () => {
  assert.match(source, /resolvedDisplayMode === "columns" \? "relative min-w-0 max-w-full overflow-x-auto" : ""/);
  assert.match(source, /width: orderedDescriptors\.reduce/);
  assert.match(source, /minWidth: "100%"/);
  const viewport = source.indexOf(': <div className={resolvedDisplayMode === "columns"');
  assert.ok(source.indexOf('This side has reached its configured relationship limit.') < viewport);
  assert.ok(source.indexOf('{editable && <div') < viewport);
  assert.match(source.slice(viewport), /Reset columns[\s\S]*<table[\s\S]*Move \$\{descriptor.label\} left[\s\S]*Resize \$\{descriptor.label\} column/);
});

test("relationship fields render through stable descriptor IDs in columns and shared controls in cards", () => {
  assert.match(
    source,
    /resolvedDisplayMode === "columns"[\s\S]*orderedDescriptors\.map\(\(descriptor\)[\s\S]*descriptor\.kind === "relationship_boolean"[\s\S]*edgeFields\.find\(\(field\) => String\(field\.id\) === descriptor\.fieldId\)/,
  );
  assert.match(
    source,
    /resolvedDisplayMode === "cards"[\s\S]*edgeFields\.map\(\(field\)[\s\S]*renderEdgeField\(edge, field\)/,
  );
});

test("column controls exclude actions and expose sorting, reordering, resizing, and reset", () => {
  assert.match(source, /aria-sort=\{getAriaSort\(descriptor\.sortField, sortField, sortDir\)\}/);
  assert.match(source, /aria-label=\{`Move \$\{descriptor\.label\} left`\}/);
  assert.match(source, /aria-label=\{`Resize \$\{descriptor\.label\} column`\}/);
  assert.match(source, /role="slider"/);
  assert.match(source, /aria-valuemin="120"/);
  assert.match(source, /aria-valuemax="480"/);
  assert.match(source, /preferences\.canPersist && <Button[\s\S]*Reset columns/);
  assert.match(source, /Reset columns/);
  assert.match(source, /<span className="sr-only">Actions<\/span>/);
});

test("relationship field control exposes accessible pending and read-only states", () => {
  assert.match(source, /aria-label=\{`\$\{field\.label\}: \$\{value \? "Yes" : "No"\}`\}/);
  assert.match(source, /aria-label=\{`\$\{field\.label\} for this relationship`\}/);
  assert.match(source, /aria-busy=\{pending\}/);
  assert.match(source, /disabled=\{pending\}/);
});

test("configured picker context renders headed responsive columns with a safe blank fallback", () => {
  assert.match(source, /relationshipPickerContextColumn\(definition, editSide\)/);
  assert.match(source, /query\.data\?\.primaryColumnLabel \|\| "Record"/);
  assert.match(source, /hidden grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)_2rem\][\s\S]*\{primaryHeading\}[\s\S]*\{contextColumn\.label\}/);
  assert.match(source, /font-medium sm:hidden[\s\S]*\{contextColumn\.label\}: /);
  assert.match(source, /entity\.picker_context_label \|\| "—"/);
});

test("legacy pickers retain the original single-column row layout", () => {
  assert.match(source, /contextColumn \? "grid w-full[\s\S]*: "flex w-full items-center justify-between/);
});