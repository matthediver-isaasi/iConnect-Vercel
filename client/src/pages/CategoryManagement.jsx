import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FolderTree, Plus, Pencil, Trash2, AlertCircle, Tag, GripVertical } from "lucide-react";
import { toast } from "sonner";
import { renameResourceSubcategory } from "@/api/functions";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const CONTENT_TYPE_OPTIONS = [
  { value: 'Articles', label: 'Articles' },
  { value: 'Resources', label: 'Resources' },
  { value: 'News', label: 'News' },
  { value: 'Events', label: 'Events' }
];

export default function CategoryManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('content.categories')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [editingCategory, setEditingCategory] = useState(null);
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState(null);
  const [newSubcategory, setNewSubcategory] = useState("");
  const [editingSubcategory, setEditingSubcategory] = useState(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isReordering, setIsReordering] = useState(false);

  const queryClient = useQueryClient();

  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['resource-categories'],
    queryFn: () => base44.entities.ResourceCategory.list('display_order'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const createCategoryMutation = useMutation({
    mutationFn: (categoryData) => base44.entities.ResourceCategory.create(categoryData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resource-categories'] });
      setShowCategoryDialog(false);
      setEditingCategory(null);
      toast.success('Category created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create category: ' + error.message);
    }
  });

  const updateCategoryMutation = useMutation({
    mutationFn: ({ id, categoryData }) => base44.entities.ResourceCategory.update(id, categoryData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resource-categories'] });
      setShowCategoryDialog(false);
      setEditingCategory(null);
      toast.success('Category updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update category: ' + error.message);
    }
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: (id) => base44.entities.ResourceCategory.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resource-categories'] });
      setShowDeleteConfirm(false);
      setCategoryToDelete(null);
      toast.success('Category deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete category: ' + error.message);
    }
  });

  const renameMutation = useMutation({
    mutationFn: async ({ categoryId, oldName, newName }) => {
      const response = await renameResourceSubcategory({ 
        categoryId, 
        oldSubcategoryName: oldName, 
        newSubcategoryName: newName 
      });
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['resource-categories'] });
      setShowRenameDialog(false);
      setEditingSubcategory(null);
      setRenameValue("");
      toast.success(data.message || 'Subcategory renamed successfully');
    },
    onError: (error) => {
      toast.error('Failed to rename subcategory: ' + error.message);
    }
  });

  const handleCreateNew = () => {
    setEditingCategory({
      name: "",
      description: "",
      subcategories: [],
      display_order: categories.length,
      is_active: true,
      applies_to_content_types: ['Articles', 'Resources']
    });
    setShowCategoryDialog(true);
  };

  const handleEdit = (category) => {
    setEditingCategory({ ...category });
    setShowCategoryDialog(true);
  };

  const handleDelete = (category) => {
    setCategoryToDelete(category);
    setShowDeleteConfirm(true);
  };

  const handleSave = () => {
    if (!editingCategory.name.trim()) {
      toast.error('Category name is required');
      return;
    }

    const categoryData = {
      name: editingCategory.name,
      description: editingCategory.description || "",
      subcategories: editingCategory.subcategories || [],
      display_order: editingCategory.display_order,
      is_active: editingCategory.is_active,
      applies_to_content_types: editingCategory.applies_to_content_types || ['Articles', 'Resources']
    };

    if (editingCategory.id) {
      updateCategoryMutation.mutate({ id: editingCategory.id, categoryData });
    } else {
      createCategoryMutation.mutate(categoryData);
    }
  };

  const handleAddSubcategory = () => {
    const trimmed = newSubcategory.trim();
    if (!trimmed) {
      toast.error('Subcategory name cannot be empty');
      return;
    }

    const existing = editingCategory.subcategories || [];
    if (existing.includes(trimmed)) {
      toast.error('Subcategory already exists');
      return;
    }

    const updated = [...existing, trimmed].sort((a, b) => 
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );

    setEditingCategory({ ...editingCategory, subcategories: updated });
    setNewSubcategory("");
  };

  const handleRemoveSubcategory = (subcategory) => {
    const updated = (editingCategory.subcategories || []).filter(s => s !== subcategory);
    setEditingCategory({ ...editingCategory, subcategories: updated });
  };

  const handleRenameSubcategory = (category, subcategory) => {
    setEditingSubcategory({ category, subcategory });
    setRenameValue(subcategory);
    setShowRenameDialog(true);
  };

  const confirmRename = () => {
    if (!renameValue.trim() || renameValue.trim() === editingSubcategory.subcategory) {
      toast.error('Please enter a different name');
      return;
    }

    renameMutation.mutate({
      categoryId: editingSubcategory.category.id,
      oldName: editingSubcategory.subcategory,
      newName: renameValue.trim()
    });
  };

  const toggleContentType = (type) => {
    const current = editingCategory.applies_to_content_types || [];
    const updated = current.includes(type)
      ? current.filter(t => t !== type)
      : [...current, type];
    
    setEditingCategory({ ...editingCategory, applies_to_content_types: updated });
  };

  const handleDragEnd = async (result) => {
    if (!result.destination) return;
    if (result.source.index === result.destination.index) return;

    setIsReordering(true);

    try {
      const items = Array.from(categories);
      const [reorderedItem] = items.splice(result.source.index, 1);
      items.splice(result.destination.index, 0, reorderedItem);

      // Update display_order for all affected items
      const updates = items.map((item, index) => 
        base44.entities.ResourceCategory.update(item.id, { display_order: index })
      );

      await Promise.all(updates);
      await queryClient.invalidateQueries({ queryKey: ['resource-categories'] });
      toast.success('Category order updated');
    } catch (error) {
      toast.error('Failed to reorder: ' + error.message);
    } finally {
      setIsReordering(false);
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Category Management
            </h1>
            <p className="text-slate-600">
              Manage categories and subcategories for Theme, Collection, Level, and News Type
            </p>
          </div>
          <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
            <Plus className="w-4 h-4 mr-2" />
            Create Category
          </Button>
        </div>

        {isLoading ? (
          <div className="text-center py-12">Loading categories...</div>
        ) : categories.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <FolderTree className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Categories Yet
              </h3>
              <p className="text-slate-600 mb-6">
                Create your first category to organize your content
              </p>
              <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Category
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {isReordering && (
              <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-50 flex items-center justify-center">
                <div className="bg-white rounded-lg p-6 shadow-xl">
                  <div className="flex items-center gap-3">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                    <p className="text-slate-900 font-medium">Updating order...</p>
                  </div>
                </div>
              </div>
            )}
            
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="categories">
                {(provided) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="space-y-4"
                  >
                    {categories.map((category, index) => (
                      <Draggable key={category.id} draggableId={category.id} index={index}>
                        {(provided, snapshot) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                          >
                            <Card className={`border-slate-200 shadow-sm hover:shadow-md transition-shadow ${
                              snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-400' : ''
                            }`}>
                              <CardHeader className="border-b border-slate-200">
                                <div className="flex items-start gap-3">
                                  <div {...provided.dragHandleProps} className="pt-1">
                                    <GripVertical className="w-5 h-5 text-slate-400 cursor-grab active:cursor-grabbing" />
                                  </div>
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-2">
                                      <FolderTree className="w-5 h-5 text-blue-600" />
                                      <CardTitle className="text-lg">{category.name}</CardTitle>
                                    </div>
                                    {category.description && (
                                      <p className="text-sm text-slate-600 mb-2">{category.description}</p>
                                    )}
                                    <div className="flex flex-wrap gap-2">
                                      {(category.applies_to_content_types || []).map(type => (
                                        <Badge key={type} className="bg-purple-100 text-purple-700 text-xs">
                                          {type}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              </CardHeader>
                              <CardContent className="pt-4">
                                <div className="space-y-3 mb-4">
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs font-medium text-slate-500 uppercase">
                                      Subcategories ({(category.subcategories || []).length})
                                    </span>
                                  </div>
                                  {(category.subcategories || []).length === 0 ? (
                                    <p className="text-sm text-slate-500 italic">No subcategories yet</p>
                                  ) : (
                                    <div className="space-y-2 max-h-48 overflow-y-auto">
                                      {category.subcategories.map((sub) => (
                                        <div
                                          key={sub}
                                          className="flex items-center justify-between p-2 bg-slate-50 rounded-lg text-sm group"
                                        >
                                          <span className="text-slate-700">{sub}</span>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => handleRenameSubcategory(category, sub)}
                                            className="opacity-0 group-hover:opacity-100 transition-opacity h-7 text-xs"
                                          >
                                            <Pencil className="w-3 h-3 mr-1" />
                                            Rename
                                          </Button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>

                                <div className="flex gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleEdit(category)}
                                    className="flex-1"
                                  >
                                    <Pencil className="w-3 h-3 mr-1" />
                                    Edit
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleDelete(category)}
                                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </Button>
                                </div>
                              </CardContent>
                            </Card>
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>
          </>
        )}

        {/* Create/Edit Category Dialog */}
        <Dialog open={showCategoryDialog} onOpenChange={setShowCategoryDialog}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingCategory?.id ? 'Edit Category' : 'Create New Category'}
              </DialogTitle>
            </DialogHeader>

            {editingCategory && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="category-name">Category Name *</Label>
                  <Input
                    id="category-name"
                    value={editingCategory.name}
                    onChange={(e) => setEditingCategory({ ...editingCategory, name: e.target.value })}
                    placeholder="e.g., Theme, Collection, Level"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="category-description">Description</Label>
                  <Textarea
                    id="category-description"
                    value={editingCategory.description || ''}
                    onChange={(e) => setEditingCategory({ ...editingCategory, description: e.target.value })}
                    placeholder="Optional description..."
                    rows={2}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Applies To Content Types</Label>
                  <div className="flex flex-wrap gap-3 p-3 bg-slate-50 rounded-lg">
                    {CONTENT_TYPE_OPTIONS.map(option => (
                      <label
                        key={option.value}
                        className="flex items-center gap-2 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={(editingCategory.applies_to_content_types || []).includes(option.value)}
                          onChange={() => toggleContentType(option.value)}
                          className="rounded border-slate-300"
                        />
                        <span className="text-sm text-slate-700">{option.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <Label>Subcategories</Label>
                  
                  <div className="flex gap-2">
                    <Input
                      placeholder="Add subcategory..."
                      value={newSubcategory}
                      onChange={(e) => setNewSubcategory(e.target.value)}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddSubcategory();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      onClick={handleAddSubcategory}
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>

                  {(editingCategory.subcategories || []).length > 0 && (
                    <div className="space-y-2 max-h-64 overflow-y-auto border border-slate-200 rounded-lg p-3">
                      {editingCategory.subcategories.map((sub) => (
                        <div
                          key={sub}
                          className="flex items-center justify-between p-2 bg-slate-50 rounded"
                        >
                          <span className="text-sm text-slate-700">{sub}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveSubcategory(sub)}
                            className="text-red-600 hover:text-red-700 h-7"
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="display-order">Display Order</Label>
                  <Input
                    id="display-order"
                    type="number"
                    value={editingCategory.display_order}
                    onChange={(e) => setEditingCategory({ ...editingCategory, display_order: parseInt(e.target.value) || 0 })}
                  />
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowCategoryDialog(false);
                  setEditingCategory(null);
                  setNewSubcategory("");
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createCategoryMutation.isPending || updateCategoryMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingCategory?.id ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Category</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-red-50 rounded-lg">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-red-900 font-medium">
                    Are you sure you want to delete "{categoryToDelete?.name}"?
                  </p>
                  <p className="text-xs text-red-700 mt-1">
                    This will remove the category and may affect content that uses it.
                  </p>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setCategoryToDelete(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => categoryToDelete && deleteCategoryMutation.mutate(categoryToDelete.id)}
                disabled={deleteCategoryMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Rename Subcategory Dialog */}
        <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rename Subcategory</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="p-3 bg-blue-50 rounded-lg">
                <p className="text-sm text-blue-900">
                  This will update the subcategory name across all resources and articles that use it.
                </p>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="rename-value">New Name</Label>
                <Input
                  id="rename-value"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="Enter new subcategory name..."
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      confirmRename();
                    }
                  }}
                />
              </div>

              {editingSubcategory && (
                <div className="text-sm text-slate-600">
                  <p><span className="font-medium">Category:</span> {editingSubcategory.category.name}</p>
                  <p><span className="font-medium">Current name:</span> {editingSubcategory.subcategory}</p>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowRenameDialog(false);
                  setEditingSubcategory(null);
                  setRenameValue("");
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={confirmRename}
                disabled={renameMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {renameMutation.isPending ? 'Renaming...' : 'Rename'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}