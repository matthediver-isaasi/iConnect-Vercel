import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Building2, Shield, Save, GripVertical } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import PermissionMatrix from "@/components/PermissionMatrix";

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

export default function OrganisationPreferencesPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [permissionsByRole, setPermissionsByRole] = useState({});
  const [hasChanges, setHasChanges] = useState(false);
  const [changedRoleIds, setChangedRoleIds] = useState(new Set());
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
        filter: { setting_key: 'organization_field_order' }
      });
      if (settings && settings.length > 0) {
        try {
          return JSON.parse(settings[0].setting_value);
        } catch {
          return null;
        }
      }
      return null;
    },
    enabled: accessChecked,
  });

  const { data: bulkPermissions, isLoading: permissionsLoading } = useQuery({
    queryKey: ['bulk-org-field-permissions'],
    queryFn: async () => {
      const response = await fetch('/api/roles/bulk-field-permissions?type=organization', {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch permissions');
      return response.json();
    },
    enabled: accessChecked,
  });

  useEffect(() => {
    if (bulkPermissions) {
      setPermissionsByRole(bulkPermissions);
      setHasChanges(false);
      setChangedRoleIds(new Set());
    }
  }, [bulkPermissions]);

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

  const saveOrderMutation = useMutation({
    mutationFn: async ({ contactFieldOrder, customFieldOrder }) => {
      const settings = await base44.entities.SystemSettings.list({
        filter: { setting_key: 'organization_field_order' }
      });
      const orderData = JSON.stringify({ contactFieldOrder, customFieldOrder });
      if (settings && settings.length > 0) {
        await base44.entities.SystemSettings.update(settings[0].id, { setting_value: orderData });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'organization_field_order',
          setting_value: orderData,
          description: 'Field display order for My Organisation page'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-field-order-settings'] });
    }
  });

  const updatePermissionsMutation = useMutation({
    mutationFn: async (permsToSave) => {
      const response = await fetch('/api/roles/bulk-field-permissions?type=organization', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ permissions: permsToSave })
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
      setChangedRoleIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['bulk-org-field-permissions'] });
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to save permissions');
    }
  });

  const handlePermissionChange = useCallback((roleId, fieldKey, newPerm) => {
    setPermissionsByRole(prev => ({
      ...prev,
      [roleId]: {
        ...(prev[roleId] || {}),
        [fieldKey]: newPerm
      }
    }));
    setChangedRoleIds(prev => new Set(prev).add(roleId));
    setHasChanges(true);
  }, []);

  const handleBulkFieldChange = useCallback((fieldKey, newPerm) => {
    setPermissionsByRole(prev => {
      const next = { ...prev };
      roles.forEach(role => {
        next[role.id] = { ...(next[role.id] || {}), [fieldKey]: newPerm };
      });
      return next;
    });
    setChangedRoleIds(prev => {
      const next = new Set(prev);
      roles.forEach(r => next.add(r.id));
      return next;
    });
    setHasChanges(true);
  }, [roles]);

  const handleBulkRoleChange = useCallback((roleId, newPerm) => {
    const allFieldKeys = [
      ...HEADER_FIELDS.map(f => f.key),
      ...CONTACT_FIELDS.map(f => f.key),
      ...orgCustomFields.map(f => f.id)
    ];
    setPermissionsByRole(prev => {
      const rolePerms = {};
      allFieldKeys.forEach(k => { rolePerms[k] = newPerm; });
      return { ...prev, [roleId]: rolePerms };
    });
    setChangedRoleIds(prev => new Set(prev).add(roleId));
    setHasChanges(true);
  }, [orgCustomFields]);

  const handleSave = () => {
    const permsToSave = {};
    changedRoleIds.forEach(roleId => {
      permsToSave[roleId] = permissionsByRole[roleId] || {};
    });
    updatePermissionsMutation.mutate(permsToSave);
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

  const fieldGroups = [
    { label: 'Header Fields', fields: HEADER_FIELDS },
    { label: 'Contact & Invoicing Fields', fields: orderedContactFields },
    ...(orderedCustomFields.length > 0
      ? [{ label: 'Custom Organisation Fields', fields: orderedCustomFields.map(f => ({ key: f.id, label: f.label, description: `${f.field_type} field` })) }]
      : [])
  ];

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-[90rem] mx-auto">
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <Building2 className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900" data-testid="text-page-title">
              Organisation Preferences
            </h1>
          </div>
          <p className="text-slate-600">
            Configure field permissions across all roles and manage field display order for the My Organisation page.
          </p>
        </div>

        <Tabs defaultValue="permissions" className="space-y-4">
          <TabsList data-testid="tabs-preferences">
            <TabsTrigger value="permissions" data-testid="tab-permissions">
              <Shield className="w-4 h-4 mr-1.5" />
              Permissions
            </TabsTrigger>
            <TabsTrigger value="field-order" data-testid="tab-field-order">
              <GripVertical className="w-4 h-4 mr-1.5" />
              Field Order
            </TabsTrigger>
          </TabsList>

          <TabsContent value="permissions">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Shield className="w-5 h-5" />
                      Role Permissions Matrix
                    </CardTitle>
                    <CardDescription>
                      Click any cell to cycle through permissions. Use the dropdown arrows for bulk changes.
                    </CardDescription>
                  </div>
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
              </CardHeader>
              <CardContent>
                <PermissionMatrix
                  fieldGroups={fieldGroups}
                  roles={roles}
                  permissionsByRole={permissionsByRole}
                  onPermissionChange={handlePermissionChange}
                  onBulkFieldChange={handleBulkFieldChange}
                  onBulkRoleChange={handleBulkRoleChange}
                  isLoading={permissionsLoading || rolesLoading || !orgCustomFields}
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="field-order">
            <DragDropContext onDragEnd={handleDragEnd}>
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Contact & Invoicing Fields</CardTitle>
                    <CardDescription>
                      Drag to reorder these fields in the contact details section. Header fields (Name, Description, Logo) are fixed.
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
                                  className={`flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg ${
                                    snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-500' : ''
                                  }`}
                                >
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
                        Drag to reorder custom fields.
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
                                    className={`flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg ${
                                      snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-500' : ''
                                    }`}
                                  >
                                    <div
                                      {...provided.dragHandleProps}
                                      className="cursor-grab active:cursor-grabbing p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700"
                                      data-testid={`drag-handle-custom-${field.id}`}
                                    >
                                      <GripVertical className="w-4 h-4 text-slate-400" />
                                    </div>
                                    <div>
                                      <p className="font-medium text-slate-900 dark:text-slate-100">{field.label}</p>
                                      <p className="text-sm text-slate-500 dark:text-slate-400">{field.field_type} field</p>
                                    </div>
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
              </div>
            </DragDropContext>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
