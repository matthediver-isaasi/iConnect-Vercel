import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Search, Loader2 } from 'lucide-react';
import {
  listLucideIconNames,
  loadLucideIcon,
  getCachedLucideIcon,
  kebabizeLucideName,
} from '@/lib/lucideCatalog';

// Task #2804: searchable picker over the FULL Lucide catalog (1500+ icons)
// for button-style default icons. Mirrors FontAwesomeIconPicker's lazy-load
// pattern: the name list loads only when the dialog first opens, and each
// icon component is fetched on demand as it scrolls into the results grid.

const MAX_RESULTS = 120;

function LucidePreview({ name }) {
  const [, force] = useState(0);
  const Cmp = getCachedLucideIcon(name);
  useEffect(() => {
    if (Cmp) return;
    let cancelled = false;
    loadLucideIcon(name)
      .then((loaded) => { if (!cancelled && loaded) force((n) => n + 1); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [name, Cmp]);
  if (!Cmp) return <span className="inline-block w-5 h-5" aria-hidden="true" />;
  return <Cmp className="w-5 h-5 text-slate-700" />;
}

export function LucideIconPicker({ open, onClose, onSelect, currentValue }) {
  const [names, setNames] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0); // bumped by the retry button
  const searchRef = useRef(null);
  const loadStartedRef = useRef(false);

  useEffect(() => {
    if (!open || names || loadStartedRef.current) return;
    loadStartedRef.current = true;
    let cancelled = false;
    setLoading(true);
    setError(false);
    listLucideIconNames()
      .then((list) => {
        if (cancelled) return;
        setNames(list);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        loadStartedRef.current = false; // allow retry next open
        setError(true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, names, attempt]);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => searchRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const currentKebab = kebabizeLucideName(currentValue || '');

  const results = useMemo(() => {
    if (!names) return [];
    const q = query.trim().toLowerCase().replace(/\s+/g, '-');
    const out = [];
    for (const n of names) {
      if (q && !n.includes(q)) continue;
      out.push(n);
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }, [names, query]);

  const handlePick = (name) => {
    onSelect(name);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl" data-testid="dialog-lucide-icon-picker">
        <DialogHeader>
          <DialogTitle>Choose a Lucide icon</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search icons (e.g. arrow, star, calendar)…"
              className="h-9 pl-8"
              data-testid="input-lucide-icon-search"
            />
          </div>

          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500" data-testid="status-lucide-icon-loading">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading icons…
            </div>
          )}
          {error && (
            <div className="py-12 text-center text-sm text-slate-500 space-y-3" data-testid="status-lucide-icon-error">
              <p>Could not load the icon list.</p>
              <button
                type="button"
                className="text-primary underline underline-offset-2"
                onClick={() => {
                  // loadStartedRef was reset by the failed attempt; bumping
                  // `attempt` re-runs the load effect without closing.
                  setError(false);
                  setAttempt((n) => n + 1);
                }}
                data-testid="button-lucide-icon-retry"
              >
                Try again
              </button>
            </div>
          )}

          {!loading && !error && names && (
            <>
              <div
                className="grid grid-cols-4 sm:grid-cols-6 gap-1 max-h-[50vh] overflow-y-auto pr-1"
                data-testid="grid-lucide-icons"
              >
                {results.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => handlePick(name)}
                    title={name}
                    className={`flex flex-col items-center justify-center gap-1 rounded-md p-2 hover-elevate active-elevate-2 ${currentKebab === name ? 'ring-2 ring-primary' : ''}`}
                    data-testid={`lucide-icon-option-${name}`}
                  >
                    <LucidePreview name={name} />
                    <span className="w-full truncate text-center text-[9px] text-slate-500">{name}</span>
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                <span data-testid="text-lucide-icon-result-count">
                  {results.length === 0
                    ? 'No icons match your search'
                    : `Showing ${results.length}${results.length >= MAX_RESULTS ? '+' : ''} of ${names.length} icons`}
                </span>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default LucideIconPicker;
