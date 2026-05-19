import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Square,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Trash2,
  Copy,
  GripVertical,
  Layers,
  CircleAlert,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { resolveBlockAtBreakpoint } from '@/lib/canvasDesign';
import { SEVERITY, worstSeverity } from '@/lib/canvasA11y';

const SEV_ICON = {
  [SEVERITY.ERROR]: CircleAlert,
  [SEVERITY.WARNING]: AlertTriangle,
  [SEVERITY.INFO]: Info,
};
const SEV_CLASS = {
  [SEVERITY.ERROR]: 'text-destructive',
  [SEVERITY.WARNING]: 'text-amber-700',
  [SEVERITY.INFO]: 'text-slate-400',
};

function LayerRow({
  block,
  isSelected,
  breakpoint,
  issues,
  onSelect,
  onToggleHidden,
  onToggleLocked,
  onDelete,
  onDuplicate,
  onRename,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.name);
  const geom = resolveBlockAtBreakpoint(block, breakpoint);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1 px-2 py-1.5 rounded text-sm select-none ${
        isSelected ? 'bg-primary/15 ring-1 ring-primary/30' : 'bg-slate-50 hover-elevate'
      } ${geom.hidden ? 'opacity-60' : ''}`}
      data-testid={`layer-${block.id}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(block.id, e.shiftKey);
      }}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => e.stopPropagation()}
        data-testid={`layer-drag-${block.id}`}
      >
        <GripVertical className="w-3.5 h-3.5 text-slate-400" />
      </div>
      <Square className="w-3.5 h-3.5 text-slate-500 shrink-0" />
      {(() => {
        const sev = worstSeverity(issues);
        if (!sev) return null;
        const Icon = SEV_ICON[sev];
        const tip = issues.map((i) => i.message).join('\n');
        return (
          <span
            className={`shrink-0 ${SEV_CLASS[sev]}`}
            title={tip}
            data-testid={`layer-a11y-${block.id}`}
            data-severity={sev}
          >
            <Icon className="w-3.5 h-3.5" />
          </span>
        );
      })()}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            onRename(block.id, draft.trim() || 'Box');
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setDraft(block.name);
              setEditing(false);
            }
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 text-xs px-1 py-0.5 rounded border border-slate-300 bg-white"
          data-testid={`layer-rename-input-${block.id}`}
        />
      ) : (
        <span
          className="flex-1 min-w-0 truncate text-xs"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(block.name);
            setEditing(true);
          }}
          data-testid={`layer-name-${block.id}`}
        >
          {block.name}
        </span>
      )}
      <button
        className="p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => { e.stopPropagation(); onToggleLocked(block.id); }}
        title={block.locked ? 'Unlock' : 'Lock'}
        data-testid={`layer-lock-${block.id}`}
      >
        {block.locked ? <Lock className="w-3.5 h-3.5 text-slate-500" /> : <Unlock className="w-3.5 h-3.5 text-slate-400" />}
      </button>
      <button
        className="p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => { e.stopPropagation(); onToggleHidden(block.id); }}
        title={geom.hidden ? 'Show' : 'Hide'}
        data-testid={`layer-visibility-${block.id}`}
      >
        {geom.hidden ? <EyeOff className="w-3.5 h-3.5 text-slate-500" /> : <Eye className="w-3.5 h-3.5 text-slate-400" />}
      </button>
      <button
        className="p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => { e.stopPropagation(); onDuplicate(block.id); }}
        title="Duplicate"
        data-testid={`layer-duplicate-${block.id}`}
      >
        <Copy className="w-3.5 h-3.5 text-slate-400" />
      </button>
      <button
        className="p-0.5 rounded hover:bg-slate-200 hover:text-destructive"
        onClick={(e) => { e.stopPropagation(); onDelete(block.id); }}
        title="Delete"
        data-testid={`layer-delete-${block.id}`}
      >
        <Trash2 className="w-3.5 h-3.5 text-slate-400" />
      </button>
    </div>
  );
}

export default function CanvasLayers({
  blocks,
  selectedIds,
  breakpoint,
  issuesByBlock,
  onSelect,
  onReorder,
  onToggleHidden,
  onToggleLocked,
  onDelete,
  onDuplicate,
  onRename,
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Layers list: top-most z-order first (reverse of array, since later in
  // array = visually on top in stage). We display top->bottom.
  const ordered = [...blocks].reverse();

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const visualOldIndex = ordered.findIndex((b) => b.id === active.id);
    const visualNewIndex = ordered.findIndex((b) => b.id === over.id);
    if (visualOldIndex === -1 || visualNewIndex === -1) return;
    const newVisual = arrayMove(ordered, visualOldIndex, visualNewIndex);
    onReorder(newVisual.slice().reverse());
  };

  return (
    <div className="space-y-2" data-testid="canvas-layers">
      <div className="flex items-center gap-2">
        <Layers className="w-4 h-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-900">Layers</h2>
      </div>
      {blocks.length === 0 ? (
        <p className="text-xs text-slate-500" data-testid="layers-empty">No elements yet.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ordered.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1">
              {ordered.map((b) => (
                <LayerRow
                  key={b.id}
                  block={b}
                  isSelected={selectedIds.includes(b.id)}
                  breakpoint={breakpoint}
                  issues={issuesByBlock?.get?.(b.id) || []}
                  onSelect={onSelect}
                  onToggleHidden={onToggleHidden}
                  onToggleLocked={onToggleLocked}
                  onDelete={onDelete}
                  onDuplicate={onDuplicate}
                  onRename={onRename}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
