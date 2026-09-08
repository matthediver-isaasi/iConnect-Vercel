const PANEL_WIDTH = 320;
const MIN_PANEL_WIDTH = 240;
const MIN_CANVAS_WIDTH = 240;
const PALETTE_WIDTH = 256;
const PALETTE_BREAKPOINT = 1280;

export function getEmailBuilderPanelLayout({
  editorWidth,
  layersOpen,
  propertiesExpanded,
  compactPaletteOpen = false,
}) {
  const width = Math.max(0, Number(editorWidth) || 0);
  const showPalette = compactPaletteOpen || (width >= PALETTE_BREAKPOINT && !propertiesExpanded);
  const paletteWidth = showPalette ? PALETTE_WIDTH : 0;
  const availableForPanels = Math.max(0, width - paletteWidth - MIN_CANVAS_WIDTH);
  const panelCount = layersOpen ? 2 : 1;
  const normalPanelWidth = Math.min(
    PANEL_WIDTH,
    Math.max(MIN_PANEL_WIDTH, availableForPanels / panelCount),
  );

  const layersWidth = layersOpen ? normalPanelWidth : 0;
  const desiredPropertiesWidth = propertiesExpanded ? PANEL_WIDTH * 2 : PANEL_WIDTH;
  const propertiesWidth = Math.min(
    desiredPropertiesWidth,
    Math.max(
      MIN_PANEL_WIDTH,
      availableForPanels - layersWidth,
    ),
  );

  return {
    showPalette,
    layersWidth,
    propertiesWidth,
    railWidth: layersWidth + propertiesWidth,
  };
}