import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Badge } from "@/components/ui/badge";
import { GripVertical } from "lucide-react";
import { reorderBackFieldOrder } from "@/utils/directorySettings";

/**
 * Shared drag-and-drop list for the unified back-of-card field order.
 * Core fields and custom fields appear in ONE sequence.
 *
 * Props:
 *  - order: resolved array of keys (core keys + `custom:<id>`)
 *  - items: map key -> { label, description?, isCustom?, hidden? }
 *           (`hidden` marks fields currently toggled off on the back —
 *            they stay orderable but show a "Hidden" badge)
 *  - onChange(nextOrder)
 *  - droppableId (unique per page)
 *  - disabled: render rows without drag affordance
 *  - renderControls(key, item): optional extra per-row controls (e.g. the
 *    per-directory visibility selects on Dynamic Directory Management),
 *    rendered on the right of the row.
 */
export default function BackFieldOrderList({ order, items, onChange, droppableId = "back-field-order", disabled = false, renderControls = null }) {
  const handleDragEnd = (result) => {
    if (!result.destination) return;
    const src = result.source.index;
    const dest = result.destination.index;
    if (src === dest) return;
    onChange(reorderBackFieldOrder(order, src, dest));
  };

  const rows = (order || []).filter((key) => items[key]);

  const renderRow = (key, index) => {
    const item = items[key];
    const inner = (dragHandleProps, isDragging) => (
      <div
        className={`flex items-center gap-3 p-2.5 rounded-lg border ${
          isDragging ? 'border-blue-400 bg-blue-50 shadow-lg' : 'border-slate-200 bg-slate-50'
        }`}
        data-testid={`row-back-order-${key}`}
      >
        {!disabled && (
          <div
            {...dragHandleProps}
            className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600"
            data-testid={`drag-handle-back-${key}`}
          >
            <GripVertical className="w-4 h-4" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-slate-800 truncate">{item.label}</div>
          {item.description && <p className="text-xs text-slate-500 truncate">{item.description}</p>}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {item.isCustom && (
            <Badge variant="secondary" className="text-xs">Custom field</Badge>
          )}
          {item.hidden && (
            <Badge variant="outline" className="text-xs text-slate-400 border-slate-300">Hidden</Badge>
          )}
          {renderControls && renderControls(key, item)}
        </div>
      </div>
    );

    if (disabled) {
      return <div key={key}>{inner({}, false)}</div>;
    }
    return (
      <Draggable key={key} draggableId={`${droppableId}-${key}`} index={index}>
        {(provided, snapshot) => (
          <div ref={provided.innerRef} {...provided.draggableProps}>
            {inner(provided.dragHandleProps, snapshot.isDragging)}
          </div>
        )}
      </Draggable>
    );
  };

  if (disabled) {
    return <div className="space-y-2">{rows.map((key) => renderRow(key))}</div>;
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <Droppable droppableId={droppableId}>
        {(provided) => (
          <div ref={provided.innerRef} {...provided.droppableProps} className="space-y-2">
            {rows.map((key, index) => renderRow(key, index))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>
  );
}
