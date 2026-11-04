import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ActivityInvoiceActions from "./ActivityInvoiceActions.jsx";

test("compact report actions expose accessible view and download controls", () => {
  const html = renderToStaticMarkup(<ActivityInvoiceActions compact booking={{
    accountingInvoiceId: "invoice", booking_group_reference: "BOOK / 123",
  }} />);
  assert.match(html, /aria-label="View invoice"/);
  assert.match(html, /aria-label="Download invoice"/);
  assert.match(html, /\/api\/booking-invoice\/BOOK%20%2F%20123\?inline=true/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /h-7 w-7/);
  assert.doesNotMatch(html, />View invoice</);
});

test("missing invoice or booking group cannot produce an invoice link", () => {
  for (const booking of [
    { booking_group_reference: "BOOK", xeroInvoiceNumber: "INV-1" },
    { xeroInvoiceId: "invoice" },
  ]) assert.equal(renderToStaticMarkup(<ActivityInvoiceActions compact booking={booking} />), "");
});

test("existing activity actions retain their visible labels", () => {
  const html = renderToStaticMarkup(<ActivityInvoiceActions booking={{
    xero_invoice_id: "invoice", booking_group_reference: "BOOK",
  }} />);
  assert.match(html, /View invoice<\/a>/);
  assert.match(html, /Download invoice<\/button>/);
});
