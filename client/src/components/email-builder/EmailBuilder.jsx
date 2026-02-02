import { useState, useCallback, useEffect, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
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
} from '@dnd-kit/sortable';
import { ScrollArea } from '@/components/ui/scroll-area';
import BlockPalette from './BlockPalette';
import BlockRenderer from './BlockRenderer';
import BlockEditor from './BlockEditor';
import GlobalSettings from './GlobalSettings';
import { BLOCK_TYPES, createBlock, defaultEmailDesign } from './types';
import { designToHtml } from './mjmlConverter';

export default function EmailBuilder({ 
  initialDesign, 
  onChange, 
  height = '100%' 
}) {
  const [design, setDesign] = useState(() => {
    if (initialDesign && initialDesign.blocks) {
      return initialDesign;
    }
    return { ...defaultEmailDesign };
  });
  const [selectedBlockId, setSelectedBlockId] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const debounceRef = useRef(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const selectedBlock = design.blocks.find(b => b.id === selectedBlockId);

  const notifyChange = useCallback((newDesign) => {
    if (!onChange) return;
    
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    
    debounceRef.current = setTimeout(() => {
      const html = designToHtml(newDesign);
      onChange({ design: newDesign, html });
    }, 300);
  }, [onChange]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const updateDesign = useCallback((updater) => {
    setDesign(prev => {
      const newDesign = typeof updater === 'function' ? updater(prev) : updater;
      notifyChange(newDesign);
      return newDesign;
    });
  }, [notifyChange]);

  const handleDragStart = (event) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over) return;

    const activeData = active.data.current;

    if (activeData?.fromPalette) {
      const newBlock = createBlock(activeData.type);
      
      if (over.id === 'canvas-drop-area' || !design.blocks.find(b => b.id === over.id)) {
        updateDesign(prev => ({
          ...prev,
          blocks: [...prev.blocks, newBlock],
        }));
      } else {
        const overIndex = design.blocks.findIndex(b => b.id === over.id);
        updateDesign(prev => ({
          ...prev,
          blocks: [
            ...prev.blocks.slice(0, overIndex),
            newBlock,
            ...prev.blocks.slice(overIndex),
          ],
        }));
      }
      setSelectedBlockId(newBlock.id);
      return;
    }

    if (active.id !== over.id) {
      updateDesign(prev => {
        const oldIndex = prev.blocks.findIndex(b => b.id === active.id);
        const newIndex = prev.blocks.findIndex(b => b.id === over.id);
        
        if (oldIndex === -1 || newIndex === -1) return prev;
        
        return {
          ...prev,
          blocks: arrayMove(prev.blocks, oldIndex, newIndex),
        };
      });
    }
  };

  const handleBlockSelect = (blockId) => {
    setSelectedBlockId(blockId);
  };

  const handleBlockDelete = (blockId) => {
    updateDesign(prev => ({
      ...prev,
      blocks: prev.blocks.filter(b => b.id !== blockId),
    }));
    if (selectedBlockId === blockId) {
      setSelectedBlockId(null);
    }
  };

  const handleBlockDuplicate = (blockId) => {
    const block = design.blocks.find(b => b.id === blockId);
    if (!block) return;
    
    const newBlock = {
      ...JSON.parse(JSON.stringify(block)),
      id: `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };
    
    const index = design.blocks.findIndex(b => b.id === blockId);
    updateDesign(prev => ({
      ...prev,
      blocks: [
        ...prev.blocks.slice(0, index + 1),
        newBlock,
        ...prev.blocks.slice(index + 1),
      ],
    }));
    setSelectedBlockId(newBlock.id);
  };

  const handleBlockUpdate = (updatedBlock) => {
    updateDesign(prev => ({
      ...prev,
      blocks: prev.blocks.map(b => b.id === updatedBlock.id ? updatedBlock : b),
    }));
  };

  const handleGlobalSettingsChange = (newSettings) => {
    updateDesign(prev => ({
      ...prev,
      globalStyles: newSettings,
    }));
  };

  function CanvasDropZone({ children, isEmpty }) {
    const { isOver, setNodeRef } = useDroppable({
      id: 'canvas-drop-area',
    });

    return (
      <div 
        ref={setNodeRef}
        className={`min-h-[400px] p-4 transition-colors ${
          isOver ? 'bg-primary/5 ring-2 ring-primary ring-inset' : ''
        }`}
      >
        {isEmpty && (
          <div className={`flex flex-col items-center justify-center h-[300px] border-2 border-dashed rounded-lg text-muted-foreground ${
            isOver ? 'border-primary bg-primary/10' : 'border-muted-foreground/30'
          }`}>
            <p className="text-lg mb-2">
              {isOver ? 'Drop to add block' : 'Drag blocks here to build your email'}
            </p>
            {!isOver && <p className="text-sm">or click a block type on the left to add it</p>}
          </div>
        )}
        {children}
      </div>
    );
  }

  return (
    <div className="flex h-full" style={{ height }}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {/* Left Panel - Block Palette & Global Settings */}
        <div className="w-64 border-r bg-muted/30 flex flex-col">
          <ScrollArea className="flex-1">
            <BlockPalette />
            <GlobalSettings 
              settings={design.globalStyles} 
              onChange={handleGlobalSettingsChange} 
            />
          </ScrollArea>
        </div>

        {/* Center - Canvas */}
        <div className="flex-1 overflow-auto" style={{ backgroundColor: design.globalStyles.backgroundColor }}>
          <div className="p-8 min-h-full flex justify-center">
            <div 
              className="w-full shadow-lg"
              style={{ 
                maxWidth: design.globalStyles.contentWidth,
                backgroundColor: design.globalStyles.contentBackgroundColor,
              }}
            >
              <SortableContext
                items={design.blocks.map(b => b.id)}
                strategy={verticalListSortingStrategy}
              >
                <CanvasDropZone isEmpty={design.blocks.length === 0}>
                  {design.blocks.map(block => (
                    <BlockRenderer
                      key={block.id}
                      block={block}
                      isSelected={block.id === selectedBlockId}
                      onSelect={handleBlockSelect}
                      onDelete={handleBlockDelete}
                      onDuplicate={handleBlockDuplicate}
                    />
                  ))}
                </CanvasDropZone>
              </SortableContext>
            </div>
          </div>
        </div>

        <DragOverlay>
          {activeId && activeId.startsWith('palette-') && (
            <div className="p-3 bg-background border rounded-md shadow-lg opacity-80">
              <span className="text-sm font-medium">
                {activeId.replace('palette-', '').charAt(0).toUpperCase() + 
                 activeId.replace('palette-', '').slice(1)} Block
              </span>
            </div>
          )}
        </DragOverlay>

        {/* Right Panel - Block Editor */}
        <div className="w-72 border-l bg-background flex flex-col">
          <div className="p-3 border-b">
            <h3 className="font-medium text-sm">Properties</h3>
          </div>
          <ScrollArea className="flex-1">
            <BlockEditor 
              block={selectedBlock} 
              onChange={handleBlockUpdate} 
            />
          </ScrollArea>
        </div>
      </DndContext>
    </div>
  );
}

export { designToHtml };
