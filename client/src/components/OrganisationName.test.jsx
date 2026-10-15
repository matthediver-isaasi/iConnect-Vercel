import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import OrganisationName from "./OrganisationName.jsx";

globalThis.React = React;

for (const tag of ["p", "h3"]) {
  for (const [label, name] of [
    ["empty", ""],
    ["spaces", "   "],
    ["mixed whitespace", "\t\n \r"],
    ["non-breaking spaces", "\u00a0"],
    ["null", null],
    ["absent", undefined],
  ]) {
    test(`${tag}: ${label} name has a visible, accessible warning`, () => {
      const html = renderToStaticMarkup(
        React.createElement(tag, null, React.createElement(OrganisationName, { name })),
      );
      const document = new JSDOM(html).window.document;
      const warning = document.querySelector("span");
      assert.equal(warning.textContent.trim(), "Name missing");
      assert.equal(warning.getAttribute("aria-hidden"), null);
      assert.equal(warning.hasAttribute("hidden"), false);
      assert.ok(warning.classList.contains("bg-amber-50"));
      assert.ok(warning.classList.contains("text-amber-800"));
      assert.equal(warning.querySelector("svg").getAttribute("aria-hidden"), "true");
      assert.equal(document.querySelector("button, a"), null, "warning must not intercept parent interactions");
    });
  }

  for (const name of ["BNMS", "  St Mary's Hospital  ", "0", "École & Research"]) {
    test(`${tag}: preserves real name ${JSON.stringify(name)} exactly`, () => {
      const html = renderToStaticMarkup(
        React.createElement(tag, null, React.createElement(OrganisationName, { name })),
      );
      const document = new JSDOM(html).window.document;
      assert.equal(document.querySelector(tag).textContent, name);
      assert.equal(document.querySelector("svg, span"), null);
    });
  }
}

test("table and card use the warning without changing record navigation", () => {
  const source = readFileSync(new URL("../pages/OrganisationsList.jsx", import.meta.url), "utf8");
  assert.match(source, /<p className="font-medium text-slate-900"><OrganisationName name=\{org\.name\} \/><\/p>/);
  assert.match(source, /<h3 className="font-medium text-slate-900 truncate"><OrganisationName name=\{org\.name\} \/><\/h3>/);
  for (const view of ["row", "card"]) {
    assert.ok(source.includes(
      'onClick={() => navigate(`/organisations/${org.id}`)}\n' +
      `                    ${view === "row" ? "    " : ""}data-testid={\`${view}-org-\${org.id}\`}`,
    ), `${view} still navigates with the record ID`);
  }
});
