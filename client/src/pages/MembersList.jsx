import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { 
  Users,
  Search, 
  Loader2, 
  ChevronLeft, 
  ChevronRight,
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
  Smartphone,
  Briefcase,
  Save,
  Trash2,
  AlertTriangle
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
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { createPageUrl, isDeletedMember } from "@/utils";
import MemberDetailView from "@/components/MemberDetailView";
import { useToast } from "@/components/ui/use-toast";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { useNavigate } from "react-router-dom";

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
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(20);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [singleDeleteMember, setSingleDeleteMember] = useState(null);
  const [draggedColumn, setDraggedColumn] = useState(null);

  useRealtimeSubscription('member', [['members-crm-list']], { 
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

  const { data: members = [], isLoading: membersLoading } = useQuery({
    queryKey: ['members-crm-list'],
    enabled: accessChecked,
    queryFn: async () => {
      return await base44.entities.Member.listAll();
    }
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations-for-members'],
    enabled: accessChecked,
    queryFn: async () => {
      return await base44.entities.Organization.list('name');
    }
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles-for-members'],
    enabled: accessChecked,
    queryFn: async () => {
      return await base44.entities.Role.list();
    }
  });

  const { data: memberCustomFields = [] } = useQuery({
    queryKey: ['member-custom-fields-crm'],
    enabled: accessChecked,
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'member' },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => f.entity_scope === 'member');
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => !f.entity_scope || f.entity_scope === 'member');
        } catch {
          return [];
        }
      }
    }
  });

  const { data: allMemberPreferenceValues = [] } = useQuery({
    queryKey: ['all-member-preference-values-crm'],
    enabled: accessChecked && memberCustomFields.length > 0,
    queryFn: async () => {
      try {
        const values = await base44.entities.MemberPreferenceValue.list();
        return values || [];
      } catch {
        return [];
      }
    }
  });

  const { toast } = useToast();
  const columnPrefKey = memberInfo?.id ? getColumnPrefKey(memberInfo.id) : null;
  const dbColumnsLoadedRef = useRef(false);
  const savedPrefIdRef = useRef(null);

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
          description: 'CRM member list column preferences'
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
    mutationFn: async (memberIds) => {
      for (const memberId of memberIds) {
        await base44.entities.Member.delete(memberId);
      }
      return { deletedCount: memberIds.length };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['members-crm-list'] });
      setSelectedMembers([]);
      setShowDeleteDialog(false);
      setDeleteConfirmText('');
      setSingleDeleteMember(null);
      toast({
        title: "Members deleted",
        description: `Successfully deleted ${result.deletedCount} member(s).`
      });
    },
    onError: (error) => {
      toast({
        title: "Delete failed",
        description: error.message || "Could not delete members. Please try again.",
        variant: "destructive"
      });
    }
  });

  // Selection handlers
  const toggleMemberSelection = (memberId, e) => {
    if (e?.stopPropagation) e.stopPropagation();
    setSelectedMembers(prev => 
      prev.includes(memberId) 
        ? prev.filter(id => id !== memberId)
        : [...prev, memberId]
    );
  };

  const toggleSelectAll = () => {
    const currentPageIds = paginatedMembers.map(m => m.id);
    const allSelected = currentPageIds.every(id => selectedMembers.includes(id));
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

  const orgMap = useMemo(() => {
    const map = {};
    organizations.forEach(org => { map[org.id] = org; });
    return map;
  }, [organizations]);

  const memberValuesMap = useMemo(() => {
    const map = {};
    allMemberPreferenceValues.forEach(pv => {
      if (!map[pv.member_id]) {
        map[pv.member_id] = {};
      }
      map[pv.member_id][pv.field_id] = pv.value;
    });
    return map;
  }, [allMemberPreferenceValues]);

  const filteredMembers = useMemo(() => {
    let result = [...members];
    
    // Filter out deleted/anonymized members
    result = result.filter(m => !isDeletedMember(m));

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(m => 
        getMemberName(m).toLowerCase().includes(query) ||
        m.email?.toLowerCase().includes(query) ||
        m.mobile?.toLowerCase().includes(query) ||
        m.job_title?.toLowerCase().includes(query)
      );
    }

    if (statusFilter !== 'all') {
      if (statusFilter === 'disabled') {
        result = result.filter(m => m.disabled === true);
      } else {
        result = result.filter(m => !m.disabled);
      }
    }

    if (orgFilter !== 'all') {
      result = result.filter(m => m.organization_id === orgFilter);
    }

    if (roleFilter !== 'all') {
      result = result.filter(m => {
        // Support both legacy 'roles' array and new 'role_id' single value
        const memberRoles = m.roles || (m.role_id ? [m.role_id] : []);
        return memberRoles.includes(roleFilter);
      });
    }

    Object.entries(coreFieldFilters).forEach(([field, filterValue]) => {
      if (filterValue && filterValue.trim()) {
        const query = filterValue.toLowerCase().trim();
        result = result.filter(m => {
          const fieldVal = m[field];
          return fieldVal && fieldVal.toLowerCase().includes(query);
        });
      }
    });

    Object.entries(customFieldFilters).forEach(([fieldId, filterValue]) => {
      if (filterValue && filterValue !== 'all' && filterValue.trim() !== '') {
        const isTextFilter = filterValue.startsWith('__text__:');
        const actualValue = isTextFilter ? filterValue.replace('__text__:', '').toLowerCase() : filterValue;
        
        result = result.filter(m => {
          const memberFieldValue = memberValuesMap[m.id]?.[fieldId];
          if (!memberFieldValue) return false;
          
          if (isTextFilter) {
            return memberFieldValue.toLowerCase().includes(actualValue);
          }
          
          try {
            const parsed = JSON.parse(memberFieldValue);
            if (Array.isArray(parsed)) {
              return parsed.includes(filterValue);
            }
            return memberFieldValue === filterValue;
          } catch {
            return memberFieldValue === filterValue;
          }
        });
      }
    });

    return result;
  }, [members, searchQuery, statusFilter, orgFilter, roleFilter, coreFieldFilters, customFieldFilters, memberValuesMap]);

  const paginatedMembers = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredMembers.slice(start, start + itemsPerPage);
  }, [filteredMembers, currentPage, itemsPerPage]);

  const totalPages = Math.ceil(filteredMembers.length / itemsPerPage);

  const resetFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setOrgFilter('all');
    setRoleFilter('all');
    setCoreFieldFilters({ job_title: '' });
    setCustomFieldFilters({});
    setCurrentPage(1);
  };

  const hasActiveFilters = searchQuery || 
    statusFilter !== 'all' || 
    orgFilter !== 'all' ||
    roleFilter !== 'all' ||
    Object.values(coreFieldFilters).some(v => v && v.trim() !== '') ||
    Object.values(customFieldFilters).some(v => v && v !== 'all' && v.trim() !== '');

  const customFieldsMergedRef = useRef(false);

  useEffect(() => {
    if (memberCustomFields.length > 0 && !customFieldsMergedRef.current) {
      customFieldsMergedRef.current = true;
      setColumns(prev => {
        const existingIds = prev.map(c => c.id);
        const newCustomFieldColumns = memberCustomFields
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
  }, [memberCustomFields]);

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
    setColumns(DEFAULT_COLUMNS);
    saveLocalColumns(DEFAULT_COLUMNS, tenantSlug);
    customFieldsMergedRef.current = false;
  };

  const getCellValue = (member, col) => {
    if (col.isCustomField) {
      return memberValuesMap[member.id]?.[col.fieldId] || '-';
    }
    
    switch (col.id) {
      case 'name':
        return (
          <div className="flex items-center gap-3">
            <Avatar className="h-8 w-8">
              <AvatarImage src={member.profile_photo} />
              <AvatarFallback className="bg-blue-100 text-blue-700 text-xs">
                {getInitials(getMemberName(member))}
              </AvatarFallback>
            </Avatar>
            <span className="font-medium text-slate-900">{getMemberName(member) || 'Unknown'}</span>
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
              return (
                <Badge key={idx} variant="outline" className="text-xs">
                  {role?.name || roleId}
                </Badge>
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
          navigate(`/members/${createdMember.id}`);
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
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search members..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                className="pl-9"
                data-testid="input-search-members"
              />
            </div>
          </div>

          <ScrollArea className="flex-1 p-4 min-w-[288px]">
            <div className="space-y-4">
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

              <div className="space-y-1.5">
                <Label className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Organisation</Label>
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
              </div>

              <div className="space-y-1.5">
                <Label className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Role</Label>
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
              </div>

              <Separator />

              <div className="space-y-3">
                <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Details</p>
                
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
                    data-testid="input-filter-member-phone"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[11px] text-slate-600 break-words">Job Title</Label>
                  <Input
                    placeholder="Filter by job title..."
                    value={coreFieldFilters.job_title}
                    onChange={(e) => { 
                      setCoreFieldFilters(prev => ({ ...prev, job_title: e.target.value }));
                      setCurrentPage(1);
                    }}
                    className="h-8 text-xs"
                    data-testid="input-filter-member-job-title"
                  />
                </div>
              </div>

              {memberCustomFields.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Custom Fields</p>
                    
                    {memberCustomFields.map(field => {
                      const validOptions = (field.options || []).filter(opt => 
                        !opt.is_title && opt.value && opt.value.trim() !== ''
                      );
                      const hasOptions = validOptions.length > 0;
                      
                      if (hasOptions) {
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
                              <SelectTrigger className="h-8 text-xs" data-testid={`select-member-filter-${field.id}`}>
                                <SelectValue placeholder="All" />
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
                        const textValue = customFieldFilters[field.id]?.replace('__text__:', '') || '';
                        return (
                          <div key={field.id} className="space-y-1.5">
                            <Label className="text-[11px] text-slate-600 break-words leading-tight">{field.label}</Label>
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
              Showing {filteredMembers.length} of {members.length} members
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
                    Members
                  </h1>
                  <p className="text-sm text-slate-500">
                    {filteredMembers.length} member{filteredMembers.length !== 1 ? 's' : ''}
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
                        <Button 
                          size="sm" 
                          className="w-full gap-1" 
                          onClick={() => saveViewMutation.mutate()}
                          disabled={saveViewMutation.isPending}
                          data-testid="button-save-member-view"
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
                  onClick={() => setIsCreatingNew(true)}
                  className="gap-1"
                  data-testid="button-add-member"
                >
                  <Users className="w-4 h-4" />
                  Add Member
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

          <div className="flex-1 overflow-auto p-6">
            {membersLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : paginatedMembers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                <Users className="w-16 h-16 mb-4 text-slate-300" />
                <p className="text-lg font-medium">No members found</p>
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
                      {visibleColumns.map(col => (
                        <TableHead key={col.id} className="whitespace-nowrap">{col.label}</TableHead>
                      ))}
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedMembers.map(member => (
                      <TableRow 
                        key={member.id} 
                        className={`cursor-pointer hover:bg-slate-50 ${selectedMembers.includes(member.id) ? 'bg-blue-50' : ''}`}
                        onClick={() => navigate(`/members/${member.id}`)}
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
                      onClick={() => navigate(`/members/${member.id}`)}
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
                          {member.disabled ? (
                            <Badge variant="secondary" className="bg-red-100 text-red-700 text-xs">Disabled</Badge>
                          ) : (
                            <Badge variant="secondary" className="bg-green-100 text-green-700 text-xs">Active</Badge>
                          )}
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

          {totalPages > 1 && (
            <div className="bg-white border-t border-slate-200 px-6 py-4">
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
                    data-testid="button-member-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    data-testid="button-member-next-page"
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
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
              Delete Member{singleDeleteMember ? '' : 's'}
            </DialogTitle>
            <DialogDescription className="text-left space-y-3 pt-2">
              {singleDeleteMember ? (
                <p>
                  You are about to permanently delete <strong>{getMemberName(singleDeleteMember)}</strong>.
                </p>
              ) : (
                <p>
                  You are about to permanently delete <strong>{selectedMembers.length} member{selectedMembers.length !== 1 ? 's' : ''}</strong>.
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
                  Delete {singleDeleteMember ? '1' : selectedMembers.length} Member{(singleDeleteMember || selectedMembers.length === 1) ? '' : 's'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
