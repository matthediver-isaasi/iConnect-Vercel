import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./RelatedRecordsPanel.jsx", import.meta.url),
  "utf8",
);

test("relationship fields render through the shared control in columns and cards", () => {
  const occurrences = source.match(/\{renderEdgeField\(edge, field\)\}/g) || [];
  assert.equal(occurrences.length, 2);
  assert.match(
    source,
    /resolvedDisplayMode === "columns"[\s\S]*edgeFields\.map\(\(field\)[\s\S]*renderEdgeField\(edge, field\)/,
  );
  assert.match(
    source,
    /resolvedDisplayMode === "cards"[\s\S]*edgeFields\.map\(\(field\)[\s\S]*renderEdgeField\(edge, field\)/,
  );
});

test("relationship field control exposes accessible pending and read-only states", () => {
  assert.match(source, /aria-label=\{`\$\{field\.label\}: \$\{value \? "Yes" : "No"\}`\}/);
  assert.match(source, /aria-label=\{`\$\{field\.label\} for this relationship`\}/);
  assert.match(source, /aria-busy=\{pending\}/);
  assert.match(source, /disabled=\{pending\}/);
});