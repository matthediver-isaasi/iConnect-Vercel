import React, { useState, useEffect, useMemo, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Ticket, Plus, Pencil, Copy, Trash2, AlertCircle, Building2, Globe, Search, ChevronLeft, ChevronRight, EyeOff, Eye, User, Shield, Users, X, Loader2, Calendar } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const ITEMS_PER_PAGE = 10;

function getTargetType(code) {
  if (code.member_id) return 'member';
  if (code.role_id) return 'role';
  if (code.member_group_id) return 'member_group';
  if (code.organization_id) return 'organization';
  return 'global';
}

export default function DiscountCodeManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editingCode, setEditingCode] = useState(null);
  
  const [searchTerm, setSearchTerm] = useState("");
  const [showExpired, setShowExpired] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const [memberSearchInput, setMemberSearchInput] = useState("");
  const [memberSearchResults, setMemberSearchResults] = useState([]);
  const [memberSearchLoading, setMemberSearchLoading] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_DiscountCodeManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [showDialog, setShowDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [codeToDelete, setCodeToDelete] = useState(null);
  
  const queryClient = useQueryClient();

  const { data: discountCodes = [], isLoading: loadingCodes } = useQuery({
    queryKey: ['discount-codes'],
    queryFn: () => base44.entities.DiscountCode.list('-created_date'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: programs = [] } = useQuery({
    queryKey: ['programs'],
    queryFn: () => base44.entities.Program.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: events = [] } = useQuery({
    queryKey: ['events-for-discount'],
    queryFn: () => base44.entities.Event.list('-start_date'),
    staleTime: 60000,
  });

  const { data: usageRecords = [] } = useQuery({
    queryKey: ['discount-usage'],
    queryFn: () => base44.entities.DiscountCodeUsage.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: rolesData } = useQuery({
    queryKey: ['admin-roles-for-discount'],
    queryFn: async () => {
      const resp = await fetch('/api/admin/roles', { credentials: 'include' });
      if (!resp.ok) return [];
      const json = await resp.json();
      return json.data || [];
    },
    staleTime: 60000,
  });
  const roles = rolesData || [];

  const { data: memberGroups = [] } = useQuery({
    queryKey: ['member-groups-for-discount'],
    queryFn: () => base44.entities.MemberGroup.list(),
    staleTime: 60000,
  });

  const memberIdsInCodes = useMemo(() => {
    const ids = new Set();
    discountCodes.forEach(c => { if (c.member_id) ids.add(c.member_id); });
    return [...ids];
  }, [discountCodes]);

  const { data: membersForDisplay = [] } = useQuery({
    queryKey: ['members-for-discount-display', memberIdsInCodes],
    queryFn: async () => {
      if (memberIdsInCodes.length === 0) return [];
      const results = [];
      for (const id of memberIdsInCodes) {
        try {
          const m = await base44.entities.Member.get(id);
          if (m) results.push(m);
        } catch (e) {}
      }
      return results;
    },
    enabled: memberIdsInCodes.length > 0,
    staleTime: 60000,
  });

  const debouncedMemberSearch = useCallback(
    (() => {
      let timer;
      return (query) => {
        clearTimeout(timer);
        if (!query || query.length < 2) {
          setMemberSearchResults([]);
          setMemberSearchLoading(false);
          return;
        }
        setMemberSearchLoading(true);
        timer = setTimeout(async () => {
          try {
            const resp = await fetch(`/api/members/search?q=${encodeURIComponent(query)}&limit=10`, { credentials: 'include' });
            if (resp.ok) {
              const data = await resp.json();
              setMemberSearchResults(data);
            }
          } catch (e) {
            console.error('Member search error:', e);
          } finally {
            setMemberSearchLoading(false);
          }
        }, 300);
      };
    })(),
    []
  );

  const getTargetLabel = (code) => {
    const type = getTargetType(code);
    switch (type) {
      case 'member': {
        const m = membersForDisplay.find(m => m.id === code.member_id);
        return { label: m ? `${m.first_name} ${m.last_name}` : 'Member', icon: User, colorClass: 'bg-indigo-50 text-indigo-700 border-indigo-200' };
      }
      case 'role': {
        const r = roles.find(r => r.id === code.role_id);
        return { label: r?.name || 'Role', icon: Shield, colorClass: 'bg-teal-50 text-teal-700 border-teal-200' };
      }
      case 'member_group': {
        const g = memberGroups.find(g => g.id === code.member_group_id);
        return { label: g?.name || 'Group', icon: Users, colorClass: 'bg-orange-50 text-orange-700 border-orange-200' };
      }
      case 'organization': {
        const o = organizations.find(o => o.id === code.organization_id);
        return { label: o?.name || 'Organisation', icon: Building2, colorClass: 'bg-blue-50 text-blue-700 border-blue-200' };
      }
      default:
        return { label: 'Global', icon: Globe, colorClass: 'bg-green-50 text-green-700 border-green-200' };
    }
  };

  const filteredCodes = useMemo(() => {
    let filtered = discountCodes;
    
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(code => {
        if (code.code?.toLowerCase().includes(term)) return true;
        if (code.description?.toLowerCase().includes(term)) return true;
        const target = getTargetLabel(code);
        if (target.label?.toLowerCase().includes(term)) return true;
        return false;
      });
    }
    
    if (!showExpired) {
      filtered = filtered.filter(code => {
        if (!code.expires_at) return true;
        return new Date(code.expires_at) >= new Date();
      });
    }
    
    return filtered;
  }, [discountCodes, searchTerm, showExpired, organizations, roles, memberGroups, membersForDisplay]);

  const totalPages = Math.ceil(filteredCodes.length / ITEMS_PER_PAGE);
  const paginatedCodes = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredCodes.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredCodes, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, showExpired]);

  const createCodeMutation = useMutation({
    mutationFn: (codeData) => base44.entities.DiscountCode.create(codeData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discount-codes'] });
      queryClient.invalidateQueries({ queryKey: ['members-for-discount-display'] });
      setShowDialog(false);
      setEditingCode(null);
      toast.success('Discount code created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create discount code: ' + error.message);
    }
  });

  const updateCodeMutation = useMutation({
    mutationFn: ({ id, codeData }) => base44.entities.DiscountCode.update(id, codeData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discount-codes'] });
      queryClient.invalidateQueries({ queryKey: ['members-for-discount-display'] });
      setShowDialog(false);
      setEditingCode(null);
      toast.success('Discount code updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update discount code: ' + error.message);
    }
  });

  const deleteCodeMutation = useMutation({
    mutationFn: (id) => base44.entities.DiscountCode.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discount-codes'] });
      setShowDeleteConfirm(false);
      setCodeToDelete(null);
      toast.success('Discount code deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete discount code: ' + error.message);
    }
  });

  const canDeleteCode = (code) => {
    if (code.organization_id) {
      const usage = usageRecords.find(ur => 
        ur.discount_code_id === code.id && ur.organization_id === code.organization_id
      );
      return !usage || usage.usage_count === 0;
    } else {
      return (code.current_usage_count || 0) === 0;
    }
  };

  const handleCreateNew = () => {
    setEditingCode({
      code: "",
      type: "percentage",
      value: 0,
      description: "",
      is_active: false,
      expires_at: "",
      min_purchase_amount: 0,
      max_usage_count: null,
      program_tag: "",
      event_id: "",
      organization_id: "",
      member_id: "",
      role_id: "",
      member_group_id: "",
      _targetType: "global"
    });
    setSelectedMember(null);
    setMemberSearchInput("");
    setMemberSearchResults([]);
    setShowDialog(true);
  };

  const handleEdit = (code) => {
    const targetType = getTargetType(code);
    const editData = { 
      ...code,
      expires_at: code.expires_at ? format(new Date(code.expires_at), "yyyy-MM-dd'T'HH:mm") : "",
      organization_id: code.organization_id || "",
      member_id: code.member_id || "",
      role_id: code.role_id || "",
      member_group_id: code.member_group_id || "",
      program_tag: code.program_tag || "",
      event_id: code.event_id || "",
      max_usage_count: code.max_usage_count || null,
      _targetType: targetType
    };
    setEditingCode(editData);
    
    if (targetType === 'member' && code.member_id) {
      const m = membersForDisplay.find(m => m.id === code.member_id);
      setSelectedMember(m || null);
      setMemberSearchInput(m ? `${m.first_name} ${m.last_name}` : '');
    } else {
      setSelectedMember(null);
      setMemberSearchInput("");
    }
    setMemberSearchResults([]);
    setShowDialog(true);
  };

  const handleCopy = (code) => {
    const targetType = getTargetType(code);
    setEditingCode({
      ...code,
      id: undefined,
      code: code.code + "_COPY",
      is_active: false,
      current_usage_count: 0,
      expires_at: code.expires_at ? format(new Date(code.expires_at), "yyyy-MM-dd'T'HH:mm") : "",
      organization_id: code.organization_id || "",
      member_id: code.member_id || "",
      role_id: code.role_id || "",
      member_group_id: code.member_group_id || "",
      program_tag: code.program_tag || "",
      event_id: code.event_id || "",
      _targetType: targetType
    });
    if (targetType === 'member' && code.member_id) {
      const m = membersForDisplay.find(m => m.id === code.member_id);
      setSelectedMember(m || null);
      setMemberSearchInput(m ? `${m.first_name} ${m.last_name}` : '');
    } else {
      setSelectedMember(null);
      setMemberSearchInput("");
    }
    setMemberSearchResults([]);
    setShowDialog(true);
  };

  const handleDelete = (code) => {
    if (!canDeleteCode(code)) {
      toast.error('Cannot delete a discount code that has been used');
      return;
    }
    setCodeToDelete(code);
    setShowDeleteConfirm(true);
  };

  const handleToggleActive = async (code) => {
    try {
      await base44.entities.DiscountCode.update(code.id, {
        is_active: !code.is_active
      });
      queryClient.invalidateQueries({ queryKey: ['discount-codes'] });
      toast.success(`Discount code ${code.is_active ? 'deactivated' : 'activated'}`);
    } catch (error) {
      toast.error('Failed to update status: ' + error.message);
    }
  };

  const handleTargetTypeChange = (newType) => {
    setEditingCode(prev => ({
      ...prev,
      _targetType: newType,
      organization_id: "",
      member_id: "",
      role_id: "",
      member_group_id: "",
    }));
    setSelectedMember(null);
    setMemberSearchInput("");
    setMemberSearchResults([]);
  };

  const handleSave = () => {
    if (!editingCode.code.trim()) {
      toast.error('Code is required');
      return;
    }

    if (editingCode.value <= 0) {
      toast.error('Value must be greater than 0');
      return;
    }

    if (editingCode.type === 'percentage' && editingCode.value > 100) {
      toast.error('Percentage cannot exceed 100%');
      return;
    }

    const targetType = editingCode._targetType;
    if (targetType === 'organization' && !editingCode.organization_id) {
      toast.error('Please select an organisation');
      return;
    }
    if (targetType === 'member' && !editingCode.member_id) {
      toast.error('Please select a member');
      return;
    }
    if (targetType === 'role' && !editingCode.role_id) {
      toast.error('Please select a role');
      return;
    }
    if (targetType === 'member_group' && !editingCode.member_group_id) {
      toast.error('Please select a member group');
      return;
    }

    const codeData = {
      code: editingCode.code.toUpperCase().trim(),
      type: editingCode.type,
      value: parseFloat(editingCode.value),
      description: editingCode.description || "",
      is_active: editingCode.is_active,
      expires_at: editingCode.expires_at ? new Date(editingCode.expires_at).toISOString() : null,
      min_purchase_amount: parseFloat(editingCode.min_purchase_amount) || 0,
      max_usage_count: editingCode.max_usage_count ? parseInt(editingCode.max_usage_count) : null,
      program_tag: editingCode.program_tag || null,
      event_id: editingCode.event_id || null,
      organization_id: targetType === 'organization' ? editingCode.organization_id : null,
      member_id: targetType === 'member' ? editingCode.member_id : null,
      role_id: targetType === 'role' ? editingCode.role_id : null,
      member_group_id: targetType === 'member_group' ? editingCode.member_group_id : null,
    };

    if (editingCode.id) {
      updateCodeMutation.mutate({ id: editingCode.id, codeData });
    } else {
      createCodeMutation.mutate(codeData);
    }
  };

  const getUsageInfo = (code) => {
    if (code.organization_id) {
      const usage = usageRecords.find(ur => 
        ur.discount_code_id === code.id && ur.organization_id === code.organization_id
      );
      const used = usage?.usage_count || 0;
      return {
        used,
        max: code.max_usage_count,
        hasMax: !!code.max_usage_count
      };
    } else {
      return {
        used: code.current_usage_count || 0,
        max: code.max_usage_count,
        hasMax: !!code.max_usage_count
      };
    }
  };

  const getMaxUsageHint = () => {
    if (!editingCode) return '';
    switch (editingCode._targetType) {
      case 'global': return 'Total across all users';
      case 'organization': return 'Per organisation';
      case 'member': return 'Per individual member';
      case 'role': return 'Per individual member with this role';
      case 'member_group': return 'Per individual member in this group';
      default: return '';
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Discount Code Management
            </h1>
            <p className="text-slate-600">
              Create and manage discount codes for program ticket purchases
            </p>
          </div>
          <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
            <Plus className="w-4 h-4 mr-2" />
            Create Code
          </Button>
        </div>

        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search by code, description, or target..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                  data-testid="input-search-discount-codes"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowExpired(!showExpired)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors ${
                    showExpired 
                      ? 'bg-amber-50 border-amber-200 text-amber-700' 
                      : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                  data-testid="button-toggle-expired"
                >
                  {showExpired ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  {showExpired ? 'Showing expired' : 'Hiding expired'}
                </button>
                <div className="text-sm text-slate-500">
                  {filteredCodes.length} {filteredCodes.length === 1 ? 'code' : 'codes'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {loadingCodes ? (
          <div className="text-center py-12">Loading discount codes...</div>
        ) : discountCodes.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Ticket className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Discount Codes Yet
              </h3>
              <p className="text-slate-600 mb-6">
                Create your first discount code to start offering promotions
              </p>
              <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Code
              </Button>
            </CardContent>
          </Card>
        ) : filteredCodes.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Search className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Matching Codes
              </h3>
              <p className="text-slate-600 mb-4">
                No discount codes match your search criteria
              </p>
              <Button 
                variant="outline" 
                onClick={() => { setSearchTerm(""); setShowExpired(true); }}
              >
                Clear Filters
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-6">
            {paginatedCodes.map((code) => {
              const usageInfo = getUsageInfo(code);
              const target = getTargetLabel(code);
              const TargetIcon = target.icon;
              const isExpired = code.expires_at && new Date(code.expires_at) < new Date();
              
              return (
                <Card key={code.id} className={`border-2 ${
                  !code.is_active ? 'border-slate-200 bg-slate-50' : 
                  isExpired ? 'border-red-200 bg-red-50' :
                  'border-slate-200'
                }`}>
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <Ticket className="w-5 h-5 text-blue-600" />
                          <CardTitle className="text-2xl font-bold">{code.code}</CardTitle>
                          {code.is_active ? (
                            <Badge className="bg-green-100 text-green-700">Active</Badge>
                          ) : (
                            <Badge className="bg-slate-200 text-slate-700">Draft</Badge>
                          )}
                          {isExpired && (
                            <Badge className="bg-red-100 text-red-700">Expired</Badge>
                          )}
                        </div>
                        
                        <div className="flex flex-wrap gap-2 mt-3">
                          {code.type === 'percentage' ? (
                            <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                              {code.value}% OFF
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                              £{code.value.toFixed(2)} OFF
                            </Badge>
                          )}
                          
                          <Badge variant="outline" className={target.colorClass}>
                            <TargetIcon className="w-3 h-3 mr-1" />
                            {target.label}
                          </Badge>
                          
                          {code.program_tag && (
                            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                              {code.program_tag}
                            </Badge>
                          )}
                          {code.event_id && (() => {
                            const ev = events.find(e => e.id === code.event_id);
                            return (
                              <Badge variant="outline" className="bg-sky-50 text-sky-700 border-sky-200">
                                <Calendar className="w-3 h-3 mr-1" />
                                {ev?.title || ev?.name || 'Event'}
                              </Badge>
                            );
                          })()}
                        </div>
                      </div>
                      
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEdit(code)}
                        >
                          <Pencil className="w-3 h-3 mr-1" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCopy(code)}
                        >
                          <Copy className="w-3 h-3 mr-1" />
                          Copy
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleToggleActive(code)}
                        >
                          {code.is_active ? 'Deactivate' : 'Activate'}
                        </Button>
                        {canDeleteCode(code) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDelete(code)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  
                  <CardContent className="pt-4">
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="space-y-3">
                        {code.description && (
                          <div>
                            <div className="text-xs font-medium text-slate-500 mb-1">Description</div>
                            <p className="text-sm text-slate-700">{code.description}</p>
                          </div>
                        )}
                        
                        {code.min_purchase_amount > 0 && (
                          <div>
                            <div className="text-xs font-medium text-slate-500 mb-1">Minimum Purchase</div>
                            <p className="text-sm text-slate-700">£{code.min_purchase_amount.toFixed(2)}</p>
                          </div>
                        )}
                        
                        {code.expires_at && (
                          <div>
                            <div className="text-xs font-medium text-slate-500 mb-1">Expires</div>
                            <p className={`text-sm ${isExpired ? 'text-red-600 font-medium' : 'text-slate-700'}`}>
                              {format(new Date(code.expires_at), 'MMM d, yyyy h:mm a')}
                            </p>
                          </div>
                        )}
                      </div>
                      
                      <div className="space-y-3">
                        <div>
                          <div className="text-xs font-medium text-slate-500 mb-1">Usage</div>
                          {usageInfo.hasMax ? (
                            <p className="text-sm text-slate-700">
                              {usageInfo.used} / {usageInfo.max} times used
                            </p>
                          ) : (
                            <p className="text-sm text-slate-700">
                              {usageInfo.used} times used (no limit)
                            </p>
                          )}
                        </div>
                        
                        {code.created_date && (
                          <div>
                            <div className="text-xs font-medium text-slate-500 mb-1">Created</div>
                            <p className="text-sm text-slate-700">
                              {format(new Date(code.created_date), 'MMM d, yyyy')}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-slate-200">
                <div className="text-sm text-slate-500">
                  Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1} - {Math.min(currentPage * ITEMS_PER_PAGE, filteredCodes.length)} of {filteredCodes.length}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Previous
                  </Button>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum;
                      if (totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (currentPage <= 3) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = currentPage - 2 + i;
                      }
                      return (
                        <Button
                          key={pageNum}
                          variant={currentPage === pageNum ? "default" : "outline"}
                          size="sm"
                          onClick={() => setCurrentPage(pageNum)}
                          className="w-9"
                          data-testid={`button-page-${pageNum}`}
                        >
                          {pageNum}
                        </Button>
                      );
                    })}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    data-testid="button-next-page"
                  >
                    Next
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Edit/Create Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingCode?.id ? 'Edit Discount Code' : 'Create New Discount Code'}
              </DialogTitle>
            </DialogHeader>
            
            {editingCode && (
              <div className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="code">Code *</Label>
                    <Input
                      id="code"
                      value={editingCode.code}
                      onChange={(e) => setEditingCode({ ...editingCode, code: e.target.value.toUpperCase() })}
                      placeholder="e.g., SUMMER20"
                      data-testid="input-discount-code-name"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="type">Type *</Label>
                    <Select
                      value={editingCode.type}
                      onValueChange={(value) => setEditingCode({ ...editingCode, type: value })}
                    >
                      <SelectTrigger data-testid="select-discount-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">Percentage</SelectItem>
                        <SelectItem value="fixed">Fixed Amount</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="value">
                    Value * {editingCode.type === 'percentage' ? '(%)' : '(£)'}
                  </Label>
                  <Input
                    id="value"
                    type="number"
                    step="0.01"
                    min="0"
                    max={editingCode.type === 'percentage' ? "100" : undefined}
                    value={editingCode.value}
                    onChange={(e) => setEditingCode({ ...editingCode, value: e.target.value })}
                    data-testid="input-discount-value"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={editingCode.description}
                    onChange={(e) => setEditingCode({ ...editingCode, description: e.target.value })}
                    placeholder="Internal description for this code..."
                    rows={2}
                    data-testid="input-discount-description"
                  />
                </div>

                <div className="space-y-3 p-4 border border-slate-200 rounded-lg bg-slate-50">
                  <Label className="text-sm font-semibold">Target</Label>
                  <RadioGroup
                    value={editingCode._targetType}
                    onValueChange={handleTargetTypeChange}
                    className="grid grid-cols-2 md:grid-cols-3 gap-2"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="global" id="target-global" data-testid="radio-target-global" />
                      <Label htmlFor="target-global" className="flex items-center gap-1 cursor-pointer text-sm">
                        <Globe className="w-3.5 h-3.5" /> Global
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="organization" id="target-org" data-testid="radio-target-organization" />
                      <Label htmlFor="target-org" className="flex items-center gap-1 cursor-pointer text-sm">
                        <Building2 className="w-3.5 h-3.5" /> Organisation
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="member" id="target-member" data-testid="radio-target-member" />
                      <Label htmlFor="target-member" className="flex items-center gap-1 cursor-pointer text-sm">
                        <User className="w-3.5 h-3.5" /> Member
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="role" id="target-role" data-testid="radio-target-role" />
                      <Label htmlFor="target-role" className="flex items-center gap-1 cursor-pointer text-sm">
                        <Shield className="w-3.5 h-3.5" /> Role
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="member_group" id="target-group" data-testid="radio-target-member-group" />
                      <Label htmlFor="target-group" className="flex items-center gap-1 cursor-pointer text-sm">
                        <Users className="w-3.5 h-3.5" /> Member Group
                      </Label>
                    </div>
                  </RadioGroup>

                  {editingCode._targetType === 'organization' && (
                    <div className="space-y-2 mt-3">
                      <Label>Organisation *</Label>
                      <Select
                        value={editingCode.organization_id}
                        onValueChange={(value) => setEditingCode({ ...editingCode, organization_id: value })}
                      >
                        <SelectTrigger data-testid="select-target-organization">
                          <SelectValue placeholder="Select organisation" />
                        </SelectTrigger>
                        <SelectContent>
                          {organizations.map(org => (
                            <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {editingCode._targetType === 'member' && (
                    <div className="space-y-2 mt-3">
                      <Label>Member *</Label>
                      {selectedMember ? (
                        <div className="flex items-center gap-2 p-2 border border-indigo-200 bg-indigo-50 rounded-md">
                          <User className="w-4 h-4 text-indigo-600" />
                          <span className="text-sm font-medium text-indigo-900 flex-1">
                            {selectedMember.first_name} {selectedMember.last_name}
                            {selectedMember.email && (
                              <span className="text-indigo-600 font-normal ml-1">({selectedMember.email})</span>
                            )}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => {
                              setSelectedMember(null);
                              setMemberSearchInput("");
                              setEditingCode({ ...editingCode, member_id: "" });
                            }}
                            data-testid="button-clear-member"
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      ) : (
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                          <Input
                            value={memberSearchInput}
                            onChange={(e) => {
                              setMemberSearchInput(e.target.value);
                              debouncedMemberSearch(e.target.value);
                            }}
                            placeholder="Search by name or email..."
                            className="pl-10"
                            data-testid="input-member-search"
                          />
                          {memberSearchLoading && (
                            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 animate-spin" />
                          )}
                          {memberSearchResults.length > 0 && (
                            <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-md shadow-lg max-h-48 overflow-y-auto">
                              {memberSearchResults.map(m => (
                                <button
                                  key={m.id}
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2"
                                  onClick={() => {
                                    setSelectedMember(m);
                                    setEditingCode({ ...editingCode, member_id: m.id });
                                    setMemberSearchInput(`${m.first_name} ${m.last_name}`);
                                    setMemberSearchResults([]);
                                  }}
                                  data-testid={`button-select-member-${m.id}`}
                                >
                                  <User className="w-3 h-3 text-slate-400" />
                                  <span className="font-medium">{m.first_name} {m.last_name}</span>
                                  <span className="text-slate-500 ml-auto">{m.email}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {editingCode._targetType === 'role' && (
                    <div className="space-y-2 mt-3">
                      <Label>Role *</Label>
                      <Select
                        value={editingCode.role_id}
                        onValueChange={(value) => setEditingCode({ ...editingCode, role_id: value })}
                      >
                        <SelectTrigger data-testid="select-target-role">
                          <SelectValue placeholder="Select role" />
                        </SelectTrigger>
                        <SelectContent>
                          {roles.map(r => (
                            <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {editingCode._targetType === 'member_group' && (
                    <div className="space-y-2 mt-3">
                      <Label>Member Group *</Label>
                      <Select
                        value={editingCode.member_group_id}
                        onValueChange={(value) => setEditingCode({ ...editingCode, member_group_id: value })}
                      >
                        <SelectTrigger data-testid="select-target-member-group">
                          <SelectValue placeholder="Select member group" />
                        </SelectTrigger>
                        <SelectContent>
                          {memberGroups.filter(g => g.is_active).map(g => (
                            <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="program">Program (Optional)</Label>
                    <Select
                      value={editingCode.program_tag}
                      onValueChange={(value) => setEditingCode({ ...editingCode, program_tag: value })}
                    >
                      <SelectTrigger data-testid="select-program">
                        <SelectValue placeholder="All programs" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={null}>All programs</SelectItem>
                        {programs.map(prog => (
                          <SelectItem key={prog.id} value={prog.program_tag}>{prog.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="event">Event (Optional)</Label>
                    <Select
                      value={editingCode.event_id}
                      onValueChange={(value) => setEditingCode({ ...editingCode, event_id: value })}
                    >
                      <SelectTrigger data-testid="select-event">
                        <SelectValue placeholder="All events" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={null}>All events</SelectItem>
                        {events.map(ev => (
                          <SelectItem key={ev.id} value={ev.id}>{ev.title || ev.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="min-purchase">Minimum Purchase (£)</Label>
                    <Input
                      id="min-purchase"
                      type="number"
                      step="0.01"
                      min="0"
                      value={editingCode.min_purchase_amount}
                      onChange={(e) => setEditingCode({ ...editingCode, min_purchase_amount: e.target.value })}
                      data-testid="input-min-purchase"
                    />
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="max-usage">Max Uses (Optional)</Label>
                    <Input
                      id="max-usage"
                      type="number"
                      min="1"
                      value={editingCode.max_usage_count || ''}
                      onChange={(e) => setEditingCode({ ...editingCode, max_usage_count: e.target.value })}
                      placeholder="Unlimited"
                      data-testid="input-max-usage"
                    />
                    <p className="text-xs text-slate-500">
                      {getMaxUsageHint()}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="expires">Expiry Date (Optional)</Label>
                    <Input
                      id="expires"
                      type="datetime-local"
                      value={editingCode.expires_at}
                      onChange={(e) => setEditingCode({ ...editingCode, expires_at: e.target.value })}
                      data-testid="input-expires"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                  <Switch
                    id="is-active"
                    checked={editingCode.is_active}
                    onCheckedChange={(checked) => setEditingCode({ ...editingCode, is_active: checked })}
                    data-testid="switch-is-active"
                  />
                  <div className="flex-1">
                    <Label htmlFor="is-active" className="cursor-pointer font-medium">
                      Active
                    </Label>
                    <p className="text-xs text-slate-500 mt-1">
                      Only active codes can be used by members
                    </p>
                  </div>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  setEditingCode(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createCodeMutation.isPending || updateCodeMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-save-discount-code"
              >
                {editingCode?.id ? 'Update Code' : 'Create Code'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Discount Code</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-red-50 rounded-lg">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-red-900 font-medium">
                    Are you sure you want to delete "{codeToDelete?.code}"?
                  </p>
                  <p className="text-xs text-red-700 mt-1">
                    This action cannot be undone.
                  </p>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setCodeToDelete(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => codeToDelete && deleteCodeMutation.mutate(codeToDelete.id)}
                disabled={deleteCodeMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
                data-testid="button-confirm-delete"
              >
                Delete Code
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
