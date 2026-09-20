import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OrganisationPostalSummary, {
  buildOrganisationPostalSummary,
  ORGANISATION_POSTAL_ORDER_KEY,
  placeOrganisationPostalSummary,
} from "./OrganisationPostalSummary.jsx";

const values = (...entries) => entries.map(([field_id, value]) => ({ field_id, value }));

test("uses stable visible organisation field metadata to build a postal block", () => {
  const summary = buildOrganisationPostalSummary([
    { id: "region", name: "region", label: "Area", _visBack: true },
    { id: "line", name: "address_line_1", label: "Office", _visBack: true },
    { id: "town", name: "post_town", label: "Place", _visBack: true },
    { id: "postcode", name: "postcode", label: "Code", _visBack: true },
  ], values(
    ["region", "South Yorkshire"],
    ["line", "Gawber Road"],
    ["town", "Barnsley"],
    ["postcode", "S75 2EP"],
  ));
  assert.deepEqual(summary, {
    fieldIds: ["region", "line", "town", "postcode"],
    lines: ["Gawber Road", "Barnsley", "South Yorkshire", "S75 2EP"],
  });
  const html = renderToStaticMarkup(<OrganisationPostalSummary summary={summary} />);
  assert.match(html, /data-testid="organisation-postal-address"/);
  assert.match(html, /Postal address[\s\S]*Gawber Road[\s\S]*Barnsley[\s\S]*S75 2EP/);
});

test("does not infer an address from editable labels, region alone, or hidden fields", () => {
  assert.equal(buildOrganisationPostalSummary([
    { id: "department", name: "department_notes", label: "Address line 1", _visBack: true },
    { id: "region", name: "region", label: "Region", _visBack: true },
    { id: "hidden", name: "postcode", label: "Postcode", _visBack: false },
  ], values(
    ["department", "Department address"],
    ["region", "Yorkshire and the Humber"],
    ["hidden", "S75 2EP"],
  )), null);
});

test("formats an authorised structured address and ignores non-address fields", () => {
  const summary = buildOrganisationPostalSummary([
    { id: "address", name: "postal_address", _visBack: true },
    { id: "region", name: "region", _visBack: true },
    { id: "phone", name: "phone", _visBack: true },
  ], values(
    ["address", JSON.stringify({
      line_1: "10 High Street",
      post_town: "Leeds",
      postcode: "LS1 1AA",
      country: "United Kingdom",
    })],
    ["region", "West Yorkshire"],
    ["phone", "01234 567890"],
  ));
  assert.deepEqual(summary.fieldIds, ["address", "region"]);
  assert.deepEqual(summary.lines, [
    "10 High Street", "Leeds", "West Yorkshire", "LS1 1AA", "United Kingdom",
  ]);
});

test("places the postal block before the first related source without label inference", () => {
  const sources = [
    { key: "object-field:office", object_label: "Office" },
    { key: "object-field:department-name", object_label: "Department" },
    { key: "object-field:department-phone", relationship_label: "Departments" },
  ];
  assert.deepEqual(placeOrganisationPostalSummary([
    "org_member_count",
    "object-field:office",
    "custom:region",
    "object-field:department-name",
    "custom:address",
    "custom:postcode",
    "object-field:department-phone",
    "org_members_list",
  ], sources, { fieldIds: ["address", "postcode"], lines: ["One Road"] }), [
    "org_member_count",
    ORGANISATION_POSTAL_ORDER_KEY,
    "object-field:office",
    "custom:region",
    "object-field:department-name",
    "object-field:department-phone",
    "org_members_list",
  ]);
});

test("merges structured and scalar address components in postal order without duplicates", () => {
  const summary = buildOrganisationPostalSummary([
    { id: "address", name: "address", _visBack: true },
    { id: "county", name: "address_county", _visBack: true },
    { id: "postcode", name: "postcode", _visBack: true },
  ], values(
    ["address", {
      line1: "1 Main Street",
      city: "Sheffield",
      postcode: "S1 1AA",
      country: "United Kingdom",
    }],
    ["county", "South Yorkshire"],
    ["postcode", "S1 1AA"],
  ));
  assert.deepEqual(summary.lines, [
    "1 Main Street",
    "Sheffield",
    "South Yorkshire",
    "S1 1AA",
    "United Kingdom",
  ]);
});

test("uses the authorised core invoicing address with its real town_city shape", () => {
  const summary = buildOrganisationPostalSummary([
    { id: "town", name: "town_city", _visBack: true },
    { id: "county", name: "region", _visBack: true },
    { id: "country", name: "country", _visBack: true },
  ], values(
    ["town", "Barnsley"],
    ["county", "South Yorkshire"],
    ["country", "United Kingdom"],
  ), "Gawber Road\nS75 2EP");
  assert.deepEqual(summary, {
    fieldIds: ["town", "county", "country"],
    lines: [
      "Gawber Road",
      "Barnsley",
      "South Yorkshire",
      "S75 2EP",
      "United Kingdom",
    ],
  });
  assert.deepEqual(placeOrganisationPostalSummary([
    "org_member_count",
    "object-field:department-name",
  ], [{ key: "object-field:department-name" }], summary), [
    "org_member_count",
    ORGANISATION_POSTAL_ORDER_KEY,
    "object-field:department-name",
  ]);
});

test("does not show a hidden or absent core address", () => {
  assert.equal(buildOrganisationPostalSummary([], [], undefined), null);
  assert.equal(buildOrganisationPostalSummary([], [], null), null);
  assert.equal(buildOrganisationPostalSummary([], [], {}), null);
});
