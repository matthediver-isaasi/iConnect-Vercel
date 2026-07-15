// Lazy access to the FULL Lucide icon catalog (1500+ icons) without pulling
// the whole library into the main bundle. lucide-react's dynamicIconImports
// maps kebab-case icon names to per-icon dynamic imports, so only the icons
// actually used are ever fetched. The map itself is also loaded on demand.
//
// Names: legacy button styles store curated PascalCase names (resolved by the
// canvas registry's curated map); the full-catalog picker stores the kebab
// name verbatim (e.g. "arrow-up-right"). kebabizeLucideName converts either
// form so both resolve here.

let _mapPromise = null;
let _map = null; // { 'arrow-up-right': () => import(...), ... }
const _iconCache = new Map(); // kebab name -> React component

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

export function loadLucideIconMap() {
  if (!_mapPromise) {
    _mapPromise = import('lucide-react/dynamicIconImports')
      .then((mod) => {
        _map = mod.default || mod;
        return _map;
      })
      .catch((err) => {
        _mapPromise = null; // allow retry
        throw err;
      });
  }
  return _mapPromise;
}

// Synchronous lookup of an already-loaded catalog icon (or null).
export function getCachedLucideIcon(name) {
  return _iconCache.get(kebabizeLucideName(name)) || null;
}

// Load a single catalog icon component by (Pascal or kebab) name.
// Resolves to the component, or null when the name isn't in the catalog.
export async function loadLucideIcon(name) {
  const kebab = kebabizeLucideName(name);
  if (!kebab) return null;
  if (_iconCache.has(kebab)) return _iconCache.get(kebab);
  const map = await loadLucideIconMap();
  const importer = map[kebab];
  if (!importer) return null;
  const mod = await importer();
  const Cmp = mod.default || null;
  if (Cmp) _iconCache.set(kebab, Cmp);
  return Cmp;
}

// All catalog icon names (kebab-case), for the picker's search list.
export async function listLucideIconNames() {
  const map = await loadLucideIconMap();
  return Object.keys(map);
}
