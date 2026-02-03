import { useState, useMemo, useEffect, useCallback, useRef } from "react";
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
import { Separator } from "@/components/ui/separator";
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
  Save,
  Calendar,
  Trash2,
  AlertTriangle,
  ShieldCheck
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
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { createPageUrl, isDeletedMember } from "@/utils";
import OrganisationDetailView from "@/components/OrganisationDetailView";
import { useToast } from "@/components/ui/use-toast";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";

const DEFAULT_COLUMNS = [
  { id: 'name', label: 'Organisation', visible: true, locked: true },
  { id: 'members', label: 'Members', visible: true, locked: false },
  { id: 'contact', label: 'Contact', visible: true, locked: false },
  { id: 'created_at', label: 'Created', visible: false, locked: false },
];

const getStorageKey = (tenantSlug) => `organisations_list_columns_${tenantSlug || 'default'}`;
const getColumnPrefKey = (memberId) => `crm_org_columns_${memberId}`;

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


export default function OrganisationsListPage() {
  const { isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const { tenantSlug } = useTenantBranding() || {};
  const queryClient = useQueryClient();
  const [accessChecked, setAccessChecked] = useState(false);
  const lastLoadedSlugRef = useRef(undefined);
  
  const [viewMode, setViewMode] = useState('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [coreFieldFilters, setCoreFieldFilters] = useState({
    phone: '',
    website_url: '',
    invoicing_email: '',
    invoicing_address: ''
  });
  const [customFieldFilters, setCustomFieldFilters] = useState({});
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(20);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedOrgs, setSelectedOrgs] = useState([]);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [singleDeleteOrg, setSingleDeleteOrg] = useState(null);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [draggedColumn, setDraggedColumn] = useState(null);

  useRealtimeSubscription('organization', [['organizations-crm-list']], { 
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
      // Admin-only page, also check OrganisationDirectory feature exclusion for consistency
      if (isFeatureExcluded('page_OrganisationsList') || isFeatureExcluded('page_OrganisationDirectory')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: organizations = [], isLoading: orgsLoading } = useQuery({
    queryKey: ['organizations-crm-list'],
    enabled: accessChecked,
    queryFn: async () => {
      return await base44.entities.Organization.list({
        sort: { name: 'asc' },
        queryParams: { skipDirectoryFilters: 'true' }
      });
    }
  });

  // Sync selectedOrg with latest data when organizations list updates (e.g., from realtime)
  useEffect(() => {
    if (selectedOrg && !orgsLoading) {
      const updatedOrg = organizations.find(org => org.id === selectedOrg.id);
      if (!updatedOrg) {
        // Organization was deleted or no longer in list, clear selection
        setSelectedOrg(null);
      } else if (updatedOrg !== selectedOrg) {
        // Organization object changed, sync with latest data
        setSelectedOrg(updatedOrg);
      }
    }
  }, [organizations, selectedOrg, orgsLoading]);

  const { data: members = [] } = useQuery({
    queryKey: ['all-members-for-org-list'],
    enabled: accessChecked,
    queryFn: async () => {
      const allMembers = await base44.entities.Member.listAll();
      return allMembers || [];
    }
  });

  const { data: orgCustomFields = [] } = useQuery({
    queryKey: ['/api/entities/PreferenceField', 'organization', 'crm'],
    enabled: accessChecked,
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'organization' },
          sort: { display_order: 'asc' }
        });
        // Filter for fields visible in Admin CRM list
        return (fields || []).filter(f => f.entity_scope === 'organization' && f.show_in_admin_list !== false);
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => f.entity_scope === 'organization' && f.show_in_admin_list !== false);
        } catch {
          return [];
        }
      }
    }
  });

  const { data: allOrgPreferenceValues = [] } = useQuery({
    queryKey: ['all-org-preference-values-crm'],
    enabled: accessChecked && orgCustomFields.length > 0,
    queryFn: async () => {
      try {
        const values = await base44.entities.OrganizationPreferenceValue.list();
        return values || [];
      } catch {
        return [];
      }
    }
  });

  // Fetch saved column preferences from database (once on load)
  const { toast } = useToast();
  const columnPrefKey = memberInfo?.id ? getColumnPrefKey(memberInfo.id) : null;
  const dbColumnsLoadedRef = useRef(false);
  const savedPrefIdRef = useRef(null);

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
  useEffect(() => {
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

  // Mutation to save view (user-initiated)
  const saveViewMutation = useMutation({
    mutationFn: async () => {
      const valueStr = JSON.stringify(columns);
      if (savedPrefIdRef.current) {
        return await base44.entities.SystemSettings.update(savedPrefIdRef.current, {
          setting_value: valueStr
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: columnPrefKey,
          setting_value: valueStr,
          description: 'CRM organisation list column preferences'
        });
      }
    },
    onSuccess: (result) => {
      if (result?.id) savedPrefIdRef.current = result.id;
      toast({
        title: "View saved",
        description: "Your column preferences have been saved."
      });
    },
    onError: () => {
      toast({
        title: "Save failed",
        description: "Could not save your column preferences. Please try again.",
        variant: "destructive"
      });
    }
  });

  // Batch delete mutation
  const batchDeleteMutation = useMutation({
    mutationFn: async (orgIds) => {
      // First delete all members belonging to these organizations
      const membersToDelete = members.filter(m => orgIds.includes(m.organization_id));
      for (const member of membersToDelete) {
        await base44.entities.Member.delete(member.id);
      }
      // Then delete the organizations
      for (const orgId of orgIds) {
        await base44.entities.Organization.delete(orgId);
      }
      return { deletedOrgs: orgIds.length, deletedMembers: membersToDelete.length };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['organizations-crm-list'] });
      queryClient.invalidateQueries({ queryKey: ['all-members-for-org-list'] });
      setSelectedOrgs([]);
      setShowDeleteDialog(false);
      setDeleteConfirmText('');
      setSingleDeleteOrg(null);
      toast({
        title: "Organisations deleted",
        description: `Successfully deleted ${result.deletedOrgs} organisation(s) and ${result.deletedMembers} member(s).`
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
    setSelectedOrgs(prev => 
      prev.includes(orgId) 
        ? prev.filter(id => id !== orgId)
        : [...prev, orgId]
    );
  };

  const toggleSelectAll = () => {
    // Only include non-primary organizations in select all
    const selectableOrgs = paginatedOrganizations.filter(org => !org.is_primary);
    const currentPageIds = selectableOrgs.map(org => org.id);
    const allSelected = currentPageIds.length > 0 && currentPageIds.every(id => selectedOrgs.includes(id));
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

  const selectedMemberCount = useMemo(() => {
    const activeMembers = members.filter(m => !isDeletedMember(m));
    if (singleDeleteOrg) {
      return activeMembers.filter(m => m.organization_id === singleDeleteOrg.id).length;
    }
    return activeMembers.filter(m => selectedOrgs.includes(m.organization_id)).length;
  }, [members, selectedOrgs, singleDeleteOrg]);

  const organizationMemberCounts = useMemo(() => {
    const counts = {};
    members.forEach((member) => {
      if (member.organization_id && !isDeletedMember(member)) {
        counts[member.organization_id] = (counts[member.organization_id] || 0) + 1;
      }
    });
    return counts;
  }, [members]);

  const orgValuesMap = useMemo(() => {
    const map = {};
    allOrgPreferenceValues.forEach(pv => {
      if (!map[pv.organization_id]) {
        map[pv.organization_id] = {};
      }
      map[pv.organization_id][pv.field_id] = pv.value;
    });
    return map;
  }, [allOrgPreferenceValues]);

  const filteredOrganizations = useMemo(() => {
    let result = [...organizations];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(org => 
        org.name?.toLowerCase().includes(query) ||
        org.invoicing_email?.toLowerCase().includes(query) ||
        org.phone?.toLowerCase().includes(query) ||
        org.website_url?.toLowerCase().includes(query)
      );
    }

    // Apply core field filters (text-based)
    Object.entries(coreFieldFilters).forEach(([field, filterValue]) => {
      if (filterValue && filterValue.trim()) {
        const query = filterValue.toLowerCase().trim();
        result = result.filter(org => {
          const fieldVal = org[field];
          return fieldVal && fieldVal.toLowerCase().includes(query);
        });
      }
    });

    // Apply custom field filters
    Object.entries(customFieldFilters).forEach(([fieldId, filterValue]) => {
      if (filterValue && filterValue !== 'all' && filterValue.trim() !== '') {
        const isTextFilter = filterValue.startsWith('__text__:');
        const actualValue = isTextFilter ? filterValue.replace('__text__:', '').toLowerCase() : filterValue;
        
        result = result.filter(org => {
          const orgFieldValue = orgValuesMap[org.id]?.[fieldId];
          if (!orgFieldValue) return false;
          
          if (isTextFilter) {
            // Text search
            return orgFieldValue.toLowerCase().includes(actualValue);
          }
          
          try {
            const parsed = JSON.parse(orgFieldValue);
            if (Array.isArray(parsed)) {
              return parsed.includes(filterValue);
            }
            return parsed === filterValue;
          } catch {
            return orgFieldValue === filterValue;
          }
        });
      }
    });

    return result;
  }, [organizations, searchQuery, coreFieldFilters, customFieldFilters, orgValuesMap]);

  const paginatedOrganizations = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredOrganizations.slice(start, start + itemsPerPage);
  }, [filteredOrganizations, currentPage, itemsPerPage]);

  const totalPages = Math.ceil(filteredOrganizations.length / itemsPerPage);

  const resetFilters = () => {
    setSearchQuery('');
    setCoreFieldFilters({ phone: '', website_url: '', invoicing_email: '', invoicing_address: '' });
    setCustomFieldFilters({});
    setCurrentPage(1);
  };

  const hasActiveFilters = searchQuery || 
    Object.values(coreFieldFilters).some(v => v && v.trim() !== '') ||
    Object.values(customFieldFilters).some(v => v && v !== 'all' && v.trim() !== '');

  // Track if custom fields have been merged into columns
  const customFieldsMergedRef = useRef(false);

  // Update columns when custom fields are loaded - merge with saved preferences
  useEffect(() => {
    if (orgCustomFields.length > 0 && !customFieldsMergedRef.current) {
      customFieldsMergedRef.current = true;
      setColumns(prev => {
        const existingIds = prev.map(c => c.id);
        const newCustomFieldColumns = orgCustomFields
          .filter(f => !existingIds.includes(`cf_${f.id}`))
          .map(f => ({
            id: `cf_${f.id}`,
            label: f.label,
            visible: false,
            locked: false,
            isCustomField: true,
            fieldId: f.id
          }));
        if (newCustomFieldColumns.length > 0) {
          const updated = [...prev, ...newCustomFieldColumns];
          saveLocalColumns(updated, tenantSlug);
          return updated;
        }
        return prev;
      });
    }
  }, [orgCustomFields]);

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
    const customFieldCols = orgCustomFields.map(f => ({
      id: `cf_${f.id}`,
      label: f.label,
      visible: false,
      locked: false,
      isCustomField: true,
      fieldId: f.id
    }));
    const newColumns = [...DEFAULT_COLUMNS, ...customFieldCols];
    setColumns(newColumns);
    // Save immediately to both local and database
    saveLocalColumns(newColumns, tenantSlug);
    if (memberInfo?.id) {
      saveColumnsMutation.mutate(newColumns);
    }
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
          setSelectedOrg(createdOrg);
        }}
      />
    );
  }

  if (selectedOrg) {
    return (
      <OrganisationDetailView 
        organization={selectedOrg}
        onBack={() => setSelectedOrg(null)}
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
          </div>

          <ScrollArea className="flex-1 p-4 min-w-[288px]">
            <div className="space-y-4">
              {/* Core Field Filters */}
              <div className="space-y-3">
                <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Contact Details</p>
                
                <div className="space-y-1.5">
                  <Label className="text-[11px] text-slate-600 break-words">Phone</Label>
                  <Input
                    placeholder="Filter by phone..."
                    value={coreFieldFilters.phone}
                    onChange={(e) => { 
                      setCoreFieldFilters(prev => ({ ...prev, phone: e.target.value }));
                      setCurrentPage(1);
                    }}
                    className="h-8 text-xs"
                    data-testid="input-filter-phone"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[11px] text-slate-600 break-words">Email</Label>
                  <Input
                    placeholder="Filter by email..."
                    value={coreFieldFilters.invoicing_email}
                    onChange={(e) => { 
                      setCoreFieldFilters(prev => ({ ...prev, invoicing_email: e.target.value }));
                      setCurrentPage(1);
                    }}
                    className="h-8 text-xs"
                    data-testid="input-filter-email"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[11px] text-slate-600 break-words">Website</Label>
                  <Input
                    placeholder="Filter by website..."
                    value={coreFieldFilters.website_url}
                    onChange={(e) => { 
                      setCoreFieldFilters(prev => ({ ...prev, website_url: e.target.value }));
                      setCurrentPage(1);
                    }}
                    className="h-8 text-xs"
                    data-testid="input-filter-website"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[11px] text-slate-600 break-words">Address</Label>
                  <Input
                    placeholder="Filter by address..."
                    value={coreFieldFilters.invoicing_address}
                    onChange={(e) => { 
                      setCoreFieldFilters(prev => ({ ...prev, invoicing_address: e.target.value }));
                      setCurrentPage(1);
                    }}
                    className="h-8 text-xs"
                    data-testid="input-filter-address"
                  />
                </div>
              </div>

              {/* Custom Fields */}
              {orgCustomFields.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Custom Fields</p>
                    
                    {orgCustomFields.map(field => {
                      // Filter out title options (is_title=true or no value)
                      const validOptions = (field.options || []).filter(opt => 
                        !opt.is_title && opt.value && opt.value.trim() !== ''
                      );
                      const hasOptions = validOptions.length > 0;
                      
                      if (hasOptions) {
                        // Dropdown filter for fields with options
                        return (
                          <div key={field.id} className="space-y-1.5">
                            <Label className="text-[11px] text-slate-600 break-words leading-tight">{field.label}</Label>
                            <Select 
                              value={customFieldFilters[field.id] || 'all'} 
                              onValueChange={(v) => { 
                                setCustomFieldFilters(prev => ({ ...prev, [field.id]: v })); 
                                setCurrentPage(1); 
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs" data-testid={`select-filter-${field.id}`}>
                                <SelectValue placeholder={`All`} />
                              </SelectTrigger>
                              <SelectContent className="max-w-[260px]">
                                <SelectItem value="all" className="text-xs">All</SelectItem>
                                {validOptions.map((opt, idx) => (
                                  <SelectItem 
                                    key={idx} 
                                    value={opt.value} 
                                    className="text-xs whitespace-normal break-words"
                                  >
                                    {opt.label || opt.value}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        );
                      } else {
                        // Text filter for fields without options
                        const textValue = customFieldFilters[field.id]?.replace('__text__:', '') || '';
                        return (
                          <div key={field.id} className="space-y-1.5">
                            <Label className="text-[11px] text-slate-600 break-words leading-tight">{field.label}</Label>
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
                          </div>
                        );
                      }
                    })}
                  </div>
                </>
              )}
            </div>
          </ScrollArea>

          <div className="p-4 border-t border-slate-200 bg-slate-50 min-w-[288px]">
            <p className="text-xs text-slate-500">
              Showing {filteredOrganizations.length} of {organizations.length} organisations
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
                    {filteredOrganizations.length} organisation{filteredOrganizations.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
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
                        <Button 
                          size="sm" 
                          className="w-full gap-1" 
                          onClick={() => saveViewMutation.mutate()}
                          disabled={saveViewMutation.isPending}
                          data-testid="button-save-view"
                        >
                          {saveViewMutation.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Save className="w-3.5 h-3.5" />
                          )}
                          Save View
                        </Button>
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

          <div className="flex-1 overflow-auto p-6">
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
                      {visibleColumns.map(col => (
                        <th key={col.id} className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">
                          {col.label}
                        </th>
                      ))}
                      <th className="w-12 px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginatedOrganizations.map(org => (
                      <tr 
                        key={org.id} 
                        className={`hover:bg-slate-50 cursor-pointer transition-colors ${selectedOrgs.includes(org.id) ? 'bg-blue-50' : ''}`}
                        onClick={() => setSelectedOrg(org)}
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
                                  {org.logo_url ? (
                                    <img src={org.logo_url} alt={org.name} className="w-10 h-10 rounded-lg object-contain bg-slate-100" />
                                  ) : (
                                    <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                                      <Building2 className="w-5 h-5 text-blue-600" />
                                    </div>
                                  )}
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
                    onClick={() => setSelectedOrg(org)}
                    data-testid={`card-org-${org.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3 mb-3">
                        {org.logo_url ? (
                          <img src={org.logo_url} alt={org.name} className="w-12 h-12 rounded-lg object-contain bg-slate-100" />
                        ) : (
                          <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                            <Building2 className="w-6 h-6 text-blue-600" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <h3 className="font-medium text-slate-900 truncate">{org.name}</h3>
                        </div>
                      </div>

                      <div className="space-y-2 text-sm text-slate-600">
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4 text-slate-400" />
                          <span>{organizationMemberCounts[org.id] || 0} members</span>
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

                      {orgCustomFields.slice(0, 2).map(field => {
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
                <strong>Warning:</strong> This will also delete <strong>{selectedMemberCount} member{selectedMemberCount !== 1 ? 's' : ''}</strong> belonging to {singleDeleteOrg ? 'this organisation' : 'these organisations'}. This action cannot be undone.
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
