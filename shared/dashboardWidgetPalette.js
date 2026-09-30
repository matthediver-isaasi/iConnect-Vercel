export const DASHBOARD_WIDGET_PALETTE_SLOTS = [
  { key: "default", label: "Default", color: "hsl(var(--chart-1))", editorColor: "#e76e50" },
  { key: "emerald", label: "Emerald", color: "hsl(var(--chart-2))", editorColor: "#2a9d90" },
  { key: "amber", label: "Amber", color: "hsl(var(--chart-3))", editorColor: "#274754" },
  { key: "violet", label: "Violet", color: "hsl(var(--chart-4))", editorColor: "#e8c468" },
  { key: "rose", label: "Rose", color: "hsl(var(--chart-5))", editorColor: "#f4a462" },
];

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

export function defaultDashboardWidgetPalette() {
  return DASHBOARD_WIDGET_PALETTE_SLOTS.map(slot => ({ ...slot }));
}

export function normalizeDashboardWidgetPalette(input) {
  const entries = Array.isArray(input) ? input : [];
  return DASHBOARD_WIDGET_PALETTE_SLOTS.map(defaultSlot => {
    const saved = entries.find(entry => entry?.key === defaultSlot.key);
    const label =
      typeof saved?.label === "string" && saved.label.trim()
        ? saved.label.trim().slice(0, 40)
        : defaultSlot.label;
    const savedColor = typeof saved?.color === "string" ? saved.color.trim() : "";
    const color =
      savedColor === defaultSlot.color
        ? defaultSlot.color
        : HEX_COLOUR.test(savedColor)
          ? savedColor.toLowerCase()
          : defaultSlot.color;
    return { ...defaultSlot, label, color };
  });
}

export function paletteForEditing(input) {
  return normalizeDashboardWidgetPalette(input).map(slot => ({
    key: slot.key,
    label: slot.label,
    color: HEX_COLOUR.test(slot.color) ? slot.color.toLowerCase() : slot.editorColor,
    themeDefault: slot.color === DASHBOARD_WIDGET_PALETTE_SLOTS.find(
      defaultSlot => defaultSlot.key === slot.key,
    )?.color,
  }));
}

export function validateDashboardWidgetPalette(input) {
  if (!Array.isArray(input)) {
    return { success: false, error: "palette must be an array" };
  }
  const clean = [];
  for (const defaultSlot of DASHBOARD_WIDGET_PALETTE_SLOTS) {
    const entry = input.find(item => item?.key === defaultSlot.key);
    if (!entry) {
      return { success: false, error: `Missing palette slot: ${defaultSlot.key}` };
    }
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const rawColor = typeof entry.color === "string" ? entry.color.trim() : "";
    const color =
      rawColor === defaultSlot.color
        ? defaultSlot.color
        : rawColor.toLowerCase();
    if (!label || label.length > 40) {
      return {
        success: false,
        error: `${defaultSlot.label} label must be between 1 and 40 characters`,
      };
    }
    if (color !== defaultSlot.color && !HEX_COLOUR.test(color)) {
      return {
        success: false,
        error: `${label || defaultSlot.label} colour must be a six-digit hex value`,
      };
    }
    clean.push({ key: defaultSlot.key, label, color });
  }
  return { success: true, palette: clean };
}

export function resolveDashboardWidgetColour(palette, key) {
  const effective = normalizeDashboardWidgetPalette(palette);
  return (
    effective.find(slot => slot.key === key)?.color ||
    effective[0]?.color ||
    DASHBOARD_WIDGET_PALETTE_SLOTS[0].color
  );
}

export function dashboardWidgetChartColours(palette) {
  return normalizeDashboardWidgetPalette(palette).map(slot => slot.color);
}