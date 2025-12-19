import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Building2, Shield, Save, Eye, EyeOff, Pencil, GripVertical } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";

const HEADER_FIELDS = [
  { key: 'name', label: 'Organisation Name', description: 'The name of the organisation (shown in header)' },
  { key: 'description', label: 'Description', description: 'Organisation description/about (shown in header)' },
  { key: 'logo_url', label: 'Logo', description: 'Organisation logo image (shown in header)' },
];

const CONTACT_FIELDS = [
  { key: 'phone', label: 'Phone Number', description: 'Contact phone number' },
  { key: 'website_url', label: 'Website', description: 'Organisation website URL' },
  { key: 'invoicing_email', label: 'Invoicing Email', description: 'Email for invoicing purposes' },
  { key: 'invoicing_address', label: 'Invoicing Address', description: 'Address for invoicing' },
];

const ALL_CORE_FIELDS = [...HEADER_FIELDS, ...CONTACT_FIELDS];

const PERMISSION_OPTIONS = [
  { value: 'read_write', label: 'Read & Write', icon: Pencil, color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100' },
  { value: 'read', label: 'Read Only', icon: Eye, color: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100' },
  { value: 'hidden', label: 'Hidden', icon: EyeOff, color: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200' },
];

export default function OrganisationPreferencesPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState(null);
  const [permissions, setPermissions] = useState({});
  const [hasChanges, setHasChanges] = useState(false);
  const [orderedContactFields, setOrderedContactFields] = useState(CONTACT_FIELDS);
  const [orderedCustomFields, setOrderedCustomFields] = useState([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_admin_OrganisationPreferences')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: roles = [], isLoading: rolesLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => base44.entities.Role.list(),
    enabled: accessChecked,
  });

  const { data: orgCustomFields = [] } = useQuery({
    queryKey: ['org-preference-fields'],
    queryFn: async () => {
      const fields = await base44.entities.PreferenceField.list({
        filter: { is_active: true, entity_scope: 'organization' },
        sort: { display_order: 'asc' }
      });
      return (fields || []).filter(f => f.entity_scope === 'organization');
    },
    enabled: accessChecked,
  });

  const { data: fieldOrderSettings } = useQuery({
    queryKey: ['org-field-order-settings'],
    queryFn: async () => {
      const settings = await base44.entities.SystemSettings.list({
        filter: { key: 'organization_field_order' }
      });
      if (settings && settings.length > 0) {
        try {
          return JSON.parse(settings[0].value);
        } catch {
          return null;
        }
      }
      return null;
    },
    enabled: accessChecked,
  });

  useEffect(() => {
    if (fieldOrderSettings?.contactFieldOrder) {
      const orderedKeys = fieldOrderSettings.contactFieldOrder;
      const reordered = orderedKeys
        .map(key => CONTACT_FIELDS.find(f => f.key === key))
        .filter(Boolean);
      const remaining = CONTACT_FIELDS.filter(f => !orderedKeys.includes(f.key));
      setOrderedContactFields([...reordered, ...remaining]);
    } else {
      setOrderedContactFields(CONTACT_FIELDS);
    }
  }, [fieldOrderSettings]);

  useEffect(() => {
    if (orgCustomFields.length > 0) {
      if (fieldOrderSettings?.customFieldOrder) {
        const orderedIds = fieldOrderSettings.customFieldOrder;
        const reordered = orderedIds
          .map(id => orgCustomFields.find(f => f.id === id))
          .filter(Boolean);
        const remaining = orgCustomFields.filter(f => !orderedIds.includes(f.id));
        setOrderedCustomFields([...reordered, ...remaining]);
      } else {
        setOrderedCustomFields([...orgCustomFields].sort((a, b) => (a.display_order || 0) - (b.display_order || 0)));
      }
    }
  }, [orgCustomFields, fieldOrderSettings]);

  const { data: rolePermissions = {}, isLoading: permissionsLoading } = useQuery({
    queryKey: ['role-org-field-permissions', selectedRoleId],
    queryFn: async () => {
      if (!selectedRoleId) return {};
      const response = await fetch(`/api/roles/${selectedRoleId}/organization-field-permissions`, {
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error('Failed to fetch permissions');
      }
      const data = await response.json();
      const permissionMap = {};
      if (Array.isArray(data)) {
        data.forEach(p => {
          permissionMap[p.field_key] = p.permission;
        });
      }
      return permissionMap;
    },
    enabled: !!selectedRoleId && accessChecked,
  });

  useEffect(() => {
    if (selectedRoleId && rolePermissions) {
      const allFields = [...ALL_CORE_FIELDS.map(f => f.key), ...orderedCustomFields.map(f => f.id)];
      const initialPermissions = {};
      allFields.forEach(fieldKey => {
        initialPermissions[fieldKey] = rolePermissions[fieldKey] || 'read_write';
      });
      setPermissions(initialPermissions);
      setHasChanges(false);
    }
  }, [selectedRoleId, rolePermissions, orderedCustomFields]);

  const saveOrderMutation = useMutation({
    mutationFn: async ({ contactFieldOrder, customFieldOrder }) => {
      const settings = await base44.entities.SystemSettings.list({
        filter: { key: 'organization_field_order' }
      });
      
      const orderData = JSON.stringify({ contactFieldOrder, customFieldOrder });
      
      if (settings && settings.length > 0) {
        await base44.entities.SystemSettings.update(settings[0].id, { value: orderData });
      } else {
        await base44.entities.SystemSettings.create({
          key: 'organization_field_order',
          value: orderData,
          description: 'Field display order for My Organisation page'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-field-order-settings'] });
    }
  });

  const updatePermissionsMutation = useMutation({
    mutationFn: async (permissionsData) => {
      const permissionsArray = Object.entries(permissionsData).map(([field_key, permission]) => ({
        field_key,
        permission
      }));
      
      const response = await fetch(`/api/roles/${selectedRoleId}/organization-field-permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(permissionsArray)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update permissions');
      }
      return response.json();
    },
    onSuccess: () => {
      toast.success('Permissions saved successfully');
      setHasChanges(false);
      queryClient.invalidateQueries({ queryKey: ['role-org-field-permissions', selectedRoleId] });
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to save permissions');
    }
  });

  const handlePermissionChange = (fieldKey, newPermission) => {
    setPermissions(prev => ({
      ...prev,
      [fieldKey]: newPermission
    }));
    setHasChanges(true);
  };

  const handleSave = () => {
    updatePermissionsMutation.mutate(permissions);
  };

  const handleRoleChange = (roleId) => {
    if (hasChanges) {
      if (!confirm('You have unsaved changes. Are you sure you want to switch roles?')) {
        return;
      }
    }
    setSelectedRoleId(roleId);
  };

  const handleDragEnd = (result) => {
    const { source, destination, type } = result;
    
    if (!destination) return;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    if (type === 'CONTACT_FIELDS') {
      const newFields = Array.from(orderedContactFields);
      const [removed] = newFields.splice(source.index, 1);
      newFields.splice(destination.index, 0, removed);
      setOrderedContactFields(newFields);
      
      saveOrderMutation.mutate({
        contactFieldOrder: newFields.map(f => f.key),
        customFieldOrder: orderedCustomFields.map(f => f.id)
      });
      toast.success('Field order updated');
    } else if (type === 'CUSTOM_FIELDS') {
      const newFields = Array.from(orderedCustomFields);
      const [removed] = newFields.splice(source.index, 1);
      newFields.splice(destination.index, 0, removed);
      setOrderedCustomFields(newFields);
      
      saveOrderMutation.mutate({
        contactFieldOrder: orderedContactFields.map(f => f.key),
        customFieldOrder: newFields.map(f => f.id)
      });
      toast.success('Field order updated');
    }
  };

  const getPermissionBadge = (permission) => {
    const option = PERMISSION_OPTIONS.find(o => o.value === permission) || PERMISSION_OPTIONS[0];
    const Icon = option.icon;
    return (
      <Badge className={`${option.color} flex items-center gap-1`}>
        <Icon className="w-3 h-3" />
        {option.label}
      </Badge>
    );
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Building2 className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
              Organisation Preferences
            </h1>
          </div>
          <p className="text-slate-600">
            Configure field order and permissions for each role on the My Organisation page. Drag fields to reorder them.
          </p>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Select Role
            </CardTitle>
            <CardDescription>
              Choose a role to configure its organisation field permissions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <Select
                value={selectedRoleId || ''}
                onValueChange={handleRoleChange}
                disabled={rolesLoading}
              >
                <SelectTrigger className="w-[300px]" data-testid="select-role">
                  <SelectValue placeholder="Select a role..." />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                      {role.is_admin && <Badge className="ml-2" variant="secondary">Admin</Badge>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              {hasChanges && (
                <Button
                  onClick={handleSave}
                  disabled={updatePermissionsMutation.isPending}
                  data-testid="button-save-permissions"
                >
                  {updatePermissionsMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  Save Changes
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <DragDropContext onDragEnd={handleDragEnd}>
          {selectedRoleId && (
            <>
              {permissionsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                </div>
              ) : (
                <div className="space-y-6">
                  <Card>
                    <CardHeader>
                      <CardTitle>Header Fields</CardTitle>
                      <CardDescription>
                        Fields shown in the organisation header (fixed position)
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {HEADER_FIELDS.map((field) => (
                          <div
                            key={field.key}
                            className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg"
                          >
                            <div>
                              <p className="font-medium text-slate-900 dark:text-slate-100">{field.label}</p>
                              <p className="text-sm text-slate-500 dark:text-slate-400">{field.description}</p>
                            </div>
                            <Select
                              value={permissions[field.key] || 'read_write'}
                              onValueChange={(value) => handlePermissionChange(field.key, value)}
                            >
                              <SelectTrigger className="w-[160px]" data-testid={`select-permission-${field.key}`}>
                                <SelectValue>
                                  {getPermissionBadge(permissions[field.key] || 'read_write')}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {PERMISSION_OPTIONS.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    <div className="flex items-center gap-2">
                                      <option.icon className="w-4 h-4" />
                                      {option.label}
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Contact & Invoicing Fields</CardTitle>
                      <CardDescription>
                        Drag to reorder these fields in the contact details section
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Droppable droppableId="contact-fields" type="CONTACT_FIELDS">
                        {(provided) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.droppableProps}
                            className="space-y-2"
                          >
                            {orderedContactFields.map((field, index) => (
                              <Draggable key={field.key} draggableId={field.key} index={index}>
                                {(provided, snapshot) => (
                                  <div
                                    ref={provided.innerRef}
                                    {...provided.draggableProps}
                                    className={`flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg ${
                                      snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-500' : ''
                                    }`}
                                  >
                                    <div className="flex items-center gap-3">
                                      <div
                                        {...provided.dragHandleProps}
                                        className="cursor-grab active:cursor-grabbing p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700"
                                        data-testid={`drag-handle-${field.key}`}
                                      >
                                        <GripVertical className="w-4 h-4 text-slate-400" />
                                      </div>
                                      <div>
                                        <p className="font-medium text-slate-900 dark:text-slate-100">{field.label}</p>
                                        <p className="text-sm text-slate-500 dark:text-slate-400">{field.description}</p>
                                      </div>
                                    </div>
                                    <Select
                                      value={permissions[field.key] || 'read_write'}
                                      onValueChange={(value) => handlePermissionChange(field.key, value)}
                                    >
                                      <SelectTrigger className="w-[160px]" data-testid={`select-permission-${field.key}`}>
                                        <SelectValue>
                                          {getPermissionBadge(permissions[field.key] || 'read_write')}
                                        </SelectValue>
                                      </SelectTrigger>
                                      <SelectContent>
                                        {PERMISSION_OPTIONS.map((option) => (
                                          <SelectItem key={option.value} value={option.value}>
                                            <div className="flex items-center gap-2">
                                              <option.icon className="w-4 h-4" />
                                              {option.label}
                                            </div>
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                )}
                              </Draggable>
                            ))}
                            {provided.placeholder}
                          </div>
                        )}
                      </Droppable>
                    </CardContent>
                  </Card>

                  {orderedCustomFields.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Custom Organisation Fields</CardTitle>
                        <CardDescription>
                          Drag to reorder. Custom fields defined for organisations.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Droppable droppableId="custom-fields" type="CUSTOM_FIELDS">
                          {(provided) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.droppableProps}
                              className="space-y-2"
                            >
                              {orderedCustomFields.map((field, index) => (
                                <Draggable key={field.id} draggableId={field.id} index={index}>
                                  {(provided, snapshot) => (
                                    <div
                                      ref={provided.innerRef}
                                      {...provided.draggableProps}
                                      className={`flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg ${
                                        snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-500' : ''
                                      }`}
                                    >
                                      <div className="flex items-center gap-3">
                                        <div
                                          {...provided.dragHandleProps}
                                          className="cursor-grab active:cursor-grabbing p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700"
                                          data-testid={`drag-handle-custom-${field.id}`}
                                        >
                                          <GripVertical className="w-4 h-4 text-slate-400" />
                                        </div>
                                        <div>
                                          <p className="font-medium text-slate-900 dark:text-slate-100">{field.label}</p>
                                          <p className="text-sm text-slate-500 dark:text-slate-400">
                                            {field.field_type} field
                                            {field.is_required && <Badge variant="outline" className="ml-2">Required</Badge>}
                                          </p>
                                        </div>
                                      </div>
                                      <Select
                                        value={permissions[field.id] || 'read_write'}
                                        onValueChange={(value) => handlePermissionChange(field.id, value)}
                                      >
                                        <SelectTrigger className="w-[160px]" data-testid={`select-permission-${field.id}`}>
                                          <SelectValue>
                                            {getPermissionBadge(permissions[field.id] || 'read_write')}
                                          </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent>
                                          {PERMISSION_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                              <div className="flex items-center gap-2">
                                                <option.icon className="w-4 h-4" />
                                                {option.label}
                                              </div>
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  )}
                                </Draggable>
                              ))}
                              {provided.placeholder}
                            </div>
                          )}
                        </Droppable>
                      </CardContent>
                    </Card>
                  )}

                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                    <h4 className="font-medium text-blue-900 dark:text-blue-100 mb-2">Permission Levels</h4>
                    <ul className="space-y-1 text-sm text-blue-800 dark:text-blue-200">
                      <li className="flex items-center gap-2">
                        <Pencil className="w-4 h-4" />
                        <strong>Read & Write:</strong> Members can view and edit this field
                      </li>
                      <li className="flex items-center gap-2">
                        <Eye className="w-4 h-4" />
                        <strong>Read Only:</strong> Members can view but not edit this field
                      </li>
                      <li className="flex items-center gap-2">
                        <EyeOff className="w-4 h-4" />
                        <strong>Hidden:</strong> This field is not shown to members with this role
                      </li>
                    </ul>
                  </div>
                </div>
              )}
            </>
          )}
        </DragDropContext>

        {!selectedRoleId && (
          <Card>
            <CardContent className="p-12 text-center">
              <Shield className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
                Select a Role
              </h3>
              <p className="text-slate-600 dark:text-slate-400">
                Choose a role from the dropdown above to configure its organisation field permissions.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
