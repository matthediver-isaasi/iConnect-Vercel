import { useEffect, useMemo, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Eye, EyeOff, Lock, Unlock, RotateCcw, AlertTriangle, CircleAlert, Info, ArrowUp, ArrowDown, Maximize2, Link2, Link2Off } from 'lucide-react';
import {
  resolveBlockAtBreakpoint,
  hasOverride,
  setBlockBp,
  clearBpOverride,
  BREAKPOINTS,
  BREAKPOINT_WIDTHS,
  validateBlock,
  sanitizeAnchorId,
  BLOCK_TYPES,
  blockSupportsFullBleed,
  setBlockContentFullBleed,
  blockSupportsShadow,
  SHADOW_LEVELS,
} from '@/lib/canvasDesign';
import { useCanvasAnchors } from './CanvasAnchorContext';
import {
  SEVERITY,
  contrastRatio,
  meetsAA,
  blockTextColor,
  blockBackgroundColor,
  blockHeadingLevel,
} from '@/lib/canvasA11y';
import { getBlockDefinition } from './blocks/registry';
import { ColorField } from './blocks/ColorField';

// Block types where the shared "Spacing" (padding) panel has no visible effect,
// so it is hidden in the inspector (Task #2695). Padding is only meaningful when
// a block's content flows inside its shared wrapper. These blocks either position
// their children independently on the stage (Box, Section), fill 100% of their
// box (Image, Video, Map), or expose their own dedicated spacing control
// (Card = "Card padding", Button = "Internal spacing & text"). Renderers are
// unchanged, so any padding already saved on existing pages still applies.
const NO_PADDING_PANEL_BLOCK_TYPES = new Set([
  BLOCK_TYPES.BOX,
  BLOCK_TYPES.SECTION,
  BLOCK_TYPES.CARD,
  BLOCK_TYPES.IMAGE,
  BLOCK_TYPES.VIDEO,
  BLOCK_TYPES.MAP,
  BLOCK_TYPES.BUTTON,
]);

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
  onUnlinkSymbol,
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
    onUnlinkSymbol={onUnlinkSymbol}
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

// Reading-order position + arrows, per-element audit issues and the contrast
// readout. Rendered inside the consolidated "Accessibility" section (no Section
// wrapper of its own).
function A11yChecks({ block, issues, onReorder, readingOrderIndex, readingOrderTotal }) {
  const fg = blockTextColor(block);
  const bg = blockBackgroundColor(block);
  const ratio = contrastRatio(fg, bg);
  const isLarge = blockHeadingLevel(block) != null
    || block.type === BLOCK_TYPES.HERO
    || block.type === BLOCK_TYPES.STAT;
  const passes = meetsAA(ratio, { isLargeText: isLarge });

  return (
    <div className="space-y-2 pt-2 border-t border-slate-200">
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
    </div>
  );
}

function ContentSection({ block, breakpoint, onUpdate, onUnlinkSymbol }) {
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
        <InspectorComponent block={block} update={onUpdate} breakpoint={breakpoint} onUnlinkSymbol={onUnlinkSymbol} />
      </div>
    </Section>
  );
}

function SingleBlockInspector({ block, breakpoint, blockIssues, onUpdate, onToggleLocked, onToggleHidden, onClearOverride, onReorder, onUnlinkSymbol, readingOrderIndex, readingOrderTotal }) {
  const geom = useMemo(() => resolveBlockAtBreakpoint(block, breakpoint), [block, breakpoint]);
  const def = getBlockDefinition(block.type);

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

  // Task #2506: full-bleed (content.fullBleed) pins x/w exactly like
  // fullWidth does (via blockIsFullWidthLike), so the Position panel must
  // disable the X/Width inputs and offer a visible escape hatch instead of
  // leaving dead-looking controls. Turning it off snapshots the currently
  // rendered x/w into the active breakpoint first (shared helper).
  const isFullBleed = blockSupportsFullBleed(block.type) && !!block.content?.fullBleed;
  const horizontallyPinned = block.fullWidth || isFullBleed;

  const toggleFullBleed = () => {
    onUpdate((b) => setBlockContentFullBleed(b, breakpoint, !(b.content && b.content.fullBleed)));
  };

  // Ratio lock (editor-session UI only; never persisted). When engaged, editing
  // Width recomputes Height (and vice versa) to preserve the aspect ratio
  // captured at the moment the lock was turned on. Only available when both
  // Width and Height are actually editable.
  const canLockRatio = !horizontallyPinned && !def?.noResize;
  const [ratioLocked, setRatioLocked] = useState(false);
  const [lockedRatio, setLockedRatio] = useState(null);

  // A new block was selected — drop any captured ratio so it never leaks
  // across elements.
  useEffect(() => {
    setRatioLocked(false);
    setLockedRatio(null);
  }, [block.id]);

  // If the lock becomes impossible to honour (block pinned full-width/bleed or
  // became noResize), release it silently so no constraint is violated.
  useEffect(() => {
    if (ratioLocked && !canLockRatio) {
      setRatioLocked(false);
      setLockedRatio(null);
    }
  }, [ratioLocked, canLockRatio]);

  const toggleRatioLock = () => {
    if (!canLockRatio) return;
    if (ratioLocked) {
      setRatioLocked(false);
      setLockedRatio(null);
      return;
    }
    const { w, h } = geom;
    // Only capture a ratio when both dimensions are valid & non-degenerate.
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      setLockedRatio(w / h);
      setRatioLocked(true);
    }
  };

  // Width/Height edits go through here so the ratio lock (when on) can update
  // both dimensions together. Falls back to the plain single-field path when
  // unlocked, preserving today's independent behaviour.
  const updateDimension = (field, value) => {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    if (ratioLocked && Number.isFinite(lockedRatio) && lockedRatio > 0) {
      const entered = Math.max(10, Math.round(value));
      const w = field === 'w' ? entered : Math.max(10, Math.round(entered * lockedRatio));
      const h = field === 'h' ? entered : Math.max(10, Math.round(entered / lockedRatio));
      onUpdate((b) => setBlockBp(b, breakpoint, { w, h }));
      return;
    }
    updateGeom(field, value);
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

      <ContentSection block={block} breakpoint={breakpoint} onUpdate={onUpdate} onUnlinkSymbol={onUnlinkSymbol} />

      <AnchorIdSection block={block} onUpdate={onUpdate} />

      <Section title={`Position (${breakpoint})`}>
        {def?.noResize ? (
          <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-700 mb-2">
            This block has a fixed size. Use the X and Y fields to reposition it.
          </div>
        ) : (
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
        )}
        {blockSupportsFullBleed(block.type) && !def?.noResize && (
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-1.5 text-xs text-slate-600">
              <Maximize2 className="w-3.5 h-3.5" />
              <span>Full-bleed</span>
            </div>
            <Button
              size="sm"
              variant={isFullBleed ? 'default' : 'outline'}
              onClick={toggleFullBleed}
              className="toggle-elevate"
              data-testid="button-toggle-full-bleed"
              data-state={isFullBleed ? 'on' : 'off'}
              title={isFullBleed
                ? 'Disable full-bleed (block keeps its current size; width becomes editable)'
                : 'Stretch block edge-to-edge across the full screen width'}
            >
              {isFullBleed ? 'On' : 'Off'}
            </Button>
          </div>
        )}
        {horizontallyPinned && !def?.noResize && (
          <p className="text-xs text-slate-500 mb-2" data-testid="text-full-width-hint">
            {isFullBleed && !block.fullWidth
              ? 'Full-bleed pins X and Width to the canvas edge at every breakpoint. Turn it off above to edit horizontally.'
              : 'X and Width are pinned to the canvas at each breakpoint. Disable to edit horizontally.'}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            id="inp-x" label="X" testId="input-x"
            value={geom.x}
            onChange={(v) => updateGeom('x', v)}
            override={hasOverride(block, breakpoint, 'x')}
            disabled={horizontallyPinned}
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
            onChange={(v) => updateDimension('w', v)}
            override={hasOverride(block, breakpoint, 'w')}
            disabled={horizontallyPinned || def?.noResize}
          />
          <NumberField
            id="inp-h" label="Height" testId="input-h" min={10}
            value={geom.h}
            onChange={(v) => updateDimension('h', v)}
            override={hasOverride(block, breakpoint, 'h')}
            disabled={def?.noResize}
          />
        </div>
        <div className="flex items-center justify-between gap-2 mt-2">
          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            {ratioLocked ? <Link2 className="w-3.5 h-3.5" /> : <Link2Off className="w-3.5 h-3.5" />}
            <span>Lock ratio</span>
          </div>
          <Button
            size="sm"
            variant={ratioLocked ? 'default' : 'outline'}
            onClick={toggleRatioLock}
            disabled={!canLockRatio}
            className="toggle-elevate"
            data-testid="button-toggle-ratio-lock"
            data-state={ratioLocked ? 'on' : 'off'}
            title={!canLockRatio
              ? 'Width and Height must both be editable to lock their ratio'
              : ratioLocked
                ? 'Unlock aspect ratio (edit Width and Height independently)'
                : 'Lock aspect ratio (editing one dimension adjusts the other)'}
          >
            {ratioLocked ? 'On' : 'Off'}
          </Button>
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
          {blockSupportsShadow(block.type) && (
            <div className="space-y-1">
              <Label className="text-xs text-slate-600">Shadow</Label>
              <Select
                value={block.style.boxShadow || 'none'}
                onValueChange={(v) => updateStyle({ boxShadow: v })}
              >
                <SelectTrigger className="h-8" data-testid="select-shadow"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SHADOW_LEVELS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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

      {!NO_PADDING_PANEL_BLOCK_TYPES.has(block.type) && (
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
      )}

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
          <A11yChecks
            block={block}
            issues={blockIssues || []}
            onReorder={onReorder}
            readingOrderIndex={readingOrderIndex}
            readingOrderTotal={readingOrderTotal}
          />
        </div>
      </Section>
    </div>
  );
}

// Task #1446: "Jump link" (anchor id) editor. Deliberately worded "Jump
// link" / "Anchor ID" rather than "Anchor" to avoid colliding with the
// alignment "Align to: Anchor" terminology used elsewhere in the editor.
// A local draft lets the author type freely (spaces, capitals) while the
// stored value is always the sanitized slug; on blur the field snaps to the
// canonical slug. Duplicate anchor ids across the page are flagged inline.
function AnchorIdSection({ block, onUpdate }) {
  const { duplicateAnchorIds } = useCanvasAnchors();
  const stored = block.anchorId || '';
  const [draft, setDraft] = useState(stored);

  useEffect(() => {
    setDraft(block.anchorId || '');
    // Re-sync when switching to a different block.
  }, [block.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (text) => {
    const clean = sanitizeAnchorId(text);
    onUpdate((b) => ({ ...b, anchorId: clean }));
  };

  const isDuplicate = !!stored && duplicateAnchorIds.has(stored);

  return (
    <Section title="Jump link (anchor)">
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5 text-slate-500" />
          <Label className="text-xs text-slate-600">Anchor ID</Label>
        </div>
        <Input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => setDraft(sanitizeAnchorId(draft))}
          placeholder="e.g. pricing or contact-us"
          className="h-8"
          data-testid="input-anchor-id"
        />
        {stored ? (
          <p className="text-[10px] text-slate-500" data-testid="text-anchor-id-slug">
            Link to this section with <span className="font-mono text-slate-700">#{stored}</span>
          </p>
        ) : (
          <p className="text-[10px] text-slate-500">
            Name a section so buttons and links can jump straight to it.
          </p>
        )}
        {isDuplicate && (
          <div
            className="flex items-start gap-1.5 rounded border border-warning/30 bg-warning/10 p-1.5 text-[10px] text-warning"
            data-testid="warning-anchor-id-duplicate"
          >
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            <span>Another block already uses <span className="font-mono">#{stored}</span>. Make it unique so jump links aren't ambiguous.</span>
          </div>
        )}
      </div>
    </Section>
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

// ColorField consolidated into the shared ./blocks/ColorField (Task #2561).
