// Shared resolution of the search-results branding used across all three search
// surfaces: the full results page (`pages/SearchResults.jsx`), the header search
// dropdown (`components/layouts/PublicHeader.jsx`), and the Canvas Builder search
// element (`components/canvas/blocks/dynamicBlocks.jsx`).
//
// Each surface resolves its own `brandingConfig` object (from a query, the
// tenant-branding context, or the public chrome branding), but they must apply
// the SAME two keys and the SAME fallback rules, otherwise the styling drifts
// out of sync. Keep that logic here in one place.
//
// The two keys are:
//   - searchResultsFont            — font family applied to result text.
//   - searchResultsTypeLabelColor  — colour for the type labels / affordances.
// The tinted background behind a chosen type-label colour is derived from that
// colour so all three surfaces produce an identical subtle tint.

// Convert a #rgb / #rrggbb hex string to an rgba() with the given alpha. Returns
// null for malformed input so callers can fall back to the default look.
export function hexToRgba(hex, alpha) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9A-Fa-f]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Resolve the search-results branding from a brandingConfig object. Accepts the
// raw config (e.g. `branding.brandingConfig`) and returns the resolved values
// with fallbacks applied in one place.
//   font          — configured font family, or null (surface uses its default).
//   typeLabelColor — configured type-label colour, or null.
//   typeLabelBg   — subtle tinted background derived from typeLabelColor, or null.
export function resolveSearchResultsBranding(brandingConfig) {
  const cfg = brandingConfig || {};
  const font = cfg.searchResultsFont || null;
  const typeLabelColor = cfg.searchResultsTypeLabelColor || null;
  const typeLabelBg = typeLabelColor ? hexToRgba(typeLabelColor, 0.12) : null;
  return { font, typeLabelColor, typeLabelBg };
}
