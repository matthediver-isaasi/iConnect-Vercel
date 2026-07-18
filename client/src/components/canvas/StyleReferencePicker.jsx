// Style Reference picker for AI generation (Task #2873, upgraded to the
// structured Design DNA v2 pipeline in Task #2879).
//
// Lets an admin attach a visual style reference to an AI Composition / AI
// page generation: one of their own published pages, an external public URL
// (both captured server-side across desktop/tablet/mobile viewports with a
// computed-style extractor), or uploaded screenshots. The capture is
// analysed into a structured "Design DNA" profile shown for review before
// use, with a refresh option for cached analyses. The influence level
// (Light / Strong / Very Strong) weights how much the reference shapes the
// output — tenant branding and content always win.
//
// Value shape (null = no reference; generation stays exactly as before):
//   { sourceType: 'page'|'url'|'upload', sourceUrl?, analysisId?,
//     screenshots: [{viewport,label,url}], designDna?, influence }

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Palette, RefreshCw, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.details = body.details;
    throw err;
  }
  return body;
}

const post = (body) => srFetch('/api/ai-compositions/style-reference', {
  method: 'POST',
  body: JSON.stringify(body),
});

const isV2 = (dna) => !!dna && dna.schemaVersion === '2.0';

function Swatch({ colour }) {
  return (
    <span
      className="inline-block h-4 w-4 rounded-sm border border-border align-middle"
      style={{ backgroundColor: colour }}
      title={colour}
    />
  );
}

function DnaSummaryV2({ designDna }) {
  const [showDetail, setShowDetail] = useState(false);
  if (!isV2(designDna)) return null;
  const { summary, designTokens, componentRecipes, responsiveSystem, confidence } = designDna;
  const colours = (designTokens?.colours || []).slice(0, 8);
  const typo = (designTokens?.typography || []).slice(0, 5);
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2 text-xs" data-testid="text-styleref-dna">
      <p className="text-foreground">{summary?.designCharacter}</p>
      {(summary?.mostDistinctiveTraits || []).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {summary.mostDistinctiveTraits.slice(0, 6).map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
          ))}
        </div>
      )}
      {colours.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">Palette:</span>
          {colours.map((c) => <Swatch key={`${c.colour}-${c.role}`} colour={c.colour} />)}
        </div>
      )}
      {typeof confidence?.overall === 'number' && (
        <p className="text-muted-foreground" data-testid="text-styleref-confidence">
          Analysis confidence: {Math.round(confidence.overall * 100)}%
        </p>
      )}
      <button
        type="button"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        onClick={() => setShowDetail((v) => !v)}
        data-testid="button-styleref-dna-detail"
      >
        {showDetail ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {showDetail ? 'Hide details' : 'Show details'}
      </button>
      {showDetail && (
        <div className="space-y-2 border-t border-border pt-2">
          {typo.length > 0 && (
            <div>
              <p className="font-medium text-foreground">Typography</p>
              {typo.map((t, i) => (
                <p key={i} className="text-muted-foreground">
                  {t.role}: {t.fontFamily || '—'} {t.fontSizePx ? `${t.fontSizePx}px` : ''} {t.fontWeight ? `w${t.fontWeight}` : ''}
                </p>
              ))}
            </div>
          )}
          {(componentRecipes || []).length > 0 && (
            <div>
              <p className="font-medium text-foreground">Recognised components</p>
              {componentRecipes.slice(0, 4).map((r) => (
                <p key={r.name} className="text-muted-foreground">
                  {r.name.replace(/_/g, ' ')} ×{r.occurrences}{r.surface ? ` — ${r.surface}` : ''}
                </p>
              ))}
            </div>
          )}
          {responsiveSystem?.mobile && (
            <div>
              <p className="font-medium text-foreground">On mobile</p>
              <p className="text-muted-foreground">{responsiveSystem.mobile}</p>
            </div>
          )}
          {(confidence?.limitations || []).length > 0 && (
            <div>
              <p className="font-medium text-foreground">Limitations</p>
              {confidence.limitations.slice(0, 3).map((l) => (
                <p key={l} className="text-muted-foreground">{l}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Legacy v1 free-text profile display (older saved references).
function DnaSummaryV1({ designDna }) {
  const rows = [
    ['Composition', designDna?.composition],
    ['Layout rhythm', designDna?.layoutRhythm],
    ['Typography', designDna?.typography],
    ['Imagery', designDna?.imageryStyle],
    ['Spacing', designDna?.spacingSystem],
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
  const [errorDetails, setErrorDetails] = useState([]);
  const [analyzeWarning, setAnalyzeWarning] = useState('');
  const [wasCached, setWasCached] = useState(false);

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

  const applyAnalysis = (analysis, srcType) => {
    const crops = (analysis.generationCrops || []).length
      ? analysis.generationCrops
      : (analysis.screenshots || []).slice(0, MAX_SCREENSHOTS);
    onChange({
      sourceType: srcType,
      ...(analysis.sourceUrl ? { sourceUrl: analysis.sourceUrl } : {}),
      analysisId: analysis.id,
      screenshots: crops.map((s) => ({ viewport: s.viewport, label: s.label, url: s.url })),
      ...(analysis.designDna ? { designDna: analysis.designDna } : {}),
      influence: value?.influence || 'strong',
    });
  };

  // Staged capture: start → capture each viewport → analyze.
  const capture = async ({ refresh = false } = {}) => {
    setError('');
    setErrorDetails([]);
    setAnalyzeWarning('');
    setWasCached(false);
    setBusy(true);
    try {
      setBusyLabel('Checking the reference…');
      const startBody = sourceType === 'page'
        ? { action: 'start', sourceType: 'page', pageId, refresh }
        : { action: 'start', sourceType: 'url', url: (value?.sourceUrl || extUrl).trim(), refresh };
      const started = await post(startBody);
      if (started.cached && started.analysis) {
        setWasCached(true);
        applyAnalysis(started.analysis, sourceType);
        return;
      }
      const { analysisId, viewports } = started;
      const labels = { desktop: 'desktop', tablet: 'tablet', mobile: 'mobile' };
      for (const vp of viewports || []) {
        setBusyLabel(`Capturing the ${labels[vp] || vp} view…`);
        const result = await post({ action: 'capture', analysisId, viewport: vp });
        if (result.ok === false && result.warning) {
          setAnalyzeWarning(`The ${vp} view could not be captured — continuing without it.`);
        }
      }
      setBusyLabel('Analysing the design…');
      const { analysis } = await post({ action: 'analyze', analysisId });
      applyAnalysis(analysis, sourceType);
    } catch (err) {
      setError(err.message);
      if (Array.isArray(err.details)) setErrorDetails(err.details);
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  };

  const refreshAnalysis = () => capture({ refresh: true });

  const uploadFiles = async (files) => {
    setError('');
    setErrorDetails([]);
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
      setBusyLabel('Analysing the design…');
      let analysis = null;
      try {
        ({ analysis } = await post({ action: 'analyze', screenshots: uploaded }));
      } catch (err) {
        // Analysis is best-effort on uploads: screenshots alone still guide
        // generation, but tell the user the style profile was rejected.
        setAnalyzeWarning(`${err.message} The screenshots will still guide the AI.`);
        if (Array.isArray(err.details)) setErrorDetails(err.details);
      }
      if (analysis) {
        applyAnalysis(analysis, 'upload');
      } else {
        onChange({
          sourceType: 'upload',
          screenshots: uploaded,
          influence: value?.influence || 'strong',
        });
      }
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
    setErrorDetails([]);
    setAnalyzeWarning('');
    setWasCached(false);
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
              <Button size="sm" onClick={() => capture()} disabled={busy || !pageId} data-testid={`button-${idPrefix}-capture-page`}>
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
              <Button size="sm" onClick={() => capture()} disabled={busy || !extUrl.trim()} data-testid={`button-${idPrefix}-capture-url`}>
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
                alt={`Reference (${s.label || s.viewport})`}
                className="h-14 w-auto rounded-sm border border-border object-cover object-top"
                data-testid={`img-${idPrefix}-shot-${s.label || s.viewport}`}
              />
            ))}
          </div>
          {value.sourceUrl && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid={`text-${idPrefix}-source`}>{value.sourceUrl}</p>
              {wasCached && <Badge variant="secondary" className="text-[10px]">Saved analysis</Badge>}
              {value.analysisId && (value.sourceType === 'url' || value.sourceType === 'page') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={refreshAnalysis}
                  disabled={busy || disabled}
                  data-testid={`button-${idPrefix}-refresh`}
                >
                  {busy
                    ? (<><Loader2 className="mr-1 h-3 w-3 animate-spin" /> {busyLabel}</>)
                    : (<><RefreshCw className="mr-1 h-3 w-3" /> Re-analyse</>)}
                </Button>
              )}
            </div>
          )}
          {isV2(value.designDna)
            ? <DnaSummaryV2 designDna={value.designDna} />
            : <DnaSummaryV1 designDna={value.designDna} />}
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
      {error && (
        <div className="space-y-1">
          <p className="text-xs text-destructive" data-testid={`text-${idPrefix}-error`}>{error}</p>
          {errorDetails.length > 0 && (
            <ul className="list-disc pl-4 text-[11px] text-muted-foreground">
              {errorDetails.slice(0, 4).map((d) => <li key={d}>{d}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
