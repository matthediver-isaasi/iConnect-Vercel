import { BREAKPOINT_WIDTHS } from "./canvasDesign.js";
import { POPUP_DEFAULT_CONFIG } from "../../../shared/cmsPopupContract.js";

export function popupEditorDimensions(config, viewport = "desktop") {
  const modal = { ...POPUP_DEFAULT_CONFIG.modal, ...config?.modal };
  const viewportWidth = BREAKPOINT_WIDTHS[viewport] || BREAKPOINT_WIDTHS.desktop;
  // Same 12px per-side viewport gutter, border and content padding as PopupModal.
  const modalWidth = Math.min(Number(modal.width), viewportWidth - 24);
  const contentWidth = Math.max(1, modalWidth - 2 * Number(modal.border_width) - 2 * Number(modal.padding));
  return { modalWidth, contentWidth, viewportWidth, breakpoint: contentWidth < 640 ? "mobile" : contentWidth < 1024 ? "tablet" : "desktop" };
}
