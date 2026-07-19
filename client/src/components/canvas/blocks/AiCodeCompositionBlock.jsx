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
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Code2, Image as ImageIcon, Link2, Loader2, RotateCcw, Search, ShieldCheck, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
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
// Deferred usage only (render time), so the registry → dynamicBlocks →
// this-file → registry cycle is safe: function declarations are hoisted.
import { getBlockDefinition } from './registry';
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

// ---------------------------------------------------------------------------
// Slot rendering (Phase 2, Task #2906). The sanitiser empties every
// data-iconnect-slot placeholder and stamps data-slot-key; the SERVER resolved
// each slot into a trusted block config ({ type, content }). The client only
// mounts the corresponding registry component into the placeholder — the
// generated code never renders iConnect components itself.

// Pseudo-type with no canvas block: a small trusted membership CTA panel.
function MembershipApplicationCta({ content }) {
  const href = content?.tierId
    ? `/MembershipApplication?tier=${content.tierId}`
    : '/MembershipApplication';
  return (
    <div className="rounded-md border border-border bg-card p-6 text-center">
      <p className="mb-3 font-medium">
        {content?.tierName ? `Apply for ${content.tierName} membership` : 'Apply for membership'}
      </p>
      <Button asChild data-testid="button-aicc-slot-membership">
        <a href={href}>Apply now</a>
      </Button>
    </div>
  );
}

function SlotContent({ slot, asEditor }) {
  if (!slot?.resolved || !slot.block?.type) {
    if (!asEditor) return null;
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
        {slot?.unresolvedReason || 'This area is not connected to content yet.'}
      </div>
    );
  }
  if (slot.block.type === 'membership-application-cta') {
    return <MembershipApplicationCta content={slot.block.content} />;
  }
  const def = getBlockDefinition(slot.block.type);
  const Renderer = def?.Renderer;
  if (!Renderer) return null;
  const syntheticBlock = {
    id: `aicc-slot-${slot.key}`,
    type: slot.block.type,
    content: slot.block.content || {},
    style: {},
  };
  return <Renderer block={syntheticBlock} asEditor={!!asEditor} />;
}

/**
 * Pure V2 renderer: scoped <style> + sanitised HTML inside the scope wrapper.
 * After injection an effect wires the SERVER-resolved action hrefs onto
 * [data-ai-action] elements (unresolved actions become inert placeholders)
 * and mounts trusted slot components into [data-slot-key] placeholders via
 * portals. The client never builds internal URLs itself.
 */
export function AiCodeCompositionContent({ document: doc, asEditor }) {
  const compositionId = doc?.compositionId || '';
  const rootRef = useRef(null);
  const [slotMounts, setSlotMounts] = useState([]);
  const markup = useMemo(() => ({ __html: doc?.html || '' }), [doc?.html]);

  // Wire actions + collect slot mount points whenever the markup re-injects.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !doc) return;
    const actions = new Map(
      (Array.isArray(doc.actions) ? doc.actions : []).map((a) => [a?.key, a]),
    );
    root.querySelectorAll('[data-ai-action]').forEach((el) => {
      const action = actions.get(el.getAttribute('data-ai-action'));
      const isAnchor = el.tagName === 'A';
      if (action && action.resolved && action.href) {
        if (isAnchor) {
          el.setAttribute('href', action.href);
          if (action.type === 'external_url') {
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
          }
        } else {
          el.setAttribute('data-ai-href', action.href);
          el.style.cursor = 'pointer';
        }
        el.removeAttribute('aria-disabled');
      } else {
        // Inert placeholder: never a dead navigation.
        if (isAnchor) el.removeAttribute('href');
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('title', 'This link is not connected yet');
        el.style.cursor = 'default';
      }
    });

    const slots = new Map(
      (Array.isArray(doc.slots) ? doc.slots : []).map((s) => [s?.key, s]),
    );
    const mounts = [];
    root.querySelectorAll('[data-slot-key], [data-iconnect-slot]').forEach((el) => {
      const key = el.getAttribute('data-slot-key') || el.getAttribute('data-iconnect-slot');
      const slot = slots.get(key);
      if (!slot) return;
      el.innerHTML = '';
      mounts.push({ key, el, slot });
    });
    setSlotMounts(mounts);
  }, [doc]);

  const onClickCapture = (e) => {
    if (asEditor) {
      // Never navigate away from the builder. Instead, clicking an element
      // with a data-ai-id selects it for prompt-led editing (Task #2908):
      // broadcast to the inspector's edit panel via a window CustomEvent.
      e.preventDefault();
      const el = e.target?.closest?.('[data-ai-id]');
      const root = rootRef.current;
      if (el && root) {
        root.querySelectorAll('[data-aicc-selected]').forEach((n) => n.removeAttribute('data-aicc-selected'));
        el.setAttribute('data-aicc-selected', 'true');
        const img = el.tagName === 'IMG' ? el : el.querySelector?.('img[data-ai-id]');
        window.dispatchEvent(new CustomEvent('aicc-element-selected', {
          detail: {
            compositionId,
            aiId: el.getAttribute('data-ai-id'),
            label: (el.textContent || '').trim().slice(0, 60) || el.tagName.toLowerCase(),
            // Image context (Phase 5): a selected <img> (or an element wrapping
            // exactly one) unlocks the deterministic "Replace image" action.
            imageAiId: el.tagName === 'IMG' ? el.getAttribute('data-ai-id') : (img?.getAttribute('data-ai-id') || null),
          },
        }));
      }
      return;
    }
    const actionEl = e.target?.closest?.('[data-ai-action]');
    if (!actionEl) return;
    const href = actionEl.getAttribute('data-ai-href');
    if (href && actionEl.tagName !== 'A') {
      e.preventDefault();
      window.location.href = href;
    }
  };

  // Editor-only selection/hover affordances for identified elements.
  const editorCss = asEditor
    ? `[data-ai-composition="${compositionId}"] [data-ai-id]:hover { outline: 1px dashed hsl(var(--primary) / 0.6); outline-offset: 2px; cursor: pointer; }
[data-ai-composition="${compositionId}"] [data-aicc-selected] { outline: 2px solid hsl(var(--primary)); outline-offset: 2px; }`
    : '';

  if (!isV2Document(doc) || !compositionId) return null;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `${doc.css || ''}${editorCss ? `\n${editorCss}` : ''}` }} />
      {/* eslint-disable-next-line react/no-danger -- server-sanitised, immutable document */}
      <div
        ref={rootRef}
        data-ai-composition={compositionId}
        dangerouslySetInnerHTML={markup}
        onClickCapture={onClickCapture}
      />
      {slotMounts.map(({ key, el, slot }) => createPortal(
        <SlotContent slot={slot} asEditor={asEditor} />,
        el,
        `aicc-slot-${key}`,
      ))}
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
      <AiCodeCompositionContent document={doc} asEditor={!!asEditor} />
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
export function useCodeGenerationLoop({ onComplete }) {
  const [running, setRunning] = useState(false);
  const [label, setLabel] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [rejectionReasons, setRejectionReasons] = useState([]);
  // Design-first (Phase 6): when the server pauses at `awaiting_visual`, the
  // proposal (desktop + mobile concept images) is exposed for review; the
  // loop resumes on approve / revise.
  const [visualProposal, setVisualProposal] = useState(null);
  const [visualRevisions, setVisualRevisions] = useState([]);
  const [visualSimilarity, setVisualSimilarity] = useState(null);
  const [awaitingJobId, setAwaitingJobId] = useState(null);
  const cancelledRef = useRef(false);

  useEffect(() => () => { cancelledRef.current = true; }, []);

  const pump = async (firstBody) => {
    setRunning(true);
    setError(null);
    setRejectionReasons([]);
    setVisualProposal(null);
    setAwaitingJobId(null);
    setProgress((p) => Math.max(p, 0.05));
    cancelledRef.current = false;
    try {
      let resp = await aicFetch('/api/ai-compositions/generate-v2', {
        method: 'POST',
        body: JSON.stringify(firstBody),
      });
      let guard = 0;
      // context (+plan/visual/deconstruct) + code with refinement rounds.
      while (!cancelledRef.current && resp.status === 'running' && guard < 24) {
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
      if (resp.status === 'awaiting_visual') {
        setVisualProposal(resp.visualProposal || null);
        setVisualRevisions(Array.isArray(resp.visualRevisions) ? resp.visualRevisions : []);
        setAwaitingJobId(resp.jobId);
        setLabel('Review the visual concept');
        setProgress(0.35);
      } else if (resp.status === 'complete' && resp.compositionId) {
        setProgress(1);
        setLabel('Done');
        setVisualSimilarity(resp.visualSimilarity || null);
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

  const start = async (startBody) => {
    setProgress(0.05);
    setVisualSimilarity(null);
    setVisualRevisions([]);
    setLabel('Starting…');
    await pump(startBody);
  };

  const approveVisual = async () => {
    if (!awaitingJobId) return;
    await pump({ jobId: awaitingJobId, visualAction: 'approve' });
  };

  const reviseVisual = async (instruction) => {
    if (!awaitingJobId || !instruction?.trim()) return;
    await pump({ jobId: awaitingJobId, visualAction: 'revise', instruction: instruction.trim() });
  };

  return {
    start, running, label, progress, error, rejectionReasons,
    visualProposal, visualRevisions, visualSimilarity,
    awaitingVisual: !!(awaitingJobId && visualProposal),
    approveVisual, reviseVisual,
  };
}

// Design-first review card: shows the desktop + mobile concept images with
// approve / revise controls while the generation job is paused.
function VisualProposalReview({ gen }) {
  const [instruction, setInstruction] = useState('');
  if (!gen.awaitingVisual || !gen.visualProposal) return null;
  const p = gen.visualProposal;
  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-testid="panel-aicc-visual-review">
      <p className="text-sm font-medium">Visual concept {p.round > 1 ? `(revision ${p.round})` : ''}</p>
      <p className="text-xs text-muted-foreground">
        This is a visual mockup — the wording is placeholder and will be replaced by your real content when it's built.
      </p>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs text-muted-foreground">Desktop</p>
          <img src={p.desktopUrl} alt="Desktop visual concept" className="w-full rounded-md border border-border" data-testid="img-aicc-visual-desktop" />
        </div>
        <div className="w-1/3 space-y-1">
          <p className="text-xs text-muted-foreground">Mobile</p>
          <img src={p.mobileUrl} alt="Mobile visual concept" className="w-full rounded-md border border-border" data-testid="img-aicc-visual-mobile" />
        </div>
      </div>
      {gen.visualRevisions.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {gen.visualRevisions.map((r, i) => <li key={i}>· {r}</li>)}
        </ul>
      )}
      <Textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder='e.g. "make the hero smaller", "reduce the yellow", "use an illustration rather than photography"'
        rows={2}
        disabled={gen.running}
        data-testid="input-aicc-visual-instruction"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={gen.approveVisual}
          disabled={gen.running}
          data-testid="button-aicc-visual-approve"
        >
          <Check className="mr-1 h-4 w-4" /> Approve & build
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { gen.reviseVisual(instruction); setInstruction(''); }}
          disabled={gen.running || !instruction.trim()}
          data-testid="button-aicc-visual-revise"
        >
          <RotateCcw className="mr-1 h-4 w-4" /> Request changes
        </Button>
      </div>
    </div>
  );
}

const PREVIEW_WIDTHS = { desktop: 1440, tablet: 1024, mobile: 390 };

// Renders any V2 document (current or a PROPOSED one) at breakpoint widths.
// The document's @media rules evaluate against the VIEWPORT, so a scaled
// div cannot preview breakpoints — render inside an iframe whose window is
// the target width, then scale the iframe down to the inspector column.
function DocBreakpointPreview({ doc, testId = 'iframe-aicc-preview' }) {
  const [bp, setBp] = useState('desktop');
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
          data-testid={testId}
        />
      </div>
    </div>
  );
}

function BreakpointPreview({ compositionId }) {
  const { data } = useAiCodeComposition(compositionId);
  const doc = data?.document;
  if (!isV2Document(doc)) return null;
  return <DocBreakpointPreview doc={doc} />;
}

// Which destinations `kinds` filter each record-backed action type searches.
const ACTION_DEST_KINDS = {
  internal_page: 'page',
  event: 'event_registration',
  event_registration: 'event_registration',
  form: 'form',
  membership_application: 'membership_application',
  document: 'document',
};
const SELF_RESOLVING_TYPES = new Set(['external_url', 'anchor', 'email', 'tel']);
const SELF_RESOLVING_FIELD = { external_url: 'url', anchor: 'anchorId', email: 'address', tel: 'number' };
const SELF_RESOLVING_PLACEHOLDER = {
  external_url: 'https://example.org/…',
  anchor: 'section-anchor-id',
  email: 'name@example.org',
  tel: '+44 20 …',
};

// One unresolved action row: search real records (record-backed types) or
// type a value (external/email/tel/anchor), then resolve server-side. The
// server verifies the target and builds the href — never the client.
function UnresolvedActionRow({ compositionId, action, onResolved }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const selfResolving = SELF_RESOLVING_TYPES.has(action.type);

  const search = async () => {
    if (!q.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const kinds = ACTION_DEST_KINDS[action.type];
      const body = await aicFetch(`/api/ai-compositions/destinations?q=${encodeURIComponent(q.trim())}${kinds ? `&kinds=${kinds}` : ''}`);
      setResults(Array.isArray(body.destinations) ? body.destinations.slice(0, 6) : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  };

  const resolve = async (target) => {
    setBusy(true);
    setError(null);
    try {
      await aicFetch('/api/ai-compositions/resolve-action', {
        method: 'POST',
        body: JSON.stringify({ compositionId, actionKey: action.key, target }),
      });
      onResolved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded-md border border-border p-2" data-testid={`row-aicc-action-${action.key}`}>
      <p className="text-xs">
        <span className="font-medium">{action.label || action.hint || action.key}</span>{' '}
        <span className="text-muted-foreground">· {action.type.replace(/_/g, ' ')}</span>
      </p>
      <p className="text-xs text-muted-foreground">{action.unresolvedReason || 'Not connected yet'}</p>
      {selfResolving ? (
        <div className="flex flex-wrap items-center gap-1">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={SELF_RESOLVING_PLACEHOLDER[action.type]}
            className="flex-1"
            data-testid={`input-aicc-resolve-${action.key}`}
          />
          <Button
            size="icon"
            variant="outline"
            onClick={() => resolve({ [SELF_RESOLVING_FIELD[action.type]]: value.trim() })}
            disabled={busy || !value.trim()}
            data-testid={`button-aicc-resolve-${action.key}`}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
              placeholder="Search for the right content…"
              className="flex-1"
              data-testid={`input-aicc-search-${action.key}`}
            />
            <Button
              size="icon"
              variant="outline"
              onClick={search}
              disabled={searching || !q.trim()}
              data-testid={`button-aicc-search-${action.key}`}
            >
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
          {results.length > 0 && (
            <ul className="space-y-1">
              {results.map((r) => (
                <li key={`${r.kind}-${r.id}`}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-auto w-full justify-start whitespace-normal py-1 text-left"
                    onClick={() => resolve({ recordId: r.id })}
                    disabled={busy}
                    data-testid={`button-aicc-pick-${action.key}-${r.id}`}
                  >
                    <span className="text-xs">{r.title}{r.detail ? ` — ${r.detail}` : ''}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function UnresolvedActionsPanel({ compositionId, doc }) {
  const queryClient = useQueryClient();
  const actions = Array.isArray(doc?.actions) ? doc.actions : [];
  const referenced = Array.isArray(doc?.sanitisation?.actionKeys) && doc.sanitisation.actionKeys.length
    ? new Set(doc.sanitisation.actionKeys)
    : null;
  const unresolved = actions.filter(
    (a) => a && (!referenced || referenced.has(a.key)) && (a.resolved !== true || !a.href),
  );
  if (!unresolved.length) return null;
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2 text-xs font-medium">
        <TriangleAlert className="h-3.5 w-3.5 text-warning" />
        <span data-testid="text-aicc-unresolved-count">
          {unresolved.length} link{unresolved.length === 1 ? '' : 's'} not connected — resolve before publishing
        </span>
      </div>
      {unresolved.map((a) => (
        <UnresolvedActionRow
          key={a.key}
          compositionId={compositionId}
          action={a}
          onResolved={() => {
            queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId] });
            queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId, 'versions'] });
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompt-led editing (Task #2908). Proposals are computed AND stored
// server-side; accept re-applies the stored proposal against the CURRENT
// document. The panel only orchestrates: propose → preview → accept/reject,
// plus undo and the edit history.

const BREAKPOINT_LABELS = { all: 'All screen sizes', desktop: 'Desktop only', tablet: 'Tablet only', mobile: 'Mobile only' };

function AiCodeEditPanel({ compositionId }) {
  const queryClient = useQueryClient();
  const [instruction, setInstruction] = useState('');
  const [selected, setSelected] = useState(null); // { aiId, label }
  const [breakpoint, setBreakpoint] = useState('all');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState(null); // propose response
  const [error, setError] = useState(null);
  const [needsConfirm, setNeedsConfirm] = useState(null); // { warnings }
  const [criticalIssues, setCriticalIssues] = useState([]);

  // Listen for element selection clicks from the rendered composition.
  useEffect(() => {
    const onSelect = (e) => {
      if (e.detail?.compositionId !== compositionId) return;
      setSelected({ aiId: e.detail.aiId, label: e.detail.label, imageAiId: e.detail.imageAiId || null });
    };
    window.addEventListener('aicc-element-selected', onSelect);
    return () => window.removeEventListener('aicc-element-selected', onSelect);
  }, [compositionId]);

  const historyQuery = useQuery({
    queryKey: ['/api/ai-compositions', compositionId, 'edit-v2-history'],
    queryFn: () => aicFetch(`/api/ai-compositions/edit-v2?compositionId=${compositionId}`),
    enabled: !!compositionId,
    staleTime: 15 * 1000,
  });

  const invalidateComposition = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId] });
    queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId, 'versions'] });
    queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId, 'edit-v2-history'] });
  };

  const resetOutcome = () => {
    setError(null);
    setNeedsConfirm(null);
    setCriticalIssues([]);
  };

  const propose = async () => {
    if (!instruction.trim() || busy) return;
    setBusy(true);
    resetOutcome();
    setProposal(null);
    try {
      const body = await aicFetch('/api/ai-compositions/edit-v2', {
        method: 'POST',
        body: JSON.stringify({
          action: 'propose',
          compositionId,
          instruction: instruction.trim(),
          target: selected ? { type: 'element', elementId: selected.aiId } : { type: 'composition' },
          breakpoint,
        }),
      });
      setProposal(body);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const accept = async (confirmProtected = false) => {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    setCriticalIssues([]);
    try {
      const res = await fetch(buildEditV2Url(), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept', conversationId: proposal.conversationId, confirmProtected }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setProposal(null);
        setNeedsConfirm(null);
        setInstruction('');
        invalidateComposition();
      } else if (res.status === 409 && body.requiresConfirmation) {
        setNeedsConfirm({ warnings: body.warnings || [] });
      } else if (res.status === 422 && body.code === 'AI_VALIDATION_CRITICAL') {
        setCriticalIssues(body.validation?.critical || []);
        setError(body.error);
      } else {
        setError(body.error || 'Could not apply this change.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!proposal || busy) return;
    setBusy(true);
    resetOutcome();
    try {
      await aicFetch('/api/ai-compositions/edit-v2', {
        method: 'POST',
        body: JSON.stringify({ action: 'reject', conversationId: proposal.conversationId }),
      });
      setProposal(null);
      invalidateComposition();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (busy) return;
    setBusy(true);
    resetOutcome();
    try {
      await aicFetch('/api/ai-compositions/edit-v2', {
        method: 'POST',
        body: JSON.stringify({ action: 'undo', compositionId }),
      });
      invalidateComposition();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Deterministic image replacement (Phase 5): pick a media-library image and
  // swap the selected <img> via the server-verified replace-image action —
  // no LLM involved, tenant ownership checked server-side.
  const replaceImage = async (fileRepositoryId) => {
    if (!selected?.imageAiId || busy) return;
    setBusy(true);
    resetOutcome();
    try {
      await aicFetch('/api/ai-compositions/edit-v2', {
        method: 'POST',
        body: JSON.stringify({
          action: 'replace-image',
          compositionId,
          aiId: selected.imageAiId,
          fileRepositoryId,
        }),
      });
      invalidateComposition();
    } catch (err) {
      setError(err.message || 'The image could not be replaced. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  };

  const openReplaceImagePicker = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('canvas:open-file-repository', {
      detail: {
        kind: 'image',
        title: 'Replace this image',
        onPick: (asset) => { if (asset?.id) replaceImage(asset.id); },
      },
    }));
  };

  const history = (historyQuery.data?.conversation || []).slice(0, 8);

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>Edit with AI</Label>
        <Button size="sm" variant="ghost" onClick={undo} disabled={busy} data-testid="button-aicc-edit-undo">
          <RotateCcw className="mr-1 h-4 w-4" /> Undo last change
        </Button>
      </div>
      <div className="space-y-1">
        {selected ? (
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <span className="rounded-md border border-border bg-muted/40 px-2 py-1" data-testid="text-aicc-edit-target">
              Editing: {selected.label}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)} data-testid="button-aicc-edit-clear-target">
              Whole design
            </Button>
            {selected.imageAiId && (
              <Button size="sm" variant="outline" onClick={openReplaceImagePicker} disabled={busy} data-testid="button-aicc-replace-image">
                <ImageIcon className="mr-1 h-4 w-4" /> Replace image
              </Button>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Tip: click any part of the design on the canvas to edit just that element.
          </p>
        )}
        <Textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder='e.g. "Make the heading larger" or "Redesign this as two columns"'
          rows={3}
          data-testid="input-aicc-edit-instruction"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select value={breakpoint} onValueChange={setBreakpoint}>
            <SelectTrigger className="flex-1" data-testid="select-aicc-edit-breakpoint"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(BREAKPOINT_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={propose} disabled={busy || !instruction.trim()} data-testid="button-aicc-edit-propose">
            {busy && !proposal
              ? (<><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Working…</>)
              : (<><Sparkles className="mr-1 h-4 w-4" /> Propose change</>)}
          </Button>
        </div>
      </div>

      {proposal && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs" data-testid="text-aicc-edit-summary">
            <span className="font-medium">{proposal.isAlternative ? 'New design alternative: ' : 'Proposed change: '}</span>
            {proposal.summary || 'Preview below.'}
          </p>
          {proposal.isAlternative && (
            <p className="text-xs text-muted-foreground">
              This is a full redesign — accepting saves it as an alternative without replacing your current design.
            </p>
          )}
          {isV2Document(proposal.previewDocument) && (
            <DocBreakpointPreview doc={proposal.previewDocument} testId="iframe-aicc-edit-preview" />
          )}
          {(proposal.warnings || []).length > 0 && (
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {proposal.warnings.slice(0, 6).map((w, i) => (
                <li key={i} className="flex items-start gap-1">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                  <span>{w.reason || `${w.label || w.key || w.type}: “${w.before}” → “${w.after}”`}</span>
                </li>
              ))}
            </ul>
          )}
          {needsConfirm ? (
            <div className="space-y-1">
              <p className="text-xs font-medium">This change alters facts (prices, dates or names). Apply anyway?</p>
              {(needsConfirm.warnings || []).slice(0, 6).map((w, i) => (
                <p key={i} className="text-xs text-muted-foreground">{w.label || w.key}: “{w.before}” → “{w.after}”</p>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => accept(true)} disabled={busy} data-testid="button-aicc-edit-confirm">
                  <Check className="mr-1 h-4 w-4" /> Yes, apply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNeedsConfirm(null)} disabled={busy} data-testid="button-aicc-edit-cancel-confirm">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => accept(false)} disabled={busy} data-testid="button-aicc-edit-accept">
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />} Accept
              </Button>
              <Button size="sm" variant="ghost" onClick={reject} disabled={busy} data-testid="button-aicc-edit-reject">
                <Trash2 className="mr-1 h-4 w-4" /> Reject
              </Button>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive" data-testid="text-aicc-edit-error">{error}</p>}
      {criticalIssues.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive">
          {criticalIssues.slice(0, 6).map((c, i) => <li key={i}>· {c.detail || c.rule || String(c)}</li>)}
        </ul>
      )}

      {history.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Recent edits</p>
          <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
            {history.map((h) => (
              <li key={h.id} data-testid={`row-aicc-edit-history-${h.id}`}>
                <span className={h.status === 'accepted' ? '' : 'line-through opacity-70'}>
                  {h.summary || h.instruction}
                </span>{' '}
                · {h.status}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function buildEditV2Url() {
  const slug = getTenantSlugFromLocation();
  const url = new URL('/api/ai-compositions/edit-v2', window.location.origin);
  if (slug) url.searchParams.set('tenant', slug);
  return url.pathname + url.search;
}

// Saved redesign alternatives: shown side by side, switched explicitly.
function AlternativesPanel({ compositionId }) {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState(null);
  const { data } = useQuery({
    queryKey: ['/api/ai-compositions', compositionId, 'versions'],
    queryFn: () => aicFetch(`/api/ai-compositions/${compositionId}?versions=1`),
    enabled: !!compositionId,
    staleTime: 15 * 1000,
  });
  const alternatives = (data?.versions || []).filter((v) => v.is_alternative);
  if (!alternatives.length) return null;

  const useAlternative = async (versionId) => {
    setBusyId(versionId);
    try {
      await aicFetch(`/api/ai-compositions/${compositionId}?restore=1`, {
        method: 'POST',
        body: JSON.stringify({ versionId }),
      });
      queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId] });
      queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId, 'versions'] });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <Label>Design alternatives</Label>
      <ul className="space-y-1">
        {alternatives.slice(0, 6).map((v) => (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2" data-testid={`row-aicc-alternative-${v.id}`}>
            <span className="text-xs">{v.change_summary || 'Redesign'}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => useAlternative(v.id)}
              disabled={!!busyId}
              data-testid={`button-aicc-use-alternative-${v.id}`}
            >
              {busyId === v.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null} Use this design
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Admin-only Composition Inspector: validation reports, generation metadata
// and the conversation trail. The endpoint 404s for non-admins, so the whole
// section simply hides itself when the fetch fails.
function CompositionInspectorPanel({ compositionId }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useQuery({
    queryKey: ['/api/ai-compositions', compositionId, 'inspector'],
    queryFn: () => aicFetch(`/api/ai-compositions/${compositionId}?inspector=1`),
    enabled: !!compositionId && open,
    retry: false,
    staleTime: 30 * 1000,
  });
  if (!compositionId) return null;
  if (open && error) return null; // non-admin (404) or unavailable — hide entirely
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} data-testid="button-aicc-inspector-toggle">
        <ShieldCheck className="mr-1 h-4 w-4" /> {open ? 'Hide technical details' : 'Technical details (admin)'}
      </Button>
      {open && data && (
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground" data-testid="text-aicc-inspector-meta">
            {data.versions?.length || 0} versions · current {String(data.currentVersionId || '').slice(0, 8)}
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {(data.versions || []).slice(0, 15).map((v) => (
              <li key={v.id} className="rounded-md border border-border p-2" data-testid={`row-aicc-inspector-version-${v.id}`}>
                <p>
                  <span className="font-medium">{v.operation_type || 'generate'}</span>
                  {v.is_alternative ? ' · alternative' : ''}
                  {v.id === data.currentVersionId ? ' · current' : ''}
                </p>
                <p className="text-muted-foreground">{v.change_summary || '—'}</p>
                <p className="text-muted-foreground">
                  model {v.generation_metadata?.model || '?'} ·{' '}
                  validation {v.validation_result?.ok === false ? 'failed' : 'ok'}
                  {v.validation_result?.phase3?.status ? ` · phase3 ${v.validation_result.phase3.status}` : ''}
                </p>
              </li>
            ))}
          </ul>
          {(data.conversation || []).length > 0 && (
            <>
              <p className="font-medium text-muted-foreground">Edit conversation</p>
              <ul className="max-h-32 space-y-1 overflow-y-auto text-muted-foreground">
                {data.conversation.slice(0, 15).map((c) => (
                  <li key={c.id} data-testid={`row-aicc-inspector-convo-${c.id}`}>
                    “{c.instruction}” → {c.kind} · {c.status}
                    {c.breakpoint && c.breakpoint !== 'all' ? ` · ${c.breakpoint}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function AiCodeCompositionInspector({ block, update, onChange, pageId }) {
  const queryClient = useQueryClient();
  const insertedId = block.content?.compositionId || '';
  const [draftId, setDraftId] = useState('');
  const [brief, setBrief] = useState('');
  const [scope, setScope] = useState('section');
  const [direction, setDirection] = useState('');
  const [creativity, setCreativity] = useState('brand_led');
  const [designFirst, setDesignFirst] = useState(false);
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
      compositionType: scope,
      direction: direction || undefined,
      creativity,
      designFirst,
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
        <Label>What should the AI design?</Label>
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger data-testid="select-aicc-scope"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="section">A single section</SelectItem>
            <SelectItem value="page_body">A full page body (multiple sections)</SelectItem>
          </SelectContent>
        </Select>
        {scope === 'page_body' && (
          <p className="text-xs text-muted-foreground">
            Your site header, footer and navigation are never redesigned — the AI only creates the page content between them.
          </p>
        )}
      </div>
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

      <div className="space-y-1">
        <Label>Workflow</Label>
        <Select value={designFirst ? 'design_first' : 'code_first'} onValueChange={(v) => setDesignFirst(v === 'design_first')}>
          <SelectTrigger data-testid="select-aicc-workflow"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="code_first">Build straight away</SelectItem>
            <SelectItem value="design_first">Show me a visual concept first</SelectItem>
          </SelectContent>
        </Select>
        {designFirst && (
          <p className="text-xs text-muted-foreground">
            You'll see a desktop and mobile mockup to approve or revise before anything is built.
          </p>
        )}
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

      <VisualProposalReview gen={gen} />
      {gen.visualSimilarity?.status === 'warning' && (
        <p className="text-xs text-warning" data-testid="text-aicc-visual-warning">
          The built section differs from the approved visual in places
          {typeof gen.visualSimilarity.similarity === 'number' ? ` (similarity ${Math.round(gen.visualSimilarity.similarity * 100)}%)` : ''}.
          You can refine it with prompt-led edits below.
        </p>
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
          <UnresolvedActionsPanel compositionId={activeId} doc={doc} />
        </div>
      )}

      {/* Prompt-led editing operates on the INSERTED composition only —
          drafts are regenerated, not edited. */}
      {insertedId && !draftId && isV2Document(doc) && (
        <>
          <AiCodeEditPanel compositionId={insertedId} />
          <AlternativesPanel compositionId={insertedId} />
          <CompositionInspectorPanel compositionId={insertedId} />
        </>
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
