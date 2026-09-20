import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

const React = (await import("react")).default;
globalThis.React = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { MemberCpdPointsHistoryView } = await import("./MemberCpdPointsTab.jsx");

test("renders signed balance, reversal states, snapshot fields and pagination", () => {
  const html = renderToStaticMarkup(
    <MemberCpdPointsHistoryView
      page={1}
      setPage={() => {}}
      data={{
        balance: "3.5",
        total: 21,
        pageSize: 20,
        items: [
          {
            id: "award",
            entry_kind: "event_award",
            points_value: "5",
            event_name: "Snapshotted conference",
            ticket_name_snapshot: "Member ticket",
            award_trigger: "attendance",
            evidence_date: "2026-09-01T10:00:00Z",
            is_reversed: true,
          },
          {
            id: "reversal",
            entry_kind: "reversal",
            points_value: "-1.5",
            event_name: "Historical activity",
            activity_description: "Imported evidence",
            evidence_date: "2025-05-01",
          },
        ],
      }}
    />,
  );
  assert.match(html, /3\.5/);
  assert.match(html, /Snapshotted conference/);
  assert.match(html, /Member ticket/);
  assert.match(html, /Attendance/);
  assert.match(html, /Reversed/);
  assert.match(html, /Historical activity/);
  assert.match(html, /Imported evidence/);
  assert.match(html, /Reversal/);
  assert.match(html, /Page 1 of 2/);
  assert.match(html, />Next</);
});