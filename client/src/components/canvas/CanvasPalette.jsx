import { useDraggable } from '@dnd-kit/core';
import { Square } from 'lucide-react';
import { BLOCK_TYPES } from '@/lib/canvasDesign';

const PALETTE_ITEMS = [
  {
    type: BLOCK_TYPES.BOX,
    label: 'Box',
    description: 'Generic container',
    Icon: Square,
  },
];

function PaletteItem({ item }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${item.type}`,
    data: { fromPalette: true, type: item.type },
  });
  const { Icon } = item;
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
      <Icon className="w-4 h-4 text-slate-500" />
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium text-slate-900">{item.label}</span>
        <span className="text-xs text-slate-500 truncate">{item.description}</span>
      </div>
    </div>
  );
}

export default function CanvasPalette() {
  return (
    <div className="space-y-2" data-testid="canvas-palette">
      <p className="text-xs text-slate-500 mb-2">
        Drag a block onto the canvas to place it.
      </p>
      {PALETTE_ITEMS.map((item) => (
        <PaletteItem key={item.type} item={item} />
      ))}
    </div>
  );
}
