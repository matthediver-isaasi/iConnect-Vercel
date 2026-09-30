// Shared helper for building a Google Fonts stylesheet URL from a tenant's
// installed fonts. Pure/no-deps so it can be imported by serverless endpoints
// and the SSR layer (api/_lib/renderHtml.js) alike. Task #2549.

const DEFAULT_WEIGHTS = '400;500;600;700';

/**
 * Build a fonts.googleapis.com/css2 URL from installed-font rows.
 * Only rows with a non-empty `google_family` token contribute; system fonts
 * (Arial, Georgia, etc.) and locally-hosted fonts (Degular) are skipped.
 *
 * @param {Array<{google_family?: string}>} fonts
 * @param {{weights?: string}} [opts]
 * @returns {string|null} the stylesheet URL, or null when there is nothing to load
 */
export function buildGoogleFontsHref(fonts, opts = {}) {
  if (!Array.isArray(fonts)) return null;
  const weights = opts.weights || DEFAULT_WEIGHTS;
  const seen = new Set();
  const families = [];
  for (const f of fonts) {
    const fam = (f && typeof f.google_family === 'string') ? f.google_family.trim() : '';
    if (!fam || seen.has(fam)) continue;
    seen.add(fam);
    families.push(fam);
  }
  if (families.length === 0) return null;
  const query = families.map((fam) => `family=${fam}:wght@${weights}`).join('&');
  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
}
