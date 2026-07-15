import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Save, Loader2, Eye, RotateCcw, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { LUCIDE_ICONS, getLucideIcon, isFaIconName, renderStyleIcon } from "@/components/canvas/blocks/registry";
import { FontAwesomeIconPicker } from "@/components/canvas/FontAwesomeIconPicker";
import TypographyStyleSelector, { useTypographyStyles, getTypographyStyleCSS } from "@/components/iedit/TypographyStyleSelector";
import { composeButtonLabelStyle } from "@/lib/tenantButtonStyle";

// Default icon block shared by all styles. `name === ''` means "no icon"
// (renders nothing). `color === ''` means "inherit the button's text colour".
// Additive: older saved configs with no `icon` block load with no icon.
const DEFAULT_ICON = { name: '', color: '', position: 'before', size: 18 };

// Radix <Select.Item> forbids an empty-string value, so the "Main site" scope
// (internally represented as '') uses this non-empty sentinel in the picker.
// Microsite ids are UUIDs, so they can never collide with it.
const MAIN_SITE_SCOPE_VALUE = '__main__';

// UI-only stable identity for custom style rows. Used as the React list key
// and as the target for update/rename/delete so a row is never keyed by its
// mutable slugified `key` (which re-slugifies on each rename keystroke and
// would otherwise remount the row, dropping input focus — Task #2562).
let __customStyleUidCounter = 0;
const genCustomStyleUid = () =>
  (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `cs-${Date.now()}-${++__customStyleUidCounter}`;

const DEFAULT_PRIMARY_STYLE = {
  background: {
    type: 'gradient',
    solidColor: '#5C0085',
    gradientAngle: 90,
    gradientStops: [
      { color: '#5C0085', position: 0 },
      { color: '#BA0087', position: 100 }
    ]
  },
  border: {
    width: 0,
    color: '#000000',
    style: 'solid'
  },
  radius: 6,
  hover: {
    type: 'gradient',
    solidColor: '#BA0087',
    gradientAngle: 90,
    gradientStops: [
      { color: '#BA0087', position: 0 },
      { color: '#EE00C3', position: 100 }
    ]
  },
  textColor: '#FFFFFF',
  hoverTextColor: '#FFFFFF',
  size: {
    paddingX: 20,
    paddingY: 8,
    fontSize: 16,
    iconSize: 18
  },
  icon: { ...DEFAULT_ICON }
};

const DEFAULT_SECONDARY_STYLE = {
  background: {
    type: 'solid',
    solidColor: 'transparent',
    gradientAngle: 90,
    gradientStops: [
      { color: '#FFFFFF', position: 0 },
      { color: '#F0F0F0', position: 100 }
    ]
  },
  border: {
    width: 2,
    color: '#000000',
    style: 'solid'
  },
  radius: 6,
  hover: {
    type: 'gradient',
    solidColor: '#5C0085',
    gradientAngle: 90,
    gradientStops: [
      { color: '#5C0085', position: 0 },
      { color: '#BA0087', position: 100 }
    ]
  },
  textColor: '#000000',
  hoverTextColor: '#FFFFFF',
  size: {
    paddingX: 20,
    paddingY: 8,
    fontSize: 16,
    iconSize: 18
  },
  icon: { ...DEFAULT_ICON }
};

// Default size block shared by both styles — used to backfill the field on
// payloads saved before the size tab existed (additive migration).
const DEFAULT_SIZE = { paddingX: 20, paddingY: 8, fontSize: 16, iconSize: 18 };

// Helper to convert old format to new format
const migrateGradientConfig = (bgConfig) => {
  if (!bgConfig) return bgConfig;
  
  // If already has new format, return as-is
  if (bgConfig.gradientStops) return bgConfig;
  
  // Convert old format to new format
  const directionToAngle = {
    'to right': 90,
    'to left': 270,
    'to bottom': 180,
    'to top': 0,
    'to bottom right': 135,
    'to bottom left': 225,
    'to top right': 45,
    'to top left': 315
  };
  
  return {
    ...bgConfig,
    gradientAngle: directionToAngle[bgConfig.gradientDirection] || 90,
    gradientStops: [
      { color: bgConfig.gradientStart || '#5C0085', position: 0 },
      { color: bgConfig.gradientEnd || '#BA0087', position: 100 }
    ]
  };
};

function ButtonStyleEditor({
  style,
  onChange,
  title,
  description,
  // Optional — when set, the title renders as an editable Input
  // (used for free-form custom styles) and onLabelChange is fired on input.
  editableLabel = false,
  onLabelChange,
  // Optional — when set, a Delete button shows in the card header.
  // Used to remove custom styles from the saved map.
  onDelete,
  // Optional override so custom entries can carry stable data-testid
  // prefixes derived from their map-key rather than their (renamable) label.
  testIdPrefix: testIdPrefixProp,
  // Optional — when set, a microsite assignment picker renders in the header.
  // `micrositeOptions` is the tenant's list of microsites ([{id,name}...]);
  // `selectedMicrosites` is the array of assigned microsite id strings;
  // `onMicrositesChange(nextIds)` fires when the selection changes.
  micrositeOptions,
  selectedMicrosites,
  onMicrositesChange,
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [faPickerOpen, setFaPickerOpen] = useState(false);
  const testIdPrefix = testIdPrefixProp || title.toLowerCase().replace(/\s+/g, '-');

  // Task #2591: the label typography baked into this button style. When set,
  // the preview labels render in that typography so the creator is WYSIWYG
  // with the canvas render path. `getStyleById` resolves from the tenant's
  // typography styles (all scopes) so microsite-scoped styles also resolve.
  const { getStyleById } = useTypographyStyles();
  const labelTypoStyle = getStyleById(style.labelTypographyStyleId);
  const labelTypoCss = labelTypoStyle ? getTypographyStyleCSS(labelTypoStyle) : null;

  const updateStyle = (path, value) => {
    const newStyle = { ...style };
    const keys = path.split('.');
    let current = newStyle;
    for (let i = 0; i < keys.length - 1; i++) {
      current[keys[i]] = { ...current[keys[i]] };
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
    onChange(newStyle);
  };

  const getBackgroundStyle = (bgConfig) => {
    if (bgConfig.type === 'transparent') {
      return { backgroundColor: 'transparent' };
    }
    if (bgConfig.type === 'solid') {
      return { backgroundColor: bgConfig.solidColor };
    }
    
    // Handle new format with gradientStops
    if (bgConfig.gradientStops && bgConfig.gradientStops.length >= 2) {
      const angle = bgConfig.gradientAngle ?? 90;
      const stops = [...bgConfig.gradientStops]
        .sort((a, b) => a.position - b.position)
        .map(stop => `${stop.color} ${stop.position}%`)
        .join(', ');
      return {
        background: `linear-gradient(${angle}deg, ${stops})`
      };
    }
    
    // Fallback for old format
    const directionToAngle = {
      'to right': 90,
      'to left': 270,
      'to bottom': 180,
      'to top': 0,
      'to bottom right': 135,
      'to bottom left': 225
    };
    const angle = directionToAngle[bgConfig.gradientDirection] || 90;
    return {
      background: `linear-gradient(${angle}deg, ${bgConfig.gradientStart || '#5C0085'} 0%, ${bgConfig.gradientEnd || '#BA0087'} 100%)`
    };
  };

  // Padding comes live from the Size tab (paddingX/paddingY), falling back to
  // DEFAULT_SIZE. Dragging the padding sliders updates the preview immediately.
  const sizeCfg = style.size || DEFAULT_SIZE;
  const previewPadX = Number.isFinite(sizeCfg.paddingX) ? sizeCfg.paddingX : DEFAULT_SIZE.paddingX;
  const previewPadY = Number.isFinite(sizeCfg.paddingY) ? sizeCfg.paddingY : DEFAULT_SIZE.paddingY;
  const previewStyle = {
    ...getBackgroundStyle(isHovered ? style.hover : style.background),
    border: `${style.border.width}px ${style.border.style} ${style.border.color}`,
    borderRadius: `${style.radius}px`,
    color: isHovered ? style.hoverTextColor : style.textColor,
    padding: `${previewPadY}px ${previewPadX}px`,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px'
  };

  // Default-icon preview helpers. The icon block is additive — when no icon
  // is configured (`name === ''`) nothing is rendered. Icon colour falls back
  // to the button's current text colour when left blank.
  const iconCfg = style.icon || DEFAULT_ICON;
  const iconSizePx = Number.isFinite(iconCfg.size) ? iconCfg.size : DEFAULT_ICON.size;
  const iconPosition = iconCfg.position === 'after' ? 'after' : 'before';

  const renderPreviewInner = (textColor, label) => {
    // renderStyleIcon supports both Lucide names and Font Awesome classes.
    const iconEl = iconCfg.name
      ? renderStyleIcon(iconCfg.name, iconSizePx, iconCfg.color || textColor)
      : null;
    // Typography style provides the base font; the button's own text colour and
    // optional label-size override win on top (matches the live render paths).
    const labelSpanStyle = composeButtonLabelStyle({
      typographyCss: labelTypoCss,
      textColor,
      labelSize: style.labelSize,
    }) || undefined;
    return iconPosition === 'after' ? (
      <>
        <span style={labelSpanStyle}>{label}</span>
        {iconEl}
      </>
    ) : (
      <>
        {iconEl}
        <span style={labelSpanStyle}>{label}</span>
      </>
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {editableLabel ? (
              <Input
                value={title}
                onChange={(e) => onLabelChange && onLabelChange(e.target.value)}
                className="text-lg font-semibold"
                placeholder="Style name"
                data-testid={`input-${testIdPrefix}-label`}
              />
            ) : (
              <CardTitle className="text-lg">{title}</CardTitle>
            )}
            {description && <CardDescription className="mt-1">{description}</CardDescription>}
            {onMicrositesChange && (
              <div className="mt-3" data-testid={`microsites-${testIdPrefix}`}>
                <Label className="text-xs text-slate-600">Available on</Label>
                {(!micrositeOptions || micrositeOptions.length === 0) ? (
                  <p className="text-xs text-slate-500 mt-1">
                    No microsites yet. This style is available on your main site.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5 mt-1.5">
                      {micrositeOptions.map((m) => {
                        const idStr = String(m.id);
                        const checked = Array.isArray(selectedMicrosites) && selectedMicrosites.includes(idStr);
                        return (
                          <label
                            key={idStr}
                            className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(v) => {
                                const current = Array.isArray(selectedMicrosites) ? selectedMicrosites : [];
                                const next = v === true
                                  ? [...current.filter((x) => x !== idStr), idStr]
                                  : current.filter((x) => x !== idStr);
                                onMicrositesChange(next);
                              }}
                              data-testid={`checkbox-${testIdPrefix}-microsite-${idStr}`}
                            />
                            <span>{m.name || m.slug || idStr}</span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1.5">
                      Leave all unchecked to make this a main-site style.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          {onDelete && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onDelete}
              data-testid={`button-${testIdPrefix}-delete`}
              aria-label="Delete style"
            >
              <Trash2 className="w-4 h-4 text-red-500" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Live Preview */}
        <div className="p-6 bg-slate-100 rounded-lg flex items-center justify-center gap-4">
          <div className="text-center">
            <p className="text-xs text-slate-500 mb-2">Normal State</p>
            <button
              className="unstyled"
              style={{
                ...getBackgroundStyle(style.background),
                border: `${style.border.width}px ${style.border.style} ${style.border.color}`,
                borderRadius: `${style.radius}px`,
                color: style.textColor,
                padding: '12px 24px',
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px'
              }}
              data-testid={`preview-${title.toLowerCase().replace(' ', '-')}-normal`}
            >
              {renderPreviewInner(style.textColor, 'Sample Button')}
            </button>
          </div>
          <div className="text-center">
            <p className="text-xs text-slate-500 mb-2">Hover State</p>
            <button
              className="unstyled"
              style={{
                ...getBackgroundStyle(style.hover),
                border: `${style.border.width}px ${style.border.style} ${style.border.color}`,
                borderRadius: `${style.radius}px`,
                color: style.hoverTextColor,
                padding: '12px 24px',
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px'
              }}
              data-testid={`preview-${title.toLowerCase().replace(' ', '-')}-hover`}
            >
              {renderPreviewInner(style.hoverTextColor, 'Sample Button')}
            </button>
          </div>
          <div className="text-center">
            <p className="text-xs text-slate-500 mb-2">Interactive Preview</p>
            <button
              className="unstyled"
              style={previewStyle}
              onMouseEnter={() => setIsHovered(true)}
              onMouseLeave={() => setIsHovered(false)}
              data-testid={`preview-${title.toLowerCase().replace(' ', '-')}-interactive`}
            >
              {renderPreviewInner(isHovered ? style.hoverTextColor : style.textColor, 'Hover Me')}
            </button>
          </div>
        </div>

        {/* Label typography (Task #2591). Baked into the button style so any
            button dropped onto the canvas using this style renders its label
            in this typography automatically. A per-button override in the
            page builder still takes precedence. */}
        <div data-testid={`typography-${testIdPrefix}`}>
          <TypographyStyleSelector
            value={style.labelTypographyStyleId || ''}
            onChange={(styleId) => updateStyle('labelTypographyStyleId', styleId || '')}
            label="Label typography"
            placeholder="Default (no typography style)"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Buttons using this style render their label in this typography automatically. A per-button override in the page builder still wins.
          </p>

          {/* Label size override (Task #2597). The typography style supplies the
              base font; this optionally overrides just the label's font size.
              Leave blank to inherit the typography style's size (or default). */}
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <Label className="text-xs text-slate-600 min-w-32">Label size override</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={8}
                max={72}
                value={style.labelSize ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  updateStyle('labelSize', v === '' ? '' : Number(v));
                }}
                placeholder={labelTypoStyle ? `${labelTypoStyle.font_size}px (typography)` : 'Inherit'}
                className="w-44"
                data-testid={`input-${testIdPrefix}-label-size`}
              />
              <span className="text-sm text-slate-500">px</span>
              {(style.labelSize ?? '') !== '' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => updateStyle('labelSize', '')}
                  data-testid={`button-${testIdPrefix}-label-size-clear`}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Overrides the label font size on top of the typography style. The button's text colour also always applies to the label.
          </p>
        </div>

        <Tabs defaultValue="background" className="w-full">
          <TabsList className="grid w-full grid-cols-6">
            <TabsTrigger value="background" data-testid={`tab-${testIdPrefix}-background`}>Background</TabsTrigger>
            <TabsTrigger value="border" data-testid={`tab-${testIdPrefix}-border`}>Border</TabsTrigger>
            <TabsTrigger value="radius" data-testid={`tab-${testIdPrefix}-radius`}>Radius</TabsTrigger>
            <TabsTrigger value="size" data-testid={`tab-${testIdPrefix}-size`}>Size</TabsTrigger>
            <TabsTrigger value="icon" data-testid={`tab-${testIdPrefix}-icon`}>Icon</TabsTrigger>
            <TabsTrigger value="hover" data-testid={`tab-${testIdPrefix}-hover`}>Hover Effect</TabsTrigger>
          </TabsList>

          {/* Background Tab */}
          <TabsContent value="background" className="space-y-4 pt-4">
            <div className="flex items-center gap-4">
              <Label className="min-w-24">Type:</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`${testIdPrefix}-bg-type`}
                    checked={style.background.type === 'solid'}
                    onChange={() => updateStyle('background.type', 'solid')}
                    className="w-4 h-4"
                    data-testid={`radio-${testIdPrefix}-bg-solid`}
                  />
                  <span className="text-sm">Solid</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`${testIdPrefix}-bg-type`}
                    checked={style.background.type === 'gradient'}
                    onChange={() => updateStyle('background.type', 'gradient')}
                    className="w-4 h-4"
                    data-testid={`radio-${testIdPrefix}-bg-gradient`}
                  />
                  <span className="text-sm">Gradient</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`${testIdPrefix}-bg-type`}
                    checked={style.background.type === 'transparent'}
                    onChange={() => updateStyle('background.type', 'transparent')}
                    className="w-4 h-4"
                    data-testid={`radio-${testIdPrefix}-bg-transparent`}
                  />
                  <span className="text-sm">Transparent</span>
                </label>
              </div>
            </div>

            {style.background.type === 'transparent' ? (
              <div
                className="flex items-center gap-4 p-4 rounded border border-dashed border-slate-300"
                data-testid={`explainer-${testIdPrefix}-bg-transparent`}
              >
                <div
                  className="w-16 h-10 rounded border border-slate-300 shrink-0"
                  style={{
                    backgroundImage:
                      'linear-gradient(45deg, #cbd5e1 25%, transparent 25%), linear-gradient(-45deg, #cbd5e1 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #cbd5e1 75%), linear-gradient(-45deg, transparent 75%, #cbd5e1 75%)',
                    backgroundSize: '12px 12px',
                    backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px'
                  }}
                  aria-hidden="true"
                />
                <p className="text-sm text-slate-600">
                  No fill — the button background is fully transparent. Use the Border tab to outline the button if needed.
                </p>
              </div>
            ) : style.background.type === 'solid' ? (
              <div className="flex items-center gap-4">
                <Label className="min-w-24">Color:</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={style.background.solidColor === 'transparent' ? '#ffffff' : style.background.solidColor}
                    onChange={(e) => updateStyle('background.solidColor', e.target.value)}
                    className="w-10 h-10 rounded cursor-pointer"
                    data-testid={`colorpicker-${testIdPrefix}-bg-solid`}
                  />
                  <Input
                    value={style.background.solidColor}
                    onChange={(e) => updateStyle('background.solidColor', e.target.value)}
                    className="w-32"
                    placeholder="#000000 or transparent"
                    data-testid={`input-${testIdPrefix}-bg-solid`}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-4">
                  <Label className="min-w-24">Angle:</Label>
                  <div className="flex items-center gap-3 flex-1">
                    <div 
                      className="relative w-12 h-12 rounded-full border-2 border-slate-300 flex items-center justify-center cursor-pointer"
                      style={{ background: 'conic-gradient(from 0deg, #e2e8f0, #94a3b8, #e2e8f0)' }}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const x = e.clientX - rect.left - rect.width / 2;
                        const y = e.clientY - rect.top - rect.height / 2;
                        let angle = Math.round(Math.atan2(y, x) * (180 / Math.PI) + 90);
                        if (angle < 0) angle += 360;
                        updateStyle('background.gradientAngle', angle);
                      }}
                      data-testid={`angle-wheel-${testIdPrefix}-bg`}
                    >
                      <div 
                        className="absolute w-1 h-5 bg-slate-800 rounded origin-bottom"
                        style={{ 
                          transform: `rotate(${(style.background.gradientAngle || 90)}deg)`,
                          bottom: '50%'
                        }}
                      />
                    </div>
                    <Input
                      type="number"
                      min="0"
                      max="360"
                      value={style.background.gradientAngle ?? 90}
                      onChange={(e) => updateStyle('background.gradientAngle', parseInt(e.target.value, 10) || 0)}
                      className="w-20"
                      data-testid={`input-${testIdPrefix}-gradient-angle`}
                    />
                    <span className="text-sm text-slate-500">degrees</span>
                  </div>
                </div>
                
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Color Stops:</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const stops = style.background.gradientStops || [];
                        const newPosition = stops.length > 0 
                          ? Math.round((stops[stops.length - 1].position + 100) / 2)
                          : 50;
                        updateStyle('background.gradientStops', [
                          ...stops,
                          { color: '#888888', position: Math.min(newPosition, 99) }
                        ].sort((a, b) => a.position - b.position));
                      }}
                      data-testid={`button-${testIdPrefix}-add-stop`}
                    >
                      <Plus className="w-4 h-4 mr-1" /> Add Stop
                    </Button>
                  </div>
                  
                  <div 
                    className="h-6 rounded"
                    style={getBackgroundStyle(style.background)}
                    data-testid={`gradient-preview-${testIdPrefix}-bg`}
                  />
                  
                  {(style.background.gradientStops || []).map((stop, index) => (
                    <div key={index} className="flex items-center gap-3">
                      <input
                        type="color"
                        value={stop.color}
                        onChange={(e) => {
                          const newStops = [...(style.background.gradientStops || [])];
                          newStops[index] = { ...newStops[index], color: e.target.value };
                          updateStyle('background.gradientStops', newStops);
                        }}
                        className="w-10 h-10 rounded cursor-pointer"
                        data-testid={`colorpicker-${testIdPrefix}-stop-${index}`}
                      />
                      <Input
                        value={stop.color}
                        onChange={(e) => {
                          const newStops = [...(style.background.gradientStops || [])];
                          newStops[index] = { ...newStops[index], color: e.target.value };
                          updateStyle('background.gradientStops', newStops);
                        }}
                        className="w-28"
                        data-testid={`input-${testIdPrefix}-stop-color-${index}`}
                      />
                      <div className="flex items-center gap-2 flex-1">
                        <Slider
                          value={[stop.position]}
                          onValueChange={([val]) => {
                            const newStops = [...(style.background.gradientStops || [])];
                            newStops[index] = { ...newStops[index], position: val };
                            updateStyle('background.gradientStops', newStops.sort((a, b) => a.position - b.position));
                          }}
                          min={0}
                          max={100}
                          step={1}
                          className="flex-1"
                          data-testid={`slider-${testIdPrefix}-stop-${index}`}
                        />
                        <span className="text-sm text-slate-500 w-10">{stop.position}%</span>
                      </div>
                      {(style.background.gradientStops || []).length > 2 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            const newStops = (style.background.gradientStops || []).filter((_, i) => i !== index);
                            updateStyle('background.gradientStops', newStops);
                          }}
                          data-testid={`button-${testIdPrefix}-remove-stop-${index}`}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="flex items-center gap-4">
              <Label className="min-w-24">Text Color:</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={style.textColor}
                  onChange={(e) => updateStyle('textColor', e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer"
                  data-testid={`colorpicker-${testIdPrefix}-text-color`}
                />
                <Input
                  value={style.textColor}
                  onChange={(e) => updateStyle('textColor', e.target.value)}
                  className="w-32"
                  data-testid={`input-${testIdPrefix}-text-color`}
                />
              </div>
            </div>
          </TabsContent>

          {/* Border Tab */}
          <TabsContent value="border" className="space-y-4 pt-4">
            <div className="flex items-center gap-4">
              <Label className="min-w-24">Width:</Label>
              <div className="flex items-center gap-4 flex-1">
                <Slider
                  value={[style.border.width]}
                  onValueChange={([val]) => updateStyle('border.width', val)}
                  max={10}
                  step={1}
                  className="flex-1"
                  data-testid={`slider-${testIdPrefix}-border-width`}
                />
                <span className="text-sm text-slate-500 w-12" data-testid={`text-${testIdPrefix}-border-width-value`}>{style.border.width}px</span>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Label className="min-w-24">Color:</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={style.border.color}
                  onChange={(e) => updateStyle('border.color', e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer"
                  data-testid={`colorpicker-${testIdPrefix}-border-color`}
                />
                <Input
                  value={style.border.color}
                  onChange={(e) => updateStyle('border.color', e.target.value)}
                  className="w-32"
                  data-testid={`input-${testIdPrefix}-border-color`}
                />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Label className="min-w-24">Style:</Label>
              <select
                value={style.border.style}
                onChange={(e) => updateStyle('border.style', e.target.value)}
                className="border rounded px-3 py-2 text-sm"
                data-testid={`select-${testIdPrefix}-border-style`}
              >
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
                <option value="dotted">Dotted</option>
              </select>
            </div>
          </TabsContent>

          {/* Radius Tab */}
          <TabsContent value="radius" className="space-y-4 pt-4">
            <div className="flex items-center gap-4">
              <Label className="min-w-24">Radius:</Label>
              <div className="flex items-center gap-4 flex-1">
                <Slider
                  value={[style.radius]}
                  onValueChange={([val]) => updateStyle('radius', val)}
                  max={50}
                  step={1}
                  className="flex-1"
                  data-testid={`slider-${testIdPrefix}-radius`}
                />
                <span className="text-sm text-slate-500 w-12" data-testid={`text-${testIdPrefix}-radius-value`}>{style.radius}px</span>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              Set to 50px for fully rounded pill-shaped buttons
            </p>
          </TabsContent>

          {/* Size Tab */}
          <TabsContent value="size" className="space-y-4 pt-4">
            <p className="text-xs text-slate-500">
              These dimensions are applied when the button is used on canvas
              pages (Tenant primary / Tenant secondary variants). Other
              frontend consumers continue to use their own sizing.
            </p>

            <div className="flex items-center gap-4">
              <Label className="min-w-32">Horizontal padding:</Label>
              <div className="flex items-center gap-4 flex-1">
                <Slider
                  value={[style.size?.paddingX ?? DEFAULT_SIZE.paddingX]}
                  onValueChange={([val]) => updateStyle('size.paddingX', val)}
                  min={0}
                  max={64}
                  step={1}
                  className="flex-1"
                  data-testid={`slider-${testIdPrefix}-size-padding-x`}
                />
                <span className="text-sm text-slate-500 w-12" data-testid={`text-${testIdPrefix}-size-padding-x-value`}>
                  {style.size?.paddingX ?? DEFAULT_SIZE.paddingX}px
                </span>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Label className="min-w-32">Vertical padding:</Label>
              <div className="flex items-center gap-4 flex-1">
                <Slider
                  value={[style.size?.paddingY ?? DEFAULT_SIZE.paddingY]}
                  onValueChange={([val]) => updateStyle('size.paddingY', val)}
                  min={0}
                  max={40}
                  step={1}
                  className="flex-1"
                  data-testid={`slider-${testIdPrefix}-size-padding-y`}
                />
                <span className="text-sm text-slate-500 w-12" data-testid={`text-${testIdPrefix}-size-padding-y-value`}>
                  {style.size?.paddingY ?? DEFAULT_SIZE.paddingY}px
                </span>
              </div>
            </div>
          </TabsContent>

          {/* Icon Tab */}
          <TabsContent value="icon" className="space-y-4 pt-4">
            <p className="text-xs text-slate-500">
              Set a default icon for this button style. It shows in the previews
              above and on tenant-variant buttons placed on published pages. A
              per-block icon chosen in the page builder overrides this default.
            </p>

            <div className="flex items-center gap-4 flex-wrap">
              <Label className="min-w-32">Icon:</Label>
              <div className="flex items-center gap-3 flex-1 flex-wrap">
                <select
                  value={isFaIconName(style.icon?.name) ? '' : (style.icon?.name || '')}
                  onChange={(e) => updateStyle('icon.name', e.target.value)}
                  className="border rounded px-3 py-2 text-sm flex-1"
                  data-testid={`select-${testIdPrefix}-icon-name`}
                >
                  <option value="">
                    {isFaIconName(style.icon?.name) ? 'Font Awesome icon selected' : 'None'}
                  </option>
                  {Object.keys(LUCIDE_ICONS).map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setFaPickerOpen(true)}
                  data-testid={`button-${testIdPrefix}-fa-icon-picker`}
                >
                  Browse icon library
                </Button>
                {style.icon?.name ? (
                  <span className="shrink-0 inline-flex" data-testid={`icon-preview-${testIdPrefix}`}>
                    {renderStyleIcon(
                      style.icon.name,
                      style.icon?.size ?? DEFAULT_ICON.size,
                      style.icon?.color || style.textColor
                    )}
                  </span>
                ) : null}
              </div>
            </div>
            {isFaIconName(style.icon?.name) ? (
              <p className="text-xs text-slate-500">
                Using icon library icon: <code>{style.icon.name}</code>. Pick from the
                dropdown or choose another library icon to replace it.
              </p>
            ) : null}
            <FontAwesomeIconPicker
              open={faPickerOpen}
              onClose={() => setFaPickerOpen(false)}
              currentValue={isFaIconName(style.icon?.name) ? style.icon.name : ''}
              onSelect={(cls) => {
                updateStyle('icon.name', cls || '');
                setFaPickerOpen(false);
              }}
            />

            {style.icon?.name ? (
              <>
                <div className="flex items-center gap-4">
                  <Label className="min-w-32">Icon size:</Label>
                  <div className="flex items-center gap-4 flex-1">
                    <Slider
                      value={[style.icon?.size ?? DEFAULT_ICON.size]}
                      onValueChange={([val]) => updateStyle('icon.size', val)}
                      min={10}
                      max={48}
                      step={1}
                      className="flex-1"
                      data-testid={`slider-${testIdPrefix}-icon-size`}
                    />
                    <span className="text-sm text-slate-500 w-12" data-testid={`text-${testIdPrefix}-icon-size-value`}>
                      {style.icon?.size ?? DEFAULT_ICON.size}px
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <Label className="min-w-32">Icon color:</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={(style.icon?.color || style.textColor) === 'transparent' ? '#ffffff' : (style.icon?.color || style.textColor)}
                      onChange={(e) => updateStyle('icon.color', e.target.value)}
                      className="w-10 h-10 rounded cursor-pointer"
                      data-testid={`colorpicker-${testIdPrefix}-icon-color`}
                    />
                    <Input
                      value={style.icon?.color || ''}
                      onChange={(e) => updateStyle('icon.color', e.target.value)}
                      className="w-40"
                      placeholder="Inherit text color"
                      data-testid={`input-${testIdPrefix}-icon-color`}
                    />
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  Leave blank to use the button's text colour. The icon colour can differ from the label.
                </p>

                <div className="flex items-center gap-4">
                  <Label className="min-w-32">Position:</Label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name={`${testIdPrefix}-icon-position`}
                        checked={(style.icon?.position || 'before') === 'before'}
                        onChange={() => updateStyle('icon.position', 'before')}
                        className="w-4 h-4"
                        data-testid={`radio-${testIdPrefix}-icon-before`}
                      />
                      <span className="text-sm">Before label</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name={`${testIdPrefix}-icon-position`}
                        checked={style.icon?.position === 'after'}
                        onChange={() => updateStyle('icon.position', 'after')}
                        className="w-4 h-4"
                        data-testid={`radio-${testIdPrefix}-icon-after`}
                      />
                      <span className="text-sm">After label</span>
                    </label>
                  </div>
                </div>
              </>
            ) : null}
          </TabsContent>

          {/* Hover Tab */}
          <TabsContent value="hover" className="space-y-4 pt-4">
            <div className="flex items-center gap-4">
              <Label className="min-w-24">Type:</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`${testIdPrefix}-hover-type`}
                    checked={style.hover.type === 'solid'}
                    onChange={() => updateStyle('hover.type', 'solid')}
                    className="w-4 h-4"
                    data-testid={`radio-${testIdPrefix}-hover-solid`}
                  />
                  <span className="text-sm">Solid</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`${testIdPrefix}-hover-type`}
                    checked={style.hover.type === 'gradient'}
                    onChange={() => updateStyle('hover.type', 'gradient')}
                    className="w-4 h-4"
                    data-testid={`radio-${testIdPrefix}-hover-gradient`}
                  />
                  <span className="text-sm">Gradient</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`${testIdPrefix}-hover-type`}
                    checked={style.hover.type === 'transparent'}
                    onChange={() => updateStyle('hover.type', 'transparent')}
                    className="w-4 h-4"
                    data-testid={`radio-${testIdPrefix}-hover-transparent`}
                  />
                  <span className="text-sm">Transparent</span>
                </label>
              </div>
            </div>

            {style.hover.type === 'transparent' ? (
              <div
                className="flex items-center gap-4 p-4 rounded border border-dashed border-slate-300"
                data-testid={`explainer-${testIdPrefix}-hover-transparent`}
              >
                <div
                  className="w-16 h-10 rounded border border-slate-300 shrink-0"
                  style={{
                    backgroundImage:
                      'linear-gradient(45deg, #cbd5e1 25%, transparent 25%), linear-gradient(-45deg, #cbd5e1 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #cbd5e1 75%), linear-gradient(-45deg, transparent 75%, #cbd5e1 75%)',
                    backgroundSize: '12px 12px',
                    backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px'
                  }}
                  aria-hidden="true"
                />
                <p className="text-sm text-slate-600">
                  No fill on hover — the button background becomes fully transparent. Pair with a hover border / text colour to keep the hover state visible.
                </p>
              </div>
            ) : style.hover.type === 'solid' ? (
              <div className="flex items-center gap-4">
                <Label className="min-w-24">Color:</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={style.hover.solidColor}
                    onChange={(e) => updateStyle('hover.solidColor', e.target.value)}
                    className="w-10 h-10 rounded cursor-pointer"
                    data-testid={`colorpicker-${testIdPrefix}-hover-solid`}
                  />
                  <Input
                    value={style.hover.solidColor}
                    onChange={(e) => updateStyle('hover.solidColor', e.target.value)}
                    className="w-32"
                    data-testid={`input-${testIdPrefix}-hover-solid`}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-4">
                  <Label className="min-w-24">Angle:</Label>
                  <div className="flex items-center gap-3 flex-1">
                    <div 
                      className="relative w-12 h-12 rounded-full border-2 border-slate-300 flex items-center justify-center cursor-pointer"
                      style={{ background: 'conic-gradient(from 0deg, #e2e8f0, #94a3b8, #e2e8f0)' }}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const x = e.clientX - rect.left - rect.width / 2;
                        const y = e.clientY - rect.top - rect.height / 2;
                        let angle = Math.round(Math.atan2(y, x) * (180 / Math.PI) + 90);
                        if (angle < 0) angle += 360;
                        updateStyle('hover.gradientAngle', angle);
                      }}
                      data-testid={`angle-wheel-${testIdPrefix}-hover`}
                    >
                      <div 
                        className="absolute w-1 h-5 bg-slate-800 rounded origin-bottom"
                        style={{ 
                          transform: `rotate(${(style.hover.gradientAngle || 90)}deg)`,
                          bottom: '50%'
                        }}
                      />
                    </div>
                    <Input
                      type="number"
                      min="0"
                      max="360"
                      value={style.hover.gradientAngle ?? 90}
                      onChange={(e) => updateStyle('hover.gradientAngle', parseInt(e.target.value, 10) || 0)}
                      className="w-20"
                      data-testid={`input-${testIdPrefix}-hover-gradient-angle`}
                    />
                    <span className="text-sm text-slate-500">degrees</span>
                  </div>
                </div>
                
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Color Stops:</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const stops = style.hover.gradientStops || [];
                        const newPosition = stops.length > 0 
                          ? Math.round((stops[stops.length - 1].position + 100) / 2)
                          : 50;
                        updateStyle('hover.gradientStops', [
                          ...stops,
                          { color: '#888888', position: Math.min(newPosition, 99) }
                        ].sort((a, b) => a.position - b.position));
                      }}
                      data-testid={`button-${testIdPrefix}-hover-add-stop`}
                    >
                      <Plus className="w-4 h-4 mr-1" /> Add Stop
                    </Button>
                  </div>
                  
                  <div 
                    className="h-6 rounded"
                    style={getBackgroundStyle(style.hover)}
                    data-testid={`gradient-preview-${testIdPrefix}-hover`}
                  />
                  
                  {(style.hover.gradientStops || []).map((stop, index) => (
                    <div key={index} className="flex items-center gap-3">
                      <input
                        type="color"
                        value={stop.color}
                        onChange={(e) => {
                          const newStops = [...(style.hover.gradientStops || [])];
                          newStops[index] = { ...newStops[index], color: e.target.value };
                          updateStyle('hover.gradientStops', newStops);
                        }}
                        className="w-10 h-10 rounded cursor-pointer"
                        data-testid={`colorpicker-${testIdPrefix}-hover-stop-${index}`}
                      />
                      <Input
                        value={stop.color}
                        onChange={(e) => {
                          const newStops = [...(style.hover.gradientStops || [])];
                          newStops[index] = { ...newStops[index], color: e.target.value };
                          updateStyle('hover.gradientStops', newStops);
                        }}
                        className="w-28"
                        data-testid={`input-${testIdPrefix}-hover-stop-color-${index}`}
                      />
                      <div className="flex items-center gap-2 flex-1">
                        <Slider
                          value={[stop.position]}
                          onValueChange={([val]) => {
                            const newStops = [...(style.hover.gradientStops || [])];
                            newStops[index] = { ...newStops[index], position: val };
                            updateStyle('hover.gradientStops', newStops.sort((a, b) => a.position - b.position));
                          }}
                          min={0}
                          max={100}
                          step={1}
                          className="flex-1"
                          data-testid={`slider-${testIdPrefix}-hover-stop-${index}`}
                        />
                        <span className="text-sm text-slate-500 w-10">{stop.position}%</span>
                      </div>
                      {(style.hover.gradientStops || []).length > 2 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            const newStops = (style.hover.gradientStops || []).filter((_, i) => i !== index);
                            updateStyle('hover.gradientStops', newStops);
                          }}
                          data-testid={`button-${testIdPrefix}-hover-remove-stop-${index}`}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="flex items-center gap-4">
              <Label className="min-w-24">Hover Text:</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={style.hoverTextColor}
                  onChange={(e) => updateStyle('hoverTextColor', e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer"
                  data-testid={`colorpicker-${testIdPrefix}-hover-text-color`}
                />
                <Input
                  value={style.hoverTextColor}
                  onChange={(e) => updateStyle('hoverTextColor', e.target.value)}
                  className="w-32"
                  data-testid={`input-${testIdPrefix}-hover-text-color`}
                />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export default function ButtonElementsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  const [primaryStyle, setPrimaryStyle] = useState(DEFAULT_PRIMARY_STYLE);
  const [secondaryStyle, setSecondaryStyle] = useState(DEFAULT_SECONDARY_STYLE);
  // Free-form additional tenant button styles. Stored as an ordered array
  // so the UI can render them with stable keys; saved as a map keyed by
  // `key`. `key` is the persisted map-key — immutable once saved so canvas
  // Button blocks already referencing `tenant:<key>` keep resolving. `label`
  // is the human-readable name shown in the canvas Variant dropdown.
  const [customStyles, setCustomStyles] = useState([]);
  // Tenant microsites, for the per-custom-style assignment picker. A custom
  // style with 0 assigned microsites is a main-site style; otherwise it is
  // offered only on the assigned microsites' pages in the canvas builder
  // (render path is never filtered — Task #2562).
  const [microsites, setMicrosites] = useState([]);

  // Scope filter: '' = main site; otherwise a microsite id. Filters the
  // additional custom styles list to one scope and targets new styles to it.
  const [selectedScope, setSelectedScope] = useState('');

  // Slugify a label to a kebab-case key, ensuring it doesn't collide with
  // reserved keys (`primary`, `secondary`) or any other existing key.
  const slugifyKey = (label, existingKeys) => {
    const base = (label || 'new-style')
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'new-style';
    const reserved = new Set(['primary', 'secondary', ...existingKeys]);
    if (!reserved.has(base)) return base;
    let n = 2;
    while (reserved.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  };

  const addCustomStyle = () => {
    setCustomStyles((prev) => {
      const key = slugifyKey('New style', prev.map((c) => c.key));
      // Deep clone of the primary defaults so user starts from a familiar
      // base; they can rebrand colors/radius/size from there.
      const clone = JSON.parse(JSON.stringify(DEFAULT_PRIMARY_STYLE));
      // `isNew` is a UI-only flag (stripped on save) that allows the key
      // to be re-slugified from the label until the first save lands.
      // `uid` is a UI-only stable identity used as the React list key and as
      // the target for update/rename/delete. It must NOT be the mutable
      // slugified `key`, or re-slugifying on each keystroke remounts the row
      // and the rename input loses focus after one character (Task #2562).
      // Default the new style's scope to whatever scope is currently
      // selected: a specific microsite -> assigned to it; main site -> [].
      const initialMicrosites = selectedScope ? [String(selectedScope)] : [];
      return [...prev, { uid: genCustomStyleUid(), key, label: 'New style', isNew: true, microsites: initialMicrosites, ...clone }];
    });
  };

  const updateCustomStyle = (uid, nextStyle) => {
    setCustomStyles((prev) =>
      prev.map((c) =>
        c.uid === uid
          ? { ...nextStyle, uid: c.uid, key: c.key, label: c.label, isNew: c.isNew, microsites: c.microsites }
          : c
      )
    );
  };

  const renameCustomStyle = (uid, nextLabel) => {
    setCustomStyles((prev) => {
      // For brand-new (never-saved) entries we re-slugify the map-key from
      // the label on every keystroke, so the persisted key reflects the
      // user's chosen name on first save. Once saved (`isNew` is cleared),
      // the key is immutable to keep already-placed canvas Button blocks
      // resolvable. Rows are targeted by the stable `uid`, never the mutable
      // `key`, so re-slugifying doesn't remount the row (Task #2562).
      return prev.map((c) => {
        if (c.uid !== uid) return c;
        if (!c.isNew) return { ...c, label: nextLabel };
        const otherKeys = prev.filter((x) => x.uid !== uid).map((x) => x.key);
        const nextKey = slugifyKey(nextLabel, otherKeys);
        return { ...c, label: nextLabel, key: nextKey };
      });
    });
  };

  const setCustomStyleMicrosites = (uid, nextMicrosites) => {
    setCustomStyles((prev) =>
      prev.map((c) =>
        c.uid === uid
          ? { ...c, microsites: Array.isArray(nextMicrosites) ? nextMicrosites.map(String) : [] }
          : c
      )
    );
  };

  const deleteCustomStyle = (uid) => {
    setCustomStyles((prev) => prev.filter((c) => c.uid !== uid));
  };

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('site-builder.buttons')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // Fetch existing button styles from tenant branding
  useEffect(() => {
    const fetchButtonStyles = async () => {
      try {
        const response = await fetch('/api/admin/tenant-branding', {
          credentials: 'include'
        });
        
        if (response.ok) {
          const data = await response.json();
          const buttonStyles = data.branding?.branding_config?.button_styles;
          
          if (buttonStyles) {
            // Task #961: for transparent blocks, skip the default-merge so
            // we don't inject default `solidColor` / `gradientStops` into
            // an intentionally fill-less config. Solid/gradient blocks
            // still get the same gradient + defaults migration as before.
            const mergeBgBlock = (defaultBlock, incoming) => {
              if (incoming && incoming.type === 'transparent') {
                return { ...incoming };
              }
              return migrateGradientConfig({ ...defaultBlock, ...(incoming || {}) });
            };
            if (buttonStyles.primary) {
              const migratedPrimary = {
                ...DEFAULT_PRIMARY_STYLE,
                ...buttonStyles.primary,
                background: mergeBgBlock(DEFAULT_PRIMARY_STYLE.background, buttonStyles.primary.background),
                hover: mergeBgBlock(DEFAULT_PRIMARY_STYLE.hover, buttonStyles.primary.hover),
                size: { ...DEFAULT_SIZE, ...(buttonStyles.primary.size || {}) },
                icon: { ...DEFAULT_ICON, ...(buttonStyles.primary.icon || {}) }
              };
              setPrimaryStyle(migratedPrimary);
            }
            if (buttonStyles.secondary) {
              const migratedSecondary = {
                ...DEFAULT_SECONDARY_STYLE,
                ...buttonStyles.secondary,
                background: mergeBgBlock(DEFAULT_SECONDARY_STYLE.background, buttonStyles.secondary.background),
                hover: mergeBgBlock(DEFAULT_SECONDARY_STYLE.hover, buttonStyles.secondary.hover),
                size: { ...DEFAULT_SIZE, ...(buttonStyles.secondary.size || {}) },
                icon: { ...DEFAULT_ICON, ...(buttonStyles.secondary.icon || {}) }
              };
              setSecondaryStyle(migratedSecondary);
            }
            // Load any custom (non-primary/secondary) entries — they all
            // share the same shape and the same per-key migration as the
            // two reserved keys.
            const loadedCustom = [];
            Object.entries(buttonStyles).forEach(([key, entry]) => {
              if (key === 'primary' || key === 'secondary') return;
              if (!entry || typeof entry !== 'object') return;
              loadedCustom.push({
                uid: genCustomStyleUid(),
                key,
                label: entry.label || key,
                ...DEFAULT_PRIMARY_STYLE,
                ...entry,
                // Coerce persisted microsite assignments to an array of id
                // strings (additive: older entries with no `microsites` load
                // as a main-site style).
                microsites: Array.isArray(entry.microsites) ? entry.microsites.map(String) : [],
                background: mergeBgBlock(DEFAULT_PRIMARY_STYLE.background, entry.background),
                hover: mergeBgBlock(DEFAULT_PRIMARY_STYLE.hover, entry.hover),
                size: { ...DEFAULT_SIZE, ...(entry.size || {}) },
                icon: { ...DEFAULT_ICON, ...(entry.icon || {}) }
              });
            });
            if (loadedCustom.length > 0) setCustomStyles(loadedCustom);
          }
        }
      } catch (error) {
        console.error('Failed to fetch button styles:', error);
      } finally {
        setLoading(false);
      }
    };

    if (accessChecked) {
      fetchButtonStyles();
    }
  }, [accessChecked]);

  // Load the tenant's microsites for the per-custom-style assignment picker.
  // Failure is non-fatal: with no list, custom styles simply behave as
  // main-site styles.
  useEffect(() => {
    if (!accessChecked) return;
    const fetchMicrosites = async () => {
      try {
        const response = await fetch('/api/admin/microsites', { credentials: 'include' });
        if (!response.ok) return;
        const data = await response.json();
        if (Array.isArray(data?.microsites)) setMicrosites(data.microsites);
      } catch (error) {
        console.error('Failed to fetch microsites:', error);
      }
    };
    fetchMicrosites();
  }, [accessChecked]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // First fetch current branding to get existing branding_config
      const getResponse = await fetch('/api/admin/tenant-branding', {
        credentials: 'include'
      });
      
      if (!getResponse.ok) {
        throw new Error('Failed to fetch current branding');
      }
      
      const currentData = await getResponse.json();
      const currentBrandingConfig = currentData.branding?.branding_config || {};
      
      // Build the full button_styles map: primary, secondary, plus every
      // custom entry keyed by its stable map-key. The UI array form is
      // collapsed back to an object so the existing storage contract is
      // unchanged.
      const customMap = {};
      customStyles.forEach(({ key, label, isNew: _isNew, uid: _uid, microsites: entryMicrosites, ...rest }) => {
        if (!key) return;
        // Strip the UI-only `key`, `isNew` and `uid` fields; keep `label` so
        // it round-trips. The key becomes the object map-key on save.
        // Persist `microsites` as an array of id strings ([] = main-site).
        customMap[key] = {
          label: label || key,
          microsites: Array.isArray(entryMicrosites) ? entryMicrosites.map(String) : [],
          ...rest,
        };
      });
      const updatedBrandingConfig = {
        ...currentBrandingConfig,
        button_styles: {
          primary: primaryStyle,
          secondary: secondaryStyle,
          ...customMap
        }
      };
      
      // Save back to tenant branding
      const response = await fetch('/api/admin/tenant-branding', {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          branding_config: updatedBrandingConfig
        })
      });
      
      if (!response.ok) {
        throw new Error('Failed to save button styles');
      }
      
      // Clear the `isNew` flag from any newly-added custom entries — once
      // saved, their map-keys are frozen and renames will only update the
      // human-readable label going forward.
      setCustomStyles((prev) => prev.map((c) => (c.isNew ? { ...c, isNew: false } : c)));
      toast.success('Button styles saved successfully!');
    } catch (error) {
      console.error('Save error:', error);
      toast.error('Failed to save button styles');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setPrimaryStyle(DEFAULT_PRIMARY_STYLE);
    setSecondaryStyle(DEFAULT_SECONDARY_STYLE);
    setCustomStyles([]);
    toast.info('Button styles reset to defaults');
  };

  if (!accessChecked || loading) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  // Only show custom styles belonging to the selected scope: an empty
  // `microsites` array is a main-site style; otherwise membership in the
  // selected microsite id. Primary/Secondary defaults are global and shown
  // regardless of scope.
  const scopedCustomStyles = customStyles.filter((entry) => {
    const assigned = Array.isArray(entry.microsites) ? entry.microsites.map(String) : [];
    return selectedScope ? assigned.includes(String(selectedScope)) : assigned.length === 0;
  });

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Button Style Creator
            </h1>
            <p className="text-slate-600">
              Define primary and secondary button styles for your portal. These styles can be used when configuring navigation buttons and other frontend elements.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleReset}
              data-testid="button-reset-styles"
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              Reset
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              data-testid="button-save-styles"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Styles
            </Button>
          </div>
        </div>

        {/* Style Editors */}
        <div className="grid lg:grid-cols-2 gap-8">
          <ButtonStyleEditor
            style={primaryStyle}
            onChange={setPrimaryStyle}
            title="Primary Button"
            description="Main call-to-action buttons with bold, attention-grabbing styling"
          />
          
          <ButtonStyleEditor
            style={secondaryStyle}
            onChange={setSecondaryStyle}
            title="Secondary Button"
            description="Alternative buttons for less prominent actions, often with outline styling"
          />
        </div>

        {/* Additional (free-form) button styles — canvas Button block only */}
        <div className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Additional button styles</h2>
              <p className="text-sm text-slate-600">
                Extra named styles available in the page builder's Button block. Use these for contrast against specific section backgrounds (e.g. "On dark hero", "On orange banner"). Primary and Secondary above remain the defaults used by navigation, header, and IEdit CTA buttons.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {/* Scope switcher — main site + each active microsite */}
              <div className="flex items-center gap-2">
                <Label htmlFor="button-style-scope" className="text-sm text-slate-600 whitespace-nowrap">Scope</Label>
                <Select
                  value={selectedScope || MAIN_SITE_SCOPE_VALUE}
                  onValueChange={(v) => setSelectedScope(v === MAIN_SITE_SCOPE_VALUE ? '' : v)}
                >
                  <SelectTrigger id="button-style-scope" className="w-48" data-testid="select-button-style-scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={MAIN_SITE_SCOPE_VALUE} data-testid="scope-option-main">Main site</SelectItem>
                    {microsites.map((m) => (
                      <SelectItem key={m.id} value={String(m.id)} data-testid={`scope-option-${m.id}`}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={addCustomStyle}
                data-testid="button-add-custom-style"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add button style
              </Button>
            </div>
          </div>
          {scopedCustomStyles.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-slate-500 text-sm">
                No additional styles in this scope yet. Click "Add button style" to create one.
              </CardContent>
            </Card>
          ) : (
            <div className="grid lg:grid-cols-2 gap-8">
              {scopedCustomStyles.map((entry) => (
                <ButtonStyleEditor
                  key={entry.uid}
                  style={entry}
                  onChange={(next) => updateCustomStyle(entry.uid, next)}
                  title={entry.label}
                  description={`Variant key: tenant:${entry.key}`}
                  editableLabel
                  onLabelChange={(v) => renameCustomStyle(entry.uid, v)}
                  onDelete={() => deleteCustomStyle(entry.uid)}
                  testIdPrefix={`custom-${entry.key}`}
                  micrositeOptions={microsites}
                  selectedMicrosites={entry.microsites}
                  onMicrositesChange={(next) => setCustomStyleMicrosites(entry.uid, next)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Usage Info */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Eye className="w-5 h-5" />
              How to Use These Styles
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-slate-600">
              Once saved, these button styles will be available throughout your portal configuration:
            </p>
            <ul className="mt-3 space-y-2 text-slate-600">
              <li className="flex items-start gap-2">
                <span className="text-primary font-bold">•</span>
                <span><strong>Navigation Management:</strong> When adding navigation items as buttons, select Primary or Secondary style</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary font-bold">•</span>
                <span><strong>Page Builder:</strong> Button blocks will use these predefined styles</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary font-bold">•</span>
                <span><strong>Content Cards:</strong> Action buttons on resource and article cards</span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
