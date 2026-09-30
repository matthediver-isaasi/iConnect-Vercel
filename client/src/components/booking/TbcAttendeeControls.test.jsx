import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TbcAttendeeControls from "./TbcAttendeeControls.jsx";
import { isTbcReplacementDisplayActive } from "../../lib/tbcBookingReplacement.mjs";

/**
 * UI-level regression coverage for the TBC "replace standard booking
 * elements" ticket-selector hiding.
 *
 * While the replacement display is active (toggle on and nothing owed) the
 * detail pages must hide ticket selection controls but keep the attendee
 * input. On the complex event page the full ticket cards are swapped for
 * this minimal control; on the simple event page the selector cards are
 * gated on the same isTbcReplacementDisplayActive check asserted here.
 */

const tc = { id: "tc-1", name: "Standard", price: 0 };

function render(props) {
  return renderToStaticMarkup(React.createElement(TbcAttendeeControls, props));
}

test("replacement-active controls keep the attendee input but no selector chrome", () => {
  const html = render({ ticketClass: tc, attendeeCount: 0, onAdd: () => {} });
  assert.ok(html.includes("Add Attendee"));
  // No ticket-selector chrome: prices, availability, discounts, ticket names.
  assert.ok(!html.includes("\u00a3"));
  assert.ok(!/Free/.test(html));
  assert.ok(!/available|Only \d+ left|Sold Out/.test(html));
  assert.ok(!/[Dd]iscount/.test(html));
  assert.ok(!html.includes("Standard"));
  assert.ok(!html.includes("Tickets"));
});

test("group events show Register Myself instead of Add Attendee", () => {
  const html = render({ ticketClass: tc, onAdd: () => {}, isGroupEvent: true });
  assert.ok(html.includes("Register Myself"));
  assert.ok(!html.includes("Add Attendee"));
});

test("added attendees surface as a count badge", () => {
  const html = render({ ticketClass: tc, attendeeCount: 2, onAdd: () => {} });
  assert.ok(html.includes("2 added"));
});

test("no bookable ticket class degrades to the standard empty message", () => {
  const html = render({ ticketClass: null, onAdd: () => {} });
  assert.ok(html.includes("No tickets are currently available"));
});

// The same gate drives selector hiding on BOTH detail pages: simple event
// ticket cards and the complex ticket-card swap are conditioned on this.
test("selectors hide only when the replacement applies and nothing is owed", () => {
  const replacement = { message: "m", ctaLabel: null, title: null };
  assert.equal(isTbcReplacementDisplayActive(replacement, 0), true);
  assert.equal(isTbcReplacementDisplayActive(replacement, 25), false);
  assert.equal(isTbcReplacementDisplayActive(null, 0), false);
});
