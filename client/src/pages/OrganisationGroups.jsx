import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Building2, Plus, Pencil, Trash2, Loader2, Search, Filter, X } from "lucide-react";
import OrganisationGroupDetailView from "@/components/OrganisationGroupDetailView";
import { isOrgAdminColumnVisible, isOrgAdminFilterVisible } from "@/pages/CustomFieldsAdmin";
import { COUNTRIES } from "@/data/countries";

const EMPTY_ARR = [];

const MULTI_VALUE_TYPES = new Set(['picklist', 'list', 'countries']);

function parseStoredValue(field, raw) {
  if (MULTI_VALUE_TYPES.has(field?.field_type) && raw) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(v => String(v).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return raw;
}

/**
 * Render a custom field value as a display string. Returns null if empty.
 *
 * Note: OrganisationGroupDetailView stores country/countries values as
 * country NAMES (not ISO codes). Comparisons and display must use names.
 */
function renderFieldValue(field, value) {
  if (value === undefined || value === null || value === '') return null;
  if (field.field_type === 'boolean') {
    return (value === 'true' || value === true) ? 'Yes' : 'No';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    // Stored as country names already — just join them.
    if (field.field_type === 'countries') {
      return value.join(', ');
    }
    if (field.options?.length) {
      return value.map(v => field.options.find(o => o.value === v)?.label || v).join(', ');
    }
    return value.join(', ');
  }
  // country stored as a name string — display directly.
  if (field.field_type === 'country') {
    return String(value);
  }
  if (field.field_type === 'dropdown' && field.options?.length) {
    return field.options.find(o => o.value === value)?.label || value;
  }
  return String(value);
}

export default function OrganisationGroups() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const [accessChecked, setAccessChecked] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState({ name: "", description: "" });

  // Filter state
  const [nameSearch, setNameSearch] = useState('');
  const [customFieldFilters, setCustomFieldFilters] = useState({});

  // Dedicated RBAC gate for Organisation Groups.
  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("crm.organisation-groups")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  const { data: groups = EMPTY_ARR, isLoading: groupsLoading } = useQuery({
    queryKey: ["/api/entities/OrganizationGroup"],
    enabled: accessChecked,
    queryFn: () => base44.entities.OrganizationGroup.list({ sort: { name: "asc" } }),
  });

  // Organisations, used for per-group counts and the detail listing.
  const { data: orgs = EMPTY_ARR } = useQuery({
    queryKey: ["organisation-groups-orgs"],
    enabled: accessChecked,
    queryFn: () => base44.entities.Organization.list({ sort: { name: "asc" } }),
  });

  // Custom field definitions scoped to organisation groups.
  const { data: customFields = EMPTY_ARR } = useQuery({
    queryKey: ['group-list-custom-fields'],
    enabled: accessChecked,
    queryFn: async () => {
      const fields = await base44.entities.PreferenceField.list({
        filter: { entity_scope: 'organization_group', is_active: true },
        sort: { display_order: 'asc' }
      });
      return (fields || []).filter(f => f.entity_scope === 'organization_group' && f.is_active !== false);
    }
  });

  // All preference values for groups in this tenant.
  // Note: org groups are typically small in number (tens to low hundreds),
  // so fetching all values in one request is acceptable.
  const { data: allGroupValues = EMPTY_ARR } = useQuery({
    queryKey: ['org-groups-all-preference-values'],
    enabled: accessChecked && customFields.length > 0,
    queryFn: async () => {
      const values = await base44.entities.OrganizationGroupPreferenceValue.list({});
      return values || [];
    }
  });

  // Derived: fields to show as columns and as filters.
  const columnFields = useMemo(
    () => customFields.filter(f => isOrgAdminColumnVisible(f)),
    [customFields]
  );
  const filterFields = useMemo(
    () => customFields.filter(f => isOrgAdminFilterVisible(f)),
    [customFields]
  );

  // Map groupId -> fieldId -> parsedValue
  const groupValuesMap = useMemo(() => {
    const map = {};
    for (const v of allGroupValues) {
      if (!v.organization_group_id || !v.field_id) continue;
      if (!map[v.organization_group_id]) map[v.organization_group_id] = {};
      const field = customFields.find(f => f.id === v.field_id);
      map[v.organization_group_id][v.field_id] = parseStoredValue(field, v.value);
    }
    return map;
  }, [allGroupValues, customFields]);

  // Client-side filtering (groups are always few enough for this)
  const filteredGroups = useMemo(() => {
    let result = groups;

    if (nameSearch.trim()) {
      const q = nameSearch.trim().toLowerCase();
      result = result.filter(g =>
        g.name?.toLowerCase().includes(q) ||
        g.description?.toLowerCase().includes(q)
      );
    }

    for (const [fieldId, filterValue] of Object.entries(customFieldFilters)) {
      if (!filterValue) continue;
      if (Array.isArray(filterValue) && filterValue.length === 0) continue;
      if (typeof filterValue === 'string' && filterValue === '') continue;

      const field = customFields.find(f => f.id === fieldId);
      if (!field) continue;

      result = result.filter(g => {
        const val = groupValuesMap[g.id]?.[fieldId];

        if (Array.isArray(filterValue)) {
          // Option-based filter: any_of
          if (val === undefined || val === null || val === '') return false;
          const vals = Array.isArray(val) ? val : [val];
          return filterValue.some(fv => vals.includes(fv));
        }

        if (typeof filterValue === 'string' && filterValue.startsWith('__bool__:')) {
          const boolTarget = filterValue === '__bool__:true';
          if (val === undefined || val === null || val === '') return false;
          const boolVal = val === 'true' || val === true;
          return boolVal === boolTarget;
        }

        if (typeof filterValue === 'string' && filterValue.startsWith('__text__:')) {
          const text = filterValue.slice('__text__:'.length).toLowerCase();
          if (!text) return true;
          return (String(val || '')).toLowerCase().includes(text);
        }

        return true;
      });
    }

    return result;
  }, [groups, nameSearch, customFieldFilters, customFields, groupValuesMap]);

  const hasActiveFilters = nameSearch.trim() !== '' || Object.values(customFieldFilters).some(v =>
    Array.isArray(v) ? v.length > 0 : (typeof v === 'string' && v !== '')
  );

  const orgsByGroup = orgs.reduce((acc, o) => {
    if (o.organization_group_id) {
      (acc[o.organization_group_id] ||= []).push(o);
    }
    return acc;
  }, {});

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/entities/OrganizationGroup"] });
    queryClient.invalidateQueries({ queryKey: ["organisation-groups-orgs"] });
    queryClient.invalidateQueries({ queryKey: ["organizations-crm-paginated"] });
    queryClient.invalidateQueries({ queryKey: ["org-groups-all-preference-values"] });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
      };
      if (editingGroup) {
        return base44.entities.OrganizationGroup.update(editingGroup.id, payload);
      }
      return base44.entities.OrganizationGroup.create(payload);
    },
    onSuccess: () => {
      toast.success(editingGroup ? "Group updated" : "Group created");
      setDialogOpen(false);
      setEditingGroup(null);
      invalidate();
    },
    onError: (e) => toast.error("Failed to save group: " + e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (group) => base44.entities.OrganizationGroup.delete(group.id),
    onSuccess: () => {
      toast.success("Group deleted — its organisations were detached, not deleted");
      setDeleteTarget(null);
      if (selectedGroup && deleteTarget && selectedGroup.id === deleteTarget.id) {
        setSelectedGroup(null);
      }
      invalidate();
    },
    onError: (e) => toast.error("Failed to delete group: " + e.message),
  });

  const openCreate = () => {
    setEditingGroup(null);
    setForm({ name: "", description: "" });
    setDialogOpen(true);
  };
  const openEdit = (group) => {
    setEditingGroup(group);
    setForm({ name: group.name || "", description: group.description || "" });
    setDialogOpen(true);
  };

  const clearFilters = () => {
    setNameSearch('');
    setCustomFieldFilters({});
  };

  const setOptionFilter = (fieldId, optionValue, checked) => {
    setCustomFieldFilters(prev => {
      const current = Array.isArray(prev[fieldId]) ? prev[fieldId] : [];
      const next = checked
        ? [...current, optionValue]
        : current.filter(v => v !== optionValue);
      return { ...prev, [fieldId]: next };
    });
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  // ---- Detail view: full CRM-style group record (Task #3601) ----
  if (selectedGroup) {
    const group = groups.find((g) => g.id === selectedGroup.id) || selectedGroup;
    return (
      <>
        <OrganisationGroupDetailView
          group={group}
          orgs={orgs}
          onBack={() => setSelectedGroup(null)}
          onDelete={(g) => setDeleteTarget(g)}
        />
        {renderDialogs()}
      </>
    );
  }

  // ---- List view ----
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800 flex items-center gap-2">
            <Building2 className="w-6 h-6 text-blue-600" /> Organisation Groups
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Group organisations under a shared parent (e.g. an NHS Trust and its hospitals).
          </p>
        </div>
        <Button onClick={openCreate} data-testid="button-create-group">
          <Plus className="w-4 h-4 mr-1" /> New Group
        </Button>
      </div>

      {/* Filter bar */}
      {(filterFields.length > 0 || true) && (
        <div className="space-y-3">
          <div className="flex gap-2 items-center">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                className="pl-8"
                placeholder="Search groups…"
                value={nameSearch}
                onChange={e => setNameSearch(e.target.value)}
                data-testid="input-group-search"
              />
            </div>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="text-slate-500 gap-1" data-testid="button-clear-group-filters">
                <X className="w-3.5 h-3.5" /> Clear
              </Button>
            )}
          </div>

          {filterFields.length > 0 && (
            <div className="flex flex-wrap gap-2 items-start">
              {filterFields.map(field => (
                <GroupFilterControl
                  key={field.id}
                  field={field}
                  value={customFieldFilters[field.id]}
                  onOptionToggle={(optVal, checked) => setOptionFilter(field.id, optVal, checked)}
                  onBoolChange={(boolStr) => setCustomFieldFilters(prev => ({ ...prev, [field.id]: boolStr }))}
                  onTextChange={(text) => setCustomFieldFilters(prev => ({ ...prev, [field.id]: text ? `__text__:${text}` : '' }))}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {groupsLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
      ) : filteredGroups.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-slate-500">
            {groups.length === 0
              ? 'No organisation groups yet. Create one to start grouping organisations.'
              : 'No groups match the current filters.'}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {filteredGroups.map((g) => {
            const vals = groupValuesMap[g.id] || {};
            return (
              <Card key={g.id} className="hover:shadow-sm transition-shadow">
                <CardContent className="flex items-center justify-between py-4">
                  <button
                    className="text-left flex-1 min-w-0"
                    onClick={() => setSelectedGroup(g)}
                    data-testid={`button-view-group-${g.id}`}
                  >
                    <div className="font-medium text-slate-800">{g.name}</div>
                    {g.description && <div className="text-sm text-slate-500 truncate">{g.description}</div>}

                    {/* Custom field column values */}
                    {columnFields.length > 0 && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
                        {columnFields.map(field => {
                          const display = renderFieldValue(field, vals[field.id]);
                          if (!display) return null;
                          return (
                            <span key={field.id} className="text-xs text-slate-500">
                              <span className="font-medium text-slate-600">{field.label}:</span>{' '}
                              {display}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </button>
                  <div className="flex items-center gap-3 ml-3 flex-shrink-0">
                    <Badge variant="secondary" data-testid={`badge-group-count-${g.id}`}>
                      {(orgsByGroup[g.id] || []).length} organisation{(orgsByGroup[g.id] || []).length === 1 ? "" : "s"}
                    </Badge>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(g)} data-testid={`button-edit-group-${g.id}`}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="text-red-600" onClick={() => setDeleteTarget(g)} data-testid={`button-delete-group-${g.id}`}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {renderDialogs()}
    </div>
  );

  function renderDialogs() {
    return (
      <>
        <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) { setDialogOpen(false); setEditingGroup(null); } }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingGroup ? "Edit Organisation Group" : "New Organisation Group"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Example NHS Trust"
                  data-testid="input-group-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Description (optional)</Label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  rows={3}
                  data-testid="textarea-group-description"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  if (!form.name.trim()) { toast.error("Group name is required"); return; }
                  saveMutation.mutate();
                }}
                disabled={saveMutation.isPending}
                data-testid="button-save-group"
              >
                {saveMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete "{deleteTarget?.name}"?</DialogTitle>
              <DialogDescription>
                The {(orgsByGroup[deleteTarget?.id] || []).length} organisation(s) in this group will be
                detached from it — the organisations themselves are <strong>not</strong> deleted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => deleteMutation.mutate(deleteTarget)}
                disabled={deleteMutation.isPending}
                data-testid="button-confirm-delete-group"
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete group"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }
}

// ---- Filter control per field ----

function GroupFilterControl({ field, value, onOptionToggle, onBoolChange, onTextChange }) {
  const ft = field.field_type;

  // Option-based (picklist / dropdown): inline checkbox list
  if ((ft === 'picklist' || ft === 'dropdown') && field.options?.length) {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="border rounded-md p-2 bg-white shadow-sm min-w-[140px] max-w-[200px]" data-testid={`filter-field-${field.id}`}>
        <p className="text-xs font-medium text-slate-600 mb-1.5">{field.label}</p>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {field.options.map(opt => (
            <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-700 hover:text-slate-900">
              <Checkbox
                checked={selected.includes(opt.value)}
                onCheckedChange={(checked) => onOptionToggle(opt.value, !!checked)}
                data-testid={`filter-option-${field.id}-${opt.value}`}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
    );
  }

  // Country field — stored values are country NAMES (the editor saves names, not codes).
  // Filter options and comparisons must use names to match stored data.
  if (ft === 'country' || ft === 'countries') {
    const selected = Array.isArray(value) ? value : [];
    const allowedCodes = field.all_countries !== false
      ? null
      : (Array.isArray(field.selected_countries) ? field.selected_countries : null);
    const countryList = allowedCodes ? COUNTRIES.filter(c => allowedCodes.includes(c.code)) : COUNTRIES;

    return (
      <div className="border rounded-md p-2 bg-white shadow-sm min-w-[160px] max-w-[200px]" data-testid={`filter-field-${field.id}`}>
        <p className="text-xs font-medium text-slate-600 mb-1.5">{field.label}</p>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {countryList.map(c => (
            <label key={c.code} className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-700 hover:text-slate-900">
              <Checkbox
                checked={selected.includes(c.name)}
                onCheckedChange={(checked) => onOptionToggle(c.name, !!checked)}
                data-testid={`filter-country-${field.id}-${c.code}`}
              />
              {c.name}
            </label>
          ))}
        </div>
      </div>
    );
  }

  // Boolean
  if (ft === 'boolean') {
    const boolVal = typeof value === 'string' && value.startsWith('__bool__:')
      ? value.slice('__bool__:'.length)
      : '';
    return (
      <div className="border rounded-md p-2 bg-white shadow-sm min-w-[140px]" data-testid={`filter-field-${field.id}`}>
        <p className="text-xs font-medium text-slate-600 mb-1.5">{field.label}</p>
        <Select
          value={boolVal || 'all'}
          onValueChange={v => onBoolChange(v === 'all' ? '' : `__bool__:${v}`)}
        >
          <SelectTrigger className="h-7 text-xs" data-testid={`filter-bool-${field.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any</SelectItem>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  }

  // Text / textarea / email / url / number / decimal / date — text search
  const textVal = typeof value === 'string' && value.startsWith('__text__:')
    ? value.slice('__text__:'.length)
    : '';
  return (
    <div className="border rounded-md p-2 bg-white shadow-sm min-w-[160px]" data-testid={`filter-field-${field.id}`}>
      <p className="text-xs font-medium text-slate-600 mb-1.5">{field.label}</p>
      <Input
        className="h-7 text-xs"
        placeholder={`Filter by ${field.label.toLowerCase()}…`}
        value={textVal}
        onChange={e => onTextChange(e.target.value)}
        data-testid={`filter-text-${field.id}`}
      />
    </div>
  );
}
