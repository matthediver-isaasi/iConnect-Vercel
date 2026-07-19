// AI Design Studio V2 — `ai-code-composition` canvas block (Task #2904, Phase 0).
//
// Renders a V2 code package (renderer_version 2, document schemaVersion
// "2.0"): the server-sanitised, CSS-scoped HTML is injected verbatim inside a
// [data-ai-composition="<compositionId>"] wrapper together with its scoped
// <style>. The client NEVER re-processes the markup — sanitisation and CSS
// scoping happened once, server-side (api/_lib/aiCodePipeline.js), before the
// immutable version was stored.
//
// Phase 0 inspector: attach an existing V2 composition by id (the BNMS proof
// fixture is seeded by scripts/seed-bnms-scan-fixture.mjs) and inspect the
// stored sanitisation/scoping report. No AI generation UI yet — that is
// Phase 1 of the V2 plan.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code2, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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

export function AiCodeCompositionInspector({ block, onChange }) {
  const compositionId = block.content?.compositionId || '';
  const [pendingId, setPendingId] = useState(compositionId);
  const { data, isLoading, error } = useAiCodeComposition(compositionId);
  const doc = data?.document;

  const attach = () => {
    const id = pendingId.trim();
    onChange({ ...block, content: { ...block.content, compositionId: id } });
  };

  return (
    <div className="space-y-4">
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
          onClick={attach}
          disabled={pendingId.trim() === compositionId}
          data-testid="button-aicc-attach"
        >
          Attach
        </Button>
        <p className="text-xs text-muted-foreground">
          Phase 0: attach an existing V2 (native HTML/CSS) composition. AI
          generation for V2 arrives in Phase 1.
        </p>
      </div>

      {compositionId && isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}
      {compositionId && error && (
        <p className="text-sm text-destructive" data-testid="text-aicc-error">
          Could not load this composition.
        </p>
      )}
      {compositionId && doc && !isV2Document(doc) && (
        <p className="text-sm text-destructive">
          This composition is a legacy (V1) document — use the original AI Composition block for it.
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
    </div>
  );
}
