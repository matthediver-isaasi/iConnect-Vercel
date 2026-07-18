// AI Composition canvas block — Render + Inspector (Task #2849).
//
// The Render fetches the composition's CURRENT document (public endpoint —
// published pages render for guests) and mounts AiCompositionRenderer, wired
// into the parent canvas's auto-height reflow via useReportReflowHeight so
// the composition's real rendered height drives layout at every breakpoint.
//
// The Inspector is the Phase 1 creation panel: brief + mode + direction +
// creativity, a staged progress loop against /api/ai-compositions/generate,
// a preview at three breakpoints, Insert / Regenerate / Discard for drafts,
// and version history with restore once inserted. Draft compositions are
// held in local state (draftId) and only committed to the block's content on
// Insert; Discard deletes the draft server-side and never touches the page.

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Loader2, RotateCcw, Trash2, Check, History } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import AiCompositionRenderer from '../AiCompositionRenderer';
import AiCompositionEditPanel from './AiCompositionEditPanel';
import { resolveDraftAfterGeneration, isDiscardableDraft } from '@/lib/aiCompositionRender';
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
    err.body = body;
    throw err;
  }
  return body;
}

export function useAiComposition(compositionId) {
  return useQuery({
    queryKey: ['/api/ai-compositions', compositionId],
    queryFn: () => aicFetch(`/api/ai-compositions/${compositionId}`),
    enabled: !!compositionId,
    staleTime: 30 * 1000,
  });
}

export function AiCompositionRender({ block, asEditor }) {
  const compositionId = block.content?.compositionId || '';
  const { data, isLoading, error } = useAiComposition(compositionId);
  const reflowRef = useReportReflowHeight(block.id);

  if (!compositionId) {
    if (!asEditor) return null;
    return (
      <div
        ref={reflowRef}
        className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/40 p-8 text-center"
        data-testid={`placeholder-aic-${block.id}`}
      >
        <Sparkles className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          AI Composition — describe what you want in the inspector and generate a design.
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
  if (error || !data?.document) {
    if (!asEditor) return null;
    return (
      <div ref={reflowRef} className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        This AI Composition could not be loaded.
      </div>
    );
  }
  return (
    <div ref={reflowRef}>
      <AiCompositionRenderer document={data.document} instanceId={block.id} />
    </div>
  );
}

const STAGE_SEQUENCE = ['context', 'plan', 'copy', 'document'];

function useGenerationLoop({ onComplete }) {
  const [running, setRunning] = useState(false);
  const [label, setLabel] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const cancelledRef = useRef(false);

  useEffect(() => () => { cancelledRef.current = true; }, []);

  const start = async (startBody) => {
    setRunning(true);
    setError(null);
    setLabel('Starting…');
    setProgress(0.05);
    cancelledRef.current = false;
    try {
      let resp = await aicFetch('/api/ai-compositions/generate', {
        method: 'POST',
        body: JSON.stringify(startBody),
      });
      // Drive the staged job until complete/failed. Each POST advances one stage.
      let guard = 0;
      while (!cancelledRef.current && resp.status === 'running' && guard < 12) {
        guard += 1;
        const idx = STAGE_SEQUENCE.indexOf(resp.stage);
        setProgress(Math.min(0.9, 0.15 + (idx >= 0 ? idx : 0) * 0.25));
        setLabel(resp.label || 'Generating…');
        resp = await aicFetch('/api/ai-compositions/generate', {
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
      }
    } catch (err) {
      if (!cancelledRef.current) setError(err.message || 'Generation failed');
    } finally {
      if (!cancelledRef.current) setRunning(false);
    }
  };

  return { start, running, label, progress, error, setError };
}

function BreakpointPreview({ compositionId }) {
  const [bp, setBp] = useState('desktop');
  const { data } = useAiComposition(compositionId);
  if (!data?.document) return null;
  const widths = { desktop: 1200, tablet: 820, mobile: 390 };
  const boxW = 260; // inspector column width budget
  const scale = boxW / widths[bp];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {['desktop', 'tablet', 'mobile'].map((b) => (
          <Button
            key={b}
            size="sm"
            variant={bp === b ? 'secondary' : 'ghost'}
            onClick={() => setBp(b)}
            data-testid={`button-aic-preview-${b}`}
          >
            {b.charAt(0).toUpperCase() + b.slice(1)}
          </Button>
        ))}
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-background" style={{ height: 320 }}>
        <div
          style={{
            width: widths[bp],
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          <AiCompositionRenderer
            document={data.document}
            instanceId={`preview-${compositionId}`}
            forceBreakpoint={bp === 'desktop' ? null : bp}
          />
        </div>
      </div>
    </div>
  );
}

function VersionHistory({ compositionId }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const { data, refetch } = useQuery({
    queryKey: ['/api/ai-compositions', compositionId, 'versions'],
    queryFn: () => aicFetch(`/api/ai-compositions/${compositionId}?versions=1`),
    enabled: !!compositionId && open,
  });
  const restore = async (versionId) => {
    setBusyId(versionId);
    try {
      await aicFetch(`/api/ai-compositions/${compositionId}?restore=1`, {
        method: 'POST',
        body: JSON.stringify({ versionId }),
      });
      await queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId] });
      await refetch();
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div className="space-y-2">
      <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} data-testid="button-aic-versions">
        <History className="mr-1 h-4 w-4" /> Version history
      </Button>
      {open && (
        <div className="space-y-1">
          {(data?.versions || []).map((v) => {
            const isCurrent = v.id === data?.currentVersionId;
            return (
              <div key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-xs">
                <div className="min-w-0">
                  <div className="truncate font-medium" data-testid={`text-aic-version-${v.id}`}>
                    {v.change_summary || v.operation_type}
                  </div>
                  <div className="text-muted-foreground">
                    {new Date(v.created_at).toLocaleString()}{isCurrent ? ' · current' : ''}
                  </div>
                </div>
                {!isCurrent && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === v.id}
                    onClick={() => restore(v.id)}
                    data-testid={`button-aic-restore-${v.id}`}
                  >
                    {busyId === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Restore'}
                  </Button>
                )}
              </div>
            );
          })}
          {open && data && (data.versions || []).length === 0 && (
            <p className="text-xs text-muted-foreground">No versions yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function AiCompositionInspector({ block, update, pageId }) {
  const queryClient = useQueryClient();
  const insertedId = block.content?.compositionId || '';
  const [draftId, setDraftId] = useState('');
  const [brief, setBrief] = useState('');
  const [mode, setMode] = useState('auto');
  const [direction, setDirection] = useState('');
  const [creativity, setCreativity] = useState('brand_led');
  const [busy, setBusy] = useState(false);

  const gen = useGenerationLoop({
    onComplete: (compositionId) => {
      // Regenerating the inserted composition adds a version to it — it must
      // NOT re-enter draft mode (draft mode exposes Discard, which deletes).
      setDraftId(resolveDraftAfterGeneration(insertedId, compositionId));
      queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId] });
      queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId, 'versions'] });
    },
  });

  const activeId = draftId || insertedId;

  const generate = () => {
    if (!brief.trim() || gen.running) return;
    gen.start({
      pageId: pageId || undefined,
      brief,
      mode: mode === 'auto' ? undefined : mode,
      direction: direction || undefined,
      creativity,
      // Regenerating an inserted composition adds a version to it; a pending
      // draft is regenerated in place too.
      compositionId: activeId || undefined,
    });
  };

  const insert = () => {
    if (!draftId) return;
    update((b) => ({ ...b, content: { ...b.content, compositionId: draftId } }));
    setDraftId('');
  };

  const discard = async () => {
    // Never delete the composition the block is actually using.
    if (!isDiscardableDraft(draftId, insertedId)) return;
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
        <Label htmlFor={`aic-brief-${block.id}`}>Describe what you want</Label>
        <Textarea
          id={`aic-brief-${block.id}`}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="e.g. A section promoting our annual conference with three highlights and a sign-up call to action"
          rows={4}
          data-testid="input-aic-brief"
        />
      </div>
      <div className="space-y-1">
        <Label>Scope</Label>
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger data-testid="select-aic-mode"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Automatic (based on the page)</SelectItem>
            <SelectItem value="section">Single section</SelectItem>
            <SelectItem value="whole_page">Whole page</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`aic-direction-${block.id}`}>Visual direction (optional)</Label>
        <Input
          id={`aic-direction-${block.id}`}
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          placeholder="e.g. bold, dark, geometric"
          data-testid="input-aic-direction"
        />
      </div>
      <div className="space-y-1">
        <Label>Creativity</Label>
        <Select value={creativity} onValueChange={setCreativity}>
          <SelectTrigger data-testid="select-aic-creativity"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="strict">Stay close to our brand</SelectItem>
            <SelectItem value="brand_led">Brand-led (recommended)</SelectItem>
            <SelectItem value="expressive">Expressive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button
        onClick={generate}
        disabled={gen.running || !brief.trim()}
        data-testid="button-aic-generate"
      >
        {gen.running
          ? (<><Loader2 className="mr-1 h-4 w-4 animate-spin" /> {gen.label}</>)
          : (<><Sparkles className="mr-1 h-4 w-4" /> {activeId ? 'Regenerate' : 'Generate design'}</>)}
      </Button>
      {gen.running && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(gen.progress * 100)}%` }} />
        </div>
      )}
      {gen.error && (
        <p className="text-xs text-destructive" data-testid="text-aic-error">{gen.error}</p>
      )}

      {activeId && <BreakpointPreview compositionId={activeId} />}

      {draftId && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={insert} data-testid="button-aic-insert">
            <Check className="mr-1 h-4 w-4" /> Insert
          </Button>
          <Button size="sm" variant="outline" onClick={generate} disabled={gen.running} data-testid="button-aic-regenerate">
            <RotateCcw className="mr-1 h-4 w-4" /> Regenerate
          </Button>
          <Button size="sm" variant="outline" onClick={discard} disabled={busy} data-testid="button-aic-discard">
            <Trash2 className="mr-1 h-4 w-4" /> Discard
          </Button>
        </div>
      )}

      {insertedId && !draftId && <VersionHistory compositionId={insertedId} />}
      {insertedId && !draftId && <AiCompositionEditPanel compositionId={insertedId} />}
    </div>
  );
}
