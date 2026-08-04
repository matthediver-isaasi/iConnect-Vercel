import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import RoleBadge from "@/components/RoleBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { 
  Users,
  Search, 
  Loader2, 
  ChevronLeft, 
  ChevronRight,
  X,
  LayoutList,
  LayoutGrid,
  SlidersHorizontal,
  RotateCcw,
  PanelLeft,
  PanelLeftClose,
  Eye,
  EyeOff,
  GripVertical,
  Columns3,
  Building2,
  Mail,
  Phone,
  Smartphone,
  Briefcase,
  Trash2,
  AlertTriangle,
  Download
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { isMemberAdminColumnVisible, isMemberAdminFilterVisible } from "@/pages/CustomFieldsAdmin";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { createPageUrl, isDeletedMember } from "@/utils";
import SortableHeader, { getAriaSort } from "@/components/SortableHeader";
import MultiSelectFilter from "@/components/MultiSelectFilter";
import {
  coerceCustomFilters,
  isActiveCustomFilterValue,
  TEXT_OPERATORS,
  OPTION_OPERATORS,
  BOOLEAN_OPERATORS,
  SELECT_OPERATORS,
  isEmptinessOp,
  buildCustomFilterWireValue,
  sanitizeFilterOps,
} from "@/lib/customFilterUtils";
import FilterOperatorMenu from "@/components/FilterOperatorMenu";
import { useSavedListViews } from "@/hooks/useSavedListViews";
import SavedViewSwitcher from "@/components/SavedViewSwitcher";

const MEMBER_SORT_KEYS = {
  name: 'first_name',
  email: 'email',
  organization: 'organization_name',
  job_title: 'job_title',
  mobile: 'mobile',
  status: 'login_enabled',
};

function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}
import MemberDetailView from "@/components/MemberDetailView";
import GuestAccessControl from "@/components/GuestAccessControl";
import { useToast } from "@/components/ui/use-toast";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { useMemberTerminology } from "@/contexts/MemberTerminologyContext";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useWidgetDrill, WidgetDrillChip } from "@/components/dashboard/widgetDrill";

const DEFAULT_COLUMNS = [
  { id: 'name', label: 'Member', visible: true, locked: true },
  { id: 'email', label: 'Email', visible: true, locked: false },
  { id: 'organization', label: 'Organisation', visible: true, locked: false },
  { id: 'job_title', label: 'Job Title', visible: true, locked: false },
  { id: 'mobile', label: 'Mobile', visible: false, locked: false },
  { id: 'status', label: 'Status', visible: true, locked: false },
  { id: 'roles', label: 'Roles', visible: false, locked: false }
];

const getStorageKey = (tenantSlug) => `members_list_columns_${tenantSlug || 'default'}`;
const getColumnPrefKey = (memberId) => `crm_member_columns_${memberId}`;

// Stable ids for the reorderable filters in the left pane (core filters first;
// custom fields are appended by their field id).
const DEFAULT_MEMBER_FILTER_ORDER = ['status', 'organisation', 'role', 'phone', 'job_title'];

const loadLocalColumns = (tenantSlug) => {
  try {
    const saved = localStorage.getItem(getStorageKey(tenantSlug));
    if (saved) return JSON.parse(saved);
  } catch {}
  return null;
};

const saveLocalColumns = (columns, tenantSlug) => {
  try {
    localStorage.setItem(getStorageKey(tenantSlug), JSON.stringify(columns));
  } catch {}
};

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' }
];

const getMemberName = (member) => {
  return [member?.first_name, member?.last_name].filter(Boolean).join(' ') || '';
};

const getInitials = (name) => {
  if (!name) return '?';
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
};

export default function MembersListPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const { memberLabel, memberLabelPlural, getMemberDetailUrl } = useMemberTerminology();
  const memberLabelLower = memberLabel.toLowerCase();
  const memberLabelPluralLower = memberLabelPlural.toLowerCase();
  const { tenantSlug } = useTenantBranding() || {};
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [accessChecked, setAccessChecked] = useState(false);
  const lastLoadedSlugRef = useRef(undefined);
  
  const [viewMode, setViewMode] = useState('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [orgFilter, setOrgFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [coreFieldFilters, setCoreFieldFilters] = useState({
    job_title: ''
  });
  const [customFieldFilters, setCustomFieldFilters] = useState({});
  // Per-filter condition operators, keyed by filter id (custom field id or
  // core filter id). Absent key = the filter's default operator.
  const [filterOps, setFilterOps] = useState({});
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(50);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [selectAllFiltered, setSelectAllFiltered] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [singleDeleteMember, setSingleDeleteMember] = useState(null);
  const [draggedColumn, setDraggedColumn] = useState(null);
  const [sortField, setSortField] = useState('created_on');
  const [sortDir, setSortDir] = useState('desc');
  const [filtersReady, setFiltersReady] = useState(false);
  const [filterOrder, setFilterOrder] = useState(DEFAULT_MEMBER_FILTER_ORDER);
  const [hiddenFilterIds, setHiddenFilterIds] = useState([]);
  const [draggedFilterId, setDraggedFilterId] = useState(null);
  const [filterSearchQuery, setFilterSearchQuery] = useState('');
  const [filterSearchOpen, setFilterSearchOpen] = useState(false);
  const filterSearchRef = useRef(null);

  const handleSort = useCallback((field) => {
    if (!field) return;
    setCurrentPage(1);
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }, [sortField]);

  const debouncedSearch = useDebounce(searchQuery, 300);

  useRealtimeSubscription('member', [['members-paginated']], { 
    enabled: accessChecked, 
    tenantId: memberInfo?.tenant_id 
  });

  // Load columns from tenant-scoped localStorage on mount or when tenant slug changes
  // Falls back to 'default' namespace if no tenantSlug is available (e.g., platform admin)
  useEffect(() => {
    const currentSlug = tenantSlug || 'default';
    if (lastLoadedSlugRef.current !== currentSlug) {
      const saved = loadLocalColumns(tenantSlug);
      if (saved) {
        setColumns(saved);
      } else if (lastLoadedSlugRef.current !== undefined) {
        // Reset to defaults when switching to a new tenant with no saved preferences
        setColumns(DEFAULT_COLUMNS);
      }
      lastLoadedSlugRef.current = currentSlug;
    }
  }, [tenantSlug]);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_MembersList')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations-for-members'],
    enabled: accessChecked,
    queryFn: async () => {
      // Paginate past the API's 1000-row cap so large tenants see the
      // full organisation list.
      return await base44.entities.Organization.listAll({ sort: { name: 'asc' } });
    }
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles-for-members'],
    enabled: accessChecked,
    queryFn: async () => {
      return await base44.entities.Role.list();
    }
  });

  const { data: memberCustomFields = [], isSuccess: memberCustomFieldsLoaded } = useQuery({
    queryKey: ['member-custom-fields-crm'],
    enabled: accessChecked,
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'member' },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => f.entity_scope === 'member' && (isMemberAdminColumnVisible(f) || isMemberAdminFilterVisible(f)));
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => (!f.entity_scope || f.entity_scope === 'member') && (isMemberAdminColumnVisible(f) || isMemberAdminFilterVisible(f)));
        } catch {
          return [];
        }
      }
    }
  });

  const memberColumnFields = useMemo(
    () => memberCustomFields.filter(f => isMemberAdminColumnVisible(f)),
    [memberCustomFields]
  );
  const memberFilterFields = useMemo(
    () => memberCustomFields.filter(f => isMemberAdminFilterVisible(f)),
    [memberCustomFields]
  );
  // All filter ids currently available, in default display order (core then custom).
  const availableFilterIds = useMemo(
    () => [...DEFAULT_MEMBER_FILTER_ORDER, ...memberFilterFields.map(f => f.id)],
    [memberFilterFields]
  );
  // Filters to actually render, in the user's chosen order, dropping any id with no
  // matching control (e.g. a custom field not yet loaded or no longer available).
  const orderedFilterIds = useMemo(() => {
    const availSet = new Set(availableFilterIds);
    return filterOrder.filter(id => availSet.has(id));
  }, [filterOrder, availableFilterIds]);
  const hiddenFilterSet = useMemo(() => new Set(hiddenFilterIds), [hiddenFilterIds]);
  // Filters split by visibility, preserving the user's chosen order.
  const visibleOrderedFilterIds = useMemo(
    () => orderedFilterIds.filter(id => !hiddenFilterSet.has(id)),
    [orderedFilterIds, hiddenFilterSet]
  );
  const hiddenOrderedFilterIds = useMemo(
    () => orderedFilterIds.filter(id => hiddenFilterSet.has(id)),
    [orderedFilterIds, hiddenFilterSet]
  );

  const activeCustomFilters = useMemo(() => {
    const obj = {};
    // Union of ids with a value and ids with an emptiness operator (which
    // filter without any value).
    const ids = new Set([
      ...Object.keys(customFieldFilters),
      ...memberFilterFields.map(f => f.id).filter(id => isEmptinessOp(filterOps[id])),
    ]);
    ids.forEach((fieldId) => {
      const op = filterOps[fieldId];
      if (isEmptinessOp(op)) {
        obj[fieldId] = { op };
      } else if (isActiveCustomFilterValue(customFieldFilters[fieldId])) {
        obj[fieldId] = buildCustomFilterWireValue(customFieldFilters[fieldId], op);
      }
    });
    return obj;
  }, [customFieldFilters, filterOps, memberFilterFields]);
  const customFiltersParam = useMemo(() => JSON.stringify(activeCustomFilters), [activeCustomFilters]);
  const customFieldIdsParam = useMemo(
    () => memberCustomFields.map(f => f.id).join(','),
    [memberCustomFields]
  );

  // Direct-column filters with operators, sent as the coreFilters param and
  // applied server-side. Filter id -> DB column: phone stores in `mobile`.
  const coreFiltersParam = useMemo(() => {
    const obj = {};
    const addText = (filterId, column) => {
      const op = filterOps[filterId] || 'contains';
      const value = (coreFieldFilters[filterId] || '').trim();
      if (isEmptinessOp(op)) {
        obj[column] = { op };
      } else if (value) {
        obj[column] = { op, value };
      }
    };
    addText('job_title', 'job_title');
    addText('phone', 'mobile');
    // Organisation / role become core filters only for non-default operators;
    // the default "is" keeps using the legacy organizationId/roleId params.
    const addId = (filterId, column, selected) => {
      const op = filterOps[filterId] || 'any_of';
      if (isEmptinessOp(op)) {
        obj[column] = { op };
      } else if (op === 'none_of' && selected && selected !== 'all') {
        obj[column] = { op, value: selected };
      }
    };
    addId('organisation', 'organization_id', orgFilter);
    addId('role', 'role_id', roleFilter);
    return Object.keys(obj).length > 0 ? JSON.stringify(obj) : '';
  }, [filterOps, coreFieldFilters, orgFilter, roleFilter]);

  // Legacy params must be suppressed when the operator moved the org/role
  // filter into coreFilters (otherwise both would apply and conflict).
  const effectiveOrgParam = (filterOps['organisation'] || 'any_of') === 'any_of' ? orgFilter : 'all';
  const effectiveRoleParam = (filterOps['role'] || 'any_of') === 'any_of' ? roleFilter : 'all';

  // Dashboard widget click-through: restrict the list to the ids stored
  // by the clicked widget bucket (see components/dashboard/widgetDrill.jsx).
  const [searchParams, setSearchParams] = useSearchParams();
  const { drill: widgetDrill, drillIdsParam, clearDrill } = useWidgetDrill(searchParams, setSearchParams);

  const { data: membersData, isLoading: membersLoading, isFetching: membersFetching } = useQuery({
    queryKey: ['members-paginated', currentPage, itemsPerPage, debouncedSearch, effectiveOrgParam, effectiveRoleParam, statusFilter, sortField, sortDir, customFiltersParam, coreFiltersParam, customFieldIdsParam, drillIdsParam],
    enabled: accessChecked && filtersReady,
    keepPreviousData: true,
    queryFn: async () => {
      const params = new URLSearchParams({
        page: currentPage.toString(),
        limit: itemsPerPage.toString(),
        search: debouncedSearch,
        organizationId: effectiveOrgParam,
        roleId: effectiveRoleParam,
        status: statusFilter,
        sortField,
        sortDir
      });
      if (customFiltersParam && customFiltersParam !== '{}') {
        params.set('customFilters', customFiltersParam);
      }
      if (coreFiltersParam) {
        params.set('coreFilters', coreFiltersParam);
      }
      if (customFieldIdsParam) {
        params.set('fields', customFieldIdsParam);
      }
      // A drill id list can be thousands of UUIDs — too long for a URL, so
      // it travels in a POST body while the other params stay in the query.
      const response = await fetch(`/api/admin/members/paginated?${params}`, {
        credentials: 'include',
        ...(drillIdsParam
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: drillIdsParam }),
            }
          : {}),
      });
      if (!response.ok) throw new Error('Failed to fetch members');
      return response.json();
    }
  });

  const members = membersData?.members || [];
  const pagination = membersData?.pagination || { page: 1, limit: 50, total: 0, totalPages: 0 };
  const totalPages = pagination.totalPages;

  const { toast } = useToast();
  const columnPrefKey = memberInfo?.id ? getColumnPrefKey(memberInfo.id) : null;
  const dbColumnsLoadedRef = useRef(false);
  const savedPrefIdRef = useRef(null);
  // Once a saved view has applied its own columns, the baseline column-prefs
  // row must not override them.
  const viewColumnsAppliedRef = useRef(false);

  const { data: savedDbColumns } = useQuery({
    queryKey: ['crm-member-column-prefs', columnPrefKey],
    enabled: accessChecked && !!columnPrefKey && !dbColumnsLoadedRef.current,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (dbColumnsLoadedRef.current) return null;
      dbColumnsLoadedRef.current = true;
      try {
        const settings = await base44.entities.SystemSettings.list();
        const setting = settings?.find(s => s.setting_key === columnPrefKey);
        if (setting) {
          savedPrefIdRef.current = setting.id;
          return setting;
        }
        return null;
      } catch {
        return null;
      }
    }
  });

  useEffect(() => {
    if (viewColumnsAppliedRef.current) return;
    if (savedDbColumns?.setting_value) {
      try {
        const parsed = JSON.parse(savedDbColumns.setting_value);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setColumns(parsed);
          saveLocalColumns(parsed, tenantSlug);
        }
      } catch {}
    }
  }, [savedDbColumns, tenantSlug]);

  // Named personal saved views (filters + columns + sort), persisted per user in
  // SystemSettings. The legacy single saved view is surfaced as "My view".
  const restoredSearchRef = useRef(undefined);
  const {
    views: savedViews,
    viewsLoaded,
    defaultView,
    activeViewId,
    setActiveViewId,
    createView,
    updateView,
    renameView,
    deleteView,
    setDefaultView,
    isSaving: viewSaving,
  } = useSavedListViews({ page: 'members', memberId: memberInfo?.id, enabled: accessChecked });

  // Apply a view's saved filters. Full replace: keys absent from the view reset
  // to their defaults so switching between views never mixes filter values.
  const applyViewFilters = useCallback((f) => {
    const filters = f && typeof f === 'object' ? f : {};
    const search = typeof filters.searchQuery === 'string' ? filters.searchQuery : '';
    setSearchQuery(search);
    setStatusFilter(typeof filters.statusFilter === 'string' ? filters.statusFilter : 'all');
    setOrgFilter(typeof filters.orgFilter === 'string' ? filters.orgFilter : 'all');
    setRoleFilter(typeof filters.roleFilter === 'string' ? filters.roleFilter : 'all');
    setCoreFieldFilters({
      job_title: '',
      ...(filters.coreFieldFilters && typeof filters.coreFieldFilters === 'object' ? filters.coreFieldFilters : {})
    });
    // Coerce legacy single-value option filters (plain strings) to arrays.
    setCustomFieldFilters(
      filters.customFieldFilters && typeof filters.customFieldFilters === 'object'
        ? coerceCustomFilters(filters.customFieldFilters)
        : {}
    );
    setFilterOps(
      filters.filterOps && typeof filters.filterOps === 'object'
        ? sanitizeFilterOps(filters.filterOps)
        : {}
    );
    setSortField(typeof filters.sortField === 'string' ? filters.sortField : 'created_on');
    setSortDir(filters.sortDir === 'asc' || filters.sortDir === 'desc' ? filters.sortDir : 'desc');
    if (Array.isArray(filters.filterOrder)) {
      const saved = filters.filterOrder.filter(id => typeof id === 'string');
      if (memberCustomFieldsLoaded) {
        // Custom fields already loaded: reconcile now (drop stale, append new).
        const availSet = new Set(availableFilterIds);
        const kept = saved.filter(id => availSet.has(id));
        const additions = availableFilterIds.filter(id => !saved.includes(id));
        setFilterOrder([...kept, ...additions]);
      } else {
        // Apply as-is; the reconcile effect fixes it once fields load.
        setFilterOrder(saved);
      }
    } else {
      setFilterOrder(availableFilterIds);
    }
    setHiddenFilterIds(
      Array.isArray(filters.hiddenFilterIds)
        ? filters.hiddenFilterIds.filter(id => typeof id === 'string')
        : []
    );
    setCurrentPage(1);
    return search;
  }, [memberCustomFieldsLoaded, availableFilterIds]);

  // Apply a full saved view: filters plus (when the view carries them) columns.
  const applySavedView = useCallback((view) => {
    const search = applyViewFilters(view.filters);
    if (Array.isArray(view.columns) && view.columns.length > 0) {
      viewColumnsAppliedRef.current = true;
      setColumns(view.columns);
      saveLocalColumns(view.columns, tenantSlug);
    }
    setActiveViewId(view.id);
    return search;
  }, [applyViewFilters, tenantSlug, setActiveViewId]);

  // Apply the default view once, BEFORE the list query is allowed to run, so
  // users never see a flash of unfiltered results. No default = unfiltered load.
  useEffect(() => {
    if (filtersReady) return;
    if (!accessChecked) return;
    if (!memberInfo?.id) { setFiltersReady(true); return; }
    if (!viewsLoaded) return;
    // Apply the default view exactly once.
    if (restoredSearchRef.current === undefined) {
      restoredSearchRef.current = defaultView ? (applySavedView(defaultView) || '') : '';
    }
    // Wait for the debounced search to catch up to the restored value so the very
    // first list fetch already carries the saved search (no unfiltered flash + refetch).
    if (debouncedSearch === restoredSearchRef.current) {
      setFiltersReady(true);
    }
  }, [accessChecked, memberInfo?.id, viewsLoaded, defaultView, filtersReady, debouncedSearch, applySavedView]);

  // Snapshot of the current filters, sort and columns for saving into a view.
  const buildViewSnapshot = () => ({
    filters: {
      searchQuery,
      statusFilter,
      orgFilter,
      roleFilter,
      coreFieldFilters,
      customFieldFilters,
      filterOps,
      sortField,
      sortDir,
      filterOrder,
      hiddenFilterIds
    },
    columns,
  });

  // Batch delete mutation
  const batchDeleteMutation = useMutation({
    mutationFn: async (memberIds) => {
      for (const memberId of memberIds) {
        await base44.entities.Member.delete(memberId);
      }
      return { deletedCount: memberIds.length };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['members-paginated'] });
      setSelectedMembers([]);
      setSelectAllFiltered(false);
      setShowDeleteDialog(false);
      setDeleteConfirmText('');
      setSingleDeleteMember(null);
      toast({
        title: `${memberLabelPlural} deleted`,
        description: `Successfully deleted ${result.deletedCount} ${memberLabelPluralLower.replace(/s$/, '(s)')}.`
      });
    },
    onError: (error) => {
      toast({
        title: "Delete failed",
        description: error.message || `Could not delete ${memberLabelPluralLower}. Please try again.`,
        variant: "destructive"
      });
    }
  });

  // Selection handlers
  const toggleMemberSelection = (memberId, e) => {
    if (e?.stopPropagation) e.stopPropagation();
    if (selectAllFiltered) setSelectAllFiltered(false);
    setSelectedMembers(prev => 
      prev.includes(memberId) 
        ? prev.filter(id => id !== memberId)
        : [...prev, memberId]
    );
  };

  const toggleSelectAll = () => {
    const currentPageIds = paginatedMembers.map(m => m.id);
    const allSelected = currentPageIds.every(id => selectedMembers.includes(id));
    if (selectAllFiltered) setSelectAllFiltered(false);
    if (allSelected) {
      setSelectedMembers(prev => prev.filter(id => !currentPageIds.includes(id)));
    } else {
      setSelectedMembers(prev => [...new Set([...prev, ...currentPageIds])]);
    }
  };

  const handleDeleteClick = (member, e) => {
    e.stopPropagation();
    setSingleDeleteMember(member);
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = () => {
    if (singleDeleteMember) {
      batchDeleteMutation.mutate([singleDeleteMember.id]);
    } else {
      batchDeleteMutation.mutate(selectedMembers);
    }
  };

  const handleExportCSV = async () => {
    setIsExporting(true);
    try {
      const params = new URLSearchParams();
      if (selectAllFiltered) {
        if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
        if (orgFilter && orgFilter !== 'all') params.set('organizationId', orgFilter);
        if (roleFilter && roleFilter !== 'all') params.set('roleId', roleFilter);
        if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter);
      } else {
        params.set('ids', selectedMembers.join(','));
      }
      const response = await fetch(`/api/admin/members/export-csv?${params}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const today = new Date().toISOString().split('T')[0];
      link.download = `members_export_${today}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast({ title: "Export complete", description: `CSV file downloaded successfully.` });
    } catch (err) {
      toast({ title: "Export failed", description: err.message || "Could not export members.", variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  const orgMap = useMemo(() => {
    const map = {};
    organizations.forEach(org => { map[org.id] = org; });
    return map;
  }, [organizations]);

  const memberValuesMap = useMemo(() => {
    const map = {};
    members.forEach(m => {
      if (m.custom_fields) {
        map[m.id] = m.custom_fields;
      }
    });
    return map;
  }, [members]);

  // Core-field filters (job title / phone) are applied server-side via the
  // coreFilters param, so only the deleted-member guard remains client-side.
  const filteredMembers = useMemo(
    () => members.filter(m => !isDeletedMember(m)),
    [members]
  );

  const paginatedMembers = filteredMembers;

  const allPageSelected = paginatedMembers.length > 0 &&
    paginatedMembers.every(m => selectedMembers.includes(m.id));
  const showSelectAllBanner = allPageSelected && totalPages > 1 && !selectAllFiltered;

  const resetFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setOrgFilter('all');
    setRoleFilter('all');
    setCoreFieldFilters({ job_title: '' });
    setCustomFieldFilters({});
    setFilterOps({});
    setFilterOrder(availableFilterIds);
    setHiddenFilterIds([]);
    setCurrentPage(1);
  };

  const getMemberFilterLabel = useCallback((id) => {
    switch (id) {
      case 'status': return 'Status';
      case 'organisation': return 'Organisation';
      case 'role': return 'Role';
      case 'phone': return 'Phone';
      case 'job_title': return 'Job Title';
      default: {
        const field = memberFilterFields.find(f => f.id === id);
        return field?.label || 'Filter';
      }
    }
  }, [memberFilterFields]);

  const clearMemberFilterValue = useCallback((id) => {
    switch (id) {
      case 'status': setStatusFilter('all'); break;
      case 'organisation': setOrgFilter('all'); break;
      case 'role': setRoleFilter('all'); break;
      case 'phone': setCoreFieldFilters(prev => ({ ...prev, phone: '' })); break;
      case 'job_title': setCoreFieldFilters(prev => ({ ...prev, job_title: '' })); break;
      default: setCustomFieldFilters(prev => ({ ...prev, [id]: '' })); break;
    }
    // Clearing a filter also resets its condition back to the default.
    setFilterOps(prev => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setCurrentPage(1);
  }, []);

  // Change a filter's condition operator; emptiness operators drop the value.
  const setMemberFilterOp = useCallback((id, op) => {
    setFilterOps(prev => ({ ...prev, [id]: op }));
    setCurrentPage(1);
  }, []);

  // Hide/show a filter. Hiding clears any active value so users never filter by
  // something they can no longer see.
  const toggleMemberFilterHidden = useCallback((id) => {
    setHiddenFilterIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      clearMemberFilterValue(id);
      return [...prev, id];
    });
  }, [clearMemberFilterValue]);

  const filterSearchMatches = useMemo(() => {
    if (!filterSearchQuery.trim()) return [];
    const q = filterSearchQuery.toLowerCase();
    return orderedFilterIds.filter(id =>
      getMemberFilterLabel(id).toLowerCase().includes(q)
    );
  }, [filterSearchQuery, orderedFilterIds, getMemberFilterLabel]);

  const highlightFilterEl = useCallback((id) => {
    const el = document.querySelector(`[data-filter-id="${id}"]`);
    if (!el) return;
    el.classList.remove('filter-highlight-active');
    void el.offsetWidth;
    el.classList.add('filter-highlight-active');
    setTimeout(() => el.classList.remove('filter-highlight-active'), 1600);
  }, []);

  const handleFilterSearchSelect = useCallback((id) => {
    setFilterSearchQuery('');
    setFilterSearchOpen(false);
    if (hiddenFilterSet.has(id)) {
      toggleMemberFilterHidden(id);
      setTimeout(() => {
        document.querySelector(`[data-filter-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        highlightFilterEl(id);
      }, 100);
    } else {
      document.querySelector(`[data-filter-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      highlightFilterEl(id);
    }
  }, [hiddenFilterSet, toggleMemberFilterHidden, highlightFilterEl]);

  useEffect(() => {
    if (!filterSearchOpen) return;
    const handler = (e) => {
      if (filterSearchRef.current && !filterSearchRef.current.contains(e.target)) {
        setFilterSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [filterSearchOpen]);

  const handleFilterDragStart = (e, id) => {
    setDraggedFilterId(id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleFilterDragOver = (e, overId) => {
    e.preventDefault();
    if (draggedFilterId === null || draggedFilterId === overId) return;
    setFilterOrder(prev => {
      const from = prev.indexOf(draggedFilterId);
      const to = prev.indexOf(overId);
      if (from === -1 || to === -1) return prev;
      const updated = [...prev];
      const [removed] = updated.splice(from, 1);
      updated.splice(to, 0, removed);
      return updated;
    });
  };

  const handleFilterDragEnd = () => {
    setDraggedFilterId(null);
  };

  const renderMemberFilterControl = (id) => {
    switch (id) {
      case 'status':
        return (
          <div className="space-y-1.5">
            <Label className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Status</Label>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setCurrentPage(1); }}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-member-status-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-w-[260px]">
                {STATUS_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      case 'organisation': {
        const op = filterOps['organisation'] || 'any_of';
        return (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-1">
              <Label className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Organisation</Label>
              <FilterOperatorMenu
                operators={SELECT_OPERATORS}
                value={op}
                onChange={(v) => setMemberFilterOp('organisation', v)}
                testId="op-member-filter-organisation"
              />
            </div>
            {!isEmptinessOp(op) && (
              <Select value={orgFilter} onValueChange={(v) => { setOrgFilter(v); setCurrentPage(1); }}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-member-org-filter">
                  <SelectValue placeholder="All Organisations" />
                </SelectTrigger>
                <SelectContent className="max-w-[260px]">
                  <SelectItem value="all" className="text-xs">All Organisations</SelectItem>
                  {organizations.map(org => (
                    <SelectItem key={org.id} value={org.id} className="text-xs whitespace-normal break-words">
                      {org.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      }
      case 'role': {
        const op = filterOps['role'] || 'any_of';
        return (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-1">
              <Label className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Role</Label>
              <FilterOperatorMenu
                operators={SELECT_OPERATORS}
                value={op}
                onChange={(v) => setMemberFilterOp('role', v)}
                testId="op-member-filter-role"
              />
            </div>
            {!isEmptinessOp(op) && (
              <Select value={roleFilter} onValueChange={(v) => { setRoleFilter(v); setCurrentPage(1); }}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-member-role-filter">
                  <SelectValue placeholder="All Roles" />
                </SelectTrigger>
                <SelectContent className="max-w-[260px]">
                  <SelectItem value="all" className="text-xs">All Roles</SelectItem>
                  {roles.map(role => (
                    <SelectItem key={role.id} value={role.id} className="text-xs whitespace-normal break-words">
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      }
      case 'phone': {
        const op = filterOps['phone'] || 'contains';
        return (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-1">
              <Label className="text-[11px] text-slate-600 break-words">Phone</Label>
              <FilterOperatorMenu
                operators={TEXT_OPERATORS}
                value={op}
                onChange={(v) => setMemberFilterOp('phone', v)}
                testId="op-member-filter-phone"
              />
            </div>
            {!isEmptinessOp(op) && (
              <Input
                placeholder="Filter by phone..."
                value={coreFieldFilters.phone || ''}
                onChange={(e) => {
                  setCoreFieldFilters(prev => ({ ...prev, phone: e.target.value }));
                  setCurrentPage(1);
                }}
                className="h-8 text-xs"
                data-testid="input-filter-member-phone"
              />
            )}
          </div>
        );
      }
      case 'job_title': {
        const op = filterOps['job_title'] || 'contains';
        return (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-1">
              <Label className="text-[11px] text-slate-600 break-words">Job Title</Label>
              <FilterOperatorMenu
                operators={TEXT_OPERATORS}
                value={op}
                onChange={(v) => setMemberFilterOp('job_title', v)}
                testId="op-member-filter-job-title"
              />
            </div>
            {!isEmptinessOp(op) && (
              <Input
                placeholder="Filter by job title..."
                value={coreFieldFilters.job_title || ''}
                onChange={(e) => {
                  setCoreFieldFilters(prev => ({ ...prev, job_title: e.target.value }));
                  setCurrentPage(1);
                }}
                className="h-8 text-xs"
                data-testid="input-filter-member-job-title"
              />
            )}
          </div>
        );
      }
      default: {
        const field = memberFilterFields.find(f => f.id === id);
        if (!field) return null;
        const fieldOp = filterOps[field.id];
        if (field.field_type === 'boolean') {
          const op = fieldOp || 'is';
          return (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-1">
                <Label className="text-[11px] text-slate-600 break-words leading-tight">{field.label}</Label>
                <FilterOperatorMenu
                  operators={BOOLEAN_OPERATORS}
                  value={op}
                  onChange={(v) => setMemberFilterOp(field.id, v)}
                  testId={`op-member-filter-${field.id}`}
                />
              </div>
              {!isEmptinessOp(op) && (
                <Select
                  value={customFieldFilters[field.id] || 'all'}
                  onValueChange={(v) => {
                    setCustomFieldFilters(prev => ({ ...prev, [field.id]: v === 'all' ? '' : v }));
                    setCurrentPage(1);
                  }}
                >
                  <SelectTrigger className="h-8 text-xs" data-testid={`select-member-filter-bool-${field.id}`}>
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-xs">All</SelectItem>
                    <SelectItem value="__bool__:Yes" className="text-xs">Yes</SelectItem>
                    <SelectItem value="__bool__:No" className="text-xs">No</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          );
        }
        const validOptions = (field.options || []).filter(opt =>
          !opt.is_title && opt.value && opt.value.trim() !== ''
        );
        const hasOptions = validOptions.length > 0;
        if (hasOptions) {
          const op = fieldOp || 'any_of';
          const rawVal = customFieldFilters[field.id];
          const selectedValues = Array.isArray(rawVal)
            ? rawVal
            : (rawVal && rawVal !== 'all' ? [rawVal] : []);
          const labelForValue = (val) => {
            const opt = validOptions.find(o => o.value === val);
            return opt?.label || val;
          };
          const setSelectedValues = (vals) => {
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
                  onChange={(v) => setMemberFilterOp(field.id, v)}
                  testId={`op-member-filter-${field.id}`}
                />
              </div>
              {!isEmptinessOp(op) && (
                <>
                  <MultiSelectFilter
                    options={validOptions.map(opt => ({ value: opt.value, label: opt.label || opt.value }))}
                    selected={selectedValues}
                    onChange={setSelectedValues}
                    placeholder="All"
                    className="h-8 min-h-8 w-full text-xs"
                    data-testid={`select-member-filter-${field.id}`}
                  />
                  {selectedValues.length > 1 && (
                    <div className="flex flex-wrap gap-1">
                      {selectedValues.map(val => (
                        <Badge
                          key={val}
                          variant="secondary"
                          className="text-[10px] font-normal max-w-full gap-1"
                          data-testid={`badge-member-filter-${field.id}-${val}`}
                        >
                          <span className="truncate">{labelForValue(val)}</span>
                          <button
                            type="button"
                            className="shrink-0 rounded-full"
                            onClick={() => setSelectedValues(selectedValues.filter(v => v !== val))}
                            aria-label={`Remove ${labelForValue(val)}`}
                            data-testid={`button-remove-member-filter-${field.id}-${val}`}
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
                onChange={(v) => setMemberFilterOp(field.id, v)}
                testId={`op-member-filter-${field.id}`}
              />
            </div>
            {!isEmptinessOp(op) && (
              <Input
                placeholder="Filter..."
                value={textValue}
                onChange={(e) => {
                  const val = e.target.value;
                  setCustomFieldFilters(prev => ({
                    ...prev,
                    [field.id]: val ? `__text__:${val}` : ''
                  }));
                  setCurrentPage(1);
                }}
                className="h-8 text-xs"
                data-testid={`input-member-filter-cf-${field.id}`}
              />
            )}
          </div>
        );
      }
    }
  };

  const hasActiveFilters = searchQuery || 
    statusFilter !== 'all' || 
    orgFilter !== 'all' ||
    roleFilter !== 'all' ||
    Object.values(coreFieldFilters).some(v => v && v.trim() !== '') ||
    Object.values(customFieldFilters).some(isActiveCustomFilterValue) ||
    Object.values(filterOps).some(isEmptinessOp);

  // Reconcile columns when custom fields load or when their column-visibility changes:
  // add any newly column-visible fields and prune custom columns whose field is no
  // longer column-visible (or no longer exists). Gated on the query having loaded so
  // an in-flight empty default doesn't wipe saved preferences.
  useEffect(() => {
    if (!memberCustomFieldsLoaded) return;
    setColumns(prev => {
      const allowedFieldIds = new Set(memberColumnFields.map(f => f.id));
      const existingFieldIds = new Set(
        prev.filter(c => c.isCustomField && c.fieldId).map(c => c.fieldId)
      );
      const pruned = prev.filter(c => !c.isCustomField || allowedFieldIds.has(c.fieldId));
      const additions = memberColumnFields
        .filter(f => !existingFieldIds.has(f.id))
        .map(f => ({
          id: `cf_${f.id}`,
          label: f.label,
          visible: false,
          locked: false,
          isCustomField: true,
          fieldId: f.id
        }));
      if (pruned.length === prev.length && additions.length === 0) return prev;
      const updated = [...pruned, ...additions];
      saveLocalColumns(updated, tenantSlug);
      return updated;
    });
  }, [memberColumnFields, memberCustomFieldsLoaded, tenantSlug]);

  // Reconcile the filter order once custom fields have loaded: drop ids that no
  // longer exist and append any newly available filters not present in the saved
  // order (so new custom fields still show up, after the saved ones).
  useEffect(() => {
    if (!memberCustomFieldsLoaded) return;
    setFilterOrder(prev => {
      const availSet = new Set(availableFilterIds);
      const kept = prev.filter(id => availSet.has(id));
      const additions = availableFilterIds.filter(id => !prev.includes(id));
      if (additions.length === 0 && kept.length === prev.length) return prev;
      return [...kept, ...additions];
    });
  }, [availableFilterIds, memberCustomFieldsLoaded]);

  const visibleColumns = columns.filter(c => c.visible);

  const toggleColumnVisibility = (colId) => {
    setColumns(prev => {
      const updated = prev.map(c => c.id === colId && !c.locked ? { ...c, visible: !c.visible } : c);
      saveLocalColumns(updated, tenantSlug);
      return updated;
    });
  };

  const handleDragStart = (e, index) => {
    if (columns[index].locked) return;
    setDraggedColumn(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    if (draggedColumn === null || draggedColumn === index || columns[index].locked) return;
    
    setColumns(prev => {
      const updated = [...prev];
      const [removed] = updated.splice(draggedColumn, 1);
      updated.splice(index, 0, removed);
      setDraggedColumn(index);
      return updated;
    });
  };

  const handleDragEnd = () => {
    if (draggedColumn !== null) {
      saveLocalColumns(columns, tenantSlug);
    }
    setDraggedColumn(null);
  };

  const resetColumns = () => {
    const customFieldCols = memberColumnFields.map(f => ({
      id: `cf_${f.id}`,
      label: f.label,
      visible: false,
      locked: false,
      isCustomField: true,
      fieldId: f.id
    }));
    const newColumns = [...DEFAULT_COLUMNS, ...customFieldCols];
    setColumns(newColumns);
    saveLocalColumns(newColumns, tenantSlug);
  };

  const getCellValue = (member, col) => {
    if (col.isCustomField) {
      return memberValuesMap[member.id]?.[col.fieldId] || '-';
    }
    
    switch (col.id) {
      case 'name':
        return (
          <div className="flex items-center gap-3 flex-wrap">
            <Avatar className="h-8 w-8">
              <AvatarImage src={member.profile_photo} />
              <AvatarFallback className="bg-blue-100 text-blue-700 text-xs">
                {getInitials(getMemberName(member))}
              </AvatarFallback>
            </Avatar>
            <span className="font-medium text-slate-900">{getMemberName(member) || 'Unknown'}</span>
            {member.is_guest && (
              <span onClick={(e) => e.stopPropagation()}>
                <GuestAccessControl
                  member={member}
                  canManage={isAccessReady && !isFeatureExcluded('element_TeamLoginAccessToggle')}
                  testIdSuffix={`row-${member.id}`}
                />
              </span>
            )}
          </div>
        );
      case 'email':
        return member.email || '-';
      case 'organization':
        const org = orgMap[member.organization_id];
        return org?.name || '-';
      case 'job_title':
        return member.job_title || '-';
      case 'mobile':
        return member.mobile || '-';
      case 'status':
        return member.disabled ? (
          <Badge variant="secondary" className="bg-red-100 text-red-700">Disabled</Badge>
        ) : (
          <Badge variant="secondary" className="bg-green-100 text-green-700">Active</Badge>
        );
      case 'roles':
        // Support both legacy 'roles' array and new 'role_id' single value
        const memberRoleId = member.role_id;
        const memberRoles = member.roles || (memberRoleId ? [memberRoleId] : []);
        if (memberRoles.length === 0) return '-';
        return (
          <div className="flex flex-wrap gap-1">
            {memberRoles.slice(0, 2).map((roleId, idx) => {
              const role = roles.find(r => r.id === roleId);
              if (!role && roleId) {
                // Role not in this tenant's loaded role list — surface a clear
                // "Unknown role" badge and warn so cross-tenant role leaks
                // (see task-647) become visible rather than rendering a raw
                // UUID. Never expose the offending UUID in the UI.
                console.warn('[MembersList] Unknown role on member', {
                  role_id: roleId,
                  member_id: member.id,
                  tenant_id: member.tenant_id,
                });
              }
              return (
                <RoleBadge
                  key={idx}
                  role={role}
                  name={role?.name || 'Unknown role'}
                  className="text-xs"
                  data-testid={`badge-role-${roleId}`}
                />
              );
            })}
            {memberRoles.length > 2 && (
              <Badge variant="outline" className="text-xs">+{memberRoles.length - 2}</Badge>
            )}
          </div>
        );
      default:
        return '-';
    }
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (isCreatingNew) {
    return (
      <MemberDetailView
        member={{}}
        onBack={() => setIsCreatingNew(false)}
        memberCustomFields={memberCustomFields}
        organizations={organizations}
        roles={roles}
        isNew={true}
        onCreated={(createdMember) => {
          setIsCreatingNew(false);
          navigate(getMemberDetailUrl(createdMember.id));
        }}
      />
    );
  }

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
                    onClick={resetFilters}
                    className="text-slate-500 hover:text-slate-700 h-8 px-2"
                    data-testid="button-reset-member-filters"
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
                  data-testid="button-collapse-member-sidebar"
                >
                  <PanelLeftClose className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div className="mb-2">
              <SavedViewSwitcher
                views={savedViews}
                activeViewId={activeViewId}
                isSaving={viewSaving}
                onApplyView={applySavedView}
                onClearView={() => { setActiveViewId(null); resetFilters(); }}
                onCreateView={(name, opts) =>
                  createView(name, buildViewSnapshot(), opts).then(v => setActiveViewId(v.id))
                }
                onUpdateView={(view) => updateView(view.id, buildViewSnapshot())}
                onRenameView={(view, name) => renameView(view.id, name)}
                onDeleteView={(view) => deleteView(view.id)}
                onSetDefault={(viewId) => setDefaultView(viewId)}
                testIdPrefix="member-view"
              />
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder={`Search ${memberLabelPluralLower}...`}
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                className="pl-9"
                data-testid="input-search-members"
              />
            </div>
            <div className="relative mt-2" ref={filterSearchRef}>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              <Input
                placeholder="Search filters..."
                value={filterSearchQuery}
                onChange={(e) => { setFilterSearchQuery(e.target.value); setFilterSearchOpen(true); }}
                onFocus={() => { if (filterSearchQuery) setFilterSearchOpen(true); }}
                className="pl-8 h-8 text-xs"
                data-testid="input-filter-search-members"
              />
              {filterSearchOpen && filterSearchQuery.trim() && (
                <div className="absolute z-50 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg max-h-52 overflow-y-auto">
                  {filterSearchMatches.length > 0 ? (
                    filterSearchMatches.map(id => (
                      <button
                        key={id}
                        type="button"
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 flex items-center justify-between gap-2"
                        onMouseDown={(e) => { e.preventDefault(); handleFilterSearchSelect(id); }}
                        data-testid={`filter-search-result-member-${id}`}
                      >
                        <span>{getMemberFilterLabel(id)}</span>
                        {hiddenFilterSet.has(id) && <span className="text-slate-400 text-[10px] shrink-0">hidden</span>}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-xs text-slate-400">No matching filters</div>
                  )}
                </div>
              )}
            </div>
          </div>

          <ScrollArea className="flex-1 p-4 min-w-[288px]">
            <div className="space-y-3">
              {visibleOrderedFilterIds.map(id => {
                const control = renderMemberFilterControl(id);
                if (!control) return null;
                return (
                  <div
                    key={id}
                    onDragOver={(e) => handleFilterDragOver(e, id)}
                    className={`flex items-center gap-1.5 rounded-md ${draggedFilterId === id ? 'opacity-50' : ''}`}
                    data-testid={`member-filter-row-${id}`}
                    data-filter-id={id}
                  >
                    <div
                      draggable
                      onDragStart={(e) => handleFilterDragStart(e, id)}
                      onDragEnd={handleFilterDragEnd}
                      className="shrink-0 cursor-grab text-slate-400 hover:text-slate-600"
                      aria-label="Drag to reorder filter"
                      title="Drag to reorder filter"
                      data-testid={`drag-member-filter-${id}`}
                    >
                      <GripVertical className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      {control}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleMemberFilterHidden(id)}
                      className="shrink-0 h-6 w-6 text-slate-400 hover:text-slate-600"
                      aria-label={`Hide ${getMemberFilterLabel(id)} filter`}
                      title="Hide this filter"
                      data-testid={`toggle-hide-member-filter-${id}`}
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>

            {hiddenOrderedFilterIds.length > 0 && (
              <div className="mt-6 pt-4 border-t border-slate-200">
                <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide mb-2">
                  Hidden filters
                </p>
                <div className="space-y-1">
                  {hiddenOrderedFilterIds.map(id => (
                    <div
                      key={id}
                      className="flex items-center gap-1.5 rounded-md"
                      data-testid={`member-hidden-filter-row-${id}`}
                      data-filter-id={id}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleMemberFilterHidden(id)}
                        className="shrink-0 h-6 w-6 text-slate-400 hover:text-slate-600"
                        aria-label={`Show ${getMemberFilterLabel(id)} filter`}
                        title="Show this filter"
                        data-testid={`toggle-show-member-filter-${id}`}
                      >
                        <EyeOff className="w-3.5 h-3.5" />
                      </Button>
                      <span className="flex-1 min-w-0 text-xs text-slate-500 truncate">
                        {getMemberFilterLabel(id)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </ScrollArea>

          <div className="p-4 border-t border-slate-200 bg-slate-50 min-w-[288px]">
            <p className="text-xs text-slate-500">
              Showing {filteredMembers.length} of {pagination.total} {memberLabelPluralLower}
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
                    data-testid="button-expand-member-sidebar"
                  >
                    <PanelLeft className="w-4 h-4" />
                  </Button>
                )}
                <div>
                  <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
                    <Users className="w-5 h-5 text-blue-600" />
                    {memberLabelPlural}
                  </h1>
                  <p className="text-sm text-slate-500">
                    {pagination.total} {pagination.total !== 1 ? memberLabelPluralLower : memberLabelLower}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {viewMode === 'list' && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1" data-testid="button-configure-member-columns">
                        <Columns3 className="w-4 h-4" />
                        Columns
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80" align="end">
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <h4 className="font-medium text-sm">Configure Columns</h4>
                          <Button variant="ghost" size="sm" onClick={resetColumns} className="h-7 text-xs" data-testid="button-reset-member-columns">
                            Reset
                          </Button>
                        </div>
                        <p className="text-xs text-slate-500">Drag to reorder. Click to show/hide.</p>
                        <p className="text-xs text-slate-500">Use the views menu in the filter pane to save your columns, filters and sort as a named view.</p>
                        <ScrollArea className="h-56">
                          <div className="space-y-1">
                            {columns.map((col, index) => (
                              <div
                                key={col.id}
                                draggable={!col.locked}
                                onDragStart={(e) => handleDragStart(e, index)}
                                onDragOver={(e) => handleDragOver(e, index)}
                                onDragEnd={handleDragEnd}
                                className={`flex items-center gap-2 p-2 rounded-md border ${
                                  draggedColumn === index ? 'border-blue-400 bg-blue-50' : 'border-transparent hover:bg-slate-50'
                                } ${col.locked ? 'opacity-60' : 'cursor-grab'}`}
                                data-testid={`member-column-item-${col.id}`}
                              >
                                <GripVertical className={`w-4 h-4 text-slate-400 ${col.locked ? 'invisible' : ''}`} />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  onClick={() => toggleColumnVisibility(col.id)}
                                  disabled={col.locked}
                                  data-testid={`toggle-member-column-${col.id}`}
                                >
                                  {col.visible ? (
                                    <Eye className="w-3.5 h-3.5 text-blue-600" />
                                  ) : (
                                    <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                                  )}
                                </Button>
                                <span className={`text-sm flex-1 ${col.visible ? 'text-slate-900' : 'text-slate-400'}`}>
                                  {col.id === 'name' ? memberLabel : col.label}
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
                )}
                {(selectedMembers.length > 0 || selectAllFiltered) && (
                  <>
                    <Button 
                      variant="outline"
                      onClick={handleExportCSV}
                      disabled={isExporting}
                      className="gap-1"
                      data-testid="button-export-csv-members"
                    >
                      {isExporting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                      Export CSV {selectAllFiltered ? `(${pagination.total})` : `(${selectedMembers.length})`}
                    </Button>
                    {selectedMembers.length > 0 && (
                      <Button 
                        variant="destructive"
                        onClick={() => setShowDeleteDialog(true)}
                        className="gap-1"
                        data-testid="button-delete-selected-members"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete Selected ({selectedMembers.length})
                      </Button>
                    )}
                    <Button 
                      variant="ghost"
                      size="sm"
                      onClick={() => { setSelectedMembers([]); setSelectAllFiltered(false); }}
                      className="text-slate-500"
                      data-testid="button-clear-selection-members"
                    >
                      <X className="w-3 h-3 mr-1" />
                      Clear selection
                    </Button>
                  </>
                )}
                <Button 
                  onClick={() => setIsCreatingNew(true)}
                  className="gap-1"
                  data-testid="button-add-member"
                >
                  <Users className="w-4 h-4" />
                  Add {memberLabel}
                </Button>
                <div className="bg-slate-100 rounded-lg p-1 flex">
                  <Button
                    variant={viewMode === 'list' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('list')}
                    className="gap-1"
                    data-testid="button-member-view-list"
                  >
                    <LayoutList className="w-4 h-4" />
                    List
                  </Button>
                  <Button
                    variant={viewMode === 'card' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('card')}
                    className="gap-1"
                    data-testid="button-member-view-card"
                  >
                    <LayoutGrid className="w-4 h-4" />
                    Cards
                  </Button>
                </div>
              </div>
            </div>
          </header>

          {(showSelectAllBanner || selectAllFiltered) && (
            <div className="bg-blue-50 border-b border-blue-200 px-6 py-2 text-sm text-blue-700 flex items-center justify-center gap-2" data-testid="banner-select-all-members">
              {selectAllFiltered ? (
                <>
                  All {pagination.total} {memberLabelPluralLower} are selected.
                  <button 
                    className="font-semibold underline"
                    onClick={() => { setSelectAllFiltered(false); setSelectedMembers([]); }}
                    data-testid="button-clear-all-selection-members"
                  >
                    Clear selection
                  </button>
                </>
              ) : (
                <>
                  All {paginatedMembers.length} on this page selected.
                  <button 
                    className="font-semibold underline"
                    onClick={() => setSelectAllFiltered(true)}
                    data-testid="button-select-all-filtered-members"
                  >
                    Select all {pagination.total} {memberLabelPluralLower}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="flex-1 overflow-auto p-6">
            {widgetDrill && (
              <div className="mb-4">
                <WidgetDrillChip drill={widgetDrill} onClear={clearDrill} />
              </div>
            )}
            {membersLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : paginatedMembers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                <Users className="w-16 h-16 mb-4 text-slate-300" />
                <p className="text-lg font-medium">No {memberLabelPluralLower} found</p>
                <p className="text-sm">Try adjusting your filters</p>
              </div>
            ) : viewMode === 'list' ? (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <Checkbox 
                          checked={paginatedMembers.length > 0 && paginatedMembers.every(m => selectedMembers.includes(m.id))}
                          onCheckedChange={toggleSelectAll}
                          data-testid="checkbox-select-all-members"
                        />
                      </TableHead>
                      {visibleColumns.map(col => {
                        const sortKey = col.isCustomField ? null : MEMBER_SORT_KEYS[col.id];
                        return (
                          <TableHead
                            key={col.id}
                            className="whitespace-nowrap"
                            aria-sort={getAriaSort(sortKey, sortField, sortDir)}
                          >
                            <SortableHeader
                              field={sortKey}
                              sortField={sortField}
                              sortDir={sortDir}
                              onSort={handleSort}
                              sortable={!!sortKey}
                            >
                              {col.id === 'name' ? memberLabel : col.label}
                            </SortableHeader>
                          </TableHead>
                        );
                      })}
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedMembers.map(member => (
                      <TableRow 
                        key={member.id} 
                        className={`cursor-pointer hover:bg-slate-50 ${selectedMembers.includes(member.id) ? 'bg-blue-50' : ''}`}
                        onClick={() => navigate(getMemberDetailUrl(member.id))}
                        data-testid={`member-row-${member.id}`}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox 
                            checked={selectedMembers.includes(member.id)}
                            onCheckedChange={() => toggleMemberSelection(member.id)}
                            data-testid={`checkbox-member-${member.id}`}
                          />
                        </TableCell>
                        {visibleColumns.map(col => (
                          <TableCell key={col.id}>{getCellValue(member, col)}</TableCell>
                        ))}
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-400 hover:text-red-600"
                            onClick={(e) => handleDeleteClick(member, e)}
                            data-testid={`button-delete-member-${member.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {paginatedMembers.map(member => {
                  const org = orgMap[member.organization_id];
                  return (
                    <Card 
                      key={member.id} 
                      className="cursor-pointer hover:shadow-md transition-shadow"
                      onClick={() => navigate(getMemberDetailUrl(member.id))}
                      data-testid={`member-card-${member.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <Avatar className="h-12 w-12">
                            <AvatarImage src={member.profile_photo} />
                            <AvatarFallback className="bg-blue-100 text-blue-700">
                              {getInitials(getMemberName(member))}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium text-slate-900 truncate">{getMemberName(member) || 'Unknown'}</h3>
                            {member.job_title && (
                              <p className="text-sm text-slate-500 truncate flex items-center gap-1">
                                <Briefcase className="w-3 h-3" />
                                {member.job_title}
                              </p>
                            )}
                            {org && (
                              <p className="text-sm text-slate-500 truncate flex items-center gap-1">
                                <Building2 className="w-3 h-3" />
                                {org.name}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            {member.disabled ? (
                              <Badge variant="secondary" className="bg-red-100 text-red-700 text-xs">Disabled</Badge>
                            ) : (
                              <Badge variant="secondary" className="bg-green-100 text-green-700 text-xs">Active</Badge>
                            )}
                            {member.is_guest && (
                              <span onClick={(e) => e.stopPropagation()}>
                                <GuestAccessControl
                                  member={member}
                                  canManage={isAccessReady && !isFeatureExcluded('element_TeamLoginAccessToggle')}
                                  testIdSuffix={`card-${member.id}`}
                                />
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="mt-3 pt-3 border-t border-slate-100 space-y-1">
                          {member.email && (
                            <p className="text-xs text-slate-500 truncate flex items-center gap-1">
                              <Mail className="w-3 h-3" />
                              {member.email}
                            </p>
                          )}
                          {member.phone && (
                            <p className="text-xs text-slate-500 flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {member.phone}
                            </p>
                          )}
                          {member.mobile && (
                            <p className="text-xs text-slate-500 flex items-center gap-1">
                              <Smartphone className="w-3 h-3" />
                              {member.mobile}
                            </p>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {!membersLoading && (
            <div className="bg-white border-t border-slate-200 px-6 py-4 flex-shrink-0">
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-500">
                  {membersFetching && <Loader2 className="w-3 h-3 inline-block mr-1 animate-spin" />}
                  {pagination.total > 0 ? (
                    <>
                      Showing {((currentPage - 1) * itemsPerPage) + 1}-{Math.min(currentPage * itemsPerPage, pagination.total)} of {pagination.total} {memberLabelPluralLower}
                      {totalPages > 1 && ` (Page ${currentPage} of ${totalPages})`}
                    </>
                  ) : (
                    `No ${memberLabelPluralLower} found`
                  )}
                </p>
                {totalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1 || membersFetching}
                      data-testid="button-member-prev-page"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages || membersFetching}
                      data-testid="button-member-next-page"
                    >
                      Next
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={(open) => {
        setShowDeleteDialog(open);
        if (!open) {
          setDeleteConfirmText('');
          setSingleDeleteMember(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Delete {singleDeleteMember ? memberLabel : memberLabelPlural}
            </DialogTitle>
            <DialogDescription className="text-left space-y-3 pt-2">
              {singleDeleteMember ? (
                <p>
                  You are about to permanently delete <strong>{getMemberName(singleDeleteMember)}</strong>.
                </p>
              ) : (
                <p>
                  You are about to permanently delete <strong>{selectedMembers.length} {selectedMembers.length !== 1 ? memberLabelPluralLower : memberLabelLower}</strong>.
                </p>
              )}
              <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3 text-destructive text-sm">
                <strong>Warning:</strong> This action cannot be undone.
              </div>
              <p className="text-sm">
                To confirm, please type <strong>DELETE</strong> below:
              </p>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Input 
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Type DELETE to confirm"
              data-testid="input-delete-member-confirm"
            />
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowDeleteDialog(false);
                setDeleteConfirmText('');
                setSingleDeleteMember(null);
              }}
              data-testid="button-cancel-member-delete"
            >
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={deleteConfirmText !== 'DELETE' || batchDeleteMutation.isPending}
              data-testid="button-confirm-member-delete"
            >
              {batchDeleteMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete {singleDeleteMember ? '1' : selectedMembers.length} {(singleDeleteMember || selectedMembers.length === 1) ? memberLabel : memberLabelPlural}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
