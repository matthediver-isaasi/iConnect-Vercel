import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, Save, Eye, EyeOff, Settings, Plus } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useNavigate } from "react-router-dom";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import IEditElementPalette from "../components/iedit/IEditElementPalette";
import IEditElementCard from "../components/iedit/IEditElementCard";
import IEditElementEditor from "../components/iedit/IEditElementEditor";
import IEditPageSettings from "../components/iedit/IEditPageSettings";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";
import ElementPreviewWrapper from "../components/iedit/ElementPreviewWrapper";
import DraggableEditModal from "../components/iedit/DraggableEditModal";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function IEditPageEditorPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [pageId, setPageId] = useState(null);
  const [elements, setElements] = useState([]);
  const [showPalette, setShowPalette] = useState(false);
  const [editingElement, setEditingElement] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  
  const [inlineEditingElement, setInlineEditingElement] = useState(null);
  const [draftContent, setDraftContent] = useState({});
  const [draftVariant, setDraftVariant] = useState('default');
  const [draftSettings, setDraftSettings] = useState({});

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('site-builder.page-editor')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // Get pageId from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('pageId');
    if (id) {
      setPageId(id);
    } else {
      toast.error('No page ID provided');
      navigate(createPageUrl('IEditPageManagement'));
    }
  }, []);

  // Fetch page data
  const { data: page, isLoading: pageLoading } = useQuery({
    queryKey: ['iedit-page', pageId],
    queryFn: async () => {
      const allPages = await base44.entities.IEditPage.list();
      return allPages.find(p => p.id === pageId);
    },
    enabled: !!pageId
  });

  // Fetch page elements
  const { data: pageElements = [], isLoading: elementsLoading } = useQuery({
    queryKey: ['iedit-page-elements', pageId],
    queryFn: () => base44.entities.IEditPageElement.list({ 
      filter: { page_id: pageId }, 
      sort: { display_order: 'asc' } 
    }),
    staleTime: 0,
    enabled: !!pageId
  });

  // Fetch all pages for "Copy to Page" feature
  const { data: allPages = [] } = useQuery({
    queryKey: ['iedit-all-pages'],
    queryFn: () => base44.entities.IEditPage.list()
  });

  // Update local state when elements are fetched
  useEffect(() => {
    if (pageElements) {
      setElements(pageElements);
    }
  }, [pageElements]);

  // Update page mutation
  const updatePageMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.IEditPage.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-page', pageId] });
      toast.success('Page updated successfully');
    }
  });

  // Create element mutation
  const createElementMutation = useMutation({
    mutationFn: (elementData) => base44.entities.IEditPageElement.create(elementData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-page-elements', pageId] });
      setShowPalette(false);
      toast.success('Element added');
    }
  });

  // Update element mutation
  const updateElementMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.IEditPageElement.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-page-elements', pageId] });
      toast.success('Element updated');
    }
  });

  // Delete element mutation
  const deleteElementMutation = useMutation({
    mutationFn: (id) => base44.entities.IEditPageElement.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-page-elements', pageId] });
      toast.success('Element deleted');
    }
  });

  // Handle drag end
  const handleDragEnd = async (result) => {
    if (!result.destination) return;

    const items = Array.from(elements);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);

    // Update local state immediately for smooth UX
    setElements(items);

    // Update display_order for all affected elements
    const updates = items.map((item, index) => ({
      id: item.id,
      display_order: index
    }));

    try {
      for (const update of updates) {
        await base44.entities.IEditPageElement.update(update.id, { display_order: update.display_order });
      }
      queryClient.invalidateQueries({ queryKey: ['iedit-page-elements', pageId] });
    } catch (error) {
      toast.error('Failed to reorder elements');
      // Revert on error
      setElements(pageElements);
    }
  };

  // Add element from palette
  const handleAddElement = async (template) => {
    const newElement = {
      page_id: pageId,
      element_type: template.element_type,
      display_order: elements.length,
      content: template.default_content || {},
      style_variant: (template.available_variants && template.available_variants.length > 0) ? template.available_variants[0] : 'default',
      settings: {}
    };

    createElementMutation.mutate(newElement);
  };

  // Update element
  const handleUpdateElement = async (elementId, updates) => {
    updateElementMutation.mutate({ id: elementId, data: updates });
    setEditingElement(null);
  };

  // Delete element
  const handleDeleteElement = async (elementId) => {
    if (confirm('Are you sure you want to delete this element?')) {
      deleteElementMutation.mutate(elementId);
    }
  };

  // Duplicate element
  const handleDuplicateElement = async (element) => {
    const duplicated = {
      page_id: pageId,
      element_type: element.element_type,
      display_order: element.display_order + 1,
      content: { ...element.content },
      style_variant: element.style_variant,
      settings: { ...element.settings }
    };

    createElementMutation.mutate(duplicated);
  };

  // Copy element to another page
  const handleCopyToPage = async (element, targetPageId) => {
    try {
      // Get elements from target page to determine display order
      const targetPageElements = await base44.entities.IEditPageElement.list({ 
        filter: { page_id: targetPageId } 
      });
      
      const newElement = {
        page_id: targetPageId,
        element_type: element.element_type,
        display_order: targetPageElements.length,
        content: { ...element.content },
        style_variant: element.style_variant,
        settings: { ...element.settings }
      };

      await base44.entities.IEditPageElement.create(newElement);
      
      // Find the target page name for the toast
      const targetPage = allPages.find(p => p.id === targetPageId);
      toast.success(`Element copied to "${targetPage?.title || 'page'}"`);
      
      // Invalidate target page elements cache
      queryClient.invalidateQueries({ queryKey: ['iedit-page-elements', targetPageId] });
    } catch (error) {
      console.error('Failed to copy element:', error);
      toast.error('Failed to copy element to page');
    }
  };

  // Update page settings
  const handleUpdatePageSettings = (updates) => {
    updatePageMutation.mutate({ id: pageId, data: updates });
    setShowSettings(false);
  };

  const handleStartInlineEdit = (element) => {
    setInlineEditingElement(element);
    setDraftContent(element.content || {});
    setDraftVariant(element.style_variant || 'default');
    setDraftSettings(element.settings || {});
  };

  const handleInlineEditChange = (updates) => {
    if (updates.content !== undefined) {
      setDraftContent(updates.content);
    }
    if (updates.style_variant !== undefined) {
      setDraftVariant(updates.style_variant);
    }
    if (updates.settings !== undefined) {
      setDraftSettings(updates.settings);
    }
  };

  const handleSaveInlineEdit = async () => {
    if (!inlineEditingElement) return;
    
    try {
      await updateElementMutation.mutateAsync({ 
        id: inlineEditingElement.id, 
        data: {
          content: draftContent,
          style_variant: draftVariant,
          settings: draftSettings
        }
      });
      setInlineEditingElement(null);
      setDraftContent({});
      setDraftVariant('default');
      setDraftSettings({});
      toast.success('Element updated');
    } catch (error) {
      toast.error('Failed to save element');
    }
  };

  const handleCancelInlineEdit = () => {
    setInlineEditingElement(null);
    setDraftContent({});
    setDraftVariant('default');
    setDraftSettings({});
  };

  const elementsWithDraft = useMemo(() => {
    if (!inlineEditingElement) return elements;
    
    return elements.map(el => {
      if (el.id === inlineEditingElement.id) {
        return { 
          ...el, 
          content: draftContent,
          style_variant: draftVariant,
          settings: draftSettings
        };
      }
      return el;
    });
  }, [elements, inlineEditingElement, draftContent, draftVariant, draftSettings]);

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  if (pageLoading || !page) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-slate-600">Loading page editor...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Top Bar */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(createPageUrl('IEditPageManagement'))}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <div>
            <h1 className="text-xl font-bold text-slate-900">{page.title}</h1>
            <p className="text-sm text-slate-500">/{page.slug}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSettings(true)}
          >
            <Settings className="w-4 h-4 mr-2" />
            Settings
          </Button>
          <Button
            variant={previewMode ? "default" : "outline"}
            size="sm"
            onClick={() => setPreviewMode(!previewMode)}
            className={previewMode ? "bg-blue-600 hover:bg-blue-700" : ""}
          >
            {previewMode ? (
              <>
                <EyeOff className="w-4 h-4 mr-2" />
                Edit Mode
              </>
            ) : (
              <>
                <Eye className="w-4 h-4 mr-2" />
                Preview
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="flex-1 flex">
        {/* Main Editor Area */}
        <div className="flex-1 overflow-y-auto">
          {previewMode ? (
            /* Preview Mode */
            <div className="bg-white min-h-full">
              <style>
                {`
                  @font-face {
                    font-family: 'Degular Medium';
                    src: url('https://teeone.pythonanywhere.com/font-assets/Degular-Medium.woff') format('woff');
                    font-weight: 500;
                    font-style: normal;
                    font-display: swap;
                  }
                `}
              </style>
              {elementsWithDraft.length === 0 ? (
                <div className="flex items-center justify-center py-20">
                  <div className="text-center">
                    <Eye className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-600 mb-2">Preview Empty</p>
                    <p className="text-sm text-slate-500">Add elements to see the preview</p>
                    <Button
                      onClick={() => setPreviewMode(false)}
                      className="mt-4 bg-blue-600 hover:bg-blue-700"
                    >
                      Exit Preview
                    </Button>
                  </div>
                </div>
              ) : (
                elementsWithDraft.map((element) => (
                  <ElementPreviewWrapper
                    key={element.id}
                    element={element}
                    onEdit={handleStartInlineEdit}
                    isEditing={inlineEditingElement?.id === element.id}
                  >
                    <IEditElementRenderer
                      element={element}
                      memberInfo={null}
                      organizationInfo={null}
                    />
                  </ElementPreviewWrapper>
                ))
              )}
            </div>
          ) : (
            /* Edit Mode */
            <div className="p-8">
              <div className="max-w-4xl mx-auto">
                {/* Add Element Button */}
                <div className="mb-6">
                  <Button
                    onClick={() => setShowPalette(true)}
                    className="w-full bg-blue-600 hover:bg-blue-700"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add Element
                  </Button>
                </div>

                {/* Elements List */}
                {elements.length === 0 ? (
                  <Card className="border-2 border-dashed border-slate-300">
                    <CardContent className="p-12 text-center">
                      <p className="text-slate-600 mb-4">No elements yet. Start building your page!</p>
                      <Button onClick={() => setShowPalette(true)} className="bg-blue-600 hover:bg-blue-700">
                        <Plus className="w-4 h-4 mr-2" />
                        Add First Element
                      </Button>
                    </CardContent>
                  </Card>
                ) : (
                  <DragDropContext onDragEnd={handleDragEnd}>
                    <Droppable droppableId="elements">
                      {(provided) => (
                        <div
                          {...provided.droppableProps}
                          ref={provided.innerRef}
                          className="space-y-4"
                        >
                          {elements.map((element, index) => (
                            <Draggable
                              key={element.id}
                              draggableId={element.id}
                              index={index}
                            >
                              {(provided, snapshot) => (
                                <div
                                  ref={provided.innerRef}
                                  {...provided.draggableProps}
                                  {...provided.dragHandleProps}
                                >
                                  <IEditElementCard
                                    element={element}
                                    isDragging={snapshot.isDragging}
                                    onEdit={() => setEditingElement(element)}
                                    onDelete={() => handleDeleteElement(element.id)}
                                    onDuplicate={() => handleDuplicateElement(element)}
                                    onCopyToPage={handleCopyToPage}
                                    availablePages={allPages}
                                    currentPageId={pageId}
                                  />
                                </div>
                              )}
                            </Draggable>
                          ))}
                          {provided.placeholder}
                        </div>
                      )}
                    </Droppable>
                  </DragDropContext>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Element Palette Sidebar */}
      {showPalette && !previewMode && (
        <IEditElementPalette
          onClose={() => setShowPalette(false)}
          onSelectTemplate={handleAddElement}
        />
      )}

      {/* Element Editor Sidebar */}
      {editingElement && !previewMode && (
        <IEditElementEditor
          element={editingElement}
          onClose={() => setEditingElement(null)}
          onSave={(updates) => handleUpdateElement(editingElement.id, updates)}
        />
      )}

      {/* Page Settings Dialog */}
      {showSettings && page && (
        <IEditPageSettings
          page={page}
          onClose={() => setShowSettings(false)}
          onSave={handleUpdatePageSettings}
        />
      )}

      {/* Inline Edit Modal (for preview mode editing) */}
      {inlineEditingElement && previewMode && (
        <DraggableEditModal
          element={inlineEditingElement}
          draftContent={draftContent}
          draftVariant={draftVariant}
          draftSettings={draftSettings}
          onChange={handleInlineEditChange}
          onSave={handleSaveInlineEdit}
          onClose={handleCancelInlineEdit}
          EditorComponent={IEditElementEditor}
        />
      )}
    </div>
  );
}