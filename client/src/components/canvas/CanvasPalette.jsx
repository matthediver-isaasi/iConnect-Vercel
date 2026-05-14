import { useDraggable } from '@dnd-kit/core';
import { listPaletteBlocks, BLOCK_CATEGORIES } from './blocks/registry';

function PaletteItem({ item }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${item.type}`,
    data: { fromPalette: true, type: item.type },
  });
  const Icon = item.icon;
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-2 p-2 rounded-md border border-slate-200 bg-white cursor-grab select-none hover-elevate ${
        isDragging ? 'opacity-50' : ''
      }`}
      data-testid={`palette-item-${item.type}`}
    >
      {Icon && <Icon className="w-4 h-4 text-slate-500 shrink-0" />}
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium text-slate-900 truncate">{item.label}</span>
      </div>
    </div>
  );
}

export default function CanvasPalette() {
  const items = listPaletteBlocks();
  const grouped = BLOCK_CATEGORIES.map((cat) => ({
    ...cat,
    items: items.filter((i) => i.category === cat.id),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-3" data-testid="canvas-palette">
      <p className="text-xs text-slate-500">
        Drag a block onto the canvas to place it.
      </p>
      {grouped.map((group) => (
        <div key={group.id} className="space-y-1.5" data-testid={`palette-group-${group.id}`}>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            {group.label}
          </div>
          <div className="space-y-1">
            {group.items.map((item) => (
              <PaletteItem key={item.type} item={item} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
