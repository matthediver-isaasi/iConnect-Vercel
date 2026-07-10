import { useState } from 'react';
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
export default function CanvasPalettePanel({ open, onOpenChange }) {
  const swatchCtx = useCanvasSwatches();
  const [newColor, setNewColor] = useState('#5C0085');

  if (!swatchCtx) return null;

  const { swatches, ready, isMicrosite, max, addSwatch, removeSwatch, updateSwatch, reorderSwatch } = swatchCtx;
  const trimmedNew = (newColor || '').trim();
  const canAdd = HEX_RE.test(trimmedNew) && !swatches.includes(trimmedNew.toUpperCase()) && swatches.length < max;

  const handleAdd = () => {
    if (!canAdd) return;
    addSwatch(trimmedNew);
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

        {/* Swatch list */}
        <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
          {!ready ? (
            <p className="text-sm text-slate-500 py-6 text-center" data-testid="text-palette-loading">Loading palette…</p>
          ) : swatches.length === 0 ? (
            <p className="text-sm text-slate-500 py-6 text-center" data-testid="text-palette-empty">
              No swatches yet. Add a colour above, or use the “save” button on any colour picker.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="list-palette-swatches">
              {swatches.map((swatch, i) => (
                <li key={`${swatch}-${i}`} className="flex items-center gap-2" data-testid={`row-swatch-${i}`}>
                  <input
                    type="color"
                    value={swatch}
                    onChange={(e) => updateSwatch(i, e.target.value)}
                    className="h-8 w-10 rounded border border-slate-200 cursor-pointer shrink-0"
                    data-testid={`input-swatch-color-${i}`}
                    aria-label={`Swatch ${i + 1} colour`}
                  />
                  <Input
                    value={swatch}
                    onChange={(e) => updateSwatch(i, e.target.value)}
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
