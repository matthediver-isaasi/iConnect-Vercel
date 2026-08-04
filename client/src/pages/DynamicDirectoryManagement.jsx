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
import { FolderTree, Loader2, Plus, Pencil, Trash2, User, Building2, Filter, Shield, Mail } from "lucide-react";
import { toast } from "sonner";
import SEOSettings from "@/components/blog/SEOSettings";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { getDirectoryFilterOptions, isFieldInDirectory, CORE_FIELDS, MEMBER_BACK_DEFAULT_ORDER, ORG_BACK_CORE_ITEMS, ORG_BACK_DEFAULT_ORDER, resolveBackFieldOrder, enrichFieldForDirectory, getDirectoryOrderedFields } from "@/utils/directorySettings";
import BackFieldOrderList from "@/components/directory/BackFieldOrderList";

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
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
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
  const [allowedRoleIds, setAllowedRoleIds] = useState([]);
  const [emailSourceType, setEmailSourceType] = useState('');
  const [emailSourceField, setEmailSourceField] = useState('');
  const [seoTitle, setSeoTitle] = useState('');
  const [seoDescription, setSeoDescription] = useState('');
  const [ogImageUrl, setOgImageUrl] = useState('');
  const [showMembersOnCardBack, setShowMembersOnCardBack] = useState(true);
  // null = use tenant default order; array = per-directory override
  const [backFieldOrder, setBackFieldOrder] = useState(null);
  // Per-directory core-field visibility overrides: { key: { front?, back? } }.
  // Absent key/side = inherit the tenant-global directory settings.
  const [coreFieldVisibility, setCoreFieldVisibility] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_DynamicDirectoryManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

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
        return (fields || []).filter(f => f.field_type === 'picklist' || f.field_type === 'dropdown' || f.field_type === 'boolean');
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
          (f.field_type === 'picklist' || f.field_type === 'dropdown' || f.field_type === 'boolean') && f.is_filterable
        );
      } catch (error) {
        console.error('Failed to fetch filterable fields:', error);
        return [];
      }
    },
    enabled: isDialogOpen
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['/api/entities/Role'],
    queryFn: async () => {
      try {
        const rolesList = await base44.entities.Role.list({
          sort: { name: 'asc' }
        });
        return rolesList || [];
      } catch (error) {
        console.error('Failed to fetch roles:', error);
        return [];
      }
    },
    enabled: isDialogOpen
  });

  const { data: emailCustomFields = [] } = useQuery({
    queryKey: ['/api/entities/PreferenceField/email-sources', entityType],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { entity_scope: 'member', is_active: true },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f =>
          f.entity_scope === 'member' &&
          (f.field_type === 'text' || f.field_type === 'email')
        );
      } catch {
        return [];
      }
    },
    enabled: isDialogOpen && entityType === 'member'
  });

  // Tenant-wide default back-of-card orders + this directory's custom fields,
  // for the per-directory back order override editor.
  const { data: tenantBackOrderDefaults } = useQuery({
    queryKey: ['tenant-back-order-defaults'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      let memberOrder = null;
      let memberSettings = null;
      const memberSetting = allSettings.find(s => s.setting_key === 'member_directory_display');
      if (memberSetting?.setting_value) {
        try {
          memberSettings = JSON.parse(memberSetting.setting_value);
          if (Array.isArray(memberSettings?.back_field_order)) memberOrder = memberSettings.back_field_order;
        } catch {}
      }
      let orgOrder = null;
      const orgSetting = allSettings.find(s => s.setting_key === 'org_directory_back_field_order');
      if (orgSetting?.setting_value) {
        try {
          const parsed = JSON.parse(orgSetting.setting_value);
          if (Array.isArray(parsed)) orgOrder = parsed;
        } catch {}
      }
      return { memberOrder, orgOrder, memberSettings };
    },
    enabled: isDialogOpen,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: backOrderCustomFields = [] } = useQuery({
    queryKey: ['back-order-custom-fields', entityType, editingDirectory?.id],
    queryFn: async () => {
      const dirId = editingDirectory?.id;
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: entityType },
          sort: { display_order: 'asc' }
        });
        const scoped = (fields || []).filter(f =>
          (entityType === 'member' ? (!f.entity_scope || f.entity_scope === 'member') : f.entity_scope === 'organization')
        );
        return scoped
          .filter(f => isFieldInDirectory(f, dirId))
          .map(f => enrichFieldForDirectory(f, dirId));
      } catch {
        return [];
      }
    },
    enabled: isDialogOpen && !!editingDirectory?.id,
  });

  const backOrderDefaultOrder = entityType === 'organization' ? ORG_BACK_DEFAULT_ORDER : MEMBER_BACK_DEFAULT_ORDER;
  const backOrderTenantOrder = entityType === 'organization'
    ? tenantBackOrderDefaults?.orgOrder
    : tenantBackOrderDefaults?.memberOrder;
  const backOrderLegacyFields = entityType === 'organization'
    ? getDirectoryOrderedFields(backOrderCustomFields, null)
    : getDirectoryOrderedFields(backOrderCustomFields, tenantBackOrderDefaults?.memberSettings);
  const resolvedDialogBackOrder = resolveBackFieldOrder({
    directoryOrder: backFieldOrder,
    tenantOrder: backOrderTenantOrder,
    defaultOrder: backOrderDefaultOrder,
    customFields: backOrderLegacyFields,
  });
  const dialogBackOrderItems = (() => {
    const items = {};
    if (entityType === 'organization') {
      for (const core of ORG_BACK_CORE_ITEMS) items[core.key] = { label: core.label, description: core.description };
    } else {
      for (const cf of CORE_FIELDS) items[cf.key] = { label: cf.label, description: cf.description };
    }
    for (const f of backOrderLegacyFields) {
      items[`custom:${f.id}`] = { label: f._displayLabel || f.label, isCustom: true };
    }
    return items;
  })();

  // --- Per-directory core-field visibility (tri-state: inherit/show/hide) ---
  const coreVisibilityMeta = entityType === 'organization'
    ? ORG_BACK_CORE_ITEMS.map(c => ({ key: c.key, sides: ['back'] }))
    : CORE_FIELDS.map(c => ({ key: c.key, sides: c.backOnly ? ['back'] : ['front', 'back'] }));
  const coreVisibilityMetaByKey = Object.fromEntries(coreVisibilityMeta.map(m => [m.key, m]));

  const getCoreVisState = (key, side) => {
    const ov = coreFieldVisibility?.[key];
    if (ov && typeof ov === 'object' && typeof ov[side] === 'boolean') return ov[side] ? 'show' : 'hide';
    return 'inherit';
  };
  const setCoreVisState = (key, side, val) => {
    setCoreFieldVisibility(prev => {
      const next = { ...(prev || {}) };
      const entry = { ...(next[key] && typeof next[key] === 'object' ? next[key] : {}) };
      if (val === 'inherit') delete entry[side];
      else entry[side] = val === 'show';
      if (typeof entry.front !== 'boolean' && typeof entry.back !== 'boolean') delete next[key];
      else next[key] = entry;
      return Object.keys(next).length > 0 ? next : null;
    });
  };

  const renderCoreVisibilityControls = (key, item) => {
    if (item.isCustom) return null;
    const meta = coreVisibilityMetaByKey[key];
    if (!meta) return null;
    const sideLabel = (side) => {
      if (entityType === 'organization') return 'Popup';
      return side === 'front' ? 'Front' : 'Back';
    };
    return (
      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {meta.sides.map(side => {
          const state = getCoreVisState(key, side);
          return (
            <div key={side} className="flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wide text-slate-400">{sideLabel(side)}</span>
              <select
                className={`h-7 rounded-md border text-xs px-1 bg-white ${state === 'inherit' ? 'text-slate-500 border-slate-200' : 'text-slate-800 border-blue-300'}`}
                value={state}
                onChange={(e) => setCoreVisState(key, side, e.target.value)}
                data-testid={`select-core-vis-${key}-${side}`}
              >
                <option value="inherit">Inherit</option>
                <option value="show">Show</option>
                <option value="hide">Hide</option>
              </select>
            </div>
          );
        })}
      </div>
    );
  };

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
    setSelectedFilterFields([]);  // Default to empty array for new directories (no filters)
    setAllowedRoleIds([]);
    setEmailSourceType('');
    setEmailSourceField('');
    setSeoTitle('');
    setSeoDescription('');
    setOgImageUrl('');
    setShowMembersOnCardBack(true);
    setBackFieldOrder(null);
    setCoreFieldVisibility(null);
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
    setAllowedRoleIds(directory.allowed_role_ids || []);
    setEmailSourceType(directory.email_source_type || '');
    setEmailSourceField(directory.email_source_field || '');
    setSeoTitle(directory.seo_title || '');
    setSeoDescription(directory.seo_description || '');
    setOgImageUrl(directory.og_image_url || '');
    setShowMembersOnCardBack(directory.show_members_on_card_back !== false);
    setBackFieldOrder(Array.isArray(directory.back_field_order) && directory.back_field_order.length > 0
      ? directory.back_field_order
      : null);
    setCoreFieldVisibility(
      directory.core_field_visibility && typeof directory.core_field_visibility === 'object' && !Array.isArray(directory.core_field_visibility) && Object.keys(directory.core_field_visibility).length > 0
        ? directory.core_field_visibility
        : null
    );
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
    setSelectedFilterFields([]);  // Reset to empty array when changing entity type
  };

  const handleToggleFilterField = (fieldId) => {
    setSelectedFilterFields(prev => {
      const currentList = prev || [];
      if (currentList.includes(fieldId)) {
        return currentList.filter(id => id !== fieldId);
      } else {
        return [...currentList, fieldId];
      }
    });
  };

  const handleFilterFieldChange = (value) => {
    setFilterFieldId(value);
    setFilterValue('');
  };

  const handleToggleRole = (roleId) => {
    setAllowedRoleIds(prev => {
      if (prev.includes(roleId)) {
        return prev.filter(id => id !== roleId);
      } else {
        return [...prev, roleId];
      }
    });
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
      is_active: isActive,
      selected_filter_fields: selectedFilterFields || [],  // Always include, defaults to empty array
      allowed_role_ids: allowedRoleIds,
      email_source_type: emailSourceType || null,
      email_source_field: emailSourceField || null,
      seo_title: seoTitle || null,
      seo_description: seoDescription || null,
      og_image_url: ogImageUrl || null,
      show_members_on_card_back: entityType === 'organization' ? showMembersOnCardBack : true,
      back_field_order: (Array.isArray(backFieldOrder) && backFieldOrder.length > 0) ? backFieldOrder : null,
      core_field_visibility: (coreFieldVisibility && Object.keys(coreFieldVisibility).length > 0) ? coreFieldVisibility : null
    };

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
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" data-testid="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
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
                <li>Only picklist, dropdown and boolean custom fields can be used as filters</li>
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
                      No picklist/dropdown/boolean fields available
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
              <p className="text-xs text-slate-500">Only picklist, dropdown and boolean fields are available</p>
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
                  {getDirectoryFilterOptions(selectedField).map((option) => (
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
                  (picklist, dropdown or boolean type) with "Is Filterable" enabled in Preference Fields settings.
                  The primary filter field selected above is excluded from this list.
                </p>
              ) : (
                <>
                  <p className="text-xs text-slate-500">
                    {(selectedFilterFields?.length || 0) === 0
                      ? "No filters selected - no additional filter dropdowns will be shown on this directory."
                      : "Only the selected fields will appear as filter dropdowns on this directory."}
                  </p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {availableFilterFields.map((field) => (
                      <div key={field.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`filter-field-${field.id}`}
                          checked={(selectedFilterFields || []).includes(field.id)}
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
                  <p className="text-xs text-blue-600 mt-2">
                    {(selectedFilterFields?.length || 0)} filter{(selectedFilterFields?.length || 0) !== 1 ? 's' : ''} selected
                    {(selectedFilterFields?.length || 0) === 0 && " (no filter dropdowns will show)"}
                  </p>
                </>
              )}
            </div>

            {entityType === 'member' && (
              <div className="space-y-3 p-3 bg-slate-50 rounded-lg border">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-blue-600" />
                  <Label className="font-medium">Email Field for Directory</Label>
                </div>
                <p className="text-xs text-slate-500">
                  Choose which email field to display on member cards and the contact button. Defaults to the member's primary email.
                </p>
                <Select
                  value={emailSourceType && emailSourceField ? `${emailSourceType}:${emailSourceField}` : 'default'}
                  onValueChange={(val) => {
                    if (val === 'default') {
                      setEmailSourceType('');
                      setEmailSourceField('');
                    } else {
                      const [type, ...rest] = val.split(':');
                      setEmailSourceType(type);
                      setEmailSourceField(rest.join(':'));
                    }
                  }}
                  data-testid="select-email-source"
                >
                  <SelectTrigger data-testid="select-email-source-trigger">
                    <SelectValue placeholder="Member Email (Default)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Member Email (Default)</SelectItem>
                    {emailCustomFields.map(field => (
                      <SelectItem key={field.id} value={`custom:${field.id}`}>
                        {field.label} (Custom Field)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {entityType === 'organization' && (
              <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border">
                <div>
                  <Label htmlFor="showMembersOnCardBack" className="cursor-pointer">Show members on card back</Label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    When on, the back of each organisation card lists its members grouped by role. Turn off to hide the members section for this directory.
                  </p>
                </div>
                <Switch
                  id="showMembersOnCardBack"
                  checked={showMembersOnCardBack}
                  onCheckedChange={setShowMembersOnCardBack}
                  data-testid="switch-show-members-on-card-back"
                />
              </div>
            )}

            <div className="space-y-3 p-3 bg-slate-50 rounded-lg border">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="overrideBackOrder" className="cursor-pointer">Custom card back order</Label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {backFieldOrder
                      ? 'This directory uses its own back-of-card field order.'
                      : 'Using the tenant default order from the directory settings pages.'}
                  </p>
                </div>
                <Switch
                  id="overrideBackOrder"
                  checked={!!backFieldOrder}
                  disabled={!editingDirectory}
                  onCheckedChange={(checked) => {
                    setBackFieldOrder(checked ? resolvedDialogBackOrder : null);
                  }}
                  data-testid="switch-override-back-order"
                />
              </div>
              {!editingDirectory && (
                <p className="text-xs text-slate-500">
                  Save the directory first, then edit it to customise the back-of-card order and field visibility.
                </p>
              )}
              {editingDirectory && (
                <>
                  <p className="text-xs text-slate-500">
                    Use the per-field dropdowns to show or hide core fields on this directory only.
                    "Inherit" follows the global directory settings. Hidden fields keep their slot in the order.
                  </p>
                  <BackFieldOrderList
                    order={resolvedDialogBackOrder}
                    items={dialogBackOrderItems}
                    droppableId="dialog-back-order"
                    onChange={setBackFieldOrder}
                    disabled={!backFieldOrder}
                    renderControls={renderCoreVisibilityControls}
                  />
                  {backFieldOrder && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setBackFieldOrder(null)}
                      data-testid="button-reset-back-order"
                    >
                      Reset to tenant default order
                    </Button>
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

            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 space-y-3">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-blue-600" />
                <Label className="font-medium text-blue-900">Role Access Control</Label>
              </div>
              <p className="text-xs text-blue-700">
                Select which roles can view this directory. Leave all unchecked to allow all member roles.
              </p>
              <div className="space-y-2">
                {roles.map((role) => (
                  <div
                    key={role.id}
                    className="flex items-center gap-3 p-2 bg-white rounded hover:bg-blue-50 transition-colors cursor-pointer"
                    onClick={() => handleToggleRole(role.id)}
                    data-testid={`role-access-row-${role.id}`}
                  >
                    <Checkbox
                      id={`role-${role.id}`}
                      checked={allowedRoleIds.includes(role.id)}
                      onCheckedChange={() => handleToggleRole(role.id)}
                      className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                      data-testid={`checkbox-role-${role.id}`}
                    />
                    <Label
                      htmlFor={`role-${role.id}`}
                      className="flex-1 cursor-pointer text-sm"
                    >
                      {role.name}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="px-1">
            <SEOSettings
              seoTitle={seoTitle}
              onSeoTitleChange={setSeoTitle}
              seoDescription={seoDescription}
              onSeoDescriptionChange={setSeoDescription}
              ogImageUrl={ogImageUrl}
              onOgImageUrlChange={setOgImageUrl}
              defaultTitle={name}
            />
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
