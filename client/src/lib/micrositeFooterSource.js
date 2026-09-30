const FOOTER_SOURCES = new Set(["inherit", "configured", "canvas"]);

export function buildMicrositeFooterSourcePayload(source, canvasFooterId) {
  const footerSource = FOOTER_SOURCES.has(source) ? source : "configured";
  return {
    footer_source: footerSource,
    canvas_footer_id: footerSource === "canvas" ? (canvasFooterId || null) : null,
  };
}