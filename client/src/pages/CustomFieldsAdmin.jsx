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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GripVertical, Loader2, ClipboardList, Plus, Pencil, Trash2, X, User, Building2, Filter } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email Address' },
  { value: 'url', label: 'URL / Website' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes/No (Boolean)' },
  { value: 'number', label: 'Number (Integer)' },
  { value: 'decimal', label: 'Decimal Number' },
  { value: 'picklist', label: 'Picklist (Multiple Selection)' },
  { value: 'dropdown', label: 'Dropdown (Single Selection)' },
  { value: 'list', label: 'List (User-Defined Values)' }
];

const ENTITY_SCOPES = [
  { value: 'member', label: 'Member', icon: User, description: 'Field appears in member preferences' },
  { value: 'organization', label: 'Organisation', icon: Building2, description: 'Field appears in organisation profile' }
];

export default function CustomFieldsAdminPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [activeTab, setActiveTab] = useState('member');
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin || isFeatureExcluded('page_CustomFieldsAdmin')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady]);

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2 flex items-center gap-3">
              <ClipboardList className="w-8 h-8 text-blue-600" />
              Custom Fields
            </h1>
            <p className="text-slate-600">
              Define custom fields for members and organisations
            </p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-2 max-w-md">
            <TabsTrigger value="member" className="gap-2" data-testid="tab-member-fields">
              <User className="w-4 h-4" />
              Member Fields
            </TabsTrigger>
            <TabsTrigger value="organization" className="gap-2" data-testid="tab-organization-fields">
              <Building2 className="w-4 h-4" />
              Organisation Fields
            </TabsTrigger>
          </TabsList>

          <TabsContent value="member">
            <CustomFieldsManager 
              queryClient={queryClient} 
              entityScope="member"
              title="Member Custom Fields"
              description="These fields appear in the 'Additional Info' section on each member's Preferences page"
            />
          </TabsContent>

          <TabsContent value="organization">
            <CustomFieldsManager 
              queryClient={queryClient} 
              entityScope="organization"
              title="Organisation Custom Fields"
              description="These fields appear when viewing an organisation's profile in the Organisation Directory"
            />
          </TabsContent>
        </Tabs>

        <Card className="mt-6 border-blue-200 bg-blue-50">
          <CardContent className="p-4">
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-2">How Custom Fields Work:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><strong>Member Fields:</strong> Members can edit these in their Preferences page under "Additional Info"</li>
                <li><strong>Organisation Fields:</strong> Organisation admins can edit these, and values are displayed when clicking an organisation in the directory</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CustomFieldsManager({ queryClient, entityScope, title, description }) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingField, setEditingField] = useState(null);
  const [fieldName, setFieldName] = useState('');
  const [fieldLabel, setFieldLabel] = useState('');
  const [fieldType, setFieldType] = useState('text');
  const [fieldRequired, setFieldRequired] = useState(false);
  const [fieldOptions, setFieldOptions] = useState([]);
  const [newOptionValue, setNewOptionValue] = useState('');
  const [newOptionLabel, setNewOptionLabel] = useState('');
  const [fieldFilterable, setFieldFilterable] = useState(false);

  const { data: preferenceFields = [], isLoading } = useQuery({
    queryKey: ['/api/entities/PreferenceField', entityScope],
    queryFn: async () => {
      try {
        // Try to filter by entity_scope (requires migration to be run)
        const fields = await base44.entities.PreferenceField.list({
          filter: { entity_scope: entityScope },
          sort: { display_order: 'asc' }
        });
        return fields || [];
      } catch (error) {
        // Fallback: if entity_scope column doesn't exist, fetch all and filter client-side
        console.warn('entity_scope filter failed, falling back to client-side filter:', error);
        try {
          const allFields = await base44.entities.PreferenceField.list({
            sort: { display_order: 'asc' }
          });
          // For backwards compatibility: fields without entity_scope are considered 'member' scope
          return (allFields || []).filter(f => 
            entityScope === 'member' 
              ? (!f.entity_scope || f.entity_scope === 'member')
              : f.entity_scope === entityScope
          );
        } catch (fallbackError) {
          console.error('Failed to fetch preference fields:', fallbackError);
          return [];
        }
      }
    }
  });

  const createFieldMutation = useMutation({
    mutationFn: async (fieldData) => {
      return await base44.entities.PreferenceField.create(fieldData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/entities/PreferenceField', entityScope] });
      toast.success('Custom field created successfully');
      resetForm();
    },
    onError: (error) => {
      toast.error('Failed to create field: ' + error.message);
    }
  });

  const updateFieldMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      return await base44.entities.PreferenceField.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/entities/PreferenceField', entityScope] });
      toast.success('Custom field updated successfully');
      resetForm();
    },
    onError: (error) => {
      toast.error('Failed to update field: ' + error.message);
    }
  });

  const deleteFieldMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.PreferenceField.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/entities/PreferenceField', entityScope] });
      toast.success('Custom field deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete field: ' + error.message);
    }
  });

  const handleDragEnd = async (result) => {
    if (!result.destination) return;

    const items = Array.from(preferenceFields);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);

    // Update display_order for all affected items
    for (let i = 0; i < items.length; i++) {
      if (items[i].display_order !== i) {
        try {
          await base44.entities.PreferenceField.update(items[i].id, { display_order: i });
        } catch (error) {
          console.error('Failed to update display order:', error);
        }
      }
    }
    
    queryClient.invalidateQueries({ queryKey: ['/api/entities/PreferenceField', entityScope] });
  };

  const resetForm = () => {
    setIsDialogOpen(false);
    setEditingField(null);
    setFieldName('');
    setFieldLabel('');
    setFieldType('text');
    setFieldRequired(false);
    setFieldOptions([]);
    setNewOptionValue('');
    setNewOptionLabel('');
    setFieldFilterable(false);
  };

  const handleOpenCreateDialog = () => {
    resetForm();
    setIsDialogOpen(true);
  };

  const handleOpenEditDialog = (field) => {
    setEditingField(field);
    setFieldName(field.name || '');
    setFieldLabel(field.label || '');
    setFieldType(field.field_type || 'text');
    setFieldRequired(field.is_required || false);
    setFieldOptions(field.options || []);
    setFieldFilterable(field.is_filterable || false);
    setIsDialogOpen(true);
  };

  const handleAddOption = () => {
    if (!newOptionValue.trim()) return;
    const option = {
      value: newOptionValue.trim(),
      label: newOptionLabel.trim() || newOptionValue.trim()
    };
    setFieldOptions([...fieldOptions, option]);
    setNewOptionValue('');
    setNewOptionLabel('');
  };

  const handleRemoveOption = (index) => {
    setFieldOptions(fieldOptions.filter((_, i) => i !== index));
  };

  const handleSubmit = () => {
    if (!fieldName.trim() || !fieldLabel.trim()) {
      toast.error('Please provide both field name and label');
      return;
    }

    // Note: We no longer require options for picklist/dropdown fields
    // This allows creating fields where options are added per-record (e.g., approved domains per organisation)

    const fieldData = {
      name: fieldName.trim().toLowerCase().replace(/\s+/g, '_'),
      label: fieldLabel.trim(),
      field_type: fieldType,
      is_required: fieldRequired,
      options: (fieldType === 'picklist' || fieldType === 'dropdown') ? fieldOptions : null,
      display_order: editingField ? editingField.display_order : preferenceFields.length,
      is_active: true,
      entity_scope: entityScope,
      is_filterable: (fieldType === 'picklist' || fieldType === 'dropdown') ? fieldFilterable : false
    };

    if (editingField) {
      updateFieldMutation.mutate({ id: editingField.id, data: fieldData });
    } else {
      createFieldMutation.mutate(fieldData);
    }
  };

  const handleToggleActive = (field) => {
    updateFieldMutation.mutate({
      id: field.id,
      data: { is_active: !field.is_active }
    });
  };

  const ScopeIcon = entityScope === 'member' ? User : Building2;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ScopeIcon className="w-5 h-5 text-blue-600" />
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Button 
            onClick={handleOpenCreateDialog}
            className="gap-2 bg-blue-600 hover:bg-blue-700"
            data-testid={`button-add-${entityScope}-field`}
          >
            <Plus className="w-4 h-4" />
            Add Field
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          </div>
        ) : preferenceFields.length === 0 ? (
          <div className="text-center py-8 text-slate-500 border border-dashed border-slate-200 rounded-lg">
            <ScopeIcon className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p>No {entityScope === 'member' ? 'member' : 'organisation'} custom fields defined yet.</p>
            <p className="text-sm mt-1">Click "Add Field" to create your first custom field.</p>
          </div>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId={`${entityScope}-fields`}>
              {(provided) => (
                <div
                  {...provided.droppableProps}
                  ref={provided.innerRef}
                  className="space-y-3"
                >
                  {preferenceFields.map((field, index) => (
                    <Draggable key={field.id} draggableId={field.id} index={index}>
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          className={`flex items-center gap-3 p-4 border rounded-lg transition-all ${
                            snapshot.isDragging ? 'shadow-lg border-blue-300' : ''
                          } ${field.is_active ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-200 opacity-60'}`}
                          data-testid={`field-item-${field.id}`}
                        >
                          <div
                            {...provided.dragHandleProps}
                            className="cursor-grab active:cursor-grabbing p-1 hover:bg-slate-100 rounded"
                          >
                            <GripVertical className="w-4 h-4 text-slate-400" />
                          </div>
                          
                          <div className="flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-slate-900">{field.label}</span>
                              <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                                {FIELD_TYPES.find(t => t.value === field.field_type)?.label || field.field_type}
                              </span>
                              {field.is_required && (
                                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded">Required</span>
                              )}
                              {field.is_filterable && (
                                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded flex items-center gap-1">
                                  <Filter className="w-3 h-3" />
                                  Filterable
                                </span>
                              )}
                              {!field.is_active && (
                                <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">Inactive</span>
                              )}
                            </div>
                            <p className="text-sm text-slate-500 mt-1">Field name: {field.name}</p>
                            {field.options && field.options.length > 0 && (
                              <p className="text-sm text-slate-400 mt-1">
                                Options: {field.options.map(o => o.label).join(', ')}
                              </p>
                            )}
                          </div>
                          
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={field.is_active}
                              onCheckedChange={() => handleToggleActive(field)}
                              data-testid={`switch-field-active-${field.id}`}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleOpenEditDialog(field)}
                              data-testid={`button-edit-field-${field.id}`}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                if (confirm('Are you sure you want to delete this field? All saved values for this field will also be deleted.')) {
                                  deleteFieldMutation.mutate(field.id);
                                }
                              }}
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              data-testid={`button-delete-field-${field.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
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
          </DragDropContext>
        )}
      </CardContent>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[500px] max-h-[90vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>
              {editingField ? 'Edit Custom Field' : 'Create Custom Field'}
            </DialogTitle>
            <DialogDescription>
              {editingField 
                ? 'Update the settings for this custom field.'
                : `Add a new custom field for ${entityScope === 'member' ? 'members' : 'organisations'}.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4 overflow-y-auto flex-1">
            <div className="space-y-2">
              <Label htmlFor="fieldLabel">Field Label *</Label>
              <Input
                id="fieldLabel"
                value={fieldLabel}
                onChange={(e) => setFieldLabel(e.target.value)}
                placeholder="e.g., Department, Industry"
                data-testid="input-field-label"
              />
              <p className="text-xs text-slate-500">This is what users will see</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="fieldName">Field Name *</Label>
              <Input
                id="fieldName"
                value={fieldName}
                onChange={(e) => setFieldName(e.target.value)}
                placeholder="e.g., department, industry"
                data-testid="input-field-name"
              />
              <p className="text-xs text-slate-500">Internal identifier (lowercase, no spaces)</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="fieldType">Field Type *</Label>
              <Select value={fieldType} onValueChange={setFieldType}>
                <SelectTrigger data-testid="select-field-type">
                  <SelectValue placeholder="Select field type" />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {fieldType === 'list' && (
              <div className="p-3 bg-green-50 rounded-lg border border-green-200">
                <p className="text-sm text-green-800">
                  <strong>List Field:</strong> Users can add their own custom values to this field. 
                  Unlike picklists, there are no pre-defined options - each {entityScope === 'member' ? 'member' : 'organisation'} can enter their own list items.
                </p>
                <p className="text-xs text-green-600 mt-1">
                  Example uses: skills, interests, tags, domains, certifications
                </p>
              </div>
            )}

            {(fieldType === 'picklist' || fieldType === 'dropdown') && (
              <div className="space-y-3">
                <Label>Options (Optional)</Label>
                <p className="text-xs text-slate-500 -mt-1">
                  Leave empty if values will be unique per {entityScope === 'member' ? 'member' : 'organisation'} (e.g., approved domains, custom tags)
                </p>
                
                {fieldOptions.length > 0 && (
                  <div className="space-y-2">
                    {fieldOptions.map((option, index) => (
                      <div 
                        key={index} 
                        className="flex items-center gap-2 p-2 bg-slate-50 rounded border"
                      >
                        <span className="flex-1 text-sm">{option.label}</span>
                        <span className="text-xs text-slate-400">({option.value})</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemoveOption(index)}
                          className="h-6 w-6"
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <Input
                    value={newOptionValue}
                    onChange={(e) => setNewOptionValue(e.target.value)}
                    placeholder="Value"
                    className="flex-1"
                    data-testid="input-option-value"
                  />
                  <Input
                    value={newOptionLabel}
                    onChange={(e) => setNewOptionLabel(e.target.value)}
                    placeholder="Label (optional)"
                    className="flex-1"
                    data-testid="input-option-label"
                  />
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={handleAddOption}
                    data-testid="button-add-option"
                  >
                    Add
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border">
              <div>
                <Label htmlFor="fieldRequired" className="cursor-pointer">Required Field</Label>
                <p className="text-xs text-slate-500 mt-0.5">
                  {entityScope === 'member' ? 'Members' : 'Organisations'} must fill in this field
                </p>
              </div>
              <Switch
                id="fieldRequired"
                checked={fieldRequired}
                onCheckedChange={setFieldRequired}
                data-testid="switch-field-required"
              />
            </div>

            {(fieldType === 'picklist' || fieldType === 'dropdown') && (
              <div className="flex items-center justify-between p-3 bg-purple-50 rounded-lg border border-purple-200">
                <div>
                  <Label htmlFor="fieldFilterable" className="cursor-pointer flex items-center gap-2">
                    <Filter className="w-4 h-4 text-purple-600" />
                    Use as Directory Filter
                  </Label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Show this field as a dropdown filter in the {entityScope === 'member' ? 'Member' : 'Organisation'} Directory
                  </p>
                </div>
                <Switch
                  id="fieldFilterable"
                  checked={fieldFilterable}
                  onCheckedChange={setFieldFilterable}
                  data-testid="switch-field-filterable"
                />
              </div>
            )}
          </div>

          <DialogFooter className="flex-shrink-0">
            <Button variant="outline" onClick={resetForm} data-testid="button-cancel-field">
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit}
              disabled={createFieldMutation.isPending || updateFieldMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
              data-testid="button-save-field"
            >
              {(createFieldMutation.isPending || updateFieldMutation.isPending) ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              {editingField ? 'Update Field' : 'Create Field'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
