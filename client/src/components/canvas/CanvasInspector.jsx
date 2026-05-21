import { useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Eye, EyeOff, Lock, Unlock, RotateCcw, AlertTriangle, CircleAlert, Info, ArrowUp, ArrowDown, Maximize2 } from 'lucide-react';
import {
  resolveBlockAtBreakpoint,
  hasOverride,
  setBlockBp,
  clearBpOverride,
  BREAKPOINTS,
  BREAKPOINT_WIDTHS,
  validateBlock,
  BLOCK_TYPES,
} from '@/lib/canvasDesign';
import {
  SEVERITY,
  contrastRatio,
  meetsAA,
  blockTextColor,
  blockBackgroundColor,
  blockHeadingLevel,
} from '@/lib/canvasA11y';
import { getBlockDefinition } from './blocks/registry';

function NumberField({ id, label, value, onChange, min, max, step = 1, testId, override, disabled }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs text-slate-600">{label}</Label>
        {override !== undefined && (
          <span
            className={`text-[10px] uppercase tracking-wide ${override ? 'text-warning' : 'text-slate-400'}`}
            title={override ? 'Has breakpoint override' : 'Inherited from larger breakpoint'}
          >
            {override ? 'override' : 'inherited'}
          </span>
        )}
      </div>
      <Input
        id={id}
        type="number"
        value={Number.isFinite(value) ? Math.round(value) : ''}
        onChange={(e) => {
          const v = e.target.value === '' ? null : Number(e.target.value);
          onChange(v);
        }}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="h-8"
        data-testid={testId}
      />
    </div>
  );
}

export default function CanvasInspector({
  selectedBlocks,
  breakpoint,
  blockIssues = [],
  onUpdateBlock,
  onToggleLocked,
  onToggleHidden,
  onClearOverride,
  onReorderBlock,
  readingOrderIndex = -1,
  readingOrderTotal = 0,
}) {
  const single = selectedBlocks.length === 1 ? selectedBlocks[0] : null;

  if (selectedBlocks.length === 0) {
    return (
      <div className="space-y-2" data-testid="inspector-empty">
        <div className="flex items-center gap-2 mb-2">
          <Settings className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-900">Inspector</h2>
        </div>
        <p className="text-xs text-slate-500">
          Select an element on the canvas to edit its properties.
        </p>
      </div>
    );
  }

  if (!single) {
    return (
      <div className="space-y-2" data-testid="inspector-multi">
        <div className="flex items-center gap-2 mb-2">
          <Settings className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-900">Inspector</h2>
        </div>
        <p className="text-xs text-slate-500" data-testid="text-inspector-multi">
          {selectedBlocks.length} elements selected. Use the toolbar to align or
          distribute. Properties shared by all elements can be edited here in
          a later step.
        </p>
      </div>
    );
  }

  return <SingleBlockInspector
    block={single}
    breakpoint={breakpoint}
    blockIssues={blockIssues}
    onUpdate={(updater) => onUpdateBlock(single.id, updater)}
    onToggleLocked={() => onToggleLocked(single.id)}
    onToggleHidden={() => onToggleHidden(single.id)}
    onClearOverride={(field) => onClearOverride(single.id, breakpoint, field)}
    onReorder={onReorderBlock ? (dir) => onReorderBlock(single.id, dir) : null}
    readingOrderIndex={readingOrderIndex}
    readingOrderTotal={readingOrderTotal}
  />;
}

const SEV_ICON = {
  [SEVERITY.ERROR]: CircleAlert,
  [SEVERITY.WARNING]: AlertTriangle,
  [SEVERITY.INFO]: Info,
};
const SEV_CLASS = {
  [SEVERITY.ERROR]: 'text-destructive',
  [SEVERITY.WARNING]: 'text-warning',
  [SEVERITY.INFO]: 'text-slate-500',
};

function A11ySection({ block, issues, onReorder, readingOrderIndex, readingOrderTotal }) {
  const fg = blockTextColor(block);
  const bg = blockBackgroundColor(block);
  const ratio = contrastRatio(fg, bg);
  const isLarge = blockHeadingLevel(block) != null
    || block.type === BLOCK_TYPES.HERO
    || block.type === BLOCK_TYPES.STAT;
  const passes = meetsAA(ratio, { isLargeText: isLarge });

  return (
    <Section title="Accessibility checks">
      {onReorder && readingOrderIndex >= 0 && (
        <div className="flex items-center justify-between gap-2 text-xs text-slate-600 mb-1">
          <span>
            Reading order:&nbsp;
            <span className="font-medium text-slate-800" data-testid="text-reading-order-index">
              {readingOrderIndex + 1} of {readingOrderTotal}
            </span>
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="outline"
              onClick={() => onReorder('up')}
              disabled={readingOrderIndex <= 0}
              title="Move earlier in reading order"
              data-testid="button-reading-order-up"
            >
              <ArrowUp className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              onClick={() => onReorder('down')}
              disabled={readingOrderIndex >= readingOrderTotal - 1}
              title="Move later in reading order"
              data-testid="button-reading-order-down"
            >
              <ArrowDown className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
      {issues.length === 0 ? (
        <div className="text-xs text-slate-600" data-testid="inspector-a11y-clean">
          No accessibility issues detected on this element.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="inspector-a11y-issues">
          {issues.map((it, i) => {
            const Icon = SEV_ICON[it.severity] || Info;
            return (
              <li
                key={`${it.rule}-${i}`}
                className="flex items-start gap-1.5 text-xs"
                data-testid={`inspector-a11y-issue-${it.rule}`}
              >
                <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${SEV_CLASS[it.severity]}`} />
                <div className="min-w-0">
                  <div className="text-slate-700">{it.message}</div>
                  <div className="text-[10px] text-slate-500 font-mono">{it.rule}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {ratio != null && (
        <div
          className={`mt-2 rounded border p-2 text-xs ${
            passes
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-warning/10 border-warning/30 text-warning'
          }`}
          data-testid="inspector-contrast-readout"
          data-passes={passes ? 'true' : 'false'}
        >
          <div className="font-medium">
            Contrast {ratio.toFixed(2)}:1 — {passes ? 'passes' : 'fails'} WCAG AA
          </div>
          <div className="text-[10px] mt-0.5">
            Required: {isLarge ? '3:1 (large text)' : '4.5:1 (body text)'} ·
            text {fg} on {bg}
          </div>
        </div>
      )}
    </Section>
  );
}

function ContentSection({ block, breakpoint, onUpdate }) {
  const def = getBlockDefinition(block.type);
  const InspectorComponent = def.Inspector;
  if (!InspectorComponent) return null;
  const errors = validateBlock(block);
  return (
    <Section title={`Content (${def.label})`}>
      {errors.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning space-y-1" data-testid="inspector-block-errors">
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangle className="w-3.5 h-3.5" /> Required fields missing
          </div>
          <ul className="list-disc pl-4 space-y-0.5">
            {errors.map((err, i) => <li key={i}>{err}</li>)}
          </ul>
        </div>
      )}
      <div className="space-y-2">
        <InspectorComponent block={block} update={onUpdate} breakpoint={breakpoint} />
      </div>
    </Section>
  );
}

function SingleBlockInspector({ block, breakpoint, blockIssues, onUpdate, onToggleLocked, onToggleHidden, onClearOverride, onReorder, readingOrderIndex, readingOrderTotal }) {
  const geom = useMemo(() => resolveBlockAtBreakpoint(block, breakpoint), [block, breakpoint]);

  const updateGeom = (field, value) => {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    onUpdate((b) => setBlockBp(b, breakpoint, { [field]: value }));
  };

  const updateStyle = (patch) => {
    onUpdate((b) => ({ ...b, style: { ...b.style, ...patch } }));
  };

  const updateA11y = (patch) => {
    onUpdate((b) => ({ ...b, a11y: { ...b.a11y, ...patch } }));
  };

  const updateName = (name) => onUpdate((b) => ({ ...b, name }));

  const toggleFullWidth = () => {
    const cw = BREAKPOINT_WIDTHS[breakpoint] || BREAKPOINT_WIDTHS.desktop;
    onUpdate((b) => {
      if (b.fullWidth) {
        // Turning off: snapshot the currently rendered x=0/w=cw into
        // the current breakpoint so the block keeps its visual size,
        // then disable the pin.
        const withGeom = setBlockBp(b, breakpoint, { x: 0, w: cw });
        return { ...withGeom, fullWidth: false };
      }
      return { ...b, fullWidth: true };
    });
  };

  const visibilityToggleOnBp = (bp) => {
    onUpdate((b) => {
      const current = resolveBlockAtBreakpoint(b, bp).hidden;
      return setBlockBp(b, bp, { hidden: !current });
    });
  };

  return (
    <div className="space-y-4" data-testid="inspector-single">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Settings className="w-4 h-4 text-slate-500 shrink-0" />
          <h2 className="text-sm font-semibold text-slate-900 truncate">{block.name}</h2>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={onToggleLocked}
            title={block.locked ? 'Unlock' : 'Lock'}
            data-testid="button-toggle-lock"
          >
            {block.locked ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onToggleHidden}
            title={geom.hidden ? 'Show on current breakpoint' : 'Hide on current breakpoint'}
            data-testid="button-toggle-visibility"
          >
            {geom.hidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-slate-600">Name</Label>
        <Input
          value={block.name}
          onChange={(e) => updateName(e.target.value)}
          className="h-8"
          data-testid="input-block-name"
        />
      </div>

      <ContentSection block={block} breakpoint={breakpoint} onUpdate={onUpdate} />

      <A11ySection
        block={block}
        issues={blockIssues || []}
        onReorder={onReorder}
        readingOrderIndex={readingOrderIndex}
        readingOrderTotal={readingOrderTotal}
      />

      <Section title={`Position (${breakpoint})`}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            <Maximize2 className="w-3.5 h-3.5" />
            <span>Full width</span>
          </div>
          <Button
            size="sm"
            variant={block.fullWidth ? 'default' : 'outline'}
            onClick={toggleFullWidth}
            className="toggle-elevate"
            data-testid="button-toggle-full-width"
            data-state={block.fullWidth ? 'on' : 'off'}
            title={block.fullWidth
              ? 'Disable full width (release horizontal pin)'
              : 'Pin block to full canvas width at every breakpoint'}
          >
            {block.fullWidth ? 'On' : 'Off'}
          </Button>
        </div>
        {block.fullWidth && (
          <p className="text-xs text-slate-500 mb-2" data-testid="text-full-width-hint">
            X and Width are pinned to the canvas at each breakpoint. Disable to edit horizontally.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            id="inp-x" label="X" testId="input-x"
            value={geom.x}
            onChange={(v) => updateGeom('x', v)}
            override={hasOverride(block, breakpoint, 'x')}
            disabled={block.fullWidth}
          />
          <NumberField
            id="inp-y" label="Y" testId="input-y"
            value={geom.y}
            onChange={(v) => updateGeom('y', v)}
            override={hasOverride(block, breakpoint, 'y')}
          />
          <NumberField
            id="inp-w" label="Width" testId="input-w" min={10}
            value={geom.w}
            onChange={(v) => updateGeom('w', v)}
            override={hasOverride(block, breakpoint, 'w')}
            disabled={block.fullWidth}
          />
          <NumberField
            id="inp-h" label="Height" testId="input-h" min={10}
            value={geom.h}
            onChange={(v) => updateGeom('h', v)}
            override={hasOverride(block, breakpoint, 'h')}
          />
        </div>
        {breakpoint !== 'desktop' && (
          <Button
            size="sm" variant="outline"
            className="w-full mt-2"
            onClick={() => {
              ['x', 'y', 'w', 'h', 'hidden'].forEach((f) => onClearOverride(f));
            }}
            data-testid="button-clear-overrides"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Clear breakpoint overrides
          </Button>
        )}
      </Section>

      <Section title="Appearance">
        <div className="space-y-2">
          <ColorField label="Background" value={block.style.background} onChange={(v) => updateStyle({ background: v })} testId="input-bg-color" />
          <ColorField label="Border color" value={block.style.borderColor} onChange={(v) => updateStyle({ borderColor: v })} testId="input-border-color" />
          <div className="grid grid-cols-2 gap-2">
            <NumberField id="inp-bw" label="Border width" testId="input-border-width" min={0}
              value={block.style.borderWidth}
              onChange={(v) => updateStyle({ borderWidth: v || 0 })}
            />
            <NumberField id="inp-br" label="Radius" testId="input-border-radius" min={0}
              value={block.style.borderRadius}
              onChange={(v) => updateStyle({ borderRadius: v || 0 })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-slate-600">Border style</Label>
            <Select value={block.style.borderStyle} onValueChange={(v) => updateStyle({ borderStyle: v })}>
              <SelectTrigger className="h-8" data-testid="select-border-style"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="solid">Solid</SelectItem>
                <SelectItem value="dashed">Dashed</SelectItem>
                <SelectItem value="dotted">Dotted</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-slate-600">Opacity</Label>
              <Input
                type="number" min={0} max={1} step={0.05}
                value={block.style.opacity}
                onChange={(e) => updateStyle({ opacity: Math.max(0, Math.min(1, Number(e.target.value) || 0)) })}
                className="h-8"
                data-testid="input-opacity"
              />
            </div>
            <NumberField id="inp-z" label="z-index" testId="input-z-index"
              value={block.style.zIndex}
              onChange={(v) => updateStyle({ zIndex: v || 0 })}
            />
          </div>
        </div>
      </Section>

      <Section title="Per-breakpoint visibility">
        <div className="space-y-1">
          {BREAKPOINTS.map((bp) => {
            const hidden = resolveBlockAtBreakpoint(block, bp).hidden;
            return (
              <div key={bp} className="flex items-center justify-between text-sm">
                <span className="capitalize text-slate-700">{bp}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => visibilityToggleOnBp(bp)}
                  data-testid={`button-visibility-${bp}`}
                >
                  {hidden ? <EyeOff className="w-4 h-4 mr-1" /> : <Eye className="w-4 h-4 mr-1" />}
                  {hidden ? 'Hidden' : 'Visible'}
                </Button>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Spacing">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            id="inp-pt" label="Padding top" testId="input-padding-top" min={0}
            value={block.style.paddingTop || 0}
            onChange={(v) => updateStyle({ paddingTop: Math.max(0, v || 0) })}
          />
          <NumberField
            id="inp-pr" label="Padding right" testId="input-padding-right" min={0}
            value={block.style.paddingRight || 0}
            onChange={(v) => updateStyle({ paddingRight: Math.max(0, v || 0) })}
          />
          <NumberField
            id="inp-pb" label="Padding bottom" testId="input-padding-bottom" min={0}
            value={block.style.paddingBottom || 0}
            onChange={(v) => updateStyle({ paddingBottom: Math.max(0, v || 0) })}
          />
          <NumberField
            id="inp-pl" label="Padding left" testId="input-padding-left" min={0}
            value={block.style.paddingLeft || 0}
            onChange={(v) => updateStyle({ paddingLeft: Math.max(0, v || 0) })}
          />
        </div>
        <Button
          size="sm" variant="ghost"
          className="w-full"
          onClick={() => {
            const v = Number(prompt('Apply same padding to all sides:', '0'));
            if (Number.isFinite(v) && v >= 0) {
              updateStyle({ paddingTop: v, paddingRight: v, paddingBottom: v, paddingLeft: v });
            }
          }}
          data-testid="button-padding-all"
        >
          Apply to all sides
        </Button>
      </Section>

      <Section title="Accessibility">
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs text-slate-600">Landmark role</Label>
            <select
              value={block.a11y.role || ''}
              onChange={(e) => updateA11y({ role: e.target.value })}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              data-testid="select-aria-role"
            >
              <option value="">(none — neutral &lt;div&gt;)</option>
              <option value="banner">banner — page header</option>
              <option value="navigation">navigation — nav</option>
              <option value="main">main — primary content</option>
              <option value="complementary">complementary — aside</option>
              <option value="contentinfo">contentinfo — page footer</option>
              <option value="region">region — generic landmark</option>
            </select>
            <p className="text-[10px] text-slate-500">
              Sections with a landmark role render as the matching HTML5 element (header/nav/main/aside/footer/section) for SEO and screen readers.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-slate-600">ARIA label</Label>
            <Input
              value={block.a11y.ariaLabel || ''}
              onChange={(e) => updateA11y({ ariaLabel: e.target.value })}
              placeholder="Descriptive label for screen readers"
              className="h-8"
              data-testid="input-aria-label"
            />
          </div>
          {block.type === BLOCK_TYPES.IMAGE && (
            <div className="space-y-1">
              <Label className="text-xs text-slate-600">Alt text</Label>
              <Input
                value={block.content?.alt || ''}
                onChange={(e) => onUpdate((b) => ({
                  ...b,
                  content: { ...b.content, alt: e.target.value },
                }))}
                placeholder="Describe the image for screen readers"
                className="h-8"
                data-testid="input-alt-text"
              />
              <p className="text-[10px] text-slate-500">
                Leave blank and toggle aria-hidden if the image is purely decorative.
              </p>
            </div>
          )}
          {block.type === BLOCK_TYPES.CARD && (
            <div className="space-y-1">
              <Label className="text-xs text-slate-600">Card image alt text</Label>
              <Input
                value={block.content?.imageAlt || ''}
                onChange={(e) => onUpdate((b) => ({
                  ...b,
                  content: { ...b.content, imageAlt: e.target.value },
                }))}
                placeholder="Describe the card image"
                className="h-8"
                data-testid="input-alt-text"
              />
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs text-slate-600">Language (BCP-47)</Label>
            <Input
              value={block.a11y.lang || ''}
              onChange={(e) => updateA11y({ lang: e.target.value })}
              placeholder="e.g. en, fr, es-MX"
              className="h-8"
              data-testid="input-lang"
            />
            <p className="text-[10px] text-slate-500">
              Set when this block's content is in a different language than the page.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-slate-600">Tab index</Label>
              <Input
                type="number"
                value={block.a11y.tabIndex ?? ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  updateA11y({ tabIndex: raw === '' ? null : Number(raw) });
                }}
                placeholder="default"
                className="h-8"
                data-testid="input-tab-index"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-600">Hidden to screen readers</Label>
              <Button
                size="sm"
                variant="ghost"
                className={`w-full toggle-elevate ${block.a11y.ariaHidden ? 'toggle-elevated' : ''}`}
                aria-pressed={!!block.a11y.ariaHidden}
                onClick={() => updateA11y({ ariaHidden: !block.a11y.ariaHidden })}
                data-testid="button-aria-hidden"
              >
                {block.a11y.ariaHidden ? 'aria-hidden: true' : 'aria-hidden: false'}
              </Button>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="space-y-2 pt-2 border-t border-slate-200">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      {children}
    </div>
  );
}

function ColorField({ label, value, onChange, testId }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-slate-600">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || '#ffffff'}
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
    </div>
  );
}
