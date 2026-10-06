import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import OrganisationDirectoryCoreRow, { organisationDirectoryCoreValue } from "./OrganisationDirectoryCoreRow.jsx";
import DirectoryFilterMode from "./DirectoryFilterMode.jsx";

globalThis.React = React;

test("published core rows link only safe contacts and escape description as text", () => {
  const render = (organization, fieldKey) => renderToStaticMarkup(
    <OrganisationDirectoryCoreRow organization={organization} fieldKey={fieldKey} />,
  );
  assert.match(render({ website_url: "example.test/path" }, "org_website"), /href="https:\/\/example.test\/path"/);
  assert.match(render({ phone: "+44 (20) 7946 0823" }, "org_phone"), /href="tel:\+442079460823"/);
  const description = render({ description: '<script>alert("x")</script>' }, "org_description");
  assert.match(description, /&lt;script&gt;/);
  assert.doesNotMatch(description, /<script|<a /);
  assert.doesNotMatch(render({ website_url: "javascript:alert(1)" }, "org_website"), /href=/);
  for (const organization of [{}, { phone: "  " }, { phone: null }, { phone: { private: true } }]) {
    assert.equal(render(organization, "org_phone"), "");
    assert.equal(organisationDirectoryCoreValue(organization, "org_phone"), null);
  }
});

test("selection mode controls rely on authoritative choice controls, never labels", () => {
  const render = (field, modes = {}) => renderToStaticMarkup(
    <DirectoryFilterMode field={field} modes={modes} disabled={false} onChange={() => {}} />,
  );
  assert.equal(render({ key: "org_phone", label: "Phone", control: "text" }), "");
  assert.equal(render(undefined), "");
  for (const control of ["choice", "source-choice"]) {
    const html = render({ key: "custom:focus", label: "Focus", control, multi_select: false }, { "custom:focus": "multi" });
    assert.match(html, /aria-label="Focus filter selection mode"/);
    assert.match(html, /value="multi" selected/);
  }
});
