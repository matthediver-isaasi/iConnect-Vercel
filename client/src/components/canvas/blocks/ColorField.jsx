import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Plus, Check } from 'lucide-react';
import { useCanvasSwatches } from '../CanvasSwatchContext';

const HEX_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

/**
 * Task #2561: shared colour input for every CanvasBuilder inspector. Previously
 * duplicated in registry.jsx, CanvasInspector.jsx and dynamicBlocks.jsx.
 *
 * Renders the native colour picker + hex input, plus — when a swatch context is
 * present (editor only) — a row of the active scope's saved swatches (click to
 * apply) and a "save current colour as a swatch" button. When no swatch context
 * is present it degrades to the plain picker so non-editor usages keep working.
 */
export function ColorField({ label, value, onChange, testId, placeholder = '(unset)', hint, fallback = '#000000' }) {
  const swatchCtx = useCanvasSwatches();
  const swatches = swatchCtx?.swatches || [];
  const trimmed = (value || '').trim();
  const isValidHex = HEX_RE.test(trimmed);
  const alreadySaved = !!swatchCtx && isValidHex && swatchCtx.hasSwatch(trimmed);
  const canSave = !!swatchCtx && isValidHex && !alreadySaved;

  return (
    <div className="space-y-1">
      {label ? <Label className="text-xs text-slate-600">{label}</Label> : null}
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={isValidHex ? trimmed : fallback}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-10 rounded border border-slate-200 cursor-pointer"
          data-testid={testId}
        />
        <Input
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-8 flex-1 font-mono text-xs"
        />
        {swatchCtx ? (
          <button
            type="button"
            onClick={() => { if (canSave) swatchCtx.addSwatch(trimmed); }}
            disabled={!canSave}
            title={alreadySaved ? 'Already in palette' : 'Save colour to palette'}
            aria-label={alreadySaved ? 'Colour already in palette' : 'Save colour to palette'}
            className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded border border-slate-200 text-slate-600 hover-elevate active-elevate-2 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid={testId ? `${testId}-save-swatch` : undefined}
          >
            {alreadySaved ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          </button>
        ) : null}
      </div>
      {swatchCtx && swatches.length > 0 ? (
        <div
          className="flex flex-wrap gap-1 pt-0.5"
          data-testid={testId ? `${testId}-swatches` : 'color-swatches'}
        >
          {swatches.map((swatch, i) => (
            <button
              key={`${swatch}-${i}`}
              type="button"
              onClick={() => onChange(swatch)}
              title={swatch}
              aria-label={`Apply colour ${swatch}`}
              className={`h-5 w-5 rounded border cursor-pointer ${
                trimmed.toUpperCase() === swatch ? 'border-slate-900 ring-1 ring-slate-900' : 'border-slate-300'
              }`}
              style={{ backgroundColor: swatch }}
              data-testid={testId ? `${testId}-swatch-${i}` : `swatch-apply-${i}`}
            />
          ))}
        </div>
      ) : null}
      {hint ? <p className="text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

export default ColorField;
