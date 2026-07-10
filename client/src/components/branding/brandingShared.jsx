import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Plus, X, User, Palette } from "lucide-react";
import { CURATED_FONTS } from "@/lib/sharedFonts";
import { useInstalledFonts } from "@/lib/installedFonts";

export const NAV_FONT_WEIGHTS = [
  { value: 100, label: '100 - Thin' },
  { value: 200, label: '200 - Extra Light' },
  { value: 300, label: '300 - Light' },
  { value: 400, label: '400 - Regular' },
  { value: 500, label: '500 - Medium' },
  { value: 600, label: '600 - Semibold' },
  { value: 700, label: '700 - Bold' },
  { value: 800, label: '800 - Extra Bold' },
  { value: 900, label: '900 - Black' }
];

export const NAV_AVAILABLE_FONTS = CURATED_FONTS;

export const DEFAULT_INDICATOR_GRADIENT_STOPS = [
  { color: '#5C0085', position: 0 },
  { color: '#BA0087', position: 100 }
];

// The five supported social platforms (kept in sync with `availableSocialIcons`
// in SocialIconsConfig.jsx). Each can have a custom uploaded SVG glyph that is
// recoloured to the configured header/footer social-icon colour at render time.
export const SOCIAL_ICON_PLATFORMS = [
  { key: 'linkedin', name: 'LinkedIn' },
  { key: 'twitter', name: 'Twitter/X' },
  { key: 'facebook', name: 'Facebook' },
  { key: 'instagram', name: 'Instagram' },
  { key: 'youtube', name: 'YouTube' }
];

export const HEADER_LINK_GRADIENT_STOPS = [
  { color: '#5C0085', position: 0 },
  { color: '#BA0087', position: 100 }
];

// Tone-keyed class maps for the shared branding controls. The `dark` tone is
// the original hardcoded styling used by /admin/branding (unchanged); the
// `light` tone maps every surface to theme-token classes so the same controls
// read correctly on white pages like /micrositemanagement. Dynamic inline
// styles (gradient/swatch previews) are tone-independent by design.
export const BRANDING_TONES = {
  dark: {
    card: 'bg-slate-800/50 border-slate-700',
    cardTitle: 'text-white',
    cardDesc: 'text-slate-400',
    label: 'text-slate-300',
    labelStrong: 'text-slate-200',
    hint: 'text-xs text-slate-500',
    helpText: 'text-slate-400 text-sm',
    heading: 'text-white font-medium',
    input: 'bg-slate-900 border-slate-600 text-white',
    inputSoft: 'bg-slate-900/50 border-slate-600 text-white',
    stopRow: 'bg-slate-900/50',
    track: 'bg-slate-700',
    stopValue: 'text-slate-300',
    stopMeta: 'text-slate-400',
    removeBtn: 'text-slate-400 hover:text-red-400',
    divider: 'border-slate-700',
    outlineBtn: 'border-slate-600 text-slate-300',
    previewBorder: 'border-slate-600',
    chip: 'bg-slate-700',
    chipText: 'text-white',
    chipRemove: 'text-slate-400 hover:text-red-400'
  },
  light: {
    card: '',
    cardTitle: '',
    cardDesc: '',
    label: '',
    labelStrong: '',
    hint: 'text-xs text-muted-foreground',
    helpText: 'text-muted-foreground text-sm',
    heading: 'font-medium',
    input: '',
    inputSoft: '',
    stopRow: 'bg-muted',
    track: 'bg-slate-300',
    stopValue: 'text-foreground',
    stopMeta: 'text-muted-foreground',
    removeBtn: 'text-muted-foreground hover:text-red-500',
    divider: 'border-border',
    outlineBtn: '',
    previewBorder: 'border-input',
    chip: 'bg-muted',
    chipText: 'text-foreground',
    chipRemove: 'text-muted-foreground hover:text-red-500'
  }
};

export function getBrandingTone(tone) {
  return BRANDING_TONES[tone] || BRANDING_TONES.dark;
}

export const DEFAULT_HEADER_GRADIENT_STOPS = [
  { color: '#FFFFFF', position: 0 },
  { color: '#FFFFFF', position: 30 },
  { color: '#5C0085', position: 50 },
  { color: '#BA0087', position: 65 },
  { color: '#EE00C3', position: 80 },
  { color: '#FF4229', position: 90 },
  { color: '#FFB000', position: 100 }
];

export const DEFAULT_SECONDARY_BAR_GRADIENT_STOPS = [
  { color: '#5C0085', position: 0 },
  { color: '#BA0087', position: 100 }
];

export const DEFAULT_LOGIN_BUTTON_GRADIENT_STOPS = [
  { color: '#5C0085', position: 0 },
  { color: '#BA0087', position: 100 }
];

// Reusable multi-point gradient-stop editor (color picker + position slider +
// add/remove). `onChange` receives the updated stops array.
export function GradientStopsEditor({ stops, onChange, testIdPrefix, tone = 'dark' }) {
  const t = getBrandingTone(tone);
  const [newColor, setNewColor] = useState('#000000');
  const [newPosition, setNewPosition] = useState(100);
  const list = Array.isArray(stops) && stops.length > 0 ? stops : DEFAULT_INDICATOR_GRADIENT_STOPS;
  return (
    <div className="space-y-3">
      {list.map((stop, index) => (
        <div key={index} className={`flex items-center gap-3 ${t.stopRow} rounded-lg p-3`}>
          <input
            type="color"
            value={stop.color}
            onChange={(e) => {
              const ns = [...list];
              ns[index] = { ...ns[index], color: e.target.value };
              onChange(ns);
            }}
            className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
          />
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between">
              <span className={`${t.stopValue} text-sm font-mono`}>{stop.color}</span>
              <span className={`${t.stopMeta} text-sm`}>{stop.position}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={stop.position}
              onChange={(e) => {
                const ns = [...list];
                ns[index] = { ...ns[index], position: parseInt(e.target.value) };
                onChange(ns);
              }}
              className={`w-full h-2 ${t.track} rounded-lg appearance-none cursor-pointer accent-purple-500`}
              data-testid={`slider-${testIdPrefix}-position-${index}`}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`h-8 w-8 ${t.removeBtn} flex-shrink-0`}
            onClick={() => onChange(list.filter((_, i) => i !== index))}
            data-testid={`button-remove-${testIdPrefix}-${index}`}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      ))}
      <div className={`flex items-center gap-3 pt-2 border-t ${t.divider}`}>
        <input
          type="color"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
          className="w-10 h-10 rounded cursor-pointer"
        />
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between">
            <span className={`${t.stopMeta} text-sm`}>New color position</span>
            <span className={`${t.stopMeta} text-sm`}>{newPosition}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={newPosition}
            onChange={(e) => setNewPosition(parseInt(e.target.value))}
            className={`w-full h-2 ${t.track} rounded-lg appearance-none cursor-pointer accent-purple-500`}
            data-testid={`slider-${testIdPrefix}-new-position`}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onChange([...list, { color: newColor, position: newPosition }].sort((a, b) => a.position - b.position));
            setNewColor('#000000');
          }}
          className={t.outlineBtn}
          data-testid={`button-add-${testIdPrefix}`}
        >
          <Plus className="w-4 h-4 mr-2" />
          Add
        </Button>
      </div>
    </div>
  );
}

// Multi-point stops editor that also exposes a per-stop opacity (0-100%) so the
// underlying image can show through. Used by the portal sidebar image-overlay
// and gradient backgrounds. `stops` is [{ color, opacity, position }].
export function OpacityStopsEditor({ stops, onChange, testIdPrefix, tone = 'dark' }) {
  const t = getBrandingTone(tone);
  const list = Array.isArray(stops) && stops.length > 0
    ? stops
    : [{ color: '#000000', opacity: 0.6, position: 0 }, { color: '#000000', opacity: 0, position: 100 }];
  const update = (index, patch) => {
    const ns = [...list];
    ns[index] = { ...ns[index], ...patch };
    onChange(ns);
  };
  return (
    <div className="space-y-3">
      {list.map((stop, index) => (
        <div key={index} className={`flex items-center gap-3 ${t.stopRow} rounded-lg p-3`}>
          <input
            type="color"
            value={stop.color || '#000000'}
            onChange={(e) => update(index, { color: e.target.value })}
            className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
            data-testid={`color-${testIdPrefix}-${index}`}
          />
          <div className="flex-1 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className={`${t.stopValue} text-sm font-mono`}>{stop.color}</span>
              <span className={`${t.stopMeta} text-sm`}>{stop.position}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={stop.position}
              onChange={(e) => update(index, { position: parseInt(e.target.value, 10) })}
              className={`w-full h-2 ${t.track} rounded-lg appearance-none cursor-pointer accent-purple-500`}
              data-testid={`slider-${testIdPrefix}-position-${index}`}
            />
            <div className="flex items-center justify-between gap-2">
              <span className={`${t.stopMeta} text-xs`}>Opacity</span>
              <span className={`${t.stopMeta} text-xs`}>{Math.round((stop.opacity ?? 1) * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round((stop.opacity ?? 1) * 100)}
              onChange={(e) => update(index, { opacity: parseInt(e.target.value, 10) / 100 })}
              className={`w-full h-2 ${t.track} rounded-lg appearance-none cursor-pointer accent-purple-500`}
              data-testid={`slider-${testIdPrefix}-opacity-${index}`}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`h-8 w-8 ${t.removeBtn} flex-shrink-0`}
            onClick={() => onChange(list.filter((_, i) => i !== index))}
            disabled={list.length <= 2}
            data-testid={`button-remove-${testIdPrefix}-${index}`}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...list, { color: '#000000', opacity: 0.5, position: 100 }].sort((a, b) => a.position - b.position))}
        className={t.outlineBtn}
        data-testid={`button-add-${testIdPrefix}`}
      >
        <Plus className="w-4 h-4 mr-2" />
        Add stop
      </Button>
    </div>
  );
}

// Per-bar active-item indicator controls: enable toggle, height, and an
// independent multi-point gradient. `value` is the bar's indicator config.
export function IndicatorEditor({ value, onChange, testIdPrefix, tone = 'dark' }) {
  const t = getBrandingTone(tone);
  const cfg = value || {};
  return (
    <div className={`space-y-4 pt-3 border-t ${t.divider}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label className={t.label}>Active item indicator</Label>
          <p className={t.hint}>Show a colored bar under the currently selected menu item</p>
        </div>
        <Switch
          checked={!!cfg.enabled}
          onCheckedChange={(checked) => onChange({ ...cfg, enabled: checked })}
          data-testid={`switch-${testIdPrefix}-enabled`}
        />
      </div>
      {cfg.enabled && (
        <>
          <div className="space-y-2">
            <Label className={t.label}>Indicator Height (px)</Label>
            <Input
              type="number"
              min="1"
              max="50"
              placeholder="5"
              value={cfg.height ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                onChange({ ...cfg, height: v === '' ? '' : parseInt(v, 10) });
              }}
              className={t.input}
              data-testid={`input-${testIdPrefix}-height`}
            />
            <p className={t.hint}>Height of the indicator bar. Leave blank for the default (5px).</p>
          </div>
          <div className="space-y-2">
            <Label className={t.label}>Indicator Gradient</Label>
            <GradientStopsEditor
              stops={cfg.gradientStops}
              onChange={(s) => onChange({ ...cfg, gradientStops: s })}
              testIdPrefix={`${testIdPrefix}-gradient`}
              tone={tone}
            />
          </div>
        </>
      )}
    </div>
  );
}

// Reusable control group for a header action link (Login / Member Area). Renders
// a custom-label input plus the full style control set (button-vs-link,
// background, corner radius, border, label colour, height, width). `config` is
// the link object from formData.header_config; `onChange(patch)` shallow-merges
// the patch into that object. `defaultLabel` is the placeholder/fallback shown
// when the label is blank (e.g. "Login" / "Member Area").
export function HeaderLinkControls({ config, onChange, title, description, defaultLabel, testIdPrefix, previewBackgroundStops, headerExtra, tone = 'dark' }) {
  const t = getBrandingTone(tone);
  const cfg = config || {};
  const update = (patch) => onChange(patch);
  const previewLabel = (typeof cfg.label === 'string' && cfg.label.trim()) ? cfg.label.trim() : defaultLabel;
  return (
    <Card className={t.card}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className={`${t.cardTitle} flex items-center gap-2`}>
              <User className="w-5 h-5" />
              {title}
            </CardTitle>
            <CardDescription className={t.cardDesc}>
              {description}
            </CardDescription>
          </div>
          {headerExtra || null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className={t.label}>Custom label</Label>
          <Input
            type="text"
            maxLength={60}
            placeholder={defaultLabel}
            value={cfg.label || ''}
            onChange={(e) => update({ label: e.target.value })}
            className={t.input}
            data-testid={`input-${testIdPrefix}-label`}
          />
          <p className={t.hint}>Text shown on the {defaultLabel.toLowerCase()} item. Leave blank to use the default "{defaultLabel}".</p>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label className={t.label}>Render as button</Label>
            <p className={t.hint}>Off keeps a plain text link. On shows a styled button.</p>
          </div>
          <Switch
            checked={!!cfg.asButton}
            onCheckedChange={(checked) => update({ asButton: checked })}
            data-testid={`switch-${testIdPrefix}-as-button`}
          />
        </div>

        {cfg.asButton && (
          <>
            <div className="space-y-1">
              <Label className={`${t.label} text-xs`}>Live Preview</Label>
              <div
                className={`rounded-lg border ${t.previewBorder} overflow-hidden flex items-center justify-end p-4`}
                style={{
                  background: `linear-gradient(to right, ${(previewBackgroundStops || HEADER_LINK_GRADIENT_STOPS)
                    .slice()
                    .sort((a, b) => a.position - b.position)
                    .map(stop => `${stop.color} ${stop.position}%`)
                    .join(', ')})`
                }}
                data-testid={`preview-${testIdPrefix}-button`}
              >
                <span
                  className="inline-flex items-center justify-center gap-1 px-3 py-1.5 text-sm font-semibold"
                  style={{
                    color: cfg.labelColor || '#FFFFFF',
                    background: (cfg.backgroundMode === 'gradient')
                      ? `linear-gradient(to right, ${(cfg.gradientStops || HEADER_LINK_GRADIENT_STOPS)
                          .slice()
                          .sort((a, b) => a.position - b.position)
                          .map(stop => `${stop.color} ${stop.position}%`)
                          .join(', ')})`
                      : (cfg.solidColor || '#5C0085'),
                    borderRadius: `${parseInt(cfg.cornerRadius, 10) || 0}px`,
                    borderWidth: `${parseInt(cfg.borderWidth, 10) || 0}px`,
                    borderStyle: cfg.borderStyle || 'solid',
                    borderColor: cfg.borderColor || 'transparent',
                    ...(parseInt(cfg.height, 10) > 0 ? { height: `${parseInt(cfg.height, 10)}px` } : {}),
                    ...(parseInt(cfg.width, 10) > 0 ? { width: `${parseInt(cfg.width, 10)}px` } : {}),
                    whiteSpace: 'nowrap'
                  }}
                >
                  <User className="w-4 h-4" />
                  {previewLabel}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <Label className={t.label}>Background style</Label>
              <Select
                value={cfg.backgroundMode || 'solid'}
                onValueChange={(val) => update({ backgroundMode: val })}
              >
                <SelectTrigger className={t.input} data-testid={`select-${testIdPrefix}-background-mode`}>
                  <SelectValue placeholder="Solid color" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="solid">Solid color</SelectItem>
                  <SelectItem value="gradient">Multi-stop gradient</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(cfg.backgroundMode || 'solid') === 'solid' ? (
              <div className="space-y-2">
                <Label className={t.label}>Background Color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={cfg.solidColor || '#5C0085'}
                    onChange={(e) => update({ solidColor: e.target.value })}
                    className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                    data-testid={`input-${testIdPrefix}-solid-color`}
                  />
                  <Input
                    type="text"
                    placeholder="#5C0085"
                    value={cfg.solidColor || ''}
                    onChange={(e) => update({ solidColor: e.target.value })}
                    className={`${t.input} font-mono`}
                    data-testid={`input-${testIdPrefix}-solid-color-hex`}
                  />
                </div>
                <p className={t.hint}>Solid background color for the button.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label className={t.label}>Background Gradient</Label>
                <GradientStopsEditor
                  stops={cfg.gradientStops || HEADER_LINK_GRADIENT_STOPS}
                  onChange={(s) => update({ gradientStops: s })}
                  testIdPrefix={`${testIdPrefix}-gradient`}
                  tone={tone}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className={t.label}>Corner Radius (px)</Label>
                <Input
                  type="number"
                  min="0"
                  max="50"
                  placeholder="0"
                  value={cfg.cornerRadius ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    update({ cornerRadius: val === '' ? '' : parseInt(val, 10) });
                  }}
                  className={t.input}
                  data-testid={`input-${testIdPrefix}-corner-radius`}
                />
                <p className={t.hint}>Roundness of the button corners. Leave blank for square (0px).</p>
              </div>
              <div className="space-y-2">
                <Label className={t.label}>Border Width (px)</Label>
                <Input
                  type="number"
                  min="0"
                  max="10"
                  placeholder="0"
                  value={cfg.borderWidth ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    update({ borderWidth: val === '' ? '' : parseInt(val, 10) });
                  }}
                  className={t.input}
                  data-testid={`input-${testIdPrefix}-border-width`}
                />
                <p className={t.hint}>Thickness of the border. Leave blank for no border.</p>
              </div>
              <div className="space-y-2">
                <Label className={t.label}>Border Color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={cfg.borderColor || '#FFFFFF'}
                    onChange={(e) => update({ borderColor: e.target.value })}
                    className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                    data-testid={`input-${testIdPrefix}-border-color`}
                  />
                  <Input
                    type="text"
                    placeholder="No border color"
                    value={cfg.borderColor || ''}
                    onChange={(e) => update({ borderColor: e.target.value })}
                    className={`${t.input} font-mono`}
                    data-testid={`input-${testIdPrefix}-border-color-hex`}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label className={t.label}>Border Style</Label>
                <Select
                  value={cfg.borderStyle || 'solid'}
                  onValueChange={(val) => update({ borderStyle: val })}
                >
                  <SelectTrigger className={t.input} data-testid={`select-${testIdPrefix}-border-style`}>
                    <SelectValue placeholder="Solid" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="solid">Solid</SelectItem>
                    <SelectItem value="dashed">Dashed</SelectItem>
                    <SelectItem value="dotted">Dotted</SelectItem>
                    <SelectItem value="none">None</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label className={t.label}>Label Color</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={cfg.labelColor || '#FFFFFF'}
                  onChange={(e) => update({ labelColor: e.target.value })}
                  className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                  data-testid={`input-${testIdPrefix}-label-color`}
                />
                <Input
                  type="text"
                  placeholder="Inherit nav text color"
                  value={cfg.labelColor || ''}
                  onChange={(e) => update({ labelColor: e.target.value })}
                  className={`${t.input} font-mono`}
                  data-testid={`input-${testIdPrefix}-label-color-hex`}
                />
              </div>
              <p className={t.hint}>Color of the button label text. Leave blank to inherit the top-nav text color.</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className={t.label}>Height (px)</Label>
                <Input
                  type="number"
                  min="0"
                  max="200"
                  placeholder="Auto"
                  value={cfg.height ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    update({ height: val === '' ? '' : parseInt(val, 10) });
                  }}
                  className={t.input}
                  data-testid={`input-${testIdPrefix}-height`}
                />
                <p className={t.hint}>Button height. Leave blank to size to content.</p>
              </div>
              <div className="space-y-2">
                <Label className={t.label}>Width (px)</Label>
                <Input
                  type="number"
                  min="0"
                  max="400"
                  placeholder="Auto"
                  value={cfg.width ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    update({ width: val === '' ? '' : parseInt(val, 10) });
                  }}
                  className={t.input}
                  data-testid={`input-${testIdPrefix}-width`}
                />
                <p className={t.hint}>Button width. Leave blank to size to content.</p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Legacy header-gradient hydration: older tenants/microsites stored
// header_config.gradientColors (a plain color array) instead of gradientStops.
// Mirrors the conversion used by /admin/branding so both surfaces hydrate
// legacy JSON identically.
export function convertLegacyHeaderGradientColors(colors, fallback = DEFAULT_HEADER_GRADIENT_STOPS) {
  if (!colors || colors.length === 0) return fallback;
  if (colors.length === 1) {
    return [
      { color: '#FFFFFF', position: 0 },
      { color: '#FFFFFF', position: 30 },
      { color: colors[0], position: 100 }
    ];
  }
  const colorStops = colors.map((color, index) => ({
    color,
    position: Math.round((index / (colors.length - 1)) * 70) + 30
  }));
  return [
    { color: '#FFFFFF', position: 0 },
    { color: '#FFFFFF', position: 30 },
    ...colorStops
  ];
}

export function getHeaderGradientStops(headerConfig, fallback = DEFAULT_HEADER_GRADIENT_STOPS) {
  if (headerConfig?.gradientStops && headerConfig.gradientStops.length > 0) {
    return headerConfig.gradientStops;
  }
  if (headerConfig?.gradientColors && headerConfig.gradientColors.length > 0) {
    return convertLegacyHeaderGradientColors(headerConfig.gradientColors, fallback);
  }
  return fallback;
}

// Hydrate a stored secondaryBar object into the full editable shape used by
// the controls below (same shape /admin/branding builds in its formData).
export function hydrateSecondaryBarConfig(sb) {
  const s = sb || {};
  return {
    enabled: !!s.enabled,
    height: s.height ?? '',
    gradientStops: (Array.isArray(s.gradientStops) && s.gradientStops.length > 0)
      ? s.gradientStops
      : DEFAULT_SECONDARY_BAR_GRADIENT_STOPS,
    textColor: s.textColor || '',
    hoverColor: s.hoverColor || '',
    fontSize: s.fontSize ?? '',
    fontWeight: s.fontWeight ?? '',
    fontFamily: s.fontFamily || '',
    // Bottom border is opt-in: '' means "unset" (keep today's default look);
    // an explicit true/false governs the rendered border in both states.
    bottomBorderEnabled: (s.bottomBorderEnabled === true || s.bottomBorderEnabled === false)
      ? s.bottomBorderEnabled
      : '',
    bottomBorderColor: s.bottomBorderColor || '',
    bottomBorderWidth: s.bottomBorderWidth ?? '',
    labelMaxWidth: s.labelMaxWidth ?? '',
    indicator: {
      enabled: s.indicator ? !!s.indicator.enabled : true,
      height: s.indicator?.height ?? '',
      gradientStops: (s.indicator?.gradientStops && s.indicator.gradientStops.length > 0)
        ? s.indicator.gradientStops
        : DEFAULT_INDICATOR_GRADIENT_STOPS
    }
  };
}

// Hydrate a stored footer_config into the full editable shape used by
// FooterControls (same shape /admin/branding builds in its formData).
export function hydrateFooterConfig(fc, { withDefaults = true } = {}) {
  const f = fc || {};
  return {
    columns: f.columns || (withDefaults ? 4 : ''),
    columnAlignments: f.columnAlignments || {},
    ctaText: f.ctaText || (withDefaults ? 'Become a member today' : ''),
    ctaButtonText: f.ctaButtonText || (withDefaults ? 'Join Us' : ''),
    ctaLink: f.ctaLink || (withDefaults ? 'Membership' : ''),
    newsletterText: f.newsletterText || (withDefaults ? 'Sign up to our newsletter' : ''),
    gradientColors: f.gradientColors || (withDefaults ? ['#5C0085', '#BA0087', '#EE00C3', '#FF4229', '#FFB000'] : []),
    backgroundColor: f.backgroundColor || (withDefaults ? '#000000' : ''),
    textColor: f.textColor || (withDefaults ? '#FFFFFF' : ''),
    address: {
      name: f.address?.name || '',
      lines: f.address?.lines || []
    },
    contact: {
      phone: f.contact?.phone || '',
      email: f.contact?.email || ''
    },
    legalText: f.legalText || '',
    termsAndConditionsUrl: f.termsAndConditionsUrl || '',
    privacyPolicyUrl: f.privacyPolicyUrl || ''
  };
}

// Full Secondary Lower Navigation Bar control set (enable, height, live
// preview, background gradient, text color/size/hover/weight/family and the
// active-item indicator) — the same options as /admin/branding, shared so the
// microsite editor exposes an identical card. `value` is the secondaryBar
// object; `onChange` receives the updated object.
export function SecondaryBarControls({
  value,
  onChange,
  headerLogoUrl,
  siteName,
  primaryColor,
  secondaryColor,
  mainNavItems,
  testIdPrefix = 'secondary-bar',
  headerExtra,
  title = 'Secondary Lower Navigation Bar',
  description = 'Add an optional second bar below the top navigation bar with its own height and gradient background',
  tone = 'dark'
}) {
  const t = getBrandingTone(tone);
  const { options: fontOptions } = useInstalledFonts();
  const sb = value || {};
  const set = (patch) => onChange({ ...sb, ...patch });
  // Bottom border: '' = unset (keep today's default), true/false = explicit.
  // When unset, the effective state mirrors today's look: no line while the
  // gradient bar is enabled, a line on the plain white fallback bar.
  const borderExplicit = sb.bottomBorderEnabled === true || sb.bottomBorderEnabled === false;
  const borderEnabledEffective = borderExplicit ? sb.bottomBorderEnabled : !sb.enabled;
  const previewBorderWidth = parseInt(sb.bottomBorderWidth, 10) > 0 ? parseInt(sb.bottomBorderWidth, 10) : 1;
  const previewBottomBorder = borderEnabledEffective
    ? `${previewBorderWidth}px solid ${sb.bottomBorderColor || '#E2E8F0'}`
    : null;
  const navLabels = (mainNavItems && mainNavItems.length > 0)
    ? mainNavItems
    : ['Membership', 'Resources', 'News', 'Get Involved'];
  const hoverClass = `sb-preview-link-${testIdPrefix}`;
  return (
    <Card className={t.card}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className={`${t.cardTitle} flex items-center gap-2`}>
              <Palette className="w-5 h-5" />
              {title}
            </CardTitle>
            <CardDescription className={t.cardDesc}>{description}</CardDescription>
          </div>
          {headerExtra || null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {sb.hoverColor ? (
          <style>{`.${hoverClass}:hover { color: ${sb.hoverColor} !important; }`}</style>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label className={t.label}>Enable secondary bar</Label>
            <p className={t.hint}>Renders a second bar directly beneath the top navigation bar</p>
          </div>
          <Switch
            checked={!!sb.enabled}
            onCheckedChange={(checked) => set({ enabled: checked })}
            data-testid={`switch-${testIdPrefix}-enabled`}
          />
        </div>

        {sb.enabled && (
          <>
            <div className="space-y-2">
              <Label className={t.label}>Secondary Bar Height (px)</Label>
              <Input
                type="number"
                min="20"
                max="300"
                placeholder="48"
                value={sb.height ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  set({ height: val === '' ? '' : parseInt(val, 10) });
                }}
                className={t.input}
                data-testid={`input-${testIdPrefix}-height`}
              />
            </div>

            <div className="space-y-2">
              <Label className={t.label}>Label max width (px)</Label>
              <Input
                type="number"
                min="0"
                max="600"
                placeholder="No cap (single line)"
                value={sb.labelMaxWidth ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  set({ labelMaxWidth: val === '' ? '' : parseInt(val, 10) });
                }}
                className={t.input}
                data-testid={`input-${testIdPrefix}-label-max-width`}
              />
              <p className={t.hint}>Cap each menu label's width so long labels wrap onto multiple lines. Leave blank for single-line labels.</p>
            </div>

            <div className="space-y-1">
              <Label className={`${t.label} text-xs`}>Live Preview</Label>
              <div
                className={`rounded-lg border ${t.previewBorder} overflow-hidden flex`}
                style={{
                  minHeight: `${Math.min(Math.max(parseInt(sb.height, 10) || 48, 24), 120)}px`,
                  background: `linear-gradient(to right, ${(sb.gradientStops || DEFAULT_SECONDARY_BAR_GRADIENT_STOPS)
                    .slice()
                    .sort((a, b) => a.position - b.position)
                    .map(stop => `${stop.color} ${stop.position}%`)
                    .join(', ')})`,
                  ...(previewBottomBorder ? { borderBottom: previewBottomBorder } : {})
                }}
                data-testid={`preview-${testIdPrefix}`}
              >
                <div className="flex flex-1 items-center justify-between gap-6 px-4">
                  <div className="flex items-center flex-shrink-0">
                    {headerLogoUrl ? (
                      <img
                        src={headerLogoUrl}
                        alt={siteName || 'Logo'}
                        className="object-contain"
                        style={{ height: '32px', width: 'auto', maxWidth: '160px' }}
                      />
                    ) : (
                      <span
                        className="font-bold"
                        style={{
                          color: sb.textColor || '#FFFFFF',
                          fontSize: '18px',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {siteName || 'Your Logo'}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-8 h-full">
                    {navLabels.map((label, idx) => {
                      const previewMaxWidth = parseInt(sb.labelMaxWidth, 10);
                      const previewWrap = (Number.isFinite(previewMaxWidth) && previewMaxWidth > 0)
                        ? {
                            maxWidth: `${previewMaxWidth}px`,
                            whiteSpace: 'normal',
                            overflowWrap: 'break-word',
                            wordBreak: 'break-word',
                            textAlign: 'center',
                            lineHeight: 1.2
                          }
                        : { whiteSpace: 'nowrap' };
                      return (
                      <div key={label} className="relative h-full flex items-center">
                        <span
                          className={hoverClass}
                          style={{
                            color: sb.textColor || '#FFFFFF',
                            fontSize: `${parseInt(sb.fontSize, 10) || 16}px`,
                            fontWeight: sb.fontWeight || (idx === 0 ? 700 : 500),
                            fontFamily: sb.fontFamily || 'Poppins, sans-serif',
                            ...previewWrap
                          }}
                        >
                          {label}
                        </span>
                        {idx === 0 && (sb.indicator ? sb.indicator.enabled : true) && (
                          <div
                            className="absolute left-0 right-0"
                            style={{
                              bottom: 0,
                              height: `${parseInt(sb.indicator?.height, 10) || 5}px`,
                              background: (sb.indicator?.gradientStops && sb.indicator.gradientStops.length > 0)
                                ? `linear-gradient(to right, ${sb.indicator.gradientStops
                                    .slice()
                                    .sort((a, b) => a.position - b.position)
                                    .map(stop => `${stop.color} ${stop.position}%`)
                                    .join(', ')})`
                                : `linear-gradient(to right, ${primaryColor || '#5C0085'}, ${secondaryColor || '#BA0087'})`
                            }}
                          />
                        )}
                      </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label className={t.label}>Bar Background Gradient</Label>
              <GradientStopsEditor
                stops={sb.gradientStops || DEFAULT_SECONDARY_BAR_GRADIENT_STOPS}
                onChange={(s) => set({ gradientStops: s })}
                testIdPrefix={`${testIdPrefix}-gradient`}
                tone={tone}
              />
              <p className={t.hint}>Adjust sliders to control where each color appears in the gradient (0% = left, 100% = right).</p>
            </div>

            <div className={`grid grid-cols-2 gap-4 pt-2 border-t ${t.divider}`}>
              <div className="space-y-2">
                <Label className={t.label}>Link Text Color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={sb.textColor || '#FFFFFF'}
                    onChange={(e) => set({ textColor: e.target.value })}
                    className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                    data-testid={`input-${testIdPrefix}-text-color`}
                  />
                  <Input
                    type="text"
                    placeholder="#FFFFFF"
                    value={sb.textColor || ''}
                    onChange={(e) => set({ textColor: e.target.value })}
                    className={`${t.input} font-mono`}
                    data-testid={`input-${testIdPrefix}-text-color-hex`}
                  />
                </div>
                <p className={t.hint}>Color of the main menu link text in this bar. Defaults to white.</p>
              </div>
              <div className="space-y-2">
                <Label className={t.label}>Link Font Size (px)</Label>
                <Input
                  type="number"
                  min="8"
                  max="48"
                  placeholder="16"
                  value={sb.fontSize ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    set({ fontSize: val === '' ? '' : parseInt(val, 10) });
                  }}
                  className={t.input}
                  data-testid={`input-${testIdPrefix}-font-size`}
                />
                <p className={t.hint}>Size of the main menu link text. Leave blank for default.</p>
              </div>
              <div className="space-y-2">
                <Label className={t.label}>Link Hover Color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={sb.hoverColor || '#FFFFFF'}
                    onChange={(e) => set({ hoverColor: e.target.value })}
                    className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                    data-testid={`input-${testIdPrefix}-hover-color`}
                  />
                  <Input
                    type="text"
                    placeholder="No hover change"
                    value={sb.hoverColor || ''}
                    onChange={(e) => set({ hoverColor: e.target.value })}
                    className={`${t.input} font-mono`}
                    data-testid={`input-${testIdPrefix}-hover-color-hex`}
                  />
                </div>
                <p className={t.hint}>Color links change to on hover. Leave blank to keep current behavior.</p>
              </div>
              <div className="space-y-2">
                <Label className={t.label}>Link Font Weight</Label>
                <Select
                  value={sb.fontWeight ? String(sb.fontWeight) : 'default'}
                  onValueChange={(val) => set({ fontWeight: val === 'default' ? '' : parseInt(val, 10) })}
                >
                  <SelectTrigger className={t.input} data-testid={`select-${testIdPrefix}-font-weight`}>
                    <SelectValue placeholder="Default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    {NAV_FONT_WEIGHTS.map((w) => (
                      <SelectItem key={w.value} value={String(w.value)}>{w.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className={t.hint}>Weight of the main menu link text. Leave at default to keep current styling.</p>
              </div>
              <div className="space-y-2">
                <Label className={t.label}>Base Font Family</Label>
                <Select
                  value={sb.fontFamily || 'default'}
                  onValueChange={(val) => set({ fontFamily: val === 'default' ? '' : val })}
                >
                  <SelectTrigger className={t.input} data-testid={`select-${testIdPrefix}-font-family`}>
                    <SelectValue placeholder="Poppins" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Poppins (default)</SelectItem>
                    {fontOptions.map((f) => (
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className={t.hint}>Font family for the main menu links. Defaults to Poppins.</p>
              </div>
            </div>

            <IndicatorEditor
              value={sb.indicator}
              onChange={(ind) => set({ indicator: ind })}
              testIdPrefix={`${testIdPrefix}-indicator`}
              tone={tone}
            />
          </>
        )}

        <div className={`space-y-3 pt-2 border-t ${t.divider}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label className={t.label}>Bottom Border</Label>
              <p className={t.hint}>Show a line beneath this bar. Leave untouched to keep the current default look.</p>
            </div>
            <Switch
              checked={borderEnabledEffective}
              onCheckedChange={(checked) => set({ bottomBorderEnabled: checked })}
              data-testid={`switch-${testIdPrefix}-bottom-border`}
            />
          </div>

          {borderEnabledEffective && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className={t.label}>Border Color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={sb.bottomBorderColor || '#E2E8F0'}
                    onChange={(e) => set({ bottomBorderColor: e.target.value })}
                    className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                    data-testid={`input-${testIdPrefix}-bottom-border-color`}
                  />
                  <Input
                    type="text"
                    placeholder="#E2E8F0"
                    value={sb.bottomBorderColor || ''}
                    onChange={(e) => set({ bottomBorderColor: e.target.value })}
                    className={`${t.input} font-mono`}
                    data-testid={`input-${testIdPrefix}-bottom-border-color-hex`}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label className={t.label}>Border Thickness (px)</Label>
                <Input
                  type="number"
                  min="0"
                  max="20"
                  placeholder="1"
                  value={sb.bottomBorderWidth ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    set({ bottomBorderWidth: val === '' ? '' : parseInt(val, 10) });
                  }}
                  className={t.input}
                  data-testid={`input-${testIdPrefix}-bottom-border-width`}
                />
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Full Footer Configuration control set (columns, newsletter heading, gradient
// colors, background/text colors, address, contact, legal text and policy
// URLs) — the same options as /admin/branding, shared so the microsite editor
// exposes an identical card. `value` is the footer_config object; `onChange`
// receives the updated object.
export function FooterControls({
  value,
  onChange,
  testIdPrefix = 'footer',
  headerExtra,
  title = 'Footer Configuration',
  description = 'Customize the public website footer content',
  tone = 'dark'
}) {
  const t = getBrandingTone(tone);
  const fc = value || {};
  const set = (patch) => onChange({ ...fc, ...patch });
  const [newGradientColor, setNewGradientColor] = useState('#5C0085');
  const [newAddressLine, setNewAddressLine] = useState('');

  const addAddressLine = () => {
    if (!newAddressLine.trim()) return;
    set({ address: { ...(fc.address || {}), lines: [...(fc.address?.lines || []), newAddressLine.trim()] } });
    setNewAddressLine('');
  };

  return (
    <Card className={t.card}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className={`${t.cardTitle} flex items-center gap-2`}>
              <Palette className="w-5 h-5" />
              {title}
            </CardTitle>
            <CardDescription className={t.cardDesc}>{description}</CardDescription>
          </div>
          {headerExtra || null}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label className={t.labelStrong}>Number of Footer Columns</Label>
          <p className={`${t.stopMeta} text-sm`}>How many navigation columns to display in the footer (configured in Portal Navigation Management)</p>
          <Select
            value={String(fc.columns || 4)}
            onValueChange={(value) => set({ columns: parseInt(value, 10) })}
          >
            <SelectTrigger className={`${t.inputSoft} w-32`} data-testid={`select-${testIdPrefix}-columns`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 Column</SelectItem>
              <SelectItem value="2">2 Columns</SelectItem>
              <SelectItem value="3">3 Columns</SelectItem>
              <SelectItem value="4">4 Columns</SelectItem>
              <SelectItem value="5">5 Columns</SelectItem>
              <SelectItem value="6">6 Columns</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className={t.labelStrong}>Newsletter Heading</Label>
          <Input
            value={fc.newsletterText || ''}
            onChange={(e) => set({ newsletterText: e.target.value })}
            className={t.inputSoft}
            placeholder="Sign up to our newsletter"
            data-testid={`input-${testIdPrefix}-newsletter-text`}
          />
        </div>

        <div className="space-y-3">
          <Label className={t.labelStrong}>Gradient Colors</Label>
          <p className={`${t.stopMeta} text-sm`}>Colors used in the footer gradient bar and buttons</p>
          <div className="flex flex-wrap gap-2 mb-2">
            {(fc.gradientColors || []).map((color, index) => (
              <div key={index} className={`flex items-center gap-1 ${t.chip} rounded px-2 py-1`}>
                <input
                  type="color"
                  value={color}
                  onChange={(e) => set({ gradientColors: (fc.gradientColors || []).map((c, i) => i === index ? e.target.value : c) })}
                  className="w-6 h-6 rounded cursor-pointer"
                />
                <span className={`${t.chipText} text-sm`}>{color}</span>
                <button
                  type="button"
                  onClick={() => set({ gradientColors: (fc.gradientColors || []).filter((_, i) => i !== index) })}
                  className={`${t.chipRemove} ml-1`}
                  data-testid={`button-remove-${testIdPrefix}-gradient-${index}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={newGradientColor}
              onChange={(e) => setNewGradientColor(e.target.value)}
              className="w-10 h-8 rounded cursor-pointer"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => set({ gradientColors: [...(fc.gradientColors || []), newGradientColor] })}
              className={t.outlineBtn}
              data-testid={`button-add-${testIdPrefix}-gradient-color`}
            >
              <Plus className="w-4 h-4 mr-1" />
              Add Color
            </Button>
          </div>
          {(fc.gradientColors || []).length > 0 && (
            <div
              className="h-4 rounded mt-2"
              style={{ background: `linear-gradient(to right, ${fc.gradientColors.join(', ')})` }}
            />
          )}
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label className={t.labelStrong}>Background Color</Label>
            <p className={`${t.stopMeta} text-sm`}>The background color for the footer section</p>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={fc.backgroundColor || '#000000'}
                onChange={(e) => set({ backgroundColor: e.target.value })}
                className="w-12 h-10 rounded cursor-pointer"
                data-testid={`input-${testIdPrefix}-background-color`}
              />
              <Input
                value={fc.backgroundColor || ''}
                onChange={(e) => set({ backgroundColor: e.target.value })}
                className={`${t.inputSoft} flex-1`}
                placeholder="#000000"
                data-testid={`input-${testIdPrefix}-background-color-text`}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label className={t.labelStrong}>Text Color</Label>
            <p className={`${t.stopMeta} text-sm`}>The text color for footer content</p>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={fc.textColor || '#FFFFFF'}
                onChange={(e) => set({ textColor: e.target.value })}
                className="w-12 h-10 rounded cursor-pointer"
                data-testid={`input-${testIdPrefix}-text-color`}
              />
              <Input
                value={fc.textColor || ''}
                onChange={(e) => set({ textColor: e.target.value })}
                className={`${t.inputSoft} flex-1`}
                placeholder="#FFFFFF"
                data-testid={`input-${testIdPrefix}-text-color-text`}
              />
            </div>
          </div>
        </div>

        <div className={`border-t ${t.divider} pt-4 space-y-4`}>
          <h4 className={t.heading}>Address</h4>
          <div className="space-y-2">
            <Label className={t.labelStrong}>Organization Name</Label>
            <Input
              value={fc.address?.name || ''}
              onChange={(e) => set({ address: { ...(fc.address || {}), name: e.target.value } })}
              className={t.inputSoft}
              placeholder="Your Organization Name"
              data-testid={`input-${testIdPrefix}-address-name`}
            />
          </div>
          <div className="space-y-2">
            <Label className={t.labelStrong}>Address Lines</Label>
            <div className="space-y-2">
              {(fc.address?.lines || []).map((line, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={line}
                    disabled
                    className={`${t.inputSoft} flex-1`}
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    onClick={() => set({ address: { ...(fc.address || {}), lines: (fc.address?.lines || []).filter((_, i) => i !== index) } })}
                    data-testid={`button-remove-${testIdPrefix}-address-line-${index}`}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Input
                  value={newAddressLine}
                  onChange={(e) => setNewAddressLine(e.target.value)}
                  className={`${t.inputSoft} flex-1`}
                  placeholder="Add address line..."
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAddressLine())}
                  data-testid={`input-${testIdPrefix}-new-address-line`}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={addAddressLine}
                  className={t.outlineBtn}
                  data-testid={`button-add-${testIdPrefix}-address-line`}
                >
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className={`border-t ${t.divider} pt-4 space-y-4`}>
          <h4 className={t.heading}>Contact Information</h4>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className={t.labelStrong}>Phone Number</Label>
              <Input
                value={fc.contact?.phone || ''}
                onChange={(e) => set({ contact: { ...(fc.contact || {}), phone: e.target.value } })}
                className={t.inputSoft}
                placeholder="+44 (0)114 251 5750"
                data-testid={`input-${testIdPrefix}-phone`}
              />
            </div>
            <div className="space-y-2">
              <Label className={t.labelStrong}>Email Address</Label>
              <Input
                value={fc.contact?.email || ''}
                onChange={(e) => set({ contact: { ...(fc.contact || {}), email: e.target.value } })}
                className={t.inputSoft}
                placeholder="hello@example.org"
                data-testid={`input-${testIdPrefix}-email`}
              />
            </div>
          </div>
        </div>

        <div className={`border-t ${t.divider} pt-4 space-y-4`}>
          <h4 className={t.heading}>Legal</h4>
          <div className="space-y-2">
            <Label className={t.labelStrong}>Legal / Charity Text</Label>
            <Textarea
              value={fc.legalText || ''}
              onChange={(e) => set({ legalText: e.target.value })}
              className={`${t.inputSoft} min-h-[80px]`}
              placeholder="Registered charity number, company registration info, etc."
              data-testid={`input-${testIdPrefix}-legal-text`}
            />
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className={t.labelStrong}>Terms & Conditions URL</Label>
              <Input
                value={fc.termsAndConditionsUrl || ''}
                onChange={(e) => set({ termsAndConditionsUrl: e.target.value })}
                className={t.inputSoft}
                placeholder="https://..."
                data-testid={`input-${testIdPrefix}-terms-url`}
              />
            </div>
            <div className="space-y-2">
              <Label className={t.labelStrong}>Privacy Policy URL</Label>
              <Input
                value={fc.privacyPolicyUrl || ''}
                onChange={(e) => set({ privacyPolicyUrl: e.target.value })}
                className={t.inputSoft}
                placeholder="https://..."
                data-testid={`input-${testIdPrefix}-privacy-url`}
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
