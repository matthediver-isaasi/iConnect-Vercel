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
  ChevronLeft, ChevronRight, Images, User, Mic, ExternalLink, LayoutGrid,
  Award, ChevronUp, ChevronDown, Lock,
} from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { sanitizeRichText } from './sanitize';
import {
  BLOCK_TYPES,
  resolveResponsiveValue,
  hasResponsiveOverride,
  hasAnyResponsiveValue,
  writeResponsiveValue,
} from '@/lib/canvasDesign';
import { publicClient } from '@/api/publicClient';
import { base44 } from '@/api/base44Client';
import { ComplexEventProgramme } from '@/components/events/ComplexEventSchedule';
import WallOfFameDisplay from '@/components/walloffame/WallOfFameDisplay';
import { GalleryImage, Lightbox, resolveAlt } from '@/components/iedit/elements/IEditGalleryElement';
import {
  TypographyStyleField,
  useTenantTypographyStyles,
  useTenantTypographyStylesState,
  isAwaitingTypographyStyle,
  resolveTenantStyle,
  buildTypographyInlineStyle,
  buildTenantTypographyResponsiveCss,
  hasResponsiveTypographyOverride,
  LinkField,
} from './registry';

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
function NumberField({ label, value, onChange, min, max, step, testId, hint }) {
  return (
    <Field label={label} hint={hint}>
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
function ToggleField({ label, value, onChange, testId, hint }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Switch checked={!!value} onCheckedChange={onChange} data-testid={testId} />
        <span className="text-xs text-slate-600">{value ? 'On' : 'Off'}</span>
      </div>
    </Field>
  );
}
// Simple checkbox-style multi-select. `value` is an array of selected ids;
// `options` is [{ value, label }]. Toggling adds/removes an id. No selection
// (empty array) is a meaningful state handled by callers.
function MultiCheckboxField({ label, value, onChange, options, testId, hint }) {
  const selected = Array.isArray(value) ? value.map(String) : [];
  const toggle = (id) => {
    const key = String(id);
    const next = selected.includes(key)
      ? selected.filter((v) => v !== key)
      : [...selected, key];
    onChange(next);
  };
  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-col gap-1.5" data-testid={testId}>
        {options.map((o) => {
          const id = `${testId}-${o.value}`;
          return (
            <label
              key={o.value}
              htmlFor={id}
              className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer"
            >
              <Checkbox
                id={id}
                checked={selected.includes(String(o.value))}
                onCheckedChange={() => toggle(o.value)}
                data-testid={`${testId}-option-${o.value}`}
              />
              <span>{o.label}</span>
            </label>
          );
        })}
      </div>
    </Field>
  );
}

// Up/down reorder list for a set of options. `value` is an ordered list of
// ids; any option not present in `value` is shown after the ordered ones in
// the order it arrives in `options`. onChange always receives the full id list
// covering every option, so the stored order stays in sync with availability.
function CategoryReorderField({ label = 'Category display order', options, value, onChange, testId, hint }) {
  const available = options.map((o) => String(o.value));
  const stored = (Array.isArray(value) ? value.map(String) : []).filter((id) => available.includes(id));
  const ordered = [...stored, ...available.filter((id) => !stored.includes(id))];
  const labelFor = (id) => options.find((o) => String(o.value) === id)?.label || id;
  const move = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  };
  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-col gap-1.5" data-testid={testId}>
        {ordered.map((id, idx) => (
          <div
            key={id}
            className="flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1"
            data-testid={`${testId}-item-${id}`}
          >
            <span className="flex-1 truncate text-xs text-slate-700">{labelFor(id)}</span>
            <Button
              size="icon"
              variant="ghost"
              disabled={idx === 0}
              onClick={() => move(idx, -1)}
              data-testid={`${testId}-up-${id}`}
              aria-label={`Move ${labelFor(id)} up`}
            >
              <ChevronUp className="w-3 h-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              disabled={idx === ordered.length - 1}
              onClick={() => move(idx, 1)}
              data-testid={`${testId}-down-${id}`}
              aria-label={`Move ${labelFor(id)} down`}
            >
              <ChevronDown className="w-3 h-3" />
            </Button>
          </div>
        ))}
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
// EVENT SESSIONS (session + track schedule for a single multi-session event)
// ============================================================================
function EventSessionsRender({ block, asEditor }) {
  const c = block.content || {};
  if (!c.eventId) {
    return <EmptyState icon={CalendarDays} text="Pick a multi-session event in the inspector." />;
  }
  const blockHeight = block.geom?.h || 600;
  const maxHeight = Math.max(240, blockHeight - 80);
  return (
    <div className="w-full h-full overflow-auto">
      <ComplexEventProgramme
        eventId={c.eventId}
        emptyText={c.emptyText}
        maxHeight={maxHeight}
        asEditor={asEditor}
      />
    </div>
  );
}

function ComplexEventPickerField({ value, onChange, testId }) {
  // All complex events (incl. drafts) from the authenticated entity API.
  const { data: allEvents, isLoading: loadingEvents } = useQuery({
    queryKey: ['canvas', 'admin-complex-events'],
    queryFn: () => base44.entities.ComplexEvent.list(),
    staleTime: 60_000,
  });
  // Session counts for every event (covers draft-state events the public list omits).
  const { data: allSessions, isLoading: loadingSessions } = useQuery({
    queryKey: ['canvas', 'admin-complex-event-sessions'],
    queryFn: () => base44.entities.ComplexEventSession.listAll(),
    staleTime: 60_000,
  });
  const isLoading = loadingEvents || loadingSessions;
  const sessionCountById = new Map();
  (allSessions || []).forEach((s) => {
    const key = String(s.complex_event_id);
    sessionCountById.set(key, (sessionCountById.get(key) || 0) + 1);
  });
  // An event is a "draft" if either its publication status or lifecycle state says so.
  const isDraft = (e) => e.status === 'draft' || e.event_state === 'draft';
  const options = (allEvents || [])
    .filter((e) => {
      if (!['draft', 'published', 'tbc'].includes(e.status)) return false;
      if (e.event_state && !['active', 'closed', 'draft'].includes(e.event_state)) return false;
      // Drafts are still being built, so allow them even without a programme yet.
      if (isDraft(e)) return true;
      return (sessionCountById.get(String(e.id)) || 0) > 0;
    })
    .map((e) => ({
      value: String(e.id),
      label: (e.title || e.name || 'Untitled event') + (isDraft(e) ? ' (Draft)' : ''),
    }));
  return (
    <Field label="Event" hint={isLoading ? 'Loading events…' : 'Pick a multi-session event. Drafts are included so you can set this up before the event goes live.'}>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="h-8" data-testid={testId}><SelectValue placeholder="Select an event" /></SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <SelectItem value="__none__" disabled>No multi-session events available</SelectItem>
          ) : options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function EventSessionsInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <ComplexEventPickerField
        value={c.eventId}
        onChange={(v) => set({ eventId: v })}
        testId="select-event-sessions"
      />
      <TextField label="Empty message" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-event-sessions-empty" />
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
  // Real mobile viewports often render the carousel inside a block whose
  // CSS width still cascades from desktop (e.g. 900px) — the stage clips
  // it but `getBoundingClientRect` still measures 900px, so the
  // container-width check above wouldn't trigger. Also force-stack when
  // the actual viewport is below the stacked breakpoint via `matchMedia`,
  // so phones reliably get the stacked layout regardless of the block's
  // stored mobile geometry.
  const [viewportNarrow, setViewportNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(`(max-width: ${STACKED_BREAKPOINT_PX - 0.02}px)`);
    const update = () => setViewportNarrow(!!mql.matches);
    update();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update);
      return () => mql.removeEventListener('change', update);
    }
    mql.addListener(update);
    return () => mql.removeListener(update);
  }, []);
  // When the editor (or public renderer) explicitly forces a tablet or
  // mobile breakpoint, stack regardless of the measured container width
  // — in the canvas the stage width changes but the block's geometry
  // width may still be desktop-sized. When no breakpoint is forced
  // (e.g. on the live public site without `?_bp=`), stack when either
  // the actual viewport OR the measured container width is narrow.
  const isStacked = breakpoint === 'mobile' || breakpoint === 'tablet'
    ? true
    : (viewportNarrow || measuredStacked);
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
  // Task #972: in real public renders (no forced-breakpoint preview),
  // per-device sizes are driven by per-page CSS custom properties +
  // `@media` rules emitted by `buildCanvasCss`, so the browser handles
  // breakpoint switching with zero JS. We only inline the resolved px
  // value when the editor / `?_bp=` preview path passes an explicit
  // breakpoint — inline style then wins over the @media rules so the
  // preview chip continues to show the right size.
  const isForcedPreview = !!breakpoint;
  const dateFontSize = resolveResponsiveValue(c.dateFontSize, breakpoint);
  const titleFontSize = resolveResponsiveValue(c.titleFontSize, breakpoint);
  const summaryFontSize = resolveResponsiveValue(c.summaryFontSize, breakpoint);
  const titleLineHeightV = resolveResponsiveValue(c.titleLineHeight, breakpoint);
  const summaryLineHeightV = resolveResponsiveValue(c.summaryLineHeight, breakpoint);
  const dateIconSizeV = resolveResponsiveValue(c.dateIconSize, breakpoint);
  const placeholderIconSizeV = resolveResponsiveValue(c.placeholderIconSize, breakpoint);

  // For each per-device field, pick between an inline px literal (forced
  // preview) and a CSS var reference (public mode). When public mode and
  // the field has no value at any breakpoint we skip it entirely so
  // Tailwind defaults stay byte-identical to pre-#970.
  const cssVar = (raw, name) => (hasAnyResponsiveValue(raw) ? `var(${name})` : null);

  const dateStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(dateFontSize)) dateStyle.fontSize = `${dateFontSize}px`;
  } else {
    const v = cssVar(c.dateFontSize, '--cb-ev-date-fs');
    if (v) dateStyle.fontSize = v;
  }
  if (c.dateColor) dateStyle.color = c.dateColor;

  const titleStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(titleFontSize)) titleStyle.fontSize = `${titleFontSize}px`;
  } else {
    const v = cssVar(c.titleFontSize, '--cb-ev-title-fs');
    if (v) titleStyle.fontSize = v;
  }
  if (c.titleColor) titleStyle.color = c.titleColor;

  const summaryStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(summaryFontSize)) summaryStyle.fontSize = `${summaryFontSize}px`;
  } else {
    const v = cssVar(c.summaryFontSize, '--cb-ev-summary-fs');
    if (v) summaryStyle.fontSize = v;
  }
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
  // Task #972: in public mode the line-height is supplied by a CSS var
  // so per-device values respond to viewport via @media rules.
  const positiveResponsive = (raw) => {
    if (!hasAnyResponsiveValue(raw)) return false;
    if (typeof raw === 'number') return raw > 0;
    return ['desktop', 'tablet', 'mobile'].some(
      (k) => Number.isFinite(raw[k]) && raw[k] > 0,
    );
  };
  if (isForcedPreview) {
    if (Number.isFinite(titleLineHeightV) && titleLineHeightV > 0) {
      titleStyle.lineHeight = titleLineHeightV;
    }
    if (Number.isFinite(summaryLineHeightV) && summaryLineHeightV > 0) {
      summaryStyle.lineHeight = summaryLineHeightV;
    }
  } else {
    if (positiveResponsive(c.titleLineHeight)) titleStyle.lineHeight = 'var(--cb-ev-title-lh)';
    if (positiveResponsive(c.summaryLineHeight)) summaryStyle.lineHeight = 'var(--cb-ev-summary-lh)';
  }
  // Per-icon overrides — when unset we keep the original Tailwind w-3 h-3
  // (date row) and w-10 h-10 (no-image placeholder). In public mode the
  // px value is fed via the var; in forced-preview mode the resolved px
  // is inlined directly (wins over the var).
  const useDateIconVar = !isForcedPreview && hasAnyResponsiveValue(c.dateIconSize);
  const useDateIconInline = isForcedPreview && Number.isFinite(dateIconSizeV) && dateIconSizeV > 0;
  const dateIconCls = useDateIconVar || useDateIconInline ? '' : 'w-3 h-3';
  const dateIconStyle = useDateIconInline
    ? { width: `${dateIconSizeV}px`, height: `${dateIconSizeV}px` }
    : useDateIconVar
      ? { width: 'var(--cb-ev-date-icon)', height: 'var(--cb-ev-date-icon)' }
      : undefined;
  const usePhIconVar = !isForcedPreview && hasAnyResponsiveValue(c.placeholderIconSize);
  const usePhIconInline = isForcedPreview && Number.isFinite(placeholderIconSizeV) && placeholderIconSizeV > 0;
  const placeholderIconCls = usePhIconVar || usePhIconInline ? '' : 'w-10 h-10';
  const placeholderIconStyle = usePhIconInline
    ? { width: `${placeholderIconSizeV}px`, height: `${placeholderIconSizeV}px` }
    : usePhIconVar
      ? { width: 'var(--cb-ev-ph-icon)', height: 'var(--cb-ev-ph-icon)' }
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
// SPEAKER CAROUSEL
// ============================================================================

function speakerInitials(name) {
  return String(name || '')
    .split(' ')
    .map((n) => n[0])
    .filter(Boolean)
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function speakerSubtitle(speaker, c) {
  return [
    c.showJobTitle !== false ? speaker.job_title : null,
    c.showOrganization !== false ? speaker.organization : null,
  ].filter(Boolean).join(', ');
}

// Resolve the selected event (picker stores a slug-or-id) to its assigned
// speakers, preserving the event's stored speaker order. Reuses the cached
// public-events list (same as the picker) to map the value to a real event id,
// then fetches the event detail for `speaker_ids` and the speakers themselves.
function useEventSpeakers(eventValue) {
  const value = eventValue ? String(eventValue) : '';
  const { data: allEvents } = useQuery({
    queryKey: ['canvas', 'public-events'],
    queryFn: () => publicClient.listEvents(),
    staleTime: 60_000,
    enabled: !!value,
  });
  const resolvedId = useMemo(() => {
    if (!value || !Array.isArray(allEvents)) return null;
    const match = allEvents.find(
      (e) => String(e.slug) === value || String(e.id) === value,
    );
    return match ? match.id : null;
  }, [allEvents, value]);

  const { data: event, isLoading: eventLoading, isError: eventError } = useQuery({
    queryKey: ['canvas', 'speaker-carousel-event', resolvedId],
    queryFn: () => publicClient.getEvent(resolvedId),
    staleTime: 60_000,
    enabled: !!resolvedId,
  });

  const speakerIds = useMemo(() => {
    const ids = event?.speaker_ids;
    return Array.isArray(ids) ? ids.filter(Boolean) : [];
  }, [event]);

  const idsKey = speakerIds.join(',');
  const { data: speakers, isLoading: speakersLoading, isError: speakersError } = useQuery({
    queryKey: ['canvas', 'speaker-carousel-speakers', idsKey],
    queryFn: () => publicClient.listSpeakers(speakerIds),
    staleTime: 60_000,
    enabled: speakerIds.length > 0,
  });

  const ordered = useMemo(() => {
    if (speakerIds.length === 0) return [];
    const list = Array.isArray(speakers) ? speakers : [];
    const byId = new Map(list.map((s) => [String(s.id), s]));
    return speakerIds.map((id) => byId.get(String(id))).filter(Boolean);
  }, [speakers, speakerIds]);

  const resolvingEvent = !!value && (!Array.isArray(allEvents) || (!!resolvedId && eventLoading));
  const loadingSpeakers = speakerIds.length > 0 && speakersLoading;

  return {
    hasEvent: !!value,
    speakers: ordered,
    isLoading: resolvingEvent || loadingSpeakers,
    isError: eventError || speakersError,
  };
}

// Shared full-detail body for a single speaker — used by both the click-to-open
// detail dialog and the "See all speakers" modal's per-card detail view.
function SpeakerDetail({ speaker, content }) {
  if (!speaker) return null;
  const subtitle = speakerSubtitle(speaker, content || {});
  const bioHtml = speaker.biography ? sanitizeRichText(speaker.biography) : '';
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Avatar className="w-16 h-16">
          {speaker.profile_photo_url ? (
            <AvatarImage src={speaker.profile_photo_url} alt={speaker.full_name} />
          ) : null}
          <AvatarFallback>{speakerInitials(speaker.full_name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-slate-900 m-0" data-testid="text-speaker-carousel-detail-name">
            {speaker.full_name}
          </h3>
          {subtitle ? (
            <p className="text-sm text-slate-500 m-0" data-testid="text-speaker-carousel-detail-role">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {bioHtml ? (
        <div>
          <h4 className="text-sm font-medium text-slate-900 mb-1">Biography</h4>
          <div
            className="text-sm text-slate-600 leading-relaxed"
            data-testid="text-speaker-carousel-detail-bio"
            dangerouslySetInnerHTML={{ __html: bioHtml }}
          />
        </div>
      ) : null}
    </div>
  );
}

// A compact speaker card used inside the "See all speakers" modal list.
function SpeakerListCard({ speaker, content, onClick }) {
  const subtitle = speakerSubtitle(speaker, content || {});
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3 rounded-md border border-slate-200 bg-white text-left hover-elevate"
      data-testid={`button-speaker-carousel-all-${speaker.id}`}
    >
      <Avatar className="w-12 h-12 shrink-0">
        {speaker.profile_photo_url ? (
          <AvatarImage src={speaker.profile_photo_url} alt={speaker.full_name} />
        ) : null}
        <AvatarFallback>{speakerInitials(speaker.full_name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-900 truncate">{speaker.full_name}</div>
        {subtitle ? <div className="text-xs text-slate-500 truncate">{subtitle}</div> : null}
      </div>
    </button>
  );
}

// ============================================================================
// Carousel slide / fade transitions (shared by Speaker & Sponsor carousels)
// ============================================================================

// Keyframes are injected once into <head> on first use. The incoming page is
// rendered in place while the outgoing page is layered above it and animated
// out, so the container never collapses or shifts during the transition.
const CAROUSEL_TRANSITION_KEYFRAMES = `
@keyframes cb-car-in-right{from{transform:translateX(100%)}to{transform:translateX(0)}}
@keyframes cb-car-out-left{from{transform:translateX(0)}to{transform:translateX(-100%)}}
@keyframes cb-car-in-left{from{transform:translateX(-100%)}to{transform:translateX(0)}}
@keyframes cb-car-out-right{from{transform:translateX(0)}to{transform:translateX(100%)}}
@keyframes cb-car-fade-out{from{opacity:1}to{opacity:0}}
`;
let _carouselKeyframesInjected = false;
function ensureCarouselTransitionKeyframes() {
  if (_carouselKeyframesInjected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.setAttribute('data-cb-carousel-transitions', '');
  el.textContent = CAROUSEL_TRANSITION_KEYFRAMES;
  document.head.appendChild(el);
  _carouselKeyframesInjected = true;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(!!mq.matches);
    apply();
    if (mq.addEventListener) {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
    mq.addListener(apply);
    return () => mq.removeListener(apply);
  }, []);
  return reduced;
}

// Animates page changes for the carousels. `slideKey` is the current page
// index; when it changes we snapshot the previously rendered page and layer it
// above the new page, running an out/in animation pair whose direction follows
// `direction` (1 = next, -1 = prev). `transition` of 'none' (or a reduced-motion
// preference) renders the page instantly — byte-identical to the pre-existing
// discrete-paging behaviour.
function CarouselStage({ transition, durationMs, direction, slideKey, children }) {
  const reduced = usePrefersReducedMotion();
  const animated = (transition === 'slide' || transition === 'fade') && !reduced;

  const [prev, setPrev] = useState(null);
  const lastKeyRef = useRef(slideKey);
  const lastNodeRef = useRef(children);
  const dirRef = useRef(direction);
  dirRef.current = direction;

  useEffect(() => { ensureCarouselTransitionKeyframes(); }, []);

  useEffect(() => {
    if (!animated) {
      lastKeyRef.current = slideKey;
      lastNodeRef.current = children;
      setPrev((p) => (p ? null : p));
      return;
    }
    if (slideKey !== lastKeyRef.current) {
      setPrev({ key: lastKeyRef.current, node: lastNodeRef.current, direction: dirRef.current });
    }
    lastKeyRef.current = slideKey;
    lastNodeRef.current = children;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideKey, animated]);

  useEffect(() => {
    if (!prev) return undefined;
    const t = setTimeout(() => setPrev(null), durationMs + 60);
    return () => clearTimeout(t);
  }, [prev, durationMs]);

  if (!animated) return children;

  const transitioning = !!prev;
  const dir = prev ? prev.direction : 1;
  const dur = `${durationMs}ms`;
  let enterAnim;
  let exitAnim;
  if (transition === 'fade') {
    // Crossfade: the incoming page sits fully opaque underneath while the
    // outgoing page fades away on top, revealing the new page.
    enterAnim = undefined;
    exitAnim = `cb-car-fade-out ${dur} ease both`;
  } else if (dir >= 0) {
    enterAnim = `cb-car-in-right ${dur} ease both`;
    exitAnim = `cb-car-out-left ${dur} ease both`;
  } else {
    enterAnim = `cb-car-in-left ${dur} ease both`;
    exitAnim = `cb-car-out-right ${dur} ease both`;
  }

  return (
    <>
      <div
        key={`cb-car-cur-${slideKey}`}
        className="absolute inset-0"
        style={transitioning && enterAnim ? { animation: enterAnim } : undefined}
      >
        {children}
      </div>
      {transitioning ? (
        <div
          key={`cb-car-prev-${prev.key}`}
          className="absolute inset-0 pointer-events-none"
          style={{ animation: exitAnim }}
          aria-hidden="true"
        >
          {prev.node}
        </div>
      ) : null}
    </>
  );
}

function SpeakerCarouselRender({ block, asEditor, breakpoint }) {
  const c = block.content || {};
  const { hasEvent, speakers, isLoading, isError } = useEventSpeakers(c.eventId);

  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [hovered, setHovered] = useState(false);
  const [autoplayPausedAt, setAutoplayPausedAt] = useState(0);
  const [selected, setSelected] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const touchStartRef = useRef(null);

  const count = speakers.length;
  const perView = Math.max(1, Number(c.speakersPerView) || 1);
  const pageCount = Math.max(1, Math.ceil(count / perView));
  const hasMany = pageCount > 1;
  const transitionStyle = c.transition || 'slide';
  const transitionMs = Math.max(100, Number(c.transitionMs) || 400);
  const pauseOnHover = !!c.pauseOnHover;

  useEffect(() => {
    if (index > Math.max(0, pageCount - 1)) setIndex(0);
  }, [pageCount, index]);

  useEffect(() => {
    if (asEditor) return;
    if (!c.autoplay || pageCount < 2) return;
    // Pause autoplay while a dialog is open so the slide doesn't move under
    // the user as they read a profile.
    if (selected || showAll) return;
    // Pause-on-hover: when enabled, hovering the carousel halts autoplay.
    if (pauseOnHover && hovered) return;
    const ms = Math.max(1500, Number(c.autoplayMs) || 5000);
    const pauseMs = Math.max(ms, 4000);
    const t = setInterval(() => {
      if (autoplayPausedAt && Date.now() - autoplayPausedAt < pauseMs) return;
      setDirection(1);
      setIndex((i) => (i + 1) % pageCount);
    }, ms);
    return () => clearInterval(t);
  }, [asEditor, c.autoplay, c.autoplayMs, pageCount, autoplayPausedAt, selected, showAll, pauseOnHover, hovered]);

  const goPrev = () => { setDirection(-1); setIndex((i) => (i - 1 + pageCount) % pageCount); };
  const goNext = () => { setDirection(1); setIndex((i) => (i + 1) % pageCount); };

  const handleTouchStart = (ev) => {
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  };
  const handleTouchEnd = (ev) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || pageCount < 2) return;
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
    if (pageCount < 2) return;
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

  // Empty / no-speaker states show an editor placeholder, but render nothing
  // disruptive on the published public page.
  if (!hasEvent) {
    if (!asEditor) return null;
    return <EmptyState icon={Mic} text={c.emptyText || 'Pick an event with assigned speakers in the inspector.'} />;
  }
  if (isLoading) return <ListSkeleton count={1} columns={1} gap={0} />;
  if (isError) {
    if (!asEditor) return null;
    return <ErrorState message="Couldn't load speakers right now." />;
  }
  if (count === 0) {
    if (!asEditor) return null;
    return <EmptyState icon={Mic} text="The selected event has no speakers yet." />;
  }

  const speaker = speakers[Math.min(index, count - 1)];
  const showArrows = hasMany && c.showArrows !== false;
  const showIndicators = hasMany && c.showIndicators !== false;
  const ctaLabel = c.ctaLabel || 'See all speakers';
  const ctaMode = c.ctaMode || 'popup';
  const ctaHref = c.ctaHref || '';

  // Responsive font sizing — inline px literal in forced-breakpoint preview,
  // CSS var (driven by buildCanvasCss @media rules) on real public pages.
  const isForcedPreview = !!breakpoint;
  const nameFontSize = resolveResponsiveValue(c.nameFontSize, breakpoint);
  const titleFontSize = resolveResponsiveValue(c.titleFontSize, breakpoint);
  const orgFontSize = resolveResponsiveValue(c.orgFontSize, breakpoint);
  const cssVar = (raw, name) => (hasAnyResponsiveValue(raw) ? `var(${name})` : null);

  const nameStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(nameFontSize)) nameStyle.fontSize = `${nameFontSize}px`;
  } else {
    const v = cssVar(c.nameFontSize, '--cb-sp-name-fs');
    if (v) nameStyle.fontSize = v;
  }
  const titleStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(titleFontSize)) titleStyle.fontSize = `${titleFontSize}px`;
  } else {
    const v = cssVar(c.titleFontSize, '--cb-sp-title-fs');
    if (v) titleStyle.fontSize = v;
  }
  const orgStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(orgFontSize)) orgStyle.fontSize = `${orgFontSize}px`;
  } else {
    const v = cssVar(c.orgFontSize, '--cb-sp-org-fs');
    if (v) orgStyle.fontSize = v;
  }

  const openSpeaker = (s) => { setSelected(s); setAutoplayPausedAt(Date.now()); };

  const renderCard = (s, paddingClass = 'px-8 py-4') => (
    <button
      type="button"
      onClick={() => openSpeaker(s)}
      className={`w-full h-full flex flex-col items-center justify-center text-center gap-3 ${paddingClass} focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
      data-testid={`button-speaker-carousel-${s.id}`}
      aria-label={`View details for ${s.full_name || 'speaker'}`}
    >
      <Avatar className="w-24 h-24">
        {s.profile_photo_url ? (
          <AvatarImage src={s.profile_photo_url} alt={s.full_name} />
        ) : null}
        <AvatarFallback className="text-xl">{speakerInitials(s.full_name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 w-full">
        <div
          className="text-lg font-semibold text-slate-900 truncate"
          style={nameStyle}
          data-testid={`text-speaker-carousel-name-${s.id}`}
        >
          {s.full_name}
        </div>
        {c.showJobTitle !== false && s.job_title ? (
          <div className="text-sm text-slate-600 truncate" style={titleStyle}>{s.job_title}</div>
        ) : null}
        {c.showOrganization !== false && s.organization ? (
          <div className="text-sm text-slate-500 truncate" style={orgStyle}>{s.organization}</div>
        ) : null}
      </div>
    </button>
  );

  // Current page's speakers; padded to `perView` so the last (short) page keeps
  // equal-width slots instead of stretching the remaining cards.
  const pageSpeakers = speakers.slice(index * perView, index * perView + perView);
  const pageSlice = perView > 1
    ? Array.from({ length: perView }, (_, i) => pageSpeakers[i] || null)
    : pageSpeakers;

  return (
    <div
      className="relative w-full h-full overflow-hidden flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      aria-label={block.a11y?.ariaLabel || 'Speaker carousel'}
      data-testid="speaker-carousel"
      role="region"
      aria-roledescription="carousel"
      tabIndex={hasMany ? 0 : -1}
      onTouchStart={hasMany ? handleTouchStart : undefined}
      onTouchEnd={hasMany ? handleTouchEnd : undefined}
      onKeyDown={hasMany ? handleKeyDown : undefined}
      onMouseEnter={pauseOnHover ? () => setHovered(true) : undefined}
      onMouseLeave={pauseOnHover ? () => setHovered(false) : undefined}
      style={hasMany ? { touchAction: 'pan-y' } : undefined}
    >
      <div className="relative flex-1 min-h-0">
        <CarouselStage
          transition={transitionStyle}
          durationMs={transitionMs}
          direction={direction}
          slideKey={index}
        >
          {perView === 1 ? (
            renderCard(speaker)
          ) : (
            <div className="w-full h-full flex items-stretch gap-4 px-8 py-4">
              {pageSlice.map((s, i) => (
                <div key={s ? s.id : `empty-${index}-${i}`} className="flex-1 min-w-0">
                  {s ? renderCard(s, 'px-2 py-2') : null}
                </div>
              ))}
            </div>
          )}
        </CarouselStage>

        {showArrows ? (
          <>
            <button
              type="button"
              onClick={() => { goPrev(); setAutoplayPausedAt(Date.now()); }}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/80 hover:bg-white border border-slate-200 flex items-center justify-center shadow-sm"
              aria-label="Previous speaker"
              data-testid="button-speaker-carousel-prev"
            >
              <ChevronLeft className="w-4 h-4 text-slate-700" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => { goNext(); setAutoplayPausedAt(Date.now()); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/80 hover:bg-white border border-slate-200 flex items-center justify-center shadow-sm"
              aria-label="Next speaker"
              data-testid="button-speaker-carousel-next"
            >
              <ChevronRight className="w-4 h-4 text-slate-700" aria-hidden="true" />
            </button>
          </>
        ) : null}

        {showIndicators ? (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
            {Array.from({ length: pageCount }).map((_, i) => {
              const active = i === index;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => { setDirection(i >= index ? 1 : -1); setIndex(i); setAutoplayPausedAt(Date.now()); }}
                  aria-label={`Show page ${i + 1} of ${pageCount}`}
                  aria-current={active ? 'true' : undefined}
                  className={`w-2 h-2 rounded-full border border-white/80 ${active ? 'bg-slate-900' : 'bg-slate-400/70'}`}
                  data-testid={`button-speaker-carousel-indicator-${i}`}
                />
              );
            })}
          </div>
        ) : null}
      </div>

      {ctaLabel ? (
        <div className="shrink-0 flex justify-center px-4 py-3 border-t border-slate-100">
          {ctaMode === 'link' && ctaHref ? (
            <a
              href={asEditor ? undefined : ctaHref}
              onClick={(e) => { if (asEditor) e.preventDefault(); }}
              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
              data-testid="link-speaker-carousel-see-all"
            >
              {ctaLabel} <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </a>
          ) : (
            <button
              type="button"
              onClick={() => { setShowAll(true); setAutoplayPausedAt(Date.now()); }}
              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
              data-testid="button-speaker-carousel-see-all"
            >
              {ctaLabel} <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </div>
      ) : null}

      {/* Single-speaker detail dialog */}
      <Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" data-testid="dialog-speaker-carousel-detail">
          <DialogHeader>
            <DialogTitle>Speaker</DialogTitle>
            <DialogDescription className="sr-only">Speaker profile details</DialogDescription>
          </DialogHeader>
          <SpeakerDetail speaker={selected} content={c} />
        </DialogContent>
      </Dialog>

      {/* "See all speakers" modal — scrollable list of every speaker */}
      <Dialog open={showAll} onOpenChange={setShowAll}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" data-testid="dialog-speaker-carousel-all">
          <DialogHeader>
            <DialogTitle>{ctaLabel}</DialogTitle>
            <DialogDescription className="sr-only">All speakers for this event</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {speakers.map((s) => (
              <SpeakerListCard
                key={s.id}
                speaker={s}
                content={c}
                onClick={() => { setShowAll(false); setSelected(s); }}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SpeakerCarouselInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <EventCarouselPickerRow
        value={c.eventId || ''}
        onChange={(v) => set({ eventId: v })}
        testId="select-speaker-carousel-event"
      />
      <NumberField
        label="Speakers per view"
        min={1}
        value={c.speakersPerView || 1}
        onChange={(v) => set({ speakersPerView: Math.max(1, Math.floor(Number(v) || 1)) })}
        testId="input-speaker-carousel-per-view"
        hint="How many speaker cards to show side-by-side in one slide."
      />
      <TextField
        label="CTA label"
        value={c.ctaLabel}
        onChange={(v) => set({ ctaLabel: v })}
        testId="input-speaker-carousel-cta-label"
        hint="Shown below the carousel; leave blank to hide the “See all” link."
      />
      <SelectField
        label="CTA behaviour"
        value={c.ctaMode || 'popup'}
        onChange={(v) => set({ ctaMode: v })}
        options={[
          { value: 'popup', label: 'Open popup' },
          { value: 'link', label: 'Go to link' },
        ]}
        testId="select-speaker-carousel-cta-mode"
      />
      {(c.ctaMode || 'popup') === 'link' ? (
        <LinkField
          label="CTA link"
          value={c.ctaHref}
          onChange={(v) => set({ ctaHref: v })}
          testId="input-speaker-carousel-cta-href"
        />
      ) : null}
      <ToggleField
        label="Show job title"
        value={c.showJobTitle !== false}
        onChange={(v) => set({ showJobTitle: v })}
        testId="toggle-speaker-carousel-job-title"
      />
      <ToggleField
        label="Show organization"
        value={c.showOrganization !== false}
        onChange={(v) => set({ showOrganization: v })}
        testId="toggle-speaker-carousel-org"
      />
      <ToggleField
        label="Autoplay"
        value={c.autoplay !== false}
        onChange={(v) => set({ autoplay: v })}
        testId="toggle-speaker-carousel-autoplay"
      />
      <NumberField
        label="Autoplay interval (ms)"
        min={1500}
        value={c.autoplayMs || 5000}
        onChange={(v) => set({ autoplayMs: Math.max(1500, Number(v) || 5000) })}
        testId="input-speaker-carousel-autoplay-ms"
      />
      <ToggleField
        label="Show prev/next arrows"
        value={c.showArrows !== false}
        onChange={(v) => set({ showArrows: v })}
        testId="toggle-speaker-carousel-arrows"
      />
      <ToggleField
        label="Show slide indicators"
        value={c.showIndicators !== false}
        onChange={(v) => set({ showIndicators: v })}
        testId="toggle-speaker-carousel-indicators"
      />
      <SelectField
        label="Slide transition"
        value={c.transition || 'slide'}
        onChange={(v) => set({ transition: v })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'slide', label: 'Slide' },
          { value: 'fade', label: 'Fade' },
        ]}
        testId="select-speaker-carousel-transition"
      />
      {(c.transition || 'slide') !== 'none' ? (
        <NumberField
          label="Transition duration (ms)"
          min={100}
          value={c.transitionMs ?? 400}
          onChange={(v) => set({ transitionMs: Math.max(100, Number(v) || 400) })}
          testId="input-speaker-carousel-transition-ms"
        />
      ) : null}
      <ToggleField
        label="Pause on hover"
        value={!!c.pauseOnHover}
        onChange={(v) => set({ pauseOnHover: v })}
        testId="toggle-speaker-carousel-pause-hover"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Name</Label>
      </div>
      <ResponsiveNumberField
        label="Name font size (px)"
        min={1}
        value={c.nameFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ nameFontSize: v })}
        testId="input-speaker-carousel-name-font-size"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Job title</Label>
      </div>
      <ResponsiveNumberField
        label="Job title font size (px)"
        min={1}
        value={c.titleFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ titleFontSize: v })}
        testId="input-speaker-carousel-title-font-size"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Organization</Label>
      </div>
      <ResponsiveNumberField
        label="Organization font size (px)"
        min={1}
        value={c.orgFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ orgFontSize: v })}
        testId="input-speaker-carousel-org-font-size"
      />

      <TextField
        label="Empty state text"
        value={c.emptyText}
        onChange={(v) => set({ emptyText: v })}
        testId="input-speaker-carousel-empty"
      />
    </>
  );
}

// ============================================================================
// SPEAKER GRID
// ============================================================================
// Lays out an event's speakers in a responsive grid (columns per breakpoint),
// with optional pagination. Reuses the same speaker data hook, card body and
// detail dialog as the Speaker carousel.
function SpeakerGridCard({ speaker, content, nameStyle, titleStyle, orgStyle, onClick }) {
  const c = content || {};
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-slate-200 bg-white overflow-hidden h-full flex flex-col items-center justify-start text-center gap-3 px-4 py-5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 hover-elevate"
      data-testid={`button-speaker-grid-${speaker.id}`}
      aria-label={`View details for ${speaker.full_name || 'speaker'}`}
    >
      <Avatar className="w-20 h-20">
        {speaker.profile_photo_url ? (
          <AvatarImage src={speaker.profile_photo_url} alt={speaker.full_name} />
        ) : null}
        <AvatarFallback className="text-lg">{speakerInitials(speaker.full_name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 w-full">
        <div
          className="text-base font-semibold text-slate-900 truncate"
          style={nameStyle}
          data-testid={`text-speaker-grid-name-${speaker.id}`}
        >
          {speaker.full_name}
        </div>
        {c.showJobTitle !== false && speaker.job_title ? (
          <div className="text-sm text-slate-600 truncate" style={titleStyle}>{speaker.job_title}</div>
        ) : null}
        {c.showOrganization !== false && speaker.organization ? (
          <div className="text-sm text-slate-500 truncate" style={orgStyle}>{speaker.organization}</div>
        ) : null}
      </div>
    </button>
  );
}

function SpeakerGridRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const { hasEvent, speakers, isLoading, isError } = useEventSpeakers(c.eventId);
  const cols = columnsForBreakpoint(c, breakpoint);
  const gap = c.gap ?? 16;
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(0);

  const count = speakers.length;
  const paginate = !!c.paginate;
  const rowsPerPage = Math.max(1, Math.floor(Number(c.rowsPerPage) || 1));
  const perPage = Math.max(1, cols * rowsPerPage);
  const pageCount = paginate ? Math.max(1, Math.ceil(count / perPage)) : 1;

  // Keep the current page in range when the speaker count / columns change.
  useEffect(() => {
    if (page > Math.max(0, pageCount - 1)) setPage(0);
  }, [pageCount, page]);

  // Empty / no-speaker states show an editor placeholder, but render nothing
  // disruptive on the published public page.
  if (!hasEvent) {
    if (!asEditor) return null;
    return <EmptyState icon={Mic} text={c.emptyText || 'Pick an event with assigned speakers in the inspector.'} />;
  }
  if (isLoading) return <ListSkeleton count={Math.min(count || 4, 4)} columns={cols} gap={gap} />;
  if (isError) {
    if (!asEditor) return null;
    return <ErrorState message="Couldn't load speakers right now." />;
  }
  if (count === 0) {
    if (!asEditor) return null;
    return <EmptyState icon={Mic} text="The selected event has no speakers yet." />;
  }

  // Responsive font sizing — inline px literal in forced-breakpoint preview,
  // CSS var (driven by buildCanvasCss @media rules) on real public pages.
  const isForcedPreview = !!breakpoint;
  const nameFontSize = resolveResponsiveValue(c.nameFontSize, breakpoint);
  const titleFontSize = resolveResponsiveValue(c.titleFontSize, breakpoint);
  const orgFontSize = resolveResponsiveValue(c.orgFontSize, breakpoint);
  const cssVar = (raw, name) => (hasAnyResponsiveValue(raw) ? `var(${name})` : null);
  const nameStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(nameFontSize)) nameStyle.fontSize = `${nameFontSize}px`;
  } else {
    const v = cssVar(c.nameFontSize, '--cb-spgr-name-fs');
    if (v) nameStyle.fontSize = v;
  }
  const titleStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(titleFontSize)) titleStyle.fontSize = `${titleFontSize}px`;
  } else {
    const v = cssVar(c.titleFontSize, '--cb-spgr-title-fs');
    if (v) titleStyle.fontSize = v;
  }
  const orgStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(orgFontSize)) orgStyle.fontSize = `${orgFontSize}px`;
  } else {
    const v = cssVar(c.orgFontSize, '--cb-spgr-org-fs');
    if (v) orgStyle.fontSize = v;
  }

  const safePage = Math.min(page, pageCount - 1);
  const visible = paginate
    ? speakers.slice(safePage * perPage, safePage * perPage + perPage)
    : speakers;

  return (
    <div className="w-full h-full overflow-auto flex flex-col" aria-label={block.a11y?.ariaLabel || 'Speakers'} data-testid="speaker-grid">
      <div style={gridStyle(cols, gap)}>
        {visible.map((s) => (
          <SpeakerGridCard
            key={s.id}
            speaker={s}
            content={c}
            nameStyle={nameStyle}
            titleStyle={titleStyle}
            orgStyle={orgStyle}
            onClick={() => setSelected(s)}
          />
        ))}
      </div>

      {paginate && pageCount > 1 ? (
        <div className="shrink-0 flex items-center justify-center gap-3 pt-4">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage <= 0}
            className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm disabled:opacity-40"
            aria-label="Previous page"
            data-testid="button-speaker-grid-prev"
          >
            <ChevronLeft className="w-4 h-4 text-slate-700" aria-hidden="true" />
          </button>
          <span className="text-sm text-slate-600" data-testid="text-speaker-grid-page">
            Page {safePage + 1} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={safePage >= pageCount - 1}
            className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm disabled:opacity-40"
            aria-label="Next page"
            data-testid="button-speaker-grid-next"
          >
            <ChevronRight className="w-4 h-4 text-slate-700" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {/* Single-speaker detail dialog */}
      <Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" data-testid="dialog-speaker-grid-detail">
          <DialogHeader>
            <DialogTitle>Speaker</DialogTitle>
            <DialogDescription className="sr-only">Speaker profile details</DialogDescription>
          </DialogHeader>
          <SpeakerDetail speaker={selected} content={c} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SpeakerGridInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <EventCarouselPickerRow
        value={c.eventId || ''}
        onChange={(v) => set({ eventId: v })}
        testId="select-speaker-grid-event"
      />
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField
        label="Gap (px)"
        min={0}
        value={c.gap ?? 16}
        onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })}
        testId="input-speaker-grid-gap"
      />
      <ToggleField
        label="Paginate"
        value={!!c.paginate}
        onChange={(v) => set({ paginate: v })}
        testId="toggle-speaker-grid-paginate"
        hint="Split speakers across pages with prev/next controls."
      />
      {c.paginate ? (
        <NumberField
          label="Rows per page"
          min={1}
          value={c.rowsPerPage ?? 2}
          onChange={(v) => set({ rowsPerPage: Math.max(1, Math.floor(Number(v) || 1)) })}
          testId="input-speaker-grid-rows-per-page"
          hint="Number of speaker rows shown before paging."
        />
      ) : null}
      <ToggleField
        label="Show job title"
        value={c.showJobTitle !== false}
        onChange={(v) => set({ showJobTitle: v })}
        testId="toggle-speaker-grid-job-title"
      />
      <ToggleField
        label="Show organization"
        value={c.showOrganization !== false}
        onChange={(v) => set({ showOrganization: v })}
        testId="toggle-speaker-grid-org"
      />
      <TextField
        label="Empty state text"
        value={c.emptyText}
        onChange={(v) => set({ emptyText: v })}
        testId="input-speaker-grid-empty"
        hint="Shown in the editor when no event or no speakers are found."
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Name</Label>
      </div>
      <ResponsiveNumberField
        label="Name font size (px)"
        min={1}
        value={c.nameFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ nameFontSize: v })}
        testId="input-speaker-grid-name-font-size"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Job title</Label>
      </div>
      <ResponsiveNumberField
        label="Job title font size (px)"
        min={1}
        value={c.titleFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ titleFontSize: v })}
        testId="input-speaker-grid-title-font-size"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Organization</Label>
      </div>
      <ResponsiveNumberField
        label="Organization font size (px)"
        min={1}
        value={c.orgFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ orgFontSize: v })}
        testId="input-speaker-grid-org-font-size"
      />
    </>
  );
}

// ============================================================================
// SPONSOR GRID
// ============================================================================
function useEventSponsors(eventValue, categoryOrder) {
  const value = eventValue ? String(eventValue) : '';
  // Stable key so the grouping memo only recomputes when the order actually
  // changes (the array prop identity may change every render).
  const orderKey = Array.isArray(categoryOrder) ? categoryOrder.map(String).join(',') : '';
  const { data: allEvents } = useQuery({
    queryKey: ['canvas', 'public-events'],
    queryFn: () => publicClient.listEvents(),
    staleTime: 60_000,
    enabled: !!value,
  });
  const resolved = useMemo(() => {
    if (!value || !Array.isArray(allEvents)) return null;
    const match = allEvents.find(
      (e) => String(e.slug) === value || String(e.id) === value,
    );
    if (!match) return null;
    const eventType = (match.event_type === 'complex' || match.is_complex) ? 'complex' : 'simple';
    return { id: match.id, eventType };
  }, [allEvents, value]);

  const { data, isLoading: sponsorsLoading, isError } = useQuery({
    queryKey: ['canvas', 'sponsor-grid', resolved?.id, resolved?.eventType],
    queryFn: () => publicClient.getEventSponsors(resolved.id, resolved.eventType),
    staleTime: 60_000,
    enabled: !!resolved?.id,
  });

  const groups = useMemo(() => {
    const sponsors = Array.isArray(data?.sponsors) ? data.sponsors : [];
    const categories = Array.isArray(data?.categories) ? data.categories : [];
    const assignments = Array.isArray(data?.assignments) ? data.assignments : [];
    if (sponsors.length === 0) return [];
    const sponsorById = new Map(sponsors.map((s) => [String(s.id), s]));
    const catMeta = new Map();
    categories.forEach((cat, i) => {
      catMeta.set(String(cat.id), {
        name: cat.name || '',
        order: Number.isFinite(cat.display_order) ? cat.display_order : i,
      });
    });
    const byCat = new Map();
    const pushTo = (key, sponsor) => {
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key).push(sponsor);
    };
    // Category membership is event-scoped: use the assignment rows
    // (sponsor_id -> category_id for THIS event), not the sponsor's global
    // category. A sponsor assigned to multiple categories appears in each.
    if (assignments.length > 0) {
      for (const a of assignments) {
        const sponsor = sponsorById.get(String(a.sponsor_id));
        if (!sponsor) continue;
        // Prefer the category stored on the assignment; for events saved
        // before levels were persisted, fall back to the sponsor's global
        // category so they still group correctly without a re-save.
        const catId = a.category_id || sponsor.category_id;
        pushTo(catId ? String(catId) : '__none__', sponsor);
      }
    } else {
      for (const s of sponsors) {
        pushTo(s.category_id ? String(s.category_id) : '__none__', s);
      }
    }
    const result = [];
    for (const [key, list] of byCat.entries()) {
      if (key === '__none__') continue;
      const meta = catMeta.get(key);
      result.push({ id: key, name: meta?.name || '', order: meta?.order ?? 9998, sponsors: list });
    }
    // Per-block category order override (Task #1503). Categories listed in the
    // override sort first, in the override's order; everything not listed falls
    // back to the existing stored-order/alphabetical sort after them. The
    // synthetic "Other" bucket is never part of the override and stays last.
    const orderList = orderKey ? orderKey.split(',') : [];
    const orderIndex = new Map(orderList.map((id, i) => [id, i]));
    result.sort((a, b) => {
      const ai = orderIndex.has(a.id) ? orderIndex.get(a.id) : Infinity;
      const bi = orderIndex.has(b.id) ? orderIndex.get(b.id) : Infinity;
      if (ai !== bi) return ai - bi;
      return (a.order - b.order) || a.name.localeCompare(b.name);
    });
    if (byCat.has('__none__')) {
      result.push({ id: '__none__', name: 'Other', order: 9999, sponsors: byCat.get('__none__') });
    }
    return result;
  }, [data, orderKey]);

  // Per-assignment, event-specific sponsorship detail (e.g. "Lunch"), keyed by
  // sponsor id. UNIQUE(event_id, sponsor_id) guarantees one detail per sponsor.
  const detailById = useMemo(() => {
    const map = new Map();
    const assignments = Array.isArray(data?.assignments) ? data.assignments : [];
    for (const a of assignments) {
      if (a.sponsor_id && a.sponsorship_detail) {
        map.set(String(a.sponsor_id), a.sponsorship_detail);
      }
    }
    return map;
  }, [data]);

  const resolvingEvent = !!value && !Array.isArray(allEvents);
  const loadingSponsors = !!resolved?.id && sponsorsLoading;

  return {
    hasEvent: !!value,
    groups,
    detailById,
    totalSponsors: Array.isArray(data?.sponsors) ? data.sponsors.length : 0,
    isLoading: resolvingEvent || loadingSponsors,
    isError,
  };
}

function SponsorDetail({ sponsor }) {
  if (!sponsor) return null;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 shrink-0 rounded-md border border-slate-200 bg-white flex items-center justify-center p-2 overflow-hidden">
          {sponsor.logo_url ? (
            <img
              src={sponsor.logo_url}
              alt={sponsor.name || ''}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <Building2 className="w-7 h-7 text-slate-300" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-slate-900 m-0" data-testid="text-sponsor-carousel-detail-name">
            {sponsor.name}
          </h3>
        </div>
      </div>
      {sponsor.description ? (
        <div>
          <p
            className="text-sm text-slate-600 leading-relaxed m-0"
            data-testid="text-sponsor-carousel-detail-description"
          >
            {sponsor.description}
          </p>
        </div>
      ) : null}
      {sponsor.website_url ? (
        <a
          href={sponsor.website_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
          data-testid="link-sponsor-carousel-detail-website"
        >
          Visit website <ExternalLink className="w-4 h-4" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

function SponsorCard({ sponsor, showDescription, showSponsorDetail, detail, nameStyle, descStyle, onClick }) {
  const inner = (
    <>
      <div className="aspect-[16/9] bg-white flex items-center justify-center p-4 border-b border-slate-100">
        {sponsor.logo_url ? (
          <img
            src={sponsor.logo_url}
            alt={sponsor.name || ''}
            className="max-w-full max-h-full object-contain"
            loading="lazy"
          />
        ) : (
          <Building2 className="w-8 h-8 text-slate-300" aria-hidden="true" />
        )}
      </div>
      <div className="p-3 flex flex-col gap-1">
        <div
          className="text-sm font-semibold text-slate-900"
          style={nameStyle}
          data-testid={`text-sponsor-name-${sponsor.id}`}
        >
          {sponsor.name}
        </div>
        {showSponsorDetail && detail ? (
          <div className="text-xs font-medium text-slate-600" data-testid={`text-sponsor-detail-${sponsor.id}`}>{detail}</div>
        ) : null}
        {showDescription && sponsor.description ? (
          <div className="text-xs text-slate-500" style={descStyle}>{sponsor.description}</div>
        ) : null}
      </div>
    </>
  );
  const className = 'rounded-md border border-slate-200 bg-white overflow-hidden flex flex-col h-full';
  // Carousel usage: render as a button that opens the detail modal.
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${className} text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
        data-testid={`button-sponsor-${sponsor.id}`}
        aria-label={`View details for ${sponsor.name || 'sponsor'}`}
      >
        {inner}
      </button>
    );
  }
  // Grid usage: keep linking out to the sponsor website.
  if (sponsor.website_url) {
    return (
      <a
        href={sponsor.website_url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        data-testid={`link-sponsor-${sponsor.id}`}
      >
        {inner}
      </a>
    );
  }
  return <div className={className} data-testid={`card-sponsor-${sponsor.id}`}>{inner}</div>;
}

function SponsorGridRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const { hasEvent, groups, detailById, totalSponsors, isLoading, isError } = useEventSponsors(c.eventId, c.categoryOrder);
  const cols = columnsForBreakpoint(c, breakpoint);
  const gap = c.gap ?? 16;
  const [selected, setSelected] = useState(null);

  // Empty / no-sponsor states show an editor placeholder, but render nothing
  // disruptive on the published public page.
  if (!hasEvent) {
    if (!asEditor) return null;
    return <EmptyState icon={Building2} text={c.emptyText || 'Pick an event with assigned sponsors in the inspector.'} />;
  }
  if (isLoading) return <ListSkeleton count={Math.min(totalSponsors || 4, 4)} columns={cols} gap={gap} />;
  if (isError) {
    if (!asEditor) return null;
    return <ErrorState message="Couldn't load sponsors right now." />;
  }
  if (totalSponsors === 0) {
    if (!asEditor) return null;
    return <EmptyState icon={Building2} text="The selected event has no sponsors yet." />;
  }

  // Responsive font sizing — inline px literal in forced-breakpoint preview,
  // CSS var (driven by buildCanvasCss @media rules) on real public pages.
  const isForcedPreview = !!breakpoint;
  const nameFontSize = resolveResponsiveValue(c.nameFontSize, breakpoint);
  const descFontSize = resolveResponsiveValue(c.descFontSize, breakpoint);
  const cssVar = (raw, name) => (hasAnyResponsiveValue(raw) ? `var(${name})` : null);
  const nameStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(nameFontSize)) nameStyle.fontSize = `${nameFontSize}px`;
  } else {
    const v = cssVar(c.nameFontSize, '--cb-spg-name-fs');
    if (v) nameStyle.fontSize = v;
  }
  const descStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(descFontSize)) descStyle.fontSize = `${descFontSize}px`;
  } else {
    const v = cssVar(c.descFontSize, '--cb-spg-desc-fs');
    if (v) descStyle.fontSize = v;
  }

  const showHeadings = c.showCategoryHeadings !== false;
  const showDescription = c.showDescription !== false;
  const showSponsorDetail = c.showSponsorDetail === true;

  // Optional category filter. Empty selection => show every group (today's
  // behaviour). When categories are selected, keep only those groups; the
  // "Other" bucket (id '__none__') is itself a selectable option. Stale ids
  // (e.g. a category removed after the event was changed) are dropped so they
  // can never silently hide every sponsor.
  const availableIds = new Set(groups.map((g) => String(g.id)));
  const selectedCats = (Array.isArray(c.categoryIds) ? c.categoryIds.map(String) : [])
    .filter((id) => availableIds.has(id));
  const filteredGroups = selectedCats.length === 0
    ? groups
    : groups.filter((g) => selectedCats.includes(String(g.id)));

  // A filter selection that matches no sponsors behaves like the empty state.
  if (filteredGroups.length === 0) {
    if (!asEditor) return null;
    return <EmptyState icon={Building2} text="No sponsors match the selected categories." />;
  }

  if (!showHeadings) {
    const seen = new Set();
    const all = [];
    for (const g of filteredGroups) {
      for (const s of g.sponsors) {
        if (seen.has(String(s.id))) continue;
        seen.add(String(s.id));
        all.push(s);
      }
    }
    return (
      <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || 'Sponsors'} data-testid="sponsor-grid">
        <div style={gridStyle(cols, gap)}>
          {all.map((s) => (
            <SponsorCard key={s.id} sponsor={s} showDescription={showDescription} showSponsorDetail={showSponsorDetail} detail={detailById.get(String(s.id))} nameStyle={nameStyle} descStyle={descStyle} onClick={() => setSelected(s)} />
          ))}
        </div>

        {/* Single-sponsor detail dialog */}
        <Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" data-testid="dialog-sponsor-carousel-detail">
            <DialogHeader>
              <DialogTitle>Sponsor</DialogTitle>
              <DialogDescription className="sr-only">Sponsor profile details</DialogDescription>
            </DialogHeader>
            <SponsorDetail sponsor={selected} />
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || 'Sponsors'} data-testid="sponsor-grid">
      <div className="flex flex-col gap-6">
        {filteredGroups.map((g) => (
          <div key={g.id} data-testid={`sponsor-group-${g.id}`}>
            {g.name ? (
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-3">{g.name}</h3>
            ) : null}
            <div style={gridStyle(cols, gap)}>
              {g.sponsors.map((s) => (
                <SponsorCard key={s.id} sponsor={s} showDescription={showDescription} showSponsorDetail={showSponsorDetail} detail={detailById.get(String(s.id))} nameStyle={nameStyle} descStyle={descStyle} onClick={() => setSelected(s)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Single-sponsor detail dialog */}
      <Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" data-testid="dialog-sponsor-carousel-detail">
          <DialogHeader>
            <DialogTitle>Sponsor</DialogTitle>
            <DialogDescription className="sr-only">Sponsor profile details</DialogDescription>
          </DialogHeader>
          <SponsorDetail sponsor={selected} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SponsorGridInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  // Derive category options from the same sponsor data the renderer loads,
  // including the "Other" bucket (id '__none__') when present.
  const { hasEvent, groups } = useEventSponsors(c.eventId);
  const categoryOptions = groups.map((g) => ({
    value: g.id,
    label: g.id === '__none__' ? (g.name || 'Other') : (g.name || 'Untitled category'),
  }));
  // The "Other" bucket can't be reordered — it always renders last.
  const orderableOptions = categoryOptions.filter((o) => o.value !== '__none__');
  return (
    <>
      <EventCarouselPickerRow
        value={c.eventId || ''}
        onChange={(v) => set({ eventId: v, categoryIds: [], categoryOrder: [] })}
        testId="select-sponsor-grid-event"
      />
      {hasEvent && categoryOptions.length > 0 ? (
        <MultiCheckboxField
          label="Filter by category"
          value={c.categoryIds}
          onChange={(v) => set({ categoryIds: v })}
          options={categoryOptions}
          testId="multiselect-sponsor-grid-categories"
          hint="Leave all unchecked to show every sponsor for the event."
        />
      ) : null}
      {hasEvent && orderableOptions.length > 1 ? (
        <CategoryReorderField
          options={orderableOptions}
          value={c.categoryOrder}
          onChange={(v) => set({ categoryOrder: v })}
          testId="reorder-sponsor-grid-categories"
          hint="Use the arrows to set the order categories appear in. 'Other' always shows last."
        />
      ) : null}
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField
        label="Gap (px)"
        min={0}
        value={c.gap ?? 16}
        onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })}
        testId="input-sponsor-grid-gap"
      />
      <ToggleField
        label="Show description"
        value={c.showDescription !== false}
        onChange={(v) => set({ showDescription: v })}
        testId="toggle-sponsor-grid-description"
      />
      <ToggleField
        label="Event specific sponsor details"
        value={c.showSponsorDetail === true}
        onChange={(v) => set({ showSponsorDetail: v })}
        testId="toggle-sponsor-grid-sponsor-detail"
        hint="Show what each sponsor is sponsoring for this event (e.g. Lunch), when entered."
      />
      <ToggleField
        label="Group by category"
        value={c.showCategoryHeadings !== false}
        onChange={(v) => set({ showCategoryHeadings: v })}
        testId="toggle-sponsor-grid-headings"
      />
      <TextField
        label="Empty state text"
        value={c.emptyText}
        onChange={(v) => set({ emptyText: v })}
        testId="input-sponsor-grid-empty-text"
        hint="Shown in the editor when no event or no sponsors are found."
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Sponsor name</Label>
      </div>
      <ResponsiveNumberField
        label="Name font size (px)"
        min={1}
        value={c.nameFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ nameFontSize: v })}
        testId="input-sponsor-grid-name-font-size"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Description</Label>
      </div>
      <ResponsiveNumberField
        label="Description font size (px)"
        min={1}
        value={c.descFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ descFontSize: v })}
        testId="input-sponsor-grid-desc-font-size"
      />
    </>
  );
}

// ============================================================================
// SPONSOR CAROUSEL
// ============================================================================
// Same sponsor data + card as the Sponsor grid, wrapped in the auto-scrolling
// paged carousel shell modelled on the Speaker carousel.
function SponsorCarouselRender({ block, asEditor, breakpoint }) {
  const c = block.content || {};
  const { hasEvent, groups, detailById, totalSponsors, isLoading, isError } = useEventSponsors(c.eventId);

  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [hovered, setHovered] = useState(false);
  const [autoplayPausedAt, setAutoplayPausedAt] = useState(0);
  const [selected, setSelected] = useState(null);
  const touchStartRef = useRef(null);

  // Flatten the grouped sponsors into a single de-duplicated list, applying the
  // optional category filter (mirrors the Sponsor grid logic). The carousel
  // does not show category headings, so we always collapse to one list.
  const availableIds = new Set(groups.map((g) => String(g.id)));
  const selectedCats = (Array.isArray(c.categoryIds) ? c.categoryIds.map(String) : [])
    .filter((id) => availableIds.has(id));
  const filteredGroups = selectedCats.length === 0
    ? groups
    : groups.filter((g) => selectedCats.includes(String(g.id)));
  const sponsors = useMemo(() => {
    const seen = new Set();
    const all = [];
    for (const g of filteredGroups) {
      for (const s of g.sponsors) {
        if (seen.has(String(s.id))) continue;
        seen.add(String(s.id));
        all.push(s);
      }
    }
    return all;
  }, [filteredGroups]);

  const count = sponsors.length;
  const perView = Math.max(1, Number(c.sponsorsPerView) || 1);
  const pageCount = Math.max(1, Math.ceil(count / perView));
  const hasMany = pageCount > 1;
  const gap = c.gap ?? 16;
  const transitionStyle = c.transition || 'slide';
  const transitionMs = Math.max(100, Number(c.transitionMs) || 400);
  const pauseOnHover = !!c.pauseOnHover;

  useEffect(() => {
    if (index > Math.max(0, pageCount - 1)) setIndex(0);
  }, [pageCount, index]);

  useEffect(() => {
    if (asEditor) return;
    if (!c.autoplay || pageCount < 2) return;
    // Pause autoplay while the detail dialog is open so the slide doesn't move
    // under the user as they read a profile.
    if (selected) return;
    // Pause-on-hover: when enabled, hovering the carousel halts autoplay.
    if (pauseOnHover && hovered) return;
    const ms = Math.max(1500, Number(c.autoplayMs) || 5000);
    const pauseMs = Math.max(ms, 4000);
    const t = setInterval(() => {
      if (autoplayPausedAt && Date.now() - autoplayPausedAt < pauseMs) return;
      setDirection(1);
      setIndex((i) => (i + 1) % pageCount);
    }, ms);
    return () => clearInterval(t);
  }, [asEditor, c.autoplay, c.autoplayMs, pageCount, autoplayPausedAt, selected, pauseOnHover, hovered]);

  const goPrev = () => { setDirection(-1); setIndex((i) => (i - 1 + pageCount) % pageCount); };
  const goNext = () => { setDirection(1); setIndex((i) => (i + 1) % pageCount); };

  const handleTouchStart = (ev) => {
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  };
  const handleTouchEnd = (ev) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || pageCount < 2) return;
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
    if (pageCount < 2) return;
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

  // Empty / no-sponsor states show an editor placeholder, but render nothing
  // disruptive on the published public page.
  if (!hasEvent) {
    if (!asEditor) return null;
    return <EmptyState icon={Building2} text={c.emptyText || 'Pick an event with assigned sponsors in the inspector.'} />;
  }
  if (isLoading) return <ListSkeleton count={Math.min(perView, 4)} columns={Math.min(perView, 4)} gap={gap} />;
  if (isError) {
    if (!asEditor) return null;
    return <ErrorState message="Couldn't load sponsors right now." />;
  }
  if (totalSponsors === 0) {
    if (!asEditor) return null;
    return <EmptyState icon={Building2} text="The selected event has no sponsors yet." />;
  }
  // A filter selection that matches no sponsors behaves like the empty state.
  if (count === 0) {
    if (!asEditor) return null;
    return <EmptyState icon={Building2} text="No sponsors match the selected categories." />;
  }

  const showArrows = hasMany && c.showArrows !== false;
  const showIndicators = hasMany && c.showIndicators !== false;
  const showDescription = c.showDescription !== false;
  const showSponsorDetail = c.showSponsorDetail === true;

  // Responsive font sizing — inline px literal in forced-breakpoint preview,
  // CSS var (driven by buildCanvasCss @media rules) on real public pages.
  const isForcedPreview = !!breakpoint;
  const nameFontSize = resolveResponsiveValue(c.nameFontSize, breakpoint);
  const descFontSize = resolveResponsiveValue(c.descFontSize, breakpoint);
  const cssVar = (raw, name) => (hasAnyResponsiveValue(raw) ? `var(${name})` : null);
  const nameStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(nameFontSize)) nameStyle.fontSize = `${nameFontSize}px`;
  } else {
    const v = cssVar(c.nameFontSize, '--cb-spc-name-fs');
    if (v) nameStyle.fontSize = v;
  }
  const descStyle = {};
  if (isForcedPreview) {
    if (Number.isFinite(descFontSize)) descStyle.fontSize = `${descFontSize}px`;
  } else {
    const v = cssVar(c.descFontSize, '--cb-spc-desc-fs');
    if (v) descStyle.fontSize = v;
  }

  const openSponsor = (s) => { setSelected(s); setAutoplayPausedAt(Date.now()); };

  // Current page's sponsors; padded to `perView` so the last (short) page keeps
  // equal-width slots instead of stretching the remaining cards.
  const pageSponsors = sponsors.slice(index * perView, index * perView + perView);
  const pageSlice = perView > 1
    ? Array.from({ length: perView }, (_, i) => pageSponsors[i] || null)
    : pageSponsors;

  return (
    <div
      className="relative w-full h-full overflow-hidden flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      aria-label={block.a11y?.ariaLabel || 'Sponsor carousel'}
      data-testid="sponsor-carousel"
      role="region"
      aria-roledescription="carousel"
      tabIndex={hasMany ? 0 : -1}
      onTouchStart={hasMany ? handleTouchStart : undefined}
      onTouchEnd={hasMany ? handleTouchEnd : undefined}
      onKeyDown={hasMany ? handleKeyDown : undefined}
      onMouseEnter={pauseOnHover ? () => setHovered(true) : undefined}
      onMouseLeave={pauseOnHover ? () => setHovered(false) : undefined}
      style={hasMany ? { touchAction: 'pan-y' } : undefined}
    >
      <div className="relative flex-1 min-h-0">
        <CarouselStage
          transition={transitionStyle}
          durationMs={transitionMs}
          direction={direction}
          slideKey={index}
        >
          <div className="w-full h-full flex items-stretch px-8 py-4" style={{ gap: `${gap}px` }}>
            {pageSlice.map((s, i) => (
              <div key={s ? s.id : `empty-${index}-${i}`} className="flex-1 min-w-0">
                {s ? (
                  <SponsorCard
                    sponsor={s}
                    showDescription={showDescription}
                    showSponsorDetail={showSponsorDetail}
                    detail={detailById.get(String(s.id))}
                    nameStyle={nameStyle}
                    descStyle={descStyle}
                    onClick={() => openSponsor(s)}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </CarouselStage>

        {showArrows ? (
          <>
            <button
              type="button"
              onClick={() => { goPrev(); setAutoplayPausedAt(Date.now()); }}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/80 hover:bg-white border border-slate-200 flex items-center justify-center shadow-sm"
              aria-label="Previous sponsors"
              data-testid="button-sponsor-carousel-prev"
            >
              <ChevronLeft className="w-4 h-4 text-slate-700" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => { goNext(); setAutoplayPausedAt(Date.now()); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/80 hover:bg-white border border-slate-200 flex items-center justify-center shadow-sm"
              aria-label="Next sponsors"
              data-testid="button-sponsor-carousel-next"
            >
              <ChevronRight className="w-4 h-4 text-slate-700" aria-hidden="true" />
            </button>
          </>
        ) : null}

        {showIndicators ? (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
            {Array.from({ length: pageCount }).map((_, i) => {
              const active = i === index;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => { setDirection(i >= index ? 1 : -1); setIndex(i); setAutoplayPausedAt(Date.now()); }}
                  aria-label={`Show page ${i + 1} of ${pageCount}`}
                  aria-current={active ? 'true' : undefined}
                  className={`w-2 h-2 rounded-full border border-white/80 ${active ? 'bg-slate-900' : 'bg-slate-400/70'}`}
                  data-testid={`button-sponsor-carousel-indicator-${i}`}
                />
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Single-sponsor detail dialog */}
      <Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" data-testid="dialog-sponsor-carousel-detail">
          <DialogHeader>
            <DialogTitle>Sponsor</DialogTitle>
            <DialogDescription className="sr-only">Sponsor profile details</DialogDescription>
          </DialogHeader>
          <SponsorDetail sponsor={selected} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SponsorCarouselInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  // Derive category options from the same sponsor data the renderer loads,
  // including the "Other" bucket (id '__none__') when present.
  const { hasEvent, groups } = useEventSponsors(c.eventId);
  const categoryOptions = groups.map((g) => ({
    value: g.id,
    label: g.id === '__none__' ? (g.name || 'Other') : (g.name || 'Untitled category'),
  }));
  return (
    <>
      <EventCarouselPickerRow
        value={c.eventId || ''}
        onChange={(v) => set({ eventId: v, categoryIds: [] })}
        testId="select-sponsor-carousel-event"
      />
      {hasEvent && categoryOptions.length > 0 ? (
        <MultiCheckboxField
          label="Filter by category"
          value={c.categoryIds}
          onChange={(v) => set({ categoryIds: v })}
          options={categoryOptions}
          testId="multiselect-sponsor-carousel-categories"
          hint="Leave all unchecked to show every sponsor for the event."
        />
      ) : null}
      <NumberField
        label="Sponsors per page"
        min={1}
        value={c.sponsorsPerView || 1}
        onChange={(v) => set({ sponsorsPerView: Math.max(1, Math.floor(Number(v) || 1)) })}
        testId="input-sponsor-carousel-per-view"
        hint="How many sponsor cards to show side-by-side in one slide."
      />
      <NumberField
        label="Gap (px)"
        min={0}
        value={c.gap ?? 16}
        onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })}
        testId="input-sponsor-carousel-gap"
      />
      <ToggleField
        label="Show description"
        value={c.showDescription !== false}
        onChange={(v) => set({ showDescription: v })}
        testId="toggle-sponsor-carousel-description"
      />
      <ToggleField
        label="Event specific sponsor details"
        value={c.showSponsorDetail === true}
        onChange={(v) => set({ showSponsorDetail: v })}
        testId="toggle-sponsor-carousel-sponsor-detail"
        hint="Show what each sponsor is sponsoring for this event (e.g. Lunch), when entered."
      />
      <ToggleField
        label="Autoplay"
        value={c.autoplay !== false}
        onChange={(v) => set({ autoplay: v })}
        testId="toggle-sponsor-carousel-autoplay"
      />
      <NumberField
        label="Autoplay interval (ms)"
        min={1500}
        value={c.autoplayMs || 5000}
        onChange={(v) => set({ autoplayMs: Math.max(1500, Number(v) || 5000) })}
        testId="input-sponsor-carousel-autoplay-ms"
      />
      <ToggleField
        label="Show prev/next arrows"
        value={c.showArrows !== false}
        onChange={(v) => set({ showArrows: v })}
        testId="toggle-sponsor-carousel-arrows"
      />
      <ToggleField
        label="Show slide indicators"
        value={c.showIndicators !== false}
        onChange={(v) => set({ showIndicators: v })}
        testId="toggle-sponsor-carousel-indicators"
      />
      <SelectField
        label="Slide transition"
        value={c.transition || 'slide'}
        onChange={(v) => set({ transition: v })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'slide', label: 'Slide' },
          { value: 'fade', label: 'Fade' },
        ]}
        testId="select-sponsor-carousel-transition"
      />
      {(c.transition || 'slide') !== 'none' ? (
        <NumberField
          label="Transition duration (ms)"
          min={100}
          value={c.transitionMs ?? 400}
          onChange={(v) => set({ transitionMs: Math.max(100, Number(v) || 400) })}
          testId="input-sponsor-carousel-transition-ms"
        />
      ) : null}
      <ToggleField
        label="Pause on hover"
        value={!!c.pauseOnHover}
        onChange={(v) => set({ pauseOnHover: v })}
        testId="toggle-sponsor-carousel-pause-hover"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Sponsor name</Label>
      </div>
      <ResponsiveNumberField
        label="Name font size (px)"
        min={1}
        value={c.nameFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ nameFontSize: v })}
        testId="input-sponsor-carousel-name-font-size"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Description</Label>
      </div>
      <ResponsiveNumberField
        label="Description font size (px)"
        min={1}
        value={c.descFontSize}
        breakpoint={breakpoint}
        onChange={(v) => set({ descFontSize: v })}
        testId="input-sponsor-carousel-desc-font-size"
      />

      <TextField
        label="Empty state text"
        value={c.emptyText}
        onChange={(v) => set({ emptyText: v })}
        testId="input-sponsor-carousel-empty-text"
        hint="Shown in the editor when no event or no sponsors are found."
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

  // Co-authors (Task #1230): articles can have multiple authors stored in the
  // blog_post_author join table. Fetch the ordered author list (primary first)
  // for the visible article ids so teasers show co-authors, not just the
  // primary author. News uses a separate entity, so this only runs for articles.
  const articleIdsKey = useMemo(
    () => (source === 'articles' ? items.map((a) => a.id).filter(Boolean).join(',') : ''),
    [source, items]
  );
  const { data: coAuthorsData } = useQuery({
    queryKey: ['canvas', 'article-co-authors', articleIdsKey],
    queryFn: async () => {
      if (!articleIdsKey) return { authors: {} };
      const r = await fetch(`/api/articles/co-authors?ids=${encodeURIComponent(articleIdsKey)}`);
      if (!r.ok) return { authors: {} };
      return r.json();
    },
    enabled: source === 'articles' && !!articleIdsKey,
    staleTime: 60_000,
  });
  const formatAuthorNames = (cards) => {
    const names = (cards || []).map((a) => a.name).filter(Boolean);
    if (names.length === 0) return '';
    return names.reduce((acc, n, idx) => acc + (idx === 0 ? n : (idx === 1 ? ' & ' : ', ') + n), '');
  };

  const linkBase = source === 'news' ? '/NewsView?slug=' : '/Articles?slug=';
  const effectiveCols = layout === 'list' ? 1 : cols;

  // Tenant typography styles for the card title / summary text. When set,
  // the chosen style's font (family/size/weight/line-height/etc.) overrides
  // the hardcoded text-sm / text-xs classes; when unset, cards render
  // exactly as before. Mirrors the Card/Text/Hero block pattern.
  const { styles: tenantStyles, resolved: stylesResolved } = useTenantTypographyStylesState();
  const titleStyleObj = resolveTenantStyle(c.titleTypographyStyleId, tenantStyles);
  const summaryStyleObj = resolveTenantStyle(c.summaryTypographyStyleId, tenantStyles);
  const awaitingTitle = isAwaitingTypographyStyle(c.titleTypographyStyleId, titleStyleObj, stylesResolved);
  const awaitingSummary = isAwaitingTypographyStyle(c.summaryTypographyStyleId, summaryStyleObj, stylesResolved);
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const bpForInline = isPreview ? breakpoint : 'desktop';
  // When awaiting an unresolved style, carry a `visibility: hidden` inline
  // style (truthy) so the legacy text-sm/text-xs class is also dropped and
  // the default size never flashes before the custom style arrives.
  let titleInline = titleStyleObj
    ? buildTypographyInlineStyle(titleStyleObj, { breakpoint: bpForInline })
    : null;
  if (awaitingTitle) titleInline = { ...(titleInline || {}), visibility: 'hidden' };
  let summaryInline = summaryStyleObj
    ? buildTypographyInlineStyle(summaryStyleObj, { breakpoint: bpForInline })
    : null;
  if (awaitingSummary) summaryInline = { ...(summaryInline || {}), visibility: 'hidden' };
  const safeBlockId = String(block.id || '').replace(/["\\]/g, '');
  const responsiveCss = !isPreview
    ? [
        titleStyleObj && hasResponsiveTypographyOverride(titleStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="article-title"]`, titleStyleObj)
          : null,
        summaryStyleObj && hasResponsiveTypographyOverride(summaryStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="article-summary"]`, summaryStyleObj)
          : null,
      ].filter(Boolean).join('')
    : '';

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || c.title || 'Articles'}>
      {responsiveCss ? <style dangerouslySetInnerHTML={{ __html: responsiveCss }} /> : null}
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
                <h3
                  className={titleInline ? 'text-slate-900 m-0' : 'text-sm font-semibold text-slate-900 m-0'}
                  style={titleInline || undefined}
                  data-tg-r="article-title"
                >
                  {a.title}
                </h3>
                {a.published_date ? (
                  <div className="text-xs text-slate-500">{formatDate(a.published_date)}</div>
                ) : null}
                {source === 'articles' && (() => {
                  const authorText = formatAuthorNames(coAuthorsData?.authors?.[a.id]);
                  if (!authorText) return null;
                  return (
                    <div
                      className="text-xs text-slate-500 flex items-center gap-1"
                      data-testid={`text-article-authors-${a.id}`}
                    >
                      <User className="w-3 h-3 flex-shrink-0" />
                      <span>by {authorText}</span>
                    </div>
                  );
                })()}
                {c.showSummary !== false && a.summary ? (
                  <p
                    className={summaryInline ? 'text-slate-600 line-clamp-3 mt-1' : 'text-xs text-slate-600 line-clamp-3 mt-1'}
                    style={summaryInline || undefined}
                    data-tg-r="article-summary"
                  >
                    {a.summary}
                  </p>
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
      <TypographyStyleField
        label="Card title style"
        value={c.titleTypographyStyleId}
        onChange={(id) => set({ titleTypographyStyleId: id })}
        testId="select-article-list-title-typography"
      />
      <TypographyStyleField
        label="Card text style"
        value={c.summaryTypographyStyleId}
        onChange={(id) => set({ summaryTypographyStyleId: id })}
        testId="select-article-list-summary-typography"
      />
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
// CARD DECK
// ============================================================================
// Renders a responsive grid of cards from the shared card library (the same
// `card_deck` source the iEdit Card Deck element uses). Authors pick which
// cards appear and in what order via the inspector; layout follows the
// standard per-breakpoint columns + gap convention used by the other data
// blocks (not the iEdit fixed-grid mapping).
function useCardDeckCards() {
  return useQuery({
    queryKey: ['canvas', 'public-card-decks'],
    queryFn: async () => (await publicClient.listCardDecks()) || [],
    staleTime: 60_000,
  });
}

function CardDeckRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const cols = columnsForBreakpoint(c, breakpoint);
  const gap = c.gap ?? 24;
  const showImage = c.showImage !== false;
  const showDescription = c.showDescription !== false;
  const showButton = c.showButton !== false;
  const { data: allCards, isLoading, isError } = useCardDeckCards();

  const cards = useMemo(() => {
    const byId = new Map((Array.isArray(allCards) ? allCards : []).map((card) => [String(card.id), card]));
    return (Array.isArray(c.cardIds) ? c.cardIds : [])
      .filter(Boolean)
      .map((id) => byId.get(String(id)))
      .filter(Boolean);
  }, [allCards, c.cardIds]);

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || c.title || 'Card deck'}>
      {c.title ? <Heading level={c.headingLevel || 2}>{c.title}</Heading> : null}
      {isLoading ? (
        <ListSkeleton count={Math.min((c.cardIds || []).filter(Boolean).length || 3, 6)} columns={cols} gap={gap} />
      ) : isError ? (
        <ErrorState message="Couldn't load cards right now." />
      ) : cards.length === 0 ? (
        <EmptyState icon={LayoutGrid} text={c.emptyText || 'Select cards in the inspector.'} />
      ) : (
        <ul className="list-none m-0 p-0" style={gridStyle(cols, gap)} data-testid="card-deck">
          {cards.map((card) => (
            <li
              key={card.id}
              className="rounded-md border border-slate-200 bg-white overflow-hidden flex flex-col"
              data-testid={`card-deck-item-${card.id}`}
            >
              {showImage && card.image_url ? (
                <div className="aspect-[16/9] bg-slate-100">
                  <img src={card.image_url} alt={card.title || ''} className="w-full h-full object-cover" loading="lazy" />
                </div>
              ) : null}
              <div className="p-4 flex-1 flex flex-col gap-2">
                {card.title ? (
                  <h3 className="text-base font-semibold text-slate-900 m-0">{card.title}</h3>
                ) : null}
                {showDescription && card.description ? (
                  <p className="text-sm text-slate-600 line-clamp-3 m-0">{card.description}</p>
                ) : null}
                {Array.isArray(card.links) && card.links.some((l) => l?.url && l?.text) ? (
                  <ul className="list-none p-0 m-0 space-y-1">
                    {card.links.map((link, idx) => (
                      link?.url && link?.text ? (
                        <li key={idx} className="m-0">
                          <a
                            href={asEditor ? undefined : link.url}
                            onClick={(ev) => { if (asEditor) ev.preventDefault(); }}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-blue-600 hover:underline"
                            data-testid={`link-card-deck-${card.id}-${idx}`}
                          >
                            {link.text}
                          </a>
                        </li>
                      ) : null
                    ))}
                  </ul>
                ) : null}
                {showButton && card.target_url ? (
                  <a
                    href={asEditor ? undefined : card.target_url}
                    onClick={(ev) => { if (asEditor) ev.preventDefault(); }}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1 mt-auto pt-2"
                    data-testid={`button-card-deck-${card.id}`}
                  >
                    {card.button_text || 'Learn more'} <ArrowRight className="w-3 h-3" />
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CardDeckPickerRow({ value, onChange, testId, disabledValues = [] }) {
  const { data: cards, isLoading } = useCardDeckCards();
  const [open, setOpen] = useState(false);
  const options = (cards || []).map((card) => ({ value: String(card.id), label: card.title || '(untitled card)' }));
  const current = options.find((o) => o.value === String(value || ''));
  const disabledSet = new Set((disabledValues || []).map(String));
  return (
    <Field label="Card" hint={isLoading ? 'Loading cards…' : null}>
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
            <span className="truncate text-left">{current ? current.label : 'Select a card'}</span>
            <ChevronRight className="ml-2 h-4 w-4 shrink-0 opacity-50 rotate-90" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[--radix-popover-trigger-width]" align="start">
          <Command>
            <CommandInput placeholder="Search cards…" data-testid={`${testId}-search`} />
            <CommandList>
              <CommandEmpty>No cards found.</CommandEmpty>
              <CommandGroup>
                {options.map((o) => {
                  const isDisabled = disabledSet.has(o.value) && o.value !== String(value || '');
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

function CardDeckInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const ids = Array.isArray(c.cardIds) ? c.cardIds : [];
  return (
    <>
      <Field label="Cards" hint="Add cards from your card library. Use Up/Down to reorder.">
        <CarouselArrayList
          items={ids}
          onChange={(next) => set({ cardIds: next })}
          renderItem={(item, idx, setItem) => (
            <CardDeckPickerRow
              value={item || ''}
              onChange={(v) => setItem(v)}
              testId={`select-card-deck-card-${idx}`}
              disabledValues={ids.filter((_, i) => i !== idx)}
            />
          )}
          makeNew={() => ''}
          addLabel="Add card"
          testIdPrefix="card-deck-cards"
        />
      </Field>
      <TextField label="Heading" value={c.title} onChange={(v) => set({ title: v })} testId="input-card-deck-title" />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 2)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[2, 3, 4].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-card-deck-heading-level"
      />
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap ?? 24} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-card-deck-gap" />
      <ToggleField label="Show image" value={c.showImage !== false} onChange={(v) => set({ showImage: v })} testId="toggle-card-deck-image" />
      <ToggleField label="Show description" value={c.showDescription !== false} onChange={(v) => set({ showDescription: v })} testId="toggle-card-deck-description" />
      <ToggleField label="Show button" value={c.showButton !== false} onChange={(v) => set({ showButton: v })} testId="toggle-card-deck-button" />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-card-deck-empty" />
    </>
  );
}

// ============================================================================
// WALL OF FAME
// ============================================================================
// Renders the shared WallOfFameDisplay (the same component the iEdit Wall of
// Fame element uses) bound to a published Wall of Fame section. Authors pick
// the section + standard per-breakpoint layout options and card-feature
// toggles via the inspector; WallOfFameDisplay handles category navigation,
// flip cards, bios and contact links exactly as in iEdit.
function useWallOfFameSections() {
  return useQuery({
    queryKey: ['canvas', 'public-wall-of-fame-sections'],
    queryFn: async () => (await publicClient.listWallOfFameSections()) || [],
    staleTime: 60_000,
  });
}

function WallOfFameRender({ block, breakpoint }) {
  const c = block.content || {};
  const cols = columnsForBreakpoint(c, breakpoint);
  const gap = c.gap ?? 24;
  const { data: sections, isLoading, isError } = useWallOfFameSections();
  // When full-bleed, the block spans 100vw but its content should re-align to
  // the page's centered content column. `--cb-content-width` is published by
  // the stage stylesheet per breakpoint (1200/768/375); falls back to 1200.
  const railStyle = c.fullBleed
    ? { maxWidth: 'var(--cb-content-width, 1200px)', marginInline: 'auto' }
    : undefined;

  if (!c.sectionId) {
    return (
      <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || 'Wall of Fame'}>
        <div className="w-full h-full" style={railStyle}>
          {isLoading ? (
            <ListSkeleton count={3} columns={cols} gap={gap} />
          ) : (
            <EmptyState icon={Award} text={c.emptyText || 'Select a Wall of Fame section in the inspector.'} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || 'Wall of Fame'}>
      <div className="w-full h-full" style={railStyle}>
        {isError ? (
          <ErrorState message="Couldn't load the Wall of Fame right now." />
        ) : (
          <WallOfFameDisplay
            sectionId={c.sectionId}
            categoryId={c.categoryId || null}
            cardsPerRow={cols}
            cardGap={gap}
            showPhoto={c.showPhoto !== false}
            showJobTitle={c.showJobTitle !== false}
            showBioSnippet={!!c.showBioSnippet}
          />
        )}
      </div>
    </div>
  );
}

function WallOfFameSectionPicker({ value, onChange, testId }) {
  const { data: sections, isLoading } = useWallOfFameSections();
  const options = (Array.isArray(sections) ? sections : [])
    .map((s) => ({ value: String(s.id), label: s.name || '(untitled section)' }));
  return (
    <Field label="Wall of Fame section" hint={isLoading ? 'Loading sections…' : 'Choose which Wall of Fame section to display.'}>
      <Select value={value ? String(value) : ''} onValueChange={onChange}>
        <SelectTrigger className="h-8" data-testid={testId}>
          <SelectValue placeholder="Select a section" />
        </SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <div className="p-2 text-xs text-slate-500">No sections available</div>
          ) : (
            options.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </Field>
  );
}

function useWallOfFameCategories(sectionId) {
  return useQuery({
    queryKey: ['canvas', 'public-wall-of-fame-categories', sectionId],
    queryFn: async () => (await publicClient.listWallOfFameCategories(sectionId)) || [],
    enabled: !!sectionId,
    staleTime: 60_000,
  });
}

const WALL_OF_FAME_ALL_CATEGORIES = '__all__';

function WallOfFameCategoryPicker({ sectionId, value, onChange, testId }) {
  const { data: categories, isLoading } = useWallOfFameCategories(sectionId);
  const options = (Array.isArray(categories) ? categories : [])
    .map((cat) => ({ value: String(cat.id), label: cat.name || '(untitled category)' }));
  return (
    <Field
      label="Category (optional)"
      hint={isLoading ? 'Loading categories…' : 'Pin the block to a single category, skipping the category navigation.'}
    >
      <Select
        value={value ? String(value) : WALL_OF_FAME_ALL_CATEGORIES}
        onValueChange={(v) => onChange(v === WALL_OF_FAME_ALL_CATEGORIES ? null : v)}
      >
        <SelectTrigger className="h-8" data-testid={testId}>
          <SelectValue placeholder="All categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={WALL_OF_FAME_ALL_CATEGORIES}>All categories</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function WallOfFameInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <WallOfFameSectionPicker
        value={c.sectionId}
        onChange={(v) => set({ sectionId: v, categoryId: null })}
        testId="select-wall-of-fame-section"
      />
      {c.sectionId ? (
        <WallOfFameCategoryPicker
          sectionId={c.sectionId}
          value={c.categoryId}
          onChange={(v) => set({ categoryId: v })}
          testId="select-wall-of-fame-category"
        />
      ) : null}
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap ?? 24} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-wall-of-fame-gap" />
      <ToggleField label="Show photo" value={c.showPhoto !== false} onChange={(v) => set({ showPhoto: v })} testId="toggle-wall-of-fame-photo" />
      <ToggleField label="Show job title" value={c.showJobTitle !== false} onChange={(v) => set({ showJobTitle: v })} testId="toggle-wall-of-fame-job-title" />
      <ToggleField label="Show bio snippet" value={!!c.showBioSnippet} onChange={(v) => set({ showBioSnippet: v })} testId="toggle-wall-of-fame-bio-snippet" />
      <ToggleField
        label="Full-bleed (span full screen width)"
        value={!!c.fullBleed}
        onChange={(v) => set({ fullBleed: v })}
        testId="toggle-wall-of-fame-full-bleed"
      />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-wall-of-fame-empty" />
    </>
  );
}

// ============================================================================
// PHOTO GALLERY
// ============================================================================
// Renders a tenant photo gallery onto a canvas page. Pagination state is kept
// block-local (useState) — deliberately NOT mirrored to the page URL's ?page=
// so multiple galleries on one page paginate independently and don't fight the
// page-level query string. Photos are fetched per-page from the public gallery
// API; private galleries come back locked (no photos) and we show a message.
function galleryPageNumbers(current, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages = new Set([1, totalPages, current, current - 1, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

function GalleryRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const cols = columnsForBreakpoint(c, breakpoint);
  const pageSize = Math.max(1, Math.min(48, c.pageSize || 12));
  const [page, setPage] = useState(1);
  const [lightboxIndex, setLightboxIndex] = useState(null);

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ['canvas', 'public-gallery', c.gallerySlug, page, pageSize],
    queryFn: () => publicClient.getGallery(c.gallerySlug, page, pageSize),
    enabled: !!c.gallerySlug,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  if (!c.gallerySlug) {
    return <EmptyState icon={Images} text={c.emptyText || 'Select a photo gallery in the inspector.'} />;
  }
  if (isLoading) {
    return (
      <div className="w-full h-full flex flex-col gap-3">
        {c.heading ? <Heading level={c.headingLevel || 2}>{c.heading}</Heading> : null}
        <ListSkeleton count={pageSize > 6 ? 6 : pageSize} columns={cols} gap={c.gap ?? 16} />
      </div>
    );
  }
  if (isError || !data) {
    return <ErrorState message="This gallery could not be loaded." />;
  }

  if (data.is_locked) {
    return (
      <div className="w-full h-full flex flex-col gap-3">
        {(c.heading || data.title) ? <Heading level={c.headingLevel || 2}>{c.heading || data.title}</Heading> : null}
        <div
          className="w-full flex-1 min-h-[120px] flex flex-col items-center justify-center text-center px-6 py-8 text-slate-500"
          data-testid="gallery-locked"
        >
          <Lock className="w-8 h-8 mb-2 text-slate-400" aria-hidden="true" />
          <p className="text-sm">This gallery is for members only.</p>
        </div>
      </div>
    );
  }

  const photos = Array.isArray(data.photos) ? data.photos : [];
  const total = data.total_photos ?? photos.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (total === 0) {
    return (
      <div className="w-full h-full flex flex-col gap-3">
        {(c.heading || data.title) ? <Heading level={c.headingLevel || 2}>{c.heading || data.title}</Heading> : null}
        <EmptyState icon={Images} text="This gallery has no photos yet." />
      </div>
    );
  }

  const go = (p) => {
    const next = Math.max(1, Math.min(totalPages, p));
    if (next !== page) {
      setPage(next);
      setLightboxIndex(null);
    }
  };

  return (
    <div className="w-full h-full flex flex-col gap-4 overflow-auto" aria-label={block.a11y?.ariaLabel || c.heading || data.title || 'Photo gallery'}>
      {(c.heading || data.title) ? <Heading level={c.headingLevel || 2}>{c.heading || data.title}</Heading> : null}
      <div style={gridStyle(cols, c.gap ?? 16)} aria-busy={isFetching ? 'true' : undefined}>
        {photos.map((photo, i) => {
          const { alt, role } = resolveAlt(photo, data.title, false);
          return (
            <button
              key={photo.id}
              type="button"
              className="relative block w-full aspect-[4/3] bg-slate-100 rounded-md overflow-hidden hover-elevate active-elevate-2"
              onClick={() => { if (asEditor) return; setLightboxIndex(i); }}
              aria-label={`Open photo ${i + 1}${alt ? `: ${alt}` : ''}`}
              data-testid={`button-gallery-photo-${photo.id}`}
            >
              <GalleryImage photo={photo} className="w-full h-full object-cover" alt={alt} role={role} />
            </button>
          );
        })}
      </div>

      {totalPages > 1 ? (
        <nav className="flex flex-wrap items-center justify-center gap-1.5" aria-label="Gallery pages">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => go(page - 1)}
            data-testid="button-gallery-prev"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
            Prev
          </Button>
          {galleryPageNumbers(page, totalPages).map((p, i) =>
            p === '…' ? (
              <span key={`ellipsis-${i}`} className="px-2 text-sm text-slate-400" aria-hidden="true">…</span>
            ) : (
              <Button
                key={p}
                size="sm"
                variant={p === page ? 'default' : 'outline'}
                onClick={() => go(p)}
                aria-current={p === page ? 'page' : undefined}
                aria-label={`Page ${p}`}
                data-testid={`button-gallery-page-${p}`}
              >
                {p}
              </Button>
            )
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => go(page + 1)}
            data-testid="button-gallery-next"
          >
            Next
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          </Button>
        </nav>
      ) : null}

      {!asEditor && lightboxIndex !== null ? (
        <Lightbox
          gallery={{ title: c.heading || data.title, photos }}
          activeIndex={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          srOptimised={false}
        />
      ) : null}
    </div>
  );
}

// Picker uses the authenticated entity API (the inspector is admin-side), so
// admins can pick any gallery — including member-only ones, which the public
// renderer then surfaces with a locked message to anonymous visitors.
function GalleryPickerField({ value, onChange, testId }) {
  const { data: galleries, isLoading } = useQuery({
    queryKey: ['canvas', 'admin-galleries'],
    queryFn: () => base44.entities.Gallery.list('display_order'),
    staleTime: 60_000,
  });
  const options = (galleries || [])
    .filter((g) => g.slug)
    .map((g) => ({ value: g.slug, label: g.is_public ? g.title : `${g.title} (members only)` }));
  return (
    <Field label="Gallery" hint={isLoading ? 'Loading galleries…' : null}>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className="h-8" data-testid={testId}><SelectValue placeholder="Select a gallery" /></SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <SelectItem value="__none__" disabled>No galleries found</SelectItem>
          ) : options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function GalleryInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <GalleryPickerField value={c.gallerySlug} onChange={(v) => set({ gallerySlug: v })} testId="select-gallery-slug" />
      <TextField label="Heading" value={c.heading} onChange={(v) => set({ heading: v })} testId="input-gallery-heading" />
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField
        label="Photos per page"
        value={c.pageSize ?? 12}
        min={1}
        max={48}
        step={1}
        onChange={(v) => set({ pageSize: Math.max(1, Math.min(48, Number(v) || 12)) })}
        testId="input-gallery-page-size"
      />
      <NumberField label="Grid gap (px)" value={c.gap ?? 16} min={0} max={64} step={2} onChange={(v) => set({ gap: Number(v) || 0 })} testId="input-gallery-gap" />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-gallery-empty" />
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
  [BLOCK_TYPES.EVENT_SESSIONS]: {
    label: 'Event sessions',
    icon: CalendarDays,
    category: 'data',
    Editor: (props) => <EventSessionsRender {...props} asEditor />,
    Renderer: EventSessionsRender,
    Inspector: EventSessionsInspector,
  },
  [BLOCK_TYPES.EVENT_CAROUSEL]: {
    label: 'Event carousel',
    icon: Images,
    category: 'data',
    Editor: (props) => <EventCarouselRender {...props} asEditor />,
    Renderer: EventCarouselRender,
    Inspector: EventCarouselInspector,
  },
  [BLOCK_TYPES.SPEAKER_CAROUSEL]: {
    label: 'Speaker carousel',
    icon: Mic,
    category: 'data',
    Editor: (props) => <SpeakerCarouselRender {...props} asEditor />,
    Renderer: SpeakerCarouselRender,
    Inspector: SpeakerCarouselInspector,
  },
  [BLOCK_TYPES.SPEAKER_GRID]: {
    label: 'Speaker grid',
    icon: Mic,
    category: 'data',
    Editor: (props) => <SpeakerGridRender {...props} asEditor />,
    Renderer: SpeakerGridRender,
    Inspector: SpeakerGridInspector,
  },
  [BLOCK_TYPES.SPONSOR_GRID]: {
    label: 'Sponsor grid',
    icon: Building2,
    category: 'data',
    Editor: (props) => <SponsorGridRender {...props} asEditor />,
    Renderer: SponsorGridRender,
    Inspector: SponsorGridInspector,
  },
  [BLOCK_TYPES.SPONSOR_CAROUSEL]: {
    label: 'Sponsor carousel',
    icon: Images,
    category: 'data',
    Editor: (props) => <SponsorCarouselRender {...props} asEditor />,
    Renderer: SponsorCarouselRender,
    Inspector: SponsorCarouselInspector,
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
  [BLOCK_TYPES.CARD_DECK]: {
    label: 'Card deck',
    icon: LayoutGrid,
    category: 'data',
    Editor: (props) => <CardDeckRender {...props} asEditor />,
    Renderer: CardDeckRender,
    Inspector: CardDeckInspector,
  },
  [BLOCK_TYPES.WALL_OF_FAME]: {
    label: 'Wall of Fame',
    icon: Award,
    category: 'data',
    Editor: (props) => <WallOfFameRender {...props} asEditor />,
    Renderer: WallOfFameRender,
    Inspector: WallOfFameInspector,
  },
  [BLOCK_TYPES.GALLERY]: {
    label: 'Photo Gallery',
    icon: Images,
    category: 'data',
    Editor: (props) => <GalleryRender {...props} asEditor />,
    Renderer: GalleryRender,
    Inspector: GalleryInspector,
    allowOverflow: true,
  },
};
