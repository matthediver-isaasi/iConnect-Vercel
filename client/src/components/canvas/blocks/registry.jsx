import { useMemo, useState, useEffect, lazy, Suspense } from 'react';
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
} from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BLOCK_TYPES, buildResponsiveImage } from '@/lib/canvasDesign';
import ImageSelector from '@/components/ImageSelector';
import { sanitizeRichText, stripTrailingEmptyParagraphs, sanitizeCustomHtml } from './sanitize';
import { DYNAMIC_BLOCK_DEFINITIONS } from './dynamicBlocks';

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

function RichTextField({ label, value, onChange, testId }) {
  // Sanitize on write so the stored design is always safe even if the
  // editor is bypassed or pasted content contains XSS payloads.
  const handleChange = (next) => onChange(sanitizeRichText(next || ''));
  return (
    <div className="space-y-1" data-testid={testId}>
      <Label className="text-xs text-slate-600">{label}</Label>
      <div className="border border-slate-200 rounded-md overflow-hidden">
        <Suspense fallback={<div className="p-3 text-xs text-slate-500">Loading editor…</div>}>
          <RichTextEditor content={value || ''} onChange={handleChange} />
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

function buildTypographyInlineStyle(style, options) {
  if (!style) return null;
  const opts = options || {};
  const out = {};
  if (style.font_family) out.fontFamily = style.font_family;
  // When the style declares a mobile-specific value and the caller has
  // opted into responsive rendering, the corresponding property is
  // emitted via a per-block <style> block with a media query instead
  // of an inline style — inline styles win against any selector, so we
  // can't reliably override them in a `@media (max-width: …)` rule.
  if (style.font_size != null && !opts.omitFontSize) out.fontSize = `${style.font_size}px`;
  if (style.font_weight != null) out.fontWeight = style.font_weight;
  if (style.line_height != null && !opts.omitLineHeight) out.lineHeight = style.line_height;
  if (style.letter_spacing != null && !opts.omitLetterSpacing) out.letterSpacing = `${style.letter_spacing}px`;
  if (style.text_transform && style.text_transform !== 'none') {
    out.textTransform = style.text_transform;
  }
  if (style.color) out.color = style.color;
  if (style.margin_bottom != null && !opts.omitMarginBottom) out.marginBottom = `${style.margin_bottom}px`;
  return out;
}

// Matches BREAKPOINT_MAX_PX.mobile in `@/lib/canvasDesign` — kept inline
// here to avoid adding an import for a single constant. If the canonical
// mobile breakpoint ever changes, update both call sites.
const MOBILE_BREAKPOINT_MAX_PX = 639.98;

// Returns true when the tenant style declares a mobile-specific override
// for the given property (mobile value present and different to desktop).
function hasMobileOverride(tenantStyle, desktopKey, mobileKey) {
  if (!tenantStyle) return false;
  const m = tenantStyle[mobileKey];
  if (m == null) return false;
  return m !== tenantStyle[desktopKey];
}

// Builds a <style> rule that overrides the Text block's typography
// properties at the mobile breakpoint when the chosen tenant typography
// style declares distinct mobile equivalents (font-size, line-height,
// letter-spacing, margin-bottom). The selector matches the renderer's
// outer wrapper (`[data-cb="<id>"]`) emitted by `CanvasBlockRender`.
// Returns null when no responsive override is needed.
function buildTextMobileTypographyCss(blockId, tenantStyle) {
  if (!tenantStyle || !blockId) return null;
  const overrides = {
    fontSize: hasMobileOverride(tenantStyle, 'font_size', 'font_size_mobile')
      ? { desktop: `${tenantStyle.font_size}px`, mobile: `${tenantStyle.font_size_mobile}px` }
      : null,
    lineHeight: hasMobileOverride(tenantStyle, 'line_height', 'line_height_mobile')
      ? { desktop: String(tenantStyle.line_height), mobile: String(tenantStyle.line_height_mobile) }
      : null,
    letterSpacing: hasMobileOverride(tenantStyle, 'letter_spacing', 'letter_spacing_mobile')
      ? { desktop: `${tenantStyle.letter_spacing}px`, mobile: `${tenantStyle.letter_spacing_mobile}px` }
      : null,
    marginBottom: hasMobileOverride(tenantStyle, 'margin_bottom', 'margin_bottom_mobile')
      ? { desktop: `${tenantStyle.margin_bottom}px`, mobile: `${tenantStyle.margin_bottom_mobile}px` }
      : null,
  };
  const cssKey = {
    fontSize: 'font-size',
    lineHeight: 'line-height',
    letterSpacing: 'letter-spacing',
    marginBottom: 'margin-bottom',
  };
  const active = Object.entries(overrides).filter(([, v]) => v != null);
  if (active.length === 0) return null;
  // CSS attribute selectors with quoted values don't need escaping for
  // typical generated block ids, but defensively strip the quote/backslash
  // characters that would break the selector.
  const safeId = String(blockId).replace(/["\\]/g, '');
  const sel = `[data-cb="${safeId}"]`;
  const desktopDecls = active.map(([k, v]) => `${cssKey[k]}:${v.desktop};`).join('');
  const mobileDecls = active.map(([k, v]) => `${cssKey[k]}:${v.mobile};`).join('');
  const desktopRule = `${sel}{${desktopDecls}}`;
  const mobileRule = `@media (max-width:${MOBILE_BREAKPOINT_MAX_PX}px){${sel}{${mobileDecls}}}`;
  return `${desktopRule}${mobileRule}`;
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
function HeroRender({ block, asEditor, priority }) {
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
  const headlineInline = headlineStyleObj
    ? { color: 'inherit', margin: 0, ...buildTypographyInlineStyle(headlineStyleObj) }
    : { color: 'inherit', margin: 0, fontSize: 'clamp(1.5rem, 4vw, 2.5rem)', fontWeight: 700 };
  const subheadlineInline = subheadlineStyleObj
    ? { color: 'inherit', marginTop: 8, opacity: 0.9, maxWidth: 720, ...buildTypographyInlineStyle(subheadlineStyleObj) }
    : { color: 'inherit', marginTop: 8, opacity: 0.9, maxWidth: 720 };
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
        <Heading style={headlineInline}>
          {c.headline || ''}
        </Heading>
        {c.subheadline && (
          <Sub style={subheadlineInline}>
            {c.subheadline}
          </Sub>
        )}
        {Array.isArray(c.ctas) && c.ctas.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2" style={{ justifyContent: justify }}>
            {c.ctas.map((cta, i) => (
              <a
                key={i}
                href={asEditor ? undefined : (cta.href || '#')}
                className={buttonClasses(cta.variant || 'primary', 'default')}
                onClick={(e) => { if (asEditor) e.preventDefault(); }}
              >
                {cta.label || 'CTA'}
              </a>
            ))}
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

  // Responsive typography handling: if the chosen tenant style has any
  // distinct mobile equivalents (font-size, line-height, letter-spacing,
  // margin-bottom), we omit those properties from inline styles and
  // instead emit a per-block <style> tag with a `@media` rule so the
  // mobile values kick in below the mobile breakpoint. When the editor
  // previews a forced breakpoint (`?_bp=mobile`), the iframe viewport
  // may not actually match the media query, so we additionally pin the
  // matching values inline for the forced breakpoint preview.
  const hasMobileFontSize = hasMobileOverride(tenantStyle, 'font_size', 'font_size_mobile');
  const hasMobileLineHeight = hasMobileOverride(tenantStyle, 'line_height', 'line_height_mobile');
  const hasMobileLetterSpacing = hasMobileOverride(tenantStyle, 'letter_spacing', 'letter_spacing_mobile');
  const hasMobileMarginBottom = hasMobileOverride(tenantStyle, 'margin_bottom', 'margin_bottom_mobile');
  const mobileTypographyCss = tenantStyle
    ? buildTextMobileTypographyCss(block.id, tenantStyle)
    : null;

  let Tag;
  let headingSizeClass = '';
  let inlineTypography = null;
  if (tenantStyle) {
    Tag = tagForTypographyStyleType(tenantStyle.style_type);
    inlineTypography = buildTypographyInlineStyle(tenantStyle, {
      omitFontSize: hasMobileFontSize,
      omitLineHeight: hasMobileLineHeight,
      omitLetterSpacing: hasMobileLetterSpacing,
      omitMarginBottom: hasMobileMarginBottom,
    });
    // For forced breakpoint previews in the editor (where the iframe
    // viewport may not match the @media rule), pin the matching values
    // inline so the preview reflects the responsive override.
    const isMobile = breakpoint === 'mobile';
    const isWide = breakpoint === 'desktop' || breakpoint === 'tablet';
    if (hasMobileFontSize) {
      const v = isMobile ? tenantStyle.font_size_mobile : isWide ? tenantStyle.font_size : null;
      if (v != null) inlineTypography.fontSize = `${v}px`;
    }
    if (hasMobileLineHeight) {
      const v = isMobile ? tenantStyle.line_height_mobile : isWide ? tenantStyle.line_height : null;
      if (v != null) inlineTypography.lineHeight = v;
    }
    if (hasMobileLetterSpacing) {
      const v = isMobile ? tenantStyle.letter_spacing_mobile : isWide ? tenantStyle.letter_spacing : null;
      if (v != null) inlineTypography.letterSpacing = `${v}px`;
    }
    if (hasMobileMarginBottom) {
      const v = isMobile ? tenantStyle.margin_bottom_mobile : isWide ? tenantStyle.margin_bottom : null;
      if (v != null) inlineTypography.marginBottom = `${v}px`;
    }
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
  return (
    <>
      {mobileTypographyCss && (
        <style dangerouslySetInnerHTML={{ __html: mobileTypographyCss }} />
      )}
      <Tag
        className={`prose prose-sm max-w-none w-full h-full overflow-auto [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:text-xl [&_h3]:font-semibold [&_h4]:text-lg [&_h4]:font-semibold [&_h5]:text-base [&_h5]:font-semibold [&_h6]:text-sm [&_h6]:font-semibold [&_h6]:uppercase [&_p:last-child]:mb-0 [&_a]:text-blue-600 [&_a]:underline ${headingSizeClass}`}
        style={outerStyle}
        dangerouslySetInnerHTML={{ __html: safeHtml }}
      />
    </>
  );
}

function TextInspector({ block, update }) {
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
      <RichTextField label="Content" value={c.html} onChange={(v) => set({ html: v })} testId="input-text-content" />
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
function ButtonRender({ block, asEditor }) {
  const c = block.content || {};
  const Icon = getLucideIcon(c.icon);
  // Tenant typography style — when set, the label span carries inline
  // font-family/size/weight/etc so the button label honours brand type. The
  // outer anchor still uses the variant/size button classes (background,
  // radius, hover/active states) so this only changes typography.
  const tenantStyles = useTenantTypographyStyles();
  const labelStyleObj = resolveTenantStyle(c.typographyStyleId, tenantStyles);
  const labelInline = labelStyleObj ? buildTypographyInlineStyle(labelStyleObj) : null;
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
        className={buttonClasses(c.variant, c.size)}
        onClick={(e) => { if (asEditor) e.preventDefault(); }}
      >
        {inner}
      </a>
    </div>
  );
}

function ButtonInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
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
        ]}
        testId="select-button-variant"
      />
      <SelectField
        label="Size"
        value={c.size || 'default'}
        onChange={(v) => set({ size: v })}
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
function IconRender({ block }) {
  const c = block.content || {};
  const Icon = getLucideIcon(c.icon) || Star;
  return (
    <div className="w-full h-full flex items-center justify-center">
      <Icon
        style={{ color: c.color || '#0f172a', width: c.size || 48, height: c.size || 48 }}
        aria-label={c.ariaLabel || undefined}
        aria-hidden={c.ariaLabel ? undefined : true}
      />
    </div>
  );
}

function IconInspector({ block, update }) {
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
      <NumberField label="Size (px)" min={8} max={256} value={c.size || 48} onChange={(v) => set({ size: Math.max(8, Number(v) || 8) })} testId="input-icon-size" />
      <TextField label="ARIA label (if meaningful)" value={c.ariaLabel} onChange={(v) => set({ ariaLabel: v })} testId="input-icon-aria" />
    </>
  );
}

// CARD -----------------------------------------------------------------------
function CardRender({ block, asEditor, priority }) {
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
  const headingInline = headingStyleObj
    ? { margin: 0, marginTop: c.imageUrl ? 12 : 0, ...buildTypographyInlineStyle(headingStyleObj) }
    : { margin: 0, marginTop: c.imageUrl ? 12 : 0, fontSize: '1.125rem', fontWeight: 600 };
  return (
    <div className="w-full h-full flex flex-col">
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
      <Heading style={headingInline}>
        {c.heading}
      </Heading>
      <div
        className="prose prose-sm max-w-none mt-1 flex-1 [&_p:last-child]:mb-0"
        dangerouslySetInnerHTML={{ __html: sanitizeRichText(stripTrailingEmptyParagraphs(c.body || '')) }}
      />
      {c.ctaLabel && (
        <div className="mt-2">
          <a
            href={asEditor ? undefined : (c.ctaHref || '#')}
            className={buttonClasses(c.ctaVariant || 'outline', 'default')}
            onClick={(e) => { if (asEditor) e.preventDefault(); }}
          >
            {c.ctaLabel}
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      )}
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
function StatRender({ block }) {
  const c = block.content || {};
  return (
    <div className="w-full h-full flex flex-col items-center justify-center text-center">
      <div
        style={{ color: c.color || '#0f172a', fontSize: 'clamp(1.5rem, 4vw, 2.5rem)', fontWeight: 700, lineHeight: 1 }}
      >
        {c.value}
      </div>
      <div className="text-sm text-slate-600 mt-1">{c.label}</div>
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

// SECTION --------------------------------------------------------------------
// A visual grouping primitive. The canvas itself is flat (absolute
// positioning), so Section acts as a styled background "band" / container
// frame behind other blocks placed over it (controlled via z-index). Its
// own appearance (background, border, padding) comes from block.style; the
// inner content offers a max-width centering rail and an optional editor
// label so authors can tell sections apart from regular boxes.
function SectionRender({ block, asEditor }) {
  const c = block.content || {};
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

  // Inner rail keeps content centered at the configured max-width even
  // when the outer section is full-bleed.
  const railStyle = c.maxWidth
    ? { maxWidth: c.maxWidth, marginInline: 'auto', width: '100%', height: '100%' }
    : { width: '100%', height: '100%' };

  return (
    <div
      className="w-full h-full relative"
      style={fullBleedStyle || undefined}
      data-section-id={block.id}
      data-full-bleed={c.fullBleed ? 'true' : 'false'}
    >
      <div style={railStyle} />
      {asEditor && (
        <span
          className="absolute top-1 left-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded bg-slate-900/70 text-white pointer-events-none"
          aria-hidden="true"
        >
          Section{c.fullBleed ? ' · full-bleed' : ''}
        </span>
      )}
    </div>
  );
}

function SectionInspector({ block, update }) {
  const c = block.content || {};
  const set = (patch) => update((b) => ({ ...b, content: { ...b.content, ...patch } }));
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
      <p className="text-xs text-slate-500">
        Use the Appearance and Spacing panels above for background, border and padding.
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
