/**
 * Task #2572: microsite-scoped typography styles — shared scope resolver.
 *
 * A typography_style belongs to exactly one scope: the main tenant site
 * (microsite_id IS NULL) or a single microsite (microsite_id = <id>).
 *
 * Given the tenant's full active style list and the microsite context of a
 * request, resolve the styles that apply to that page:
 *
 *   - Main site (micrositeId falsy): only the main-site styles.
 *   - A microsite: the main-site styles PLUS that microsite's own styles, so a
 *     block referencing any style id still resolves (no broken/unstyled blocks).
 *     The EFFECTIVE default per style_type is the microsite's default when it
 *     defines one, otherwise the main-site default — the microsite default
 *     suppresses the main-site default flag for that style_type so exactly one
 *     style per (style_type) is marked default in the returned list.
 *
 * Pure + dependency-free so both the SSR layer (api/_lib/renderHtml.js) and the
 * public endpoint (api/public/typography-styles.js) share identical behaviour.
 */

function isActive(style) {
  return !!style && style.is_active !== false;
}

function sameId(a, b) {
  return String(a) === String(b);
}

export function resolveScopedTypographyStyles(allStyles, micrositeId) {
  const active = (Array.isArray(allStyles) ? allStyles : []).filter(isActive);
  const mainStyles = active.filter((s) => !s.microsite_id);

  if (!micrositeId) {
    return mainStyles;
  }

  const micrositeStyles = active.filter(
    (s) => s.microsite_id && sameId(s.microsite_id, micrositeId),
  );

  // Style types for which the microsite defines its own default — these
  // suppress the main-site default flag so the microsite default wins.
  const micrositeDefaultTypes = new Set(
    micrositeStyles.filter((s) => s.is_default).map((s) => s.style_type),
  );

  const combined = [...mainStyles, ...micrositeStyles];
  return combined.map((s) => {
    if (s.is_default && !s.microsite_id && micrositeDefaultTypes.has(s.style_type)) {
      return { ...s, is_default: false };
    }
    return s;
  });
}
