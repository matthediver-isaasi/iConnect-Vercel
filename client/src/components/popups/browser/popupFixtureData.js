import { createBlock, createFlowDesign, createFlowNode, insertFlowNode, normalizeCanvasDesign } from "../../../lib/canvasDesign.js";
import { POPUP_DEFAULT_CONFIG } from "../../../../../shared/cmsPopupContract.js";

export function popupFixtureDesign(version = 1, tall = false) {
  const markers = ["desktop", "tablet", "mobile"].map((breakpoint) => ({
    id: `marker-${breakpoint}`, type: "text",
    content: { html: `<p>${breakpoint} Canvas geometry</p>` },
    bp: Object.fromEntries(["desktop", "tablet", "mobile"].map((bp) => [bp, { x: 0, y: 0, w: 280, h: 42, hidden: bp !== breakpoint }])),
  }));
  const prose = { id: "popup-prose", type: "text", content: { html: "<p>A real Canvas announcement with responsive text and an interactive link.</p>" },
    bp: { desktop: { x: 0, y: 50, w: 980, h: 70 }, tablet: { x: 0, y: 50, w: 700, h: 70 }, mobile: { x: 0, y: 50, w: 360, h: 96 } } };
  const action = { id: "popup-action", type: "button", content: { label: "Canvas action", href: "#fixture-action" },
    bp: { desktop: { x: 0, y: 160, w: 180, h: 44 }, tablet: { x: 0, y: 160, w: 180, h: 44 }, mobile: { x: 0, y: 180, w: 180, h: 44 } } };
  const spacer = { id: "popup-bottom", type: "text", content: { html: "<p>End of announcement</p>" },
    bp: { desktop: { x: 0, y: tall ? 1850 : 240, w: 280, h: 50 }, tablet: { x: 0, y: tall ? 1850 : 240, w: 280, h: 50 }, mobile: { x: 0, y: tall ? 1850 : 260, w: 280, h: 50 } } };
  const authored = (block) => ({ ...block, ...block.bp });
  if (version === 1) return normalizeCanvasDesign({ version: 1, root: { sections: [{ id: "fixture-root", children: [...markers, prose, action, spacer].map((block) => createBlock(block.type, authored(block))) }] } });
  let design = createFlowDesign();
  design.root.sections[0].id = "fixture-flow-section";
  design.root.sections[0].flow = { ...design.root.sections[0].flow, padTop: 0, padBottom: 0, padLeft: 0, padRight: 0, gap: 12 };
  for (const block of [...markers, prose, action]) design = insertFlowNode(design, createFlowNode(block.type, { ...authored(block), flow: { heightMode: "fixed", height: block.type === "button" ? 44 : 80 } }));
  if (tall) design = insertFlowNode(design, createFlowNode("spacer", { id: "long-spacer", flow: { heightMode: "fixed", height: 1850 } }));
  return insertFlowNode(design, createFlowNode(spacer.type, { ...authored(spacer), flow: { heightMode: "fixed", height: 50 } }));
}

export function popupFixtureRecord({ version = 1, width = 800, modal = {}, tall = false, id = "11111111-1111-4111-8111-111111111111", priority = 4, trigger = { type: "immediate", value: 0 }, frequency = "page_view" } = {}) {
  return {
    id, name: "Fixture announcement", revision: 1, dismissal_generation: 1,
    design: popupFixtureDesign(version, tall), symbols: [], ends_at: null,
    config: { ...structuredClone(POPUP_DEFAULT_CONFIG), priority, trigger,
      frequency: { type: frequency, days: 1 },
      modal: { ...POPUP_DEFAULT_CONFIG.modal, width, ...modal } },
  };
}
