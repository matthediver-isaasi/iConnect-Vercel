import { useMemo, useState, useEffect, useRef, lazy, Suspense } from 'react';
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
  Component as ComponentIcon,
  RotateCcw,
  Table as TableIcon,
  MessageSquareQuote,
  X,
} from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  BLOCK_TYPES,
  buildResponsiveImage,
  resolveResponsiveValue,
  hasResponsiveOverride,
  hasAnyResponsiveValue,
  writeResponsiveValue,
  BREAKPOINT_MAX_PX,
} from '@/lib/canvasDesign';
import ImageSelector from '@/components/ImageSelector';
import { sanitizeRichText, stripTrailingEmptyParagraphs, sanitizeCustomHtml } from './sanitize';
import { DYNAMIC_BLOCK_DEFINITIONS } from './dynamicBlocks';
import { useTenantBranding } from '@/contexts/TenantBrandingContext';

// Lazy-load the rich text editor — it's heavy (tiptap) and not needed for blocks
// that don't use it.
const RichTextEditor = lazy(() => import('@/components/email-builder/RichTextEditor'));

const LUCIDE_ICONS = {
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

function ImageField({ label, value, alt, onChangeSrc, onChangeAlt, testId }) {
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
  return (
    <div className="space-y-1" data-testid={testId}>
      <Label className="text-xs text-slate-600">{label}</Label>
      <div className="border border-slate-200 rounded-md overflow-hidden">
        <Suspense fallback={<div className="p-3 text-xs text-slate-500">Loading editor…</div>}>
          <RichTextEditor content={value || ''} onChange={handleChange} breakpoint={breakpoint} />
        </Suspense>
      </div>
    </div>
  );
}

function ArrayList({ items, onChange, renderItem, makeNew, addLabel = 'Add item', testIdPrefix }) {
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
            next[idx] = { ...next[idx], ...patch };
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
              onClick={() => onChange(items.filter((_, i) => i !== idx))}
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

function useTenantTypographyStyles() {
  const { data } = useQuery({
    queryKey: ['/api/public/typography-styles'],
    queryFn: fetchTenantTypographyStyles,
    staleTime: 60_000,
    retry: false,
  });
  return Array.isArray(data) ? data : [];
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

function buildTypographyInlineStyle(style, options) {
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
function hasResponsiveTypographyOverride(tenantStyle) {
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
function buildTenantTypographyResponsiveCss(selector, style) {
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
function TypographyStyleField({ label, value, onChange, testId }) {
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
function resolveTenantStyle(styleId, styles) {
  if (!styleId) return null;
  return (styles || []).find((s) => s.id === styleId) || null;
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

// Default size for tenant button variants on the canvas — matches today's
// `lg` canvas button dimensions (h-10 px-5 text-base) so a tenant whose
// stored `button_styles.{primary,secondary}` has no `size` block still
// renders at sensible CTA proportions.
const TENANT_BUTTON_DEFAULT_SIZE = {
  paddingX: 20,
  paddingY: 8,
  fontSize: 16,
  iconSize: 18,
};

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

// Compute a CSS `background` shorthand from a button_styles bg/hover config
// (the shape produced by `/ButtonElements`). Mirrors the resolver already
// used by PublicHeader / PublicLayout. Returns null when the config is
// missing so callers can fall back to a default.
function bgCssFromConfig(bgConfig) {
  if (!bgConfig) return null;
  // Task #961: explicit transparent type — no fill, regardless of any
  // stale `solidColor` / `gradientStops` left on the object.
  if (bgConfig.type === 'transparent') {
    return { backgroundColor: 'transparent' };
  }
  if (bgConfig.type === 'solid') {
    return { backgroundColor: bgConfig.solidColor || 'transparent' };
  }
  const stops = bgConfig.gradientStops;
  if (Array.isArray(stops) && stops.length >= 2) {
    const angle = bgConfig.gradientAngle ?? 90;
    const parts = [...stops]
      .sort((a, b) => a.position - b.position)
      .map((s) => `${s.color} ${s.position}%`)
      .join(', ');
    return { background: `linear-gradient(${angle}deg, ${parts})` };
  }
  if (bgConfig.gradientStart && bgConfig.gradientEnd) {
    return {
      background: `linear-gradient(90deg, ${bgConfig.gradientStart} 0%, ${bgConfig.gradientEnd} 100%)`,
    };
  }
  if (bgConfig.solidColor) {
    return { backgroundColor: bgConfig.solidColor };
  }
  return null;
}

// Resolve a stored tenant button-style key against the branding payload.
// Accepts the canvas variant string ('tenant-primary' / 'tenant-secondary')
// and returns the corresponding `branding.buttonStyles[primary|secondary]`
// object — or null when branding isn't loaded / the slot isn't configured.
function resolveTenantButtonStyle(variant, branding) {
  // Three accepted variant shapes:
  //   'tenant-primary'   → button_styles.primary    (legacy, kept stable)
  //   'tenant-secondary' → button_styles.secondary  (legacy, kept stable)
  //   'tenant:<key>'     → button_styles[<key>]     (free-form custom entries, task #960)
  let key = null;
  if (variant === 'tenant-primary') key = 'primary';
  else if (variant === 'tenant-secondary') key = 'secondary';
  else if (typeof variant === 'string' && variant.startsWith('tenant:')) {
    key = variant.slice('tenant:'.length);
  }
  if (!key) return null;
  // `buttonStyles` is the flat field exposed by /api/public/tenant-branding;
  // older payloads expose it nested as `brandingConfig.button_styles`.
  const styles =
    branding?.buttonStyles ||
    branding?.brandingConfig?.button_styles ||
    null;
  if (!styles) return null;
  return styles[key] || null;
}

// True for any variant that should be rendered via the inline-style
// tenant button path (legacy `tenant-primary` / `tenant-secondary` plus
// the free-form `tenant:<key>` form introduced in task #960).
function isTenantButtonVariant(variant) {
  return (
    variant === 'tenant-primary' ||
    variant === 'tenant-secondary' ||
    (typeof variant === 'string' && variant.startsWith('tenant:'))
  );
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
function HeroRender({ block, asEditor, priority, breakpoint }) {
  const c = block.content || {};
  // Tenant typography styles take precedence for both the headline and the
  // optional sub-headline when set and resolvable. The tag is derived from
  // the style's `style_type` (h1–h6/paragraph) and inline styles carry
  // font-family/size/weight/etc so editor preview and public renderer match.
  const tenantStyles = useTenantTypographyStyles();
  const headlineStyleObj = resolveTenantStyle(c.headlineTypographyStyleId, tenantStyles);
  const subheadlineStyleObj = resolveTenantStyle(c.subheadlineTypographyStyleId, tenantStyles);
  const Heading = headlineStyleObj
    ? tagForTypographyStyleType(headlineStyleObj.style_type)
    : `h${Math.max(1, Math.min(6, c.headingLevel || 1))}`;
  const Sub = subheadlineStyleObj
    ? tagForTypographyStyleType(subheadlineStyleObj.style_type)
    : 'p';
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const bpForInline = isPreview ? breakpoint : 'desktop';
  const headlineInline = headlineStyleObj
    ? { color: 'inherit', margin: 0, ...buildTypographyInlineStyle(headlineStyleObj, { breakpoint: bpForInline }) }
    : { color: 'inherit', margin: 0, fontSize: 'clamp(1.5rem, 4vw, 2.5rem)', fontWeight: 700 };
  const subheadlineInline = subheadlineStyleObj
    ? { color: 'inherit', marginTop: 8, opacity: 0.9, maxWidth: 720, ...buildTypographyInlineStyle(subheadlineStyleObj, { breakpoint: bpForInline }) }
    : { color: 'inherit', marginTop: 8, opacity: 0.9, maxWidth: 720 };
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
  const isImageBg = c.bgType === 'image' && c.bgImageUrl;
  const bg = isImageBg
    ? null
    : c.bgType === 'color'
      ? { background: c.bgColor || '#0f172a' }
      : { background: '#0f172a' };
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
          />
        );
      })()}
      {c.bgType === 'video' && c.bgVideoUrl && !asEditor && (
        <video
          src={c.bgVideoUrl}
          autoPlay muted loop playsInline
          className="absolute inset-0 w-full h-full object-cover"
          aria-hidden="true"
        />
      )}
      <div
        className="absolute inset-0"
        style={{ background: `rgba(0,0,0,${Math.max(0, Math.min(1, c.darkWash ?? 0.4))})` }}
        aria-hidden="true"
      />
      <div
        className="relative h-full w-full flex flex-col p-6"
        style={{ alignItems: justify, justifyContent: 'center', textAlign, color: c.textColor || '#ffffff' }}
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
            {c.ctas.map((cta, i) => {
              const ctaLabelStyleObj = resolveTenantStyle(cta.labelTypographyStyleId, tenantStyles);
              const ctaLabelInline = ctaLabelStyleObj ? buildTypographyInlineStyle(ctaLabelStyleObj) : null;
              return (
                <a
                  key={i}
                  href={asEditor ? undefined : (cta.href || '#')}
                  className={buttonClasses(cta.variant || 'primary', 'default')}
                  onClick={(e) => { if (asEditor) e.preventDefault(); }}
                >
                  <span style={ctaLabelInline || undefined}>{cta.label || 'CTA'}</span>
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function HeroInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
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
      {c.bgType === 'video' && (
        <TextField label="Background video URL" value={c.bgVideoUrl} onChange={(v) => set({ bgVideoUrl: v })} testId="input-hero-bg-video" />
      )}
      <NumberField
        label="Dark overlay (0–1)" value={c.darkWash} min={0} max={1} step={0.05}
        onChange={(v) => set({ darkWash: Math.max(0, Math.min(1, Number(v) || 0)) })}
        testId="input-hero-dark-wash"
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
              <TextField label="Link" value={item.href} onChange={(v) => patch({ href: v })} testId={`hero-cta-${idx}-href`} />
              <SelectField
                label="Variant"
                value={item.variant || 'primary'}
                onChange={(v) => patch({ variant: v })}
                options={[
                  { value: 'primary', label: 'Primary' },
                  { value: 'default', label: 'Default' },
                  { value: 'outline', label: 'Outline' },
                  { value: 'ghost', label: 'Ghost' },
                ]}
                testId={`hero-cta-${idx}-variant`}
              />
            </>
          )}
        />
      </Field>
    </>
  );
}

// TEXT -----------------------------------------------------------------------
function TextRender({ block, breakpoint }) {
  const c = block.content || {};
  const safeHtml = sanitizeRichText(stripTrailingEmptyParagraphs(c.html || ''));
  // Tenant typography style takes precedence when set and resolvable — the
  // outer tag follows the style's `style_type` (h1–h6/paragraph) and an
  // inline style object carries font-family/size/weight/etc so the public
  // renderer matches what the author sees in the editor.
  const tenantStyles = useTenantTypographyStyles();
  const tenantStyle = c.typographyStyleId
    ? tenantStyles.find((s) => s.id === c.typographyStyleId) || null
    : null;

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
    headingSizeClass = {
      1: 'text-3xl font-bold',
      2: 'text-2xl font-bold',
      3: 'text-xl font-semibold',
      4: 'text-lg font-semibold',
      5: 'text-base font-semibold',
      6: 'text-sm font-semibold uppercase tracking-wide',
    }[level] || '';
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
    </>
  );
}

// IMAGE ----------------------------------------------------------------------
function ImageRender({ block, asEditor, priority }) {
  const c = block.content || {};
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
      <TextField label="Link (optional)" value={c.href} onChange={(v) => set({ href: v })} testId="input-image-href" />
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
  const tenantStyles = useTenantTypographyStyles();
  const labelStyleObj = resolveTenantStyle(c.typographyStyleId, tenantStyles);
  const labelInline = labelStyleObj ? buildTypographyInlineStyle(labelStyleObj) : null;
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
    const tenantInner = (
      <>
        {Icon && <Icon style={{ width: iconPx, height: iconPx }} />}
        <span style={labelInline || undefined}>{c.label || 'Button'}</span>
      </>
    );
    return (
      <div className="w-full h-full flex items-center justify-start">
        <a
          href={asEditor ? undefined : (c.href || '#')}
          target={c.newTab ? '_blank' : undefined}
          rel={c.newTab ? 'noopener noreferrer' : undefined}
          aria-label={c.ariaLabel || undefined}
          className="inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap"
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
    const baseCls = `inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap ${variantClass[c.variant] || variantClass.default}`;
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
      <div className="w-full h-full flex items-center justify-start">
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
    <div className="w-full h-full flex items-center justify-start">
      <a
        href={asEditor ? undefined : (c.href || '#')}
        target={c.newTab ? '_blank' : undefined}
        rel={c.newTab ? 'noopener noreferrer' : undefined}
        aria-label={c.ariaLabel || undefined}
        className={buttonClasses(fallbackVariant, fallbackSize)}
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
    <Field label="Size">
      <div className="space-y-2">
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
      <TextField label="Link target" value={c.href} onChange={(v) => set({ href: v })} testId="input-button-href" />
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
function AccordionRender({ block }) {
  const c = block.content || {};
  // Controlled open-state so we can enforce expandOne (only one item open at
  // a time). When expandOne is false the user can open as many as they like.
  const [openIds, setOpenIds] = useState([]);
  const items = c.items || [];
  const toggle = (idx) => {
    setOpenIds((prev) => {
      const isOpen = prev.includes(idx);
      if (c.expandOne) return isOpen ? [] : [idx];
      return isOpen ? prev.filter((i) => i !== idx) : [...prev, idx];
    });
  };
  return (
    <div
      className="w-full h-full overflow-auto space-y-2"
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
              className="px-3 pb-3 pt-1 prose prose-sm max-w-none [&_p:last-child]:mb-0"
              dangerouslySetInnerHTML={{ __html: sanitizeRichText(stripTrailingEmptyParagraphs(item.a || '')) }}
            />
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
            </>
          )}
        />
      </Field>
    </>
  );
}

// TESTIMONIALS ---------------------------------------------------------------
function TestimonialsRender({ block }) {
  const c = block.content || {};
  const items = c.items || [];
  if (items.length === 0) return null;
  const containerClass =
    c.layout === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3'
      : c.layout === 'carousel' ? 'flex gap-3 overflow-x-auto snap-x'
      : 'flex flex-col gap-3';
  return (
    <div className={`w-full h-full overflow-auto ${containerClass}`}>
      {items.map((t, i) => (
        <figure
          key={i}
          className="rounded-md border border-slate-200 bg-white p-3 min-w-[240px] snap-start"
        >
          <Quote className="w-4 h-4 text-slate-400 mb-1" aria-hidden="true" />
          <blockquote className="text-sm text-slate-800">{t.quote}</blockquote>
          <figcaption className="mt-2 flex items-center gap-2 text-xs text-slate-600">
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
function CardRender({ block, asEditor, priority, breakpoint }) {
  const c = block.content || {};
  // Tenant typography style takes precedence for the card title — the
  // outer tag follows the style's `style_type` and inline styles carry
  // font-family/size/weight/etc. Falls back to the legacy `headingLevel`
  // when no style is set or the chosen style id can't be resolved.
  const tenantStyles = useTenantTypographyStyles();
  const headingStyleObj = resolveTenantStyle(c.headingTypographyStyleId, tenantStyles);
  const Heading = headingStyleObj
    ? tagForTypographyStyleType(headingStyleObj.style_type)
    : `h${Math.max(1, Math.min(6, c.headingLevel || 3))}`;
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const bpForInline = isPreview ? breakpoint : 'desktop';
  const headingInline = headingStyleObj
    ? { margin: 0, marginTop: c.imageUrl ? 12 : 0, ...buildTypographyInlineStyle(headingStyleObj, { breakpoint: bpForInline }) }
    : { margin: 0, marginTop: c.imageUrl ? 12 : 0, fontSize: '1.125rem', fontWeight: 600 };
  const safeBlockId = String(block.id || '').replace(/["\\]/g, '');
  const cardResponsiveCss = !isPreview && headingStyleObj && hasResponsiveTypographyOverride(headingStyleObj)
    ? buildTenantTypographyResponsiveCss(`[data-cb="${safeBlockId}"] [data-tg-r="card-heading"]`, headingStyleObj)
    : null;
  return (
    <div className="w-full h-full flex flex-col">
      {cardResponsiveCss && (
        <style dangerouslySetInnerHTML={{ __html: cardResponsiveCss }} />
      )}
      {c.imageUrl && (() => {
        const r = buildResponsiveImage(c.imageUrl, { sizes: '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw' });
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
            style={{ height: 160, objectFit: 'cover', borderRadius: 4 }}
          />
        );
      })()}
      <Heading style={headingInline} data-tg-r="card-heading">
        {c.heading}
      </Heading>
      <div
        className="prose prose-sm max-w-none mt-1 flex-1 [&_p:last-child]:mb-0"
        dangerouslySetInnerHTML={{ __html: sanitizeRichText(stripTrailingEmptyParagraphs(c.body || '')) }}
      />
      {c.ctaLabel && (() => {
        const ctaLabelStyleObj = resolveTenantStyle(c.ctaLabelTypographyStyleId, tenantStyles);
        const ctaLabelInline = ctaLabelStyleObj ? buildTypographyInlineStyle(ctaLabelStyleObj) : null;
        return (
          <div className="mt-2">
            <a
              href={asEditor ? undefined : (c.ctaHref || '#')}
              className={buttonClasses(c.ctaVariant || 'outline', 'default')}
              onClick={(e) => { if (asEditor) e.preventDefault(); }}
            >
              <span style={ctaLabelInline || undefined}>{c.ctaLabel}</span>
              <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        );
      })()}
    </div>
  );
}

function CardInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
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
      <TextField label="CTA label" value={c.ctaLabel} onChange={(v) => set({ ctaLabel: v })} testId="input-card-cta-label" />
      <TypographyStyleField
        label="CTA label style"
        value={c.ctaLabelTypographyStyleId}
        onChange={(id) => set({ ctaLabelTypographyStyleId: id })}
        testId="select-card-cta-typography"
      />
      <TextField label="CTA link" value={c.ctaHref} onChange={(v) => set({ ctaHref: v })} testId="input-card-cta-href" />
      <SelectField
        label="CTA variant"
        value={c.ctaVariant || 'outline'}
        onChange={(v) => set({ ctaVariant: v })}
        options={[
          { value: 'primary', label: 'Primary' },
          { value: 'default', label: 'Default' },
          { value: 'outline', label: 'Outline' },
          { value: 'ghost', label: 'Ghost' },
        ]}
        testId="select-card-cta-variant"
      />
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
              <TextField label="Link" value={item.href} onChange={(v) => patch({ href: v })} testId={`logo-${idx}-href`} />
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

// PRICING TABLE --------------------------------------------------------------
// Author-friendly pricing layout with 2-4 tiers. Each tier carries its own
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

function PricingTableRender({ block, asEditor, breakpoint }) {
  const c = block.content || {};
  const tiers = Array.isArray(c.tiers) ? c.tiers.slice(0, 4) : [];
  const showToggle = !!c.billingToggle;
  const [billing, setBilling] = useState(c.defaultBilling === 'annual' ? 'annual' : 'monthly');
  const headingLevel = Math.max(1, Math.min(6, Number(c.headingLevel) || 2));
  const Heading = `h${headingLevel}`;
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const responsiveCss = !isPreview ? buildResponsiveColumnsCss(block.id, c.columns, c.gap) : null;
  const previewCols = isPreview ? resolveColumns(c.columns, breakpoint) : null;
  const recommendedBadge = c.recommendedBadgeLabel || 'Most popular';

  return (
    <div className="w-full h-full overflow-auto">
      {responsiveCss && <style dangerouslySetInnerHTML={{ __html: responsiveCss }} />}
      {(c.heading || c.subheading) && (
        <div className="mb-4 text-center">
          {c.heading && (
            <Heading style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600, color: 'var(--cb-color-on-surface, #0f172a)' }}>
              {c.heading}
            </Heading>
          )}
          {c.subheading && (
            <p className="mt-1 text-sm" style={{ color: 'var(--cb-color-on-surface-muted, #475569)' }}>
              {c.subheading}
            </p>
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
              style={tierStyle}
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
              <h3 className="text-base font-semibold" style={{ margin: 0, color: 'var(--cb-color-on-surface, #0f172a)' }}>
                {t.name || `Tier ${i + 1}`}
              </h3>
              {t.description && (
                <p className="mt-1 text-sm" style={{ color: 'var(--cb-color-on-surface-muted, #475569)' }}>
                  {t.description}
                </p>
              )}
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-3xl font-bold" style={{ color: 'var(--cb-color-on-surface, #0f172a)' }}>
                  {price || '—'}
                </span>
                {t.period && (
                  <span className="text-sm" style={{ color: 'var(--cb-color-on-surface-muted, #475569)' }}>
                    {t.period}
                  </span>
                )}
              </div>
              {Array.isArray(t.features) && t.features.length > 0 && (
                <ul className="mt-4 space-y-1.5 text-sm" style={{ listStyle: 'none', padding: 0, margin: 0, color: 'var(--cb-color-on-surface, #0f172a)' }}>
                  {t.features.filter(Boolean).map((f, fi) => {
                    const feat = typeof f === 'string' ? { text: f, included: true, tooltip: '' } : (f || {});
                    const included = feat.included !== false;
                    const Glyph = included ? Check : X;
                    const srPrefix = included ? 'Included: ' : 'Not included: ';
                    return (
                      <li
                        key={fi}
                        className="flex items-start gap-2"
                        title={feat.tooltip || undefined}
                        style={{ opacity: included ? 1 : 0.65 }}
                      >
                        <Glyph
                          className="w-4 h-4 mt-0.5 shrink-0"
                          style={{ color: included ? 'var(--cb-color-primary, #0f172a)' : 'var(--cb-color-on-surface-muted, #64748b)' }}
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
                  <a
                    href={asEditor ? undefined : (t.ctaHref || '#')}
                    onClick={(e) => { if (asEditor) e.preventDefault(); }}
                    className={buttonClasses(t.ctaVariant || (t.recommended ? 'primary' : 'outline'), 'default')}
                    style={{ width: '100%', justifyContent: 'center' }}
                    aria-label={`${t.ctaLabel} — ${t.name || `Tier ${i + 1}`}`}
                    data-testid={`link-pricing-cta-${i}`}
                  >
                    <span>{t.ctaLabel}</span>
                  </a>
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
  const setColumns = (bp, val) => set({ columns: { ...(c.columns || {}), [bp]: Math.max(1, Math.min(4, Number(val) || 1)) } });
  const tiers = Array.isArray(c.tiers) ? c.tiers : [];
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
      <TextField label="Subheading" multiline value={c.subheading} onChange={(v) => set({ subheading: v })} testId="input-pricing-subheading" />
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
        <NumberField label="Cols (desktop)" min={1} max={4} value={resolveColumns(c.columns, 'desktop')} onChange={(v) => setColumns('desktop', v)} testId="input-pricing-cols-desktop" />
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
      <Field label="Tiers (2–4)">
        <ArrayList
          items={tiers}
          onChange={(next) => set({ tiers: next.slice(0, 4) })}
          makeNew={() => ({
            name: 'New tier', monthlyPrice: '£0', annualPrice: '£0', period: '/month',
            description: '', features: [{ text: 'Feature one', included: true, tooltip: '' }],
            ctaLabel: 'Choose', ctaHref: '#', ctaVariant: 'outline', recommended: false,
          })}
          addLabel={tiers.length >= 4 ? 'Maximum 4 tiers' : 'Add tier'}
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
                <TextField label="CTA link" value={item.ctaHref} onChange={(v) => patch({ ctaHref: v })} testId={`pricing-tier-${idx}-cta-href`} />
                <SelectField
                  label="CTA variant"
                  value={item.ctaVariant || 'outline'}
                  onChange={(v) => patch({ ctaVariant: v })}
                  options={[
                    { value: 'primary', label: 'Primary' },
                    { value: 'default', label: 'Default' },
                    { value: 'outline', label: 'Outline' },
                    { value: 'ghost', label: 'Ghost' },
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
        {tiers.length > 4 && (
          <p className="text-xs text-warning mt-1">Only the first 4 tiers will render.</p>
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
  const headingLevel = Math.max(1, Math.min(6, Number(c.headingLevel) || 2));
  const Heading = `h${headingLevel}`;
  const isPreview = breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
  const responsiveCss = !isPreview ? buildResponsiveColumnsCss(block.id, c.columns, c.gap) : null;
  const previewCols = isPreview ? resolveColumns(c.columns, breakpoint) : null;
  return (
    <div className="w-full h-full overflow-auto">
      {responsiveCss && <style dangerouslySetInnerHTML={{ __html: responsiveCss }} />}
      {c.heading && (
        <Heading
          className="mb-4 text-center"
          style={{ margin: '0 0 1rem', fontSize: '1.5rem', fontWeight: 600, color: 'var(--cb-color-on-surface, #0f172a)' }}
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
              style={{
                margin: 0,
                fontSize: '0.95rem',
                lineHeight: 1.5,
                color: 'var(--cb-color-on-surface, #0f172a)',
              }}
            >
              {t.quote}
            </blockquote>
            <figcaption
              className="flex items-center gap-3 mt-auto"
              style={{ color: 'var(--cb-color-on-surface-muted, #475569)', fontSize: '0.875rem' }}
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
  );
}

function TestimonialGridInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
  const setColumns = (bp, val) => set({ columns: { ...(c.columns || {}), [bp]: Math.max(1, Math.min(4, Number(val) || 1)) } });
  return (
    <>
      <TextField label="Heading" value={c.heading} onChange={(v) => set({ heading: v })} testId="input-testimonial-grid-heading" />
      <SelectField
        label="Heading level"
        value={String(c.headingLevel || 2)}
        onChange={(v) => set({ headingLevel: Number(v) })}
        options={[2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `H${n}` }))}
        testId="select-testimonial-grid-heading-level"
      />
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Cols (desktop)" min={1} max={4} value={resolveColumns(c.columns, 'desktop')} onChange={(v) => setColumns('desktop', v)} testId="input-testimonial-grid-cols-desktop" />
        <NumberField label="Cols (tablet)" min={1} max={4} value={resolveColumns(c.columns, 'tablet')} onChange={(v) => setColumns('tablet', v)} testId="input-testimonial-grid-cols-tablet" />
        <NumberField label="Cols (mobile)" min={1} max={4} value={resolveColumns(c.columns, 'mobile')} onChange={(v) => setColumns('mobile', v)} testId="input-testimonial-grid-cols-mobile" />
      </div>
      <NumberField label="Gap (px)" min={0} max={64} value={c.gap || 16} onChange={(v) => set({ gap: Number(v) || 0 })} testId="input-testimonial-grid-gap" />
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
// Helpers for the new Section background-image + overlay layers.
// hexToRgba accepts any author-entered colour string. For 3/6-digit hex we
// parse to rgba(); otherwise we hand the raw value to CSS wrapped via
// `color-mix` is overkill — instead we fall back to letting the browser
// resolve the colour and apply opacity via a second value. To keep the
// gradient string valid CSS in every case, we always emit rgba() for hex
// inputs and an opacity-multiplied raw value otherwise.
function hexToRgba(input, opacity) {
  const o = Math.max(0, Math.min(1, Number(opacity) || 0));
  if (typeof input !== 'string') return `rgba(0,0,0,${o})`;
  const s = input.trim();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m3) {
    const r = parseInt(m3[1] + m3[1], 16);
    const g = parseInt(m3[2] + m3[2], 16);
    const b = parseInt(m3[3] + m3[3], 16);
    return `rgba(${r},${g},${b},${o})`;
  }
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (m6) {
    const r = parseInt(m6[1], 16);
    const g = parseInt(m6[2], 16);
    const b = parseInt(m6[3], 16);
    return `rgba(${r},${g},${b},${o})`;
  }
  // Fallback: assume the caller passed an rgb()/rgba()/named colour and
  // approximate opacity by wrapping in color-mix. Browsers without
  // color-mix support fall back to the raw value (opacity ignored), which
  // is acceptable for v1 since the inspector picker emits hex.
  return `color-mix(in srgb, ${s} ${Math.round(o * 100)}%, transparent)`;
}

function buildSectionOverlayBackground(c) {
  const t = c.overlayType || 'none';
  if (t === 'solid') {
    return hexToRgba(c.overlayColor || '#000000', c.overlayOpacity ?? 0.4);
  }
  if (t === 'linear') {
    const angle = Number.isFinite(c.overlayAngle) ? c.overlayAngle : 180;
    const from = hexToRgba(c.overlayFromColor || '#000000', c.overlayFromOpacity ?? 0.6);
    const to = hexToRgba(c.overlayToColor || '#000000', c.overlayToOpacity ?? 0);
    return `linear-gradient(${angle}deg, ${from}, ${to})`;
  }
  if (t === 'radial') {
    const centre = hexToRgba(c.overlayCenterColor || '#000000', c.overlayCenterOpacity ?? 0);
    const edge = hexToRgba(c.overlayEdgeColor || '#000000', c.overlayEdgeOpacity ?? 0.6);
    return `radial-gradient(ellipse at center, ${centre}, ${edge})`;
  }
  return null;
}

// Builds the CSS gradient string for sections whose `bgType === 'gradient'`.
// Mirrors buildSectionOverlayBackground but uses dedicated `gradient*` keys
// so the value is preserved separately from any image-overlay configuration
// the same section may also have stored.
function buildSectionGradientBackground(c) {
  const t = c.gradientType || 'linear';
  if (t === 'radial') {
    const centre = hexToRgba(c.gradientCenterColor || '#3b82f6', c.gradientCenterOpacity ?? 1);
    const edge = hexToRgba(c.gradientEdgeColor || '#1e3a8a', c.gradientEdgeOpacity ?? 1);
    return `radial-gradient(ellipse at center, ${centre}, ${edge})`;
  }
  const angle = Number.isFinite(c.gradientAngle) ? c.gradientAngle : 180;
  const from = hexToRgba(c.gradientFromColor || '#3b82f6', c.gradientFromOpacity ?? 1);
  const to = hexToRgba(c.gradientToColor || '#1e3a8a', c.gradientToOpacity ?? 1);
  return `linear-gradient(${angle}deg, ${from}, ${to})`;
}

const SECTION_BLEND_MODES = [
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
            <>
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
              <ColorField
                label="From colour"
                value={c.gradientFromColor || '#3b82f6'}
                onChange={(v) => set({ gradientFromColor: v })}
                testId="input-section-gradient-from-color"
              />
              <NumberField
                label="From opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.gradientFromOpacity ?? 1}
                onChange={(v) => set({ gradientFromOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-section-gradient-from-opacity"
              />
              <ColorField
                label="To colour"
                value={c.gradientToColor || '#1e3a8a'}
                onChange={(v) => set({ gradientToColor: v })}
                testId="input-section-gradient-to-color"
              />
              <NumberField
                label="To opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.gradientToOpacity ?? 1}
                onChange={(v) => set({ gradientToOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-section-gradient-to-opacity"
              />
            </>
          )}
          {gradientType === 'radial' && (
            <>
              <ColorField
                label="Centre colour"
                value={c.gradientCenterColor || '#3b82f6'}
                onChange={(v) => set({ gradientCenterColor: v })}
                testId="input-section-gradient-center-color"
              />
              <NumberField
                label="Centre opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.gradientCenterOpacity ?? 1}
                onChange={(v) => set({ gradientCenterOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-section-gradient-center-opacity"
              />
              <ColorField
                label="Edge colour"
                value={c.gradientEdgeColor || '#1e3a8a'}
                onChange={(v) => set({ gradientEdgeColor: v })}
                testId="input-section-gradient-edge-color"
              />
              <NumberField
                label="Edge opacity (0–1)"
                min={0} max={1} step={0.05}
                value={c.gradientEdgeOpacity ?? 1}
                onChange={(v) => set({ gradientEdgeOpacity: Math.max(0, Math.min(1, Number(v) || 0)) })}
                testId="input-section-gradient-edge-opacity"
              />
            </>
          )}
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
function SymbolRender({ block, asEditor }) {
  const c = block.content || {};
  const symbolChildren = block.__symbolChildren;
  if (!asEditor && Array.isArray(symbolChildren) && symbolChildren.length > 0) {
    // In the public renderer, defer to the host page's renderer to draw the
    // spliced-in children. We return null here because CanvasPageRenderer
    // walks __symbolChildren itself; emitting markup again would duplicate.
    return null;
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
function SymbolInspector({ block }) {
  const c = block.content || {};
  return (
    <div className="space-y-2 text-xs text-slate-600">
      <p><strong>Symbol:</strong> {c.symbolName || c.symbolId || '—'}</p>
      <p className="text-slate-500">
        This block reuses a saved symbol. Open the Symbols dialog to manage symbols, or use Unlink to convert this instance back into editable blocks on the page.
      </p>
    </div>
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
  [BLOCK_TYPES.ACCORDION]:    { label: 'FAQ / Accordion',icon: HelpCircle,     category: 'content',  Editor: AccordionRender,    Renderer: AccordionRender,    Inspector: AccordionInspector },
  [BLOCK_TYPES.TESTIMONIALS]: { label: 'Testimonials',   icon: Quote,          category: 'content',  Editor: TestimonialsRender, Renderer: TestimonialsRender, Inspector: TestimonialsInspector },
  [BLOCK_TYPES.CUSTOM_HTML]:  { label: 'Custom HTML',    icon: Code2,          category: 'advanced', Editor: CustomHtmlRender,   Renderer: CustomHtmlRender,   Inspector: CustomHtmlInspector },
  [BLOCK_TYPES.ICON]:         { label: 'Icon',           icon: Star,           category: 'ui',       Editor: IconRender,         Renderer: IconRender,         Inspector: IconInspector },
  [BLOCK_TYPES.CARD]:         { label: 'Card',           icon: LayoutGrid,     category: 'ui',       Editor: CardRender,         Renderer: CardRender,         Inspector: CardInspector },
  [BLOCK_TYPES.STAT]:         { label: 'Stat',           icon: Hash,           category: 'ui',       Editor: StatRender,         Renderer: StatRender,         Inspector: StatInspector },
  [BLOCK_TYPES.LOGO_STRIP]:   { label: 'Logo strip',     icon: Images,         category: 'ui',       Editor: LogoStripRender,    Renderer: LogoStripRender,    Inspector: LogoStripInspector },
  [BLOCK_TYPES.MAP]:          { label: 'Map',            icon: MapIcon,        category: 'media',    Editor: MapRender,          Renderer: MapRender,          Inspector: MapInspector },
  [BLOCK_TYPES.PRICING_TABLE]:    { label: 'Pricing table',   icon: TableIcon,         category: 'content',  Editor: PricingTableRender,    Renderer: PricingTableRender,    Inspector: PricingTableInspector },
  [BLOCK_TYPES.TESTIMONIAL_GRID]: { label: 'Testimonial grid',icon: MessageSquareQuote,category: 'content',  Editor: TestimonialGridRender, Renderer: TestimonialGridRender, Inspector: TestimonialGridInspector },
  [BLOCK_TYPES.BOX]:          { label: 'Box',            icon: Square,         category: 'layout',   Editor: BoxRender,          Renderer: BoxRender,          Inspector: BoxInspector, paletteHidden: false },
  [BLOCK_TYPES.SYMBOL]:       { label: 'Symbol',         icon: ComponentIcon,  category: 'advanced', Editor: SymbolRender,       Renderer: SymbolRender,       Inspector: SymbolInspector, paletteHidden: true },
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
