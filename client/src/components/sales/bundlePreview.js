// Unsaved catalogue choices are estimates only. Saved component evidence is
// authoritative, even when its category is absent (legacy proposals).
export function bundlePreviewLines(lines, products, bundles, categories) {
  return lines.map(line => {
    if (line.type !== 'bundle') return line;
    const bundle = bundles.find(b => b.id === line.bundleId);
    const savedId = line.catalogue_id || line.catalogueId;
    if (savedId === line.bundleId && (line.sales_quote_bundle_component || line.components || line.bundleComponents)) return line;
    return { ...line, sales_quote_bundle_component: undefined, bundleComponents: (bundle?.items || []).map(item => {
      const product = products.find(p => p.id === item.productId);
      const category = categories.find(c => c.id === product?.categoryId);
      return { quantity: item.quantity, name: product?.name || 'Unavailable product',
        categoryName: product ? product.categoryId ? category?.name : 'Uncategorised' : undefined };
    }) };
  });
}
