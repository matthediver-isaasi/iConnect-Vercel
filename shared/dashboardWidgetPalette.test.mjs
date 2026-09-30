import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_WIDGET_PALETTE_SLOTS,
  dashboardWidgetChartColours,
  normalizeDashboardWidgetPalette,
  paletteForEditing,
  resolveDashboardWidgetColour,
  validateDashboardWidgetPalette,
} from "./dashboardWidgetPalette.js";

test("unconfigured tenants retain the five built-in palette slots", () => {
  const palette = normalizeDashboardWidgetPalette(null);
  assert.deepEqual(
    palette.map(slot => slot.key),
    ["default", "emerald", "amber", "violet", "rose"],
  );
  assert.deepEqual(
    palette.map(slot => slot.color),
    DASHBOARD_WIDGET_PALETTE_SLOTS.map(slot => slot.color),
  );
});

test("partial or malformed saved palettes fall back per slot", () => {
  const palette = normalizeDashboardWidgetPalette([
    { key: "default", label: "Brand blue", color: "#123abc" },
    { key: "emerald", label: "", color: "not-a-colour" },
  ]);
  assert.equal(palette[0].label, "Brand blue");
  assert.equal(palette[0].color, "#123abc");
  assert.equal(palette[1].label, "Emerald");
  assert.equal(palette[1].color, DASHBOARD_WIDGET_PALETTE_SLOTS[1].color);
  assert.equal(palette.length, 5);
});

test("legacy widget keys resolve against custom tenant colours", () => {
  const input = paletteForEditing(null).map((slot, index) => ({
    ...slot,
    color: `#00000${index}`,
  }));
  assert.equal(resolveDashboardWidgetColour(input, "violet"), "#000003");
  assert.equal(resolveDashboardWidgetColour(input, "unknown"), "#000000");
  assert.deepEqual(dashboardWidgetChartColours(input), input.map(slot => slot.color));
});

test("palette writes require all stable keys, labels, and six-digit hex colours", () => {
  const valid = paletteForEditing(null);
  assert.equal(validateDashboardWidgetPalette(valid).success, true);
  assert.equal(validateDashboardWidgetPalette(valid.slice(1)).success, false);
  assert.equal(
    validateDashboardWidgetPalette(
      valid.map(slot => (slot.key === "rose" ? { ...slot, color: "#fff" } : slot)),
    ).success,
    false,
  );
  assert.equal(
    validateDashboardWidgetPalette(
      valid.map(slot => (slot.key === "amber" ? { ...slot, label: " " } : slot)),
    ).success,
    false,
  );
});

test("opening and saving built-in defaults preserves theme-aware chart tokens", () => {
  const draft = paletteForEditing(null);
  assert.ok(draft.every(slot => slot.themeDefault === true));
  const payload = draft.map(slot => {
    const defaultSlot = DASHBOARD_WIDGET_PALETTE_SLOTS.find(item => item.key === slot.key);
    return {
      key: slot.key,
      label: slot.label,
      color: slot.themeDefault ? defaultSlot.color : slot.color,
    };
  });
  const parsed = validateDashboardWidgetPalette(payload);
  assert.equal(parsed.success, true);
  assert.deepEqual(
    normalizeDashboardWidgetPalette(parsed.palette).map(slot => slot.color),
    DASHBOARD_WIDGET_PALETTE_SLOTS.map(slot => slot.color),
  );
});