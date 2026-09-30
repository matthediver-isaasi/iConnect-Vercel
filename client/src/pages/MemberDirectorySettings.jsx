import { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Save, Users, GripVertical, CreditCard, Eye, Shield } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { CORE_FIELDS, normalizeFieldVisibility, reorderCoreFieldOrder, MEMBER_BACK_DEFAULT_ORDER, resolveBackFieldOrder, getOrderedCustomFields, isCustomFieldVisibleOnBack, isVisibleOnBack } from "@/utils/directorySettings";
import BackFieldOrderList from "@/components/directory/BackFieldOrderList";

function migrateSettings(raw) {
  const migrated = { field_order: raw.field_order || [], back_field_order: Array.isArray(raw.back_field_order) ? raw.back_field_order : [], custom_fields: {}, visible_role_ids: raw.visible_role_ids || [], custom_fields_label: typeof raw.custom_fields_label === 'string' ? raw.custom_fields_label : '' };

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

function buildDefaultFieldOrder() {
  return CORE_FIELDS.map(f => f.key);
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

  const { data: memberCustomFields = [] } = useQuery({
    queryKey: ['member-custom-fields-for-directory-settings'],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'member' },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => !f.entity_scope || f.entity_scope === 'member');
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({ filter: { is_active: true } });
          return (allFields || []).filter(f => !f.entity_scope || f.entity_scope === 'member');
        } catch {
          return [];
        }
      }
    },
    staleTime: 60 * 1000,
  });

  const { data: roles = [], isLoading: isLoadingRoles } = useQuery({
    queryKey: ['roles-for-directory-settings'],
    queryFn: async () => {
      const allRoles = await base44.entities.Role.list();
      return (allRoles || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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
    if (displaySettings) {
      const migrated = migrateSettings(displaySettings);
      if (!migrated.field_order || migrated.field_order.length === 0) {
        migrated.field_order = buildDefaultFieldOrder();
      } else {
        const existingSet = new Set(migrated.field_order);
        for (const cf of CORE_FIELDS) {
          if (!existingSet.has(cf.key)) {
            migrated.field_order.push(cf.key);
          }
        }
      }
      migrated.id = displaySettings.id;
      setSettings(migrated);
    }
  }, [displaySettings]);

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

  const handleDragEnd = useCallback((result) => {
    if (!result.destination) return;
    const srcIdx = result.source.index;
    const destIdx = result.destination.index;
    if (srcIdx === destIdx) return;

    setSettings(prev => ({
      ...prev,
      // Indices come from the rendered CORE-only list; legacy `custom:*`
      // keys are preserved in field_order but hidden.
      field_order: reorderCoreFieldOrder(prev.field_order, srcIdx, destIdx),
    }));
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

  if (!accessChecked || isLoading || isLoadingRoles || !settings) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const coreFieldMap = Object.fromEntries(CORE_FIELDS.map(f => [f.key, f]));

  // Unified back/detail order: core fields + member custom fields interleaved.
  const orderedCustoms = getOrderedCustomFields(memberCustomFields, settings);
  const resolvedBackOrder = resolveBackFieldOrder({
    directoryOrder: null,
    tenantOrder: settings.back_field_order,
    defaultOrder: MEMBER_BACK_DEFAULT_ORDER,
    customFields: orderedCustoms,
  });
  const backOrderItems = {};
  for (const cf of CORE_FIELDS) {
    backOrderItems[cf.key] = {
      label: cf.label,
      description: cf.description,
      hidden: !isVisibleOnBack(settings, cf.key),
    };
  }
  for (const f of memberCustomFields) {
    backOrderItems[`custom:${f.id}`] = {
      label: f.label,
      isCustom: true,
      hidden: !isCustomFieldVisibleOnBack(settings, f.id),
    };
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
              Choose which built-in fields appear on the member card (front) and the detail popup (back). Drag rows to reorder.
              Custom fields are now configured per directory on the{' '}
              <a href={createPageUrl('CustomFieldsAdmin')} className="text-blue-600 underline" data-testid="link-custom-fields-admin">
                Custom Fields
              </a>{' '}
              page (edit a field to set its front/back placement and order for each directory).
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
                    {settings.field_order.filter(k => coreFieldMap[k]).map((fieldKey, index) => {
                      const coreField = coreFieldMap[fieldKey];

                      const label = coreField.label;
                      const description = coreField.description;
                      const isBackOnly = coreField?.backOnly;

                      const vis = settings[fieldKey] || { front: true, back: true };
                      const frontChecked = isBackOnly ? false : vis.front !== false;
                      const backChecked = vis.back !== false;

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
                              }`}
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
                                </div>
                                <p className="text-xs text-slate-500 truncate">{description}</p>
                              </div>

                              <div className="w-20 flex justify-center">
                                {isBackOnly ? (
                                  <span className="text-xs text-slate-400">N/A</span>
                                ) : (
                                  <Switch
                                    checked={frontChecked}
                                    onCheckedChange={() => handleToggle(fieldKey, 'front')}
                                    data-testid={`switch-front-${fieldKey}`}
                                  />
                                )}
                              </div>

                              <div className="w-20 flex justify-center">
                                <Switch
                                  checked={backChecked}
                                  onCheckedChange={() => handleToggle(fieldKey, 'back')}
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

        <Card className="border-slate-200 mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="w-5 h-5" />
              Detail View Order
            </CardTitle>
            <CardDescription>
              Arrange the order fields appear in the member detail (back-of-card) view. Core fields and custom
              fields share one sequence. This is the tenant-wide default; individual dynamic directories can
              override it in Dynamic Directory Management. Visibility toggles above (and per-directory custom
              field settings) still control what shows — fields marked "Hidden" keep their place but don't render.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BackFieldOrderList
              order={resolvedBackOrder}
              items={backOrderItems}
              droppableId="member-back-order"
              onChange={(next) => setSettings(prev => ({ ...prev, back_field_order: next }))}
            />
          </CardContent>
        </Card>

        <Card className="border-slate-200 mt-6">
          <CardHeader>
            <CardTitle>Custom Fields Section Label</CardTitle>
            <CardDescription>
              The heading shown above the custom-field grid in the member detail (back-of-card) view.
              Leave blank to use the default "Additional Information". Individual dynamic directories
              can override this in Dynamic Directory Management.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-w-md">
              <Label htmlFor="custom-fields-label">Section label</Label>
              <Input
                id="custom-fields-label"
                value={settings.custom_fields_label || ''}
                onChange={(e) => setSettings(prev => ({ ...prev, custom_fields_label: e.target.value }))}
                placeholder="Additional Information"
                data-testid="input-custom-fields-label"
              />
            </div>
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
