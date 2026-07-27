import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { COUNTRIES } from "@/data/countries";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useSearchParams, useNavigate, useParams } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "date-fns";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { 
  Building2, 
  Search, 
  LayoutGrid, 
  LayoutList, 
  Filter, 
  X, 
  ChevronLeft, 
  ChevronRight, 
  Users, 
  Globe, 
  Phone, 
  Mail, 
  MapPin,
  Loader2,
  SlidersHorizontal,
  RotateCcw,
  Columns3,
  GripVertical,
  PanelLeftClose,
  PanelLeft,
  Eye,
  EyeOff,
  Calendar,
  Trash2,
  AlertTriangle,
  ShieldCheck,
  Download,
  ChevronsUpDown,
  Check
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { isOrgAdminColumnVisible, isOrgAdminFilterVisible } from "@/pages/CustomFieldsAdmin";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { createPageUrl, isDeletedMember } from "@/utils";
import OrganisationDetailView from "@/components/OrganisationDetailView";
import { useToast } from "@/components/ui/use-toast";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import SortableHeader, { getAriaSort } from "@/components/SortableHeader";
import { safeLogoSrc } from "@/lib/safeLogoSrc";
import MultiSelectFilter from "@/components/MultiSelectFilter";
import {
  coerceCustomFilters,
  isActiveCustomFilterValue,
  TEXT_OPERATORS,
  OPTION_OPERATORS,
  BOOLEAN_OPERATORS,
  COUNTRY_OPERATORS,
  isEmptinessOp,
  buildCustomFilterWireValue,
  sanitizeFilterOps,
} from "@/lib/customFilterUtils";
import FilterOperatorMenu from "@/components/FilterOperatorMenu";
import { useSavedListViews } from "@/hooks/useSavedListViews";
import SavedViewSwitcher from "@/components/SavedViewSwitcher";
import { useMemberTerminology } from "@/contexts/MemberTerminologyContext";
import { useWidgetDrill, WidgetDrillChip } from "@/components/dashboard/widgetDrill";

function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

const ORG_SORT_KEYS = {
  name: 'name',
  members: 'members',
  contact: 'invoicing_email',
  email: 'invoicing_email',
  phone: 'phone',
  website: 'website_url',
  description: 'description',
  created_at: 'created_at',
};

const DEFAULT_COLUMNS = [
  { id: 'name', label: 'Organisation', visible: true, locked: true },
  { id: 'members', label: 'Members', visible: true, locked: false },
  { id: 'contact', label: 'Contact', visible: true, locked: false },
  { id: 'email', label: 'Email', visible: false, locked: false },
  { id: 'phone', label: 'Phone', visible: false, locked: false },
  { id: 'website', label: 'Website', visible: false, locked: false },
  { id: 'address', label: 'Address', visible: false, locked: false },
  { id: 'description', label: 'Description', visible: false, locked: false },
  { id: 'created_at', label: 'Created', visible: false, locked: false },
];

const getStorageKey = (tenantSlug) => `organisations_list_columns_${tenantSlug || 'default'}`;
const getColumnPrefKey = (memberId) => `crm_org_columns_${memberId}`;

// Stable ids for the reorderable filters in the left pane (core filters first;
// custom fields are appended by their field id).
const DEFAULT_ORG_FILTER_ORDER = ['phone', 'email', 'website', 'address'];

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


function CountryFilterCombobox({ label, fieldId, selectedName, onChange, operatorMenu, hideValue }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const filtered = search
    ? COUNTRIES.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    : COUNTRIES;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-1">
        <Label className="text-[11px] text-slate-600 break-words leading-tight">{label}</Label>
        {operatorMenu}
      </div>
      {hideValue ? null : (
      <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setSearch(''); }}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between h-8 text-xs font-normal"
            data-testid={`select-filter-country-${fieldId}`}
          >
            <span className="truncate">{selectedName || 'All'}</span>
            <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[220px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search countries..." value={search} onValueChange={setSearch} className="text-xs h-8" />
            <CommandList>
              <CommandEmpty className="text-xs py-2 text-center">No country found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="all"
                  onSelect={() => { onChange(''); setOpen(false); setSearch(''); }}
                  className="text-xs"
                >
                  <Check className={cn("mr-2 h-3 w-3", !selectedName ? "opacity-100" : "opacity-0")} />
                  All
                </CommandItem>
                {filtered.map(c => (
                  <CommandItem
                    key={c.code}
                    value={c.name}
                    onSelect={() => { onChange(c.name); setOpen(false); setSearch(''); }}
                    className="text-xs"
                  >
                    <Check className={cn("mr-2 h-3 w-3", selectedName === c.name ? "opacity-100" : "opacity-0")} />
                    {c.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      )}
    </div>
  );
}

export default function OrganisationsListPage() {
  const { isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const { memberLabel, memberLabelPlural } = useMemberTerminology();
  // Column labels are persisted (localStorage/DB), so the "Members" column
  // label is resolved at render time from the configured terminology.
  const displayColumnLabel = (col) => (col.id === 'members' ? memberLabelPlural : col.label);
  const { tenantSlug } = useTenantBranding() || {};
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { id: urlOrgId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [accessChecked, setAccessChecked] = useState(false);
  const lastLoadedSlugRef = useRef(undefined);
  const autoSelectHandledRef = useRef(false);
  
  const [viewMode, setViewMode] = useState('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [coreFieldFilters, setCoreFieldFilters] = useState({
    phone: '',
    website_url: '',
    invoicing_email: '',
    invoicing_address: ''
  });
  const [customFieldFilters, setCustomFieldFilters] = useState({});
  // Per-filter condition operators, keyed by filter id (custom field id or
  // core filter id). Absent key = the filter's default operator.
  const [filterOps, setFilterOps] = useState({});
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(20);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedOrgs, setSelectedOrgs] = useState([]);
  const [selectAllFiltered, setSelectAllFiltered] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [singleDeleteOrg, setSingleDeleteOrg] = useState(null);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [draggedColumn, setDraggedColumn] = useState(null);
  const [sortField, setSortField] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [filtersReady, setFiltersReady] = useState(false);
  const [filterOrder, setFilterOrder] = useState(DEFAULT_ORG_FILTER_ORDER);
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

  useRealtimeSubscription('organization', [['organizations-crm-paginated']], { 
    enabled: accessChecked, 
    tenantId: memberInfo?.tenant_id 
  });

  // Load columns from tenant-scoped localStorage on mount or when tenant slug changes
  // Falls back to 'default' namespace if no tenantSlug is available (e.g., platform admin)
  // Also merges in any new DEFAULT_COLUMNS that don't exist in saved prefs
  useEffect(() => {
    const currentSlug = tenantSlug || 'default';
    if (lastLoadedSlugRef.current !== currentSlug) {
      const saved = loadLocalColumns(tenantSlug);
      if (saved) {
        // Merge in any new default columns that don't exist in saved prefs
        const existingIds = new Set(saved.map(c => c.id));
        const newDefaultColumns = DEFAULT_COLUMNS.filter(dc => !existingIds.has(dc.id));
        const merged = newDefaultColumns.length > 0 ? [...saved, ...newDefaultColumns] : saved;
        setColumns(merged);
        if (newDefaultColumns.length > 0) {
          saveLocalColumns(merged, tenantSlug);
        }
      } else if (lastLoadedSlugRef.current !== undefined) {
        // Reset to defaults when switching to a new tenant with no saved preferences
        setColumns(DEFAULT_COLUMNS);
      }
      lastLoadedSlugRef.current = currentSlug;
    }
  }, [tenantSlug]);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('crm.organisations')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const debouncedSearch = useDebounce(searchQuery, 300);

  const { data: orgCustomFields = [], isSuccess: orgCustomFieldsLoaded } = useQuery({
    queryKey: ['/api/entities/PreferenceField', 'organization', 'crm'],
    enabled: accessChecked,
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'organization' },
          sort: { display_order: 'asc' }
        });
        // Include any field admin-visible as either a column or a filter; consumers below split further.
        return (fields || []).filter(f => f.entity_scope === 'organization' && (isOrgAdminColumnVisible(f) || isOrgAdminFilterVisible(f)));
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => f.entity_scope === 'organization' && (isOrgAdminColumnVisible(f) || isOrgAdminFilterVisible(f)));
        } catch {
          return [];
        }
      }
    }
  });

  // Fields available as columns in the CRM table (column picker, table cells, card back).
  const orgColumnFields = useMemo(
    () => orgCustomFields.filter(f => isOrgAdminColumnVisible(f)),
    [orgCustomFields]
  );
  // Fields available in the sidebar filter list.
  const orgFilterFields = useMemo(
    () => orgCustomFields.filter(f => isOrgAdminFilterVisible(f)),
    [orgCustomFields]
  );
  // All filter ids currently available, in default display order (core then custom).
  const availableFilterIds = useMemo(
    () => [...DEFAULT_ORG_FILTER_ORDER, ...orgFilterFields.map(f => f.id)],
    [orgFilterFields]
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

  // Only the active custom filters, serialised so the server can apply them at
  // the DB level (totals + paging span the whole tenant, not just one page).
  const activeCustomFilters = useMemo(() => {
    const obj = {};
    // Union of ids with a value and ids with an emptiness operator (which
    // filter without any value).
    const ids = new Set([
      ...Object.keys(customFieldFilters),
      ...orgFilterFields.map(f => f.id).filter(id => isEmptinessOp(filterOps[id])),
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
  }, [customFieldFilters, filterOps, orgFilterFields]);
  const customFiltersParam = useMemo(() => JSON.stringify(activeCustomFilters), [activeCustomFilters]);
  // Custom field ids whose values the server should fetch for the current page
  // so custom-field columns populate on every row.
  const customFieldIdsParam = useMemo(
    () => orgColumnFields.map(f => f.id).join(','),
    [orgColumnFields]
  );
  // Direct-column filters with operators, sent as the coreFilters param and
  // applied server-side. Filter id -> DB column mapping.
  const coreFiltersParam = useMemo(() => {
    const obj = {};
    const addText = (filterId, stateKey, column) => {
      const op = filterOps[filterId] || 'contains';
      const value = (coreFieldFilters[stateKey] || '').trim();
      if (isEmptinessOp(op)) {
        obj[column] = { op };
      } else if (value) {
        obj[column] = { op, value };
      }
    };
    addText('phone', 'phone', 'phone');
    addText('email', 'invoicing_email', 'invoicing_email');
    addText('website', 'website_url', 'website_url');
    addText('address', 'invoicing_address', 'invoicing_address');
    return Object.keys(obj).length > 0 ? JSON.stringify(obj) : '';
  }, [coreFieldFilters, filterOps]);

  // Dashboard widget click-through: restrict the list to the ids stored
  // by the clicked widget bucket (see components/dashboard/widgetDrill.jsx).
  const { drill: widgetDrill, drillIdsParam, clearDrill } = useWidgetDrill(searchParams, setSearchParams);

  const { data: orgsData, isLoading: orgsLoading } = useQuery({
    queryKey: ['organizations-crm-paginated', currentPage, itemsPerPage, debouncedSearch, coreFiltersParam, customFiltersParam, customFieldIdsParam, sortField, sortDir, drillIdsParam],
    enabled: accessChecked && filtersReady,
    keepPreviousData: true,
    queryFn: async () => {
      const params = new URLSearchParams({
        page: currentPage.toString(),
        limit: itemsPerPage.toString(),
        search: debouncedSearch,
        sortField,
        sortDir
      });
      if (coreFiltersParam) {
        params.set('coreFilters', coreFiltersParam);
      }
      if (customFiltersParam && customFiltersParam !== '{}') {
        params.set('customFilters', customFiltersParam);
      }
      if (customFieldIdsParam) {
        params.set('fields', customFieldIdsParam);
      }
      // A drill id list can be thousands of UUIDs — too long for a URL, so
      // it travels in a POST body while the other params stay in the query.
      const response = await fetch(`/api/admin/organizations/paginated?${params}`, {
        credentials: 'include',
        ...(drillIdsParam
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: drillIdsParam }),
            }
          : {}),
      });
      if (!response.ok) throw new Error('Failed to fetch organisations');
      return response.json();
    }
  });

  const organizations = orgsData?.organizations || [];
  const pagination = orgsData?.pagination || { page: 1, limit: itemsPerPage, total: 0, totalPages: 0 };

  const { data: directOrg, isLoading: directOrgLoading, isFetched: directOrgFetched } = useQuery({
    queryKey: ['organization-direct', urlOrgId],
    enabled: !!urlOrgId && accessChecked,
    queryFn: async () => {
      try {
        return await base44.entities.Organization.get(urlOrgId);
      } catch {
        return null;
      }
    },
    staleTime: 30000,
  });

  const selectedOrg = useMemo(() => {
    if (!urlOrgId) return null;
    const fromList = organizations.find(org => org.id === urlOrgId);
    if (fromList) return fromList;
    if (directOrg) return directOrg;
    return null;
  }, [urlOrgId, organizations, directOrg]);

  useEffect(() => {
    if (!urlOrgId || !directOrgFetched) return;
    if (!selectedOrg) {
      navigate('/organisations', { replace: true });
    }
  }, [urlOrgId, selectedOrg, directOrgFetched, navigate]);

  // Deep-link via ?selected=<id>: navigate straight to the detail route, which
  // resolves the org via the direct fetch even when it isn't on the first page.
  useEffect(() => {
    if (autoSelectHandledRef.current || !accessChecked) return;
    const selectedId = searchParams.get('selected');
    if (selectedId) {
      autoSelectHandledRef.current = true;
      navigate(`/organisations/${selectedId}`, { replace: true });
    }
  }, [accessChecked, searchParams, navigate]);

  // Fetch saved column preferences from database (once on load)
  const { toast } = useToast();
  const columnPrefKey = memberInfo?.id ? getColumnPrefKey(memberInfo.id) : null;
  const dbColumnsLoadedRef = useRef(false);
  const savedPrefIdRef = useRef(null);
  // Once a saved view has applied its own columns, the baseline column-prefs
  // row must not override them.
  const viewColumnsAppliedRef = useRef(false);

  const { data: savedDbColumns } = useQuery({
    queryKey: ['crm-org-column-prefs', columnPrefKey],
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

  // Load columns from database on initial fetch (overrides localStorage)
  // Also merge in any new DEFAULT_COLUMNS that don't exist in saved prefs
  useEffect(() => {
    if (viewColumnsAppliedRef.current) return;
    if (savedDbColumns?.setting_value) {
      try {
        const parsed = JSON.parse(savedDbColumns.setting_value);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Merge in any new default columns that don't exist in saved prefs
          const existingIds = new Set(parsed.map(c => c.id));
          const newDefaultColumns = DEFAULT_COLUMNS.filter(dc => !existingIds.has(dc.id));
          const merged = newDefaultColumns.length > 0 ? [...parsed, ...newDefaultColumns] : parsed;
          setColumns(merged);
          saveLocalColumns(merged, tenantSlug);
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
  } = useSavedListViews({ page: 'organisations', memberId: memberInfo?.id, enabled: accessChecked });

  // Apply a view's saved filters. Full replace: keys absent from the view reset
  // to their defaults so switching between views never mixes filter values.
  const applyViewFilters = useCallback((f) => {
    const filters = f && typeof f === 'object' ? f : {};
    const search = typeof filters.searchQuery === 'string' ? filters.searchQuery : '';
    setSearchQuery(search);
    setCoreFieldFilters({
      phone: '',
      website_url: '',
      invoicing_email: '',
      invoicing_address: '',
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
    setSortField(typeof filters.sortField === 'string' ? filters.sortField : 'name');
    setSortDir(filters.sortDir === 'asc' || filters.sortDir === 'desc' ? filters.sortDir : 'asc');
    if (Array.isArray(filters.filterOrder)) {
      const saved = filters.filterOrder.filter(id => typeof id === 'string');
      if (orgCustomFieldsLoaded) {
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
  }, [orgCustomFieldsLoaded, availableFilterIds]);

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
    mutationFn: async (orgIds) => {
      // Fetch + delete members per org on demand (no full members list is held
      // in memory anymore). Then delete the organizations themselves.
      let deletedMembers = 0;
      for (const orgId of orgIds) {
        const orgMembers = await base44.entities.Member.listAll({ filter: { organization_id: orgId } });
        for (const member of orgMembers || []) {
          await base44.entities.Member.delete(member.id);
          deletedMembers += 1;
        }
      }
      for (const orgId of orgIds) {
        await base44.entities.Organization.delete(orgId);
      }
      return { deletedOrgs: orgIds.length, deletedMembers };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['organizations-crm-paginated'] });
      setSelectedOrgs([]);
      setSelectAllFiltered(false);
      setShowDeleteDialog(false);
      setDeleteConfirmText('');
      setSingleDeleteOrg(null);
      toast({
        title: "Organisations deleted",
        description: `Successfully deleted ${result.deletedOrgs} organisation(s) and ${result.deletedMembers} ${memberLabel.toLowerCase()}(s).`
      });
    },
    onError: (error) => {
      toast({
        title: "Delete failed",
        description: error.message || "Could not delete organisations. Please try again.",
        variant: "destructive"
      });
    }
  });

  // Selection handlers
  const toggleOrgSelection = (orgId, e) => {
    e.stopPropagation();
    if (selectAllFiltered) setSelectAllFiltered(false);
    setSelectedOrgs(prev => 
      prev.includes(orgId) 
        ? prev.filter(id => id !== orgId)
        : [...prev, orgId]
    );
  };

  const toggleSelectAll = () => {
    const selectableOrgs = paginatedOrganizations.filter(org => !org.is_primary);
    const currentPageIds = selectableOrgs.map(org => org.id);
    const allSelected = currentPageIds.length > 0 && currentPageIds.every(id => selectedOrgs.includes(id));
    if (selectAllFiltered) setSelectAllFiltered(false);
    if (allSelected) {
      setSelectedOrgs(prev => prev.filter(id => !currentPageIds.includes(id)));
    } else {
      setSelectedOrgs(prev => [...new Set([...prev, ...currentPageIds])]);
    }
  };

  const handleDeleteOrgClick = (org, e) => {
    e.stopPropagation();
    setSingleDeleteOrg(org);
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = () => {
    if (singleDeleteOrg) {
      batchDeleteMutation.mutate([singleDeleteOrg.id]);
    } else {
      batchDeleteMutation.mutate(selectedOrgs);
    }
  };

  const handleExportCSV = async () => {
    setIsExporting(true);
    try {
      const params = new URLSearchParams();
      if (selectAllFiltered) {
        if (searchQuery.trim()) params.set('search', searchQuery.trim());
        params.set('excludePrimary', 'true');
        if (coreFiltersParam) params.set('coreFilters', coreFiltersParam);
        if (customFiltersParam && customFiltersParam !== '{}') {
          params.set('customFieldFilters', customFiltersParam);
        }
      } else {
        params.set('ids', selectedOrgs.join(','));
      }
      const response = await fetch(`/api/admin/organisations/export-csv?${params}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const today = new Date().toISOString().split('T')[0];
      link.download = `organisations_export_${today}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast({ title: "Export complete", description: `CSV file downloaded successfully.` });
    } catch (err) {
      toast({ title: "Export failed", description: err.message || "Could not export organisations.", variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  // Member counts now come from the server per page (org.member_count).
  const organizationMemberCounts = useMemo(() => {
    const counts = {};
    organizations.forEach((org) => {
      counts[org.id] = org.member_count || 0;
    });
    return counts;
  }, [organizations]);

  const selectedMemberCount = useMemo(() => {
    if (singleDeleteOrg) {
      return singleDeleteOrg.member_count || 0;
    }
    return selectedOrgs.reduce((sum, id) => sum + (organizationMemberCounts[id] || 0), 0);
  }, [organizationMemberCounts, selectedOrgs, singleDeleteOrg]);

  // Build the per-org custom value map from the server-provided page values so
  // custom-field columns/cards populate for every row. Values are normalised
  // exactly as before (parse JSON strings, unwrap {value,label} shapes).
  const orgValuesMap = useMemo(() => {
    const extractPrimitiveValue = (val) => {
      if (val === null || val === undefined) return val;
      if (typeof val === 'object' && !Array.isArray(val) && val.value !== undefined) {
        return val.value;
      }
      if (Array.isArray(val)) {
        return val.map(item => {
          if (typeof item === 'object' && item !== null && item.value !== undefined) {
            return item.value;
          }
          return item;
        });
      }
      return val;
    };

    const map = {};
    organizations.forEach((org) => {
      const cf = org.custom_fields || {};
      map[org.id] = {};
      Object.entries(cf).forEach(([fieldId, rawValue]) => {
        let normalizedValue = rawValue;
        if (typeof rawValue === 'string') {
          const trimmed = rawValue.trim();
          if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
              normalizedValue = JSON.parse(trimmed);
            } catch {
            }
          }
        }
        normalizedValue = extractPrimitiveValue(normalizedValue);
        map[org.id][fieldId] = normalizedValue;
      });
    });
    return map;
  }, [organizations]);

  // The server already filters, sorts, and paginates; the page rows are the
  // organisations to render as-is.
  const paginatedOrganizations = organizations;
  const totalPages = pagination.totalPages;

  const allPageSelected = paginatedOrganizations.filter(org => !org.is_primary).length > 0 &&
    paginatedOrganizations.filter(org => !org.is_primary).every(org => selectedOrgs.includes(org.id));
  const showSelectAllBanner = allPageSelected && totalPages > 1 && !selectAllFiltered;

  const resetFilters = () => {
    setSearchQuery('');
    setCoreFieldFilters({ phone: '', website_url: '', invoicing_email: '', invoicing_address: '' });
    setCustomFieldFilters({});
    setFilterOps({});
    setFilterOrder(availableFilterIds);
    setHiddenFilterIds([]);
    setCurrentPage(1);
  };

  const getOrgFilterLabel = useCallback((id) => {
    switch (id) {
      case 'phone': return 'Phone';
      case 'email': return 'Email';
      case 'website': return 'Website';
      case 'address': return 'Address';
      default: {
        const field = orgFilterFields.find(f => f.id === id);
        return field?.label || 'Filter';
      }
    }
  }, [orgFilterFields]);

  const clearOrgFilterValue = useCallback((id) => {
    switch (id) {
      case 'phone': setCoreFieldFilters(prev => ({ ...prev, phone: '' })); break;
      case 'email': setCoreFieldFilters(prev => ({ ...prev, invoicing_email: '' })); break;
      case 'website': setCoreFieldFilters(prev => ({ ...prev, website_url: '' })); break;
      case 'address': setCoreFieldFilters(prev => ({ ...prev, invoicing_address: '' })); break;
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
  const setOrgFilterOp = useCallback((id, op) => {
    setFilterOps(prev => ({ ...prev, [id]: op }));
    setCurrentPage(1);
  }, []);

  // Hide/show a filter. Hiding clears any active value so users never filter by
  // something they can no longer see.
  const toggleOrgFilterHidden = useCallback((id) => {
    setHiddenFilterIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      clearOrgFilterValue(id);
      return [...prev, id];
    });
  }, [clearOrgFilterValue]);

  const filterSearchMatches = useMemo(() => {
    if (!filterSearchQuery.trim()) return [];
    const q = filterSearchQuery.toLowerCase();
    return orderedFilterIds.filter(id =>
      getOrgFilterLabel(id).toLowerCase().includes(q)
    );
  }, [filterSearchQuery, orderedFilterIds, getOrgFilterLabel]);

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
      toggleOrgFilterHidden(id);
      setTimeout(() => {
        document.querySelector(`[data-filter-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        highlightFilterEl(id);
      }, 100);
    } else {
      document.querySelector(`[data-filter-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      highlightFilterEl(id);
    }
  }, [hiddenFilterSet, toggleOrgFilterHidden, highlightFilterEl]);

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

  // Shared renderer for the four core text filters (phone/email/website/address).
  const renderCoreTextFilter = (id, label, stateKey, testId) => {
    const op = filterOps[id] || 'contains';
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-1">
          <Label className="text-[11px] text-slate-600 break-words">{label}</Label>
          <FilterOperatorMenu
            operators={TEXT_OPERATORS}
            value={op}
            onChange={(v) => setOrgFilterOp(id, v)}
            testId={`op-org-filter-${id}`}
          />
        </div>
        {!isEmptinessOp(op) && (
          <Input
            placeholder={`Filter by ${label.toLowerCase()}...`}
            value={coreFieldFilters[stateKey] || ''}
            onChange={(e) => {
              setCoreFieldFilters(prev => ({ ...prev, [stateKey]: e.target.value }));
              setCurrentPage(1);
            }}
            className="h-8 text-xs"
            data-testid={testId}
          />
        )}
      </div>
    );
  };

  const renderOrgFilterControl = (id) => {
    switch (id) {
      case 'phone':
        return renderCoreTextFilter('phone', 'Phone', 'phone', 'input-filter-phone');
      case 'email':
        return renderCoreTextFilter('email', 'Email', 'invoicing_email', 'input-filter-email');
      case 'website':
        return renderCoreTextFilter('website', 'Website', 'website_url', 'input-filter-website');
      case 'address':
        return renderCoreTextFilter('address', 'Address', 'invoicing_address', 'input-filter-address');
      default: {
        const field = orgFilterFields.find(f => f.id === id);
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
                  onChange={(v) => setOrgFilterOp(field.id, v)}
                  testId={`op-org-filter-${field.id}`}
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
                  <SelectTrigger className="h-8 text-xs" data-testid={`select-filter-bool-${field.id}`}>
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
        if (field.field_type === 'country' || field.field_type === 'countries') {
          const op = fieldOp || 'any_of';
          const rawVal = customFieldFilters[field.id] || '';
          const selectedName = typeof rawVal === 'string' && rawVal.startsWith('__country__:')
            ? rawVal.slice('__country__:'.length)
            : '';
          return (
            <CountryFilterCombobox
              key={field.id}
              label={field.label}
              fieldId={field.id}
              selectedName={selectedName}
              hideValue={isEmptinessOp(op)}
              operatorMenu={
                <FilterOperatorMenu
                  operators={COUNTRY_OPERATORS}
                  value={op}
                  onChange={(v) => setOrgFilterOp(field.id, v)}
                  testId={`op-org-filter-${field.id}`}
                />
              }
              onChange={(name) => {
                setCustomFieldFilters(prev => ({
                  ...prev,
                  [field.id]: name ? `__country__:${name}` : ''
                }));
                setCurrentPage(1);
              }}
            />
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
                  onChange={(v) => setOrgFilterOp(field.id, v)}
                  testId={`op-org-filter-${field.id}`}
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
                    data-testid={`select-filter-${field.id}`}
                  />
                  {selectedValues.length > 1 && (
                    <div className="flex flex-wrap gap-1">
                      {selectedValues.map(val => (
                        <Badge
                          key={val}
                          variant="secondary"
                          className="text-[10px] font-normal max-w-full gap-1"
                          data-testid={`badge-filter-${field.id}-${val}`}
                        >
                          <span className="truncate">{labelForValue(val)}</span>
                          <button
                            type="button"
                            className="shrink-0 rounded-full"
                            onClick={() => setSelectedValues(selectedValues.filter(v => v !== val))}
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
                onChange={(v) => setOrgFilterOp(field.id, v)}
                testId={`op-org-filter-${field.id}`}
              />
            </div>
            {!isEmptinessOp(op) && (
              <Input
                placeholder={`Filter...`}
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
                data-testid={`input-filter-cf-${field.id}`}
              />
            )}
          </div>
        );
      }
    }
  };

  const hasActiveFilters = searchQuery || 
    Object.values(coreFieldFilters).some(v => v && v.trim() !== '') ||
    Object.values(customFieldFilters).some(isActiveCustomFilterValue) ||
    Object.values(filterOps).some(isEmptinessOp);

  // Reconcile columns when custom fields load or when their column-visibility changes:
  // add any newly column-visible fields, and prune custom columns whose field is no
  // longer column-visible (or no longer exists). Gated on the query having loaded so
  // an in-flight empty default doesn't wipe saved preferences.
  useEffect(() => {
    if (!orgCustomFieldsLoaded) return;
    setColumns(prev => {
      const allowedFieldIds = new Set(orgColumnFields.map(f => f.id));
      const existingFieldIds = new Set(
        prev.filter(c => c.isCustomField && c.fieldId).map(c => c.fieldId)
      );
      const pruned = prev.filter(c => !c.isCustomField || allowedFieldIds.has(c.fieldId));
      const additions = orgColumnFields
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
  }, [orgColumnFields, orgCustomFieldsLoaded, tenantSlug]);

  // Reconcile the filter order once custom fields have loaded: drop ids that no
  // longer exist and append any newly available filters not present in the saved
  // order (so new custom fields still show up, after the saved ones).
  useEffect(() => {
    if (!orgCustomFieldsLoaded) return;
    setFilterOrder(prev => {
      const availSet = new Set(availableFilterIds);
      const kept = prev.filter(id => availSet.has(id));
      const additions = availableFilterIds.filter(id => !prev.includes(id));
      if (additions.length === 0 && kept.length === prev.length) return prev;
      return [...kept, ...additions];
    });
  }, [availableFilterIds, orgCustomFieldsLoaded]);

  // Save columns to localStorage when they change (only after initial load)
  useEffect(() => {
    if (lastLoadedSlugRef.current !== undefined) {
      saveLocalColumns(columns, tenantSlug);
    }
  }, [columns, tenantSlug]);

  const visibleColumns = useMemo(() => columns.filter(c => c.visible), [columns]);

  const toggleColumnVisibility = (columnId) => {
    setColumns(prev => prev.map(col => 
      col.id === columnId && !col.locked 
        ? { ...col, visible: !col.visible }
        : col
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

  const handleDragStart = (e, index) => {
    setDraggedColumn(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    if (draggedColumn === null || draggedColumn === index) return;
    moveColumn(draggedColumn, index);
    setDraggedColumn(index);
  };

  const handleDragEnd = () => {
    setDraggedColumn(null);
  };

  const resetColumns = () => {
    const customFieldCols = orgColumnFields.map(f => ({
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

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (isCreatingNew) {
    return (
      <OrganisationDetailView 
        organization={{}}
        onBack={() => setIsCreatingNew(false)}
        orgCustomFields={orgCustomFields}
        memberCount={0}
        isNew={true}
        onCreated={(createdOrg) => {
          setIsCreatingNew(false);
          navigate(`/organisations/${createdOrg.id}`, { replace: true });
        }}
      />
    );
  }

  if (selectedOrg) {
    return (
      <OrganisationDetailView 
        organization={selectedOrg}
        onBack={() => navigate('/organisations')}
        orgCustomFields={orgCustomFields}
        memberCount={organizationMemberCounts[selectedOrg.id] || 0}
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
                    data-testid="button-reset-filters"
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
                testIdPrefix="org-view"
              />
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search organisations..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                className="pl-9"
                data-testid="input-search-orgs"
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
                data-testid="input-filter-search-orgs"
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
                        data-testid={`filter-search-result-org-${id}`}
                      >
                        <span>{getOrgFilterLabel(id)}</span>
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
                const control = renderOrgFilterControl(id);
                if (!control) return null;
                return (
                  <div
                    key={id}
                    onDragOver={(e) => handleFilterDragOver(e, id)}
                    className={`flex items-center gap-1.5 rounded-md ${draggedFilterId === id ? 'opacity-50' : ''}`}
                    data-testid={`org-filter-row-${id}`}
                    data-filter-id={id}
                  >
                    <div
                      draggable
                      onDragStart={(e) => handleFilterDragStart(e, id)}
                      onDragEnd={handleFilterDragEnd}
                      className="shrink-0 cursor-grab text-slate-400 hover:text-slate-600"
                      aria-label="Drag to reorder filter"
                      title="Drag to reorder filter"
                      data-testid={`drag-org-filter-${id}`}
                    >
                      <GripVertical className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      {control}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleOrgFilterHidden(id)}
                      className="shrink-0 h-6 w-6 text-slate-400 hover:text-slate-600"
                      aria-label={`Hide ${getOrgFilterLabel(id)} filter`}
                      title="Hide this filter"
                      data-testid={`toggle-hide-org-filter-${id}`}
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
                      data-testid={`org-hidden-filter-row-${id}`}
                      data-filter-id={id}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleOrgFilterHidden(id)}
                        className="shrink-0 h-6 w-6 text-slate-400 hover:text-slate-600"
                        aria-label={`Show ${getOrgFilterLabel(id)} filter`}
                        title="Show this filter"
                        data-testid={`toggle-show-org-filter-${id}`}
                      >
                        <EyeOff className="w-3.5 h-3.5" />
                      </Button>
                      <span className="flex-1 min-w-0 text-xs text-slate-500 truncate">
                        {getOrgFilterLabel(id)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </ScrollArea>

          <div className="p-4 border-t border-slate-200 bg-slate-50 min-w-[288px]">
            <p className="text-xs text-slate-500">
              Showing {organizations.length} of {pagination.total} organisations
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
                    Organisations
                  </h1>
                  <p className="text-sm text-slate-500">
                    {pagination.total} organisation{pagination.total !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {(selectedOrgs.length > 0 || selectAllFiltered) && (
                  <>
                    <Button 
                      variant="outline"
                      onClick={handleExportCSV}
                      disabled={isExporting}
                      className="gap-1"
                      data-testid="button-export-csv-orgs"
                    >
                      {isExporting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                      Export CSV {selectAllFiltered ? `(${pagination.total})` : `(${selectedOrgs.length})`}
                    </Button>
                    {selectedOrgs.length > 0 && (
                      <Button 
                        variant="destructive"
                        onClick={() => setShowDeleteDialog(true)}
                        className="gap-1"
                        data-testid="button-delete-selected"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete Selected ({selectedOrgs.length})
                      </Button>
                    )}
                    <Button 
                      variant="ghost"
                      size="sm"
                      onClick={() => { setSelectedOrgs([]); setSelectAllFiltered(false); }}
                      className="text-slate-500"
                      data-testid="button-clear-selection-orgs"
                    >
                      <X className="w-3 h-3 mr-1" />
                      Clear selection
                    </Button>
                  </>
                )}
                <Button 
                  onClick={() => setIsCreatingNew(true)}
                  className="gap-1"
                  data-testid="button-add-organisation"
                >
                  <Building2 className="w-4 h-4" />
                  Add Organisation
                </Button>
                {viewMode === 'list' && (
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
                                  {displayColumnLabel(col)}
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

          {(showSelectAllBanner || selectAllFiltered) && (
            <div className="bg-blue-50 border-b border-blue-200 px-6 py-2 text-sm text-blue-700 flex items-center justify-center gap-2" data-testid="banner-select-all-orgs">
              {selectAllFiltered ? (
                <>
                  All {pagination.total} organisations are selected.
                  <button 
                    className="font-semibold underline"
                    onClick={() => { setSelectAllFiltered(false); setSelectedOrgs([]); }}
                    data-testid="button-clear-all-selection-orgs"
                  >
                    Clear selection
                  </button>
                </>
              ) : (
                <>
                  All {paginatedOrganizations.filter(o => !o.is_primary).length} on this page selected.
                  <button 
                    className="font-semibold underline"
                    onClick={() => setSelectAllFiltered(true)}
                    data-testid="button-select-all-filtered-orgs"
                  >
                    Select all {pagination.total} organisations
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
            {orgsLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : paginatedOrganizations.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                <Building2 className="w-16 h-16 mb-4 text-slate-300" />
                <p className="text-lg font-medium">No organisations found</p>
                <p className="text-sm">Try adjusting your filters</p>
              </div>
            ) : viewMode === 'list' ? (
              <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="w-12 px-4 py-3">
                        <Checkbox 
                          checked={paginatedOrganizations.filter(org => !org.is_primary).length > 0 && paginatedOrganizations.filter(org => !org.is_primary).every(org => selectedOrgs.includes(org.id))}
                          onCheckedChange={toggleSelectAll}
                          disabled={paginatedOrganizations.every(org => org.is_primary)}
                          data-testid="checkbox-select-all"
                        />
                      </th>
                      {visibleColumns.map(col => {
                        // Custom-field columns are not server-sortable, so they
                        // render as non-sortable headers (mirrors the members list).
                        const sortKey = col.isCustomField ? null : ORG_SORT_KEYS[col.id];
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
                              {displayColumnLabel(col)}
                            </SortableHeader>
                          </th>
                        );
                      })}
                      <th className="w-12 px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginatedOrganizations.map(org => (
                      <tr 
                        key={org.id} 
                        className={`hover:bg-slate-50 cursor-pointer transition-colors ${selectedOrgs.includes(org.id) ? 'bg-blue-50' : ''}`}
                        onClick={() => navigate(`/organisations/${org.id}`)}
                        data-testid={`row-org-${org.id}`}
                      >
                        <td className="w-12 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <Checkbox 
                            checked={selectedOrgs.includes(org.id)}
                            onCheckedChange={(checked) => toggleOrgSelection(org.id, { stopPropagation: () => {} })}
                            disabled={org.is_primary}
                            data-testid={`checkbox-org-${org.id}`}
                          />
                        </td>
                        {visibleColumns.map(col => {
                          if (col.id === 'name') {
                            return (
                              <td key={col.id} className="px-4 py-3">
                                <div className="flex items-center gap-3">
                                  {(() => {
                                    const safeSrc = safeLogoSrc(org.logo_url);
                                    return safeSrc ? (
                                      <img src={safeSrc} alt={org.name} className="w-10 h-10 rounded-lg object-contain bg-slate-100" />
                                    ) : (
                                      <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                                        <Building2 className="w-5 h-5 text-blue-600" />
                                      </div>
                                    );
                                  })()}
                                  <div>
                                    <p className="font-medium text-slate-900">{org.name}</p>
                                    {org.website_url && (
                                      <p className="text-xs text-slate-500 truncate max-w-[200px]">{org.website_url}</p>
                                    )}
                                  </div>
                                </div>
                              </td>
                            );
                          }
                          if (col.id === 'members') {
                            return (
                              <td key={col.id} className="px-4 py-3">
                                <div className="flex items-center gap-1 text-slate-600">
                                  <Users className="w-4 h-4" />
                                  <span>{organizationMemberCounts[org.id] || 0}</span>
                                </div>
                              </td>
                            );
                          }
                          if (col.id === 'contact') {
                            return (
                              <td key={col.id} className="px-4 py-3">
                                <div className="text-sm text-slate-600">
                                  {org.invoicing_email && (
                                    <p className="truncate max-w-[180px]">{org.invoicing_email}</p>
                                  )}
                                  {org.phone && (
                                    <p className="text-xs text-slate-400">{org.phone}</p>
                                  )}
                                </div>
                              </td>
                            );
                          }
                          if (col.id === 'email') {
                            return (
                              <td key={col.id} className="px-4 py-3 text-sm text-slate-600">
                                {org.invoicing_email || '-'}
                              </td>
                            );
                          }
                          if (col.id === 'phone') {
                            return (
                              <td key={col.id} className="px-4 py-3 text-sm text-slate-600">
                                {org.phone || '-'}
                              </td>
                            );
                          }
                          if (col.id === 'website') {
                            return (
                              <td key={col.id} className="px-4 py-3 text-sm text-slate-600">
                                {org.website_url ? (
                                  <a 
                                    href={org.website_url.startsWith('http') ? org.website_url : `https://${org.website_url}`} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="text-primary truncate block max-w-[200px]"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {org.website_url}
                                  </a>
                                ) : '-'}
                              </td>
                            );
                          }
                          if (col.id === 'address') {
                            const addr = org.address;
                            let addressDisplay = '-';
                            if (addr && typeof addr === 'object') {
                              const parts = [addr.line1, addr.line2, addr.city, addr.region, addr.postcode, addr.country].filter(Boolean);
                              addressDisplay = parts.length > 0 ? parts.join(', ') : '-';
                            } else if (addr && typeof addr === 'string') {
                              try {
                                const parsed = JSON.parse(addr);
                                const parts = [parsed.line1, parsed.line2, parsed.city, parsed.region, parsed.postcode, parsed.country].filter(Boolean);
                                addressDisplay = parts.length > 0 ? parts.join(', ') : '-';
                              } catch {
                                addressDisplay = addr || '-';
                              }
                            }
                            return (
                              <td key={col.id} className="px-4 py-3 text-sm text-slate-600 max-w-[250px]">
                                <span className="truncate block" title={addressDisplay !== '-' ? addressDisplay : undefined}>
                                  {addressDisplay}
                                </span>
                              </td>
                            );
                          }
                          if (col.id === 'description') {
                            return (
                              <td key={col.id} className="px-4 py-3 text-sm text-slate-600 max-w-[200px]">
                                <span className="truncate block" title={org.description || undefined}>
                                  {org.description || '-'}
                                </span>
                              </td>
                            );
                          }
                          if (col.id === 'created_at') {
                            return (
                              <td key={col.id} className="px-4 py-3 text-sm text-slate-600">
                                {org.created_at ? format(new Date(org.created_at), 'dd MMM yyyy') : '-'}
                              </td>
                            );
                          }
                          if (col.isCustomField) {
                            const field = orgCustomFields.find(f => f.id === col.fieldId);
                            const value = orgValuesMap[org.id]?.[col.fieldId];
                            let displayValue = value || '-';
                            if (value && field && (field.field_type === 'picklist' || field.field_type === 'dropdown')) {
                              try {
                                const parsed = JSON.parse(value);
                                if (Array.isArray(parsed)) {
                                  displayValue = parsed.map(v => {
                                    const opt = field.options?.find(o => o.value === v);
                                    return opt?.label || v;
                                  }).join(', ');
                                } else {
                                  const opt = field.options?.find(o => o.value === value);
                                  displayValue = opt?.label || value;
                                }
                              } catch {
                                const opt = field.options?.find(o => o.value === value);
                                displayValue = opt?.label || value;
                              }
                            }
                            return (
                              <td key={col.id} className="px-4 py-3 text-sm text-slate-600">
                                {displayValue}
                              </td>
                            );
                          }
                          return <td key={col.id} className="px-4 py-3">-</td>;
                        })}
                        <td className="w-12 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          {org.is_primary ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  disabled
                                  className="text-green-600"
                                  data-testid={`button-delete-org-protected-${org.id}`}
                                >
                                  <ShieldCheck className="w-4 h-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>Primary organisation - cannot be deleted</p>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-slate-400"
                              onClick={(e) => handleDeleteOrgClick(org, e)}
                              data-testid={`button-delete-org-${org.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {paginatedOrganizations.map(org => (
                  <Card 
                    key={org.id} 
                    className="cursor-pointer hover:shadow-md transition-shadow hover-elevate"
                    onClick={() => navigate(`/organisations/${org.id}`)}
                    data-testid={`card-org-${org.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3 mb-3">
                        {(() => {
                          const safeSrc = safeLogoSrc(org.logo_url);
                          return safeSrc ? (
                            <img src={safeSrc} alt={org.name} className="w-12 h-12 rounded-lg object-contain bg-slate-100" />
                          ) : (
                            <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                              <Building2 className="w-6 h-6 text-blue-600" />
                            </div>
                          );
                        })()}
                        <div className="min-w-0 flex-1">
                          <h3 className="font-medium text-slate-900 truncate">{org.name}</h3>
                        </div>
                      </div>

                      <div className="space-y-2 text-sm text-slate-600">
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4 text-slate-400" />
                          <span>{organizationMemberCounts[org.id] || 0} {(organizationMemberCounts[org.id] || 0) === 1 ? memberLabel.toLowerCase() : memberLabelPlural.toLowerCase()}</span>
                        </div>
                        {org.invoicing_email && (
                          <div className="flex items-center gap-2">
                            <Mail className="w-4 h-4 text-slate-400" />
                            <span className="truncate">{org.invoicing_email}</span>
                          </div>
                        )}
                        {org.phone && (
                          <div className="flex items-center gap-2">
                            <Phone className="w-4 h-4 text-slate-400" />
                            <span>{org.phone}</span>
                          </div>
                        )}
                        {org.website_url && (
                          <div className="flex items-center gap-2">
                            <Globe className="w-4 h-4 text-slate-400" />
                            <span className="truncate">{org.website_url}</span>
                          </div>
                        )}
                        {columns.find(c => c.id === 'created_at')?.visible && org.created_at && (
                          <div className="flex items-center gap-2">
                            <Calendar className="w-4 h-4 text-slate-400" />
                            <span>{format(new Date(org.created_at), 'dd MMM yyyy')}</span>
                          </div>
                        )}
                      </div>

                      {orgColumnFields.slice(0, 2).map(field => {
                        const value = orgValuesMap[org.id]?.[field.id];
                        if (!value) return null;
                        let displayValue = value;
                        if (field.field_type === 'picklist' || field.field_type === 'dropdown') {
                          try {
                            const parsed = JSON.parse(value);
                            if (Array.isArray(parsed)) {
                              displayValue = parsed.map(v => {
                                const opt = field.options?.find(o => o.value === v);
                                return opt?.label || v;
                              }).join(', ');
                            } else {
                              const opt = field.options?.find(o => o.value === value);
                              displayValue = opt?.label || value;
                            }
                          } catch {
                            const opt = field.options?.find(o => o.value === value);
                            displayValue = opt?.label || value;
                          }
                        }
                        return (
                          <div key={field.id} className="mt-2 text-xs">
                            <span className="text-slate-400">{field.label}: </span>
                            <span className="text-slate-600">{displayValue}</span>
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <footer className="bg-white border-t border-slate-200 px-6 py-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-500">
                  Page {currentPage} of {totalPages}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
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

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={(open) => {
        setShowDeleteDialog(open);
        if (!open) {
          setDeleteConfirmText('');
          setSingleDeleteOrg(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Delete Organisation{singleDeleteOrg ? '' : 's'}
            </DialogTitle>
            <DialogDescription className="text-left space-y-3 pt-2">
              {singleDeleteOrg ? (
                <p>
                  You are about to permanently delete <strong>{singleDeleteOrg.name}</strong>.
                </p>
              ) : (
                <p>
                  You are about to permanently delete <strong>{selectedOrgs.length} organisation{selectedOrgs.length !== 1 ? 's' : ''}</strong>.
                </p>
              )}
              <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3 text-destructive text-sm">
                <strong>Warning:</strong> This will also delete <strong>{selectedMemberCount} {selectedMemberCount === 1 ? memberLabel.toLowerCase() : memberLabelPlural.toLowerCase()}</strong> belonging to {singleDeleteOrg ? 'this organisation' : 'these organisations'}. This action cannot be undone.
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
              data-testid="input-delete-confirm"
            />
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowDeleteDialog(false);
                setDeleteConfirmText('');
                setSingleDeleteOrg(null);
              }}
              data-testid="button-cancel-delete"
            >
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={deleteConfirmText !== 'DELETE' || batchDeleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {batchDeleteMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete {singleDeleteOrg ? '1' : selectedOrgs.length} Organisation{(singleDeleteOrg || selectedOrgs.length === 1) ? '' : 's'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
