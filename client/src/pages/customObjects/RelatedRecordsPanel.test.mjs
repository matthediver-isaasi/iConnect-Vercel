import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./RelatedRecordsPanel.jsx", import.meta.url),
  "utf8",
);

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