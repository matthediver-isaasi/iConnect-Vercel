import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';

export default function SortablePortalMenuItem({ item, disabled, className, children }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled });
  return <div ref={setNodeRef} className={className}
    style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.55 : 1 }}>
    {children(<button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners}
      disabled={disabled} aria-label={`Drag to reorder ${item.title}`}
      className="touch-none cursor-grab rounded p-1 text-slate-500 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-500 active:cursor-grabbing">
      <GripVertical className="h-4 w-4" />
    </button>)}
  </div>;
}
