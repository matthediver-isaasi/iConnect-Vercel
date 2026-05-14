import { useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Eye, EyeOff, Lock, Unlock, RotateCcw, AlertTriangle } from 'lucide-react';
import {
  resolveBlockAtBreakpoint,
  hasOverride,
  setBlockBp,
  clearBpOverride,
  BREAKPOINTS,
  validateBlock,
} from '@/lib/canvasDesign';
import { getBlockDefinition } from './blocks/registry';

function NumberField({ id, label, value, onChange, min, max, step = 1, testId, override }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs text-slate-600">{label}</Label>
        {override !== undefined && (
          <span
            className={`text-[10px] uppercase tracking-wide ${override ? 'text-amber-600' : 'text-slate-400'}`}
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
        className="h-8"
        data-testid={testId}
      />
    </div>
  );
}

export default function CanvasInspector({
  selectedBlocks,
  breakpoint,
  onUpdateBlock,
  onToggleLocked,
  onToggleHidden,
  onClearOverride,
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
    onUpdate={(updater) => onUpdateBlock(single.id, updater)}
    onToggleLocked={() => onToggleLocked(single.id)}
    onToggleHidden={() => onToggleHidden(single.id)}
    onClearOverride={(field) => onClearOverride(single.id, breakpoint, field)}
  />;
}

function ContentSection({ block, onUpdate }) {
  const def = getBlockDefinition(block.type);
  const InspectorComponent = def.Inspector;
  if (!InspectorComponent) return null;
  const errors = validateBlock(block);
  return (
    <Section title={`Content (${def.label})`}>
      {errors.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 space-y-1" data-testid="inspector-block-errors">
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangle className="w-3.5 h-3.5" /> Required fields missing
          </div>
          <ul className="list-disc pl-4 space-y-0.5">
            {errors.map((err, i) => <li key={i}>{err}</li>)}
          </ul>
        </div>
      )}
      <div className="space-y-2">
        <InspectorComponent block={block} update={onUpdate} />
      </div>
    </Section>
  );
}

function SingleBlockInspector({ block, breakpoint, onUpdate, onToggleLocked, onToggleHidden, onClearOverride }) {
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

      <ContentSection block={block} onUpdate={onUpdate} />

      <Section title={`Position (${breakpoint})`}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            id="inp-x" label="X" testId="input-x"
            value={geom.x}
            onChange={(v) => updateGeom('x', v)}
            override={hasOverride(block, breakpoint, 'x')}
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
          <div className="space-y-1">
            <Label className="text-xs text-slate-600">Alt text</Label>
            <Input
              value={block.a11y.altText || ''}
              onChange={(e) => updateA11y({ altText: e.target.value })}
              placeholder="Used by image-bearing blocks"
              className="h-8"
              data-testid="input-alt-text"
            />
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
