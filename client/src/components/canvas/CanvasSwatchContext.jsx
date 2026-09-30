import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { adminFetch } from '@/lib/adminFetch';
import { useToast } from '@/components/ui/use-toast';

/**
 * Task #2561: resolves + persists the Canvas colour palette for the page
 * currently open in the CanvasBuilder editor.
 *
 * Scope follows the page: a page belonging to a microsite manages that
 * microsite's swatches (microsite.branding_config.canvas_swatches); a main-site
 * page manages the tenant's swatches (tenant.branding_config.canvas_swatches).
 * The two scopes are fully independent.
 *
 * This provider is only mounted inside the editor shell. On public pages it is
 * absent, so `useCanvasSwatches()` returns null and every ColorField degrades
 * to a plain colour picker.
 */

const CanvasSwatchContext = createContext(null);

const HEX_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const MAX_SWATCHES = 48;
const MAX_LABEL_LEN = 60;

function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!HEX_RE.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

function normalizeLabel(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_LABEL_LEN);
}

// Task #2698: swatches are stored as `{ hex, label }` entries. Reading accepts
// both the current object shape AND legacy plain hex strings (label defaults to
// ''), so existing palettes keep working with no data migration. Dedupe by hex.
function readSwatches(config) {
  const list = Array.isArray(config?.canvas_swatches) ? config.canvas_swatches : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    let hex = null;
    let label = '';
    if (typeof raw === 'string') {
      hex = normalizeHex(raw);
    } else if (raw && typeof raw === 'object') {
      hex = normalizeHex(raw.hex);
      label = normalizeLabel(raw.label);
    }
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push({ hex, label });
    if (out.length >= MAX_SWATCHES) break;
  }
  return out;
}

export function useCanvasSwatches() {
  return useContext(CanvasSwatchContext);
}

export function CanvasSwatchProvider({ micrositeId = null, children }) {
  const isMicrosite = !!micrositeId;
  const [swatches, setSwatches] = useState([]);
  const [ready, setReady] = useState(false);
  // Full branding_config for the active scope. The microsite endpoint rebuilds
  // branding_config from scratch on save, so we must resend the whole object
  // (with canvas_swatches swapped) to avoid dropping other branding keys.
  const brandingConfigRef = useRef({});
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setSwatches([]);
    (async () => {
      try {
        let config = {};
        if (isMicrosite) {
          const res = await adminFetch(`/api/admin/microsites?id=${encodeURIComponent(micrositeId)}`);
          const data = await res.json().catch(() => ({}));
          config = data?.microsite?.branding_config || {};
        } else {
          const res = await adminFetch('/api/admin/tenant-branding');
          const data = await res.json().catch(() => ({}));
          config = data?.branding?.branding_config || {};
        }
        if (cancelled) return;
        brandingConfigRef.current = (config && typeof config === 'object' && !Array.isArray(config)) ? config : {};
        setSwatches(readSwatches(brandingConfigRef.current));
      } catch {
        if (!cancelled) setSwatches([]);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [micrositeId, isMicrosite]);

  const persist = useCallback(async (next) => {
    try {
      if (isMicrosite) {
        const branding_config = { ...brandingConfigRef.current, canvas_swatches: next };
        const res = await adminFetch(`/api/admin/microsites?id=${encodeURIComponent(micrositeId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branding_config }),
        });
        if (!res.ok) throw new Error('save failed');
        const data = await res.json().catch(() => ({}));
        brandingConfigRef.current = data?.microsite?.branding_config || branding_config;
      } else {
        const res = await adminFetch('/api/admin/tenant-branding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branding_config: { canvas_swatches: next } }),
        });
        if (!res.ok) throw new Error('save failed');
        const data = await res.json().catch(() => ({}));
        brandingConfigRef.current = data?.branding?.branding_config
          || { ...brandingConfigRef.current, canvas_swatches: next };
      }
      return true;
    } catch {
      return false;
    }
  }, [isMicrosite, micrositeId]);

  // Persist `next` after a functional state update. On failure, resync from the
  // last server-confirmed config and warn the author.
  const persistAsync = useCallback((next) => {
    persist(next).then((ok) => {
      if (!ok) {
        setSwatches(readSwatches(brandingConfigRef.current));
        toast({
          title: 'Could not save palette',
          description: 'Your change was reverted. Please try again.',
          variant: 'destructive',
        });
      }
    });
  }, [persist, toast]);

  const addSwatch = useCallback((color, label = '') => {
    const hex = normalizeHex(color);
    if (!hex) return false;
    const lbl = normalizeLabel(label);
    setSwatches((prev) => {
      if (prev.some((s) => s.hex === hex)) return prev;
      if (prev.length >= MAX_SWATCHES) {
        toast({ title: 'Palette is full', description: `You can save up to ${MAX_SWATCHES} swatches.`, variant: 'destructive' });
        return prev;
      }
      const next = [...prev, { hex, label: lbl }];
      persistAsync(next);
      return next;
    });
    return true;
  }, [persistAsync, toast]);

  const removeSwatch = useCallback((index) => {
    setSwatches((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const next = prev.slice();
      next.splice(index, 1);
      persistAsync(next);
      return next;
    });
  }, [persistAsync]);

  // Task #2698: patch a swatch's hex and/or label. `patch` may be a plain hex
  // string (colour only, back-compat) or an object `{ hex?, label? }`. Changing
  // the hex to one that already exists on another swatch is rejected (dedupe).
  const updateSwatch = useCallback((index, patch) => {
    setSwatches((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const current = prev[index];
      let nextHex = current.hex;
      let nextLabel = current.label;
      if (typeof patch === 'string') {
        const hex = normalizeHex(patch);
        if (!hex) return prev;
        nextHex = hex;
      } else if (patch && typeof patch === 'object') {
        if (patch.hex !== undefined) {
          const hex = normalizeHex(patch.hex);
          if (!hex) return prev;
          nextHex = hex;
        }
        if (patch.label !== undefined) {
          nextLabel = normalizeLabel(patch.label);
        }
      } else {
        return prev;
      }
      if (nextHex !== current.hex && prev.some((s, j) => j !== index && s.hex === nextHex)) return prev;
      if (nextHex === current.hex && nextLabel === current.label) return prev;
      const next = prev.slice();
      next[index] = { hex: nextHex, label: nextLabel };
      persistAsync(next);
      return next;
    });
  }, [persistAsync]);

  const reorderSwatch = useCallback((from, to) => {
    setSwatches((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      persistAsync(next);
      return next;
    });
  }, [persistAsync]);

  const value = useMemo(() => ({
    swatches,
    ready,
    isMicrosite,
    micrositeId: micrositeId || null,
    scopeLabel: isMicrosite ? 'this microsite' : 'the main site',
    max: MAX_SWATCHES,
    hasSwatch: (color) => { const h = normalizeHex(color); return h ? swatches.some((s) => s.hex === h) : false; },
    addSwatch,
    removeSwatch,
    updateSwatch,
    reorderSwatch,
  }), [swatches, ready, isMicrosite, micrositeId, addSwatch, removeSwatch, updateSwatch, reorderSwatch]);

  return (
    <CanvasSwatchContext.Provider value={value}>
      {children}
    </CanvasSwatchContext.Provider>
  );
}
