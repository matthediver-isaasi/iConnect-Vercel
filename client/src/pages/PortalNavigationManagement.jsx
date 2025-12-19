import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Menu, Plus, Pencil, GripVertical, Users, Shield, Calendar, CreditCard, Ticket, Wallet, ShoppingCart, History, Sparkles, FileText, Briefcase, Settings, BookOpen, Building, HelpCircle, BarChart3, FileEdit, AtSign, FolderTree, Trophy, MousePointer2, Mail, Download, LayoutGrid, Table, Search, Trash2 } from "lucide-react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const availableIcons = {
  Menu, Calendar, CreditCard, Ticket, Wallet, ShoppingCart, History, Sparkles, FileText, Briefcase, Settings, 
  BookOpen, Building, HelpCircle, Users, Shield, BarChart3, FileEdit, AtSign, FolderTree, Trophy, MousePointer2, Mail, Download
};

export default function PortalNavigationManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('system.portal-navigation')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [editingItem, setEditingItem] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [viewMode, setViewMode] = useState('hierarchy'); // 'hierarchy' or 'table'
  const [searchQuery, setSearchQuery] = useState('');
  const [filterSection, setFilterSection] = useState('all');
  const [filterParent, setFilterParent] = useState('all');
  const [sortBy, setSortBy] = useState('display_order');

  const queryClient = useQueryClient();

  const { data: navItems = [], isLoading } = useQuery({
    queryKey: ['portal-navigation-items'],
    queryFn: () => base44.entities.PortalNavigationItem.list('display_order'),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnMount: true
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.PortalNavigationItem.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-navigation-items'] });
      setShowDialog(false);
      setEditingItem(null);
      toast.success('Navigation item created');
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.PortalNavigationItem.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-navigation-items'] });
      setShowDialog(false);
      setEditingItem(null);
      toast.success('Navigation item updated');
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.PortalNavigationItem.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-navigation-items'] });
      toast.success('Navigation item deleted');
    }
  });

  const userItems = useMemo(() => {
    const items = navItems.filter(item => item.is_active && item.section === "user").sort((a, b) => a.display_order - b.display_order);
    // Build hierarchy
    const topLevel = items.filter(item => !item.parent_title);
    return topLevel.map(parent => ({
      ...parent,
      subItems: items.filter(child => child.parent_title === parent.title).sort((a, b) => a.display_order - b.display_order)
    }));
  }, [navItems]);

  const adminItems = useMemo(() => {
    const items = navItems.filter(item => item.is_active && item.section === "admin").sort((a, b) => a.display_order - b.display_order);
    // Build hierarchy
    const topLevel = items.filter(item => !item.parent_title);
    return topLevel.map(parent => ({
      ...parent,
      subItems: items.filter(child => child.parent_title === parent.title).sort((a, b) => a.display_order - b.display_order)
    }));
  }, [navItems]);

  const filteredAndSortedItems = useMemo(() => {
    let filtered = navItems.filter(item => {
      const matchesSearch = searchQuery === '' || 
        item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.url?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.feature_id?.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesSection = filterSection === 'all' || item.section === filterSection;
      const matchesParent = filterParent === 'all' || 
        (filterParent === 'none' && !item.parent_title) ||
        (filterParent !== 'none' && item.parent_title === filterParent);

      return matchesSearch && matchesSection && matchesParent;
    });

    // Build hierarchical structure
    const topLevel = filtered.filter(item => !item.parent_title);
    const result = [];

    topLevel.sort((a, b) => {
      switch (sortBy) {
        case 'title':
          return a.title.localeCompare(b.title);
        case 'section':
          return a.section.localeCompare(b.section);
        case 'display_order':
        default:
          return a.display_order - b.display_order;
      }
    });

    topLevel.forEach(parent => {
      result.push({ ...parent, isParent: true });
      
      const children = filtered
        .filter(item => item.parent_title === parent.title)
        .sort((a, b) => a.display_order - b.display_order);
      
      children.forEach(child => {
        result.push({ ...child, isChild: true });
      });
    });

    return result;
  }, [navItems, searchQuery, filterSection, filterParent, sortBy]);

  const parentOptions = useMemo(() => {
    const parents = navItems
      .filter(item => !item.parent_title)
      .map(item => item.title)
      .sort();
    return ['all', 'none', ...parents];
  }, [navItems]);

  const handleCreate = (section = "user") => {
    setEditingItem({
      title: "",
      url: "",
      icon: "Menu",
      feature_id: "",
      section,
      display_order: navItems.filter(i => i.section === section).length,
      is_active: true,
      parent_title: "",
      sub_items: []
    });
    setShowDialog(true);
  };

  const handleEdit = (item) => {
    setEditingItem({ ...item });
    setShowDialog(true);
  };

  const handleSave = () => {
    if (!editingItem.title) {
      toast.error('Title is required');
      return;
    }

    if (editingItem.id) {
      // When editing, only update title and icon
      updateMutation.mutate({ 
        id: editingItem.id, 
        data: { 
          title: editingItem.title, 
          icon: editingItem.icon 
        } 
      });
    } else {
      createMutation.mutate(editingItem);
    }
  };



  const handleDragEnd = async (result) => {
    if (!result.destination) return;
    if (result.source.droppableId === result.destination.droppableId && 
        result.source.index === result.destination.index) return;

    setIsReordering(true);

    try {
      const { source, destination, draggableId } = result;
      
      // Parse section and parent IDs
      const sourceSection = source.droppableId.split('-')[0];
      const sourceParts = source.droppableId.split('-');
      const sourceParentId = sourceParts.length > 1 ? sourceParts[1] : null;
      
      const destParts = destination.droppableId.split('-');
      const destParentId = destParts.length > 1 ? destParts[1] : null;
      
      const allNavItems = navItems.filter(item => item.section === sourceSection);
      const draggedItem = allNavItems.find(item => item.id === draggableId);
      
      if (!draggedItem) return;

      // Determine parent titles
      const sourceParentTitle = sourceParentId 
        ? allNavItems.find(p => p.id === sourceParentId)?.title || null 
        : null;
      const destParentTitle = destParentId 
        ? allNavItems.find(p => p.id === destParentId)?.title || null 
        : null;
      
      const oldParentTitle = draggedItem.parent_title || null;
      const hasChildren = allNavItems.some(item => item.parent_title === draggedItem.title);

      // If moving a parent into another parent, orphan its children
      if (hasChildren && destParentTitle) {
        const children = allNavItems.filter(item => item.parent_title === draggedItem.title);
        for (const child of children) {
          await base44.entities.PortalNavigationItem.update(child.id, { parent_title: "" });
        }
      }

      // Build destination sibling list (excluding dragged item)
      const destSiblings = allNavItems
        .filter(item => 
          item.id !== draggableId &&
          (destParentTitle ? item.parent_title === destParentTitle : !item.parent_title)
        )
        .sort((a, b) => a.display_order - b.display_order);

      // Insert dragged item at destination index
      destSiblings.splice(destination.index, 0, draggedItem);

      // Update all destination siblings with new order and parent
      for (let i = 0; i < destSiblings.length; i++) {
        const item = destSiblings[i];
        const updates = { display_order: i };
        
        // Only update parent_title for the dragged item
        if (item.id === draggableId) {
          updates.parent_title = destParentTitle || "";
        }
        
        await base44.entities.PortalNavigationItem.update(item.id, updates);
      }

      // Clean up source parent if parent changed
      if (oldParentTitle !== destParentTitle) {
        const sourceSiblings = allNavItems
          .filter(item => 
            item.id !== draggableId && 
            (oldParentTitle ? item.parent_title === oldParentTitle : !item.parent_title)
          )
          .sort((a, b) => a.display_order - b.display_order);
        
        for (let i = 0; i < sourceSiblings.length; i++) {
          await base44.entities.PortalNavigationItem.update(sourceSiblings[i].id, { display_order: i });
        }
      }

      await queryClient.invalidateQueries({ queryKey: ['portal-navigation-items'] });
      toast.success('Navigation updated');
    } catch (error) {
      toast.error('Failed to reorder');
      console.error(error);
    } finally {
      setIsReordering(false);
    }
  };



  const renderItemCard = (item, index, provided, section, isChild = false) => {
    const IconComponent = availableIcons[item.icon] || Menu;
    const hasChildren = item.subItems && item.subItems.length > 0;

    return (
      <div ref={provided.innerRef} {...provided.draggableProps}>
        <div
          className={`flex items-center gap-3 p-4 bg-white rounded-lg border border-slate-200 hover:border-blue-400 transition-colors ${isChild ? 'ml-8' : ''}`}
        >
          <div {...provided.dragHandleProps}>
            <GripVertical className="w-5 h-5 text-slate-400 cursor-grab" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <IconComponent className="w-4 h-4 text-slate-600" />
              <span className="font-medium text-slate-900">{item.title}</span>
              {hasChildren && (
                <Badge variant="outline" className="text-xs bg-blue-50">
                  {item.subItems.length} sub-item{item.subItems.length > 1 ? 's' : ''}
                </Badge>
              )}
            </div>
            <div className="text-sm text-slate-500 truncate">{item.url || '(Parent menu)'}</div>
            <div className="text-xs text-slate-400 mt-1">Feature ID: {item.feature_id}</div>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => handleEdit(item)}
          >
            <Pencil className="w-3 h-3" />
          </Button>
        </div>

        {!isChild && (
          <Droppable droppableId={`${section}-${item.id}`}>
            {(provided, snapshot) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
                className={`ml-8 mt-2 space-y-2 min-h-[60px] border-l-2 pl-4 transition-colors ${
                  snapshot.isDraggingOver ? 'border-blue-500 bg-blue-50' : 'border-slate-200'
                } ${hasChildren ? '' : 'opacity-40'}`}
              >
                {hasChildren ? (
                  item.subItems.map((subItem, subIndex) => (
                    <Draggable key={subItem.id} draggableId={subItem.id} index={subIndex}>
                      {(provided) => renderItemCard(subItem, subIndex, provided, section, true)}
                    </Draggable>
                  ))
                ) : (
                  <div className="text-center py-4 text-xs text-slate-400">
                    Drop items here to create sub-menu
                  </div>
                )}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        )}
      </div>
    );
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
              Portal Navigation Management
            </h1>
            <p className="text-slate-600">
              Manage and reorder portal sidebar menu items
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant={viewMode === 'hierarchy' ? 'default' : 'outline'}
              onClick={() => setViewMode('hierarchy')}
              className="gap-2"
            >
              <LayoutGrid className="w-4 h-4" />
              Hierarchy
            </Button>
            <Button
              variant={viewMode === 'table' ? 'default' : 'outline'}
              onClick={() => setViewMode('table')}
              className="gap-2"
            >
              <Table className="w-4 h-4" />
              Table
            </Button>
          </div>
        </div>

        {viewMode === 'hierarchy' ? (
          <Card className="border-blue-200 bg-blue-50 mb-6">
            <CardContent className="p-4">
              <p className="text-sm text-blue-700">
                Drag items to reorder or nest them. Drop items onto parent menus to create sub-items, or drag them to the top level to make them standalone.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="mb-6">
            <CardContent className="p-4">
              <div className="grid md:grid-cols-4 gap-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Select value={filterSection} onValueChange={setFilterSection}>
                  <SelectTrigger>
                    <SelectValue placeholder="Section" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sections</SelectItem>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={filterParent} onValueChange={setFilterParent}>
                  <SelectTrigger>
                    <SelectValue placeholder="Parent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Parents</SelectItem>
                    <SelectItem value="none">Top Level Only</SelectItem>
                    {parentOptions.filter(p => p !== 'all' && p !== 'none').map(parent => (
                      <SelectItem key={parent} value={parent}>{parent}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={sortBy} onValueChange={setSortBy}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sort by" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="display_order">Display Order</SelectItem>
                    <SelectItem value="title">Title</SelectItem>
                    <SelectItem value="section">Section</SelectItem>
                    <SelectItem value="parent">Parent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        )}

        {viewMode === 'table' ? (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="text-left p-3 text-sm font-semibold text-slate-700">Title</th>
                      <th className="text-left p-3 text-sm font-semibold text-slate-700">Icon</th>
                      <th className="text-left p-3 text-sm font-semibold text-slate-700">URL</th>
                      <th className="text-left p-3 text-sm font-semibold text-slate-700">Section</th>
                      <th className="text-left p-3 text-sm font-semibold text-slate-700">Parent</th>
                      <th className="text-left p-3 text-sm font-semibold text-slate-700">Order</th>
                      <th className="text-left p-3 text-sm font-semibold text-slate-700">Feature ID</th>
                      <th className="text-left p-3 text-sm font-semibold text-slate-700">Active</th>
                      <th className="text-right p-3 text-sm font-semibold text-slate-700">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAndSortedItems.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="text-center py-12 text-slate-500">
                          No items found
                        </td>
                      </tr>
                    ) : (
                      filteredAndSortedItems.map(item => {
                        const IconComponent = availableIcons[item.icon] || Menu;
                        return (
                          <tr key={item.id} className={`border-b border-slate-100 hover:bg-slate-50 ${item.isChild ? 'bg-slate-25' : ''}`}>
                            <td className="p-3">
                              <div className={`flex items-center gap-2 ${item.isChild ? 'pl-6' : ''}`}>
                                {item.isChild && (
                                  <span className="text-slate-400">└─</span>
                                )}
                                <span className={`${item.isParent ? 'font-semibold' : 'font-medium'} text-slate-900`}>
                                  {item.title}
                                </span>
                              </div>
                            </td>
                            <td className="p-3">
                              <div className="flex items-center gap-2">
                                <IconComponent className="w-4 h-4 text-slate-600" />
                                <span className="text-xs text-slate-500">{item.icon}</span>
                              </div>
                            </td>
                            <td className="p-3">
                              <span className="text-sm text-slate-600 truncate max-w-xs block">{item.url || '-'}</span>
                            </td>
                            <td className="p-3">
                              <Badge variant={item.section === 'admin' ? 'default' : 'outline'} className="text-xs">
                                {item.section}
                              </Badge>
                            </td>
                            <td className="p-3">
                              <span className="text-sm text-slate-600">{item.parent_title || '-'}</span>
                            </td>
                            <td className="p-3">
                              <span className="text-sm text-slate-600">{item.display_order}</span>
                            </td>
                            <td className="p-3">
                              <span className="text-xs text-slate-500 font-mono">{item.feature_id}</span>
                            </td>
                            <td className="p-3">
                              {item.is_active ? (
                                <Badge className="bg-green-100 text-green-700 text-xs">Active</Badge>
                              ) : (
                                <Badge className="bg-slate-100 text-slate-700 text-xs">Inactive</Badge>
                              )}
                            </td>
                            <td className="p-3">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleEdit(item)}
                                >
                                  <Pencil className="w-3 h-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    if (confirm(`Delete "${item.title}"?`)) {
                                      deleteMutation.mutate(item.id);
                                    }
                                  }}
                                  className="text-red-600 hover:text-red-700"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
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
          <div className="grid md:grid-cols-2 gap-6">
            {/* User Navigation */}
            <Card>
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5 text-blue-600" />
                  User Navigation
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <Droppable droppableId="user">
                  {(provided) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className="space-y-3 min-h-[400px]"
                    >
                      {userItems.length === 0 ? (
                        <div className="text-center py-12 text-slate-500">
                          No user navigation items
                        </div>
                      ) : (
                        userItems.map((item, index) => (
                          <Draggable key={item.id} draggableId={item.id} index={index}>
                            {(provided) => renderItemCard(item, index, provided, "user")}
                          </Draggable>
                        ))
                      )}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </CardContent>
            </Card>

            {/* Admin Navigation */}
            <Card>
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  <Shield className="w-5 h-5 text-amber-600" />
                  Admin Navigation
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <Droppable droppableId="admin">
                  {(provided) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className="space-y-3 min-h-[400px]"
                    >
                      {adminItems.length === 0 ? (
                        <div className="text-center py-12 text-slate-500">
                          No admin navigation items
                        </div>
                      ) : (
                        adminItems.map((item, index) => (
                          <Draggable key={item.id} draggableId={item.id} index={index}>
                            {(provided) => renderItemCard(item, index, provided, "admin")}
                          </Draggable>
                        ))
                      )}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </CardContent>
            </Card>
          </div>
        </DragDropContext>
        )}

        {/* Edit/Create Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingItem?.id ? 'Edit Navigation Item' : 'Create Navigation Item'}
              </DialogTitle>
            </DialogHeader>

            {editingItem && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Title *</Label>
                  <Input
                    value={editingItem.title}
                    onChange={(e) => setEditingItem({ ...editingItem, title: e.target.value })}
                    placeholder="e.g., Browse Events"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Icon *</Label>
                  <Select
                    value={editingItem.icon}
                    onValueChange={(value) => setEditingItem({ ...editingItem, icon: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.keys(availableIcons).map(iconName => (
                        <SelectItem key={iconName} value={iconName}>{iconName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createMutation.isPending || updateMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingItem?.id ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}