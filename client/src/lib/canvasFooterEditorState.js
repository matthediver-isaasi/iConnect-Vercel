/**
 * Keep CanvasBuilder's hydration input stable for the lifetime of one footer.
 *
 * CanvasBuilder deliberately treats a new initialDesign object as an explicit
 * document reset. Query refetches and dirty-state rerenders can provide newly
 * allocated copies of the same footer, but must not reset unsaved local edits.
 * A different footer ID is a real document change and gets a fresh normalized
 * design.
 */
export function createCanvasFooterInitialDesignResolver(normalizeDesign) {
  let currentFooterId = null;
  let currentInitialDesign = null;

  return (footer) => {
    if (!footer?.id) return null;
    if (footer.id !== currentFooterId) {
      currentFooterId = footer.id;
      currentInitialDesign = normalizeDesign(footer.design);
    }
    return currentInitialDesign;
  };
}