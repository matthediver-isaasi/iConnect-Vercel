import test from "node:test";
import assert from "node:assert/strict";

import {
  convertLegacyHeaderGradientColors,
  getHeaderGradientStops,
  hydrateSecondaryBarConfig,
  hydrateFooterConfig,
  DEFAULT_HEADER_GRADIENT_STOPS,
  DEFAULT_SECONDARY_BAR_GRADIENT_STOPS,
  DEFAULT_INDICATOR_GRADIENT_STOPS,
} from "./brandingShared.jsx";

/**
 * Regression coverage for the legacy-JSON hydration helpers shared between
 * /admin/branding and the microsite branding cards (Task #2525).
 *
 * Older tenants/microsites store header_config.gradientColors (a plain color
 * array) instead of gradientStops, sparse secondaryBar objects and sparse
 * footer_config objects. Both editors must hydrate those legacy shapes into
 * the same full editable shape, so a drift here silently loses stored values
 * when an admin re-saves.
 */

// --- getHeaderGradientStops / convertLegacyHeaderGradientColors ------------

test("header gradient: prefers stored gradientStops", () => {
  const stops = [{ color: "#111111", position: 0 }, { color: "#222222", position: 100 }];
  assert.deepEqual(getHeaderGradientStops({ gradientStops: stops }), stops);
});

test("header gradient: legacy gradientColors array converts to stops", () => {
  const out = getHeaderGradientStops({ gradientColors: ["#AA0000", "#00BB00"] });
  // White lead-in stops, then the legacy colors spread from 30..100.
  assert.deepEqual(out, [
    { color: "#FFFFFF", position: 0 },
    { color: "#FFFFFF", position: 30 },
    { color: "#AA0000", position: 30 },
    { color: "#00BB00", position: 100 },
  ]);
});

test("header gradient: single legacy color becomes white->color ramp", () => {
  const out = convertLegacyHeaderGradientColors(["#AB00CD"]);
  assert.deepEqual(out, [
    { color: "#FFFFFF", position: 0 },
    { color: "#FFFFFF", position: 30 },
    { color: "#AB00CD", position: 100 },
  ]);
});

test("header gradient: empty config falls back to default stops", () => {
  assert.deepEqual(getHeaderGradientStops({}), DEFAULT_HEADER_GRADIENT_STOPS);
  assert.deepEqual(getHeaderGradientStops(null), DEFAULT_HEADER_GRADIENT_STOPS);
  assert.deepEqual(getHeaderGradientStops({ gradientStops: [], gradientColors: [] }), DEFAULT_HEADER_GRADIENT_STOPS);
});

// --- hydrateSecondaryBarConfig ---------------------------------------------

test("secondaryBar: sparse legacy object hydrates every editable subkey", () => {
  const out = hydrateSecondaryBarConfig({ enabled: true, textColor: "#FFEE00" });
  assert.equal(out.enabled, true);
  assert.equal(out.textColor, "#FFEE00");
  // Unset keys become editable empties, not undefined.
  assert.equal(out.height, "");
  assert.equal(out.hoverColor, "");
  assert.equal(out.fontSize, "");
  assert.equal(out.fontWeight, "");
  assert.equal(out.fontFamily, "");
  // Bottom border stays "unset" ('') so the public renderer keeps today's
  // default look (line on the white fallback bar, none on the gradient bar).
  assert.equal(out.bottomBorderEnabled, "");
  assert.equal(out.bottomBorderColor, "");
  assert.equal(out.bottomBorderWidth, "");
  assert.deepEqual(out.gradientStops, DEFAULT_SECONDARY_BAR_GRADIENT_STOPS);
  // Indicator defaults to enabled with the default gradient.
  assert.equal(out.indicator.enabled, true);
  assert.equal(out.indicator.height, "");
  assert.deepEqual(out.indicator.gradientStops, DEFAULT_INDICATOR_GRADIENT_STOPS);
});

test("secondaryBar: stored values survive hydration untouched", () => {
  const stops = [{ color: "#123456", position: 0 }, { color: "#654321", position: 100 }];
  const out = hydrateSecondaryBarConfig({
    enabled: true,
    height: 64,
    gradientStops: stops,
    fontWeight: 700,
    bottomBorderEnabled: true,
    bottomBorderColor: "#ABCDEF",
    bottomBorderWidth: 3,
    indicator: { enabled: false, height: 5, gradientStops: stops },
  });
  assert.equal(out.height, 64);
  assert.deepEqual(out.gradientStops, stops);
  assert.equal(out.fontWeight, 700);
  // Explicit border settings round-trip untouched (true/false is a real value).
  assert.equal(out.bottomBorderEnabled, true);
  assert.equal(out.bottomBorderColor, "#ABCDEF");
  assert.equal(out.bottomBorderWidth, 3);
  assert.equal(out.indicator.enabled, false);
  assert.equal(out.indicator.height, 5);
  assert.deepEqual(out.indicator.gradientStops, stops);
});

test("secondaryBar: missing object hydrates to disabled defaults", () => {
  const out = hydrateSecondaryBarConfig(undefined);
  assert.equal(out.enabled, false);
  assert.deepEqual(out.gradientStops, DEFAULT_SECONDARY_BAR_GRADIENT_STOPS);
});

// --- hydrateFooterConfig -----------------------------------------------------

test("footer: withDefaults hydrates the same defaults /admin/branding uses", () => {
  const out = hydrateFooterConfig({});
  assert.equal(out.columns, 4);
  assert.equal(out.ctaText, "Become a member today");
  assert.equal(out.ctaButtonText, "Join Us");
  assert.equal(out.ctaLink, "Membership");
  assert.equal(out.newsletterText, "Sign up to our newsletter");
  assert.equal(out.backgroundColor, "#000000");
  assert.equal(out.textColor, "#FFFFFF");
  assert.equal(out.gradientColors.length, 5);
  assert.deepEqual(out.address, { name: "", lines: [] });
  assert.deepEqual(out.contact, { phone: "", email: "" });
});

test("footer: withDefaults=false leaves unset keys empty (microsite inherit)", () => {
  const out = hydrateFooterConfig({}, { withDefaults: false });
  assert.equal(out.columns, "");
  assert.equal(out.ctaText, "");
  assert.equal(out.backgroundColor, "");
  assert.deepEqual(out.gradientColors, []);
  assert.deepEqual(out.address, { name: "", lines: [] });
  assert.deepEqual(out.contact, { phone: "", email: "" });
});

test("footer: legacy stored subkeys (address/contact/urls) all hydrate", () => {
  const fc = {
    columns: 3,
    columnAlignments: { 0: "center" },
    gradientColors: ["#111111", "#222222"],
    backgroundColor: "#0A0A0A",
    textColor: "#EEEEEE",
    newsletterText: "Join our list",
    address: { name: "Head Office", lines: ["1 Main St", "London"] },
    contact: { phone: "0123", email: "hi@example.org" },
    legalText: "(c) Example",
    termsAndConditionsUrl: "https://example.org/terms",
    privacyPolicyUrl: "https://example.org/privacy",
  };
  const out = hydrateFooterConfig(fc, { withDefaults: false });
  assert.equal(out.columns, 3);
  assert.deepEqual(out.columnAlignments, { 0: "center" });
  assert.deepEqual(out.gradientColors, ["#111111", "#222222"]);
  assert.equal(out.backgroundColor, "#0A0A0A");
  assert.equal(out.textColor, "#EEEEEE");
  assert.equal(out.newsletterText, "Join our list");
  assert.deepEqual(out.address, { name: "Head Office", lines: ["1 Main St", "London"] });
  assert.deepEqual(out.contact, { phone: "0123", email: "hi@example.org" });
  assert.equal(out.legalText, "(c) Example");
  assert.equal(out.termsAndConditionsUrl, "https://example.org/terms");
  assert.equal(out.privacyPolicyUrl, "https://example.org/privacy");
});
