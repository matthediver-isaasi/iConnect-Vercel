import { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Save, Users, GripVertical, CreditCard, Eye, Shield } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { CORE_FIELDS, normalizeFieldVisibility } from "@/utils/directorySettings";

function migrateSettings(raw) {
  const migrated = { field_order: raw.field_order || [], custom_fields: {}, visible_role_ids: raw.visible_role_ids || [] };

  for (const cf of CORE_FIELDS) {
    const val = raw[cf.key];
    const normalized = normalizeFieldVisibility(val);
    if (cf.backOnly) {
      normalized.front = false;
    }
    migrated[cf.key] = normalized;
  }

  if (raw.custom_fields) {
    for (const [id, val] of Object.entries(raw.custom_fields)) {
      migrated.custom_fields[id] = normalizeFieldVisibility(val);
    }
  }

  return migrated;
}

function buildDefaultFieldOrder(directoryFields) {
  const order = CORE_FIELDS.map(f => f.key);
  for (const f of directoryFields) {
    order.push(`custom:${f.id}`);
  }
  return order;
}

export default function MemberDirectorySettingsPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [settings, setSettings] = useState(null);
  const queryClient = useQueryClient();

  const { data: displaySettings, isLoading } = useQuery({
    queryKey: ['memberDirectoryDisplay'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'member_directory_display');

      if (setting?.setting_value) {
        try {
          const parsed = JSON.parse(setting.setting_value);
          return { id: setting.id, ...parsed };
        } catch (e) {
          console.error('Failed to parse member directory settings:', e);
        }
      }

      return {
        show_profile_photo: { front: true, back: true },
        show_events: { front: true, back: true },
        show_articles: { front: true, back: true },
        show_organization: { front: true, back: true },
        show_job_title: { front: true, back: true },
        show_linkedin: { front: true, back: true },
        show_awards: { front: true, back: true },
        show_bio_in_popup: { front: false, back: true },
        custom_fields: {},
        field_order: []
      };
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: roles = [], isLoading: isLoadingRoles } = useQuery({
    queryKey: ['roles-for-directory-settings'],
    queryFn: async () => {
      const allRoles = await base44.entities.Role.list();
      return (allRoles || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: directoryFields = [], isLoading: isLoadingFields } = useQuery({
    queryKey: ['member-directory-fields'],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'member' },
          sort: { display_order: 'asc' }
        });
        const isVisibleInMain = (field) => {
          if (field.directory_visibility) {
            let vis = field.directory_visibility;
            if (typeof vis === 'string') {
              try { vis = JSON.parse(vis); } catch { vis = []; }
            }
            if (Array.isArray(vis)) return vis.includes('main');
          }
          return field.show_in_member_directory !== false;
        };
        return (fields || []).filter(f => f.entity_scope === 'member' && isVisibleInMain(f));
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          const isVisibleInMain = (field) => {
            if (field.directory_visibility) {
              let vis = field.directory_visibility;
              if (typeof vis === 'string') {
                try { vis = JSON.parse(vis); } catch { vis = []; }
              }
              if (Array.isArray(vis)) return vis.includes('main');
            }
            return field.show_in_member_directory !== false;
          };
          return (allFields || []).filter(f =>
            (!f.entity_scope || f.entity_scope === 'member') && isVisibleInMain(f)
          );
        } catch {
          return [];
        }
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_MemberDirectorySettings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  useEffect(() => {
    if (displaySettings && directoryFields !== undefined) {
      const migrated = migrateSettings(displaySettings);
      if (!migrated.field_order || migrated.field_order.length === 0) {
        migrated.field_order = buildDefaultFieldOrder(directoryFields);
      } else {
        const existingSet = new Set(migrated.field_order);
        for (const cf of CORE_FIELDS) {
          if (!existingSet.has(cf.key)) {
            migrated.field_order.push(cf.key);
          }
        }
        for (const f of directoryFields) {
          const customKey = `custom:${f.id}`;
          if (!existingSet.has(customKey)) {
            migrated.field_order.push(customKey);
          }
        }
        migrated.field_order = migrated.field_order.filter(k => {
          if (k.startsWith('custom:')) {
            return directoryFields.some(f => f.id === k.replace('custom:', ''));
          }
          return CORE_FIELDS.some(cf => cf.key === k);
        });
      }
      migrated.id = displaySettings.id;
      setSettings(migrated);
    }
  }, [displaySettings, directoryFields]);

  const saveSettingsMutation = useMutation({
    mutationFn: async (newSettings) => {
      const { id, ...settingsToSave } = newSettings;
      const settingValue = JSON.stringify(settingsToSave);

      if (id) {
        return await base44.entities.SystemSettings.update(id, {
          setting_value: settingValue
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'member_directory_display',
          setting_value: settingValue,
          description: 'Controls which fields are displayed on Member Directory cards'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memberDirectoryDisplay'] });
      toast.success('Settings saved successfully');
    },
    onError: (error) => {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save settings');
    }
  });

  const handleToggle = useCallback((key, side) => {
    setSettings(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        [side]: !prev[key]?.[side]
      }
    }));
  }, []);

  const handleCustomFieldToggle = useCallback((fieldId, side) => {
    setSettings(prev => {
      const current = prev.custom_fields[fieldId] || { front: true, back: true };
      return {
        ...prev,
        custom_fields: {
          ...prev.custom_fields,
          [fieldId]: {
            ...current,
            [side]: !current[side]
          }
        }
      };
    });
  }, []);

  const handleDragEnd = useCallback((result) => {
    if (!result.destination) return;
    const srcIdx = result.source.index;
    const destIdx = result.destination.index;
    if (srcIdx === destIdx) return;

    setSettings(prev => {
      const newOrder = [...prev.field_order];
      const [moved] = newOrder.splice(srcIdx, 1);
      newOrder.splice(destIdx, 0, moved);
      return { ...prev, field_order: newOrder };
    });
  }, []);

  const handleSave = () => {
    saveSettingsMutation.mutate(settings);
  };

  const handleRoleToggle = useCallback((roleId) => {
    setSettings(prev => {
      const current = prev.visible_role_ids || [];
      const next = current.includes(roleId)
        ? current.filter(id => id !== roleId)
        : [...current, roleId];
      return { ...prev, visible_role_ids: next };
    });
  }, []);

  if (!accessChecked || isLoading || isLoadingFields || isLoadingRoles || !settings) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const coreFieldMap = Object.fromEntries(CORE_FIELDS.map(f => [f.key, f]));
  const customFieldMap = Object.fromEntries(directoryFields.map(f => [`custom:${f.id}`, f]));

  function getFieldTypeLabel(field) {
    const typeMap = {
      dropdown: 'Dropdown', picklist: 'Picklist', number: 'Number',
      date: 'Date', boolean: 'Yes/No', text: 'Text', email: 'Email',
      url: 'URL', multiline_text: 'Multi-line Text'
    };
    return typeMap[field.field_type] || 'Text';
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Users className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
              Member Directory Settings
            </h1>
          </div>
          <p className="text-slate-600">Configure what information displays on member directory cards and detail views. Drag to reorder.</p>
        </div>

        <Card className="border-slate-200 mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Visible Roles
            </CardTitle>
            <CardDescription>
              Select which roles appear in the member directory. If none are selected, all members are shown.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {roles.length === 0 ? (
              <p className="text-sm text-slate-500">No roles found.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {roles.map(role => {
                  const isChecked = (settings.visible_role_ids || []).includes(role.id);
                  return (
                    <label
                      key={role.id}
                      className="flex items-center gap-2.5 p-2.5 rounded-lg border border-slate-200 bg-slate-50 cursor-pointer hover-elevate"
                      data-testid={`checkbox-role-${role.id}`}
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => handleRoleToggle(role.id)}
                      />
                      <span className="text-sm font-medium text-slate-700 truncate">{role.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {(settings.visible_role_ids || []).length > 0 && (
              <p className="text-xs text-slate-500 mt-3">
                {settings.visible_role_ids.length} role{settings.visible_role_ids.length !== 1 ? 's' : ''} selected
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-200">
          <CardHeader>
            <CardTitle>Field Visibility & Order</CardTitle>
            <CardDescription>
              Choose which fields appear on the member card (front) and the detail popup (back). Drag rows to reorder.
            </CardDescription>
            <div className="flex items-center gap-6 pt-3 text-xs font-medium text-slate-500 uppercase tracking-wide">
              <div className="flex-1 pl-10">Field</div>
              <div className="w-20 text-center flex items-center justify-center gap-1">
                <CreditCard className="w-3.5 h-3.5" />
                Card
              </div>
              <div className="w-20 text-center flex items-center justify-center gap-1">
                <Eye className="w-3.5 h-3.5" />
                Detail
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="directory-fields">
                {(provided) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="space-y-2"
                  >
                    {settings.field_order.map((fieldKey, index) => {
                      const isCustom = fieldKey.startsWith('custom:');
                      const coreField = coreFieldMap[fieldKey];
                      const customField = customFieldMap[fieldKey];

                      if (!coreField && !customField) return null;

                      const label = coreField ? coreField.label : customField.label;
                      const description = coreField
                        ? coreField.description
                        : `${getFieldTypeLabel(customField)} field`;
                      const isBackOnly = coreField?.backOnly;

                      let frontChecked, backChecked;
                      if (isCustom) {
                        const vis = settings.custom_fields[customField.id] || { front: true, back: true };
                        frontChecked = vis.front !== false;
                        backChecked = vis.back !== false;
                      } else {
                        const vis = settings[fieldKey] || { front: true, back: true };
                        frontChecked = isBackOnly ? false : vis.front !== false;
                        backChecked = vis.back !== false;
                      }

                      return (
                        <Draggable key={fieldKey} draggableId={fieldKey} index={index}>
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              className={`flex items-center gap-4 p-3 rounded-lg border ${
                                snapshot.isDragging
                                  ? 'border-blue-400 bg-blue-50 shadow-lg'
                                  : 'border-slate-200 bg-slate-50'
                              } ${isCustom ? '' : ''}`}
                              data-testid={`row-field-${fieldKey}`}
                            >
                              <div
                                {...provided.dragHandleProps}
                                className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600"
                                data-testid={`drag-handle-${fieldKey}`}
                              >
                                <GripVertical className="w-4 h-4" />
                              </div>

                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm text-slate-800 truncate">
                                  {label}
                                  {isCustom && (
                                    <span className="ml-2 text-xs text-blue-600 font-normal">Custom</span>
                                  )}
                                </div>
                                <p className="text-xs text-slate-500 truncate">{description}</p>
                              </div>

                              <div className="w-20 flex justify-center">
                                {isBackOnly ? (
                                  <span className="text-xs text-slate-400">N/A</span>
                                ) : (
                                  <Switch
                                    checked={frontChecked}
                                    onCheckedChange={() =>
                                      isCustom
                                        ? handleCustomFieldToggle(customField.id, 'front')
                                        : handleToggle(fieldKey, 'front')
                                    }
                                    data-testid={`switch-front-${fieldKey}`}
                                  />
                                )}
                              </div>

                              <div className="w-20 flex justify-center">
                                <Switch
                                  checked={backChecked}
                                  onCheckedChange={() =>
                                    isCustom
                                      ? handleCustomFieldToggle(customField.id, 'back')
                                      : handleToggle(fieldKey, 'back')
                                  }
                                  data-testid={`switch-back-${fieldKey}`}
                                />
                              </div>
                            </div>
                          )}
                        </Draggable>
                      );
                    })}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>
          </CardContent>
        </Card>

        <div className="flex justify-end pt-6">
          <Button
            onClick={handleSave}
            disabled={saveSettingsMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700"
            data-testid="button-save-settings"
          >
            {saveSettingsMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Settings
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
