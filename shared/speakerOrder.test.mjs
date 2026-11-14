import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { speakersInOrder } from "./speakerOrder.js";

test("saved order skips unavailable records and deduplicates first occurrence without mutating catalogue", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(speakersInOrder(["c", "missing", "a", "c", "b"], rows).map(s => s.id), ["c", "a", "b"]);
  assert.deepEqual(rows.map(s => s.id), ["a", "b", "c"]);
});

test("spotlight resolves shuffled responses against saved IDs", () => {
  const source = readFileSync("client/src/components/iedit/elements/IEditEventSpotlightElement.jsx", "utf8");
  const expression = source.match(/return event.speaker_ids.map[^\n]+/)[0];
  const result = new Function("event", "speakers", expression)({ speaker_ids: ["b", "a"] }, [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(result.map(s => s.id), ["b", "a"]);
  const server = readFileSync("api/_lib/memberContentIEditDynamic.js", "utf8");
  assert.match(server, /event.speaker_ids.map\(id => speakerRows.find/);
});

test("standard and embedded details resolve ordered aggregate; complex uses visible session traversal", () => {
  const standard = readFileSync("client/src/pages/EventDetails.jsx", "utf8");
  assert.match(standard, /speakersInOrder\(allSpeakerIds, await publicClient.listSpeakers/);
  const complex = readFileSync("client/src/pages/ComplexEventDetail.jsx", "utf8");
  const body = complex.match(/const visibleSpeakers = useMemo\(\(\) => \{([\s\S]*?)\n  \},/)[1];
  const result = new Function("event", "filteredSessions", "speakers", "speakersInOrder", "speakerSessionsMap", body)(
    { speaker_ids: ["c", "a"] }, [{ speaker_ids: ["b", "a"] }, { speaker_ids: ["d"] }],
    ["d", "b", "a", "c"].map(id => ({ id })), speakersInOrder,
    { a: [{}], b: [{}], d: [{}] });
  // c is event-level but its session is excluded by track access.
  assert.deepEqual(result.map(s => s.id), ["a", "b", "d"]);
});
