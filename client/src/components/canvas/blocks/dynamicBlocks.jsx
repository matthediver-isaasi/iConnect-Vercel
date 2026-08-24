// Phase 4: dynamic / data-bound canvas blocks.
//
// Each block fetches live data via the existing tenant-scoped public APIs
// using TanStack Query. The same renderer is used in the editor and on the
// public page; in the editor we add `data-canvas-editor` to suppress link
// navigation. Skeleton/empty states and accessibility metadata are baked in.
import { useMemo, useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Calendar, MapPin, FileText, Newspaper, Heart, Users, Layers,
  CalendarDays, Folder, ArrowRight, Loader2, FormInput, Building2,
  ChevronLeft, ChevronRight, Images, User, Mic, ExternalLink, LayoutGrid,
  Award, ChevronUp, ChevronDown, Lock, AlertTriangle, Search, Briefcase,
} from 'lucide-react';
import IEditFeaturedJobElement, { IEditFeaturedJobElementEditor } from '@/components/iedit/elements/IEditFeaturedJobElement';
import { Sparkles } from 'lucide-react';
import { AiCompositionRender, AiCompositionInspector } from './AiCompositionBlock';
import { AiCodeCompositionRender, AiCodeCompositionInspector } from './AiCodeCompositionBlock';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ColorField } from './ColorField';
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
import TenantCtaButton from '@/components/common/TenantCtaButton';
import ShowcaseCard from '@/components/common/ShowcaseCard';
import { sanitizeRichText } from './sanitize';
import { cardDescriptionToHtml } from '@/lib/cardDescriptionHtml';
import { resolveSearchResultsBranding } from '@/lib/searchResultsBranding';
import { getSearchResultTypeIcon, getSearchResultTypeLabel, useArticleDisplayName } from '@/lib/searchResultTypes';
import {
  BLOCK_TYPES,
  BREAKPOINT_MAX_PX,
  resolveResponsiveValue,
  hasResponsiveOverride,
  hasAnyResponsiveValue,
  writeResponsiveValue,
  buildResponsiveImage,
  setBlockContentFullBleed,
} from '@/lib/canvasDesign';
import {
  getResourceShowcaseSourceMode,
  resolveSpecificResourceShowcaseItems,
} from '@/lib/resourceShowcaseSelection';
import { publicClient } from '@/api/publicClient';
import { base44 } from '@/api/base44Client';
import { useNavigate } from 'react-router-dom';
import { useTenantBranding } from '@/contexts/TenantBrandingContext';
import { useArticleUrl } from '@/contexts/ArticleUrlContext';
import { useMicrosite, usePublicChromeBranding } from '@/contexts/MicrositeContext';
import { useCanvasEditorPage } from '../CanvasEditorPageContext';
import {
  isTenantButtonVariant,
  resolveTenantButtonStyle,
  buildTenantButtonInlineStyle,
} from '@/lib/tenantButtonStyle';
import { ComplexEventProgramme } from '@/components/events/ComplexEventSchedule';
import WallOfFameDisplay from '@/components/walloffame/WallOfFameDisplay';
import ResourceCard from '@/components/resources/ResourceCard';
import { resolveResourceNewTab, TENANT_FORM_RESOURCE_TYPE } from '@/lib/resourcePresentation';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DirectoryMemberCard, DirectoryOrganizationCard } from '@/components/directory/DirectoryCards';
import MemberGroupBlockView, { resolveMemberGroupGrid } from './MemberGroupBlockView';
import MemberGroupCardsBlockView from './MemberGroupCardsBlockView';
import {
  useMemberGroupCardsData,
  useMemberGroupRoleHolders,
} from '@/hooks/useMemberGroupCards';
import {
  MEMBER_GROUP_CARD_SOURCE,
  resolveMemberGroupCardColumns,
  resolveMemberGroupCardLimit,
  resolveMemberGroupCardSource,
  resolveSelectedMemberGroupIds,
  resolveSelectedMemberGroupRoles,
  selectSelectedMemberGroups,
  selectSelfJoinMemberGroups,
} from '@/lib/memberGroupCards';
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
  resolveNewTab,
  ImageField,
  SectionGradientStops,
  SECTION_BLEND_MODES,
  buildSectionGradientBackground,
  buildSectionOverlayBackground,
} from './registry';
import { applyFormEmbedResize } from './formEmbedResize';

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
function SelectField({ label, value, onChange, options, testId, disabled, warning, hint }) {
  return (
    <Field label={label} hint={hint}>
      <Select value={value || ''} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="h-8" data-testid={testId}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {warning ? (
        <p className="flex items-start gap-1 text-[11px] text-warning" data-testid={testId ? `${testId}-warning` : undefined}>
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </p>
      ) : null}
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
function MultiCheckboxField({ label, value, onChange, options, testId, hint, warning }) {
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
      {warning ? (
        <p className="flex items-start gap-1 text-[11px] text-warning" data-testid={testId ? `${testId}-warning` : undefined}>
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </p>
      ) : null}
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

// ColorField consolidated into the shared ./ColorField (Task #2561) — it adds
// palette swatch support and degrades to a plain picker outside the editor.

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

// Public pages render blocks WITHOUT a `breakpoint` prop (the visitor's real
// viewport decides), so an inline grid resolved via columnsForBreakpoint
// silently falls back to the desktop column count. On the public path the
// list blocks therefore emit per-breakpoint @media rules (scoped to the
// block's [data-cb] wrapper) instead of an inline grid, mirroring the
// buildResponsiveColumnsCss pattern the pricing/testimonial blocks use.
// In the editor preview `breakpoint` IS set, so the inline grid stays.
function isEditorPreviewBreakpoint(breakpoint) {
  return breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
}

function buildResponsiveListGridCss(blockId, content, gap, { testId, forceSingle = false } = {}) {
  const safeId = String(blockId || '').replace(/["\\]/g, '');
  if (!safeId) return '';
  const desk = forceSingle ? 1 : columnsForBreakpoint(content, 'desktop');
  const tab = forceSingle ? 1 : columnsForBreakpoint(content, 'tablet');
  const mob = forceSingle ? 1 : columnsForBreakpoint(content, 'mobile');
  const sel = testId
    ? `[data-cb="${safeId}"] [data-testid="${testId}"]`
    : `[data-cb="${safeId}"] [data-list-grid]`;
  const g = Number.isFinite(Number(gap)) ? Number(gap) : 16;
  const parts = [
    `${sel}{display:grid;gap:${g}px;grid-template-columns:repeat(${desk},minmax(0,1fr));}`,
  ];
  if (tab !== desk) {
    parts.push(`@media (max-width:${BREAKPOINT_MAX_PX.tablet}px){${sel}{grid-template-columns:repeat(${tab},minmax(0,1fr));}}`);
  }
  if (mob !== tab) {
    parts.push(`@media (max-width:${BREAKPOINT_MAX_PX.mobile}px){${sel}{grid-template-columns:repeat(${mob},minmax(0,1fr));}}`);
  }
  return parts.join('');
}

// Renders a set of sponsor items as a row-by-row flex layout so that any
// under-full row (including the last row of a multi-row dataset) is centered
// independently. Each card keeps the same fixed width as in a normal `cols`-
// column grid: calc((100% - (cols-1)*gap) / cols).
function chunkedGrid(items, cols, gap, renderCard) {
  const g = gap ?? 16;
  const cardBasis = `calc((100% - ${Math.max(0, cols - 1) * g}px) / ${cols})`;
  const rows = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: `${g}px` }}>
      {rows.map((row, ri) => (
        <div
          key={ri}
          style={{
            display: 'flex',
            gap: `${g}px`,
            justifyContent: row.length < cols ? 'center' : undefined,
          }}
        >
          {row.map((item) => (
            <div key={item.id} style={{ flex: `0 0 ${cardBasis}`, minWidth: 0 }}>
              {renderCard(item)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
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

  const isPreview = isEditorPreviewBreakpoint(breakpoint);
  const gridCss = !isPreview
    ? buildResponsiveListGridCss(block.id, c, c.gap, { testId: 'event-list', forceSingle: layout === 'list' })
    : '';

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || c.title || 'Events'}>
      {gridCss ? <style dangerouslySetInnerHTML={{ __html: gridCss }} /> : null}
      {c.title ? <Heading level={c.headingLevel || 2}>{c.title}</Heading> : null}
      {isLoading ? (
        <ListSkeleton count={Math.min(c.limit || 6, 6)} columns={effectiveCols} gap={c.gap} />
      ) : isError ? (
        <ErrorState message="Couldn't load events right now." />
      ) : items.length === 0 ? (
        <EmptyState icon={Calendar} text={c.emptyText || 'No events to show.'} />
      ) : (
        <ul className="list-none m-0 p-0" style={isPreview ? gridStyle(effectiveCols, c.gap) : undefined} data-testid="event-list">
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
  const [viewportNarrow, setViewportNarrow] = useState(() => {
    // Resolve synchronously so the first paint on a real phone is already
    // stacked instead of correcting after an effect runs.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return !!window.matchMedia(`(max-width: ${STACKED_BREAKPOINT_PX - 0.02}px)`).matches;
  });
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
              target={!asEditor && resolveNewTab(c) ? '_blank' : undefined}
              rel={!asEditor && resolveNewTab(c) ? 'noopener noreferrer' : undefined}
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
          newTab={resolveNewTab(c)}
          onNewTabChange={(v) => set({ newTab: v })}
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
      className="w-full rounded-md border border-slate-200 bg-white overflow-hidden h-full flex flex-col items-center justify-start text-center gap-3 px-4 py-5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 hover-elevate"
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
    allCategories: Array.isArray(data?.categories) ? data.categories : [],
    detailById,
    totalSponsors: Array.isArray(data?.sponsors) ? data.sponsors.length : 0,
    isLoading: resolvingEvent || loadingSponsors,
    isError,
  };
}

function SponsorDetail({ sponsor, websiteNewTab = true }) {
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
          target={websiteNewTab ? '_blank' : undefined}
          rel={websiteNewTab ? 'noopener noreferrer' : undefined}
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
          data-testid="link-sponsor-carousel-detail-website"
        >
          Visit website <ExternalLink className="w-4 h-4" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

function SponsorCard({ sponsor, showDescription, showSponsorDetail, detail, nameStyle, descStyle, onClick, websiteNewTab = true }) {
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
        className={`${className} w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
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
        target={websiteNewTab ? '_blank' : undefined}
        rel={websiteNewTab ? 'noopener noreferrer' : undefined}
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
  const websiteNewTab = resolveNewTab({ newTab: c.websiteNewTab }, true);
  const { hasEvent, groups, allCategories, detailById, totalSponsors, isLoading, isError } = useEventSponsors(c.eventId, c.categoryOrder);
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
  const centerAlign = c.centerAlign === true;

  // Whether the block has an empty-category CTA configured.
  const hasEmptyCatContent = !!(c.emptyCatMessage || c.emptyCatCtaLabel);

  // Optional category filter. Use allCategories (full list) for stale-id
  // detection so empty categories aren't incorrectly dropped. The "Other"
  // bucket (id '__none__') is handled separately via groups.
  const allCatIds = new Set([
    ...allCategories.map((cat) => String(cat.id)),
    ...groups.map((g) => String(g.id)),
  ]);
  const selectedCats = (Array.isArray(c.categoryIds) ? c.categoryIds.map(String) : [])
    .filter((id) => allCatIds.has(id));

  // Groups that have sponsors, filtered by selection.
  const filteredGroups = selectedCats.length === 0
    ? groups
    : groups.filter((g) => selectedCats.includes(String(g.id)));

  // Real categories (not __none__) that have no sponsors but are selected.
  const groupById = new Map(groups.map((g) => [String(g.id), g]));
  const emptySelectedCats = (selectedCats.length === 0
    ? allCategories
    : allCategories.filter((cat) => selectedCats.includes(String(cat.id)))
  ).filter((cat) => !groupById.has(String(cat.id)));

  // A filter selection that matches no sponsors AND no displayable empty cats
  // behaves like the empty state.
  const hasAnythingToShow = filteredGroups.length > 0 || (emptySelectedCats.length > 0 && hasEmptyCatContent);
  if (!hasAnythingToShow) {
    if (!asEditor) return null;
    return <EmptyState icon={Building2} text="No sponsors match the selected categories." />;
  }

  if (!showHeadings) {
    // When headings are off, collapse to a flat sponsor list. Empty categories
    // have no visual slot to render their CTA into, so they are silently skipped.
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
        {centerAlign
          ? chunkedGrid(all, cols, gap, (s) => (
              <SponsorCard sponsor={s} showDescription={showDescription} showSponsorDetail={showSponsorDetail} detail={detailById.get(String(s.id))} nameStyle={nameStyle} descStyle={descStyle} onClick={() => setSelected(s)} websiteNewTab={websiteNewTab} />
            ))
          : (
            <div style={gridStyle(cols, gap)}>
              {all.map((s) => (
                <SponsorCard key={s.id} sponsor={s} showDescription={showDescription} showSponsorDetail={showSponsorDetail} detail={detailById.get(String(s.id))} nameStyle={nameStyle} descStyle={descStyle} onClick={() => setSelected(s)} websiteNewTab={websiteNewTab} />
              ))}
            </div>
          )}

        {/* Single-sponsor detail dialog */}
        <Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" data-testid="dialog-sponsor-carousel-detail">
            <DialogHeader>
              <DialogTitle>Sponsor</DialogTitle>
              <DialogDescription className="sr-only">Sponsor profile details</DialogDescription>
            </DialogHeader>
            <SponsorDetail sponsor={selected} websiteNewTab={websiteNewTab} />
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // Build the sorted merged list of categories (sponsor-bearing + empty-with-CTA).
  const orderList = Array.isArray(c.categoryOrder) ? c.categoryOrder.map(String) : [];
  const orderIndex = new Map(orderList.map((id, i) => [id, i]));

  const mergedCats = [];
  for (const g of filteredGroups) {
    if (String(g.id) === '__none__') continue; // handled separately at end
    mergedCats.push({ id: String(g.id), name: g.name, order: g.order, sponsors: g.sponsors, isEmpty: false });
  }
  if (hasEmptyCatContent) {
    for (const cat of emptySelectedCats) {
      mergedCats.push({
        id: String(cat.id),
        name: cat.name || '',
        order: Number.isFinite(cat.display_order) ? cat.display_order : 9998,
        sponsors: [],
        isEmpty: true,
      });
    }
  }
  mergedCats.sort((a, b) => {
    const ai = orderIndex.has(a.id) ? orderIndex.get(a.id) : Infinity;
    const bi = orderIndex.has(b.id) ? orderIndex.get(b.id) : Infinity;
    if (ai !== bi) return ai - bi;
    return (a.order - b.order) || a.name.localeCompare(b.name);
  });
  // "Other" bucket always renders last.
  const noneGroup = filteredGroups.find((g) => String(g.id) === '__none__');
  if (noneGroup) {
    mergedCats.push({ id: '__none__', name: noneGroup.name || 'Other', order: 9999, sponsors: noneGroup.sponsors, isEmpty: false });
  }

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || 'Sponsors'} data-testid="sponsor-grid">
      <div className="flex flex-col gap-6">
        {mergedCats.map((cat) => (
          <div key={cat.id} data-testid={`sponsor-group-${cat.id}`}>
            {cat.name ? (
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-3">{cat.name}</h3>
            ) : null}
            {cat.isEmpty ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid={`sponsor-group-empty-cta-${cat.id}`}>
                {c.emptyCatMessage ? (
                  <p className="text-sm text-slate-600 max-w-sm">{c.emptyCatMessage}</p>
                ) : null}
                {c.emptyCatCtaLabel ? (
                  <TenantCtaButton
                    as="a"
                    href={asEditor ? undefined : (c.emptyCatCtaHref || undefined)}
                    target={c.emptyCatCtaHref && resolveNewTab({ newTab: c.emptyCatCtaNewTab }, true) ? '_blank' : undefined}
                    rel={c.emptyCatCtaHref && resolveNewTab({ newTab: c.emptyCatCtaNewTab }, true) ? 'noopener noreferrer' : undefined}
                    fallbackVariant="default"
                    data-testid={`button-sponsor-empty-cta-${cat.id}`}
                  >
                    {c.emptyCatCtaLabel}
                  </TenantCtaButton>
                ) : null}
              </div>
            ) : centerAlign
              ? chunkedGrid(cat.sponsors, cols, gap, (s) => (
                  <SponsorCard sponsor={s} showDescription={showDescription} showSponsorDetail={showSponsorDetail} detail={detailById.get(String(s.id))} nameStyle={nameStyle} descStyle={descStyle} onClick={() => setSelected(s)} websiteNewTab={websiteNewTab} />
                ))
              : (
              <div style={gridStyle(cols, gap)}>
                {cat.sponsors.map((s) => (
                  <SponsorCard key={s.id} sponsor={s} showDescription={showDescription} showSponsorDetail={showSponsorDetail} detail={detailById.get(String(s.id))} nameStyle={nameStyle} descStyle={descStyle} onClick={() => setSelected(s)} websiteNewTab={websiteNewTab} />
                ))}
              </div>
            )}
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
          <SponsorDetail sponsor={selected} websiteNewTab={websiteNewTab} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SponsorGridInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  // Derive category options from the full category list so empty categories
  // (no sponsors assigned yet) are still selectable.
  const { hasEvent, groups, allCategories } = useEventSponsors(c.eventId);
  const groupById = new Map(groups.map((g) => [String(g.id), g]));
  // Real categories from the API, marked as empty when they have no sponsors.
  const categoryOptions = allCategories.map((cat) => {
    const hasSponsors = groupById.has(String(cat.id));
    return {
      value: String(cat.id),
      label: (cat.name || 'Untitled category') + (!hasSponsors ? ' (no sponsors)' : ''),
    };
  });
  // Also include the synthetic "Other" bucket when it exists in groups.
  const noneGroup = groups.find((g) => g.id === '__none__');
  if (noneGroup) {
    categoryOptions.push({ value: '__none__', label: noneGroup.name || 'Other' });
  }
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
      <ToggleField
        label="Center align"
        value={c.centerAlign === true}
        onChange={(v) => set({ centerAlign: v })}
        testId="toggle-sponsor-grid-center-align"
        hint="Centers rows that have fewer sponsors than the configured number of columns."
      />
      <ToggleField
        label="Open in new tab"
        value={resolveNewTab({ newTab: c.websiteNewTab }, true)}
        onChange={(v) => set({ websiteNewTab: v })}
        testId="toggle-sponsor-grid-website-new-tab"
        hint="Open sponsor website links in a new browser tab."
      />
      <TextField
        label="Empty state text"
        value={c.emptyText}
        onChange={(v) => set({ emptyText: v })}
        testId="input-sponsor-grid-empty-text"
        hint="Shown in the editor when no event or no sponsors are found."
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Empty category content</Label>
        <p className="text-xs text-slate-500 mt-0.5">Shown when a selected category has no sponsors yet. Leave blank to silently skip empty categories.</p>
      </div>
      <TextField
        label="Message"
        value={c.emptyCatMessage || ''}
        onChange={(v) => set({ emptyCatMessage: v })}
        testId="input-sponsor-grid-empty-cat-message"
        hint="Text shown in the empty category slot."
      />
      <TextField
        label="CTA button label"
        value={c.emptyCatCtaLabel || ''}
        onChange={(v) => set({ emptyCatCtaLabel: v })}
        testId="input-sponsor-grid-empty-cat-cta-label"
      />
      <LinkField
        label="CTA link"
        value={c.emptyCatCtaHref}
        onChange={(v) => set({ emptyCatCtaHref: v })}
        testId="input-sponsor-grid-empty-cat-cta-href"
        newTab={resolveNewTab({ newTab: c.emptyCatCtaNewTab }, true)}
        onNewTabChange={(v) => set({ emptyCatCtaNewTab: v })}
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
// Resolve the effective device breakpoint for JS-driven responsive settings
// (sponsors per page, gap, internal padding). In the editor we honour the
// forced device preview via `breakpoint`; on real public pages there is no
// forced breakpoint, so we track the viewport with matchMedia against the same
// canvas breakpoint maxes used elsewhere (avoids editor/public divergence).
function resolveRuntimeBreakpoint() {
  // SSR-safe: without a window (or matchMedia) fall back to desktop.
  if (typeof window === 'undefined' || !window.matchMedia) return 'desktop';
  if (window.matchMedia(`(max-width: ${BREAKPOINT_MAX_PX.mobile}px)`).matches) return 'mobile';
  if (window.matchMedia(`(max-width: ${BREAKPOINT_MAX_PX.tablet}px)`).matches) return 'tablet';
  return 'desktop';
}

function useCarouselBreakpoint(breakpoint) {
  // Compute the initial value synchronously so the FIRST render already uses
  // the real device breakpoint — initialising to 'desktop' and correcting in
  // an effect makes phones first-paint with desktop per-page/gap/padding.
  const [runtimeBp, setRuntimeBp] = useState(resolveRuntimeBreakpoint);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mqMobile = window.matchMedia(`(max-width: ${BREAKPOINT_MAX_PX.mobile}px)`);
    const mqTablet = window.matchMedia(`(max-width: ${BREAKPOINT_MAX_PX.tablet}px)`);
    const update = () => {
      setRuntimeBp(mqMobile.matches ? 'mobile' : mqTablet.matches ? 'tablet' : 'desktop');
    };
    update();
    mqMobile.addEventListener('change', update);
    mqTablet.addEventListener('change', update);
    return () => {
      mqMobile.removeEventListener('change', update);
      mqTablet.removeEventListener('change', update);
    };
  }, []);
  if (breakpoint === 'mobile' || breakpoint === 'tablet' || breakpoint === 'desktop') return breakpoint;
  return runtimeBp;
}

function SponsorCarouselRender({ block, asEditor, breakpoint }) {
  const c = block.content || {};
  const websiteNewTab = resolveNewTab({ newTab: c.websiteNewTab }, true);
  const { hasEvent, groups, allCategories, detailById, totalSponsors, isLoading, isError } = useEventSponsors(c.eventId);

  // Per-device layout settings resolve against the effective breakpoint so the
  // same values used in the forced-breakpoint editor preview also apply on the
  // live public page as the viewport crosses the tablet/mobile thresholds.
  const effBreakpoint = useCarouselBreakpoint(breakpoint);

  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [hovered, setHovered] = useState(false);
  const [autoplayPausedAt, setAutoplayPausedAt] = useState(0);
  const [selected, setSelected] = useState(null);
  const touchStartRef = useRef(null);

  // Flatten the grouped sponsors into a single de-duplicated list, applying the
  // optional category filter (mirrors the Sponsor grid logic). The carousel
  // does not show category headings, so we always collapse to one list.
  // Use allCategories for stale-id detection so empty categories aren't dropped.
  const allCatIds = new Set([
    ...allCategories.map((cat) => String(cat.id)),
    ...groups.map((g) => String(g.id)),
  ]);
  const selectedCats = (Array.isArray(c.categoryIds) ? c.categoryIds.map(String) : [])
    .filter((id) => allCatIds.has(id));
  const filteredGroups = selectedCats.length === 0
    ? groups
    : groups.filter((g) => selectedCats.includes(String(g.id)));

  const hasEmptyCatContent = !!(c.emptyCatMessage || c.emptyCatCtaLabel);

  // Empty categories that are selected (not in any sponsor group).
  const groupById = new Map(groups.map((g) => [String(g.id), g]));
  const emptySelectedCats = (selectedCats.length === 0
    ? allCategories
    : allCategories.filter((cat) => selectedCats.includes(String(cat.id)))
  ).filter((cat) => !groupById.has(String(cat.id)));

  // Build the flat carousel items list: real sponsors + synthetic CTA slides
  // for empty selected categories (when content is configured).
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
    if (hasEmptyCatContent) {
      for (const cat of emptySelectedCats) {
        // Inject a synthetic sentinel item for this empty category.
        all.push({ __emptyCta: true, id: `__empty_${cat.id}`, catId: String(cat.id), catName: cat.name || '' });
      }
    }
    return all;
  }, [filteredGroups, emptySelectedCats, hasEmptyCatContent]);

  const count = sponsors.length;
  // Sponsors per page, gap and internal padding are per-device (scalar for
  // legacy blocks, or a { desktop, tablet, mobile } object) — resolve each
  // against the effective breakpoint, then fall back to the historic defaults.
  const perView = Math.max(1, Math.floor(resolveResponsiveValue(c.sponsorsPerView, effBreakpoint) ?? 1));
  const pageCount = Math.max(1, Math.ceil(count / perView));
  const hasMany = pageCount > 1;
  const gap = Math.max(0, resolveResponsiveValue(c.gap, effBreakpoint) ?? 16);
  const padTop = Math.max(0, resolveResponsiveValue(c.innerPaddingTop, effBreakpoint) ?? 16);
  const padRight = Math.max(0, resolveResponsiveValue(c.innerPaddingRight, effBreakpoint) ?? 32);
  const padBottom = Math.max(0, resolveResponsiveValue(c.innerPaddingBottom, effBreakpoint) ?? 16);
  const padLeft = Math.max(0, resolveResponsiveValue(c.innerPaddingLeft, effBreakpoint) ?? 32);
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
  const centerAlign = c.centerAlign === true;

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

  // Current page's sponsors. When centerAlign is off, pad to `perView` so the
  // last (short) page keeps equal-width slots. When centerAlign is on, use the
  // real cards only so they can be centered without empty ghost columns.
  const pageSponsors = sponsors.slice(index * perView, index * perView + perView);
  const pageSlice = centerAlign
    ? pageSponsors
    : perView > 1
      ? Array.from({ length: perView }, (_, i) => pageSponsors[i] || null)
      : pageSponsors;

  // When full-bleed, the bar spans 100vw but its content should re-align to
  // the page's centered content column. `--cb-content-width` is published by
  // the stage stylesheet per breakpoint (1200/768/375); falls back to 1200.
  const railStyle = c.fullBleed
    ? { maxWidth: 'var(--cb-content-width, 1200px)', marginInline: 'auto' }
    : undefined;

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
          <div
            className="w-full h-full flex items-stretch"
            style={{
              gap: `${gap}px`,
              paddingTop: padTop,
              paddingRight: padRight,
              paddingBottom: padBottom,
              paddingLeft: padLeft,
              justifyContent: centerAlign && pageSlice.length < perView ? 'center' : undefined,
              ...railStyle,
            }}
          >
            {pageSlice.map((s, i) => (
              <div
                key={s ? s.id : `empty-${index}-${i}`}
                style={centerAlign ? { flex: `0 0 calc((100% - ${(perView - 1) * gap}px) / ${perView})`, minWidth: 0 } : undefined}
                className={centerAlign ? undefined : 'flex-1 min-w-0'}
              >
                {s && s.__emptyCta ? (
                  <div
                    className="rounded-md border border-slate-200 bg-white overflow-hidden flex flex-col h-full items-center justify-center gap-3 p-6 text-center"
                    data-testid={`sponsor-carousel-empty-cta-${s.catId}`}
                  >
                    {c.emptyCatMessage ? (
                      <p className="text-sm text-slate-600">{c.emptyCatMessage}</p>
                    ) : null}
                    {c.emptyCatCtaLabel ? (
                      <TenantCtaButton
                        as="a"
                        href={asEditor ? undefined : (c.emptyCatCtaHref || undefined)}
                        target={c.emptyCatCtaHref && resolveNewTab({ newTab: c.emptyCatCtaNewTab }, true) ? '_blank' : undefined}
                        rel={c.emptyCatCtaHref && resolveNewTab({ newTab: c.emptyCatCtaNewTab }, true) ? 'noopener noreferrer' : undefined}
                        fallbackVariant="default"
                        data-testid={`button-sponsor-carousel-empty-cta-${s.catId}`}
                      >
                        {c.emptyCatCtaLabel}
                      </TenantCtaButton>
                    ) : null}
                  </div>
                ) : s ? (
                  <SponsorCard
                    sponsor={s}
                    showDescription={showDescription}
                    showSponsorDetail={showSponsorDetail}
                    detail={detailById.get(String(s.id))}
                    nameStyle={nameStyle}
                    descStyle={descStyle}
                    onClick={() => openSponsor(s)}
                    websiteNewTab={websiteNewTab}
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
              className="absolute top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/80 hover:bg-white border border-slate-200 flex items-center justify-center shadow-sm"
              style={{ left: Math.max(8, padLeft - 24) }}
              aria-label="Previous sponsors"
              data-testid="button-sponsor-carousel-prev"
            >
              <ChevronLeft className="w-4 h-4 text-slate-700" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => { goNext(); setAutoplayPausedAt(Date.now()); }}
              className="absolute top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/80 hover:bg-white border border-slate-200 flex items-center justify-center shadow-sm"
              style={{ right: Math.max(8, padRight - 24) }}
              aria-label="Next sponsors"
              data-testid="button-sponsor-carousel-next"
            >
              <ChevronRight className="w-4 h-4 text-slate-700" aria-hidden="true" />
            </button>
          </>
        ) : null}

        {showIndicators ? (
          <div
            className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5"
            style={{ bottom: Math.max(4, padBottom - 8) }}
          >
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
          <SponsorDetail sponsor={selected} websiteNewTab={websiteNewTab} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SponsorCarouselInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  // Derive category options from the full category list so empty categories
  // (no sponsors assigned yet) are still selectable.
  const { hasEvent, groups, allCategories } = useEventSponsors(c.eventId);
  const groupById = new Map(groups.map((g) => [String(g.id), g]));
  const categoryOptions = allCategories.map((cat) => {
    const hasSponsors = groupById.has(String(cat.id));
    return {
      value: String(cat.id),
      label: (cat.name || 'Untitled category') + (!hasSponsors ? ' (no sponsors)' : ''),
    };
  });
  const noneGroup = groups.find((g) => g.id === '__none__');
  if (noneGroup) {
    categoryOptions.push({ value: '__none__', label: noneGroup.name || 'Other' });
  }
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
      <ResponsiveNumberField
        label="Sponsors per page"
        min={1}
        value={c.sponsorsPerView}
        breakpoint={breakpoint}
        onChange={(v) => set({ sponsorsPerView: v })}
        testId="input-sponsor-carousel-per-view"
        hint="How many sponsor cards to show side-by-side in one slide. Set separate values on tablet and mobile."
      />
      <ResponsiveNumberField
        label="Gap (px)"
        min={0}
        value={c.gap}
        breakpoint={breakpoint}
        onChange={(v) => set({ gap: v })}
        testId="input-sponsor-carousel-gap"
      />

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Internal padding</Label>
        <p className="text-xs text-slate-500 mt-0.5">Space between the block background and the carousel content, in px. Set separate values per device.</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ResponsiveNumberField
          label="Top"
          min={0}
          value={c.innerPaddingTop}
          breakpoint={breakpoint}
          onChange={(v) => set({ innerPaddingTop: v })}
          testId="input-sponsor-carousel-inner-padding-top"
        />
        <ResponsiveNumberField
          label="Right"
          min={0}
          value={c.innerPaddingRight}
          breakpoint={breakpoint}
          onChange={(v) => set({ innerPaddingRight: v })}
          testId="input-sponsor-carousel-inner-padding-right"
        />
        <ResponsiveNumberField
          label="Bottom"
          min={0}
          value={c.innerPaddingBottom}
          breakpoint={breakpoint}
          onChange={(v) => set({ innerPaddingBottom: v })}
          testId="input-sponsor-carousel-inner-padding-bottom"
        />
        <ResponsiveNumberField
          label="Left"
          min={0}
          value={c.innerPaddingLeft}
          breakpoint={breakpoint}
          onChange={(v) => set({ innerPaddingLeft: v })}
          testId="input-sponsor-carousel-inner-padding-left"
        />
      </div>

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
      <ToggleField
        label="Open in new tab"
        value={resolveNewTab({ newTab: c.websiteNewTab }, true)}
        onChange={(v) => set({ websiteNewTab: v })}
        testId="toggle-sponsor-carousel-website-new-tab"
        hint="Open sponsor website links in a new browser tab."
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
      <ToggleField
        label="Center align"
        value={c.centerAlign === true}
        onChange={(v) => set({ centerAlign: v })}
        testId="toggle-sponsor-carousel-center-align"
        hint="Centers the last (short) page when it has fewer sponsors than the sponsors-per-page count."
      />
      <ToggleField
        label="Full-bleed (span full screen width)"
        value={!!c.fullBleed}
        onChange={(v) => set({ fullBleed: v })}
        testId="toggle-sponsor-carousel-full-bleed"
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

      <div className="pt-2 mt-2 border-t border-slate-200">
        <Label className="text-xs font-semibold text-slate-700">Empty category content</Label>
        <p className="text-xs text-slate-500 mt-0.5">A card/slide shown for each selected category with no sponsors. Leave blank to silently skip empty categories.</p>
      </div>
      <TextField
        label="Message"
        value={c.emptyCatMessage || ''}
        onChange={(v) => set({ emptyCatMessage: v })}
        testId="input-sponsor-carousel-empty-cat-message"
        hint="Text shown on the empty category card."
      />
      <TextField
        label="CTA button label"
        value={c.emptyCatCtaLabel || ''}
        onChange={(v) => set({ emptyCatCtaLabel: v })}
        testId="input-sponsor-carousel-empty-cat-cta-label"
      />
      <LinkField
        label="CTA link"
        value={c.emptyCatCtaHref}
        onChange={(v) => set({ emptyCatCtaHref: v })}
        testId="input-sponsor-carousel-empty-cat-cta-href"
        newTab={resolveNewTab({ newTab: c.emptyCatCtaNewTab }, true)}
        onNewTabChange={(v) => set({ emptyCatCtaNewTab: v })}
      />
    </>
  );
}

// ============================================================================
// SHOWCASE CARD SETTINGS (shared by the article/news list and resource
// showcase blocks — same knobs the old iEdit Showcase exposed)
// ============================================================================
// Resolve every stored Showcase-card knob into safe render values. The
// inspector stores raw keystrokes unclamped so typing "35" doesn't get mangled
// to the min bound the moment "3" is entered; the ranges are enforced here at
// render time instead. Unset values keep the original hardcoded behaviour so
// existing pages render byte-identically.
function resolveShowcaseCardSettings(c) {
  const clampNum = (raw, min, max, fallback) => {
    const n = Number(raw);
    if (raw == null || raw === '' || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const hasExplicitTitleSize = c.titleFontSize != null && c.titleFontSize !== '' && Number(c.titleFontSize) > 0;
  // Description line clamp: 'none' = no limit, 1..10 = clamp, default 3.
  let descriptionLineClamp = 3;
  if (c.descriptionLineClamp === 'none') descriptionLineClamp = 'none';
  else if (Number(c.descriptionLineClamp) > 0) descriptionLineClamp = Number(c.descriptionLineClamp);
  return {
    cardHeight: clampNum(c.cardHeight, 200, 800, 400),
    imageHeightPercent: clampNum(c.imageHeightPercent, 20, 80, 50),
    ctaButtonSize: clampNum(c.ctaButtonSize, 24, 80, 48),
    ctaButtonMargin: clampNum(c.ctaButtonMargin, 0, 50, 0),
    imageBorderWeight: clampNum(c.imageBorderWeight, 1, 20, 3),
    cardTextAlign: c.cardTextAlign === 'center' || c.cardTextAlign === 'right' ? c.cardTextAlign : 'left',
    cardBorderRadius: clampNum(c.cardBorderRadius, 0, 40, 8),
    hasExplicitTitleSize,
    titleFontSize: clampNum(c.titleFontSize, 10, 48, 16),
    dateFontSize: clampNum(c.dateFontSize, 8, 24, 12),
    showPublishedDate: c.showPublishedDate !== false,
    descriptionLineClamp,
    // null = fall back to the card corner radius inside ShowcaseCard.
    ctaButtonBorderRadius: c.ctaButtonBorderRadius != null && c.ctaButtonBorderRadius !== ''
      ? clampNum(c.ctaButtonBorderRadius, 0, 40, null)
      : null,
  };
}

// The full set of Showcase-card inspector fields, shared verbatim between the
// article/news list and resource showcase inspectors. `idPrefix` keeps each
// block's data-testids distinct (and unchanged for the article block).
function ShowcaseCardSettingsFields({ c, set, idPrefix, badgeTextPlaceholder }) {
  return (
    <>
      <ToggleField label="Show image" value={c.showImage !== false} onChange={(v) => set({ showImage: v })} testId={`toggle-${idPrefix}-image`} />
      <ToggleField label="Show summary" value={c.showSummary !== false} onChange={(v) => set({ showSummary: v })} testId={`toggle-${idPrefix}-summary`} />
      {c.showSummary !== false ? (
        <SelectField
          label="Summary lines"
          value={c.descriptionLineClamp === 'none' ? 'none' : String(Number(c.descriptionLineClamp) > 0 ? Number(c.descriptionLineClamp) : 3)}
          onChange={(v) => set({ descriptionLineClamp: v === 'none' ? 'none' : Number(v) })}
          options={[
            ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} line${n === 1 ? '' : 's'}` })),
            { value: 'none', label: 'No limit' },
          ]}
          testId={`select-${idPrefix}-summary-lines`}
        />
      ) : null}
      <ToggleField
        label="Show published date"
        value={c.showPublishedDate !== false}
        onChange={(v) => set({ showPublishedDate: v })}
        testId={`toggle-${idPrefix}-published-date`}
      />
      {c.showPublishedDate !== false ? (
        <NumberField
          label="Date font size (px)"
          min={8}
          max={24}
          value={c.dateFontSize || 12}
          onChange={(v) => set({ dateFontSize: v })}
          testId={`input-${idPrefix}-date-font-size`}
        />
      ) : null}
      <NumberField
        label="Title font size (px)"
        min={10}
        max={48}
        value={c.titleFontSize || 16}
        onChange={(v) => set({ titleFontSize: v })}
        testId={`input-${idPrefix}-title-font-size`}
      />
      <NumberField
        label="Card corner radius (px)"
        min={0}
        max={40}
        value={c.cardBorderRadius ?? 8}
        onChange={(v) => set({ cardBorderRadius: v })}
        testId={`input-${idPrefix}-border-radius`}
      />
      <NumberField
        label="Card height (px)"
        min={200}
        max={800}
        value={c.cardHeight || 400}
        onChange={(v) => set({ cardHeight: v })}
        testId={`input-${idPrefix}-card-height`}
      />
      <NumberField
        label="Image height (%)"
        min={20}
        max={80}
        value={c.imageHeightPercent || 50}
        onChange={(v) => set({ imageHeightPercent: v })}
        testId={`input-${idPrefix}-image-height`}
      />
      <SelectField
        label="Text alignment"
        value={c.cardTextAlign || 'left'}
        onChange={(v) => set({ cardTextAlign: v })}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Centre' },
          { value: 'right', label: 'Right' },
        ]}
        testId={`select-${idPrefix}-text-align`}
      />
      <ToggleField
        label="Show line below image"
        value={!!c.showImageBorder}
        onChange={(v) => set({ showImageBorder: v })}
        testId={`toggle-${idPrefix}-image-border`}
      />
      {c.showImageBorder ? (
        <>
          <NumberField
            label="Line weight (px)"
            min={1}
            max={20}
            value={c.imageBorderWeight || 3}
            onChange={(v) => set({ imageBorderWeight: v })}
            testId={`input-${idPrefix}-image-border-weight`}
          />
          <ColorField
            label="Line colour"
            value={c.imageBorderColor}
            onChange={(v) => set({ imageBorderColor: v })}
            placeholder="#2563eb"
            fallback="#2563eb"
            testId={`input-${idPrefix}-image-border-color`}
          />
        </>
      ) : null}
      <ToggleField
        label="Show badge"
        value={c.showBadge !== false}
        onChange={(v) => set({ showBadge: v })}
        testId={`toggle-${idPrefix}-badge`}
      />
      {c.showBadge !== false ? (
        <>
          <TextField
            label="Badge text"
            value={c.badgeText}
            onChange={(v) => set({ badgeText: v })}
            placeholder={badgeTextPlaceholder}
            testId={`input-${idPrefix}-badge-text`}
          />
          <ColorField
            label="Badge background"
            value={c.badgeBgColor}
            onChange={(v) => set({ badgeBgColor: v })}
            placeholder="(default)"
            testId={`input-${idPrefix}-badge-bg`}
          />
          <ColorField
            label="Badge text colour"
            value={c.badgeTextColor}
            onChange={(v) => set({ badgeTextColor: v })}
            placeholder="#ffffff"
            fallback="#ffffff"
            testId={`input-${idPrefix}-badge-text-color`}
          />
        </>
      ) : null}
      <ToggleField
        label="Show arrow button"
        value={c.showCTAButton !== false}
        onChange={(v) => set({ showCTAButton: v })}
        testId={`toggle-${idPrefix}-cta`}
      />
      {c.showCTAButton !== false ? (
        <>
          <NumberField
            label="Button size (px)"
            min={24}
            max={80}
            value={c.ctaButtonSize || 48}
            onChange={(v) => set({ ctaButtonSize: v })}
            testId={`input-${idPrefix}-cta-size`}
          />
          <NumberField
            label="Button margin (px)"
            min={0}
            max={50}
            value={c.ctaButtonMargin ?? 0}
            onChange={(v) => set({ ctaButtonMargin: v })}
            testId={`input-${idPrefix}-cta-margin`}
          />
          <ColorField
            label="Button background"
            value={c.ctaButtonBgColor}
            onChange={(v) => set({ ctaButtonBgColor: v })}
            placeholder="#2563eb"
            fallback="#2563eb"
            testId={`input-${idPrefix}-cta-bg`}
          />
          <ColorField
            label="Arrow colour"
            value={c.ctaButtonArrowColor}
            onChange={(v) => set({ ctaButtonArrowColor: v })}
            placeholder="#ffffff"
            fallback="#ffffff"
            testId={`input-${idPrefix}-cta-arrow`}
          />
          <NumberField
            label="Button corner radius (px)"
            min={0}
            max={40}
            value={c.ctaButtonBorderRadius ?? (c.cardBorderRadius ?? 8)}
            onChange={(v) => set({ ctaButtonBorderRadius: v })}
            testId={`input-${idPrefix}-cta-radius`}
          />
        </>
      ) : null}
      <TypographyStyleField
        label="Card title style"
        value={c.titleTypographyStyleId}
        onChange={(id) => set({ titleTypographyStyleId: id })}
        testId={`select-${idPrefix}-title-typography`}
      />
      <TypographyStyleField
        label="Card text style"
        value={c.summaryTypographyStyleId}
        onChange={(id) => set({ summaryTypographyStyleId: id })}
        testId={`select-${idPrefix}-summary-typography`}
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
  const linkNewTab = resolveNewTab(c);
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

  // Article cards must use the same folder-based view URLs as the rest of the
  // app (/{articles|blogs|...}/{authorHandle}/{slug}). The legacy
  // '/Articles?slug=...' format routes to the LISTING page (the /Articles
  // route renders Articles/PublicArticles, which never reads ?slug), so the
  // click appeared to change the URL but painted the blog list instead of the
  // article. News keeps '/NewsView?slug=' — that route reads the slug param.
  const { getArticleViewUrlFromArticle } = useArticleUrl();
  const authorHandles = useMemo(() => {
    const handles = {};
    Object.entries(data?.authors || {}).forEach(([id, info]) => {
      if (info?.handle) handles[id] = info.handle;
    });
    return handles;
  }, [data?.authors]);
  const cardUrlFor = (a) => {
    if (source === 'news') return `/NewsView?slug=${encodeURIComponent(a.slug || a.id)}`;
    if (!a.slug) return `/Articles?slug=${encodeURIComponent(a.id)}`;
    return getArticleViewUrlFromArticle(a, authorHandles);
  };
  const effectiveCols = layout === 'list' ? 1 : cols;

  // Badge label for article cards mirrors the iEdit Showcase: the tenant's
  // `article_display_name` setting singularised (e.g. "Articles" -> "Article").
  const articleDisplayName = useArticleDisplayName();
  const articleBadgeLabel = articleDisplayName
    ? (articleDisplayName.endsWith('s') ? articleDisplayName.slice(0, -1) : articleDisplayName)
    : 'Article';
  // Showcase card settings (Task #2808): every knob the old iEdit Showcase
  // exposed, with the previous hardcoded values as defaults so existing pages
  // render byte-identically when the fields are unset.
  const defaultBadgeBg = source === 'news' ? '#2563eb' : '#16a34a';
  const badgeBg = c.badgeBgColor || defaultBadgeBg;
  const badgeTextColor = c.badgeTextColor || '#ffffff';
  const defaultBadgeText = source === 'news' ? 'News' : articleBadgeLabel;
  const badgeText = (typeof c.badgeText === 'string' && c.badgeText.trim()) ? c.badgeText : defaultBadgeText;
  const {
    cardHeight, imageHeightPercent, ctaButtonSize, ctaButtonMargin,
    imageBorderWeight, cardTextAlign, cardBorderRadius, hasExplicitTitleSize,
    titleFontSize, dateFontSize, showPublishedDate, descriptionLineClamp,
    ctaButtonBorderRadius,
  } = resolveShowcaseCardSettings(c);

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
  // An explicitly set "Title font size (px)" always wins over the typography
  // style's own size, so the control keeps working when a style is selected.
  if (titleInline && hasExplicitTitleSize) titleInline = { ...titleInline, fontSize: `${titleFontSize}px` };
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
        buildResponsiveListGridCss(block.id, c, c.gap, { testId: 'article-list', forceSingle: layout === 'list' }),
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
        <ul className="list-none m-0 p-0" style={isPreview ? gridStyle(effectiveCols, c.gap) : undefined} data-testid="article-list">
          {items.map((a) => {
            const authorText = source === 'articles'
              ? formatAuthorNames(coAuthorsData?.authors?.[a.id])
              : '';
            return (
              <li key={a.id} className="list-none">
                <ShowcaseCard
                  title={a.title}
                  imageUrl={a.image_url || a.feature_image_url}
                  showImageArea={c.showImage !== false}
                  imageFocalPoint={a.feature_image_focal_point || null}
                  imageAlt={a.title}
                  summary={c.showSummary !== false ? a.summary : null}
                  publishedDate={a.published_date}
                  authorText={authorText}
                  url={cardUrlFor(a)}
                  newTab={linkNewTab}
                  asEditor={asEditor}
                  showBadge={c.showBadge !== false}
                  badgeText={badgeText}
                  badgeBgColor={badgeBg}
                  badgeTextColor={badgeTextColor}
                  cardHeight={cardHeight}
                  imageHeightPercent={imageHeightPercent}
                   imageAspectRatio={source === 'news' ? '1200 / 630' : null}
                  showImageBorder={!!c.showImageBorder}
                  imageBorderWeight={imageBorderWeight}
                  imageBorderColor={c.imageBorderColor || '#2563eb'}
                  showCTAButton={c.showCTAButton !== false}
                  ctaButtonSize={ctaButtonSize}
                  ctaButtonMargin={ctaButtonMargin}
                  ctaButtonBgColor={c.ctaButtonBgColor || '#2563eb'}
                  ctaButtonArrowColor={c.ctaButtonArrowColor || '#ffffff'}
                  ctaButtonBorderRadius={ctaButtonBorderRadius}
                  textAlign={cardTextAlign}
                  cardBorderRadius={cardBorderRadius}
                  titleFontSize={titleFontSize}
                  dateFontSize={dateFontSize}
                  showPublishedDate={showPublishedDate}
                  descriptionLineClamp={c.showSummary !== false ? descriptionLineClamp : 0}
                  titleStyleOverride={titleInline}
                  summaryStyleOverride={summaryInline}
                  titleExtraProps={{ 'data-tg-r': 'article-title' }}
                  summaryExtraProps={{ 'data-tg-r': 'article-summary' }}
                  testId={a.id}
                  wrapperTestId={`link-article-${a.id}`}
                />
              </li>
            );
          })}
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
      {/* Showcase card settings (Tasks #2808/#2810) — shared with the
          resource showcase block; unset values keep the current defaults. */}
      <ShowcaseCardSettingsFields c={c} set={set} idPrefix="article-list" badgeTextPlaceholder="Default: Article / News" />
      <ToggleField label="Featured first" value={!!c.featuredFirst} onChange={(v) => set({ featuredFirst: v })} testId="toggle-article-list-featured-first" />
      <ToggleField
        label="Open in new tab"
        value={resolveNewTab(c)}
        onChange={(v) => set({ newTab: v })}
        testId="toggle-article-list-new-tab"
        hint="Open the article link in a new browser tab."
      />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-article-list-empty" />
    </>
  );
}

// ============================================================================
// RESOURCE LIST
// ============================================================================
// Resolve the selected category/sub-category filters from block content,
// supporting both the newer multi-select arrays (`categories`/`subcategories`)
// and the legacy single-value fields (`category`/`subcategory`). Arrays take
// precedence; when neither array has entries we fall back to the singles so
// existing blocks keep working unchanged.
function resolveResourceFilterSelections(c) {
  const catArr = Array.isArray(c.categories) ? c.categories.filter(Boolean).map(String) : [];
  const subArr = Array.isArray(c.subcategories) ? c.subcategories.filter(Boolean).map(String) : [];
  if (catArr.length || subArr.length) {
    return { categories: catArr, subcategories: subArr };
  }
  return {
    categories: c.category ? [String(c.category)] : [],
    subcategories: c.subcategory ? [String(c.subcategory)] : [],
  };
}

// Apply the block's configured resource filters (type, tag, categories /
// sub-categories, audience) to the full public resource list. Shared between
// the Resource list and Resource showcase blocks so both filter identically.
function filterResourcesByContent(data, c, categoriesData) {
  let list = Array.isArray(data) ? data.slice() : [];
  if (c.resourceType) {
    const t = String(c.resourceType).toLowerCase();
    list = list.filter((r) => String(r.resource_type || '').toLowerCase() === t);
  }
  if (c.tag) {
    const tag = String(c.tag).toLowerCase();
    list = list.filter((r) => Array.isArray(r.tags) && r.tags.some((x) => String(x).toLowerCase() === tag));
  }
  const { categories: selCats, subcategories: selSubs } = resolveResourceFilterSelections(c);
  if (selSubs.length) {
    // Sub-category filter takes precedence: include resources matching ANY
    // of the selected sub-categories.
    const subSet = new Set(selSubs.map((s) => String(s).toLowerCase()));
    list = list.filter((r) =>
      Array.isArray(r.subcategories) && r.subcategories.some((x) => subSet.has(String(x).toLowerCase()))
    );
  } else if (selCats.length) {
    const cats = Array.isArray(categoriesData) ? categoriesData : [];
    const subNames = new Set();
    const freeText = new Set();
    selCats.forEach((name) => {
      const lower = String(name).toLowerCase();
      const matchedCategory = cats.find((cc) => String(cc.name || '').toLowerCase() === lower);
      if (matchedCategory) {
        // Known category: match resources belonging to any of its subcategories.
        (Array.isArray(matchedCategory.subcategories) ? matchedCategory.subcategories : [])
          .forEach((s) => subNames.add(String(s).toLowerCase()));
      } else {
        // Legacy free-text value: preserve original subcategory-or-tag matching.
        freeText.add(lower);
      }
    });
    list = list.filter((r) => {
      const rsubs = Array.isArray(r.subcategories) ? r.subcategories.map((x) => String(x).toLowerCase()) : [];
      const rtags = Array.isArray(r.tags) ? r.tags.map((x) => String(x).toLowerCase()) : [];
      if (rsubs.some((x) => subNames.has(x))) return true;
      if (freeText.size && (rsubs.some((x) => freeText.has(x)) || rtags.some((x) => freeText.has(x)))) return true;
      return false;
    });
  }
  if (c.audience === 'public-only') list = list.filter((r) => !r.is_locked);
  else if (c.audience === 'members-only') list = list.filter((r) => r.is_locked);
  return list;
}

function ResourceListRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const cols = columnsForBreakpoint(c, breakpoint);
  const openLinksInNewTab = resolveNewTab(c, true);
  const layout = c.layout || 'grid';
  const effectiveCols = layout === 'list' ? 1 : cols;

  // Card corner radius (Task #3208), mirroring the article/news list's
  // 0–40px range. Unset/invalid values resolve to 0 so existing pages keep
  // their square cards; clamped here at render time (inspector stores raw
  // keystrokes so typing isn't mangled mid-entry).
  const rawCardRadius = Number(c.cardBorderRadius);
  const cardCornerRadius = Number.isFinite(rawCardRadius)
    ? Math.min(40, Math.max(0, rawCardRadius))
    : 0;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-resources'],
    queryFn: () => publicClient.listResources(),
    staleTime: 60_000,
  });

  const { data: categoriesData } = useQuery({
    queryKey: ['canvas', 'public-resource-categories'],
    queryFn: () => publicClient.listResourceCategories(),
    staleTime: 60_000,
  });

  // Button styles drive ResourceCard's native CTA exactly as on /resources,
  // so the block's cards match the public page's card actions.
  const { data: buttonStyles = [] } = useQuery({
    queryKey: ['canvas', 'public-button-styles-resources'],
    queryFn: async () => {
      const styles = await publicClient.listButtonStyles();
      return (Array.isArray(styles) ? styles : []).filter((s) => s.card_type === 'resource' && s.is_active);
    },
    staleTime: 60_000,
  });

  // Mirror /resources' logged-in check so members-only cards unlock identically.
  const isLoggedIn = useMemo(() => {
    try {
      const storedMember = localStorage.getItem('agcas_member');
      if (!storedMember) return false;
      const member = JSON.parse(storedMember);
      if (member.sessionExpiry && new Date(member.sessionExpiry) < new Date()) return false;
      return true;
    } catch {
      return false;
    }
  }, []);

  const items = useMemo(
    () => filterResourcesByContent(data, c, categoriesData),
    [data, categoriesData, c.resourceType, c.tag, c.category, c.subcategory, c.categories, c.subcategories, c.audience]
  );

  // Viewer-facing search box narrows the already-configured `items` in real
  // time. It never widens the block's scope — it only filters what the author
  // already selected. Off by default so existing pages are unchanged.
  const searchEnabled = !!c.searchEnabled;
  const [query, setQuery] = useState('');
  const searchedItems = useMemo(() => {
    if (!searchEnabled) return items;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) => {
      if (String(r.title || '').toLowerCase().includes(q)) return true;
      if (String(r.description || '').toLowerCase().includes(q)) return true;
      if (String(r.resource_type || '').toLowerCase().includes(q)) return true;
      if (Array.isArray(r.tags) && r.tags.some((x) => String(x).toLowerCase().includes(q))) return true;
      return false;
    });
  }, [items, query, searchEnabled]);

  // Paging model mirrors the Speaker grid: a `paginate` flag reuses the
  // existing `limit` as the per-page size. When paging is off the block keeps
  // its original behaviour — slice the filtered list down to `limit`.
  const hasLimit = !!(c.limit && c.limit > 0);
  const perPage = Math.max(1, Number(c.limit) || 1);
  const paginate = !!c.paginate && hasLimit;
  const pageCount = paginate ? Math.max(1, Math.ceil(searchedItems.length / perPage)) : 1;
  const [page, setPage] = useState(0);
  // Keep the current page in range when filters change the result count.
  useEffect(() => {
    if (page > Math.max(0, pageCount - 1)) setPage(0);
  }, [pageCount, page]);
  // Reset to the first page whenever the search term changes the result set.
  useEffect(() => {
    setPage(0);
  }, [query]);
  const safePage = Math.min(page, pageCount - 1);
  const visibleItems = paginate
    ? searchedItems.slice(safePage * perPage, safePage * perPage + perPage)
    : (hasLimit ? searchedItems.slice(0, perPage) : searchedItems);

  const isPreview = isEditorPreviewBreakpoint(breakpoint);
  const gridCss = !isPreview
    ? buildResponsiveListGridCss(block.id, c, c.gap, { testId: 'resource-list', forceSingle: layout === 'list' })
    : '';

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || c.title || 'Resources'}>
      {gridCss ? <style dangerouslySetInnerHTML={{ __html: gridCss }} /> : null}
      {c.title ? <Heading level={c.headingLevel || 2}>{c.title}</Heading> : null}
      {isLoading ? (
        <ListSkeleton count={Math.min(c.limit || 6, 6)} columns={effectiveCols} gap={c.gap} />
      ) : isError ? (
        <ErrorState message="Couldn't load resources right now." />
      ) : items.length === 0 ? (
        <EmptyState icon={Folder} text={c.emptyText || 'No resources available.'} />
      ) : (
        <>
        {searchEnabled ? (
          <div className="relative mb-3">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={c.searchPlaceholder || 'Search resources…'}
              aria-label={c.searchPlaceholder || 'Search resources'}
              className="w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300"
              data-testid="input-resource-list-search"
            />
          </div>
        ) : null}
        {searchedItems.length === 0 ? (
          <EmptyState icon={Folder} text={c.emptyText || 'No resources available.'} />
        ) : (
        <>
        <ul className="list-none m-0 p-0" style={isPreview ? gridStyle(effectiveCols, c.gap) : undefined} data-testid="resource-list">
          {visibleItems.map((r) => (
            <li
              key={r.id}
              data-testid={`link-resource-${r.id}`}
              onClickCapture={asEditor ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
            >
              <ResourceCard
                resource={r}
                isLocked={!r.is_public && !isLoggedIn}
                buttonStyles={buttonStyles}
                openInNewTab={resolveResourceNewTab(r, openLinksInNewTab)}
                cornerRadius={cardCornerRadius}
              />
            </li>
          ))}
        </ul>
        {paginate && pageCount > 1 ? (
          <div className="relative z-10 flex items-center justify-center gap-3 pt-4">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage <= 0}
              className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm disabled:opacity-40"
              aria-label="Previous page"
              data-testid="button-resource-list-prev"
            >
              <ChevronLeft className="w-4 h-4 text-slate-700" aria-hidden="true" />
            </button>
            <span className="text-sm text-slate-600" data-testid="text-resource-list-page">
              Page {safePage + 1} of {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm disabled:opacity-40"
              aria-label="Next page"
              data-testid="button-resource-list-next"
            >
              <ChevronRight className="w-4 h-4 text-slate-700" aria-hidden="true" />
            </button>
          </div>
        ) : null}
        </>
        )}
        </>
      )}
    </div>
  );
}

// Resource filter fields (type, tag, category / sub-category multi-selects
// and audience) shared between the Resource list and Resource showcase
// inspectors so both blocks are configured identically.
function ResourceFilterFields({ c, set, idPrefix }) {
  const { data: categoriesData, isLoading: categoriesLoading } = useQuery({
    queryKey: ['canvas', 'admin-resource-categories'],
    queryFn: () => base44.entities.ResourceCategory.list('display_order'),
    staleTime: 60_000,
  });

  const resourceCategories = useMemo(() => {
    const cats = Array.isArray(categoriesData) ? categoriesData : [];
    return cats.filter((cat) => {
      if (cat.is_active === false) return false;
      const applies = cat.applies_to_content_types;
      return !Array.isArray(applies) || applies.length === 0 || applies.includes('Resources');
    });
  }, [categoriesData]);

  // Reflect the saved value in the dropdowns. Newer blocks store the category
  // name in `c.category` and the subcategory in `c.subcategory`. Legacy blocks
  // stored a single free-text value in `c.category`, which may actually be a
  // subcategory name — surface it under its parent category when we can match.
  const { selectedCategoryName, selectedSubcategory } = useMemo(() => {
    const savedCat = String(c.category || '');
    if (!savedCat) return { selectedCategoryName: '', selectedSubcategory: '' };
    const byName = resourceCategories.find(
      (cat) => String(cat.name || '').toLowerCase() === savedCat.toLowerCase()
    );
    if (byName) return { selectedCategoryName: byName.name, selectedSubcategory: c.subcategory || '' };
    if (!c.subcategory) {
      const parent = resourceCategories.find(
        (cat) => Array.isArray(cat.subcategories)
          && cat.subcategories.some((s) => String(s).toLowerCase() === savedCat.toLowerCase())
      );
      if (parent) {
        const sub = parent.subcategories.find((s) => String(s).toLowerCase() === savedCat.toLowerCase());
        return { selectedCategoryName: parent.name, selectedSubcategory: sub };
      }
    }
    return { selectedCategoryName: savedCat, selectedSubcategory: c.subcategory || '' };
  }, [c.category, c.subcategory, resourceCategories]);

  // The category filter now supports multiple selections. Prefer the newer
  // `categories` array; fall back to the legacy single value (mapped to a real
  // category name where possible) so existing blocks stay editable.
  const selectedCategories = useMemo(() => {
    const arr = Array.isArray(c.categories) ? c.categories.filter(Boolean).map(String) : [];
    if (arr.length) return arr;
    return selectedCategoryName ? [selectedCategoryName] : [];
  }, [c.categories, selectedCategoryName]);

  const selectedSubcategories = useMemo(() => {
    const arr = Array.isArray(c.subcategories) ? c.subcategories.filter(Boolean).map(String) : [];
    if (arr.length) return arr;
    return selectedSubcategory ? [selectedSubcategory] : [];
  }, [c.subcategories, selectedSubcategory]);

  // Sub-category options are the union of the sub-categories across every
  // selected (known) category.
  const subcategoryOptions = useMemo(() => {
    const seen = new Set();
    const out = [];
    selectedCategories.forEach((name) => {
      const cat = resourceCategories.find(
        (cc) => String(cc.name || '').toLowerCase() === String(name).toLowerCase()
      );
      if (cat && Array.isArray(cat.subcategories)) {
        cat.subcategories.filter(Boolean).forEach((s) => {
          const key = String(s).toLowerCase();
          if (!seen.has(key)) { seen.add(key); out.push(s); }
        });
      }
    });
    return out;
  }, [selectedCategories, resourceCategories]);

  // Warn editors when a saved filter references a category / sub-category that
  // no longer exists (renamed or deleted in Category Management). We only judge
  // staleness once the category list has loaded, otherwise every block would
  // flash a false warning on first render. With multi-select, a selected
  // category is stale when it no longer matches any active category by name,
  // and a selected sub-category is stale when it is no longer one of the
  // available sub-categories for the selected categories.
  const knownCategoryNames = useMemo(
    () => new Set(resourceCategories.map((cat) => String(cat.name || '').toLowerCase())),
    [resourceCategories]
  );
  const staleCategories = useMemo(
    () => (categoriesLoading
      ? []
      : selectedCategories.filter((name) => !knownCategoryNames.has(String(name).toLowerCase()))),
    [categoriesLoading, selectedCategories, knownCategoryNames]
  );
  const availableSubSet = useMemo(
    () => new Set(subcategoryOptions.map((s) => String(s).toLowerCase())),
    [subcategoryOptions]
  );
  const staleSubcategories = useMemo(
    () => (categoriesLoading
      ? []
      : selectedSubcategories.filter((s) => !availableSubSet.has(String(s).toLowerCase()))),
    [categoriesLoading, selectedSubcategories, availableSubSet]
  );

  return (
    <>
      <SelectField
        label="Resource type"
        value={c.resourceType || 'all'}
        onChange={(v) => set({ resourceType: v === 'all' ? '' : v })}
        options={[
          { value: 'all', label: 'All resource types' },
          { value: 'download', label: 'Download' },
          { value: 'video', label: 'Video' },
          { value: 'external_link', label: 'External link' },
          { value: 'tenant_form', label: 'Tenant form' },
        ]}
        testId={`select-${idPrefix}-type`}
      />
      <TextField label="Filter tag" value={c.tag} onChange={(v) => set({ tag: v })} testId={`input-${idPrefix}-tag`} />
      <MultiCheckboxField
        label="Filter categories"
        value={selectedCategories}
        options={[
          ...resourceCategories.map((cat) => ({ value: cat.name, label: cat.name })),
          ...staleCategories.map((name) => ({ value: name, label: `${name} (no longer exists)` })),
        ]}
        onChange={(next) => {
          // Keep only the sub-categories that still belong to a selected category.
          const validSubs = new Set();
          next.forEach((name) => {
            const cat = resourceCategories.find(
              (cc) => String(cc.name || '').toLowerCase() === String(name).toLowerCase()
            );
            if (cat && Array.isArray(cat.subcategories)) {
              cat.subcategories.filter(Boolean).forEach((s) => validSubs.add(String(s).toLowerCase()));
            }
          });
          const prunedSubs = selectedSubcategories.filter((s) => validSubs.has(String(s).toLowerCase()));
          set({ categories: next, subcategories: prunedSubs, category: '', subcategory: '' });
        }}
        testId={`multiselect-${idPrefix}-categories`}
        hint={categoriesLoading ? 'Loading categories…' : 'Leave all unchecked for every category. Resources matching any selected category are shown.'}
        warning={staleCategories.length
          ? `Saved categor${staleCategories.length > 1 ? 'ies' : 'y'} ${staleCategories.map((n) => `"${n}"`).join(', ')} no longer exist. Uncheck ${staleCategories.length > 1 ? 'them' : 'it'} or pick a current category, or this list may show nothing.`
          : undefined}
      />
      <MultiCheckboxField
        label="Filter sub-categories"
        value={selectedSubcategories}
        options={[
          ...subcategoryOptions.map((s) => ({ value: s, label: s })),
          ...staleSubcategories.map((s) => ({ value: s, label: `${s} (no longer exists)` })),
        ]}
        onChange={(next) => set({
          categories: selectedCategories,
          subcategories: next,
          category: '',
          subcategory: '',
        })}
        testId={`multiselect-${idPrefix}-subcategories`}
        hint={subcategoryOptions.length === 0
          ? 'Select one or more categories to choose sub-categories.'
          : 'Resources matching any selected sub-category are shown.'}
        warning={staleSubcategories.length
          ? `Saved sub-categor${staleSubcategories.length > 1 ? 'ies' : 'y'} ${staleSubcategories.map((s) => `"${s}"`).join(', ')} no longer belong to the selected categories. Uncheck ${staleSubcategories.length > 1 ? 'them' : 'it'} or pick a current sub-category.`
          : undefined}
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
        testId={`select-${idPrefix}-audience`}
      />
    </>
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
      <ResourceFilterFields c={c} set={set} idPrefix="resource-list" />
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
      <NumberField label={c.paginate ? 'Items per page' : 'Limit'} min={1} max={50} value={c.limit || 6} onChange={(v) => set({ limit: Math.max(1, Math.min(50, Number(v) || 1)) })} testId="input-resource-list-limit" />
      <ToggleField
        label="Paginate"
        value={!!c.paginate}
        onChange={(v) => set({ paginate: v })}
        testId="toggle-resource-list-paginate"
        hint="Page through all matching resources with prev/next controls, showing the limit above as items per page."
      />
      <ToggleField
        label="Show search box"
        value={!!c.searchEnabled}
        onChange={(v) => set({ searchEnabled: v })}
        testId="toggle-resource-list-search"
        hint="Adds a search box above the list so viewers can filter the shown resources by title, description, type or tag."
      />
      {c.searchEnabled ? (
        <TextField
          label="Search placeholder"
          value={c.searchPlaceholder}
          onChange={(v) => set({ searchPlaceholder: v })}
          testId="input-resource-list-search-placeholder"
        />
      ) : null}
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap || 16} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-resource-list-gap" />
      <NumberField
        label="Card corner radius (px)"
        min={0}
        max={40}
        value={c.cardBorderRadius ?? 0}
        onChange={(v) => set({ cardBorderRadius: v })}
        testId="input-resource-list-border-radius"
      />
      <ToggleField
        label="Open in new tab"
        value={resolveNewTab(c, true)}
        onChange={(v) => set({ newTab: v })}
        testId="toggle-resource-list-new-tab"
        hint="Open resource links in a new browser tab."
      />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-resource-list-empty" />
    </>
  );
}

// ============================================================================
// RESOURCE SHOWCASE
// ============================================================================
// Cards-only equivalent of the iEdit "Resources Showcase" element: a grid of
// Showcase cards for resources, with the exact same card controls as the
// article/news list block. No background / header / subheader / description
// text — authors add those with separate blocks, keeping the grid reusable.
function ResourceShowcaseRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const cols = columnsForBreakpoint(c, breakpoint);
  const linkNewTab = resolveNewTab(c, true);
  // Saved blocks from before source modes existed must keep their established
  // automatic behaviour. A manual list is deliberately ordered by its IDs,
  // rather than by the normal resource date sort.
  const sourceMode = getResourceShowcaseSourceMode(c);
  const selectedResourceIds = Array.isArray(c.resourceIds) ? c.resourceIds : [];

  const { data, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-resources'],
    queryFn: () => publicClient.listResources(),
    staleTime: 60_000,
  });
  const { data: categoriesData } = useQuery({
    queryKey: ['canvas', 'public-resource-categories'],
    queryFn: () => publicClient.listResourceCategories(),
    staleTime: 60_000,
  });

  const { data: buttonStyles = [] } = useQuery({
    queryKey: ['canvas', 'public-button-styles-resources'],
    queryFn: async () => {
      const styles = await publicClient.listButtonStyles();
      return (Array.isArray(styles) ? styles : []).filter((style) => style.card_type === 'resource' && style.is_active);
    },
    staleTime: 60_000,
  });

  const isLoggedIn = useMemo(() => {
    try {
      const raw = localStorage.getItem('agcas_member');
      if (!raw) return false;
      const member = JSON.parse(raw);
      return !member.sessionExpiry || new Date(member.sessionExpiry) >= new Date();
    } catch {
      return false;
    }
  }, []);

  const items = useMemo(() => {
    if (sourceMode === 'specific') {
      return resolveSpecificResourceShowcaseItems(data, selectedResourceIds);
    }
    let list = filterResourcesByContent(data, c, categoriesData);
    const dir = c.sortBy === 'date-asc' ? 1 : -1;
    list.sort((a, b) => {
      const da = new Date(a.published_date || a.created_at || a.created_date || 0);
      const db = new Date(b.published_date || b.created_at || b.created_date || 0);
      return (da - db) * dir;
    });
    const limit = Number(c.limit) > 0 ? Number(c.limit) : 0;
    return limit ? list.slice(0, limit) : list;
  }, [data, categoriesData, sourceMode, selectedResourceIds, c.resourceType, c.tag, c.category, c.subcategory, c.categories, c.subcategories, c.audience, c.sortBy, c.limit]);

  // Shared Showcase-card knobs — identical to the article/news list block.
  const {
    cardHeight, imageHeightPercent, ctaButtonSize, ctaButtonMargin,
    imageBorderWeight, cardTextAlign, cardBorderRadius, hasExplicitTitleSize,
    titleFontSize, dateFontSize, showPublishedDate, descriptionLineClamp,
    ctaButtonBorderRadius,
  } = resolveShowcaseCardSettings(c);
  const badgeBg = c.badgeBgColor || '#9333ea';
  const badgeTextColor = c.badgeTextColor || '#ffffff';
  const badgeText = (typeof c.badgeText === 'string' && c.badgeText.trim()) ? c.badgeText : 'Resource';

  // Tenant typography styles for the card title / summary text, mirroring
  // the article/news list block exactly.
  const { styles: tenantStyles, resolved: stylesResolved } = useTenantTypographyStylesState();
  const titleStyleObj = resolveTenantStyle(c.titleTypographyStyleId, tenantStyles);
  const summaryStyleObj = resolveTenantStyle(c.summaryTypographyStyleId, tenantStyles);
  const awaitingTitle = isAwaitingTypographyStyle(c.titleTypographyStyleId, titleStyleObj, stylesResolved);
  const awaitingSummary = isAwaitingTypographyStyle(c.summaryTypographyStyleId, summaryStyleObj, stylesResolved);
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const bpForInline = isPreview ? breakpoint : 'desktop';
  let titleInline = titleStyleObj
    ? buildTypographyInlineStyle(titleStyleObj, { breakpoint: bpForInline })
    : null;
  if (titleInline && hasExplicitTitleSize) titleInline = { ...titleInline, fontSize: `${titleFontSize}px` };
  if (awaitingTitle) titleInline = { ...(titleInline || {}), visibility: 'hidden' };
  let summaryInline = summaryStyleObj
    ? buildTypographyInlineStyle(summaryStyleObj, { breakpoint: bpForInline })
    : null;
  if (awaitingSummary) summaryInline = { ...(summaryInline || {}), visibility: 'hidden' };
  const safeBlockId = String(block.id || '').replace(/["\\]/g, '');
  const responsiveCss = !isPreview
    ? [
        titleStyleObj && hasResponsiveTypographyOverride(titleStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="resource-showcase-title"]`, titleStyleObj)
          : null,
        summaryStyleObj && hasResponsiveTypographyOverride(summaryStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="resource-showcase-summary"]`, summaryStyleObj)
          : null,
        buildResponsiveListGridCss(block.id, c, c.gap ?? 24, { testId: 'resource-showcase' }),
      ].filter(Boolean).join('')
    : '';

  return (
    <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || 'Resources'}>
      {responsiveCss ? <style dangerouslySetInnerHTML={{ __html: responsiveCss }} /> : null}
      {isLoading ? (
        <ListSkeleton
          count={sourceMode === 'specific'
            ? Math.min(Math.max(selectedResourceIds.filter(Boolean).length, 1), 6)
            : Math.min(c.limit || 3, 6)}
          columns={cols}
          gap={c.gap}
        />
      ) : isError ? (
        <ErrorState message="Couldn't load resources right now." />
      ) : items.length === 0 ? (
        <EmptyState icon={Folder} text={c.emptyText || 'No resources available.'} />
      ) : (
        <ul className="list-none m-0 p-0" style={isPreview ? gridStyle(cols, c.gap ?? 24) : undefined} data-testid="resource-showcase">
          {items.map((r) => {
            // Same link behaviour as the iEdit Resources Showcase element:
            // public resources open their target URL directly (the public
            // API nulls target_url for member-only resources); member-only
            // resources show a lock CTA and route to /resources?resourceId=
            // which triggers the login flow for guests and opens the
            // resource for authenticated members.
            const isLocked = r.is_public === false || r.is_locked === true;
            const url = isLocked
              ? `/resources?resourceId=${r.id}`
              : (r.target_url || r.download_url || r.content_url || '');
            if (r.resource_type === TENANT_FORM_RESOURCE_TYPE) {
              return (
                <li
                  key={r.id}
                  className="list-none"
                  onClickCapture={asEditor ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  } : undefined}
                >
                  <ResourceCard
                    resource={r}
                    isLocked={isLocked}
                    isAuthenticated={isLoggedIn}
                    buttonStyles={buttonStyles}
                    openInNewTab={resolveResourceNewTab(r, linkNewTab)}
                    cornerRadius={cardBorderRadius}
                  />
                </li>
              );
            }
            return (
              <li key={r.id} className="list-none">
                <ShowcaseCard
                  title={r.title || r.name}
                  imageUrl={r.image_url || r.feature_image_url}
                  showImageArea={c.showImage !== false}
                  imageFocalPoint={r.feature_image_focal_point || null}
                  imageAlt={r.title || r.name}
                  summary={c.showSummary !== false ? (r.summary || r.description) : null}
                  publishedDate={r.published_date || r.created_at || r.created_date}
                  url={url || undefined}
                  external={!isLocked && !!url}
                  newTab={!isLocked && linkNewTab}
                  locked={isLocked}
                  asEditor={asEditor}
                  showBadge={c.showBadge !== false}
                  badgeText={badgeText}
                  badgeBgColor={badgeBg}
                  badgeTextColor={badgeTextColor}
                  cardHeight={cardHeight}
                  imageHeightPercent={imageHeightPercent}
                  showImageBorder={!!c.showImageBorder}
                  imageBorderWeight={imageBorderWeight}
                  imageBorderColor={c.imageBorderColor || '#2563eb'}
                  showCTAButton={c.showCTAButton !== false}
                  ctaButtonSize={ctaButtonSize}
                  ctaButtonMargin={ctaButtonMargin}
                  ctaButtonBgColor={c.ctaButtonBgColor || '#2563eb'}
                  ctaButtonArrowColor={c.ctaButtonArrowColor || '#ffffff'}
                  ctaButtonBorderRadius={ctaButtonBorderRadius}
                  textAlign={cardTextAlign}
                  cardBorderRadius={cardBorderRadius}
                  titleFontSize={titleFontSize}
                  dateFontSize={dateFontSize}
                  showPublishedDate={showPublishedDate}
                  descriptionLineClamp={c.showSummary !== false ? descriptionLineClamp : 0}
                  titleStyleOverride={titleInline}
                  summaryStyleOverride={summaryInline}
                  titleExtraProps={{ 'data-tg-r': 'resource-showcase-title' }}
                  summaryExtraProps={{ 'data-tg-r': 'resource-showcase-summary' }}
                  testId={r.id}
                  wrapperTestId={`link-resource-showcase-${r.id}`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ResourceShowcasePickerRow({ value, onChange, testId, disabledValues = [] }) {
  const { data: resources, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-resources'],
    queryFn: () => publicClient.listResources(),
    staleTime: 60_000,
  });
  const [open, setOpen] = useState(false);
  const options = (Array.isArray(resources) ? resources : []).map((resource) => ({
    value: String(resource.id),
    label: resource.title || resource.name || '(untitled resource)',
  }));
  const current = options.find((option) => option.value === String(value || ''));
  const disabledSet = new Set((disabledValues || []).filter(Boolean).map(String));
  const hint = isLoading
    ? 'Loading resources…'
    : isError
      ? 'Couldn’t load resources right now.'
      : options.length === 0
        ? 'No resources are currently available in the public resource feed.'
        : 'Search the resources currently available in the public resource feed.';

  return (
    <Field label="Resource" hint={hint}>
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
            <span className="truncate text-left">
              {current ? current.label : value ? 'Unavailable resource' : 'Select a resource'}
            </span>
            <ChevronRight className="ml-2 h-4 w-4 shrink-0 opacity-50 rotate-90" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[--radix-popover-trigger-width]" align="start">
          <Command>
            <CommandInput placeholder="Search resources…" data-testid={`${testId}-search`} />
            <CommandList>
              <CommandEmpty>{isLoading ? 'Loading resources…' : 'No resources found.'}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => {
                  const isDisabled = disabledSet.has(option.value) && option.value !== String(value || '');
                  return (
                    <CommandItem
                      key={option.value}
                      value={`${option.label} ${option.value}`}
                      disabled={isDisabled}
                      onSelect={() => { onChange(option.value); setOpen(false); }}
                      data-testid={`${testId}-option-${option.value}`}
                    >
                      <span className="truncate">{option.label}</span>
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

function ResourceShowcaseInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const sourceMode = getResourceShowcaseSourceMode(c);
  const resourceIds = Array.isArray(c.resourceIds) ? c.resourceIds.map((id) => String(id || '')) : [];
  return (
    <>
      <SelectField
        label="Resource source"
        value={sourceMode}
        onChange={(v) => set({ sourceMode: v })}
        options={[
          { value: 'automatic', label: 'Automatic resources' },
          { value: 'specific', label: 'Specific resources' },
        ]}
        testId="select-resource-showcase-source"
      />
      {sourceMode === 'automatic' ? (
        <>
          <ResourceFilterFields c={c} set={set} idPrefix="resource-showcase" />
          <SelectField
            label="Sort"
            value={c.sortBy || 'date-desc'}
            onChange={(v) => set({ sortBy: v })}
            options={[
              { value: 'date-desc', label: 'Newest first' },
              { value: 'date-asc', label: 'Oldest first' },
            ]}
            testId="select-resource-showcase-sort"
          />
          <NumberField label="Limit" min={1} max={50} value={c.limit || 3} onChange={(v) => set({ limit: Math.max(1, Number(v) || 1) })} testId="input-resource-showcase-limit" />
        </>
      ) : (
        <Field label="Selected resources" hint="Add resources from the public feed. Use Up and Down to choose their display order.">
          <CarouselArrayList
            items={resourceIds}
            onChange={(next) => set({ resourceIds: next })}
            renderItem={(item, idx, setItem) => (
              <ResourceShowcasePickerRow
                value={item}
                onChange={setItem}
                testId={`select-resource-showcase-resource-${idx}`}
                disabledValues={resourceIds.filter((_, index) => index !== idx)}
              />
            )}
            makeNew={() => ''}
            addLabel="Add resource"
            testIdPrefix="resource-showcase-resources"
          />
        </Field>
      )}
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap ?? 24} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-resource-showcase-gap" />
      <ShowcaseCardSettingsFields c={c} set={set} idPrefix="resource-showcase" badgeTextPlaceholder="Default: Resource" />
      <ToggleField
        label="Open in new tab"
        value={resolveNewTab(c, true)}
        onChange={(v) => set({ newTab: v })}
        testId="toggle-resource-showcase-new-tab"
        hint="Open the resource link in a new browser tab."
      />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-resource-showcase-empty" />
    </>
  );
}

// ============================================================================
// FORM EMBED
// ============================================================================
function FormEmbedRender({ block, asEditor, priority }) {
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

  const params = new URLSearchParams();
  if (c.fontFamily) params.set('font', c.fontFamily);
  if (Number.isFinite(c.fontSize) && c.fontSize > 0) params.set('fontSize', String(c.fontSize));
  const qs = params.toString();
  const href = `/embed/form/${encodeURIComponent(form.slug)}${qs ? `?${qs}` : ''}`;

  const mode = c.mode || 'inline';

  // The form's inner content for each display mode. It is placed inside the
  // centred content rail so the form stays within the page column even when
  // the surrounding background bleeds full width.
  let inner;
  if (mode === 'link') {
    inner = (
      <article className="w-full h-full overflow-auto flex flex-col gap-2">
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
  } else {
    // inline + iframe both render the real public form runtime in an iframe so
    // conditional logic, validation, and the submission pipeline are preserved.
    inner = (
      <>
        {mode === 'inline' && (c.title || form.name) ? (
          <h3 className="text-base font-semibold text-slate-900 m-0 mb-2">{c.title || form.name}</h3>
        ) : null}
        {asEditor ? (
          <div className="flex-1 min-h-[200px] grid place-items-center text-xs text-slate-500 border border-dashed border-slate-300 rounded">
            Form preview ({form.name}) — submissions only run on the published page.
          </div>
        ) : (
          <FormEmbedIframe href={href} title={c.title || form.name || 'Form'} />
        )}
      </>
    );
  }

  // Background treatment mirrors the Section element: colour (driven by the
  // Appearance panel's style.background on the outer block tag), or gradient /
  // image + overlay (both rendered as inset bleed layers). Gradient and image
  // backgrounds bleed back out to the full block edge via `layerInset` negative
  // offsets, so the outer padding insets the form *within* the visible
  // background instead of outside it. All bleed-mode side effects are gated
  // behind `isImageBg` / `isGradientBg` so legacy form embeds (no bgType /
  // bgType === 'color') emit exactly the same DOM as before.
  const isImageBg = c.bgType === 'image' && !!c.bgImageUrl;
  const isGradientBg = c.bgType === 'gradient';
  const isBleedBg = isImageBg || isGradientBg;
  const gradientBg = isGradientBg ? buildSectionGradientBackground(c) : null;
  const overlayBg = isImageBg ? buildSectionOverlayBackground(c) : null;
  const hasOverlay = isImageBg && overlayBg && (c.overlayType || 'none') !== 'none';

  const s = block.style || {};
  const pt = s.paddingTop || 0;
  const pr = s.paddingRight || 0;
  const pb = s.paddingBottom || 0;
  const pl = s.paddingLeft || 0;
  const layerInset = isBleedBg ? {
    position: 'absolute',
    top: -pt,
    right: -pr,
    bottom: -pb,
    left: -pl,
    pointerEvents: 'none',
  } : null;

  // Inner rail keeps the form within the page content column. When full-bleed,
  // the wrapper background spans 100vw (via geomRule on the outer tag) but the
  // rail caps the form to `--cb-content-width` (published per breakpoint;
  // 1200/768/375, fallback 1200) — mirroring the News Ticker pattern. It is a
  // flex column so the iframe can flex to fill until it reports its height.
  const railStyle = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  };
  if (c.fullBleed) {
    railStyle.maxWidth = 'var(--cb-content-width, 1200px)';
    railStyle.marginInline = 'auto';
  }
  if (isBleedBg) {
    // Keep the form rail above the gradient/image bleed layer so the outer
    // padding stays visible as breathing room between background and form.
    railStyle.position = 'relative';
    railStyle.zIndex = 2;
  }

  // `isolation: isolate` confines the overlay's mix-blend-mode to the
  // image+overlay stack so the form never compositionally blends with anything
  // beneath the block. Gradient now paints on an inset bleed layer (like image)
  // rather than on this wrapper, so the outer padding insets the form within
  // the gradient instead of outside it.
  const wrapperStyle = isImageBg ? { isolation: 'isolate' } : undefined;

  return (
    <div
      className="w-full h-full relative"
      style={wrapperStyle || undefined}
      aria-label={block.a11y?.ariaLabel || form.name}
      data-full-bleed={c.fullBleed ? 'true' : 'false'}
      {...(isImageBg ? { 'data-bg-type': 'image' } : isGradientBg ? { 'data-bg-type': 'gradient' } : null)}
    >
      {isImageBg && (() => {
        const r = buildResponsiveImage(c.bgImageUrl, { sizes: '100vw' });
        return (
          <img
            src={r.src}
            srcSet={r.srcSet}
            sizes={r.sizes}
            alt=""
            aria-hidden="true"
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            fetchpriority={priority ? 'high' : undefined}
            style={{
              ...layerInset,
              width: `calc(100% + ${pl + pr}px)`,
              height: `calc(100% + ${pt + pb}px)`,
              maxWidth: 'none',
              maxHeight: 'none',
              objectFit: 'cover',
              objectPosition: 'center',
              zIndex: 0,
            }}
          />
        );
      })()}
      {isGradientBg && gradientBg && (
        <div
          aria-hidden="true"
          style={{
            ...layerInset,
            background: gradientBg,
            zIndex: 0,
          }}
        />
      )}
      {hasOverlay && (
        <div
          aria-hidden="true"
          style={{
            ...layerInset,
            background: overlayBg,
            mixBlendMode: c.overlayBlendMode || 'normal',
            zIndex: 1,
          }}
        />
      )}
      <div style={railStyle}>
        {inner}
      </div>
    </div>
  );
}

function FormEmbedIframe({ href, title }) {
  const iframeRef = useRef(null);
  const [height, setHeight] = useState(null);

  useEffect(() => {
    const onMessage = (event) => {
      const data = event.data;
      if (!data || data.type !== 'iconn-form-resize') return;
      const iframe = iframeRef.current;
      // Only react to messages coming from this iframe's own contentWindow.
      if (!iframe || event.source !== iframe.contentWindow) return;
      const reported = Number(data.height);
      if (!Number.isFinite(reported) || reported <= 0) return;
      setHeight(Math.ceil(reported));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Canvas block boxes are absolutely positioned with a geometry-driven
  // fixed height and `overflow:hidden`, so a form taller than the block's
  // allocated height gets clipped even though the iframe itself is sized
  // correctly. When the form reports its height, let the enclosing block
  // frame grow with its content (and extend the stage so the document
  // expands to contain it) instead of clipping.
  //
  // Because every block keeps its original fixed `top`, simply growing the
  // form would make it overlap any block an author placed directly beneath
  // it. So we also push down every sibling block positioned below the form
  // by the same growth delta, keeping the document free of overlap/clipping.
  useEffect(() => {
    if (height == null) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const blockEl = iframe.closest('[data-cb]');
    if (!blockEl) return;
    return applyFormEmbedResize(blockEl);
  }, [height]);

  return (
    <iframe
      ref={iframeRef}
      src={href}
      title={title}
      loading="lazy"
      style={{
        width: '100%',
        flex: height == null ? 1 : '0 0 auto',
        height: height == null ? undefined : height,
        minHeight: 320,
        border: 0,
      }}
      data-testid="iframe-form-embed"
    />
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

// Font picker for the embedded form. Sources the selectable families from the
// tenant's typography styles (the same list InstalledFonts/IEdit drive off), so
// authors can only pick fonts the tenant actually has. `value` is the full CSS
// font-family string (e.g. "Poppins, sans-serif"); empty = the form's default.
function FormFontField({ value, onChange, testId }) {
  const { styles } = useTenantTypographyStylesState();
  const fonts = useMemo(() => {
    const seen = new Map();
    (styles || []).forEach((s) => {
      const fam = String(s?.font_family || '').trim();
      if (!fam || seen.has(fam)) return;
      const label = fam.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      seen.set(fam, label || fam);
    });
    return Array.from(seen, ([v, label]) => ({ value: v, label }));
  }, [styles]);
  return (
    <Field label="Font" hint={fonts.length === 0 ? 'No tenant fonts found; using the form default.' : null}>
      <Select value={value || '__default__'} onValueChange={(v) => onChange(v === '__default__' ? '' : v)}>
        <SelectTrigger className="h-8" data-testid={testId}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__">Default</SelectItem>
          {fonts.map((o) => (
            <SelectItem key={o.value} value={o.value} style={{ fontFamily: o.value }}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function FormEmbedInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const bgType = c.bgType || 'color';
  const overlayType = c.overlayType || 'solid';
  const isImageBg = bgType === 'image';
  const isGradientBg = bgType === 'gradient';
  const gradientType = c.gradientType || 'linear';
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
      <FormFontField value={c.fontFamily} onChange={(v) => set({ fontFamily: v })} testId="select-form-embed-font" />
      <SelectField
        label="Text size"
        value={Number.isFinite(c.fontSize) && c.fontSize > 0 ? String(c.fontSize) : '__default__'}
        onChange={(v) => set({ fontSize: v === '__default__' ? null : Number(v) })}
        options={[
          { value: '__default__', label: 'Default' },
          { value: '14', label: 'Small' },
          { value: '16', label: 'Medium' },
          { value: '18', label: 'Large' },
          { value: '20', label: 'Extra large' },
        ]}
        testId="select-form-embed-font-size"
      />
      <TextField label="Title override" value={c.title} onChange={(v) => set({ title: v })} testId="input-form-embed-title" />
      <TextField label="CTA label" value={c.ctaLabel} onChange={(v) => set({ ctaLabel: v })} testId="input-form-embed-cta" />
      <ToggleField
        label="Full-bleed"
        value={!!c.fullBleed}
        onChange={(v) => set({ fullBleed: v })}
        testId="toggle-form-embed-full-bleed"
        hint="Background spans the full viewport width; the form stays within the page content column."
      />
      <SelectField
        label="Background"
        value={bgType}
        onChange={(v) => set({ bgType: v })}
        options={[
          { value: 'color', label: 'Colour' },
          { value: 'gradient', label: 'Gradient' },
          { value: 'image', label: 'Image' },
        ]}
        testId="select-form-embed-bg-type"
      />
      {isGradientBg && (
        <>
          <SelectField
            label="Gradient type"
            value={gradientType}
            onChange={(v) => set({ gradientType: v })}
            options={[
              { value: 'linear', label: 'Linear' },
              { value: 'radial', label: 'Radial' },
            ]}
            testId="select-form-embed-gradient-type"
          />
          {gradientType === 'linear' && (
            <NumberField
              label="Angle (0–360°)"
              min={0} max={360} step={1}
              value={Number.isFinite(c.gradientAngle) ? c.gradientAngle : 180}
              onChange={(v) => {
                const n = Number(v);
                set({ gradientAngle: Number.isFinite(n) ? Math.max(0, Math.min(360, n)) : 180 });
              }}
              testId="input-form-embed-gradient-angle"
            />
          )}
          <SectionGradientStops
            c={c}
            gradientType={gradientType}
            set={set}
          />
        </>
      )}
      {isImageBg && (
        <>
          <ImageField
            label="Background image"
            value={c.bgImageUrl}
            onChangeSrc={(v) => set({ bgImageUrl: v })}
            testId="input-form-embed-bg-image"
          />
          <SelectField
            label="Overlay"
            value={overlayType}
            onChange={(v) => set({ overlayType: v })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'solid', label: 'Solid colour' },
              { value: 'linear', label: 'Linear gradient' },
              { value: 'radial', label: 'Radial gradient' },
            ]}
            testId="select-form-embed-overlay-type"
          />
          {overlayType === 'solid' && (
            <>
              <ColorField
                label="Overlay colour"
                value={c.overlayColor || '#000000'}
                onChange={(v) => set({ overlayColor: v })}
                testId="input-form-embed-overlay-color"
              />
              <NumberField
                label="Overlay opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.overlayOpacity ?? 0.4}
                onChange={(v) => set({ overlayOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-form-embed-overlay-opacity"
              />
            </>
          )}
          {overlayType === 'linear' && (
            <>
              <ColorField
                label="From colour"
                value={c.overlayFromColor || '#000000'}
                onChange={(v) => set({ overlayFromColor: v })}
                testId="input-form-embed-overlay-from-color"
              />
              <NumberField
                label="From opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.overlayFromOpacity ?? 0.6}
                onChange={(v) => set({ overlayFromOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-form-embed-overlay-from-opacity"
              />
              <ColorField
                label="To colour"
                value={c.overlayToColor || '#000000'}
                onChange={(v) => set({ overlayToColor: v })}
                testId="input-form-embed-overlay-to-color"
              />
              <NumberField
                label="To opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.overlayToOpacity ?? 0}
                onChange={(v) => set({ overlayToOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-form-embed-overlay-to-opacity"
              />
              <NumberField
                label="Angle (0–360°)"
                min={0} max={360} step={1}
                value={Number.isFinite(c.overlayAngle) ? c.overlayAngle : 180}
                onChange={(v) => {
                  const n = Number(v);
                  set({ overlayAngle: Number.isFinite(n) ? Math.max(0, Math.min(360, n)) : 180 });
                }}
                testId="input-form-embed-overlay-angle"
              />
            </>
          )}
          {overlayType === 'radial' && (
            <>
              <ColorField
                label="Centre colour"
                value={c.overlayCenterColor || '#000000'}
                onChange={(v) => set({ overlayCenterColor: v })}
                testId="input-form-embed-overlay-center-color"
              />
              <NumberField
                label="Centre opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.overlayCenterOpacity ?? 0}
                onChange={(v) => set({ overlayCenterOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-form-embed-overlay-center-opacity"
              />
              <ColorField
                label="Edge colour"
                value={c.overlayEdgeColor || '#000000'}
                onChange={(v) => set({ overlayEdgeColor: v })}
                testId="input-form-embed-overlay-edge-color"
              />
              <NumberField
                label="Edge opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.overlayEdgeOpacity ?? 0.6}
                onChange={(v) => set({ overlayEdgeOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-form-embed-overlay-edge-opacity"
              />
            </>
          )}
          {overlayType !== 'none' && (
            <SelectField
              label="Blend mode"
              value={c.overlayBlendMode || 'normal'}
              onChange={(v) => set({ overlayBlendMode: v })}
              options={SECTION_BLEND_MODES.map((m) => ({ value: m, label: m }))}
              testId="select-form-embed-overlay-blend"
            />
          )}
        </>
      )}
      <p className="text-xs text-slate-500">
        Use the Appearance panel above for the background colour, border and padding.
        {isImageBg ? ' The Appearance colour shows through any transparent areas of the image overlay.' : ''}
        {isGradientBg ? ' The gradient renders behind the form; the Appearance background colour is hidden when a gradient is set.' : ''}
      </p>
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

function useDirectoryRecords({ directorySlug, page, limit, sort, search, filterOverrides, enabled }) {
  return useQuery({
    queryKey: ['canvas', 'public-dynamic-directory', directorySlug, page || 1, limit, sort, search || '', filterOverrides || ''],
    queryFn: async () => {
      const tenant = publicClient.getTenantSlug();
      const params = new URLSearchParams();
      params.set('slug', directorySlug);
      params.set('page', String(Math.max(1, page || 1)));
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
    keepPreviousData: true,
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
  const pageSize = Math.max(1, Math.min(c.limit || 12, 50));

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort, setSort] = useState(c.sort || 'name-asc');
  const [currentPage, setCurrentPage] = useState(1);

  // Debounce end-user search (portal uses 300ms).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Any query change resets to page 1.
  useEffect(() => { setCurrentPage(1); }, [debouncedSearch, sort, c.directorySlug, c.filterOverrides]);

  const { data, isLoading, isError, error, isFetching } = useDirectoryRecords({
    directorySlug: c.directorySlug,
    page: currentPage,
    limit: pageSize,
    sort,
    search: debouncedSearch,
    filterOverrides: c.filterOverrides,
  });

  const records = Array.isArray(data?.records) ? data.records : [];
  const entityType = data?.entityType || 'member';
  const cfg = data?.config || {};
  const displaySettings = cfg.displaySettings || {};
  const roles = Array.isArray(cfg.roles) ? cfg.roles : [];
  const directoryCustomFields = Array.isArray(cfg.directoryCustomFields) ? cfg.directoryCustomFields : [];
  const rolesById = useMemo(() => {
    const m = {};
    for (const r of roles) m[r.id] = r;
    return m;
  }, [roles]);

  const total = Number(data?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (!c.directorySlug) {
    return <EmptyState icon={Icon} text="Pick a directory in the inspector." />;
  }

  // In the editor, block interactive controls from stealing selection clicks.
  const editorGuard = asEditor
    ? { onClickCapture: (e) => e.stopPropagation() }
    : {};

  return (
    <TooltipProvider>
      <div className="w-full h-full overflow-auto" aria-label={block.a11y?.ariaLabel || c.title || fallbackTitle}>
        {c.title ? <Heading level={c.headingLevel || 2}>{c.title}</Heading> : null}

        <div className="flex flex-wrap items-center gap-3 mb-4" {...editorGuard}>
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" aria-hidden="true" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={entityType === 'organization' ? 'Search organisations...' : 'Search members...'}
              className="pl-9"
              data-testid="input-directory-search"
              aria-label="Search directory"
            />
          </div>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger className="w-[180px]" data-testid="select-directory-sort" aria-label="Sort directory">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name-asc">Name (A → Z)</SelectItem>
              <SelectItem value="name-desc">Name (Z → A)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <ListSkeleton count={Math.min(pageSize, 6)} columns={cols} gap={c.gap} />
        ) : isError ? (
          <ErrorState message={String(error?.message || "Couldn't load directory right now.")} />
        ) : records.length === 0 ? (
          <EmptyState icon={Icon} text={c.emptyText || 'No records to show yet.'} />
        ) : (
          <>
            <ul
              className="list-none m-0 p-0"
              style={gridStyle(cols, c.gap)}
              data-testid="directory-list"
            >
              {records.map((r) => (
                <li key={r.id}>
                  {entityType === 'organization' ? (
                    <DirectoryOrganizationCard
                      org={r}
                      displaySettings={displaySettings}
                      isGuest={true}
                    />
                  ) : (
                    <DirectoryMemberCard
                      member={r}
                      role={r.role_id ? rolesById[r.role_id] : undefined}
                      organization={r.organization_name ? { name: r.organization_name } : undefined}
                      displaySettings={displaySettings}
                      directoryCustomFields={directoryCustomFields}
                      memberValues={r.customValues || {}}
                      isGuest={true}
                    />
                  )}
                </li>
              ))}
            </ul>

            {totalPages > 1 ? (
              <div className="flex items-center justify-center gap-4 mt-6" {...editorGuard}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1 || isFetching}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  data-testid="button-directory-prev"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Previous
                </Button>
                <span className="text-sm text-slate-600" data-testid="text-directory-page">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages || isFetching}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  data-testid="button-directory-next"
                >
                  Next <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </TooltipProvider>
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
        label="Default sort"
        value={c.sort || 'name-asc'}
        onChange={(v) => set({ sort: v })}
        options={[
          { value: 'name-asc', label: 'Name (A → Z)' },
          { value: 'name-desc', label: 'Name (Z → A)' },
        ]}
        testId="select-member-dir-sort"
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
      <NumberField label="Per page" min={1} max={50} value={c.limit || 12} onChange={(v) => set({ limit: Math.max(1, Number(v) || 1) })} testId="input-member-dir-limit" />
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap || 16} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-member-dir-gap" />
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
        label="Default sort"
        value={c.sort || 'name-asc'}
        onChange={(v) => set({ sort: v })}
        options={[
          { value: 'name-asc', label: 'Name (A → Z)' },
          { value: 'name-desc', label: 'Name (Z → A)' },
        ]}
        testId="select-dynamic-dir-sort"
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
      <NumberField label="Per page" min={1} max={50} value={c.limit || 12} onChange={(v) => set({ limit: Math.max(1, Number(v) || 1) })} testId="input-dynamic-dir-limit" />
      <PerBreakpointColumns value={c.columns} onChange={(v) => set({ columns: v })} />
      <NumberField label="Gap (px)" min={0} value={c.gap || 16} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-dynamic-dir-gap" />
      <TextField label="Empty state text" value={c.emptyText} onChange={(v) => set({ emptyText: v })} testId="input-dynamic-dir-empty" />
    </>
  );
}

// ============================================================================
// MEMBER GROUP
// ============================================================================
function useCanvasMemberGroups({ enabled = true } = {}) {
  return useQuery({
    queryKey: ['canvas', 'member-groups'],
    queryFn: async () => {
      const groups = await base44.entities.MemberGroup.listAll({
        filter: { is_active: true },
        sort: { name: 'asc' },
      });
      return (Array.isArray(groups) ? groups : [])
        .filter((group) => group?.id && group.is_active !== false)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    },
    enabled,
    staleTime: 60_000,
  });
}

function useMemberGroupBreakpoint(editorBreakpoint) {
  const explicit = isEditorPreviewBreakpoint(editorBreakpoint) ? editorBreakpoint : null;
  const detect = () => {
    if (typeof window === 'undefined') return 'desktop';
    if (window.innerWidth <= BREAKPOINT_MAX_PX.mobile) return 'mobile';
    if (window.innerWidth <= BREAKPOINT_MAX_PX.tablet) return 'tablet';
    return 'desktop';
  };
  const [liveBreakpoint, setLiveBreakpoint] = useState(() => explicit || detect());

  useEffect(() => {
    if (explicit) {
      setLiveBreakpoint(explicit);
      return undefined;
    }
    const update = () => setLiveBreakpoint(detect());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [explicit]);

  return explicit || liveBreakpoint;
}

function useMemberGroupMembers({ groupId, roles, page, limit }) {
  return useQuery({
    queryKey: ['canvas', 'public-member-group', groupId, roles, page, limit],
    queryFn: () => publicClient.listMemberGroupMembers({
      groupId,
      roles,
      page,
      limit,
    }),
    enabled: !!groupId,
    keepPreviousData: true,
    staleTime: 60_000,
  });
}

function MemberGroupRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const activeBreakpoint = useMemberGroupBreakpoint(breakpoint);
  const { columns, pageSize } = resolveMemberGroupGrid(c, activeBreakpoint);
  const selectedRoles = Array.isArray(c.roleFilter) ? c.roleFilter.filter(Boolean) : [];
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setCurrentPage(1);
  }, [c.groupId, pageSize, selectedRoles.join('\u0000')]);

  const { data, isLoading, isError, error, isFetching } = useMemberGroupMembers({
    groupId: c.groupId,
    roles: selectedRoles,
    page: currentPage,
    limit: pageSize,
  });
  const group = data?.config?.group || null;
  const records = Array.isArray(data?.records) ? data.records : [];
  const total = Number(data?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  if (!c.groupId) return <EmptyState icon={Users} text="Pick a member group in the inspector." />;

  return (
    <MemberGroupBlockView
      block={block}
      content={c}
      group={group}
      records={records}
      displaySettings={data?.config?.displaySettings}
      columns={columns}
      pageSize={pageSize}
      currentPage={currentPage}
      total={total}
      isLoading={isLoading}
      isError={isError}
      errorMessage={String(error?.message || '')}
      isFetching={isFetching}
      asEditor={asEditor}
      onPrevious={() => setCurrentPage((page) => Math.max(1, page - 1))}
      onNext={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
    />
  );
}

function MemberGroupInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((current) => ({
    ...current,
    content: { ...current.content, ...patch },
  }));
  const { data: groups = [], isLoading } = useCanvasMemberGroups();
  const selectedGroup = groups.find((group) => group.id === c.groupId) || null;
  const groupRoles = Array.isArray(selectedGroup?.roles) ? selectedGroup.roles.filter(Boolean) : [];

  useEffect(() => {
    const current = Array.isArray(c.roleFilter) ? c.roleFilter : [];
    const valid = current.filter((role) => groupRoles.includes(role));
    if (valid.length !== current.length) set({ roleFilter: valid });
  }, [
    c.groupId,
    groupRoles.join('\u0000'),
    (Array.isArray(c.roleFilter) ? c.roleFilter : []).join('\u0000'),
  ]);

  return (
    <>
      <Field label="Member group" hint={isLoading ? 'Loading member groups…' : null}>
        <Select
          value={c.groupId || ''}
          onValueChange={(groupId) => set({ groupId, roleFilter: [] })}
        >
          <SelectTrigger className="h-8" data-testid="select-member-group">
            <SelectValue placeholder="Select a member group" />
          </SelectTrigger>
          <SelectContent>
            {groups.length === 0 ? (
              <SelectItem value="__none__" disabled>No active member groups</SelectItem>
            ) : groups.map((group) => (
              <SelectItem key={group.id} value={group.id}>{group.name || 'Unnamed group'}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <MultiCheckboxField
        label="Roles to show"
        value={c.roleFilter}
        onChange={(roleFilter) => set({ roleFilter })}
        options={groupRoles.map((role) => ({ value: role, label: role }))}
        testId="member-group-role-filter"
        hint={!c.groupId
          ? 'Select a group to choose roles.'
          : groupRoles.length === 0
            ? 'This group has no configured roles.'
            : 'Leave every role unticked to show all current members.'}
      />
      <ToggleField label="Show member cards" value={c.showMembers !== false} onChange={(showMembers) => set({ showMembers })} testId="toggle-member-group-members" />
      <ToggleField label="Show group name" value={c.showGroupName !== false} onChange={(showGroupName) => set({ showGroupName })} testId="toggle-member-group-name" />
      <ToggleField label="Show group description" value={c.showGroupDescription !== false} onChange={(showGroupDescription) => set({ showGroupDescription })} testId="toggle-member-group-description" />
      <SelectField
        label="Group name heading level"
        value={String(c.headingLevel || 2)}
        onChange={(headingLevel) => set({ headingLevel: Number(headingLevel) })}
        options={[2, 3, 4].map((level) => ({ value: String(level), label: `H${level}` }))}
        testId="select-member-group-heading-level"
      />
      <NumberField label="Rows per page" min={1} max={6} value={c.rows ?? 2} onChange={(rows) => set({ rows })} testId="input-member-group-rows" />
      <PerBreakpointColumns value={c.columns} onChange={(columns) => set({ columns })} />
      <NumberField label="Gap (px)" min={0} max={100} value={c.gap ?? 16} onChange={(gap) => set({ gap })} testId="input-member-group-gap" />
      <TextField label="Empty state text" value={c.emptyText} onChange={(emptyText) => set({ emptyText })} testId="input-member-group-empty" />
    </>
  );
}

// ============================================================================
// MEMBER GROUP CARDS
// ============================================================================
// This distinct block lists eligible groups. It deliberately shares both the
// live data state and card component with /MemberGroups so the portal and a
// Canvas page cannot drift in viewer indicators or activation behavior.
function MemberGroupCardsRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  const source = resolveMemberGroupCardSource(c.source);
  const selectedGroupIds = resolveSelectedMemberGroupIds(c.selectedGroupIds);
  const selectedGroupRoles = resolveSelectedMemberGroupRoles(
    c.selectedGroupRoles,
    selectedGroupIds,
  );
  const manualMode = source === MEMBER_GROUP_CARD_SOURCE.SELECTED;
  const data = useMemberGroupCardsData({ source, selectedGroupIds });
  const limit = resolveMemberGroupCardLimit(c.limit);
  const groups = useMemo(
    () => (manualMode
      ? selectSelectedMemberGroups(data.groups, selectedGroupIds)
      : selectSelfJoinMemberGroups(data.groups, limit)),
    [data.groups, limit, manualMode, selectedGroupIds],
  );
  const roleHolderByGroup = useMemberGroupRoleHolders({
    groups,
    selectedGroupRoles,
    enabled: manualMode,
  });

  return (
    <MemberGroupCardsBlockView
      block={block}
      groups={groups}
      isAuthenticated={data.isAuthenticated}
      assignmentByGroup={data.assignmentByGroup}
      openVacancyCountByGroup={data.openVacancyCountByGroup}
      groupAdminIds={data.groupAdminIds}
      isLoading={data.isLoading}
      isError={!!data.dataError}
      errorMessage={String(data.dataError?.message || '')}
      accessRestricted={data.accessRestricted}
      asEditor={asEditor}
      breakpoint={breakpoint}
      manualMode={manualMode}
      selectedGroupCount={selectedGroupIds.length}
      roleHolderByGroup={roleHolderByGroup}
    />
  );
}

function MemberGroupCardsInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((current) => ({
    ...current,
    content: { ...current.content, ...patch },
  }));

  const source = resolveMemberGroupCardSource(c.source);
  const manualMode = source === MEMBER_GROUP_CARD_SOURCE.SELECTED;
  const selectedGroupIds = resolveSelectedMemberGroupIds(c.selectedGroupIds);
  const selectedGroupRoles = resolveSelectedMemberGroupRoles(
    c.selectedGroupRoles,
    selectedGroupIds,
  );
  const {
    data: groups = [],
    isLoading,
    isError,
    error,
  } = useCanvasMemberGroups({ enabled: manualMode });
  const [search, setSearch] = useState('');
  const groupById = useMemo(
    () => new Map(groups.map((group) => [String(group.id), group])),
    [groups],
  );
  const groupKind = (group) => (
    group.allow_self_join
      ? 'Self-join'
      : group.automatic_membership_enabled
        ? 'Automatic membership'
        : 'Managed membership'
  );
  const normalizedSearch = search.trim().toLowerCase();
  const matchingGroups = groups.filter((group) => (
    !selectedGroupIds.includes(String(group.id))
    && (
      !normalizedSearch
      || String(group.name || '').toLowerCase().includes(normalizedSearch)
      || groupKind(group).toLowerCase().includes(normalizedSearch)
    )
  )).slice(0, 12);
  const setSelectedGroupIds = (ids) => set({
    selectedGroupIds: resolveSelectedMemberGroupIds(ids),
    selectedGroupRoles: resolveSelectedMemberGroupRoles(
      selectedGroupRoles,
      resolveSelectedMemberGroupIds(ids),
    ),
  });
  const setSelectedGroupRole = (groupId, role) => set({
    selectedGroupRoles: resolveSelectedMemberGroupRoles({
      ...selectedGroupRoles,
      [groupId]: role,
    }, selectedGroupIds),
  });
  const moveSelected = (index, direction) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= selectedGroupIds.length) return;
    const next = [...selectedGroupIds];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setSelectedGroupIds(next);
  };

  return (
    <>
      <SelectField
        label="Group source"
        value={source}
        onChange={(nextSource) => set({ source: resolveMemberGroupCardSource(nextSource) })}
        options={[
          { value: MEMBER_GROUP_CARD_SOURCE.SELF_JOIN, label: 'Active self-join groups' },
          { value: MEMBER_GROUP_CARD_SOURCE.SELECTED, label: 'Selected active groups' },
        ]}
        testId="select-member-group-cards-source"
      />
      <PerBreakpointColumns
        value={resolveMemberGroupCardColumns(c.columns)}
        onChange={(columns) => set({ columns })}
      />
      {!manualMode ? (
        <NumberField
          label="Number of cards"
          hint="Shows active groups open for self-join, in alphabetical order."
          min={1}
          max={24}
          value={c.limit ?? 6}
          onChange={(limit) => set({ limit })}
          testId="input-member-group-cards-limit"
        />
      ) : (
        <div className="space-y-3" data-testid="member-group-cards-picker">
          <Field
            label="Find active member groups"
            hint={isLoading
              ? 'Loading active member groups…'
              : isError
                ? 'Active member groups could not be loaded.'
              : selectedGroupIds.length >= 24
                ? 'You can select up to 24 groups.'
                : 'Search by group name or membership type.'}
          >
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search groups"
              className="h-8"
              data-testid="input-member-group-cards-search"
            />
          </Field>
          {isError ? (
            <p className="text-xs text-rose-600" role="alert" data-testid="member-group-cards-picker-error">
              {String(error?.message || "Couldn't load active member groups right now.")}
            </p>
          ) : !isLoading && matchingGroups.length > 0 ? (
            <div className="max-h-48 overflow-y-auto rounded-md border border-slate-200" data-testid="member-group-cards-search-results">
              {matchingGroups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-2 py-2 text-left text-xs last:border-b-0 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => setSelectedGroupIds([...selectedGroupIds, group.id])}
                  disabled={selectedGroupIds.length >= 24}
                  data-testid={`button-add-member-group-card-${group.id}`}
                >
                  <span className="truncate font-medium text-slate-700">{group.name || 'Unnamed group'}</span>
                  <span className="shrink-0 text-slate-500">{groupKind(group)}</span>
                </button>
              ))}
            </div>
          ) : !isLoading && (
            <p className="text-xs text-slate-500" data-testid="member-group-cards-no-search-results">
              {groups.length === 0 ? 'No active member groups are available.' : 'No matching available groups.'}
            </p>
          )}
          <Field
            label="Selected groups"
            hint={isLoading
              ? 'Checking the saved selections…'
              : isError
                ? 'Saved selections could not be checked.'
              : selectedGroupIds.length === 0
              ? 'No groups selected yet.'
              : 'Groups display in this order. Inactive or deleted selections are not published.'}
          >
            <div className="flex flex-col gap-1.5" data-testid="member-group-cards-selected">
              {!isLoading && !isError && selectedGroupIds.map((id, index) => {
                const group = groupById.get(id);
                const unavailable = !group;
                const label = group?.name || 'Unavailable selection';
                const groupRoles = [...new Set(
                  (Array.isArray(group?.roles) ? group.roles : [])
                    .map((role) => String(role || '').trim())
                    .filter(Boolean),
                )];
                const configuredRole = selectedGroupRoles[id] || '';
                const staleRole = !!configuredRole && !groupRoles.includes(configuredRole);
                const noRoleValue = '__canvas_no_group_role__';
                const roleOptions = [
                  { value: noRoleValue, label: 'Do not show a role' },
                  ...groupRoles.map((role) => ({ value: role, label: role })),
                ];
                if (staleRole) {
                  roleOptions.push({
                    value: configuredRole,
                    label: `${configuredRole} (unavailable)`,
                  });
                }
                return (
                  <div
                    key={id}
                    className={`rounded-md border px-2 py-1 ${
                      unavailable
                        ? 'border-amber-200 bg-amber-50 text-amber-800'
                        : 'border-slate-200 text-slate-700'
                    }`}
                    data-testid={unavailable ? `member-group-card-unavailable-${id}` : `member-group-card-selected-${id}`}
                  >
                    <div className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {label}
                        {group ? <span className="text-slate-400"> ({groupKind(group)})</span> : null}
                      </span>
                      <Button size="icon" variant="ghost" disabled={index === 0} onClick={() => moveSelected(index, -1)} aria-label={`Move ${label} up`} data-testid={`button-member-group-card-up-${id}`}>
                        <ChevronUp className="w-3 h-3" />
                      </Button>
                      <Button size="icon" variant="ghost" disabled={index === selectedGroupIds.length - 1} onClick={() => moveSelected(index, 1)} aria-label={`Move ${label} down`} data-testid={`button-member-group-card-down-${id}`}>
                        <ChevronDown className="w-3 h-3" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSelectedGroupIds(selectedGroupIds.filter((selectedId) => selectedId !== id))} data-testid={`button-remove-member-group-card-${id}`}>
                        Remove
                      </Button>
                    </div>
                    <div className="mt-1.5">
                      <SelectField
                        label="Role to show"
                        value={configuredRole || noRoleValue}
                        onChange={(role) => setSelectedGroupRole(
                          id,
                          role === noRoleValue ? '' : role,
                        )}
                        options={roleOptions}
                        disabled={unavailable || groupRoles.length === 0}
                        hint={!unavailable && groupRoles.length === 0
                          ? 'This group has no configured roles.'
                          : 'Optional. Current directory-visible holders appear on this Canvas card.'}
                        warning={staleRole
                          ? `The saved role “${configuredRole}” is no longer configured for this group.`
                          : undefined}
                        testId={`select-member-group-card-role-${id}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </Field>
        </div>
      )}
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
                  <div className="text-sm text-slate-600 m-0 [&_p]:m-0" dangerouslySetInnerHTML={{ __html: cardDescriptionToHtml(card.description) }} />
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
  const displayMode = c.displayMode === 'cover' ? 'cover' : 'grid';
  const cols = columnsForBreakpoint(c, breakpoint);
  const pageSize = Math.max(1, Math.min(48, c.pageSize || 12));
  const [page, setPage] = useState(1);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [popupOpen, setPopupOpen] = useState(false);

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

  const headingEl = (c.heading || data.title)
    ? <Heading level={c.headingLevel || 2}>{c.heading || data.title}</Heading>
    : null;

  // Grid + pagination markup, shared by grid mode (rendered inline) and cover
  // mode (rendered inside the popup dialog). Photo clicks open the Lightbox.
  const photoGrid = (
    <>
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
    </>
  );

  const lightboxEl = !asEditor && lightboxIndex !== null ? (
    <Lightbox
      gallery={{ title: c.heading || data.title, photos }}
      activeIndex={lightboxIndex}
      onIndexChange={setLightboxIndex}
      onClose={() => setLightboxIndex(null)}
      srOptimised={false}
    />
  ) : null;

  // Cover-image-only mode: show just the gallery's cover photo as a clickable
  // affordance that opens the full paginated grid in a popup dialog.
  if (displayMode === 'cover') {
    const cover = data.cover_photo || photos[0] || null;
    const { alt: coverAlt, role: coverRole } = resolveAlt(cover, data.title, false);
    const countLabel = `${total} photo${total === 1 ? '' : 's'}`;
    const popupTitle = c.heading || data.title || 'Photo gallery';
    return (
      <div
        className="w-full h-full flex flex-col gap-3"
        aria-label={block.a11y?.ariaLabel || c.heading || data.title || 'Photo gallery'}
      >
        {headingEl}
        <button
          type="button"
          className="relative block w-full flex-1 min-h-[160px] bg-slate-100 rounded-md overflow-hidden hover-elevate active-elevate-2 group text-left"
          onClick={() => { if (asEditor) return; setPopupOpen(true); }}
          aria-label={`Open ${popupTitle} — ${countLabel}`}
          aria-haspopup="dialog"
          data-testid="button-gallery-cover"
        >
          {cover ? (
            <GalleryImage photo={cover} className="w-full h-full object-cover" alt={coverAlt} role={coverRole} />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Images className="w-10 h-10 text-slate-300" aria-hidden="true" />
            </div>
          )}
          <span className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-8 text-sm font-medium text-white">
            <Images className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>View gallery — {countLabel}</span>
          </span>
        </button>

        <Dialog open={popupOpen} onOpenChange={setPopupOpen}>
          <DialogContent
            className="max-w-[95vw] w-[95vw] sm:max-w-5xl max-h-[90vh] overflow-y-auto"
            data-testid="dialog-gallery-cover-popup"
          >
            <DialogHeader>
              <DialogTitle data-testid="text-gallery-popup-title">{popupTitle}</DialogTitle>
              <DialogDescription className="sr-only">{countLabel}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {photoGrid}
            </div>
          </DialogContent>
        </Dialog>

        {lightboxEl}
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col gap-4 overflow-auto" aria-label={block.a11y?.ariaLabel || c.heading || data.title || 'Photo gallery'}>
      {headingEl}
      {photoGrid}
      {lightboxEl}
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
      <SelectField
        label="Display mode"
        value={c.displayMode === 'cover' ? 'cover' : 'grid'}
        onChange={(v) => set({ displayMode: v })}
        options={[
          { value: 'grid', label: 'Grid (all photos)' },
          { value: 'cover', label: 'Cover image only' },
        ]}
        testId="select-gallery-display-mode"
      />
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
// LOGIN FORM block
// ============================================================================
function LoginFormEditorPreview() {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center p-4 bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      <div className="w-full max-w-sm bg-white rounded-lg border border-slate-200 shadow-lg p-6 space-y-4">
        <div className="text-center space-y-1">
          <div className="text-lg font-bold text-slate-900">Member Access</div>
          <div className="text-xs text-slate-500">Enter your email and password to sign in</div>
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-700">Email</div>
            <div className="h-9 rounded-md border border-slate-200 bg-slate-50 flex items-center px-3 gap-2">
              <div className="w-3.5 h-3.5 bg-slate-300 rounded-sm shrink-0" />
              <div className="h-2.5 bg-slate-200 rounded w-2/3" />
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-700">Password</div>
            <div className="h-9 rounded-md border border-slate-200 bg-slate-50 flex items-center px-3 gap-2">
              <div className="w-3.5 h-3.5 bg-slate-300 rounded-sm shrink-0" />
              <div className="h-2.5 bg-slate-200 rounded w-1/2" />
            </div>
          </div>
          <div className="h-9 bg-slate-800 rounded-md flex items-center justify-center">
            <div className="h-2.5 bg-slate-600 rounded w-1/3" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-px flex-1 bg-slate-200" />
          <div className="text-[10px] text-slate-400 uppercase tracking-wide">or continue with</div>
          <div className="h-px flex-1 bg-slate-200" />
        </div>
        <div className="h-9 rounded-md border border-slate-200 flex items-center justify-center gap-2">
          <div className="w-3.5 h-3.5 bg-slate-300 rounded-sm" />
          <div className="h-2.5 bg-slate-200 rounded w-1/3" />
        </div>
        <div className="flex justify-center">
          <div className="h-2 bg-blue-200 rounded w-1/4" />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-500 bg-white/80 rounded-full px-3 py-1 border border-slate-200">
        <Lock className="w-3 h-3 text-slate-400" />
        <span>Login form — fully functional on the live page</span>
      </div>
    </div>
  );
}

function LoginFormInspector() {
  return (
    <div className="space-y-3 p-3">
      <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-xs text-blue-700 space-y-1">
        <p className="font-medium">Login Form block</p>
        <p>This block renders the tenant's standard sign-in, set-password, and forgot-password forms. It is fixed in size; use the position controls to place it on your page.</p>
      </div>
    </div>
  );
}

// Renderer lazily imports LoginForm so the heavy auth component is only
// bundled on pages that actually use the login-form block.
const LoginFormComponent = lazy(() => import('@/components/auth/LoginForm'));

function LoginFormRendererLazy() {
  return (
    <div className="w-full h-full flex items-center justify-center p-4 bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      <Suspense fallback={<div className="w-full max-w-sm h-64 bg-white rounded-lg border border-slate-200 animate-pulse" />}>
        <LoginFormComponent className="w-full max-w-sm" />
      </Suspense>
    </div>
  );
}

// ============================================================================
// Search Input block (Task #2550)
// ============================================================================
// A styled public-search field that reuses /api/public/search. Submitting
// navigates to /search?q=…; a live results popover shows matches as the user
// types. Renders identically in the editor preview (`asEditor`, interactions
// disabled) and on the published page. On microsite pages the inspector adds an
// "Include results from outside this microsite" toggle; the render maps that to
// the endpoint's microsite scope.
const SEARCH_INPUT_SIZES = {
  sm: { height: 36, fontSize: 14, padX: 12, icon: 16 },
  md: { height: 44, fontSize: 16, padX: 14, icon: 18 },
  lg: { height: 52, fontSize: 18, padX: 16, icon: 20 },
};

function SearchInputRender({ block, asEditor }) {
  const c = block?.content || {};
  const navigate = useNavigate();
  const { micrositePrefix } = useMicrosite();
  // Search-results branding, resolved the same way the full /search page does:
  // microsite branding on a microsite route, tenant branding otherwise.
  const { branding: chromeBranding } = usePublicChromeBranding() || {};
  const { font: searchResultsFont, typeLabelColor: searchTypeLabelColor } =
    resolveSearchResultsBranding(chromeBranding?.brandingConfig);
  const articleDisplayName = useArticleDisplayName();
  const size = SEARCH_INPUT_SIZES[c.size] || SEARCH_INPUT_SIZES.md;
  const showIcon = c.showIcon !== false;
  const placeholder = c.placeholder || 'Search…';

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Microsite scope only matters on an actual microsite route. Toggle OFF
  // (includeOutsideMicrosite === false) limits results to this microsite;
  // otherwise search the whole tenant (still resolving this microsite's own
  // pages to their prefixed URLs).
  const onMicrosite = !asEditor && !!micrositePrefix;
  const micrositeScope = onMicrosite
    ? (c.includeOutsideMicrosite === false ? 'only' : 'all')
    : null;

  const { data, isFetching } = useQuery({
    queryKey: ['canvas', 'search-input', debounced, micrositePrefix || '', micrositeScope || ''],
    queryFn: () => publicClient.search(debounced, {
      micrositePrefix: onMicrosite ? micrositePrefix : null,
      micrositeScope,
    }),
    enabled: !asEditor && debounced.length >= 2,
    staleTime: 30_000,
  });
  const results = Array.isArray(data?.results) ? data.results : [];

  useEffect(() => {
    if (asEditor) return undefined;
    const onDocMouseDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [asEditor]);

  const goToSearch = (term) => {
    const q = (term ?? query).trim();
    if (!q) return;
    setOpen(false);
    const params = new URLSearchParams({ q });
    // On a microsite, navigate to the prefixed /{prefix}/search path so the
    // results page mounts under the microsite's chrome (matching the header
    // search dropdown). Carry the scope through as a query param so the
    // "Include results from outside this microsite" toggle still controls the
    // full results, not just the live popover.
    if (onMicrosite && micrositePrefix) {
      params.set('micrositeScope', micrositeScope);
      navigate(`/${micrositePrefix}/search?${params.toString()}`);
      return;
    }
    navigate(`/search?${params.toString()}`);
  };

  const goToResult = (url) => {
    if (!url) return;
    setOpen(false);
    navigate(url);
  };

  const borderWidth = Number.isFinite(c.borderWidth) ? c.borderWidth : 1;
  // Single source of truth for the corner radius: the block-level
  // `style.borderRadius` (the standard "Border radius" style control), which
  // also rounds the block wrapper in CanvasStage. `c.cornerRadius` is kept only
  // as a read-only fallback for legacy blocks saved before this was
  // consolidated. The browser naturally caps the visible radius to half the
  // input's height, so a high value renders a clean pill without a manual clamp.
  const appliedRadius = Number.isFinite(block?.style?.borderRadius)
    ? block.style.borderRadius
    : (Number.isFinite(c.cornerRadius) ? c.cornerRadius : 8);
  const inputStyle = {
    width: '100%',
    height: size.height,
    maxHeight: '100%',
    fontSize: size.fontSize,
    fontFamily: searchResultsFont || 'inherit',
    paddingLeft: size.padX,
    paddingRight: showIcon ? size.height : size.padX,
    color: c.textColor || '#0f172a',
    background: c.backgroundColor || '#ffffff',
    borderColor: c.borderColor || '#cbd5e1',
    borderWidth,
    borderStyle: 'solid',
    borderRadius: appliedRadius,
    outline: 'none',
    boxSizing: 'border-box',
  };

  const showPopover = !asEditor && open && debounced.length >= 2;

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center"
      style={{ position: 'relative' }}
    >
      <div style={{ position: 'relative', width: '100%' }}>
        <input
          type="search"
          value={query}
          placeholder={placeholder}
          readOnly={asEditor}
          aria-label={block?.a11y?.ariaLabel || placeholder}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { if (!asEditor && debounced.length >= 2) setOpen(true); }}
          onKeyDown={(e) => {
            if (asEditor) return;
            if (e.key === 'Enter') { e.preventDefault(); goToSearch(); }
            if (e.key === 'Escape') setOpen(false);
          }}
          style={inputStyle}
          data-testid="input-canvas-search"
        />
        {showIcon && (
          <button
            type="button"
            aria-label="Search"
            tabIndex={asEditor ? -1 : 0}
            onClick={() => { if (!asEditor) goToSearch(); }}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              height: '100%',
              width: size.height,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              cursor: asEditor ? 'default' : 'pointer',
              color: c.textColor || '#0f172a',
              opacity: 0.7,
            }}
            data-testid="button-canvas-search"
          >
            {isFetching
              ? <Loader2 style={{ width: size.icon, height: size.icon }} className="animate-spin" aria-hidden="true" />
              : <Search style={{ width: size.icon, height: size.icon }} aria-hidden="true" />}
          </button>
        )}
        {showPopover && (
          <div
            role="listbox"
            className="absolute left-0 right-0 z-50 mt-1 max-h-80 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg"
            style={{ top: '100%', ...(searchResultsFont ? { fontFamily: searchResultsFont } : {}) }}
            data-testid="popover-canvas-search-results"
          >
            {results.length === 0 ? (
              <div className="px-3 py-3 text-sm text-slate-500" data-testid="text-canvas-search-empty">
                {isFetching ? 'Searching…' : 'No results found.'}
              </div>
            ) : (
              <>
                {results.map((r, i) => {
                  const TypeIcon = getSearchResultTypeIcon(r.type);
                  return (
                    <button
                      key={`${r.type || 'result'}-${r.id || i}`}
                      type="button"
                      onClick={() => goToResult(r.url)}
                      className="w-full px-4 py-3 flex items-start gap-3 hover:bg-slate-50 transition-colors text-left border-b border-slate-50 last:border-0"
                      data-testid={`link-canvas-search-result-${i}`}
                    >
                      <div className="flex-shrink-0 w-8 h-8 bg-slate-100 rounded flex items-center justify-center">
                        <TypeIcon className="w-4 h-4 text-slate-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        {r.type && (
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs font-medium uppercase${searchTypeLabelColor ? '' : ' text-purple-600'}`}
                              style={searchTypeLabelColor ? { color: searchTypeLabelColor } : undefined}
                            >
                              {getSearchResultTypeLabel(r.type, articleDisplayName)}
                            </span>
                          </div>
                        )}
                        <p className="font-medium text-slate-900 truncate">{r.title || 'Untitled'}</p>
                        {r.description && (
                          <p className="text-sm text-slate-500 line-clamp-1">{r.description}</p>
                        )}
                      </div>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => goToSearch()}
                  className={`w-full px-4 py-3 text-center text-sm font-medium hover:bg-slate-50 transition-colors${searchTypeLabelColor ? '' : ' text-purple-600'}`}
                  style={searchTypeLabelColor ? { color: searchTypeLabelColor } : undefined}
                  data-testid="button-canvas-view-all-results"
                >
                  View all results
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SearchInputInspector({ block, update }) {
  const c = block.content || {};
  const { isMicrositePage } = useCanvasEditorPage();
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <TextField
        label="Placeholder text"
        value={c.placeholder}
        onChange={(v) => set({ placeholder: v })}
        testId="input-search-placeholder"
      />
      <SelectField
        label="Size"
        value={c.size || 'md'}
        onChange={(v) => set({ size: v })}
        options={[
          { value: 'sm', label: 'Small' },
          { value: 'md', label: 'Medium' },
          { value: 'lg', label: 'Large' },
        ]}
        testId="select-search-size"
      />
      <ColorField
        label="Background colour"
        value={c.backgroundColor}
        onChange={(v) => set({ backgroundColor: v })}
        testId="color-search-bg"
      />
      <ColorField
        label="Text colour"
        value={c.textColor}
        onChange={(v) => set({ textColor: v })}
        testId="color-search-text"
      />
      <ColorField
        label="Border colour"
        value={c.borderColor}
        onChange={(v) => set({ borderColor: v })}
        testId="color-search-border"
      />
      <NumberField
        label="Border width (px)"
        value={c.borderWidth}
        min={0}
        max={8}
        onChange={(v) => set({ borderWidth: v == null ? 0 : v })}
        testId="input-search-border-width"
      />
      <ToggleField
        label="Show search icon"
        value={c.showIcon !== false}
        onChange={(v) => set({ showIcon: v })}
        testId="toggle-search-icon"
      />
      {isMicrositePage && (
        <ToggleField
          label="Include results from outside this microsite"
          value={c.includeOutsideMicrosite !== false}
          onChange={(v) => set({ includeOutsideMicrosite: v })}
          testId="toggle-search-include-outside"
          hint="On: search the whole site. Off: show only results from this microsite."
        />
      )}
    </>
  );
}

// ============================================================================
// Registry export
// ============================================================================
// ---------------------------------------------------------------------------
// Featured job — exact mirror of the iEdit "Featured Job" element. The block
// renders the same IEditFeaturedJobElement component (same data source,
// layouts, typography and responsive CSS) and reuses its editor panel as the
// inspector, so the two builders share one implementation and cannot drift.
// ---------------------------------------------------------------------------
function FeaturedJobRender({ block, asEditor }) {
  const c = block.content || {};
  // The element scopes its responsive <style> rules with an id derived from
  // `content.anchor` (falling back to a shared 'default'). Two blocks on one
  // page without anchors would collide, so we scope by block id when no
  // anchor is set. The user-set anchor still wins, exactly like iEdit.
  const scopedAnchor = c.anchor || `fj-${String(block.id || 'block').replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const content = { ...c, anchor: scopedAnchor };
  const body = <IEditFeaturedJobElement content={content} settings={{ fullWidth: true }} />;
  if (asEditor) {
    // In the builder, swallow clicks so the element's internal links (job
    // card, View All Jobs button) don't navigate away from the editor.
    return (
      <div
        onClickCapture={(e) => { e.preventDefault(); e.stopPropagation(); }}
        data-testid="featured-job-editor-preview"
      >
        {body}
      </div>
    );
  }
  return body;
}

function FeaturedJobInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  return (
    <>
      {/* Canvas-specific control: full-bleed pushes the element's gradient /
          split backgrounds to the viewport edges while the inner content rail
          stays centered. Routed through the shared snapshot-on-release helper
          so it can't drift from the Position panel's Full-bleed toggle. */}
      <ToggleField
        label="Full-bleed (span full screen width)"
        value={!!c.fullBleed}
        onChange={(v) => update((b) => setBlockContentFullBleed(b, breakpoint || 'desktop', !!v))}
        testId="toggle-featured-job-full-bleed"
      />
      <IEditFeaturedJobElementEditor
        element={{ content: c }}
        onChange={(el) =>
          update((b) => ({
            ...b,
            // Preserve canvas-only keys (fullBleed) that the iEdit editor
            // doesn't know about and would otherwise drop.
            content: { ...(el?.content || {}), fullBleed: !!(b.content && b.content.fullBleed) },
          }))
        }
      />
    </>
  );
}

export const DYNAMIC_BLOCK_DEFINITIONS = {
  [BLOCK_TYPES.AI_COMPOSITION]: {
    label: 'AI Composition (legacy)',
    icon: Sparkles,
    category: 'data',
    Editor: (props) => <AiCompositionRender {...props} asEditor />,
    Renderer: AiCompositionRender,
    Inspector: AiCompositionInspector,
    // V2 (native code) is the only insertable AI block now; existing V1
    // blocks keep rendering/editing but no new ones can be added.
    paletteHidden: true,
  },
  // AI Design Studio V2 (Task #2904): native HTML/CSS/SVG code packages.
  // autoHeight — the flowed document drives the block's footprint.
  // allowOverflow — the wrapper must never clip decorative bleed/shadows;
  // the document flows naturally and blocks below reflow beneath it.
  [BLOCK_TYPES.AI_CODE_COMPOSITION]: {
    label: 'AI Composition (V2)',
    icon: Sparkles,
    category: 'data',
    Editor: (props) => <AiCodeCompositionRender {...props} asEditor />,
    Renderer: AiCodeCompositionRender,
    Inspector: AiCodeCompositionInspector,
    autoHeight: true,
    allowOverflow: true,
  },
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
  [BLOCK_TYPES.RESOURCE_SHOWCASE]: {
    label: 'Resource showcase',
    icon: Folder,
    category: 'data',
    Editor: (props) => <ResourceShowcaseRender {...props} asEditor />,
    Renderer: ResourceShowcaseRender,
    Inspector: ResourceShowcaseInspector,
  },
  [BLOCK_TYPES.FEATURED_JOB]: {
    label: 'Featured job',
    icon: Briefcase,
    category: 'data',
    Editor: (props) => <FeaturedJobRender {...props} asEditor />,
    Renderer: FeaturedJobRender,
    Inspector: FeaturedJobInspector,
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
    allowOverflow: true,
  },
  [BLOCK_TYPES.DYNAMIC_DIRECTORY_EMBED]: {
    label: 'Dynamic directory',
    icon: Building2,
    category: 'data',
    Editor: (props) => <DynamicDirectoryEmbedRender {...props} asEditor />,
    Renderer: DynamicDirectoryEmbedRender,
    Inspector: DynamicDirectoryEmbedInspector,
    allowOverflow: true,
  },
  [BLOCK_TYPES.MEMBER_GROUP]: {
    label: 'Member Group',
    icon: Users,
    category: 'data',
    Editor: (props) => <MemberGroupRender {...props} asEditor />,
    Renderer: MemberGroupRender,
    Inspector: MemberGroupInspector,
    allowOverflow: true,
  },
  [BLOCK_TYPES.MEMBER_GROUP_CARDS]: {
    label: 'Member Group Cards',
    icon: Users,
    category: 'data',
    Editor: (props) => <MemberGroupCardsRender {...props} asEditor />,
    Renderer: MemberGroupCardsRender,
    Inspector: MemberGroupCardsInspector,
    allowOverflow: true,
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
  [BLOCK_TYPES.LOGIN_FORM]: {
    label: 'Login Form',
    icon: Lock,
    category: 'advanced',
    Editor: LoginFormEditorPreview,
    Renderer: LoginFormRendererLazy,
    Inspector: LoginFormInspector,
    noResize: true,
  },
  [BLOCK_TYPES.SEARCH_INPUT]: {
    label: 'Search Input',
    icon: Search,
    category: 'ui',
    Editor: (props) => <SearchInputRender {...props} asEditor />,
    Renderer: SearchInputRender,
    Inspector: SearchInputInspector,
    allowOverflow: true,
  },
};
