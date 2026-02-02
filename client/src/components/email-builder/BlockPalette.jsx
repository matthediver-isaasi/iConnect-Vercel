import { useDraggable } from '@dnd-kit/core';
import { Type, Image, MousePointer2, Minus, MoveVertical, Columns, SquareDashed } from 'lucide-react';
import { BLOCK_TYPES } from './types';

const structureItems = [
  { type: BLOCK_TYPES.SECTION, icon: SquareDashed, label: 'Section' },
  { type: BLOCK_TYPES.COLUMNS, icon: Columns, label: 'Columns' },
];

const contentItems = [
  { type: BLOCK_TYPES.TEXT, icon: Type, label: 'Text' },
  { type: BLOCK_TYPES.IMAGE, icon: Image, label: 'Image' },
  { type: BLOCK_TYPES.BUTTON, icon: MousePointer2, label: 'Button' },
  { type: BLOCK_TYPES.DIVIDER, icon: Minus, label: 'Divider' },
  { type: BLOCK_TYPES.SPACER, icon: MoveVertical, label: 'Spacer' },
];

function DraggablePaletteItem({ type, icon: Icon, label }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${type}`,
    data: { type, fromPalette: true },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex flex-col items-center justify-center p-3 border rounded-md cursor-grab bg-background hover-elevate transition-all ${
        isDragging ? 'opacity-50 ring-2 ring-primary' : ''
      }`}
      data-testid={`palette-block-${type}`}
    >
      <Icon className="w-5 h-5 mb-1 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export default function BlockPalette() {
  return (
    <div className="p-4 border-b">
      <h3 className="text-sm font-medium mb-3">Structure</h3>
      <div className="grid grid-cols-2 gap-2 mb-4">
        {structureItems.map(item => (
          <DraggablePaletteItem key={item.type} {...item} />
        ))}
      </div>
      <h3 className="text-sm font-medium mb-3">Content</h3>
      <div className="grid grid-cols-3 gap-2">
        {contentItems.map(item => (
          <DraggablePaletteItem key={item.type} {...item} />
        ))}
      </div>
    </div>
  );
}
