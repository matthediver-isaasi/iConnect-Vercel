import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Mail, Plus, Pencil, Trash2, Users, Shield, AlertTriangle, Download, Loader2, ChevronLeft, ChevronRight, ChevronDown, X, RefreshCw, Link2, Unlink, Send, Globe, ListFilter, Check, Save } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useNavigate, useSearchParams } from "react-router-dom";
import EmailCampaigns from "@/components/EmailCampaigns";

export default function CommunicationsManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState(null);
  const [showSetupInstructions, setShowSetupInstructions] = useState(false);
  const [syncingCategory, setSyncingCategory] = useState(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null); // { categoryId, processed, total, subscribed, unsubscribed, errors }
  const [activeJobId, setActiveJobId] = useState(null);

  const [expandedCategories, setExpandedCategories] = useState({});

  const toggleCategory = (categoryId) => {
    setExpandedCategories(prev => ({ ...prev, [categoryId]: !prev[categoryId] }));
  };

  const [showEditListDialog, setShowEditListDialog] = useState(false);
  const [editingList, setEditingList] = useState(null);
  const [editListName, setEditListName] = useState('');
  const [editListAudiences, setEditListAudiences] = useState([]);
  const [savingListEdit, setSavingListEdit] = useState(false);
  const [showDeleteListConfirm, setShowDeleteListConfirm] = useState(false);
  const [listToDelete, setListToDelete] = useState(null);
  const [deletingList, setDeletingList] = useState(false);
  const [showAddListSegment, setShowAddListSegment] = useState(false);
  const [addListSegmentType, setAddListSegmentType] = useState('');
  const [addListSegmentIds, setAddListSegmentIds] = useState([]);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  useEffect(() => {
    const zohoConnected = searchParams.get('zoho_connected');
    const zohoError = searchParams.get('zoho_error');
    
    if (zohoConnected === 'true') {
      toast.success('Zoho Campaigns connected successfully!');
      queryClient.invalidateQueries({ queryKey: ['zoho-campaigns-status'] });
      queryClient.invalidateQueries({ queryKey: ['zoho-campaigns-lists'] });
      window.history.replaceState({}, '', window.location.pathname);
    } else if (zohoError) {
      toast.error(`Zoho connection failed: ${zohoError}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [searchParams, queryClient]);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('communication')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
        checkForRunningJob();
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const checkForRunningJob = async () => {
    try {
      const response = await fetch('/api/zoho-campaigns/sync-job', {
        credentials: 'include'
      });
      if (!response.ok) return;
      
      const job = await response.json();
      if (job.status === 'running' || job.status === 'pending') {
        setActiveJobId(job.id);
        setSyncingCategory(job.categoryId);
        setSyncProgress({
          categoryId: job.categoryId,
          processed: job.currentOffset,
          total: job.totalMembers,
          subscribed: job.subscribed,
          unsubscribed: job.unsubscribed,
          errors: job.errors,
          skipped: job.skipped,
          progress: job.progress
        });
        continueAndPollJob(job.id, job.categoryId);
      }
    } catch (error) {
      console.log('No running sync job found');
    }
  };

  const { data: categories = [], isLoading: categoriesLoading, error: categoriesError } = useQuery({
    queryKey: ['communication-categories'],
    queryFn: () => base44.entities.CommunicationCategory.list({ sort: { display_order: 'asc' } }),
    staleTime: 0,
    retry: 1,
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: () => base44.entities.Role.list(),
  });

  const { data: allOrganizations = [] } = useQuery({
    queryKey: ['all-organizations-for-lookup'],
    queryFn: () => base44.entities.Organization.listAll(),
    staleTime: 60000,
  });

  const orgLookup = useMemo(() => {
    const map = {};
    allOrganizations.forEach(org => { map[org.id] = org.name; });
    return map;
  }, [allOrganizations]);

  const roleLookup = useMemo(() => {
    const map = {};
    roles.forEach(role => { map[role.id] = role.name; });
    return map;
  }, [roles]);

  const { data: categoryRoles = [] } = useQuery({
    queryKey: ['communication-category-roles'],
    queryFn: () => base44.entities.CommunicationCategoryRole.list(),
    staleTime: 0,
    retry: 1,
  });

  const { data: preferences = [] } = useQuery({
    queryKey: ['member-communication-preferences'],
    queryFn: () => base44.entities.MemberCommunicationPreference.list(),
    staleTime: 0,
    retry: 1,
  });

  const { data: allMembers = [], isLoading: membersLoading } = useQuery({
    queryKey: ['all-members-for-export'],
    queryFn: () => base44.entities.Member.listAll(),
    staleTime: 60000,
  });

  const { data: externalSubscriberCounts = {} } = useQuery({
    queryKey: ['external-subscriber-counts'],
    queryFn: async () => {
      const response = await fetch('/api/admin/external-subscribers', { credentials: 'include' });
      if (!response.ok) return {};
      const data = await response.json();
      return data.counts || {};
    },
    staleTime: 30000,
  });

  const { data: zohoStatus, isLoading: zohoStatusLoading } = useQuery({
    queryKey: ['zoho-campaigns-status'],
    queryFn: async () => {
      const response = await fetch('/api/zoho-campaigns/oauth?action=status', {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch Zoho status');
      return response.json();
    },
    staleTime: 30000,
  });

  const { data: zohoListsData, isLoading: zohoListsLoading } = useQuery({
    queryKey: ['zoho-campaigns-lists'],
    queryFn: async () => {
      const response = await fetch('/api/zoho-campaigns/lists', {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch Zoho lists');
      return response.json();
    },
    enabled: zohoStatus?.connected === true,
    staleTime: 60000,
  });

  const zohoLists = zohoListsData?.lists || [];
  const isZohoConnected = zohoStatus?.connected === true;
  const isZohoCredentialsConfigured = zohoStatus?.credentialsConfigured === true;

  const { data: audienceLists = [] } = useQuery({
    queryKey: ['audience-lists'],
    queryFn: async () => {
      const response = await fetch('/api/audience-lists', { credentials: 'include' });
      if (!response.ok) return [];
      return response.json();
    },
    staleTime: 30000,
  });

  const { data: memberGroups = [] } = useQuery({
    queryKey: ['member-groups'],
    queryFn: () => base44.entities.MemberGroup.list(),
    staleTime: 60000,
  });

  const { data: formsWithCategory = [] } = useQuery({
    queryKey: ['forms-with-category'],
    queryFn: async () => {
      try {
        const allForms = await base44.entities.Form.list();
        return (allForms || []).filter(f => f.communication_category_id && f.is_active !== false);
      } catch (e) { return []; }
    },
    staleTime: 60000,
  });

  const { data: fundraisingCampaigns = [] } = useQuery({
    queryKey: ['fundraising-campaigns-list'],
    queryFn: async () => {
      try {
        const response = await fetch('/api/fundraising/campaigns', { credentials: 'include' });
        if (!response.ok) return [];
        return await response.json() || [];
      } catch (e) { return []; }
    },
    staleTime: 60000,
  });

  const getSegmentSummary = (segment) => {
    const typeLabels = {
      communication_category: 'Categories',
      member_group: 'Groups',
      role: 'Roles',
      form: 'Forms',
      fundraisers: 'Fundraisers',
      donors: 'Donors',
      all_members: 'All Members',
      audience_list: 'Saved Lists'
    };
    const label = typeLabels[segment.type] || segment.type;
    if (segment.type === 'all_members') return label;
    const count = (segment.ids || []).length;
    if (segment.type === 'role') {
      const names = (segment.ids || []).map(id => roleLookup[id]).filter(Boolean);
      return names.length > 0 ? `${label}: ${names.join(', ')}` : `${label} (${count})`;
    }
    if (segment.type === 'member_group') {
      const names = (segment.ids || []).map(id => memberGroups.find(g => g.id === id)?.name).filter(Boolean);
      return names.length > 0 ? `${label}: ${names.join(', ')}` : `${label} (${count})`;
    }
    if (segment.type === 'communication_category') {
      const names = (segment.ids || []).map(id => categories.find(c => c.id === id)?.name).filter(Boolean);
      return names.length > 0 ? `${label}: ${names.join(', ')}` : `${label} (${count})`;
    }
    if (segment.type === 'form') {
      const names = (segment.ids || []).map(id => formsWithCategory.find(f => f.id === id)?.name).filter(Boolean);
      return names.length > 0 ? `${label}: ${names.join(', ')}` : `${label} (${count})`;
    }
    if (segment.type === 'fundraisers' || segment.type === 'donors') {
      if (segment.ids?.includes('all')) return segment.type === 'fundraisers' ? 'All Fundraisers' : 'All Donors';
      const names = (segment.ids || []).map(id => fundraisingCampaigns.find(c => c.id === id)?.name).filter(Boolean);
      return names.length > 0 ? `${label}: ${names.join(', ')}` : `${label} (${count})`;
    }
    if (segment.type === 'audience_list') {
      const names = (segment.ids || []).map(id => audienceLists.find(l => l.id === id)?.name).filter(Boolean);
      return names.length > 0 ? `${label}: ${names.join(', ')}` : `${label} (${count})`;
    }
    return `${label} (${count})`;
  };

  const openEditListDialog = (list) => {
    setEditingList(list);
    setEditListName(list.name);
    setEditListAudiences(Array.isArray(list.target_audiences) ? [...list.target_audiences] : []);
    setShowAddListSegment(false);
    setAddListSegmentType('');
    setAddListSegmentIds([]);
    setShowEditListDialog(true);
  };

  const openNewListDialog = () => {
    setEditingList(null);
    setEditListName('');
    setEditListAudiences([]);
    setShowAddListSegment(false);
    setAddListSegmentType('');
    setAddListSegmentIds([]);
    setShowEditListDialog(true);
  };

  const handleSaveListEdit = async () => {
    if (!editListName.trim()) { toast.error('Please enter a list name'); return; }
    if (editListAudiences.length === 0) { toast.error('At least one audience segment is required'); return; }
    setSavingListEdit(true);
    try {
      const isCreating = !editingList;
      const payload = {
        name: editListName.trim(),
        target_audiences: editListAudiences
      };
      if (!isCreating) {
        payload.id = editingList.id;
      }

      const response = await fetch('/api/audience-lists', {
        method: isCreating ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        toast.success(isCreating ? 'Audience list created' : 'Audience list updated');
        setShowEditListDialog(false);
        queryClient.invalidateQueries({ queryKey: ['audience-lists'] });
      } else {
        const err = await response.json();
        toast.error(err.error || `Failed to ${isCreating ? 'create' : 'update'} list`);
      }
    } catch (e) {
      toast.error('Failed to save audience list');
    } finally {
      setSavingListEdit(false);
    }
  };

  const handleDeleteList = async () => {
    if (!listToDelete) return;
    setDeletingList(true);
    try {
      const response = await fetch(`/api/audience-lists?id=${listToDelete.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (response.ok) {
        toast.success('Audience list deleted');
        setShowDeleteListConfirm(false);
        setListToDelete(null);
        queryClient.invalidateQueries({ queryKey: ['audience-lists'] });
      } else {
        const err = await response.json();
        toast.error(err.error || 'Failed to delete list');
      }
    } catch (e) {
      toast.error('Failed to delete audience list');
    } finally {
      setDeletingList(false);
    }
  };

  
  const handleSyncCategory = async (categoryId) => {
    setSyncingCategory(categoryId);
    setSyncProgress({ categoryId, processed: 0, total: 0, subscribed: 0, unsubscribed: 0, errors: 0 });
    
    try {
      const response = await fetch('/api/zoho-campaigns/sync-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ categoryId })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to start sync');
      }
      
      const result = await response.json();
      
      if (!result.success) {
        toast.error(result.error || 'Failed to start sync');
        setSyncingCategory(null);
        setSyncProgress(null);
        return;
      }
      
      setActiveJobId(result.jobId);
      if (!result.resumed) {
        setSyncProgress(prev => ({ ...prev, total: result.totalMembers }));
      }
      
      continueAndPollJob(result.jobId, categoryId);
      
    } catch (error) {
      toast.error(error.message || 'Failed to sync with Zoho Campaigns');
      setSyncingCategory(null);
      setSyncProgress(null);
    }
  };
  
  const continueAndPollJob = async (jobId, categoryId) => {
    try {
      const response = await fetch('/api/zoho-campaigns/sync-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'continue', jobId })
      });
      
      if (!response.ok) {
        throw new Error('Failed to continue job');
      }
      
      const job = await response.json();
      
      setSyncProgress({
        categoryId,
        processed: job.currentOffset,
        total: job.totalMembers,
        subscribed: job.subscribed,
        unsubscribed: job.unsubscribed,
        errors: job.errors,
        skipped: job.skipped,
        progress: job.progress
      });
      
      if (job.status === 'running' && job.hasMore) {
        setTimeout(() => continueAndPollJob(jobId, categoryId), 500);
      } else if (job.status === 'completed') {
        const skippedMsg = job.skipped > 0 ? `, ${job.skipped} skipped` : '';
        toast.success(`Sync complete: ${job.subscribed} subscribed, ${job.unsubscribed} unsubscribed${job.errors > 0 ? `, ${job.errors} errors` : ''}${skippedMsg}`);
        setSyncingCategory(null);
        setSyncProgress(null);
        setActiveJobId(null);
      } else if (job.status === 'failed') {
        toast.error(job.errorMessage || job.error || 'Sync failed');
        setSyncingCategory(null);
        setSyncProgress(null);
        setActiveJobId(null);
      }
    } catch (error) {
      toast.error('Lost connection to sync job');
      setSyncingCategory(null);
      setSyncProgress(null);
      setActiveJobId(null);
    }
  };

  const handleSyncAll = async () => {
    setSyncingAll(true);
    try {
      const response = await fetch('/api/zoho-campaigns/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({})
      });
      
      if (!response.ok) throw new Error('Sync failed');
      
      const result = await response.json();
      if (result.success) {
        const totalSubscribed = result.categories?.reduce((sum, c) => sum + (c.subscribed || 0), 0) || 0;
        const totalUnsubscribed = result.categories?.reduce((sum, c) => sum + (c.unsubscribed || 0), 0) || 0;
        toast.success(`Synced all lists: ${totalSubscribed} subscribers, ${totalUnsubscribed} unsubscribed`);
      } else {
        toast.error(result.error || 'Sync failed');
      }
    } catch (error) {
      toast.error('Failed to sync with Zoho Campaigns');
    } finally {
      setSyncingAll(false);
    }
  };

  const handleUpdateZohoListId = async (categoryId, zohoListId) => {
    try {
      await base44.entities.CommunicationCategory.update(categoryId, { 
        zoho_list_id: zohoListId || null 
      });
      queryClient.invalidateQueries({ queryKey: ['communication-categories'] });
      toast.success('Zoho list mapping updated');
    } catch (error) {
      toast.error('Failed to update Zoho list mapping');
    }
  };

  const [exportingCategory, setExportingCategory] = useState(null);
  const [showSubscribersDialog, setShowSubscribersDialog] = useState(false);
  const [viewingCategory, setViewingCategory] = useState(null);
  const [subscribersPage, setSubscribersPage] = useState(1);
  const SUBSCRIBERS_PER_PAGE = 10;

  const getSubscribersForCategory = (categoryId) => {
    const assignedRoleIds = getCategoryRoles(categoryId);
    if (assignedRoleIds.length === 0) return [];
    
    // Filter eligible members by role and exclude those who opted out of ALL communications
    const eligibleMembers = allMembers.filter(member => 
      assignedRoleIds.includes(member.role_id) && 
      member.communications_opted_out_all !== true
    );
    
    // Find members who have explicitly opted OUT of this specific category (is_subscribed === false)
    // All eligible members are considered subscribed by default
    const optedOutMemberIds = preferences
      .filter(p => p.category_id === categoryId && p.is_subscribed === false)
      .map(p => p.member_id);
    
    // Return eligible members who haven't opted out of this category
    return eligibleMembers.filter(member => !optedOutMemberIds.includes(member.id));
  };

  const getSubscriberCount = (categoryId) => {
    return getSubscribersForCategory(categoryId).length;
  };

  const getExternalSubscriberCount = (categoryId) => {
    return externalSubscriberCounts[categoryId] || 0;
  };

  const getTotalSubscriberCount = (categoryId) => {
    return getSubscriberCount(categoryId) + getExternalSubscriberCount(categoryId);
  };

  const [subscriberTab, setSubscriberTab] = useState('members');
  const [externalSubscribers, setExternalSubscribers] = useState([]);
  const [externalSubscribersTotal, setExternalSubscribersTotal] = useState(0);
  const [externalSubscribersPage, setExternalSubscribersPage] = useState(1);
  const [loadingExternalSubscribers, setLoadingExternalSubscribers] = useState(false);
  const [removingSubscriberId, setRemovingSubscriberId] = useState(null);

  const fetchExternalSubscribers = async (categoryId, page = 1) => {
    setLoadingExternalSubscribers(true);
    try {
      const response = await fetch(`/api/admin/external-subscribers?category_id=${categoryId}&page=${page}&per_page=${SUBSCRIBERS_PER_PAGE}`, {
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        setExternalSubscribers(data.subscribers || []);
        setExternalSubscribersTotal(data.total || 0);
        setExternalSubscribersPage(page);
      }
    } catch (error) {
      console.error('Error fetching external subscribers:', error);
    } finally {
      setLoadingExternalSubscribers(false);
    }
  };

  const handleRemoveExternalSubscriber = async (subscriberId) => {
    setRemovingSubscriberId(subscriberId);
    try {
      const response = await fetch('/api/admin/external-subscribers', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriber_id: subscriberId })
      });
      if (response.ok) {
        toast.success('External subscriber removed');
        setExternalSubscribers(prev => prev.filter(s => s.id !== subscriberId));
        setExternalSubscribersTotal(prev => prev - 1);
        queryClient.invalidateQueries({ queryKey: ['external-subscriber-counts'] });
      } else {
        toast.error('Failed to remove subscriber');
      }
    } catch (error) {
      toast.error('Failed to remove subscriber');
    } finally {
      setRemovingSubscriberId(null);
    }
  };

  const openSubscribersView = (category) => {
    setViewingCategory(category);
    setSubscribersPage(1);
    setSubscriberTab('members');
    setExternalSubscribers([]);
    setExternalSubscribersTotal(0);
    setShowSubscribersDialog(true);
  };

  const getPaginatedSubscribers = () => {
    if (!viewingCategory) return { subscribers: [], totalPages: 0, total: 0 };
    const allSubscribers = getSubscribersForCategory(viewingCategory.id);
    const total = allSubscribers.length;
    const totalPages = Math.ceil(total / SUBSCRIBERS_PER_PAGE);
    const start = (subscribersPage - 1) * SUBSCRIBERS_PER_PAGE;
    const subscribers = allSubscribers.slice(start, start + SUBSCRIBERS_PER_PAGE);
    return { subscribers, totalPages, total };
  };

  const handleExportSubscribers = async (category) => {
    setExportingCategory(category.id);
    try {
      const memberSubscribers = getSubscribersForCategory(category.id);
      
      let extSubs = [];
      try {
        const response = await fetch(`/api/admin/external-subscribers?category_id=${category.id}&page=1&per_page=10000`, {
          credentials: 'include'
        });
        if (response.ok) {
          const data = await response.json();
          extSubs = data.subscribers || [];
        }
      } catch (e) {
        console.error('Error fetching external subscribers for export:', e);
      }

      if (memberSubscribers.length === 0 && extSubs.length === 0) {
        toast.info('No subscribers to export for this category');
        setExportingCategory(null);
        return;
      }

      const headers = ['Name', 'Organisation', 'Role', 'Email', 'Type'];
      
      const memberRows = memberSubscribers.map(member => {
        const name = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'N/A';
        const org = (member.organization_id && orgLookup[member.organization_id]) || 'N/A';
        const role = (member.role_id && roleLookup[member.role_id]) || 'N/A';
        const email = member.email || 'N/A';
        
        return [name, org, role, email, 'Member'].map(val => {
          const escaped = String(val).replace(/"/g, '""');
          return `"${escaped}"`;
        }).join(',');
      });

      const externalRows = extSubs.map(sub => {
        const name = [sub.first_name, sub.last_name].filter(Boolean).join(' ') || 'N/A';
        const email = sub.email || 'N/A';
        
        return [name, 'N/A', 'N/A', email, 'External'].map(val => {
          const escaped = String(val).replace(/"/g, '""');
          return `"${escaped}"`;
        }).join(',');
      });

      const csvContent = [headers.join(','), ...memberRows, ...externalRows].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      const safeFileName = category.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const date = new Date().toISOString().split('T')[0];
      link.setAttribute('href', url);
      link.setAttribute('download', `${safeFileName}_subscribers_${date}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      const totalExported = memberSubscribers.length + extSubs.length;
      toast.success(`Exported ${totalExported} subscribers (${memberSubscribers.length} members, ${extSubs.length} external)`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export subscribers');
    } finally {
      setExportingCategory(null);
    }
  };

  const getCategoryRoles = (categoryId) => {
    return categoryRoles.filter(cr => cr.category_id === categoryId).map(cr => cr.role_id);
  };

  const createCategoryMutation = useMutation({
    mutationFn: async (data) => {
      const { selectedRoles = [], ...categoryData } = data;
      const category = await base44.entities.CommunicationCategory.create(categoryData);
      
      for (const roleId of selectedRoles) {
        await base44.entities.CommunicationCategoryRole.create({
          category_id: category.id,
          role_id: roleId
        });
      }
      return category;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communication-categories'] });
      queryClient.invalidateQueries({ queryKey: ['communication-category-roles'] });
      setShowCategoryDialog(false);
      setEditingCategory(null);
      toast.success('Category created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create category: ' + error.message);
    }
  });

  const updateCategoryMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      const { selectedRoles = [], ...categoryData } = data;
      await base44.entities.CommunicationCategory.update(id, categoryData);
      
      const existingRoles = categoryRoles.filter(cr => cr.category_id === id);
      for (const existing of existingRoles) {
        if (!selectedRoles.includes(existing.role_id)) {
          await base44.entities.CommunicationCategoryRole.delete(existing.id);
        }
      }
      
      const existingRoleIds = existingRoles.map(er => er.role_id);
      for (const roleId of selectedRoles) {
        if (!existingRoleIds.includes(roleId)) {
          await base44.entities.CommunicationCategoryRole.create({
            category_id: id,
            role_id: roleId
          });
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communication-categories'] });
      queryClient.invalidateQueries({ queryKey: ['communication-category-roles'] });
      setShowCategoryDialog(false);
      setEditingCategory(null);
      toast.success('Category updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update category: ' + error.message);
    }
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: async (id) => {
      const relatedRoles = categoryRoles.filter(cr => cr.category_id === id);
      for (const cr of relatedRoles) {
        await base44.entities.CommunicationCategoryRole.delete(cr.id);
      }
      await base44.entities.CommunicationCategory.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communication-categories'] });
      queryClient.invalidateQueries({ queryKey: ['communication-category-roles'] });
      setShowDeleteConfirm(false);
      setCategoryToDelete(null);
      toast.success('Category deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete category: ' + error.message);
    }
  });

  const handleSaveCategory = () => {
    if (!editingCategory.name?.trim()) {
      toast.error('Please enter a category name');
      return;
    }
    if (!editingCategory.is_public && (!editingCategory.selectedRoles || editingCategory.selectedRoles.length === 0)) {
      toast.error('Please select at least one role or mark the list as public');
      return;
    }

    if (editingCategory.id) {
      updateCategoryMutation.mutate({ id: editingCategory.id, data: editingCategory });
    } else {
      createCategoryMutation.mutate(editingCategory);
    }
  };

  const openNewCategoryDialog = () => {
    setEditingCategory({
      name: '',
      description: '',
      is_active: true,
      is_public: false,
      display_order: categories.length,
      selectedRoles: []
    });
    setShowCategoryDialog(true);
  };

  const openEditCategoryDialog = (category) => {
    setEditingCategory({
      ...category,
      selectedRoles: getCategoryRoles(category.id)
    });
    setShowCategoryDialog(true);
  };

  const toggleRoleSelection = (roleId) => {
    const currentRoles = editingCategory.selectedRoles || [];
    if (currentRoles.includes(roleId)) {
      setEditingCategory({
        ...editingCategory,
        selectedRoles: currentRoles.filter(id => id !== roleId)
      });
    } else {
      setEditingCategory({
        ...editingCategory,
        selectedRoles: [...currentRoles, roleId]
      });
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const tablesNotSetup = categoriesError?.message?.includes('does not exist') || 
                         categoriesError?.message?.includes('relation') ||
                         categoriesError?.message?.includes('42P01');

  if (tablesNotSetup) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Card className="border-amber-200 bg-amber-50">
            <CardHeader>
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-8 h-8 text-amber-600" />
                <div>
                  <CardTitle className="text-amber-900">Database Setup Required</CardTitle>
                  <CardDescription className="text-amber-700">
                    The communications tables need to be created in Supabase before using this feature.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-amber-800 mb-4">
                Please run the following SQL in your Supabase SQL Editor to create the required tables:
              </p>
              <pre className="bg-slate-900 text-green-400 p-4 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap">
{`-- Communication Categories
CREATE TABLE IF NOT EXISTS communication_category (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  is_public BOOLEAN DEFAULT false,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add is_public column if table already exists
ALTER TABLE communication_category ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false;

-- Role assignments for each category
CREATE TABLE IF NOT EXISTS communication_category_role (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES communication_category(id) ON DELETE CASCADE,
  role_id UUID REFERENCES role(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(category_id, role_id)
);

-- Member preferences for categories
CREATE TABLE IF NOT EXISTS member_communication_preference (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID REFERENCES member(id) ON DELETE CASCADE,
  category_id UUID REFERENCES communication_category(id) ON DELETE CASCADE,
  is_subscribed BOOLEAN DEFAULT true,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(member_id, category_id)
);

-- Enable RLS
ALTER TABLE communication_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_category_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_communication_preference ENABLE ROW LEVEL SECURITY;

-- Policies for service role access
CREATE POLICY "Service role has full access to communication_category" 
  ON communication_category FOR ALL 
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to communication_category_role" 
  ON communication_category_role FOR ALL 
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to member_communication_preference" 
  ON member_communication_preference FOR ALL 
  USING (true) WITH CHECK (true);`}
              </pre>
              <Button 
                onClick={() => window.location.reload()} 
                className="mt-4 bg-amber-600 hover:bg-amber-700"
                data-testid="button-refresh-after-setup"
              >
                Refresh After Setup
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <Card className="shadow-lg border-0">
          <CardHeader className="border-b border-slate-200 bg-white rounded-t-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Mail className="w-6 h-6 text-blue-600" />
                </div>
                <div>
                  <CardTitle className="text-xl">Communications Management</CardTitle>
                  <CardDescription>
                    Manage marketing communication categories and role-based subscriptions
                  </CardDescription>
                </div>
              </div>
              <Button 
                onClick={openNewCategoryDialog}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-add-category"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Category
              </Button>
            </div>
          </CardHeader>

          <CardContent className="p-6">
            <Tabs defaultValue="campaigns" className="w-full">
              <TabsList className="mb-6">
                <TabsTrigger value="campaigns" data-testid="tab-campaigns">
                  <Send className="w-4 h-4 mr-2" />
                  Email Campaigns
                </TabsTrigger>
                <TabsTrigger value="lists" data-testid="tab-lists">
                  <ListFilter className="w-4 h-4 mr-2" />
                  Lists
                </TabsTrigger>
                <TabsTrigger value="categories" data-testid="tab-categories">
                  <Mail className="w-4 h-4 mr-2" />
                  Subscription Categories
                </TabsTrigger>
              </TabsList>

              <TabsContent value="campaigns">
                <EmailCampaigns />
              </TabsContent>

              <TabsContent value="lists">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900" data-testid="text-lists-heading">Audience Lists</h3>
                    <p className="text-sm text-slate-500">Create and manage reusable audience lists for your email campaigns.</p>
                  </div>
                  <Button
                    onClick={openNewListDialog}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-create-list"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Create List
                  </Button>
                </div>

                {audienceLists.length === 0 ? (
                  <div className="text-center py-12">
                    <ListFilter className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-slate-900 mb-2" data-testid="text-no-lists">No Audience Lists</h3>
                    <p className="text-slate-600 mb-4">
                      Create audience lists to define reusable recipient groups for your email campaigns.
                    </p>
                    <Button
                      onClick={openNewListDialog}
                      className="bg-blue-600 hover:bg-blue-700"
                      data-testid="button-create-first-list"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Create First List
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {audienceLists.map(list => (
                      <Card
                        key={list.id}
                        className="border border-slate-200"
                        data-testid={`card-list-${list.id}`}
                      >
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <h4 className="text-base font-semibold text-slate-900" data-testid={`text-list-name-${list.id}`}>
                                {list.name}
                              </h4>
                              <div className="flex flex-wrap gap-1 mt-2" data-testid={`text-list-rules-${list.id}`}>
                                {(list.target_audiences || []).length === 0 ? (
                                  <span className="text-sm text-slate-400 italic">No audience rules defined</span>
                                ) : (
                                  (list.target_audiences || []).map((segment, idx) => (
                                    <Badge key={idx} variant="outline" className="text-xs">
                                      {getSegmentSummary(segment)}
                                    </Badge>
                                  ))
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openEditListDialog(list)}
                                data-testid={`button-edit-list-${list.id}`}
                              >
                                <Pencil className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-red-600"
                                onClick={() => { setListToDelete(list); setShowDeleteListConfirm(true); }}
                                data-testid={`button-delete-list-${list.id}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="categories">
            {/* Zoho Campaigns Integration Status */}
            <div className="mb-6 p-4 border border-slate-200 rounded-lg bg-slate-50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${isZohoConnected ? 'bg-green-100' : 'bg-amber-100'}`}>
                    {isZohoConnected ? (
                      <Link2 className="w-5 h-5 text-green-600" />
                    ) : (
                      <Unlink className="w-5 h-5 text-amber-600" />
                    )}
                  </div>
                  <div>
                    <h4 className="font-medium text-slate-900">Zoho Campaigns</h4>
                    <p className="text-sm text-slate-500">
                      {zohoStatusLoading ? 'Checking connection...' : 
                       isZohoConnected ? 'Connected - sync your lists to Zoho Campaigns' : 
                       !isZohoCredentialsConfigured ? 'Configure and connect in Admin Integrations' :
                       'Connect your Zoho account in Admin Integrations'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isZohoConnected && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleSyncAll}
                      disabled={syncingAll || categories.filter(c => c.zoho_list_id).length === 0}
                      data-testid="button-sync-all-zoho"
                    >
                      {syncingAll ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4 mr-2" />
                      )}
                      Sync All Lists
                    </Button>
                  )}
                  {!isZohoConnected && !zohoStatusLoading && (
                    <Button
                      variant="outline"
                      onClick={() => window.location.href = '/admin/integrations'}
                      data-testid="button-configure-zoho"
                    >
                      {isZohoCredentialsConfigured ? 'Connect in Integrations' : 'Configure in Integrations'}
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {categoriesLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-pulse text-slate-600">Loading categories...</div>
              </div>
            ) : categories.length === 0 ? (
              <div className="text-center py-12">
                <Mail className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-slate-900 mb-2">No Communication Categories</h3>
                <p className="text-slate-600 mb-4">
                  Create categories like "Newsletter", "Events", "Offers" etc. to manage member subscriptions.
                </p>
                <Button 
                  onClick={openNewCategoryDialog}
                  className="bg-blue-600 hover:bg-blue-700"
                  data-testid="button-add-first-category"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Create First Category
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {categories.map((category) => {
                  const assignedRoles = getCategoryRoles(category.id);
                  const subscriberCount = getSubscriberCount(category.id);
                  const externalCount = getExternalSubscriberCount(category.id);
                  const totalCount = subscriberCount + externalCount;
                  
                  return (
                    <Card 
                      key={category.id} 
                      className={`border ${category.is_active ? 'border-slate-200' : 'border-slate-200 bg-slate-50'}`}
                      data-testid={`card-category-${category.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div
                              className="flex items-center gap-3 cursor-pointer select-none"
                              onClick={() => toggleCategory(category.id)}
                              data-testid={`button-toggle-category-${category.id}`}
                            >
                              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${expandedCategories[category.id] ? 'rotate-0' : '-rotate-90'}`} />
                              <h3 className="text-lg font-semibold text-slate-900">
                                {category.name}
                              </h3>
                              {category.is_public && (
                                <Badge variant="outline" className="text-xs border-pink-200 text-pink-700 bg-pink-50">
                                  Public
                                </Badge>
                              )}
                              {!category.is_active && (
                                <Badge variant="secondary" className="text-xs">
                                  Inactive
                                </Badge>
                              )}
                              <span className="text-sm text-muted-foreground">
                                {totalCount} subscriber{totalCount !== 1 ? 's' : ''}
                              </span>
                            </div>

                          {expandedCategories[category.id] && (
                            <>
                            {category.description && (
                              <p className="text-sm text-slate-600 mt-2 mb-3">
                                {category.description}
                              </p>
                            )}
                            
                            <div className="flex flex-wrap items-center gap-4">
                              <div className="flex items-center gap-2">
                                <Shield className="w-4 h-4 text-slate-400" />
                                <span className="text-sm text-slate-600">Roles:</span>
                                <div className="flex flex-wrap gap-1">
                                  {assignedRoles.length === 0 ? (
                                    <span className="text-sm text-slate-400 italic">None assigned</span>
                                  ) : (
                                    assignedRoles.map(roleId => {
                                      const role = roles.find(r => r.id === roleId);
                                      return role ? (
                                        <Badge 
                                          key={roleId} 
                                          variant="outline" 
                                          className="text-xs"
                                        >
                                          {role.name}
                                        </Badge>
                                      ) : null;
                                    })
                                  )}
                                </div>
                              </div>
                              
                              <div className="flex items-center gap-2">
                                <Users className="w-4 h-4 text-slate-400" />
                                <button
                                  className="text-sm text-slate-600 hover:text-blue-600 hover:underline cursor-pointer bg-transparent border-0 p-0"
                                  onClick={() => openSubscribersView(category)}
                                  disabled={membersLoading}
                                  title={membersLoading ? 'Loading members...' : 'View subscribers'}
                                  data-testid={`button-view-subscribers-${category.id}`}
                                >
                                  <span className="font-medium text-slate-900 hover:text-blue-600">{totalCount}</span> subscribers
                                  {externalCount > 0 && (
                                    <span className="text-xs text-slate-400 ml-1">({subscriberCount} members, {externalCount} external)</span>
                                  )}
                                </button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                  onClick={() => handleExportSubscribers(category)}
                                  disabled={exportingCategory === category.id || totalCount === 0 || membersLoading}
                                  title={membersLoading ? 'Loading members...' : totalCount === 0 ? 'No subscribers to export' : 'Export subscribers to CSV'}
                                  data-testid={`button-export-category-${category.id}`}
                                >
                                  {exportingCategory === category.id || membersLoading ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Download className="w-4 h-4" />
                                  )}
                                </Button>
                              </div>
                            </div>
                            
                            {/* Zoho List Mapping */}
                            {isZohoConnected && (
                              <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-slate-100">
                                <div className="flex items-center gap-2">
                                  <Link2 className="w-4 h-4 text-orange-500" />
                                  <span className="text-sm text-slate-600">Zoho List:</span>
                                  <Select
                                    value={category.zoho_list_id || "none"}
                                    onValueChange={(value) => handleUpdateZohoListId(category.id, value === "none" ? null : value)}
                                  >
                                    <SelectTrigger className="w-[200px] h-8" data-testid={`select-zoho-list-${category.id}`}>
                                      <SelectValue placeholder="Select list..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="none">Not mapped</SelectItem>
                                      {zohoLists.map(list => (
                                        <SelectItem key={list.listkey} value={list.listkey}>
                                          {list.listname}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                
                                {category.zoho_list_id && (
                                  <>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => handleSyncCategory(category.id)}
                                      disabled={syncingCategory === category.id}
                                      data-testid={`button-sync-category-${category.id}`}
                                    >
                                      {syncingCategory === category.id ? (
                                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                                      ) : (
                                        <RefreshCw className="w-4 h-4 mr-1" />
                                      )}
                                      Sync
                                    </Button>
                                    
                                    {syncProgress && syncProgress.categoryId === category.id && (
                                      <div className="flex flex-col gap-1 ml-2" data-testid={`sync-progress-${category.id}`}>
                                        <div className="flex items-center gap-2">
                                          <div className="w-32 h-2 bg-slate-200 rounded-full overflow-hidden" data-testid={`sync-progress-bar-${category.id}`}>
                                            <div 
                                              className="h-full bg-blue-500 transition-all duration-300"
                                              style={{ width: `${syncProgress.total > 0 ? (syncProgress.processed / syncProgress.total) * 100 : 0}%` }}
                                            />
                                          </div>
                                          <span className="text-xs text-slate-600 whitespace-nowrap" data-testid={`sync-progress-count-${category.id}`}>
                                            {syncProgress.processed} / {syncProgress.total}
                                          </span>
                                        </div>
                                        <span className="text-xs text-amber-600" data-testid={`sync-progress-warning-${category.id}`}>
                                          Please stay on this page until sync completes
                                        </span>
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )}

                            </>
                          )}
                          </div>
                          
                          <div className="flex items-center gap-2 ml-4">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditCategoryDialog(category)}
                              data-testid={`button-edit-category-${category.id}`}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              onClick={() => {
                                setCategoryToDelete(category);
                                setShowDeleteConfirm(true);
                              }}
                              data-testid={`button-delete-category-${category.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Dialog open={showCategoryDialog} onOpenChange={setShowCategoryDialog}>
          <DialogContent className="max-w-lg" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>
                {editingCategory?.id ? 'Edit Category' : 'Create Category'}
              </DialogTitle>
            </DialogHeader>
            
            {editingCategory && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Category Name *</Label>
                  <Input
                    id="name"
                    value={editingCategory.name || ''}
                    onChange={(e) => setEditingCategory({ ...editingCategory, name: e.target.value })}
                    placeholder="e.g., Newsletter, Events, Special Offers"
                    data-testid="input-category-name"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={editingCategory.description || ''}
                    onChange={(e) => setEditingCategory({ ...editingCategory, description: e.target.value })}
                    placeholder="Describe what communications this category includes"
                    rows={2}
                    data-testid="input-category-description"
                  />
                </div>
                
                <div className="flex items-center justify-between gap-4 p-3 border border-slate-200 rounded-lg">
                  <div className="space-y-1">
                    <Label htmlFor="is_public" className="cursor-pointer">
                      Public List
                    </Label>
                    <p className="text-xs text-slate-500">
                      Allow non-members (e.g. donors, guests) to be added to this list
                    </p>
                  </div>
                  <Switch
                    id="is_public"
                    checked={editingCategory.is_public || false}
                    onCheckedChange={(checked) => setEditingCategory({ ...editingCategory, is_public: checked })}
                    data-testid="switch-category-public"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Applicable Roles {!editingCategory.is_public && '*'}</Label>
                  <p className="text-xs text-slate-500 mb-2">
                    Select which member roles can subscribe to this category
                  </p>
                  <div className="border border-slate-200 rounded-lg p-3 max-h-48 overflow-y-auto space-y-2">
                    {roles.filter(r => r.is_active !== false).map(role => (
                      <div 
                        key={role.id} 
                        className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded"
                      >
                        <Checkbox
                          id={`role-${role.id}`}
                          checked={editingCategory.selectedRoles?.includes(role.id)}
                          onCheckedChange={() => toggleRoleSelection(role.id)}
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
                
                <div className="flex items-center gap-3">
                  <Switch
                    id="is_active"
                    checked={editingCategory.is_active}
                    onCheckedChange={(checked) => setEditingCategory({ ...editingCategory, is_active: checked })}
                    data-testid="switch-category-active"
                  />
                  <Label htmlFor="is_active" className="cursor-pointer">
                    Active
                  </Label>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="display_order">Display Order</Label>
                  <Input
                    id="display_order"
                    type="number"
                    value={editingCategory.display_order ?? 0}
                    onChange={(e) => setEditingCategory({ ...editingCategory, display_order: parseInt(e.target.value) || 0 })}
                    data-testid="input-category-order"
                  />
                </div>
              </div>
            )}
            
            <DialogFooter>
              <Button 
                variant="outline" 
                onClick={() => setShowCategoryDialog(false)}
                data-testid="button-cancel-category"
              >
                Cancel
              </Button>
              <Button 
                onClick={handleSaveCategory}
                disabled={createCategoryMutation.isPending || updateCategoryMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-save-category"
              >
                {editingCategory?.id ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent aria-describedby="delete-category-description">
            <DialogHeader>
              <DialogTitle>Delete Category</DialogTitle>
              <DialogDescription id="delete-category-description">
                Are you sure you want to delete "{categoryToDelete?.name}"? This will also remove all member preferences for this category.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button 
                variant="outline" 
                onClick={() => setShowDeleteConfirm(false)}
                data-testid="button-cancel-delete"
              >
                Cancel
              </Button>
              <Button 
                variant="destructive"
                onClick={() => deleteCategoryMutation.mutate(categoryToDelete?.id)}
                disabled={deleteCategoryMutation.isPending}
                data-testid="button-confirm-delete"
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showSubscribersDialog} onOpenChange={setShowSubscribersDialog}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col" aria-describedby="subscribers-dialog-description">
            <DialogHeader className="flex-shrink-0">
              <div className="flex items-center justify-between">
                <div>
                  <DialogTitle className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-blue-600" />
                    {viewingCategory?.name} Subscribers
                  </DialogTitle>
                  <DialogDescription id="subscribers-dialog-description" className="mt-1">
                    {(() => {
                      const memberCount = viewingCategory ? getSubscriberCount(viewingCategory.id) : 0;
                      const extCount = viewingCategory ? getExternalSubscriberCount(viewingCategory.id) : 0;
                      const total = memberCount + extCount;
                      if (extCount > 0) {
                        return `${total} total subscribers (${memberCount} members, ${extCount} external)`;
                      }
                      return `${memberCount} member${memberCount !== 1 ? 's' : ''} subscribed to this category`;
                    })()}
                  </DialogDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => viewingCategory && handleExportSubscribers(viewingCategory)}
                  disabled={exportingCategory === viewingCategory?.id || membersLoading}
                  className="flex items-center gap-2"
                  data-testid="button-export-from-dialog"
                >
                  {exportingCategory === viewingCategory?.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  Export CSV
                </Button>
              </div>
            </DialogHeader>
            
            <div className="flex-1 overflow-auto mt-4">
              <Tabs value={subscriberTab} onValueChange={(val) => {
                setSubscriberTab(val);
                if (val === 'external' && viewingCategory) {
                  fetchExternalSubscribers(viewingCategory.id, 1);
                }
              }}>
                <TabsList className="mb-4" data-testid="tabs-subscriber-type">
                  <TabsTrigger value="members" data-testid="tab-members">
                    <Users className="w-4 h-4 mr-1" />
                    Members ({viewingCategory ? getSubscriberCount(viewingCategory.id) : 0})
                  </TabsTrigger>
                  <TabsTrigger value="external" data-testid="tab-external">
                    <Globe className="w-4 h-4 mr-1" />
                    External ({viewingCategory ? getExternalSubscriberCount(viewingCategory.id) : 0})
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="members">
                  {membersLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-600 mr-2" />
                      <span className="text-slate-600">Loading members...</span>
                    </div>
                  ) : (
                    <>
                      {(() => {
                        const { subscribers, totalPages, total } = getPaginatedSubscribers();
                        
                        if (total === 0) {
                          return (
                            <div className="text-center py-12">
                              <Users className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                              <p className="text-slate-600">No member subscribers for this category</p>
                            </div>
                          );
                        }
                        
                        return (
                          <>
                            <p className="text-xs text-slate-500 mb-3">Click on a member to edit their details</p>
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Name</TableHead>
                                  <TableHead>Organisation</TableHead>
                                  <TableHead>Role</TableHead>
                                  <TableHead>Email</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {subscribers.map((member) => (
                                  <TableRow 
                                    key={member.id} 
                                    data-testid={`row-subscriber-${member.id}`}
                                    className="cursor-pointer hover:bg-blue-50 transition-colors"
                                    onClick={() => {
                                      setShowSubscribersDialog(false);
                                      navigate(`/members/${member.id}`);
                                    }}
                                  >
                                    <TableCell className="font-medium text-blue-600 hover:text-blue-700">
                                      {[member.first_name, member.last_name].filter(Boolean).join(' ') || 'N/A'}
                                    </TableCell>
                                    <TableCell>{(member.organization_id && orgLookup[member.organization_id]) || 'N/A'}</TableCell>
                                    <TableCell>{(member.role_id && roleLookup[member.role_id]) || 'N/A'}</TableCell>
                                    <TableCell className="text-slate-600">{member.email || 'N/A'}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                            
                            {totalPages > 1 && (
                              <div className="flex items-center justify-between mt-4 pt-4 border-t">
                                <div className="text-sm text-slate-600">
                                  Showing {((subscribersPage - 1) * SUBSCRIBERS_PER_PAGE) + 1} - {Math.min(subscribersPage * SUBSCRIBERS_PER_PAGE, total)} of {total}
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setSubscribersPage(p => Math.max(1, p - 1))}
                                    disabled={subscribersPage === 1}
                                    data-testid="button-prev-page"
                                  >
                                    <ChevronLeft className="w-4 h-4" />
                                    Previous
                                  </Button>
                                  <span className="text-sm text-slate-600 px-2">
                                    Page {subscribersPage} of {totalPages}
                                  </span>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setSubscribersPage(p => Math.min(totalPages, p + 1))}
                                    disabled={subscribersPage === totalPages}
                                    data-testid="button-next-page"
                                  >
                                    Next
                                    <ChevronRight className="w-4 h-4" />
                                  </Button>
                                </div>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </>
                  )}
                </TabsContent>

                <TabsContent value="external">
                  {loadingExternalSubscribers ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-600 mr-2" />
                      <span className="text-slate-600">Loading external subscribers...</span>
                    </div>
                  ) : externalSubscribersTotal === 0 ? (
                    <div className="text-center py-12">
                      <Globe className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-slate-600">No external subscribers for this category</p>
                      <p className="text-xs text-slate-400 mt-1">External subscribers are non-members who subscribed via public forms, event donations, or direct signup</p>
                    </div>
                  ) : (
                    <>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Email</TableHead>
                            <TableHead>Subscribed</TableHead>
                            <TableHead className="w-[80px]"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {externalSubscribers.map((sub) => (
                            <TableRow key={sub.id} data-testid={`row-external-subscriber-${sub.id}`}>
                              <TableCell className="font-medium">
                                {[sub.first_name, sub.last_name].filter(Boolean).join(' ') || 'N/A'}
                              </TableCell>
                              <TableCell className="text-slate-600">{sub.email}</TableCell>
                              <TableCell className="text-slate-500 text-sm">
                                {sub.subscribed_at ? new Date(sub.subscribed_at).toLocaleDateString() : 'N/A'}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleRemoveExternalSubscriber(sub.id)}
                                  disabled={removingSubscriberId === sub.id}
                                  title="Remove subscriber"
                                  data-testid={`button-remove-external-${sub.id}`}
                                >
                                  {removingSubscriberId === sub.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-4 h-4 text-red-500" />
                                  )}
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>

                      {(() => {
                        const extTotalPages = Math.ceil(externalSubscribersTotal / SUBSCRIBERS_PER_PAGE);
                        if (extTotalPages <= 1) return null;
                        return (
                          <div className="flex items-center justify-between mt-4 pt-4 border-t">
                            <div className="text-sm text-slate-600">
                              Showing {((externalSubscribersPage - 1) * SUBSCRIBERS_PER_PAGE) + 1} - {Math.min(externalSubscribersPage * SUBSCRIBERS_PER_PAGE, externalSubscribersTotal)} of {externalSubscribersTotal}
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => viewingCategory && fetchExternalSubscribers(viewingCategory.id, externalSubscribersPage - 1)}
                                disabled={externalSubscribersPage === 1}
                                data-testid="button-ext-prev-page"
                              >
                                <ChevronLeft className="w-4 h-4" />
                                Previous
                              </Button>
                              <span className="text-sm text-slate-600 px-2">
                                Page {externalSubscribersPage} of {extTotalPages}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => viewingCategory && fetchExternalSubscribers(viewingCategory.id, externalSubscribersPage + 1)}
                                disabled={externalSubscribersPage === extTotalPages}
                                data-testid="button-ext-next-page"
                              >
                                Next
                                <ChevronRight className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={showDeleteListConfirm} onOpenChange={setShowDeleteListConfirm}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete Saved List</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete "{listToDelete?.name}"? This cannot be undone. Any campaigns using this list will no longer resolve its recipients.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDeleteListConfirm(false)} data-testid="button-cancel-delete-list">
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteList}
                disabled={deletingList}
                data-testid="button-confirm-delete-list"
              >
                {deletingList ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Trash2 className="w-4 h-4 mr-1" />}
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showEditListDialog} onOpenChange={setShowEditListDialog}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editingList ? 'Edit List' : 'Create List'}</DialogTitle>
              <DialogDescription>
                {editingList ? 'Update the name or audience segments for this list.' : 'Define a reusable audience list for your email campaigns.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>List Name</Label>
                <Input
                  value={editListName}
                  onChange={(e) => setEditListName(e.target.value)}
                  placeholder="e.g. AGM Attendees, Newsletter Audience"
                  data-testid="input-edit-list-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Audience Segments</Label>
                {editListAudiences.length > 0 && (
                  <div className="space-y-1">
                    {editListAudiences.map((segment, idx) => (
                      <div key={idx} className="flex items-center gap-2 border rounded-md p-2" data-testid={`edit-list-segment-${idx}`}>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm">{getSegmentSummary(segment)}</span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setEditListAudiences(prev => prev.filter((_, i) => i !== idx))}
                          data-testid={`button-remove-edit-segment-${idx}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {!showAddListSegment ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setAddListSegmentType('');
                      setAddListSegmentIds([]);
                      setShowAddListSegment(true);
                    }}
                    className="w-full"
                    data-testid="button-add-list-segment"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add Segment
                  </Button>
                ) : (
                  <div className="border rounded-md p-3 space-y-3 bg-muted/20">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-sm font-medium">Add Segment</Label>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowAddListSegment(false)}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    <Select value={addListSegmentType} onValueChange={(v) => { setAddListSegmentType(v); setAddListSegmentIds([]); }}>
                      <SelectTrigger data-testid="select-add-list-segment-type">
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        {!editListAudiences.some(a => a.type === 'all_members') && (
                          <SelectItem value="all_members">All Members</SelectItem>
                        )}
                        <SelectItem value="communication_category">Categories</SelectItem>
                        <SelectItem value="member_group">Groups</SelectItem>
                        <SelectItem value="role">Roles</SelectItem>
                        {formsWithCategory.length > 0 && (
                          <SelectItem value="form">Form Subscribers</SelectItem>
                        )}
                        {!editListAudiences.some(a => a.type === 'fundraisers') && (
                          <SelectItem value="fundraisers">Fundraisers</SelectItem>
                        )}
                        {!editListAudiences.some(a => a.type === 'donors') && (
                          <SelectItem value="donors">Donors</SelectItem>
                        )}
                      </SelectContent>
                    </Select>

                    {addListSegmentType && addListSegmentType !== 'all_members' && (
                      <div className="border rounded-md p-2 max-h-32 overflow-y-auto space-y-1 bg-background">
                        {addListSegmentType === 'communication_category' && categories.filter(c => c.is_active !== false).map(cat => (
                          <label key={cat.id} className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={addListSegmentIds.includes(cat.id)}
                              onChange={(e) => {
                                if (e.target.checked) setAddListSegmentIds(prev => [...prev, cat.id]);
                                else setAddListSegmentIds(prev => prev.filter(i => i !== cat.id));
                              }} className="rounded" />
                            <span className="text-sm">{cat.name}</span>
                          </label>
                        ))}
                        {addListSegmentType === 'member_group' && memberGroups.map(group => (
                          <label key={group.id} className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={addListSegmentIds.includes(group.id)}
                              onChange={(e) => {
                                if (e.target.checked) setAddListSegmentIds(prev => [...prev, group.id]);
                                else setAddListSegmentIds(prev => prev.filter(i => i !== group.id));
                              }} className="rounded" />
                            <span className="text-sm">{group.name}</span>
                          </label>
                        ))}
                        {addListSegmentType === 'role' && roles.map(role => (
                          <label key={role.id} className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={addListSegmentIds.includes(role.id)}
                              onChange={(e) => {
                                if (e.target.checked) setAddListSegmentIds(prev => [...prev, role.id]);
                                else setAddListSegmentIds(prev => prev.filter(i => i !== role.id));
                              }} className="rounded" />
                            <span className="text-sm">{role.name}</span>
                          </label>
                        ))}
                        {addListSegmentType === 'form' && formsWithCategory.map(form => {
                          const linkedCategory = categories.find(c => c.id === form.communication_category_id);
                          return (
                            <label key={form.id} className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={addListSegmentIds.includes(form.id)}
                                onChange={(e) => {
                                  if (e.target.checked) setAddListSegmentIds(prev => [...prev, form.id]);
                                  else setAddListSegmentIds(prev => prev.filter(i => i !== form.id));
                                }} className="rounded" />
                              <span className="text-sm">{form.name}</span>
                              {linkedCategory && <span className="text-xs text-muted-foreground ml-1">({linkedCategory.name})</span>}
                            </label>
                          );
                        })}
                        {(addListSegmentType === 'fundraisers' || addListSegmentType === 'donors') && (
                          fundraisingCampaigns.length === 0 ? (
                            <div className="text-sm text-muted-foreground py-2">No fundraising campaigns found.</div>
                          ) : (
                            <>
                              <label className="flex items-center gap-2 cursor-pointer font-medium border-b pb-1 mb-1">
                                <input type="checkbox"
                                  checked={addListSegmentIds.includes('all')}
                                  onChange={(e) => {
                                    if (e.target.checked) setAddListSegmentIds(['all']);
                                    else setAddListSegmentIds([]);
                                  }} className="rounded" />
                                <span className="text-sm">{addListSegmentType === 'fundraisers' ? 'All fundraisers' : 'All donors'}</span>
                              </label>
                              {fundraisingCampaigns.map(fc => (
                                <label key={fc.id} className="flex items-center gap-2 cursor-pointer">
                                  <input type="checkbox"
                                    checked={addListSegmentIds.includes('all') || addListSegmentIds.includes(fc.id)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setAddListSegmentIds(prev => {
                                          const newIds = prev.filter(i => i !== 'all');
                                          newIds.push(fc.id);
                                          if (newIds.length === fundraisingCampaigns.length) return ['all'];
                                          return newIds;
                                        });
                                      } else {
                                        setAddListSegmentIds(prev => {
                                          let curr = prev.includes('all') ? fundraisingCampaigns.map(c => c.id) : [...prev];
                                          return curr.filter(i => i !== fc.id);
                                        });
                                      }
                                    }} className="rounded" />
                                  <span className="text-sm">{fc.name}</span>
                                </label>
                              ))}
                            </>
                          )
                        )}
                      </div>
                    )}

                    {addListSegmentType && (
                      <Button
                        size="sm"
                        onClick={() => {
                          if (addListSegmentType === 'all_members') {
                            setEditListAudiences(prev => [...prev, { type: 'all_members', ids: [] }]);
                          } else if (addListSegmentIds.length > 0) {
                            const existingIdx = editListAudiences.findIndex(a => a.type === addListSegmentType);
                            if (existingIdx >= 0) {
                              setEditListAudiences(prev => {
                                const updated = [...prev];
                                const existing = new Set(updated[existingIdx].ids || []);
                                addListSegmentIds.forEach(id => existing.add(id));
                                updated[existingIdx] = { ...updated[existingIdx], ids: [...existing] };
                                return updated;
                              });
                            } else {
                              setEditListAudiences(prev => [...prev, { type: addListSegmentType, ids: addListSegmentIds }]);
                            }
                          }
                          setShowAddListSegment(false);
                          setAddListSegmentType('');
                          setAddListSegmentIds([]);
                        }}
                        disabled={addListSegmentType !== 'all_members' && addListSegmentIds.length === 0}
                        data-testid="button-confirm-add-list-segment"
                      >
                        <Check className="w-4 h-4 mr-1" />
                        Add
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowEditListDialog(false)} data-testid="button-cancel-edit-list">
                Cancel
              </Button>
              <Button
                onClick={handleSaveListEdit}
                disabled={savingListEdit || !editListName.trim() || editListAudiences.length === 0}
                data-testid="button-save-edit-list"
              >
                {savingListEdit ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                {editingList ? 'Save Changes' : 'Create List'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
