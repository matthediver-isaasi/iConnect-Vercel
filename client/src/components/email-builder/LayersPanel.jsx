import { useState, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Type,
  Image,
  MousePointer2,
  Minus,
  MoveVertical,
  Columns,
  SquareDashed,
  GripVertical,
  Trash2,
  Copy,
  Eye,
  EyeOff,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { BLOCK_TYPES } from './types';

const BLOCK_ICONS = {
  [BLOCK_TYPES.SECTION]: SquareDashed,
  [BLOCK_TYPES.TEXT]: Type,
  [BLOCK_TYPES.IMAGE]: Image,
  [BLOCK_TYPES.BUTTON]: MousePointer2,
  [BLOCK_TYPES.DIVIDER]: Minus,
  [BLOCK_TYPES.SPACER]: MoveVertical,
  [BLOCK_TYPES.COLUMNS]: Columns,
};

const BLOCK_LABELS = {
  [BLOCK_TYPES.SECTION]: 'Section',
  [BLOCK_TYPES.TEXT]: 'Text',
  [BLOCK_TYPES.IMAGE]: 'Image',
  [BLOCK_TYPES.BUTTON]: 'Button',
  [BLOCK_TYPES.DIVIDER]: 'Divider',
  [BLOCK_TYPES.SPACER]: 'Spacer',
  [BLOCK_TYPES.COLUMNS]: 'Columns',
};

function getBlockLabel(block) {
  const base = BLOCK_LABELS[block.type] || block.type;
  if (block.type === BLOCK_TYPES.TEXT && block.content) {
    const preview = block.content.substring(0, 20);
    return preview.length < block.content.length ? `${preview}...` : preview;
  }
  if (block.type === BLOCK_TYPES.BUTTON && block.content) {
    return `Button: ${block.content.substring(0, 15)}`;
  }
  return base;
}

function SortableLayerItem({
  block,
  isSelected,
  isExpanded,
  onSelect,
  onToggleExpand,
  onDelete,
  onDuplicate,
  onToggleVisibility,
  hasChildren,
  depth = 0,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `layer-${block.id}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const Icon = BLOCK_ICONS[block.type] || SquareDashed;
  const isHidden = block.hidden;

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, paddingLeft: `${depth * 16 + 4}px` }}
      className={`flex items-center gap-1 px-1 py-0.5 rounded-md text-sm cursor-pointer select-none transition-colors ${
        isSelected
          ? 'bg-primary/15 text-foreground'
          : 'hover:bg-muted/60 text-foreground'
      } ${isHidden ? 'opacity-50' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(block.id);
      }}
      data-testid={`layer-item-${block.id}`}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab p-0.5 rounded hover:bg-muted flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
        data-testid={`layer-drag-${block.id}`}
      >
        <GripVertical className="w-3 h-3 text-muted-foreground" />
      </div>

      {hasChildren && (
        <button
          className="p-0.5 rounded hover:bg-muted flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(block.id);
          }}
          data-testid={`layer-expand-${block.id}`}
        >
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
      )}
      {!hasChildren && <div className="w-4 flex-shrink-0" />}

      <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      <span className="truncate flex-1 text-xs">{getBlockLabel(block)}</span>

      <div className="flex items-center gap-0.5 flex-shrink-0 ml-auto">
        <button
          className="p-0.5 rounded hover:bg-muted"
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisibility(block.id);
          }}
          data-testid={`layer-visibility-${block.id}`}
        >
          {isHidden ? (
            <EyeOff className="w-3 h-3 text-muted-foreground" />
          ) : (
            <Eye className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
        <button
          className="p-0.5 rounded hover:bg-muted"
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate(block.id);
          }}
          data-testid={`layer-copy-${block.id}`}
        >
          <Copy className="w-3 h-3 text-muted-foreground" />
        </button>
        <button
          className="p-0.5 rounded hover:bg-muted hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(block.id);
          }}
          data-testid={`layer-delete-${block.id}`}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function SortableChildItem({
  child,
  sectionId,
  isSelected,
  onSelect,
  onDelete,
  onDuplicate,
  onToggleVisibility,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `child-${child.id}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    paddingLeft: '20px',
  };

  const Icon = BLOCK_ICONS[child.type] || SquareDashed;
  const isHidden = child.hidden;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1 px-1 py-0.5 rounded-md text-sm cursor-pointer select-none transition-colors ${
        isSelected
          ? 'bg-primary/15 text-foreground'
          : 'hover:bg-muted/60 text-foreground'
      } ${isHidden ? 'opacity-50' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(child.id, sectionId);
      }}
      data-testid={`layer-child-${child.id}`}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab p-0.5 rounded hover:bg-muted flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="w-3 h-3 text-muted-foreground" />
      </div>
      <div className="w-4 flex-shrink-0" />
      <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      <span className="truncate flex-1 text-xs">{getBlockLabel(child)}</span>

      <div className="flex items-center gap-0.5 flex-shrink-0 ml-auto">
        <button
          className="p-0.5 rounded hover:bg-muted"
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisibility(child.id, sectionId);
          }}
          data-testid={`layer-child-visibility-${child.id}`}
        >
          {isHidden ? (
            <EyeOff className="w-3 h-3 text-muted-foreground" />
          ) : (
            <Eye className="w-3 h-3 text-muted-foreground" />
          )}
        </button>
        <button
          className="p-0.5 rounded hover:bg-muted"
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate(child.id);
          }}
          data-testid={`layer-child-copy-${child.id}`}
        >
          <Copy className="w-3 h-3 text-muted-foreground" />
        </button>
        <button
          className="p-0.5 rounded hover:bg-muted hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(child.id);
          }}
          data-testid={`layer-child-delete-${child.id}`}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

export default function LayersPanel({
  blocks,
  selectedBlockId,
  selectedChildId,
  onSelectBlock,
  onSelectChild,
  onDeleteBlock,
  onDuplicateBlock,
  onDeleteChild,
  onDuplicateChild,
  onToggleBlockVisibility,
  onToggleChildVisibility,
  onReorderBlocks,
  onReorderChildren,
}) {
  const [expandedSections, setExpandedSections] = useState(() => {
    const initial = {};
    blocks.forEach((b) => {
      if (b.type === BLOCK_TYPES.SECTION) initial[b.id] = true;
    });
    return initial;
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const toggleExpand = useCallback((id) => {
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleBlockSelect = useCallback(
    (blockId) => {
      onSelectBlock(blockId);
    },
    [onSelectBlock]
  );

  const handleChildSelect = useCallback(
    (childId, sectionId) => {
      onSelectBlock(sectionId);
      onSelectChild(childId);
    },
    [onSelectBlock, onSelectChild]
  );

  const handleTopLevelDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeRealId = String(active.id).replace('layer-', '');
    const overRealId = String(over.id).replace('layer-', '');
    const oldIndex = blocks.findIndex((b) => b.id === activeRealId);
    const newIndex = blocks.findIndex((b) => b.id === overRealId);
    if (oldIndex !== -1 && newIndex !== -1) {
      onReorderBlocks(oldIndex, newIndex);
    }
  };

  const handleChildDragEnd = (sectionId) => (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeRealId = String(active.id).replace('child-', '');
    const overRealId = String(over.id).replace('child-', '');
    const section = blocks.find((b) => b.id === sectionId);
    if (!section?.children) return;
    const oldIndex = section.children.findIndex((c) => c.id === activeRealId);
    const newIndex = section.children.findIndex((c) => c.id === overRealId);
    if (oldIndex !== -1 && newIndex !== -1) {
      onReorderChildren(sectionId, oldIndex, newIndex);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b flex-shrink-0">
        <h3 className="font-medium text-sm">Layers</h3>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-0.5">
          {blocks.length === 0 && (
            <p className="text-xs text-muted-foreground p-2">
              No elements yet. Drag blocks from the palette.
            </p>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleTopLevelDragEnd}
          >
            <SortableContext
              items={blocks.map((b) => `layer-${b.id}`)}
              strategy={verticalListSortingStrategy}
            >
              {blocks.map((block) => {
                const hasChildren =
                  block.type === BLOCK_TYPES.SECTION &&
                  block.children &&
                  block.children.length > 0;
                const isExpanded = expandedSections[block.id] !== false;

                return (
                  <div key={block.id}>
                    <SortableLayerItem
                      block={block}
                      isSelected={
                        block.id === selectedBlockId && !selectedChildId
                      }
                      isExpanded={isExpanded}
                      onSelect={handleBlockSelect}
                      onToggleExpand={toggleExpand}
                      onDelete={onDeleteBlock}
                      onDuplicate={onDuplicateBlock}
                      onToggleVisibility={onToggleBlockVisibility}
                      hasChildren={hasChildren}
                      depth={0}
                    />
                    {hasChildren && isExpanded && (
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleChildDragEnd(block.id)}
                      >
                        <SortableContext
                          items={block.children.map((c) => `child-${c.id}`)}
                          strategy={verticalListSortingStrategy}
                        >
                          {block.children.map((child) => (
                            <SortableChildItem
                              key={child.id}
                              child={child}
                              sectionId={block.id}
                              isSelected={child.id === selectedChildId}
                              onSelect={handleChildSelect}
                              onDelete={onDeleteChild}
                              onDuplicate={onDuplicateChild}
                              onToggleVisibility={onToggleChildVisibility}
                            />
                          ))}
                        </SortableContext>
                      </DndContext>
                    )}
                  </div>
                );
              })}
            </SortableContext>
          </DndContext>
        </div>
      </ScrollArea>
    </div>
  );
}
