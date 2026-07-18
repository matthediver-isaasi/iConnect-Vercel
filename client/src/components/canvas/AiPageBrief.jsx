// AI Design Studio Phase 5 (Task #2853): shared advanced-brief UI.
//
// Used by both the AiCompositionBlock inspector and the "Create page with AI"
// wizard so the brief shape stays identical: purpose / audience / desired
// action / content notes, tenant record pins (server-verified again in
// generate.js — the picker is a convenience, never trusted), plan review and
// SEO toggles, plus the editable section-plan review panel shown while a job
// sits in `awaiting_plan`.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Loader2, Plus, Search, X, ArrowUp, ArrowDown, Trash2, Check } from 'lucide-react';

async function aicFetch(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const RECORD_KIND_LABELS = {
  page: 'Page',
  event_registration: 'Event',
  form: 'Form',
  document: 'Document',
  membership_application: 'Membership tier',
};

export function RecordPicker({ records, onChange, idPrefix }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const data = await aicFetch(`/api/ai-compositions/destinations?q=${encodeURIComponent(q)}`);
      setResults((data.destinations || []).filter((d) => RECORD_KIND_LABELS[d.kind]));
      setOpen(true);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const add = (d) => {
    if (records.some((r) => r.id === d.id)) return;
    onChange([...records, { kind: d.kind, id: d.id, slug: d.slug || null, title: d.title }].slice(0, 8));
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="space-y-2">
      <Label>Use these records (optional)</Label>
      {records.length > 0 && (
        <div className="space-y-1">
          {records.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-xs">
              <span className="min-w-0 truncate" data-testid={`text-aic-record-${r.id}`}>
                <span className="text-muted-foreground">{RECORD_KIND_LABELS[r.kind]}:</span> {r.title}
              </span>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onChange(records.filter((x) => x.id !== r.id))}
                data-testid={`button-aic-record-remove-${r.id}`}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Input
          id={`${idPrefix}-record-q`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }}
          placeholder="Search events, forms, pages…"
          className="flex-1 min-w-0"
          data-testid="input-aic-record-search"
        />
        <Button size="icon" variant="outline" onClick={search} disabled={searching || !query.trim()} data-testid="button-aic-record-search">
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </Button>
      </div>
      {open && (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-1">
          {results.length === 0 && <p className="p-1 text-xs text-muted-foreground">No matches.</p>}
          {results.map((d) => (
            <button
              key={`${d.kind}-${d.id}`}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover-elevate"
              onClick={() => add(d)}
              data-testid={`button-aic-record-add-${d.id}`}
            >
              <Plus className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">
                <span className="text-muted-foreground">{RECORD_KIND_LABELS[d.kind]}:</span> {d.title}
                {d.detail ? <span className="text-muted-foreground"> — {d.detail}</span> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdvancedBriefFields({ value, onChange, idPrefix, showToggles = true }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-purpose`}>Purpose of the page</Label>
        <Input
          id={`${idPrefix}-purpose`}
          value={value.purpose}
          onChange={(e) => set('purpose', e.target.value)}
          placeholder="e.g. Promote our annual conference"
          data-testid="input-aic-purpose"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-audience`}>Who is it for?</Label>
        <Input
          id={`${idPrefix}-audience`}
          value={value.audience}
          onChange={(e) => set('audience', e.target.value)}
          placeholder="e.g. Prospective members and partners"
          data-testid="input-aic-audience"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-action`}>What should visitors do?</Label>
        <Input
          id={`${idPrefix}-action`}
          value={value.desiredAction}
          onChange={(e) => set('desiredAction', e.target.value)}
          placeholder="e.g. Register for the event"
          data-testid="input-aic-desired-action"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-content`}>Content to include (optional)</Label>
        <Textarea
          id={`${idPrefix}-content`}
          value={value.contentNotes}
          onChange={(e) => set('contentNotes', e.target.value)}
          placeholder="Key facts, dates, names or copy that must appear"
          rows={3}
          data-testid="input-aic-content-notes"
        />
      </div>
      <RecordPicker
        records={value.records}
        onChange={(records) => set('records', records)}
        idPrefix={idPrefix}
      />
      {showToggles && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor={`${idPrefix}-review-plan`}>Review the plan before generating</Label>
            <Switch
              id={`${idPrefix}-review-plan`}
              checked={value.reviewPlan}
              onCheckedChange={(v) => set('reviewPlan', v)}
              data-testid="switch-aic-review-plan"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor={`${idPrefix}-seo`}>Suggest SEO title & description</Label>
            <Switch
              id={`${idPrefix}-seo`}
              checked={value.generateSeo}
              onCheckedChange={(v) => set('generateSeo', v)}
              data-testid="switch-aic-generate-seo"
            />
          </div>
        </>
      )}
    </div>
  );
}

export const EMPTY_ADVANCED_BRIEF = {
  purpose: '',
  audience: '',
  desiredAction: '',
  contentNotes: '',
  records: [],
  reviewPlan: false,
  generateSeo: false,
};

// Turn the advanced-brief state into request-body fields; empty fields are
// omitted so simple briefs stay byte-identical to Phase 1 requests.
export function advancedBriefToBody(adv) {
  const body = {};
  if (adv.purpose.trim()) body.purpose = adv.purpose.trim();
  if (adv.audience.trim()) body.audience = adv.audience.trim();
  if (adv.desiredAction.trim()) body.desiredAction = adv.desiredAction.trim();
  if (adv.contentNotes.trim()) body.contentNotes = adv.contentNotes.trim();
  if (adv.records.length) body.records = adv.records.map(({ kind, id, slug }) => ({ kind, id, slug }));
  if (adv.reviewPlan) body.reviewPlan = true;
  if (adv.generateSeo) body.generateSeo = true;
  return body;
}

// Editable section plan shown while the job is paused in `awaiting_plan`.
export function PlanReviewPanel({ plan, onApprove, onCancel, busy }) {
  const [sections, setSections] = useState(() => (plan?.sections || []).map((s, i) => ({ ...s, _key: i })));

  const setSection = (key, patch) => setSections((prev) => prev.map((s) => (s._key === key ? { ...s, ...patch } : s)));
  const move = (idx, dir) => setSections((prev) => {
    const next = [...prev];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return prev;
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  });
  const remove = (key) => setSections((prev) => prev.filter((s) => s._key !== key));

  const approve = () => {
    onApprove({ ...plan, sections: sections.map(({ _key, ...s }) => s) });
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <p className="text-sm font-medium">Page plan — edit before generating</p>
      {sections.map((s, idx) => (
        <div key={s._key} className="space-y-1 rounded-md border border-border p-2">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <Input
              value={s.name || ''}
              onChange={(e) => setSection(s._key, { name: e.target.value })}
              className="flex-1 min-w-0"
              data-testid={`input-aic-plan-title-${idx}`}
            />
            <div className="flex gap-1">
              <Button size="icon" variant="ghost" onClick={() => move(idx, -1)} disabled={idx === 0} data-testid={`button-aic-plan-up-${idx}`}>
                <ArrowUp className="h-3 w-3" />
              </Button>
              <Button size="icon" variant="ghost" onClick={() => move(idx, 1)} disabled={idx === sections.length - 1} data-testid={`button-aic-plan-down-${idx}`}>
                <ArrowDown className="h-3 w-3" />
              </Button>
              <Button size="icon" variant="ghost" onClick={() => remove(s._key)} disabled={sections.length <= 1} data-testid={`button-aic-plan-remove-${idx}`}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <Textarea
            value={s.purpose || ''}
            onChange={(e) => setSection(s._key, { purpose: e.target.value })}
            rows={2}
            placeholder="What this section covers"
            data-testid={`input-aic-plan-summary-${idx}`}
          />
          {Array.isArray(s.components) && s.components.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid={`text-aic-plan-components-${idx}`}>
              Recommended components: {s.components.map((c) => c.componentKey || c).join(', ')}
            </p>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={approve} disabled={busy || sections.length === 0} data-testid="button-aic-plan-approve">
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />} Generate from this plan
        </Button>
        {onCancel && (
          <Button size="sm" variant="outline" onClick={onCancel} disabled={busy} data-testid="button-aic-plan-cancel">
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
