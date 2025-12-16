import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { 
  Plus, Pencil, Trash2, ChevronDown, ChevronRight, GripVertical,
  FolderTree, Save, RotateCcw, AlertTriangle,
  Layers, Sparkles
} from 'lucide-react';
import { ROLE_ACCESS_MAP } from '@/lib/roleAccessMap';

const ICON_OPTIONS = [
  'Calendar', 'CreditCard', 'Users', 'FileText', 'Briefcase', 'Layout',
  'ClipboardList', 'HelpCircle', 'Mail', 'Shield', 'Settings', 'BarChart3',
  'Award', 'Building', 'Globe', 'Lock', 'Key', 'Database', 'Folder'
];

export default function RoleAccessConfigManagement() {
  const [showDialog, setShowDialog] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [expandedModules, setExpandedModules] = useState({});
  const [expandedPages, setExpandedPages] = useState({});
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const queryClient = useQueryClient();

  const { data: accessItems = [], isLoading, error } = useQuery({
    queryKey: ['role-access-items'],
    queryFn: () => base44.entities.RoleAccessItem.list(),
  });

  const createMutation = useMutation({
    mutationFn: async (data) => {
      return base44.entities.RoleAccessItem.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role-access-items'] });
      setShowDialog(false);
      setEditingItem(null);
      toast.success('Item created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create item: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      return base44.entities.RoleAccessItem.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role-access-items'] });
      setShowDialog(false);
      setEditingItem(null);
      toast.success('Item updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update item: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      return base44.entities.RoleAccessItem.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role-access-items'] });
      toast.success('Item deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete item: ' + error.message);
    }
  });

  const seedMutation = useMutation({
    mutationFn: async (items) => {
      for (const item of items) {
        await base44.entities.RoleAccessItem.create(item);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role-access-items'] });
      toast.success('Configuration seeded from defaults');
    },
    onError: (error) => {
      toast.error('Failed to seed configuration: ' + error.message);
    }
  });

  const hierarchy = useMemo(() => {
    const modules = accessItems.filter(item => item.item_type === 'module')
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    
    return modules.map(mod => {
      const pages = accessItems.filter(item => item.item_type === 'page' && item.parent_id === mod.id)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
      
      return {
        ...mod,
        pages: pages.map(page => {
          const features = accessItems.filter(item => item.item_type === 'feature' && item.parent_id === page.id)
            .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
          return { ...page, features };
        })
      };
    });
  }, [accessItems]);

  const moduleOptions = useMemo(() => {
    return accessItems.filter(item => item.item_type === 'module');
  }, [accessItems]);

  const pageOptions = useMemo(() => {
    return accessItems.filter(item => item.item_type === 'page');
  }, [accessItems]);

  const handleAdd = (type, parentId = null) => {
    const siblings = accessItems.filter(item => 
      item.item_type === type && 
      (type === 'module' ? !item.parent_id : item.parent_id === parentId)
    );
    const maxOrder = siblings.length > 0 
      ? Math.max(...siblings.map(s => s.display_order || 0))
      : -1;

    setEditingItem({
      item_type: type,
      item_key: '',
      label: '',
      icon: type === 'module' ? 'Settings' : null,
      parent_id: parentId || null,
      display_order: maxOrder + 1,
      is_active: true
    });
    setShowDialog(true);
  };

  const handleEdit = (item) => {
    setEditingItem({ ...item });
    setShowDialog(true);
  };

  const handleDelete = (item) => {
    const hasChildren = accessItems.some(child => child.parent_id === item.id);
    if (hasChildren) {
      toast.error('Cannot delete item with children. Delete children first.');
      return;
    }
    if (confirm(`Delete "${item.label}"? This cannot be undone.`)) {
      deleteMutation.mutate(item.id);
    }
  };

  const handleSave = () => {
    if (!editingItem.item_key || !editingItem.label) {
      toast.error('Item Key and Label are required');
      return;
    }

    if (editingItem.item_type === 'page' && !editingItem.parent_id) {
      toast.error('Please select a parent module');
      return;
    }

    if (editingItem.item_type === 'feature' && !editingItem.parent_id) {
      toast.error('Please select a parent page');
      return;
    }

    const data = {
      item_type: editingItem.item_type,
      item_key: editingItem.item_key,
      label: editingItem.label,
      icon: editingItem.icon || null,
      parent_id: editingItem.parent_id || null,
      display_order: editingItem.display_order || 0,
      is_active: editingItem.is_active !== false
    };

    if (editingItem.id) {
      updateMutation.mutate({ id: editingItem.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleDragEnd = async (result) => {
    if (!result.destination) return;

    const { source, destination, type } = result;
    
    if (source.droppableId === destination.droppableId && source.index === destination.index) {
      return;
    }

    let items = [];
    
    if (type === 'module') {
      items = hierarchy.map(m => ({ ...m }));
    } else if (type === 'page') {
      const moduleId = source.droppableId.replace('pages-', '');
      const module = hierarchy.find(m => m.id === moduleId);
      if (!module) return;
      items = module.pages.map(p => ({ ...p }));
    } else if (type === 'feature') {
      const pageId = source.droppableId.replace('features-', '');
      for (const mod of hierarchy) {
        const page = mod.pages.find(p => p.id === pageId);
        if (page) {
          items = page.features.map(f => ({ ...f }));
          break;
        }
      }
    }

    const [removed] = items.splice(source.index, 1);
    items.splice(destination.index, 0, removed);

    const updates = items.map((item, index) => ({
      id: item.id,
      display_order: index
    }));

    try {
      for (const update of updates) {
        await base44.entities.RoleAccessItem.update(update.id, { display_order: update.display_order });
      }
      queryClient.invalidateQueries({ queryKey: ['role-access-items'] });
      toast.success('Order updated');
    } catch (err) {
      toast.error('Failed to update order: ' + err.message);
    }
  };

  const handleSeedFromDefaults = async () => {
    if (accessItems.length > 0) {
      setShowResetConfirm(true);
      return;
    }
    await seedFromDefaults();
  };

  const seedFromDefaults = async () => {
    const items = [];
    let moduleOrder = 0;

    for (const mod of ROLE_ACCESS_MAP) {
      const moduleItem = {
        item_type: 'module',
        item_key: mod.id,
        label: mod.label,
        icon: mod.icon || 'Settings',
        parent_id: null,
        display_order: moduleOrder++,
        is_active: true
      };
      items.push(moduleItem);
    }

    await seedMutation.mutateAsync(items);

    const createdModules = await base44.entities.RoleAccessItem.list();

    const pageItems = [];
    for (const mod of ROLE_ACCESS_MAP) {
      const createdModule = createdModules.find(m => m.item_key === mod.id);
      if (!createdModule) continue;

      let pageOrder = 0;
      for (const page of mod.pages) {
        pageItems.push({
          item_type: 'page',
          item_key: page.id,
          label: page.label,
          icon: null,
          parent_id: createdModule.id,
          display_order: pageOrder++,
          is_active: true
        });
      }
    }

    if (pageItems.length > 0) {
      await seedMutation.mutateAsync(pageItems);
    }

    const createdPages = await base44.entities.RoleAccessItem.list();

    const featureItems = [];
    for (const mod of ROLE_ACCESS_MAP) {
      for (const page of mod.pages) {
        const createdPage = createdPages.find(p => p.item_key === page.id);
        if (!createdPage || !page.features) continue;

        let featureOrder = 0;
        for (const feature of page.features) {
          featureItems.push({
            item_type: 'feature',
            item_key: feature.id,
            label: feature.label,
            icon: null,
            parent_id: createdPage.id,
            display_order: featureOrder++,
            is_active: true
          });
        }
      }
    }

    if (featureItems.length > 0) {
      await seedMutation.mutateAsync(featureItems);
    }

    queryClient.invalidateQueries({ queryKey: ['role-access-items'] });
    setShowResetConfirm(false);
    toast.success('Configuration seeded from defaults');
  };

  const handleResetToDefaults = async () => {
    const features = accessItems.filter(i => i.item_type === 'feature');
    const pages = accessItems.filter(i => i.item_type === 'page');
    const modules = accessItems.filter(i => i.item_type === 'module');
    
    for (const item of [...features, ...pages, ...modules]) {
      await base44.entities.RoleAccessItem.delete(item.id);
    }
    await seedFromDefaults();
    setShowResetConfirm(false);
  };

  const toggleModule = (moduleId) => {
    setExpandedModules(prev => ({ ...prev, [moduleId]: !prev[moduleId] }));
  };

  const togglePage = (pageId) => {
    setExpandedPages(prev => ({ ...prev, [pageId]: !prev[pageId] }));
  };

  const getSelectedModuleLabel = (parentId) => {
    const mod = moduleOptions.find(m => m.id === parentId);
    return mod?.label || '';
  };

  const getSelectedPageLabel = (parentId) => {
    const page = pageOptions.find(p => p.id === parentId);
    return page?.label || '';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (error) {
    const errorMessage = error?.message || String(error);
    const isTableNotFound = errorMessage.toLowerCase().includes('does not exist') || 
                            errorMessage.toLowerCase().includes('relation') ||
                            errorMessage.toLowerCase().includes('42p01');
    
    return (
      <Card className="m-6">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 mb-4">
            <AlertTriangle className="h-5 w-5" />
            <span className="font-medium">{isTableNotFound ? 'Table not found' : 'Database Error'}</span>
          </div>
          <p className="text-sm text-red-600 dark:text-red-400 mb-4 font-mono bg-red-50 dark:bg-red-950 p-2 rounded">
            {errorMessage}
          </p>
          <p className="text-sm text-muted-foreground mb-4">
            {isTableNotFound 
              ? "The role_access_item table doesn't exist yet. Please create it in your Supabase database using the SQL below:"
              : "If this is a permissions error, you may need to update your RLS policies. The table creation SQL is below:"}
          </p>
          <pre className="bg-muted p-4 rounded-md text-xs overflow-x-auto mb-4">
{`CREATE TABLE role_access_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type TEXT NOT NULL CHECK (item_type IN ('module', 'page', 'feature')),
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  icon TEXT,
  parent_id UUID REFERENCES role_access_item(id) ON DELETE CASCADE,
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(item_key)
);

CREATE INDEX idx_role_access_item_type ON role_access_item(item_type);
CREATE INDEX idx_role_access_item_parent ON role_access_item(parent_id);

ALTER TABLE role_access_item ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access" ON role_access_item FOR SELECT USING (true);
CREATE POLICY "Allow full access" ON role_access_item FOR ALL USING (true);`}
          </pre>
          <p className="text-sm text-muted-foreground">
            After creating the table, refresh this page.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="p-6 space-y-6" data-testid="page-role-access-config">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FolderTree className="h-6 w-6" />
            Role Access Configuration
          </h1>
          <p className="text-muted-foreground mt-1">
            Configure how modules, pages, and features are grouped in Role Management
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={handleSeedFromDefaults}
            disabled={seedMutation.isPending}
            data-testid="button-seed-defaults"
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            {accessItems.length > 0 ? 'Reset to Defaults' : 'Seed from Defaults'}
          </Button>
          <Button onClick={() => handleAdd('module')} data-testid="button-add-module">
            <Plus className="h-4 w-4 mr-2" />
            Add Module
          </Button>
          <Button variant="secondary" onClick={() => handleAdd('page')} data-testid="button-add-page" disabled={moduleOptions.length === 0}>
            <Plus className="h-4 w-4 mr-2" />
            Add Page
          </Button>
          <Button variant="secondary" onClick={() => handleAdd('feature')} data-testid="button-add-feature" disabled={pageOptions.length === 0}>
            <Plus className="h-4 w-4 mr-2" />
            Add Feature
          </Button>
        </div>
      </div>

      {hierarchy.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center py-8">
              <Layers className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="font-medium mb-2">No Configuration Found</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Start by seeding from the default configuration or add modules manually.
              </p>
              <Button onClick={handleSeedFromDefaults} data-testid="button-seed-empty">
                <Sparkles className="h-4 w-4 mr-2" />
                Seed from Defaults
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="modules" type="module">
            {(provided) => (
              <div 
                className="space-y-3"
                ref={provided.innerRef}
                {...provided.droppableProps}
              >
                {hierarchy.map((module, moduleIndex) => (
                  <Draggable key={module.id} draggableId={module.id} index={moduleIndex}>
                    {(provided, snapshot) => (
                      <Card 
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        className={`overflow-hidden ${snapshot.isDragging ? 'shadow-lg ring-2 ring-primary' : ''}`}
                      >
                        <div 
                          className="flex items-center gap-2 p-4 cursor-pointer hover-elevate"
                          onClick={() => toggleModule(module.id)}
                          data-testid={`module-${module.item_key}`}
                        >
                          <div {...provided.dragHandleProps} onClick={e => e.stopPropagation()}>
                            <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab active:cursor-grabbing" />
                          </div>
                          {expandedModules[module.id] ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          <Badge variant="default" className="bg-primary/20 text-primary border-0">
                            Module
                          </Badge>
                          <span className="font-medium flex-1">{module.label}</span>
                          <span className="text-xs text-muted-foreground font-mono">{module.item_key}</span>
                          <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                            <Button size="icon" variant="ghost" onClick={() => handleEdit(module)} data-testid={`button-edit-${module.item_key}`}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => handleDelete(module)} data-testid={`button-delete-${module.item_key}`}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>

                        {expandedModules[module.id] && (
                          <div className="border-t bg-muted/30 p-4 pl-10">
                            <Button 
                              size="sm" 
                              variant="outline" 
                              onClick={() => handleAdd('page', module.id)}
                              className="mb-3"
                              data-testid={`button-add-page-${module.item_key}`}
                            >
                              <Plus className="h-3 w-3 mr-1" />
                              Add Page to {module.label}
                            </Button>

                            <Droppable droppableId={`pages-${module.id}`} type="page">
                              {(provided) => (
                                <div 
                                  className="space-y-2"
                                  ref={provided.innerRef}
                                  {...provided.droppableProps}
                                >
                                  {module.pages.map((page, pageIndex) => (
                                    <Draggable key={page.id} draggableId={page.id} index={pageIndex}>
                                      {(provided, snapshot) => (
                                        <div 
                                          ref={provided.innerRef}
                                          {...provided.draggableProps}
                                          className={`bg-background rounded-md border ${snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-500' : ''}`}
                                        >
                                          <div 
                                            className="flex items-center gap-2 p-3 cursor-pointer hover-elevate"
                                            onClick={() => togglePage(page.id)}
                                            data-testid={`page-${page.item_key}`}
                                          >
                                            <div {...provided.dragHandleProps} onClick={e => e.stopPropagation()}>
                                              <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab active:cursor-grabbing" />
                                            </div>
                                            {page.features?.length > 0 ? (
                                              expandedPages[page.id] ? (
                                                <ChevronDown className="h-4 w-4" />
                                              ) : (
                                                <ChevronRight className="h-4 w-4" />
                                              )
                                            ) : (
                                              <div className="w-4" />
                                            )}
                                            <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 border-0">
                                              Page
                                            </Badge>
                                            <span className="font-medium flex-1">{page.label}</span>
                                            <span className="text-xs text-muted-foreground font-mono">{page.item_key}</span>
                                            <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                                              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleEdit(page)}>
                                                <Pencil className="h-3 w-3" />
                                              </Button>
                                              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleDelete(page)}>
                                                <Trash2 className="h-3 w-3" />
                                              </Button>
                                            </div>
                                          </div>

                                          {expandedPages[page.id] && (
                                            <div className="border-t bg-muted/20 p-3 pl-12">
                                              <Button 
                                                size="sm" 
                                                variant="outline" 
                                                onClick={() => handleAdd('feature', page.id)}
                                                className="mb-2 h-7 text-xs"
                                                data-testid={`button-add-feature-${page.item_key}`}
                                              >
                                                <Plus className="h-3 w-3 mr-1" />
                                                Add Feature to {page.label}
                                              </Button>

                                              <Droppable droppableId={`features-${page.id}`} type="feature">
                                                {(provided) => (
                                                  <div 
                                                    className="space-y-1"
                                                    ref={provided.innerRef}
                                                    {...provided.droppableProps}
                                                  >
                                                    {page.features?.map((feature, featureIndex) => (
                                                      <Draggable key={feature.id} draggableId={feature.id} index={featureIndex}>
                                                        {(provided, snapshot) => (
                                                          <div 
                                                            ref={provided.innerRef}
                                                            {...provided.draggableProps}
                                                            className={`flex items-center gap-2 p-2 bg-background rounded border ${snapshot.isDragging ? 'shadow-lg ring-2 ring-green-500' : ''}`}
                                                            data-testid={`feature-${feature.item_key}`}
                                                          >
                                                            <div {...provided.dragHandleProps}>
                                                              <GripVertical className="h-3 w-3 text-muted-foreground cursor-grab active:cursor-grabbing" />
                                                            </div>
                                                            <Badge variant="outline" className="text-xs bg-green-50 text-green-700 dark:bg-green-900 dark:text-green-300 border-0">
                                                              Feature
                                                            </Badge>
                                                            <span className="text-sm flex-1">{feature.label}</span>
                                                            <span className="text-xs text-muted-foreground font-mono">{feature.item_key}</span>
                                                            <div className="flex gap-1">
                                                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => handleEdit(feature)}>
                                                                <Pencil className="h-3 w-3" />
                                                              </Button>
                                                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => handleDelete(feature)}>
                                                                <Trash2 className="h-3 w-3" />
                                                              </Button>
                                                            </div>
                                                          </div>
                                                        )}
                                                      </Draggable>
                                                    ))}
                                                    {provided.placeholder}
                                                  </div>
                                                )}
                                              </Droppable>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </Draggable>
                                  ))}
                                  {provided.placeholder}
                                </div>
                              )}
                            </Droppable>
                          </div>
                        )}
                      </Card>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      )}

      <Dialog open={showDialog} onOpenChange={(open) => { setShowDialog(open); if (!open) setEditingItem(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingItem?.id ? 'Edit' : 'Create'} {editingItem?.item_type === 'module' ? 'Module' : editingItem?.item_type === 'page' ? 'Page' : 'Feature'}
            </DialogTitle>
            <DialogDescription>
              {editingItem?.item_type === 'module' 
                ? 'Modules are top-level groupings that contain pages.'
                : editingItem?.item_type === 'page'
                ? 'Pages belong to modules and can contain features.'
                : 'Features are specific capabilities within a page.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {editingItem?.item_type === 'page' && (
              <div className="space-y-2">
                <Label htmlFor="parent" className="flex items-center gap-1">
                  Parent Module <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={editingItem?.parent_id || ''}
                  onValueChange={(value) => setEditingItem({ ...editingItem, parent_id: value })}
                >
                  <SelectTrigger data-testid="select-parent-module" className={!editingItem?.parent_id ? 'border-amber-500' : ''}>
                    <SelectValue placeholder="Select a module...">
                      {editingItem?.parent_id ? getSelectedModuleLabel(editingItem.parent_id) : 'Select a module...'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {moduleOptions.map(mod => (
                      <SelectItem key={mod.id} value={mod.id}>{mod.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!editingItem?.parent_id && (
                  <p className="text-xs text-amber-600">Please select a parent module</p>
                )}
              </div>
            )}

            {editingItem?.item_type === 'feature' && (
              <div className="space-y-2">
                <Label htmlFor="parent" className="flex items-center gap-1">
                  Parent Page <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={editingItem?.parent_id || ''}
                  onValueChange={(value) => setEditingItem({ ...editingItem, parent_id: value })}
                >
                  <SelectTrigger data-testid="select-parent-page" className={!editingItem?.parent_id ? 'border-amber-500' : ''}>
                    <SelectValue placeholder="Select a page...">
                      {editingItem?.parent_id ? getSelectedPageLabel(editingItem.parent_id) : 'Select a page...'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {pageOptions.map(page => (
                      <SelectItem key={page.id} value={page.id}>{page.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!editingItem?.parent_id && (
                  <p className="text-xs text-amber-600">Please select a parent page</p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="item_key">Item Key (ID)</Label>
              <Input
                id="item_key"
                value={editingItem?.item_key || ''}
                onChange={(e) => setEditingItem({ ...editingItem, item_key: e.target.value })}
                placeholder={
                  editingItem?.item_type === 'module' ? 'events' :
                  editingItem?.item_type === 'page' ? 'events.browse-events' :
                  'events.browse-events.search-filters'
                }
                data-testid="input-item-key"
              />
              <p className="text-xs text-muted-foreground">
                Use dot notation for hierarchy: module.page.feature
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="label">Label</Label>
              <Input
                id="label"
                value={editingItem?.label || ''}
                onChange={(e) => setEditingItem({ ...editingItem, label: e.target.value })}
                placeholder="Display name"
                data-testid="input-label"
              />
            </div>

            {editingItem?.item_type === 'module' && (
              <div className="space-y-2">
                <Label htmlFor="icon">Icon</Label>
                <Select
                  value={editingItem?.icon || 'Settings'}
                  onValueChange={(value) => setEditingItem({ ...editingItem, icon: value })}
                >
                  <SelectTrigger data-testid="select-icon">
                    <SelectValue placeholder="Select icon" />
                  </SelectTrigger>
                  <SelectContent>
                    {ICON_OPTIONS.map(icon => (
                      <SelectItem key={icon} value={icon}>{icon}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} data-testid="button-cancel">
              Cancel
            </Button>
            <Button 
              onClick={handleSave} 
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="button-save"
            >
              <Save className="h-4 w-4 mr-2" />
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              Reset to Defaults?
            </DialogTitle>
            <DialogDescription>
              This will delete all existing configuration and replace it with the default structure from the codebase. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResetConfirm(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleResetToDefaults}
              disabled={seedMutation.isPending || deleteMutation.isPending}
            >
              Reset to Defaults
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
