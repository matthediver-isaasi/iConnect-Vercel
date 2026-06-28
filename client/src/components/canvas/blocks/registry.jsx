import { Fragment, useMemo, useState, useEffect, useLayoutEffect, useRef, lazy, Suspense, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import {
  Square,
  LayoutPanelTop,
  Image as ImageIcon,
  Type,
  MousePointerClick,
  Film,
  Columns3,
  Minus,
  Rows3,
  HelpCircle,
  Quote,
  Code2,
  Star,
  LayoutGrid,
  Hash,
  Images,
  Map as MapIcon,
  ArrowRight,
  Bell, Award, Check, Heart, Mail, Phone, Globe, Calendar, Clock,
  Users, Building2, Briefcase, BookOpen, GraduationCap, Lightbulb,
  Shield, Zap, ChevronDown,
  ExternalLink, FileText, Video, Download, Music, MapPin,
  Link as LinkIcon,
  Component as ComponentIcon,
  RotateCcw,
  Grid2x2,
  ChevronLeft,
  ChevronRight,
  Table as TableIcon,
  MessageSquareQuote,
  Megaphone,
  Menu,
  X,
  Plus,
  ArrowUp,
  ArrowDown,
  Trash2,
  Unlink,
  Search,
  GalleryHorizontal,
  GripVertical,
  Copy,
} from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  BLOCK_TYPES,
  buildResponsiveImage,
  resolveResponsiveValue,
  hasResponsiveOverride,
  hasAnyResponsiveValue,
  writeResponsiveValue,
  BREAKPOINT_MAX_PX,
  resolveBlockAtBreakpoint,
  normalizeCanvasDesign,
  getRootChildren,
} from '@/lib/canvasDesign';
import ImageSelector from '@/components/ImageSelector';
import { FocalPointPicker, getFocalPointStyle } from '@/components/FocalPointPicker';
import { sanitizeRichText, stripTrailingEmptyParagraphs, sanitizeCustomHtml } from './sanitize';
import { DYNAMIC_BLOCK_DEFINITIONS } from './dynamicBlocks';
import { publicClient } from '@/api/publicClient';
import { useTenantBranding } from '@/contexts/TenantBrandingContext';
import {
  TENANT_BUTTON_DEFAULT_SIZE,
  bgCssFromConfig,
  resolveTenantButtonStyle,
  isTenantButtonVariant,
} from '@/lib/tenantButtonStyle';
import { useCanvasAnchors } from '../CanvasAnchorContext';
import { useCanvasSymbols } from '../CanvasSymbolsContext';
import { useAccordionReflow } from '../AccordionReflowContext';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import {
  hexToRgba,
  buildHeroOverlayBackground,
  buildSectionOverlayBackground,
  buildSectionGradientBackground,
  getUsableStops,
  buildGradientStopList,
  deriveSectionGradientStops,
} from '@/lib/canvasBackground';

// Lazy-load the rich text editor — it's heavy (tiptap) and not needed for blocks
// that don't use it.
const RichTextEditor = lazy(() => import('@/components/email-builder/RichTextEditor'));
const FontAwesomeIconPicker = lazy(() => import('@/components/canvas/FontAwesomeIconPicker'));

export const LUCIDE_ICONS = {
  Star, Bell, Award, Check, Heart, Mail, Phone, Globe, Calendar, Clock,
  Users, Building2, Briefcase, BookOpen, GraduationCap, Lightbulb,
  Shield, Zap, ArrowRight, ChevronDown, Square, Type, ImageIcon,
  HelpCircle, Quote, Hash, MapIcon,
};

export function getLucideIcon(name) {
  return LUCIDE_ICONS[name] || null;
}

// ---------------------------------------------------------------------------
// Small inspector primitives reused across block content tabs
// ---------------------------------------------------------------------------

function Field({ label, children, testId }) {
  return (
    <div className="space-y-1" data-testid={testId}>
      <Label className="text-xs text-slate-600">{label}</Label>
      {children}
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, testId, multiline }) {
  if (multiline) {
    return (
      <Field label={label}>
        <Textarea
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="text-sm"
          data-testid={testId}
        />
      </Field>
    );
  }
  return (
    <Field label={label}>
      <Input
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8"
        data-testid={testId}
      />
    </Field>
  );
}

// Task #1446: link editor with an in-page anchor picker. Behaves like the
// plain TextField (free-text URLs still work) but adds a dropdown that lists
// the page's anchors and fills in a `#anchor-id` value when one is picked.
// The available-anchors list comes from CanvasAnchorContext so every link
// field across the registry shares one source of truth.
export function LinkField({ label, value, onChange, placeholder, testId }) {
  const { anchors, pages } = useCanvasAnchors();
  const usableAnchors = (anchors || []).filter((a) => a.anchorId);
  // Task #1448: other canvas pages that expose anchors. Picking one of these
  // emits a cross-page `/page-slug#anchor-id` href instead of a bare `#id`.
  const otherPages = (pages || []).filter((p) => p.slug && p.anchors?.length > 0);
  const hasAnyAnchor = usableAnchors.length > 0 || otherPages.length > 0;
  return (
    <Field label={label}>
      <div className="flex items-center gap-1">
        <Input
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder || 'https://… or #section'}
          className="h-8 flex-1"
          data-testid={testId}
        />
        {hasAnyAnchor && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                type="button"
                title="Link to a section on this or another page"
                data-testid={testId ? `${testId}-anchor-picker` : 'link-anchor-picker'}
              >
                <Hash className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              {usableAnchors.length > 0 && (
                <>
                  <DropdownMenuLabel>This page</DropdownMenuLabel>
                  {usableAnchors.map((a) => (
                    <DropdownMenuItem
                      key={a.blockId}
                      onSelect={() => onChange(`#${a.anchorId}`)}
                      data-testid={`anchor-option-${a.anchorId}`}
                    >
                      <div className="flex flex-col">
                        <span className="font-mono text-xs">#{a.anchorId}</span>
                        <span className="text-[10px] text-slate-500">{a.blockName}</span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {otherPages.map((p, pageIdx) => (
                <Fragment key={p.id || p.slug}>
                  {(usableAnchors.length > 0 || pageIdx > 0) && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="truncate">{p.title}</DropdownMenuLabel>
                  {p.anchors.map((a) => (
                    <DropdownMenuItem
                      key={`${p.slug}-${a.blockId}`}
                      onSelect={() => onChange(`/${p.slug}#${a.anchorId}`)}
                      data-testid={`anchor-option-${p.slug}-${a.anchorId}`}
                    >
                      <div className="flex flex-col">
                        <span className="font-mono text-xs">/{p.slug}#{a.anchorId}</span>
                        <span className="text-[10px] text-slate-500">{a.blockName}</span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </Field>
  );
}

function NumberField({ label, value, onChange, min, max, step = 1, testId }) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? null : Number(raw));
        }}
        className="h-8"
        data-testid={testId}
      />
    </Field>
  );
}

// Task #970: per-device numeric field. Mirrors the helper in dynamicBlocks.jsx
// (kept duplicated so each file stays self-contained, matching the existing
// pattern for primitives). See `resolveResponsiveValue` / `writeResponsiveValue`
// in canvasDesign.js for the storage contract.
function ResponsiveNumberField({ label, value, onChange, breakpoint, min, max, step = 1, testId, placeholder }) {
  const bp = breakpoint || 'desktop';
  const ownVal = hasResponsiveOverride(value, bp)
    ? (typeof value === 'number' ? value : value[bp])
    : null;
  const inherited = bp === 'desktop'
    ? null
    : resolveResponsiveValue(value, bp === 'mobile' ? 'tablet' : 'desktop');
  const ph = bp !== 'desktop' && Number.isFinite(inherited)
    ? `${inherited} (inherit)`
    : (bp !== 'desktop' ? 'inherit' : (placeholder || ''));
  return (
    <Field label={`${label}${bp !== 'desktop' ? ` (${bp})` : ''}`}>
      <Input
        type="number"
        value={Number.isFinite(ownVal) ? ownVal : ''}
        min={min}
        max={max}
        step={step}
        placeholder={ph}
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
        <SelectTrigger className="h-8" data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
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
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs text-slate-600">{label}</Label>
      <Switch checked={!!value} onCheckedChange={onChange} data-testid={testId} />
    </div>
  );
}

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
          className="h-8 flex-1 font-mono text-xs"
        />
      </div>
    </Field>
  );
}

export function ImageField({ label, value, alt, onChangeSrc, onChangeAlt, testId }) {
  // The "Media library" button asks the editor shell to open the shared
  // MediaLibraryDialog. The shell wires up a window event listener that
  // sets a callback so the picked asset flows back here. This keeps
  // block inspectors decoupled from the dialog implementation.
  const openLibrary = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('canvas:open-media-library', {
      detail: {
        onPick: (asset) => {
          if (asset?.url) onChangeSrc(asset.url);
          if (onChangeAlt && asset?.alt_text) onChangeAlt(asset.alt_text);
        },
      },
    }));
  };
  return (
    <div className="space-y-2">
      <Label className="text-xs text-slate-600">{label}</Label>
      <ImageSelector value={value} onChange={onChangeSrc} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={openLibrary}
        className="w-full"
        data-testid={`${testId}-open-library`}
      >
        <Images className="w-4 h-4 mr-2" />
        Choose from media library
      </Button>
      {onChangeAlt && (
        <Input
          value={alt || ''}
          onChange={(e) => onChangeAlt(e.target.value)}
          placeholder="Alt text (required for accessibility)"
          className="h-8"
          data-testid={`${testId}-alt`}
        />
      )}
    </div>
  );
}

function RichTextField({ label, value, onChange, testId, breakpoint }) {
  // Sanitize on write so the stored design is always safe even if the
  // editor is bypassed or pasted content contains XSS payloads.
  const handleChange = (next) => onChange(sanitizeRichText(next || ''));
  // Task #1446: surface the page's anchors so in-line text links can target
  // a section. Passed through additively; RichTextEditor ignores it when empty.
  // Task #1448: also surface other canvas pages' anchors as cross-page
  // `/page-slug#anchor-id` options.
  const { anchors, pages } = useCanvasAnchors();
  const anchorOptions = [
    ...(anchors || [])
      .filter((a) => a.anchorId)
      .map((a) => ({ value: `#${a.anchorId}`, label: `#${a.anchorId}`, description: a.blockName })),
    ...(pages || [])
      .filter((p) => p.slug && p.anchors?.length > 0)
      .flatMap((p) => p.anchors.map((a) => ({
        value: `/${p.slug}#${a.anchorId}`,
        label: `/${p.slug}#${a.anchorId}`,
        description: `${p.title} — ${a.blockName}`,
      }))),
  ];
  return (
    <div className="space-y-1" data-testid={testId}>
      <Label className="text-xs text-slate-600">{label}</Label>
      <div className="border border-slate-200 rounded-md overflow-hidden">
        <Suspense fallback={<div className="p-3 text-xs text-slate-500">Loading editor…</div>}>
          <RichTextEditor content={value || ''} onChange={handleChange} breakpoint={breakpoint} anchorOptions={anchorOptions} />
        </Suspense>
      </div>
    </div>
  );
}

function ArrayList({ items, onChange, renderItem, makeNew, addLabel = 'Add item', testIdPrefix, duplicateItem, maxItems, collapsible = false, getItemTitle }) {
  const list = items || [];
  const count = list.length;
  const atMax = typeof maxItems === 'number' && count >= maxItems;

  // Per-item expand/collapse state (only used when `collapsible`). Existing
  // items start collapsed so the list is short and scannable; newly added or
  // duplicated items are inserted expanded so the admin can edit them at once.
  const [expanded, setExpanded] = useState(() => list.map(() => !collapsible));
  useEffect(() => {
    setExpanded((prev) => {
      if (prev.length === list.length) return prev;
      return list.map((_, i) => (i < prev.length ? prev[i] : !collapsible));
    });
  }, [list.length, collapsible]);

  const move = (idx, dir) => {
    const next = [...list];
    [next[idx + dir], next[idx]] = [next[idx], next[idx + dir]];
    setExpanded((prev) => {
      const e = [...prev];
      [e[idx + dir], e[idx]] = [e[idx], e[idx + dir]];
      return e;
    });
    onChange(next);
  };
  const duplicate = (idx) => {
    if (atMax) return;
    const next = [...list];
    next.splice(idx + 1, 0, duplicateItem(list[idx]));
    setExpanded((prev) => {
      const e = [...prev];
      e.splice(idx + 1, 0, true);
      return e;
    });
    onChange(next);
  };
  const removeAt = (idx) => {
    setExpanded((prev) => prev.filter((_, i) => i !== idx));
    onChange(list.filter((_, i) => i !== idx));
  };
  const addItem = () => {
    setExpanded((prev) => [...prev, true]);
    onChange([...list, makeNew()]);
  };
  const patchAt = (idx, patch) => {
    const next = [...list];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };

  const actionButtons = (idx) => (
    <>
      {idx > 0 && (
        <Button
          size="sm" variant="ghost" type="button"
          onClick={() => move(idx, -1)}
          data-testid={`${testIdPrefix}-up-${idx}`}
        >Up</Button>
      )}
      {idx < count - 1 && (
        <Button
          size="sm" variant="ghost" type="button"
          onClick={() => move(idx, 1)}
          data-testid={`${testIdPrefix}-down-${idx}`}
        >Down</Button>
      )}
      {duplicateItem && (
        <Button
          size="sm" variant="ghost" type="button"
          disabled={atMax}
          title={atMax ? 'Maximum reached' : undefined}
          onClick={() => duplicate(idx)}
          data-testid={`${testIdPrefix}-duplicate-${idx}`}
        >Duplicate</Button>
      )}
      <Button
        size="sm" variant="ghost" type="button"
        onClick={() => removeAt(idx)}
        data-testid={`${testIdPrefix}-remove-${idx}`}
      >Remove</Button>
    </>
  );

  return (
    <div className="space-y-2">
      {list.map((item, idx) => {
        if (collapsible) {
          const isOpen = expanded[idx] !== false;
          const title = (getItemTitle && getItemTitle(item, idx)) || `Item ${idx + 1}`;
          return (
            <div
              key={idx}
              className="rounded-md border border-slate-200 bg-slate-50"
              data-testid={`${testIdPrefix}-item-${idx}`}
            >
              <div className="flex items-center gap-1 p-2 flex-wrap">
                <Button
                  size="sm" variant="ghost" type="button"
                  className="flex-1 justify-start min-w-0 gap-1"
                  onClick={() => setExpanded((prev) => prev.map((v, i) => (i === idx ? !v : v)))}
                  data-testid={`${testIdPrefix}-toggle-${idx}`}
                >
                  {isOpen
                    ? <ChevronDown className="h-4 w-4 shrink-0" />
                    : <ChevronRight className="h-4 w-4 shrink-0" />}
                  <span className="truncate">{title}</span>
                </Button>
                <div className="flex items-center gap-1 shrink-0">
                  {actionButtons(idx)}
                </div>
              </div>
              {isOpen && (
                <div className="space-y-2 p-2 pt-0">
                  {renderItem(item, idx, (patch) => patchAt(idx, patch))}
                </div>
              )}
            </div>
          );
        }
        return (
          <div
            key={idx}
            className="space-y-2 p-2 rounded-md border border-slate-200 bg-slate-50"
            data-testid={`${testIdPrefix}-item-${idx}`}
          >
            {renderItem(item, idx, (patch) => patchAt(idx, patch))}
            <div className="flex items-center justify-end gap-1">
              {actionButtons(idx)}
            </div>
          </div>
        );
      })}
      <Button
        size="sm" variant="outline" type="button"
        disabled={atMax}
        onClick={addItem}
        data-testid={`${testIdPrefix}-add`}
      >
        {addLabel}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper functions used by block renderers
// ---------------------------------------------------------------------------

function textColorForRole(role) {
  if (role === 'secondary') return '#475569';
  if (role === 'tertiary') return '#64748b';
  return '#0f172a';
}

// ---------------------------------------------------------------------------
// Tenant typography styles (used by the Text block's "Render as" picker).
// Fetched from the public, host-resolved endpoint so the editor preview and
// the public renderer see the same data. Cached by TanStack Query so all
// Text inspectors/renderers on the page share a single network call.
// ---------------------------------------------------------------------------

async function fetchTenantTypographyStyles() {
  // Prefer the authenticated entity endpoint — it resolves the tenant
  // from the logged-in session and therefore works in every editor
  // context (Replit dev URLs, *.replit.dev preview hosts, the admin
  // subdomain, custom domains, etc.). This is the same source
  // /InstalledFonts and the legacy IEdit typography picker use, so the
  // canvas dropdown now stays in sync with the admin font config no
  // matter which host the editor is loaded on.
  try {
    const { base44 } = await import('@/api/base44Client');
    const styles = await base44.entities.TypographyStyle.list();
    if (Array.isArray(styles)) {
      return styles.filter((s) => s && s.is_active !== false);
    }
  } catch {
    // Not authenticated (e.g. public visitor viewing a published page).
    // Fall through to the host-based public endpoint below.
  }
  // Public renderer path: host-based tenant resolution. Returns [] on
  // hosts the resolver can't map to a tenant (localhost, *.replit.dev,
  // *.repl.co), in which case the block falls back to the legacy
  // Paragraph/H1–H6 path with hardcoded Tailwind sizes.
  try {
    const res = await fetch('/api/public/typography-styles', { credentials: 'include' });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

// Typography styles injected into the initial HTML by the SSR layer
// (api/_lib/renderHtml.js → window.__TENANT_TYPOGRAPHY_STYLES__). On real
// tenant hosts this is present on the very first paint, so the query below
// is seeded synchronously and text/headline blocks render with their custom
// style immediately — no default-then-custom flash. It's absent in the
// editor and on hosts the SSR couldn't map to a tenant (localhost,
// *.replit.dev), where the query fetches normally.
function readInjectedTypographyStyles() {
  if (typeof window === 'undefined') return undefined;
  const injected = window.__TENANT_TYPOGRAPHY_STYLES__;
  return Array.isArray(injected) ? injected : undefined;
}

export function useTenantTypographyStylesState() {
  const { data } = useQuery({
    queryKey: ['/api/public/typography-styles'],
    queryFn: fetchTenantTypographyStyles,
    // Seed from the SSR-injected list when present so the very first render
    // already has the styles. Treated as stale (updatedAt 0) so a
    // background refetch still reconciles with the authoritative source
    // (e.g. the authenticated base44 list in the editor).
    initialData: readInjectedTypographyStyles,
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
    retry: false,
  });
  return {
    styles: Array.isArray(data) ? data : [],
    // `resolved` is true once we have a definitive answer — either SSR
    // seeded the list or the fetch returned (even an empty array). Blocks
    // use this to distinguish "styles loaded, this id genuinely missing"
    // (fall back to legacy heading render) from "styles not loaded yet"
    // (must not paint a default style that will be immediately replaced).
    resolved: data !== undefined,
  };
}

export function useTenantTypographyStyles() {
  return useTenantTypographyStylesState().styles;
}

// When the chosen tenant style maps to a real heading level, derive the
// matching `headingAs` so that if the style is later deleted or made
// inactive the block still degrades to the correct legacy H1–H6 render
// instead of silently falling back to a plain <div>.
function fallbackHeadingAsForStyleType(styleType) {
  const m = String(styleType || '').toLowerCase().match(/^h([1-6])$/);
  return m ? m[1] : '';
}

const TYPOGRAPHY_TYPE_ORDER = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6, paragraph: 7 };

function sortTypographyStyles(styles) {
  return [...styles].sort((a, b) => {
    const oa = TYPOGRAPHY_TYPE_ORDER[a.style_type] ?? 99;
    const ob = TYPOGRAPHY_TYPE_ORDER[b.style_type] ?? 99;
    if (oa !== ob) return oa - ob;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function tagForTypographyStyleType(styleType) {
  const t = String(styleType || '').toLowerCase();
  if (/^h[1-6]$/.test(t)) return t;
  if (t === 'paragraph') return 'p';
  return 'div';
}

// Task #974: cascade mobile -> tablet -> desktop for the four
// per-device tenant typography properties (font-size, line-height,
// letter-spacing, margin-bottom). When the caller doesn't specify a
// breakpoint we fall back to the desktop value so callers that
// pre-date the responsive contract behave byte-identically.
function pickResponsiveTypoValue(style, baseKey, breakpoint) {
  if (!style) return null;
  const desk = style[baseKey];
  if (breakpoint === 'mobile') {
    return style[`${baseKey}_mobile`] ?? style[`${baseKey}_tablet`] ?? desk;
  }
  if (breakpoint === 'tablet') {
    return style[`${baseKey}_tablet`] ?? desk;
  }
  return desk;
}

export function buildTypographyInlineStyle(style, options) {
  if (!style) return null;
  const opts = options || {};
  const bp = opts.breakpoint;
  const out = {};
  if (style.font_family) out.fontFamily = style.font_family;
  // When the style declares a tablet/mobile-specific value and the
  // caller has opted into responsive rendering, the corresponding
  // property is emitted via a per-block <style> block with @media
  // queries instead of an inline style — inline styles win against
  // any selector, so we can't reliably override them in a `@media`
  // rule without !important. The renderer either passes a breakpoint
  // (editor preview, inline value pinned for forced bp) or omits the
  // option (public visitor, @media rule drives the cascade).
  const fs = pickResponsiveTypoValue(style, 'font_size', bp);
  if (fs != null && !opts.omitFontSize) out.fontSize = `${fs}px`;
  if (style.font_weight != null) out.fontWeight = style.font_weight;
  const lh = pickResponsiveTypoValue(style, 'line_height', bp);
  if (lh != null && !opts.omitLineHeight) out.lineHeight = lh;
  const ls = pickResponsiveTypoValue(style, 'letter_spacing', bp);
  if (ls != null && !opts.omitLetterSpacing) out.letterSpacing = `${ls}px`;
  if (style.text_transform && style.text_transform !== 'none') {
    out.textTransform = style.text_transform;
  }
  if (style.color) out.color = style.color;
  const mb = pickResponsiveTypoValue(style, 'margin_bottom', bp);
  if (mb != null && !opts.omitMarginBottom) out.marginBottom = `${mb}px`;
  return out;
}

// True when the tenant style declares any tablet- or mobile-specific
// override that differs from the desktop value (for the four per-device
// properties font-size / line-height / letter-spacing / margin-bottom).
export function hasResponsiveTypographyOverride(tenantStyle) {
  if (!tenantStyle) return false;
  for (const k of ['font_size', 'line_height', 'letter_spacing', 'margin_bottom']) {
    const d = tenantStyle[k];
    const t = tenantStyle[`${k}_tablet`];
    const m = tenantStyle[`${k}_mobile`];
    if (t != null && t !== d) return true;
    if (m != null && m !== d) return true;
  }
  return false;
}

// Build the @media (max-width: …) blocks that override the chosen
// typography properties at the tablet and mobile breakpoints. The
// `selector` argument is the CSS selector the rules should target —
// typically `[data-cb="<id>"]` (Text block wrapper) or a more specific
// child selector (Hero headline, Card heading). Uses !important so the
// declarations beat any inline-style desktop value emitted by the
// renderer. Mobile rules are only emitted when the mobile value
// differs from whatever applies at tablet (desktop or tablet override)
// to keep the stylesheet small. Returns null when no override applies.
export function buildTenantTypographyResponsiveCss(selector, style) {
  if (!style || !selector) return null;
  const PROPS = [
    { css: 'font-size', key: 'font_size', unit: 'px' },
    { css: 'line-height', key: 'line_height', unit: '' },
    { css: 'letter-spacing', key: 'letter_spacing', unit: 'px' },
    { css: 'margin-bottom', key: 'margin_bottom', unit: 'px' },
  ];
  const tabletDecls = [];
  const mobileDecls = [];
  for (const p of PROPS) {
    const d = style[p.key];
    const t = style[`${p.key}_tablet`];
    const m = style[`${p.key}_mobile`];
    const tabletWins = t != null && t !== d;
    if (tabletWins) {
      tabletDecls.push(`${p.css}:${t}${p.unit} !important;`);
    }
    const effective = tabletWins ? t : d;
    if (m != null && m !== effective) {
      mobileDecls.push(`${p.css}:${m}${p.unit} !important;`);
    }
  }
  const parts = [];
  if (tabletDecls.length) {
    parts.push(`@media (max-width:${BREAKPOINT_MAX_PX.tablet}px){${selector}{${tabletDecls.join('')}}}`);
  }
  if (mobileDecls.length) {
    parts.push(`@media (max-width:${BREAKPOINT_MAX_PX.mobile}px){${selector}{${mobileDecls.join('')}}}`);
  }
  return parts.length ? parts.join('') : null;
}

function buildTextResponsiveTypographyCss(blockId, tenantStyle) {
  if (!tenantStyle || !blockId) return null;
  const safeId = String(blockId).replace(/["\\]/g, '');
  return buildTenantTypographyResponsiveCss(`[data-cb="${safeId}"]`, tenantStyle);
}

// Task #974: extract distinct `data-fs-tablet="..."` / `data-fs-mobile="..."`
// values from sanitized Tiptap HTML and emit per-value CSS rules so
// real visitor browsers apply the right font-size at each viewport
// without any runtime JS. Editor preview iframes that force a
// breakpoint via `?_bp=` typically render at a desktop viewport width,
// so when the renderer is pinned to tablet/mobile we emit the matching
// declarations unconditionally instead of inside `@media` blocks.
// Uses !important to beat the inline `style="font-size:…"` emitted by
// Tiptap's FontSize extension for the desktop value.
function buildTiptapFontSizeResponsiveCss(blockId, html, breakpoint) {
  if (!blockId || !html) return null;
  const tabletVals = new Set();
  const mobileVals = new Set();
  const re = /data-fs-(tablet|mobile)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === 'tablet') tabletVals.add(m[2]);
    else mobileVals.add(m[2]);
  }
  if (!tabletVals.size && !mobileVals.size) return null;
  const safeId = String(blockId).replace(/["\\]/g, '');
  const escVal = (v) => String(v).replace(/["\\]/g, '');
  const parts = [];
  if (tabletVals.size) {
    const inner = [...tabletVals]
      .map((v) => `[data-cb="${safeId}"] [data-fs-tablet="${escVal(v)}"]{font-size:${v} !important;}`)
      .join('');
    if (breakpoint === 'tablet' || breakpoint === 'mobile') {
      parts.push(inner);
    } else {
      parts.push(`@media (max-width:${BREAKPOINT_MAX_PX.tablet}px){${inner}}`);
    }
  }
  if (mobileVals.size) {
    const inner = [...mobileVals]
      .map((v) => `[data-cb="${safeId}"] [data-fs-mobile="${escVal(v)}"]{font-size:${v} !important;}`)
      .join('');
    if (breakpoint === 'mobile') {
      parts.push(inner);
    } else {
      parts.push(`@media (max-width:${BREAKPOINT_MAX_PX.mobile}px){${inner}}`);
    }
  }
  return parts.length ? parts.join('') : null;
}

// Shared inspector control: lets authors pick a tenant typography style for
// blocks that don't have the Text block's full "Render as" picker (Hero
// headline/subheadline, Card heading, Button label). Hidden entirely when the
// tenant has no styles configured so those tenants see no UI change.
// `onChange(id, picked)` — `id` is the chosen style id (or '' for default) and
// `picked` is the resolved style object (or null) so callers can also persist
// a graceful-degradation fallback (e.g. mirror `headingLevel`).
export function TypographyStyleField({ label, value, onChange, testId }) {
  const tenantStyles = useTenantTypographyStyles();
  const sorted = useMemo(() => sortTypographyStyles(tenantStyles), [tenantStyles]);
  if (sorted.length === 0) return null;
  const options = [
    { value: '__none__', label: 'Default (no tenant style)' },
    ...sorted.map((s) => ({
      value: s.id,
      label: `${s.name || 'Untitled style'} (${String(s.style_type || '').toUpperCase() || '—'})`,
    })),
  ];
  const handleChange = (v) => {
    if (v === '__none__') {
      onChange('', null);
    } else {
      const picked = sorted.find((s) => s.id === v) || null;
      onChange(v, picked);
    }
  };
  return (
    <SelectField
      label={label}
      value={value || '__none__'}
      onChange={handleChange}
      options={options}
      testId={testId}
    />
  );
}

// Resolve a stored tenant typography style id against the cached tenant
// styles list. Returns null if the id is empty, unknown, or the list isn't
// loaded yet — callers should fall back to their pre-typography defaults.
export function resolveTenantStyle(styleId, styles) {
  if (!styleId) return null;
  return (styles || []).find((s) => s.id === styleId) || null;
}

// Safety net for the typography-flash fix. A block that references a tenant
// style id we can't resolve *yet* (the styles list hasn't loaded) must not
// paint the legacy default it would immediately replace. Returns true only
// during the brief not-loaded-yet window — once the list resolves (even to
// an empty array) `stylesResolved` is true and an unresolved id correctly
// falls through to the legacy render. On SSR-seeded public pages the list is
// present on first paint, so this is effectively always false there.
export function isAwaitingTypographyStyle(styleId, resolvedStyleObj, stylesResolved) {
  return !!styleId && !resolvedStyleObj && !stylesResolved;
}

function buttonClasses(variant, size) {
  const v = {
    primary: 'bg-primary text-primary-foreground hover-elevate active-elevate-2',
    default: 'bg-slate-900 text-white hover-elevate active-elevate-2',
    outline: 'border border-slate-300 bg-white text-slate-900 hover-elevate active-elevate-2',
    ghost: 'bg-transparent text-slate-900 hover-elevate active-elevate-2',
  };
  const s = {
    sm: 'h-8 px-3 text-xs',
    default: 'h-9 px-4 text-sm',
    lg: 'h-10 px-5 text-base',
  };
  return `inline-flex items-center justify-center gap-1.5 rounded-md font-medium ${v[variant] || v.default} ${s[size] || s.default}`;
}

// Task #962: numeric baselines for the legacy size classes used by
// `buttonClasses`. When a legacy variant gets a per-block `content.size`
// override (partial { paddingX?, paddingY?, fontSize?, iconSize? }), the
// non-overridden keys should still match the baseline implied by the
// selected legacy size class (`sm` / `default` / `lg`) — not the tenant
// CTA defaults — so partial overrides preserve prior visual sizing for
// the keys that weren't touched.
const LEGACY_BUTTON_SIZE_BASELINES = {
  sm:      { paddingX: 12, paddingY: 6,  fontSize: 12, iconSize: 14 },
  default: { paddingX: 16, paddingY: 8,  fontSize: 14, iconSize: 16 },
  lg:      { paddingX: 20, paddingY: 10, fontSize: 16, iconSize: 18 },
};

// Pull the legacy size-class string off a block content object,
// tolerating the historical shape where `content.size` was the string
// itself. New writes go to `content.sizeClass` so `content.size` can
// hold the per-block override object.
function readLegacySizeClass(c) {
  if (c && typeof c.sizeClass === 'string') return c.sizeClass;
  if (c && typeof c.size === 'string') return c.size;
  return 'default';
}

// Pull the per-block size override object off a block content object.
// Only returns an object when `content.size` is a plain object (the new
// override shape); strings (legacy) and missing values both return null.
function readSizeOverrides(c) {
  if (c && c.size && typeof c.size === 'object' && !Array.isArray(c.size)) return c.size;
  return null;
}

function aspectFromRatio(r) {
  if (typeof r !== 'string') return 16 / 9;
  const [a, b] = r.split(':').map(Number);
  if (!a || !b) return 16 / 9;
  return a / b;
}

function youTubeId(url) {
  if (!url) return null;
  const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([\w-]{6,})/);
  return m ? m[1] : null;
}

function vimeoId(url) {
  if (!url) return null;
  const m = String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Individual block definitions
// ---------------------------------------------------------------------------

// HERO -----------------------------------------------------------------------
// Renders a single Hero call-to-action button. Mirrors the standalone Button
// block so Hero CTAs can use the same tenant-branded button styles
// (tenant-primary / tenant-secondary / tenant:<key>) in addition to the four
// legacy variants. Unlike the standalone Button — whose width/height come from
// its canvas geometry / resize handles — a Hero CTA has no handles, so optional
// per-CTA `width`/`height` (px) are exposed in the inspector and applied here.
// Blank width/height keeps the button auto-sized (legacy behaviour).
function HeroCtaButton({ cta, asEditor, tenantStyles, stylesResolved }) {
  const branding = useTenantBranding()?.branding || null;
  const variant = cta.variant || 'primary';
  const isTenant = isTenantButtonVariant(variant);
  const tenantStyle = isTenant ? resolveTenantButtonStyle(variant, branding) : null;
  const [hovered, setHovered] = useState(false);

  const labelStyleObj = resolveTenantStyle(cta.labelTypographyStyleId, tenantStyles);
  // Omit the typography style's bottom margin: in a flex `items-center` row a
  // margin-bottom on the label shifts its margin-box, pushing the text visually
  // higher than the icon (the reported vertical-alignment issue).
  const ctaLabelInline = labelStyleObj ? buildTypographyInlineStyle(labelStyleObj, { omitMarginBottom: true }) : null;
  const awaitingLabel = isAwaitingTypographyStyle(cta.labelTypographyStyleId, labelStyleObj, stylesResolved);
  const labelStyle = awaitingLabel
    ? { ...(ctaLabelInline || {}), visibility: 'hidden' }
    : (ctaLabelInline || undefined);
  const labelSpan = <span style={labelStyle}>{cta.label || 'CTA'}</span>;

  // Per-CTA icon overrides. `cta.icon` is a sentinel-based choice:
  //   undefined / '__default__' → inherit the tenant button style's icon
  //   '__none__'                → no icon (overrides the style default)
  //   <LucideName>              → use that named icon
  // `cta.iconSize` (px) and `cta.iconPosition` ('before'|'after') override the
  // tenant style's icon size / position when set.
  const perCtaIconName = cta.icon && cta.icon !== '__default__' && cta.icon !== '__none__' ? cta.icon : null;
  const iconForcedNone = cta.icon === '__none__';
  const ctaIconSizeNum = Number(cta.iconSize);
  const hasCtaIconSize = Number.isFinite(ctaIconSizeNum) && ctaIconSizeNum > 0;
  const ctaIconPositionSet = cta.iconPosition === 'before' || cta.iconPosition === 'after';

  // Optional explicit dimensions. Blank/0 → auto (omit so the button sizes to
  // its content, preserving the prior look for existing heroes).
  const w = Number(cta.width);
  const h = Number(cta.height);
  const sizeStyle = {};
  if (Number.isFinite(w) && w > 0) sizeStyle.width = `${w}px`;
  if (Number.isFinite(h) && h > 0) sizeStyle.height = `${h}px`;
  const hasSize = Object.keys(sizeStyle).length > 0;

  if (isTenant && tenantStyle) {
    const tenantBaseline = { ...TENANT_BUTTON_DEFAULT_SIZE, ...(tenantStyle.size || {}) };
    const bg = bgCssFromConfig(hovered ? tenantStyle.hover : tenantStyle.background) || {};
    const border = tenantStyle.border || {};
    const styleIconCfg = tenantStyle.icon || null;
    // Effective icon: per-CTA name wins; an explicit "none" suppresses the
    // style default; otherwise inherit the tenant style's icon.
    let iconName = null;
    let iconColor;
    if (perCtaIconName) {
      iconName = perCtaIconName;
    } else if (!iconForcedNone && styleIconCfg?.name) {
      iconName = styleIconCfg.name;
      iconColor = styleIconCfg.color || undefined;
    }
    const IconCmp = iconName ? getLucideIcon(iconName) : null;
    const iconSizePx = hasCtaIconSize
      ? ctaIconSizeNum
      : (!perCtaIconName && Number.isFinite(styleIconCfg?.size) ? styleIconCfg.size : (tenantBaseline.iconSize || 18));
    const iconAfter = ctaIconPositionSet ? cta.iconPosition === 'after' : styleIconCfg?.position === 'after';
    const iconEl = IconCmp ? (
      <IconCmp style={{ width: iconSizePx, height: iconSizePx, color: iconColor, flexShrink: 0 }} />
    ) : null;
    const tenantTextColor = hovered
      ? tenantStyle.hoverTextColor || tenantStyle.textColor || '#ffffff'
      : tenantStyle.textColor || '#ffffff';
    const inlineStyle = {
      ...bg,
      color: tenantTextColor,
      borderRadius: `${tenantStyle.radius ?? 6}px`,
      border:
        border.width > 0
          ? `${border.width}px ${border.style || 'solid'} ${border.color || '#000000'}`
          : 'none',
      paddingTop: tenantBaseline.paddingY,
      paddingBottom: tenantBaseline.paddingY,
      paddingLeft: tenantBaseline.paddingX,
      paddingRight: tenantBaseline.paddingX,
      fontSize: tenantBaseline.fontSize,
      lineHeight: 1,
      transition: 'background-color 0.2s ease, color 0.2s ease, background 0.2s ease',
      ...sizeStyle,
    };
    // A typography style applied to the label <span> sets its own `color`,
    // which would override the tenant button's hover text color (an inline
    // color on the span wins over the inherited color from the <a>). Mirror
    // the button's current text color onto the label so the tenant hover
    // style is respected even when a font style is picked for the CTA.
    const tenantLabelStyle = (awaitingLabel || ctaLabelInline)
      ? { ...(ctaLabelInline || {}), color: tenantTextColor, ...(awaitingLabel ? { visibility: 'hidden' } : {}) }
      : undefined;
    const tenantLabelSpan = <span style={tenantLabelStyle}>{cta.label || 'CTA'}</span>;
    return (
      <a
        href={asEditor ? undefined : (cta.href || '#')}
        className="inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap leading-none"
        style={inlineStyle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => { if (asEditor) e.preventDefault(); }}
      >
        {iconAfter ? (<>{tenantLabelSpan}{iconEl}</>) : (<>{iconEl}{tenantLabelSpan}</>)}
      </a>
    );
  }

  // Legacy variant (or tenant variant whose tenant style isn't configured /
  // branding hasn't loaded). Colours/radius come from buttonClasses; an
  // explicit width/height overrides the class height via inline style. When a
  // tenant variant falls back here we use the `lg` size (matching the
  // standalone Button) so the CTA keeps sensible proportions. Legacy variants
  // have no style default icon, so only an explicitly chosen per-CTA icon shows.
  const fallbackVariant = isTenant ? 'primary' : variant;
  const fallbackSize = isTenant ? 'lg' : 'default';
  const LegacyIcon = perCtaIconName ? getLucideIcon(perCtaIconName) : null;
  const legacyIconSize = hasCtaIconSize ? ctaIconSizeNum : 18;
  const legacyIconAfter = ctaIconPositionSet ? cta.iconPosition === 'after' : false;
  const legacyIconEl = LegacyIcon ? (
    <LegacyIcon style={{ width: legacyIconSize, height: legacyIconSize, flexShrink: 0 }} />
  ) : null;
  return (
    <a
      href={asEditor ? undefined : (cta.href || '#')}
      className={buttonClasses(fallbackVariant, fallbackSize)}
      style={hasSize ? sizeStyle : undefined}
      onClick={(e) => { if (asEditor) e.preventDefault(); }}
    >
      {legacyIconAfter ? (<>{labelSpan}{legacyIconEl}</>) : (<>{legacyIconEl}{labelSpan}</>)}
    </a>
  );
}

function HeroRender({ block, asEditor, priority, breakpoint }) {
  const c = block.content || {};
  // Tenant typography styles take precedence for both the headline and the
  // optional sub-headline when set and resolvable. The tag is derived from
  // the style's `style_type` (h1–h6/paragraph) and inline styles carry
  // font-family/size/weight/etc so editor preview and public renderer match.
  const { styles: tenantStyles, resolved: stylesResolved } = useTenantTypographyStylesState();
  const headlineStyleObj = resolveTenantStyle(c.headlineTypographyStyleId, tenantStyles);
  const subheadlineStyleObj = resolveTenantStyle(c.subheadlineTypographyStyleId, tenantStyles);
  const awaitingHeadline = isAwaitingTypographyStyle(c.headlineTypographyStyleId, headlineStyleObj, stylesResolved);
  const awaitingSubheadline = isAwaitingTypographyStyle(c.subheadlineTypographyStyleId, subheadlineStyleObj, stylesResolved);
  const Heading = headlineStyleObj
    ? tagForTypographyStyleType(headlineStyleObj.style_type)
    : `h${Math.max(1, Math.min(6, c.headingLevel || 1))}`;
  const Sub = subheadlineStyleObj
    ? tagForTypographyStyleType(subheadlineStyleObj.style_type)
    : 'p';
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const bpForInline = isPreview ? breakpoint : 'desktop';
  const headlineInline = headlineStyleObj
    ? { color: 'inherit', margin: 0, width: '100%', ...buildTypographyInlineStyle(headlineStyleObj, { breakpoint: bpForInline }) }
    : { color: 'inherit', margin: 0, width: '100%', fontSize: 'clamp(1.5rem, 4vw, 2.5rem)', fontWeight: 700 };
  if (awaitingHeadline) headlineInline.visibility = 'hidden';
  const subheadlineInline = subheadlineStyleObj
    ? { color: 'inherit', marginTop: 8, opacity: 0.9, width: '100%', ...buildTypographyInlineStyle(subheadlineStyleObj, { breakpoint: bpForInline }) }
    : { color: 'inherit', marginTop: 8, opacity: 0.9, width: '100%' };
  if (awaitingSubheadline) subheadlineInline.visibility = 'hidden';
  // Public visitor: emit per-block @media CSS so tablet/mobile values
  // kick in below their breakpoints. Editor preview pins the matching
  // values inline above (the iframe viewport may not match @media).
  const safeBlockId = String(block.id || '').replace(/["\\]/g, '');
  const heroResponsiveCss = !isPreview && (headlineStyleObj || subheadlineStyleObj)
    ? [
        headlineStyleObj && hasResponsiveTypographyOverride(headlineStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="headline"]`, headlineStyleObj)
          : null,
        subheadlineStyleObj && hasResponsiveTypographyOverride(subheadlineStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="subheadline"]`, subheadlineStyleObj)
          : null,
      ].filter(Boolean).join('') || null
    : null;
  const align = c.alignment || 'center';
  const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  const textAlign = align;
  // When full-bleed, the background spans 100vw but the text content should
  // re-align to the page's centered content column. `--cb-content-width` is
  // published by the stage stylesheet per breakpoint (1200/768/375); falls
  // back to 1200. No-op when full-bleed is off or the variable is absent.
  const railStyle = c.fullBleed
    ? { maxWidth: 'var(--cb-content-width, 1200px)', marginInline: 'auto' }
    : undefined;
  const isImageBg = c.bgType === 'image' && c.bgImageUrl;
  const bg = isImageBg
    ? null
    : c.bgType === 'color'
      ? { background: c.bgColor || '#0f172a' }
      : { background: '#0f172a' };
  // Internal padding of the text/CTA content wrapper. Stored on
  // block.style.padding* (mirrors the Section block) and falls back to 24px
  // per side so legacy heroes that never set padding render exactly as the
  // old hardcoded `p-6`.
  const s = block.style || {};
  const heroPadding = {
    paddingTop: s.paddingTop ?? 24,
    paddingRight: s.paddingRight ?? 24,
    paddingBottom: s.paddingBottom ?? 24,
    paddingLeft: s.paddingLeft ?? 24,
  };
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ ...(bg || {}), borderRadius: block.style.borderRadius || 0 }}
    >
      {heroResponsiveCss && (
        <style dangerouslySetInnerHTML={{ __html: heroResponsiveCss }} />
      )}
      {isImageBg && (() => {
        const r = buildResponsiveImage(c.bgImageUrl, { sizes: '100vw' });
        return (
          <img
            src={r.src}
            srcSet={r.srcSet}
            sizes={r.sizes}
            alt={block?.a11y?.altText || ''}
            aria-hidden={block?.a11y?.altText ? undefined : 'true'}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            fetchpriority={priority ? 'high' : undefined}
            className="absolute inset-0 w-full h-full object-cover"
            style={getFocalPointStyle(c.bgFocalPoint)}
          />
        );
      })()}
      {c.bgType === 'video' && c.bgVideoUrl && !asEditor && (
        <video
          src={c.bgVideoUrl}
          autoPlay muted loop playsInline
          className="absolute inset-0 w-full h-full object-cover"
          style={getFocalPointStyle(c.bgFocalPoint)}
          aria-hidden="true"
        />
      )}
      <div
        className="absolute inset-0"
        style={{ background: buildHeroOverlayBackground(c) }}
        aria-hidden="true"
      />
      <div
        className="relative h-full w-full flex flex-col"
        style={{ alignItems: justify, justifyContent: 'center', textAlign, color: c.textColor || '#ffffff', ...heroPadding, ...(railStyle || {}) }}
      >
        <Heading style={headlineInline} data-tg-r="headline">
          {c.headline || ''}
        </Heading>
        {c.subheadline && (
          <Sub style={subheadlineInline} data-tg-r="subheadline">
            {c.subheadline}
          </Sub>
        )}
        {Array.isArray(c.ctas) && c.ctas.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2" style={{ justifyContent: justify }}>
            {c.ctas.map((cta, i) => (
              <HeroCtaButton
                key={i}
                cta={cta}
                asEditor={asEditor}
                tenantStyles={tenantStyles}
                stylesResolved={stylesResolved}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HeroInspector({ block, update }) {
  const c = block.content || {};
  const s = block.style || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const setStyle = (patch) => update((b) => ({ ...b, style: { ...b.style, ...patch } }));
  const clampPad = (v) => Math.max(0, Number(v) || 0);
  // Tenant branding powers the extra "Tenant …" CTA variants (mirrors the
  // standalone Button inspector); the hook payload is cached/shared.
  const branding = useTenantBranding()?.branding || null;
  const customStyleEntries = (() => {
    const styles =
      branding?.buttonStyles ||
      branding?.brandingConfig?.button_styles ||
      null;
    if (!styles || typeof styles !== 'object') return [];
    return Object.entries(styles)
      .filter(([k, v]) => k !== 'primary' && k !== 'secondary' && v && typeof v === 'object')
      .map(([k, v]) => ({ key: k, label: v.label || k }));
  })();
  const clampDim = (v) => (v === '' || v === null || v === undefined ? undefined : Math.max(0, Number(v) || 0));
  return (
    <>
      <TextField label="Headline" value={c.headline} onChange={(v) => set({ headline: v })} testId="input-hero-headline" />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 1)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-hero-heading-level"
      />
      <TypographyStyleField
        label="Headline style"
        value={c.headlineTypographyStyleId}
        onChange={(id, picked) => {
          // Mirror the chosen style's heading level so that if the tenant
          // style is later deleted the block still renders as the right
          // heading (graceful degradation, matches the Text block).
          const fallback = fallbackHeadingAsForStyleType(picked && picked.style_type);
          set({
            headlineTypographyStyleId: id,
            ...(fallback ? { headingLevel: Number(fallback) } : {}),
          });
        }}
        testId="select-hero-headline-typography"
      />
      <TextField label="Sub-headline" multiline value={c.subheadline} onChange={(v) => set({ subheadline: v })} testId="input-hero-subheadline" />
      <TypographyStyleField
        label="Sub-headline style"
        value={c.subheadlineTypographyStyleId}
        onChange={(id) => set({ subheadlineTypographyStyleId: id })}
        testId="select-hero-subheadline-typography"
      />
      <SelectField
        label="Background type"
        value={c.bgType || 'color'}
        onChange={(v) => set({ bgType: v })}
        options={[
          { value: 'color', label: 'Colour' },
          { value: 'image', label: 'Image' },
          { value: 'video', label: 'Video (mp4 URL)' },
        ]}
        testId="select-hero-bg-type"
      />
      {c.bgType === 'color' && (
        <ColorField label="Background colour" value={c.bgColor} onChange={(v) => set({ bgColor: v })} testId="input-hero-bg-color" />
      )}
      {c.bgType === 'image' && (
        <ImageField
          label="Background image"
          value={c.bgImageUrl}
          onChangeSrc={(v) => set({ bgImageUrl: v })}
          testId="input-hero-bg-image"
        />
      )}
      {c.bgType === 'image' && c.bgImageUrl && (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Focal point</Label>
          <FocalPointPicker
            imageUrl={c.bgImageUrl}
            focalPoint={c.bgFocalPoint || { x: 50, y: 50 }}
            onChange={(fp) => set({ bgFocalPoint: fp })}
          />
        </div>
      )}
      {c.bgType === 'video' && (
        <TextField label="Background video URL" value={c.bgVideoUrl} onChange={(v) => set({ bgVideoUrl: v })} testId="input-hero-bg-video" />
      )}
      {c.bgType === 'video' && c.bgVideoUrl && (
        <>
          <NumberField
            label="Focal point X (%)"
            value={c.bgFocalPoint?.x ?? 50}
            onChange={(v) => set({ bgFocalPoint: { x: Math.max(0, Math.min(100, Number(v) || 0)), y: c.bgFocalPoint?.y ?? 50 } })}
            min={0}
            max={100}
            testId="input-hero-bg-focal-x"
          />
          <NumberField
            label="Focal point Y (%)"
            value={c.bgFocalPoint?.y ?? 50}
            onChange={(v) => set({ bgFocalPoint: { x: c.bgFocalPoint?.x ?? 50, y: Math.max(0, Math.min(100, Number(v) || 0)) } })}
            min={0}
            max={100}
            testId="input-hero-bg-focal-y"
          />
        </>
      )}
      <SelectField
        label="Overlay style"
        value={c.overlayStyle || 'solid'}
        onChange={(v) => set({ overlayStyle: v })}
        options={[
          { value: 'solid', label: 'Solid' },
          { value: 'gradient', label: 'Gradient' },
        ]}
        testId="select-hero-overlay-style"
      />
      {(c.overlayStyle || 'solid') === 'solid' && (
        <NumberField
          label="Dark overlay (0–1)" value={c.darkWash} min={0} max={1} step={0.05}
          onChange={(v) => set({ darkWash: Math.max(0, Math.min(1, Number(v) || 0)) })}
          testId="input-hero-dark-wash"
        />
      )}
      {c.overlayStyle === 'gradient' && (
        <>
          <HeroOverlayStops c={c} set={set} />
          <SelectField
            label="Gradient direction"
            value={c.overlayDirection || 'to-top'}
            onChange={(v) => set({ overlayDirection: v })}
            options={[
              { value: 'to-top', label: 'Bottom → Top' },
              { value: 'to-bottom', label: 'Top → Bottom' },
              { value: 'to-right', label: 'Left → Right' },
              { value: 'to-left', label: 'Right → Left' },
              { value: 'to-bottom-right', label: 'Diagonal ↘' },
              { value: 'to-top-right', label: 'Diagonal ↗' },
              { value: 'custom', label: 'Custom angle' },
            ]}
            testId="select-hero-overlay-direction"
          />
          {c.overlayDirection === 'custom' && (
            <NumberField
              label="Angle (deg)" value={c.overlayAngle ?? 0} min={0} max={360} step={1}
              onChange={(v) => set({ overlayAngle: Math.max(0, Math.min(360, Number(v) || 0)) })}
              testId="input-hero-overlay-angle"
            />
          )}
        </>
      )}
      <ToggleField
        label="Full-bleed (span full screen width)"
        value={!!c.fullBleed}
        onChange={(v) => set({ fullBleed: v })}
        testId="toggle-hero-full-bleed"
      />
      <ColorField label="Text colour" value={c.textColor} onChange={(v) => set({ textColor: v })} testId="input-hero-text-color" />
      <SelectField
        label="Alignment"
        value={c.alignment || 'center'}
        onChange={(v) => set({ alignment: v })}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
          { value: 'right', label: 'Right' },
        ]}
        testId="select-hero-alignment"
      />
      <NumberField
        label="Padding top (px)" min={0} value={s.paddingTop ?? 24}
        onChange={(v) => setStyle({ paddingTop: clampPad(v) })}
        testId="input-hero-padding-top"
      />
      <NumberField
        label="Padding right (px)" min={0} value={s.paddingRight ?? 24}
        onChange={(v) => setStyle({ paddingRight: clampPad(v) })}
        testId="input-hero-padding-right"
      />
      <NumberField
        label="Padding bottom (px)" min={0} value={s.paddingBottom ?? 24}
        onChange={(v) => setStyle({ paddingBottom: clampPad(v) })}
        testId="input-hero-padding-bottom"
      />
      <NumberField
        label="Padding left (px)" min={0} value={s.paddingLeft ?? 24}
        onChange={(v) => setStyle({ paddingLeft: clampPad(v) })}
        testId="input-hero-padding-left"
      />
      <Field label="Call-to-action buttons">
        <ArrayList
          items={c.ctas || []}
          onChange={(next) => set({ ctas: next })}
          makeNew={() => ({ label: 'New CTA', href: '#', variant: 'primary' })}
          addLabel="Add CTA"
          testIdPrefix="hero-cta"
          renderItem={(item, idx, patch) => (
            <>
              <TextField label="Label" value={item.label} onChange={(v) => patch({ label: v })} testId={`hero-cta-${idx}-label`} />
              <TypographyStyleField
                label="Label style"
                value={item.labelTypographyStyleId}
                onChange={(id) => patch({ labelTypographyStyleId: id })}
                testId={`select-hero-cta-${idx}-typography`}
              />
              <LinkField label="Link" value={item.href} onChange={(v) => patch({ href: v })} testId={`hero-cta-${idx}-href`} />
              <SelectField
                label="Variant"
                value={item.variant || 'primary'}
                onChange={(v) => patch({ variant: v })}
                options={[
                  { value: 'primary', label: 'Primary' },
                  { value: 'default', label: 'Default' },
                  { value: 'outline', label: 'Outline' },
                  { value: 'ghost', label: 'Ghost' },
                  { value: 'tenant-primary', label: 'Tenant primary (branded)' },
                  { value: 'tenant-secondary', label: 'Tenant secondary (branded)' },
                  ...customStyleEntries.map((e) => ({
                    value: `tenant:${e.key}`,
                    label: `Tenant: ${e.label}`,
                  })),
                ]}
                testId={`hero-cta-${idx}-variant`}
              />
              <NumberField
                label="Width (px — blank = auto)"
                min={0}
                value={item.width}
                onChange={(v) => patch({ width: clampDim(v) })}
                testId={`input-hero-cta-${idx}-width`}
              />
              <NumberField
                label="Height (px — blank = auto)"
                min={0}
                value={item.height}
                onChange={(v) => patch({ height: clampDim(v) })}
                testId={`input-hero-cta-${idx}-height`}
              />
              <SelectField
                label="Icon"
                value={item.icon || '__default__'}
                onChange={(v) => patch({ icon: v === '__default__' ? undefined : v })}
                options={[
                  { value: '__default__', label: 'Default (button style)' },
                  { value: '__none__', label: 'None' },
                  ...Object.keys(LUCIDE_ICONS).map((n) => ({ value: n, label: n })),
                ]}
                testId={`select-hero-cta-${idx}-icon`}
              />
              <NumberField
                label="Icon size (px — blank = default)"
                min={0}
                value={item.iconSize}
                onChange={(v) => patch({ iconSize: clampDim(v) })}
                testId={`input-hero-cta-${idx}-icon-size`}
              />
              <SelectField
                label="Icon position"
                value={item.iconPosition || '__default__'}
                onChange={(v) => patch({ iconPosition: v === '__default__' ? undefined : v })}
                options={[
                  { value: '__default__', label: 'Default (button style)' },
                  { value: 'before', label: 'Before text' },
                  { value: 'after', label: 'After text' },
                ]}
                testId={`select-hero-cta-${idx}-icon-position`}
              />
            </>
          )}
        />
      </Field>
    </>
  );
}

// TEXT -----------------------------------------------------------------------
// Custom bullet-list icons. When a Text block sets `content.bulletIcon`
// (a Font Awesome class string, e.g. `fa-solid fa-book-open`), every <ul> in
// the block drops its default disc marker and renders the chosen icon instead,
// in the configured colour/size. We inject an <i> element into each <ul>'s <li>
// at render time (after sanitisation) — robust against icon changes and avoids
// any unicode-codepoint lookups. The SAME code path runs in the editor stage
// and the public renderer (both use TextRender), so previews match published
// output. When no icon is set, the HTML is returned untouched (no regression).
//
// The transform is a pure string tokenizer (no `window`/`DOMParser`
// dependency) so it produces identical output in the browser AND in any
// server-rendered path. A list-type stack is tracked so nested ordered lists
// (<ol>) keep their numbers — only <ul> items get the icon marker.
function escapeBulletAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Keep a CSS colour token safe to place inside a style="" attribute value:
// allow only the characters valid in colour values (hex, rgb()/hsl(), named).
function safeCssColor(c) {
  const v = String(c || '').trim();
  if (!v) return '';
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(v) ? v : '';
}

function mergeStyleIntoOpenTag(tagName, attrs, styleToAdd) {
  const styleRe = /style\s*=\s*"([^"]*)"/i;
  if (styleRe.test(attrs)) {
    const newAttrs = attrs.replace(styleRe, (_full, val) =>
      `style="${val.replace(/;\s*$/, '')};${styleToAdd}"`);
    return `<${tagName}${newAttrs}>`;
  }
  return `<${tagName}${attrs} style="${styleToAdd}">`;
}

function applyBulletIconToHtml(html, iconClass, color, sizePx, pad) {
  if (!html || !iconClass || !String(iconClass).trim()) return html;
  const cleanedClass = escapeBulletAttr(String(iconClass).trim());
  const sizeNum = Number.isFinite(sizePx) ? sizePx : null;
  const cssColor = safeCssColor(color);

  // Optional per-side padding (px) around the icon. When every side is unset
  // AND no custom size is configured we fall back to the original 1.6em
  // hanging indent so existing blocks render byte-identically.
  const p = pad || {};
  const padT = Number.isFinite(p.top) ? p.top : null;
  const padR = Number.isFinite(p.right) ? p.right : null;
  const padB = Number.isFinite(p.bottom) ? p.bottom : null;
  const padL = Number.isFinite(p.left) ? p.left : null;
  const hasPad = padT !== null || padR !== null || padB !== null || padL !== null;
  const legacy = !hasPad && sizeNum === null;

  // Vertical position of the icon. Top pushes the icon DOWN, bottom pushes it
  // UP — both move only the absolutely-positioned icon, never the list text,
  // so the bullet can be nudged to line up precisely with the text baseline.
  // Default baseline offset stays 0.15em when neither is set.
  const iconTop = (padT !== null || padB !== null)
    ? `calc(0.15em + ${padT !== null ? padT : 0}px - ${padB !== null ? padB : 0}px)`
    : '0.15em';

  const iconStyle = [
    'position:absolute',
    `left:${padL !== null ? `${padL}px` : '0'}`,
    `top:${iconTop}`,
    cssColor ? `color:${cssColor}` : '',
    sizeNum !== null ? `font-size:${sizeNum}px` : '',
  ].filter(Boolean).join(';');

  // Text inset: enough room for the icon so it never overruns the text.
  // inset = left padding + icon width + right gap (default 8px). The icon
  // width allowance scales with the icon size: when a px size is set we use
  // 1.25x it (Font Awesome glyphs can be up to ~1.25em wide); when no size is
  // set the icon inherits the list font size, so we reserve 1.25em via calc()
  // — this keeps the text clear even at large font sizes. Top/bottom padding
  // deliberately does NOT pad the <li> (it only moves the icon, see above). In
  // legacy mode (no size and no padding) we keep the original 1.6em indent.
  let liStyle;
  if (legacy) {
    liStyle = 'list-style:none;position:relative;padding-left:1.6em';
  } else {
    const left = padL !== null ? padL : 0;
    const gap = padR !== null ? padR : 8;
    const iconW = sizeNum !== null ? `${Math.round(sizeNum * 1.25)}px` : '1.25em';
    const inset = `calc(${left}px + ${iconW} + ${gap}px)`;
    liStyle = ['list-style:none', 'position:relative', `padding-left:${inset}`].join(';');
  }

  const iconHtml = `<i class="${cleanedClass} cb-bullet-icon" aria-hidden="true" style="${iconStyle}"></i>`;

  const tagRe = /<(\/?)(ul|ol|li)\b([^>]*)>/gi;
  const listStack = [];
  let out = '';
  let lastIndex = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    const [full, slash, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    out += html.slice(lastIndex, m.index);
    lastIndex = m.index + full.length;
    if (!slash) {
      if (name === 'ul') {
        listStack.push('ul');
        out += mergeStyleIntoOpenTag('ul', attrs, 'list-style:none;padding-left:0;margin-left:0');
      } else if (name === 'ol') {
        listStack.push('ol');
        out += full;
      } else { // li
        if (listStack[listStack.length - 1] === 'ul') {
          out += mergeStyleIntoOpenTag('li', attrs, liStyle);
          out += iconHtml;
        } else {
          out += full;
        }
      }
    } else {
      if ((name === 'ul' || name === 'ol') && listStack.length) listStack.pop();
      out += full;
    }
  }
  out += html.slice(lastIndex);
  return out;
}

function TextRender({ block, breakpoint }) {
  const c = block.content || {};
  const safeHtml = applyBulletIconToHtml(
    sanitizeRichText(stripTrailingEmptyParagraphs(c.html || '')),
    c.bulletIcon,
    c.bulletIconColor,
    c.bulletIconSize,
    {
      top: c.bulletIconPadTop,
      right: c.bulletIconPadRight,
      bottom: c.bulletIconPadBottom,
      left: c.bulletIconPadLeft,
    },
  );
  // Tenant typography style takes precedence when set and resolvable — the
  // outer tag follows the style's `style_type` (h1–h6/paragraph) and an
  // inline style object carries font-family/size/weight/etc so the public
  // renderer matches what the author sees in the editor.
  const { styles: tenantStyles, resolved: stylesResolved } = useTenantTypographyStylesState();
  const tenantStyle = c.typographyStyleId
    ? tenantStyles.find((s) => s.id === c.typographyStyleId) || null
    : null;
  const awaitingStyle = isAwaitingTypographyStyle(c.typographyStyleId, tenantStyle, stylesResolved);

  // Responsive typography handling: when the chosen tenant style declares
  // any tablet/mobile-specific override, the editor preview pins the
  // matching values inline (because the iframe viewport may not match
  // the @media rules) while the public visitor renders inline desktop
  // values plus a per-block <style> with `@media` rules.
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const hasResponsiveOverrideForBlock = tenantStyle
    ? hasResponsiveTypographyOverride(tenantStyle)
    : false;
  const responsiveTenantCss = !isPreview && hasResponsiveOverrideForBlock
    ? buildTextResponsiveTypographyCss(block.id, tenantStyle)
    : null;
  const tiptapResponsiveCss = buildTiptapFontSizeResponsiveCss(
    block.id,
    safeHtml,
    isPreview ? breakpoint : null,
  );

  let Tag;
  let headingSizeClass = '';
  let inlineTypography = null;
  if (tenantStyle) {
    Tag = tagForTypographyStyleType(tenantStyle.style_type);
    inlineTypography = buildTypographyInlineStyle(tenantStyle, {
      breakpoint: isPreview ? breakpoint : 'desktop',
    });
  } else {
    // Fallback: legacy "Render as H1–H6" path. Unchanged behaviour for any
    // existing block that has `headingAs` set but no `typographyStyleId`.
    const level = Number(c.headingAs);
    Tag = level >= 1 && level <= 6 ? `h${level}` : 'div';
    // While the styles list is still loading and this block references a
    // (not-yet-resolved) tenant style, suppress the legacy sizing so we
    // don't paint a default we're about to replace.
    headingSizeClass = awaitingStyle ? '' : ({
      1: 'text-3xl font-bold',
      2: 'text-2xl font-bold',
      3: 'text-xl font-semibold',
      4: 'text-lg font-semibold',
      5: 'text-base font-semibold',
      6: 'text-sm font-semibold uppercase tracking-wide',
    }[level] || '');
  }
  const outerStyle = {
    // Tenant style colour wins; otherwise honour the block's colour role.
    color: tenantStyle && tenantStyle.color
      ? tenantStyle.color
      : textColorForRole(c.colorRole),
    ...(inlineTypography || {}),
  };
  // Per-block line-spacing override (`content.lineHeight`, unitless).
  // Applied last so it wins over any tenant-style line-height (including
  // the responsive mobile pin) and over the default browser line-height
  // on the legacy heading path.
  if (Number.isFinite(c.lineHeight)) {
    outerStyle.lineHeight = c.lineHeight;
  }
  // Hide the text until the referenced style resolves so the legacy default
  // is never visibly painted before snapping to the custom style.
  if (awaitingStyle) {
    outerStyle.visibility = 'hidden';
  }
  return (
    <>
      {responsiveTenantCss && (
        <style dangerouslySetInnerHTML={{ __html: responsiveTenantCss }} />
      )}
      {tiptapResponsiveCss && (
        <style dangerouslySetInnerHTML={{ __html: tiptapResponsiveCss }} />
      )}
      <Tag
        className={`prose prose-sm max-w-none w-full h-full overflow-auto [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:text-xl [&_h3]:font-semibold [&_h4]:text-lg [&_h4]:font-semibold [&_h5]:text-base [&_h5]:font-semibold [&_h6]:text-sm [&_h6]:font-semibold [&_h6]:uppercase [&_p:last-child]:mb-0 [&_a]:text-blue-600 [&_a]:underline ${headingSizeClass}`}
        style={outerStyle}
        dangerouslySetInnerHTML={{ __html: safeHtml }}
      />
    </>
  );
}

function TextInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const tenantStyles = useTenantTypographyStyles();
  const sortedTenantStyles = useMemo(
    () => sortTypographyStyles(tenantStyles),
    [tenantStyles],
  );
  // Build the options list: tenant styles first (so authors see their
  // brand styles up top), then the generic Paragraph + H1–H6 fallbacks
  // which are always available.
  const renderAsOptions = useMemo(() => {
    const tenantOptions = sortedTenantStyles.map((s) => ({
      value: `style:${s.id}`,
      label: `${s.name || 'Untitled style'} (${String(s.style_type || '').toUpperCase() || '—'})`,
    }));
    const genericOptions = [
      { value: 'p', label: 'Paragraph / rich text' },
      { value: '1', label: 'Heading 1 (H1)' },
      { value: '2', label: 'Heading 2 (H2)' },
      { value: '3', label: 'Heading 3 (H3)' },
      { value: '4', label: 'Heading 4 (H4)' },
      { value: '5', label: 'Heading 5 (H5)' },
      { value: '6', label: 'Heading 6 (H6)' },
    ];
    return [...tenantOptions, ...genericOptions];
  }, [sortedTenantStyles]);
  // Compute the current selected value. Tenant style id wins; otherwise
  // we fall back to the legacy `headingAs` level.
  const currentValue = c.typographyStyleId
    ? `style:${c.typographyStyleId}`
    : String(c.headingAs || 'p');
  const handleRenderAsChange = (v) => {
    if (typeof v === 'string' && v.startsWith('style:')) {
      // Picking a tenant style also stores a fallback `headingAs`
      // derived from its `style_type` (h1–h6). If the style is later
      // deleted or deactivated, the block still renders as the right
      // heading level via the legacy path instead of collapsing to a
      // plain <div>.
      const id = v.slice('style:'.length);
      const picked = sortedTenantStyles.find((s) => s.id === id);
      const fallback = fallbackHeadingAsForStyleType(picked && picked.style_type);
      set({ typographyStyleId: id, headingAs: fallback });
    } else {
      set({ typographyStyleId: '', headingAs: v === 'p' ? '' : v });
    }
  };
  return (
    <>
      <SelectField
        label="Render as"
        value={currentValue}
        onChange={handleRenderAsChange}
        options={renderAsOptions}
        testId="select-text-heading-as"
      />
      <RichTextField label="Content" value={c.html} onChange={(v) => set({ html: v })} testId="input-text-content" breakpoint={breakpoint} />
      <SelectField
        label="Text colour role"
        value={c.colorRole || 'default'}
        onChange={(v) => set({ colorRole: v })}
        options={[
          { value: 'default', label: 'Default' },
          { value: 'secondary', label: 'Secondary' },
          { value: 'tertiary', label: 'Tertiary' },
        ]}
        testId="select-text-color-role"
      />
      <NumberField
        label="Line spacing (leave blank for default)"
        value={Number.isFinite(c.lineHeight) ? c.lineHeight : null}
        onChange={(v) => set({ lineHeight: Number.isFinite(v) ? v : undefined })}
        min={0.5}
        max={4}
        step={0.1}
        testId="input-text-line-height"
      />
      <div className="pt-1 border-t border-slate-100 space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-slate-600">Bullet list icon</Label>
          {c.bulletIcon && String(c.bulletIcon).trim() ? (
            <i
              className={String(c.bulletIcon).trim()}
              aria-hidden="true"
              style={{ color: c.bulletIconColor || undefined }}
              data-testid="preview-text-bullet-icon"
            />
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={() => setIconPickerOpen(true)}
          data-testid="button-browse-bullet-icon"
        >
          <Search className="w-4 h-4" />
          {c.bulletIcon && String(c.bulletIcon).trim() ? 'Change icon…' : 'Browse icons…'}
        </Button>
        <Suspense fallback={null}>
          {iconPickerOpen ? (
            <FontAwesomeIconPicker
              open={iconPickerOpen}
              onClose={() => setIconPickerOpen(false)}
              onSelect={(cls) => set({ bulletIcon: cls })}
              currentValue={c.bulletIcon}
            />
          ) : null}
        </Suspense>
        <TextField
          label="Font Awesome class (advanced — or use the picker above)"
          value={c.bulletIcon}
          onChange={(v) => set({ bulletIcon: v })}
          placeholder="fa-solid fa-book-open"
          testId="input-text-bullet-icon"
        />
        {c.bulletIcon && String(c.bulletIcon).trim() ? (
          <>
            <ColorField
              label="Bullet icon colour"
              value={c.bulletIconColor || ''}
              onChange={(v) => set({ bulletIconColor: v })}
              testId="input-text-bullet-icon-color"
            />
            <NumberField
              label="Bullet icon size (px, blank for default)"
              value={Number.isFinite(c.bulletIconSize) ? c.bulletIconSize : null}
              onChange={(v) => set({ bulletIconSize: Number.isFinite(v) ? v : null })}
              min={6}
              max={96}
              step={1}
              testId="input-text-bullet-icon-size"
            />
            <Label className="text-xs text-slate-600">Bullet icon position (px, blank for default)</Label>
            <p className="text-[11px] text-slate-500">Moves the bullet icon only — the text stays put. Top nudges the bullet down, Bottom nudges it up; Left/Right adjust the horizontal gap.</p>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Top (move down)"
                value={Number.isFinite(c.bulletIconPadTop) ? c.bulletIconPadTop : null}
                onChange={(v) => set({ bulletIconPadTop: Number.isFinite(v) ? v : null })}
                min={0}
                max={96}
                step={1}
                testId="input-text-bullet-icon-pad-top"
              />
              <NumberField
                label="Right (gap)"
                value={Number.isFinite(c.bulletIconPadRight) ? c.bulletIconPadRight : null}
                onChange={(v) => set({ bulletIconPadRight: Number.isFinite(v) ? v : null })}
                min={0}
                max={96}
                step={1}
                testId="input-text-bullet-icon-pad-right"
              />
              <NumberField
                label="Bottom (move up)"
                value={Number.isFinite(c.bulletIconPadBottom) ? c.bulletIconPadBottom : null}
                onChange={(v) => set({ bulletIconPadBottom: Number.isFinite(v) ? v : null })}
                min={0}
                max={96}
                step={1}
                testId="input-text-bullet-icon-pad-bottom"
              />
              <NumberField
                label="Left (move right)"
                value={Number.isFinite(c.bulletIconPadLeft) ? c.bulletIconPadLeft : null}
                onChange={(v) => set({ bulletIconPadLeft: Number.isFinite(v) ? v : null })}
                min={0}
                max={96}
                step={1}
                testId="input-text-bullet-icon-pad-left"
              />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

// IMAGE ----------------------------------------------------------------------
function _sanitizeFaIconClassForImage(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .split(/\s+/)
    .filter((t) => /^fa[a-z0-9-]*$/.test(t))
    .join(' ');
}

function ImageRender({ block, asEditor, priority }) {
  const c = block.content || {};
  const iconClass = _sanitizeFaIconClassForImage(c.iconClass);

  if (iconClass) {
    const alignToJustify = (a) => (a === 'center' ? 'center' : a === 'right' ? 'flex-end' : 'flex-start');
    const iconEl = (
      <div
        className="w-full h-full flex items-center"
        style={{ justifyContent: alignToJustify(c.iconAlign) }}
      >
        <i
          className={iconClass}
          aria-hidden="true"
          style={{
            fontSize: Number.isFinite(Number(c.iconSize)) && Number(c.iconSize) > 0 ? Number(c.iconSize) : 64,
            color: c.iconColor || undefined,
            lineHeight: 1,
          }}
        />
      </div>
    );
    if (c.href && !asEditor) {
      return <a href={c.href} className="block w-full h-full">{iconEl}</a>;
    }
    return iconEl;
  }

  const r = c.src ? buildResponsiveImage(c.src, { sizes: '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw' }) : null;
  const img = c.src ? (
    <img
      src={r.src}
      srcSet={r.srcSet}
      sizes={r.sizes}
      alt={c.alt || ''}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      fetchpriority={priority ? 'high' : undefined}
      style={{
        width: '100%',
        height: '100%',
        objectFit: c.objectFit || 'cover',
        display: 'block',
        borderRadius: block.style.borderRadius || 0,
      }}
    />
  ) : (
    <div className="w-full h-full flex items-center justify-center bg-slate-100 text-slate-400 text-xs">
      <ImageIcon className="w-6 h-6 mr-1" /> No image
    </div>
  );
  if (c.href && !asEditor) {
    return <a href={c.href} className="block w-full h-full">{img}</a>;
  }
  return img;
}

function ImageInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const iconClass = _sanitizeFaIconClassForImage(c.iconClass);
  return (
    <>
      <ImageField
        label="Image"
        value={c.src}
        alt={c.alt}
        onChangeSrc={(v) => set({ src: v })}
        onChangeAlt={(v) => set({ alt: v })}
        testId="input-image"
      />
      <div className="pt-1 border-t border-slate-100 space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-slate-600">Font Awesome icon</Label>
          {iconClass ? (
            <i
              className={iconClass}
              aria-hidden="true"
              style={{ color: c.iconColor || undefined }}
              data-testid="preview-image-icon"
            />
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={() => setIconPickerOpen(true)}
          data-testid="button-browse-image-icon"
        >
          <Search className="w-4 h-4" />
          {iconClass ? 'Change icon…' : 'Browse icons…'}
        </Button>
        <Suspense fallback={null}>
          {iconPickerOpen ? (
            <FontAwesomeIconPicker
              open={iconPickerOpen}
              onClose={() => setIconPickerOpen(false)}
              onSelect={(cls) => set({ iconClass: cls })}
              currentValue={c.iconClass}
            />
          ) : null}
        </Suspense>
        <TextField
          label="Font Awesome class (advanced — or use the picker above)"
          value={c.iconClass}
          onChange={(v) => set({ iconClass: v })}
          placeholder="fa-solid fa-image"
          testId="input-image-icon-class"
        />
        {iconClass && (
          <>
            <NumberField
              label="Icon size (px)"
              value={c.iconSize == null ? 64 : c.iconSize}
              onChange={(v) => set({ iconSize: v })}
              min={8}
              max={320}
              testId="input-image-icon-size"
            />
            <SelectField
              label="Icon alignment"
              value={c.iconAlign || 'center'}
              onChange={(v) => set({ iconAlign: v })}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
              ]}
              testId="select-image-icon-align"
            />
            <ColorField
              label="Icon colour (optional)"
              value={c.iconColor}
              onChange={(v) => set({ iconColor: v })}
              testId="input-image-icon-color"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-slate-500"
              onClick={() => set({ iconClass: '', iconSize: 64, iconColor: '', iconAlign: 'center' })}
              data-testid="button-remove-image-icon"
            >
              Remove icon
            </Button>
          </>
        )}
      </div>
      <LinkField label="Link (optional)" value={c.href} onChange={(v) => set({ href: v })} testId="input-image-href" />
      <ToggleField
        label="Full-bleed (span full screen width)"
        value={!!c.fullBleed}
        onChange={(v) => set({ fullBleed: v })}
        testId="toggle-image-full-bleed"
      />
      {c.fullBleed && (
        <>
          <SelectField
            label="Height mode"
            value={c.heightMode || 'auto'}
            onChange={(v) => set({ heightMode: v })}
            options={[
              { value: 'auto', label: 'Auto (drag to resize)' },
              { value: 'px', label: 'Fixed (px)' },
              { value: 'vh', label: 'Viewport height (vh)' },
            ]}
            testId="select-image-height-mode"
          />
          {(c.heightMode === 'px' || c.heightMode === 'vh') && (
            <NumberField
              label={c.heightMode === 'vh' ? 'Height (vh)' : 'Height (px)'}
              value={Number.isFinite(c.heightValue) ? c.heightValue : (c.heightMode === 'vh' ? 40 : 300)}
              onChange={(v) => set({ heightValue: Number.isFinite(v) ? v : null })}
              min={1}
              max={c.heightMode === 'vh' ? 100 : 2000}
              step={1}
              testId="input-image-height-value"
            />
          )}
        </>
      )}
      {!iconClass && (
        <SelectField
          label="Object fit"
          value={c.objectFit || 'cover'}
          onChange={(v) => set({ objectFit: v })}
          options={[
            { value: 'cover', label: 'Cover' },
            { value: 'contain', label: 'Contain' },
            { value: 'fill', label: 'Fill' },
            { value: 'none', label: 'None' },
            { value: 'scale-down', label: 'Scale down' },
          ]}
          testId="select-image-fit"
        />
      )}
    </>
  );
}

// BUTTON ---------------------------------------------------------------------
function ButtonRender({ block, asEditor, breakpoint }) {
  const c = block.content || {};
  const Icon = getLucideIcon(c.icon);
  // Tenant typography style — when set, the label span carries inline
  // font-family/size/weight/etc so the button label honours brand type. The
  // outer anchor still uses the variant/size button classes (background,
  // radius, hover/active states) so this only changes typography.
  const { styles: tenantStyles, resolved: stylesResolved } = useTenantTypographyStylesState();
  const labelStyleObj = resolveTenantStyle(c.typographyStyleId, tenantStyles);
  const awaitingLabel = isAwaitingTypographyStyle(c.typographyStyleId, labelStyleObj, stylesResolved);
  // While the referenced style is still loading, hide the label rather than
  // flash the default text styling that will be replaced a moment later.
  const labelInline = labelStyleObj
    ? buildTypographyInlineStyle(labelStyleObj, { omitMarginBottom: true })
    : (awaitingLabel ? { visibility: 'hidden' } : null);
  // Tenant button variants — when `variant` is `tenant-primary` or
  // `tenant-secondary` we render with inline styles derived from the
  // tenant's saved `branding.buttonStyles[primary|secondary]` instead of
  // the hardcoded buttonClasses() output. Hover swap mirrors the
  // useState approach already used by PublicHeader's StyledNavButton so
  // we don't invent a third hover mechanism. The four legacy variants
  // (`primary`/`default`/`outline`/`ghost`) continue through buttonClasses
  // unchanged.
  const branding = useTenantBranding()?.branding || null;
  const isTenantVariant = isTenantButtonVariant(c.variant);
  const tenantStyle = isTenantVariant ? resolveTenantButtonStyle(c.variant, branding) : null;
  const [tenantHovered, setTenantHovered] = useState(false);

  // Task #962: per-block size overrides. `content.size` (when stored as
  // an object) is a partial { paddingX?, paddingY?, fontSize?, iconSize? }
  // that wins over the resolved tenant size and the tenant/legacy
  // default. For legacy variants any override switches the block to the
  // inline-styled <a> path so the per-block size actually takes effect;
  // non-overridden keys fall back to the legacy size-class baseline
  // (sm/default/lg) so partial overrides keep the visual size of the
  // keys the user didn't touch.
  // Task #970: each sub-field of `content.size` is now per-device — either
  // a scalar number (legacy / desktop-only) or a `{ desktop?, tablet?, mobile? }`
  // object that cascades mobile→tablet→desktop. Resolve each sub-field at
  // the current breakpoint; sub-fields that resolve to undefined drop off
  // so the resolved size still falls back to tenant/legacy baselines.
  // Task #972: path-selection must be STATIC (not breakpoint-resolved) so
  // a block whose only override sits on `mobile` still switches to the
  // inline-styled path on real public pages (where `breakpoint` is
  // undefined and would otherwise resolve to the empty desktop value).
  // The inline path then feeds each sub-field via a CSS var that the
  // per-page stylesheet declares per breakpoint.
  const isForcedPreview = !!breakpoint;
  const rawSizeOverrides = readSizeOverrides(c);
  const sizeOverrides = (() => {
    if (!rawSizeOverrides) return null;
    const out = {};
    for (const k of ['paddingX', 'paddingY', 'fontSize', 'iconSize']) {
      const v = resolveResponsiveValue(rawSizeOverrides[k], breakpoint);
      if (Number.isFinite(v)) out[k] = v;
    }
    return out;
  })();
  const hasAnyBpSizeOverride =
    !!rawSizeOverrides &&
    ['paddingX', 'paddingY', 'fontSize', 'iconSize'].some(
      (k) => hasAnyResponsiveValue(rawSizeOverrides[k]),
    );
  const hasSizeOverrides = hasAnyBpSizeOverride;
  const legacySizeClass = readLegacySizeClass(c);
  // Helper to pick between a forced-preview inline px literal and a CSS
  // var (public mode). Both fall back to the baseline pixel value when
  // the sub-field isn't overridden — so e.g. a Button whose only override
  // is `paddingX` still uses the baseline `fontSize`/`paddingY`/`iconSize`.
  const subFieldValue = (subKey, varName, baselinePx) => {
    if (isForcedPreview) {
      const v = sizeOverrides && Number.isFinite(sizeOverrides[subKey]) ? sizeOverrides[subKey] : baselinePx;
      return `${v}px`;
    }
    if (rawSizeOverrides && hasAnyResponsiveValue(rawSizeOverrides[subKey])) {
      return `var(${varName}, ${baselinePx}px)`;
    }
    return `${baselinePx}px`;
  };

  if (isTenantVariant && tenantStyle) {
    // Baseline = tenant defaults merged with the tenant style's saved size
    // (the values that would apply if NO per-block override existed). The
    // per-block override (if any) feeds in via subFieldValue's var fallback.
    const tenantBaseline = { ...TENANT_BUTTON_DEFAULT_SIZE, ...(tenantStyle.size || {}) };
    const bg = bgCssFromConfig(tenantHovered ? tenantStyle.hover : tenantStyle.background) || {};
    const border = tenantStyle.border || {};
    const padY = subFieldValue('paddingY', '--cb-btn-py',   tenantBaseline.paddingY);
    const padX = subFieldValue('paddingX', '--cb-btn-px',   tenantBaseline.paddingX);
    const fs   = subFieldValue('fontSize', '--cb-btn-fs',   tenantBaseline.fontSize);
    const iconPx = subFieldValue('iconSize', '--cb-btn-icon', tenantBaseline.iconSize);
    const inlineStyle = {
      ...bg,
      color: tenantHovered
        ? tenantStyle.hoverTextColor || tenantStyle.textColor || '#ffffff'
        : tenantStyle.textColor || '#ffffff',
      borderRadius: `${tenantStyle.radius ?? 6}px`,
      border:
        border.width > 0
          ? `${border.width}px ${border.style || 'solid'} ${border.color || '#000000'}`
          : 'none',
      paddingTop: padY,
      paddingBottom: padY,
      paddingLeft: padX,
      paddingRight: padX,
      fontSize: fs,
      transition: 'background-color 0.2s ease, color 0.2s ease, background 0.2s ease',
    };
    // Default icon from the tenant button style. The per-block icon (c.icon,
    // resolved into `Icon` above) always wins; the style's default icon only
    // renders when the block itself has no icon. The style icon carries its
    // own size/colour/position so it can differ from the label colour.
    const styleIconCfg = tenantStyle.icon || null;
    const StyleIcon = !Icon && styleIconCfg?.name ? getLucideIcon(styleIconCfg.name) : null;
    const styleIconSize = StyleIcon && Number.isFinite(styleIconCfg.size) ? styleIconCfg.size : 18;
    const styleIconColor = StyleIcon ? (styleIconCfg.color || undefined) : undefined;
    const styleIconAfter = StyleIcon && styleIconCfg.position === 'after';
    const labelSpan = <span style={labelInline || undefined}>{c.label || 'Button'}</span>;
    const styleIconEl = StyleIcon ? (
      <StyleIcon style={{ width: styleIconSize, height: styleIconSize, color: styleIconColor }} />
    ) : null;
    let tenantInner;
    if (Icon) {
      tenantInner = (
        <>
          <Icon style={{ width: iconPx, height: iconPx }} />
          {labelSpan}
        </>
      );
    } else if (StyleIcon) {
      tenantInner = styleIconAfter ? (
        <>
          {labelSpan}
          {styleIconEl}
        </>
      ) : (
        <>
          {styleIconEl}
          {labelSpan}
        </>
      );
    } else {
      tenantInner = labelSpan;
    }
    return (
      <div className="w-full h-full">
        <a
          href={asEditor ? undefined : (c.href || '#')}
          target={c.newTab ? '_blank' : undefined}
          rel={c.newTab ? 'noopener noreferrer' : undefined}
          aria-label={c.ariaLabel || undefined}
          className="flex w-full h-full items-center justify-center gap-1.5 font-medium whitespace-nowrap"
          style={inlineStyle}
          onMouseEnter={() => setTenantHovered(true)}
          onMouseLeave={() => setTenantHovered(false)}
          onClick={(e) => { if (asEditor) e.preventDefault(); }}
        >
          {tenantInner}
        </a>
      </div>
    );
  }

  // Task #962: legacy variant + per-block size overrides → render with
  // inline padding/font/icon (mirroring the tenant inline-styled path)
  // so the overrides actually apply. Variant colours still come from
  // `buttonClasses` (sans size class) so existing colour behaviour is
  // preserved; only the size class is replaced by inline styles.
  if (!isTenantVariant && hasSizeOverrides) {
    const baseline = LEGACY_BUTTON_SIZE_BASELINES[legacySizeClass] || LEGACY_BUTTON_SIZE_BASELINES.default;
    const variantClass = {
      primary: 'bg-primary text-primary-foreground hover-elevate active-elevate-2',
      default: 'bg-slate-900 text-white hover-elevate active-elevate-2',
      outline: 'border border-slate-300 bg-white text-slate-900 hover-elevate active-elevate-2',
      ghost: 'bg-transparent text-slate-900 hover-elevate active-elevate-2',
    };
    const baseCls = `flex w-full h-full items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap ${variantClass[c.variant] || variantClass.default}`;
    const padY = subFieldValue('paddingY', '--cb-btn-py',   baseline.paddingY);
    const padX = subFieldValue('paddingX', '--cb-btn-px',   baseline.paddingX);
    const fs   = subFieldValue('fontSize', '--cb-btn-fs',   baseline.fontSize);
    const iconPx = subFieldValue('iconSize', '--cb-btn-icon', baseline.iconSize);
    const inlineStyle = {
      paddingTop: padY,
      paddingBottom: padY,
      paddingLeft: padX,
      paddingRight: padX,
      fontSize: fs,
    };
    return (
      <div className="w-full h-full">
        <a
          href={asEditor ? undefined : (c.href || '#')}
          target={c.newTab ? '_blank' : undefined}
          rel={c.newTab ? 'noopener noreferrer' : undefined}
          aria-label={c.ariaLabel || undefined}
          className={baseCls}
          style={inlineStyle}
          onClick={(e) => { if (asEditor) e.preventDefault(); }}
        >
          {Icon && <Icon style={{ width: iconPx, height: iconPx }} />}
          <span style={labelInline || undefined}>{c.label || 'Button'}</span>
        </a>
      </div>
    );
  }

  // Fallback path: tenant variant selected but tenant has no button styles
  // configured (or branding hasn't loaded yet) — render with the `lg`
  // legacy classes so the button still has sensible CTA proportions.
  const fallbackSize = isTenantVariant ? 'lg' : legacySizeClass;
  const fallbackVariant = isTenantVariant ? 'primary' : c.variant;
  const inner = (
    <>
      {Icon && <Icon className="w-4 h-4" />}
      <span style={labelInline || undefined}>{c.label || 'Button'}</span>
    </>
  );
  return (
    <div className="w-full h-full">
      <a
        href={asEditor ? undefined : (c.href || '#')}
        target={c.newTab ? '_blank' : undefined}
        rel={c.newTab ? 'noopener noreferrer' : undefined}
        aria-label={c.ariaLabel || undefined}
        className={`${buttonClasses(fallbackVariant, fallbackSize)} whitespace-nowrap`}
        style={{ width: '100%', height: '100%' }}
        onClick={(e) => { if (asEditor) e.preventDefault(); }}
      >
        {inner}
      </a>
    </div>
  );
}

// Task #962: Inspector control for per-block size overrides on a Button.
// Renders four numeric inputs (px) for paddingX, paddingY, fontSize,
// iconSize. The override object is stored at `content.size` (partial
// object); the legacy string size lives at `content.sizeClass` so the
// two coexist cleanly. Per-field placeholder reflects the *resolved*
// default for the current variant: tenant defaults + tenantStyle.size
// for tenant variants, or the legacy size-class baseline (sm/default/lg)
// for legacy variants. Clearing all four inputs removes
// `content.size` entirely so a no-overrides block has no `size` key.
const BUTTON_SIZE_OVERRIDE_FIELDS = [
  { key: 'paddingX', label: 'Padding X' },
  { key: 'paddingY', label: 'Padding Y' },
  { key: 'fontSize', label: 'Font size' },
  { key: 'iconSize', label: 'Icon size' },
];

function ButtonSizeOverridesField({ block, update, baseline, baselineLabel, breakpoint }) {
  const c = block.content || {};
  const overrides = readSizeOverrides(c) || {};
  const bp = breakpoint || 'desktop';
  // Task #970: each sub-field of the override object is now itself per-device.
  // The writer updates the targeted sub-field via `writeResponsiveValue` (so
  // desktop-only entries stay scalar) and then trims the parent `content.size`
  // when no sub-field has any data — keeping no-override blocks byte-identical.
  const writeOverride = (key, nextVal) => {
    update((b) => {
      const content = { ...(b.content || {}) };
      if (typeof content.size === 'string' && !content.sizeClass) {
        content.sizeClass = content.size;
      }
      const current = readSizeOverrides(content) ? { ...readSizeOverrides(content) } : {};
      const updated = writeResponsiveValue(current[key], bp, Number.isFinite(nextVal) ? nextVal : null);
      if (updated === undefined) {
        delete current[key];
      } else {
        current[key] = updated;
      }
      if (Object.keys(current).length === 0) {
        delete content.size;
      } else {
        content.size = current;
      }
      return { ...b, content };
    });
  };
  return (
    <Field label="Internal spacing & text">
      <div className="space-y-2">
        <p className="text-xs text-slate-500">
          The button fills its bounds — set its overall size with the Width and Height fields (or the resize handles). These values control internal padding and the label/icon size within that box.
        </p>
        <p className="text-xs text-slate-500">
          Leave blank to use the {baselineLabel} for this variant. Set any value to override just this button.
          {bp !== 'desktop' ? ` Editing the ${bp} breakpoint — blank inherits from the wider breakpoint.` : ''}
        </p>
        {BUTTON_SIZE_OVERRIDE_FIELDS.map((f) => {
          const subValue = overrides[f.key];
          const ownVal = hasResponsiveOverride(subValue, bp)
            ? (typeof subValue === 'number' ? subValue : subValue[bp])
            : null;
          const hasValue = Number.isFinite(ownVal);
          // Placeholder: on tablet/mobile show what we would inherit (the next
          // wider breakpoint's resolved value); on desktop show the variant
          // baseline so the user knows what they would get if left blank.
          let placeholder = '';
          if (bp !== 'desktop') {
            const inh = resolveResponsiveValue(subValue, bp === 'mobile' ? 'tablet' : 'desktop');
            placeholder = Number.isFinite(inh) ? `${inh} (inherit)` : 'inherit';
          } else if (baseline && Number.isFinite(baseline[f.key])) {
            placeholder = String(baseline[f.key]);
          }
          return (
            <div key={f.key} className="flex items-center gap-2">
              <Label className="text-xs w-20 shrink-0">{`${f.label}${bp !== 'desktop' ? ` (${bp})` : ''}`}</Label>
              <Input
                type="number"
                min={0}
                step={1}
                value={hasValue ? ownVal : ''}
                placeholder={placeholder}
                onChange={(e) => {
                  const raw = e.target.value;
                  writeOverride(f.key, raw === '' ? null : Number(raw));
                }}
                className="h-8"
                data-testid={`input-button-size-${f.key}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={!hasValue}
                onClick={() => writeOverride(f.key, null)}
                aria-label={`Use ${baselineLabel}`}
                title={`Use ${baselineLabel}`}
                data-testid={`button-button-size-${f.key}-reset`}
              >
                <RotateCcw className="w-4 h-4" />
              </Button>
            </div>
          );
        })}
      </div>
    </Field>
  );
}

function ButtonInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  // Pull tenant branding so we can append the tenant's free-form custom
  // button styles (task #960) to the Variant dropdown. The hook is the
  // same one ButtonRender uses, so the payload is cached.
  const branding = useTenantBranding()?.branding || null;
  const customStyleEntries = (() => {
    const styles =
      branding?.buttonStyles ||
      branding?.brandingConfig?.button_styles ||
      null;
    if (!styles || typeof styles !== 'object') return [];
    return Object.entries(styles)
      .filter(([k, v]) => k !== 'primary' && k !== 'secondary' && v && typeof v === 'object')
      .map(([k, v]) => ({ key: k, label: v.label || k }));
  })();
  // Task #962: resolve the effective default size for the currently
  // selected variant so the per-block override inputs can show those
  // values as placeholders ("the value you'd get if you leave this
  // blank"). Tenant variants resolve via the saved tenant style;
  // legacy variants resolve via the legacy size-class baseline.
  const variant = c.variant || 'default';
  const isTenantVar = isTenantButtonVariant(variant);
  const tenantStyleForBaseline = isTenantVar ? resolveTenantButtonStyle(variant, branding) : null;
  const inspectorSizeBaseline = isTenantVar
    ? { ...TENANT_BUTTON_DEFAULT_SIZE, ...(tenantStyleForBaseline?.size || {}) }
    : (LEGACY_BUTTON_SIZE_BASELINES[readLegacySizeClass(c)] || LEGACY_BUTTON_SIZE_BASELINES.default);
  const inspectorBaselineLabel = isTenantVar ? 'tenant default' : 'preset default';
  return (
    <>
      <TextField label="Label" value={c.label} onChange={(v) => set({ label: v })} testId="input-button-label" />
      <TypographyStyleField
        label="Label style"
        value={c.typographyStyleId}
        onChange={(id) => set({ typographyStyleId: id })}
        testId="select-button-typography"
      />
      <LinkField label="Link target" value={c.href} onChange={(v) => set({ href: v })} testId="input-button-href" />
      <MediaLibraryPickButton
        testId="button-button-media-library"
        onPick={(asset) => {
          if (!asset?.url) return;
          // Linking to a file (PDF etc.) should open/download in a new tab.
          set({ href: asset.url, newTab: true });
        }}
      />
      <SelectField
        label="Variant"
        value={c.variant || 'default'}
        onChange={(v) => set({ variant: v })}
        options={[
          { value: 'primary', label: 'Primary' },
          { value: 'default', label: 'Default' },
          { value: 'outline', label: 'Outline' },
          { value: 'ghost', label: 'Ghost' },
          { value: 'tenant-primary', label: 'Tenant primary (branded)' },
          { value: 'tenant-secondary', label: 'Tenant secondary (branded)' },
          ...customStyleEntries.map((e) => ({
            value: `tenant:${e.key}`,
            label: `Tenant: ${e.label}`,
          })),
        ]}
        testId="select-button-variant"
      />
      <SelectField
        label="Size preset"
        value={readLegacySizeClass(c)}
        onChange={(v) => {
          // Write new size class to `content.sizeClass`. Clear
          // historical string `content.size` so it doesn't collide with
          // the per-block override object that now lives there.
          update((b) => {
            const content = { ...(b.content || {}), sizeClass: v };
            if (typeof content.size === 'string') delete content.size;
            return { ...b, content };
          });
        }}
        options={[
          { value: 'sm', label: 'Small' },
          { value: 'default', label: 'Default' },
          { value: 'lg', label: 'Large' },
        ]}
        testId="select-button-size"
      />
      <SelectField
        label="Icon (optional)"
        value={c.icon || '__none__'}
        onChange={(v) => set({ icon: v === '__none__' ? '' : v })}
        options={[{ value: '__none__', label: 'None' }, ...Object.keys(LUCIDE_ICONS).map((n) => ({ value: n, label: n }))]}
        testId="select-button-icon"
      />
      <ButtonSizeOverridesField
        block={block}
        update={update}
        baseline={inspectorSizeBaseline}
        baselineLabel={inspectorBaselineLabel}
        breakpoint={breakpoint}
      />
      <ToggleField label="Open in new tab" value={c.newTab} onChange={(v) => set({ newTab: v })} testId="toggle-button-newtab" />
      <TextField label="ARIA label (optional)" value={c.ariaLabel} onChange={(v) => set({ ariaLabel: v })} testId="input-button-aria" />
    </>
  );
}

// VIDEO ----------------------------------------------------------------------
// Provider embeds are resolved through the server-side oEmbed proxy at
// /api/canvas/oembed so that supported providers' canonical embed HTML is
// used (rather than guessing iframe URLs from regex). Aspect ratio is
// applied to layout via CSS aspect-ratio on a centered inner wrapper so the
// configured ratio visibly drives rendered sizing.
function useOEmbed(provider, url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setData(null);
    setError(null);
    if (!url || (provider !== 'youtube' && provider !== 'vimeo')) return;
    let cancelled = false;
    fetch(`/api/canvas/oembed?url=${encodeURIComponent(url)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`oEmbed failed (${r.status})`);
        return r.json();
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); });
    return () => { cancelled = true; };
  }, [provider, url]);
  return { data, error };
}

function VideoRender({ block, asEditor }) {
  const c = block.content || {};
  const ratioStr = (c.aspectRatio || '16:9').replace(':', ' / ');
  const ar = aspectFromRatio(c.aspectRatio);
  const { data: oembed, error: oembedError } = useOEmbed(c.provider, c.url);

  const inner = (() => {
    if (!c.url) {
      return (
        <div className="w-full h-full flex items-center justify-center bg-black/90 text-white/70 text-xs">
          <Film className="w-6 h-6 mr-1" /> No video URL
        </div>
      );
    }
    if (c.provider === 'mp4') {
      return (
        <video
          src={c.url}
          controls={c.controls !== false}
          autoPlay={!!c.autoplay && !asEditor}
          muted={c.muted !== false}
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
          crossOrigin="anonymous"
        >
          {c.captionsUrl && (
            <track kind="captions" src={c.captionsUrl} srcLang="en" label="English" default />
          )}
        </video>
      );
    }
    if (oembedError) {
      return (
        <div className="w-full h-full flex items-center justify-center bg-black/90 text-white/70 text-xs px-2 text-center">
          Couldn’t load embed: {oembedError}
        </div>
      );
    }
    if (!oembed) {
      return (
        <div className="w-full h-full flex items-center justify-center bg-black/80 text-white/60 text-xs">
          Loading embed…
        </div>
      );
    }
    // The oEmbed `html` is provider-issued iframe markup. We inject it into
    // a wrapper styled to fill the aspect box so the embed sizes itself
    // correctly regardless of the width/height the provider reports.
    return (
      <div
        className="w-full h-full [&_iframe]:w-full [&_iframe]:h-full [&_iframe]:block [&_iframe]:border-0"
        title={block.a11y?.ariaLabel || oembed.title || 'Embedded video'}
        // oEmbed HTML from YouTube/Vimeo is trusted provider output (iframe).
        // We never accept arbitrary URLs — only host-allow-listed providers.
        dangerouslySetInnerHTML={{ __html: oembed.html || '' }}
      />
    );
  })();

  return (
    <div
      className="w-full h-full flex items-center justify-center"
      data-aspect={ar.toFixed(3)}
    >
      <div
        className="w-full max-h-full"
        style={{ aspectRatio: ratioStr, maxWidth: '100%' }}
      >
        {inner}
      </div>
    </div>
  );
}

function VideoInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <SelectField
        label="Provider"
        value={c.provider || 'youtube'}
        onChange={(v) => set({ provider: v })}
        options={[
          { value: 'youtube', label: 'YouTube' },
          { value: 'vimeo', label: 'Vimeo' },
          { value: 'mp4', label: 'Direct video (mp4)' },
        ]}
        testId="select-video-provider"
      />
      <TextField label="Video URL" value={c.url} onChange={(v) => set({ url: v })} testId="input-video-url" />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() => {
          if (typeof window === 'undefined') return;
          // Open the shared media library filtered to videos so the
          // picker only shows mp4/webm/ogg assets; the picked URL flows
          // back into the block's `url` content field.
          window.dispatchEvent(new CustomEvent('canvas:open-media-library', {
            detail: {
              kind: 'video',
              onPick: (asset) => { if (asset?.url) set({ provider: 'mp4', url: asset.url }); },
            },
          }));
        }}
        data-testid="button-video-media-library"
      >
        <Images className="w-4 h-4 mr-2" />
        Choose from media library (video)
      </Button>
      <SelectField
        label="Aspect ratio"
        value={c.aspectRatio || '16:9'}
        onChange={(v) => set({ aspectRatio: v })}
        options={[
          { value: '16:9', label: '16:9' },
          { value: '4:3', label: '4:3' },
          { value: '1:1', label: '1:1' },
          { value: '21:9', label: '21:9' },
        ]}
        testId="select-video-aspect"
      />
      <TextField label="Captions URL (VTT, for mp4)" value={c.captionsUrl} onChange={(v) => set({ captionsUrl: v })} testId="input-video-captions" />
      <ToggleField label="Autoplay" value={c.autoplay} onChange={(v) => set({ autoplay: v })} testId="toggle-video-autoplay" />
      <ToggleField label="Muted" value={c.muted !== false} onChange={(v) => set({ muted: v })} testId="toggle-video-muted" />
      <ToggleField label="Show controls" value={c.controls !== false} onChange={(v) => set({ controls: v })} testId="toggle-video-controls" />
    </>
  );
}

// COLUMNS --------------------------------------------------------------------
// CSS-driven multi-column block. The editor used to swap flex widths at
// runtime based on the active breakpoint prop — that meant SSR/public
// pages rendered desktop widths on mobile until JS booted (a layout
// regression for canvas pages). We now emit a per-instance <style> tag
// with @media queries so the browser handles width + stacking with zero
// JS. When the editor forces a breakpoint via `?_bp=`, we still respect
// it by emitting an unscoped override style block.
function buildColumnsCss(scope, items, widthsByBp, gap, stackOnMobile) {
  const n = items.length || 1;
  const gp = Number(gap) || 0;
  const widthRule = (bp) => {
    const list = (widthsByBp && widthsByBp[bp]) || [];
    const rules = [];
    for (let i = 0; i < n; i++) {
      const pct = Number(list[i]) || (100 / n);
      rules.push(`${scope} > :nth-child(${i + 1}){flex:0 0 calc(${pct}% - ${(gp * (n - 1)) / n}px);}`);
    }
    return rules.join('');
  };
  const desktop = `${scope}{display:flex;flex-direction:row;gap:${gp}px;}` + widthRule('desktop');
  const tablet = `@media (max-width: 1023.98px){${widthRule('tablet')}}`;
  const mobile = stackOnMobile
    ? `@media (max-width: 639.98px){${scope}{flex-direction:column;}${scope} > *{flex:1 1 100%!important;}}`
    : `@media (max-width: 639.98px){${widthRule('mobile')}}`;
  return desktop + tablet + mobile;
}

function ColumnsRender({ block, breakpoint }) {
  const c = block.content || {};
  const items = c.items || [];
  const gap = c.gap || 0;
  const scopeId = `cb-cols-${String(block.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  // For the editor preview chips (`?_bp=` forces a breakpoint), apply
  // inline width/stacking so the visual matches what visitors at that
  // breakpoint will see. The CSS stylesheet below still drives real
  // public pages on any actual device width.
  const forcedWidths = breakpoint ? ((c.widths && c.widths[breakpoint]) || c.widths?.desktop || []) : null;
  const forcedStack = !!(breakpoint === 'mobile' && c.stackOnMobile);
  const cssText = useMemo(
    () => buildColumnsCss(`#${scopeId}`, items, c.widths || {}, gap, !!c.stackOnMobile),
    [scopeId, items, c.widths, gap, c.stackOnMobile],
  );
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: cssText }} />
      <div
        id={scopeId}
        className="w-full h-full"
        style={breakpoint ? { display: 'flex', flexDirection: forcedStack ? 'column' : 'row', gap } : undefined}
      >
        {items.map((it, i) => {
          const forcedStyle = breakpoint
            ? {
                flex: forcedStack
                  ? '1 1 100%'
                  : `0 0 calc(${(forcedWidths && forcedWidths[i]) || (100 / items.length)}% - ${(gap * (items.length - 1)) / items.length}px)`,
              }
            : undefined;
          return (
            <div key={i} style={forcedStyle} className="overflow-auto">
              <div
                className="prose prose-sm max-w-none [&_p:last-child]:mb-0"
                dangerouslySetInnerHTML={{ __html: sanitizeRichText(stripTrailingEmptyParagraphs(it.html || '')) }}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

function ColumnsInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const setCount = (n) => {
    n = Math.max(1, Math.min(4, n));
    const items = [...(c.items || [])];
    while (items.length < n) items.push({ html: `<p>Column ${items.length + 1}</p>` });
    items.length = n;
    const widths = { ...(c.widths || {}) };
    for (const bp of ['desktop', 'tablet', 'mobile']) {
      const list = widths[bp] || [];
      while (list.length < n) list.push(Math.round(100 / n));
      list.length = n;
      const sum = list.reduce((a, b) => a + b, 0);
      if (sum > 0) widths[bp] = list.map((v) => Math.round((v / sum) * 100));
    }
    set({ count: n, items, widths });
  };
  return (
    <>
      <NumberField label="Number of columns" min={1} max={4} value={c.count || 2} onChange={(v) => setCount(Number(v) || 1)} testId="input-columns-count" />
      <NumberField label="Gap (px)" min={0} value={c.gap || 0} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-columns-gap" />
      <ToggleField label="Stack on mobile" value={!!c.stackOnMobile} onChange={(v) => set({ stackOnMobile: v })} testId="toggle-columns-stack" />
      {['desktop', 'tablet', 'mobile'].map((bp) => (
        <Field key={bp} label={`Widths on ${bp} (%)`}>
          <div className="grid grid-cols-4 gap-1">
            {(c.widths?.[bp] || []).map((w, i) => (
              <Input
                key={i}
                type="number" min={0} max={100} value={w}
                onChange={(e) => {
                  const next = [...(c.widths?.[bp] || [])];
                  next[i] = Number(e.target.value) || 0;
                  set({ widths: { ...c.widths, [bp]: next } });
                }}
                className="h-8 text-xs"
                data-testid={`input-columns-w-${bp}-${i}`}
              />
            ))}
          </div>
        </Field>
      ))}
      <Field label="Column content">
        <ArrayList
          items={c.items || []}
          onChange={(next) => set({ items: next })}
          makeNew={() => ({ html: '<p>New column</p>' })}
          addLabel="Add column"
          testIdPrefix="columns"
          renderItem={(item, idx, patch) => (
            <RichTextField
              label={`Column ${idx + 1}`}
              value={item.html}
              onChange={(v) => patch({ html: v })}
              testId={`columns-${idx}-html`}
            />
          )}
        />
      </Field>
    </>
  );
}

// SPACER ---------------------------------------------------------------------
function SpacerRender({ block }) {
  return <div className="w-full h-full" aria-hidden="true" />;
}

function SpacerInspector() {
  // Spacer height is driven entirely by the block's breakpoint geometry
  // (Position panel → Height per Desktop/Tablet/Mobile). We intentionally
  // don't duplicate height controls here to avoid two sources of truth.
  return (
    <p className="text-xs text-slate-500" data-testid="info-spacer">
      Spacer height is controlled by the block&apos;s height on each breakpoint —
      adjust it from the Position panel above.
    </p>
  );
}

// DIVIDER --------------------------------------------------------------------
function DividerRender({ block }) {
  const c = block.content || {};
  return (
    <div className="w-full h-full flex items-center">
      <hr
        className="w-full m-0"
        style={{
          borderTopWidth: c.thickness || 1,
          borderTopStyle: c.lineStyle || 'solid',
          borderColor: c.color || '#e2e8f0',
          borderRight: 0, borderBottom: 0, borderLeft: 0,
        }}
      />
    </div>
  );
}

function DividerInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <SelectField
        label="Line style"
        value={c.lineStyle || 'solid'}
        onChange={(v) => set({ lineStyle: v })}
        options={[
          { value: 'solid', label: 'Solid' },
          { value: 'dashed', label: 'Dashed' },
          { value: 'dotted', label: 'Dotted' },
        ]}
        testId="select-divider-style"
      />
      <ColorField label="Colour" value={c.color} onChange={(v) => set({ color: v })} testId="input-divider-color" />
      <NumberField label="Thickness (px)" min={1} max={20} value={c.thickness || 1} onChange={(v) => set({ thickness: Math.max(1, Number(v) || 1) })} testId="input-divider-thickness" />
    </>
  );
}

// ACCORDION ------------------------------------------------------------------
// Structured link icon set — kept in lockstep with the iedit accordion
// (IEditAccordionElement.jsx) so the two builders feel consistent.
const ACCORDION_LINK_ICON_TYPES = [
  { value: 'external', label: 'External Link', icon: ExternalLink },
  { value: 'document', label: 'Document', icon: FileText },
  { value: 'video', label: 'Video', icon: Video },
  { value: 'download', label: 'Download', icon: Download },
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'phone', label: 'Phone', icon: Phone },
  { value: 'link', label: 'Generic Link', icon: LinkIcon },
  { value: 'image', label: 'Image', icon: ImageIcon },
  { value: 'audio', label: 'Audio', icon: Music },
  { value: 'calendar', label: 'Calendar/Event', icon: Calendar },
  { value: 'location', label: 'Location', icon: MapPin },
  { value: 'resource', label: 'Resource', icon: BookOpen },
];

function getAccordionLinkIcon(iconType) {
  const found = ACCORDION_LINK_ICON_TYPES.find((t) => t.value === iconType);
  return found ? found.icon : ExternalLink;
}

// Suggest an accordion link icon type from a media-library asset's mime type,
// falling back to the URL extension when mime_type is missing (URL-only
// assets). Returns one of the ACCORDION_LINK_ICON_TYPES values.
function suggestAccordionLinkIcon(asset) {
  const m = String(asset?.mime_type || '').toLowerCase();
  const u = String(asset?.url || '').toLowerCase();
  if (m.startsWith('video/') || /\.(mp4|webm|ogv|mov)(\?|$)/.test(u)) return 'video';
  if (m.startsWith('image/') || /\.(jpe?g|png|gif|webp|svg)(\?|$)/.test(u)) return 'image';
  if (m.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac)(\?|$)/.test(u)) return 'audio';
  if (m === 'application/pdf' || /\.(pdf|docx?|xlsx?|pptx?|txt|csv|rtf|odt)(\?|$)/.test(u)) return 'document';
  return 'download';
}

// Button that opens the shared MediaLibraryDialog so an author can attach a
// document/video/image to a link (accordion links, CTA buttons, etc.),
// mirroring how ImageField wires up the 'canvas:open-media-library' window
// event. No `kind` filter is passed so every asset type (documents included)
// is selectable.
function MediaLibraryPickButton({ onPick, testId }) {
  const openLibrary = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('canvas:open-media-library', {
      detail: { onPick },
    }));
  };
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={openLibrary}
      className="w-full"
      data-testid={testId}
    >
      <Images className="w-4 h-4 mr-2" />
      Choose from media library
    </Button>
  );
}

function AccordionRender({ block, asEditor }) {
  const c = block.content || {};
  // Controlled open-state so we can enforce expandOne (only one item open at
  // a time). When expandOne is false the user can open as many as they like.
  const [openIds, setOpenIds] = useState([]);
  const items = c.items || [];
  const questionStyle = Number.isFinite(c.questionFontSize)
    ? { fontSize: `${c.questionFontSize}px` }
    : undefined;
  const itemGap = Number.isFinite(c.itemGap) ? Math.max(0, c.itemGap) : 8;
  const toggle = (idx) => {
    setOpenIds((prev) => {
      const isOpen = prev.includes(idx);
      if (c.expandOne) return isOpen ? [] : [idx];
      return isOpen ? prev.filter((i) => i !== idx) : [...prev, idx];
    });
  };

  // Report our rendered height to the AccordionReflowContext so that the
  // canvas renderers can shift blocks below us down by the right delta.
  const reflow = useAccordionReflow();
  const containerRef = useRef(null);

  // Synchronous initial measurement before first paint so that blocks below
  // are already at their correct positions on the first committed frame
  // (avoids a visible layout jump when stored height != natural collapsed height).
  useLayoutEffect(() => {
    if (!reflow || !containerRef.current) return;
    const h = containerRef.current.getBoundingClientRect().height;
    if (h > 0) reflow.reportHeight(block.id, Math.round(h));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally mount-only; ResizeObserver below handles ongoing changes

  // Ongoing measurement via ResizeObserver for expand / collapse events.
  useEffect(() => {
    if (!reflow || !containerRef.current) return;
    const el = containerRef.current;
    const report = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) reflow.reportHeight(block.id, Math.round(h));
    };
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [reflow, block.id]);

  return (
    <div
      ref={containerRef}
      className="w-full flex flex-col"
      style={{ gap: `${itemGap}px` }}
      role="region"
      aria-label={block.a11y?.ariaLabel || 'Frequently asked questions'}
    >
      {items.map((item, i) => {
        const isOpen = openIds.includes(i);
        const headingId = `${block.id}-acc-h-${i}`;
        const panelId = `${block.id}-acc-p-${i}`;
        return (
          <div key={i} className="rounded-md border border-slate-200 bg-white">
            <h3 className="m-0">
              <button
                type="button"
                id={headingId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(i)}
                style={questionStyle}
                className="w-full px-3 py-2 cursor-pointer font-medium text-sm flex items-center justify-between text-left hover-elevate active-elevate-2"
              >
                <span>{item.q || `Question ${i + 1}`}</span>
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={headingId}
              hidden={!isOpen}
              className="px-3 pb-3 pt-2 bg-slate-50 rounded-b-md"
            >
              <div
                className="prose prose-sm max-w-none [&_p:last-child]:mb-0"
                dangerouslySetInnerHTML={{ __html: sanitizeRichText(stripTrailingEmptyParagraphs(item.a || '')) }}
              />
              {Array.isArray(item.links) && item.links.length > 0 && (
                <div className="mt-4 pt-3 border-t border-slate-200">
                  <div className="flex flex-wrap gap-3">
                    {item.links.map((link, linkIndex) => {
                      const IconComponent = getAccordionLinkIcon(link.iconType);
                      const newTab = link.openInNewTab !== false;
                      const chipClass =
                        'inline-flex items-center gap-2 px-3 py-2 rounded-md bg-white border border-slate-200 text-blue-600 hover-elevate text-sm font-medium';
                      const inner = (
                        <>
                          <IconComponent className="w-4 h-4 flex-shrink-0" />
                          <span>{link.label || 'Link'}</span>
                        </>
                      );
                      return (
                        <MegaLink
                          key={linkIndex}
                          href={link.url}
                          openInNewTab={newTab}
                          asEditor={asEditor}
                          className={chipClass}
                          testId={`accordion-link-${i}-${linkIndex}`}
                        >
                          {inner}
                        </MegaLink>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AccordionInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <ToggleField label="Expand one at a time" value={!!c.expandOne} onChange={(v) => set({ expandOne: v })} testId="toggle-accordion-expand-one" />
      <NumberField
        label="Question font size (px)"
        min={8}
        max={72}
        value={c.questionFontSize}
        onChange={(v) => set({ questionFontSize: v == null ? null : Math.max(8, Math.min(72, Number(v))) })}
        testId="input-accordion-question-font-size"
      />
      <NumberField
        label="Gap between items (px)"
        min={0}
        max={64}
        value={Number.isFinite(c.itemGap) ? c.itemGap : 8}
        onChange={(v) => set({ itemGap: v == null ? 8 : Math.max(0, Math.min(64, Number(v))) })}
        testId="input-accordion-item-gap"
      />
      <Field label="Items">
        <ArrayList
          items={c.items || []}
          onChange={(next) => set({ items: next })}
          makeNew={() => ({ q: 'New question?', a: '<p>Answer</p>' })}
          addLabel="Add item"
          testIdPrefix="accordion"
          renderItem={(item, idx, patch) => (
            <>
              <TextField label="Question" value={item.q} onChange={(v) => patch({ q: v })} testId={`accordion-${idx}-q`} />
              <RichTextField label="Answer" value={item.a} onChange={(v) => patch({ a: v })} testId={`accordion-${idx}-a`} />
              <Field label="Links">
                <ArrayList
                  items={item.links || []}
                  onChange={(nextLinks) => patch({ links: nextLinks })}
                  makeNew={() => ({ label: 'New link', url: '', iconType: 'external', openInNewTab: true })}
                  addLabel="Add link"
                  testIdPrefix={`accordion-${idx}-links`}
                  renderItem={(link, linkIdx, patchLink) => (
                    <>
                      <TextField label="Label" value={link.label} onChange={(v) => patchLink({ label: v })} testId={`accordion-${idx}-link-${linkIdx}-label`} />
                      <LinkField label="URL" value={link.url} onChange={(v) => patchLink({ url: v })} testId={`accordion-${idx}-link-${linkIdx}-url`} />
                      <MediaLibraryPickButton
                        testId={`accordion-${idx}-link-${linkIdx}-media`}
                        onPick={(asset) => {
                          if (!asset?.url) return;
                          const patchData = { url: asset.url, iconType: suggestAccordionLinkIcon(asset) };
                          // Only auto-fill the label when the author hasn't set
                          // one yet (empty or still the default placeholder).
                          if (!link.label || link.label === 'New link') {
                            patchData.label = asset.name || asset.alt_text || asset.url;
                          }
                          patchLink(patchData);
                        }}
                      />
                      <SelectField
                        label="Icon"
                        value={link.iconType || 'external'}
                        onChange={(v) => patchLink({ iconType: v })}
                        options={ACCORDION_LINK_ICON_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                        testId={`accordion-${idx}-link-${linkIdx}-icon`}
                      />
                      <ToggleField
                        label="Open in new tab"
                        value={link.openInNewTab !== false}
                        onChange={(v) => patchLink({ openInNewTab: v })}
                        testId={`accordion-${idx}-link-${linkIdx}-newtab`}
                      />
                    </>
                  )}
                />
              </Field>
            </>
          )}
        />
      </Field>
    </>
  );
}

// TESTIMONIALS ---------------------------------------------------------------
function TestimonialsRender({ block, breakpoint }) {
  const c = block.content || {};
  const items = c.items || [];
  // Resolve tenant typography styles for the quote text and the
  // author/role attribution, mirroring how Card/Hero consume them. When
  // unset (or the chosen style is later deleted) we fall back to the
  // original Tailwind sizes (text-sm / text-xs).
  const { styles: tenantStyles, resolved: stylesResolved } = useTenantTypographyStylesState();
  const quoteStyleObj = resolveTenantStyle(c.quoteTypographyStyleId, tenantStyles);
  const attributionStyleObj = resolveTenantStyle(c.attributionTypographyStyleId, tenantStyles);
  const awaitingQuote = isAwaitingTypographyStyle(c.quoteTypographyStyleId, quoteStyleObj, stylesResolved);
  const awaitingAttribution = isAwaitingTypographyStyle(c.attributionTypographyStyleId, attributionStyleObj, stylesResolved);
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const bpForInline = isPreview ? breakpoint : 'desktop';
  if (items.length === 0) return null;
  // When awaiting an unresolved style, carry a `visibility: hidden` inline
  // style (truthy) so the legacy text-sm/text-xs class is also dropped and
  // the default size never flashes before the custom style arrives.
  let quoteInline = quoteStyleObj
    ? buildTypographyInlineStyle(quoteStyleObj, { breakpoint: bpForInline })
    : null;
  if (awaitingQuote) quoteInline = { ...(quoteInline || {}), visibility: 'hidden' };
  let attributionInline = attributionStyleObj
    ? buildTypographyInlineStyle(attributionStyleObj, { breakpoint: bpForInline })
    : null;
  if (awaitingAttribution) attributionInline = { ...(attributionInline || {}), visibility: 'hidden' };
  // Internal card padding — defaults to the original 12px; an explicit 0
  // is honoured (matches the Card block's contentPadding behaviour).
  const cardPadding = c.cardPadding == null ? 12 : (Number(c.cardPadding) || 0);
  // Card colours default to the original white/slate look when unset.
  const cardBg = c.cardBgColor || '#ffffff';
  const cardBorder = c.cardBorderColor || '#e2e8f0';
  const containerClass =
    c.layout === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'
      : c.layout === 'carousel' ? 'flex gap-3 overflow-x-auto snap-x'
      : 'flex flex-col gap-3';
  return (
    <div className={`w-full h-full overflow-auto ${containerClass}`}>
      {items.map((t, i) => (
        <figure
          key={i}
          className="rounded-md border min-w-[240px] snap-start"
          style={{ padding: cardPadding, background: cardBg, borderColor: cardBorder }}
        >
          <Quote className="w-4 h-4 text-slate-400 mb-1" aria-hidden="true" />
          <blockquote className={quoteInline ? 'text-slate-800' : 'text-sm text-slate-800'} style={quoteInline || undefined}>{t.quote}</blockquote>
          <figcaption className={`mt-2 flex items-center gap-2 ${attributionInline ? 'text-slate-600' : 'text-xs text-slate-600'}`} style={attributionInline || undefined}>
            {t.photo ? (
              <img src={t.photo} alt="" loading="lazy" decoding="async" className="w-6 h-6 rounded-full object-cover" />
            ) : null}
            <div>
              <div className="font-medium text-slate-900">{t.author}</div>
              {t.role && <div className="text-slate-500">{t.role}</div>}
            </div>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function TestimonialsInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <SelectField
        label="Layout"
        value={c.layout || 'grid'}
        onChange={(v) => set({ layout: v })}
        options={[
          { value: 'single', label: 'Single' },
          { value: 'carousel', label: 'Carousel' },
          { value: 'grid', label: 'Grid' },
        ]}
        testId="select-testimonials-layout"
      />
      <NumberField
        label="Card padding (px)"
        value={c.cardPadding == null ? 12 : c.cardPadding}
        onChange={(v) => set({ cardPadding: v })}
        min={0}
        max={64}
        testId="input-testimonials-card-padding"
      />
      <ColorField
        label="Card background colour"
        value={c.cardBgColor}
        onChange={(v) => set({ cardBgColor: v })}
        testId="input-testimonials-card-bg-color"
      />
      <ColorField
        label="Card border colour"
        value={c.cardBorderColor}
        onChange={(v) => set({ cardBorderColor: v })}
        testId="input-testimonials-card-border-color"
      />
      <TypographyStyleField
        label="Quote style"
        value={c.quoteTypographyStyleId}
        onChange={(id) => set({ quoteTypographyStyleId: id })}
        testId="select-testimonials-quote-typography"
      />
      <TypographyStyleField
        label="Attribution style"
        value={c.attributionTypographyStyleId}
        onChange={(id) => set({ attributionTypographyStyleId: id })}
        testId="select-testimonials-attribution-typography"
      />
      <ToggleField
        label="Full-bleed (span full screen width)"
        value={!!c.fullBleed}
        onChange={(v) => set({ fullBleed: v })}
        testId="toggle-testimonials-full-bleed"
      />
      <Field label="Items">
        <ArrayList
          items={c.items || []}
          onChange={(next) => set({ items: next })}
          makeNew={() => ({ quote: 'A quote.', author: 'Name', role: '', photo: '' })}
          addLabel="Add testimonial"
          testIdPrefix="testimonials"
          renderItem={(item, idx, patch) => (
            <>
              <TextField label="Quote" multiline value={item.quote} onChange={(v) => patch({ quote: v })} testId={`testimonials-${idx}-quote`} />
              <TextField label="Author" value={item.author} onChange={(v) => patch({ author: v })} testId={`testimonials-${idx}-author`} />
              <TextField label="Role" value={item.role} onChange={(v) => patch({ role: v })} testId={`testimonials-${idx}-role`} />
              <ImageField
                label="Photo (optional)"
                value={item.photo}
                onChangeSrc={(v) => patch({ photo: v })}
                testId={`testimonials-${idx}-photo`}
              />
            </>
          )}
        />
      </Field>
    </>
  );
}

// CUSTOM HTML ----------------------------------------------------------------
function CustomHtmlRender({ block }) {
  const c = block.content || {};
  return (
    <div
      className="w-full h-full overflow-auto"
      dangerouslySetInnerHTML={{ __html: sanitizeCustomHtml(c.html || '') }}
    />
  );
}

function CustomHtmlInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  // Sanitize when the user leaves the textarea so they can paste raw markup
  // without it being mangled mid-edit, but the persisted value is always safe.
  return (
    <>
      <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
        Custom HTML is sanitised on save and on render, but you should still use this
        block carefully. Scripts, styles, iframes and form elements are stripped.
      </div>
      <Field label="HTML">
        <Textarea
          value={c.html || ''}
          onChange={(e) => set({ html: e.target.value })}
          onBlur={(e) => set({ html: sanitizeCustomHtml(e.target.value || '') })}
          rows={8}
          className="font-mono text-xs"
          data-testid="input-custom-html"
        />
      </Field>
    </>
  );
}

// ICON -----------------------------------------------------------------------
function IconRender({ block, breakpoint }) {
  const c = block.content || {};
  const Icon = getLucideIcon(c.icon) || Star;
  // Task #970: `c.size` is now per-device. Falls back to 48 (legacy default)
  // when nothing resolves at this breakpoint, matching prior behaviour.
  // Task #972: in real public renders (no forced breakpoint) the per-device
  // value is delivered through the `--cb-icon-size` CSS var emitted by
  // `buildCanvasCss`, so @media rules drive the size with zero JS. In
  // forced-preview / editor mode we still resolve in JS and inline the px
  // so the preview chip wins over the @media rules.
  const isForcedPreview = !!breakpoint;
  const resolvedSize = resolveResponsiveValue(c.size, breakpoint);
  let widthVal;
  let heightVal;
  if (isForcedPreview) {
    const size = Number.isFinite(resolvedSize) ? resolvedSize : 48;
    widthVal = size;
    heightVal = size;
  } else if (hasAnyResponsiveValue(c.size)) {
    widthVal = 'var(--cb-icon-size, 48px)';
    heightVal = 'var(--cb-icon-size, 48px)';
  } else {
    widthVal = 48;
    heightVal = 48;
  }
  return (
    <div className="w-full h-full flex items-center justify-center">
      <Icon
        style={{ color: c.color || '#0f172a', width: widthVal, height: heightVal }}
        aria-label={c.ariaLabel || undefined}
        aria-hidden={c.ariaLabel ? undefined : true}
      />
    </div>
  );
}

function IconInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <SelectField
        label="Icon"
        value={c.icon || 'Star'}
        onChange={(v) => set({ icon: v })}
        options={Object.keys(LUCIDE_ICONS).map((n) => ({ value: n, label: n }))}
        testId="select-icon-name"
      />
      <ColorField label="Colour" value={c.color} onChange={(v) => set({ color: v })} testId="input-icon-color" />
      <ResponsiveNumberField
        label="Size (px)"
        min={8}
        max={256}
        value={c.size}
        breakpoint={breakpoint}
        onChange={(v) => set({ size: v })}
        testId="input-icon-size"
        placeholder="48"
      />
      <TextField label="ARIA label (if meaningful)" value={c.ariaLabel} onChange={(v) => set({ ariaLabel: v })} testId="input-icon-aria" />
    </>
  );
}

// CARD -----------------------------------------------------------------------
// Sanitize an author-supplied Font Awesome class string. Only tokens that
// start with `fa` and consist of [a-z0-9-] survive (e.g. `fa-solid`,
// `fa-book-open`, legacy `fas`/`fab`). This blocks arbitrary class injection
// while allowing every Font Awesome style prefix + icon name.
function sanitizeFaIconClass(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .split(/\s+/)
    .filter((t) => /^fa[a-z0-9-]*$/.test(t))
    .join(' ');
}

// Card drop-shadow presets, mirroring Tailwind's shadow scale.
const CARD_SHADOW_PRESETS = {
  none: null,
  sm: '0 1px 2px 0 rgba(0,0,0,0.05)',
  md: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
  lg: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
};

function CardRender({ block, asEditor, priority, breakpoint }) {
  const c = block.content || {};
  // Tenant typography style takes precedence for the card title — the
  // outer tag follows the style's `style_type` and inline styles carry
  // font-family/size/weight/etc. Falls back to the legacy `headingLevel`
  // when no style is set or the chosen style id can't be resolved.
  const { styles: tenantStyles, resolved: stylesResolved } = useTenantTypographyStylesState();
  const headingStyleObj = resolveTenantStyle(c.headingTypographyStyleId, tenantStyles);
  const awaitingHeading = isAwaitingTypographyStyle(c.headingTypographyStyleId, headingStyleObj, stylesResolved);
  const Heading = headingStyleObj
    ? tagForTypographyStyleType(headingStyleObj.style_type)
    : `h${Math.max(1, Math.min(6, c.headingLevel || 3))}`;
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const bpForInline = isPreview ? breakpoint : 'desktop';
  const headingInline = headingStyleObj
    ? { margin: 0, ...buildTypographyInlineStyle(headingStyleObj, { breakpoint: bpForInline }) }
    : { margin: 0, fontSize: '1.125rem', fontWeight: 600 };
  if (awaitingHeading) headingInline.visibility = 'hidden';
  // Inner padding applied to the text/CTA area only — the image stays
  // full-bleed against the card edges. Defaults to 16; an explicit 0 is
  // honoured so authors can opt back into a flush layout.
  const contentPadding = c.contentPadding == null ? 16 : (Number(c.contentPadding) || 0);
  const ctaJustify = c.ctaAlign === 'center'
    ? 'center'
    : c.ctaAlign === 'right' ? 'flex-end' : 'flex-start';
  const safeBlockId = String(block.id || '').replace(/["\\]/g, '');
  const cardResponsiveCss = !isPreview && headingStyleObj && hasResponsiveTypographyOverride(headingStyleObj)
    ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="card-heading"]`, headingStyleObj)
    : null;

  // Branding + hover state drive the optional tenant-styled CTA (mirrors
  // ButtonRender). Declared unconditionally so hook order stays stable.
  const branding = useTenantBranding()?.branding || null;
  const [ctaHovered, setCtaHovered] = useState(false);

  const cardRadius = (block.style && block.style.borderRadius) || 0;
  const imageMode = c.imageDisplayMode === 'inline' ? 'inline' : 'full-bleed';
  const alignToJustify = (a) => (a === 'center' ? 'center' : a === 'right' ? 'flex-end' : 'flex-start');

  // Drop shadow + highlight ring → combined box-shadow on the card surface.
  // Needs `allowOverflow` on the registry entry so the wrapper's
  // `overflow: hidden` doesn't clip it.
  const shadowParts = [];
  const shadowPreset = CARD_SHADOW_PRESETS[c.shadow];
  if (shadowPreset) shadowParts.push(shadowPreset);
  if (c.highlight) shadowParts.push(`0 0 0 3px ${c.highlightColor || '#3b82f6'}`);
  const cardBoxShadow = shadowParts.length ? shadowParts.join(', ') : undefined;

  const iconClass = sanitizeFaIconClass(c.iconClass);
  // null = "not set by author" → fall back to legacy per-element defaults
  // (mb-2 for icon/inline image, no margin for full-bleed).
  const headerSpacingPx = (c.headerSpacing != null && Number.isFinite(Number(c.headerSpacing)))
    ? Number(c.headerSpacing)
    : null;

  return (
    <div
      className="w-full h-full flex flex-col"
      style={cardBoxShadow ? { boxShadow: cardBoxShadow, borderRadius: cardRadius } : undefined}
    >
      {cardResponsiveCss && (
        <style dangerouslySetInnerHTML={{ __html: cardResponsiveCss }} />
      )}
      {c.imageUrl && imageMode === 'full-bleed' && (() => {
        const r = buildResponsiveImage(c.imageUrl, { sizes: '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw' });
        // Full-bleed header image: round its top corners to match the card
        // radius and square the bottom, since the padded text area sits below.
        return (
          <img
            src={r.src}
            srcSet={r.srcSet}
            sizes={r.sizes}
            alt={c.imageAlt || ''}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            fetchpriority={priority ? 'high' : undefined}
            className="w-full"
            style={{
              height: 160,
              objectFit: 'cover',
              borderTopLeftRadius: cardRadius,
              borderTopRightRadius: cardRadius,
              // Only apply when the author has explicitly set headerSpacing;
              // full-bleed images previously had no bottom margin so we must
              // not add one to legacy cards (where headerSpacing is null/undefined).
              marginBottom: c.headerSpacing != null ? headerSpacingPx : undefined,
            }}
          />
        );
      })()}
      <div className="flex-1 flex flex-col min-h-0" style={{ padding: contentPadding }}>
        {iconClass && (
          <div
            className={`flex${headerSpacingPx == null ? ' mb-2' : ''}`}
            style={{ justifyContent: alignToJustify(c.iconAlign), ...(headerSpacingPx != null ? { marginBottom: headerSpacingPx } : {}) }}
          >
            <i
              className={iconClass}
              aria-hidden="true"
              style={{
                fontSize: Number.isFinite(Number(c.iconSize)) && Number(c.iconSize) > 0 ? Number(c.iconSize) : 32,
                color: c.iconColor || undefined,
                lineHeight: 1,
              }}
            />
          </div>
        )}
        {c.imageUrl && imageMode === 'inline' && (() => {
          const r = buildResponsiveImage(c.imageUrl, { sizes: '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw' });
          const pct = Number.isFinite(Number(c.imageWidthPct)) ? Math.max(5, Math.min(100, Number(c.imageWidthPct))) : 100;
          return (
            <div
              className={`flex${headerSpacingPx == null ? ' mb-2' : ''}`}
              style={{ justifyContent: alignToJustify(c.imageAlign), ...(headerSpacingPx != null ? { marginBottom: headerSpacingPx } : {}) }}
            >
              <img
                src={r.src}
                srcSet={r.srcSet}
                sizes={r.sizes}
                alt={c.imageAlt || ''}
                loading={priority ? 'eager' : 'lazy'}
                decoding="async"
                fetchpriority={priority ? 'high' : undefined}
                style={{
                  width: `${pct}%`,
                  height: 'auto',
                  display: 'block',
                  borderRadius: cardRadius,
                }}
              />
            </div>
          );
        })()}
        <Heading style={headingInline} data-tg-r="card-heading">
          {c.heading}
        </Heading>
        <div
          className="prose prose-sm max-w-none mt-1 flex-1 [&_p:last-child]:mb-0"
          dangerouslySetInnerHTML={{ __html: sanitizeRichText(stripTrailingEmptyParagraphs(c.body || '')) }}
        />
        {c.ctaEnabled !== false && c.ctaLabel && (() => {
          const ctaLabelStyleObj = resolveTenantStyle(c.ctaLabelTypographyStyleId, tenantStyles);
          const awaitingCtaLabel = isAwaitingTypographyStyle(c.ctaLabelTypographyStyleId, ctaLabelStyleObj, stylesResolved);
          const ctaLabelInline = ctaLabelStyleObj
            ? buildTypographyInlineStyle(ctaLabelStyleObj)
            : (awaitingCtaLabel ? { visibility: 'hidden' } : null);
          const ctaVariant = c.ctaVariant || 'outline';
          // Tenant-styled CTA: route through the shared tenant button resolver
          // exactly like ButtonRender so background/border/radius/hover honour
          // the tenant's saved button styles.
          const isTenantVariant = isTenantButtonVariant(ctaVariant);
          const tenantStyle = isTenantVariant ? resolveTenantButtonStyle(ctaVariant, branding) : null;
          if (isTenantVariant && tenantStyle) {
            const baseline = { ...TENANT_BUTTON_DEFAULT_SIZE, ...(tenantStyle.size || {}) };
            const bg = bgCssFromConfig(ctaHovered ? tenantStyle.hover : tenantStyle.background) || {};
            const border = tenantStyle.border || {};
            const inlineStyle = {
              ...bg,
              color: ctaHovered
                ? tenantStyle.hoverTextColor || tenantStyle.textColor || '#ffffff'
                : tenantStyle.textColor || '#ffffff',
              borderRadius: `${tenantStyle.radius ?? 6}px`,
              border:
                border.width > 0
                  ? `${border.width}px ${border.style || 'solid'} ${border.color || '#000000'}`
                  : 'none',
              paddingTop: baseline.paddingY,
              paddingBottom: baseline.paddingY,
              paddingLeft: baseline.paddingX,
              paddingRight: baseline.paddingX,
              fontSize: baseline.fontSize,
              transition: 'background-color 0.2s ease, color 0.2s ease, background 0.2s ease',
            };
            return (
              <div className="mt-2 flex" style={{ justifyContent: ctaJustify }}>
                <a
                  href={asEditor ? undefined : (c.ctaHref || '#')}
                  className="inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap"
                  style={inlineStyle}
                  onMouseEnter={() => setCtaHovered(true)}
                  onMouseLeave={() => setCtaHovered(false)}
                  onClick={(e) => { if (asEditor) e.preventDefault(); }}
                >
                  <span style={ctaLabelInline || undefined}>{c.ctaLabel}</span>
                  <ArrowRight className="w-4 h-4" />
                </a>
              </div>
            );
          }
          // Fallback path: tenant variant chosen but tenant has no matching
          // style configured → render with the legacy `outline` classes so the
          // CTA still looks sensible.
          const fallbackVariant = isTenantVariant ? 'outline' : ctaVariant;
          return (
            <div className="mt-2 flex" style={{ justifyContent: ctaJustify }}>
              <a
                href={asEditor ? undefined : (c.ctaHref || '#')}
                className={buttonClasses(fallbackVariant, 'default')}
                onClick={(e) => { if (asEditor) e.preventDefault(); }}
              >
                <span style={ctaLabelInline || undefined}>{c.ctaLabel}</span>
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function CardInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  // Tenant custom button styles for the CTA variant picker — same
  // enumeration as ButtonInspector so the Card CTA offers the exact same
  // tenant-branded options.
  const branding = useTenantBranding()?.branding || null;
  const customStyleEntries = (() => {
    const styles =
      branding?.buttonStyles ||
      branding?.brandingConfig?.button_styles ||
      null;
    if (!styles || typeof styles !== 'object') return [];
    return Object.entries(styles)
      .filter(([k, v]) => k !== 'primary' && k !== 'secondary' && v && typeof v === 'object')
      .map(([k, v]) => ({ key: k, label: v.label || k }));
  })();
  const imageMode = c.imageDisplayMode === 'inline' ? 'inline' : 'full-bleed';
  const ctaEnabled = c.ctaEnabled !== false;
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const iconClass = sanitizeFaIconClass(c.iconClass);
  return (
    <>
      <ImageField
        label="Image (optional)"
        value={c.imageUrl}
        alt={c.imageAlt}
        onChangeSrc={(v) => set({ imageUrl: v })}
        onChangeAlt={(v) => set({ imageAlt: v })}
        testId="input-card-image"
      />
      {c.imageUrl && (
        <SelectField
          label="Image display"
          value={imageMode}
          onChange={(v) => set({ imageDisplayMode: v })}
          options={[
            { value: 'full-bleed', label: 'Full bleed (cropped header)' },
            { value: 'inline', label: 'Inline (uncropped, sized)' },
          ]}
          testId="select-card-image-mode"
        />
      )}
      {c.imageUrl && imageMode === 'inline' && (
        <>
          <NumberField
            label="Image width (%)"
            value={c.imageWidthPct == null ? 100 : c.imageWidthPct}
            onChange={(v) => set({ imageWidthPct: v })}
            min={5}
            max={100}
            step={5}
            testId="input-card-image-width"
          />
          <SelectField
            label="Image alignment"
            value={c.imageAlign || 'center'}
            onChange={(v) => set({ imageAlign: v })}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Center' },
              { value: 'right', label: 'Right' },
            ]}
            testId="select-card-image-align"
          />
        </>
      )}
      <div className="pt-1 border-t border-slate-100 space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-slate-600">Font Awesome icon</Label>
          {iconClass ? (
            <i
              className={iconClass}
              aria-hidden="true"
              style={{ color: c.iconColor || undefined }}
              data-testid="preview-card-icon"
            />
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={() => setIconPickerOpen(true)}
          data-testid="button-browse-card-icon"
        >
          <Search className="w-4 h-4" />
          {iconClass ? 'Change icon…' : 'Browse icons…'}
        </Button>
        <Suspense fallback={null}>
          {iconPickerOpen ? (
            <FontAwesomeIconPicker
              open={iconPickerOpen}
              onClose={() => setIconPickerOpen(false)}
              onSelect={(cls) => set({ iconClass: cls })}
              currentValue={c.iconClass}
            />
          ) : null}
        </Suspense>
        <TextField
          label="Font Awesome class (advanced — or use the picker above)"
          value={c.iconClass}
          onChange={(v) => set({ iconClass: v })}
          placeholder="e.g. fa-solid fa-book-open"
          testId="input-card-icon-class"
        />
        {iconClass && (
          <>
            <NumberField
              label="Icon size (px)"
              value={c.iconSize == null ? 32 : c.iconSize}
              onChange={(v) => set({ iconSize: v })}
              min={8}
              max={160}
              testId="input-card-icon-size"
            />
            <SelectField
              label="Icon alignment"
              value={c.iconAlign || 'left'}
              onChange={(v) => set({ iconAlign: v })}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
              ]}
              testId="select-card-icon-align"
            />
            <ColorField
              label="Icon colour (optional)"
              value={c.iconColor}
              onChange={(v) => set({ iconColor: v })}
              testId="input-card-icon-color"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-slate-500"
              onClick={() => set({ iconClass: '', iconSize: 32, iconColor: '', iconAlign: 'left' })}
              data-testid="button-remove-card-icon"
            >
              Remove icon
            </Button>
          </>
        )}
      </div>
      <TextField label="Heading" value={c.heading} onChange={(v) => set({ heading: v })} testId="input-card-heading" />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 3)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-card-heading-level"
      />
      <TypographyStyleField
        label="Heading style"
        value={c.headingTypographyStyleId}
        onChange={(id, picked) => {
          // Mirror the chosen style's heading level so the card still
          // renders as the right heading if the tenant style is later
          // deleted (graceful degradation, matches the Text/Hero blocks).
          const fallback = fallbackHeadingAsForStyleType(picked && picked.style_type);
          const fallbackNum = fallback ? Math.max(2, Math.min(6, Number(fallback))) : null;
          set({
            headingTypographyStyleId: id,
            ...(fallbackNum ? { headingLevel: fallbackNum } : {}),
          });
        }}
        testId="select-card-heading-typography"
      />
      <RichTextField label="Body" value={c.body} onChange={(v) => set({ body: v })} testId="input-card-body" />
      <NumberField
        label="Content padding (px)"
        value={c.contentPadding == null ? 16 : c.contentPadding}
        onChange={(v) => set({ contentPadding: v })}
        min={0}
        max={64}
        testId="input-card-content-padding"
      />
      <NumberField
        label="Image / icon spacing (px)"
        value={c.headerSpacing == null ? 8 : c.headerSpacing}
        onChange={(v) => set({ headerSpacing: v })}
        min={0}
        max={120}
        testId="input-card-header-spacing"
      />
      <ToggleField
        label="Show CTA"
        value={ctaEnabled}
        onChange={(v) => set({ ctaEnabled: v })}
        testId="toggle-card-cta-enabled"
      />
      {ctaEnabled && (
        <>
          <TextField label="CTA label" value={c.ctaLabel} onChange={(v) => set({ ctaLabel: v })} testId="input-card-cta-label" />
          <TypographyStyleField
            label="CTA label style"
            value={c.ctaLabelTypographyStyleId}
            onChange={(id) => set({ ctaLabelTypographyStyleId: id })}
            testId="select-card-cta-typography"
          />
          <LinkField label="CTA link" value={c.ctaHref} onChange={(v) => set({ ctaHref: v })} testId="input-card-cta-href" />
          <SelectField
            label="CTA variant"
            value={c.ctaVariant || 'outline'}
            onChange={(v) => set({ ctaVariant: v })}
            options={[
              { value: 'primary', label: 'Primary' },
              { value: 'default', label: 'Default' },
              { value: 'outline', label: 'Outline' },
              { value: 'ghost', label: 'Ghost' },
              { value: 'tenant-primary', label: 'Tenant primary (branded)' },
              { value: 'tenant-secondary', label: 'Tenant secondary (branded)' },
              ...customStyleEntries.map((e) => ({
                value: `tenant:${e.key}`,
                label: `Tenant: ${e.label}`,
              })),
            ]}
            testId="select-card-cta-variant"
          />
          <SelectField
            label="CTA alignment"
            value={c.ctaAlign || 'left'}
            onChange={(v) => set({ ctaAlign: v })}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Center' },
              { value: 'right', label: 'Right' },
            ]}
            testId="select-card-cta-align"
          />
        </>
      )}
      <SelectField
        label="Drop shadow"
        value={c.shadow || 'none'}
        onChange={(v) => set({ shadow: v })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'sm', label: 'Small' },
          { value: 'md', label: 'Medium' },
          { value: 'lg', label: 'Large' },
        ]}
        testId="select-card-shadow"
      />
      <ToggleField
        label="Highlight ring"
        value={!!c.highlight}
        onChange={(v) => set({ highlight: v })}
        testId="toggle-card-highlight"
      />
      {c.highlight && (
        <ColorField
          label="Highlight colour"
          value={c.highlightColor || '#3b82f6'}
          onChange={(v) => set({ highlightColor: v })}
          testId="input-card-highlight-color"
        />
      )}
    </>
  );
}

// STAT -----------------------------------------------------------------------
// Split a display string like "2,500+" or "$5.2K" into the numeric core
// (used as the count-up target) and the non-numeric prefix/suffix that
// are preserved at every animation frame. Returns `null` for the
// numeric part when no number is present, in which case the renderer
// shows the raw value with no animation.
function parseStatValue(raw) {
  const str = String(raw == null ? '' : raw);
  const m = str.match(/^(\D*?)([\d][\d.,\s]*)(.*)$/);
  if (!m) return { prefix: '', target: null, suffix: '', decimals: 0, separator: '' };
  const [, prefix, numStr, suffix] = m;
  const trimmed = numStr.trim();
  // Detect thousands separator (comma or space) by looking for groups of
  // three trailing digits. We preserve whichever appears in the saved
  // value so a UK author writing "2,500" doesn't become "2500" mid-frame.
  const hasCommaThousands = /\d{1,3}(,\d{3})+/.test(trimmed);
  const hasSpaceThousands = /\d{1,3}(\s\d{3})+/.test(trimmed);
  const separator = hasCommaThousands ? ',' : hasSpaceThousands ? ' ' : '';
  // Strip thousands separators (commas or spaces) but keep the decimal
  // point. After stripping, parseFloat gives us the numeric target.
  const numeric = trimmed.replace(/,/g, '').replace(/\s+/g, '');
  const dot = numeric.indexOf('.');
  const decimals = dot >= 0 ? numeric.length - dot - 1 : 0;
  const target = Number(numeric);
  if (!Number.isFinite(target)) {
    return { prefix: '', target: null, suffix: '', decimals: 0, separator: '' };
  }
  return { prefix, target, suffix, decimals, separator };
}

function formatStatNumber(value, { decimals, separator }) {
  const fixed = value.toFixed(decimals || 0);
  if (!separator) return fixed;
  // Re-apply thousands separator to the integer part only.
  const [intPart, fracPart] = fixed.split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return fracPart != null ? `${withSep}.${fracPart}` : withSep;
}

function StatRender({ block, asEditor }) {
  const c = block.content || {};
  const parsed = useMemo(() => parseStatValue(c.value), [c.value]);
  const animate = !!c.animate && parsed.target != null && parsed.target !== 0;
  const duration = Math.max(200, Math.min(10000, Number(c.animationDurationMs) || 1500));

  // Held value shown to the user. `null` means "render the saved
  // c.value verbatim" — that's the steady state for the editor
  // preview, for blocks where animate=false, and for blocks where the
  // animation has finished. We only seed a real "0" frame when the
  // public renderer is about to animate up to the target.
  const [display, setDisplay] = useState(() => {
    if (asEditor || !animate) return null;
    return formatStatNumber(0, parsed);
  });
  const containerRef = useRef(null);
  const startedRef = useRef(false);

  useEffect(() => {
    // Editor preview never animates — authors see the saved value as-is
    // so they can read/edit it. Same when there is no numeric target.
    if (asEditor || !animate) {
      setDisplay(null);
      startedRef.current = false;
      return undefined;
    }
    // Honour reduced-motion users: skip the animation entirely and show
    // the final number immediately.
    if (
      typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setDisplay(null);
      startedRef.current = false;
      return undefined;
    }
    setDisplay(formatStatNumber(0, parsed));
    startedRef.current = false;

    const el = containerRef.current;
    if (!el) return undefined;

    let rafId = 0;
    const runAnimation = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      const startTs = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - startTs) / duration);
        // ease-out cubic — fast start, soft landing.
        const eased = 1 - Math.pow(1 - t, 3);
        const current = parsed.target * eased;
        setDisplay(formatStatNumber(current, parsed));
        if (t < 1) {
          rafId = requestAnimationFrame(tick);
        } else {
          setDisplay(null); // null = show final c.value string as-is
        }
      };
      rafId = requestAnimationFrame(tick);
    };

    if (typeof IntersectionObserver === 'undefined') {
      runAnimation();
      return () => { if (rafId) cancelAnimationFrame(rafId); };
    }
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          runAnimation();
          io.disconnect();
          break;
        }
      }
    }, { threshold: 0.25 });
    io.observe(el);
    return () => {
      io.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [asEditor, animate, duration, parsed]);

  const valueFontSize = Number.isFinite(c.valueFontSize) && c.valueFontSize > 0
    ? `${c.valueFontSize}px`
    : 'clamp(1.5rem, 4vw, 2.5rem)';
  const labelFontSize = Number.isFinite(c.labelFontSize) && c.labelFontSize > 0
    ? `${c.labelFontSize}px`
    : undefined;

  // While animating we show `display`; otherwise we render the saved
  // string verbatim so prefixes/suffixes like "+" or "K" survive.
  const valueText = display != null
    ? `${parsed.prefix}${display}${parsed.suffix}`
    : c.value;

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex flex-col items-center justify-center text-center"
    >
      <div
        data-testid="text-stat-value"
        style={{
          color: c.color || '#0f172a',
          fontSize: valueFontSize,
          fontWeight: 700,
          lineHeight: 1,
          marginBottom: 4,
        }}
      >
        {valueText}
      </div>
      <div
        data-testid="text-stat-label"
        className={c.labelColor ? '' : 'text-slate-600'}
        style={{
          color: c.labelColor || undefined,
          fontSize: labelFontSize,
        }}
      >
        {c.label}
      </div>
    </div>
  );
}

function StatInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <TextField label="Value" value={c.value} onChange={(v) => set({ value: v })} testId="input-stat-value" />
      <TextField label="Label" value={c.label} onChange={(v) => set({ label: v })} testId="input-stat-label" />
      <ColorField label="Value colour" value={c.color} onChange={(v) => set({ color: v })} testId="input-stat-color" />
      <ColorField label="Label colour" value={c.labelColor} onChange={(v) => set({ labelColor: v })} testId="input-stat-label-color" />
      <NumberField
        label="Value size (px)"
        min={8}
        max={200}
        value={Number.isFinite(c.valueFontSize) ? c.valueFontSize : ''}
        onChange={(v) => set({ valueFontSize: v === '' || v == null ? null : Math.max(8, Math.min(200, Number(v) || 0)) })}
        testId="input-stat-value-size"
      />
      <NumberField
        label="Label size (px)"
        min={8}
        max={80}
        value={Number.isFinite(c.labelFontSize) ? c.labelFontSize : ''}
        onChange={(v) => set({ labelFontSize: v === '' || v == null ? null : Math.max(8, Math.min(80, Number(v) || 0)) })}
        testId="input-stat-label-size"
      />
      <ToggleField
        label="Animate as counter"
        value={!!c.animate}
        onChange={(v) => set({ animate: v })}
        testId="toggle-stat-animate"
      />
      {c.animate && (
        <NumberField
          label="Animation duration (ms)"
          min={200}
          max={10000}
          step={100}
          value={Number.isFinite(c.animationDurationMs) ? c.animationDurationMs : 1500}
          onChange={(v) => set({ animationDurationMs: Math.max(200, Math.min(10000, Number(v) || 1500)) })}
          testId="input-stat-animation-duration"
        />
      )}
    </>
  );
}

// COUNTDOWN ------------------------------------------------------------------
// Live countdown clock. Computes time remaining from `content.targetDate`
// (a datetime-local string, interpreted in the viewer's local timezone) and
// re-renders every second via a setInterval. Once the target has passed it
// shows the configurable finished message instead of negative numbers. The
// editor preview ticks too so authors see real behaviour. The interval is
// cleaned up on unmount and is not started when there is no valid target.
function computeCountdownParts(targetMs, now) {
  let remaining = Math.max(0, Math.floor((targetMs - now) / 1000));
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining - minutes * 60;
  return { days, hours, minutes, seconds };
}

function CountdownRender({ block }) {
  const c = block.content || {};

  // When linked to an event, read the target from the event's start_date so the
  // countdown stays accurate if the event date changes. Falls back to the manual
  // targetDate when no event is linked.
  const eventKey = c.eventSlug || c.eventId || null;
  const { data: linkedEvent } = useQuery({
    queryKey: ['canvas', 'public-event', eventKey],
    queryFn: async () => {
      if (c.eventSlug) return publicClient.getEventBySlug(c.eventSlug);
      if (c.eventId) return publicClient.getEvent(c.eventId);
      return null;
    },
    enabled: !!eventKey,
    staleTime: 60_000,
  });

  const targetMs = useMemo(() => {
    const raw = eventKey ? linkedEvent?.start_date : c.targetDate;
    if (!raw) return null;
    const t = new Date(raw).getTime();
    return Number.isNaN(t) ? null : t;
  }, [eventKey, linkedEvent?.start_date, c.targetDate]);

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (targetMs == null) return undefined;
    const start = Date.now();
    setNow(start);
    // Already past — no need to start a ticker at all.
    if (start >= targetMs) return undefined;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      // Once the target passes, stop re-rendering every second.
      if (t >= targetMs) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [targetMs]);

  const align = c.alignment || 'center';
  const justifyContent = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  const numberColor = c.numberColor || 'var(--cb-color-primary, #0f172a)';
  const numberFontSize = Number.isFinite(c.numberFontSize) && c.numberFontSize > 0
    ? `${c.numberFontSize}px`
    : 'clamp(1.75rem, 5vw, 2.75rem)';
  const labelFontSize = Number.isFinite(c.labelFontSize) && c.labelFontSize > 0
    ? `${c.labelFontSize}px`
    : '0.8125rem';

  if (targetMs == null) {
    return (
      <div className="w-full h-full flex items-center justify-center text-center text-sm text-slate-400">
        {eventKey
          ? "The linked event has no start date yet."
          : "Set a target date in the inspector to start the countdown."}
      </div>
    );
  }

  const finished = now >= targetMs;
  if (finished) {
    return (
      <div
        className="w-full h-full flex items-center"
        style={{ justifyContent }}
        data-testid="text-countdown-finished"
      >
        <div
          className="text-center"
          style={{ color: numberColor, fontSize: numberFontSize, fontWeight: 700, lineHeight: 1.1 }}
        >
          {c.finishedMessage || "Time's up!"}
        </div>
      </div>
    );
  }

  const parts = computeCountdownParts(targetMs, now);
  const units = [
    { key: 'days', show: c.showDays !== false, value: parts.days, label: c.daysLabel || 'Days' },
    { key: 'hours', show: c.showHours !== false, value: parts.hours, label: c.hoursLabel || 'Hours' },
    { key: 'minutes', show: c.showMinutes !== false, value: parts.minutes, label: c.minutesLabel || 'Minutes' },
    { key: 'seconds', show: c.showSeconds !== false, value: parts.seconds, label: c.secondsLabel || 'Seconds' },
  ].filter((u) => u.show);

  const pad = (n) => String(n).padStart(2, '0');
  const boxed = c.presetStyle === 'boxed';
  const showSeparators = !!c.showSeparators;
  // Separators look wrong squeezed between cards, so they only apply to plain.
  const withSeparators = showSeparators && !boxed;

  return (
    <div
      className="w-full h-full flex items-center"
      style={{ justifyContent }}
      aria-label={block.a11y?.ariaLabel || 'Countdown timer'}
    >
      <div className="flex flex-wrap items-stretch" style={{ gap: boxed ? 'clamp(0.5rem, 2vw, 1rem)' : 'clamp(0.75rem, 3vw, 2rem)', justifyContent }}>
        {units.map((u, i) => (
          <Fragment key={u.key}>
            <div
              className="flex flex-col items-center justify-center text-center"
              data-testid={`countdown-unit-${u.key}`}
              style={boxed ? {
                background: c.boxBackground || 'var(--cb-color-surface, #ffffff)',
                border: `1px solid ${c.boxBorderColor || 'var(--cb-color-border, #e2e8f0)'}`,
                borderRadius: 'var(--cb-radius, 8px)',
                padding: 'clamp(0.5rem, 2vw, 1rem) clamp(0.75rem, 3vw, 1.25rem)',
                minWidth: '4.5rem',
              } : undefined}
            >
              <div
                data-testid={`text-countdown-${u.key}`}
                style={{
                  color: numberColor,
                  fontSize: numberFontSize,
                  fontWeight: 700,
                  lineHeight: 1,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {u.key === 'days' ? u.value : pad(u.value)}
              </div>
              <div
                className={c.labelColor ? '' : 'text-slate-600'}
                style={{
                  color: c.labelColor || undefined,
                  fontSize: labelFontSize,
                  marginTop: 4,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {u.label}
              </div>
            </div>
            {withSeparators && i < units.length - 1 && (
              <div
                aria-hidden="true"
                data-testid={`countdown-separator-${u.key}`}
                className="flex items-start"
                style={{
                  color: numberColor,
                  fontSize: numberFontSize,
                  fontWeight: 700,
                  lineHeight: 1,
                }}
              >
                :
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// Optional event link for the Countdown block. Mirrors the event-picker pattern
// used by the dynamic blocks (publicClient.listEvents, slug-preferred values),
// plus a "None" option so authors can unlink and return to a manual date.
function CountdownEventPicker({ value, onChange, testId }) {
  const { data: events, isLoading } = useQuery({
    queryKey: ['canvas', 'public-events'],
    queryFn: () => publicClient.listEvents(),
    staleTime: 60_000,
  });
  const options = (events || []).map((e) => ({ value: e.slug || String(e.id), label: e.title }));
  return (
    <Field label={isLoading ? 'Link to event (loading…)' : 'Link to event'}>
      <Select value={value || '__none__'} onValueChange={(v) => onChange(v === '__none__' ? '' : v)}>
        <SelectTrigger className="h-8" data-testid={testId}>
          <SelectValue placeholder="Select an event" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">None (use manual date)</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function CountdownInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const linkedToEvent = !!(c.eventSlug || c.eventId);
  return (
    <>
      <CountdownEventPicker
        value={c.eventSlug || c.eventId}
        onChange={(v) => set({ eventSlug: v, eventId: '' })}
        testId="select-countdown-event"
      />
      <Field label="Target date & time">
        <Input
          type="datetime-local"
          value={c.targetDate || ''}
          onChange={(e) => set({ targetDate: e.target.value })}
          className="h-8"
          disabled={linkedToEvent}
          data-testid="input-countdown-target"
        />
        {linkedToEvent ? (
          <p className="text-xs text-slate-500">
            Using the linked event’s start date. Choose “None” above to set a date manually.
          </p>
        ) : null}
      </Field>
      <ToggleField label="Show days" value={c.showDays !== false} onChange={(v) => set({ showDays: v })} testId="toggle-countdown-days" />
      <ToggleField label="Show hours" value={c.showHours !== false} onChange={(v) => set({ showHours: v })} testId="toggle-countdown-hours" />
      <ToggleField label="Show minutes" value={c.showMinutes !== false} onChange={(v) => set({ showMinutes: v })} testId="toggle-countdown-minutes" />
      <ToggleField label="Show seconds" value={c.showSeconds !== false} onChange={(v) => set({ showSeconds: v })} testId="toggle-countdown-seconds" />
      <TextField label="Days label" value={c.daysLabel} onChange={(v) => set({ daysLabel: v })} testId="input-countdown-days-label" />
      <TextField label="Hours label" value={c.hoursLabel} onChange={(v) => set({ hoursLabel: v })} testId="input-countdown-hours-label" />
      <TextField label="Minutes label" value={c.minutesLabel} onChange={(v) => set({ minutesLabel: v })} testId="input-countdown-minutes-label" />
      <TextField label="Seconds label" value={c.secondsLabel} onChange={(v) => set({ secondsLabel: v })} testId="input-countdown-seconds-label" />
      <TextField label="Finished message" value={c.finishedMessage} onChange={(v) => set({ finishedMessage: v })} testId="input-countdown-finished" />
      <SelectField
        label="Alignment"
        value={c.alignment || 'center'}
        onChange={(v) => set({ alignment: v })}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
          { value: 'right', label: 'Right' },
        ]}
        testId="select-countdown-alignment"
      />
      <SelectField
        label="Style"
        value={c.presetStyle === 'boxed' ? 'boxed' : 'plain'}
        onChange={(v) => set({ presetStyle: v })}
        options={[
          { value: 'plain', label: 'Plain' },
          { value: 'boxed', label: 'Boxed' },
        ]}
        testId="select-countdown-style"
      />
      {c.presetStyle !== 'boxed' && (
        <ToggleField label="Show separators (:)" value={!!c.showSeparators} onChange={(v) => set({ showSeparators: v })} testId="toggle-countdown-separators" />
      )}
      <ColorField label="Number colour" value={c.numberColor} onChange={(v) => set({ numberColor: v })} testId="input-countdown-number-color" />
      <ColorField label="Label colour" value={c.labelColor} onChange={(v) => set({ labelColor: v })} testId="input-countdown-label-color" />
      {c.presetStyle === 'boxed' && (
        <>
          <ColorField label="Box background" value={c.boxBackground} onChange={(v) => set({ boxBackground: v })} testId="input-countdown-box-background" />
          <ColorField label="Box border colour" value={c.boxBorderColor} onChange={(v) => set({ boxBorderColor: v })} testId="input-countdown-box-border" />
        </>
      )}
      <NumberField
        label="Number size (px)"
        min={8}
        max={160}
        value={Number.isFinite(c.numberFontSize) ? c.numberFontSize : ''}
        onChange={(v) => set({ numberFontSize: v === '' || v == null ? null : Math.max(8, Math.min(160, Number(v) || 0)) })}
        testId="input-countdown-number-size"
      />
      <NumberField
        label="Label size (px)"
        min={8}
        max={60}
        value={Number.isFinite(c.labelFontSize) ? c.labelFontSize : ''}
        onChange={(v) => set({ labelFontSize: v === '' || v == null ? null : Math.max(8, Math.min(60, Number(v) || 0)) })}
        testId="input-countdown-label-size"
      />
    </>
  );
}

// LOGO STRIP -----------------------------------------------------------------
function LogoStripRender({ block }) {
  const c = block.content || {};
  return (
    <div
      className="w-full h-full flex items-center flex-wrap"
      style={{ gap: c.gap || 24 }}
    >
      {(c.logos || []).map((l, i) => {
        const img = l.src ? (
          <img
            src={l.src}
            alt={l.alt || ''}
            loading="lazy"
            decoding="async"
            style={{
              maxHeight: '80%',
              maxWidth: 160,
              objectFit: 'contain',
              filter: c.grayscale ? 'grayscale(100%)' : 'none',
              opacity: c.grayscale ? 0.8 : 1,
            }}
          />
        ) : (
          <div className="w-24 h-12 bg-slate-100 rounded flex items-center justify-center text-xs text-slate-400">
            Logo {i + 1}
          </div>
        );
        return l.href ? (
          <a key={i} href={l.href} target="_blank" rel="noopener noreferrer">{img}</a>
        ) : (
          <div key={i}>{img}</div>
        );
      })}
    </div>
  );
}

function LogoStripInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <NumberField label="Gap (px)" min={0} value={c.gap || 24} onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })} testId="input-logos-gap" />
      <ToggleField label="Grayscale" value={!!c.grayscale} onChange={(v) => set({ grayscale: v })} testId="toggle-logos-grayscale" />
      <Field label="Logos">
        <ArrayList
          items={c.logos || []}
          onChange={(next) => set({ logos: next })}
          makeNew={() => ({ src: '', alt: '', href: '' })}
          addLabel="Add logo"
          testIdPrefix="logo"
          renderItem={(item, idx, patch) => (
            <>
              <ImageField
                label={`Logo ${idx + 1}`}
                value={item.src}
                alt={item.alt}
                onChangeSrc={(v) => patch({ src: v })}
                onChangeAlt={(v) => patch({ alt: v })}
                testId={`logo-${idx}-img`}
              />
              <LinkField label="Link" value={item.href} onChange={(v) => patch({ href: v })} testId={`logo-${idx}-href`} />
            </>
          )}
        />
      </Field>
    </>
  );
}

// MAP ------------------------------------------------------------------------
function MapRender({ block }) {
  const c = block.content || {};
  const q = encodeURIComponent(c.query || '');
  const url = `https://www.google.com/maps?q=${q}&z=${c.zoom || 12}&output=embed`;
  return (
    <div className="w-full h-full">
      {c.query ? (
        <iframe
          src={url}
          title={c.title || 'Map'}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          style={{ width: '100%', height: '100%', border: 0 }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">
          <MapIcon className="w-4 h-4 mr-1" /> No location set
        </div>
      )}
    </div>
  );
}

function MapInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <TextField label="Location query" value={c.query} onChange={(v) => set({ query: v })} testId="input-map-query" />
      <NumberField label="Zoom (1–20)" min={1} max={20} value={c.zoom || 12} onChange={(v) => set({ zoom: Math.max(1, Math.min(20, Number(v) || 12)) })} testId="input-map-zoom" />
      <TextField label="Map title (accessibility)" value={c.title} onChange={(v) => set({ title: v })} testId="input-map-title" />
    </>
  );
}

// NEWS TICKER ----------------------------------------------------------------
// A static-text ticker bar: editors type their own items in the Inspector
// (unlike the portal-wide NewsTickerBar.jsx which pulls from published news
// articles). Two modes share one hook so the editor preview and the public
// renderer behave identically: `cycling` (one item at a time, vertical slide)
// and `scrolling` (continuous horizontal marquee).

// Shared cycling logic — advances an index every `intervalSeconds`. Disabled
// when there are 0/1 items or when the caller opts out (scrolling mode uses a
// pure-CSS marquee instead). Resets when the item count shrinks so a deleted
// item never leaves the index out of range.
function useTickerCycle(count, intervalSeconds, enabled) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!enabled || count <= 1) return undefined;
    const ms = Math.max(1, Number(intervalSeconds) || 5) * 1000;
    const t = setInterval(() => setIndex((p) => (p + 1) % count), ms);
    return () => clearInterval(t);
  }, [count, intervalSeconds, enabled]);
  useEffect(() => {
    setIndex((p) => (p >= count ? 0 : p));
  }, [count]);
  return count > 0 ? index % count : 0;
}

// Pure-CSS marquee: the item run is duplicated so translateX(-50%) loops
// seamlessly. Loop duration scales with item count * seconds-per-item so the
// inspector's single speed control feels consistent in both modes. Respects
// prefers-reduced-motion (animation paused for users who opt out).
function NewsTickerScroller({ items, intervalSeconds, separatorColor }) {
  const perItem = Math.max(1, Number(intervalSeconds) || 5);
  const loopSeconds = Math.max(4, items.length * perItem);
  const renderRun = (runKey) => items.map((it, i) => (
    <span key={`${runKey}-${i}`} className="inline-flex items-center whitespace-nowrap">
      <span>{it.text}</span>
      <span aria-hidden="true" className="mx-4 opacity-60" style={{ color: separatorColor }}>•</span>
    </span>
  ));
  return (
    <div className="relative flex-1 overflow-hidden">
      <style>{`@keyframes cb-ticker-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}@media (prefers-reduced-motion: reduce){.cb-ticker-track{animation:none !important}}`}</style>
      <div
        className="cb-ticker-track inline-flex whitespace-nowrap"
        style={{ animation: `cb-ticker-marquee ${loopSeconds}s linear infinite`, willChange: 'transform' }}
      >
        {renderRun('a')}
        {renderRun('b')}
      </div>
    </div>
  );
}

function NewsTickerRender({ block }) {
  const c = block.content || {};
  const items = (c.items || []).filter(
    (it) => it && typeof it.text === 'string' && it.text.trim() !== '',
  );
  const mode = c.mode === 'scrolling' ? 'scrolling' : 'cycling';
  const intervalSeconds = Math.max(1, Number(c.intervalSeconds) || 5);
  const bg = c.backgroundColor || '#9333ea';
  const fg = c.textColor || '#ffffff';
  const label = (c.label || '').trim();
  const index = useTickerCycle(items.length, intervalSeconds, mode === 'cycling');
  // When full-bleed, the bar spans 100vw but its content should re-align to
  // the page's centered content column. `--cb-content-width` is published by
  // the stage stylesheet per breakpoint (1200/768/375); falls back to 1200.
  const railStyle = c.fullBleed
    ? { maxWidth: 'var(--cb-content-width, 1200px)', marginInline: 'auto' }
    : undefined;

  if (items.length === 0) {
    return (
      <div
        className="w-full h-full flex items-center justify-center text-xs"
        style={{ background: bg, color: fg }}
        data-testid="news-ticker-empty"
      >
        Add ticker items in the Inspector
      </div>
    );
  }

  return (
    <div
      className="w-full h-full overflow-hidden flex items-center"
      style={{ background: bg, color: fg }}
      role="marquee"
      aria-label={label || 'News ticker'}
    >
      <div className="flex items-center gap-3 w-full h-full px-4" style={railStyle}>
        {label ? (
          <span
            className="text-xs font-semibold uppercase tracking-wider shrink-0 rounded px-2 py-1"
            style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
          >
            {label}
          </span>
        ) : null}
        {mode === 'cycling' ? (
          <div className="relative flex-1 h-6 overflow-hidden">
            {items.map((it, i) => (
              <div
                key={i}
                className="absolute inset-0 flex items-center transition-all duration-500"
                style={{
                  transform: `translateY(${(i - index) * 100}%)`,
                  opacity: i === index ? 1 : 0,
                }}
              >
                <span className="truncate">{it.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <NewsTickerScroller items={items} intervalSeconds={intervalSeconds} separatorColor={fg} />
        )}
      </div>
    </div>
  );
}

function NewsTickerInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const mode = c.mode === 'scrolling' ? 'scrolling' : 'cycling';
  return (
    <>
      <TextField
        label="Label / prefix"
        value={c.label}
        onChange={(v) => set({ label: v })}
        placeholder="e.g. Latest: (leave blank for none)"
        testId="input-ticker-label"
      />
      <SelectField
        label="Display mode"
        value={mode}
        onChange={(v) => set({ mode: v })}
        options={[
          { value: 'cycling', label: 'Cycling (one at a time)' },
          { value: 'scrolling', label: 'Scrolling (marquee)' },
        ]}
        testId="select-ticker-mode"
      />
      <NumberField
        label={mode === 'scrolling' ? 'Speed (seconds per item)' : 'Interval (seconds between items)'}
        min={1}
        max={60}
        value={c.intervalSeconds || 5}
        onChange={(v) => set({ intervalSeconds: Math.max(1, Math.min(60, Number(v) || 5)) })}
        testId="input-ticker-interval"
      />
      <ColorField
        label="Background colour"
        value={c.backgroundColor || '#9333ea'}
        onChange={(v) => set({ backgroundColor: v })}
        testId="input-ticker-bg"
      />
      <ColorField
        label="Text colour"
        value={c.textColor || '#ffffff'}
        onChange={(v) => set({ textColor: v })}
        testId="input-ticker-fg"
      />
      <ToggleField
        label="Full-bleed (span full screen width)"
        value={!!c.fullBleed}
        onChange={(v) => set({ fullBleed: v })}
        testId="toggle-ticker-full-bleed"
      />
      <Field label="Ticker items">
        <ArrayList
          items={c.items || []}
          onChange={(next) => set({ items: next })}
          makeNew={() => ({ text: 'New ticker item' })}
          addLabel="Add item"
          testIdPrefix="ticker"
          renderItem={(item, idx, patch) => (
            <TextField
              label={`Item ${idx + 1}`}
              value={item.text}
              onChange={(v) => patch({ text: v })}
              testId={`ticker-${idx}-text`}
            />
          )}
        />
      </Field>
    </>
  );
}

// MEGA MENU ------------------------------------------------------------------
// A manually-built navigation bar dropped onto a single page. It is fully
// independent of the site-wide portal navigation (navigation_item /
// PublicHeader.jsx) — authors type every label and URL by hand. Each
// top-level item is either a plain link (uses `href`) or opens a rich
// dropdown panel made of columns (heading + links with short descriptions)
// plus an optional featured block (image + title + text + link).
//
// Layout-shift safety (per the design guidelines): the desktop dropdown is an
// absolutely-positioned overlay toggled via visibility/opacity, so opening it
// never reflows the bar or the page. On narrow screens the bar collapses to a
// hamburger that expands an accordion overlay.

// Resolve whether to render the narrow (mobile) layout. In the editor we honour
// the forced device preview via `breakpoint`; on real public pages there is no
// breakpoint, so we track the viewport with matchMedia.
function useMegaMenuNarrow(breakpoint) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    // Match the canvas "mobile" breakpoint exactly so the public viewport
    // collapses to the hamburger at the same width the editor's mobile
    // preview does (avoids editor/public divergence).
    const mq = window.matchMedia(`(max-width: ${BREAKPOINT_MAX_PX.mobile}px)`);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  if (breakpoint === 'mobile') return true;
  if (breakpoint === 'tablet' || breakpoint === 'desktop') return false;
  return narrow;
}

function megaItemHasPanel(item) {
  // An explicit per-item toggle wins; otherwise infer a panel from populated
  // dropdown/featured content (keeps older blocks without the flag working).
  if (typeof item?.hasPanel === 'boolean') return item.hasPanel;
  const cols = Array.isArray(item?.columns) ? item.columns : [];
  return cols.length > 0
    || !!item?.featuredImage
    || !!(item?.featuredTitle && String(item.featuredTitle).trim())
    || !!(item?.featuredText && String(item.featuredText).trim());
}

// Internal paths route through react-router (SPA navigation); external,
// protocol, mailto/tel and in-page anchors render as a plain <a>. Mirrors the
// internal-vs-external convention used elsewhere in the app.
function isExternalHref(href) {
  if (!href) return false;
  return /^(https?:)?\/\//i.test(href) || /^(mailto:|tel:)/i.test(href);
}

function MegaLink({ href, openInNewTab, asEditor, className, style, children, testId }) {
  const target = openInNewTab ? '_blank' : undefined;
  const rel = openInNewTab ? 'noopener noreferrer' : undefined;
  // In the editor, links never navigate — render an inert anchor.
  if (asEditor) {
    return (
      <a
        className={className}
        style={style}
        onClick={(e) => e.preventDefault()}
        data-testid={testId}
      >
        {children}
      </a>
    );
  }
  if (href && !isExternalHref(href) && !href.startsWith('#')) {
    const to = href.startsWith('/') ? href : createPageUrl(href);
    return (
      <Link to={to} target={target} rel={rel} className={className} style={style} data-testid={testId}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href || '#'}
      target={target}
      rel={rel}
      className={className}
      style={style}
      data-testid={testId}
    >
      {children}
    </a>
  );
}

function MegaPanel({ item, asEditor, panelBg, panelFg, accent }) {
  const cols = Array.isArray(item?.columns) ? item.columns : [];
  const hasFeatured = !!item?.featuredImage
    || !!(item?.featuredTitle && String(item.featuredTitle).trim())
    || !!(item?.featuredText && String(item.featuredText).trim());
  return (
    <div
      className="flex w-full flex-wrap gap-6 rounded-md border border-slate-200 p-5 shadow-lg"
      style={{ backgroundColor: panelBg, color: panelFg }}
    >
      {cols.map((col, ci) => (
        <div key={ci} className="min-w-[160px] flex-1 space-y-2">
          {col?.heading && String(col.heading).trim() && (
            <div
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: accent }}
            >
              {col.heading}
            </div>
          )}
          <ul className="space-y-1.5">
            {(Array.isArray(col?.links) ? col.links : []).map((ln, li) => (
              <li key={li}>
                <MegaLink
                  href={ln?.href}
                  openInNewTab={ln?.openInNewTab}
                  asEditor={asEditor}
                  className="block rounded-md p-1.5 hover-elevate"
                  testId={`mega-panel-link-${ci}-${li}`}
                >
                  <span className="block text-sm font-medium">{ln?.label || 'Link'}</span>
                  {ln?.description && String(ln.description).trim() && (
                    <span className="block text-xs opacity-70">{ln.description}</span>
                  )}
                </MegaLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {hasFeatured && (
        <div className="min-w-[180px] max-w-[220px] flex-1 space-y-2">
          {item?.featuredImage && (
            <img
              src={item.featuredImage}
              alt={item.featuredAlt || ''}
              className="w-full rounded-md object-cover"
              style={{ maxHeight: '120px' }}
            />
          )}
          {item?.featuredTitle && String(item.featuredTitle).trim() && (
            <div className="text-sm font-semibold">{item.featuredTitle}</div>
          )}
          {item?.featuredText && String(item.featuredText).trim() && (
            <div className="text-xs opacity-70">{item.featuredText}</div>
          )}
          {item?.featuredHref && (
            <MegaLink
              href={item.featuredHref}
              openInNewTab={item.featuredOpenInNewTab}
              asEditor={asEditor}
              className="inline-flex items-center gap-1 text-xs font-medium hover-elevate rounded-md px-1.5 py-1"
              style={{ color: accent }}
              testId="mega-panel-featured-link"
            >
              Learn more <ArrowRight className="w-3 h-3" />
            </MegaLink>
          )}
        </div>
      )}
    </div>
  );
}

function MegaMenuRender({ block, asEditor, breakpoint }) {
  const c = block.content || {};
  const items = Array.isArray(c.items) ? c.items : [];
  const narrow = useMegaMenuNarrow(breakpoint);
  const [openIndex, setOpenIndex] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState({});
  const closeTimer = useRef(null);

  const barBg = c.barBackgroundColor || '#ffffff';
  const barFg = c.barTextColor || '#0f172a';
  const panelBg = c.panelBackgroundColor || '#ffffff';
  const panelFg = c.panelTextColor || '#0f172a';
  const accent = c.accentColor || '#9333ea';
  const labelFontSize = Math.min(48, Math.max(10, Number(c.labelFontSize) || 14));

  const justify = c.align === 'center'
    ? 'justify-center'
    : c.align === 'right' ? 'justify-end' : 'justify-start';

  // When full-bleed, the bar spans 100vw but its menu row should re-align to
  // the page's centered content column. `--cb-content-width` is published by
  // the stage stylesheet per breakpoint (1200/768/375); falls back to 1200.
  const railStyle = c.fullBleed
    ? { maxWidth: 'var(--cb-content-width, 1200px)', marginInline: 'auto' }
    : undefined;

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const openPanel = (idx) => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setOpenIndex(idx);
  };
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenIndex(null), 120);
  };

  if (items.length === 0) {
    return (
      <div
        className="w-full h-full flex items-center justify-center rounded-md border border-dashed border-slate-300 text-sm text-slate-500"
        data-testid="mega-menu-empty"
      >
        Add menu items in the Inspector to build your mega menu.
      </div>
    );
  }

  // ---- Narrow / mobile layout: hamburger + accordion overlay ----
  if (narrow) {
    return (
      <div
        className="w-full h-full rounded-md"
        style={{ backgroundColor: barBg, color: barFg }}
        data-testid="block-mega-menu"
      >
        <div className="flex items-center justify-between h-full px-3">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md p-2 hover-elevate"
            style={{ color: barFg }}
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            data-testid="button-mega-menu-toggle"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            <span className="text-sm font-medium">Menu</span>
          </button>
        </div>
        {mobileOpen && (
          <div
            className="relative z-50 mx-2 mb-2 max-h-[60vh] overflow-auto rounded-md border border-slate-200 shadow-lg"
            style={{ backgroundColor: panelBg, color: panelFg }}
            data-testid="mega-menu-mobile-panel"
          >
            <ul className="divide-y divide-slate-100">
              {items.map((item, idx) => {
                const hasPanel = megaItemHasPanel(item);
                const expanded = !!mobileExpanded[idx];
                return (
                  <li key={idx}>
                    {hasPanel ? (
                      <>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 p-3 text-left hover-elevate"
                          onClick={() => setMobileExpanded((m) => ({ ...m, [idx]: !m[idx] }))}
                          aria-expanded={expanded}
                          data-testid={`button-mega-mobile-item-${idx}`}
                        >
                          <span className="font-medium" style={{ fontSize: labelFontSize }}>{item?.label || 'Item'}</span>
                          <ChevronDown
                            className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
                          />
                        </button>
                        {expanded && (
                          <div className="px-3 pb-3">
                            <MegaPanel
                              item={item}
                              asEditor={asEditor}
                              panelBg={panelBg}
                              panelFg={panelFg}
                              accent={accent}
                            />
                          </div>
                        )}
                      </>
                    ) : (
                      <MegaLink
                        href={item?.href}
                        openInNewTab={item?.openInNewTab}
                        asEditor={asEditor}
                        className="block p-3 font-medium hover-elevate"
                        style={{ fontSize: labelFontSize }}
                        testId={`mega-mobile-link-${idx}`}
                      >
                        {item?.label || 'Item'}
                      </MegaLink>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // ---- Desktop layout: horizontal bar with a single full-width dropdown ----
  const openItem = openIndex != null ? items[openIndex] : null;
  const panelOpen = !!openItem && megaItemHasPanel(openItem);
  return (
    <div
      className="relative w-full h-full rounded-md"
      style={{ backgroundColor: barBg, color: barFg }}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpenIndex(null); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpenIndex(null); }}
      data-testid="block-mega-menu"
    >
      <ul className={`flex h-full items-center gap-1 px-3 w-full ${justify}`} style={railStyle}>
        {items.map((item, idx) => {
          const hasPanel = megaItemHasPanel(item);
          const isOpen = openIndex === idx;
          if (!hasPanel) {
            return (
              <li key={idx} className="relative">
                <MegaLink
                  href={item?.href}
                  openInNewTab={item?.openInNewTab}
                  asEditor={asEditor}
                  className="inline-flex items-center rounded-md px-3 py-2 font-medium hover-elevate"
                  style={{ fontSize: labelFontSize }}
                  testId={`mega-item-link-${idx}`}
                >
                  {item?.label || 'Item'}
                </MegaLink>
              </li>
            );
          }
          return (
            <li
              key={idx}
              className="relative"
              onMouseEnter={() => openPanel(idx)}
              onMouseLeave={scheduleClose}
              onFocus={() => openPanel(idx)}
            >
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md px-3 py-2 font-medium hover-elevate"
                style={{ color: barFg, fontSize: labelFontSize }}
                aria-expanded={isOpen}
                aria-haspopup="true"
                onClick={() => setOpenIndex(isOpen ? null : idx)}
                data-testid={`button-mega-item-${idx}`}
              >
                {item?.label || 'Item'}
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>
            </li>
          );
        })}
      </ul>
      {/* Single full-width overlay panel — toggled via visibility/opacity so
          opening never reflows the bar (layout-shift-safe per design
          guidelines). Hovering the panel keeps it open. */}
      <div
        className="absolute left-0 right-0 top-full z-50 pt-2 transition-opacity duration-150"
        style={{
          visibility: panelOpen ? 'visible' : 'hidden',
          opacity: panelOpen ? 1 : 0,
          pointerEvents: panelOpen ? 'auto' : 'none',
        }}
        onMouseEnter={() => { if (openIndex != null) openPanel(openIndex); }}
        onMouseLeave={scheduleClose}
        data-testid="mega-panel"
      >
        {/* When full-bleed, the overlay spans 100vw (left-0/right-0 of the bar)
            but the panel content should re-align to the centered content column,
            mirroring the bar row's railStyle. No-op when not full-bleed. */}
        <div style={railStyle}>
          {openItem && (
            <MegaPanel
              item={openItem}
              asEditor={asEditor}
              panelBg={panelBg}
              panelFg={panelFg}
              accent={accent}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MegaMenuInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  return (
    <>
      <SelectField
        label="Alignment"
        value={c.align || 'left'}
        onChange={(v) => set({ align: v })}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
          { value: 'right', label: 'Right' },
        ]}
        testId="select-mega-align"
      />
      <ToggleField
        label="Full-bleed (span full screen width)"
        value={!!c.fullBleed}
        onChange={(v) => set({ fullBleed: v })}
        testId="toggle-mega-full-bleed"
      />
      <ColorField
        label="Bar background"
        value={c.barBackgroundColor || '#ffffff'}
        onChange={(v) => set({ barBackgroundColor: v })}
        testId="input-mega-bar-bg"
      />
      <ColorField
        label="Bar text colour"
        value={c.barTextColor || '#0f172a'}
        onChange={(v) => set({ barTextColor: v })}
        testId="input-mega-bar-fg"
      />
      <ColorField
        label="Dropdown background"
        value={c.panelBackgroundColor || '#ffffff'}
        onChange={(v) => set({ panelBackgroundColor: v })}
        testId="input-mega-panel-bg"
      />
      <ColorField
        label="Dropdown text colour"
        value={c.panelTextColor || '#0f172a'}
        onChange={(v) => set({ panelTextColor: v })}
        testId="input-mega-panel-fg"
      />
      <ColorField
        label="Accent colour"
        value={c.accentColor || '#9333ea'}
        onChange={(v) => set({ accentColor: v })}
        testId="input-mega-accent"
      />
      <NumberField
        label="Label font size (px)"
        value={c.labelFontSize || 14}
        onChange={(v) => set({ labelFontSize: v })}
        min={10}
        max={48}
        testId="input-mega-label-font-size"
      />
      <Field label="Menu items">
        <ArrayList
          items={c.items || []}
          onChange={(next) => set({ items: next })}
          makeNew={() => ({
            label: 'New item',
            hasPanel: false,
            href: '',
            openInNewTab: false,
            columns: [],
            featuredImage: '',
            featuredAlt: '',
            featuredTitle: '',
            featuredText: '',
            featuredHref: '',
            featuredOpenInNewTab: false,
          })}
          addLabel="Add menu item"
          testIdPrefix="mega-item"
          renderItem={(item, idx, patch) => {
            const itemHasPanel = megaItemHasPanel(item);
            return (
            <div className="space-y-2">
              <TextField
                label="Label"
                value={item.label}
                onChange={(v) => patch({ label: v })}
                testId={`mega-item-${idx}-label`}
              />
              <ToggleField
                label="Opens a dropdown panel"
                value={itemHasPanel}
                onChange={(v) => patch({ hasPanel: v })}
                testId={`mega-item-${idx}-haspanel`}
              />
              {!itemHasPanel && (
                <>
                  <LinkField
                    label="Link URL"
                    value={item.href}
                    onChange={(v) => patch({ href: v })}
                    placeholder="/Home or https://…"
                    testId={`mega-item-${idx}-href`}
                  />
                  <ToggleField
                    label="Open link in new tab"
                    value={item.openInNewTab}
                    onChange={(v) => patch({ openInNewTab: v })}
                    testId={`mega-item-${idx}-newtab`}
                  />
                </>
              )}
              {itemHasPanel && (
              <>
              <Field label="Dropdown columns">
                <ArrayList
                  items={item.columns || []}
                  onChange={(next) => patch({ columns: next })}
                  makeNew={() => ({ heading: 'New column', links: [] })}
                  addLabel="Add column"
                  testIdPrefix={`mega-item-${idx}-col`}
                  renderItem={(col, ci, patchCol) => (
                    <div className="space-y-2">
                      <TextField
                        label="Column heading"
                        value={col.heading}
                        onChange={(v) => patchCol({ heading: v })}
                        testId={`mega-item-${idx}-col-${ci}-heading`}
                      />
                      <Field label="Links">
                        <ArrayList
                          items={col.links || []}
                          onChange={(next) => patchCol({ links: next })}
                          makeNew={() => ({ label: 'New link', href: '', description: '', openInNewTab: false })}
                          addLabel="Add link"
                          testIdPrefix={`mega-item-${idx}-col-${ci}-link`}
                          renderItem={(ln, li, patchLink) => (
                            <div className="space-y-2">
                              <TextField
                                label="Label"
                                value={ln.label}
                                onChange={(v) => patchLink({ label: v })}
                                testId={`mega-item-${idx}-col-${ci}-link-${li}-label`}
                              />
                              <LinkField
                                label="URL"
                                value={ln.href}
                                onChange={(v) => patchLink({ href: v })}
                                placeholder="/page or https://…"
                                testId={`mega-item-${idx}-col-${ci}-link-${li}-href`}
                              />
                              <TextField
                                label="Description"
                                value={ln.description}
                                onChange={(v) => patchLink({ description: v })}
                                multiline
                                testId={`mega-item-${idx}-col-${ci}-link-${li}-desc`}
                              />
                              <ToggleField
                                label="Open in new tab"
                                value={ln.openInNewTab}
                                onChange={(v) => patchLink({ openInNewTab: v })}
                                testId={`mega-item-${idx}-col-${ci}-link-${li}-newtab`}
                              />
                            </div>
                          )}
                        />
                      </Field>
                    </div>
                  )}
                />
              </Field>
              <Field label="Featured block (optional)">
                <div className="space-y-2">
                  <ImageField
                    label="Featured image"
                    value={item.featuredImage}
                    alt={item.featuredAlt}
                    onChangeSrc={(v) => patch({ featuredImage: v })}
                    onChangeAlt={(v) => patch({ featuredAlt: v })}
                    testId={`mega-item-${idx}-featured-img`}
                  />
                  <TextField
                    label="Featured title"
                    value={item.featuredTitle}
                    onChange={(v) => patch({ featuredTitle: v })}
                    testId={`mega-item-${idx}-featured-title`}
                  />
                  <TextField
                    label="Featured text"
                    value={item.featuredText}
                    onChange={(v) => patch({ featuredText: v })}
                    multiline
                    testId={`mega-item-${idx}-featured-text`}
                  />
                  <LinkField
                    label="Featured link URL"
                    value={item.featuredHref}
                    onChange={(v) => patch({ featuredHref: v })}
                    placeholder="/page or https://…"
                    testId={`mega-item-${idx}-featured-href`}
                  />
                  <ToggleField
                    label="Open featured link in new tab"
                    value={item.featuredOpenInNewTab}
                    onChange={(v) => patch({ featuredOpenInNewTab: v })}
                    testId={`mega-item-${idx}-featured-newtab`}
                  />
                </div>
              </Field>
              </>
              )}
            </div>
            );
          }}
        />
      </Field>
    </>
  );
}

// PRICING TABLE --------------------------------------------------------------
// Author-friendly pricing layout with 2-6 tiers. Each tier carries its own
// monthly/annual price strings; when `billingToggle` is on, a small inline
// toggle swaps which price is shown without re-rendering anything else on
// the page. The recommended tier is highlighted via the semantic primary
// token (not amber/yellow — see replit.md "Semantic `warning` Color Token"
// rule). All colours route through `var(--cb-color-*)` so tenant branding
// flows through automatically.

function resolveColumns(value, breakpoint) {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return 3;
  if (breakpoint === 'mobile') return Number(value.mobile ?? value.tablet ?? value.desktop ?? 1);
  if (breakpoint === 'tablet') return Number(value.tablet ?? value.desktop ?? 2);
  return Number(value.desktop ?? 3);
}

function buildResponsiveColumnsCss(blockId, columns, gap) {
  if (!blockId) return null;
  const safeId = String(blockId).replace(/["\\]/g, '');
  const sel = `[data-cb="${safeId}"] [data-cb-grid="cols"]`;
  const desk = resolveColumns(columns, 'desktop');
  const tab = resolveColumns(columns, 'tablet');
  const mob = resolveColumns(columns, 'mobile');
  const g = Number.isFinite(Number(gap)) ? Number(gap) : 16;
  const parts = [];
  parts.push(`${sel}{display:grid;gap:${g}px;grid-template-columns:repeat(${Math.max(1, desk)},minmax(0,1fr));}`);
  if (tab !== desk) {
    parts.push(`@media (max-width:${BREAKPOINT_MAX_PX.tablet}px){${sel}{grid-template-columns:repeat(${Math.max(1, tab)},minmax(0,1fr));}}`);
  }
  if (mob !== (tab !== desk ? tab : desk)) {
    parts.push(`@media (max-width:${BREAKPOINT_MAX_PX.mobile}px){${sel}{grid-template-columns:repeat(${Math.max(1, mob)},minmax(0,1fr));}}`);
  }
  return parts.join('');
}

// Per-tier CTA button. Legacy variants (primary/default/outline/ghost) keep
// flowing through buttonClasses unchanged. Tenant variants (tenant-primary /
// tenant-secondary / tenant:<key>) resolve through the same inline-style path
// the Button block uses, including the hover swap. Content (icon + label) and
// background sit vertically centred via items-center/justify-center.
function PricingTierCTA({ tier, index, asEditor, branding }) {
  const variant = tier.ctaVariant || (tier.recommended ? 'primary' : 'outline');
  const isTenant = isTenantButtonVariant(variant);
  const tenantStyle = isTenant ? resolveTenantButtonStyle(variant, branding) : null;
  const [hovered, setHovered] = useState(false);
  const label = tier.ctaLabel;
  const ariaLabel = `${label} — ${tier.name || `Tier ${index + 1}`}`;
  const href = asEditor ? undefined : (tier.ctaHref || '#');
  const onClick = (e) => { if (asEditor) e.preventDefault(); };

  if (isTenant && tenantStyle) {
    const baseline = { ...TENANT_BUTTON_DEFAULT_SIZE, ...(tenantStyle.size || {}) };
    const bg = bgCssFromConfig(hovered ? tenantStyle.hover : tenantStyle.background) || {};
    const border = tenantStyle.border || {};
    const inlineStyle = {
      ...bg,
      width: '100%',
      color: hovered
        ? tenantStyle.hoverTextColor || tenantStyle.textColor || '#ffffff'
        : tenantStyle.textColor || '#ffffff',
      borderRadius: `${tenantStyle.radius ?? 6}px`,
      border:
        border.width > 0
          ? `${border.width}px ${border.style || 'solid'} ${border.color || '#000000'}`
          : 'none',
      paddingTop: `${baseline.paddingY}px`,
      paddingBottom: `${baseline.paddingY}px`,
      paddingLeft: `${baseline.paddingX}px`,
      paddingRight: `${baseline.paddingX}px`,
      fontSize: `${baseline.fontSize}px`,
      transition: 'background-color 0.2s ease, color 0.2s ease, background 0.2s ease',
    };
    const styleIconCfg = tenantStyle.icon || null;
    const StyleIcon = styleIconCfg?.name ? getLucideIcon(styleIconCfg.name) : null;
    const styleIconSize = StyleIcon && Number.isFinite(styleIconCfg.size) ? styleIconCfg.size : 18;
    const styleIconColor = StyleIcon ? (styleIconCfg.color || undefined) : undefined;
    const styleIconAfter = StyleIcon && styleIconCfg.position === 'after';
    const styleIconEl = StyleIcon ? (
      <StyleIcon style={{ width: styleIconSize, height: styleIconSize, color: styleIconColor }} />
    ) : null;
    return (
      <a
        href={href}
        onClick={onClick}
        className="flex w-full items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap"
        style={inlineStyle}
        aria-label={ariaLabel}
        data-testid={`link-pricing-cta-${index}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {styleIconAfter ? (
          <>
            <span>{label}</span>
            {styleIconEl}
          </>
        ) : (
          <>
            {styleIconEl}
            <span>{label}</span>
          </>
        )}
      </a>
    );
  }

  return (
    <a
      href={href}
      onClick={onClick}
      className={buttonClasses(variant, 'default')}
      style={{ width: '100%', justifyContent: 'center' }}
      aria-label={ariaLabel}
      data-testid={`link-pricing-cta-${index}`}
    >
      <span>{label}</span>
    </a>
  );
}

function PricingTableRender({ block, asEditor, breakpoint }) {
  const c = block.content || {};
  const tiers = Array.isArray(c.tiers) ? c.tiers.slice(0, 6) : [];
  const showToggle = !!c.billingToggle;
  const [billing, setBilling] = useState(c.defaultBilling === 'annual' ? 'annual' : 'monthly');
  const headingLevel = Math.max(1, Math.min(6, Number(c.headingLevel) || 2));
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const bpForInline = isPreview ? breakpoint : 'desktop';
  const columnsCss = !isPreview ? buildResponsiveColumnsCss(block.id, c.columns, c.gap) : null;
  const previewCols = isPreview ? resolveColumns(c.columns, breakpoint) : null;
  const recommendedBadge = c.recommendedBadgeLabel || 'Most popular';

  // Tenant typography: resolve the chosen styles for the heading,
  // sub-heading and card content. Mirrors the Hero block — when a style
  // resolves we build an inline style from it (pinning the per-breakpoint
  // value in the editor preview) and emit @media CSS for the public
  // visitor; when nothing is selected we keep the legacy hardcoded look.
  const { styles: tenantStyles, resolved: stylesResolved } = useTenantTypographyStylesState();
  const branding = useTenantBranding()?.branding || null;
  const headingStyleObj = resolveTenantStyle(c.headingTypographyStyleId, tenantStyles);
  const subheadingStyleObj = resolveTenantStyle(c.subheadingTypographyStyleId, tenantStyles);
  const cardStyleObj = resolveTenantStyle(c.cardTypographyStyleId, tenantStyles);
  const awaitingHeading = isAwaitingTypographyStyle(c.headingTypographyStyleId, headingStyleObj, stylesResolved);
  const awaitingSubheading = isAwaitingTypographyStyle(c.subheadingTypographyStyleId, subheadingStyleObj, stylesResolved);
  const awaitingCard = isAwaitingTypographyStyle(c.cardTypographyStyleId, cardStyleObj, stylesResolved);

  const Heading = headingStyleObj ? tagForTypographyStyleType(headingStyleObj.style_type) : `h${headingLevel}`;
  const Sub = subheadingStyleObj ? tagForTypographyStyleType(subheadingStyleObj.style_type) : 'p';

  const headingInline = {
    margin: 0,
    fontSize: '1.5rem',
    fontWeight: 600,
    color: 'var(--cb-color-on-surface, #0f172a)',
    ...(headingStyleObj ? buildTypographyInlineStyle(headingStyleObj, { breakpoint: bpForInline }) : {}),
  };
  if (Number.isFinite(c.headingFontSize) && c.headingFontSize > 0) headingInline.fontSize = `${c.headingFontSize}px`;
  if (c.headingColor) headingInline.color = c.headingColor;
  if (awaitingHeading) headingInline.visibility = 'hidden';

  const subheadingInline = {
    marginTop: 4,
    fontSize: '0.875rem',
    color: 'var(--cb-color-on-surface-muted, #475569)',
    ...(subheadingStyleObj ? buildTypographyInlineStyle(subheadingStyleObj, { breakpoint: bpForInline }) : {}),
  };
  if (Number.isFinite(c.subheadingFontSize) && c.subheadingFontSize > 0) subheadingInline.fontSize = `${c.subheadingFontSize}px`;
  if (c.subheadingColor) subheadingInline.color = c.subheadingColor;
  if (awaitingSubheading) subheadingInline.visibility = 'hidden';

  // Card content typography. When active (a style is chosen, or a size/colour
  // override is set), the card's base text style lives on the <article> and
  // the individual text elements use em-relative sizes so the existing visual
  // hierarchy (name / price / description) scales from that base. When
  // inactive every card keeps its original classes/colours (zero regression).
  const cardActive = !!cardStyleObj
    || awaitingCard
    || (Number.isFinite(c.cardFontSize) && c.cardFontSize > 0)
    || !!c.cardColor;
  const cardPrimaryColor = c.cardColor || cardStyleObj?.color || 'var(--cb-color-on-surface, #0f172a)';
  const cardMutedColor = c.cardColor || 'var(--cb-color-on-surface-muted, #475569)';
  const cardBaseTypo = cardActive
    ? (() => {
        const base = { fontSize: '1rem' };
        if (cardStyleObj) {
          Object.assign(base, buildTypographyInlineStyle(cardStyleObj, { breakpoint: bpForInline, omitMarginBottom: true }));
        }
        if (Number.isFinite(c.cardFontSize) && c.cardFontSize > 0) base.fontSize = `${c.cardFontSize}px`;
        // Colours are applied per text element (primary vs muted) below.
        delete base.color;
        if (awaitingCard) base.visibility = 'hidden';
        return base;
      })()
    : null;

  const safeBlockId = String(block.id || '').replace(/["\\]/g, '');
  const typographyResponsiveCss = !isPreview
    ? [
        headingStyleObj && hasResponsiveTypographyOverride(headingStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="pricing-heading"]`, headingStyleObj)
          : null,
        subheadingStyleObj && hasResponsiveTypographyOverride(subheadingStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="pricing-subheading"]`, subheadingStyleObj)
          : null,
        cardStyleObj && hasResponsiveTypographyOverride(cardStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="pricing-card"]`, cardStyleObj)
          : null,
      ].filter(Boolean).join('') || null
    : null;

  return (
    <div className="w-full h-full overflow-auto">
      {columnsCss && <style dangerouslySetInnerHTML={{ __html: columnsCss }} />}
      {typographyResponsiveCss && <style dangerouslySetInnerHTML={{ __html: typographyResponsiveCss }} />}
      {(c.heading || c.subheading) && (
        <div className="mb-4 text-center">
          {c.heading && (
            <Heading style={headingInline} data-tg-r="pricing-heading">
              {c.heading}
            </Heading>
          )}
          {c.subheading && (
            <Sub style={subheadingInline} data-tg-r="pricing-subheading">
              {c.subheading}
            </Sub>
          )}
        </div>
      )}
      {showToggle && (
        <div className="mb-4 flex items-center justify-center gap-2 text-sm" role="group" aria-label="Billing period">
          <button
            type="button"
            onClick={() => { if (!asEditor) setBilling('monthly'); }}
            aria-pressed={billing === 'monthly'}
            className={`px-3 py-1 rounded-md border text-sm ${billing === 'monthly' ? 'bg-primary text-primary-foreground border-primary' : 'bg-transparent border-slate-300 text-slate-700'}`}
            data-testid="button-pricing-billing-monthly"
          >
            {c.monthlyLabel || 'Monthly'}
          </button>
          <button
            type="button"
            onClick={() => { if (!asEditor) setBilling('annual'); }}
            aria-pressed={billing === 'annual'}
            className={`px-3 py-1 rounded-md border text-sm ${billing === 'annual' ? 'bg-primary text-primary-foreground border-primary' : 'bg-transparent border-slate-300 text-slate-700'}`}
            data-testid="button-pricing-billing-annual"
          >
            {c.annualLabel || 'Annual'}
          </button>
          {c.annualNote && (
            <span className="ml-1 text-xs" style={{ color: 'var(--cb-color-on-surface-muted, #475569)' }}>
              {c.annualNote}
            </span>
          )}
        </div>
      )}
      <div
        data-cb-grid="cols"
        style={isPreview ? {
          display: 'grid',
          gap: `${Number(c.gap) || 16}px`,
          gridTemplateColumns: `repeat(${Math.max(1, previewCols || 1)}, minmax(0, 1fr))`,
        } : undefined}
      >
        {tiers.map((t, i) => {
          const price = billing === 'annual' ? (t.annualPrice || t.monthlyPrice) : (t.monthlyPrice || t.annualPrice);
          const tierStyle = t.recommended
            ? {
                background: 'var(--cb-color-surface, #ffffff)',
                border: '2px solid var(--cb-color-primary, #0f172a)',
                borderRadius: 8,
                padding: 20,
                boxShadow: '0 4px 12px rgba(15,23,42,0.08)',
                position: 'relative',
              }
            : {
                background: 'var(--cb-color-surface, #ffffff)',
                border: '1px solid var(--cb-color-border, #e2e8f0)',
                borderRadius: 8,
                padding: 20,
              };
          return (
            <article
              key={i}
              data-cb-pricing-tier={i}
              data-cb-pricing-recommended={t.recommended ? 'true' : undefined}
              data-tg-r="pricing-card"
              style={cardActive ? { ...tierStyle, ...cardBaseTypo } : tierStyle}
              aria-label={`${t.name || `Tier ${i + 1}`} pricing tier`}
            >
              {t.recommended && (
                <span
                  className="absolute -top-3 left-1/2 -translate-x-1/2 inline-block px-2 py-0.5 text-xs font-medium rounded-md"
                  style={{
                    background: 'var(--cb-color-primary, #0f172a)',
                    color: 'var(--cb-color-on-primary, #ffffff)',
                  }}
                >
                  {recommendedBadge}
                </span>
              )}
              <h3
                className={cardActive ? 'font-semibold' : 'text-base font-semibold'}
                style={cardActive
                  ? { margin: 0, fontSize: '1em', color: cardPrimaryColor }
                  : { margin: 0, color: 'var(--cb-color-on-surface, #0f172a)' }}
              >
                {t.name || `Tier ${i + 1}`}
              </h3>
              {t.description && (
                <p
                  className={cardActive ? '' : 'mt-1 text-sm'}
                  style={cardActive
                    ? { marginTop: 4, fontSize: '0.875em', color: cardMutedColor }
                    : { color: 'var(--cb-color-on-surface-muted, #475569)' }}
                >
                  {t.description}
                </p>
              )}
              <div className="mt-3 flex items-baseline gap-1">
                <span
                  className={cardActive ? 'font-bold' : 'text-3xl font-bold'}
                  style={cardActive
                    ? { fontSize: '1.875em', color: cardPrimaryColor }
                    : { color: 'var(--cb-color-on-surface, #0f172a)' }}
                >
                  {price || '—'}
                </span>
                {t.period && (
                  <span
                    className={cardActive ? '' : 'text-sm'}
                    style={cardActive
                      ? { fontSize: '0.875em', color: cardMutedColor }
                      : { color: 'var(--cb-color-on-surface-muted, #475569)' }}
                  >
                    {t.period}
                  </span>
                )}
              </div>
              {Array.isArray(t.features) && t.features.length > 0 && (
                <ul
                  className={`mt-4 space-y-1.5 ${cardActive ? '' : 'text-sm'}`}
                  style={{
                    listStyle: 'none',
                    padding: 0,
                    margin: 0,
                    color: cardActive ? cardPrimaryColor : 'var(--cb-color-on-surface, #0f172a)',
                    ...(cardActive ? { fontSize: '0.875em' } : {}),
                  }}
                >
                  {t.features.filter(Boolean).map((f, fi) => {
                    const feat = typeof f === 'string' ? { text: f, included: true, tooltip: '' } : (f || {});
                    const included = feat.included !== false;
                    const Glyph = included ? Check : X;
                    const srPrefix = included ? 'Included: ' : 'Not included: ';
                    return (
                      <li
                        key={fi}
                        className="flex items-center gap-2"
                        title={feat.tooltip || undefined}
                        style={{ opacity: included ? 1 : 0.65 }}
                      >
                        <Glyph
                          className="w-4 h-4 shrink-0"
                          style={{
                            color: included
                              ? (c.tickColor || 'var(--cb-color-primary, #0f172a)')
                              : (c.crossColor || 'var(--cb-color-on-surface-muted, #64748b)'),
                          }}
                          aria-hidden="true"
                        />
                        <span>
                          <span className="sr-only">{srPrefix}</span>
                          <span style={{ textDecoration: included ? 'none' : 'line-through' }}>{feat.text || ''}</span>
                          {feat.tooltip && (
                            <span className="sr-only"> — {feat.tooltip}</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {t.ctaLabel && (
                <div className="mt-5">
                  <PricingTierCTA tier={t} index={i} asEditor={asEditor} branding={branding} />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function PricingTableInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const setColumns = (bp, val) => set({ columns: { ...(c.columns || {}), [bp]: Math.max(1, Math.min(6, Number(val) || 1)) } });
  const tiers = Array.isArray(c.tiers) ? c.tiers : [];
  // Tenant branded button styles, sourced the same way the Button/Hero
  // inspectors build their custom style list, so the per-tier CTA picker
  // can offer the tenant's configured button styles alongside the legacy ones.
  const branding = useTenantBranding()?.branding || null;
  const customStyleEntries = (() => {
    const styles =
      branding?.buttonStyles ||
      branding?.brandingConfig?.button_styles ||
      null;
    if (!styles || typeof styles !== 'object') return [];
    return Object.entries(styles)
      .filter(([k, v]) => k !== 'primary' && k !== 'secondary' && v && typeof v === 'object')
      .map(([k, v]) => ({ key: k, label: v.label || k }));
  })();
  return (
    <>
      <TextField label="Heading" value={c.heading} onChange={(v) => set({ heading: v })} testId="input-pricing-heading" />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 2)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-pricing-heading-level"
      />
      <TypographyStyleField
        label="Heading style"
        value={c.headingTypographyStyleId}
        onChange={(id, picked) => {
          // Mirror the chosen style's heading level so the block degrades to
          // the right heading if the tenant style is later removed (matches Hero).
          const fallback = fallbackHeadingAsForStyleType(picked && picked.style_type);
          set({
            headingTypographyStyleId: id,
            ...(fallback ? { headingLevel: Number(fallback) } : {}),
          });
        }}
        testId="select-pricing-heading-typography"
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Heading size (px)"
          min={8}
          max={120}
          value={Number.isFinite(c.headingFontSize) ? c.headingFontSize : ''}
          onChange={(v) => set({ headingFontSize: v === '' || v == null ? null : Math.max(8, Math.min(120, Number(v) || 0)) })}
          testId="input-pricing-heading-size"
        />
        <ColorField label="Heading colour" value={c.headingColor} onChange={(v) => set({ headingColor: v })} testId="input-pricing-heading-color" />
      </div>
      <TextField label="Subheading" multiline value={c.subheading} onChange={(v) => set({ subheading: v })} testId="input-pricing-subheading" />
      <TypographyStyleField
        label="Sub-heading style"
        value={c.subheadingTypographyStyleId}
        onChange={(id) => set({ subheadingTypographyStyleId: id })}
        testId="select-pricing-subheading-typography"
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Sub-heading size (px)"
          min={8}
          max={80}
          value={Number.isFinite(c.subheadingFontSize) ? c.subheadingFontSize : ''}
          onChange={(v) => set({ subheadingFontSize: v === '' || v == null ? null : Math.max(8, Math.min(80, Number(v) || 0)) })}
          testId="input-pricing-subheading-size"
        />
        <ColorField label="Sub-heading colour" value={c.subheadingColor} onChange={(v) => set({ subheadingColor: v })} testId="input-pricing-subheading-color" />
      </div>
      <TypographyStyleField
        label="Card content style"
        value={c.cardTypographyStyleId}
        onChange={(id) => set({ cardTypographyStyleId: id })}
        testId="select-pricing-card-typography"
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Card text size (px)"
          min={8}
          max={80}
          value={Number.isFinite(c.cardFontSize) ? c.cardFontSize : ''}
          onChange={(v) => set({ cardFontSize: v === '' || v == null ? null : Math.max(8, Math.min(80, Number(v) || 0)) })}
          testId="input-pricing-card-size"
        />
        <ColorField label="Card text colour" value={c.cardColor} onChange={(v) => set({ cardColor: v })} testId="input-pricing-card-color" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ColorField label="Tick icon colour" value={c.tickColor} onChange={(v) => set({ tickColor: v })} testId="input-pricing-tick-color" />
        <ColorField label="Cross icon colour" value={c.crossColor} onChange={(v) => set({ crossColor: v })} testId="input-pricing-cross-color" />
      </div>
      <ToggleField
        label="Show monthly / annual toggle"
        value={c.billingToggle}
        onChange={(v) => set({ billingToggle: v })}
        testId="toggle-pricing-billing"
      />
      {c.billingToggle && (
        <>
          <SelectField
            label="Default billing period"
            value={c.defaultBilling || 'monthly'}
            onChange={(v) => set({ defaultBilling: v })}
            options={[
              { value: 'monthly', label: 'Monthly' },
              { value: 'annual', label: 'Annual' },
            ]}
            testId="select-pricing-default-billing"
          />
          <TextField label="Monthly label" value={c.monthlyLabel} onChange={(v) => set({ monthlyLabel: v })} testId="input-pricing-monthly-label" />
          <TextField label="Annual label" value={c.annualLabel} onChange={(v) => set({ annualLabel: v })} testId="input-pricing-annual-label" />
          <TextField label="Annual note" value={c.annualNote} onChange={(v) => set({ annualNote: v })} testId="input-pricing-annual-note" />
        </>
      )}
      <TextField
        label="Recommended badge label"
        value={c.recommendedBadgeLabel}
        onChange={(v) => set({ recommendedBadgeLabel: v })}
        testId="input-pricing-recommended-label"
      />
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Cols (desktop)" min={1} max={6} value={resolveColumns(c.columns, 'desktop')} onChange={(v) => setColumns('desktop', v)} testId="input-pricing-cols-desktop" />
        <NumberField label="Cols (tablet)" min={1} max={4} value={resolveColumns(c.columns, 'tablet')} onChange={(v) => setColumns('tablet', v)} testId="input-pricing-cols-tablet" />
        <NumberField label="Cols (mobile)" min={1} max={4} value={resolveColumns(c.columns, 'mobile')} onChange={(v) => setColumns('mobile', v)} testId="input-pricing-cols-mobile" />
      </div>
      <NumberField label="Gap (px)" min={0} max={64} value={c.gap || 16} onChange={(v) => set({ gap: Number(v) || 0 })} testId="input-pricing-gap" />
      <SelectField
        label="Recommended tier (highlighted)"
        value={(() => {
          const idx = tiers.findIndex((t) => t?.recommended);
          return idx >= 0 ? String(idx) : 'none';
        })()}
        onChange={(v) => {
          const target = v === 'none' ? -1 : Number(v);
          set({ tiers: tiers.map((t, i) => ({ ...t, recommended: i === target })) });
        }}
        options={[
          { value: 'none', label: 'No tier highlighted' },
          ...tiers.map((t, i) => ({ value: String(i), label: t?.name || `Tier ${i + 1}` })),
        ]}
        testId="select-pricing-recommended"
      />
      <Field label="Tiers (2–6)">
        <ArrayList
          items={tiers}
          collapsible
          getItemTitle={(item, idx) => (item?.name && String(item.name).trim()) || `Tier ${idx + 1}`}
          onChange={(next) => set({ tiers: next.slice(0, 6) })}
          makeNew={() => ({
            name: 'New tier', monthlyPrice: '£0', annualPrice: '£0', period: '/month',
            description: '', features: [{ text: 'Feature one', included: true, tooltip: '' }],
            ctaLabel: 'Choose', ctaHref: '#', ctaVariant: 'outline', recommended: false,
          })}
          duplicateItem={(item) => ({
            ...JSON.parse(JSON.stringify(item || {})),
            recommended: false,
          })}
          maxItems={6}
          addLabel={tiers.length >= 6 ? 'Maximum 6 tiers' : 'Add tier'}
          testIdPrefix="pricing-tier"
          renderItem={(item, idx, patch) => {
            const features = Array.isArray(item.features)
              ? item.features.map((f) => (typeof f === 'string' ? { text: f, included: true, tooltip: '' } : { text: '', included: true, tooltip: '', ...(f || {}) }))
              : [];
            const patchFeatures = (next) => patch({ features: next });
            return (
              <>
                <TextField label="Name" value={item.name} onChange={(v) => patch({ name: v })} testId={`pricing-tier-${idx}-name`} />
                <TextField label="Description" value={item.description} onChange={(v) => patch({ description: v })} testId={`pricing-tier-${idx}-desc`} />
                <div className="grid grid-cols-2 gap-2">
                  <TextField label="Monthly price" value={item.monthlyPrice} onChange={(v) => patch({ monthlyPrice: v })} testId={`pricing-tier-${idx}-monthly`} />
                  <TextField label="Annual price" value={item.annualPrice} onChange={(v) => patch({ annualPrice: v })} testId={`pricing-tier-${idx}-annual`} />
                </div>
                <TextField label="Period suffix" value={item.period} onChange={(v) => patch({ period: v })} testId={`pricing-tier-${idx}-period`} />
                <Field label="Features">
                  <ArrayList
                    items={features}
                    onChange={patchFeatures}
                    makeNew={() => ({ text: 'New feature', included: true, tooltip: '' })}
                    addLabel="Add feature"
                    testIdPrefix={`pricing-tier-${idx}-feature`}
                    renderItem={(feat, fi, patchFeat) => (
                      <>
                        <TextField
                          label="Text"
                          value={feat.text}
                          onChange={(v) => patchFeat({ text: v })}
                          testId={`pricing-tier-${idx}-feature-${fi}-text`}
                        />
                        <ToggleField
                          label="Included in this tier"
                          value={feat.included !== false}
                          onChange={(v) => patchFeat({ included: v })}
                          testId={`pricing-tier-${idx}-feature-${fi}-included`}
                        />
                        <TextField
                          label="Tooltip (optional)"
                          value={feat.tooltip}
                          onChange={(v) => patchFeat({ tooltip: v })}
                          testId={`pricing-tier-${idx}-feature-${fi}-tooltip`}
                        />
                      </>
                    )}
                  />
                </Field>
                <TextField label="CTA label" value={item.ctaLabel} onChange={(v) => patch({ ctaLabel: v })} testId={`pricing-tier-${idx}-cta-label`} />
                <LinkField label="CTA link" value={item.ctaHref} onChange={(v) => patch({ ctaHref: v })} testId={`pricing-tier-${idx}-cta-href`} />
                <SelectField
                  label="CTA variant"
                  value={item.ctaVariant || 'outline'}
                  onChange={(v) => patch({ ctaVariant: v })}
                  options={[
                    { value: 'primary', label: 'Primary' },
                    { value: 'default', label: 'Default' },
                    { value: 'outline', label: 'Outline' },
                    { value: 'ghost', label: 'Ghost' },
                    { value: 'tenant-primary', label: 'Tenant primary (branded)' },
                    { value: 'tenant-secondary', label: 'Tenant secondary (branded)' },
                    ...customStyleEntries.map((e) => ({
                      value: `tenant:${e.key}`,
                      label: `Tenant: ${e.label}`,
                    })),
                  ]}
                  testId={`pricing-tier-${idx}-cta-variant`}
                />
                <p className="text-xs text-muted-foreground">
                  Use the "Recommended tier" picker above the list to highlight one tier (mutually exclusive).
                </p>
              </>
            );
          }}
        />
        {tiers.length > 6 && (
          <p className="text-xs text-warning mt-1">Only the first 6 tiers will render.</p>
        )}
      </Field>
    </>
  );
}

// TESTIMONIAL GRID -----------------------------------------------------------
// Grid layout of testimonial cards. Each item renders as a <figure> with a
// <blockquote> and a <figcaption>/<cite> for the author. Distinct from the
// older "Testimonials" block (single/carousel/grid layouts mixed together)
// — this one is grid-only with per-device column control and optional
// avatar images. Uses tenant branding tokens for colours.

function TestimonialGridRender({ block, breakpoint }) {
  const c = block.content || {};
  const items = Array.isArray(c.items) ? c.items : [];
  const { styles: tenantStyles, resolved: stylesResolved } = useTenantTypographyStylesState();
  const headingStyleObj = resolveTenantStyle(c.headingTypographyStyleId, tenantStyles);
  const quoteStyleObj = resolveTenantStyle(c.quoteTypographyStyleId, tenantStyles);
  const attributionStyleObj = resolveTenantStyle(c.attributionTypographyStyleId, tenantStyles);
  const awaitingHeading = isAwaitingTypographyStyle(c.headingTypographyStyleId, headingStyleObj, stylesResolved);
  const awaitingQuote = isAwaitingTypographyStyle(c.quoteTypographyStyleId, quoteStyleObj, stylesResolved);
  const awaitingAttribution = isAwaitingTypographyStyle(c.attributionTypographyStyleId, attributionStyleObj, stylesResolved);
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const bpForInline = isPreview ? breakpoint : 'desktop';
  const headingLevel = Math.max(1, Math.min(6, Number(c.headingLevel) || 2));
  const Heading = headingStyleObj
    ? tagForTypographyStyleType(headingStyleObj.style_type)
    : `h${headingLevel}`;
  const headingInlineBase = headingStyleObj
    ? { margin: '0 0 1rem', color: 'var(--cb-color-on-surface, #0f172a)', ...buildTypographyInlineStyle(headingStyleObj, { breakpoint: bpForInline }) }
    : { margin: '0 0 1rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--cb-color-on-surface, #0f172a)' };
  const headingInline = awaitingHeading ? { ...headingInlineBase, visibility: 'hidden' } : headingInlineBase;
  let quoteInline = quoteStyleObj
    ? buildTypographyInlineStyle(quoteStyleObj, { breakpoint: bpForInline })
    : null;
  if (awaitingQuote) quoteInline = { ...(quoteInline || {}), visibility: 'hidden' };
  let attributionInline = attributionStyleObj
    ? buildTypographyInlineStyle(attributionStyleObj, { breakpoint: bpForInline })
    : null;
  if (awaitingAttribution) attributionInline = { ...(attributionInline || {}), visibility: 'hidden' };
  const safeBlockId = String(block.id || '').replace(/["\\]/g, '');
  const responsiveCss = !isPreview ? buildResponsiveColumnsCss(block.id, c.columns, c.gap) : null;
  const typographyResponsiveCss = !isPreview
    ? [
        headingStyleObj && hasResponsiveTypographyOverride(headingStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="tg-heading"]`, headingStyleObj)
          : null,
        quoteStyleObj && hasResponsiveTypographyOverride(quoteStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="tg-quote"]`, quoteStyleObj)
          : null,
        attributionStyleObj && hasResponsiveTypographyOverride(attributionStyleObj)
          ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="tg-attribution"]`, attributionStyleObj)
          : null,
      ].filter(Boolean).join('') || null
    : null;
  const previewCols = isPreview ? resolveColumns(c.columns, breakpoint) : null;
  const innerPaddingStyle = {
    paddingTop: c.innerPaddingTop ?? 0,
    paddingRight: c.innerPaddingRight ?? 0,
    paddingBottom: c.innerPaddingBottom ?? 0,
    paddingLeft: c.innerPaddingLeft ?? 0,
  };
  return (
    <div className="w-full h-full overflow-auto">
      {responsiveCss && <style dangerouslySetInnerHTML={{ __html: responsiveCss }} />}
      {typographyResponsiveCss && <style dangerouslySetInnerHTML={{ __html: typographyResponsiveCss }} />}
      <div style={innerPaddingStyle}>
      {c.heading && (
        <Heading
          data-tg-r="tg-heading"
          className="text-center"
          style={headingInline}
        >
          {c.heading}
        </Heading>
      )}
      <div
        data-cb-grid="cols"
        style={isPreview ? {
          display: 'grid',
          gap: `${Number(c.gap) || 16}px`,
          gridTemplateColumns: `repeat(${Math.max(1, previewCols || 1)}, minmax(0, 1fr))`,
        } : undefined}
      >
        {items.map((t, i) => (
          <figure
            key={i}
            style={{
              background: 'var(--cb-color-surface, #ffffff)',
              border: '1px solid var(--cb-color-border, #e2e8f0)',
              borderRadius: 8,
              padding: 20,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <MessageSquareQuote
              className="w-5 h-5"
              style={{ color: 'var(--cb-color-primary, #0f172a)' }}
              aria-hidden="true"
            />
            <blockquote
              data-tg-r="tg-quote"
              style={{
                margin: 0,
                color: 'var(--cb-color-on-surface, #0f172a)',
                ...(quoteInline || { fontSize: '0.95rem', lineHeight: 1.5 }),
              }}
            >
              {t.quote}
            </blockquote>
            <figcaption
              data-tg-r="tg-attribution"
              className="flex items-center gap-3 mt-auto"
              style={{
                color: 'var(--cb-color-on-surface-muted, #475569)',
                ...(attributionInline || { fontSize: '0.875rem' }),
              }}
            >
              {t.avatarUrl ? (
                <img
                  src={t.avatarUrl}
                  alt={t.avatarAlt || ''}
                  loading="lazy"
                  decoding="async"
                  className="w-10 h-10 rounded-full object-cover shrink-0"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <cite style={{ fontStyle: 'normal', fontWeight: 600, color: 'var(--cb-color-on-surface, #0f172a)', display: 'block' }}>
                  {t.author}
                </cite>
                {(t.role || t.company) && (
                  <div className="truncate">
                    {[t.role, t.company].filter(Boolean).join(', ')}
                  </div>
                )}
              </div>
              {t.companyLogoUrl ? (
                <img
                  src={t.companyLogoUrl}
                  alt={t.companyLogoAlt || ''}
                  loading="lazy"
                  decoding="async"
                  className="h-6 w-auto object-contain shrink-0 ml-auto opacity-80"
                  style={{ maxWidth: 96 }}
                />
              ) : null}
            </figcaption>
          </figure>
        ))}
      </div>
      </div>
    </div>
  );
}

function TestimonialGridInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const setColumns = (bp, val) => set({ columns: { ...(c.columns || {}), [bp]: Math.max(1, Math.min(4, Number(val) || 1)) } });
  return (
    <>
      <TextField label="Heading" value={c.heading} onChange={(v) => set({ heading: v })} testId="input-testimonial-grid-heading" />
      <TypographyStyleField
        label="Title style"
        value={c.headingTypographyStyleId}
        onChange={(id, picked) => {
          const fallback = fallbackHeadingAsForStyleType(picked && picked.style_type);
          set({
            headingTypographyStyleId: id,
            ...(fallback ? { headingLevel: Number(fallback) } : {}),
          });
        }}
        testId="select-testimonial-grid-heading-typography"
      />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 2)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-testimonial-grid-heading-level"
      />
      <TypographyStyleField
        label="Quote style"
        value={c.quoteTypographyStyleId}
        onChange={(id) => set({ quoteTypographyStyleId: id })}
        testId="select-testimonial-grid-quote-typography"
      />
      <TypographyStyleField
        label="Attribution style"
        value={c.attributionTypographyStyleId}
        onChange={(id) => set({ attributionTypographyStyleId: id })}
        testId="select-testimonial-grid-attribution-typography"
      />
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Cols (desktop)" min={1} max={4} value={resolveColumns(c.columns, 'desktop')} onChange={(v) => setColumns('desktop', v)} testId="input-testimonial-grid-cols-desktop" />
        <NumberField label="Cols (tablet)" min={1} max={4} value={resolveColumns(c.columns, 'tablet')} onChange={(v) => setColumns('tablet', v)} testId="input-testimonial-grid-cols-tablet" />
        <NumberField label="Cols (mobile)" min={1} max={4} value={resolveColumns(c.columns, 'mobile')} onChange={(v) => setColumns('mobile', v)} testId="input-testimonial-grid-cols-mobile" />
      </div>
      <NumberField label="Gap (px)" min={0} max={64} value={c.gap || 16} onChange={(v) => set({ gap: Number(v) || 0 })} testId="input-testimonial-grid-gap" />
      <div className="pt-2 mt-2 border-t border-slate-200">
        <div className="text-xs font-semibold text-slate-700">Internal padding</div>
        <p className="text-xs text-slate-500 mt-0.5">Space between the block background and the grid content, in px.</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Top"
          min={0}
          value={c.innerPaddingTop ?? 0}
          onChange={(v) => set({ innerPaddingTop: Math.max(0, Number(v) || 0) })}
          testId="input-testimonial-grid-inner-padding-top"
        />
        <NumberField
          label="Right"
          min={0}
          value={c.innerPaddingRight ?? 0}
          onChange={(v) => set({ innerPaddingRight: Math.max(0, Number(v) || 0) })}
          testId="input-testimonial-grid-inner-padding-right"
        />
        <NumberField
          label="Bottom"
          min={0}
          value={c.innerPaddingBottom ?? 0}
          onChange={(v) => set({ innerPaddingBottom: Math.max(0, Number(v) || 0) })}
          testId="input-testimonial-grid-inner-padding-bottom"
        />
        <NumberField
          label="Left"
          min={0}
          value={c.innerPaddingLeft ?? 0}
          onChange={(v) => set({ innerPaddingLeft: Math.max(0, Number(v) || 0) })}
          testId="input-testimonial-grid-inner-padding-left"
        />
      </div>
      <Field label="Testimonials">
        <ArrayList
          items={c.items || []}
          onChange={(next) => set({ items: next })}
          makeNew={() => ({ quote: 'A short, punchy quote.', author: 'Name', role: '', company: '', avatarUrl: '', avatarAlt: '', companyLogoUrl: '', companyLogoAlt: '' })}
          addLabel="Add testimonial"
          testIdPrefix="testimonial-grid"
          renderItem={(item, idx, patch) => (
            <>
              <TextField label="Quote" multiline value={item.quote} onChange={(v) => patch({ quote: v })} testId={`testimonial-grid-${idx}-quote`} />
              <TextField label="Author" value={item.author} onChange={(v) => patch({ author: v })} testId={`testimonial-grid-${idx}-author`} />
              <div className="grid grid-cols-2 gap-2">
                <TextField label="Role" value={item.role} onChange={(v) => patch({ role: v })} testId={`testimonial-grid-${idx}-role`} />
                <TextField label="Company" value={item.company} onChange={(v) => patch({ company: v })} testId={`testimonial-grid-${idx}-company`} />
              </div>
              <ImageField
                label="Avatar (optional)"
                value={item.avatarUrl}
                alt={item.avatarAlt}
                onChangeSrc={(v) => patch({ avatarUrl: v })}
                onChangeAlt={(v) => patch({ avatarAlt: v })}
                testId={`testimonial-grid-${idx}-avatar`}
              />
              <ImageField
                label="Company logo (optional)"
                value={item.companyLogoUrl}
                alt={item.companyLogoAlt}
                onChangeSrc={(v) => patch({ companyLogoUrl: v })}
                onChangeAlt={(v) => patch({ companyLogoAlt: v })}
                testId={`testimonial-grid-${idx}-company-logo`}
              />
            </>
          )}
        />
      </Field>
    </>
  );
}

// SECTION --------------------------------------------------------------------
// A visual grouping primitive. The canvas itself is flat (absolute
// positioning), so Section acts as a styled background "band" / container
// frame behind other blocks placed over it (controlled via z-index). Its
// own appearance (background, border, padding) comes from block.style; the
// inner content offers a max-width centering rail and an optional editor
// label so authors can tell sections apart from regular boxes.
// Section/Hero background-image + overlay CSS builders now live in the shared
// module `@/lib/canvasBackground` (imported at the top of this file) so the
// authenticated-portal sidebar branding can reuse the exact same CSS-generation
// code. They are re-exported here for existing importers (e.g. dynamicBlocks.jsx).
export { buildSectionGradientBackground, buildSectionOverlayBackground };

// Horizontal colour-bar preview of the current stops, with draggable +
// keyboard-accessible handles (one per stop). The bar always renders the
// gradient left→right (90deg) regardless of the block's actual direction so
// authors get a consistent, design-tool-style read of the colour transitions
// and stop spacing. Dragging a handle (or arrow keys when focused) rewrites
// that stop's position via `onChangePosition(index, pct)`.
function GradientPreviewBar({ stops, onChangePosition, testIdPrefix }) {
  const barRef = useRef(null);
  const [dragIndex, setDragIndex] = useState(-1);
  const previewCss = `linear-gradient(90deg, ${buildGradientStopList(stops)})`;

  const pctFromClientX = (clientX) => {
    const el = barRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(100, Math.round(ratio * 100)));
  };

  const handlePointerDown = (i) => (e) => {
    e.preventDefault();
    setDragIndex(i);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw in some environments; dragging still works
      // via the move handler below, so swallow and continue.
    }
    const pct = pctFromClientX(e.clientX);
    if (pct !== null) onChangePosition(i, pct);
  };

  const handlePointerMove = (i) => (e) => {
    if (dragIndex !== i) return;
    const pct = pctFromClientX(e.clientX);
    if (pct !== null) onChangePosition(i, pct);
  };

  const endDrag = (e) => {
    if (dragIndex === -1) return;
    setDragIndex(-1);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore: releasing a capture that was never (or already) released.
    }
  };

  const handleKeyDown = (i, current) => (e) => {
    const cur = Number.isFinite(Number(current)) ? Number(current) : 0;
    const big = e.shiftKey ? 10 : 1;
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - big;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + big;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 100;
    if (next === null) return;
    e.preventDefault();
    onChangePosition(i, Math.max(0, Math.min(100, next)));
  };

  return (
    <div className="space-y-1" data-testid={`${testIdPrefix}-preview`}>
      <div
        ref={barRef}
        className="relative h-8 w-full rounded-md border border-slate-200"
        style={{
          background: `${previewCss}, repeating-conic-gradient(#e2e8f0 0% 25%, #ffffff 0% 50%) 50% / 12px 12px`,
        }}
        data-testid={`${testIdPrefix}-preview-bar`}
      >
        {stops.map((stop, i) => {
          const pos = Number.isFinite(Number(stop.position))
            ? Math.max(0, Math.min(100, Number(stop.position)))
            : 0;
          return (
            <button
              key={i}
              type="button"
              role="slider"
              aria-label={`Stop ${i + 1} position`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pos}
              tabIndex={0}
              onPointerDown={handlePointerDown(i)}
              onPointerMove={handlePointerMove(i)}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={handleKeyDown(i, pos)}
              className="absolute top-1/2 h-5 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border-2 border-white shadow ring-1 ring-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
              style={{
                left: `${pos}%`,
                backgroundColor: stop.color || '#000000',
                touchAction: 'none',
              }}
              data-testid={`${testIdPrefix}-handle-${i}`}
            />
          );
        })}
      </div>
    </div>
  );
}

// Shared, editable, ordered list of gradient colour stops. Each stop carries a
// colour, opacity (0–1), and position (0–100%). Authors can add, remove, and
// reorder stops; a minimum of two stops is always enforced so the gradient
// never degenerates. The parent owns where the resulting array is persisted
// (Section → `gradientStops`, Hero overlay → `overlayStops`) via `onChange`.
// `testIdPrefix` keeps each consumer's data-testids stable and unique.
function GradientStopsEditor({ stops, onChange, testIdPrefix }) {
  const commit = (next) => onChange(next);
  const updateStop = (i, patch) => {
    commit(stops.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };
  const addStop = () => {
    // Insert a mid-point stop: midway in position between the last two stops,
    // reusing the final stop's colour so the new row is visible immediately.
    const last = stops[stops.length - 1];
    const prev = stops[stops.length - 2];
    const midPos = Math.round(((Number(prev?.position) || 0) + (Number(last?.position) || 100)) / 2);
    commit([
      ...stops,
      { color: last?.color || '#1e3a8a', opacity: last?.opacity ?? 1, position: Math.max(0, Math.min(100, midPos)) },
    ]);
  };
  const removeStop = (i) => {
    if (stops.length <= 2) return; // always keep at least two stops
    commit(stops.filter((_, idx) => idx !== i));
  };
  const moveStop = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= stops.length) return;
    const next = stops.slice();
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  };
  const setPosition = (i, pct) => {
    updateStop(i, { position: Math.max(0, Math.min(100, Math.round(Number(pct) || 0))) });
  };
  return (
    <div className="space-y-3" data-testid={`${testIdPrefix}s`}>
      <GradientPreviewBar
        stops={stops}
        onChangePosition={setPosition}
        testIdPrefix={testIdPrefix}
      />
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-slate-600">Colour stops</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addStop}
          data-testid={`button-${testIdPrefix}-add`}
        >
          <Plus className="w-3 h-3" />
          Add stop
        </Button>
      </div>
      {stops.map((stop, i) => (
        <div
          key={i}
          className="space-y-2 rounded-md border border-slate-200 p-2"
          data-testid={`${testIdPrefix}-${i}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">Stop {i + 1}</span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={i === 0}
                onClick={() => moveStop(i, -1)}
                data-testid={`button-${testIdPrefix}-up-${i}`}
              >
                <ArrowUp className="w-3 h-3" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={i === stops.length - 1}
                onClick={() => moveStop(i, 1)}
                data-testid={`button-${testIdPrefix}-down-${i}`}
              >
                <ArrowDown className="w-3 h-3" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={stops.length <= 2}
                onClick={() => removeStop(i)}
                data-testid={`button-${testIdPrefix}-remove-${i}`}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          </div>
          <ColorField
            label="Colour"
            value={stop.color || '#000000'}
            onChange={(v) => updateStop(i, { color: v })}
            testId={`input-${testIdPrefix}-color-${i}`}
          />
          <NumberField
            label="Opacity (0–1)"
            min={0} max={1} step={0.05}
            value={stop.opacity ?? 1}
            onChange={(v) => updateStop(i, { opacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
            testId={`input-${testIdPrefix}-opacity-${i}`}
          />
          <NumberField
            label="Position (0–100%)"
            min={0} max={100} step={1}
            value={Number.isFinite(Number(stop.position)) ? Number(stop.position) : ''}
            onChange={(v) => updateStop(i, { position: Math.max(0, Math.min(100, Number(v) || 0)) })}
            testId={`input-${testIdPrefix}-position-${i}`}
          />
        </div>
      ))}
    </div>
  );
}

// Section gradient stops editor. Persists the edited list to `gradientStops`,
// the source of truth once stops exist (the legacy from/to fields are left
// untouched for back-compat but are no longer consulted).
export function SectionGradientStops({ c, gradientType, set }) {
  const stops = deriveSectionGradientStops(c, gradientType);
  return (
    <GradientStopsEditor
      stops={stops}
      onChange={(next) => set({ gradientStops: next })}
      testIdPrefix="section-gradient-stop"
    />
  );
}

// Derives the Hero overlay stops array the inspector edits. When a usable
// `overlayStops` array is already stored we normalise it; otherwise we seed a
// two-stop list from the legacy overlayFrom*/overlayTo* fields so the very
// first edit picks up exactly what the overlay renders today.
function deriveHeroOverlayStops(c) {
  const stored = getUsableStops(c.overlayStops);
  if (stored) {
    return stored.map((s, i) => ({
      color: typeof s.color === 'string' && s.color ? s.color : '#000000',
      opacity: Math.max(0, Math.min(1, Number(s.opacity ?? 1) || 0)),
      position: Number.isFinite(Number(s.position))
        ? Math.max(0, Math.min(100, Number(s.position)))
        : (i === 0 ? 0 : 100),
    }));
  }
  return [
    { color: c.overlayFromColor || '#000000', opacity: c.overlayFromOpacity ?? 0.6, position: 0 },
    { color: c.overlayToColor || '#000000', opacity: c.overlayToOpacity ?? 0, position: 100 },
  ];
}

// Hero overlay gradient stops editor. Persists the edited list to
// `overlayStops`, the source of truth once stops exist; the legacy
// overlayFrom*/overlayTo* fields are left untouched for back-compat.
function HeroOverlayStops({ c, set }) {
  const stops = deriveHeroOverlayStops(c);
  return (
    <GradientStopsEditor
      stops={stops}
      onChange={(next) => set({ overlayStops: next })}
      testIdPrefix="hero-overlay-stop"
    />
  );
}

export const SECTION_BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light',
  'darken', 'lighten', 'color-dodge', 'color-burn', 'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity',
];

function SectionRender({ block, asEditor, priority }) {
  const c = block.content || {};
  const s = block.style || {};
  // Full-bleed: stretch the section across the full viewport width even
  // when the surrounding canvas has a constrained max-width. We use the
  // classic centered 100vw trick so the section escapes its container in
  // the public renderer; in the editor we just flag it visually because
  // the canvas always renders at its design width.
  const fullBleedStyle = c.fullBleed && !asEditor
    ? {
        width: '100vw',
        position: 'relative',
        left: '50%',
        right: '50%',
        marginLeft: '-50vw',
        marginRight: '-50vw',
      }
    : null;

  // Background image + overlay layers are rendered with negative insets
  // matching the outer Tag's padding so they cover the full section
  // (behind the padding too). `isolation: isolate` on this wrapper keeps
  // the overlay's mix-blend-mode confined to the image+overlay stack so
  // child blocks never compositionally blend with anything outside.
  //
  // All image-mode side effects are gated behind `isImageBg` so legacy
  // colour sections (no bgType, or `bgType === 'color'`) emit exactly
  // the same DOM/style as before this change.
  const isImageBg = c.bgType === 'image' && !!c.bgImageUrl;
  const isGradientBg = c.bgType === 'gradient';
  const gradientBg = isGradientBg ? buildSectionGradientBackground(c) : null;
  const overlayBg = isImageBg ? buildSectionOverlayBackground(c) : null;
  const hasOverlay = isImageBg && overlayBg && (c.overlayType || 'none') !== 'none';
  const pt = s.paddingTop || 0;
  const pr = s.paddingRight || 0;
  const pb = s.paddingBottom || 0;
  const pl = s.paddingLeft || 0;
  const layerInset = isImageBg ? {
    position: 'absolute',
    top: -pt,
    right: -pr,
    bottom: -pb,
    left: -pl,
    pointerEvents: 'none',
  } : null;

  // Inner rail keeps content centered at the configured max-width even
  // when the outer section is full-bleed. In image mode we also lift it
  // above the image/overlay layers via position/z-index; in colour mode
  // the rail style stays exactly as before this change.
  const railStyle = c.maxWidth
    ? { maxWidth: c.maxWidth, marginInline: 'auto', width: '100%', height: '100%' }
    : { width: '100%', height: '100%' };
  if (isImageBg) {
    railStyle.position = 'relative';
    railStyle.zIndex = 2;
  }

  let wrapperStyle = isImageBg
    ? { ...(fullBleedStyle || {}), isolation: 'isolate' }
    : fullBleedStyle;
  if (isGradientBg && gradientBg) {
    wrapperStyle = { ...(wrapperStyle || {}), background: gradientBg };
  }

  return (
    <div
      className="w-full h-full relative"
      style={wrapperStyle || undefined}
      data-section-id={block.id}
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
              objectFit: 'cover',
              objectPosition: 'center',
              zIndex: 0,
            }}
          />
        );
      })()}
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
      <div style={railStyle} />
      {asEditor && (
        <span
          className="absolute top-1 left-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded bg-slate-900/70 text-white pointer-events-none"
          aria-hidden="true"
          style={isImageBg ? { zIndex: 3 } : undefined}
        >
          Section{c.fullBleed ? ' · full-bleed' : ''}{isImageBg ? ' · image' : isGradientBg ? ' · gradient' : ''}
        </span>
      )}
    </div>
  );
}

function SectionInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const bgType = c.bgType || 'color';
  const overlayType = c.overlayType || 'solid';
  const isImageBg = bgType === 'image';
  const isGradientBg = bgType === 'gradient';
  const gradientType = c.gradientType || 'linear';
  return (
    <>
      <NumberField
        label="Max width (px, 0 = none)"
        min={0}
        value={c.maxWidth || 0}
        onChange={(v) => set({ maxWidth: Math.max(0, Number(v) || 0) })}
        testId="input-section-max-width"
      />
      <ToggleField label="Full-bleed" value={!!c.fullBleed} onChange={(v) => set({ fullBleed: v })} testId="toggle-section-full-bleed" />
      <SelectField
        label="Background"
        value={bgType}
        onChange={(v) => set({ bgType: v })}
        options={[
          { value: 'color', label: 'Colour' },
          { value: 'gradient', label: 'Gradient' },
          { value: 'image', label: 'Image' },
        ]}
        testId="select-section-bg-type"
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
            testId="select-section-gradient-type"
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
              testId="input-section-gradient-angle"
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
            testId="input-section-bg-image"
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
            testId="select-section-overlay-type"
          />
          {overlayType === 'solid' && (
            <>
              <ColorField
                label="Overlay colour"
                value={c.overlayColor || '#000000'}
                onChange={(v) => set({ overlayColor: v })}
                testId="input-section-overlay-color"
              />
              <NumberField
                label="Overlay opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.overlayOpacity ?? 0.4}
                onChange={(v) => set({ overlayOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-section-overlay-opacity"
              />
            </>
          )}
          {overlayType === 'linear' && (
            <>
              <ColorField
                label="From colour"
                value={c.overlayFromColor || '#000000'}
                onChange={(v) => set({ overlayFromColor: v })}
                testId="input-section-overlay-from-color"
              />
              <NumberField
                label="From opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.overlayFromOpacity ?? 0.6}
                onChange={(v) => set({ overlayFromOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-section-overlay-from-opacity"
              />
              <ColorField
                label="To colour"
                value={c.overlayToColor || '#000000'}
                onChange={(v) => set({ overlayToColor: v })}
                testId="input-section-overlay-to-color"
              />
              <NumberField
                label="To opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.overlayToOpacity ?? 0}
                onChange={(v) => set({ overlayToOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-section-overlay-to-opacity"
              />
              <NumberField
                label="Angle (0–360°)"
                min={0} max={360} step={1}
                value={Number.isFinite(c.overlayAngle) ? c.overlayAngle : 180}
                onChange={(v) => {
                  const n = Number(v);
                  set({ overlayAngle: Number.isFinite(n) ? Math.max(0, Math.min(360, n)) : 180 });
                }}
                testId="input-section-overlay-angle"
              />
            </>
          )}
          {overlayType === 'radial' && (
            <>
              <ColorField
                label="Centre colour"
                value={c.overlayCenterColor || '#000000'}
                onChange={(v) => set({ overlayCenterColor: v })}
                testId="input-section-overlay-center-color"
              />
              <NumberField
                label="Centre opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.overlayCenterOpacity ?? 0}
                onChange={(v) => set({ overlayCenterOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-section-overlay-center-opacity"
              />
              <ColorField
                label="Edge colour"
                value={c.overlayEdgeColor || '#000000'}
                onChange={(v) => set({ overlayEdgeColor: v })}
                testId="input-section-overlay-edge-color"
              />
              <NumberField
                label="Edge opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.overlayEdgeOpacity ?? 0.6}
                onChange={(v) => set({ overlayEdgeOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-section-overlay-edge-opacity"
              />
            </>
          )}
          {overlayType !== 'none' && (
            <SelectField
              label="Blend mode"
              value={c.overlayBlendMode || 'normal'}
              onChange={(v) => set({ overlayBlendMode: v })}
              options={SECTION_BLEND_MODES.map((m) => ({ value: m, label: m }))}
              testId="select-section-overlay-blend"
            />
          )}
        </>
      )}
      <p className="text-xs text-slate-500">
        Use the Appearance and Spacing panels above for background colour, border and padding.
        {isImageBg ? ' The Appearance colour shows through any transparent areas of the image overlay.' : ''}
        {isGradientBg ? ' The gradient renders behind section content; the Appearance background colour is hidden when a gradient is set.' : ''}
      </p>
    </>
  );
}

// BOX (Phase 2, kept for back-compat) ----------------------------------------
function BoxRender() {
  return null; // Empty container — appearance comes from block.style
}
function BoxInspector() {
  return (
    <p className="text-xs text-slate-500">
      Box is a generic container. Use the Appearance panel above to style it.
    </p>
  );
}

// SYMBOL (Phase 7) -----------------------------------------------------------
// Symbol blocks reference a tenant-scoped canvas_symbol. The editor shows a
// labelled placeholder; the public renderer splices in the resolved symbol
// children before rendering. We deliberately hide symbol from the palette —
// authors insert them from the "Symbols" dialog so they pick which symbol
// up-front.
// Read-only render of a single symbol child inside the editor stage. Mirrors
// the public renderer's per-block wrapper (geometry + box style) so the
// editor preview matches the published output. Geometry uses the symbol's
// OWN local coordinate space (top-left origin) — the host symbol block's
// wrapper already positions the whole instance, so children stay relative to
// it. Non-interactive: the parent symbol content overlay is pointer-events:
// none, so clicks fall through to the symbol instance for selection.
function SymbolChildPreview({ block, breakpoint }) {
  const def = getBlockDefinition(block.type);
  const Renderer = def?.Renderer;
  const style = block.style || {};
  const a11y = block.a11y || {};
  const geom = resolveBlockAtBreakpoint(block, breakpoint || 'desktop');
  if (geom.hidden) return null;
  const isSection = block.type === BLOCK_TYPES.SECTION;
  return (
    <div
      role={a11y.role || undefined}
      aria-label={a11y.ariaLabel || undefined}
      data-block-type={block.type}
      style={{
        position: 'absolute',
        left: geom.x,
        top: geom.y,
        width: geom.w,
        height: geom.h,
        background: style.background,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderRadius: style.borderRadius,
        opacity: style.opacity,
        zIndex: style.zIndex,
        paddingTop: style.paddingTop || 0,
        paddingRight: style.paddingRight || 0,
        paddingBottom: style.paddingBottom || 0,
        paddingLeft: style.paddingLeft || 0,
        boxSizing: 'border-box',
        overflow: (isSection || def?.allowOverflow) ? 'visible' : 'hidden',
      }}
    >
      {Renderer && <Renderer block={block} breakpoint={breakpoint || undefined} />}
    </div>
  );
}

function SymbolRender({ block, breakpoint, asEditor }) {
  const c = block.content || {};
  // Editor publishes the tenant's symbol designs via context; the public
  // renderer never mounts that provider so this is null there (and unused,
  // since the public path returns null below).
  const symbolsCtx = useCanvasSymbols();
  const symbolChildren = block.__symbolChildren;
  if (!asEditor && Array.isArray(symbolChildren) && symbolChildren.length > 0) {
    // In the public renderer, defer to the host page's renderer to draw the
    // spliced-in children. We return null here because CanvasPageRenderer
    // walks __symbolChildren itself; emitting markup again would duplicate.
    return null;
  }

  // Editor: render the symbol's real resolved content read-only inside the
  // instance box so authors can lay out around it, matching the published
  // page. The instance stays a single selectable/movable unit — its inner
  // elements are not individually selectable (the parent overlay is
  // pointer-events: none).
  if (asEditor && c.symbolId) {
    const sym = symbolsCtx?.symbolsById?.get?.(c.symbolId);
    if (sym && sym.design) {
      const symDesign = normalizeCanvasDesign(sym.design);
      const kids = getRootChildren(symDesign);
      return (
        <div
          className="absolute inset-0"
          data-symbol-id={c.symbolId}
          data-symbol-preview="true"
        >
          {kids.map((child) => (
            <SymbolChildPreview key={child.id} block={child} breakpoint={breakpoint} />
          ))}
          {/* Subtle, non-intrusive symbol affordance: a faint dashed outline
              plus a small corner badge so authors can tell a symbol instance
              apart from normal blocks. */}
          <div className="pointer-events-none absolute inset-0 border border-dashed border-indigo-400/40 rounded-[1px]" />
          <div className="pointer-events-none absolute top-0 left-0 flex items-center gap-1 bg-indigo-500/80 text-white text-[10px] font-medium leading-none px-1.5 py-0.5 rounded-br">
            <ComponentIcon className="w-3 h-3" />
            <span className="uppercase tracking-wide">Symbol</span>
          </div>
        </div>
      );
    }
    // Symbol data settled but this id is gone -> deleted / unresolvable.
    if (symbolsCtx?.loaded && !sym) {
      return (
        <div
          className="w-full h-full flex items-center justify-center border border-dashed border-destructive/50 bg-destructive/5 text-destructive"
          data-symbol-id={c.symbolId}
          data-symbol-missing="true"
        >
          <div className="flex flex-col items-center gap-1 px-3 text-center">
            <ComponentIcon className="w-5 h-5" />
            <span className="text-xs font-semibold uppercase tracking-wide">Missing symbol</span>
            <span className="text-sm">{c.symbolName || c.symbolId}</span>
          </div>
        </div>
      );
    }
    // Otherwise still loading symbol designs — fall through to the neutral
    // placeholder below until the fetch settles.
  }

  return (
    <div
      className="w-full h-full flex items-center justify-center border border-dashed border-slate-300 bg-slate-50 text-slate-600"
      data-symbol-id={c.symbolId || ''}
    >
      <div className="flex flex-col items-center gap-1 px-3 text-center">
        <ComponentIcon className="w-5 h-5 text-slate-400" />
        <span className="text-xs font-semibold uppercase tracking-wide">Symbol</span>
        <span className="text-sm">{c.symbolName || c.symbolId || 'Pick a symbol'}</span>
      </div>
    </div>
  );
}
function SymbolInspector({ block, onUnlinkSymbol }) {
  const c = block.content || {};
  return (
    <div className="space-y-2 text-xs text-slate-600">
      <p><strong>Symbol:</strong> {c.symbolName || c.symbolId || '—'}</p>
      <p className="text-slate-500">
        This block reuses a saved symbol. Open the Symbols dialog to manage symbols, or unlink it to convert this instance back into editable blocks on the page.
      </p>
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() => onUnlinkSymbol?.()}
        disabled={!onUnlinkSymbol || !c.symbolId}
        data-testid="button-unlink-symbol"
      >
        <Unlink className="w-4 h-4 mr-2" />
        Unlink symbol
      </Button>
    </div>
  );
}

// CARD FLIP GRID -------------------------------------------------------------
// A static, inline-authored grid of cards. Each card shows a front image with
// a title overlay; clicking/tapping flips it (3D Y-axis flip, identical motion
// to the Wall of Fame cards — perspective on the container, preserve-3d, both
// faces backface-hidden, the back face pre-rotated 180°) to reveal free text.
// Cards are authored in the inspector (like Hero CTAs), laid out in a CSS grid
// of `columns` columns, paginated by `rowsPerPage`. Shape is square (1:1),
// rectangular (configurable height) or circular (1:1 + full rounding).
//
// Shared by both the editor canvas and the public renderer (mirrors HeroRender).
// In the editor the content wrapper is pointer-events-none, so flips/pagination
// are inert there (cards show their front) — exactly like Hero CTAs.
// Card Flip Grid `columns` is either a legacy single number or a
// per-breakpoint object { desktop, tablet, mobile }. Resolve to the column
// count for the active breakpoint, cascading mobile→tablet→desktop and
// falling back to desktop (then 1) so old saved blocks keep working.
// Builds the back-face background for a Card Flip Grid card. Returns a solid
// colour when backBgType is unset/'color' (legacy behaviour) or a CSS gradient
// when 'gradient'. Gradient settings live on dedicated back* keys so they never
// collide with the solid backBgColor.
function buildCardFlipBackBackground(c) {
  const solid = c.backBgColor || 'var(--cb-color-surface, #ffffff)';
  if ((c.backBgType || 'color') !== 'gradient') return solid;
  const from = c.backGradientFromColor || '#3b82f6';
  const to = c.backGradientToColor || '#1e3a8a';
  if ((c.backGradientType || 'linear') === 'radial') {
    return `radial-gradient(ellipse at center, ${from}, ${to})`;
  }
  const angle = Number.isFinite(Number(c.backGradientAngle)) ? Number(c.backGradientAngle) : 180;
  return `linear-gradient(${angle}deg, ${from}, ${to})`;
}

function cardFlipColumnsForBreakpoint(columns, breakpoint) {
  if (columns && typeof columns === 'object') {
    const bp = breakpoint || 'desktop';
    const raw = columns[bp] ?? columns.desktop;
    return Math.max(1, Math.min(6, Number(raw) || 1));
  }
  return Math.max(1, Math.min(6, Number(columns) || 1));
}

function CardFlipGridRender({ block, asEditor, breakpoint }) {
  const c = block.content || {};
  const cards = Array.isArray(c.cards) ? c.cards : [];
  const columns = cardFlipColumnsForBreakpoint(c.columns, breakpoint);
  const rowsPerPage = Math.max(1, Number(c.rowsPerPage) || 1);
  const gap = Number.isFinite(Number(c.gap)) ? Math.max(0, Number(c.gap)) : 16;
  const shape = c.shape || 'square';
  const isRect = shape === 'rectangular';
  const isCircular = shape === 'circular';
  const cardHeight = Math.max(40, Number(c.cardHeight) || 320);
  const cornerRadius = Number.isFinite(Number(c.cornerRadius)) ? Math.max(0, Number(c.cornerRadius)) : 8;
  const radius = isCircular ? '9999px' : `${cornerRadius}px`;
  const flipDuration = Number.isFinite(Number(c.flipDuration)) ? Math.max(0, Number(c.flipDuration)) : 0.7;
  const titleColor = c.titleColor || '#ffffff';
  const titleSize = Number.isFinite(Number(c.titleSize)) ? Math.max(8, Number(c.titleSize)) : 16;
  const showTitleOverlay = c.showTitleOverlay !== false;
  const overlayStrength = Number.isFinite(Number(c.overlayStrength))
    ? Math.min(1, Math.max(0, Number(c.overlayStrength)))
    : 0.72;
  const overlayColor = c.overlayColor || '#000000';
  const overlayFrom = hexToRgba(overlayColor, overlayStrength);
  const overlayTo = hexToRgba(overlayColor, 0);
  // 'solid' fills the whole card with a uniform wash; 'fade' (default) keeps the
  // legacy radial/linear gradient that fades to transparent.
  const overlaySolid = c.overlayStyle === 'solid';
  const circularOverlayBg = overlaySolid
    ? overlayFrom
    : `radial-gradient(ellipse at center, ${overlayFrom}, ${overlayTo} 72%)`;
  const linearOverlayBg = overlaySolid
    ? overlayFrom
    : `linear-gradient(to top, ${overlayFrom}, ${overlayTo})`;
  const backBackground = buildCardFlipBackBackground(c);
  const backTextColor = c.backTextColor || 'var(--cb-color-on-surface, #0f172a)';

  // Optional tenant typography style for the front title font. Falls back to
  // the explicit titleColor / titleSize controls, which always win so existing
  // blocks render unchanged.
  const { styles: tenantStyles, resolved: stylesResolved } = useTenantTypographyStylesState();
  const titleStyleObj = resolveTenantStyle(c.titleTypographyStyleId, tenantStyles);
  const awaitingTitleStyle = isAwaitingTypographyStyle(c.titleTypographyStyleId, titleStyleObj, stylesResolved);
  const titleTypoInline = titleStyleObj ? buildTypographyInlineStyle(titleStyleObj, { breakpoint }) : null;

  // Per-card "View more" modal showing the full rich-text content. A single
  // dialog is rendered at the block level (outside the 3D-transformed cards)
  // and the open card is tracked here. DialogContent portals to <body> so it
  // escapes the cards' preserve-3d transform context.
  const [modalCard, setModalCard] = useState(null);

  const perPage = columns * rowsPerPage;
  const pageCount = Math.max(1, Math.ceil(cards.length / perPage));
  const [page, setPage] = useState(0);
  const safePage = Math.min(page, pageCount - 1);
  const [flipped, setFlipped] = useState({});
  // Keep the page index valid if the card count shrinks, and reset any flips
  // when the visible page changes so a new page always starts front-facing.
  useEffect(() => { if (page > pageCount - 1) setPage(pageCount - 1); }, [pageCount, page]);
  useEffect(() => { setFlipped({}); }, [safePage]);

  const start = safePage * perPage;
  const pageCards = cards.slice(start, start + perPage);
  const toggle = (idx) => setFlipped((f) => ({ ...f, [idx]: !f[idx] }));

  const cellShapeStyle = isRect ? { height: `${cardHeight}px` } : { aspectRatio: '1 / 1' };

  return (
    <div className="absolute inset-0 flex flex-col" data-testid={`card-flip-grid-${block.id}`}>
      <div className="flex-1 min-h-0">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: `${gap}px`,
          }}
        >
          {pageCards.map((card, i) => {
            const flipKey = start + i;
            const isFlipped = !!flipped[flipKey];
            const img = card?.image ? buildResponsiveImage(card.image, { sizes: `${Math.round(100 / columns)}vw` }) : null;
            return (
              <div key={flipKey} style={{ perspective: '1000px', ...cellShapeStyle }}>
                <div
                  className="relative w-full h-full cursor-pointer"
                  style={{
                    transition: `transform ${flipDuration}s`,
                    transformStyle: 'preserve-3d',
                    transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
                  }}
                  role="button"
                  tabIndex={asEditor ? -1 : 0}
                  aria-pressed={isFlipped}
                  aria-label={card?.title || 'Flip card'}
                  onClick={() => { if (!asEditor) toggle(flipKey); }}
                  onKeyDown={(e) => {
                    if (asEditor) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(flipKey); }
                  }}
                  data-testid={`card-flip-${block.id}-${flipKey}`}
                >
                  {/* Front face: image + title overlay */}
                  <div
                    className="absolute inset-0"
                    style={{
                      backfaceVisibility: 'hidden',
                      WebkitBackfaceVisibility: 'hidden',
                      borderRadius: radius,
                      overflow: 'hidden',
                      background: 'var(--cb-color-muted, #e2e8f0)',
                    }}
                  >
                    {img ? (
                      <img
                        src={img.src}
                        srcSet={img.srcSet}
                        sizes={img.sizes}
                        alt={card?.imageAlt || ''}
                        aria-hidden={card?.imageAlt ? undefined : 'true'}
                        loading="lazy"
                        decoding="async"
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-slate-400">
                        <ImageIcon className="w-8 h-8" />
                      </div>
                    )}
                    {isCircular ? (
                      <div
                        className="absolute inset-0 flex items-center justify-center px-4"
                        style={{ background: showTitleOverlay ? circularOverlayBg : 'none' }}
                      >
                        <span
                          className="block font-semibold leading-tight text-center"
                          style={{ whiteSpace: 'pre-line', ...(titleTypoInline || {}), color: titleColor, fontSize: titleSize, ...(awaitingTitleStyle ? { visibility: 'hidden' } : null) }}
                        >
                          {card?.title || ''}
                        </span>
                      </div>
                    ) : (
                      <div
                        className="absolute inset-x-0 bottom-0 px-3 py-2"
                        style={{ background: showTitleOverlay ? linearOverlayBg : 'none' }}
                      >
                        <span
                          className="block font-semibold leading-tight"
                          style={{ whiteSpace: 'pre-line', ...(titleTypoInline || {}), color: titleColor, fontSize: titleSize, textAlign: 'left', ...(awaitingTitleStyle ? { visibility: 'hidden' } : null) }}
                        >
                          {card?.title || ''}
                        </span>
                      </div>
                    )}
                  </div>
                  {/* Back face: free text (pre-rotated 180°) */}
                  <div
                    className="absolute inset-0 flex items-center justify-center p-4 text-center"
                    style={{
                      backfaceVisibility: 'hidden',
                      WebkitBackfaceVisibility: 'hidden',
                      transform: 'rotateY(180deg)',
                      borderRadius: radius,
                      overflow: 'auto',
                      background: backBackground,
                      color: backTextColor,
                    }}
                  >
                    <div className="flex flex-col items-center gap-2">
                      <div className="text-sm leading-relaxed" style={{ whiteSpace: 'pre-wrap' }}>
                        {card?.summary || card?.backText || ''}
                      </div>
                      {card?.content && String(card.content).trim() && (
                        <button
                          type="button"
                          className="text-sm font-medium underline underline-offset-2 hover-elevate rounded-md px-1"
                          style={{ color: 'inherit' }}
                          onClick={(e) => { e.stopPropagation(); setModalCard(card); }}
                          onKeyDown={(e) => { e.stopPropagation(); }}
                          data-testid={`card-flip-${block.id}-${flipKey}-view-more`}
                        >
                          View more
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Dialog open={!!modalCard} onOpenChange={(open) => { if (!open) setModalCard(null); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid={`card-flip-grid-${block.id}-modal`}>
          <DialogHeader>
            <DialogTitle>{modalCard?.title || ''}</DialogTitle>
          </DialogHeader>
          <div
            className="prose prose-sm max-w-none [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:text-xl [&_h3]:font-semibold [&_h4]:text-lg [&_h4]:font-semibold [&_h5]:text-base [&_h5]:font-semibold [&_h6]:text-sm [&_h6]:font-semibold [&_h6]:uppercase [&_p]:mb-2 [&_p:last-child]:mb-0 [&_a]:text-blue-600 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1"
            dangerouslySetInnerHTML={{ __html: sanitizeRichText(stripTrailingEmptyParagraphs(modalCard?.content || '')) }}
          />
        </DialogContent>
      </Dialog>
      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3 shrink-0">
          <Button
            size="icon"
            variant="outline"
            type="button"
            disabled={safePage <= 0}
            onClick={() => { if (!asEditor) setPage((p) => Math.max(0, p - 1)); }}
            aria-label="Previous page"
            data-testid={`card-flip-grid-${block.id}-prev`}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-xs text-slate-600 tabular-nums" data-testid={`card-flip-grid-${block.id}-page`}>
            {safePage + 1} / {pageCount}
          </span>
          <Button
            size="icon"
            variant="outline"
            type="button"
            disabled={safePage >= pageCount - 1}
            onClick={() => { if (!asEditor) setPage((p) => Math.min(pageCount - 1, p + 1)); }}
            aria-label="Next page"
            data-testid={`card-flip-grid-${block.id}-next`}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

function CardFlipGridInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const clampInt = (v, min) => Math.max(min, Math.round(Number(v) || min));
  // Normalize legacy single-number `columns` into the per-breakpoint object
  // so the three inputs always have a value to show / edit.
  const colsObj = (c.columns && typeof c.columns === 'object')
    ? { desktop: 3, tablet: 2, mobile: 1, ...c.columns }
    : { desktop: clampInt(c.columns ?? 3, 1), tablet: clampInt(c.columns ?? 2, 1), mobile: 1 };
  const setCols = (bp, n) =>
    set({ columns: { ...colsObj, [bp]: Math.max(1, Math.min(6, Number(n) || 1)) } });
  return (
    <>
      <Field label="Columns per breakpoint">
        <div className="grid grid-cols-3 gap-2">
          {['desktop', 'tablet', 'mobile'].map((bp) => (
            <div key={bp} className="space-y-1">
              <Label className="text-[10px] uppercase text-slate-500">{bp}</Label>
              <Input
                type="number"
                min={1}
                max={6}
                value={colsObj[bp]}
                onChange={(e) => setCols(bp, e.target.value)}
                className="h-8"
                data-testid={`input-card-flip-columns-${bp}`}
              />
            </div>
          ))}
        </div>
      </Field>
      <NumberField
        label="Rows per page"
        min={1}
        value={c.rowsPerPage ?? 2}
        onChange={(v) => set({ rowsPerPage: clampInt(v, 1) })}
        testId="input-card-flip-rows"
      />
      <NumberField
        label="Gap between cards (px)"
        min={0}
        value={c.gap ?? 16}
        onChange={(v) => set({ gap: Math.max(0, Number(v) || 0) })}
        testId="input-card-flip-gap"
      />
      <SelectField
        label="Card shape"
        value={c.shape || 'square'}
        onChange={(v) => set({ shape: v })}
        options={[
          { value: 'square', label: 'Square' },
          { value: 'rectangular', label: 'Rectangular' },
          { value: 'circular', label: 'Circular' },
        ]}
        testId="select-card-flip-shape"
      />
      {c.shape === 'rectangular' && (
        <NumberField
          label="Card height (px)"
          min={40}
          value={c.cardHeight ?? 320}
          onChange={(v) => set({ cardHeight: Math.max(40, Number(v) || 40) })}
          testId="input-card-flip-height"
        />
      )}
      {c.shape !== 'circular' && (
        <NumberField
          label="Corner radius (px)"
          min={0}
          value={c.cornerRadius ?? 8}
          onChange={(v) => set({ cornerRadius: Math.max(0, Number(v) || 0) })}
          testId="input-card-flip-radius"
        />
      )}
      <NumberField
        label="Flip duration (s)"
        min={0}
        step={0.1}
        value={c.flipDuration ?? 0.7}
        onChange={(v) => set({ flipDuration: Math.max(0, Number(v) || 0) })}
        testId="input-card-flip-duration"
      />
      <ColorField label="Title colour" value={c.titleColor} onChange={(v) => set({ titleColor: v })} testId="input-card-flip-title-color" />
      <NumberField
        label="Title size (px)"
        min={8}
        value={c.titleSize ?? 16}
        onChange={(v) => set({ titleSize: Math.max(8, Number(v) || 8) })}
        testId="input-card-flip-title-size"
      />
      <TypographyStyleField
        label="Title font style"
        value={c.titleTypographyStyleId}
        onChange={(id) => set({ titleTypographyStyleId: id })}
        testId="select-card-flip-title-typography"
      />
      <ToggleField
        label="Show title overlay"
        value={c.showTitleOverlay !== false}
        onChange={(v) => set({ showTitleOverlay: v })}
        testId="toggle-card-flip-overlay"
      />
      {c.showTitleOverlay !== false && (
        <>
          <SelectField
            label="Overlay style"
            value={c.overlayStyle || 'fade'}
            onChange={(v) => set({ overlayStyle: v })}
            options={[
              { value: 'fade', label: 'Fade to transparent' },
              { value: 'solid', label: 'Full coverage' },
            ]}
            testId="select-card-flip-overlay-style"
          />
          <ColorField
            label="Overlay colour"
            value={c.overlayColor || '#000000'}
            onChange={(v) => set({ overlayColor: v })}
            testId="input-card-flip-overlay-color"
          />
          <NumberField
            label="Overlay opacity (0-1)"
            min={0}
            max={1}
            step={0.01}
            value={c.overlayStrength ?? 0.72}
            onChange={(v) => set({ overlayStrength: Math.min(1, Math.max(0, Number(v) || 0)) })}
            testId="input-card-flip-overlay-strength"
          />
        </>
      )}
      <SelectField
        label="Back background type"
        value={c.backBgType || 'color'}
        onChange={(v) => set({ backBgType: v })}
        options={[
          { value: 'color', label: 'Solid colour' },
          { value: 'gradient', label: 'Gradient' },
        ]}
        testId="select-card-flip-back-bg-type"
      />
      {(c.backBgType || 'color') === 'color' && (
        <ColorField label="Back background" value={c.backBgColor} onChange={(v) => set({ backBgColor: v })} testId="input-card-flip-back-bg" />
      )}
      {c.backBgType === 'gradient' && (
        <>
          <SelectField
            label="Gradient style"
            value={c.backGradientType || 'linear'}
            onChange={(v) => set({ backGradientType: v })}
            options={[
              { value: 'linear', label: 'Linear' },
              { value: 'radial', label: 'Radial' },
            ]}
            testId="select-card-flip-back-gradient-type"
          />
          <ColorField label="Gradient from" value={c.backGradientFromColor || '#3b82f6'} onChange={(v) => set({ backGradientFromColor: v })} testId="input-card-flip-back-gradient-from" />
          <ColorField label="Gradient to" value={c.backGradientToColor || '#1e3a8a'} onChange={(v) => set({ backGradientToColor: v })} testId="input-card-flip-back-gradient-to" />
          {(c.backGradientType || 'linear') === 'linear' && (
            <NumberField
              label="Gradient angle (deg)"
              min={0}
              max={360}
              value={c.backGradientAngle ?? 180}
              onChange={(v) => set({ backGradientAngle: Math.max(0, Math.min(360, Number(v) || 0)) })}
              testId="input-card-flip-back-gradient-angle"
            />
          )}
        </>
      )}
      <ColorField label="Back text colour" value={c.backTextColor} onChange={(v) => set({ backTextColor: v })} testId="input-card-flip-back-text-color" />
      <Field label="Cards">
        <ArrayList
          items={c.cards || []}
          onChange={(next) => set({ cards: next })}
          makeNew={() => ({ image: '', imageAlt: '', title: 'New card', summary: '', content: '', backText: '' })}
          addLabel="Add card"
          testIdPrefix="card-flip-card"
          renderItem={(item, idx, patch) => (
            <>
              <ImageField
                label="Front image"
                value={item.image}
                alt={item.imageAlt}
                onChangeSrc={(v) => patch({ image: v })}
                onChangeAlt={(v) => patch({ imageAlt: v })}
                testId={`card-flip-card-${idx}-image`}
              />
              <TextField label="Front title" multiline value={item.title} onChange={(v) => patch({ title: v })} testId={`card-flip-card-${idx}-title`} />
              <TextField label="Back summary" multiline value={item.summary} onChange={(v) => patch({ summary: v })} testId={`card-flip-card-${idx}-summary`} />
              <RichTextField label="Full content (View more)" value={item.content} onChange={(v) => patch({ content: v })} testId={`card-flip-card-${idx}-content`} />
              {item.backText ? (
                <TextField label="Back text (legacy)" multiline value={item.backText} onChange={(v) => patch({ backText: v })} testId={`card-flip-card-${idx}-back`} />
              ) : null}
            </>
          )}
        />
      </Field>
    </>
  );
}

// HERO CAROUSEL ---------------------------------------------------------------

const HERO_CAROUSEL_FONT_FAMILIES = [
  'Poppins', 'Inter', 'Arial', 'Georgia', 'Times New Roman',
  'Degular Medium', 'Degular Bold', 'Degular Semibold',
];
const HERO_CAROUSEL_FONT_WEIGHTS = [
  { value: '300', label: 'Light' },
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' },
  { value: '800', label: 'Extra Bold' },
];

function HeroCarouselRender({ block, asEditor, breakpoint }) {
  const c = block.content || {};
  const slides = c.slides || [];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [previousIndex, setPreviousIndex] = useState(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const timerRef = useRef(null);

  // Resolve tenant typography styles at render time — same pattern as Hero/Text
  // blocks. When a style ID is set and resolvable, its properties override the
  // manual content fields so future edits to the style propagate automatically.
  const { styles: tenantStyles, resolved: tenantStylesResolved } = useTenantTypographyStylesState();
  const headerStyleObj = resolveTenantStyle(c.header_typography_style_id, tenantStyles);
  const subheadingStyleObj = resolveTenantStyle(c.subheading_typography_style_id, tenantStyles);
  const contentStyleObj = resolveTenantStyle(c.content_typography_style_id, tenantStyles);
  const bpForInline = breakpoint || 'desktop';

  const isMobile = breakpoint === 'mobile';
  const autoplayInterval = c.autoplayInterval ?? 5;
  const transitionEffect = c.transitionEffect || 'fade';
  const transitionDuration = Number(c.transitionDuration) || 700;
  const pauseOnHover = c.pauseOnHover !== false;
  const showArrows = c.showArrows !== false;
  const showDots = c.showDots !== false;

  // Manual fallback typography values (used when no tenant style is resolved)
  const headerFontFamily = c.header_font_family || 'Poppins';
  const headerFontSize = Number(c.header_font_size) || 48;
  const headerColor = c.header_color || '#ffffff';
  const headerFontWeight = Number(c.header_font_weight) || 700;
  const headerLetterSpacing = c.header_letter_spacing ?? 0;
  const headerLineHeight = c.header_line_height || 1.2;

  const subheadingFontFamily = c.subheading_font_family || 'Poppins';
  const subheadingFontSize = Number(c.subheading_font_size) || 24;
  const subheadingColor = c.subheading_color || '#ffffff';
  const subheadingFontWeight = Number(c.subheading_font_weight) || 400;
  const subheadingLetterSpacing = c.subheading_letter_spacing ?? 0;
  const subheadingLineHeight = c.subheading_line_height || 1.5;

  const contentFontFamily = c.content_font_family || 'Poppins';
  const contentFontSize = Number(c.content_font_size) || 16;
  const contentColor = c.content_color || '#ffffff';
  const contentFontWeight = Number(c.content_font_weight) || 400;
  const contentLetterSpacing = c.content_letter_spacing ?? 0;
  const contentLineHeight = c.content_line_height || 1.6;

  const textAlignment = c.text_alignment || 'center';
  const heightType = c.height_type || 'custom';
  const customHeight = Number(c.custom_height) || 500;
  const autoMinHeight = Number(c.auto_min_height) || 400;
  const paddingVertical = Number(c.padding_vertical) ?? 60;
  const paddingHorizontal = Number(c.padding_horizontal) ?? 16;
  const textOffsetX = Number(c.text_offset_x) || 0;
  const textOffsetY = Number(c.text_offset_y) || 0;

  const mobileHeaderFS = Number(c.mobile_header_font_size) || Math.max(24, Math.round(headerFontSize * 0.6));
  const mobileSubheadingFS = Number(c.mobile_subheading_font_size) || Math.max(16, Math.round(subheadingFontSize * 0.75));
  const mobileContentFS = Number(c.mobile_content_font_size) || Math.max(14, Math.round(contentFontSize * 0.9));
  const mobilePaddingV = Math.max(32, Math.round(paddingVertical * 0.5));
  const mobilePaddingH = Math.max(16, paddingHorizontal);
  const parsedMobileOffsetX = Number(c.mobile_text_offset_x) || 0;
  const parsedMobileOffsetY = Number(c.mobile_text_offset_y) || 0;
  const mobileOffsetX = parsedMobileOffsetX !== 0 ? parsedMobileOffsetX : Math.round(textOffsetX * 0.5);
  const mobileOffsetY = parsedMobileOffsetY !== 0 ? parsedMobileOffsetY : Math.round(textOffsetY * 0.5);

  const displayHeaderFS = isMobile ? mobileHeaderFS : headerFontSize;
  const displaySubheadingFS = isMobile ? mobileSubheadingFS : subheadingFontSize;
  const displayContentFS = isMobile ? mobileContentFS : contentFontSize;
  const displayPaddingV = isMobile ? mobilePaddingV : paddingVertical;
  const displayPaddingH = isMobile ? mobilePaddingH : paddingHorizontal;
  const effOffsetX = isMobile ? mobileOffsetX : textOffsetX;
  const effOffsetY = isMobile ? mobileOffsetY : textOffsetY;

  // Build resolved inline styles; fall back to manual fields when no tenant
  // style is set or has not yet loaded (consistent with HeroRender pattern).
  const headerInlineStyle = headerStyleObj
    ? { overflowWrap: 'break-word', color: headerColor, ...buildTypographyInlineStyle(headerStyleObj, { breakpoint: bpForInline }) }
    : { fontFamily: headerFontFamily, fontSize: `${displayHeaderFS}px`, color: headerColor, fontWeight: headerFontWeight, letterSpacing: `${headerLetterSpacing}px`, lineHeight: headerLineHeight, overflowWrap: 'break-word' };
  const subheadingInlineStyle = subheadingStyleObj
    ? { overflowWrap: 'break-word', color: subheadingColor, marginTop: '16px', ...buildTypographyInlineStyle(subheadingStyleObj, { breakpoint: bpForInline }) }
    : { fontFamily: subheadingFontFamily, fontSize: `${displaySubheadingFS}px`, color: subheadingColor, fontWeight: subheadingFontWeight, letterSpacing: `${subheadingLetterSpacing}px`, lineHeight: subheadingLineHeight, overflowWrap: 'break-word', marginTop: '16px' };
  const contentInlineStyle = contentStyleObj
    ? { overflowWrap: 'break-word', color: contentColor, marginTop: '16px', ...buildTypographyInlineStyle(contentStyleObj, { breakpoint: bpForInline }) }
    : { fontFamily: contentFontFamily, fontSize: `${displayContentFS}px`, color: contentColor, fontWeight: contentFontWeight, letterSpacing: `${contentLetterSpacing}px`, lineHeight: contentLineHeight, overflowWrap: 'break-word', marginTop: '16px' };

  const safeBlockId = `hcc-${String(block.id || '').replace(/[^a-zA-Z0-9]/g, '')}`;
  const isPreview = !!breakpoint;

  const getSlideTransitionStyle = (slideIndex) => {
    const isActive = slideIndex === currentIndex;
    const isPrev = slideIndex === previousIndex;
    const dur = `${transitionDuration}ms`;
    const base = { position: 'absolute', inset: 0 };

    if (transitionEffect === 'fade') {
      return {
        ...base,
        opacity: isActive ? 1 : 0,
        transition: `opacity ${dur} ease-in-out`,
        zIndex: isActive ? 2 : (isPrev ? 1 : 0),
      };
    }

    const movingForward = previousIndex !== null && (
      currentIndex > previousIndex ||
      (currentIndex === 0 && previousIndex === slides.length - 1)
    );

    const exitMap = {
      'slide-left': movingForward ? 'translateX(-100%)' : 'translateX(100%)',
      'slide-right': movingForward ? 'translateX(100%)' : 'translateX(-100%)',
      'slide-up': 'translateY(-100%)',
    };
    const enterMap = {
      'slide-left': movingForward ? 'translateX(100%)' : 'translateX(-100%)',
      'slide-right': movingForward ? 'translateX(-100%)' : 'translateX(100%)',
      'slide-up': 'translateY(100%)',
    };
    const eff = exitMap[transitionEffect] ? transitionEffect : 'slide-left';

    if (isActive) return { ...base, transform: 'translateX(0) translateY(0)', opacity: 1, transition: `transform ${dur} ease-in-out, opacity ${dur} ease-in-out`, zIndex: 2 };
    if (isPrev) return { ...base, transform: exitMap[eff], opacity: 0, transition: `transform ${dur} ease-in-out, opacity ${dur} ease-in-out`, zIndex: 1 };
    return { ...base, transform: enterMap[eff], opacity: 0, transition: 'none', zIndex: 0 };
  };

  const goToSlide = (newIndex) => {
    if (isTransitioning || slides.length <= 1) return;
    setIsTransitioning(true);
    setPreviousIndex(currentIndex);
    setCurrentIndex(newIndex);
    setTimeout(() => { setIsTransitioning(false); setPreviousIndex(null); }, transitionDuration);
  };

  const goToNext = () => goToSlide((currentIndex + 1) % slides.length);
  const goToPrevious = () => goToSlide((currentIndex - 1 + slides.length) % slides.length);

  useEffect(() => {
    if (slides.length <= 1 || !autoplayInterval || isPaused || asEditor) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      setIsTransitioning(true);
      setCurrentIndex((prev) => {
        setPreviousIndex(prev);
        return (prev + 1) % slides.length;
      });
      setTimeout(() => { setIsTransitioning(false); setPreviousIndex(null); }, transitionDuration);
    }, autoplayInterval * 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [slides.length, autoplayInterval, isPaused, transitionDuration, asEditor]);

  useEffect(() => {
    if (slides.length > 0 && currentIndex >= slides.length) {
      setCurrentIndex(slides.length - 1);
    }
  }, [slides.length, currentIndex]);

  if (!slides.length) {
    return (
      <div className="absolute inset-0 bg-slate-800 flex items-center justify-center">
        <p className="text-slate-300 text-sm text-center px-4">No slides configured — add slides in the inspector.</p>
      </div>
    );
  }

  const textBoxStyle = {};
  if (effOffsetX !== 0 || effOffsetY !== 0) {
    textBoxStyle.transform = `translate(${effOffsetX}px, ${effOffsetY}px)`;
  }

  // When full-bleed, the background spans 100vw but the text content should
  // re-align to the page's centered content column. `--cb-content-width` is
  // published by the stage stylesheet per breakpoint (1200/768/375); falls
  // back to 1200. No-op when full-bleed is off (preserves today's appearance).
  const railStyle = c.fullBleed
    ? { maxWidth: 'var(--cb-content-width, 1200px)', marginInline: 'auto' }
    : undefined;

  // Always compute container height so the block renders at the configured
  // height both in CanvasBuilder preview/editor and on published pages.
  // For 'full' or 'custom' the block geometry will usually already match;
  // for 'auto' the min-height prevents the carousel from collapsing when
  // content is short.
  const containerStyle =
    heightType === 'full'
      ? { height: '100vh' }
      : heightType === 'custom'
        ? { height: `${customHeight}px` }
        : { minHeight: `${autoMinHeight}px` };

  return (
    <div
      data-hcc={safeBlockId}
      className="absolute inset-0 overflow-hidden"
      style={containerStyle}
      onMouseEnter={pauseOnHover ? () => setIsPaused(true) : undefined}
      onMouseLeave={pauseOnHover ? () => setIsPaused(false) : undefined}
    >
      {!isPreview && (
        <style dangerouslySetInnerHTML={{ __html: [
          `@media(max-width:767px){`,
          `[data-hcc="${safeBlockId}"]{`,
          heightType === 'custom'
            ? `height:${Math.round(customHeight * 0.6)}px;`
            : heightType === 'full'
              ? `height:100vh;`
              : `min-height:${Math.round(autoMinHeight * 0.6)}px;`,
          `}`,
          !headerStyleObj ? `[data-hcc="${safeBlockId}"] .hcc-title{font-size:${mobileHeaderFS}px!important;}` : '',
          !subheadingStyleObj ? `[data-hcc="${safeBlockId}"] .hcc-subheading{font-size:${mobileSubheadingFS}px!important;}` : '',
          !contentStyleObj ? `[data-hcc="${safeBlockId}"] .hcc-body{font-size:${mobileContentFS}px!important;}` : '',
          headerStyleObj && hasResponsiveTypographyOverride(headerStyleObj) ? buildTenantTypographyResponsiveCss(`[data-hcc="${safeBlockId}"] .hcc-title`, headerStyleObj) : '',
          subheadingStyleObj && hasResponsiveTypographyOverride(subheadingStyleObj) ? buildTenantTypographyResponsiveCss(`[data-hcc="${safeBlockId}"] .hcc-subheading`, subheadingStyleObj) : '',
          contentStyleObj && hasResponsiveTypographyOverride(contentStyleObj) ? buildTenantTypographyResponsiveCss(`[data-hcc="${safeBlockId}"] .hcc-body`, contentStyleObj) : '',
          `[data-hcc="${safeBlockId}"] .hcc-content-wrap{padding:${mobilePaddingV}px ${mobilePaddingH}px!important;}`,
          `[data-hcc="${safeBlockId}"] .hcc-text-box{transform:translate(${mobileOffsetX}px,${mobileOffsetY}px)!important;}`,
          `}`,
        ].join('') }} />
      )}

      {slides.map((slide, index) => (
        <div key={slide.id || index} style={getSlideTransitionStyle(index)}>
          <div className="absolute inset-0">
            {slide.backgroundImage ? (
              <img
                src={slide.backgroundImage}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className="absolute inset-0 w-full h-full"
                style={{ objectFit: slide.imageFit === 'original' ? 'none' : (slide.imageFit || 'cover'), objectPosition: 'center' }}
              />
            ) : (
              <div
                className="absolute inset-0"
                style={{ background: 'linear-gradient(135deg,#1e3a5f 0%,#3b82f6 100%)' }}
              />
            )}
            <div
              className="absolute inset-0"
              aria-hidden="true"
              style={{
                backgroundColor: slide.overlayColor || '#000000',
                opacity: (slide.overlayOpacity ?? 40) / 100,
              }}
            />
          </div>

          <div
            className={`hcc-content-wrap relative h-full flex items-center z-10${c.fullBleed ? '' : ' max-w-7xl mx-auto'}`}
            style={{
              textAlign: textAlignment,
              paddingLeft: `${displayPaddingH}px`,
              paddingRight: `${displayPaddingH}px`,
              paddingTop: `${displayPaddingV}px`,
              paddingBottom: `${displayPaddingV}px`,
              ...(railStyle || {}),
            }}
          >
            <div className="hcc-text-box max-w-2xl mx-auto" style={textBoxStyle}>
              {slide.headerText && (
                <div
                  className="hcc-title"
                  style={headerInlineStyle}
                  dangerouslySetInnerHTML={{ __html: sanitizeRichText(slide.headerText) }}
                />
              )}
              {slide.subheadingText && (
                <div
                  className="hcc-subheading"
                  style={subheadingInlineStyle}
                  dangerouslySetInnerHTML={{ __html: sanitizeRichText(slide.subheadingText) }}
                />
              )}
              {slide.contentText && (
                <div
                  className="hcc-body"
                  style={contentInlineStyle}
                  dangerouslySetInnerHTML={{ __html: sanitizeRichText(slide.contentText) }}
                />
              )}
              {slide.ctaText && slide.ctaLink && (
                <div style={{ marginTop: '24px' }}>
                  <a
                    href={asEditor ? undefined : slide.ctaLink}
                    onClick={asEditor ? (e) => e.preventDefault() : undefined}
                    className="inline-block bg-white text-slate-900 font-semibold rounded-lg hover:bg-slate-100 transition-colors shadow-lg"
                    style={{ padding: '14px 28px' }}
                  >
                    {slide.ctaText}
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}

      {showArrows && slides.length > 1 && (
        <>
          <button
            type="button"
            onClick={asEditor ? undefined : goToPrevious}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center transition-colors"
            style={{ width: 48, height: 48, zIndex: 10 }}
            aria-label="Previous slide"
            data-testid="button-herocarousel-prev"
          >
            <ChevronLeft className="w-6 h-6 text-white" />
          </button>
          <button
            type="button"
            onClick={asEditor ? undefined : goToNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center transition-colors"
            style={{ width: 48, height: 48, zIndex: 10 }}
            aria-label="Next slide"
            data-testid="button-herocarousel-next"
          >
            <ChevronRight className="w-6 h-6 text-white" />
          </button>
        </>
      )}

      {showDots && slides.length > 1 && (
        <div
          className="absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-2"
          style={{ zIndex: 10 }}
        >
          {slides.map((_, index) => (
            <button
              key={index}
              type="button"
              onClick={asEditor ? undefined : () => goToSlide(index)}
              className={`h-3 rounded-full transition-all ${
                index === currentIndex ? 'bg-white w-8' : 'bg-white/50 hover:bg-white/70 w-3'
              }`}
              aria-label={`Go to slide ${index + 1}`}
              data-testid={`button-herocarousel-dot-${index}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Sortable slide item for the Hero Carousel inspector drag-reorder list.
function SortableSlideItem({ id, title, isExpanded, onToggle, onRemove, onDuplicate, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: DndCSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="border border-slate-200 rounded-md mb-2 bg-white">
      <div className="flex items-center gap-1 px-2 py-1.5 bg-slate-50 rounded-t-md select-none">
        <button
          {...attributes}
          {...listeners}
          type="button"
          className="cursor-grab text-slate-400 hover:text-slate-600 flex-shrink-0"
          title="Drag to reorder"
          aria-label="Drag handle"
        >
          <GripVertical size={14} />
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 text-left text-xs font-medium text-slate-700 truncate py-0.5 min-w-0"
        >
          {title}
        </button>
        <button
          type="button"
          onClick={onDuplicate}
          className="flex-shrink-0 text-slate-400 hover:text-slate-600 px-1"
          title="Duplicate slide"
          aria-label="Duplicate slide"
        >
          <Copy size={12} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="flex-shrink-0 text-slate-400 hover:text-red-500 text-xs px-1"
          title="Remove slide"
        >
          ×
        </button>
      </div>
      {isExpanded && (
        <div className="p-2 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}

// DnD-sortable slide list used in HeroCarouselInspector.
function SlideDndList({ slides, onChange, breakpoint }) {
  const [expanded, setExpanded] = useState(() => slides.map((_, i) => i === 0));

  useEffect(() => {
    setExpanded((prev) => {
      if (prev.length === slides.length) return prev;
      return slides.map((_, i) => (i < prev.length ? prev[i] : true));
    });
  }, [slides.length]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = slides.findIndex((s) => s.id === active.id);
    const newIndex = slides.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onChange(arrayMove(slides, oldIndex, newIndex));
    setExpanded((prev) => arrayMove(prev, oldIndex, newIndex));
  };

  const patchSlide = (idx, patch) => {
    const next = [...slides];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };

  const removeSlide = (idx) => {
    setExpanded((prev) => prev.filter((_, i) => i !== idx));
    onChange(slides.filter((_, i) => i !== idx));
  };

  const duplicateSlide = (idx) => {
    const dupe = { ...slides[idx], id: `slide-${Date.now()}` };
    const next = [...slides];
    next.splice(idx + 1, 0, dupe);
    setExpanded((prev) => {
      const e = [...prev];
      e.splice(idx + 1, 0, true);
      return e;
    });
    onChange(next);
  };

  const addSlide = () => {
    setExpanded((prev) => [...prev, true]);
    onChange([
      ...slides,
      {
        id: `slide-${Date.now()}`,
        headerText: '',
        subheadingText: '',
        contentText: '',
        ctaText: '',
        ctaLink: '',
        backgroundImage: '',
        overlayColor: '#000000',
        overlayOpacity: 40,
        imageFit: 'cover',
      },
    ]);
  };

  return (
    <div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={slides.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {slides.map((slide, idx) => (
            <SortableSlideItem
              key={slide.id}
              id={slide.id}
              title={`Slide ${idx + 1}${slide.headerText ? ` — ${slide.headerText.replace(/<[^>]*>/g, '').substring(0, 28)}` : ''}`}
              isExpanded={!!expanded[idx]}
              onToggle={() => setExpanded((prev) => prev.map((e, i) => (i === idx ? !e : e)))}
              onRemove={() => removeSlide(idx)}
              onDuplicate={() => duplicateSlide(idx)}
            >
              <ImageField
                label="Background image"
                value={slide.backgroundImage}
                onChangeSrc={(v) => patchSlide(idx, { backgroundImage: v })}
                testId={`hcc-slide-${idx}-image`}
              />
              <SelectField
                label="Image display"
                value={slide.imageFit || 'cover'}
                onChange={(v) => patchSlide(idx, { imageFit: v })}
                options={[
                  { value: 'cover', label: 'Cover (fill & crop)' },
                  { value: 'contain', label: 'Contain (fit within)' },
                  { value: 'original', label: 'Original (natural size)' },
                ]}
                testId={`hcc-slide-${idx}-image-fit`}
              />
              <div className="grid grid-cols-2 gap-2">
                <ColorField
                  label="Overlay color"
                  value={slide.overlayColor || '#000000'}
                  onChange={(v) => patchSlide(idx, { overlayColor: v })}
                />
                <NumberField
                  label="Overlay opacity (%)"
                  value={slide.overlayOpacity ?? 40}
                  min={0} max={100}
                  onChange={(v) => patchSlide(idx, { overlayOpacity: v ?? 40 })}
                  testId={`hcc-slide-${idx}-overlay-opacity`}
                />
              </div>
              <RichTextField
                label="Header"
                value={slide.headerText || ''}
                onChange={(v) => patchSlide(idx, { headerText: v })}
                testId={`hcc-slide-${idx}-header`}
                breakpoint={breakpoint}
              />
              <RichTextField
                label="Subheading"
                value={slide.subheadingText || ''}
                onChange={(v) => patchSlide(idx, { subheadingText: v })}
                testId={`hcc-slide-${idx}-subheading`}
                breakpoint={breakpoint}
              />
              <RichTextField
                label="Content"
                value={slide.contentText || ''}
                onChange={(v) => patchSlide(idx, { contentText: v })}
                testId={`hcc-slide-${idx}-content`}
                breakpoint={breakpoint}
              />
              <div className="grid grid-cols-2 gap-2">
                <TextField
                  label="CTA button text"
                  value={slide.ctaText || ''}
                  onChange={(v) => patchSlide(idx, { ctaText: v })}
                  testId={`hcc-slide-${idx}-cta-text`}
                />
                <TextField
                  label="CTA link"
                  value={slide.ctaLink || ''}
                  onChange={(v) => patchSlide(idx, { ctaLink: v })}
                  testId={`hcc-slide-${idx}-cta-link`}
                />
              </div>
            </SortableSlideItem>
          ))}
        </SortableContext>
      </DndContext>
      <Button
        size="sm"
        variant="outline"
        type="button"
        onClick={addSlide}
        data-testid="hcc-add-slide"
        className="w-full mt-1"
      >
        <Plus size={14} className="mr-1" />
        Add slide
      </Button>
    </div>
  );
}

function HeroCarouselInspector({ block, update, breakpoint }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));

  const makeTypographyControls = (prefix, defaultSize) => (
    <details className="mt-1">
      <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-700 py-1 select-none">
        Manual font settings
      </summary>
      <div className="mt-2 space-y-2 pl-1">
        <Field label="Font family">
          <Select
            value={c[`${prefix}_font_family`] || 'Poppins'}
            onValueChange={(v) => set({ [`${prefix}_font_family`]: v })}
          >
            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {HERO_CAROUSEL_FONT_FAMILIES.map((f) => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Desktop size (px)"
            value={Number(c[`${prefix}_font_size`]) || defaultSize}
            min={10} max={120}
            onChange={(v) => set({ [`${prefix}_font_size`]: v ?? defaultSize })}
          />
          <NumberField
            label="Mobile size (px)"
            value={c[`mobile_${prefix}_font_size`] || null}
            min={10} max={120}
            onChange={(v) => set({ [`mobile_${prefix}_font_size`]: v })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Font weight">
            <Select
              value={String(c[`${prefix}_font_weight`] || '400')}
              onValueChange={(v) => set({ [`${prefix}_font_weight`]: Number(v) })}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                {HERO_CAROUSEL_FONT_WEIGHTS.map((w) => (
                  <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <ColorField
            label="Color"
            value={c[`${prefix}_color`] || '#ffffff'}
            onChange={(v) => set({ [`${prefix}_color`]: v })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Letter spacing (px)"
            value={c[`${prefix}_letter_spacing`] ?? 0}
            step={0.5} min={-2} max={10}
            onChange={(v) => set({ [`${prefix}_letter_spacing`]: v ?? 0 })}
          />
          <NumberField
            label="Line height"
            value={c[`${prefix}_line_height`] || (prefix === 'header' ? 1.2 : prefix === 'subheading' ? 1.5 : 1.6)}
            step={0.1} min={0.8} max={3}
            onChange={(v) => set({ [`${prefix}_line_height`]: v })}
          />
        </div>
      </div>
    </details>
  );

  return (
    <>
      <Field label="Slides (drag to reorder)">
        <SlideDndList
          slides={c.slides || []}
          onChange={(next) => set({ slides: next })}
          breakpoint={breakpoint}
        />
      </Field>

      <details>
        <summary className="cursor-pointer text-xs font-medium text-slate-700 py-2 select-none border-t border-slate-100 mt-1">
          Typography &amp; Colors
        </summary>
        <div className="mt-2 space-y-3">
          <div>
            <TypographyStyleField
              label="Header typography style"
              value={c.header_typography_style_id}
              onChange={(id, picked) => {
                const patch = { header_typography_style_id: id };
                if (picked) {
                  if (picked.font_family) patch.header_font_family = picked.font_family;
                  if (picked.font_size) patch.header_font_size = Number(picked.font_size);
                  if (picked.font_weight) patch.header_font_weight = Number(picked.font_weight);
                  if (picked.line_height) patch.header_line_height = Number(picked.line_height);
                  if (picked.letter_spacing != null) patch.header_letter_spacing = Number(picked.letter_spacing);
                  if (picked.color) patch.header_color = picked.color;
                }
                set(patch);
              }}
              testId="select-hcc-header-typography"
            />
            {makeTypographyControls('header', 48)}
          </div>
          <div className="border-t border-slate-100 pt-3">
            <TypographyStyleField
              label="Subheading typography style"
              value={c.subheading_typography_style_id}
              onChange={(id, picked) => {
                const patch = { subheading_typography_style_id: id };
                if (picked) {
                  if (picked.font_family) patch.subheading_font_family = picked.font_family;
                  if (picked.font_size) patch.subheading_font_size = Number(picked.font_size);
                  if (picked.font_weight) patch.subheading_font_weight = Number(picked.font_weight);
                  if (picked.line_height) patch.subheading_line_height = Number(picked.line_height);
                  if (picked.letter_spacing != null) patch.subheading_letter_spacing = Number(picked.letter_spacing);
                  if (picked.color) patch.subheading_color = picked.color;
                }
                set(patch);
              }}
              testId="select-hcc-subheading-typography"
            />
            {makeTypographyControls('subheading', 24)}
          </div>
          <div className="border-t border-slate-100 pt-3">
            <TypographyStyleField
              label="Content typography style"
              value={c.content_typography_style_id}
              onChange={(id, picked) => {
                const patch = { content_typography_style_id: id };
                if (picked) {
                  if (picked.font_family) patch.content_font_family = picked.font_family;
                  if (picked.font_size) patch.content_font_size = Number(picked.font_size);
                  if (picked.font_weight) patch.content_font_weight = Number(picked.font_weight);
                  if (picked.line_height) patch.content_line_height = Number(picked.line_height);
                  if (picked.letter_spacing != null) patch.content_letter_spacing = Number(picked.letter_spacing);
                  if (picked.color) patch.content_color = picked.color;
                }
                set(patch);
              }}
              testId="select-hcc-content-typography"
            />
            {makeTypographyControls('content', 16)}
          </div>
          <div className="border-t border-slate-100 pt-3">
            <SelectField
              label="Text alignment"
              value={c.text_alignment || 'center'}
              onChange={(v) => set({ text_alignment: v })}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
              ]}
              testId="select-hcc-text-alignment"
            />
          </div>
        </div>
      </details>

      <details>
        <summary className="cursor-pointer text-xs font-medium text-slate-700 py-2 select-none border-t border-slate-100 mt-1">
          Layout &amp; Height
        </summary>
        <div className="mt-2 space-y-3">
          <SelectField
            label="Container height"
            value={c.height_type || 'custom'}
            onChange={(v) => set({ height_type: v })}
            options={[
              { value: 'auto', label: 'Auto (min height)' },
              { value: 'full', label: 'Full viewport' },
              { value: 'custom', label: 'Custom' },
            ]}
            testId="select-hcc-height"
          />
          {(c.height_type === 'auto') && (
            <NumberField
              label="Minimum height (px)"
              value={c.auto_min_height ?? 400}
              min={100}
              onChange={(v) => set({ auto_min_height: v ?? 400 })}
              testId="input-hcc-auto-min-height"
            />
          )}
          {(!c.height_type || c.height_type === 'custom') && (
            <NumberField
              label="Custom height (px)"
              value={c.custom_height ?? 500}
              min={200}
              onChange={(v) => set({ custom_height: v ?? 500 })}
              testId="input-hcc-custom-height"
            />
          )}
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Padding vertical (px)"
              value={c.padding_vertical ?? 60}
              min={0}
              onChange={(v) => set({ padding_vertical: v ?? 60 })}
            />
            <NumberField
              label="Padding horizontal (px)"
              value={c.padding_horizontal ?? 16}
              min={0}
              onChange={(v) => set({ padding_horizontal: v ?? 16 })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Text offset X (px)"
              value={c.text_offset_x ?? 0}
              onChange={(v) => set({ text_offset_x: v ?? 0 })}
              testId="input-hcc-offset-x"
            />
            <NumberField
              label="Text offset Y (px)"
              value={c.text_offset_y ?? 0}
              onChange={(v) => set({ text_offset_y: v ?? 0 })}
              testId="input-hcc-offset-y"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Mobile text X (px)"
              value={c.mobile_text_offset_x ?? 0}
              onChange={(v) => set({ mobile_text_offset_x: v ?? 0 })}
              testId="input-hcc-mobile-offset-x"
            />
            <NumberField
              label="Mobile text Y (px)"
              value={c.mobile_text_offset_y ?? 0}
              onChange={(v) => set({ mobile_text_offset_y: v ?? 0 })}
              testId="input-hcc-mobile-offset-y"
            />
          </div>
        </div>
      </details>

      <details>
        <summary className="cursor-pointer text-xs font-medium text-slate-700 py-2 select-none border-t border-slate-100 mt-1">
          Carousel Settings
        </summary>
        <div className="mt-2 space-y-3">
          <NumberField
            label="Autoplay interval (seconds, 0 to disable)"
            value={c.autoplayInterval ?? 5}
            min={0}
            onChange={(v) => set({ autoplayInterval: v ?? 0 })}
            testId="input-hcc-autoplay"
          />
          <SelectField
            label="Transition effect"
            value={c.transitionEffect || 'fade'}
            onChange={(v) => set({ transitionEffect: v })}
            options={[
              { value: 'fade', label: 'Fade' },
              { value: 'slide-left', label: 'Slide left' },
              { value: 'slide-right', label: 'Slide right' },
              { value: 'slide-up', label: 'Slide up' },
            ]}
            testId="select-hcc-transition"
          />
          <NumberField
            label="Transition duration (ms)"
            value={c.transitionDuration ?? 700}
            min={100} max={3000} step={100}
            onChange={(v) => set({ transitionDuration: v ?? 700 })}
            testId="input-hcc-duration"
          />
          <ToggleField
            label="Pause on hover"
            value={c.pauseOnHover !== false}
            onChange={(v) => set({ pauseOnHover: v })}
            testId="toggle-hcc-pause-hover"
          />
          <ToggleField
            label="Show navigation arrows"
            value={c.showArrows !== false}
            onChange={(v) => set({ showArrows: v })}
            testId="toggle-hcc-show-arrows"
          />
          <ToggleField
            label="Show dot indicators"
            value={c.showDots !== false}
            onChange={(v) => set({ showDots: v })}
            testId="toggle-hcc-show-dots"
          />
          <ToggleField
            label="Full-bleed (span full screen width)"
            value={!!c.fullBleed}
            onChange={(v) => set({ fullBleed: v })}
            testId="toggle-hcc-full-bleed"
          />
        </div>
      </details>
    </>
  );
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY = {
  [BLOCK_TYPES.SECTION]:      { label: 'Section',        icon: LayoutPanelTop, category: 'layout',   Editor: SectionRender,      Renderer: SectionRender,      Inspector: SectionInspector },
  [BLOCK_TYPES.HERO]:         { label: 'Hero',           icon: LayoutPanelTop, category: 'content',  Editor: HeroRender,         Renderer: HeroRender,         Inspector: HeroInspector,         absoluteFill: true },
  [BLOCK_TYPES.TEXT]:         { label: 'Text',           icon: Type,           category: 'content',  Editor: TextRender,         Renderer: TextRender,         Inspector: TextInspector },
  [BLOCK_TYPES.IMAGE]:        { label: 'Image',          icon: ImageIcon,      category: 'content',  Editor: ImageRender,        Renderer: ImageRender,        Inspector: ImageInspector },
  [BLOCK_TYPES.BUTTON]:       { label: 'Button / CTA',   icon: MousePointerClick, category: 'content', Editor: ButtonRender,    Renderer: ButtonRender,       Inspector: ButtonInspector },
  [BLOCK_TYPES.VIDEO]:        { label: 'Video / embed',  icon: Film,           category: 'media',    Editor: VideoRender,        Renderer: VideoRender,        Inspector: VideoInspector },
  [BLOCK_TYPES.COLUMNS]:      { label: 'Columns',        icon: Columns3,       category: 'layout',   Editor: ColumnsRender,      Renderer: ColumnsRender,      Inspector: ColumnsInspector },
  [BLOCK_TYPES.SPACER]:       { label: 'Spacer',         icon: Rows3,          category: 'layout',   Editor: SpacerRender,       Renderer: SpacerRender,       Inspector: SpacerInspector },
  [BLOCK_TYPES.DIVIDER]:      { label: 'Divider',        icon: Minus,          category: 'layout',   Editor: DividerRender,      Renderer: DividerRender,      Inspector: DividerInspector },
  [BLOCK_TYPES.ACCORDION]:    { label: 'FAQ / Accordion',icon: HelpCircle,     category: 'content',  Editor: AccordionRender,    Renderer: AccordionRender,    Inspector: AccordionInspector, allowOverflow: true, autoHeight: true },
  [BLOCK_TYPES.TESTIMONIALS]: { label: 'Testimonials',   icon: Quote,          category: 'content',  Editor: TestimonialsRender, Renderer: TestimonialsRender, Inspector: TestimonialsInspector },
  [BLOCK_TYPES.CUSTOM_HTML]:  { label: 'Custom HTML',    icon: Code2,          category: 'advanced', Editor: CustomHtmlRender,   Renderer: CustomHtmlRender,   Inspector: CustomHtmlInspector },
  [BLOCK_TYPES.ICON]:         { label: 'Icon',           icon: Star,           category: 'ui',       Editor: IconRender,         Renderer: IconRender,         Inspector: IconInspector },
  [BLOCK_TYPES.CARD]:         { label: 'Card',           icon: LayoutGrid,     category: 'ui',       Editor: CardRender,         Renderer: CardRender,         Inspector: CardInspector, allowOverflow: true },
  [BLOCK_TYPES.STAT]:         { label: 'Stat',           icon: Hash,           category: 'ui',       Editor: StatRender,         Renderer: StatRender,         Inspector: StatInspector },
  [BLOCK_TYPES.LOGO_STRIP]:   { label: 'Logo strip',     icon: Images,         category: 'ui',       Editor: LogoStripRender,    Renderer: LogoStripRender,    Inspector: LogoStripInspector },
  [BLOCK_TYPES.MAP]:          { label: 'Map',            icon: MapIcon,        category: 'media',    Editor: MapRender,          Renderer: MapRender,          Inspector: MapInspector },
  [BLOCK_TYPES.PRICING_TABLE]:    { label: 'Pricing table',   icon: TableIcon,         category: 'content',  Editor: PricingTableRender,    Renderer: PricingTableRender,    Inspector: PricingTableInspector },
  [BLOCK_TYPES.TESTIMONIAL_GRID]: { label: 'Testimonial grid',icon: MessageSquareQuote,category: 'content',  Editor: TestimonialGridRender, Renderer: TestimonialGridRender, Inspector: TestimonialGridInspector },
  [BLOCK_TYPES.NEWS_TICKER]:      { label: 'News Ticker',     icon: Megaphone,         category: 'content',  Editor: NewsTickerRender,      Renderer: NewsTickerRender,      Inspector: NewsTickerInspector },
  [BLOCK_TYPES.MEGA_MENU]:        { label: 'Mega Menu',       icon: Menu,              category: 'content',  Editor: MegaMenuRender,        Renderer: MegaMenuRender,        Inspector: MegaMenuInspector, allowOverflow: true },
  [BLOCK_TYPES.COUNTDOWN]:        { label: 'Countdown',       icon: Clock,             category: 'content',  Editor: CountdownRender,       Renderer: CountdownRender,       Inspector: CountdownInspector },
  [BLOCK_TYPES.CARD_FLIP_GRID]:   { label: 'Card Flip Grid',  icon: Grid2x2,           category: 'content',  Editor: CardFlipGridRender,    Renderer: CardFlipGridRender,    Inspector: CardFlipGridInspector },
  [BLOCK_TYPES.HERO_CAROUSEL]:    { label: 'Hero Carousel',   icon: GalleryHorizontal, category: 'content',  Editor: HeroCarouselRender,    Renderer: HeroCarouselRender,    Inspector: HeroCarouselInspector, absoluteFill: true, allowOverflow: true },
  [BLOCK_TYPES.BOX]:          { label: 'Box',            icon: Square,         category: 'layout',   Editor: BoxRender,          Renderer: BoxRender,          Inspector: BoxInspector, paletteHidden: false },
  [BLOCK_TYPES.SYMBOL]:       { label: 'Symbol',         icon: ComponentIcon,  category: 'advanced', Editor: SymbolRender,       Renderer: SymbolRender,       Inspector: SymbolInspector, paletteHidden: true, allowOverflow: true },
  ...DYNAMIC_BLOCK_DEFINITIONS,
};

export const BLOCK_CATEGORIES = [
  { id: 'content',  label: 'Content' },
  { id: 'layout',   label: 'Layout' },
  { id: 'media',    label: 'Media' },
  { id: 'ui',       label: 'UI elements' },
  { id: 'data',     label: 'Dynamic data' },
  { id: 'advanced', label: 'Advanced' },
];

export function getBlockDefinition(type) {
  return REGISTRY[type] || REGISTRY[BLOCK_TYPES.BOX];
}

export function listPaletteBlocks() {
  return Object.entries(REGISTRY)
    .filter(([, def]) => !def.paletteHidden)
    .map(([type, def]) => ({ type, ...def }));
}
