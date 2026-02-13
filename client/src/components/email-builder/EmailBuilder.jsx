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
import LayersPanel from './LayersPanel';
import { BLOCK_TYPES, createBlock, defaultEmailDesign } from './types';
import { designToHtml } from './mjmlConverter';
import { PanelRightOpen, PanelRightClose, Layers, Undo2, Redo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const GOOGLE_FONTS_LINK = 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&family=Open+Sans:wght@400;700&family=Lato:wght@400;700&family=Montserrat:wght@400;700&family=Poppins:wght@400;700&family=Raleway:wght@400;700&family=Oswald:wght@400;700&family=Playfair+Display:wght@400;700&family=Merriweather:wght@400;700&family=Source+Sans+Pro:wght@400;700&display=swap';

const loadGoogleFonts = () => {
  if (typeof document !== 'undefined' && !document.getElementById('email-builder-google-fonts')) {
    const link = document.createElement('link');
    link.id = 'email-builder-google-fonts';
    link.rel = 'stylesheet';
    link.href = GOOGLE_FONTS_LINK;
    document.head.appendChild(link);
  }
};

export default function EmailBuilder({ 
  initialDesign, 
  onChange, 
}) {
  const [design, setDesign] = useState(() => {
    if (initialDesign && initialDesign.blocks) {
      return {
        ...initialDesign,
        globalStyles: {
          ...defaultEmailDesign.globalStyles,
          ...initialDesign.globalStyles,
        },
      };
    }
    return { ...defaultEmailDesign };
  });
  const [selectedBlockId, setSelectedBlockId] = useState(null);
  const [selectedChildId, setSelectedChildId] = useState(null);
  const [selectedColumnChildId, setSelectedColumnChildId] = useState(null);
  const [selectedColumnContext, setSelectedColumnContext] = useState(null);
  const [isPageSelected, setIsPageSelected] = useState(true);
  const [activeId, setActiveId] = useState(null);
  const [layersOpen, setLayersOpen] = useState(true);
  const [propertiesExpanded, setPropertiesExpanded] = useState(false);
  const debounceRef = useRef(null);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const MAX_HISTORY = 50;

  const [footerHtml, setFooterHtml] = useState(null);
  const [footerLoading, setFooterLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/email-campaigns/preview-footer', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { footer: null })
      .then(data => { if (!cancelled) { setFooterHtml(data.footer || null); setFooterLoading(false); } })
      .catch(() => { if (!cancelled) setFooterLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const canUndo = undoStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;

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
  
  const selectedChild = selectedChildId ? (() => {
    for (const block of design.blocks) {
      if (block.type === BLOCK_TYPES.SECTION && block.children) {
        const child = block.children.find(c => c.id === selectedChildId);
        if (child) return { child, parentId: block.id };
      }
    }
    return null;
  })() : null;

  const selectedColChild = selectedColumnChildId && selectedColumnContext ? (() => {
    const block = design.blocks.find(b => b.id === selectedColumnContext.blockId);
    if (!block || block.type !== BLOCK_TYPES.COLUMNS) return null;
    const col = block.columns.find(c => c.id === selectedColumnContext.columnId);
    if (!col) return null;
    const child = col.blocks.find(b => b.id === selectedColumnChildId);
    if (!child) return null;
    return { child, blockId: block.id, columnId: col.id };
  })() : null;

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
    loadGoogleFonts();
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const isUndoRedoRef = useRef(false);

  const updateDesign = useCallback((updater) => {
    setDesign(prev => {
      const newDesign = typeof updater === 'function' ? updater(prev) : updater;
      if (newDesign === prev) return prev;
      if (!isUndoRedoRef.current) {
        undoStackRef.current = [...undoStackRef.current.slice(-(MAX_HISTORY - 1)), prev];
        redoStackRef.current = [];
        setHistoryVersion(v => v + 1);
      }
      notifyChange(newDesign);
      return newDesign;
    });
    isUndoRedoRef.current = false;
  }, [notifyChange]);

  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    isUndoRedoRef.current = true;
    setDesign(prev => {
      redoStackRef.current = [...redoStackRef.current, prev];
      const previousState = undoStackRef.current[undoStackRef.current.length - 1];
      undoStackRef.current = undoStackRef.current.slice(0, -1);
      setHistoryVersion(v => v + 1);
      notifyChange(previousState);
      return previousState;
    });
  }, [notifyChange]);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    isUndoRedoRef.current = true;
    setDesign(prev => {
      undoStackRef.current = [...undoStackRef.current, prev];
      const nextState = redoStackRef.current[redoStackRef.current.length - 1];
      redoStackRef.current = redoStackRef.current.slice(0, -1);
      setHistoryVersion(v => v + 1);
      notifyChange(nextState);
      return nextState;
    });
  }, [notifyChange]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      const isRichTextEditor = e.target.closest?.('.ProseMirror');
      if (isRichTextEditor) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo]);

  const handleDragStart = (event) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    if (activeData?.fromPalette) {
      const newBlock = createBlock(activeData.type);
      
      setIsPageSelected(false);
      setSelectedColumnChildId(null);
      setSelectedColumnContext(null);

      if (overData?.isColumn && activeData.type !== BLOCK_TYPES.SECTION && activeData.type !== BLOCK_TYPES.COLUMNS) {
        const { blockId, columnId } = overData;
        updateDesign(prev => ({
          ...prev,
          blocks: prev.blocks.map(b => {
            if (b.id === blockId && b.type === BLOCK_TYPES.COLUMNS) {
              return {
                ...b,
                columns: b.columns.map(col => {
                  if (col.id === columnId) {
                    return { ...col, blocks: [...col.blocks, newBlock] };
                  }
                  return col;
                }),
              };
            }
            return b;
          }),
        }));
        setSelectedBlockId(blockId);
        setSelectedChildId(null);
        setSelectedColumnChildId(newBlock.id);
        setSelectedColumnContext({ blockId, columnId });
      } else if (overData?.isSection && activeData.type !== BLOCK_TYPES.SECTION && activeData.type !== BLOCK_TYPES.COLUMNS) {
        const sectionId = overData.sectionId;
        updateDesign(prev => ({
          ...prev,
          blocks: prev.blocks.map(b => {
            if (b.id === sectionId) {
              return { ...b, children: [...(b.children || []), newBlock] };
            }
            return b;
          }),
        }));
        setSelectedBlockId(sectionId);
        setSelectedChildId(newBlock.id);
      } else if (over.id === 'canvas-drop-area' || !design.blocks.find(b => b.id === over.id)) {
        updateDesign(prev => ({
          ...prev,
          blocks: [...prev.blocks, newBlock],
        }));
        setSelectedBlockId(newBlock.id);
        setSelectedChildId(null);
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
        setSelectedBlockId(newBlock.id);
        setSelectedChildId(null);
      }
      return;
    }

    if (overData?.isSection) {
      const sectionId = overData.sectionId;
      const blockId = active.id;
      if (blockId !== sectionId) {
        let didMove = false;
        updateDesign(prev => {
          const blockToMove = prev.blocks.find(b => b.id === blockId);
          const targetSection = prev.blocks.find(b => b.id === sectionId);
          if (!blockToMove || !targetSection || targetSection.type !== BLOCK_TYPES.SECTION) return prev;
          if (blockToMove.type === BLOCK_TYPES.SECTION || blockToMove.type === BLOCK_TYPES.COLUMNS) return prev;
          didMove = true;
          return {
            ...prev,
            blocks: prev.blocks
              .filter(b => b.id !== blockId)
              .map(b => {
                if (b.id === sectionId) {
                  return { ...b, children: [...(b.children || []), blockToMove] };
                }
                return b;
              }),
          };
        });
        if (didMove) {
          setSelectedBlockId(sectionId);
          setSelectedChildId(blockId);
          setSelectedColumnChildId(null);
          setSelectedColumnContext(null);
          return;
        }
      }
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

  const handlePageSelect = () => {
    setIsPageSelected(true);
    setSelectedBlockId(null);
    setSelectedChildId(null);
    setSelectedColumnChildId(null);
    setSelectedColumnContext(null);
  };

  const handleBlockSelect = (blockId) => {
    setIsPageSelected(false);
    setSelectedBlockId(blockId);
    setSelectedChildId(null);
    setSelectedColumnChildId(null);
    setSelectedColumnContext(null);
  };

  const handleChildSelect = (childId) => {
    setIsPageSelected(false);
    setSelectedChildId(childId);
    setSelectedColumnChildId(null);
    setSelectedColumnContext(null);
  };

  const handleColumnChildSelect = (childId, blockId, columnId) => {
    setIsPageSelected(false);
    setSelectedBlockId(blockId);
    setSelectedChildId(null);
    setSelectedColumnChildId(childId);
    setSelectedColumnContext({ blockId, columnId });
  };

  const handleColumnChildUpdate = (updatedChild) => {
    if (!selectedColumnContext) return;
    updateDesign(prev => ({
      ...prev,
      blocks: prev.blocks.map(b => {
        if (b.id === selectedColumnContext.blockId && b.type === BLOCK_TYPES.COLUMNS) {
          return {
            ...b,
            columns: b.columns.map(col => {
              if (col.id === selectedColumnContext.columnId) {
                return {
                  ...col,
                  blocks: col.blocks.map(cb => cb.id === updatedChild.id ? updatedChild : cb),
                };
              }
              return col;
            }),
          };
        }
        return b;
      }),
    }));
  };

  const handleColumnChildDelete = (childId, blockId, columnId) => {
    updateDesign(prev => ({
      ...prev,
      blocks: prev.blocks.map(b => {
        if (b.id === blockId && b.type === BLOCK_TYPES.COLUMNS) {
          return {
            ...b,
            columns: b.columns.map(col => {
              if (col.id === columnId) {
                return { ...col, blocks: col.blocks.filter(cb => cb.id !== childId) };
              }
              return col;
            }),
          };
        }
        return b;
      }),
    }));
    if (selectedColumnChildId === childId) {
      setSelectedColumnChildId(null);
      setSelectedColumnContext(null);
    }
  };

  const handleChildDelete = (childId) => {
    updateDesign(prev => ({
      ...prev,
      blocks: prev.blocks.map(b => {
        if (b.type === BLOCK_TYPES.SECTION && b.children) {
          return { ...b, children: b.children.filter(c => c.id !== childId) };
        }
        return b;
      }),
    }));
    if (selectedChildId === childId) {
      setSelectedChildId(null);
    }
  };

  const handleChildDuplicate = (childId) => {
    for (const block of design.blocks) {
      if (block.type === BLOCK_TYPES.SECTION && block.children) {
        const childIndex = block.children.findIndex(c => c.id === childId);
        if (childIndex !== -1) {
          const child = block.children[childIndex];
          const newChild = {
            ...JSON.parse(JSON.stringify(child)),
            id: `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          };
          updateDesign(prev => ({
            ...prev,
            blocks: prev.blocks.map(b => {
              if (b.id === block.id) {
                const newChildren = [...b.children];
                newChildren.splice(childIndex + 1, 0, newChild);
                return { ...b, children: newChildren };
              }
              return b;
            }),
          }));
          setSelectedChildId(newChild.id);
          break;
        }
      }
    }
  };

  const handleChildUpdate = (updatedChild) => {
    updateDesign(prev => ({
      ...prev,
      blocks: prev.blocks.map(b => {
        if (b.type === BLOCK_TYPES.SECTION && b.children) {
          return {
            ...b,
            children: b.children.map(c => c.id === updatedChild.id ? updatedChild : c),
          };
        }
        return b;
      }),
    }));
  };

  const handleMoveBlockToSection = (blockId, sectionId) => {
    updateDesign(prev => {
      const blockToMove = prev.blocks.find(b => b.id === blockId);
      const targetSection = prev.blocks.find(b => b.id === sectionId);
      if (!blockToMove || !targetSection || targetSection.type !== BLOCK_TYPES.SECTION) return prev;
      if (blockToMove.type === BLOCK_TYPES.SECTION || blockToMove.type === BLOCK_TYPES.COLUMNS) return prev;
      return {
        ...prev,
        blocks: prev.blocks
          .filter(b => b.id !== blockId)
          .map(b => {
            if (b.id === sectionId) {
              return { ...b, children: [...(b.children || []), blockToMove] };
            }
            return b;
          }),
      };
    });
    setSelectedBlockId(sectionId);
    setSelectedChildId(blockId);
    setSelectedColumnChildId(null);
    setSelectedColumnContext(null);
  };

  const handleMoveChildToTopLevel = (childId, fromSectionId, insertAtIndex) => {
    updateDesign(prev => {
      const section = prev.blocks.find(b => b.id === fromSectionId);
      if (!section || !section.children) return prev;
      const child = section.children.find(c => c.id === childId);
      if (!child) return prev;
      const blocksWithChildRemoved = prev.blocks.map(b => {
        if (b.id === fromSectionId) {
          return { ...b, children: b.children.filter(c => c.id !== childId) };
        }
        return b;
      });
      const idx = insertAtIndex != null ? insertAtIndex : blocksWithChildRemoved.length;
      blocksWithChildRemoved.splice(idx, 0, child);
      return { ...prev, blocks: blocksWithChildRemoved };
    });
    setSelectedBlockId(childId);
    setSelectedChildId(null);
    setSelectedColumnChildId(null);
    setSelectedColumnContext(null);
  };

  const handleMoveChildToSection = (childId, fromSectionId, toSectionId) => {
    if (fromSectionId === toSectionId) return;
    updateDesign(prev => {
      const fromSection = prev.blocks.find(b => b.id === fromSectionId);
      const toSection = prev.blocks.find(b => b.id === toSectionId);
      if (!fromSection?.children || !toSection || toSection.type !== BLOCK_TYPES.SECTION) return prev;
      const child = fromSection.children.find(c => c.id === childId);
      if (!child) return prev;
      return {
        ...prev,
        blocks: prev.blocks.map(b => {
          if (b.id === fromSectionId) {
            return { ...b, children: b.children.filter(c => c.id !== childId) };
          }
          if (b.id === toSectionId) {
            return { ...b, children: [...(b.children || []), child] };
          }
          return b;
        }),
      };
    });
    setSelectedBlockId(toSectionId);
    setSelectedChildId(childId);
    setSelectedColumnChildId(null);
    setSelectedColumnContext(null);
  };

  const handleReorderChildren = (sectionId, fromIndex, toIndex) => {
    updateDesign(prev => ({
      ...prev,
      blocks: prev.blocks.map(b => {
        if (b.id === sectionId && b.children) {
          const newChildren = [...b.children];
          const [moved] = newChildren.splice(fromIndex, 1);
          newChildren.splice(toIndex, 0, moved);
          return { ...b, children: newChildren };
        }
        return b;
      }),
    }));
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

  const handleToggleBlockVisibility = (blockId) => {
    updateDesign(prev => ({
      ...prev,
      blocks: prev.blocks.map(b => 
        b.id === blockId ? { ...b, hidden: !b.hidden } : b
      ),
    }));
  };

  const handleToggleChildVisibility = (childId) => {
    updateDesign(prev => ({
      ...prev,
      blocks: prev.blocks.map(b => {
        if (b.type === BLOCK_TYPES.SECTION && b.children) {
          return {
            ...b,
            children: b.children.map(c => 
              c.id === childId ? { ...c, hidden: !c.hidden } : c
            ),
          };
        }
        return b;
      }),
    }));
  };

  const handleReorderBlocks = (fromIndex, toIndex) => {
    updateDesign(prev => ({
      ...prev,
      blocks: arrayMove(prev.blocks, fromIndex, toIndex),
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
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="w-64 border-r bg-muted/30 flex flex-col flex-shrink-0">
          <ScrollArea className="flex-1">
            <BlockPalette />
          </ScrollArea>
        </div>

        <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden" style={{ backgroundColor: design.globalStyles.backgroundColor }}>
          <div className="flex items-center gap-1 px-3 py-1.5 border-b bg-background/80 flex-shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleUndo}
                  disabled={!canUndo}
                  data-testid="button-undo"
                >
                  <Undo2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Undo (Ctrl+Z)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleRedo}
                  disabled={!canRedo}
                  data-testid="button-redo"
                >
                  <Redo2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Redo (Ctrl+Shift+Z)</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-8">
            <div className="flex justify-start">
            <div 
              className="w-full shadow-lg"
              style={{ 
                maxWidth: design.globalStyles.contentWidth || '600px',
                backgroundColor: design.globalStyles.contentBackgroundColor,
                padding: design.globalStyles.contentPadding || '0px',
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
                      onSelectChild={handleChildSelect}
                      selectedChildId={selectedChildId}
                      onSelectColumnChild={handleColumnChildSelect}
                      selectedColumnChildId={selectedColumnChildId}
                      globalFontFamily={design.globalStyles.fontFamily}
                    />
                  ))}
                </CanvasDropZone>
              </SortableContext>
              {design.globalStyles.useDefaultFooter !== false && footerHtml && (
                <div
                  className="border-t border-dashed border-muted-foreground/30"
                  style={{ padding: '0 16px 12px 16px' }}
                >
                  <p className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wider font-medium">Default Footer</p>
                  <div
                    className="text-xs [&_a]:text-blue-600 [&_a]:underline [&_img]:max-w-full"
                    style={{ pointerEvents: 'none' }}
                    dangerouslySetInnerHTML={{ __html: footerHtml }}
                    data-testid="canvas-footer-preview"
                  />
                </div>
              )}
            </div>
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
      </DndContext>

      <div className="relative flex-shrink-0 overflow-visible" style={{ width: '320px' }}>
        <div
          className="absolute top-0 bottom-0 border-l border-r bg-background flex flex-col transition-transform duration-200 ease-in-out"
          style={{
            width: '320px',
            right: '100%',
            transform: layersOpen ? 'translateX(0)' : 'translateX(100%)',
            zIndex: 5,
          }}
          data-testid="layers-panel"
        >
            <LayersPanel
              blocks={design.blocks}
              selectedBlockId={selectedBlockId}
              selectedChildId={selectedChildId}
              selectedColumnChildId={selectedColumnChildId}
              isPageSelected={isPageSelected}
              onSelectBlock={handleBlockSelect}
              onSelectChild={handleChildSelect}
              onSelectColumnChild={handleColumnChildSelect}
              onDeleteColumnChild={handleColumnChildDelete}
              onSelectPage={handlePageSelect}
              onDeleteBlock={handleBlockDelete}
              onDuplicateBlock={handleBlockDuplicate}
              onDeleteChild={handleChildDelete}
              onDuplicateChild={handleChildDuplicate}
              onToggleBlockVisibility={handleToggleBlockVisibility}
              onToggleChildVisibility={handleToggleChildVisibility}
              onReorderBlocks={handleReorderBlocks}
              onReorderChildren={handleReorderChildren}
              onMoveBlockToSection={handleMoveBlockToSection}
              onMoveChildToTopLevel={handleMoveChildToTopLevel}
              onMoveChildToSection={handleMoveChildToSection}
              onClose={() => setLayersOpen(false)}
            />
        </div>

        {!layersOpen && !propertiesExpanded && (
          <div
            className="absolute"
            style={{ right: '100%', top: '6px', zIndex: 15 }}
          >
            <Button
              size="icon"
              variant="outline"
              onClick={() => setLayersOpen(true)}
              title="Show layers"
              className="rounded-r-none border-r-0"
              data-testid="button-open-layers-tab"
            >
              <Layers className="h-4 w-4" />
            </Button>
          </div>
        )}

        <div
          className="absolute top-0 bottom-0 right-0 flex flex-col bg-background border-l transition-all duration-200 ease-in-out"
          style={{
            zIndex: 10,
            width: '320px',
            ...(propertiesExpanded ? { left: '-320px', width: '640px' } : {}),
          }}
          data-testid="properties-panel"
        >
          <div className="p-3 border-b flex items-center justify-between gap-1">
            <h3 className="font-medium text-sm">
              {isPageSelected ? 'Page Settings' : 'Properties'}
            </h3>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setPropertiesExpanded(prev => !prev)}
                title={propertiesExpanded ? 'Collapse panel' : 'Expand panel'}
                data-testid="button-toggle-properties-expand"
              >
                {propertiesExpanded ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
          <ScrollArea className="flex-1">
            {isPageSelected ? (
              <GlobalSettings 
                settings={design.globalStyles} 
                onChange={handleGlobalSettingsChange}
                footerHtml={footerHtml}
                footerLoading={footerLoading}
              />
            ) : selectedColChild ? (
              <BlockEditor 
                block={selectedColChild.child} 
                onChange={handleColumnChildUpdate}
                isChild={true}
                globalFontFamily={design.globalStyles.fontFamily}
              />
            ) : selectedChild ? (
              <BlockEditor 
                block={selectedChild.child} 
                onChange={handleChildUpdate}
                isChild={true}
                globalFontFamily={design.globalStyles.fontFamily}
              />
            ) : (
              <BlockEditor 
                block={selectedBlock} 
                onChange={handleBlockUpdate}
                globalFontFamily={design.globalStyles.fontFamily}
              />
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

export { designToHtml };
