// Phase 4: dynamic / data-bound canvas blocks.
//
// Each block fetches live data via the existing tenant-scoped public APIs
// using TanStack Query. The same renderer is used in the editor and on the
// public page; in the editor we add `data-canvas-editor` to suppress link
// navigation. Skeleton/empty states and accessibility metadata are baked in.
import { useMemo, useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Calendar, MapPin, FileText, Newspaper, Heart, Users, Layers,
  CalendarDays, Folder, ArrowRight, Loader2, FormInput, Building2,
  ChevronLeft, ChevronRight, Images,
} from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import {
  BLOCK_TYPES,
  resolveResponsiveValue,
  hasResponsiveOverride,
  writeResponsiveValue,
} from '@/lib/canvasDesign';
import { publicClient } from '@/api/publicClient';
import { base44 } from '@/api/base44Client';

// ---- Shared small primitives (duplicated minimally from registry.jsx to
// keep this file self-contained without forcing big imports).
function Field({ label, children, hint }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-slate-600">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}
function TextField({ label, value, onChange, placeholder, testId, multiline, hint }) {
  const C = multiline ? Textarea : Input;
  return (
    <Field label={label} hint={hint}>
      <C
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={multiline ? 'text-sm' : 'h-8'}
        rows={multiline ? 3 : undefined}
        data-testid={testId}
      />
    </Field>
  );
}
function NumberField({ label, value, onChange, min, max, step, testId }) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="h-8"
        data-testid={testId}
      />
    </Field>
  );
}

// Task #970: per-device numeric field. Renders a single input bound to the
// current toolbar breakpoint. Scalar values display on desktop; tablet/mobile
// show the inherited (cascaded) value as the placeholder so authors can see
// what they would get by leaving the slot blank. The writer collapses to a
// scalar number whenever only the desktop slot is set, so blocks that never
// adopt responsive overrides round-trip byte-identical to today.
function ResponsiveNumberField({ label, value, onChange, breakpoint, min, max, step, testId, hint }) {
  const bp = breakpoint || 'desktop';
  const ownVal = hasResponsiveOverride(value, bp)
    ? (typeof value === 'number' ? value : value[bp])
    : null;
  const inherited = bp === 'desktop'
    ? null
    : resolveResponsiveValue(value, bp === 'mobile' ? 'tablet' : 'desktop');
  const placeholder = bp !== 'desktop' && Number.isFinite(inherited)
    ? `${inherited} (inherit)`
    : (bp !== 'desktop' ? 'inherit' : '');
  return (
    <Field label={`${label}${bp !== 'desktop' ? ` (${bp})` : ''}`} hint={hint}>
      <Input
        type="number"
        value={Number.isFinite(ownVal) ? ownVal : ''}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          const next = raw === '' ? null : Number(raw);
          onChange(writeResponsiveValue(value, bp, Number.isFinite(next) ? next : null));
        }}
        className="h-8"
        data-testid={testId}
      />
    </Field>
  );
}
function SelectField({ label, value, onChange, options, testId }) {
  return (
    <Field label={label}>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="h-8" data-testid={testId}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
function ToggleField({ label, value, onChange, testId }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <Switch checked={!!value} onCheckedChange={onChange} data-testid={testId} />
        <span className="text-xs text-slate-600">{value ? 'On' : 'Off'}</span>
      </div>
    </Field>
  );
}

// Local colour input — mirrors the one in registry.jsx (this file keeps its
// own copies of inspector primitives to stay self-contained). Empty string
// means "unset" so renderers can fall back to defaults.
function ColorField({ label, value, onChange, testId }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-10 rounded border border-slate-200 cursor-pointer"
          data-testid={testId}
        />
        <Input
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="(unset)"
          className="h-8 flex-1 font-mono text-xs"
        />
      </div>
    </Field>
  );
}

function PerBreakpointColumns({ value = {}, onChange }) {
  const v = { desktop: 3, tablet: 2, mobile: 1, ...value };
  const set = (bp, n) => onChange({ ...v, [bp]: Math.max(1, Math.min(6, Number(n) || 1)) });
  return (
    <Field
      label="Columns per breakpoint"
      hint="Used by list blocks to decide grid columns at each breakpoint."
    >
      <div className="grid grid-cols-3 gap-2">
        {['desktop', 'tablet', 'mobile'].map((bp) => (
          <div key={bp} className="space-y-1">
            <Label className="text-[10px] uppercase text-slate-500">{bp}</Label>
            <Input
              type="number"
              min={1}
              max={6}
              value={v[bp]}
              onChange={(e) => set(bp, e.target.value)}
              className="h-8"
              data-testid={`input-columns-${bp}`}
            />
          </div>
        ))}
      </div>
    </Field>
  );
}

function ListSkeleton({ count = 3, columns = 3, gap = 16 }) {
  const items = Array.from({ length: count });
  return (
    <div
      className="w-full"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap,
      }}
      aria-busy="true"
      data-testid="skeleton-list"
    >
      {items.map((_, i) => (
        <div key={i} className="rounded-md border border-slate-200 bg-white overflow-hidden">
          <div className="aspect-[16/9] bg-slate-100 animate-pulse" />
          <div className="p-3 space-y-2">
            <div className="h-3 bg-slate-200 rounded animate-pulse w-2/3" />
            <div className="h-3 bg-slate-100 rounded animate-pulse w-full" />
            <div className="h-3 bg-slate-100 rounded animate-pulse w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon: Icon = FileText, text }) {
  return (
    <div
      className="w-full h-full min-h-[120px] flex flex-col items-center justify-center text-center px-6 py-8 text-slate-500"
      data-testid="empty-state"
    >
      <Icon className="w-8 h-8 mb-2 text-slate-400" aria-hidden="true" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

function ErrorState({ message }) {
  return (
    <div
      className="w-full h-full min-h-[120px] flex items-center justify-center text-center px-6 py-8 text-rose-600"
      role="alert"
      data-testid="error-state"
    >
      <p className="text-sm">{message || 'Failed to load content.'}</p>
    </div>
  );
}

function columnsForBreakpoint(content, breakpoint) {
  const c = content?.columns || {};
  return Math.max(1, Math.min(6, c[breakpoint] || c.desktop || 1));
}

function gridStyle(cols, gap) {
  return {
    display: 'grid',
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gap: gap ?? 16,
  };
}

function Heading({ level = 2, children }) {
  const H = `h${Math.max(1, Math.min(6, level))}`;
  return <H className="text-xl font-semibold mb-3 text-slate-900">{children}</H>;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch { return ''; }
}

function formatCurrency(amount, currency) {
  const symbols = { GBP: '£', USD: '$', EUR: '€' };
  const sym = symbols[currency] || (currency ? currency + ' ' : '');
  return `${sym}${(Number(amount) || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// ============================================================================
// EVENT LIST
// ============================================================================
function filterAndSortEvents(events, content) {
  let list = Array.isArray(events) ? events.slice() : [];
  const now = Date.now();
  if (content.filter === 'upcoming') {
    list = list.filter((e) => e.start_date && new Date(e.start_date).getTime() >= now);
  } else if (content.filter === 'past') {
    list = list.filter((e) => e.start_date && new Date(e.start_date).getTime() < now);
  } else if (content.filter === 'all' && !content.showPast) {
    list = list.filter((e) => e.start_date && new Date(e.start_date).getTime() >= now);
  }
  if (content.dateFrom) {
    const from = new Date(content.dateFrom).getTime();
    if (!Number.isNaN(from)) list = list.filter((e) => e.start_date && new Date(e.start_date).getTime() >= from);
  }
  if (content.dateTo) {
    const to = new Date(content.dateTo).getTime();
    if (!Number.isNaN(to)) list = list.filter((e) => e.start_date && new Date(e.start_date).getTime() <= to);
  }
  if (content.featuredOnly) list = list.filter((e) => e.is_featured);
  if (content.programTag) {
    const tag = String(content.programTag).toLowerCase();
    list = list.filter((e) => String(e.program_tag || '').toLowerCase() === tag);
  }
  if (content.category) {
    const cat = String(content.category).toLowerCase();
    list = list.filter((e) => {
      const fields = [e.category, e.event_category, e.event_type].filter(Boolean).map((v) => String(v).toLowerCase());
      const tags = Array.isArray(e.tags) ? e.tags.map((t) => String(t).toLowerCase()) : [];
      return fields.includes(cat) || tags.includes(cat);
    });
  }
  list.sort((a, b) => {
    const ta = a.start_date ? new Date(a.start_date).getTime() : 0;
    const tb = b.start_date ? new Date(b.start_date).getTime() : 0;
    return content.sortBy === 'start-desc' ? tb - ta : ta - tb;
  });
  if (content.limit && content.limit > 0) list = list.slice(0, content.limit);
  return list;
}

function EventListRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const cols = columnsForBreakpoint(c, breakpoint);
  const layout = c.layout || 'grid';
  const effectiveCols = layout === 'list' ? 1 : cols;
  const { data, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-events'],
    queryFn: () => publicClient.listEvents(),
    staleTime: 60_000,
  });

  const items = useMemo(() => filterAndSortEvents(data, c), [data, c]);

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || c.title || 'Events'}>
      {c.title ? <Heading level={c.headingLevel || 2}>{c.title}</Heading> : null}
      {isLoading ? (
        <ListSkeleton count={Math.min(c.limit || 6, 6)} columns={effectiveCols} gap={c.gap} />
      ) : isError ? (
        <ErrorState message="Couldn't load events right now." />
      ) : items.length === 0 ? (
        <EmptyState icon={Calendar} text={c.emptyText || 'No events to show.'} />
      ) : (
        <ul className="list-none m-0 p-0" style={gridStyle(effectiveCols, c.gap)} data-testid="event-list">
          {items.map((e) => (
            <li
              key={e.id}
              className={`rounded-md border border-slate-200 bg-white overflow-hidden ${layout === 'list' ? 'flex flex-row' : 'flex flex-col'}`}
            >
              {e.image_url ? (
                <div className={layout === 'list' ? 'w-32 shrink-0 bg-slate-100' : 'aspect-[16/9] bg-slate-100'}>
                  <img src={e.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                </div>
              ) : null}
              <div className="p-3 flex-1 flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-slate-900 m-0">{e.title}</h3>
                <div className="text-xs text-slate-600 flex items-center gap-1">
                  <Calendar className="w-3 h-3" aria-hidden="true" />
                  {formatDate(e.start_date)}
                </div>
                {e.location ? (
                  <div className="text-xs text-slate-600 flex items-center gap-1">
                    <MapPin className="w-3 h-3" aria-hidden="true" />
                    <span className="truncate">{e.location}</span>
                  </div>
                ) : null}
                {e.summary ? <p className="text-xs text-slate-600 line-clamp-3 mt-1">{e.summary}</p> : null}
                <a
                  href={asEditor ? undefined : `/Events/${encodeURIComponent(e.slug || e.id)}`}
                  onClick={(ev) => { if (asEditor) ev.preventDefault(); }}
                  className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 mt-auto pt-2"
                  data-testid={`link-event-${e.id}`}
                >
                  {c.ctaLabel || 'View details'} <ArrowRight className="w-3 h-3" />
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventListInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <TextField label="Heading" value={c.title} onChange={(v) => set({ title: v })} testId="input-event-list-title" />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 2)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[2, 3, 4].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-event-list-heading-level"
      />
      <SelectField
        label="Filter"
        value={c.filter || 'upcoming'}
        onChange={(v) => set({ filter: v })}
        options={[
          { value: 'upcoming', label: 'Upcoming only' },
          { value: 'past', label: 'Past only' },
          { value: 'all', label: 'All' },
        ]}
        testId="select-event-list-filter"
      />
      <ToggleField
        label="Show past events (when filter = All)"
        value={!!c.showPast}
        onChange={(v) => set({ showPast: v })}
        testId="toggle-event-list-show-past"
      />
      <TextField label="Date from (YYYY-MM-DD)" value={c.dateFrom} onChange={(v) => set({ dateFrom: v })} testId="input-event-list-date-from" />
      <TextField label="Date to (YYYY-MM-DD)" value={c.dateTo} onChange={(v) => set({ dateTo: v })} testId="input-event-list-date-to" />
      <ToggleField label="Featured only" value={c.featuredOnly} onChange={(v) => set({ featuredOnly: v })} testId="toggle-event-list-featured" />
      <TextField label="Program tag" value={c.programTag} onChange={(v) => set({ programTag: v })} testId="input-event-list-program-tag" />
      <TextField label="Category" value={c.category} onChange={(v) => set({ category: v })} testId="input-event-list-category" hint="Matches event category / type or tag." />
      <SelectField
        label="Sort"
        value={c.sortBy || 'start-asc'}
        onChange={(v) => set({ sortBy: v })}
        options={[
          { value: 'start-asc', label: 'Start date (earliest first)' },
          { value: 'start-desc', label: 'Start date (latest first)' },
        ]}
        testId="select-event-list-sort"
      />
      <SelectField
        label="Layout"
        value={c.layout || 'grid'}
        onChange={(v) => set({ layout: v })}
        options={[
          { value: 'grid', label: 'Grid of cards' },
          { value: 'list', label: 'Stacked list rows' },
        ]}
        testId="select-event-list-layout"
      />
      <NumberField label="Limit" min={1} max={50} value={c.limit || 6} onChange={(v) => set({ limit: Math.max(1, Number(v) || 1) })} testId="input-event-list-limit" />
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap || 16} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-event-list-gap" />
      <TextField label="CTA label" value={c.ctaLabel} onChange={(v) => set({ ctaLabel: v })} testId="input-event-list-cta" />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-event-list-empty" />
    </>
  );
}

// ============================================================================
// EVENT TEASER (detail card for a single event)
// ============================================================================
function EventTeaserRender({ block, asEditor }) {
  const c = block.content || {};
  const { data: event, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-event', c.eventSlug || c.eventId],
    queryFn: async () => {
      if (c.eventSlug) return publicClient.getEventBySlug(c.eventSlug);
      if (c.eventId) return publicClient.getEvent(c.eventId);
      return null;
    },
    enabled: !!(c.eventSlug || c.eventId),
    staleTime: 60_000,
  });

  if (!c.eventSlug && !c.eventId) {
    return <EmptyState icon={Calendar} text="Pick an event in the inspector." />;
  }
  if (isLoading) return <ListSkeleton count={1} columns={1} gap={0} />;
  if (isError || !event) return <ErrorState message="Event not found or unavailable." />;

  return (
    <article className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || event.title}>
      {c.showImage !== false && event.image_url ? (
        <div className="aspect-[16/9] bg-slate-100 rounded overflow-hidden mb-3">
          <img src={event.image_url} alt="" className="w-full h-full object-cover" />
        </div>
      ) : null}
      <h3 className="text-lg font-semibold text-slate-900 m-0">{event.title}</h3>
      <div className="text-sm text-slate-600 flex items-center gap-1 mt-1">
        <Calendar className="w-4 h-4" aria-hidden="true" />
        {formatDate(event.start_date)}
      </div>
      {event.location ? (
        <div className="text-sm text-slate-600 flex items-center gap-1 mt-1">
          <MapPin className="w-4 h-4" aria-hidden="true" />
          {event.location}
        </div>
      ) : null}
      {c.showSummary !== false && (event.summary || event.description) ? (
        <p className="text-sm text-slate-700 mt-2 line-clamp-4">
          {event.summary || String(event.description || '').replace(/<[^>]+>/g, '').slice(0, 280)}
        </p>
      ) : null}
      {c.showCta !== false ? (
        <a
          href={asEditor ? undefined : `/Events/${encodeURIComponent(event.slug || event.id)}`}
          onClick={(e) => { if (asEditor) e.preventDefault(); }}
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mt-3"
          data-testid="link-event-teaser-cta"
          aria-label={`${c.ctaLabel || 'Find out more'}: ${event.title || 'event'}`}
        >
          {c.ctaLabel || 'Find out more'} <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </a>
      ) : null}
    </article>
  );
}

function EventPickerField({ value, onChange, testId }) {
  const { data: events, isLoading } = useQuery({
    queryKey: ['canvas', 'public-events'],
    queryFn: () => publicClient.listEvents(),
    staleTime: 60_000,
  });
  const options = (events || []).map((e) => ({ value: e.slug || String(e.id), label: e.title }));
  return (
    <Field label="Event" hint={isLoading ? 'Loading events…' : null}>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="h-8" data-testid={testId}><SelectValue placeholder="Select an event" /></SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <SelectItem value="__none__" disabled>No events available</SelectItem>
          ) : options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function EventTeaserInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <EventPickerField
        value={c.eventSlug || c.eventId}
        onChange={(v) => set({ eventSlug: v, eventId: '' })}
        testId="select-event-teaser"
      />
      <ToggleField label="Show image" value={c.showImage !== false} onChange={(v) => set({ showImage: v })} testId="toggle-event-teaser-image" />
      <ToggleField label="Show summary" value={c.showSummary !== false} onChange={(v) => set({ showSummary: v })} testId="toggle-event-teaser-summary" />
      <ToggleField label="Show CTA" value={c.showCta !== false} onChange={(v) => set({ showCta: v })} testId="toggle-event-teaser-cta" />
      <TextField label="CTA label" value={c.ctaLabel} onChange={(v) => set({ ctaLabel: v })} testId="input-event-teaser-cta-label" />
    </>
  );
}

// ============================================================================
// EVENT CAROUSEL (50/50 split cards rotating through selected events)
// ============================================================================
function CarouselArrayList({ items, onChange, renderItem, makeNew, addLabel, testIdPrefix }) {
  return (
    <div className="space-y-2">
      {(items || []).map((item, idx) => (
        <div
          key={idx}
          className="space-y-2 p-2 rounded-md border border-slate-200 bg-slate-50"
          data-testid={`${testIdPrefix}-item-${idx}`}
        >
          {renderItem(item, idx, (patch) => {
            const next = [...items];
            next[idx] = typeof patch === 'object' && patch !== null && !Array.isArray(patch)
              ? { ...next[idx], ...patch }
              : patch;
            onChange(next);
          })}
          <div className="flex items-center justify-end gap-1">
            {idx > 0 && (
              <Button
                size="sm" variant="ghost" type="button"
                onClick={() => {
                  const next = [...items];
                  [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                  onChange(next);
                }}
                data-testid={`${testIdPrefix}-up-${idx}`}
              >Up</Button>
            )}
            {idx < items.length - 1 && (
              <Button
                size="sm" variant="ghost" type="button"
                onClick={() => {
                  const next = [...items];
                  [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
                  onChange(next);
                }}
                data-testid={`${testIdPrefix}-down-${idx}`}
              >Down</Button>
            )}
            <Button
              size="sm" variant="ghost" type="button"
              onClick={() => onChange((items || []).filter((_, i) => i !== idx))}
              data-testid={`${testIdPrefix}-remove-${idx}`}
            >Remove</Button>
          </div>
        </div>
      ))}
      <Button
        size="sm" variant="outline" type="button"
        onClick={() => onChange([...(items || []), makeNew()])}
        data-testid={`${testIdPrefix}-add`}
      >
        {addLabel || 'Add'}
      </Button>
    </div>
  );
}

function aspectClassForRatio(ratio) {
  switch (ratio) {
    case '1/1': return 'aspect-square';
    case '16/9': return 'aspect-[16/9]';
    case '3/2': return 'aspect-[3/2]';
    case '21/9': return 'aspect-[21/9]';
    case '4/3':
    default: return 'aspect-[4/3]';
  }
}

function EventCarouselRender({ block, asEditor, breakpoint }) {
  const c = block.content || {};
  const eventIds = Array.isArray(c.eventIds) ? c.eventIds.filter(Boolean) : [];
  const { data: allEvents, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-events'],
    queryFn: () => publicClient.listEvents(),
    staleTime: 60_000,
    enabled: eventIds.length > 0,
  });

  const items = useMemo(() => {
    if (!Array.isArray(allEvents) || eventIds.length === 0) return [];
    const byKey = new Map();
    for (const e of allEvents) {
      if (e.slug) byKey.set(String(e.slug), e);
      if (e.id != null) byKey.set(String(e.id), e);
    }
    return eventIds.map((k) => byKey.get(String(k))).filter(Boolean);
  }, [allEvents, eventIds]);

  const [index, setIndex] = useState(0);
  const [autoplayPausedAt, setAutoplayPausedAt] = useState(0);
  const touchStartRef = useRef(null);
  const rootRef = useRef(null);
  // Stacked layout when the block's own rendered width is below this
  // threshold, regardless of viewport size. ~640px matches Tailwind's
  // `md` breakpoint so the desktop look-and-feel is preserved.
  const STACKED_BREAKPOINT_PX = 640;
  const [measuredStacked, setMeasuredStacked] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = (w) => setMeasuredStacked(w > 0 && w < STACKED_BREAKPOINT_PX);
    update(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect ? entry.contentRect.width : entry.target.getBoundingClientRect().width;
        update(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // When the editor (or public renderer) explicitly forces a tablet or
  // mobile breakpoint, stack regardless of the measured container width
  // — in the canvas the stage width changes but the block's geometry
  // width may still be desktop-sized. When no breakpoint is forced
  // (e.g. on the live public site without `?_bp=`), fall back to the
  // ResizeObserver-measured width.
  const isStacked = breakpoint === 'mobile' || breakpoint === 'tablet'
    ? true
    : measuredStacked;
  useEffect(() => {
    if (index > Math.max(0, items.length - 1)) setIndex(0);
  }, [items.length, index]);

  useEffect(() => {
    if (asEditor) return;
    if (!c.autoplay || items.length < 2) return;
    const ms = Math.max(1500, Number(c.autoplayMs) || 5000);
    const pauseMs = Math.max(ms, 4000);
    const t = setInterval(() => {
      if (autoplayPausedAt && Date.now() - autoplayPausedAt < pauseMs) return;
      setIndex((i) => (i + 1) % items.length);
    }, ms);
    return () => clearInterval(t);
  }, [asEditor, c.autoplay, c.autoplayMs, items.length, autoplayPausedAt]);

  const goPrev = () => setIndex((i) => (i - 1 + items.length) % items.length);
  const goNext = () => setIndex((i) => (i + 1) % items.length);

  const handleTouchStart = (ev) => {
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
  };
  const handleTouchEnd = (ev) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || items.length < 2) return;
    const t = ev.changedTouches && ev.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const SWIPE_THRESHOLD = 40;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    if (Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) goNext(); else goPrev();
    setAutoplayPausedAt(Date.now());
  };
  const handleKeyDown = (ev) => {
    if (items.length < 2) return;
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      goPrev();
      setAutoplayPausedAt(Date.now());
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      goNext();
      setAutoplayPausedAt(Date.now());
    }
  };

  if (eventIds.length === 0) {
    return <EmptyState icon={Images} text={c.emptyText || 'Pick one or more events in the inspector.'} />;
  }
  if (isLoading) return <ListSkeleton count={1} columns={1} gap={0} />;
  if (isError) return <ErrorState message="Couldn't load events right now." />;
  if (items.length === 0) {
    return <EmptyState icon={Images} text="Selected events are unavailable." />;
  }

  const event = items[Math.min(index, items.length - 1)];
  const imageSide = c.imageSide === 'right' ? 'right' : 'left';
  const aspectCls = aspectClassForRatio(c.imageAspect || '4/3');
  const hasMany = items.length > 1;
  const showArrows = hasMany && c.showArrows !== false;
  const showIndicators = hasMany && c.showIndicators !== false;

  // In stacked mode the image is always first (order-1) and the content
  // follows; in side-by-side mode imageSide controls the column order.
  const imageOrderCls = isStacked ? 'order-1' : (imageSide === 'right' ? 'order-2' : 'order-1');
  const contentOrderCls = isStacked ? 'order-2' : (imageSide === 'right' ? 'order-1' : 'order-2');

  // Task #966: per-block style overrides. Each branch reads the field as
  // either a finite number (size) or a non-empty string (colour); when
  // unset the renderer falls through to the previous Tailwind classes,
  // so old saved blocks render byte-identical to today.
  // Task #970: raw-px text/icon fields are now per-device. `resolveResponsiveValue`
  // accepts either a legacy scalar (byte-identical to pre-#970 blocks) or the
  // new `{ desktop?, tablet?, mobile? }` object and cascades mobile→tablet→desktop.
  const dateFontSize = resolveResponsiveValue(c.dateFontSize, breakpoint);
  const titleFontSize = resolveResponsiveValue(c.titleFontSize, breakpoint);
  const summaryFontSize = resolveResponsiveValue(c.summaryFontSize, breakpoint);
  const titleLineHeightV = resolveResponsiveValue(c.titleLineHeight, breakpoint);
  const summaryLineHeightV = resolveResponsiveValue(c.summaryLineHeight, breakpoint);
  const dateIconSizeV = resolveResponsiveValue(c.dateIconSize, breakpoint);
  const placeholderIconSizeV = resolveResponsiveValue(c.placeholderIconSize, breakpoint);

  const dateStyle = {};
  if (Number.isFinite(dateFontSize)) dateStyle.fontSize = `${dateFontSize}px`;
  if (c.dateColor) dateStyle.color = c.dateColor;
  const titleStyle = {};
  if (Number.isFinite(titleFontSize)) titleStyle.fontSize = `${titleFontSize}px`;
  if (c.titleColor) titleStyle.color = c.titleColor;
  const summaryStyle = {};
  if (Number.isFinite(summaryFontSize)) summaryStyle.fontSize = `${summaryFontSize}px`;
  if (c.summaryColor) summaryStyle.color = c.summaryColor;

  const arrowStyle = Number.isFinite(c.arrowRadius)
    ? { borderRadius: `${c.arrowRadius}px` }
    : null;
  // When borderRadius is set inline we strip `rounded-full` so the
  // override actually wins (Tailwind's `rounded-full` is `border-radius:
  // 9999px` which inline rules don't reliably beat in every browser).
  const arrowRadiusCls = arrowStyle ? '' : 'rounded-full';

  const dotSize = Number.isFinite(c.dotSize) && c.dotSize > 0 ? c.dotSize : null;
  const dotInactiveColor = c.dotInactiveColor || '';
  const dotActiveColor = c.dotActiveColor || '';

  // Task #968: line spacing (title + summary) and calendar icon sizing.
  // Unitless line-height is applied inline only when a positive finite
  // number is set, so the existing Tailwind defaults remain when blank.
  if (Number.isFinite(titleLineHeightV) && titleLineHeightV > 0) {
    titleStyle.lineHeight = titleLineHeightV;
  }
  if (Number.isFinite(summaryLineHeightV) && summaryLineHeightV > 0) {
    summaryStyle.lineHeight = summaryLineHeightV;
  }
  // Per-icon overrides — when unset we keep the original Tailwind w-3 h-3
  // (date row) and w-10 h-10 (no-image placeholder).
  const dateIconSize = Number.isFinite(dateIconSizeV) && dateIconSizeV > 0 ? dateIconSizeV : null;
  const placeholderIconSize = Number.isFinite(placeholderIconSizeV) && placeholderIconSizeV > 0
    ? placeholderIconSizeV : null;
  const dateIconCls = dateIconSize ? '' : 'w-3 h-3';
  const dateIconStyle = dateIconSize ? { width: `${dateIconSize}px`, height: `${dateIconSize}px` } : undefined;
  const placeholderIconCls = placeholderIconSize ? '' : 'w-10 h-10';
  const placeholderIconStyle = placeholderIconSize
    ? { width: `${placeholderIconSize}px`, height: `${placeholderIconSize}px` }
    : undefined;

  // Task #968: container drop-shadow preset. `none` (or unset) keeps the
  // block byte-identical to today. Tailwind's `shadow-*` paints the
  // box-shadow OUTSIDE the element, so the existing `overflow-hidden`
  // on the root does not clip it.
  const DROP_SHADOW_CLS = {
    sm: 'shadow-sm',
    md: 'shadow',
    lg: 'shadow-lg',
    xl: 'shadow-xl',
  };
  const dropShadowCls = DROP_SHADOW_CLS[c.dropShadow] || '';

  // Featured badge sits on the image in the corner opposite the content
  // side, so the eye reads badge → image → content. Image-left ⇒ badge
  // top-right; image-right ⇒ badge top-left.
  const showFeaturedBadge = !!c.showFeaturedBadge && !!event.is_featured;
  const featuredBadgeLabel = c.featuredBadgeLabel || 'Featured event';
  const featuredBadgeStyle = {
    backgroundColor: c.featuredBadgeBg || '#0f172a',
    color: c.featuredBadgeColor || '#ffffff',
  };
  // In stacked mode the image spans the full width, so the badge sits in
  // the top-right corner of the image. In side-by-side mode the badge
  // hugs the corner opposite the content column.
  const featuredBadgePosCls = isStacked
    ? 'top-2 right-2'
    : (imageSide === 'right' ? 'top-2 left-2' : 'top-2 right-2');

  return (
    <div
      ref={rootRef}
      className={`relative w-full h-full overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500${dropShadowCls ? ` ${dropShadowCls}` : ''}`}
      aria-label={block.a11y?.ariaLabel || event.title || 'Event carousel'}
      data-testid="event-carousel"
      role="region"
      aria-roledescription="carousel"
      tabIndex={hasMany ? 0 : -1}
      onTouchStart={hasMany ? handleTouchStart : undefined}
      onTouchEnd={hasMany ? handleTouchEnd : undefined}
      onKeyDown={hasMany ? handleKeyDown : undefined}
      style={hasMany ? { touchAction: 'pan-y' } : undefined}
    >
      <div className={`flex ${isStacked ? 'flex-col' : 'flex-row'} w-full h-full`}>
        {/* Image is always first in source order so it stacks above the
            content on narrow rendering containers; in side-by-side mode
            ordering is controlled by imageSide via order-* utilities. */}
        <div className={`relative bg-slate-100 overflow-hidden ${imageOrderCls} ${isStacked ? `w-full ${aspectCls}` : 'w-1/2 h-full'}`}>
          {event.image_url ? (
            <img
              src={event.image_url}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-400">
              <Calendar className={placeholderIconCls} style={placeholderIconStyle} aria-hidden="true" />
            </div>
          )}
          {showFeaturedBadge ? (
            <span
              className={`absolute ${featuredBadgePosCls} inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium shadow-sm`}
              style={featuredBadgeStyle}
              data-testid="badge-event-carousel-featured"
            >
              {featuredBadgeLabel}
            </span>
          ) : null}
        </div>
        <div className={`flex flex-col gap-2 justify-center min-w-0 ${contentOrderCls} ${isStacked ? 'w-full p-4' : 'w-1/2 p-6'}`}>
          {c.showDate !== false && event.start_date ? (
            <div className="text-xs text-slate-600 flex items-center gap-1" style={dateStyle}>
              <Calendar className={dateIconCls} style={dateIconStyle} aria-hidden="true" />
              {formatDate(event.start_date)}
            </div>
          ) : null}
          <h3 className="text-lg font-semibold text-slate-900 m-0 line-clamp-2" style={titleStyle}>{event.title}</h3>
          {c.showSummary !== false && (event.summary || event.description) ? (
            <p className="text-sm text-slate-600 line-clamp-3 m-0" style={summaryStyle}>
              {event.summary || String(event.description || '').replace(/<[^>]+>/g, '').slice(0, 240)}
            </p>
          ) : null}
          <div className="mt-1">
            <a
              href={asEditor ? undefined : `/Events/${encodeURIComponent(event.slug || event.id)}`}
              onClick={(ev) => { if (asEditor) ev.preventDefault(); }}
              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
              data-testid={`link-event-carousel-${event.id}`}
              aria-label={`${c.ctaLabel || 'Find out more'}: ${event.title || 'event'}`}
            >
              {c.ctaLabel || 'Find out more'} <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
      {showArrows ? (
        <>
          <button
            type="button"
            onClick={() => { goPrev(); setAutoplayPausedAt(Date.now()); }}
            className={`absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 ${arrowRadiusCls} bg-white/80 hover:bg-white border border-slate-200 flex items-center justify-center shadow-sm`}
            style={arrowStyle || undefined}
            aria-label="Previous event"
            data-testid="button-event-carousel-prev"
          >
            <ChevronLeft className="w-4 h-4 text-slate-700" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => { goNext(); setAutoplayPausedAt(Date.now()); }}
            className={`absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 ${arrowRadiusCls} bg-white/80 hover:bg-white border border-slate-200 flex items-center justify-center shadow-sm`}
            style={arrowStyle || undefined}
            aria-label="Next event"
            data-testid="button-event-carousel-next"
          >
            <ChevronRight className="w-4 h-4 text-slate-700" aria-hidden="true" />
          </button>
        </>
      ) : null}
      {showIndicators ? (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
          {items.map((it, i) => {
            const active = i === index;
            // Build size + colour overrides only when set, so unset dots
            // keep the original Tailwind `w-2 h-2 bg-slate-900 / bg-slate-400/70`.
            const dotStyle = {};
            if (dotSize) { dotStyle.width = `${dotSize}px`; dotStyle.height = `${dotSize}px`; }
            if (active && dotActiveColor) dotStyle.backgroundColor = dotActiveColor;
            if (!active && dotInactiveColor) dotStyle.backgroundColor = dotInactiveColor;
            const sizeCls = dotSize ? '' : 'w-2 h-2';
            const colorCls = active
              ? (dotActiveColor ? '' : 'bg-slate-900')
              : (dotInactiveColor ? '' : 'bg-slate-400/70');
            return (
              <button
                key={it.id || i}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show event ${i + 1} of ${items.length}`}
                aria-current={active ? 'true' : undefined}
                className={`${sizeCls} ${colorCls} rounded-full border border-white/80`}
                style={Object.keys(dotStyle).length ? dotStyle : undefined}
                data-testid={`button-event-carousel-indicator-${i}`}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function EventCarouselPickerRow({ value, onChange, testId, disabledValues = [] }) {
  const { data: events, isLoading } = useQuery({
    queryKey: ['canvas', 'public-events'],
    queryFn: () => publicClient.listEvents(),
    staleTime: 60_000,
  });
  const [open, setOpen] = useState(false);
  const options = (events || []).map((e) => ({ value: e.slug || String(e.id), label: e.title || '(untitled)' }));
  const current = options.find((o) => o.value === value);
  const disabledSet = new Set(disabledValues || []);
  return (
    <Field label="Event" hint={isLoading ? 'Loading events…' : null}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full h-8 justify-between font-normal"
            data-testid={testId}
          >
            <span className="truncate text-left">{current ? current.label : 'Select an event'}</span>
            <ChevronRight className="ml-2 h-4 w-4 shrink-0 opacity-50 rotate-90" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[--radix-popover-trigger-width]" align="start">
          <Command>
            <CommandInput placeholder="Search events…" data-testid={`${testId}-search`} />
            <CommandList>
              <CommandEmpty>No events found.</CommandEmpty>
              <CommandGroup>
                {options.map((o) => {
                  const isDisabled = disabledSet.has(o.value) && o.value !== value;
                  return (
                    <CommandItem
                      key={o.value}
                      value={`${o.label} ${o.value}`}
                      disabled={isDisabled}
                      onSelect={() => { onChange(o.value); setOpen(false); }}
                      data-testid={`${testId}-option-${o.value}`}
                    >
                      <span className="truncate">{o.label}</span>
                      {isDisabled ? (
                        <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">Added</span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function EventCarouselInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const ids = Array.isArray(c.eventIds) ? c.eventIds : [];
  return (
    <>
      <Field label="Events" hint="Add one or more events to feature. Use Up/Down to reorder.">
        <CarouselArrayList
          items={ids}
          onChange={(next) => set({ eventIds: next })}
          renderItem={(item, idx, setItem) => (
            <EventCarouselPickerRow
              value={item || ''}
              onChange={(v) => setItem(v)}
              testId={`select-event-carousel-event-${idx}`}
              disabledValues={ids.filter((_, i) => i !== idx)}
            />
          )}
          makeNew={() => ''}
          addLabel="Add event"
          testIdPrefix="event-carousel-events"
        />
      </Field>
      <TextField
        label="CTA label"
        value={c.ctaLabel}
        onChange={(v) => set({ ctaLabel: v })}
        testId="input-event-carousel-cta-label"
      />
      <ToggleField
        label="Show date"
        value={c.showDate !== false}
        onChange={(v) => set({ showDate: v })}
        testId="toggle-event-carousel-date"
      />
      <ToggleField
        label="Show summary"
        value={c.showSummary !== false}
        onChange={(v) => set({ showSummary: v })}
        testId="toggle-event-carousel-summary"
      />
      <SelectField
        label="Image side"
        value={c.imageSide || 'left'}
        onChange={(v) => set({ imageSide: v })}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ]}
        testId="select-event-carousel-image-side"
      />
      <SelectField
        label="Image aspect ratio"
        value={c.imageAspect || '4/3'}
        onChange={(v) => set({ imageAspect: v })}
        options={[
          { value: '4/3', label: '4 : 3' },
          { value: '3/2', label: '3 : 2' },
          { value: '16/9', label: '16 : 9' },
          { value: '1/1', label: '1 : 1 (square)' },
          { value: '21/9', label: '21 : 9 (wide)' },
        ]}
        testId="select-event-carousel-image-aspect"
      />
      <ToggleField
        label="Autoplay"
        value={!!c.autoplay}
        onChange={(v) => set({ autoplay: v })}
        testId="toggle-event-carousel-autoplay"
      />
      <NumberField
        label="Autoplay interval (ms)"
        min={1500}
        value={c.autoplayMs || 5000}
        onChange={(v) => set({ autoplayMs: Math.max(1500, Number(v) || 5000) })}
        testId="input-event-carousel-autoplay-ms"
      />
      <ToggleField
        label="Show prev/next arrows"
        value={c.showArrows !== false}
        onChange={(v) => set({ showArrows: v })}
        testId="toggle-event-carousel-arrows"
      />
      <ToggleField
        label="Show slide indicators"
        value={c.showIndicators !== false}
        onChange={(v) => set({ showIndicators: v })}
        testId="toggle-event-carousel-indicators"
      />

      {/* --- Task #966: per-block text styling. Leaving any field blank
          keeps today's Tailwind defaults so existing blocks are
          byte-identical on save/reload. --- */}
      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Date</Label>
      </div>
      <ResponsiveNumberField
        label="Date font size (px)"
        min={1}
        value={c.dateFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ dateFontSize: v })}
        testId="input-event-carousel-date-font-size"
      />
      <ColorField
        label="Date colour"
        value={c.dateColor}
        onChange={(v) => set({ dateColor: v })}
        testId="color-event-carousel-date"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Title</Label>
      </div>
      <ResponsiveNumberField
        label="Title font size (px)"
        min={1}
        value={c.titleFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ titleFontSize: v })}
        testId="input-event-carousel-title-font-size"
      />
      <ColorField
        label="Title colour"
        value={c.titleColor}
        onChange={(v) => set({ titleColor: v })}
        testId="color-event-carousel-title"
      />
      <ResponsiveNumberField
        label="Title line spacing"
        min={0.5}
        max={3}
        step={0.05}
        value={c.titleLineHeight}
        breakpoint={breakpoint}
        onChange={(v) => set({ titleLineHeight: v })}
        testId="input-event-carousel-title-line-height"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Summary</Label>
      </div>
      <ResponsiveNumberField
        label="Summary font size (px)"
        min={1}
        value={c.summaryFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ summaryFontSize: v })}
        testId="input-event-carousel-summary-font-size"
      />
      <ColorField
        label="Summary colour"
        value={c.summaryColor}
        onChange={(v) => set({ summaryColor: v })}
        testId="color-event-carousel-summary"
      />
      <ResponsiveNumberField
        label="Summary line spacing"
        min={0.5}
        max={3}
        step={0.05}
        value={c.summaryLineHeight}
        breakpoint={breakpoint}
        onChange={(v) => set({ summaryLineHeight: v })}
        testId="input-event-carousel-summary-line-height"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Calendar icon</Label>
      </div>
      <ResponsiveNumberField
        label="Date row icon size (px)"
        min={1}
        value={c.dateIconSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ dateIconSize: v })}
        testId="input-event-carousel-date-icon-size"
      />
      <ResponsiveNumberField
        label="No-image placeholder icon size (px)"
        min={1}
        value={c.placeholderIconSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ placeholderIconSize: v })}
        testId="input-event-carousel-placeholder-icon-size"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Container</Label>
      </div>
      <SelectField
        label="Drop shadow"
        value={c.dropShadow || 'none'}
        onChange={(v) => set({ dropShadow: v === 'none' ? null : v })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'sm', label: 'Small' },
          { value: 'md', label: 'Medium' },
          { value: 'lg', label: 'Large' },
          { value: 'xl', label: 'Extra large' },
        ]}
        testId="select-event-carousel-drop-shadow"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Featured badge</Label>
      </div>
      <ToggleField
        label='Show "Featured event" badge'
        value={!!c.showFeaturedBadge}
        onChange={(v) => set({ showFeaturedBadge: v })}
        testId="toggle-event-carousel-featured-badge"
      />
      <TextField
        label="Badge label"
        value={c.featuredBadgeLabel}
        onChange={(v) => set({ featuredBadgeLabel: v })}
        placeholder="Featured event"
        testId="input-event-carousel-featured-label"
      />
      <ColorField
        label="Badge background colour"
        value={c.featuredBadgeBg}
        onChange={(v) => set({ featuredBadgeBg: v })}
        testId="color-event-carousel-featured-bg"
      />
      <ColorField
        label="Badge text colour"
        value={c.featuredBadgeColor}
        onChange={(v) => set({ featuredBadgeColor: v })}
        testId="color-event-carousel-featured-text"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Arrows</Label>
      </div>
      <NumberField
        label="Arrow corner radius (px)"
        min={0}
        value={c.arrowRadius}
        onChange={(v) => set({ arrowRadius: v })}
        testId="input-event-carousel-arrow-radius"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Dots</Label>
      </div>
      <NumberField
        label="Dot size (px)"
        min={1}
        value={c.dotSize}
        onChange={(v) => set({ dotSize: v })}
        testId="input-event-carousel-dot-size"
      />
      <ColorField
        label="Active dot colour"
        value={c.dotActiveColor}
        onChange={(v) => set({ dotActiveColor: v })}
        testId="color-event-carousel-dot-active"
      />
      <ColorField
        label="Inactive dot colour"
        value={c.dotInactiveColor}
        onChange={(v) => set({ dotInactiveColor: v })}
        testId="color-event-carousel-dot-inactive"
      />

      <TextField
        label="Empty state text"
        value={c.emptyText}
        onChange={(v) => set({ emptyText: v })}
        testId="input-event-carousel-empty"
      />
    </>
  );
}

// ============================================================================
// ARTICLE / NEWS LIST
// ============================================================================
function ArticleListRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const cols = columnsForBreakpoint(c, breakpoint);
  const source = c.source === 'news' ? 'news' : 'articles';
  const layout = c.layout || 'grid';
  const { data, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-' + source],
    queryFn: () => (source === 'news' ? publicClient.listNews() : publicClient.listArticles()),
    staleTime: 60_000,
  });

  // /api/public/articles returns { articles, authors, guestWriters };
  // /api/public/news returns an array directly.
  const items = useMemo(() => {
    const raw = source === 'news'
      ? (Array.isArray(data) ? data : [])
      : (Array.isArray(data?.articles) ? data.articles : []);
    let list = raw.slice();
    if (c.tag) {
      const tag = String(c.tag).toLowerCase();
      list = list.filter((a) => Array.isArray(a.tags) && a.tags.some((t) => String(t).toLowerCase() === tag));
    }
    if (c.category) {
      const cat = String(c.category).toLowerCase();
      list = list.filter((a) => Array.isArray(a.subcategories) && a.subcategories.some((s) => String(s).toLowerCase() === cat));
    }
    if (c.sortBy === 'date-asc') {
      list.sort((a, b) => new Date(a.published_date || 0) - new Date(b.published_date || 0));
    } else {
      list.sort((a, b) => new Date(b.published_date || 0) - new Date(a.published_date || 0));
    }
    if (c.featuredFirst) {
      list.sort((a, b) => (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0));
    }
    if (c.limit && c.limit > 0) list = list.slice(0, c.limit);
    return list;
  }, [data, source, c.tag, c.category, c.sortBy, c.featuredFirst, c.limit]);

  const linkBase = source === 'news' ? '/NewsView?slug=' : '/Articles?slug=';
  const effectiveCols = layout === 'list' ? 1 : cols;

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || c.title || 'Articles'}>
      {c.title ? <Heading level={c.headingLevel || 2}>{c.title}</Heading> : null}
      {isLoading ? (
        <ListSkeleton count={Math.min(c.limit || 6, 6)} columns={effectiveCols} gap={c.gap} />
      ) : isError ? (
        <ErrorState message="Couldn't load articles right now." />
      ) : items.length === 0 ? (
        <EmptyState icon={Newspaper} text={c.emptyText || 'No articles yet.'} />
      ) : (
        <ul className="list-none m-0 p-0" style={gridStyle(effectiveCols, c.gap)} data-testid="article-list">
          {items.map((a) => (
            <li
              key={a.id}
              className={`rounded-md border border-slate-200 bg-white overflow-hidden ${layout === 'list' ? 'flex flex-row' : 'flex flex-col'}`}
            >
              {c.showImage !== false && a.feature_image_url ? (
                <div className={layout === 'list' ? 'w-32 shrink-0 bg-slate-100' : 'aspect-[16/9] bg-slate-100'}>
                  <img src={a.feature_image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                </div>
              ) : null}
              <div className="p-3 flex-1 flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-slate-900 m-0">{a.title}</h3>
                {a.published_date ? (
                  <div className="text-xs text-slate-500">{formatDate(a.published_date)}</div>
                ) : null}
                {c.showSummary !== false && a.summary ? (
                  <p className="text-xs text-slate-600 line-clamp-3 mt-1">{a.summary}</p>
                ) : null}
                <a
                  href={asEditor ? undefined : `${linkBase}${encodeURIComponent(a.slug || a.id)}`}
                  onClick={(ev) => { if (asEditor) ev.preventDefault(); }}
                  className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 mt-auto pt-2"
                  data-testid={`link-article-${a.id}`}
                >
                  Read more <ArrowRight className="w-3 h-3" />
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArticleListInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <SelectField
        label="Source"
        value={c.source || 'articles'}
        onChange={(v) => set({ source: v })}
        options={[
          { value: 'articles', label: 'Articles / blog' },
          { value: 'news', label: 'News' },
        ]}
        testId="select-article-list-source"
      />
      <TextField label="Heading" value={c.title} onChange={(v) => set({ title: v })} testId="input-article-list-title" />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 2)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[2, 3, 4].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-article-list-heading-level"
      />
      <TextField label="Filter tag" value={c.tag} onChange={(v) => set({ tag: v })} testId="input-article-list-tag" />
      <TextField label="Filter category" value={c.category} onChange={(v) => set({ category: v })} testId="input-article-list-category" />
      <SelectField
        label="Sort"
        value={c.sortBy || 'date-desc'}
        onChange={(v) => set({ sortBy: v })}
        options={[
          { value: 'date-desc', label: 'Newest first' },
          { value: 'date-asc', label: 'Oldest first' },
        ]}
        testId="select-article-list-sort"
      />
      <SelectField
        label="Layout"
        value={c.layout || 'grid'}
        onChange={(v) => set({ layout: v })}
        options={[
          { value: 'grid', label: 'Grid' },
          { value: 'list', label: 'List (stacked rows)' },
        ]}
        testId="select-article-list-layout"
      />
      <NumberField label="Limit" min={1} max={50} value={c.limit || 6} onChange={(v) => set({ limit: Math.max(1, Number(v) || 1) })} testId="input-article-list-limit" />
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap || 16} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-article-list-gap" />
      <ToggleField label="Show image" value={c.showImage !== false} onChange={(v) => set({ showImage: v })} testId="toggle-article-list-image" />
      <ToggleField label="Show summary" value={c.showSummary !== false} onChange={(v) => set({ showSummary: v })} testId="toggle-article-list-summary" />
      <ToggleField label="Featured first" value={!!c.featuredFirst} onChange={(v) => set({ featuredFirst: v })} testId="toggle-article-list-featured-first" />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-article-list-empty" />
    </>
  );
}

// ============================================================================
// RESOURCE LIST
// ============================================================================
function ResourceListRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const cols = columnsForBreakpoint(c, breakpoint);
  const layout = c.layout || 'grid';
  const effectiveCols = layout === 'list' ? 1 : cols;
  const { data, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-resources'],
    queryFn: () => publicClient.listResources(),
    staleTime: 60_000,
  });

  const items = useMemo(() => {
    let list = Array.isArray(data) ? data.slice() : [];
    if (c.resourceType) {
      const t = String(c.resourceType).toLowerCase();
      list = list.filter((r) => String(r.resource_type || '').toLowerCase() === t);
    }
    if (c.tag) {
      const tag = String(c.tag).toLowerCase();
      list = list.filter((r) => Array.isArray(r.tags) && r.tags.some((x) => String(x).toLowerCase() === tag));
    }
    if (c.category) {
      const cat = String(c.category).toLowerCase();
      list = list.filter((r) =>
        (Array.isArray(r.subcategories) && r.subcategories.some((x) => String(x).toLowerCase() === cat)) ||
        (Array.isArray(r.tags) && r.tags.some((x) => String(x).toLowerCase() === cat))
      );
    }
    if (c.audience === 'public-only') list = list.filter((r) => !r.is_locked);
    else if (c.audience === 'members-only') list = list.filter((r) => r.is_locked);
    if (c.limit && c.limit > 0) list = list.slice(0, c.limit);
    return list;
  }, [data, c.resourceType, c.tag, c.category, c.audience, c.limit]);

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || c.title || 'Resources'}>
      {c.title ? <Heading level={c.headingLevel || 2}>{c.title}</Heading> : null}
      {isLoading ? (
        <ListSkeleton count={Math.min(c.limit || 6, 6)} columns={effectiveCols} gap={c.gap} />
      ) : isError ? (
        <ErrorState message="Couldn't load resources right now." />
      ) : items.length === 0 ? (
        <EmptyState icon={Folder} text={c.emptyText || 'No resources available.'} />
      ) : (
        <ul className="list-none m-0 p-0" style={gridStyle(effectiveCols, c.gap)} data-testid="resource-list">
          {items.map((r) => (
            <li
              key={r.id}
              className={`rounded-md border border-slate-200 bg-white overflow-hidden ${layout === 'list' ? 'flex flex-row' : 'flex flex-col'}`}
            >
              {r.image_url ? (
                <div className={layout === 'list' ? 'w-32 shrink-0 bg-slate-100' : 'aspect-[16/9] bg-slate-100'}>
                  <img src={r.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                </div>
              ) : null}
              <div className="p-3 flex-1 flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-slate-900 m-0">{r.title}</h3>
                {r.resource_type ? (
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">{r.resource_type}</div>
                ) : null}
                {r.description ? (
                  <p className="text-xs text-slate-600 line-clamp-3 mt-1">{r.description}</p>
                ) : null}
                {(() => {
                  const behavior = c.downloadBehavior || 'auto';
                  const newTab = behavior === 'new-tab' || (behavior === 'auto' && r.open_in_new_tab);
                  const download = behavior === 'download';
                  return (
                    <a
                      href={asEditor ? undefined : (r.target_url || r.login_redirect_url || '#')}
                      onClick={(ev) => { if (asEditor) ev.preventDefault(); }}
                      target={newTab ? '_blank' : undefined}
                      rel={newTab ? 'noopener noreferrer' : undefined}
                      download={download ? '' : undefined}
                      className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 mt-auto pt-2"
                      data-testid={`link-resource-${r.id}`}
                    >
                      {r.is_locked ? 'Login to view' : (download ? 'Download' : 'Open resource')} <ArrowRight className="w-3 h-3" />
                    </a>
                  );
                })()}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ResourceListInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <TextField label="Heading" value={c.title} onChange={(v) => set({ title: v })} testId="input-resource-list-title" />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 2)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[2, 3, 4].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-resource-list-heading-level"
      />
      <TextField label="Resource type" value={c.resourceType} onChange={(v) => set({ resourceType: v })} testId="input-resource-list-type" />
      <TextField label="Filter tag" value={c.tag} onChange={(v) => set({ tag: v })} testId="input-resource-list-tag" />
      <TextField label="Filter category" value={c.category} onChange={(v) => set({ category: v })} testId="input-resource-list-category" />
      <SelectField
        label="Link behaviour"
        value={c.downloadBehavior || 'auto'}
        onChange={(v) => set({ downloadBehavior: v })}
        options={[
          { value: 'auto', label: 'Use resource setting' },
          { value: 'same-tab', label: 'Open in same tab' },
          { value: 'new-tab', label: 'Open in new tab' },
          { value: 'download', label: 'Download attachment' },
        ]}
        testId="select-resource-list-download-behavior"
      />
      <SelectField
        label="Audience"
        value={c.audience || 'all'}
        onChange={(v) => set({ audience: v })}
        options={[
          { value: 'all', label: 'All public resources' },
          { value: 'public-only', label: 'Public only (no login required)' },
          { value: 'members-only', label: 'Members-only (locked)' },
        ]}
        testId="select-resource-list-audience"
      />
      <SelectField
        label="Layout"
        value={c.layout || 'grid'}
        onChange={(v) => set({ layout: v })}
        options={[
          { value: 'grid', label: 'Grid of cards' },
          { value: 'list', label: 'Stacked list rows' },
        ]}
        testId="select-resource-list-layout"
      />
      <NumberField label="Limit" min={1} max={50} value={c.limit || 6} onChange={(v) => set({ limit: Math.max(1, Number(v) || 1) })} testId="input-resource-list-limit" />
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap || 16} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-resource-list-gap" />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-resource-list-empty" />
    </>
  );
}

// ============================================================================
// FORM EMBED
// ============================================================================
function FormEmbedRender({ block, asEditor }) {
  const c = block.content || {};
  const { data: form, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-form', c.formSlug],
    queryFn: () => publicClient.getForm(c.formSlug),
    enabled: !!c.formSlug,
    staleTime: 60_000,
  });

  if (!c.formSlug) {
    return <EmptyState icon={FormInput} text="Pick a form in the inspector." />;
  }
  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center" aria-busy="true">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" aria-hidden="true" />
      </div>
    );
  }
  if (isError || !form) return <ErrorState message="Form not found or not active." />;

  const href = `/EmbedForm/${encodeURIComponent(form.slug)}`;

  const mode = c.mode || 'inline';

  if (mode === 'link') {
    return (
      <article className="w-full h-full overflow-auto flex flex-col gap-2" aria-label={block.a11y?.ariaLabel || form.name}>
        <h3 className="text-lg font-semibold text-slate-900 m-0">{c.title || form.name}</h3>
        {form.description ? <p className="text-sm text-slate-700 m-0">{form.description}</p> : null}
        <a
          href={asEditor ? undefined : href}
          onClick={(e) => { if (asEditor) e.preventDefault(); }}
          className="inline-flex items-center gap-1 self-start mt-2 px-3 py-1.5 text-sm rounded-md bg-slate-900 text-white"
          data-testid="link-form-embed"
          aria-label={`${c.ctaLabel || form.submit_button_text || 'Open form'}: ${form.name || 'form'}`}
        >
          <FormInput className="w-4 h-4" aria-hidden="true" />
          {c.ctaLabel || form.submit_button_text || 'Open form'}
        </a>
      </article>
    );
  }

  // inline + iframe both render the real public form runtime in an iframe so
  // conditional logic, validation, and the submission pipeline are preserved.
  return (
    <div className="w-full h-full flex flex-col" aria-label={block.a11y?.ariaLabel || form.name}>
      {mode === 'inline' && (c.title || form.name) ? (
        <h3 className="text-base font-semibold text-slate-900 m-0 mb-2">{c.title || form.name}</h3>
      ) : null}
      {asEditor ? (
        <div className="flex-1 min-h-[200px] grid place-items-center text-xs text-slate-500 border border-dashed border-slate-300 rounded">
          Form preview ({form.name}) — submissions only run on the published page.
        </div>
      ) : (
        <iframe
          src={href}
          title={c.title || form.name || 'Form'}
          loading="lazy"
          style={{ width: '100%', flex: 1, minHeight: 320, border: 0 }}
          data-testid="iframe-form-embed"
        />
      )}
    </div>
  );
}

function FormPickerField({ value, onChange, testId }) {
  const { data: forms, isLoading } = useQuery({
    queryKey: ['canvas', 'public-forms'],
    queryFn: () => publicClient.listForms(),
    staleTime: 60_000,
  });
  const options = (forms || []).filter((f) => f.is_active).map((f) => ({ value: f.slug, label: f.name }));
  return (
    <Field label="Form" hint={isLoading ? 'Loading forms…' : null}>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="h-8" data-testid={testId}><SelectValue placeholder="Select a form" /></SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <SelectItem value="__none__" disabled>No active forms</SelectItem>
          ) : options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function FormEmbedInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <FormPickerField value={c.formSlug} onChange={(v) => set({ formSlug: v })} testId="select-form-embed-slug" />
      <SelectField
        label="Display mode"
        value={c.mode || 'inline'}
        onChange={(v) => set({ mode: v })}
        options={[
          { value: 'inline', label: 'Inline card' },
          { value: 'iframe', label: 'Embedded iframe' },
          { value: 'link', label: 'Link only' },
        ]}
        testId="select-form-embed-mode"
      />
      <TextField label="Title override" value={c.title} onChange={(v) => set({ title: v })} testId="input-form-embed-title" />
      <TextField label="CTA label" value={c.ctaLabel} onChange={(v) => set({ ctaLabel: v })} testId="input-form-embed-cta" />
    </>
  );
}

// ============================================================================
// FUNDRAISING CAMPAIGN EMBED
// ============================================================================
function CampaignEmbedRender({ block, asEditor }) {
  const c = block.content || {};
  const { data, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-campaign', c.campaignSlug],
    queryFn: async () => {
      const res = await fetch(`/api/public/fundraising/campaign?slug=${encodeURIComponent(c.campaignSlug)}${publicClient.getTenantSlug() ? `&tenant=${encodeURIComponent(publicClient.getTenantSlug())}` : ''}`);
      if (!res.ok) throw new Error('Campaign fetch failed');
      return res.json();
    },
    enabled: !!c.campaignSlug,
    staleTime: 60_000,
  });

  if (!c.campaignSlug) return <EmptyState icon={Heart} text="Pick a fundraising campaign in the inspector." />;
  if (isLoading) return <ListSkeleton count={1} columns={1} gap={0} />;
  if (isError || !data || !data.name) return <ErrorState message="Campaign not available." />;

  const campaign = data;
  const totalRaised = Number(data.total_raised) || 0;
  const goal = Number(campaign.goal_amount) || 0;
  const pct = goal > 0 ? Math.min(100, Math.round((totalRaised / goal) * 100)) : 0;
  const layout = c.layout || 'full';

  if (layout === 'progress-only') {
    return (
      <div className="w-full h-full flex flex-col justify-center gap-2" aria-label={block.a11y?.ariaLabel || campaign.name}>
        <div className="text-sm font-medium text-slate-800">{campaign.name}</div>
        {goal > 0 && !campaign.hide_campaign_target ? (
          <>
            <div className="h-2 w-full bg-slate-200 rounded overflow-hidden">
              <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-slate-600">
              {formatCurrency(totalRaised, campaign.currency)} raised of {formatCurrency(goal, campaign.currency)} ({pct}%)
            </div>
          </>
        ) : (
          <div className="text-xs text-slate-600">{formatCurrency(totalRaised, campaign.currency)} raised</div>
        )}
      </div>
    );
  }

  const showImage = layout === 'full' && c.showImage !== false && campaign.cover_image_url;
  const showDescription = layout === 'full';

  return (
    <article className="w-full h-full overflow-auto flex flex-col gap-3" aria-label={block.a11y?.ariaLabel || campaign.name}>
      {showImage ? (
        <div className="aspect-[16/9] bg-slate-100 rounded overflow-hidden">
          <img src={campaign.cover_image_url} alt="" className="w-full h-full object-cover" />
        </div>
      ) : null}
      <h3 className="text-lg font-semibold text-slate-900 m-0">{campaign.name}</h3>
      {showDescription && (campaign.public_description || campaign.description) ? (
        <p className="text-sm text-slate-700 m-0 line-clamp-4">
          {String(campaign.public_description || campaign.description).replace(/<[^>]+>/g, '').slice(0, 280)}
        </p>
      ) : null}
      {c.showProgress !== false && goal > 0 && !campaign.hide_campaign_target ? (
        <div className="space-y-1">
          <div className="h-2 w-full bg-slate-200 rounded overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-xs text-slate-600">
            {formatCurrency(totalRaised, campaign.currency)} raised of {formatCurrency(goal, campaign.currency)} ({pct}%)
          </div>
        </div>
      ) : null}
      <a
        href={asEditor ? undefined : `/Campaign/${encodeURIComponent(campaign.slug)}`}
        onClick={(e) => { if (asEditor) e.preventDefault(); }}
        className="inline-flex items-center gap-1 self-start px-3 py-1.5 text-sm rounded-md bg-rose-600 text-white"
        data-testid="link-campaign-embed"
        aria-label={`${c.ctaLabel || 'Donate now'}: ${campaign.name || 'campaign'}`}
      >
        <Heart className="w-4 h-4" aria-hidden="true" />
        {c.ctaLabel || 'Donate now'}
      </a>
    </article>
  );
}

function CampaignPickerField({ value, onChange, testId }) {
  const { data, isLoading } = useQuery({
    queryKey: ['canvas', 'public-campaigns'],
    queryFn: async () => {
      const res = await fetch(`/api/public/fundraising/campaigns${publicClient.getTenantSlug() ? `?tenant=${encodeURIComponent(publicClient.getTenantSlug())}` : ''}`);
      if (!res.ok) return { campaigns: [] };
      return res.json();
    },
    staleTime: 60_000,
  });
  const options = (data?.campaigns || []).map((c) => ({ value: c.slug, label: c.name }));
  return (
    <Field label="Campaign" hint={isLoading ? 'Loading campaigns…' : null}>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="h-8" data-testid={testId}><SelectValue placeholder="Select a campaign" /></SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <SelectItem value="__none__" disabled>No active campaigns</SelectItem>
          ) : options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function CampaignEmbedInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <CampaignPickerField value={c.campaignSlug} onChange={(v) => set({ campaignSlug: v })} testId="select-campaign-embed" />
      <SelectField
        label="Layout"
        value={c.layout || 'full'}
        onChange={(v) => set({ layout: v })}
        options={[
          { value: 'full', label: 'Full (image, description, progress, CTA)' },
          { value: 'compact', label: 'Compact (no image / description)' },
          { value: 'progress-only', label: 'Progress bar only' },
        ]}
        testId="select-campaign-embed-layout"
      />
      <ToggleField label="Show progress bar" value={c.showProgress !== false} onChange={(v) => set({ showProgress: v })} testId="toggle-campaign-embed-progress" />
      <ToggleField label="Show cover image" value={c.showImage !== false} onChange={(v) => set({ showImage: v })} testId="toggle-campaign-embed-image" />
      <TextField label="CTA label" value={c.ctaLabel} onChange={(v) => set({ ctaLabel: v })} testId="input-campaign-embed-cta" />
    </>
  );
}

// ============================================================================
// SHARED DIRECTORY DATA BINDING
// ============================================================================
// Picker uses the authenticated entity API (editor is admin-side); the public
// page renders via the public /api/dynamic-directory/members endpoint.
function parseFilterOverrides(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return null;
}

function useDirectoryRecords({ directorySlug, limit, sort, search, filterOverrides, enabled }) {
  return useQuery({
    queryKey: ['canvas', 'public-dynamic-directory', directorySlug, limit, sort, search || '', filterOverrides || ''],
    queryFn: async () => {
      const tenant = publicClient.getTenantSlug();
      const params = new URLSearchParams();
      params.set('slug', directorySlug);
      params.set('page', '1');
      params.set('limit', String(Math.max(1, Math.min(limit || 12, 50))));
      params.set('sort', sort || 'name-asc');
      if (search) params.set('search', search);
      const parsedFilters = parseFilterOverrides(filterOverrides);
      if (parsedFilters && Object.keys(parsedFilters).length > 0) {
        params.set('filters', JSON.stringify(parsedFilters));
      }
      if (tenant) params.set('tenant', tenant);
      const res = await fetch(`/api/public/dynamic-directory?${params.toString()}`);
      if (!res.ok) {
        let msg = 'Directory fetch failed';
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
        throw new Error(msg);
      }
      return res.json();
    },
    enabled: !!directorySlug && enabled !== false,
    staleTime: 60_000,
  });
}

function DirectoryPickerField({ value, onChange, testId, entityType }) {
  const { data: directories, isLoading } = useQuery({
    queryKey: ['canvas', 'directory-list', entityType || 'all'],
    queryFn: async () => {
      try {
        const dirs = await base44.entities.DynamicDirectory.list({ limit: 100 });
        return Array.isArray(dirs) ? dirs : [];
      } catch (err) {
        return [];
      }
    },
    staleTime: 60_000,
  });
  const filtered = (directories || []).filter((d) => !entityType || d.entity_type === entityType);
  const options = filtered.map((d) => ({ value: d.slug, label: d.name || d.slug }));
  return (
    <Field label="Directory" hint={isLoading ? 'Loading directories…' : null}>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="h-8" data-testid={testId}><SelectValue placeholder="Select a directory" /></SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <SelectItem value="__none__" disabled>No directories configured</SelectItem>
          ) : options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function DirectoryCardsRender({ block, breakpoint, asEditor, icon: Icon, fallbackTitle }) {
  const c = block.content || {};
  const cols = columnsForBreakpoint(c, breakpoint);
  const layout = c.layout === 'list' ? 'list' : 'grid';
  const { data, isLoading, isError, error } = useDirectoryRecords({
    directorySlug: c.directorySlug,
    limit: c.limit,
    sort: c.sort,
    search: c.search,
    filterOverrides: c.filterOverrides,
  });
  const records = Array.isArray(data?.records) ? data.records : [];
  if (!c.directorySlug) {
    return <EmptyState icon={Icon} text="Pick a directory in the inspector." />;
  }
  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || c.title || fallbackTitle}>
      {c.title ? <Heading level={c.headingLevel || 2}>{c.title}</Heading> : null}
      {isLoading ? (
        <ListSkeleton count={Math.min(c.limit || 12, 6)} columns={layout === 'list' ? 1 : cols} gap={c.gap} />
      ) : isError ? (
        <ErrorState message={String(error?.message || "Couldn't load directory right now.")} />
      ) : records.length === 0 ? (
        <EmptyState icon={Icon} text={c.emptyText || 'No records to show yet.'} />
      ) : (
        <>
          <ul
            className="list-none m-0 p-0"
            style={layout === 'list' ? { display: 'flex', flexDirection: 'column', gap: c.gap || 12 } : gridStyle(cols, c.gap)}
            data-testid="directory-list"
          >
            {records.map((r) => (
              <li key={r.id} className={`rounded-md border border-slate-200 bg-white p-3 flex ${layout === 'list' ? 'flex-row items-center gap-3' : 'flex-col items-start gap-1'}`}>
                {c.showPhoto !== false ? (
                  r.image_url ? (
                    <img
                      src={r.image_url}
                      alt=""
                      className={`${layout === 'list' ? 'w-10 h-10' : 'w-12 h-12'} rounded-full object-cover bg-slate-100 shrink-0`}
                      loading="lazy"
                    />
                  ) : (
                    <div className={`${layout === 'list' ? 'w-10 h-10' : 'w-12 h-12'} rounded-full bg-slate-100 grid place-items-center shrink-0`} aria-hidden="true">
                      <Icon className="w-5 h-5 text-slate-400" />
                    </div>
                  )
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-900 truncate">{r.name || 'Untitled'}</div>
                  {c.showSubtitle !== false && r.subtitle ? (
                    <div className="text-xs text-slate-600 truncate">{r.subtitle}</div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <a
              href={asEditor ? undefined : `/DynamicDirectoryView/${encodeURIComponent(c.directorySlug)}`}
              onClick={(e) => { if (asEditor) e.preventDefault(); }}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
              data-testid="link-directory-embed"
              aria-label={`${c.ctaLabel || 'View full directory'}: ${c.title || fallbackTitle}`}
            >
              {c.ctaLabel || 'View full directory'} <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </a>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// MEMBER DIRECTORY EMBED
// ============================================================================
function MemberDirectoryEmbedRender(props) {
  return (
    <DirectoryCardsRender
      {...props}
      icon={Users}
      fallbackTitle="Member directory"
    />
  );
}

function MemberDirectoryEmbedInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <DirectoryPickerField
        value={c.directorySlug}
        onChange={(v) => set({ directorySlug: v })}
        testId="select-member-dir-slug"
        entityType="member"
      />
      <TextField label="Heading" value={c.title} onChange={(v) => set({ title: v })} testId="input-member-dir-title" />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 2)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[2, 3, 4].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-member-dir-heading-level"
      />
      <SelectField
        label="Layout"
        value={c.layout || 'grid'}
        onChange={(v) => set({ layout: v })}
        options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]}
        testId="select-member-dir-layout"
      />
      <SelectField
        label="Sort"
        value={c.sort || 'name-asc'}
        onChange={(v) => set({ sort: v })}
        options={[
          { value: 'name-asc', label: 'Name (A → Z)' },
          { value: 'name-desc', label: 'Name (Z → A)' },
        ]}
        testId="select-member-dir-sort"
      />
      <TextField
        label="Search override"
        value={c.search}
        onChange={(v) => set({ search: v })}
        testId="input-member-dir-search"
        placeholder="e.g. London"
      />
      <TextField
        label="Filter overrides (JSON)"
        value={c.filterOverrides}
        onChange={(v) => set({ filterOverrides: v })}
        testId="input-member-dir-filter-overrides"
        multiline
        placeholder='{"<field-id>": "value"}'
        hint="Adds custom preference-field filters on top of the directory's saved filter."
      />
      <NumberField label="Limit" min={1} max={50} value={c.limit || 12} onChange={(v) => set({ limit: Math.max(1, Number(v) || 1) })} testId="input-member-dir-limit" />
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap || 16} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-member-dir-gap" />
      <ToggleField label="Show photo" value={c.showPhoto !== false} onChange={(v) => set({ showPhoto: v })} testId="toggle-member-dir-photo" />
      <ToggleField label="Show subtitle (job title)" value={c.showSubtitle !== false} onChange={(v) => set({ showSubtitle: v })} testId="toggle-member-dir-subtitle" />
      <TextField label="CTA label" value={c.ctaLabel} onChange={(v) => set({ ctaLabel: v })} testId="input-member-dir-cta" />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-member-dir-empty" />
    </>
  );
}

// ============================================================================
// DYNAMIC DIRECTORY EMBED
// ============================================================================
function DynamicDirectoryEmbedRender(props) {
  return (
    <DirectoryCardsRender
      {...props}
      icon={Building2}
      fallbackTitle="Directory"
    />
  );
}

function DynamicDirectoryEmbedInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <DirectoryPickerField
        value={c.directorySlug}
        onChange={(v) => set({ directorySlug: v })}
        testId="select-dynamic-dir-slug"
      />
      <TextField label="Heading" value={c.title} onChange={(v) => set({ title: v })} testId="input-dynamic-dir-title" />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 2)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[2, 3, 4].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-dynamic-dir-heading-level"
      />
      <SelectField
        label="Layout"
        value={c.layout || 'grid'}
        onChange={(v) => set({ layout: v })}
        options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]}
        testId="select-dynamic-dir-layout"
      />
      <SelectField
        label="Sort"
        value={c.sort || 'name-asc'}
        onChange={(v) => set({ sort: v })}
        options={[
          { value: 'name-asc', label: 'Name (A → Z)' },
          { value: 'name-desc', label: 'Name (Z → A)' },
        ]}
        testId="select-dynamic-dir-sort"
      />
      <TextField
        label="Search override"
        value={c.search}
        onChange={(v) => set({ search: v })}
        testId="input-dynamic-dir-search"
        placeholder="e.g. Manchester"
      />
      <TextField
        label="Filter overrides (JSON)"
        value={c.filterOverrides}
        onChange={(v) => set({ filterOverrides: v })}
        testId="input-dynamic-dir-filter-overrides"
        multiline
        placeholder='{"<field-id>": "value"}'
        hint="Adds custom preference-field filters on top of the directory's saved filter."
      />
      <NumberField label="Limit" min={1} max={50} value={c.limit || 12} onChange={(v) => set({ limit: Math.max(1, Number(v) || 1) })} testId="input-dynamic-dir-limit" />
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap || 16} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-dynamic-dir-gap" />
      <ToggleField label="Show photo / logo" value={c.showPhoto !== false} onChange={(v) => set({ showPhoto: v })} testId="toggle-dynamic-dir-photo" />
      <ToggleField label="Show subtitle" value={c.showSubtitle !== false} onChange={(v) => set({ showSubtitle: v })} testId="toggle-dynamic-dir-subtitle" />
      <TextField label="CTA label" value={c.ctaLabel} onChange={(v) => set({ ctaLabel: v })} testId="input-dynamic-dir-cta" />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-dynamic-dir-empty" />
    </>
  );
}

// ============================================================================
// Registry export
// ============================================================================
export const DYNAMIC_BLOCK_DEFINITIONS = {
  [BLOCK_TYPES.EVENT_LIST]: {
    label: 'Event list',
    icon: CalendarDays,
    category: 'data',
    Editor: (props) => <EventListRender {...props} asEditor />,
    Renderer: EventListRender,
    Inspector: EventListInspector,
  },
  [BLOCK_TYPES.EVENT_TEASER]: {
    label: 'Event teaser',
    icon: Calendar,
    category: 'data',
    Editor: (props) => <EventTeaserRender {...props} asEditor />,
    Renderer: EventTeaserRender,
    Inspector: EventTeaserInspector,
  },
  [BLOCK_TYPES.EVENT_CAROUSEL]: {
    label: 'Event carousel',
    icon: Images,
    category: 'data',
    Editor: (props) => <EventCarouselRender {...props} asEditor />,
    Renderer: EventCarouselRender,
    Inspector: EventCarouselInspector,
  },
  [BLOCK_TYPES.ARTICLE_LIST]: {
    label: 'Article / news list',
    icon: Newspaper,
    category: 'data',
    Editor: (props) => <ArticleListRender {...props} asEditor />,
    Renderer: ArticleListRender,
    Inspector: ArticleListInspector,
  },
  [BLOCK_TYPES.RESOURCE_LIST]: {
    label: 'Resource list',
    icon: Layers,
    category: 'data',
    Editor: (props) => <ResourceListRender {...props} asEditor />,
    Renderer: ResourceListRender,
    Inspector: ResourceListInspector,
  },
  [BLOCK_TYPES.FORM_EMBED]: {
    label: 'Form embed',
    icon: FormInput,
    category: 'data',
    Editor: (props) => <FormEmbedRender {...props} asEditor />,
    Renderer: FormEmbedRender,
    Inspector: FormEmbedInspector,
  },
  [BLOCK_TYPES.CAMPAIGN_EMBED]: {
    label: 'Fundraising campaign',
    icon: Heart,
    category: 'data',
    Editor: (props) => <CampaignEmbedRender {...props} asEditor />,
    Renderer: CampaignEmbedRender,
    Inspector: CampaignEmbedInspector,
  },
  [BLOCK_TYPES.MEMBER_DIRECTORY_EMBED]: {
    label: 'Member directory',
    icon: Users,
    category: 'data',
    Editor: (props) => <MemberDirectoryEmbedRender {...props} asEditor />,
    Renderer: MemberDirectoryEmbedRender,
    Inspector: MemberDirectoryEmbedInspector,
  },
  [BLOCK_TYPES.DYNAMIC_DIRECTORY_EMBED]: {
    label: 'Dynamic directory',
    icon: Building2,
    category: 'data',
    Editor: (props) => <DynamicDirectoryEmbedRender {...props} asEditor />,
    Renderer: DynamicDirectoryEmbedRender,
    Inspector: DynamicDirectoryEmbedInspector,
  },
};
