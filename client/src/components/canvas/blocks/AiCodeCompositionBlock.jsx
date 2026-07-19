// AI Design Studio V2 — `ai-code-composition` canvas block (Task #2904, Phase 0).
//
// Renders a V2 code package (renderer_version 2, document schemaVersion
// "2.0"): the server-sanitised, CSS-scoped HTML is injected verbatim inside a
// [data-ai-composition="<compositionId>"] wrapper together with its scoped
// <style>. The client NEVER re-processes the markup — sanitisation and CSS
// scoping happened once, server-side (api/_lib/aiCodePipeline.js), before the
// immutable version was stored.
//
// Phase 1 inspector (Task #2905): generate a single V2 section from a brief
// via the staged /api/ai-compositions/generate-v2 endpoint (context → code),
// preview it at desktop/tablet/mobile widths, then Insert / Regenerate /
// Discard. Attaching an existing V2 composition by id remains available as a
// fallback (the BNMS proof fixture is seeded by
// scripts/seed-bnms-scan-fixture.mjs).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Code2, Loader2, RotateCcw, ShieldCheck, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import StyleReferencePicker from '../StyleReferencePicker';
import { useReportReflowHeight } from '../AccordionReflowContext';
import { getTenantSlugFromLocation } from '@/api/publicClient';

async function aicFetch(path, options = {}) {
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
    err.status = res.status;
    throw err;
  }
  return body;
}

export function useAiCodeComposition(compositionId) {
  return useQuery({
    queryKey: ['/api/ai-compositions', compositionId],
    queryFn: () => aicFetch(`/api/ai-compositions/${compositionId}`),
    enabled: !!compositionId,
    staleTime: 30 * 1000,
  });
}

function isV2Document(doc) {
  return !!doc && doc.schemaVersion === '2.0' && typeof doc.html === 'string';
}

/**
 * Pure V2 renderer: scoped <style> + sanitised HTML inside the scope wrapper.
 * Also used by the signed server preview page (same wrapper contract).
 */
export function AiCodeCompositionContent({ document: doc }) {
  const compositionId = doc?.compositionId || '';
  const markup = useMemo(() => ({ __html: doc?.html || '' }), [doc?.html]);
  if (!isV2Document(doc) || !compositionId) return null;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: doc.css || '' }} />
      {/* eslint-disable-next-line react/no-danger -- server-sanitised, immutable document */}
      <div data-ai-composition={compositionId} dangerouslySetInnerHTML={markup} />
    </>
  );
}

export function AiCodeCompositionRender({ block, asEditor }) {
  const compositionId = block.content?.compositionId || '';
  const { data, isLoading, error } = useAiCodeComposition(compositionId);
  const reflowRef = useReportReflowHeight(block.id);

  if (!compositionId) {
    if (!asEditor) return null;
    return (
      <div
        ref={reflowRef}
        className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/40 p-8 text-center"
        data-testid={`placeholder-aicc-${block.id}`}
      >
        <Code2 className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          AI Composition (V2) — attach a generated design in the inspector.
        </p>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div ref={reflowRef} className="flex items-center justify-center p-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const doc = data?.document;
  if (error || !isV2Document(doc)) {
    if (!asEditor) return null;
    return (
      <div ref={reflowRef} className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid={`error-aicc-${block.id}`}>
        {doc && !isV2Document(doc)
          ? 'This composition is not a V2 code package.'
          : 'This AI Composition could not be loaded.'}
      </div>
    );
  }
  return (
    <div ref={reflowRef} data-testid={`aicc-${block.id}`}>
      <AiCodeCompositionContent document={doc} />
    </div>
  );
}

function SanitisationReport({ report }) {
  if (!report) return null;
  const removed = report.htmlRemoved || [];
  const cssHard = (report.cssRejections || []).filter((r) => !r.warning);
  const cssWarn = (report.cssRejections || []).filter((r) => r.warning);
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium">
        <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Safety report</span>
      </div>
      <p className="text-muted-foreground" data-testid="text-aicc-report-summary">
        {report.aiIds?.length || 0} identified elements · {report.actionKeys?.length || 0} actions ·{' '}
        {report.slotKeys?.length || 0} slots · {removed.length} removed by sanitiser ·{' '}
        {cssHard.length} CSS rules blocked{cssWarn.length ? ` · ${cssWarn.length} notes` : ''}
      </p>
      {(removed.length > 0 || cssHard.length > 0) && (
        <ul className="max-h-32 space-y-1 overflow-y-auto text-muted-foreground">
          {removed.slice(0, 20).map((r, i) => (
            <li key={`h${i}`} className="flex items-start gap-1">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              <span>HTML {r.kind}: {r.detail}</span>
            </li>
          ))}
          {cssHard.slice(0, 20).map((r, i) => (
            <li key={`c${i}`} className="flex items-start gap-1">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              <span>CSS {r.kind}: {r.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Staged generation loop for /api/ai-compositions/generate-v2: keeps POSTing
// { jobId } while the server reports `running` (context → code, one LLM
// attempt per invocation, retries included).
function useCodeGenerationLoop({ onComplete }) {
  const [running, setRunning] = useState(false);
  const [label, setLabel] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [rejectionReasons, setRejectionReasons] = useState([]);
  const cancelledRef = useRef(false);

  useEffect(() => () => { cancelledRef.current = true; }, []);

  const start = async (startBody) => {
    setRunning(true);
    setError(null);
    setRejectionReasons([]);
    setLabel('Starting…');
    setProgress(0.05);
    cancelledRef.current = false;
    try {
      let resp = await aicFetch('/api/ai-compositions/generate-v2', {
        method: 'POST',
        body: JSON.stringify(startBody),
      });
      let guard = 0;
      // context + code with up to MAX_CODE_RETRIES refinement rounds.
      while (!cancelledRef.current && resp.status === 'running' && guard < 12) {
        guard += 1;
        let stepLabel = resp.label || 'Generating…';
        if (resp.progress?.attempt) {
          stepLabel += ` (attempt ${resp.progress.attempt + 1} of ${resp.progress.maxAttempts || 3})`;
        }
        setLabel(stepLabel);
        setProgress(Math.min(0.9, resp.stage === 'code' ? 0.45 + guard * 0.1 : 0.2));
        resp = await aicFetch('/api/ai-compositions/generate-v2', {
          method: 'POST',
          body: JSON.stringify({ jobId: resp.jobId }),
        });
      }
      if (cancelledRef.current) return;
      if (resp.status === 'complete' && resp.compositionId) {
        setProgress(1);
        setLabel('Done');
        onComplete(resp.compositionId);
      } else {
        setError(resp.error || 'Generation failed. Nothing was changed — please try again.');
        setRejectionReasons(Array.isArray(resp.rejectionReasons) ? resp.rejectionReasons : []);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err.message || 'Generation failed');
      }
    } finally {
      if (!cancelledRef.current) setRunning(false);
    }
  };

  return { start, running, label, progress, error, rejectionReasons };
}

const PREVIEW_WIDTHS = { desktop: 1440, tablet: 1024, mobile: 390 };

function BreakpointPreview({ compositionId }) {
  const [bp, setBp] = useState('desktop');
  const { data } = useAiCodeComposition(compositionId);
  const doc = data?.document;
  // The document's @media rules evaluate against the VIEWPORT, so a scaled
  // div cannot preview breakpoints — render inside an iframe whose window is
  // the target width, then scale the iframe down to the inspector column.
  const srcDoc = useMemo(() => {
    if (!isV2Document(doc)) return '';
    return [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<style>html,body{margin:0;padding:0;}${doc.css || ''}</style>`,
      '</head><body>',
      `<div data-ai-composition="${doc.compositionId}">${doc.html || ''}</div>`,
      '</body></html>',
    ].join('');
  }, [doc]);
  if (!isV2Document(doc)) return null;
  const boxW = 260; // inspector column width budget
  const boxH = 320;
  const scale = boxW / PREVIEW_WIDTHS[bp];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {Object.keys(PREVIEW_WIDTHS).map((b) => (
          <Button
            key={b}
            size="sm"
            variant={bp === b ? 'secondary' : 'ghost'}
            onClick={() => setBp(b)}
            data-testid={`button-aicc-preview-${b}`}
          >
            {b.charAt(0).toUpperCase() + b.slice(1)}
          </Button>
        ))}
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-background" style={{ height: boxH }}>
        <iframe
          title="AI section preview"
          sandbox=""
          srcDoc={srcDoc}
          style={{
            width: PREVIEW_WIDTHS[bp],
            height: boxH / scale,
            border: 0,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            pointerEvents: 'none',
          }}
          data-testid="iframe-aicc-preview"
        />
      </div>
    </div>
  );
}

export function AiCodeCompositionInspector({ block, update, onChange, pageId }) {
  const queryClient = useQueryClient();
  const insertedId = block.content?.compositionId || '';
  const [draftId, setDraftId] = useState('');
  const [brief, setBrief] = useState('');
  const [direction, setDirection] = useState('');
  const [creativity, setCreativity] = useState('brand_led');
  const [styleReference, setStyleReference] = useState(null);
  const [busy, setBusy] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [pendingId, setPendingId] = useState('');

  const setCompositionId = (id) => {
    // CanvasInspector passes `update` (an updater-fn setter); older call
    // sites passed `onChange` with the whole block — support both.
    if (typeof update === 'function') {
      update((b) => ({ ...b, content: { ...b.content, compositionId: id } }));
    } else if (typeof onChange === 'function') {
      onChange({ ...block, content: { ...block.content, compositionId: id } });
    }
  };

  const gen = useCodeGenerationLoop({
    onComplete: (compositionId) => {
      // Regenerating the inserted composition adds a version to it — it must
      // NOT re-enter draft mode (draft mode exposes Discard, which deletes).
      setDraftId(compositionId === insertedId ? '' : compositionId);
      queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId] });
      queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId, 'versions'] });
    },
  });

  const activeId = draftId || insertedId;
  const { data, isLoading, error } = useAiCodeComposition(activeId);
  const doc = data?.document;

  const generate = () => {
    if (!brief.trim() || gen.running) return;
    gen.start({
      pageId: pageId || undefined,
      brief,
      direction: direction || undefined,
      creativity,
      ...(styleReference ? { styleReference } : {}),
      // Regenerating an inserted composition adds a version to it; a pending
      // draft is regenerated in place too.
      compositionId: activeId || undefined,
    });
  };

  const insert = () => {
    if (!draftId) return;
    setCompositionId(draftId);
    setDraftId('');
  };

  const discard = async () => {
    // Never delete the composition the block is actually using.
    if (!draftId || draftId === insertedId) return;
    setBusy(true);
    try {
      await aicFetch(`/api/ai-compositions/${draftId}`, { method: 'DELETE' });
      setDraftId('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={`aicc-brief-${block.id}`}>Describe the section you want</Label>
        <Textarea
          id={`aicc-brief-${block.id}`}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="e.g. A section promoting our annual conference with three highlights and a sign-up call to action"
          rows={4}
          data-testid="input-aicc-brief"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`aicc-direction-${block.id}`}>Visual direction (optional)</Label>
        <Input
          id={`aicc-direction-${block.id}`}
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          placeholder="e.g. bold, dark, geometric"
          data-testid="input-aicc-direction"
        />
      </div>
      <div className="space-y-1">
        <Label>Creativity</Label>
        <Select value={creativity} onValueChange={setCreativity}>
          <SelectTrigger data-testid="select-aicc-creativity"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="strict">Stay close to our brand</SelectItem>
            <SelectItem value="brand_led">Brand-led (recommended)</SelectItem>
            <SelectItem value="expressive">Expressive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <StyleReferencePicker
        value={styleReference}
        onChange={setStyleReference}
        idPrefix={`aicc-styleref-${block.id}`}
        disabled={gen.running}
      />

      <Button
        onClick={generate}
        disabled={gen.running || !brief.trim()}
        data-testid="button-aicc-generate"
      >
        {gen.running
          ? (<><Loader2 className="mr-1 h-4 w-4 animate-spin" /> {gen.label}</>)
          : (<><Sparkles className="mr-1 h-4 w-4" /> {activeId ? 'Regenerate' : 'Generate section'}</>)}
      </Button>
      {gen.running && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(gen.progress * 100)}%` }} />
        </div>
      )}
      {gen.error && (
        <div className="space-y-1">
          <p className="text-xs text-destructive" data-testid="text-aicc-gen-error">{gen.error}</p>
          {gen.rejectionReasons.length > 0 && (
            <ul className="max-h-24 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
              {gen.rejectionReasons.slice(0, 6).map((r, i) => <li key={i}>· {r}</li>)}
            </ul>
          )}
        </div>
      )}

      {activeId && <BreakpointPreview compositionId={activeId} />}

      {draftId && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={insert} data-testid="button-aicc-insert">
            <Check className="mr-1 h-4 w-4" /> Insert
          </Button>
          <Button size="sm" variant="outline" onClick={generate} disabled={gen.running} data-testid="button-aicc-regenerate">
            <RotateCcw className="mr-1 h-4 w-4" /> Regenerate
          </Button>
          <Button size="sm" variant="ghost" onClick={discard} disabled={busy || gen.running} data-testid="button-aicc-discard">
            <Trash2 className="mr-1 h-4 w-4" /> Discard
          </Button>
        </div>
      )}

      {activeId && isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}
      {activeId && error && (
        <p className="text-sm text-destructive" data-testid="text-aicc-error">
          Could not load this composition.
        </p>
      )}
      {activeId && doc && !isV2Document(doc) && (
        <p className="text-sm text-destructive">
          This composition is a legacy (V1) document — it cannot be used in this block.
        </p>
      )}
      {isV2Document(doc) && (
        <div className="space-y-2">
          <p className="text-sm">
            <span className="font-medium" data-testid="text-aicc-title">{doc.title || 'Untitled'}</span>{' '}
            <span className="text-muted-foreground">· schema {doc.schemaVersion} · renderer v2</span>
          </p>
          <SanitisationReport report={doc.sanitisation} />
        </div>
      )}

      <div className="space-y-2 border-t border-border pt-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAttachOpen((v) => !v)}
          data-testid="button-aicc-attach-toggle"
        >
          {attachOpen ? 'Hide advanced' : 'Advanced: attach by ID…'}
        </Button>
        {attachOpen && (
          <div className="space-y-2">
            <Label htmlFor={`aicc-id-${block.id}`}>Composition ID</Label>
            <Input
              id={`aicc-id-${block.id}`}
              value={pendingId}
              onChange={(e) => setPendingId(e.target.value)}
              placeholder="Paste a V2 composition id"
              data-testid="input-aicc-composition-id"
            />
            <Button
              size="sm"
              onClick={() => { setCompositionId(pendingId.trim()); setDraftId(''); }}
              disabled={!pendingId.trim() || pendingId.trim() === insertedId}
              data-testid="button-aicc-attach"
            >
              Attach
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
