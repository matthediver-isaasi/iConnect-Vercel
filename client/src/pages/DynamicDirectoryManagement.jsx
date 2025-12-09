import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { FolderTree, Loader2, Plus, Pencil, Trash2, User, Building2, Filter } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const ENTITY_TYPES = [
  { value: 'member', label: 'Member', icon: User },
  { value: 'organization', label: 'Organisation', icon: Building2 }
];

function generateSlug(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export default function DynamicDirectoryManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const queryClient = useQueryClient();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingDirectory, setEditingDirectory] = useState(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [entityType, setEntityType] = useState('member');
  const [filterFieldId, setFilterFieldId] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [isActive, setIsActive] = useState(true);
  // null = use all filterable fields (backward compat), [] = explicitly none, [...ids] = specific selection
  const [selectedFilterFields, setSelectedFilterFields] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin || isFeatureExcluded('page_DynamicDirectoryManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady]);

  const { data: directories = [], isLoading: isLoadingDirectories } = useQuery({
    queryKey: ['/api/entities/DynamicDirectory'],
    queryFn: async () => {
      try {
        const dirs = await base44.entities.DynamicDirectory.list({
          sort: { name: 'asc' }
        });
        return dirs || [];
      } catch (error) {
        console.error('Failed to fetch dynamic directories:', error);
        return [];
      }
    },
    enabled: accessChecked
  });

  const { data: preferenceFields = [], isLoading: isLoadingFields } = useQuery({
    queryKey: ['/api/entities/PreferenceField', entityType],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { entity_scope: entityType, is_active: true },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => f.field_type === 'picklist' || f.field_type === 'dropdown');
      } catch (error) {
        console.error('Failed to fetch preference fields:', error);
        return [];
      }
    },
    enabled: isDialogOpen
  });

  const { data: allFilterableFields = [] } = useQuery({
    queryKey: ['/api/entities/PreferenceField/filterable', entityType],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { entity_scope: entityType, is_active: true, is_filterable: true },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => 
          (f.field_type === 'picklist' || f.field_type === 'dropdown') && f.is_filterable
        );
      } catch (error) {
        console.error('Failed to fetch filterable fields:', error);
        return [];
      }
    },
    enabled: isDialogOpen
  });

  const availableFilterFields = allFilterableFields.filter(f => f.id !== filterFieldId);

  const selectedField = preferenceFields.find(f => f.id === filterFieldId);

  const createMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.DynamicDirectory.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/entities/DynamicDirectory'] });
      toast.success('Dynamic directory created successfully');
      resetForm();
    },
    onError: (error) => {
      toast.error('Failed to create directory: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      return await base44.entities.DynamicDirectory.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/entities/DynamicDirectory'] });
      toast.success('Dynamic directory updated successfully');
      resetForm();
    },
    onError: (error) => {
      toast.error('Failed to update directory: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.DynamicDirectory.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/entities/DynamicDirectory'] });
      toast.success('Dynamic directory deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete directory: ' + error.message);
    }
  });

  const resetForm = () => {
    setIsDialogOpen(false);
    setEditingDirectory(null);
    setName('');
    setSlug('');
    setEntityType('member');
    setFilterFieldId('');
    setFilterValue('');
    setIsActive(true);
    setSelectedFilterFields(null);
  };

  const handleOpenCreateDialog = () => {
    resetForm();
    setIsDialogOpen(true);
  };

  const handleOpenEditDialog = (directory) => {
    setEditingDirectory(directory);
    setName(directory.name || '');
    setSlug(directory.slug || '');
    setEntityType(directory.entity_type || 'member');
    setFilterFieldId(directory.filter_field_id || '');
    setFilterValue(directory.filter_value || '');
    setIsActive(directory.is_active !== false);
    // Preserve null/undefined to distinguish between "not configured" and "explicitly empty"
    setSelectedFilterFields(directory.selected_filter_fields ?? null);
    setIsDialogOpen(true);
  };

  const handleNameChange = (value) => {
    setName(value);
    if (!editingDirectory) {
      setSlug(generateSlug(value));
    }
  };

  const handleEntityTypeChange = (value) => {
    setEntityType(value);
    setFilterFieldId('');
    setFilterValue('');
    setSelectedFilterFields(null);
  };

  const handleToggleFilterField = (fieldId) => {
    setSelectedFilterFields(prev => {
      // If null (not configured), initialize with just this field
      if (prev === null) {
        return [fieldId];
      }
      if (prev.includes(fieldId)) {
        return prev.filter(id => id !== fieldId);
      } else {
        return [...prev, fieldId];
      }
    });
  };

  const handleFilterFieldChange = (value) => {
    setFilterFieldId(value);
    setFilterValue('');
  };

  const handleSubmit = () => {
    if (!name.trim()) {
      toast.error('Please provide a name');
      return;
    }

    if (!slug.trim()) {
      toast.error('Please provide a slug');
      return;
    }

    if (!filterFieldId) {
      toast.error('Please select a filter field');
      return;
    }

    if (!filterValue) {
      toast.error('Please select a filter value');
      return;
    }

    const data = {
      name: name.trim(),
      slug: slug.trim().toLowerCase().replace(/\s+/g, '-'),
      entity_type: entityType,
      filter_field_id: filterFieldId,
      filter_value: filterValue,
      is_active: isActive
    };
    
    // Only include selected_filter_fields if it's been explicitly configured (not null)
    if (selectedFilterFields !== null) {
      data.selected_filter_fields = selectedFilterFields;
    }

    if (editingDirectory) {
      updateMutation.mutate({ id: editingDirectory.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleDelete = (directory) => {
    if (confirm(`Are you sure you want to delete the directory "${directory.name}"?`)) {
      deleteMutation.mutate(directory.id);
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" data-testid="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2 flex items-center gap-3" data-testid="page-title">
              <FolderTree className="w-8 h-8 text-blue-600" />
              Dynamic Directories
            </h1>
            <p className="text-slate-600" data-testid="page-description">
              Create filtered directory views based on member or organisation custom fields
            </p>
          </div>
          <Button 
            onClick={handleOpenCreateDialog}
            className="gap-2 bg-blue-600 hover:bg-blue-700"
            data-testid="button-create-directory"
          >
            <Plus className="w-4 h-4" />
            Create Directory
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Directories</CardTitle>
            <CardDescription>Manage your dynamic directory configurations</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDirectories ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-blue-600" data-testid="loading-directories" />
              </div>
            ) : directories.length === 0 ? (
              <div className="text-center py-8 text-slate-500 border border-dashed border-slate-200 rounded-lg" data-testid="empty-state">
                <FolderTree className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                <p>No dynamic directories defined yet.</p>
                <p className="text-sm mt-1">Click "Create Directory" to create your first dynamic directory.</p>
              </div>
            ) : (
              <Table data-testid="directories-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Slug</TableHead>
                    <TableHead>Entity Type</TableHead>
                    <TableHead>Filter Field</TableHead>
                    <TableHead>Filter Value</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {directories.map((directory) => {
                    const EntityIcon = directory.entity_type === 'organization' ? Building2 : User;
                    return (
                      <TableRow key={directory.id} data-testid={`directory-row-${directory.id}`}>
                        <TableCell className="font-medium" data-testid={`directory-name-${directory.id}`}>
                          {directory.name}
                        </TableCell>
                        <TableCell data-testid={`directory-slug-${directory.id}`}>
                          <code className="text-sm bg-slate-100 px-2 py-0.5 rounded">
                            /{directory.slug}
                          </code>
                        </TableCell>
                        <TableCell data-testid={`directory-entity-type-${directory.id}`}>
                          <div className="flex items-center gap-2">
                            <EntityIcon className="w-4 h-4 text-slate-500" />
                            <span className="capitalize">{directory.entity_type}</span>
                          </div>
                        </TableCell>
                        <TableCell data-testid={`directory-filter-field-${directory.id}`}>
                          {directory.filter_field_name || directory.filter_field_id || '-'}
                        </TableCell>
                        <TableCell data-testid={`directory-filter-value-${directory.id}`}>
                          {directory.filter_value || '-'}
                        </TableCell>
                        <TableCell data-testid={`directory-status-${directory.id}`}>
                          {directory.is_active !== false ? (
                            <Badge variant="default" className="bg-green-100 text-green-800 hover:bg-green-100">
                              Active
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="bg-slate-100 text-slate-600">
                              Inactive
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleOpenEditDialog(directory)}
                              data-testid={`button-edit-directory-${directory.id}`}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDelete(directory)}
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              data-testid={`button-delete-directory-${directory.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6 border-blue-200 bg-blue-50">
          <CardContent className="p-4">
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-2">How Dynamic Directories Work:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Dynamic directories create filtered views of members or organisations based on custom field values</li>
                <li>Each directory has a unique URL slug (e.g., /directory/my-directory-slug)</li>
                <li>Only picklist and dropdown custom fields can be used as filters</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[500px] max-h-[85vh] overflow-hidden !grid grid-rows-[auto_1fr_auto]">
          <DialogHeader>
            <DialogTitle data-testid="dialog-title">
              {editingDirectory ? 'Edit Dynamic Directory' : 'Create Dynamic Directory'}
            </DialogTitle>
            <DialogDescription>
              {editingDirectory 
                ? 'Update the settings for this dynamic directory.'
                : 'Create a new filtered directory view.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4 overflow-y-auto min-h-0">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g., Healthcare Members"
                data-testid="input-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">URL Slug *</Label>
              <Input
                id="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="e.g., healthcare-members"
                data-testid="input-slug"
              />
              <p className="text-xs text-slate-500">The URL path for this directory (lowercase, hyphens)</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="entityType">Entity Type *</Label>
              <Select value={entityType} onValueChange={handleEntityTypeChange}>
                <SelectTrigger data-testid="select-entity-type">
                  <SelectValue placeholder="Select entity type" />
                </SelectTrigger>
                <SelectContent>
                  {ENTITY_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      <div className="flex items-center gap-2">
                        <type.icon className="w-4 h-4" />
                        {type.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="filterField">Filter Field *</Label>
              <Select 
                value={filterFieldId} 
                onValueChange={handleFilterFieldChange}
                disabled={isLoadingFields}
              >
                <SelectTrigger data-testid="select-filter-field">
                  <SelectValue placeholder={isLoadingFields ? "Loading fields..." : "Select filter field"} />
                </SelectTrigger>
                <SelectContent>
                  {preferenceFields.length === 0 ? (
                    <SelectItem value="_none" disabled>
                      No picklist/dropdown fields available
                    </SelectItem>
                  ) : (
                    preferenceFields.map((field) => (
                      <SelectItem key={field.id} value={field.id}>
                        {field.label}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">Only picklist and dropdown fields are available</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="filterValue">Filter Value *</Label>
              <Select 
                value={filterValue} 
                onValueChange={setFilterValue}
                disabled={!selectedField}
              >
                <SelectTrigger data-testid="select-filter-value">
                  <SelectValue placeholder={!selectedField ? "Select a field first" : "Select filter value"} />
                </SelectTrigger>
                <SelectContent>
                  {selectedField?.options?.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3 p-3 bg-slate-50 rounded-lg border">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-blue-600" />
                <Label className="font-medium">Search Filter Fields (Optional)</Label>
              </div>
              {availableFilterFields.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No additional filterable fields available. To add filter options, create custom fields 
                  (picklist or dropdown type) with "Is Filterable" enabled in Preference Fields settings.
                  The primary filter field selected above is excluded from this list.
                </p>
              ) : (
                <>
                  <p className="text-xs text-slate-500">
                    {selectedFilterFields === null 
                      ? "Not configured - all filterable fields will be shown by default. Select fields below to limit which filters appear."
                      : selectedFilterFields.length === 0
                        ? "No filters selected - no additional filter dropdowns will be shown on this directory."
                        : "Only the selected fields will appear as filter dropdowns on this directory."}
                  </p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {availableFilterFields.map((field) => (
                      <div key={field.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`filter-field-${field.id}`}
                          checked={selectedFilterFields !== null && selectedFilterFields.includes(field.id)}
                          onCheckedChange={() => handleToggleFilterField(field.id)}
                          data-testid={`checkbox-filter-field-${field.id}`}
                        />
                        <label
                          htmlFor={`filter-field-${field.id}`}
                          className="text-sm text-slate-700 cursor-pointer flex-1"
                        >
                          {field.label}
                        </label>
                        <Badge variant="secondary" className="text-xs">
                          {field.field_type}
                        </Badge>
                      </div>
                    ))}
                  </div>
                  {selectedFilterFields !== null && (
                    <p className="text-xs text-blue-600 mt-2">
                      {selectedFilterFields.length} filter{selectedFilterFields.length !== 1 ? 's' : ''} selected
                      {selectedFilterFields.length === 0 && " (no filter dropdowns will show)"}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border">
              <div>
                <Label htmlFor="isActive" className="cursor-pointer">Active</Label>
                <p className="text-xs text-slate-500 mt-0.5">
                  Whether this directory is publicly accessible
                </p>
              </div>
              <Switch
                id="isActive"
                checked={isActive}
                onCheckedChange={setIsActive}
                data-testid="switch-is-active"
              />
            </div>
          </div>

          <DialogFooter className="pt-4 border-t">
            <Button 
              variant="outline" 
              onClick={resetForm}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="button-submit"
            >
              {(createMutation.isPending || updateMutation.isPending) && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              {editingDirectory ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
