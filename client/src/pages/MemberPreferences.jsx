import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, User, Shield, Save, Pencil, Eye, EyeOff, GripVertical, Link2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import PermissionMatrix from "@/components/PermissionMatrix";

const HEADER_FIELDS = [
  { key: 'first_name', label: 'First Name', description: 'Member first name (shown in header)' },
  { key: 'last_name', label: 'Last Name', description: 'Member last name (shown in header)' },
  { key: 'profile_photo_url', label: 'Profile Photo', description: 'Member profile picture (shown in header)' },
];

const PROFILE_FIELDS = [
  { key: 'job_title', label: 'Job Title', description: 'Current job title/position' },
  { key: 'mobile', label: 'Mobile Phone', description: 'Mobile phone number' },
  { key: 'landline', label: 'Landline', description: 'Landline phone number' },
  { key: 'biography', label: 'Biography', description: 'Professional biography text' },
  { key: 'show_in_directory', label: 'Show in Directory', description: 'Whether member appears in the member directory' },
];

export default function MemberPreferencesPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [permissionsByRole, setPermissionsByRole] = useState({});
  const [hasChanges, setHasChanges] = useState(false);
  const [changedRoleIds, setChangedRoleIds] = useState(new Set());
  const [orderedProfileFields, setOrderedProfileFields] = useState(PROFILE_FIELDS);
  const [orderedCustomFields, setOrderedCustomFields] = useState([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_admin_MemberPreferences')) {
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

  const { data: memberCustomFields = [] } = useQuery({
    queryKey: ['member-preference-fields'],
    queryFn: async () => {
      const fields = await base44.entities.PreferenceField.list({
        filter: { is_active: true, entity_scope: 'member' },
        sort: { display_order: 'asc' }
      });
      return (fields || []).filter(f => f.entity_scope === 'member' && f.show_in_my_preferences !== false);
    },
    enabled: accessChecked,
  });

  const { data: fieldOrderSettings } = useQuery({
    queryKey: ['member-field-order-settings'],
    queryFn: async () => {
      const settings = await base44.entities.SystemSettings.list({
        filter: { setting_key: 'member_field_order' }
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

  const { data: allForms = [], isLoading: formsLoading } = useQuery({
    queryKey: ['forms-for-member-join'],
    queryFn: async () => {
      const forms = await base44.entities.Form.list();
      return (forms || []).filter(f => !f.is_contract);
    },
    enabled: accessChecked,
  });

  const { data: joinFormSetting, isLoading: joinFormSettingLoading } = useQuery({
    queryKey: ['member-join-form-setting'],
    queryFn: async () => {
      const settings = await base44.entities.SystemSettings.list({
        filter: { setting_key: 'member_join_form' }
      });
      if (settings && settings.length > 0) {
        try {
          return { id: settings[0].id, value: JSON.parse(settings[0].setting_value) };
        } catch {
          return { id: settings[0].id, value: null };
        }
      }
      return null;
    },
    enabled: accessChecked,
  });

  const { data: joinFormsByOrgTypeSetting, isLoading: joinFormsByOrgTypeSettingLoading } = useQuery({
    queryKey: ['member-join-forms-by-org-type-setting'],
    queryFn: async () => {
      const settings = await base44.entities.SystemSettings.list({
        filter: { setting_key: 'member_join_forms_by_org_type' }
      });
      if (settings && settings.length > 0) {
        try {
          const parsed = JSON.parse(settings[0].setting_value);
          return { id: settings[0].id, value: parsed && typeof parsed === 'object' ? parsed : {} };
        } catch {
          return { id: settings[0].id, value: {} };
        }
      }
      return null;
    },
    enabled: accessChecked,
  });

  const { data: orgScopedFields = [], isLoading: orgScopedFieldsLoading } = useQuery({
    queryKey: ['org-preference-fields-for-join'],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'organization' }
        });
        return fields || [];
      } catch {
        try {
          const all = await base44.entities.PreferenceField.list({ filter: { is_active: true } });
          return (all || []).filter(f => f.entity_scope === 'organization');
        } catch {
          return [];
        }
      }
    },
    enabled: accessChecked,
  });

  const orgTypeField = useMemo(() => {
    return orgScopedFields.find(f =>
      f.name === 'org_type' || f.name === 'organisation_type' || f.name === 'organization_type'
    );
  }, [orgScopedFields]);

  const orgTypeOptions = useMemo(() => {
    if (!orgTypeField?.options) return [];
    return orgTypeField.options.map(opt => {
      if (typeof opt === 'string') return { value: opt, label: opt };
      return { value: opt.value || opt, label: opt.label || opt.value || opt };
    });
  }, [orgTypeField]);

  const [selectedJoinFormId, setSelectedJoinFormId] = useState('');
  const [joinFormsByOrgType, setJoinFormsByOrgType] = useState({});

  useEffect(() => {
    if (joinFormSetting?.value?.id) {
      setSelectedJoinFormId(joinFormSetting.value.id);
    }
  }, [joinFormSetting]);

  useEffect(() => {
    if (joinFormsByOrgTypeSetting?.value && typeof joinFormsByOrgTypeSetting.value === 'object') {
      setJoinFormsByOrgType(joinFormsByOrgTypeSetting.value);
    }
  }, [joinFormsByOrgTypeSetting]);

  const saveJoinFormMutation = useMutation({
    mutationFn: async (formId) => {
      const form = allForms.find(f => f.id === formId);
      if (!form) throw new Error('Form not found');
      const value = JSON.stringify({ id: form.id, slug: form.slug });
      if (joinFormSetting?.id) {
        await base44.entities.SystemSettings.update(joinFormSetting.id, { setting_value: value });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'member_join_form',
          setting_value: value,
          description: 'Form used as the public join form for prospective members'
        });
      }
    },
    onSuccess: () => {
      toast.success('Default join form saved');
      queryClient.invalidateQueries({ queryKey: ['member-join-form-setting'] });
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to save join form');
    }
  });

  const saveJoinFormsByOrgTypeMutation = useMutation({
    mutationFn: async (mapping) => {
      const cleaned = {};
      Object.entries(mapping || {}).forEach(([orgType, entry]) => {
        if (entry && entry.id && entry.slug) {
          cleaned[orgType] = { id: entry.id, slug: entry.slug };
        }
      });
      const value = JSON.stringify(cleaned);
      if (joinFormsByOrgTypeSetting?.id) {
        await base44.entities.SystemSettings.update(joinFormsByOrgTypeSetting.id, { setting_value: value });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'member_join_forms_by_org_type',
          setting_value: value,
          description: 'Mapping of organisation_type value -> { id, slug } of the public join form to use for that org type'
        });
      }
    },
    onSuccess: () => {
      toast.success('Per-type join forms saved');
      queryClient.invalidateQueries({ queryKey: ['member-join-forms-by-org-type-setting'] });
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to save per-type join forms');
    }
  });

  const handleSelectJoinFormForOrgType = useCallback((orgTypeValue, formId) => {
    setJoinFormsByOrgType(prev => {
      const next = { ...(prev || {}) };
      if (!formId || formId === '__default__') {
        delete next[orgTypeValue];
      } else {
        const form = allForms.find(f => f.id === formId);
        if (form) next[orgTypeValue] = { id: form.id, slug: form.slug };
      }
      return next;
    });
  }, [allForms]);

  const perTypeMappingDirty = useMemo(() => {
    const persisted = joinFormsByOrgTypeSetting?.value || {};
    const current = joinFormsByOrgType || {};
    const keys = new Set([...Object.keys(persisted), ...Object.keys(current)]);
    for (const k of keys) {
      if ((persisted[k]?.id || null) !== (current[k]?.id || null)) return true;
    }
    return false;
  }, [joinFormsByOrgTypeSetting, joinFormsByOrgType]);

  const { data: bulkPermissions, isLoading: permissionsLoading } = useQuery({
    queryKey: ['bulk-member-field-permissions'],
    queryFn: async () => {
      const response = await fetch('/api/roles/bulk-field-permissions?type=member', {
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
    if (fieldOrderSettings?.profileFieldOrder) {
      const orderedKeys = fieldOrderSettings.profileFieldOrder;
      const reordered = orderedKeys
        .map(key => PROFILE_FIELDS.find(f => f.key === key))
        .filter(Boolean);
      const remaining = PROFILE_FIELDS.filter(f => !orderedKeys.includes(f.key));
      setOrderedProfileFields([...reordered, ...remaining]);
    } else {
      setOrderedProfileFields(PROFILE_FIELDS);
    }
  }, [fieldOrderSettings]);

  useEffect(() => {
    if (memberCustomFields.length > 0) {
      if (fieldOrderSettings?.customFieldOrder) {
        const orderedIds = fieldOrderSettings.customFieldOrder;
        const reordered = orderedIds
          .map(id => memberCustomFields.find(f => f.id === id))
          .filter(Boolean);
        const remaining = memberCustomFields.filter(f => !orderedIds.includes(f.id));
        setOrderedCustomFields([...reordered, ...remaining]);
      } else {
        setOrderedCustomFields([...memberCustomFields].sort((a, b) => (a.display_order || 0) - (b.display_order || 0)));
      }
    } else {
      setOrderedCustomFields([]);
    }
  }, [memberCustomFields, fieldOrderSettings]);

  const saveOrderMutation = useMutation({
    mutationFn: async ({ profileFieldOrder, customFieldOrder }) => {
      const settings = await base44.entities.SystemSettings.list({
        filter: { setting_key: 'member_field_order' }
      });
      const orderData = JSON.stringify({ profileFieldOrder, customFieldOrder });
      if (settings && settings.length > 0) {
        await base44.entities.SystemSettings.update(settings[0].id, { setting_value: orderData });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'member_field_order',
          setting_value: orderData,
          description: 'Field display order for About Me page'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-field-order-settings'] });
    }
  });

  const updatePermissionsMutation = useMutation({
    mutationFn: async (permsToSave) => {
      const response = await fetch('/api/roles/bulk-field-permissions?type=member', {
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
      queryClient.invalidateQueries({ queryKey: ['bulk-member-field-permissions'] });
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
      ...PROFILE_FIELDS.map(f => f.key),
      ...memberCustomFields.map(f => f.id)
    ];
    setPermissionsByRole(prev => {
      const rolePerms = {};
      allFieldKeys.forEach(k => { rolePerms[k] = newPerm; });
      return { ...prev, [roleId]: rolePerms };
    });
    setChangedRoleIds(prev => new Set(prev).add(roleId));
    setHasChanges(true);
  }, [memberCustomFields]);

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

    if (type === 'PROFILE_FIELDS') {
      const newFields = Array.from(orderedProfileFields);
      const [removed] = newFields.splice(source.index, 1);
      newFields.splice(destination.index, 0, removed);
      setOrderedProfileFields(newFields);
      saveOrderMutation.mutate({
        profileFieldOrder: newFields.map(f => f.key),
        customFieldOrder: orderedCustomFields.map(f => f.id)
      });
      toast.success('Field order updated');
    } else if (type === 'CUSTOM_FIELDS') {
      const newFields = Array.from(orderedCustomFields);
      const [removed] = newFields.splice(source.index, 1);
      newFields.splice(destination.index, 0, removed);
      setOrderedCustomFields(newFields);
      saveOrderMutation.mutate({
        profileFieldOrder: orderedProfileFields.map(f => f.key),
        customFieldOrder: newFields.map(f => f.id)
      });
      toast.success('Field order updated');
    }
  };

  const fieldGroups = [
    { label: 'Header Fields', fields: HEADER_FIELDS },
    { label: 'Profile Fields', fields: orderedProfileFields },
    ...(orderedCustomFields.length > 0
      ? [{ label: 'Custom Member Fields', fields: orderedCustomFields.map(f => ({ key: f.id, label: f.label, description: `${f.field_type} field` })) }]
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
            <User className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900" data-testid="text-page-title">
              Member Preferences
            </h1>
          </div>
          <p className="text-slate-600">
            Configure field permissions across all roles and manage field display order for the About Me page.
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
            <TabsTrigger value="join" data-testid="tab-join">
              <Link2 className="w-4 h-4 mr-1.5" />
              Join
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
                  isLoading={permissionsLoading || rolesLoading || !memberCustomFields}
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="field-order">
            <DragDropContext onDragEnd={handleDragEnd}>
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Profile Fields</CardTitle>
                    <CardDescription>
                      Drag to reorder these fields in the profile details section. Header fields (First Name, Last Name, Profile Photo) are fixed.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Droppable droppableId="profile-fields" type="PROFILE_FIELDS">
                      {(provided) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.droppableProps}
                          className="space-y-2"
                        >
                          {orderedProfileFields.map((field, index) => (
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
                      <CardTitle>Custom Member Fields</CardTitle>
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

          <TabsContent value="join">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Link2 className="w-5 h-5" />
                  Member Join Form
                </CardTitle>
                <CardDescription>
                  Choose a form to use as the public joining form. The link can be shared with prospective members and is shown on each organisation's Membership tab, prefilled with that organisation. You can also choose a different form per Organisation Type — the default is used as a fallback.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2 max-w-xl">
                  <label className="text-sm font-medium" htmlFor="select-join-form">Default joining form</label>
                  {(formsLoading || joinFormSettingLoading) ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading forms...
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Select
                        value={selectedJoinFormId}
                        onValueChange={(val) => setSelectedJoinFormId(val)}
                      >
                        <SelectTrigger id="select-join-form" className="flex-1" data-testid="select-join-form">
                          <SelectValue placeholder="Select a form..." />
                        </SelectTrigger>
                        <SelectContent>
                          {allForms.length === 0 ? (
                            <div className="px-2 py-3 text-sm text-muted-foreground">No forms available</div>
                          ) : (
                            allForms.map(form => (
                              <SelectItem key={form.id} value={form.id} data-testid={`option-join-form-${form.id}`}>
                                {form.title || form.slug}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      <Button
                        onClick={() => saveJoinFormMutation.mutate(selectedJoinFormId)}
                        disabled={
                          !selectedJoinFormId ||
                          saveJoinFormMutation.isPending ||
                          selectedJoinFormId === joinFormSetting?.value?.id
                        }
                        data-testid="button-save-join-form"
                      >
                        {saveJoinFormMutation.isPending ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Save className="w-4 h-4 mr-2" />
                        )}
                        Save
                      </Button>
                    </div>
                  )}
                  {joinFormSetting?.value?.slug && (
                    <p className="text-sm text-muted-foreground" data-testid="text-current-join-form">
                      Current default join form slug: <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{joinFormSetting.value.slug}</code>
                    </p>
                  )}
                </div>

                <div className="border-t pt-4 space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold" data-testid="heading-per-org-type-join-forms">Per Organisation Type</h3>
                    <p className="text-xs text-muted-foreground">
                      Override the default join form for specific Organisation Types. Leaving an Organisation Type set to "Use default" will fall back to the default form above.
                    </p>
                  </div>
                  {(orgScopedFieldsLoading || joinFormsByOrgTypeSettingLoading || formsLoading) ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading Organisation Types...
                    </div>
                  ) : !orgTypeField ? (
                    <div className="text-sm text-muted-foreground" data-testid="text-no-org-type-field">
                      No <code className="text-xs bg-muted px-1.5 py-0.5 rounded">org_type</code> preference field is defined yet. Define one in your organisation custom fields to enable per-type join forms.
                    </div>
                  ) : orgTypeOptions.length === 0 ? (
                    <div className="text-sm text-muted-foreground" data-testid="text-no-org-type-options">
                      The <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{orgTypeField.name}</code> field has no options configured.
                    </div>
                  ) : (
                    <div className="space-y-3 max-w-xl">
                      {orgTypeOptions.map(opt => {
                        const current = joinFormsByOrgType?.[opt.value]?.id || '';
                        return (
                          <div key={opt.value} className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-2 items-center">
                            <label
                              className="text-sm"
                              htmlFor={`select-join-form-${opt.value}`}
                              data-testid={`label-join-form-org-type-${opt.value}`}
                            >
                              {opt.label}
                            </label>
                            <Select
                              value={current || '__default__'}
                              onValueChange={(val) => handleSelectJoinFormForOrgType(opt.value, val)}
                            >
                              <SelectTrigger
                                id={`select-join-form-${opt.value}`}
                                className="flex-1"
                                data-testid={`select-join-form-org-type-${opt.value}`}
                              >
                                <SelectValue placeholder="Use default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__default__" data-testid={`option-join-form-default-${opt.value}`}>
                                  Use default
                                </SelectItem>
                                {allForms.map(form => (
                                  <SelectItem
                                    key={form.id}
                                    value={form.id}
                                    data-testid={`option-join-form-${opt.value}-${form.id}`}
                                  >
                                    {form.title || form.slug}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        );
                      })}
                      <div className="flex justify-end">
                        <Button
                          onClick={() => saveJoinFormsByOrgTypeMutation.mutate(joinFormsByOrgType)}
                          disabled={!perTypeMappingDirty || saveJoinFormsByOrgTypeMutation.isPending}
                          data-testid="button-save-join-forms-by-org-type"
                        >
                          {saveJoinFormsByOrgTypeMutation.isPending ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Save className="w-4 h-4 mr-2" />
                          )}
                          Save per-type forms
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
