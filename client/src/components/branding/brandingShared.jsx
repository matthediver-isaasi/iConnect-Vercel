import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Plus, X, User } from "lucide-react";
import { CURATED_FONTS } from "@/lib/sharedFonts";

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
export function GradientStopsEditor({ stops, onChange, testIdPrefix }) {
  const [newColor, setNewColor] = useState('#000000');
  const [newPosition, setNewPosition] = useState(100);
  const list = Array.isArray(stops) && stops.length > 0 ? stops : DEFAULT_INDICATOR_GRADIENT_STOPS;
  return (
    <div className="space-y-3">
      {list.map((stop, index) => (
        <div key={index} className="flex items-center gap-3 bg-slate-900/50 rounded-lg p-3">
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
              <span className="text-slate-300 text-sm font-mono">{stop.color}</span>
              <span className="text-slate-400 text-sm">{stop.position}%</span>
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
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              data-testid={`slider-${testIdPrefix}-position-${index}`}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-400 hover:text-red-400 flex-shrink-0"
            onClick={() => onChange(list.filter((_, i) => i !== index))}
            data-testid={`button-remove-${testIdPrefix}-${index}`}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-3 pt-2 border-t border-slate-700">
        <input
          type="color"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
          className="w-10 h-10 rounded cursor-pointer"
        />
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-slate-400 text-sm">New color position</span>
            <span className="text-slate-400 text-sm">{newPosition}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={newPosition}
            onChange={(e) => setNewPosition(parseInt(e.target.value))}
            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
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
          className="border-slate-600 text-slate-300"
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
export function OpacityStopsEditor({ stops, onChange, testIdPrefix }) {
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
        <div key={index} className="flex items-center gap-3 bg-slate-900/50 rounded-lg p-3">
          <input
            type="color"
            value={stop.color || '#000000'}
            onChange={(e) => update(index, { color: e.target.value })}
            className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
            data-testid={`color-${testIdPrefix}-${index}`}
          />
          <div className="flex-1 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-300 text-sm font-mono">{stop.color}</span>
              <span className="text-slate-400 text-sm">{stop.position}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={stop.position}
              onChange={(e) => update(index, { position: parseInt(e.target.value, 10) })}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              data-testid={`slider-${testIdPrefix}-position-${index}`}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400 text-xs">Opacity</span>
              <span className="text-slate-400 text-xs">{Math.round((stop.opacity ?? 1) * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round((stop.opacity ?? 1) * 100)}
              onChange={(e) => update(index, { opacity: parseInt(e.target.value, 10) / 100 })}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              data-testid={`slider-${testIdPrefix}-opacity-${index}`}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-400 hover:text-red-400 flex-shrink-0"
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
        className="border-slate-600 text-slate-300"
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
export function IndicatorEditor({ value, onChange, testIdPrefix }) {
  const cfg = value || {};
  return (
    <div className="space-y-4 pt-3 border-t border-slate-700">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="text-slate-300">Active item indicator</Label>
          <p className="text-xs text-slate-500">Show a colored bar under the currently selected menu item</p>
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
            <Label className="text-slate-300">Indicator Height (px)</Label>
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
              className="bg-slate-900 border-slate-600 text-white"
              data-testid={`input-${testIdPrefix}-height`}
            />
            <p className="text-xs text-slate-500">Height of the indicator bar. Leave blank for the default (5px).</p>
          </div>
          <div className="space-y-2">
            <Label className="text-slate-300">Indicator Gradient</Label>
            <GradientStopsEditor
              stops={cfg.gradientStops}
              onChange={(s) => onChange({ ...cfg, gradientStops: s })}
              testIdPrefix={`${testIdPrefix}-gradient`}
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
export function HeaderLinkControls({ config, onChange, title, description, defaultLabel, testIdPrefix, previewBackgroundStops, headerExtra }) {
  const cfg = config || {};
  const update = (patch) => onChange(patch);
  const previewLabel = (typeof cfg.label === 'string' && cfg.label.trim()) ? cfg.label.trim() : defaultLabel;
  return (
    <Card className="bg-slate-800/50 border-slate-700">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="text-white flex items-center gap-2">
              <User className="w-5 h-5" />
              {title}
            </CardTitle>
            <CardDescription className="text-slate-400">
              {description}
            </CardDescription>
          </div>
          {headerExtra || null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-slate-300">Custom label</Label>
          <Input
            type="text"
            maxLength={60}
            placeholder={defaultLabel}
            value={cfg.label || ''}
            onChange={(e) => update({ label: e.target.value })}
            className="bg-slate-900 border-slate-600 text-white"
            data-testid={`input-${testIdPrefix}-label`}
          />
          <p className="text-xs text-slate-500">Text shown on the {defaultLabel.toLowerCase()} item. Leave blank to use the default "{defaultLabel}".</p>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label className="text-slate-300">Render as button</Label>
            <p className="text-xs text-slate-500">Off keeps a plain text link. On shows a styled button.</p>
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
              <Label className="text-slate-300 text-xs">Live Preview</Label>
              <div
                className="rounded-lg border border-slate-600 overflow-hidden flex items-center justify-end p-4"
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
              <Label className="text-slate-300">Background style</Label>
              <Select
                value={cfg.backgroundMode || 'solid'}
                onValueChange={(val) => update({ backgroundMode: val })}
              >
                <SelectTrigger className="bg-slate-900 border-slate-600 text-white" data-testid={`select-${testIdPrefix}-background-mode`}>
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
                <Label className="text-slate-300">Background Color</Label>
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
                    className="bg-slate-900 border-slate-600 text-white font-mono"
                    data-testid={`input-${testIdPrefix}-solid-color-hex`}
                  />
                </div>
                <p className="text-xs text-slate-500">Solid background color for the button.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label className="text-slate-300">Background Gradient</Label>
                <GradientStopsEditor
                  stops={cfg.gradientStops || HEADER_LINK_GRADIENT_STOPS}
                  onChange={(s) => update({ gradientStops: s })}
                  testIdPrefix={`${testIdPrefix}-gradient`}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-slate-300">Corner Radius (px)</Label>
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
                  className="bg-slate-900 border-slate-600 text-white"
                  data-testid={`input-${testIdPrefix}-corner-radius`}
                />
                <p className="text-xs text-slate-500">Roundness of the button corners. Leave blank for square (0px).</p>
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Border Width (px)</Label>
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
                  className="bg-slate-900 border-slate-600 text-white"
                  data-testid={`input-${testIdPrefix}-border-width`}
                />
                <p className="text-xs text-slate-500">Thickness of the border. Leave blank for no border.</p>
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Border Color</Label>
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
                    className="bg-slate-900 border-slate-600 text-white font-mono"
                    data-testid={`input-${testIdPrefix}-border-color-hex`}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Border Style</Label>
                <Select
                  value={cfg.borderStyle || 'solid'}
                  onValueChange={(val) => update({ borderStyle: val })}
                >
                  <SelectTrigger className="bg-slate-900 border-slate-600 text-white" data-testid={`select-${testIdPrefix}-border-style`}>
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
              <Label className="text-slate-300">Label Color</Label>
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
                  className="bg-slate-900 border-slate-600 text-white font-mono"
                  data-testid={`input-${testIdPrefix}-label-color-hex`}
                />
              </div>
              <p className="text-xs text-slate-500">Color of the button label text. Leave blank to inherit the top-nav text color.</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-slate-300">Height (px)</Label>
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
                  className="bg-slate-900 border-slate-600 text-white"
                  data-testid={`input-${testIdPrefix}-height`}
                />
                <p className="text-xs text-slate-500">Button height. Leave blank to size to content.</p>
              </div>
              <div className="space-y-2">
                <Label className="text-slate-300">Width (px)</Label>
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
                  className="bg-slate-900 border-slate-600 text-white"
                  data-testid={`input-${testIdPrefix}-width`}
                />
                <p className="text-xs text-slate-500">Button width. Leave blank to size to content.</p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
