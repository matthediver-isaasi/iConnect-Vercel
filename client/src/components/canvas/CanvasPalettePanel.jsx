import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Trash2, ChevronUp, ChevronDown, Plus } from 'lucide-react';
import { useCanvasSwatches } from './CanvasSwatchContext';

const HEX_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

/**
 * Task #2561: "Colour palette" management dialog for the CanvasBuilder editor.
 * Lists the active scope's saved swatches and lets authors add, edit, remove
 * and reorder them. The scope (main site vs a specific microsite) is resolved
 * by the swatch context and shown in the header.
 */
const MAX_LABEL_LEN = 60;

/**
 * Task #2698: label input for a saved swatch. Holds a local draft and only
 * commits (persists) on blur / Enter so we don't fire a save on every keystroke.
 * Re-seeds from the stored value when it changes externally (e.g. reorder).
 */
function SwatchLabelInput({ value, onCommit, testId }) {
  const [draft, setDraft] = useState(value || '');
  useEffect(() => { setDraft(value || ''); }, [value]);
  const commit = () => {
    const trimmed = (draft || '').trim().slice(0, MAX_LABEL_LEN);
    if (trimmed !== (value || '')) onCommit(trimmed);
  };
  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur(); } }}
      maxLength={MAX_LABEL_LEN}
      placeholder="Label (optional)"
      className="h-8 flex-1 text-xs"
      data-testid={testId}
    />
  );
}

export default function CanvasPalettePanel({ open, onOpenChange }) {
  const swatchCtx = useCanvasSwatches();
  const [newColor, setNewColor] = useState('#5C0085');
  const [newLabel, setNewLabel] = useState('');

  if (!swatchCtx) return null;

  const { swatches, ready, isMicrosite, max, addSwatch, removeSwatch, updateSwatch, reorderSwatch } = swatchCtx;
  const trimmedNew = (newColor || '').trim();
  const canAdd = HEX_RE.test(trimmedNew)
    && !swatches.some((s) => s.hex === trimmedNew.toUpperCase())
    && swatches.length < max;

  const handleAdd = () => {
    if (!canAdd) return;
    addSwatch(trimmedNew, newLabel);
    setNewLabel('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="dialog-canvas-palette">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            Colour palette
            <Badge variant={isMicrosite ? 'secondary' : 'outline'} data-testid="badge-palette-scope">
              {isMicrosite ? 'Microsite palette' : 'Main-site palette'}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {isMicrosite
              ? 'Saved swatches for this microsite. They appear in every colour picker on this microsite\u2019s pages.'
              : 'Saved swatches for your main site. They appear in every colour picker on main-site pages.'}
          </DialogDescription>
        </DialogHeader>

        {/* Add a new swatch */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={HEX_RE.test(trimmedNew) ? trimmedNew : '#000000'}
              onChange={(e) => setNewColor(e.target.value)}
              className="h-9 w-11 rounded border border-slate-200 cursor-pointer shrink-0"
              data-testid="input-new-swatch-color"
              aria-label="New swatch colour"
            />
            <Input
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
              placeholder="#RRGGBB"
              className="h-9 flex-1 font-mono text-sm"
              data-testid="input-new-swatch-hex"
            />
            <Button
              size="default"
              onClick={handleAdd}
              disabled={!canAdd}
              data-testid="button-add-swatch"
            >
              <Plus className="w-4 h-4 mr-1.5" /> Add
            </Button>
          </div>
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            maxLength={MAX_LABEL_LEN}
            placeholder="Label (optional) — e.g. Brand purple"
            className="h-9 w-full text-sm"
            data-testid="input-new-swatch-label"
            aria-label="New swatch label"
          />
        </div>

        {/* Swatch list */}
        <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
          {!ready ? (
            <p className="text-sm text-slate-500 py-6 text-center" data-testid="text-palette-loading">Loading palette…</p>
          ) : swatches.length === 0 ? (
            <p className="text-sm text-slate-500 py-6 text-center" data-testid="text-palette-empty">
              No swatches yet. Add a colour above, or use the “save” button on any colour picker.
            </p>
          ) : (
            <ul className="space-y-3" data-testid="list-palette-swatches">
              {swatches.map((swatch, i) => (
                <li key={`${swatch.hex}-${i}`} className="space-y-1.5" data-testid={`row-swatch-${i}`}>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={swatch.hex}
                      onChange={(e) => updateSwatch(i, { hex: e.target.value })}
                      className="h-8 w-10 rounded border border-slate-200 cursor-pointer shrink-0"
                      data-testid={`input-swatch-color-${i}`}
                      aria-label={`Swatch ${i + 1} colour`}
                    />
                    <Input
                      value={swatch.hex}
                      onChange={(e) => updateSwatch(i, { hex: e.target.value })}
                      className="h-8 flex-1 font-mono text-xs"
                      data-testid={`input-swatch-hex-${i}`}
                    />
                    <Button
                      size="icon" variant="ghost"
                      onClick={() => reorderSwatch(i, i - 1)}
                      disabled={i === 0}
                      title="Move up"
                      aria-label={`Move swatch ${i + 1} up`}
                      data-testid={`button-swatch-up-${i}`}
                    >
                      <ChevronUp className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon" variant="ghost"
                      onClick={() => reorderSwatch(i, i + 1)}
                      disabled={i === swatches.length - 1}
                      title="Move down"
                      aria-label={`Move swatch ${i + 1} down`}
                      data-testid={`button-swatch-down-${i}`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon" variant="ghost"
                      onClick={() => removeSwatch(i)}
                      title="Remove swatch"
                      aria-label={`Remove swatch ${i + 1}`}
                      data-testid={`button-swatch-remove-${i}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2 pl-12">
                    <SwatchLabelInput
                      value={swatch.label}
                      onCommit={(label) => updateSwatch(i, { label })}
                      testId={`input-swatch-label-${i}`}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-[11px] text-slate-500">
          {swatches.length} / {max} swatches
        </p>
      </DialogContent>
    </Dialog>
  );
}
