// Client helpers for the tenant's installed fonts (Task #2549).
//
// Replaces the hard-coded curated list: dropdowns, previews and public/portal
// pages all resolve the tenant's fonts from the `installed_font` table via the
// public endpoint (which resolves the tenant by host, so it works on both
// authenticated portal pages and unauthenticated public pages). When no tenant
// resolves (localhost / *.replit.dev / editor hosts) or the fetch fails, we
// fall back to the curated defaults so nothing breaks.

import { useEffect, useState } from 'react';
import { CURATED_FONTS, CURATED_GOOGLE_FONTS_URL } from './sharedFonts';

const DEFAULT_WEIGHTS = '400;500;600;700';

// Fallback options mirror the legacy curated list (value = CSS font-stack).
export const DEFAULT_FONT_OPTIONS = CURATED_FONTS;

// Build a fonts.googleapis.com/css2 URL from installed-font rows. Only rows
// with a google_family token contribute (system + local fonts are skipped).
export function buildGoogleFontsUrl(fonts, weights = DEFAULT_WEIGHTS) {
  if (!Array.isArray(fonts)) return null;
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

// Ensure a <link> loading the given google-fonts href exists in <head>.
function injectFontLink(href) {
  if (typeof document === 'undefined' || !href) return;
  const id = 'tenant-installed-fonts';
  let link = document.getElementById(id);
  if (link && link.getAttribute('href') === href) return;
  if (!link) {
    link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  link.setAttribute('href', href);
}

// Inject the stylesheet for a set of installed-font rows.
export function injectInstalledFontsStylesheet(fonts) {
  injectFontLink(buildGoogleFontsUrl(fonts));
}

// Module-level cache so the endpoint is hit once per page load.
let _cache = null;

export function loadInstalledFonts() {
  if (_cache) return _cache;
  _cache = fetch('/api/public/installed-fonts', { credentials: 'include' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (Array.isArray(data) && data.length > 0 ? data : null))
    .catch(() => null);
  return _cache;
}

// Drop the cached fetch so the next consumer re-reads the tenant's fonts.
// Call after an admin adds/removes a font so dropdowns and loaders refresh.
export function clearInstalledFontsCache() {
  _cache = null;
}

// Google Fonts family -> css2 family token (spaces become '+').
export function googleFamilyToken(name) {
  return String(name || '').trim().replace(/\s+/g, '+');
}

// Build the CSS font-stack stored in installed_font.font_stack, matching the
// legacy curated convention: quote multi-word names, append a generic family.
export function buildFontStack(name, category) {
  const clean = String(name || '').trim();
  const generic = category === 'serif' ? 'serif'
    : category === 'monospace' ? 'monospace'
    : 'sans-serif';
  const quoted = /\s/.test(clean) ? `'${clean}'` : clean;
  return `${quoted}, ${generic}`;
}

// Convert installed-font rows to {value,label} dropdown options.
export function fontsToOptions(fonts) {
  if (!Array.isArray(fonts) || fonts.length === 0) return DEFAULT_FONT_OPTIONS;
  return fonts
    .filter((f) => f && f.font_stack)
    .map((f) => ({ value: f.font_stack, label: f.label || f.font_stack }));
}

// React hook: returns the tenant's installed fonts as dropdown options and
// injects the matching google-fonts stylesheet so options render in their own
// typeface. Falls back to the curated defaults while loading / when empty.
export function useInstalledFonts() {
  const [fonts, setFonts] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    loadInstalledFonts().then((data) => {
      if (!alive) return;
      if (data) {
        injectInstalledFontsStylesheet(data);
        setFonts(data);
      } else {
        // No tenant resolved / fetch failed: keep the legacy curated fonts loaded.
        injectFontLink(CURATED_GOOGLE_FONTS_URL);
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  return {
    fonts: fonts || [],
    options: fontsToOptions(fonts),
    loading,
  };
}

// Side-effect-only component: loads the tenant's installed google fonts (or the
// curated fallback) into <head>. Drop it into a layout that used to hardcode the
// curated @import list. Renders nothing.
export function InstalledFontsLoader() {
  useInstalledFonts();
  return null;
}
