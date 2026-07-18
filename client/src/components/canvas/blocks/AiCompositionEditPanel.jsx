// AI Composition "Edit with AI" panel — Phase 2 (Task #2850).
//
// Prompt-led editing of an inserted AI Composition:
//   - Scope selection: whole composition, a section, or a single element —
//     via a hierarchy tree AND click-to-select on the preview.
//   - Breakpoint scope: All / Desktop only / Tablet only / Mobile only.
//   - Propose → before/after preview → Accept / Reject / Refine.
//   - Protected values (prices, dates, names…) change only after an explicit
//     confirmation checkbox.
//   - Link workflow: "link this button to…" returns destination candidates
//     (record IDs — the AI never invents internal URLs); the user picks one
//     and the link is applied deterministically.
//   - Complete redesigns are saved as ALTERNATIVES alongside the original.
//   - Undo the most recent accepted change; per-composition history.

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles, Loader2, Check, X, Undo2, ChevronRight, ChevronDown,
  Link2, MessageSquare, AlertTriangle,
} from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import AiCompositionRenderer from '../AiCompositionRenderer';
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

function elementLabel(el) {
  const text = el.content?.text || el.content?.label || el.data?.label || '';
  const snippet = String(text).replace(/<[^>]+>/g, '').slice(0, 32);
  return snippet ? `${el.type} · ${snippet}` : el.type;
}

function TreeElement({ el, depth, selected, onPick }) {
  const kids = Array.isArray(el.children) ? el.children : [];
  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-xs hover-elevate ${selected?.elementId === el.id ? 'bg-accent text-accent-foreground' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onPick({ type: 'element', elementId: el.id, elementType: el.type })}
        data-testid={`button-aic-tree-${el.id}`}
      >
        <span className="truncate">{elementLabel(el)}</span>
      </button>
      {kids.map((c) => (
        <TreeElement key={c.id} el={c} depth={depth + 1} selected={selected} onPick={onPick} />
      ))}
    </div>
  );
}

function HierarchyTree({ doc, selected, onPick }) {
  const [openIds, setOpenIds] = useState(() => new Set());
  if (!doc?.sections) return null;
  return (
    <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-xs font-medium hover-elevate ${selected?.type === 'composition' ? 'bg-accent text-accent-foreground' : ''}`}
        onClick={() => onPick({ type: 'composition' })}
        data-testid="button-aic-tree-composition"
      >
        Whole composition
      </button>
      {doc.sections.map((s) => {
        const open = openIds.has(s.id);
        return (
          <div key={s.id}>
            <div className="flex items-center">
              <button
                type="button"
                className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground"
                onClick={() => setOpenIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                  return next;
                })}
                aria-label={open ? 'Collapse section' : 'Expand section'}
                data-testid={`button-aic-tree-toggle-${s.id}`}
              >
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              <button
                type="button"
                className={`flex min-w-0 flex-1 items-center rounded-sm px-1 py-0.5 text-left text-xs font-medium hover-elevate ${selected?.sectionId === s.id && selected?.type === 'section' ? 'bg-accent text-accent-foreground' : ''}`}
                onClick={() => onPick({ type: 'section', sectionId: s.id })}
                data-testid={`button-aic-tree-section-${s.id}`}
              >
                <span className="truncate">{s.name || s.role || 'Section'}</span>
              </button>
            </div>
            {open && (s.elements || []).map((el) => (
              <TreeElement key={el.id} el={el} depth={1} selected={selected} onPick={onPick} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function targetLabel(target, doc) {
  if (!target || target.type === 'composition') return 'Whole composition';
  if (target.type === 'section') {
    const s = (doc?.sections || []).find((x) => x.id === target.sectionId);
    return `Section: ${s?.name || s?.role || target.sectionId}`;
  }
  return `Element: ${target.elementType || target.elementId}`;
}

function ProposalPreview({ beforeDoc, afterDoc, compositionId }) {
  const [side, setSide] = useState('after');
  const doc = side === 'after' ? afterDoc : beforeDoc;
  const scale = 260 / 1200;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant={side === 'before' ? 'secondary' : 'ghost'} onClick={() => setSide('before')} data-testid="button-aic-preview-before">Before</Button>
        <Button size="sm" variant={side === 'after' ? 'secondary' : 'ghost'} onClick={() => setSide('after')} data-testid="button-aic-preview-after">After</Button>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-background" style={{ height: 260 }}>
        <div style={{ width: 1200, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <AiCompositionRenderer document={doc} instanceId={`edit-preview-${side}-${compositionId}`} />
        </div>
      </div>
    </div>
  );
}

export default function AiCompositionEditPanel({ compositionId }) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState({ type: 'composition' });
  const [breakpoint, setBreakpoint] = useState('all');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [proposal, setProposal] = useState(null); // { conversationId, kind, summary, warnings, previewDocument, isAlternative }
  const [destRequest, setDestRequest] = useState(null); // { elementId, query, candidates, summary }
  const [confirmProtected, setConfirmProtected] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const { data: current } = useQuery({
    queryKey: ['/api/ai-compositions', compositionId],
    queryFn: () => aicFetch(`/api/ai-compositions/${compositionId}`),
    enabled: !!compositionId,
    staleTime: 30 * 1000,
  });
  const doc = current?.document || null;

  const { data: historyData, refetch: refetchHistory } = useQuery({
    queryKey: ['/api/ai-compositions', compositionId, 'conversation'],
    queryFn: () => aicFetch(`/api/ai-compositions/edit?compositionId=${compositionId}`),
    enabled: !!compositionId && showHistory,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId] });
    queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId, 'versions'] });
    queryClient.invalidateQueries({ queryKey: ['/api/ai-compositions', compositionId, 'conversation'] });
  };

  const propose = async (extra = {}) => {
    if (busy || (!instruction.trim() && !extra.resolvedDestination)) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await aicFetch('/api/ai-compositions/edit', {
        method: 'POST',
        body: JSON.stringify({
          action: 'propose',
          compositionId,
          instruction: instruction.trim(),
          target,
          breakpoint,
          ...extra,
        }),
      });
      if (resp.status === 'needs_destination') {
        setDestRequest(resp);
        setProposal(null);
      } else {
        setProposal(resp);
        setDestRequest(null);
        setConfirmProtected(false);
      }
    } catch (err) {
      setError(err.message || 'The change could not be proposed. Nothing was altered.');
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await aicFetch('/api/ai-compositions/edit', {
        method: 'POST',
        body: JSON.stringify({
          action: 'accept',
          conversationId: proposal.conversationId,
          confirmProtected,
        }),
      });
      setProposal(null);
      setInstruction('');
      invalidate();
      if (resp.isAlternative) {
        setError(null);
      }
    } catch (err) {
      setError(err.message || 'The change could not be applied.');
    } finally {
      setBusy(false);
    }
  };

  const reject = async (thenRefine = false) => {
    if (!proposal) return;
    try {
      await aicFetch('/api/ai-compositions/edit', {
        method: 'POST',
        body: JSON.stringify({ action: 'reject', conversationId: proposal.conversationId }),
      });
    } catch { /* rejection best-effort */ }
    setProposal(null);
    setConfirmProtected(false);
    if (!thenRefine) setInstruction('');
    invalidate();
  };

  const undo = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await aicFetch('/api/ai-compositions/edit', {
        method: 'POST',
        body: JSON.stringify({ action: 'undo', compositionId }),
      });
      invalidate();
    } catch (err) {
      setError(err.message || 'Undo failed.');
    } finally {
      setBusy(false);
    }
  };

  const pickDestination = (candidate) => {
    propose({
      resolvedDestination: candidate,
      linkElementId: destRequest?.elementId || undefined,
    });
  };

  const warnings = proposal?.warnings || [];

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex items-center gap-1 text-sm font-medium">
        <Sparkles className="h-4 w-4" /> Edit with AI
      </div>

      {doc && (
        <div className="space-y-1">
          <Label>What to change</Label>
          <HierarchyTree doc={doc} selected={target} onPick={setTarget} />
          <p className="text-xs text-muted-foreground" data-testid="text-aic-edit-target">
            {targetLabel(target, doc)} — you can also click parts of the preview below.
          </p>
        </div>
      )}

      {doc && (
        <div className="overflow-hidden rounded-md border border-border bg-background" style={{ height: 220 }}>
          <div style={{ width: 1200, transform: `scale(${260 / 1200})`, transformOrigin: 'top left' }}>
            <AiCompositionRenderer
              document={doc}
              instanceId={`edit-select-${compositionId}`}
              selectable
              selectedId={target.elementId || target.sectionId || null}
              onSelect={setTarget}
            />
          </div>
        </div>
      )}

      <div className="space-y-1">
        <Label>Apply to</Label>
        <Select value={breakpoint} onValueChange={setBreakpoint}>
          <SelectTrigger data-testid="select-aic-edit-breakpoint"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All screen sizes</SelectItem>
            <SelectItem value="desktop">Desktop only</SelectItem>
            <SelectItem value="tablet">Tablet only</SelectItem>
            <SelectItem value="mobile">Mobile only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`aic-edit-instruction-${compositionId}`}>Instruction</Label>
        <Textarea
          id={`aic-edit-instruction-${compositionId}`}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder='e.g. "Make the heading shorter and more urgent" or "Link this button to the annual conference sign-up"'
          rows={3}
          data-testid="input-aic-edit-instruction"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => propose()} disabled={busy || !instruction.trim()} data-testid="button-aic-edit-propose">
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
          Propose change
        </Button>
        <Button size="sm" variant="outline" onClick={undo} disabled={busy} data-testid="button-aic-edit-undo">
          <Undo2 className="mr-1 h-4 w-4" /> Undo last change
        </Button>
      </div>

      {error && <p className="text-xs text-destructive" data-testid="text-aic-edit-error">{error}</p>}

      {destRequest && (
        <div className="space-y-2 rounded-md border border-border p-2">
          <div className="flex items-center gap-1 text-xs font-medium">
            <Link2 className="h-3 w-3" /> Where should this link go?
          </div>
          {destRequest.candidates?.length ? (
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {destRequest.candidates.map((c) => (
                <button
                  key={`${c.kind}-${c.id}`}
                  type="button"
                  className="flex w-full flex-wrap items-baseline gap-x-2 rounded-sm border border-border px-2 py-1 text-left text-xs hover-elevate"
                  onClick={() => pickDestination(c)}
                  disabled={busy}
                  data-testid={`button-aic-dest-${c.kind}-${c.id}`}
                >
                  <span className="font-medium">{c.title}</span>
                  <span className="text-muted-foreground">{c.detail}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Nothing matching “{destRequest.query}” was found. Try rephrasing with the exact page, event or form name.
            </p>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDestRequest(null)} data-testid="button-aic-dest-cancel">Cancel</Button>
        </div>
      )}

      {proposal && (
        <div className="space-y-2 rounded-md border border-border p-2">
          <p className="text-xs" data-testid="text-aic-edit-summary">{proposal.summary}</p>
          {proposal.isAlternative && (
            <p className="text-xs text-muted-foreground">
              This is a complete redesign — accepting saves it as an alternative alongside the current design (use version history to switch).
            </p>
          )}
          {doc && proposal.previewDocument && (
            <ProposalPreview beforeDoc={doc} afterDoc={proposal.previewDocument} compositionId={compositionId} />
          )}
          {warnings.length > 0 && (
            <div className="space-y-1 rounded-md border border-warning bg-warning/10 p-2">
              <div className="flex items-center gap-1 text-xs font-medium text-warning">
                <AlertTriangle className="h-3 w-3" /> Protected values would change
              </div>
              {warnings.map((w, i) => (
                <p key={i} className="text-xs" data-testid={`text-aic-warning-${i}`}>
                  {w.label}: “{String(w.before ?? '')}” → “{String(w.after ?? '')}”
                </p>
              ))}
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={confirmProtected}
                  onCheckedChange={(v) => setConfirmProtected(v === true)}
                  data-testid="checkbox-aic-confirm-protected"
                />
                I understand — change these values
              </label>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={accept}
              disabled={busy || (warnings.length > 0 && !confirmProtected)}
              data-testid="button-aic-edit-accept"
            >
              <Check className="mr-1 h-4 w-4" /> Accept
            </Button>
            <Button size="sm" variant="outline" onClick={() => reject(true)} disabled={busy} data-testid="button-aic-edit-refine">
              Refine
            </Button>
            <Button size="sm" variant="outline" onClick={() => reject(false)} disabled={busy} data-testid="button-aic-edit-reject">
              <X className="mr-1 h-4 w-4" /> Reject
            </Button>
          </div>
        </div>
      )}

      <Button
        size="sm"
        variant="ghost"
        onClick={() => { setShowHistory((v) => !v); if (!showHistory) refetchHistory(); }}
        data-testid="button-aic-edit-history"
      >
        <MessageSquare className="mr-1 h-4 w-4" /> Edit history
      </Button>
      {showHistory && (
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {(historyData?.conversation || []).map((c) => (
            <div key={c.id} className="rounded-md border border-border p-2 text-xs" data-testid={`row-aic-conv-${c.id}`}>
              <div className="font-medium">{c.instruction}</div>
              <div className="text-muted-foreground">
                {c.status} · {new Date(c.created_at).toLocaleString()}
                {c.breakpoint && c.breakpoint !== 'all' ? ` · ${c.breakpoint} only` : ''}
              </div>
            </div>
          ))}
          {historyData && (historyData.conversation || []).length === 0 && (
            <p className="text-xs text-muted-foreground">No edits yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
