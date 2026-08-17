import { useState, useEffect, useMemo } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import {
  Popover, PopoverContent, PopoverTrigger
} from "@/components/ui/popover";
import { toast } from "sonner";
import {
  Building2, Plus, Pencil, Trash2, Loader2, Search, X, SlidersHorizontal,
  RotateCcw, PanelLeft, PanelLeftClose, Columns3, Eye, EyeOff, GripVertical,
  LayoutList, LayoutGrid, ChevronLeft, ChevronRight, Calendar
} from "lucide-react";
import { format } from "date-fns";
import OrganisationGroupDetailView from "@/components/OrganisationGroupDetailView";
import { isOrgAdminColumnVisible, isOrgAdminFilterVisible } from "@/pages/CustomFieldsAdmin";
import { COUNTRIES } from "@/data/countries";
import MultiSelectFilter from "@/components/MultiSelectFilter";
import FilterOperatorMenu from "@/components/FilterOperatorMenu";
import SortableHeader, { getAriaSort } from "@/components/SortableHeader";
import {
  TEXT_OPERATORS, OPTION_OPERATORS, BOOLEAN_OPERATORS, COUNTRY_OPERATORS,
  isEmptinessOp, isActiveCustomFilterValue, isActiveCustomFilterWithOp
} from "@/lib/customFilterUtils";

const EMPTY_ARR = [];
const PAGE_SIZE = 20;
const COLUMNS_STORAGE_KEY = "orgGroupsColumns.v1";

const MULTI_VALUE_TYPES = new Set(['picklist', 'list', 'countries']);
const OPTION_FIELD_TYPES = new Set(['picklist', 'dropdown']);

const DEFAULT_COLUMNS = [
  { id: 'name', label: 'Name', visible: true, locked: true },
  { id: 'description', label: 'Description', visible: true, locked: false },
  { id: 'organisations', label: 'Organisations', visible: true, locked: false },
  { id: 'created_at', label: 'Created', visible: false, locked: false },
];

const GROUP_SORT_KEYS = {
  name: 'name',
  description: 'description',
  organisations: 'organisations',
  created_at: 'created_at',
};

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
    if (field.field_type === 'countries') {
      return value.join(', ');
    }
    if (field.options?.length) {
      return value.map(v => field.options.find(o => o.value === v)?.label || v).join(', ');
    }
    return value.join(', ');
  }
  if (field.field_type === 'country') {
    return String(value);
  }
  if (field.field_type === 'dropdown' && field.options?.length) {
    return field.options.find(o => o.value === value)?.label || value;
  }
  return String(value);
}

function isValueEmpty(val) {
  if (val === undefined || val === null || val === '') return true;
  if (Array.isArray(val)) return val.length === 0;
  return false;
}

function loadStoredColumns() {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    // Ensure every default column still exists (name stays locked+visible).
    const byId = new Map(parsed.map(c => [c.id, c]));
    const merged = [...parsed];
    DEFAULT_COLUMNS.forEach(dc => {
      if (!byId.has(dc.id)) merged.push({ ...dc });
    });
    return merged.map(c => c.id === 'name' ? { ...c, visible: true, locked: true } : c);
  } catch {
    return null;
  }
}

function saveStoredColumns(cols) {
  try {
    localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(cols));
  } catch { /* ignore quota errors */ }
}

export default function OrganisationGroups() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { id: urlGroupId } = useParams();
  const location = useLocation();
  const [accessChecked, setAccessChecked] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState({ name: "", description: "" });

  // CRM shell state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [viewMode, setViewMode] = useState('list');
  const [currentPage, setCurrentPage] = useState(1);
  const [sortField, setSortField] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [columns, setColumns] = useState(() => loadStoredColumns() || DEFAULT_COLUMNS.map(c => ({ ...c })));
  const [draggedColumn, setDraggedColumn] = useState(null);

  // Filter state
  const [nameSearch, setNameSearch] = useState('');
  const [descriptionFilter, setDescriptionFilter] = useState('');
  const [customFieldFilters, setCustomFieldFilters] = useState({});
  const [filterOps, setFilterOps] = useState({});

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

  // Deep-link fallback: fetch the group directly when it isn't in the list yet.
  const groupFromList = urlGroupId ? groups.find(g => g.id === urlGroupId) : null;
  const { data: directGroup, isError: directGroupError } = useQuery({
    queryKey: ['org-group-direct', urlGroupId],
    enabled: accessChecked && !!urlGroupId && !groupsLoading && !groupFromList,
    retry: false,
    queryFn: async () => {
      const rows = await base44.entities.OrganizationGroup.filter({ id: urlGroupId });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) throw new Error('Group not found');
      return row;
    }
  });

  // Redirect to the list when a deep-linked group doesn't exist.
  useEffect(() => {
    if (urlGroupId && directGroupError) {
      toast.error("Organisation group not found");
      navigate('/OrganisationGroups', { replace: true });
    }
  }, [urlGroupId, directGroupError, navigate]);

  // Derived: fields to show as columns and as filters.
  const columnFields = useMemo(
    () => customFields.filter(f => isOrgAdminColumnVisible(f)),
    [customFields]
  );
  const filterFields = useMemo(
    () => customFields.filter(f => isOrgAdminFilterVisible(f)),
    [customFields]
  );
  // Reconcile custom-field columns once fields load: add new, prune stale.
  useEffect(() => {
    if (!accessChecked) return;
    setColumns(prev => {
      const allowedIds = new Set(columnFields.map(f => f.id));
      const existingIds = new Set(prev.filter(c => c.isCustomField && c.fieldId).map(c => c.fieldId));
      const pruned = prev.filter(c => !c.isCustomField || allowedIds.has(c.fieldId));
      const additions = columnFields
        .filter(f => !existingIds.has(f.id))
        .map(f => ({
          id: `cf_${f.id}`, label: f.label, visible: false, locked: false,
          isCustomField: true, fieldId: f.id
        }));
      if (pruned.length === prev.length && additions.length === 0) return prev;
      const updated = [...pruned, ...additions];
      saveStoredColumns(updated);
      return updated;
    });
  }, [columnFields, accessChecked]);

  useEffect(() => {
    saveStoredColumns(columns);
  }, [columns]);

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

  const orgsByGroup = useMemo(() => {
    const acc = {};
    for (const o of orgs) {
      if (o.organization_group_id) (acc[o.organization_group_id] ||= []).push(o);
    }
    return acc;
  }, [orgs]);

  const setFilterOp = (id, op) => {
    setFilterOps(prev => ({ ...prev, [id]: op }));
    setCurrentPage(1);
  };

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

    // Core "Description" filter with text operators.
    const descOp = filterOps['core_description'] || 'contains';
    if (isActiveCustomFilterWithOp(descriptionFilter ? `__text__:${descriptionFilter}` : '', descOp)) {
      const text = descriptionFilter.trim().toLowerCase();
      result = result.filter(g => {
        const val = (g.description || '').toLowerCase();
        if (descOp === 'empty') return !val;
        if (descOp === 'not_empty') return !!val;
        if (!text) return true;
        if (descOp === 'contains') return val.includes(text);
        if (descOp === 'not_contains') return !val.includes(text);
        if (descOp === 'equals') return val === text;
        return true;
      });
    }

    for (const field of filterFields) {
      const fieldId = field.id;
      const filterValue = customFieldFilters[fieldId];
      const op = filterOps[fieldId];
      const active = isEmptinessOp(op) || isActiveCustomFilterValue(filterValue);
      if (!active) continue;

      result = result.filter(g => {
        const val = groupValuesMap[g.id]?.[fieldId];

        if (isEmptinessOp(op)) {
          const empty = isValueEmpty(val);
          return op === 'empty' ? empty : !empty;
        }

        if (Array.isArray(filterValue)) {
          // Option / country filters: any_of (default) or none_of
          const vals = Array.isArray(val) ? val : (isValueEmpty(val) ? [] : [val]);
          const matches = filterValue.some(fv => vals.includes(fv));
          return (op === 'none_of') ? !matches : matches;
        }

        if (typeof filterValue === 'string' && filterValue.startsWith('__bool__:')) {
          const boolTarget = filterValue === '__bool__:true';
          if (isValueEmpty(val)) return false;
          const boolVal = val === 'true' || val === true;
          return boolVal === boolTarget;
        }

        if (typeof filterValue === 'string' && filterValue.startsWith('__text__:')) {
          const text = filterValue.slice('__text__:'.length).toLowerCase();
          if (!text) return true;
          const sval = String(val ?? '').toLowerCase();
          if (op === 'not_contains') return !sval.includes(text);
          if (op === 'equals') return sval === text;
          return sval.includes(text);
        }

        return true;
      });
    }

    return result;
  }, [groups, nameSearch, descriptionFilter, customFieldFilters, filterOps, filterFields, groupValuesMap]);

  // Sorting (client-side)
  const sortedGroups = useMemo(() => {
    const arr = [...filteredGroups];
    const dir = sortDir === 'desc' ? -1 : 1;
    arr.sort((a, b) => {
      let av, bv;
      if (sortField === 'organisations') {
        av = (orgsByGroup[a.id] || EMPTY_ARR).length;
        bv = (orgsByGroup[b.id] || EMPTY_ARR).length;
        return (av - bv) * dir;
      }
      if (sortField === 'created_at') {
        av = a.created_at ? new Date(a.created_at).getTime() : 0;
        bv = b.created_at ? new Date(b.created_at).getTime() : 0;
        return (av - bv) * dir;
      }
      av = String(a[sortField] ?? '').toLowerCase();
      bv = String(b[sortField] ?? '').toLowerCase();
      return av.localeCompare(bv) * dir;
    });
    return arr;
  }, [filteredGroups, sortField, sortDir, orgsByGroup]);

  const totalPages = Math.max(1, Math.ceil(sortedGroups.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedGroups = useMemo(
    () => sortedGroups.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [sortedGroups, safePage]
  );

  const hasActiveFilters =
    nameSearch.trim() !== '' ||
    descriptionFilter.trim() !== '' ||
    Object.values(customFieldFilters).some(isActiveCustomFilterValue) ||
    Object.values(filterOps).some(isEmptinessOp);

  const visibleColumns = useMemo(() => columns.filter(c => c.visible), [columns]);

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
    onSuccess: (_data, group) => {
      toast.success("Group deleted — its organisations were detached, not deleted");
      setDeleteTarget(null);
      if (urlGroupId && group && urlGroupId === group.id) {
        navigate('/OrganisationGroups', { replace: true });
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
    setDescriptionFilter('');
    setCustomFieldFilters({});
    setFilterOps({});
    setCurrentPage(1);
  };

  const handleSort = (field) => {
    if (!field) return;
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const toggleColumnVisibility = (columnId) => {
    setColumns(prev => prev.map(col =>
      col.id === columnId && !col.locked ? { ...col, visible: !col.visible } : col
    ));
  };

  const moveColumn = (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return;
    setColumns(prev => {
      const result = [...prev];
      const [removed] = result.splice(fromIndex, 1);
      result.splice(toIndex, 0, removed);
      return result;
    });
  };

  const resetColumns = () => {
    const customFieldCols = columnFields.map(f => ({
      id: `cf_${f.id}`, label: f.label, visible: false, locked: false,
      isCustomField: true, fieldId: f.id
    }));
    const newColumns = [...DEFAULT_COLUMNS.map(c => ({ ...c })), ...customFieldCols];
    setColumns(newColumns);
    saveStoredColumns(newColumns);
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  // ---- Detail view: deep-linkable CRM-style group record ----
  if (urlGroupId) {
    const group = groupFromList || directGroup;
    if (!group) {
      // Still resolving (list loading or direct fetch in flight)
      return (
        <div className="flex items-center justify-center min-h-[40vh]">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      );
    }
    return (
      <>
        <OrganisationGroupDetailView
          group={group}
          orgs={orgs}
          onBack={() => {
            // Only go back through history when we know the previous entry is
            // the groups list (route state set when opening a row); any other
            // provenance (deep link, another page) goes straight to the list.
            if (location.state?.fromGroupsList) {
              navigate(-1);
            } else {
              navigate('/OrganisationGroups');
            }
          }}
          onEdit={(g) => openEdit(g)}
          onDelete={(g) => setDeleteTarget(g)}
        />
        {renderDialogs()}
      </>
    );
  }

  // ---- Filter control renderer (custom fields, sidebar style) ----
  function renderGroupFilterControl(field) {
    const ft = field.field_type;
    const fieldOp = filterOps[field.id];

    if (ft === 'boolean') {
      const op = fieldOp || 'is';
      const raw = customFieldFilters[field.id];
      const boolVal = typeof raw === 'string' && raw.startsWith('__bool__:')
        ? raw.slice('__bool__:'.length) : '';
      return (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-1">
            <Label className="text-[11px] text-slate-600 break-words leading-tight">{field.label}</Label>
            <FilterOperatorMenu
              operators={BOOLEAN_OPERATORS}
              value={op}
              onChange={(v) => setFilterOp(field.id, v)}
              testId={`op-group-filter-${field.id}`}
            />
          </div>
          {!isEmptinessOp(op) && (
            <Select
              value={boolVal || 'all'}
              onValueChange={v => {
                setCustomFieldFilters(prev => ({ ...prev, [field.id]: v === 'all' ? '' : `__bool__:${v}` }));
                setCurrentPage(1);
              }}
            >
              <SelectTrigger className="h-8 text-xs" data-testid={`filter-bool-${field.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any</SelectItem>
                <SelectItem value="true">Yes</SelectItem>
                <SelectItem value="false">No</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      );
    }

    if (ft === 'country' || ft === 'countries') {
      const op = fieldOp || 'any_of';
      const selected = Array.isArray(customFieldFilters[field.id]) ? customFieldFilters[field.id] : EMPTY_ARR;
      const allowedCodes = field.all_countries !== false
        ? null
        : (Array.isArray(field.selected_countries) ? field.selected_countries : null);
      const countryList = allowedCodes ? COUNTRIES.filter(c => allowedCodes.includes(c.code)) : COUNTRIES;
      // Stored values are country NAMES — options use names as values.
      const options = countryList.map(c => ({ value: c.name, label: c.name }));
      const setSelected = (vals) => {
        setCustomFieldFilters(prev => ({ ...prev, [field.id]: vals }));
        setCurrentPage(1);
      };
      return (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-1">
            <Label className="text-[11px] text-slate-600 break-words leading-tight">{field.label}</Label>
            <FilterOperatorMenu
              operators={COUNTRY_OPERATORS}
              value={op}
              onChange={(v) => setFilterOp(field.id, v)}
              testId={`op-group-filter-${field.id}`}
            />
          </div>
          {!isEmptinessOp(op) && (
            <>
              <MultiSelectFilter
                options={options}
                selected={selected}
                onChange={setSelected}
                placeholder="All"
                className="h-8 min-h-8 w-full text-xs"
                data-testid={`select-filter-${field.id}`}
              />
              {selected.length > 1 && (
                <div className="flex flex-wrap gap-1">
                  {selected.map(val => (
                    <Badge key={val} variant="secondary" className="text-[10px] font-normal max-w-full gap-1" data-testid={`badge-filter-${field.id}-${val}`}>
                      <span className="truncate">{val}</span>
                      <button
                        type="button"
                        className="shrink-0 rounded-full"
                        onClick={() => setSelected(selected.filter(v => v !== val))}
                        aria-label={`Remove ${val}`}
                        data-testid={`button-remove-filter-${field.id}-${val}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    if (OPTION_FIELD_TYPES.has(ft) && field.options?.length) {
      const op = fieldOp || 'any_of';
      const selected = Array.isArray(customFieldFilters[field.id]) ? customFieldFilters[field.id] : EMPTY_ARR;
      const labelForValue = (val) => field.options.find(o => o.value === val)?.label || val;
      const setSelected = (vals) => {
        setCustomFieldFilters(prev => ({ ...prev, [field.id]: vals }));
        setCurrentPage(1);
      };
      return (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-1">
            <Label className="text-[11px] text-slate-600 break-words leading-tight">{field.label}</Label>
            <FilterOperatorMenu
              operators={OPTION_OPERATORS}
              value={op}
              onChange={(v) => setFilterOp(field.id, v)}
              testId={`op-group-filter-${field.id}`}
            />
          </div>
          {!isEmptinessOp(op) && (
            <>
              <MultiSelectFilter
                options={field.options.map(opt => ({ value: opt.value, label: opt.label || opt.value }))}
                selected={selected}
                onChange={setSelected}
                placeholder="All"
                className="h-8 min-h-8 w-full text-xs"
                data-testid={`select-filter-${field.id}`}
              />
              {selected.length > 1 && (
                <div className="flex flex-wrap gap-1">
                  {selected.map(val => (
                    <Badge key={val} variant="secondary" className="text-[10px] font-normal max-w-full gap-1" data-testid={`badge-filter-${field.id}-${val}`}>
                      <span className="truncate">{labelForValue(val)}</span>
                      <button
                        type="button"
                        className="shrink-0 rounded-full"
                        onClick={() => setSelected(selected.filter(v => v !== val))}
                        aria-label={`Remove ${labelForValue(val)}`}
                        data-testid={`button-remove-filter-${field.id}-${val}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    // Text / textarea / email / url / number / decimal / date — text search
    const op = fieldOp || 'contains';
    const textValue = typeof customFieldFilters[field.id] === 'string'
      ? customFieldFilters[field.id].replace('__text__:', '')
      : '';
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-1">
          <Label className="text-[11px] text-slate-600 break-words leading-tight">{field.label}</Label>
          <FilterOperatorMenu
            operators={TEXT_OPERATORS}
            value={op}
            onChange={(v) => setFilterOp(field.id, v)}
            testId={`op-group-filter-${field.id}`}
          />
        </div>
        {!isEmptinessOp(op) && (
          <Input
            placeholder="Filter..."
            value={textValue}
            onChange={(e) => {
              const val = e.target.value;
              setCustomFieldFilters(prev => ({ ...prev, [field.id]: val ? `__text__:${val}` : '' }));
              setCurrentPage(1);
            }}
            className="h-8 text-xs"
            data-testid={`input-filter-cf-${field.id}`}
          />
        )}
      </div>
    );
  }

  // ---- List view (CRM shell) ----
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex h-screen">
        <aside
          className={`bg-white border-r border-slate-200 flex flex-col transition-all duration-300 ease-in-out ${
            sidebarCollapsed ? 'w-0 overflow-hidden' : 'w-72'
          }`}
        >
          <div className="p-4 border-b border-slate-200 min-w-[288px]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-slate-900 flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4" />
                Filters
              </h2>
              <div className="flex items-center gap-1">
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearFilters}
                    className="text-slate-500 hover:text-slate-700 h-8 px-2"
                    data-testid="button-reset-group-filters"
                  >
                    <RotateCcw className="w-3 h-3 mr-1" />
                    Reset
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSidebarCollapsed(true)}
                  className="h-8 w-8 text-slate-400 hover:text-slate-600"
                  data-testid="button-collapse-sidebar"
                >
                  <PanelLeftClose className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search groups..."
                value={nameSearch}
                onChange={(e) => { setNameSearch(e.target.value); setCurrentPage(1); }}
                className="pl-9"
                data-testid="input-group-search"
              />
            </div>
          </div>

          <ScrollArea className="flex-1 p-4 min-w-[288px]">
            <div className="space-y-3">
              {/* Core field: Description */}
              <div className="space-y-1.5" data-testid="group-filter-row-description">
                <div className="flex items-center justify-between gap-1">
                  <Label className="text-[11px] text-slate-600 leading-tight">Description</Label>
                  <FilterOperatorMenu
                    operators={TEXT_OPERATORS}
                    value={filterOps['core_description'] || 'contains'}
                    onChange={(v) => setFilterOp('core_description', v)}
                    testId="op-group-filter-description"
                  />
                </div>
                {!isEmptinessOp(filterOps['core_description'] || 'contains') && (
                  <Input
                    placeholder="Filter..."
                    value={descriptionFilter}
                    onChange={(e) => { setDescriptionFilter(e.target.value); setCurrentPage(1); }}
                    className="h-8 text-xs"
                    data-testid="input-filter-description"
                  />
                )}
              </div>
              {filterFields.map(field => (
                <div key={field.id} data-testid={`group-filter-row-${field.id}`}>
                  {renderGroupFilterControl(field)}
                </div>
              ))}
            </div>
          </ScrollArea>

          <div className="p-4 border-t border-slate-200 bg-slate-50 min-w-[288px]">
            <p className="text-xs text-slate-500">
              Showing {paginatedGroups.length} of {sortedGroups.length} group{sortedGroups.length !== 1 ? 's' : ''}
            </p>
          </div>
        </aside>

        <main className="flex-1 flex flex-col overflow-hidden">
          <header className="bg-white border-b border-slate-200 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                {sidebarCollapsed && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSidebarCollapsed(false)}
                    data-testid="button-expand-sidebar"
                  >
                    <PanelLeft className="w-4 h-4" />
                  </Button>
                )}
                <div>
                  <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
                    <Building2 className="w-5 h-5 text-blue-600" />
                    Organisation Groups
                  </h1>
                  <p className="text-sm text-slate-500">
                    {sortedGroups.length} group{sortedGroups.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button onClick={openCreate} data-testid="button-create-group">
                  <Plus className="w-4 h-4 mr-1" /> New Group
                </Button>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1" data-testid="button-configure-columns">
                      <Columns3 className="w-4 h-4" />
                      Columns
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80" align="end">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="font-medium text-sm">Configure Columns</h4>
                        <Button variant="ghost" size="sm" onClick={resetColumns} className="h-7 text-xs" data-testid="button-reset-columns">
                          Reset
                        </Button>
                      </div>
                      <p className="text-xs text-slate-500">Drag to reorder. Click to show/hide.</p>
                      <ScrollArea className="h-56">
                        <div className="space-y-1">
                          {columns.map((col, index) => (
                            <div
                              key={col.id}
                              draggable={!col.locked}
                              onDragStart={(e) => { setDraggedColumn(index); e.dataTransfer.effectAllowed = 'move'; }}
                              onDragOver={(e) => {
                                e.preventDefault();
                                if (draggedColumn === null || draggedColumn === index) return;
                                moveColumn(draggedColumn, index);
                                setDraggedColumn(index);
                              }}
                              onDragEnd={() => setDraggedColumn(null)}
                              className={`flex items-center gap-2 p-2 rounded-md border ${
                                draggedColumn === index ? 'border-blue-400 bg-blue-50' : 'border-transparent hover:bg-slate-50'
                              } ${col.locked ? 'opacity-60' : 'cursor-grab'}`}
                              data-testid={`column-item-${col.id}`}
                            >
                              <GripVertical className={`w-4 h-4 text-slate-400 ${col.locked ? 'invisible' : ''}`} />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={() => toggleColumnVisibility(col.id)}
                                disabled={col.locked}
                                data-testid={`toggle-column-${col.id}`}
                              >
                                {col.visible ? (
                                  <Eye className="w-3.5 h-3.5 text-blue-600" />
                                ) : (
                                  <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                                )}
                              </Button>
                              <span className={`text-sm flex-1 ${col.visible ? 'text-slate-900' : 'text-slate-400'}`}>
                                {col.label}
                              </span>
                              {col.locked && (
                                <Badge variant="secondary" className="text-xs h-5">Required</Badge>
                              )}
                              {col.isCustomField && (
                                <Badge variant="outline" className="text-xs h-5">Custom</Badge>
                              )}
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  </PopoverContent>
                </Popover>
                <div className="bg-slate-100 rounded-lg p-1 flex">
                  <Button
                    variant={viewMode === 'list' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('list')}
                    className="gap-1"
                    data-testid="button-view-list"
                  >
                    <LayoutList className="w-4 h-4" />
                    List
                  </Button>
                  <Button
                    variant={viewMode === 'card' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('card')}
                    className="gap-1"
                    data-testid="button-view-card"
                  >
                    <LayoutGrid className="w-4 h-4" />
                    Cards
                  </Button>
                </div>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-auto p-6">
            {groupsLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : paginatedGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                <Building2 className="w-16 h-16 mb-4 text-slate-300" />
                <p className="text-lg font-medium">
                  {groups.length === 0 ? 'No organisation groups yet' : 'No groups found'}
                </p>
                <p className="text-sm">
                  {groups.length === 0
                    ? 'Create one to start grouping organisations.'
                    : 'Try adjusting your filters'}
                </p>
              </div>
            ) : viewMode === 'list' ? (
              <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      {visibleColumns.map(col => {
                        const sortKey = col.isCustomField ? null : GROUP_SORT_KEYS[col.id];
                        return (
                          <th
                            key={col.id}
                            className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide"
                            aria-sort={getAriaSort(sortKey, sortField, sortDir)}
                          >
                            <SortableHeader
                              field={sortKey}
                              sortField={sortField}
                              sortDir={sortDir}
                              onSort={handleSort}
                              sortable={!!sortKey}
                            >
                              {col.label}
                            </SortableHeader>
                          </th>
                        );
                      })}
                      <th className="w-24 px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginatedGroups.map(g => (
                      <tr
                        key={g.id}
                        className="hover:bg-slate-50 cursor-pointer transition-colors"
                        onClick={() => navigate(`/OrganisationGroups/${g.id}`, { state: { fromGroupsList: true } })}
                        data-testid={`row-group-${g.id}`}
                      >
                        {visibleColumns.map(col => {
                          if (col.id === 'name') {
                            return (
                              <td key={col.id} className="px-4 py-3">
                                <div className="flex items-center gap-3">
                                  <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                                    <Building2 className="w-5 h-5 text-blue-600" />
                                  </div>
                                  <p className="font-medium text-slate-900">{g.name}</p>
                                </div>
                              </td>
                            );
                          }
                          if (col.id === 'description') {
                            return (
                              <td key={col.id} className="px-4 py-3 text-sm text-slate-600 max-w-[300px]">
                                <span className="truncate block" title={g.description || undefined}>
                                  {g.description || '-'}
                                </span>
                              </td>
                            );
                          }
                          if (col.id === 'organisations') {
                            const count = (orgsByGroup[g.id] || EMPTY_ARR).length;
                            return (
                              <td key={col.id} className="px-4 py-3">
                                <Badge variant="secondary" data-testid={`badge-group-count-${g.id}`}>
                                  {count} organisation{count === 1 ? '' : 's'}
                                </Badge>
                              </td>
                            );
                          }
                          if (col.id === 'created_at') {
                            return (
                              <td key={col.id} className="px-4 py-3 text-sm text-slate-600">
                                {g.created_at ? format(new Date(g.created_at), 'dd MMM yyyy') : '-'}
                              </td>
                            );
                          }
                          if (col.isCustomField) {
                            const field = customFields.find(f => f.id === col.fieldId);
                            const display = field ? renderFieldValue(field, groupValuesMap[g.id]?.[col.fieldId]) : null;
                            return (
                              <td key={col.id} className="px-4 py-3 text-sm text-slate-600">
                                {display || '-'}
                              </td>
                            );
                          }
                          return <td key={col.id} className="px-4 py-3">-</td>;
                        })}
                        <td className="w-24 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="icon" onClick={() => openEdit(g)} data-testid={`button-edit-group-${g.id}`}>
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button variant="ghost" size="icon" className="text-slate-400 hover:text-red-600" onClick={() => setDeleteTarget(g)} data-testid={`button-delete-group-${g.id}`}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {paginatedGroups.map(g => {
                  const count = (orgsByGroup[g.id] || EMPTY_ARR).length;
                  const vals = groupValuesMap[g.id] || {};
                  return (
                    <Card
                      key={g.id}
                      className="cursor-pointer hover:shadow-md transition-shadow hover-elevate"
                      onClick={() => navigate(`/OrganisationGroups/${g.id}`, { state: { fromGroupsList: true } })}
                      data-testid={`card-group-${g.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3 mb-3">
                          <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                            <Building2 className="w-6 h-6 text-blue-600" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="font-medium text-slate-900 truncate">{g.name}</h3>
                            {g.description && (
                              <p className="text-xs text-slate-500 line-clamp-2">{g.description}</p>
                            )}
                          </div>
                        </div>
                        <div className="space-y-2 text-sm text-slate-600">
                          <div className="flex items-center gap-2">
                            <Building2 className="w-4 h-4 text-slate-400" />
                            <span>{count} organisation{count === 1 ? '' : 's'}</span>
                          </div>
                          {columns.find(c => c.id === 'created_at')?.visible && g.created_at && (
                            <div className="flex items-center gap-2">
                              <Calendar className="w-4 h-4 text-slate-400" />
                              <span>{format(new Date(g.created_at), 'dd MMM yyyy')}</span>
                            </div>
                          )}
                        </div>
                        {columnFields.slice(0, 2).map(field => {
                          const display = renderFieldValue(field, vals[field.id]);
                          if (!display) return null;
                          return (
                            <div key={field.id} className="mt-2 text-xs">
                              <span className="text-slate-400">{field.label}: </span>
                              <span className="text-slate-600">{display}</span>
                            </div>
                          );
                        })}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <footer className="bg-white border-t border-slate-200 px-6 py-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-500">
                  Page {safePage} of {totalPages}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    data-testid="button-next-page"
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </footer>
          )}
        </main>
      </div>
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
                The {(orgsByGroup[deleteTarget?.id] || EMPTY_ARR).length} organisation(s) in this group will be
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
