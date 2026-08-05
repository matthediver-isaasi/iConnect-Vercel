// Lazy access to the FULL Lucide icon catalog (1500+ icons) for the icon
// picker and button-style icon rendering.
//
// Task #3168: this used to dynamic-import `lucide-react/dynamicIconImports`
// (a map of 1500+ per-icon dynamic imports). That subpath import rejects in
// the running environment (Vite can't reliably pre-bundle/serve the per-icon
// chunk graph), which made the picker permanently show its error state.
// The main `lucide-react` module is ALREADY fully in the bundle from ~56
// static import sites across the app, so instead we lazy-import that module
// once and derive the kebab-case name catalog from its `icons` export. Icon
// components then come synchronously from the same map, so previews can
// never 404.
//
// Names: legacy button styles store curated PascalCase names (resolved by the
// canvas registry's curated map); the full-catalog picker stores the kebab
// name verbatim (e.g. "arrow-up-right"). kebabizeLucideName converts either
// form so both resolve here.

import { handleStaleChunkError } from '@/lib/staleChunkReload';

let _catalogPromise = null;
let _catalog = null; // Map: 'arrow-up-right' -> React component (incl. lookup aliases)
let _catalogNames = null; // canonical kebab names only (for the picker list)

export function kebabizeLucideName(name) {
  if (!name || typeof name !== 'string') return '';
  const n = name.trim();
  if (/^[a-z0-9-]+$/.test(n)) return n; // already kebab
  return n
    .replace(/Icon$/, '') // curated aliases like ImageIcon / MapIcon
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/(?<![0-9])([a-zA-Z])([0-9])/g, '$1-$2') // Building2 -> building-2, but Grid2x2 -> grid-2x2
    .toLowerCase();
}

// Kebabizing a PascalCase icon name reproduces lucide's official kebab name
// for all but 8 icons whose names end in a two-character group (ArrowDownAZ
// -> official "arrow-down-a-z", ArrowUp01 -> "arrow-up-0-1"). This fixes the
// derived form up to the official one; both forms are registered as lookup
// keys so either spelling of a stored value resolves.
function canonicalizeKebab(kebab) {
  return kebab.replace(/-(01|10|az|za)$/, (m, g) => `-${g[0]}-${g[1]}`);
}

// Loads (once) the kebab-name -> component catalog, derived from the main
// lucide-react module's `icons` export (canonical PascalCase names only —
// no aliases — so kebabizing them reproduces lucide's official kebab names).
function loadCatalog() {
  if (_catalog) return Promise.resolve(_catalog);
  if (!_catalogPromise) {
    _catalogPromise = import('lucide-react')
      .then((mod) => {
        const icons = mod.icons || {};
        const map = new Map();
        const canonicalNames = [];
        for (const [pascal, Cmp] of Object.entries(icons)) {
          const derived = kebabizeLucideName(pascal);
          if (!derived || !Cmp) continue;
          const canonical = canonicalizeKebab(derived);
          if (!map.has(canonical)) {
            map.set(canonical, Cmp);
            canonicalNames.push(canonical);
          }
          if (derived !== canonical && !map.has(derived)) map.set(derived, Cmp); // lookup alias
        }
        if (map.size === 0) throw new Error('lucide-react icons export is empty');
        _catalog = map;
        _catalogNames = canonicalNames.sort();
        return map;
      })
      .catch((err) => {
        _catalogPromise = null; // allow retry
        console.error('[lucideCatalog] failed to load icon catalog:', err);
        // Task #3406: a rejected dynamic import here usually means the tab
        // references a stale (pre-deploy) chunk. Route into the app-wide
        // recovery path (one guarded reload, then a manual-refresh overlay)
        // instead of only surfacing the picker's local error state.
        handleStaleChunkError(err);
        throw err;
      });
  }
  return _catalogPromise;
}

// Synchronous lookup of an already-loaded catalog icon (or null).
export function getCachedLucideIcon(name) {
  if (!_catalog) return null;
  return _catalog.get(kebabizeLucideName(name)) || null;
}

// Load a single catalog icon component by (Pascal or kebab) name.
// Resolves to the component, or null when the name isn't in the catalog.
export async function loadLucideIcon(name) {
  const kebab = kebabizeLucideName(name);
  if (!kebab) return null;
  const map = await loadCatalog();
  return map.get(kebab) || null;
}

// All catalog icon names (canonical kebab-case), for the picker's search list.
export async function listLucideIconNames() {
  await loadCatalog();
  return _catalogNames;
}
