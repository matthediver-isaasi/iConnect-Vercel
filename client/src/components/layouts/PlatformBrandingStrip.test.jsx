import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { platformBrandingTextColor } from "../../lib/platformBrandingContrast.js";
import { contrastRatio } from "../../lib/canvasA11y.js";

import PlatformBrandingStrip, {
  shouldShowPlatformBranding,
} from "./PlatformBrandingStrip.jsx";

const defaults = {
  platformBrandingText: "Powered by Example",
  platformBrandingUrl: "https://example.com",
};

test("branding colours meet normal-text contrast on dark and light backgrounds", () => {
  for (const branding of [
    undefined,
    { backgroundColor: "#000000", textColor: "#64748b" },
    { backgroundColor: "#ffffff" },
    { backgroundColor: "#ffffff", textColor: "#eeeeee" },
    { backgroundColor: "#777777", textColor: "#777777" },
    { backgroundColor: "#123456", textColor: "#ABCDEF" },
  ]) {
    const color = platformBrandingTextColor(branding);
    assert.ok(contrastRatio(color, branding?.backgroundColor || "#000000") >= 4.5);
    const html = renderToStaticMarkup(<PlatformBrandingStrip platformBranding={branding} platformDefaults={defaults} />);
    assert.ok(html.includes(`color:${color}`));
    assert.match(html, /class="text-xs"/);
  }
  assert.equal(platformBrandingTextColor({ backgroundColor: "#123456", textColor: "#ABCDEF" }), "#ABCDEF");
});

test("platform branding is enabled by default and only explicit false hides it", () => {
  assert.equal(shouldShowPlatformBranding(undefined), true);
  assert.equal(shouldShowPlatformBranding({}), true);
  assert.equal(shouldShowPlatformBranding({ showPlatformBranding: true }), true);
  assert.equal(shouldShowPlatformBranding({ showPlatformBranding: false }), false);
});

test("enabled strip uses platform defaults and tenant colours", () => {
  const html = renderToStaticMarkup(
    <PlatformBrandingStrip
      platformBranding={{
        showPlatformBranding: true,
        backgroundColor: "#123456",
        textColor: "#ABCDEF",
      }}
      platformDefaults={defaults}
    />,
  );

  assert.match(html, /data-testid="platform-branding-strip"/);
  assert.match(html, /background-color:#123456/);
  assert.match(html, /color:#ABCDEF/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /Powered by Example/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("disabled strip renders nothing", () => {
  const html = renderToStaticMarkup(
    <PlatformBrandingStrip
      platformBranding={{ showPlatformBranding: false }}
      platformDefaults={defaults}
    />,
  );
  assert.equal(html, "");
});

test("configured footer keeps its contained spacing", () => {
  const html = renderToStaticMarkup(
    <PlatformBrandingStrip
      platformBranding={{ showPlatformBranding: true }}
      platformDefaults={defaults}
      contained
    />,
  );
  assert.match(html, /mt-8/);
  assert.match(html, /-mb-8/);
});

test("public layout renders the shared strip after both footer modes", () => {
  const source = fs.readFileSync(new URL("./PublicLayout.jsx", import.meta.url), "utf8");
  const canvasBranch = source.slice(
    source.indexOf('branding?.footerSource === "canvas"'),
    source.indexOf('branding?.footerSource !== "canvas"'),
  );
  const configuredBranch = source.slice(source.indexOf('branding?.footerSource !== "canvas"'));

  assert.match(canvasBranch, /<CanvasPageRenderer[\s\S]*<PlatformBrandingStrip/);
  assert.match(configuredBranch, /<PlatformBrandingStrip[\s\S]*contained/);
});