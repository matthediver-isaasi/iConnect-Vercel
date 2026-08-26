import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import WidgetCard from "./WidgetCard";

const WIDTH_CLASS = {
  fifth: "md:col-span-2",
  third: "md:col-span-4",
  half: "md:col-span-6",
  full: "md:col-span-12",
};

function SortableWidget({ widget, palette, canEdit, onEdit, onDelete, onDuplicate, onResize, onResizeHeight }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: widget.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const widthClass = WIDTH_CLASS[widget.width] || WIDTH_CLASS.third;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("col-span-12", widthClass, "flex")}
    >
      <WidgetCard
        widget={widget}
        palette={palette}
        canEdit={canEdit}
        dragHandleProps={canEdit ? { ...attributes, ...listeners } : null}
        onEdit={onEdit}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onResize={onResize}
        onResizeHeight={onResizeHeight}
      />
    </div>
  );
}

const dropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.4" } },
  }),
};

export default function WidgetGrid({
  widgets,
  palette,
  canEdit = false,
  onReorder,
  onEdit,
  onDelete,
  onDuplicate,
  onResize,
  onResizeHeight,
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = widgets.map(w => w.id);
  const [activeId, setActiveId] = useState(null);
  const activeWidget = activeId ? widgets.find(w => w.id === activeId) : null;

  const handleDragStart = event => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = event => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = widgets.findIndex(w => w.id === active.id);
    const newIndex = widgets.findIndex(w => w.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder?.(arrayMove(widgets, oldIndex, newIndex));
  };

  const handleDragCancel = () => setActiveId(null);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div
          className="grid grid-cols-12 gap-4"
          data-testid="widget-grid"
        >
          {widgets.map(widget => (
            <SortableWidget
              key={widget.id}
              widget={widget}
              palette={palette}
              canEdit={canEdit}
              onEdit={onEdit}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onResize={onResize}
              onResizeHeight={onResizeHeight}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={dropAnimation} zIndex={50}>
        {activeWidget ? (
          <div
            className="pointer-events-none flex h-full w-full cursor-grabbing rounded-md shadow-lg ring-2 ring-primary/30"
            data-testid="widget-drag-overlay"
          >
            <WidgetCard widget={activeWidget} palette={palette} canEdit={false} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
