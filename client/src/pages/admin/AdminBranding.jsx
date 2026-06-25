import { useState, useEffect, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  ArrowLeft, 
  Loader2,
  Save,
  Upload,
  Image,
  Trash2,
  Palette,
  Type,
  LayoutTemplate,
  Plus,
  X,
  Shield,
  User,
  Search
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { useResolvedSocialIcons } from "@/hooks/useResolvedSocialIcons";
import UnfurlPreview from "@/components/UnfurlPreview";
import { publicClient } from "@/api/publicClient";
import { FocalPointPicker } from "@/components/FocalPointPicker";
import { buildPortalNavBackgroundStyle } from "@/lib/canvasBackground";

const NAV_FONT_WEIGHTS = [
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

const NAV_AVAILABLE_FONTS = [
  { value: 'Poppins, sans-serif', label: 'Poppins' },
  { value: 'Urbanist, sans-serif', label: 'Urbanist' },
  { value: "'Degular Medium', 'Poppins', sans-serif", label: 'Degular Medium' },
  { value: "'Source Sans Pro', sans-serif", label: 'Source Sans Pro' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: "'Times New Roman', serif", label: 'Times New Roman' }
];

const DEFAULT_INDICATOR_GRADIENT_STOPS = [
  { color: '#5C0085', position: 0 },
  { color: '#BA0087', position: 100 }
];

// The five supported social platforms (kept in sync with `availableSocialIcons`
// in SocialIconsConfig.jsx). Each can have a custom uploaded SVG glyph that is
// recoloured to the configured header/footer social-icon colour at render time.
const SOCIAL_ICON_PLATFORMS = [
  { key: 'linkedin', name: 'LinkedIn' },
  { key: 'twitter', name: 'Twitter/X' },
  { key: 'facebook', name: 'Facebook' },
  { key: 'instagram', name: 'Instagram' },
  { key: 'youtube', name: 'YouTube' }
];

// Reusable multi-point gradient-stop editor (color picker + position slider +
// add/remove). `onChange` receives the updated stops array.
function GradientStopsEditor({ stops, onChange, testIdPrefix }) {
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
function OpacityStopsEditor({ stops, onChange, testIdPrefix }) {
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
function IndicatorEditor({ value, onChange, testIdPrefix }) {
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

const HEADER_LINK_GRADIENT_STOPS = [
  { color: '#5C0085', position: 0 },
  { color: '#BA0087', position: 100 }
];

// Reusable control group for a header action link (Login / Member Area). Renders
// a custom-label input plus the full style control set (button-vs-link,
// background, corner radius, border, label colour, height, width). `config` is
// the link object from formData.header_config; `onChange(patch)` shallow-merges
// the patch into that object. `defaultLabel` is the placeholder/fallback shown
// when the label is blank (e.g. "Login" / "Member Area").
function HeaderLinkControls({ config, onChange, title, description, defaultLabel, testIdPrefix, previewBackgroundStops }) {
  const cfg = config || {};
  const update = (patch) => onChange(patch);
  const previewLabel = (typeof cfg.label === 'string' && cfg.label.trim()) ? cfg.label.trim() : defaultLabel;
  return (
    <Card className="bg-slate-800/50 border-slate-700">
      <CardHeader>
        <CardTitle className="text-white flex items-center gap-2">
          <User className="w-5 h-5" />
          {title}
        </CardTitle>
        <CardDescription className="text-slate-400">
          {description}
        </CardDescription>
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

export default function AdminBranding() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingHeaderLogo, setUploadingHeaderLogo] = useState(false);
  const [uploadingSocialImage, setUploadingSocialImage] = useState(false);
  const [uploadingPortalNavImage, setUploadingPortalNavImage] = useState(false);
  const [uploadingPortalPageImage, setUploadingPortalPageImage] = useState(false);
  const [socialImageDimWarning, setSocialImageDimWarning] = useState('');
  const [uploadingSocialSvg, setUploadingSocialSvg] = useState(null);
  const [tenantUser, setTenantUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [navPreviewItems, setNavPreviewItems] = useState({ topNav: [], mainNav: [] });
  
  const logoInputRef = useRef(null);
  const headerLogoInputRef = useRef(null);
  const socialImageInputRef = useRef(null);
  const portalNavImageInputRef = useRef(null);
  const portalPageImageInputRef = useRef(null);
  const socialSvgInputRefs = useRef({});
  
  const DEFAULT_GRADIENT_STOPS = [
    { color: '#FFFFFF', position: 0 },
    { color: '#FFFFFF', position: 30 },
    { color: '#5C0085', position: 50 },
    { color: '#BA0087', position: 65 },
    { color: '#EE00C3', position: 80 },
    { color: '#FF4229', position: 90 },
    { color: '#FFB000', position: 100 }
  ];

  const DEFAULT_SECONDARY_BAR_GRADIENT_STOPS = [
    { color: '#5C0085', position: 0 },
    { color: '#BA0087', position: 100 }
  ];

  const DEFAULT_LOGIN_BUTTON_GRADIENT_STOPS = [
    { color: '#5C0085', position: 0 },
    { color: '#BA0087', position: 100 }
  ];

  const DEFAULT_PORTAL_NAV_GRADIENT_STOPS = [
    { color: '#5C0085', opacity: 1, position: 0 },
    { color: '#BA0087', opacity: 1, position: 100 }
  ];

  const DEFAULT_PORTAL_NAV_OVERLAY_STOPS = [
    { color: '#000000', opacity: 0.6, position: 0 },
    { color: '#000000', opacity: 0, position: 100 }
  ];

  // Default portal *page* background reproduces today's hardcoded look
  // (`bg-gradient-to-br from-slate-50 to-blue-50`): slate-50 → blue-50 at 135°.
  const DEFAULT_PORTAL_PAGE_GRADIENT_STOPS = [
    { color: '#f8fafc', opacity: 1, position: 0 },
    { color: '#eff6ff', opacity: 1, position: 100 }
  ];

  const DEFAULT_PORTAL_PAGE_BACKGROUND = {
    type: 'gradient',
    solidColor: '',
    imageUrl: '',
    focalPoint: { x: 50, y: 50 },
    overlayStyle: 'solid',
    darkWash: 0.4,
    overlayStops: DEFAULT_PORTAL_NAV_OVERLAY_STOPS,
    overlayDirection: 'to-top',
    overlayAngle: 0,
    gradientType: 'linear',
    gradientStops: DEFAULT_PORTAL_PAGE_GRADIENT_STOPS,
    gradientAngle: 135
  };

  const DEFAULT_PORTAL_NAV = {
    background: {
      type: 'solid',
      solidColor: '',
      imageUrl: '',
      focalPoint: { x: 50, y: 50 },
      overlayStyle: 'solid',
      darkWash: 0.4,
      overlayStops: DEFAULT_PORTAL_NAV_OVERLAY_STOPS,
      overlayDirection: 'to-top',
      overlayAngle: 0,
      gradientType: 'linear',
      gradientStops: DEFAULT_PORTAL_NAV_GRADIENT_STOPS,
      gradientAngle: 180
    },
    pageBackground: DEFAULT_PORTAL_PAGE_BACKGROUND,
    textColor: '',
    iconColor: '',
    activeBackgroundColor: '',
    activeTextColor: '',
    activeIconColor: '',
    hoverBackgroundColor: '',
    hoverTextColor: '',
    userCard: {
      background: { type: 'solid', solidColor: '', gradientType: 'linear', gradientStops: DEFAULT_PORTAL_NAV_GRADIENT_STOPS, gradientAngle: 180 },
      textColor: ''
    }
  };

  // Merge a stored portalNav blob onto the full default shape so every control
  // is always controlled (no undefined→controlled warnings) and missing
  // sub-fields fall back to the defaults. Stops arrays are kept verbatim when
  // present so the user's exact stops round-trip.
  const hydratePortalNav = (stored) => {
    const s = stored && typeof stored === 'object' ? stored : {};
    const bg = s.background && typeof s.background === 'object' ? s.background : {};
    return {
      background: {
        type: ['solid', 'image', 'gradient'].includes(bg.type) ? bg.type : 'solid',
        solidColor: bg.solidColor || '',
        imageUrl: bg.imageUrl || '',
        focalPoint: {
          x: Number.isFinite(Number(bg.focalPoint?.x)) ? Number(bg.focalPoint.x) : 50,
          y: Number.isFinite(Number(bg.focalPoint?.y)) ? Number(bg.focalPoint.y) : 50
        },
        overlayStyle: bg.overlayStyle === 'gradient' ? 'gradient' : 'solid',
        darkWash: Number.isFinite(Number(bg.darkWash)) ? Number(bg.darkWash) : 0.4,
        overlayStops: (Array.isArray(bg.overlayStops) && bg.overlayStops.length >= 2)
          ? bg.overlayStops
          : DEFAULT_PORTAL_NAV_OVERLAY_STOPS,
        overlayDirection: bg.overlayDirection || 'to-top',
        overlayAngle: Number.isFinite(Number(bg.overlayAngle)) ? Number(bg.overlayAngle) : 0,
        gradientType: bg.gradientType === 'radial' ? 'radial' : 'linear',
        gradientStops: (Array.isArray(bg.gradientStops) && bg.gradientStops.length >= 2)
          ? bg.gradientStops
          : DEFAULT_PORTAL_NAV_GRADIENT_STOPS,
        gradientAngle: Number.isFinite(Number(bg.gradientAngle)) ? Number(bg.gradientAngle) : 180
      },
      pageBackground: (() => {
        const pbg = s.pageBackground && typeof s.pageBackground === 'object' ? s.pageBackground : {};
        return {
          type: ['solid', 'image', 'gradient'].includes(pbg.type) ? pbg.type : 'gradient',
          solidColor: pbg.solidColor || '',
          imageUrl: pbg.imageUrl || '',
          focalPoint: {
            x: Number.isFinite(Number(pbg.focalPoint?.x)) ? Number(pbg.focalPoint.x) : 50,
            y: Number.isFinite(Number(pbg.focalPoint?.y)) ? Number(pbg.focalPoint.y) : 50
          },
          overlayStyle: pbg.overlayStyle === 'gradient' ? 'gradient' : 'solid',
          darkWash: Number.isFinite(Number(pbg.darkWash)) ? Number(pbg.darkWash) : 0.4,
          overlayStops: (Array.isArray(pbg.overlayStops) && pbg.overlayStops.length >= 2)
            ? pbg.overlayStops
            : DEFAULT_PORTAL_NAV_OVERLAY_STOPS,
          overlayDirection: pbg.overlayDirection || 'to-top',
          overlayAngle: Number.isFinite(Number(pbg.overlayAngle)) ? Number(pbg.overlayAngle) : 0,
          gradientType: pbg.gradientType === 'radial' ? 'radial' : 'linear',
          gradientStops: (Array.isArray(pbg.gradientStops) && pbg.gradientStops.length >= 2)
            ? pbg.gradientStops
            : DEFAULT_PORTAL_PAGE_GRADIENT_STOPS,
          gradientAngle: Number.isFinite(Number(pbg.gradientAngle)) ? Number(pbg.gradientAngle) : 135
        };
      })(),
      textColor: s.textColor || '',
      iconColor: s.iconColor || '',
      activeBackgroundColor: s.activeBackgroundColor || '',
      activeTextColor: s.activeTextColor || '',
      activeIconColor: s.activeIconColor || '',
      hoverBackgroundColor: s.hoverBackgroundColor || '',
      hoverTextColor: s.hoverTextColor || '',
      userCard: (() => {
        const uc = s.userCard && typeof s.userCard === 'object' ? s.userCard : {};
        const ucBg = uc.background && typeof uc.background === 'object' ? uc.background : {};
        return {
          background: {
            type: ['solid', 'gradient'].includes(ucBg.type) ? ucBg.type : 'solid',
            solidColor: ucBg.solidColor || '',
            gradientType: ucBg.gradientType === 'radial' ? 'radial' : 'linear',
            gradientStops: (Array.isArray(ucBg.gradientStops) && ucBg.gradientStops.length >= 2)
              ? ucBg.gradientStops
              : DEFAULT_PORTAL_NAV_GRADIENT_STOPS,
            gradientAngle: Number.isFinite(Number(ucBg.gradientAngle)) ? Number(ucBg.gradientAngle) : 180
          },
          textColor: uc.textColor || ''
        };
      })()
    };
  };

  const [formData, setFormData] = useState({
    primary_color: '#5C0085',
    secondary_color: '#BA0087',
    tagline: '',
    description: '',
    social_image_url: '',
    logo_url: '',
    header_logo_url: '',
    header_config: {
      logoHeight: '',
      logoWidth: '',
      logoBackground: '',
      logoBorderRadiusTopLeft: '',
      logoBorderRadiusTopRight: '',
      logoBorderRadiusBottomLeft: '',
      logoBorderRadiusBottomRight: '',
      logoBorderWidth: '',
      logoBorderColor: '',
      logoShadow: 'none',
      logoPadding: '',
      logoPaddingTop: '',
      logoPaddingRight: '',
      logoPaddingBottom: '',
      logoPaddingLeft: '',
      logoMarginTop: '',
      logoMarginLeft: '',
      gradientStops: DEFAULT_GRADIENT_STOPS,
      topBarHeight: '',
      topNavTextColor: '',
      topNavHoverColor: '',
      topNavFontSize: '',
      topNavFontWeight: '',
      topNavFontFamily: '',
      searchDisplay: 'both',
      topNavIndicator: { enabled: false, height: '', gradientStops: DEFAULT_INDICATOR_GRADIENT_STOPS },
      secondaryBar: {
        enabled: false,
        height: '',
        gradientStops: DEFAULT_SECONDARY_BAR_GRADIENT_STOPS,
        textColor: '',
        hoverColor: '',
        fontSize: '',
        fontWeight: '',
        fontFamily: '',
        indicator: { enabled: true, height: '', gradientStops: DEFAULT_INDICATOR_GRADIENT_STOPS }
      },
      loginLink: {
        label: '',
        asButton: false,
        backgroundMode: 'solid',
        solidColor: '',
        gradientStops: DEFAULT_LOGIN_BUTTON_GRADIENT_STOPS,
        cornerRadius: '',
        borderWidth: '',
        borderColor: '',
        borderStyle: 'solid',
        labelColor: '',
        height: '',
        width: ''
      },
      memberAreaLink: {
        label: '',
        asButton: false,
        backgroundMode: 'solid',
        solidColor: '',
        gradientStops: DEFAULT_LOGIN_BUTTON_GRADIENT_STOPS,
        cornerRadius: '',
        borderWidth: '',
        borderColor: '',
        borderStyle: 'solid',
        labelColor: '',
        height: '',
        width: ''
      }
    },
    footer_config: {
      columns: 4,
      columnAlignments: {},
      ctaText: 'Become a member today',
      ctaButtonText: 'Join Us',
      ctaLink: 'Membership',
      newsletterText: 'Sign up to our newsletter',
      gradientColors: ['#5C0085', '#BA0087', '#EE00C3', '#FF4229', '#FFB000'],
      backgroundColor: '#000000',
      textColor: '#FFFFFF',
      address: {
        name: '',
        lines: []
      },
      contact: {
        phone: '',
        email: ''
      },
      legalText: '',
      termsAndConditionsUrl: '',
      privacyPolicyUrl: ''
    },
    branding_config: {
      footerLogoHeight: '',
      footerLogoWidth: '',
      footerLogoInvert: false,
      headerSocialIconColor: '#5C0085',
      footerSocialIconColor: '#FFFFFF',
      socialIconCustomSvgs: {},
      portalNav: DEFAULT_PORTAL_NAV,
      basePortalFont: ''
    },
    platform_branding: {
      showPlatformBranding: true,
      backgroundColor: '#000000',
      textColor: '#64748b'
    }
  });

  // Resolve uploaded custom social SVGs to same-origin data URIs so the preview
  // thumbnails below mask reliably (a cross-origin URL in mask-image renders as
  // a solid coloured square, matching what users would otherwise see live).
  const resolvedSocialSvgs = useResolvedSocialIcons(formData.branding_config?.socialIconCustomSvgs || {});

  const [newAddressLine, setNewAddressLine] = useState('');
  const [newGradientColor, setNewGradientColor] = useState('#000000');
  const [newHeaderGradientColor, setNewHeaderGradientColor] = useState('#000000');
  const [newHeaderGradientPosition, setNewHeaderGradientPosition] = useState(100);
  const [newSecondaryBarGradientColor, setNewSecondaryBarGradientColor] = useState('#000000');
  const [newSecondaryBarGradientPosition, setNewSecondaryBarGradientPosition] = useState(100);
  const [platformDefaults, setPlatformDefaults] = useState({
    platformBrandingText: 'Powered by isaasi',
    platformBrandingUrl: 'https://isaasi.co.uk'
  });

  const convertLegacyGradientColors = (colors) => {
    if (!colors || colors.length === 0) return DEFAULT_GRADIENT_STOPS;
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
  };

  const getGradientStops = (headerConfig) => {
    if (headerConfig?.gradientStops && headerConfig.gradientStops.length > 0) {
      return headerConfig.gradientStops;
    }
    if (headerConfig?.gradientColors && headerConfig.gradientColors.length > 0) {
      return convertLegacyGradientColors(headerConfig.gradientColors);
    }
    return DEFAULT_GRADIENT_STOPS;
  };

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/tenant-user-me', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.tenantUser) {
            setTenantUser(data.tenantUser);
            setTenant(data.tenant);
            
            const t = data.tenant;
            setFormData({
              primary_color: t?.primary_color || '#5C0085',
              secondary_color: t?.secondary_color || '#BA0087',
              tagline: t?.tagline || '',
              description: t?.description || '',
              social_image_url: t?.social_image_url || '',
              logo_url: t?.logo_url || '',
              header_logo_url: t?.header_logo_url || '',
              header_config: {
                logoHeight: t?.header_config?.logoHeight || '',
                logoWidth: t?.header_config?.logoWidth || '',
                logoBackground: t?.header_config?.logoBackground || '',
                logoBorderRadiusTopLeft: t?.header_config?.logoBorderRadiusTopLeft || t?.header_config?.logoBorderRadius || '',
                logoBorderRadiusTopRight: t?.header_config?.logoBorderRadiusTopRight || t?.header_config?.logoBorderRadius || '',
                logoBorderRadiusBottomLeft: t?.header_config?.logoBorderRadiusBottomLeft || t?.header_config?.logoBorderRadius || '',
                logoBorderRadiusBottomRight: t?.header_config?.logoBorderRadiusBottomRight || t?.header_config?.logoBorderRadius || '',
                logoBorderWidth: t?.header_config?.logoBorderWidth || '',
                logoBorderColor: t?.header_config?.logoBorderColor || '',
                logoShadow: t?.header_config?.logoShadow || 'none',
                logoPadding: t?.header_config?.logoPadding || '',
                logoPaddingTop: t?.header_config?.logoPaddingTop || t?.header_config?.logoPadding || '',
                logoPaddingRight: t?.header_config?.logoPaddingRight || t?.header_config?.logoPadding || '',
                logoPaddingBottom: t?.header_config?.logoPaddingBottom || t?.header_config?.logoPadding || '',
                logoPaddingLeft: t?.header_config?.logoPaddingLeft || t?.header_config?.logoPadding || '',
                logoMarginTop: t?.header_config?.logoMarginTop || '',
                logoMarginLeft: t?.header_config?.logoMarginLeft || '',
                gradientStops: getGradientStops(t?.header_config),
                topBarHeight: t?.header_config?.topBarHeight || '',
                topNavTextColor: t?.header_config?.topNavTextColor || '',
                topNavHoverColor: t?.header_config?.topNavHoverColor || '',
                topNavFontSize: t?.header_config?.topNavFontSize || '',
                topNavFontWeight: t?.header_config?.topNavFontWeight || '',
                topNavFontFamily: t?.header_config?.topNavFontFamily || '',
                searchDisplay: ['icon', 'label', 'both'].includes(t?.header_config?.searchDisplay)
                  ? t.header_config.searchDisplay
                  : 'both',
                topNavIndicator: {
                  enabled: t?.header_config?.topNavIndicator ? !!t.header_config.topNavIndicator.enabled : false,
                  height: t?.header_config?.topNavIndicator?.height || '',
                  gradientStops: (t?.header_config?.topNavIndicator?.gradientStops && t.header_config.topNavIndicator.gradientStops.length > 0)
                    ? t.header_config.topNavIndicator.gradientStops
                    : DEFAULT_INDICATOR_GRADIENT_STOPS
                },
                secondaryBar: {
                  enabled: !!t?.header_config?.secondaryBar?.enabled,
                  height: t?.header_config?.secondaryBar?.height || '',
                  gradientStops: (t?.header_config?.secondaryBar?.gradientStops && t?.header_config?.secondaryBar?.gradientStops.length > 0)
                    ? t.header_config.secondaryBar.gradientStops
                    : DEFAULT_SECONDARY_BAR_GRADIENT_STOPS,
                  textColor: t?.header_config?.secondaryBar?.textColor || '',
                  hoverColor: t?.header_config?.secondaryBar?.hoverColor || '',
                  fontSize: t?.header_config?.secondaryBar?.fontSize || '',
                  fontWeight: t?.header_config?.secondaryBar?.fontWeight || '',
                  fontFamily: t?.header_config?.secondaryBar?.fontFamily || '',
                  indicator: {
                    enabled: t?.header_config?.secondaryBar?.indicator ? !!t.header_config.secondaryBar.indicator.enabled : true,
                    height: t?.header_config?.secondaryBar?.indicator?.height || '',
                    gradientStops: (t?.header_config?.secondaryBar?.indicator?.gradientStops && t.header_config.secondaryBar.indicator.gradientStops.length > 0)
                      ? t.header_config.secondaryBar.indicator.gradientStops
                      : DEFAULT_INDICATOR_GRADIENT_STOPS
                  }
                },
                loginLink: {
                  label: t?.header_config?.loginLink?.label || '',
                  asButton: !!t?.header_config?.loginLink?.asButton,
                  backgroundMode: t?.header_config?.loginLink?.backgroundMode === 'gradient' ? 'gradient' : 'solid',
                  solidColor: t?.header_config?.loginLink?.solidColor || '',
                  gradientStops: (t?.header_config?.loginLink?.gradientStops && t.header_config.loginLink.gradientStops.length > 0)
                    ? t.header_config.loginLink.gradientStops
                    : DEFAULT_LOGIN_BUTTON_GRADIENT_STOPS,
                  cornerRadius: t?.header_config?.loginLink?.cornerRadius ?? '',
                  borderWidth: t?.header_config?.loginLink?.borderWidth ?? '',
                  borderColor: t?.header_config?.loginLink?.borderColor || '',
                  borderStyle: t?.header_config?.loginLink?.borderStyle || 'solid',
                  labelColor: t?.header_config?.loginLink?.labelColor || '',
                  height: t?.header_config?.loginLink?.height ?? '',
                  width: t?.header_config?.loginLink?.width ?? ''
                },
                memberAreaLink: {
                  label: t?.header_config?.memberAreaLink?.label || '',
                  asButton: !!t?.header_config?.memberAreaLink?.asButton,
                  backgroundMode: t?.header_config?.memberAreaLink?.backgroundMode === 'gradient' ? 'gradient' : 'solid',
                  solidColor: t?.header_config?.memberAreaLink?.solidColor || '',
                  gradientStops: (t?.header_config?.memberAreaLink?.gradientStops && t.header_config.memberAreaLink.gradientStops.length > 0)
                    ? t.header_config.memberAreaLink.gradientStops
                    : DEFAULT_LOGIN_BUTTON_GRADIENT_STOPS,
                  cornerRadius: t?.header_config?.memberAreaLink?.cornerRadius ?? '',
                  borderWidth: t?.header_config?.memberAreaLink?.borderWidth ?? '',
                  borderColor: t?.header_config?.memberAreaLink?.borderColor || '',
                  borderStyle: t?.header_config?.memberAreaLink?.borderStyle || 'solid',
                  labelColor: t?.header_config?.memberAreaLink?.labelColor || '',
                  height: t?.header_config?.memberAreaLink?.height ?? '',
                  width: t?.header_config?.memberAreaLink?.width ?? ''
                }
              },
              footer_config: {
                columns: t?.footer_config?.columns || 4,
                columnAlignments: t?.footer_config?.columnAlignments || {},
                ctaText: t?.footer_config?.ctaText || 'Become a member today',
                ctaButtonText: t?.footer_config?.ctaButtonText || 'Join Us',
                ctaLink: t?.footer_config?.ctaLink || 'Membership',
                newsletterText: t?.footer_config?.newsletterText || 'Sign up to our newsletter',
                gradientColors: t?.footer_config?.gradientColors || ['#5C0085', '#BA0087', '#EE00C3', '#FF4229', '#FFB000'],
                backgroundColor: t?.footer_config?.backgroundColor || '#000000',
                textColor: t?.footer_config?.textColor || '#FFFFFF',
                address: {
                  name: t?.footer_config?.address?.name || '',
                  lines: t?.footer_config?.address?.lines || []
                },
                contact: {
                  phone: t?.footer_config?.contact?.phone || '',
                  email: t?.footer_config?.contact?.email || ''
                },
                legalText: t?.footer_config?.legalText || '',
                termsAndConditionsUrl: t?.footer_config?.termsAndConditionsUrl || '',
                privacyPolicyUrl: t?.footer_config?.privacyPolicyUrl || ''
              },
              branding_config: {
                footerLogoHeight: t?.branding_config?.footerLogoHeight || '',
                footerLogoWidth: t?.branding_config?.footerLogoWidth || '',
                footerLogoInvert: t?.branding_config?.footerLogoInvert === true,
                headerSocialIconColor: t?.branding_config?.headerSocialIconColor || '#5C0085',
                footerSocialIconColor: t?.branding_config?.footerSocialIconColor || '#FFFFFF',
                socialIconCustomSvgs: t?.branding_config?.socialIconCustomSvgs || {},
                portalNav: hydratePortalNav(t?.branding_config?.portalNav),
                basePortalFont: t?.branding_config?.basePortalFont || ''
              },
              platform_branding: {
                showPlatformBranding: t?.platform_branding?.showPlatformBranding !== false,
                backgroundColor: t?.platform_branding?.backgroundColor || '#000000',
                textColor: t?.platform_branding?.textColor || '#64748b'
              }
            });
            
            // Also fetch platform defaults
            try {
              const defaultsRes = await fetch('/api/public/platform-defaults');
              if (defaultsRes.ok) {
                const defaultsData = await defaultsRes.json();
                setPlatformDefaults(prev => ({
                  ...prev,
                  ...defaultsData
                }));
              }
            } catch (err) {
              console.error('Failed to fetch platform defaults:', err);
            }
          } else {
            navigate('/admin/login');
          }
        } else {
          navigate('/admin/login');
        }
      } catch (err) {
        navigate('/admin/login');
      } finally {
        setLoading(false);
      }
    };
    
    checkAuth();
  }, [navigate]);

  // Fetch real navigation items so the header previews mirror the live site's
  // actual top-level menu structure (falls back to placeholders if none exist).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const items = await publicClient.listNavigationItems();
        const topLevelTitles = (location) => (items || [])
          .filter(i => (i.parent_id == null) && i.location === location)
          .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
          .map(i => i.title)
          .filter(Boolean);
        if (!cancelled) {
          setNavPreviewItems({
            topNav: topLevelTitles('top_nav'),
            mainNav: topLevelTitles('main_nav')
          });
        }
      } catch (err) {
        if (!cancelled) setNavPreviewItems({ topNav: [], mainNav: [] });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // --- Portal sidebar (authenticated-portal nav) branding helpers ---
  const portalNav = formData.branding_config?.portalNav || DEFAULT_PORTAL_NAV;
  const portalNavBg = portalNav.background || DEFAULT_PORTAL_NAV.background;

  const setPortalNav = (patch) => {
    setFormData(prev => ({
      ...prev,
      branding_config: {
        ...prev.branding_config,
        portalNav: {
          ...(prev.branding_config?.portalNav || DEFAULT_PORTAL_NAV),
          ...patch
        }
      }
    }));
  };

  const setPortalNavBg = (patch) => {
    setFormData(prev => {
      const pn = prev.branding_config?.portalNav || DEFAULT_PORTAL_NAV;
      return {
        ...prev,
        branding_config: {
          ...prev.branding_config,
          portalNav: {
            ...pn,
            background: { ...(pn.background || DEFAULT_PORTAL_NAV.background), ...patch }
          }
        }
      };
    });
  };

  const pageBg = portalNav.pageBackground || DEFAULT_PORTAL_NAV.pageBackground;

  const setPageBg = (patch) => {
    setFormData(prev => {
      const pn = prev.branding_config?.portalNav || DEFAULT_PORTAL_NAV;
      return {
        ...prev,
        branding_config: {
          ...prev.branding_config,
          portalNav: {
            ...pn,
            pageBackground: { ...(pn.pageBackground || DEFAULT_PORTAL_NAV.pageBackground), ...patch }
          }
        }
      };
    });
  };

  const userCard = portalNav.userCard || DEFAULT_PORTAL_NAV.userCard;
  const userCardBg = userCard.background || DEFAULT_PORTAL_NAV.userCard.background;

  const setUserCard = (patch) => {
    setFormData(prev => {
      const pn = prev.branding_config?.portalNav || DEFAULT_PORTAL_NAV;
      return {
        ...prev,
        branding_config: {
          ...prev.branding_config,
          portalNav: {
            ...pn,
            userCard: { ...(pn.userCard || DEFAULT_PORTAL_NAV.userCard), ...patch }
          }
        }
      };
    });
  };

  const setUserCardBg = (patch) => {
    setFormData(prev => {
      const pn = prev.branding_config?.portalNav || DEFAULT_PORTAL_NAV;
      const uc = pn.userCard || DEFAULT_PORTAL_NAV.userCard;
      return {
        ...prev,
        branding_config: {
          ...prev.branding_config,
          portalNav: {
            ...pn,
            userCard: {
              ...uc,
              background: { ...(uc.background || DEFAULT_PORTAL_NAV.userCard.background), ...patch }
            }
          }
        }
      };
    });
  };

  const handlePortalNavImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingPortalNavImage(true);
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('folder', 'branding');
    try {
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: uploadFormData
      });
      if (response.ok) {
        const data = await response.json();
        setPortalNavBg({ imageUrl: data.file_url });
        toast({ title: 'Image uploaded', description: 'Remember to Save to apply your sidebar background.' });
      } else {
        toast({ title: 'Upload failed', description: 'Could not upload the image.', variant: 'destructive' });
      }
    } catch (err) {
      toast({ title: 'Upload failed', description: 'Could not upload the image.', variant: 'destructive' });
    } finally {
      setUploadingPortalNavImage(false);
    }
  };

  const handlePortalPageImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingPortalPageImage(true);
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('folder', 'branding');
    try {
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: uploadFormData
      });
      if (response.ok) {
        const data = await response.json();
        setPageBg({ imageUrl: data.file_url });
        toast({ title: 'Image uploaded', description: 'Remember to Save to apply your page background.' });
      } else {
        toast({ title: 'Upload failed', description: 'Could not upload the image.', variant: 'destructive' });
      }
    } catch (err) {
      toast({ title: 'Upload failed', description: 'Could not upload the image.', variant: 'destructive' });
    } finally {
      setUploadingPortalPageImage(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);

    try {
      const response = await fetch('/api/admin/tenant-branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData)
      });

      if (response.ok) {
        queryClient.invalidateQueries({ queryKey: ['tenant-branding'] });
        toast({
          title: "Branding saved",
          description: "Your branding settings have been updated."
        });
      } else {
        throw new Error('Failed to save');
      }
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to save branding settings.",
        variant: "destructive"
      });
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setUploadingLogo(true);
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('folder', 'branding');
    
    try {
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: uploadFormData
      });
      
      if (response.ok) {
        const data = await response.json();
        const newLogoUrl = data.file_url;
        setFormData(prev => ({ ...prev, logo_url: newLogoUrl }));
        
        // Auto-save the logo to database
        const saveResponse = await fetch('/api/admin/tenant-branding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ logo_url: newLogoUrl })
        });
        
        if (saveResponse.ok) {
          toast({
            title: "Logo saved",
            description: "Your logo has been uploaded and saved."
          });
        } else {
          toast({
            title: "Logo uploaded",
            description: "Logo uploaded but not saved. Click Save to persist changes.",
            variant: "warning"
          });
        }
      } else {
        throw new Error('Upload failed');
      }
    } catch (err) {
      toast({
        title: "Upload failed",
        description: "Could not upload logo. Please try again.",
        variant: "destructive"
      });
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSocialImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingSocialImage(true);
    setSocialImageDimWarning('');

    // Read dimensions for non-blocking warning
    try {
      const dims = await new Promise((resolve, reject) => {
        const img = new window.Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.onerror = (err) => {
          URL.revokeObjectURL(url);
          reject(err);
        };
        img.src = url;
      });
      const { width, height } = dims;
      const widthOk = width >= 1100 && width <= 1300;
      const heightOk = height >= 580 && height <= 680;
      if (!widthOk || !heightOk) {
        setSocialImageDimWarning(`Uploaded image is ${width}×${height}. The recommended size is 1200×630 for best link-preview results.`);
      }
    } catch (_dimErr) {
      // ignore — proceed with upload regardless
    }

    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('folder', 'branding');

    try {
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: uploadFormData
      });

      if (response.ok) {
        const data = await response.json();
        const newUrl = data.file_url;
        setFormData(prev => ({ ...prev, social_image_url: newUrl }));

        const saveResponse = await fetch('/api/admin/tenant-branding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ social_image_url: newUrl })
        });

        if (saveResponse.ok) {
          toast({
            title: "Social image saved",
            description: "Your link-preview image has been uploaded and saved."
          });
        } else {
          toast({
            title: "Image uploaded",
            description: "Image uploaded but not saved. Click Save to persist changes.",
            variant: "warning"
          });
        }
      } else {
        throw new Error('Upload failed');
      }
    } catch (err) {
      toast({
        title: "Upload failed",
        description: "Could not upload social image. Please try again.",
        variant: "destructive"
      });
    } finally {
      setUploadingSocialImage(false);
      if (socialImageInputRef.current) socialImageInputRef.current.value = '';
    }
  };

  const handleRemoveSocialImage = async () => {
    setFormData(prev => ({ ...prev, social_image_url: '' }));
    setSocialImageDimWarning('');
    try {
      const response = await fetch('/api/admin/tenant-branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ social_image_url: '' })
      });
      if (response.ok) {
        toast({
          title: "Social image removed",
          description: "Your link-preview image has been removed."
        });
      } else {
        toast({
          title: "Image cleared locally",
          description: "Removal not saved on the server. Click Save to persist changes.",
          variant: "warning"
        });
      }
    } catch (_err) {
      toast({
        title: "Image cleared locally",
        description: "Removal not saved on the server. Click Save to persist changes.",
        variant: "warning"
      });
    }
  };

  // Upload a custom SVG glyph for a single social platform. Only SVG files are
  // accepted (validated client-side by MIME and extension). The returned URL is
  // stored in branding_config.socialIconCustomSvgs[platform] and auto-saved
  // through the existing branding PATCH flow.
  const handleSocialSvgUpload = async (platform, e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isSvg = (file.type === 'image/svg+xml') || /\.svg$/i.test(file.name || '');
    if (!isSvg) {
      toast({
        title: "Invalid file type",
        description: "Only SVG files are allowed for custom social icons.",
        variant: "destructive"
      });
      if (socialSvgInputRefs.current[platform]) socialSvgInputRefs.current[platform].value = '';
      return;
    }

    setUploadingSocialSvg(platform);
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('folder', 'branding');

    try {
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: uploadFormData
      });

      if (!response.ok) throw new Error('Upload failed');

      const data = await response.json();
      const newUrl = data.file_url;
      const nextSvgs = { ...(formData.branding_config?.socialIconCustomSvgs || {}), [platform]: newUrl };
      const nextBrandingConfig = { ...formData.branding_config, socialIconCustomSvgs: nextSvgs };
      setFormData(prev => ({ ...prev, branding_config: nextBrandingConfig }));

      const saveResponse = await fetch('/api/admin/tenant-branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ branding_config: nextBrandingConfig })
      });

      if (saveResponse.ok) {
        toast({
          title: "Icon saved",
          description: "Your custom social icon has been uploaded and saved."
        });
      } else {
        toast({
          title: "Icon uploaded",
          description: "Icon uploaded but not saved. Click Save to persist changes.",
          variant: "warning"
        });
      }
    } catch (err) {
      toast({
        title: "Upload failed",
        description: "Could not upload the icon. Please try again.",
        variant: "destructive"
      });
    } finally {
      setUploadingSocialSvg(null);
      if (socialSvgInputRefs.current[platform]) socialSvgInputRefs.current[platform].value = '';
    }
  };

  // Remove a platform's custom SVG, reverting it to the built-in icon.
  const handleRemoveSocialSvg = async (platform) => {
    const nextSvgs = { ...(formData.branding_config?.socialIconCustomSvgs || {}) };
    delete nextSvgs[platform];
    const nextBrandingConfig = { ...formData.branding_config, socialIconCustomSvgs: nextSvgs };
    setFormData(prev => ({ ...prev, branding_config: nextBrandingConfig }));

    try {
      const response = await fetch('/api/admin/tenant-branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ branding_config: nextBrandingConfig })
      });
      if (response.ok) {
        toast({
          title: "Icon removed",
          description: "Reverted to the built-in icon."
        });
      } else {
        toast({
          title: "Icon cleared locally",
          description: "Removal not saved on the server. Click Save to persist changes.",
          variant: "warning"
        });
      }
    } catch (_err) {
      toast({
        title: "Icon cleared locally",
        description: "Removal not saved on the server. Click Save to persist changes.",
        variant: "warning"
      });
    }
  };

  const handleHeaderLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setUploadingHeaderLogo(true);
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('folder', 'branding');
    
    try {
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: uploadFormData
      });
      
      if (response.ok) {
        const data = await response.json();
        const newLogoUrl = data.file_url;
        setFormData(prev => ({ ...prev, header_logo_url: newLogoUrl }));
        
        // Auto-save the header logo to database
        const saveResponse = await fetch('/api/admin/tenant-branding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ header_logo_url: newLogoUrl })
        });
        
        if (saveResponse.ok) {
          toast({
            title: "Header logo saved",
            description: "Your header logo has been uploaded and saved."
          });
        } else {
          toast({
            title: "Logo uploaded",
            description: "Logo uploaded but not saved. Click Save to persist changes.",
            variant: "warning"
          });
        }
      } else {
        throw new Error('Upload failed');
      }
    } catch (err) {
      toast({
        title: "Upload failed",
        description: "Could not upload header logo. Please try again.",
        variant: "destructive"
      });
    } finally {
      setUploadingHeaderLogo(false);
    }
  };

  const addAddressLine = () => {
    if (newAddressLine.trim()) {
      setFormData(prev => ({
        ...prev,
        footer_config: {
          ...prev.footer_config,
          address: {
            ...prev.footer_config.address,
            lines: [...(prev.footer_config.address.lines || []), newAddressLine.trim()]
          }
        }
      }));
      setNewAddressLine('');
    }
  };

  const removeAddressLine = (index) => {
    setFormData(prev => ({
      ...prev,
      footer_config: {
        ...prev.footer_config,
        address: {
          ...prev.footer_config.address,
          lines: prev.footer_config.address.lines.filter((_, i) => i !== index)
        }
      }
    }));
  };

  const addGradientColor = () => {
    if (newGradientColor) {
      setFormData(prev => ({
        ...prev,
        footer_config: {
          ...prev.footer_config,
          gradientColors: [...(prev.footer_config.gradientColors || []), newGradientColor]
        }
      }));
      setNewGradientColor('#000000');
    }
  };

  const removeGradientColor = (index) => {
    setFormData(prev => ({
      ...prev,
      footer_config: {
        ...prev.footer_config,
        gradientColors: prev.footer_config.gradientColors.filter((_, i) => i !== index)
      }
    }));
  };

  const updateGradientColor = (index, color) => {
    setFormData(prev => ({
      ...prev,
      footer_config: {
        ...prev.footer_config,
        gradientColors: prev.footer_config.gradientColors.map((c, i) => i === index ? color : c)
      }
    }));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Link to="/admin/dashboard">
              <Button variant="ghost" size="icon" className="text-slate-400 hover:text-white" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                <Palette className="w-6 h-6 text-purple-400" />
                Branding Settings
              </h1>
              <p className="text-slate-400 text-sm mt-1">
                Customize colors, logo, and public page styling
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {(formData.header_config?.topNavHoverColor || formData.header_config?.secondaryBar?.hoverColor) && (
            <style>{`
              ${formData.header_config?.topNavHoverColor ? `.ab-top-preview-link:hover { color: ${formData.header_config.topNavHoverColor} !important; }` : ''}
              ${formData.header_config?.secondaryBar?.hoverColor ? `.ab-sec-preview-link:hover { color: ${formData.header_config.secondaryBar.hoverColor} !important; }` : ''}
            `}</style>
          )}
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Palette className="w-5 h-5" />
                Colors
              </CardTitle>
              <CardDescription className="text-slate-400">
                Set your brand colors for the public website
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="primary_color" className="text-slate-200">Primary Color</Label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      id="primary_color"
                      value={formData.primary_color}
                      onChange={(e) => setFormData({ ...formData, primary_color: e.target.value })}
                      className="w-12 h-10 rounded cursor-pointer"
                      data-testid="input-primary-color"
                    />
                    <Input
                      value={formData.primary_color}
                      onChange={(e) => setFormData({ ...formData, primary_color: e.target.value })}
                      className="bg-slate-900/50 border-slate-600 text-white flex-1"
                      placeholder="#5C0085"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="secondary_color" className="text-slate-200">Secondary Color</Label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      id="secondary_color"
                      value={formData.secondary_color}
                      onChange={(e) => setFormData({ ...formData, secondary_color: e.target.value })}
                      className="w-12 h-10 rounded cursor-pointer"
                      data-testid="input-secondary-color"
                    />
                    <Input
                      value={formData.secondary_color}
                      onChange={(e) => setFormData({ ...formData, secondary_color: e.target.value })}
                      className="bg-slate-900/50 border-slate-600 text-white flex-1"
                      placeholder="#BA0087"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Image className="w-5 h-5" />
                Logo
              </CardTitle>
              <CardDescription className="text-slate-400">
                Upload your organization's logo for the public website footer
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="border-2 border-dashed border-slate-600 rounded-lg p-4 bg-slate-900/50">
                {formData.logo_url ? (
                  <div className="flex items-center gap-4">
                    <div className="bg-slate-700 rounded-lg p-4">
                      <img 
                        src={formData.logo_url} 
                        alt="Logo" 
                        className="h-16 w-auto object-contain"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => logoInputRef.current?.click()}
                        className="border-slate-600 text-slate-300"
                        data-testid="button-change-logo"
                      >
                        <Upload className="w-4 h-4 mr-2" />
                        Change
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setFormData({ ...formData, logo_url: '' })}
                        data-testid="button-remove-logo"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Remove
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <Image className="w-12 h-12 mx-auto text-slate-500 mb-3" />
                    <p className="text-slate-400 mb-3">No logo uploaded</p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => logoInputRef.current?.click()}
                      disabled={uploadingLogo}
                      className="border-slate-600 text-slate-300"
                      data-testid="button-upload-logo"
                    >
                      {uploadingLogo ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Upload className="w-4 h-4 mr-2" />
                      )}
                      Upload Logo
                    </Button>
                  </div>
                )}
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleLogoUpload}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="footer_logo_height" className="text-slate-200">Max Height (px)</Label>
                  <Input
                    id="footer_logo_height"
                    type="number"
                    value={formData.branding_config?.footerLogoHeight || ''}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      branding_config: { 
                        ...formData.branding_config, 
                        footerLogoHeight: e.target.value 
                      } 
                    })}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="96"
                    data-testid="input-footer-logo-height"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="footer_logo_width" className="text-slate-200">Max Width (px)</Label>
                  <Input
                    id="footer_logo_width"
                    type="number"
                    value={formData.branding_config?.footerLogoWidth || ''}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      branding_config: { 
                        ...formData.branding_config, 
                        footerLogoWidth: e.target.value 
                      } 
                    })}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="auto"
                    data-testid="input-footer-logo-width"
                  />
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-2">Leave empty for default sizing. The logo will scale proportionally within these constraints.</p>

              <div className="flex items-center justify-between p-4 mt-4 bg-slate-900/50 rounded-lg border border-slate-600">
                <div className="pr-4">
                  <Label className="text-white font-medium">Render logo in white</Label>
                  <p className="text-xs text-slate-400 mt-1">
                    Forces the footer logo to display as a solid white silhouette. Useful for dark single-color logos that need to be visible on a dark footer background. Leave off to display the logo in its original colors.
                  </p>
                </div>
                <Switch
                  checked={!!formData.branding_config?.footerLogoInvert}
                  onCheckedChange={(checked) => setFormData({
                    ...formData,
                    branding_config: {
                      ...formData.branding_config,
                      footerLogoInvert: checked
                    }
                  })}
                  data-testid="switch-footer-logo-invert"
                />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Image className="w-5 h-5" />
                Header Logo
              </CardTitle>
              <CardDescription className="text-slate-400">
                Upload a separate logo for the navigation header (typically lighter for dark backgrounds)
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="border-2 border-dashed border-slate-600 rounded-lg p-4 bg-slate-900/50">
                {formData.header_logo_url ? (
                  <div className="flex items-center gap-4">
                    <div className="bg-slate-700 rounded-lg p-4">
                      <img 
                        src={formData.header_logo_url} 
                        alt="Header Logo" 
                        className="h-16 w-auto object-contain"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => headerLogoInputRef.current?.click()}
                        className="border-slate-600 text-slate-300"
                        data-testid="button-change-header-logo"
                      >
                        <Upload className="w-4 h-4 mr-2" />
                        Change
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setFormData({ ...formData, header_logo_url: '' })}
                        data-testid="button-remove-header-logo"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Remove
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <Image className="w-12 h-12 mx-auto text-slate-500 mb-3" />
                    <p className="text-slate-400 mb-3">No header logo uploaded</p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => headerLogoInputRef.current?.click()}
                      disabled={uploadingHeaderLogo}
                      className="border-slate-600 text-slate-300"
                      data-testid="button-upload-header-logo"
                    >
                      {uploadingHeaderLogo ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Upload className="w-4 h-4 mr-2" />
                      )}
                      Upload Header Logo
                    </Button>
                  </div>
                )}
                <input
                  ref={headerLogoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleHeaderLogoUpload}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="header_logo_height" className="text-slate-200">Max Height (px)</Label>
                  <Input
                    id="header_logo_height"
                    type="number"
                    value={formData.header_config?.logoHeight || ''}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      header_config: { 
                        ...formData.header_config, 
                        logoHeight: e.target.value 
                      } 
                    })}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="158"
                    data-testid="input-header-logo-height"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="header_logo_width" className="text-slate-200">Max Width (px)</Label>
                  <Input
                    id="header_logo_width"
                    type="number"
                    value={formData.header_config?.logoWidth || ''}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      header_config: { 
                        ...formData.header_config, 
                        logoWidth: e.target.value 
                      } 
                    })}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="auto"
                    data-testid="input-header-logo-width"
                  />
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-2">Leave empty for default sizing. The logo will scale proportionally within these constraints.</p>

              <div className="border-t border-slate-700 pt-4 mt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <Label className="text-slate-200">Shrink logo on scroll</Label>
                    <p className="text-xs text-slate-500">Smoothly shrinks the logo to a smaller height when the public site is scrolled down</p>
                  </div>
                  <Switch
                    checked={!!formData.header_config?.logoShrinkOnScroll}
                    onCheckedChange={(checked) => setFormData({
                      ...formData,
                      header_config: {
                        ...formData.header_config,
                        logoShrinkOnScroll: checked
                      }
                    })}
                    data-testid="switch-logo-shrink-on-scroll"
                  />
                </div>
                {formData.header_config?.logoShrinkOnScroll && (
                  <div className="space-y-2 mt-4">
                    <Label htmlFor="header_logo_scrolled_height" className="text-slate-200">Scrolled Logo Height (px)</Label>
                    <Input
                      id="header_logo_scrolled_height"
                      type="number"
                      value={formData.header_config?.logoScrolledHeight || ''}
                      onChange={(e) => setFormData({
                        ...formData,
                        header_config: {
                          ...formData.header_config,
                          logoScrolledHeight: e.target.value
                        }
                      })}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="80"
                      data-testid="input-header-logo-scrolled-height"
                    />
                    <p className="text-xs text-slate-500">The logo height once the page is scrolled down. Should be smaller than the max height above.</p>
                  </div>
                )}
              </div>

              <div className="border-t border-slate-700 pt-4 mt-4">
                <h4 className="text-white font-medium mb-4">Logo Container Styling</h4>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="header_logo_background" className="text-slate-200">Background Color</Label>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        id="header_logo_background_picker"
                        value={formData.header_config?.logoBackground || '#ffffff'}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBackground: e.target.value 
                          } 
                        })}
                        className="w-12 h-10 rounded cursor-pointer"
                        data-testid="input-header-logo-background-picker"
                      />
                      <Input
                        id="header_logo_background"
                        value={formData.header_config?.logoBackground || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBackground: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white flex-1"
                        placeholder="transparent"
                        data-testid="input-header-logo-background"
                      />
                    </div>
                    <p className="text-xs text-slate-500">Leave empty for transparent background</p>
                  </div>
                </div>

                <div className="mt-4">
                  <Label className="text-slate-200 mb-2 block">Padding (px per side)</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_padding_top" className="text-slate-400 text-xs">Top</Label>
                      <Input
                        id="header_logo_padding_top"
                        type="number"
                        value={formData.header_config?.logoPaddingTop || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoPaddingTop: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-padding-top"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_padding_right" className="text-slate-400 text-xs">Right</Label>
                      <Input
                        id="header_logo_padding_right"
                        type="number"
                        value={formData.header_config?.logoPaddingRight || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoPaddingRight: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-padding-right"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_padding_bottom" className="text-slate-400 text-xs">Bottom</Label>
                      <Input
                        id="header_logo_padding_bottom"
                        type="number"
                        value={formData.header_config?.logoPaddingBottom || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoPaddingBottom: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-padding-bottom"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_padding_left" className="text-slate-400 text-xs">Left</Label>
                      <Input
                        id="header_logo_padding_left"
                        type="number"
                        value={formData.header_config?.logoPaddingLeft || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoPaddingLeft: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-padding-left"
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-4">
                  <Label className="text-slate-200 mb-2 block">Border Radius (px per corner)</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_border_radius_tl" className="text-slate-400 text-xs">Top Left</Label>
                      <Input
                        id="header_logo_border_radius_tl"
                        type="number"
                        value={formData.header_config?.logoBorderRadiusTopLeft || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderRadiusTopLeft: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-border-radius-tl"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_border_radius_tr" className="text-slate-400 text-xs">Top Right</Label>
                      <Input
                        id="header_logo_border_radius_tr"
                        type="number"
                        value={formData.header_config?.logoBorderRadiusTopRight || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderRadiusTopRight: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-border-radius-tr"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_border_radius_bl" className="text-slate-400 text-xs">Bottom Left</Label>
                      <Input
                        id="header_logo_border_radius_bl"
                        type="number"
                        value={formData.header_config?.logoBorderRadiusBottomLeft || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderRadiusBottomLeft: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-border-radius-bl"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_border_radius_br" className="text-slate-400 text-xs">Bottom Right</Label>
                      <Input
                        id="header_logo_border_radius_br"
                        type="number"
                        value={formData.header_config?.logoBorderRadiusBottomRight || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderRadiusBottomRight: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-border-radius-br"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="header_logo_shadow" className="text-slate-200">Shadow Effect</Label>
                    <Select
                      value={formData.header_config?.logoShadow || 'none'}
                      onValueChange={(value) => setFormData({ 
                        ...formData, 
                        header_config: { 
                          ...formData.header_config, 
                          logoShadow: value 
                        } 
                      })}
                    >
                      <SelectTrigger className="bg-slate-900/50 border-slate-600 text-white" data-testid="select-header-logo-shadow">
                        <SelectValue placeholder="Select shadow" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="sm">Small</SelectItem>
                        <SelectItem value="md">Medium</SelectItem>
                        <SelectItem value="lg">Large</SelectItem>
                        <SelectItem value="xl">Extra Large</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="border-t border-slate-700 pt-4 mt-4">
                  <h4 className="text-white font-medium mb-4">Logo Position</h4>
                  <p className="text-xs text-slate-500 mb-4">Adjust the logo position from the top-left corner. By default the logo sits flush with the top of the page.</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="header_logo_margin_top" className="text-slate-200">Margin Top (px)</Label>
                      <Input
                        id="header_logo_margin_top"
                        type="number"
                        value={formData.header_config?.logoMarginTop || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoMarginTop: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-margin-top"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="header_logo_margin_left" className="text-slate-200">Margin Left (px)</Label>
                      <Input
                        id="header_logo_margin_left"
                        type="number"
                        value={formData.header_config?.logoMarginLeft || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoMarginLeft: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-margin-left"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="header_logo_border_width" className="text-slate-200">Border Width (px)</Label>
                    <Input
                      id="header_logo_border_width"
                      type="number"
                      value={formData.header_config?.logoBorderWidth || ''}
                      onChange={(e) => setFormData({ 
                        ...formData, 
                        header_config: { 
                          ...formData.header_config, 
                          logoBorderWidth: e.target.value 
                        } 
                      })}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="0"
                      data-testid="input-header-logo-border-width"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="header_logo_border_color" className="text-slate-200">Border Color</Label>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        id="header_logo_border_color_picker"
                        value={formData.header_config?.logoBorderColor || '#000000'}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderColor: e.target.value 
                          } 
                        })}
                        className="w-12 h-10 rounded cursor-pointer"
                        data-testid="input-header-logo-border-color-picker"
                      />
                      <Input
                        id="header_logo_border_color"
                        value={formData.header_config?.logoBorderColor || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderColor: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white flex-1"
                        placeholder="#000000"
                        data-testid="input-header-logo-border-color"
                      />
                    </div>
                  </div>
                </div>

                {(formData.header_config?.logoBackground || formData.header_config?.logoBorderRadiusTopLeft || formData.header_config?.logoBorderRadiusTopRight || formData.header_config?.logoBorderRadiusBottomLeft || formData.header_config?.logoBorderRadiusBottomRight || formData.header_config?.logoBorderWidth || formData.header_config?.logoShadow !== 'none' || formData.header_config?.logoPadding || formData.header_config?.logoPaddingTop || formData.header_config?.logoPaddingRight || formData.header_config?.logoPaddingBottom || formData.header_config?.logoPaddingLeft || formData.header_config?.logoMarginTop || formData.header_config?.logoMarginLeft) && formData.header_logo_url && (
                  <div className="mt-4 p-4 bg-slate-900/50 rounded-lg">
                    <Label className="text-slate-200 mb-2 block">Preview</Label>
                    <div className="flex justify-center">
                      <div
                        style={{
                          backgroundColor: formData.header_config?.logoBackground || 'transparent',
                          borderTopLeftRadius: formData.header_config?.logoBorderRadiusTopLeft ? `${formData.header_config.logoBorderRadiusTopLeft}px` : '0',
                          borderTopRightRadius: formData.header_config?.logoBorderRadiusTopRight ? `${formData.header_config.logoBorderRadiusTopRight}px` : '0',
                          borderBottomLeftRadius: formData.header_config?.logoBorderRadiusBottomLeft ? `${formData.header_config.logoBorderRadiusBottomLeft}px` : '0',
                          borderBottomRightRadius: formData.header_config?.logoBorderRadiusBottomRight ? `${formData.header_config.logoBorderRadiusBottomRight}px` : '0',
                          borderWidth: formData.header_config?.logoBorderWidth ? `${formData.header_config.logoBorderWidth}px` : '0',
                          borderStyle: formData.header_config?.logoBorderWidth ? 'solid' : 'none',
                          borderColor: formData.header_config?.logoBorderColor || '#000000',
                          paddingTop: (formData.header_config?.logoPaddingTop || formData.header_config?.logoPadding) ? `${formData.header_config.logoPaddingTop || formData.header_config.logoPadding}px` : '0',
                          paddingRight: (formData.header_config?.logoPaddingRight || formData.header_config?.logoPadding) ? `${formData.header_config.logoPaddingRight || formData.header_config.logoPadding}px` : '0',
                          paddingBottom: (formData.header_config?.logoPaddingBottom || formData.header_config?.logoPadding) ? `${formData.header_config.logoPaddingBottom || formData.header_config.logoPadding}px` : '0',
                          paddingLeft: (formData.header_config?.logoPaddingLeft || formData.header_config?.logoPadding) ? `${formData.header_config.logoPaddingLeft || formData.header_config.logoPadding}px` : '0',
                          marginTop: formData.header_config?.logoMarginTop ? `${formData.header_config.logoMarginTop}px` : '0',
                          marginLeft: formData.header_config?.logoMarginLeft ? `${formData.header_config.logoMarginLeft}px` : '0',
                          boxShadow: formData.header_config?.logoShadow === 'sm' ? '0 1px 2px 0 rgb(0 0 0 / 0.05)' :
                                     formData.header_config?.logoShadow === 'md' ? '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)' :
                                     formData.header_config?.logoShadow === 'lg' ? '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)' :
                                     formData.header_config?.logoShadow === 'xl' ? '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)' : 'none'
                        }}
                      >
                        <img 
                          src={formData.header_logo_url} 
                          alt="Logo Preview" 
                          style={{
                            height: formData.header_config?.logoHeight ? `${Math.min(parseInt(formData.header_config.logoHeight), 80)}px` : '80px',
                            width: 'auto',
                            objectFit: 'contain'
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <LayoutTemplate className="w-5 h-5" />
                Portal Sidebar
              </CardTitle>
              <CardDescription className="text-slate-400">
                Brand the left navigation pane of the logged-in member portal: background, text &amp; icon colours, the selected-item treatment, and the portal-wide font. Leave fields blank to keep the current defaults.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* ---- Controls ---- */}
                <div className="space-y-6">
                  {/* Background type */}
                  <div className="space-y-2">
                    <Label className="text-slate-300">Background</Label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { value: 'solid', label: 'Solid colour' },
                        { value: 'image', label: 'Image' },
                        { value: 'gradient', label: 'Gradient' }
                      ].map((opt) => (
                        <Button
                          key={opt.value}
                          type="button"
                          variant={portalNavBg.type === opt.value ? 'default' : 'outline'}
                          size="sm"
                          className={portalNavBg.type === opt.value ? '' : 'border-slate-600 text-slate-300'}
                          onClick={() => setPortalNavBg({ type: opt.value })}
                          data-testid={`button-portalnav-bgtype-${opt.value}`}
                        >
                          {opt.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {portalNavBg.type === 'solid' && (
                    <div className="space-y-2">
                      <Label className="text-slate-300">Background colour</Label>
                      <div className="flex items-center gap-3">
                        <input
                          type="color"
                          value={portalNavBg.solidColor || '#1e293b'}
                          onChange={(e) => setPortalNavBg({ solidColor: e.target.value })}
                          className="w-12 h-9 rounded cursor-pointer"
                          data-testid="color-portalnav-solid"
                        />
                        <Input
                          value={portalNavBg.solidColor || ''}
                          placeholder="Default (theme)"
                          onChange={(e) => setPortalNavBg({ solidColor: e.target.value })}
                          className="bg-slate-900 border-slate-700 text-white font-mono"
                          data-testid="input-portalnav-solid"
                        />
                      </div>
                    </div>
                  )}

                  {portalNavBg.type === 'image' && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-slate-300">Image</Label>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            ref={portalNavImageInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handlePortalNavImageUpload}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="border-slate-600 text-slate-300"
                            disabled={uploadingPortalNavImage}
                            onClick={() => portalNavImageInputRef.current?.click()}
                            data-testid="button-portalnav-upload"
                          >
                            {uploadingPortalNavImage ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                            Upload image
                          </Button>
                          {portalNavBg.imageUrl && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-slate-400"
                              onClick={() => setPortalNavBg({ imageUrl: '' })}
                              data-testid="button-portalnav-clear-image"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Remove
                            </Button>
                          )}
                        </div>
                        <Input
                          value={portalNavBg.imageUrl || ''}
                          placeholder="https://… image URL"
                          onChange={(e) => setPortalNavBg({ imageUrl: e.target.value })}
                          className="bg-slate-900 border-slate-700 text-white"
                          data-testid="input-portalnav-image-url"
                        />
                      </div>

                      {portalNavBg.imageUrl && (
                        <div className="space-y-2">
                          <Label className="text-slate-300">Focal point</Label>
                          <FocalPointPicker
                            imageUrl={portalNavBg.imageUrl}
                            focalPoint={portalNavBg.focalPoint || { x: 50, y: 50 }}
                            onChange={(fp) => setPortalNavBg({ focalPoint: fp })}
                          />
                        </div>
                      )}

                      <div className="space-y-2">
                        <Label className="text-slate-300">Overlay</Label>
                        <div className="flex flex-wrap gap-2">
                          {[
                            { value: 'solid', label: 'Wash' },
                            { value: 'gradient', label: 'Gradient' }
                          ].map((opt) => (
                            <Button
                              key={opt.value}
                              type="button"
                              variant={(portalNavBg.overlayStyle || 'solid') === opt.value ? 'default' : 'outline'}
                              size="sm"
                              className={(portalNavBg.overlayStyle || 'solid') === opt.value ? '' : 'border-slate-600 text-slate-300'}
                              onClick={() => setPortalNavBg({ overlayStyle: opt.value })}
                              data-testid={`button-portalnav-overlay-${opt.value}`}
                            >
                              {opt.label}
                            </Button>
                          ))}
                        </div>
                      </div>

                      {(portalNavBg.overlayStyle || 'solid') === 'solid' ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <Label className="text-slate-300">Dark wash strength</Label>
                            <span className="text-slate-400 text-sm">{Math.round((portalNavBg.darkWash ?? 0.4) * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value={Math.round((portalNavBg.darkWash ?? 0.4) * 100)}
                            onChange={(e) => setPortalNavBg({ darkWash: parseInt(e.target.value, 10) / 100 })}
                            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                            data-testid="slider-portalnav-darkwash"
                          />
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="space-y-2">
                            <Label className="text-slate-300">Overlay direction</Label>
                            <Select
                              value={portalNavBg.overlayDirection || 'to-top'}
                              onValueChange={(v) => setPortalNavBg({ overlayDirection: v })}
                            >
                              <SelectTrigger className="bg-slate-900 border-slate-700 text-white" data-testid="select-portalnav-overlay-direction">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="to-top">To top</SelectItem>
                                <SelectItem value="to-bottom">To bottom</SelectItem>
                                <SelectItem value="to-right">To right</SelectItem>
                                <SelectItem value="to-left">To left</SelectItem>
                                <SelectItem value="to-bottom-right">To bottom-right</SelectItem>
                                <SelectItem value="to-top-right">To top-right</SelectItem>
                                <SelectItem value="custom">Custom angle</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {portalNavBg.overlayDirection === 'custom' && (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label className="text-slate-300">Angle</Label>
                                <span className="text-slate-400 text-sm">{portalNavBg.overlayAngle ?? 0}°</span>
                              </div>
                              <input
                                type="range"
                                min="0"
                                max="360"
                                value={portalNavBg.overlayAngle ?? 0}
                                onChange={(e) => setPortalNavBg({ overlayAngle: parseInt(e.target.value, 10) })}
                                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                                data-testid="slider-portalnav-overlay-angle"
                              />
                            </div>
                          )}
                          <OpacityStopsEditor
                            stops={portalNavBg.overlayStops}
                            onChange={(stops) => setPortalNavBg({ overlayStops: stops })}
                            testIdPrefix="portalnav-overlay"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {portalNavBg.type === 'gradient' && (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label className="text-slate-300">Gradient type</Label>
                        <div className="flex flex-wrap gap-2">
                          {[
                            { value: 'linear', label: 'Linear' },
                            { value: 'radial', label: 'Radial' }
                          ].map((opt) => (
                            <Button
                              key={opt.value}
                              type="button"
                              variant={(portalNavBg.gradientType || 'linear') === opt.value ? 'default' : 'outline'}
                              size="sm"
                              className={(portalNavBg.gradientType || 'linear') === opt.value ? '' : 'border-slate-600 text-slate-300'}
                              onClick={() => setPortalNavBg({ gradientType: opt.value })}
                              data-testid={`button-portalnav-gradient-${opt.value}`}
                            >
                              {opt.label}
                            </Button>
                          ))}
                        </div>
                      </div>
                      {(portalNavBg.gradientType || 'linear') === 'linear' && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <Label className="text-slate-300">Angle</Label>
                            <span className="text-slate-400 text-sm">{portalNavBg.gradientAngle ?? 180}°</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="360"
                            value={portalNavBg.gradientAngle ?? 180}
                            onChange={(e) => setPortalNavBg({ gradientAngle: parseInt(e.target.value, 10) })}
                            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                            data-testid="slider-portalnav-gradient-angle"
                          />
                        </div>
                      )}
                      <OpacityStopsEditor
                        stops={portalNavBg.gradientStops}
                        onChange={(stops) => setPortalNavBg({ gradientStops: stops })}
                        testIdPrefix="portalnav-gradient"
                      />
                    </div>
                  )}

                  {/* Colours */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-700">
                    {[
                      { key: 'textColor', label: 'Nav text colour' },
                      { key: 'iconColor', label: 'Nav icon colour' },
                      { key: 'activeBackgroundColor', label: 'Selected background' },
                      { key: 'activeTextColor', label: 'Selected text colour' },
                      { key: 'activeIconColor', label: 'Selected icon colour' },
                      { key: 'hoverBackgroundColor', label: 'Hover background' },
                      { key: 'hoverTextColor', label: 'Hover text' }
                    ].map((f) => (
                      <div key={f.key} className="space-y-2">
                        <Label className="text-slate-300">{f.label}</Label>
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={portalNav[f.key] || '#000000'}
                            onChange={(e) => setPortalNav({ [f.key]: e.target.value })}
                            className="w-10 h-9 rounded cursor-pointer flex-shrink-0"
                            data-testid={`color-portalnav-${f.key}`}
                          />
                          <Input
                            value={portalNav[f.key] || ''}
                            placeholder="Default"
                            onChange={(e) => setPortalNav({ [f.key]: e.target.value })}
                            className="bg-slate-900 border-slate-700 text-white font-mono"
                            data-testid={`input-portalnav-${f.key}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Current user card */}
                  <div className="space-y-4 pt-2 border-t border-slate-700">
                    <div>
                      <Label className="text-slate-300">Current user card</Label>
                      <p className="text-slate-500 text-xs">The signed-in member box at the bottom of the sidebar.</p>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-slate-300">Background</Label>
                      <div className="flex flex-wrap gap-2">
                        {[
                          { value: 'solid', label: 'Solid colour' },
                          { value: 'gradient', label: 'Gradient' }
                        ].map((opt) => (
                          <Button
                            key={opt.value}
                            type="button"
                            variant={(userCardBg.type || 'solid') === opt.value ? 'default' : 'outline'}
                            size="sm"
                            className={(userCardBg.type || 'solid') === opt.value ? '' : 'border-slate-600 text-slate-300'}
                            onClick={() => setUserCardBg({ type: opt.value })}
                            data-testid={`button-usercard-bgtype-${opt.value}`}
                          >
                            {opt.label}
                          </Button>
                        ))}
                      </div>
                    </div>

                    {(userCardBg.type || 'solid') === 'solid' && (
                      <div className="space-y-2">
                        <Label className="text-slate-300">Background colour</Label>
                        <div className="flex items-center gap-3">
                          <input
                            type="color"
                            value={userCardBg.solidColor || '#f1f5f9'}
                            onChange={(e) => setUserCardBg({ solidColor: e.target.value })}
                            className="w-12 h-9 rounded cursor-pointer"
                            data-testid="color-usercard-solid"
                          />
                          <Input
                            value={userCardBg.solidColor || ''}
                            placeholder="Default (light grey)"
                            onChange={(e) => setUserCardBg({ solidColor: e.target.value })}
                            className="bg-slate-900 border-slate-700 text-white font-mono"
                            data-testid="input-usercard-solid"
                          />
                        </div>
                      </div>
                    )}

                    {(userCardBg.type || 'solid') === 'gradient' && (
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <Label className="text-slate-300">Gradient type</Label>
                          <div className="flex flex-wrap gap-2">
                            {[
                              { value: 'linear', label: 'Linear' },
                              { value: 'radial', label: 'Radial' }
                            ].map((opt) => (
                              <Button
                                key={opt.value}
                                type="button"
                                variant={(userCardBg.gradientType || 'linear') === opt.value ? 'default' : 'outline'}
                                size="sm"
                                className={(userCardBg.gradientType || 'linear') === opt.value ? '' : 'border-slate-600 text-slate-300'}
                                onClick={() => setUserCardBg({ gradientType: opt.value })}
                                data-testid={`button-usercard-gradient-${opt.value}`}
                              >
                                {opt.label}
                              </Button>
                            ))}
                          </div>
                        </div>
                        {(userCardBg.gradientType || 'linear') === 'linear' && (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <Label className="text-slate-300">Angle</Label>
                              <span className="text-slate-400 text-sm">{userCardBg.gradientAngle ?? 180}°</span>
                            </div>
                            <input
                              type="range"
                              min="0"
                              max="360"
                              value={userCardBg.gradientAngle ?? 180}
                              onChange={(e) => setUserCardBg({ gradientAngle: parseInt(e.target.value, 10) })}
                              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                              data-testid="slider-usercard-gradient-angle"
                            />
                          </div>
                        )}
                        <OpacityStopsEditor
                          stops={userCardBg.gradientStops}
                          onChange={(stops) => setUserCardBg({ gradientStops: stops })}
                          testIdPrefix="usercard-gradient"
                        />
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label className="text-slate-300">Text colour</Label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={userCard.textColor || '#0f172a'}
                          onChange={(e) => setUserCard({ textColor: e.target.value })}
                          className="w-10 h-9 rounded cursor-pointer flex-shrink-0"
                          data-testid="color-usercard-text"
                        />
                        <Input
                          value={userCard.textColor || ''}
                          placeholder="Default"
                          onChange={(e) => setUserCard({ textColor: e.target.value })}
                          className="bg-slate-900 border-slate-700 text-white font-mono"
                          data-testid="input-usercard-text"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-slate-300">Card preview</Label>
                      <div
                        className="rounded-lg p-3 max-w-[260px]"
                        style={
                          Object.keys(buildPortalNavBackgroundStyle(userCardBg)).length
                            ? buildPortalNavBackgroundStyle(userCardBg)
                            : { backgroundColor: '#f1f5f9' }
                        }
                        data-testid="preview-usercard"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <User className="w-4 h-4" style={{ color: userCard.textColor || '#64748b' }} />
                          <span className="text-sm font-medium" style={{ color: userCard.textColor || '#0f172a' }}>Jane Smith</span>
                        </div>
                        <p className="text-xs truncate" style={{ color: userCard.textColor || '#64748b' }}>jane@example.com</p>
                      </div>
                    </div>
                  </div>

                  {/* Base portal font */}
                  <div className="space-y-2 pt-2 border-t border-slate-700">
                    <Label className="text-slate-300">Base portal font</Label>
                    <Select
                      value={formData.branding_config?.basePortalFont || 'default'}
                      onValueChange={(v) => setFormData(prev => ({
                        ...prev,
                        branding_config: { ...prev.branding_config, basePortalFont: v === 'default' ? '' : v }
                      }))}
                    >
                      <SelectTrigger className="bg-slate-900 border-slate-700 text-white" data-testid="select-portalnav-font">
                        <SelectValue placeholder="Default" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default</SelectItem>
                        {NAV_AVAILABLE_FONTS.map((f) => (
                          <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-slate-500 text-xs">Applied across the whole logged-in portal.</p>
                  </div>
                </div>

                {/* ---- Live preview ---- */}
                <div className="space-y-2">
                  <Label className="text-slate-300">Preview</Label>
                  <div
                    className="rounded-md overflow-hidden border border-slate-700 w-full max-w-[260px]"
                    style={{
                      fontFamily: formData.branding_config?.basePortalFont || undefined,
                      ...(Object.keys(buildPortalNavBackgroundStyle(portalNavBg)).length
                        ? buildPortalNavBackgroundStyle(portalNavBg)
                        : { backgroundColor: '#0f172a' })
                    }}
                    data-testid="preview-portalnav"
                  >
                    {(portalNav.hoverBackgroundColor || portalNav.hoverTextColor) && (
                      <style>{`
                        .portalnav-preview-item:hover {
                          ${portalNav.hoverBackgroundColor ? `background-color: ${portalNav.hoverBackgroundColor} !important;` : ''}
                          ${portalNav.hoverTextColor ? `color: ${portalNav.hoverTextColor} !important;` : ''}
                        }
                        ${portalNav.hoverTextColor ? `.portalnav-preview-item:hover svg { color: ${portalNav.hoverTextColor} !important; }` : ''}
                      `}</style>
                    )}
                    <div className="p-3 space-y-1">
                      {[
                        { label: 'Dashboard', active: false },
                        { label: 'Events', active: true },
                        { label: 'Members', active: false },
                        { label: 'Resources', active: false }
                      ].map((item) => {
                        const isActive = item.active;
                        const itemStyle = isActive
                          ? {
                              backgroundColor: portalNav.activeBackgroundColor || 'rgba(255,255,255,0.15)',
                              color: portalNav.activeTextColor || portalNav.textColor || '#ffffff'
                            }
                          : { color: portalNav.textColor || '#e2e8f0' };
                        const iconColor = isActive
                          ? (portalNav.activeIconColor || portalNav.activeTextColor || portalNav.iconColor || portalNav.textColor || '#ffffff')
                          : (portalNav.iconColor || portalNav.textColor || '#cbd5e1');
                        return (
                          <div
                            key={item.label}
                            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm${isActive ? '' : ' portalnav-preview-item'}`}
                            style={itemStyle}
                          >
                            <LayoutTemplate className="w-4 h-4" style={{ color: iconColor }} />
                            <span>{item.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <LayoutTemplate className="w-5 h-5" />
                Portal Page Background
              </CardTitle>
              <CardDescription className="text-slate-400">
                Brand the main content area behind every logged-in member portal page (Dashboard, Events, Bookings, Members &amp; more). The default reproduces the standard slate-to-blue gradient; pick a solid colour, an image with a wash, or a custom gradient.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* ---- Controls ---- */}
                <div className="space-y-6">
                  {/* Background type */}
                  <div className="space-y-2">
                    <Label className="text-slate-300">Background</Label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { value: 'solid', label: 'Solid colour' },
                        { value: 'image', label: 'Image' },
                        { value: 'gradient', label: 'Gradient' }
                      ].map((opt) => (
                        <Button
                          key={opt.value}
                          type="button"
                          variant={pageBg.type === opt.value ? 'default' : 'outline'}
                          size="sm"
                          className={pageBg.type === opt.value ? '' : 'border-slate-600 text-slate-300'}
                          onClick={() => setPageBg({ type: opt.value })}
                          data-testid={`button-portalpage-bgtype-${opt.value}`}
                        >
                          {opt.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {pageBg.type === 'solid' && (
                    <div className="space-y-2">
                      <Label className="text-slate-300">Background colour</Label>
                      <div className="flex items-center gap-3">
                        <input
                          type="color"
                          value={pageBg.solidColor || '#f8fafc'}
                          onChange={(e) => setPageBg({ solidColor: e.target.value })}
                          className="w-12 h-9 rounded cursor-pointer"
                          data-testid="color-portalpage-solid"
                        />
                        <Input
                          value={pageBg.solidColor || ''}
                          placeholder="Default (theme)"
                          onChange={(e) => setPageBg({ solidColor: e.target.value })}
                          className="bg-slate-900 border-slate-700 text-white font-mono"
                          data-testid="input-portalpage-solid"
                        />
                      </div>
                    </div>
                  )}

                  {pageBg.type === 'image' && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-slate-300">Image</Label>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            ref={portalPageImageInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handlePortalPageImageUpload}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="border-slate-600 text-slate-300"
                            disabled={uploadingPortalPageImage}
                            onClick={() => portalPageImageInputRef.current?.click()}
                            data-testid="button-portalpage-upload"
                          >
                            {uploadingPortalPageImage ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                            Upload image
                          </Button>
                          {pageBg.imageUrl && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-slate-400"
                              onClick={() => setPageBg({ imageUrl: '' })}
                              data-testid="button-portalpage-clear-image"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Remove
                            </Button>
                          )}
                        </div>
                        <Input
                          value={pageBg.imageUrl || ''}
                          placeholder="https://… image URL"
                          onChange={(e) => setPageBg({ imageUrl: e.target.value })}
                          className="bg-slate-900 border-slate-700 text-white"
                          data-testid="input-portalpage-image-url"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label className="text-slate-300">Base colour (behind image)</Label>
                        <p className="text-xs text-slate-400">Shown beneath the image — use a transparent image on top for subtle effects.</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            type="color"
                            value={pageBg.solidColor || '#f8fafc'}
                            onChange={(e) => setPageBg({ solidColor: e.target.value })}
                            className="w-12 h-9 p-1 bg-slate-900 border-slate-700"
                            data-testid="input-portalpage-base-color"
                          />
                          <Input
                            value={pageBg.solidColor || ''}
                            placeholder="#f8fafc"
                            onChange={(e) => setPageBg({ solidColor: e.target.value })}
                            className="w-32 bg-slate-900 border-slate-700 text-white"
                            data-testid="input-portalpage-base-color-hex"
                          />
                        </div>
                      </div>

                      {pageBg.imageUrl && (
                        <div className="space-y-2">
                          <Label className="text-slate-300">Focal point</Label>
                          <FocalPointPicker
                            imageUrl={pageBg.imageUrl}
                            focalPoint={pageBg.focalPoint || { x: 50, y: 50 }}
                            onChange={(fp) => setPageBg({ focalPoint: fp })}
                          />
                        </div>
                      )}

                      <div className="space-y-2">
                        <Label className="text-slate-300">Overlay</Label>
                        <div className="flex flex-wrap gap-2">
                          {[
                            { value: 'solid', label: 'Wash' },
                            { value: 'gradient', label: 'Gradient' }
                          ].map((opt) => (
                            <Button
                              key={opt.value}
                              type="button"
                              variant={(pageBg.overlayStyle || 'solid') === opt.value ? 'default' : 'outline'}
                              size="sm"
                              className={(pageBg.overlayStyle || 'solid') === opt.value ? '' : 'border-slate-600 text-slate-300'}
                              onClick={() => setPageBg({ overlayStyle: opt.value })}
                              data-testid={`button-portalpage-overlay-${opt.value}`}
                            >
                              {opt.label}
                            </Button>
                          ))}
                        </div>
                      </div>

                      {(pageBg.overlayStyle || 'solid') === 'solid' ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <Label className="text-slate-300">Dark wash strength</Label>
                            <span className="text-slate-400 text-sm">{Math.round((pageBg.darkWash ?? 0.4) * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value={Math.round((pageBg.darkWash ?? 0.4) * 100)}
                            onChange={(e) => setPageBg({ darkWash: parseInt(e.target.value, 10) / 100 })}
                            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                            data-testid="slider-portalpage-darkwash"
                          />
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="space-y-2">
                            <Label className="text-slate-300">Overlay direction</Label>
                            <Select
                              value={pageBg.overlayDirection || 'to-top'}
                              onValueChange={(v) => setPageBg({ overlayDirection: v })}
                            >
                              <SelectTrigger className="bg-slate-900 border-slate-700 text-white" data-testid="select-portalpage-overlay-direction">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="to-top">To top</SelectItem>
                                <SelectItem value="to-bottom">To bottom</SelectItem>
                                <SelectItem value="to-right">To right</SelectItem>
                                <SelectItem value="to-left">To left</SelectItem>
                                <SelectItem value="to-bottom-right">To bottom-right</SelectItem>
                                <SelectItem value="to-top-right">To top-right</SelectItem>
                                <SelectItem value="custom">Custom angle</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {pageBg.overlayDirection === 'custom' && (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label className="text-slate-300">Angle</Label>
                                <span className="text-slate-400 text-sm">{pageBg.overlayAngle ?? 0}°</span>
                              </div>
                              <input
                                type="range"
                                min="0"
                                max="360"
                                value={pageBg.overlayAngle ?? 0}
                                onChange={(e) => setPageBg({ overlayAngle: parseInt(e.target.value, 10) })}
                                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                                data-testid="slider-portalpage-overlay-angle"
                              />
                            </div>
                          )}
                          <OpacityStopsEditor
                            stops={pageBg.overlayStops}
                            onChange={(stops) => setPageBg({ overlayStops: stops })}
                            testIdPrefix="portalpage-overlay"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {pageBg.type === 'gradient' && (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label className="text-slate-300">Gradient type</Label>
                        <div className="flex flex-wrap gap-2">
                          {[
                            { value: 'linear', label: 'Linear' },
                            { value: 'radial', label: 'Radial' }
                          ].map((opt) => (
                            <Button
                              key={opt.value}
                              type="button"
                              variant={(pageBg.gradientType || 'linear') === opt.value ? 'default' : 'outline'}
                              size="sm"
                              className={(pageBg.gradientType || 'linear') === opt.value ? '' : 'border-slate-600 text-slate-300'}
                              onClick={() => setPageBg({ gradientType: opt.value })}
                              data-testid={`button-portalpage-gradient-${opt.value}`}
                            >
                              {opt.label}
                            </Button>
                          ))}
                        </div>
                      </div>
                      {(pageBg.gradientType || 'linear') === 'linear' && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <Label className="text-slate-300">Angle</Label>
                            <span className="text-slate-400 text-sm">{pageBg.gradientAngle ?? 135}°</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="360"
                            value={pageBg.gradientAngle ?? 135}
                            onChange={(e) => setPageBg({ gradientAngle: parseInt(e.target.value, 10) })}
                            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                            data-testid="slider-portalpage-gradient-angle"
                          />
                        </div>
                      )}
                      <OpacityStopsEditor
                        stops={pageBg.gradientStops}
                        onChange={(stops) => setPageBg({ gradientStops: stops })}
                        testIdPrefix="portalpage-gradient"
                      />
                    </div>
                  )}
                </div>

                {/* ---- Live preview ---- */}
                <div className="space-y-2">
                  <Label className="text-slate-300">Preview</Label>
                  <div
                    className="rounded-md overflow-hidden border border-slate-700 w-full min-h-[220px] p-4"
                    style={
                      Object.keys(buildPortalNavBackgroundStyle(pageBg)).length
                        ? buildPortalNavBackgroundStyle(pageBg)
                        : { backgroundImage: 'linear-gradient(135deg, #f8fafc, #eff6ff)' }
                    }
                    data-testid="preview-portalpage"
                  >
                    <div className="rounded-md bg-white/90 border border-slate-200 p-3 max-w-[240px] shadow-sm">
                      <div className="h-3 w-24 rounded bg-slate-300 mb-2" />
                      <div className="h-2 w-full rounded bg-slate-200 mb-1.5" />
                      <div className="h-2 w-2/3 rounded bg-slate-200" />
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Palette className="w-5 h-5" />
                Header Gradient Colors
              </CardTitle>
              <CardDescription className="text-slate-400">
                Customize the gradient colors and their positions in the navigation header bar
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-slate-300">Top Navigation Bar Height (px)</Label>
                <Input
                  type="number"
                  min="20"
                  max="300"
                  placeholder="Default"
                  value={formData.header_config?.topBarHeight ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setFormData(prev => ({
                      ...prev,
                      header_config: { ...prev.header_config, topBarHeight: val === '' ? '' : parseInt(val, 10) }
                    }));
                  }}
                  className="bg-slate-900 border-slate-600 text-white"
                  data-testid="input-top-bar-height"
                />
                <p className="text-xs text-slate-500">Sets the height of the gradient top bar. Leave blank to use the default size.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-slate-300">Link Text Color</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={formData.header_config?.topNavTextColor || '#FFFFFF'}
                      onChange={(e) => {
                        setFormData(prev => ({
                          ...prev,
                          header_config: { ...prev.header_config, topNavTextColor: e.target.value }
                        }));
                      }}
                      className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                      data-testid="input-top-nav-text-color"
                    />
                    <Input
                      type="text"
                      placeholder="#FFFFFF"
                      value={formData.header_config?.topNavTextColor || ''}
                      onChange={(e) => {
                        setFormData(prev => ({
                          ...prev,
                          header_config: { ...prev.header_config, topNavTextColor: e.target.value }
                        }));
                      }}
                      className="bg-slate-900 border-slate-600 text-white font-mono"
                      data-testid="input-top-nav-text-color-hex"
                    />
                  </div>
                  <p className="text-xs text-slate-500">Color of the top bar menu link text. Defaults to white.</p>
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-300">Link Font Size (px)</Label>
                  <Input
                    type="number"
                    min="8"
                    max="48"
                    placeholder="14"
                    value={formData.header_config?.topNavFontSize ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setFormData(prev => ({
                        ...prev,
                        header_config: { ...prev.header_config, topNavFontSize: val === '' ? '' : parseInt(val, 10) }
                      }));
                    }}
                    className="bg-slate-900 border-slate-600 text-white"
                    data-testid="input-top-nav-font-size"
                  />
                  <p className="text-xs text-slate-500">Size of the top bar menu link text. Leave blank for default.</p>
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-300">Link Hover Color</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={formData.header_config?.topNavHoverColor || '#FFFFFF'}
                      onChange={(e) => {
                        setFormData(prev => ({
                          ...prev,
                          header_config: { ...prev.header_config, topNavHoverColor: e.target.value }
                        }));
                      }}
                      className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                      data-testid="input-top-nav-hover-color"
                    />
                    <Input
                      type="text"
                      placeholder="No hover change"
                      value={formData.header_config?.topNavHoverColor || ''}
                      onChange={(e) => {
                        setFormData(prev => ({
                          ...prev,
                          header_config: { ...prev.header_config, topNavHoverColor: e.target.value }
                        }));
                      }}
                      className="bg-slate-900 border-slate-600 text-white font-mono"
                      data-testid="input-top-nav-hover-color-hex"
                    />
                  </div>
                  <p className="text-xs text-slate-500">Color links change to on hover. Leave blank to keep current behavior.</p>
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-300">Link Font Weight</Label>
                  <Select
                    value={formData.header_config?.topNavFontWeight ? String(formData.header_config.topNavFontWeight) : 'default'}
                    onValueChange={(val) => {
                      setFormData(prev => ({
                        ...prev,
                        header_config: { ...prev.header_config, topNavFontWeight: val === 'default' ? '' : parseInt(val, 10) }
                      }));
                    }}
                  >
                    <SelectTrigger className="bg-slate-900 border-slate-600 text-white" data-testid="select-top-nav-font-weight">
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {NAV_FONT_WEIGHTS.map((w) => (
                        <SelectItem key={w.value} value={String(w.value)}>{w.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">Weight of the top bar menu link text. Leave at default to keep current styling.</p>
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-300">Base Font Family</Label>
                  <Select
                    value={formData.header_config?.topNavFontFamily || 'default'}
                    onValueChange={(val) => {
                      setFormData(prev => ({
                        ...prev,
                        header_config: { ...prev.header_config, topNavFontFamily: val === 'default' ? '' : val }
                      }));
                    }}
                  >
                    <SelectTrigger className="bg-slate-900 border-slate-600 text-white" data-testid="select-top-nav-font-family">
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {NAV_AVAILABLE_FONTS.map((f) => (
                        <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">Font family for the top bar menu links. Leave at default to keep current styling.</p>
                </div>
              </div>
              <IndicatorEditor
                value={formData.header_config?.topNavIndicator}
                onChange={(ind) => setFormData(prev => ({
                  ...prev,
                  header_config: { ...prev.header_config, topNavIndicator: ind }
                }))}
                testIdPrefix="top-nav-indicator"
              />
              <div className="space-y-2">
                <Label className="text-slate-300">Search Display</Label>
                <Select
                  value={['icon', 'label', 'both'].includes(formData.header_config?.searchDisplay) ? formData.header_config.searchDisplay : 'both'}
                  onValueChange={(val) => {
                    setFormData(prev => ({
                      ...prev,
                      header_config: { ...prev.header_config, searchDisplay: val }
                    }));
                  }}
                >
                  <SelectTrigger className="bg-slate-900 border-slate-600 text-white" data-testid="select-search-display">
                    <SelectValue placeholder="Spy glass and label" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="icon">Spy glass only</SelectItem>
                    <SelectItem value="label">Label only</SelectItem>
                    <SelectItem value="both">Spy glass and label</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500">How the top bar Search control is shown. This only changes its appearance — turn Search on or off under Navigation → Header Icons. The Search control follows the top bar link styling above.</p>
              </div>
              <div className="space-y-1">
                <Label className="text-slate-300 text-xs">Live Preview</Label>
                <div
                  className="rounded-lg border border-slate-600 overflow-hidden flex"
                  style={{
                    minHeight: `${Math.min(Math.max(parseInt(formData.header_config?.topBarHeight, 10) || 48, 24), 120)}px`,
                    background: `linear-gradient(to right, ${(formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS)
                      .slice()
                      .sort((a, b) => a.position - b.position)
                      .map(stop => `${stop.color} ${stop.position}%`)
                      .join(', ')})`
                  }}
                  data-testid="preview-top-bar"
                >
                  {/* Mirror the live header: top-bar links sit right-aligned alongside Login + Search */}
                  <div className="flex flex-1 justify-end items-center gap-6 px-4 h-full">
                    {(navPreviewItems.topNav.length > 0 ? navPreviewItems.topNav : ['Home', 'About', 'Events', 'Contact']).map((label, idx) => (
                      <div key={label} className="relative h-full flex items-center">
                        <span
                          className="ab-top-preview-link"
                          style={{
                            color: formData.header_config?.topNavTextColor || '#FFFFFF',
                            fontSize: `${parseInt(formData.header_config?.topNavFontSize, 10) || 14}px`,
                            fontWeight: formData.header_config?.topNavFontWeight || 600,
                            fontFamily: formData.header_config?.topNavFontFamily || undefined,
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {label}
                        </span>
                        {idx === 0 && formData.header_config?.topNavIndicator?.enabled && (
                          <div
                            className="absolute left-0 right-0"
                            style={{
                              bottom: 0,
                              height: `${parseInt(formData.header_config?.topNavIndicator?.height, 10) || 5}px`,
                              background: `linear-gradient(to right, ${(formData.header_config?.topNavIndicator?.gradientStops || DEFAULT_INDICATOR_GRADIENT_STOPS)
                                .slice()
                                .sort((a, b) => a.position - b.position)
                                .map(stop => `${stop.color} ${stop.position}%`)
                                .join(', ')})`
                            }}
                          />
                        )}
                      </div>
                    ))}
                    <span
                      className="flex items-center gap-1"
                      style={{
                        color: formData.header_config?.topNavTextColor || '#FFFFFF',
                        fontSize: `${parseInt(formData.header_config?.topNavFontSize, 10) || 14}px`,
                        fontWeight: formData.header_config?.topNavFontWeight || 600,
                        fontFamily: formData.header_config?.topNavFontFamily || undefined,
                        whiteSpace: 'nowrap'
                      }}
                    >
                      <User className="w-4 h-4" />
                      Login
                    </span>
                    <span
                      className="flex items-center gap-1"
                      style={{
                        color: formData.header_config?.topNavTextColor || '#FFFFFF',
                        fontSize: `${parseInt(formData.header_config?.topNavFontSize, 10) || 14}px`,
                        fontWeight: formData.header_config?.topNavFontWeight || 600,
                        fontFamily: formData.header_config?.topNavFontFamily || undefined,
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {(['icon', 'label', 'both'].includes(formData.header_config?.searchDisplay) ? formData.header_config.searchDisplay : 'both') !== 'label' && <Search className="w-4 h-4" />}
                      {(['icon', 'label', 'both'].includes(formData.header_config?.searchDisplay) ? formData.header_config.searchDisplay : 'both') !== 'icon' && <span>Search</span>}
                    </span>
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                {(formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS).map((stop, index) => (
                  <div key={index} className="flex items-center gap-3 bg-slate-900/50 rounded-lg p-3">
                    <input
                      type="color"
                      value={stop.color}
                      onChange={(e) => {
                        const newStops = [...(formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS)];
                        newStops[index] = { ...newStops[index], color: e.target.value };
                        setFormData(prev => ({
                          ...prev,
                          header_config: { ...prev.header_config, gradientStops: newStops }
                        }));
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
                          const newStops = [...(formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS)];
                          newStops[index] = { ...newStops[index], position: parseInt(e.target.value) };
                          setFormData(prev => ({
                            ...prev,
                            header_config: { ...prev.header_config, gradientStops: newStops }
                          }));
                        }}
                        className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                        data-testid={`slider-gradient-position-${index}`}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-slate-400 hover:text-red-400 flex-shrink-0"
                      onClick={() => {
                        const newStops = (formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS).filter((_, i) => i !== index);
                        setFormData(prev => ({
                          ...prev,
                          header_config: { ...prev.header_config, gradientStops: newStops }
                        }));
                      }}
                      data-testid={`button-remove-header-gradient-${index}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3 pt-2 border-t border-slate-700">
                <input
                  type="color"
                  value={newHeaderGradientColor}
                  onChange={(e) => setNewHeaderGradientColor(e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer"
                />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400 text-sm">New color position</span>
                    <span className="text-slate-400 text-sm">{newHeaderGradientPosition}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={newHeaderGradientPosition}
                    onChange={(e) => setNewHeaderGradientPosition(parseInt(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                    data-testid="slider-new-gradient-position"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const newStop = { color: newHeaderGradientColor, position: newHeaderGradientPosition };
                    setFormData(prev => ({
                      ...prev,
                      header_config: {
                        ...prev.header_config,
                        gradientStops: [...(prev.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS), newStop]
                          .sort((a, b) => a.position - b.position)
                      }
                    }));
                    setNewHeaderGradientColor('#000000');
                  }}
                  className="border-slate-600 text-slate-300"
                  data-testid="button-add-header-gradient-color"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add
                </Button>
              </div>
              <p className="text-xs text-slate-500">Adjust sliders to control where each color appears in the gradient (0% = left, 100% = right). Use white at 0% and 30% for the fade-from-white effect.</p>
            </CardContent>
          </Card>

          <HeaderLinkControls
            config={formData.header_config?.loginLink}
            onChange={(patch) => setFormData(prev => ({
              ...prev,
              header_config: {
                ...prev.header_config,
                loginLink: { ...prev.header_config?.loginLink, ...patch }
              }
            }))}
            title="Login Button (logged out)"
            description="Style and label the Login item shown in the top bar to logged-out visitors."
            defaultLabel="Login"
            testIdPrefix="login-link"
            previewBackgroundStops={formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS}
          />

          <HeaderLinkControls
            config={formData.header_config?.memberAreaLink}
            onChange={(patch) => setFormData(prev => ({
              ...prev,
              header_config: {
                ...prev.header_config,
                memberAreaLink: { ...prev.header_config?.memberAreaLink, ...patch }
              }
            }))}
            title="Member Area Button (logged in)"
            description="Style and label the Member Area item shown in the top bar to logged-in members."
            defaultLabel="Member Area"
            testIdPrefix="member-area-link"
            previewBackgroundStops={formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS}
          />

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Palette className="w-5 h-5" />
                Secondary Lower Navigation Bar
              </CardTitle>
              <CardDescription className="text-slate-400">
                Add an optional second bar below the top navigation bar with its own height and gradient background
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <Label className="text-slate-300">Enable secondary bar</Label>
                  <p className="text-xs text-slate-500">Renders a second bar directly beneath the top navigation bar</p>
                </div>
                <Switch
                  checked={!!formData.header_config?.secondaryBar?.enabled}
                  onCheckedChange={(checked) => {
                    setFormData(prev => ({
                      ...prev,
                      header_config: {
                        ...prev.header_config,
                        secondaryBar: { ...prev.header_config?.secondaryBar, enabled: checked }
                      }
                    }));
                  }}
                  data-testid="switch-secondary-bar-enabled"
                />
              </div>

              {formData.header_config?.secondaryBar?.enabled && (
                <>
                  <div className="space-y-2">
                    <Label className="text-slate-300">Secondary Bar Height (px)</Label>
                    <Input
                      type="number"
                      min="20"
                      max="300"
                      placeholder="48"
                      value={formData.header_config?.secondaryBar?.height ?? ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setFormData(prev => ({
                          ...prev,
                          header_config: {
                            ...prev.header_config,
                            secondaryBar: { ...prev.header_config?.secondaryBar, height: val === '' ? '' : parseInt(val, 10) }
                          }
                        }));
                      }}
                      className="bg-slate-900 border-slate-600 text-white"
                      data-testid="input-secondary-bar-height"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-slate-300 text-xs">Live Preview</Label>
                    <div
                      className="rounded-lg border border-slate-600 overflow-hidden flex"
                      style={{
                        minHeight: `${Math.min(Math.max(parseInt(formData.header_config?.secondaryBar?.height, 10) || 48, 24), 120)}px`,
                        background: `linear-gradient(to right, ${(formData.header_config?.secondaryBar?.gradientStops || DEFAULT_SECONDARY_BAR_GRADIENT_STOPS)
                          .slice()
                          .sort((a, b) => a.position - b.position)
                          .map(stop => `${stop.color} ${stop.position}%`)
                          .join(', ')})`
                      }}
                      data-testid="preview-secondary-bar"
                    >
                      {/* Mirror the live header: logo sits on the left, main-nav links on the right */}
                      <div className="flex flex-1 items-center justify-between gap-6 px-4">
                        <div className="flex items-center flex-shrink-0">
                          {formData.header_logo_url ? (
                            <img
                              src={formData.header_logo_url}
                              alt={tenant?.name || 'Logo'}
                              className="object-contain"
                              style={{ height: '32px', width: 'auto', maxWidth: '160px' }}
                            />
                          ) : (
                            <span
                              className="font-bold"
                              style={{
                                color: formData.header_config?.secondaryBar?.textColor || '#FFFFFF',
                                fontSize: '18px',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              {tenant?.name || 'Your Logo'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-8 h-full">
                          {(navPreviewItems.mainNav.length > 0 ? navPreviewItems.mainNav : ['Membership', 'Resources', 'News', 'Get Involved']).map((label, idx) => (
                            <div key={label} className="relative h-full flex items-center">
                              <span
                                className="ab-sec-preview-link"
                                style={{
                                  color: formData.header_config?.secondaryBar?.textColor || '#FFFFFF',
                                  fontSize: `${parseInt(formData.header_config?.secondaryBar?.fontSize, 10) || 16}px`,
                                  fontWeight: formData.header_config?.secondaryBar?.fontWeight || (idx === 0 ? 700 : 500),
                                  fontFamily: formData.header_config?.secondaryBar?.fontFamily || 'Poppins, sans-serif',
                                  whiteSpace: 'nowrap'
                                }}
                              >
                                {label}
                              </span>
                              {idx === 0 && (formData.header_config?.secondaryBar?.indicator ? formData.header_config.secondaryBar.indicator.enabled : true) && (
                                <div
                                  className="absolute left-0 right-0"
                                  style={{
                                    bottom: 0,
                                    height: `${parseInt(formData.header_config?.secondaryBar?.indicator?.height, 10) || 5}px`,
                                    background: (formData.header_config?.secondaryBar?.indicator?.gradientStops && formData.header_config.secondaryBar.indicator.gradientStops.length > 0)
                                      ? `linear-gradient(to right, ${formData.header_config.secondaryBar.indicator.gradientStops
                                          .slice()
                                          .sort((a, b) => a.position - b.position)
                                          .map(stop => `${stop.color} ${stop.position}%`)
                                          .join(', ')})`
                                      : `linear-gradient(to right, ${formData.primary_color || '#5C0085'}, ${formData.secondary_color || '#BA0087'})`
                                  }}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {(formData.header_config?.secondaryBar?.gradientStops || DEFAULT_SECONDARY_BAR_GRADIENT_STOPS).map((stop, index) => (
                      <div key={index} className="flex items-center gap-3 bg-slate-900/50 rounded-lg p-3">
                        <input
                          type="color"
                          value={stop.color}
                          onChange={(e) => {
                            const newStops = [...(formData.header_config?.secondaryBar?.gradientStops || DEFAULT_SECONDARY_BAR_GRADIENT_STOPS)];
                            newStops[index] = { ...newStops[index], color: e.target.value };
                            setFormData(prev => ({
                              ...prev,
                              header_config: {
                                ...prev.header_config,
                                secondaryBar: { ...prev.header_config?.secondaryBar, gradientStops: newStops }
                              }
                            }));
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
                              const newStops = [...(formData.header_config?.secondaryBar?.gradientStops || DEFAULT_SECONDARY_BAR_GRADIENT_STOPS)];
                              newStops[index] = { ...newStops[index], position: parseInt(e.target.value) };
                              setFormData(prev => ({
                                ...prev,
                                header_config: {
                                  ...prev.header_config,
                                  secondaryBar: { ...prev.header_config?.secondaryBar, gradientStops: newStops }
                                }
                              }));
                            }}
                            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                            data-testid={`slider-secondary-bar-gradient-position-${index}`}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-slate-400 hover:text-red-400 flex-shrink-0"
                          onClick={() => {
                            const newStops = (formData.header_config?.secondaryBar?.gradientStops || DEFAULT_SECONDARY_BAR_GRADIENT_STOPS).filter((_, i) => i !== index);
                            setFormData(prev => ({
                              ...prev,
                              header_config: {
                                ...prev.header_config,
                                secondaryBar: { ...prev.header_config?.secondaryBar, gradientStops: newStops }
                              }
                            }));
                          }}
                          data-testid={`button-remove-secondary-bar-gradient-${index}`}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 pt-2 border-t border-slate-700">
                    <input
                      type="color"
                      value={newSecondaryBarGradientColor}
                      onChange={(e) => setNewSecondaryBarGradientColor(e.target.value)}
                      className="w-10 h-10 rounded cursor-pointer"
                    />
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 text-sm">New color position</span>
                        <span className="text-slate-400 text-sm">{newSecondaryBarGradientPosition}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={newSecondaryBarGradientPosition}
                        onChange={(e) => setNewSecondaryBarGradientPosition(parseInt(e.target.value))}
                        className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                        data-testid="slider-new-secondary-bar-gradient-position"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const newStop = { color: newSecondaryBarGradientColor, position: newSecondaryBarGradientPosition };
                        setFormData(prev => ({
                          ...prev,
                          header_config: {
                            ...prev.header_config,
                            secondaryBar: {
                              ...prev.header_config?.secondaryBar,
                              gradientStops: [...(prev.header_config?.secondaryBar?.gradientStops || DEFAULT_SECONDARY_BAR_GRADIENT_STOPS), newStop]
                                .sort((a, b) => a.position - b.position)
                            }
                          }
                        }));
                        setNewSecondaryBarGradientColor('#000000');
                      }}
                      className="border-slate-600 text-slate-300"
                      data-testid="button-add-secondary-bar-gradient-color"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Add
                    </Button>
                  </div>
                  <p className="text-xs text-slate-500">Adjust sliders to control where each color appears in the gradient (0% = left, 100% = right).</p>

                  <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-700">
                    <div className="space-y-2">
                      <Label className="text-slate-300">Link Text Color</Label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={formData.header_config?.secondaryBar?.textColor || '#FFFFFF'}
                          onChange={(e) => {
                            setFormData(prev => ({
                              ...prev,
                              header_config: {
                                ...prev.header_config,
                                secondaryBar: { ...prev.header_config?.secondaryBar, textColor: e.target.value }
                              }
                            }));
                          }}
                          className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                          data-testid="input-secondary-bar-text-color"
                        />
                        <Input
                          type="text"
                          placeholder="#FFFFFF"
                          value={formData.header_config?.secondaryBar?.textColor || ''}
                          onChange={(e) => {
                            setFormData(prev => ({
                              ...prev,
                              header_config: {
                                ...prev.header_config,
                                secondaryBar: { ...prev.header_config?.secondaryBar, textColor: e.target.value }
                              }
                            }));
                          }}
                          className="bg-slate-900 border-slate-600 text-white font-mono"
                          data-testid="input-secondary-bar-text-color-hex"
                        />
                      </div>
                      <p className="text-xs text-slate-500">Color of the main menu link text in this bar. Defaults to white.</p>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-slate-300">Link Font Size (px)</Label>
                      <Input
                        type="number"
                        min="8"
                        max="48"
                        placeholder="16"
                        value={formData.header_config?.secondaryBar?.fontSize ?? ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          setFormData(prev => ({
                            ...prev,
                            header_config: {
                              ...prev.header_config,
                              secondaryBar: { ...prev.header_config?.secondaryBar, fontSize: val === '' ? '' : parseInt(val, 10) }
                            }
                          }));
                        }}
                        className="bg-slate-900 border-slate-600 text-white"
                        data-testid="input-secondary-bar-font-size"
                      />
                      <p className="text-xs text-slate-500">Size of the main menu link text. Leave blank for default.</p>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-slate-300">Link Hover Color</Label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={formData.header_config?.secondaryBar?.hoverColor || '#FFFFFF'}
                          onChange={(e) => {
                            setFormData(prev => ({
                              ...prev,
                              header_config: {
                                ...prev.header_config,
                                secondaryBar: { ...prev.header_config?.secondaryBar, hoverColor: e.target.value }
                              }
                            }));
                          }}
                          className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                          data-testid="input-secondary-bar-hover-color"
                        />
                        <Input
                          type="text"
                          placeholder="No hover change"
                          value={formData.header_config?.secondaryBar?.hoverColor || ''}
                          onChange={(e) => {
                            setFormData(prev => ({
                              ...prev,
                              header_config: {
                                ...prev.header_config,
                                secondaryBar: { ...prev.header_config?.secondaryBar, hoverColor: e.target.value }
                              }
                            }));
                          }}
                          className="bg-slate-900 border-slate-600 text-white font-mono"
                          data-testid="input-secondary-bar-hover-color-hex"
                        />
                      </div>
                      <p className="text-xs text-slate-500">Color links change to on hover. Leave blank to keep current behavior.</p>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-slate-300">Link Font Weight</Label>
                      <Select
                        value={formData.header_config?.secondaryBar?.fontWeight ? String(formData.header_config.secondaryBar.fontWeight) : 'default'}
                        onValueChange={(val) => {
                          setFormData(prev => ({
                            ...prev,
                            header_config: {
                              ...prev.header_config,
                              secondaryBar: { ...prev.header_config?.secondaryBar, fontWeight: val === 'default' ? '' : parseInt(val, 10) }
                            }
                          }));
                        }}
                      >
                        <SelectTrigger className="bg-slate-900 border-slate-600 text-white" data-testid="select-secondary-bar-font-weight">
                          <SelectValue placeholder="Default" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default</SelectItem>
                          {NAV_FONT_WEIGHTS.map((w) => (
                            <SelectItem key={w.value} value={String(w.value)}>{w.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500">Weight of the main menu link text. Leave at default to keep current styling.</p>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-slate-300">Base Font Family</Label>
                      <Select
                        value={formData.header_config?.secondaryBar?.fontFamily || 'default'}
                        onValueChange={(val) => {
                          setFormData(prev => ({
                            ...prev,
                            header_config: {
                              ...prev.header_config,
                              secondaryBar: { ...prev.header_config?.secondaryBar, fontFamily: val === 'default' ? '' : val }
                            }
                          }));
                        }}
                      >
                        <SelectTrigger className="bg-slate-900 border-slate-600 text-white" data-testid="select-secondary-bar-font-family">
                          <SelectValue placeholder="Poppins" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Poppins (default)</SelectItem>
                          {NAV_AVAILABLE_FONTS.map((f) => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500">Font family for the main menu links. Defaults to Poppins.</p>
                    </div>
                  </div>
                  <IndicatorEditor
                    value={formData.header_config?.secondaryBar?.indicator}
                    onChange={(ind) => setFormData(prev => ({
                      ...prev,
                      header_config: {
                        ...prev.header_config,
                        secondaryBar: { ...prev.header_config?.secondaryBar, indicator: ind }
                      }
                    }))}
                    testIdPrefix="secondary-bar-indicator"
                  />
                </>
              )}
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Type className="w-5 h-5" />
                Tagline
              </CardTitle>
              <CardDescription className="text-slate-400">
                A short tagline or slogan for your organization
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Input
                value={formData.tagline}
                onChange={(e) => setFormData({ ...formData, tagline: e.target.value })}
                className="bg-slate-900/50 border-slate-600 text-white"
                placeholder="Empowering professionals worldwide"
                data-testid="input-tagline"
              />
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Type className="w-5 h-5" />
                Link Previews (SEO &amp; Social Sharing)
              </CardTitle>
              <CardDescription className="text-slate-400">
                Used when your site is shared on Slack, WhatsApp, iMessage, Facebook, X/Twitter, LinkedIn, and shown in Google search results.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="description" className="text-slate-200">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="bg-slate-900/50 border-slate-600 text-white"
                  placeholder="A short description of your organisation (1-2 sentences, ~155 characters)."
                  rows={3}
                  maxLength={300}
                  data-testid="input-seo-description"
                />
                <p className="text-xs text-slate-500">Shown as the meta description and link-preview subtitle. Aim for under 160 characters.</p>
              </div>
              <div className="space-y-2">
                <Label className="text-slate-200">Social Image</Label>
                <div className="border-2 border-dashed border-slate-600 rounded-lg p-4 bg-slate-900/50">
                  {formData.social_image_url ? (
                    <div className="flex items-center gap-4">
                      <div className="bg-slate-700 rounded-lg p-2">
                        <img
                          src={formData.social_image_url}
                          alt="Social share preview"
                          className="h-24 w-auto object-contain"
                          data-testid="img-social-image-preview"
                        />
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => socialImageInputRef.current?.click()}
                          disabled={uploadingSocialImage}
                          className="border-slate-600 text-slate-300"
                          data-testid="button-change-social-image"
                        >
                          {uploadingSocialImage ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Upload className="w-4 h-4 mr-2" />
                          )}
                          Change
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={handleRemoveSocialImage}
                          data-testid="button-remove-social-image"
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Remove
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-6">
                      <Image className="w-12 h-12 mx-auto text-slate-500 mb-3" />
                      <p className="text-slate-400 mb-3">No social image uploaded</p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => socialImageInputRef.current?.click()}
                        disabled={uploadingSocialImage}
                        className="border-slate-600 text-slate-300"
                        data-testid="button-upload-social-image"
                      >
                        {uploadingSocialImage ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Upload className="w-4 h-4 mr-2" />
                        )}
                        Upload Social Image
                      </Button>
                    </div>
                  )}
                  <input
                    ref={socialImageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleSocialImageUpload}
                    data-testid="input-social-image-file"
                  />
                </div>
                {socialImageDimWarning ? (
                  <p className="text-xs text-warning" data-testid="text-social-image-warning">{socialImageDimWarning}</p>
                ) : null}
                <p className="text-xs text-slate-500">Recommended size: 1200×630 PNG/JPG. If empty, your logo is used as the link-preview image.</p>
              </div>

              <div className="space-y-2">
                <Label className="text-slate-200">Preview</Label>
                <p className="text-xs text-slate-500">
                  See how your homepage will appear when shared on Slack, iMessage, and X. Switch to <em>Live (server)</em> to fetch the actual meta tags returned by the SSR pipeline that real unfurl bots see.
                </p>
                <UnfurlPreview
                  title={tenant?.tagline ? `${tenant?.name || ''} — ${tenant.tagline}` : (tenant?.name || '')}
                  description={formData.description || tenant?.tagline || ''}
                  image={formData.social_image_url || formData.logo_url || ''}
                  url={typeof window !== 'undefined' ? window.location.origin : ''}
                  siteName={tenant?.name || ''}
                  previewPath="/"
                />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <LayoutTemplate className="w-5 h-5" />
                Footer Configuration
              </CardTitle>
              <CardDescription className="text-slate-400">
                Customize the public website footer content
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label className="text-slate-200">Number of Footer Columns</Label>
                <p className="text-slate-400 text-sm">How many navigation columns to display in the footer (configured in Portal Navigation Management)</p>
                <Select
                  value={String(formData.footer_config.columns || 4)}
                  onValueChange={(value) => setFormData(prev => ({
                    ...prev,
                    footer_config: { ...prev.footer_config, columns: parseInt(value, 10) }
                  }))}
                >
                  <SelectTrigger className="bg-slate-900/50 border-slate-600 text-white w-32" data-testid="select-footer-columns">
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
                <Label className="text-slate-200">Newsletter Heading</Label>
                <Input
                  value={formData.footer_config.newsletterText}
                  onChange={(e) => setFormData(prev => ({
                    ...prev,
                    footer_config: { ...prev.footer_config, newsletterText: e.target.value }
                  }))}
                  className="bg-slate-900/50 border-slate-600 text-white"
                  placeholder="Sign up to our newsletter"
                  data-testid="input-newsletter-text"
                />
              </div>

              <div className="space-y-3">
                <Label className="text-slate-200">Gradient Colors</Label>
                <p className="text-slate-400 text-sm">Colors used in the footer gradient bar and buttons</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  {formData.footer_config.gradientColors?.map((color, index) => (
                    <div key={index} className="flex items-center gap-1 bg-slate-700 rounded px-2 py-1">
                      <input
                        type="color"
                        value={color}
                        onChange={(e) => updateGradientColor(index, e.target.value)}
                        className="w-6 h-6 rounded cursor-pointer"
                      />
                      <span className="text-white text-sm">{color}</span>
                      <button
                        type="button"
                        onClick={() => removeGradientColor(index)}
                        className="text-slate-400 hover:text-red-400 ml-1"
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
                    onClick={addGradientColor}
                    className="border-slate-600 text-slate-300"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add Color
                  </Button>
                </div>
                {formData.footer_config.gradientColors?.length > 0 && (
                  <div 
                    className="h-4 rounded mt-2"
                    style={{
                      background: `linear-gradient(to right, ${formData.footer_config.gradientColors.join(', ')})`
                    }}
                  />
                )}
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label className="text-slate-200">Background Color</Label>
                  <p className="text-slate-400 text-sm">The background color for the footer section</p>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={formData.footer_config.backgroundColor || '#000000'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: { ...prev.footer_config, backgroundColor: e.target.value }
                      }))}
                      className="w-12 h-10 rounded cursor-pointer"
                      data-testid="input-footer-background-color"
                    />
                    <Input
                      value={formData.footer_config.backgroundColor || '#000000'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: { ...prev.footer_config, backgroundColor: e.target.value }
                      }))}
                      className="bg-slate-900/50 border-slate-600 text-white flex-1"
                      placeholder="#000000"
                      data-testid="input-footer-background-color-text"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-200">Text Color</Label>
                  <p className="text-slate-400 text-sm">The text color for footer content</p>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={formData.footer_config.textColor || '#FFFFFF'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: { ...prev.footer_config, textColor: e.target.value }
                      }))}
                      className="w-12 h-10 rounded cursor-pointer"
                      data-testid="input-footer-text-color"
                    />
                    <Input
                      value={formData.footer_config.textColor || '#FFFFFF'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: { ...prev.footer_config, textColor: e.target.value }
                      }))}
                      className="bg-slate-900/50 border-slate-600 text-white flex-1"
                      placeholder="#FFFFFF"
                      data-testid="input-footer-text-color-text"
                    />
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-700 pt-4 space-y-4">
                <h4 className="text-white font-medium">Address</h4>
                <div className="space-y-2">
                  <Label className="text-slate-200">Organization Name</Label>
                  <Input
                    value={formData.footer_config.address.name}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      footer_config: {
                        ...prev.footer_config,
                        address: { ...prev.footer_config.address, name: e.target.value }
                      }
                    }))}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="Your Organization Name"
                    data-testid="input-address-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-200">Address Lines</Label>
                  <div className="space-y-2">
                    {formData.footer_config.address.lines?.map((line, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          value={line}
                          disabled
                          className="bg-slate-900/50 border-slate-600 text-white flex-1"
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon"
                          onClick={() => removeAddressLine(index)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex items-center gap-2">
                      <Input
                        value={newAddressLine}
                        onChange={(e) => setNewAddressLine(e.target.value)}
                        className="bg-slate-900/50 border-slate-600 text-white flex-1"
                        placeholder="Add address line..."
                        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAddressLine())}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={addAddressLine}
                        className="border-slate-600 text-slate-300"
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-700 pt-4 space-y-4">
                <h4 className="text-white font-medium">Contact Information</h4>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-slate-200">Phone Number</Label>
                    <Input
                      value={formData.footer_config.contact.phone}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: {
                          ...prev.footer_config,
                          contact: { ...prev.footer_config.contact, phone: e.target.value }
                        }
                      }))}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="+44 (0)114 251 5750"
                      data-testid="input-phone"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-slate-200">Email Address</Label>
                    <Input
                      value={formData.footer_config.contact.email}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: {
                          ...prev.footer_config,
                          contact: { ...prev.footer_config.contact, email: e.target.value }
                        }
                      }))}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="hello@example.org"
                      data-testid="input-email"
                    />
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-700 pt-4 space-y-4">
                <h4 className="text-white font-medium">Legal</h4>
                <div className="space-y-2">
                  <Label className="text-slate-200">Legal / Charity Text</Label>
                  <Textarea
                    value={formData.footer_config.legalText}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      footer_config: { ...prev.footer_config, legalText: e.target.value }
                    }))}
                    className="bg-slate-900/50 border-slate-600 text-white min-h-[80px]"
                    placeholder="Registered charity number, company registration info, etc."
                    data-testid="input-legal-text"
                  />
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-slate-200">Terms & Conditions URL</Label>
                    <Input
                      value={formData.footer_config.termsAndConditionsUrl}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: { ...prev.footer_config, termsAndConditionsUrl: e.target.value }
                      }))}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="https://..."
                      data-testid="input-terms-url"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-slate-200">Privacy Policy URL</Label>
                    <Input
                      value={formData.footer_config.privacyPolicyUrl}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: { ...prev.footer_config, privacyPolicyUrl: e.target.value }
                      }))}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="https://..."
                      data-testid="input-privacy-url"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Social Icon Colors Card */}
          <Card className="bg-slate-800 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-white">
                <Palette className="w-5 h-5 text-blue-400" />
                Social Icon Colors
              </CardTitle>
              <CardDescription className="text-slate-400">
                Set the colors for social media icons in the header and footer
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label className="text-slate-200">Header Social Icons</Label>
                  <div className="flex gap-2">
                    <Input
                      type="color"
                      value={formData.branding_config?.headerSocialIconColor || '#5C0085'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        branding_config: { ...prev.branding_config, headerSocialIconColor: e.target.value }
                      }))}
                      className="w-16 h-10 p-1 cursor-pointer"
                      data-testid="input-header-social-color"
                    />
                    <Input
                      type="text"
                      value={formData.branding_config?.headerSocialIconColor || '#5C0085'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        branding_config: { ...prev.branding_config, headerSocialIconColor: e.target.value }
                      }))}
                      className="flex-1 bg-slate-900/50 border-slate-600 text-white font-mono"
                      placeholder="#FFFFFF"
                      data-testid="input-header-social-color-text"
                    />
                  </div>
                  <p className="text-xs text-slate-500">Color for social icons in the top navigation bar</p>
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-200">Footer Social Icons</Label>
                  <div className="flex gap-2">
                    <Input
                      type="color"
                      value={formData.branding_config?.footerSocialIconColor || '#FFFFFF'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        branding_config: { ...prev.branding_config, footerSocialIconColor: e.target.value }
                      }))}
                      className="w-16 h-10 p-1 cursor-pointer"
                      data-testid="input-footer-social-color"
                    />
                    <Input
                      type="text"
                      value={formData.branding_config?.footerSocialIconColor || '#FFFFFF'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        branding_config: { ...prev.branding_config, footerSocialIconColor: e.target.value }
                      }))}
                      className="flex-1 bg-slate-900/50 border-slate-600 text-white font-mono"
                      placeholder="#FFFFFF"
                      data-testid="input-footer-social-color-text"
                    />
                  </div>
                  <p className="text-xs text-slate-500">Color for social icons in the footer</p>
                </div>
              </div>

              <div className="space-y-3 pt-2 border-t border-slate-700">
                <div>
                  <Label className="text-slate-200">Custom Icon SVGs</Label>
                  <p className="text-xs text-slate-500 mt-1">
                    Upload your own SVG glyph for any platform. It is recoloured to the header/footer colours above and appears wherever that platform's icon shows today. Leave empty to use the built-in icon.
                  </p>
                  <p className="text-xs text-warning mt-1" data-testid="text-social-svg-transparent-hint">
                    Custom icons must be SVGs with a transparent background. An SVG with a filled or solid background will display as a coloured square, not the icon shape.
                  </p>
                </div>
                <div className="space-y-2">
                  {SOCIAL_ICON_PLATFORMS.map((platform) => {
                    const customSvg = formData.branding_config?.socialIconCustomSvgs?.[platform.key];
                    const isUploading = uploadingSocialSvg === platform.key;
                    return (
                      <div
                        key={platform.key}
                        className="flex items-center gap-3 flex-wrap p-3 bg-slate-900/50 rounded-md border border-slate-700"
                        data-testid={`row-social-svg-${platform.key}`}
                      >
                        <div
                          className="w-9 h-9 rounded flex items-center justify-center shrink-0"
                          style={{ backgroundColor: (customSvg && resolvedSocialSvgs[platform.key]) ? 'transparent' : (formData.branding_config?.headerSocialIconColor || '#5C0085') }}
                        >
                          {customSvg && resolvedSocialSvgs[platform.key] ? (
                            <div
                              className="w-5 h-5"
                              style={{
                                backgroundColor: formData.branding_config?.headerSocialIconColor || '#5C0085',
                                WebkitMaskImage: `url("${resolvedSocialSvgs[platform.key]}")`,
                                maskImage: `url("${resolvedSocialSvgs[platform.key]}")`,
                                WebkitMaskRepeat: 'no-repeat',
                                maskRepeat: 'no-repeat',
                                WebkitMaskPosition: 'center',
                                maskPosition: 'center',
                                WebkitMaskSize: 'contain',
                                maskSize: 'contain'
                              }}
                              data-testid={`preview-social-svg-${platform.key}`}
                            />
                          ) : (
                            <Image className="w-4 h-4 text-white/70" />
                          )}
                        </div>
                        <span className="text-sm text-slate-200 flex-1 min-w-[5rem]">{platform.name}</span>
                        <input
                          type="file"
                          accept=".svg,image/svg+xml"
                          ref={(el) => { socialSvgInputRefs.current[platform.key] = el; }}
                          onChange={(e) => handleSocialSvgUpload(platform.key, e)}
                          className="hidden"
                          data-testid={`input-social-svg-${platform.key}`}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => socialSvgInputRefs.current[platform.key]?.click()}
                          disabled={isUploading}
                          className="border-slate-600 text-slate-300"
                          data-testid={`button-upload-social-svg-${platform.key}`}
                        >
                          {isUploading ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Upload className="w-4 h-4 mr-2" />
                          )}
                          {customSvg ? 'Replace' : 'Upload SVG'}
                        </Button>
                        {customSvg && (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => handleRemoveSocialSvg(platform.key)}
                            disabled={isUploading}
                            data-testid={`button-remove-social-svg-${platform.key}`}
                          >
                            <Trash2 className="w-4 h-4 mr-2" />
                            Remove
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Platform Branding Card */}
          <Card className="bg-slate-800 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-white">
                <Shield className="w-5 h-5 text-purple-400" />
                Platform Branding
              </CardTitle>
              <CardDescription className="text-slate-400">
                Configure the "Powered by" section that appears at the bottom of the footer
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between p-4 bg-slate-900/50 rounded-lg border border-slate-600">
                <Label className="text-white font-medium">Show Platform Branding</Label>
                <Switch
                  checked={formData.platform_branding.showPlatformBranding}
                  onCheckedChange={(checked) => setFormData(prev => ({
                    ...prev,
                    platform_branding: { ...prev.platform_branding, showPlatformBranding: checked }
                  }))}
                  data-testid="switch-platform-branding"
                />
              </div>

              {formData.platform_branding.showPlatformBranding && (
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-slate-200">Background Color</Label>
                    <div className="flex gap-2">
                      <Input
                        type="color"
                        value={formData.platform_branding.backgroundColor}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          platform_branding: { ...prev.platform_branding, backgroundColor: e.target.value }
                        }))}
                        className="w-16 h-10 p-1 cursor-pointer"
                        data-testid="input-platform-bg-color"
                      />
                      <Input
                        type="text"
                        value={formData.platform_branding.backgroundColor}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          platform_branding: { ...prev.platform_branding, backgroundColor: e.target.value }
                        }))}
                        className="flex-1 bg-slate-900/50 border-slate-600 text-white font-mono"
                        placeholder="#000000"
                        data-testid="input-platform-bg-color-text"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-slate-200">Text Color</Label>
                    <div className="flex gap-2">
                      <Input
                        type="color"
                        value={formData.platform_branding.textColor}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          platform_branding: { ...prev.platform_branding, textColor: e.target.value }
                        }))}
                        className="w-16 h-10 p-1 cursor-pointer"
                        data-testid="input-platform-text-color"
                      />
                      <Input
                        type="text"
                        value={formData.platform_branding.textColor}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          platform_branding: { ...prev.platform_branding, textColor: e.target.value }
                        }))}
                        className="flex-1 bg-slate-900/50 border-slate-600 text-white font-mono"
                        placeholder="#64748b"
                        data-testid="input-platform-text-color-text"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Preview */}
              {formData.platform_branding.showPlatformBranding && (
                <div className="border-t border-slate-700 pt-4">
                  <Label className="text-slate-200 mb-3 block">Preview</Label>
                  <div 
                    className="text-center p-4 rounded-lg"
                    style={{ backgroundColor: formData.platform_branding.backgroundColor }}
                  >
                    <p 
                      className="text-xs"
                      style={{ color: formData.platform_branding.textColor }}
                    >
                      {platformDefaults.platformBrandingText}
                    </p>
                  </div>
                  <p className="text-xs text-slate-500 mt-2">
                    Text and link URL are configured in Platform Admin &rarr; Defaults
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex justify-end gap-3">
            <Link to="/admin/dashboard">
              <Button type="button" variant="outline" className="border-slate-600 text-slate-300">
                Cancel
              </Button>
            </Link>
            <Button type="submit" disabled={saving} className="bg-purple-600 hover:bg-purple-700" data-testid="button-save">
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Branding
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
