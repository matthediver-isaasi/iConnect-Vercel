// Saved snapshots are authoritative. Do not infer slots from quantity or use
// logicalLineId as the availability API's persisted line ID.
export const exhibitionOf = line => line?.catalogue_snapshot?.exhibition || null;
export const selectionsOf = line => exhibitionOf(line)?.selections || [];
export const hasExhibitionHolds = form => (form?.lines || []).some(line => selectionsOf(line).length > 0);

export function exhibitionSelectionPayload(line) {
  // Omission preserves server selections; an explicit [] releases them.
  if (line.exhibitionSelections === undefined) return {};
  return { exhibitionSelections: line.exhibitionSelections.map(({ slotKey, spaceId }) => ({ slotKey, spaceId })) };
}

export function withExhibitionSelection(form, lineKey, slotKey, spaceId) {
  return {
    ...form,
    lines: form.lines.map(line => {
      if (line.key !== lineKey) return line;
      const current = line.exhibitionSelections ?? selectionsOf(line);
      return { ...line, exhibitionSelections: [
        ...current.filter(selection => selection.slotKey !== slotKey).map(({ slotKey, spaceId }) => ({ slotKey, spaceId })),
        ...(spaceId ? [{ slotKey, spaceId }] : []),
      ] };
    }),
  };
}

export function lineRequiresExhibition(line, products = [], bundles = []) {
  if (exhibitionOf(line)?.slots?.length || selectionsOf(line).length) return true;
  if (line.type === "product") return Boolean(products.find(item => String(item.id) === String(line.productId))?.spaceRequirementId);
  if (line.type === "bundle") {
    const bundle = bundles.find(item => String(item.id) === String(line.bundleId));
    return (bundle?.items || []).some(component => products.some(product => String(product.id) === String(component.productId) && product.spaceRequirementId));
  }
  return false;
}

export function exhibitionMoney(value, currency = "GBP") {
  if (value == null) return "—";
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(Number(value) / 100); }
  catch { return `${currency} ${(Number(value) / 100).toFixed(2)}`; }
}
