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
import { Sparkles, Loader2, RotateCcw, Trash2, Check, History, Wand2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import AiCompositionRenderer from '../AiCompositionRenderer';
import { useCodeGenerationLoop } from './AiCodeCompositionBlock';
import AiCompositionEditPanel from './AiCompositionEditPanel';
import { resolveDraftAfterGeneration, isDiscardableDraft } from '@/lib/aiCompositionRender';
import { AdvancedBriefFields, PlanReviewPanel, EMPTY_ADVANCED_BRIEF, advancedBriefToBody } from '../AiPageBrief';
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

const STAGE_SEQUENCE = ['context', 'plan', 'copy', 'document', 'assets', 'review'];

export function useGenerationLoop({ onComplete, onSeo }) {
  const [running, setRunning] = useState(false);
  const [label, setLabel] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  // Phase 5: when the server pauses in `awaiting_plan`, the plan + jobId are
  // surfaced so the caller can show the editable plan-review panel.
  const [pendingPlan, setPendingPlan] = useState(null);
  const cancelledRef = useRef(false);

  useEffect(() => () => { cancelledRef.current = true; }, []);

  const drive = async (initialResp) => {
    let resp = initialResp;
    let guard = 0;
    // Generous guard: the server chunks the document (retry per invocation)
    // and assets (a few images per invocation) stages, so a long run can
    // legitimately take many round-trips.
    while (!cancelledRef.current && resp.status === 'running' && guard < 40) {
      guard += 1;
      const idx = STAGE_SEQUENCE.indexOf(resp.stage);
      setProgress(Math.min(0.9, 0.15 + (idx >= 0 ? idx : 0) * 0.19));
      let label = resp.label || 'Generating…';
      // Optional server progress detail: document attempt N or image K of N.
      if (resp.progress?.attempt) {
        label += ` (attempt ${resp.progress.attempt} of ${resp.progress.maxAttempts || 3})`;
      } else if (resp.progress?.imagesTotal) {
        label += ` (image ${Math.min(resp.progress.imagesDone + 1, resp.progress.imagesTotal)} of ${resp.progress.imagesTotal})`;
      }
      setLabel(label);
      resp = await aicFetch('/api/ai-compositions/generate', {
        method: 'POST',
        body: JSON.stringify({ jobId: resp.jobId }),
      });
    }
    if (cancelledRef.current) return;
    if (resp.status === 'awaiting_plan') {
      // Pause: hand the plan back for review; resumePlan continues the job.
      setPendingPlan({ jobId: resp.jobId, plan: resp.plan });
      setRunning(false);
      setLabel('');
      return;
    }
    if (resp.status === 'complete' && resp.compositionId) {
      setProgress(1);
      setLabel('Done');
      if (resp.seo && onSeo) onSeo(resp.seo);
      onComplete(resp.compositionId, resp.screenshotReview || null);
    } else {
      setError(resp.error || 'Generation failed. Nothing was changed — please try again.');
    }
    setRunning(false);
  };

  const run = async (fn) => {
    setRunning(true);
    setError(null);
    setLabel('Starting…');
    setProgress(0.05);
    setPendingPlan(null);
    cancelledRef.current = false;
    try {
      await drive(await fn());
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err.message || 'Generation failed');
        setRunning(false);
      }
    }
  };

  const start = (startBody) => run(() => aicFetch('/api/ai-compositions/generate', {
    method: 'POST',
    body: JSON.stringify(startBody),
  }));

  // Approve (optionally edited) plan for a paused job.
  const resumePlan = (jobId, plan) => run(() => aicFetch('/api/ai-compositions/generate', {
    method: 'POST',
    body: JSON.stringify({ jobId, approvePlan: true, ...(plan ? { plan } : {}) }),
  }));

  const cancelPlan = () => setPendingPlan(null);

  return { start, resumePlan, cancelPlan, pendingPlan, running, label, progress, error, setError };
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

/**
 * Expandable per-version generation-evidence panel (Task #2890): shows what
 * reference evidence (screenshots + Design DNA) actually reached the model.
 * Fetches the full version row only when expanded.
 */
function VersionEvidence({ compositionId, versionId }) {
  const { data } = useQuery({
    queryKey: ['/api/ai-compositions', compositionId, 'version', versionId],
    queryFn: () => aicFetch(`/api/ai-compositions/${compositionId}?versionId=${versionId}`),
    enabled: !!compositionId && !!versionId,
  });
  const meta = data?.version?.generation_metadata;
  if (!data) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const ref = meta?.reference;
  // Capture-stage screenshots (with URLs for thumbnails) live on the stored
  // styleReference; the generation-stage subset is identified by label.
  const captured = Array.isArray(meta?.styleReference?.screenshots) ? meta.styleReference.screenshots : [];
  const sentLabels = new Set(ref?.referenceScreenshotLabels || []);
  const thumbs = (shots) => (
    <div className="flex flex-wrap gap-1">
      {shots.map((s, i) => (
        <figure key={s.url || i} className="w-16">
          <img src={s.url} alt={s.label || `screenshot ${i + 1}`} className="h-10 w-16 rounded-md border border-border object-cover object-top" loading="lazy" />
          <figcaption className="truncate text-[10px] text-muted-foreground">{s.label || s.viewport || `#${i + 1}`}</figcaption>
        </figure>
      ))}
    </div>
  );
  return (
    <div className="space-y-2 text-xs text-muted-foreground" data-testid={`text-aic-evidence-${versionId}`}>
      {meta?.model && <div>Model: {meta.model}{meta.compositionSchemaVersion ? ` · schema v${meta.compositionSchemaVersion}` : ''}</div>}
      {!ref && <div>No style reference was used for this version.</div>}
      {ref && (
        <>
          <div>
            Reference analysis: {ref.referenceAnalysisId ? `${ref.referenceAnalysisId.slice(0, 8)}…` : 'not recorded'}
            {' · '}{ref.referenceInfluenceLevel || 'strong'} influence
            {ref.designDnaIncluded ? ` · Design DNA ${ref.designDnaSchemaVersion || ''}` : ' · no Design DNA'}
          </div>
          <div>
            <div className="font-medium">1. Captured screenshots ({ref.captureScreenshotCount ?? captured.length})</div>
            {captured.length > 0 ? thumbs(captured) : <div>No thumbnails stored for this version.</div>}
          </div>
          <div>
            <div className="font-medium">2. Analysed for Design DNA</div>
            <div>{ref.designDnaIncluded ? 'All captured screenshots fed the Design DNA analysis.' : 'No Design DNA analysis was included.'}</div>
          </div>
          <div>
            <div className="font-medium">3. Sent with the generation request ({ref.referenceScreenshotCount || 0})</div>
            {captured.some((s) => sentLabels.has(s.label)) && thumbs(captured.filter((s) => sentLabels.has(s.label)))}
            {Array.isArray(ref.referenceScreenshotLabels) && ref.referenceScreenshotLabels.length > 0 && (
              <div>{ref.referenceScreenshotLabels.join(', ')}</div>
            )}
            <div>
              {ref.referenceImagesIncludedInOpenAIRequest
                ? `Accepted into the final AI request: ${ref.referenceImagesSentCount} image${ref.referenceImagesSentCount === 1 ? '' : 's'}.`
                : 'No images were included in the final AI request.'}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function VersionHistory({ compositionId }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [evidenceId, setEvidenceId] = useState(null);
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
              <div key={v.id} className="space-y-2 rounded-md border border-border p-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium" data-testid={`text-aic-version-${v.id}`}>
                      {v.change_summary || v.operation_type}
                    </div>
                    <div className="text-muted-foreground">
                      {new Date(v.created_at).toLocaleString()}{isCurrent ? ' · current' : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEvidenceId((cur) => (cur === v.id ? null : v.id))}
                      data-testid={`button-aic-evidence-${v.id}`}
                    >
                      Evidence
                    </Button>
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
                </div>
                {evidenceId === v.id && (
                  <VersionEvidence compositionId={compositionId} versionId={v.id} />
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

/**
 * Phase 5 (Task #2909) — "Rebuild with the new renderer": ADMIN-ONLY action on
 * legacy V1 compositions. Fetches the stored V1 generation context (brief,
 * direction, creativity, style reference) from the server, lets the admin
 * review/adjust the brief, then runs a normal V2 generation as a brand-NEW
 * composition. The V1 record is never mutated; switching the block to the new
 * renderer is an explicit final step after previewing the result.
 */
function RebuildWithV2Panel({ compositionId, pageId, update }) {
  const [seed, setSeed] = useState(null);       // null = not fetched
  const [hidden, setHidden] = useState(false);  // 404 = not an admin → hide
  const [brief, setBrief] = useState('');
  const [rebuiltId, setRebuiltId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const gen = useCodeGenerationLoop({ onComplete: (id) => setRebuiltId(id) });

  const fetchSeed = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await aicFetch(`/api/ai-compositions/rebuild-v2?compositionId=${compositionId}`);
      setSeed(data);
      setBrief(data.seed?.brief || '');
    } catch (err) {
      if (err.status === 404) setHidden(true);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const startRebuild = () => {
    if (!brief.trim() || gen.running) return;
    setRebuiltId('');
    // Faithful rebuild: fold the server-extracted V1 context (copy, links,
    // protected values, past edit requests) into the generation brief so the
    // V2 result preserves the existing content, not just the original prompt.
    // NOTE: the server hard-caps briefs at 2000 chars, so the context block is
    // budgeted (protected values first, then copy/links) and each line is
    // truncated — never let context truncate away the user's own brief.
    const MAX_BRIEF = 2000;
    const trimLine = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const content = seed?.seed?.content;
    const convo = seed?.seed?.conversation || [];
    const contextParts = [];
    if (content?.protectedValues?.length) {
      contextParts.push('These values are PROTECTED and must appear unchanged:\n'
        + content.protectedValues.slice(0, 10).map((p) => `- ${trimLine(`${p.path || p.elementId || ''}: ${p.value ?? ''}`)}`).join('\n'));
    }
    if (content?.copy?.length) {
      contextParts.push('Preserve this existing copy (same meaning, same facts):\n'
        + content.copy.slice(0, 10).map((c) => `- ${c.role ? `[${c.role}] ` : ''}${trimLine(c.text)}`).join('\n'));
    }
    if (content?.links?.length) {
      contextParts.push('Keep these links/destinations:\n'
        + content.links.slice(0, 8).map((l) => `- ${trimLine(`${l.label || l.elementId || 'link'}: ${typeof l.link === 'string' ? l.link : JSON.stringify(l.link)}`)}`).join('\n'));
    }
    if (convo.length) {
      contextParts.push('Earlier edit requests from the user (honour their intent):\n'
        + convo.slice(-4).map((c) => `- ${trimLine(c.instruction)}`).join('\n'));
    }
    const userBrief = brief.trim();
    let fullBrief = userBrief;
    if (contextParts.length) {
      const budget = MAX_BRIEF - userBrief.length - 60;
      let context = '';
      for (const part of contextParts) {
        if (context.length + part.length + 2 > budget) break;
        context += (context ? '\n\n' : '') + part;
      }
      if (context) {
        fullBrief = `${userBrief}\n\n--- Existing design context (must be preserved) ---\n${context}`;
      }
    }
    gen.start({
      pageId: pageId || undefined,
      brief: fullBrief,
      direction: seed?.seed?.direction || undefined,
      creativity: seed?.seed?.creativity || 'brand_led',
      ...(seed?.seed?.styleReference ? { styleReference: seed.seed.styleReference } : {}),
      compositionType: seed?.composition?.compositionType === 'page_body' ? 'page_body' : undefined,
    });
  };

  const switchToNew = () => {
    if (!rebuiltId) return;
    // Explicit user action: the block becomes a V2 block pointing at the NEW
    // composition. The V1 composition record is left untouched.
    update((b) => ({ ...b, type: 'ai-code-composition', content: { compositionId: rebuiltId } }));
  };

  if (hidden) return null;

  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <p className="text-xs font-medium">New renderer</p>
      <p className="text-xs text-muted-foreground">
        This design uses the previous AI renderer. You can rebuild it with the new
        renderer using the original brief — the current design stays untouched until
        you switch.
      </p>
      {!seed && (
        <Button size="sm" variant="outline" onClick={fetchSeed} disabled={busy} data-testid="button-aic-rebuild-v2">
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}
          Rebuild with new renderer…
        </Button>
      )}
      {seed && !rebuiltId && (
        <div className="space-y-2">
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            data-testid="input-aic-rebuild-brief"
          />
          {!seed.seed?.briefFromJob && (
            <p className="text-xs text-muted-foreground">
              The original brief wasn’t stored — review the suggested brief above before rebuilding.
            </p>
          )}
          <Button size="sm" onClick={startRebuild} disabled={gen.running || !brief.trim()} data-testid="button-aic-rebuild-start">
            {gen.running
              ? (<><Loader2 className="mr-1 h-4 w-4 animate-spin" /> {gen.label}</>)
              : (<><Sparkles className="mr-1 h-4 w-4" /> Rebuild</>)}
          </Button>
          {gen.error && <p className="text-xs text-destructive" data-testid="text-aic-rebuild-error">{gen.error}</p>}
        </div>
      )}
      {rebuiltId && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            The rebuilt design is ready. Switching replaces this block’s content with the
            new version — the old design remains available if you undo.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={switchToNew} data-testid="button-aic-rebuild-switch">
              <Check className="mr-1 h-4 w-4" /> Switch to new renderer
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRebuiltId('')} data-testid="button-aic-rebuild-again">
              <RotateCcw className="mr-1 h-4 w-4" /> Rebuild again
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
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
  // Phase 5 advanced brief (collapsed by default — simple briefs stay simple).
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [adv, setAdv] = useState(EMPTY_ADVANCED_BRIEF);
  // Style reference (Task #2873): null = no reference, generation unchanged.
  const [styleReference, setStyleReference] = useState(null);
  // Screenshot review verdict for the current draft (Task #2894). The
  // in-session verdict arrives via the generation loop; the persisted verdict
  // (validation_result.gates.screenshotReview on the current version) covers
  // reloads and cases where the session verdict was lost — the server value
  // wins whenever it is present.
  const [sessionVerdict, setSessionVerdict] = useState(null);
  const { data: draftData } = useAiComposition(draftId);
  const reviewVerdict = draftData?.screenshotReview || sessionVerdict;

  const gen = useGenerationLoop({
    onComplete: (compositionId, screenshotReview) => {
      // Screenshot quality review (Task #2894): a failing verdict blocks
      // Insert (the draft stays reviewable/regeneratable); skipped or pass
      // blocks nothing.
      setSessionVerdict(screenshotReview || null);
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
      ...(styleReference ? { styleReference } : {}),
      ...(advancedOpen ? advancedBriefToBody(adv) : {}),
      // Regenerating an inserted composition adds a version to it; a pending
      // draft is regenerated in place too.
      compositionId: activeId || undefined,
    });
  };

  const insert = () => {
    if (!draftId || reviewVerdict?.status === 'fail') return;
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

      <StyleReferencePicker
        value={styleReference}
        onChange={setStyleReference}
        idPrefix={`aic-styleref-${block.id}`}
        disabled={gen.running}
      />

      <Button
        size="sm"
        variant="ghost"
        onClick={() => setAdvancedOpen((v) => !v)}
        data-testid="button-aic-advanced-toggle"
      >
        {advancedOpen ? 'Hide advanced brief' : 'Advanced brief…'}
      </Button>
      {advancedOpen && (
        <AdvancedBriefFields value={adv} onChange={setAdv} idPrefix={`aic-${block.id}`} />
      )}

      {gen.pendingPlan && (
        <PlanReviewPanel
          key={gen.pendingPlan.jobId}
          plan={gen.pendingPlan.plan}
          busy={gen.running}
          onApprove={(plan) => gen.resumePlan(gen.pendingPlan.jobId, plan)}
          onCancel={gen.cancelPlan}
        />
      )}

      <Button
        onClick={generate}
        disabled={gen.running || !brief.trim() || !!gen.pendingPlan}
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

      {draftId && reviewVerdict?.status === 'fail' && (
        <p className="text-xs text-destructive" data-testid="text-aic-review-failed">
          Quality check failed at {(reviewVerdict.failedBreakpoints || []).join(', ') || 'some'} width{(reviewVerdict.failedBreakpoints || []).length === 1 ? '' : 's'} — please regenerate before inserting.
        </p>
      )}
      {draftId && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={insert} disabled={reviewVerdict?.status === 'fail'} data-testid="button-aic-insert">
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
      {insertedId && !draftId && (
        <RebuildWithV2Panel compositionId={insertedId} pageId={pageId} update={update} />
      )}
    </div>
  );
}
