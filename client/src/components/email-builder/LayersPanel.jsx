import { useState, useCallback, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
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
  FileText,
  X,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
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
    const plainText = block.content.replace(/<[^>]*>/g, '').trim();
    if (plainText) {
      const preview = plainText.substring(0, 20);
      return preview.length < plainText.length ? `${preview}...` : preview;
    }
    return base;
  }
  if (block.type === BLOCK_TYPES.BUTTON && block.content) {
    return `Button: ${block.content.substring(0, 15)}`;
  }
  return base;
}

function FlatLayerItem({
  item,
  isSelected,
  isExpanded,
  isDragOver,
  onSelect,
  onToggleExpand,
  onDelete,
  onDuplicate,
  onToggleVisibility,
  hasChildren,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.sortableId,
    data: {
      itemType: item.itemType,
      blockType: item.block.type,
      blockId: item.block.id,
      parentSectionId: item.parentSectionId || null,
      isSection: item.block.type === BLOCK_TYPES.SECTION && item.itemType === 'top-level',
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const Icon = BLOCK_ICONS[item.block.type] || SquareDashed;
  const isHidden = item.block.hidden;
  const depth = item.depth || 0;

  let itemClassName = 'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm cursor-pointer select-none transition-colors ';
  if (isSelected) {
    itemClassName += 'bg-primary/20 text-foreground ring-1 ring-primary/30 ';
  } else if (isDragOver) {
    itemClassName += 'bg-primary/15 ring-1 ring-primary/40 ring-dashed text-foreground ';
  } else {
    itemClassName += 'bg-muted/40 text-foreground hover-elevate ';
  }
  if (isHidden) itemClassName += 'opacity-50 ';

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, paddingLeft: `${depth * 16 + 4}px` }}
      className={itemClassName}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      data-testid={`layer-item-${item.block.id}`}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab p-0.5 rounded hover:bg-muted flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
        data-testid={`layer-drag-${item.block.id}`}
      >
        <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
      </div>

      {hasChildren ? (
        <button
          className="p-0.5 rounded hover:bg-muted flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            if (onToggleExpand) onToggleExpand();
          }}
          data-testid={`layer-expand-${item.block.id}`}
        >
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </button>
      ) : (
        <div className="w-5 flex-shrink-0" />
      )}

      <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      <span className="truncate flex-1 text-[13px]">{getBlockLabel(item.block)}</span>

      <div className="flex items-center gap-0.5 flex-shrink-0 ml-auto" style={{ visibility: 'visible' }}>
        {onToggleVisibility && (
          <button
            className="p-0.5 rounded hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation();
              onToggleVisibility();
            }}
            data-testid={`layer-visibility-${item.block.id}`}
          >
            {isHidden ? (
              <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />
            ) : (
              <Eye className="w-3.5 h-3.5 text-muted-foreground" />
            )}
          </button>
        )}
        {onDuplicate && (
          <button
            className="p-0.5 rounded hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
            data-testid={`layer-copy-${item.block.id}`}
          >
            <Copy className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        )}
        {onDelete && (
          <button
            className="p-0.5 rounded hover:bg-muted hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            data-testid={`layer-delete-${item.block.id}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function ColumnChildLayerItem({ child, blockId, columnId, isSelected, onSelect, onDelete }) {
  const Icon = BLOCK_ICONS[child.type] || SquareDashed;

  let itemClassName = 'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm cursor-pointer select-none transition-colors ';
  if (isSelected) {
    itemClassName += 'bg-primary/20 text-foreground ring-1 ring-primary/30 ';
  } else {
    itemClassName += 'bg-muted/30 text-foreground hover-elevate ';
  }
  if (child.hidden) itemClassName += 'opacity-50 ';

  return (
    <div
      style={{ paddingLeft: '40px' }}
      className={itemClassName}
      onClick={(e) => {
        e.stopPropagation();
        if (onSelect) onSelect(child.id, blockId, columnId);
      }}
      data-testid={`layer-col-child-${child.id}`}
    >
      <div className="w-5 flex-shrink-0" />
      <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      <span className="truncate flex-1 text-[13px]">{getBlockLabel(child)}</span>
      <div className="flex items-center gap-0.5 flex-shrink-0 ml-auto">
        <button
          className="p-0.5 rounded hover:bg-muted hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            if (onDelete) onDelete(child.id, blockId, columnId);
          }}
          data-testid={`layer-col-child-delete-${child.id}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function PageDropTarget({ isPageSelected, onSelectPage }) {
  const { isOver, setNodeRef } = useDroppable({
    id: 'page-drop-target',
    data: { isPageTarget: true },
  });

  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-1.5 px-2 py-2 rounded-md text-sm cursor-pointer select-none transition-colors ${
        isOver
          ? 'bg-primary/15 ring-1 ring-primary/40 ring-dashed text-foreground'
          : isPageSelected
            ? 'bg-primary/20 text-foreground ring-1 ring-primary/30'
            : 'bg-muted/40 text-foreground hover-elevate'
      }`}
      onClick={() => onSelectPage()}
      data-testid="layer-page"
    >
      <FileText className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
      <span className="truncate font-medium text-[13px]">Page</span>
      {isOver && (
        <span className="text-[11px] text-primary ml-auto">Drop to move here</span>
      )}
    </div>
  );
}

function SectionDropZone({ sectionId }) {
  const { isOver, setNodeRef } = useDroppable({
    id: `section-dropzone-${sectionId}`,
    data: { isSectionDropZone: true, sectionId },
  });

  return (
    <div
      ref={setNodeRef}
      style={{ paddingLeft: '24px' }}
      className={`text-xs px-2 py-1.5 italic transition-colors ${
        isOver
          ? 'text-primary bg-primary/10'
          : 'text-muted-foreground/60'
      }`}
    >
      Drop elements here
    </div>
  );
}

export default function LayersPanel({
  blocks,
  selectedBlockId,
  selectedChildId,
  selectedColumnChildId,
  isPageSelected,
  onSelectBlock,
  onSelectChild,
  onSelectColumnChild,
  onDeleteColumnChild,
  onSelectPage,
  onDeleteBlock,
  onDuplicateBlock,
  onDeleteChild,
  onDuplicateChild,
  onToggleBlockVisibility,
  onToggleChildVisibility,
  onReorderBlocks,
  onReorderChildren,
  onMoveBlockToSection,
  onMoveChildToTopLevel,
  onMoveChildToSection,
  onClose,
}) {
  const [expandedSections, setExpandedSections] = useState(() => {
    const initial = {};
    blocks.forEach((b) => {
      if (b.type === BLOCK_TYPES.SECTION || b.type === BLOCK_TYPES.COLUMNS) initial[b.id] = true;
    });
    return initial;
  });

  const [dragOverSectionId, setDragOverSectionId] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const toggleExpand = useCallback((id) => {
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const flatItems = useMemo(() => {
    const items = [];
    blocks.forEach((block, blockIndex) => {
      items.push({
        sortableId: `layer-${block.id}`,
        itemType: 'top-level',
        block,
        blockIndex,
        depth: 0,
        parentSectionId: null,
      });
      if (block.type === BLOCK_TYPES.SECTION && expandedSections[block.id] !== false && block.children) {
        block.children.forEach((child) => {
          items.push({
            sortableId: `child-${child.id}`,
            itemType: 'section-child',
            block: child,
            depth: 1,
            parentSectionId: block.id,
          });
        });
      }
    });
    return items;
  }, [blocks, expandedSections]);

  const sortableIds = useMemo(() => flatItems.map(i => i.sortableId), [flatItems]);

  const handleDragOver = (event) => {
    const { active, over } = event;
    if (!over) {
      setDragOverSectionId(null);
      return;
    }
    const overData = over.data?.current;
    const activeData = active.data?.current;

    if (
      activeData?.blockType !== BLOCK_TYPES.SECTION &&
      activeData?.blockType !== BLOCK_TYPES.COLUMNS &&
      active.id !== over.id
    ) {
      if (overData?.isSection === true) {
        setDragOverSectionId(overData.blockId);
      } else if (overData?.isSectionDropZone === true) {
        setDragOverSectionId(overData.sectionId);
      } else {
        setDragOverSectionId(null);
      }
    } else {
      setDragOverSectionId(null);
    }
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    setDragOverSectionId(null);
    if (!over || active.id === over.id) return;

    const activeData = active.data?.current;
    const overData = over.data?.current;

    const activeItemType = activeData?.itemType;
    const activeBlockType = activeData?.blockType;
    const activeBlockId = activeData?.blockId;
    const activeParentSection = activeData?.parentSectionId;

    const overItemType = overData?.itemType;
    const overBlockId = overData?.blockId;
    const overParentSection = overData?.parentSectionId;
    const overIsSection = overData?.isSection === true;
    const overIsSectionDropZone = overData?.isSectionDropZone === true;

    if (overIsSectionDropZone) {
      const targetSectionId = overData.sectionId;
      if (activeBlockType === BLOCK_TYPES.SECTION || activeBlockType === BLOCK_TYPES.COLUMNS) return;

      if (activeItemType === 'top-level' && onMoveBlockToSection) {
        onMoveBlockToSection(activeBlockId, targetSectionId);
      } else if (activeItemType === 'section-child') {
        if (activeParentSection === targetSectionId) return;
        if (onMoveChildToSection) {
          onMoveChildToSection(activeBlockId, activeParentSection, targetSectionId);
        }
      }
      return;
    }

    if (activeBlockType === BLOCK_TYPES.SECTION || activeBlockType === BLOCK_TYPES.COLUMNS) {
      if (activeItemType === 'top-level' && overItemType === 'top-level') {
        const oldIndex = blocks.findIndex(b => b.id === activeBlockId);
        const newIndex = blocks.findIndex(b => b.id === overBlockId);
        if (oldIndex !== -1 && newIndex !== -1) {
          onReorderBlocks(oldIndex, newIndex);
        }
      }
      return;
    }

    if (activeItemType === 'top-level') {
      if (overIsSection && onMoveBlockToSection) {
        onMoveBlockToSection(activeBlockId, overBlockId);
      } else if (overItemType === 'section-child' && overParentSection && onMoveBlockToSection) {
        onMoveBlockToSection(activeBlockId, overParentSection);
      } else if (overItemType === 'top-level') {
        const oldIndex = blocks.findIndex(b => b.id === activeBlockId);
        const newIndex = blocks.findIndex(b => b.id === overBlockId);
        if (oldIndex !== -1 && newIndex !== -1) {
          onReorderBlocks(oldIndex, newIndex);
        }
      }
      return;
    }

    if (activeItemType === 'section-child') {
      if (overIsSection) {
        if (overBlockId === activeParentSection) {
          return;
        }
        if (onMoveChildToSection) {
          onMoveChildToSection(activeBlockId, activeParentSection, overBlockId);
        }
        return;
      }

      if (overItemType === 'section-child' && overParentSection) {
        if (overParentSection === activeParentSection) {
          const section = blocks.find(b => b.id === activeParentSection);
          if (section?.children) {
            const oldIndex = section.children.findIndex(c => c.id === activeBlockId);
            const newIndex = section.children.findIndex(c => c.id === overBlockId);
            if (oldIndex !== -1 && newIndex !== -1) {
              onReorderChildren(activeParentSection, oldIndex, newIndex);
            }
          }
        } else {
          if (onMoveChildToSection) {
            onMoveChildToSection(activeBlockId, activeParentSection, overParentSection);
          }
        }
        return;
      }

      if (overItemType === 'top-level' && !overIsSection) {
        if (onMoveChildToTopLevel) {
          const overIndex = blocks.findIndex(b => b.id === overBlockId);
          onMoveChildToTopLevel(activeBlockId, activeParentSection, overIndex);
        }
        return;
      }

      if (over.id === 'page-drop-target') {
        if (onMoveChildToTopLevel) {
          onMoveChildToTopLevel(activeBlockId, activeParentSection, null);
        }
        return;
      }
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b flex-shrink-0 flex items-center justify-between gap-1">
        <h3 className="font-medium text-sm">Layers</h3>
        {onClose && (
          <Button
            size="icon"
            variant="ghost"
            onClick={onClose}
            title="Close layers"
            data-testid="button-close-layers"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
          <PageDropTarget isPageSelected={isPageSelected} onSelectPage={onSelectPage} />
          {blocks.length === 0 && (
            <p className="text-xs text-muted-foreground p-2 pl-6">
              No elements yet. Drag blocks from the palette.
            </p>
          )}
            <SortableContext
              items={sortableIds}
              strategy={verticalListSortingStrategy}
            >
              {blocks.map((block) => {
                const hasChildren =
                  (block.type === BLOCK_TYPES.SECTION &&
                  block.children &&
                  block.children.length > 0) ||
                  (block.type === BLOCK_TYPES.COLUMNS &&
                  block.columns &&
                  block.columns.some(col => col.blocks.length > 0));
                const isExpanded = expandedSections[block.id] !== false;
                const isSection = block.type === BLOCK_TYPES.SECTION;

                const topItem = flatItems.find(i => i.sortableId === `layer-${block.id}`);

                return (
                  <div key={block.id}>
                    {topItem && (
                      <FlatLayerItem
                        item={topItem}
                        isSelected={block.id === selectedBlockId && !selectedChildId && !selectedColumnChildId}
                        isExpanded={isExpanded}
                        isDragOver={dragOverSectionId === block.id}
                        onSelect={() => onSelectBlock(block.id)}
                        onToggleExpand={() => toggleExpand(block.id)}
                        onDelete={() => onDeleteBlock(block.id)}
                        onDuplicate={() => onDuplicateBlock(block.id)}
                        onToggleVisibility={() => onToggleBlockVisibility(block.id)}
                        hasChildren={(hasChildren || isSection || block.type === BLOCK_TYPES.COLUMNS)}
                      />
                    )}

                    {isSection && isExpanded && block.children && block.children.map((child) => {
                      const childItem = flatItems.find(i => i.sortableId === `child-${child.id}`);
                      if (!childItem) return null;
                      return (
                        <FlatLayerItem
                          key={child.id}
                          item={childItem}
                          isSelected={child.id === selectedChildId}
                          isExpanded={false}
                          isDragOver={false}
                          onSelect={() => {
                            onSelectBlock(block.id);
                            onSelectChild(child.id);
                          }}
                          onDelete={() => onDeleteChild(child.id)}
                          onDuplicate={() => onDuplicateChild(child.id)}
                          onToggleVisibility={() => onToggleChildVisibility(child.id, block.id)}
                          hasChildren={false}
                        />
                      );
                    })}

                    {isSection && isExpanded && (!block.children || block.children.length === 0) && (
                      <SectionDropZone sectionId={block.id} />
                    )}

                    {block.type === BLOCK_TYPES.COLUMNS && isExpanded && block.columns && (
                      <div>
                        {block.columns.map((col, colIdx) => (
                          <div key={col.id}>
                            <div
                              style={{ paddingLeft: '24px' }}
                              className="flex items-center gap-1.5 px-2 py-1 text-[13px] text-muted-foreground"
                            >
                              <Columns className="w-3.5 h-3.5" />
                              <span>Col {colIdx + 1} ({col.width})</span>
                            </div>
                            {col.blocks.map((childBlock) => (
                              <ColumnChildLayerItem
                                key={childBlock.id}
                                child={childBlock}
                                blockId={block.id}
                                columnId={col.id}
                                isSelected={childBlock.id === selectedColumnChildId}
                                onSelect={onSelectColumnChild}
                                onDelete={onDeleteColumnChild}
                              />
                            ))}
                          </div>
                        ))}
                      </div>
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
