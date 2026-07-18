// Style Reference picker for AI generation (Task #2873).
//
// Lets an admin attach a visual style reference to an AI Composition / AI
// page generation: one of their own published pages (captured server-side
// via browserless), an external public URL (same capture path), or uploaded
// screenshots. After capture/upload the screenshots are analysed into a
// structured "Design DNA" profile, shown for review. The influence level
// (Light / Strong / Very Strong) weights how much the reference shapes the
// output — tenant branding and content always win.
//
// Value shape (null = no reference; generation stays exactly as before):
//   { sourceType: 'page'|'url'|'upload', sourceUrl?, screenshots: [{viewport,url}],
//     designDna?, influence }

import { useEffect, useState } from 'react';
import { Loader2, Palette, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { uploadFileWithProgress } from '@/lib/uploadFile';
import { getTenantSlugFromLocation } from '@/api/publicClient';

const MAX_SCREENSHOTS = 4;

async function srFetch(path, options = {}) {
  const slug = getTenantSlugFromLocation();
  const url = new URL(path, window.location.origin);
  if (slug) url.searchParams.set('tenant', slug);
  const res = await fetch(url.pathname + url.search, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function DnaSummary({ designDna }) {
  if (!designDna) return null;
  const rows = [
    ['Composition', designDna.composition],
    ['Layout rhythm', designDna.layoutRhythm],
    ['Typography', designDna.typography],
    ['Imagery', designDna.imageryStyle],
    ['Spacing', designDna.spacingSystem],
  ].filter(([, v]) => v);
  if (!rows.length) return null;
  return (
    <div className="space-y-1 rounded-md border border-border bg-muted/40 p-2 text-xs" data-testid="text-styleref-dna">
      {rows.map(([label, v]) => (
        <p key={label} className="text-muted-foreground">
          <span className="font-medium text-foreground">{label}:</span> {v}
        </p>
      ))}
    </div>
  );
}

export default function StyleReferencePicker({ value, onChange, idPrefix = 'styleref', disabled = false }) {
  const [open, setOpen] = useState(!!value);
  const [sourceType, setSourceType] = useState(value?.sourceType || 'page');
  const [pageQuery, setPageQuery] = useState('');
  const [pageResults, setPageResults] = useState([]);
  const [pageId, setPageId] = useState('');
  const [extUrl, setExtUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [error, setError] = useState('');
  // Non-blocking: DNA analysis can fail while the screenshots still work.
  const [analyzeWarning, setAnalyzeWarning] = useState('');

  // Debounced published-page search (reuses the destinations picker endpoint).
  useEffect(() => {
    if (sourceType !== 'page' || !open) return undefined;
    const q = pageQuery.trim();
    if (!q) { setPageResults([]); return undefined; }
    const t = setTimeout(async () => {
      try {
        const data = await srFetch(`/api/ai-compositions/destinations?q=${encodeURIComponent(q)}&kinds=page`);
        setPageResults(data.destinations || []);
      } catch {
        setPageResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [pageQuery, sourceType, open]);

  const analyze = async (screenshots) => {
    setBusyLabel('Analysing the design…');
    setAnalyzeWarning('');
    try {
      const { designDna } = await srFetch('/api/ai-compositions/style-reference', {
        method: 'POST',
        body: JSON.stringify({ action: 'analyze', screenshots }),
      });
      return designDna;
    } catch (err) {
      // Analysis is best-effort: the screenshots alone still guide generation,
      // but tell the user the style profile could not be extracted.
      setAnalyzeWarning(`The design could not be analysed (${err.message}) — the screenshots will still guide the AI.`);
      return undefined;
    }
  };

  const capture = async () => {
    setError('');
    setBusy(true);
    setBusyLabel('Capturing screenshots…');
    try {
      const body = sourceType === 'page'
        ? { action: 'capture', sourceType: 'page', pageId }
        : { action: 'capture', sourceType: 'url', url: extUrl.trim() };
      const { screenshots, sourceUrl } = await srFetch('/api/ai-compositions/style-reference', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const designDna = await analyze(screenshots);
      onChange({
        sourceType,
        sourceUrl,
        screenshots,
        ...(designDna ? { designDna } : {}),
        influence: value?.influence || 'strong',
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  };

  const uploadFiles = async (files) => {
    setError('');
    // Raster only (matches the server-side allowlist — no SVG).
    const list = Array.from(files || [])
      .filter((f) => /^image\/(jpeg|jpg|png|gif|webp)$/i.test(f.type))
      .slice(0, MAX_SCREENSHOTS);
    if (!list.length) return;
    setBusy(true);
    setBusyLabel('Uploading screenshots…');
    try {
      const uploaded = [];
      for (const file of list) {
        const result = await uploadFileWithProgress(file, null, { type: 'style-reference', isPrivate: false });
        uploaded.push({ viewport: 'desktop', url: result.file_url });
      }
      const designDna = await analyze(uploaded);
      onChange({
        sourceType: 'upload',
        screenshots: uploaded,
        ...(designDna ? { designDna } : {}),
        influence: value?.influence || 'strong',
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  };

  const clear = () => {
    onChange(null);
    setPageId('');
    setPageQuery('');
    setExtUrl('');
    setError('');
    setAnalyzeWarning('');
  };

  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        disabled={disabled}
        data-testid={`button-${idPrefix}-toggle`}
      >
        <Palette className="mr-1 h-4 w-4" /> Style reference…
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-sm">Style reference</Label>
        <Button size="sm" variant="ghost" onClick={() => { clear(); setOpen(false); }} disabled={busy} data-testid={`button-${idPrefix}-close`}>
          Remove
        </Button>
      </div>

      {!value && (
        <>
          <Select value={sourceType} onValueChange={setSourceType} disabled={busy}>
            <SelectTrigger data-testid={`select-${idPrefix}-source`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="page">One of our published pages</SelectItem>
              <SelectItem value="url">A public website URL</SelectItem>
              <SelectItem value="upload">Upload screenshots</SelectItem>
            </SelectContent>
          </Select>

          {sourceType === 'page' && (
            <div className="space-y-1">
              <Input
                value={pageQuery}
                onChange={(e) => { setPageQuery(e.target.value); setPageId(''); }}
                placeholder="Search your pages…"
                disabled={busy}
                data-testid={`input-${idPrefix}-page-search`}
              />
              {pageResults.length > 0 && !pageId && (
                <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
                  {pageResults.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="block w-full rounded-sm px-2 py-1 text-left text-xs hover-elevate"
                      onClick={() => { setPageId(p.id); setPageQuery(p.title); }}
                      data-testid={`button-${idPrefix}-page-${p.id}`}
                    >
                      <span className="font-medium">{p.title}</span>
                      {p.detail && <span className="ml-1 text-muted-foreground">{p.detail}</span>}
                    </button>
                  ))}
                </div>
              )}
              <Button size="sm" onClick={capture} disabled={busy || !pageId} data-testid={`button-${idPrefix}-capture-page`}>
                {busy ? (<><Loader2 className="mr-1 h-4 w-4 animate-spin" /> {busyLabel}</>) : 'Use this page'}
              </Button>
            </div>
          )}

          {sourceType === 'url' && (
            <div className="space-y-1">
              <Input
                value={extUrl}
                onChange={(e) => setExtUrl(e.target.value)}
                placeholder="https://example.com"
                disabled={busy}
                data-testid={`input-${idPrefix}-url`}
              />
              <Button size="sm" onClick={capture} disabled={busy || !extUrl.trim()} data-testid={`button-${idPrefix}-capture-url`}>
                {busy ? (<><Loader2 className="mr-1 h-4 w-4 animate-spin" /> {busyLabel}</>) : 'Capture this site'}
              </Button>
            </div>
          )}

          {sourceType === 'upload' && (
            <div className="space-y-1">
              <label className="flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
                {busy
                  ? (<><Loader2 className="h-4 w-4 animate-spin" /> {busyLabel}</>)
                  : (<><Upload className="h-4 w-4" /> Choose up to {MAX_SCREENSHOTS} screenshots</>)}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  multiple
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
                  data-testid={`input-${idPrefix}-upload`}
                />
              </label>
            </div>
          )}
        </>
      )}

      {value && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {(value.screenshots || []).map((s) => (
              <img
                key={s.url}
                src={s.url}
                alt={`Reference (${s.viewport})`}
                className="h-14 w-auto rounded-sm border border-border object-cover object-top"
                data-testid={`img-${idPrefix}-shot-${s.viewport}`}
              />
            ))}
          </div>
          {value.sourceUrl && (
            <p className="truncate text-xs text-muted-foreground" data-testid={`text-${idPrefix}-source`}>{value.sourceUrl}</p>
          )}
          <DnaSummary designDna={value.designDna} />
          <div className="space-y-1">
            <Label className="text-xs">Influence</Label>
            <Select
              value={value.influence || 'strong'}
              onValueChange={(v) => onChange({ ...value, influence: v })}
              disabled={disabled}
            >
              <SelectTrigger data-testid={`select-${idPrefix}-influence`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light — subtle cues only</SelectItem>
                <SelectItem value="strong">Strong (recommended)</SelectItem>
                <SelectItem value="very_strong">Very strong — follow closely</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            Your branding, content and accessibility always take priority — the reference is inspiration only.
          </p>
          <Button size="sm" variant="outline" onClick={clear} disabled={busy || disabled} data-testid={`button-${idPrefix}-clear`}>
            <Trash2 className="mr-1 h-4 w-4" /> Use a different reference
          </Button>
        </div>
      )}

      {analyzeWarning && (
        <p className="text-xs text-warning" data-testid={`text-${idPrefix}-analyze-warning`}>{analyzeWarning}</p>
      )}
      {error && <p className="text-xs text-destructive" data-testid={`text-${idPrefix}-error`}>{error}</p>}
    </div>
  );
}
