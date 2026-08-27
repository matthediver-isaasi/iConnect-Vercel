import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
import { Mail, Plus, Pencil, Trash2, Users, Shield, AlertTriangle, Download, Loader2, ChevronLeft, ChevronRight, ChevronDown, X, RefreshCw, Link2, Unlink, Send, Globe, ListFilter, Check, Save, Search, UserX, Eye } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useNavigate, useSearchParams } from "react-router-dom";
import EmailCampaigns from "@/components/EmailCampaigns";
import { listAllOrganizationsForAdmin } from '@/lib/adminOrgList';
import { parseExternalContacts } from "@/lib/externalContactsCsv";
import {
  beginExternalSubscriberRequest,
  createLatestRequestTracker,
  fetchAllExternalSubscribers,
  filterMemberSubscribers,
  getPageAfterRemoval,
  getSubscriberEmptyState,
  normalizeSubscriberSearch,
  paginateSubscriberResults,
} from "@/lib/subscriberModalSearch";
import { filterExplicitCategorySubscribers } from "@shared/communicationCategoryMembership.js";

const SUBSCRIBERS_PER_PAGE = 10;
const EXTERNAL_SEARCH_DEBOUNCE_MS = 300;

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
  const [editListIgnoreOptOuts, setEditListIgnoreOptOuts] = useState(false);
  const [savingListEdit, setSavingListEdit] = useState(false);
  const [showDeleteListConfirm, setShowDeleteListConfirm] = useState(false);
  const [listToDelete, setListToDelete] = useState(null);
  const [deletingList, setDeletingList] = useState(false);
  const [showAddListSegment, setShowAddListSegment] = useState(false);
  const [addListSegmentType, setAddListSegmentType] = useState('');
  const [addListSegmentIds, setAddListSegmentIds] = useState([]);
  const [addListSegmentRoles, setAddListSegmentRoles] = useState([]);
  const [indMemberSearchInput, setIndMemberSearchInput] = useState('');
  const [indMemberSearchResults, setIndMemberSearchResults] = useState([]);
  const [indMemberSearchLoading, setIndMemberSearchLoading] = useState(false);
  const [indSelectedMembers, setIndSelectedMembers] = useState([]);
  const [eventSearchInput, setEventSearchInput] = useState('');
  const [selectedEvents, setSelectedEvents] = useState([]);
  const [eventTicketTypesCache, setEventTicketTypesCache] = useState({});
  const [eventTicketTypesLoading, setEventTicketTypesLoading] = useState({});
  const [eventTicketTypeSelections, setEventTicketTypeSelections] = useState({});
  const [eventAttendanceSelections, setEventAttendanceSelections] = useState({});
  const [eventFormSearchInput, setEventFormSearchInput] = useState('');
  const [selectedEventForm, setSelectedEventForm] = useState(null);
  const [addListEventFormReceived, setAddListEventFormReceived] = useState(true);
  const [fieldFilterGroups, setFieldFilterGroups] = useState([{ conditions: [{ entity_scope: 'member', field_key: '', field_type: '', data_type: '', operator: '', value: '', field_label: '' }] }]);
  const [eventFilterSearches, setEventFilterSearches] = useState({});

  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewListName, setPreviewListName] = useState('');
  const [previewRecipients, setPreviewRecipients] = useState([]);
  const [previewTotalCount, setPreviewTotalCount] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
  const previewPageSize = 20;
  const [externalContactsList, setExternalContactsList] = useState(null);
  const [externalContacts, setExternalContacts] = useState([]);
  const [externalContactsLoading, setExternalContactsLoading] = useState(false);
  const [externalContactForm, setExternalContactForm] = useState({ first_name: '', last_name: '', email: '' });
  const [individualGdprAcknowledged, setIndividualGdprAcknowledged] = useState(false);
  const [bulkGdprAcknowledged, setBulkGdprAcknowledged] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkSource, setBulkSource] = useState('pasted_rows');
  const [bulkOutcomes, setBulkOutcomes] = useState([]);
  const [contactsSubmitting, setContactsSubmitting] = useState(false);

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
    queryFn: () => listAllOrganizationsForAdmin(),
    staleTime: 60000,
  });

  const { data: filterableFields = null } = useQuery({
    queryKey: ['filterable-fields'],
    queryFn: async () => {
      const res = await fetch('/api/audience-lists/filterable-fields', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch filterable fields');
      return res.json();
    },
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
    queryFn: () => base44.entities.MemberCommunicationPreference.listAll({
      sort: { id: 'asc' },
    }),
    staleTime: 0,
    retry: 1,
  });

  const { data: allMembers = [], isLoading: membersLoading } = useQuery({
    queryKey: ['all-members-for-export'],
    queryFn: () => base44.entities.Member.listAll({
      sort: { id: 'asc' },
    }),
    staleTime: 60000,
  });

  const {
    data: externalSubscriberCounts = {},
    error: externalSubscriberCountsError,
  } = useQuery({
    queryKey: ['external-subscriber-counts'],
    queryFn: async () => {
      const response = await fetch('/api/admin/external-subscribers', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch external subscriber counts');
      const data = await response.json();
      return data.counts || {};
    },
    staleTime: 30000,
  });

  useEffect(() => {
    if (externalSubscriberCountsError) {
      toast.error('External subscriber counts could not be loaded');
    }
  }, [externalSubscriberCountsError]);
  const externalSubscriberCountsUnavailable = Boolean(externalSubscriberCountsError);

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

  const { data: audienceListCounts = {}, isLoading: audienceCountsLoading } = useQuery({
    queryKey: ['audience-list-counts'],
    queryFn: async () => {
      const response = await fetch('/api/audience-lists/counts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!response.ok) return {};
      const data = await response.json();
      return data.counts || {};
    },
    enabled: audienceLists.length > 0,
    staleTime: 30000,
  });

  const { data: blankPageSetting } = useQuery({
    queryKey: ['email-preferences-blank-page-setting'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'email_preferences_blank_page') || null;
    },
  });

  const blankPageEnabled = blankPageSetting?.setting_value === 'true';

  const toggleBlankPageMutation = useMutation({
    mutationFn: async (enabled) => {
      if (blankPageSetting?.id) {
        return await base44.entities.SystemSettings.update(blankPageSetting.id, {
          setting_value: String(enabled)
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'email_preferences_blank_page',
          setting_value: String(enabled),
          description: 'Show email preferences as standalone page without header/footer'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-preferences-blank-page-setting'] });
      toast.success('Email preferences page setting updated');
    },
    onError: () => {
      toast.error('Failed to update setting');
    }
  });

  const { data: memberGroups = [] } = useQuery({
    queryKey: ['member-groups'],
    queryFn: () => base44.entities.MemberGroup.list(),
    staleTime: 60000,
  });

  // Union of roles defined across the currently-selected groups in the segment
  // builder. Used to render the optional per-group role narrowing selector.
  const availableGroupRoles = useMemo(() => {
    if (addListSegmentType !== 'member_group' || addListSegmentIds.length === 0) return [];
    const roleSet = new Set();
    memberGroups.forEach(g => {
      if (addListSegmentIds.includes(g.id) && Array.isArray(g.roles)) {
        g.roles.forEach(r => { if (r) roleSet.add(r); });
      }
    });
    return [...roleSet].sort((a, b) => a.localeCompare(b));
  }, [addListSegmentType, addListSegmentIds, memberGroups]);

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

  const { data: eventLinkedForms = [] } = useQuery({
    queryKey: ['event-linked-forms'],
    queryFn: async () => {
      try {
        const allForms = await base44.entities.Form.list();
        return (allForms || []).filter(f => f.is_event_related === true && f.is_active !== false);
      } catch (e) { return []; }
    },
    staleTime: 60000,
  });

  const { data: audienceListEvents = [] } = useQuery({
    queryKey: ['audience-list-events'],
    queryFn: async () => {
      try {
        const response = await fetch('/api/audience-lists/events', { credentials: 'include' });
        if (!response.ok) return [];
        return await response.json() || [];
      } catch (e) { return []; }
    },
    staleTime: 60000,
  });

  const eventLookup = useMemo(() => {
    const map = {};
    audienceListEvents.forEach(e => { map[e.id] = e.title; });
    return map;
  }, [audienceListEvents]);

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

  const debouncedIndMemberSearch = useCallback(
    (() => {
      let timer;
      return (query) => {
        clearTimeout(timer);
        if (!query || query.length < 2) {
          setIndMemberSearchResults([]);
          setIndMemberSearchLoading(false);
          return;
        }
        setIndMemberSearchLoading(true);
        timer = setTimeout(async () => {
          try {
            const resp = await fetch(`/api/members/search?q=${encodeURIComponent(query)}&limit=10`, { credentials: 'include' });
            if (resp.ok) {
              const data = await resp.json();
              setIndMemberSearchResults(data);
            }
          } catch (e) {
            console.error('Member search error:', e);
          } finally {
            setIndMemberSearchLoading(false);
          }
        }, 300);
      };
    })(),
    []
  );

  const getSegmentSummary = (segment) => {
    const typeLabels = {
      communication_category: 'Categories',
      member_group: 'Groups',
      member_group_admins: 'Group Admins',
      role: 'Roles',
      form: 'Forms',
      fundraisers: 'Fundraisers',
      donors: 'Donors',
      all_members: 'All Members',
      audience_list: 'Saved Lists',
      individual_members: 'Individual Members',
      field_filter: 'Field Filter',
      event_attendees: 'Event Attendees',
      event_form: 'Event Form'
    };
    const label = typeLabels[segment.type] || segment.type;
    if (segment.type === 'all_members') return label;
    const count = (segment.ids || []).length;
    if (segment.type === 'individual_members') {
      if (segment.names && Object.keys(segment.names).length > 0) {
        const names = (segment.ids || []).map(id => segment.names[id]).filter(Boolean);
        return names.length > 0 ? `${label}: ${names.join(', ')}` : `${label} (${count})`;
      }
      return `${label} (${count})`;
    }
    if (segment.type === 'role') {
      const names = (segment.ids || []).map(id => roleLookup[id]).filter(Boolean);
      return names.length > 0 ? `${label}: ${names.join(', ')}` : `${label} (${count})`;
    }
    if (segment.type === 'member_group') {
      const names = (segment.ids || []).map(id => memberGroups.find(g => g.id === id)?.name).filter(Boolean);
      const base = names.length > 0 ? `${label}: ${names.join(', ')}` : `${label} (${count})`;
      const roleNames = Array.isArray(segment.roles) ? segment.roles.filter(Boolean) : [];
      return roleNames.length > 0 ? `${base} — Roles: ${roleNames.join(', ')}` : base;
    }
    if (segment.type === 'member_group_admins') {
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
    if (segment.type === 'event_attendees') {
      const lookup = segment.names || {};
      const ticketSel = segment.ticket_type_selection || {};
      const attendanceSel = segment.attendance_selection || {};
      const attendanceLabels = { attended: 'Attended only', not_attended: 'Did not attend' };
      const eventSummaries = (segment.ids || []).map(id => {
        const evName = lookup[id] || eventLookup[id] || id;
        const sel = ticketSel[id];
        const parts = [];
        if (sel && sel !== 'all' && Array.isArray(sel) && sel.length > 0) {
          parts.push(sel.map(tc => tc.name).filter(Boolean).join(', '));
        }
        if (attendanceLabels[attendanceSel[id]]) {
          parts.push(attendanceLabels[attendanceSel[id]]);
        }
        return parts.length > 0 ? `${evName} (${parts.join(' — ')})` : evName;
      }).filter(Boolean);
      return eventSummaries.length > 0 ? `${label}: ${eventSummaries.join('; ')}` : `${label} (${count})`;
    }
    if (segment.type === 'event_form') {
      const formId = (segment.ids || [])[0];
      const lookup = segment.names || {};
      const formName = lookup[formId] || eventLinkedForms.find(f => f.id === formId)?.name;
      const receivedLabel = segment.received ? 'Received' : 'Not Received';
      return formName ? `${label}: ${formName} — ${receivedLabel}` : `${label} — ${receivedLabel}`;
    }
    if (segment.type === 'field_filter') {
      const groups = segment.filter_groups || [];
      const parts = groups.map(g => {
        const conds = (g.conditions || []).map(c => {
          const fieldLabel = c.field_label || c.field_key;
          const opLabels = { equals: '=', not_equals: '!=', contains: 'contains', is_empty: 'is empty', is_not_empty: 'is not empty', is_true: 'is true', is_false: 'is false', greater_than: '>', less_than: '<', before: 'before', after: 'after', is_one_of: 'is one of', is_not_one_of: 'is not one of' };
          const opLabel = opLabels[c.operator] || c.operator;
          const scope = c.entity_scope === 'organization' ? 'Org' : c.entity_scope === 'event' ? 'Event' : 'Member';
          if (c.operator === 'is_empty' || c.operator === 'is_not_empty' || c.operator === 'is_true' || c.operator === 'is_false') {
            return `${scope}.${fieldLabel} ${opLabel}`;
          }
          let displayVal;
          if (c.entity_scope === 'event' && Array.isArray(c.value)) {
            displayVal = c.value.map(id => (c.value_names && c.value_names[id]) || eventLookup[id] || id).join(', ');
          } else {
            displayVal = Array.isArray(c.value) ? c.value.join(', ') : c.value;
          }
          return `${scope}.${fieldLabel} ${opLabel} ${displayVal}`;
        });
        return conds.join(' AND ');
      });
      const summary = parts.join(' OR ');
      return `Field Filter: ${summary}`;
    }
    return `${label} (${count})`;
  };

  const getOperatorsForDataType = (dataType) => {
    const base = [
      { value: 'equals', label: 'Equals' },
      { value: 'not_equals', label: 'Not equals' },
      { value: 'is_empty', label: 'Is empty' },
      { value: 'is_not_empty', label: 'Is not empty' },
    ];
    switch (dataType) {
      case 'text':
      case 'email':
      case 'url':
        return [...base, { value: 'contains', label: 'Contains' }];
      case 'number':
      case 'decimal':
        return [...base, { value: 'greater_than', label: 'Greater than' }, { value: 'less_than', label: 'Less than' }];
      case 'boolean':
        return [{ value: 'is_true', label: 'Is true' }, { value: 'is_false', label: 'Is false' }];
      case 'date':
        return [...base, { value: 'before', label: 'Before' }, { value: 'after', label: 'After' }];
      case 'picklist':
      case 'dropdown':
        return [...base, { value: 'is_one_of', label: 'Is one of' }];
      case 'list':
      case 'multiselect':
      case 'multi_select':
      case 'country':
      case 'countries':
        return [
          { value: 'contains', label: 'Contains any of' },
          { value: 'is_empty', label: 'Is empty' },
          { value: 'is_not_empty', label: 'Is not empty' },
        ];
      case 'event_id':
        return [
          { value: 'is_one_of', label: 'Is one of' },
          { value: 'is_not_one_of', label: 'Is not one of' },
        ];
      default:
        return [...base, { value: 'contains', label: 'Contains' }];
    }
  };

  const isMultiSelectDataType = (dataType) =>
    dataType === 'list' || dataType === 'multiselect' || dataType === 'multi_select' || dataType === 'countries' || dataType === 'country';

  const fetchEventTicketTypes = async (eventId) => {
    if (eventTicketTypesCache[eventId] !== undefined || eventTicketTypesLoading[eventId]) return;
    setEventTicketTypesLoading(prev => ({ ...prev, [eventId]: true }));
    try {
      const res = await fetch(`/api/audience-lists/event-ticket-types?eventId=${encodeURIComponent(eventId)}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setEventTicketTypesCache(prev => ({ ...prev, [eventId]: data.ticketTypes || [] }));
      } else {
        setEventTicketTypesCache(prev => ({ ...prev, [eventId]: [] }));
      }
    } catch {
      setEventTicketTypesCache(prev => ({ ...prev, [eventId]: [] }));
    } finally {
      setEventTicketTypesLoading(prev => ({ ...prev, [eventId]: false }));
    }
  };

  const resetIndMemberSearch = () => {
    setIndMemberSearchInput('');
    setIndMemberSearchResults([]);
    setIndMemberSearchLoading(false);
    setIndSelectedMembers([]);
    setEventSearchInput('');
    setSelectedEvents([]);
    setEventTicketTypesCache({});
    setEventTicketTypesLoading({});
    setEventTicketTypeSelections({});
    setEventAttendanceSelections({});
  };

  const formatEventDate = (dateStr) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  };

  const openEditListDialog = (list) => {
    setEditingList(list);
    setEditListName(list.name);
    setEditListAudiences(Array.isArray(list.target_audiences) ? [...list.target_audiences] : []);
    setEditListIgnoreOptOuts(list.ignore_opt_outs === true);
    setShowAddListSegment(false);
    setAddListSegmentType('');
    setAddListSegmentIds([]);
    setAddListSegmentRoles([]);
    resetIndMemberSearch();
    setShowEditListDialog(true);
  };

  const openNewListDialog = () => {
    setEditingList(null);
    setEditListName('');
    setEditListAudiences([]);
    setEditListIgnoreOptOuts(false);
    setShowAddListSegment(false);
    setAddListSegmentType('');
    setAddListSegmentIds([]);
    setAddListSegmentRoles([]);
    resetIndMemberSearch();
    setShowEditListDialog(true);
  };

  const openPreviewModal = async (list) => {
    setPreviewListName(list.name);
    setPreviewRecipients([]);
    setPreviewTotalCount(0);
    setPreviewPage(1);
    setPreviewLoading(true);
    setShowPreviewModal(true);
    try {
      const response = await fetch('/api/audience-lists/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ listId: list.id })
      });
      if (response.ok) {
        const data = await response.json();
        setPreviewRecipients(data.recipients || []);
        setPreviewTotalCount(data.totalCount || 0);
      } else {
        const err = await response.json();
        toast.error(err.error || 'Failed to load audience preview');
        setShowPreviewModal(false);
      }
    } catch (e) {
      toast.error('Failed to load audience preview');
      setShowPreviewModal(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const previewTotalPages = Math.max(1, Math.ceil(previewTotalCount / previewPageSize));
  const previewPagedRecipients = previewRecipients.slice(
    (previewPage - 1) * previewPageSize,
    previewPage * previewPageSize
  );

  const handleSaveListEdit = async () => {
    if (!editListName.trim()) { toast.error('Please enter a list name'); return; }
    setSavingListEdit(true);
    try {
      const isCreating = !editingList;
      const payload = {
        name: editListName.trim(),
        target_audiences: editListAudiences,
        ignore_opt_outs: editListIgnoreOptOuts
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
        if (isCreating && editListAudiences.length === 0) toast.message('This list has no dynamic segments yet. Add external contacts from the list card.');
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

  const refreshAudienceContactData = () => {
    queryClient.invalidateQueries({ queryKey: ['audience-list-counts'] });
    queryClient.invalidateQueries({ queryKey: ['audience-lists'] });
  };
  const loadExternalContacts = async (listId) => {
    setExternalContactsLoading(true);
    try {
      const response = await fetch(`/api/audience-lists/external-contacts?listId=${encodeURIComponent(listId)}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Unable to load contacts');
      const data = await response.json();
      setExternalContacts(data.contacts || []);
    } catch (error) {
      toast.error('Unable to load external contacts');
    } finally { setExternalContactsLoading(false); }
  };
  const openExternalContacts = (list) => {
    setExternalContactsList(list); setExternalContacts([]); setBulkOutcomes([]); setBulkRows([]); setBulkText('');
    setExternalContactForm({ first_name: '', last_name: '', email: '' }); setIndividualGdprAcknowledged(false); setBulkGdprAcknowledged(false);
    loadExternalContacts(list.id);
  };
  const submitExternalContacts = async (rows, source, dryRun) => {
    const response = await fetch('/api/audience-lists/external-contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ listId: externalContactsList.id, rows, source, gdprAcknowledged: source === 'individual' ? individualGdprAcknowledged : bulkGdprAcknowledged, dryRun }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not validate contacts');
    return data;
  };
  const handleSingleContactAdd = async () => {
    if (!individualGdprAcknowledged) return toast.error('Confirm the lawful basis before storing a contact.');
    if (!externalContactForm.email.trim()) return toast.error('Email is required.');
    setContactsSubmitting(true);
    try {
      const result = await submitExternalContacts([externalContactForm], 'individual', false);
      if ((result.insertedCount || 0) > 0) { toast.success('External contact added'); setExternalContactForm({ first_name: '', last_name: '', email: '' }); setIndividualGdprAcknowledged(false); await loadExternalContacts(externalContactsList.id); refreshAudienceContactData(); }
      else toast.error(result.outcomes?.[0]?.error || 'Contact was not added.');
    } catch (error) { toast.error(error.message); } finally { setContactsSubmitting(false); }
  };
  const handleBulkPreview = async () => {
    if (!bulkGdprAcknowledged) return toast.error('Confirm the lawful basis before validating this import.');
    const parsed = parseExternalContacts(bulkText);
    if (parsed.error) return toast.error(parsed.error);
    setBulkRows(parsed.rows); setContactsSubmitting(true);
    try { const result = await submitExternalContacts(parsed.rows, bulkSource, true); setBulkOutcomes(result.outcomes || []); }
    catch (error) { toast.error(error.message); } finally { setContactsSubmitting(false); }
  };
  const handleBulkConfirm = async () => {
    setContactsSubmitting(true);
    try {
      const result = await submitExternalContacts(bulkRows, bulkSource, false);
      setBulkOutcomes(result.outcomes || []);
      toast.success(`${result.insertedCount || 0} contact${result.insertedCount === 1 ? '' : 's'} added`);
      await loadExternalContacts(externalContactsList.id); refreshAudienceContactData();
    } catch (error) { toast.error(error.message); } finally { setContactsSubmitting(false); }
  };
  const removeExternalContact = async (contact) => {
    if (!externalContactsList || !window.confirm(`Remove ${contact.email} from this list?`)) return;
    try {
      const response = await fetch(`/api/audience-lists/external-contacts?listId=${encodeURIComponent(externalContactsList.id)}&id=${encodeURIComponent(contact.id)}`, { method: 'DELETE', credentials: 'include' });
      if (!response.ok) throw new Error();
      toast.success('External contact removed'); await loadExternalContacts(externalContactsList.id); refreshAudienceContactData();
    } catch { toast.error('Could not remove contact'); }
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
  const [memberSearch, setMemberSearch] = useState('');

  const [optOutSearch, setOptOutSearch] = useState('');
  const [optOutPage, setOptOutPage] = useState(1);
  const [exportingOptOuts, setExportingOptOuts] = useState(false);
  const OPT_OUT_PER_PAGE = 10;

  const getSubscribersForCategory = (categoryId) => {
    return filterExplicitCategorySubscribers(allMembers, preferences, [categoryId]);
  };

  const getSubscriberCount = (categoryId) => {
    return getSubscribersForCategory(categoryId).length;
  };

  const getOptedOutForCategory = (categoryId) => {
    const optedOutMemberIds = preferences
      .filter(p => p.category_id === categoryId && p.is_subscribed === false)
      .map(p => p.member_id);
    return allMembers.filter(member =>
      optedOutMemberIds.includes(member.id) &&
      member.communications_opted_out_all !== true
    );
  };

  const getOptedOutCount = (categoryId) => {
    return getOptedOutForCategory(categoryId).length;
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
  const [externalSearch, setExternalSearch] = useState('');
  const [loadingExternalSubscribers, setLoadingExternalSubscribers] = useState(false);
  const [externalSubscribersError, setExternalSubscribersError] = useState('');
  const [removingSubscriberId, setRemovingSubscriberId] = useState(null);
  const externalRequestTrackerRef = useRef(createLatestRequestTracker());
  const externalAbortControllerRef = useRef(null);
  const subscriberModalContextRef = useRef({
    generation: 0,
    open: false,
    categoryId: null,
    externalSearch: '',
    externalPage: 1,
    externalTotal: 0,
    externalActionGeneration: 0,
  });

  const fetchExternalSubscribers = useCallback(async (categoryId, page = 1, search = '') => {
    subscriberModalContextRef.current = beginExternalSubscriberRequest(
      subscriberModalContextRef.current,
      page,
      search
    );
    externalAbortControllerRef.current?.abort();
    const controller = new AbortController();
    externalAbortControllerRef.current = controller;
    const requestId = externalRequestTrackerRef.current.begin();
    setLoadingExternalSubscribers(true);
    setExternalSubscribersError('');

    try {
      const params = new URLSearchParams({
        category_id: categoryId,
        page: String(page),
        per_page: String(SUBSCRIBERS_PER_PAGE),
      });
      const normalizedSearch = normalizeSubscriberSearch(search);
      if (normalizedSearch) params.set('search', normalizedSearch);

      const response = await fetch(`/api/admin/external-subscribers?${params}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error('Failed to fetch external subscribers');
      }
      const data = await response.json();
      if (!externalRequestTrackerRef.current.isLatest(requestId)) return false;

      setExternalSubscribers(data.subscribers || []);
      setExternalSubscribersTotal(data.total || 0);
      setExternalSubscribersPage(data.page || page);
      subscriberModalContextRef.current.externalPage = data.page || page;
      subscriberModalContextRef.current.externalTotal = data.total || 0;
      return true;
    } catch (error) {
      if (error.name === 'AbortError' || !externalRequestTrackerRef.current.isLatest(requestId)) {
        return false;
      }
      console.error('Error fetching external subscribers:', error);
      setExternalSubscribersError('External subscribers could not be loaded. Please try again.');
      return false;
    } finally {
      if (externalRequestTrackerRef.current.isLatest(requestId)) {
        setLoadingExternalSubscribers(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!showSubscribersDialog || subscriberTab !== 'external' || !viewingCategory) return undefined;

    const timeout = window.setTimeout(() => {
      fetchExternalSubscribers(viewingCategory.id, 1, externalSearch);
    }, EXTERNAL_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [
    externalSearch,
    fetchExternalSubscribers,
    showSubscribersDialog,
    subscriberTab,
    viewingCategory,
  ]);

  const handleRemoveExternalSubscriber = async (subscriberId) => {
    const deleteContext = {
      generation: subscriberModalContextRef.current.generation,
      categoryId: subscriberModalContextRef.current.categoryId,
    };
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
        queryClient.invalidateQueries({ queryKey: ['external-subscriber-counts'] });
        const currentContext = subscriberModalContextRef.current;
        if (
          currentContext.open &&
          currentContext.generation === deleteContext.generation &&
          currentContext.categoryId === deleteContext.categoryId
        ) {
          const recoveryPage = getPageAfterRemoval(
            currentContext.externalPage,
            currentContext.externalTotal,
            SUBSCRIBERS_PER_PAGE
          );
          await fetchExternalSubscribers(
            currentContext.categoryId,
            recoveryPage,
            currentContext.externalSearch
          );
        }
      } else {
        toast.error('Failed to remove subscriber');
      }
    } catch (error) {
      toast.error('Failed to remove subscriber');
    } finally {
      setRemovingSubscriberId(null);
    }
  };

  const openSubscribersView = (category, initialTab = 'members') => {
    externalRequestTrackerRef.current.invalidate();
    externalAbortControllerRef.current?.abort();
    setViewingCategory(category);
    setSubscribersPage(1);
    setOptOutPage(1);
    setMemberSearch('');
    setExternalSearch('');
    setSubscriberTab(initialTab);
    setExternalSubscribers([]);
    setExternalSubscribersTotal(0);
    setExternalSubscribersPage(1);
    setExternalSubscribersError('');
    setLoadingExternalSubscribers(initialTab === 'external');
    subscriberModalContextRef.current = {
      generation: subscriberModalContextRef.current.generation + 1,
      open: true,
      categoryId: category.id,
      externalSearch: '',
      externalPage: 1,
      externalTotal: 0,
      externalActionGeneration: 0,
    };
    setShowSubscribersDialog(true);
  };

  const getPaginatedSubscribers = () => {
    if (!viewingCategory) {
      return { subscribers: [], totalPages: 1, total: 0, unfilteredTotal: 0, currentPage: 1 };
    }
    const allSubscribers = getSubscribersForCategory(viewingCategory.id);
    const filteredSubscribers = filterMemberSubscribers(
      allSubscribers,
      memberSearch,
      orgLookup,
      roleLookup
    );
    const page = paginateSubscriberResults(
      filteredSubscribers,
      subscribersPage,
      SUBSCRIBERS_PER_PAGE
    );
    return {
      subscribers: page.items,
      totalPages: page.totalPages,
      total: page.total,
      unfilteredTotal: allSubscribers.length,
      currentPage: page.currentPage,
      rangeStart: page.rangeStart,
      rangeEnd: page.rangeEnd,
    };
  };

  const getPaginatedOptedOut = () => {
    if (!viewingCategory) return { optedOut: [], totalPages: 0, total: 0 };
    const allOptedOut = getOptedOutForCategory(viewingCategory.id);
    const total = allOptedOut.length;
    const totalPages = Math.ceil(total / SUBSCRIBERS_PER_PAGE) || 1;
    const start = (optOutPage - 1) * SUBSCRIBERS_PER_PAGE;
    const optedOut = allOptedOut.slice(start, start + SUBSCRIBERS_PER_PAGE);
    return { optedOut, totalPages, total };
  };

  const globalOptOutMembers = useMemo(() => {
    return allMembers.filter(member => member.communications_opted_out_all === true);
  }, [allMembers]);

  const filteredOptOutMembers = useMemo(() => {
    if (!optOutSearch.trim()) return globalOptOutMembers;
    const search = optOutSearch.toLowerCase().trim();
    return globalOptOutMembers.filter(member => {
      const name = [member.first_name, member.last_name].filter(Boolean).join(' ').toLowerCase();
      const email = (member.email || '').toLowerCase();
      const org = (member.organization_id && orgLookup[member.organization_id] || '').toLowerCase();
      const role = (member.role_id && roleLookup[member.role_id] || '').toLowerCase();
      return name.includes(search) || email.includes(search) || org.includes(search) || role.includes(search);
    });
  }, [globalOptOutMembers, optOutSearch, orgLookup, roleLookup]);

  const getPaginatedOptOuts = () => {
    const total = filteredOptOutMembers.length;
    const totalPages = Math.ceil(total / OPT_OUT_PER_PAGE) || 1;
    const safePage = Math.min(optOutPage, totalPages);
    const start = (safePage - 1) * OPT_OUT_PER_PAGE;
    const members = filteredOptOutMembers.slice(start, start + OPT_OUT_PER_PAGE);
    return { members, totalPages, total, currentPage: safePage };
  };

  const handleExportOptOuts = () => {
    setExportingOptOuts(true);
    try {
      if (globalOptOutMembers.length === 0) {
        toast.info('No globally opted-out members to export');
        setExportingOptOuts(false);
        return;
      }

      const headers = ['Name', 'Email', 'Organisation', 'Role'];
      const rows = globalOptOutMembers.map(member => {
        const name = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'N/A';
        const email = member.email || 'N/A';
        const org = (member.organization_id && orgLookup[member.organization_id]) || 'N/A';
        const role = (member.role_id && roleLookup[member.role_id]) || 'N/A';

        return [name, email, org, role].map(val => {
          const escaped = String(val).replace(/"/g, '""');
          return `"${escaped}"`;
        }).join(',');
      });

      const csvContent = [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      const date = new Date().toISOString().split('T')[0];
      link.setAttribute('href', url);
      link.setAttribute('download', `global_opt_outs_${date}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success(`Exported ${globalOptOutMembers.length} opted-out member${globalOptOutMembers.length !== 1 ? 's' : ''}`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export opt-out list');
    } finally {
      setExportingOptOuts(false);
    }
  };

  const handleExportSubscribers = async (category) => {
    setExportingCategory(category.id);
    try {
      const memberSubscribers = getSubscribersForCategory(category.id);
      
      const extSubs = await fetchAllExternalSubscribers({ categoryId: category.id });

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
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const tablesNotSetup = categoriesError?.message?.includes('does not exist') || 
                         categoriesError?.message?.includes('relation') ||
                         categoriesError?.message?.includes('42P01');

  if (tablesNotSetup) {
    return (
      <div className="min-h-screen p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Card className="border-warning/30 bg-warning/10">
            <CardHeader>
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-8 h-8 text-warning" />
                <div>
                  <CardTitle className="text-warning">Database Setup Required</CardTitle>
                  <CardDescription className="text-warning">
                    The communications tables need to be created in Supabase before using this feature.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-warning mb-4">
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
                className="mt-4 bg-warning hover:bg-warning/90 text-warning-foreground"
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
    <div className="min-h-screen p-4 md:p-8">
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
                <TabsTrigger value="opt-outs" data-testid="tab-opt-outs" onClick={() => { setOptOutPage(1); }}>
                  <UserX className="w-4 h-4 mr-2" />
                  Global Opt-Outs
                  {!membersLoading && globalOptOutMembers.length > 0 && (
                    <Badge variant="secondary" className="ml-2 text-xs" data-testid="badge-opt-out-count">
                      {globalOptOutMembers.length}
                    </Badge>
                  )}
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
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 className="text-base font-semibold text-slate-900" data-testid={`text-list-name-${list.id}`}>
                                  {list.name}
                                </h4>
                                {audienceCountsLoading && audienceListCounts[list.id] === undefined ? (
                                  <Badge variant="secondary" className="text-xs" data-testid={`badge-list-count-loading-${list.id}`}>
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  </Badge>
                                ) : audienceListCounts[list.id] !== undefined ? (
                                  <Badge variant="secondary" className="text-xs" data-testid={`badge-list-count-${list.id}`}>
                                    {audienceListCounts[list.id]} {audienceListCounts[list.id] === 1 ? 'recipient' : 'recipients'}
                                  </Badge>
                                ) : null}
                              </div>
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
                                variant="outline"
                                size="sm"
                                onClick={() => openExternalContacts(list)}
                                data-testid={`button-manage-external-contacts-${list.id}`}
                              >
                                <Users className="w-4 h-4 mr-1.5" />
                                Manage external contacts
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openPreviewModal(list)}
                                data-testid={`button-preview-list-${list.id}`}
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
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
                  <div className={`p-2 rounded-lg ${isZohoConnected ? 'bg-green-100' : 'bg-warning/10'}`}>
                    {isZohoConnected ? (
                      <Link2 className="w-5 h-5 text-green-600" />
                    ) : (
                      <Unlink className="w-5 h-5 text-warning" />
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

            <div className="mb-6 p-4 border border-slate-200 rounded-lg bg-slate-50">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label className="text-sm font-medium text-slate-900">Hide header & footer on email preferences page</Label>
                  <p className="text-xs text-slate-500">
                    When enabled, the email preferences page renders as a standalone page without the site header and footer. Useful for embedding in an iframe.
                  </p>
                </div>
                <Switch
                  checked={blankPageEnabled}
                  onCheckedChange={(checked) => toggleBlankPageMutation.mutate(checked)}
                  disabled={toggleBlankPageMutation.isPending}
                  data-testid="switch-email-preferences-blank-page"
                />
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
                  const optedOutCount = getOptedOutCount(category.id);
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
                                {externalSubscriberCountsUnavailable
                                  ? 'Subscriber count unavailable'
                                  : `${totalCount} subscriber${totalCount !== 1 ? 's' : ''}`}
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
                                  {externalSubscriberCountsUnavailable ? (
                                    <span className="font-medium text-red-700">Subscriber count unavailable</span>
                                  ) : (
                                    <><span className="font-medium text-slate-900 hover:text-blue-600">{totalCount}</span> subscribers</>
                                  )}
                                  {!externalSubscriberCountsUnavailable && externalCount > 0 && (
                                    <span className="text-xs text-slate-400 ml-1">({subscriberCount} members, {externalCount} external)</span>
                                  )}
                                </button>
                                {optedOutCount > 0 && (
                                  <>
                                    <span className="text-xs text-slate-300">|</span>
                                    <button
                                      className="text-sm text-slate-500 hover:text-red-600 hover:underline cursor-pointer bg-transparent border-0 p-0 flex items-center gap-1"
                                      onClick={() => openSubscribersView(category, 'opted-out')}
                                      disabled={membersLoading}
                                      title="View members who opted out of this category"
                                      data-testid={`button-view-opted-out-${category.id}`}
                                    >
                                      <UserX className="w-3.5 h-3.5" />
                                      <span className="font-medium">{optedOutCount}</span> opted out
                                    </button>
                                  </>
                                )}
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
                                  <Link2 className="w-4 h-4 text-warning" />
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
                                        <span className="text-xs text-warning" data-testid={`sync-progress-warning-${category.id}`}>
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

              <TabsContent value="opt-outs">
                <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900" data-testid="text-opt-outs-heading">Global Opt-Outs</h3>
                    <p className="text-sm text-slate-500">Members who have opted out of all communications.</p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={handleExportOptOuts}
                    disabled={exportingOptOuts || membersLoading || globalOptOutMembers.length === 0}
                    data-testid="button-export-opt-outs"
                  >
                    {exportingOptOuts ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4 mr-2" />
                    )}
                    Download CSV
                  </Button>
                </div>

                {membersLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-blue-600 mr-2" />
                    <span className="text-slate-600">Loading members...</span>
                  </div>
                ) : globalOptOutMembers.length === 0 ? (
                  <div className="text-center py-12" data-testid="text-no-opt-outs">
                    <UserX className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-slate-900 mb-2">No Global Opt-Outs</h3>
                    <p className="text-slate-600">
                      No members have globally opted out of all communications.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="relative mb-4">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                        placeholder="Search by name, email, organisation, or role..."
                        value={optOutSearch}
                        onChange={(e) => { setOptOutSearch(e.target.value); setOptOutPage(1); }}
                        className="pl-9"
                        data-testid="input-opt-out-search"
                      />
                    </div>

                    {(() => {
                      const { members, totalPages, total, currentPage } = getPaginatedOptOuts();

                      if (total === 0) {
                        return (
                          <div className="text-center py-12" data-testid="text-no-search-results">
                            <Search className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                            <p className="text-slate-600">No opted-out members match your search.</p>
                          </div>
                        );
                      }

                      return (
                        <>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Name</TableHead>
                                <TableHead>Email</TableHead>
                                <TableHead>Organisation</TableHead>
                                <TableHead>Role</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {members.map((member) => (
                                <TableRow
                                  key={member.id}
                                  data-testid={`row-opt-out-${member.id}`}
                                  className="cursor-pointer hover:bg-blue-50 transition-colors"
                                  onClick={() => navigate(`/members/${member.id}`)}
                                >
                                  <TableCell className="font-medium text-blue-600 hover:text-blue-700" data-testid={`text-opt-out-name-${member.id}`}>
                                    {[member.first_name, member.last_name].filter(Boolean).join(' ') || 'N/A'}
                                  </TableCell>
                                  <TableCell className="text-slate-600" data-testid={`text-opt-out-email-${member.id}`}>{member.email || 'N/A'}</TableCell>
                                  <TableCell data-testid={`text-opt-out-org-${member.id}`}>{(member.organization_id && orgLookup[member.organization_id]) || 'N/A'}</TableCell>
                                  <TableCell data-testid={`text-opt-out-role-${member.id}`}>{(member.role_id && roleLookup[member.role_id]) || 'N/A'}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>

                          {totalPages > 1 && (
                            <div className="flex items-center justify-between mt-4 pt-4 border-t gap-2 flex-wrap">
                              <div className="text-sm text-slate-600" data-testid="text-opt-out-page-info">
                                Showing {((currentPage - 1) * OPT_OUT_PER_PAGE) + 1} - {Math.min(currentPage * OPT_OUT_PER_PAGE, total)} of {total}
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setOptOutPage(p => Math.max(1, p - 1))}
                                  disabled={currentPage === 1}
                                  data-testid="button-opt-out-prev-page"
                                >
                                  <ChevronLeft className="w-4 h-4" />
                                  Previous
                                </Button>
                                <span className="text-sm text-slate-600 px-2" data-testid="text-opt-out-page-label">
                                  Page {currentPage} of {totalPages}
                                </span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setOptOutPage(p => Math.min(totalPages, p + 1))}
                                  disabled={currentPage === totalPages}
                                  data-testid="button-opt-out-next-page"
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
                      Allow external non-members (e.g. donors and guests) to subscribe. This never bypasses member role access.
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
                  <Label>Applicable Roles</Label>
                  <p className="text-xs text-slate-500 mb-2">
                    Members can see and subscribe only when their role is selected. If no roles are selected, all member roles can access the category.
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

        <Dialog
          open={showSubscribersDialog}
          onOpenChange={(open) => {
            if (!open) {
              externalRequestTrackerRef.current.invalidate();
              externalAbortControllerRef.current?.abort();
              subscriberModalContextRef.current = {
                ...subscriberModalContextRef.current,
                generation: subscriberModalContextRef.current.generation + 1,
                open: false,
              };
            }
            setShowSubscribersDialog(open);
          }}
        >
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
                      if (externalSubscriberCountsUnavailable) {
                        return 'External subscriber count unavailable. Please try again.';
                      }
                      const memberCount = viewingCategory ? getSubscriberCount(viewingCategory.id) : 0;
                      const extCount = viewingCategory ? getExternalSubscriberCount(viewingCategory.id) : 0;
                      const optCount = viewingCategory ? getOptedOutCount(viewingCategory.id) : 0;
                      const total = memberCount + extCount;
                      const parts = [];
                      if (extCount > 0 || optCount > 0) {
                        parts.push(`${memberCount} members`);
                        if (extCount > 0) parts.push(`${extCount} external`);
                        if (optCount > 0) parts.push(`${optCount} opted out`);
                        return `${total} total subscribers (${parts.join(', ')})`;
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
                if (val === 'external') {
                  setLoadingExternalSubscribers(true);
                }
              }}>
                <TabsList className="mb-4" data-testid="tabs-subscriber-type">
                  <TabsTrigger value="members" data-testid="tab-members">
                    <Users className="w-4 h-4 mr-1" />
                    Members ({viewingCategory ? getSubscriberCount(viewingCategory.id) : 0})
                  </TabsTrigger>
                  <TabsTrigger value="external" data-testid="tab-external">
                    <Globe className="w-4 h-4 mr-1" />
                    External ({externalSubscriberCountsUnavailable
                      ? 'unavailable'
                      : viewingCategory ? getExternalSubscriberCount(viewingCategory.id) : 0})
                  </TabsTrigger>
                  <TabsTrigger value="opted-out" data-testid="tab-opted-out">
                    <UserX className="w-4 h-4 mr-1" />
                    Opted Out ({viewingCategory ? getOptedOutCount(viewingCategory.id) : 0})
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="members">
                  <div className="relative mb-4">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={memberSearch}
                      onChange={(event) => {
                        setMemberSearch(event.target.value);
                        setSubscribersPage(1);
                      }}
                      placeholder="Search members by name, email, organisation, or role"
                      className="pl-9"
                      data-testid="input-search-member-subscribers"
                    />
                  </div>
                  {membersLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-600 mr-2" />
                      <span className="text-slate-600">Loading members...</span>
                    </div>
                  ) : (
                    <>
                      {(() => {
                        const {
                          subscribers,
                          totalPages,
                          total,
                          unfilteredTotal,
                          currentPage,
                          rangeStart,
                          rangeEnd,
                        } = getPaginatedSubscribers();
                        const emptyState = getSubscriberEmptyState(
                          unfilteredTotal,
                          total,
                          memberSearch
                        );
                        
                        if (emptyState) {
                          return (
                            <div className="text-center py-12">
                              <Users className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                              <p className="text-slate-600">
                                {emptyState === 'no-match'
                                  ? 'No member subscribers match your search'
                                  : 'No member subscribers for this category'}
                              </p>
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
                                  Showing {rangeStart} - {rangeEnd} of {total}
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setSubscribersPage(p => Math.max(1, p - 1))}
                                    disabled={currentPage === 1}
                                    data-testid="button-prev-page"
                                  >
                                    <ChevronLeft className="w-4 h-4" />
                                    Previous
                                  </Button>
                                  <span className="text-sm text-slate-600 px-2">
                                    Page {currentPage} of {totalPages}
                                  </span>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setSubscribersPage(p => Math.min(totalPages, p + 1))}
                                    disabled={currentPage === totalPages}
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
                  <div className="relative mb-4">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={externalSearch}
                      onChange={(event) => {
                        const nextSearch = event.target.value;
                        externalRequestTrackerRef.current.invalidate();
                        externalAbortControllerRef.current?.abort();
                        subscriberModalContextRef.current.externalSearch = nextSearch;
                        subscriberModalContextRef.current.externalPage = 1;
                        subscriberModalContextRef.current.externalActionGeneration += 1;
                        setExternalSearch(nextSearch);
                        setExternalSubscribersPage(1);
                        setExternalSubscribersError('');
                        setLoadingExternalSubscribers(true);
                      }}
                      placeholder="Search external subscribers by name or email"
                      className="pl-9"
                      data-testid="input-search-external-subscribers"
                    />
                  </div>
                  {externalSubscribersError ? (
                    <div className="text-center py-12">
                      <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto mb-3" />
                      <p className="text-slate-600">{externalSubscribersError}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-4"
                        onClick={() => viewingCategory && fetchExternalSubscribers(
                          viewingCategory.id,
                          externalSubscribersPage,
                          externalSearch
                        )}
                        data-testid="button-retry-external-subscribers"
                      >
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Try again
                      </Button>
                    </div>
                  ) : loadingExternalSubscribers ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-600 mr-2" />
                      <span className="text-slate-600">Loading external subscribers...</span>
                    </div>
                  ) : externalSubscribersTotal === 0 ? (
                    <div className="text-center py-12">
                      <Globe className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      {normalizeSubscriberSearch(externalSearch) ? (
                        <p className="text-slate-600">No external subscribers match your search</p>
                      ) : (
                        <>
                          <p className="text-slate-600">No external subscribers for this category</p>
                          <p className="text-xs text-slate-400 mt-1">External subscribers are non-members who subscribed via public forms, event donations, or direct signup</p>
                        </>
                      )}
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
                                onClick={() => viewingCategory && fetchExternalSubscribers(
                                  viewingCategory.id,
                                  externalSubscribersPage - 1,
                                  externalSearch
                                )}
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
                                onClick={() => viewingCategory && fetchExternalSubscribers(
                                  viewingCategory.id,
                                  externalSubscribersPage + 1,
                                  externalSearch
                                )}
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

                <TabsContent value="opted-out">
                  {membersLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-600 mr-2" />
                      <span className="text-slate-600">Loading members...</span>
                    </div>
                  ) : (
                    <>
                      {(() => {
                        const { optedOut, totalPages, total } = getPaginatedOptedOut();

                        if (total === 0) {
                          return (
                            <div className="text-center py-12">
                              <UserX className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                              <p className="text-slate-600">No members have opted out of this category</p>
                            </div>
                          );
                        }

                        return (
                          <>
                            <p className="text-xs text-slate-500 mb-3">Members who have explicitly unsubscribed from this category. Click on a member to edit their details.</p>
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
                                {optedOut.map((member) => (
                                  <TableRow
                                    key={member.id}
                                    data-testid={`row-opted-out-${member.id}`}
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
                                  Showing {((optOutPage - 1) * SUBSCRIBERS_PER_PAGE) + 1} - {Math.min(optOutPage * SUBSCRIBERS_PER_PAGE, total)} of {total}
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setOptOutPage(p => Math.max(1, p - 1))}
                                    disabled={optOutPage === 1}
                                    data-testid="button-opted-out-prev-page"
                                  >
                                    <ChevronLeft className="w-4 h-4" />
                                    Previous
                                  </Button>
                                  <span className="text-sm text-slate-600 px-2">
                                    Page {optOutPage} of {totalPages}
                                  </span>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setOptOutPage(p => Math.min(totalPages, p + 1))}
                                    disabled={optOutPage === totalPages}
                                    data-testid="button-opted-out-next-page"
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
              </Tabs>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={showPreviewModal} onOpenChange={setShowPreviewModal}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle data-testid="text-preview-list-name">{previewListName}</DialogTitle>
              <DialogDescription>
                {previewLoading ? 'Loading audience members...' : `${previewTotalCount} total recipient${previewTotalCount !== 1 ? 's' : ''}`}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {previewLoading ? (
                <div className="flex items-center justify-center py-12" data-testid="preview-loading">
                  <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                  <span className="ml-2 text-sm text-slate-500">Resolving audience...</span>
                </div>
              ) : previewTotalCount === 0 ? (
                <div className="text-center py-12 text-sm text-slate-400" data-testid="preview-empty">
                  No recipients found for this audience list.
                </div>
              ) : (
                <Table data-testid="table-preview-recipients">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">#</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewPagedRecipients.map((r, idx) => (
                      <TableRow key={r.email + idx} data-testid={`row-preview-recipient-${idx}`}>
                        <TableCell className="text-slate-400 text-xs">
                          {(previewPage - 1) * previewPageSize + idx + 1}
                        </TableCell>
                        <TableCell data-testid={`text-recipient-name-${idx}`}>
                          {[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}
                        </TableCell>
                        <TableCell className="text-slate-600" data-testid={`text-recipient-email-${idx}`}>
                          {r.email}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
            {previewTotalCount > previewPageSize && (
              <div className="flex items-center justify-between gap-4 pt-3 border-t" data-testid="preview-pagination">
                <span className="text-sm text-slate-500">
                  Page {previewPage} of {previewTotalPages}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={previewPage <= 1}
                    onClick={() => setPreviewPage(p => Math.max(1, p - 1))}
                    data-testid="button-preview-prev"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={previewPage >= previewTotalPages}
                    onClick={() => setPreviewPage(p => Math.min(previewTotalPages, p + 1))}
                    data-testid="button-preview-next"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
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

        <Dialog open={!!externalContactsList} onOpenChange={(open) => !open && setExternalContactsList(null)}>
          <DialogContent className="max-w-4xl max-h-[88vh] overflow-hidden flex flex-col" data-testid="dialog-external-contacts">
            <DialogHeader>
              <DialogTitle>External contacts</DialogTitle>
              <DialogDescription>
                {externalContactsList?.name} · Contacts added here are included in this saved list and retain their source and audit trail.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-5 overflow-y-auto pr-1 md:grid-cols-[1.15fr_.85fr]">
              <section className="min-w-0">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">Stored contacts</h3>
                    <p className="text-xs text-slate-500">Who is in this list, and how they were added.</p>
                  </div>
                  <Badge variant="secondary">{externalContacts.length}</Badge>
                </div>
                <div className="rounded-md border border-slate-200 overflow-hidden">
                  {externalContactsLoading ? (
                    <div className="p-8 text-center text-sm text-slate-500"><Loader2 className="inline w-4 h-4 mr-2 animate-spin" />Loading contacts</div>
                  ) : externalContacts.length === 0 ? (
                    <div className="p-8 text-center text-sm text-slate-500" data-testid="external-contacts-empty">No external contacts have been stored for this list.</div>
                  ) : (
                    <div className="max-h-[360px] overflow-y-auto">
                      {externalContacts.map((contact) => (
                        <div key={contact.id} className="border-b border-slate-100 last:border-0 px-3 py-3 flex gap-3 justify-between" data-testid={`external-contact-${contact.id}`}>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-800 truncate">{[contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unnamed contact'}</p>
                            <p className="text-sm text-slate-600 truncate">{contact.email}</p>
                            <p className="mt-1 text-[11px] text-slate-500">
                              Added {contact.addition_source?.replace(/_/g, ' ') || 'manually'} by {contact.added_by_actor_label || 'Unknown operator'}
                              {contact.created_at ? ` · ${new Date(contact.created_at).toLocaleString()}` : ''}
                            </p>
                          </div>
                          <Button variant="ghost" size="icon" className="shrink-0 text-slate-500 hover:text-red-600" onClick={() => removeExternalContact(contact)} data-testid={`button-remove-external-contact-${contact.id}`} aria-label={`Remove ${contact.email}`}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
              <section className="space-y-5">
                <div className="rounded-md border border-slate-200 p-4 space-y-3">
                  <div><h3 className="text-sm font-semibold text-slate-900">Add one contact</h3><p className="text-xs text-slate-500">Record an individual recipient with a documented lawful basis.</p></div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={externalContactForm.first_name} onChange={(e) => setExternalContactForm((current) => ({ ...current, first_name: e.target.value }))} placeholder="First name" data-testid="input-external-first-name" />
                    <Input value={externalContactForm.last_name} onChange={(e) => setExternalContactForm((current) => ({ ...current, last_name: e.target.value }))} placeholder="Last name" data-testid="input-external-last-name" />
                  </div>
                  <Input type="email" value={externalContactForm.email} onChange={(e) => setExternalContactForm((current) => ({ ...current, email: e.target.value }))} placeholder="Email address" data-testid="input-external-email" />
                  <div className="flex items-start gap-2 rounded bg-amber-50 p-2.5">
                    <Checkbox id="individual-gdpr" checked={individualGdprAcknowledged} onCheckedChange={(checked) => setIndividualGdprAcknowledged(checked === true)} data-testid="checkbox-individual-gdpr" />
                    <Label htmlFor="individual-gdpr" className="text-xs leading-5 text-slate-700">I confirm we have a lawful basis to store and contact this person, and that this entry is accurate.</Label>
                  </div>
                  <Button className="w-full" onClick={handleSingleContactAdd} disabled={contactsSubmitting || !individualGdprAcknowledged} data-testid="button-add-external-contact">
                    {contactsSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Store contact
                  </Button>
                </div>
                <div className="rounded-md border border-slate-200 p-4 space-y-3">
                  <div><h3 className="text-sm font-semibold text-slate-900">Import contacts</h3><p className="text-xs text-slate-500">Upload CSV or paste CSV/tab-delimited rows. XLSX files are not accepted.</p></div>
                  <Input type="file" accept=".csv,text/csv" data-testid="input-external-csv-file" onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (!file.name.toLowerCase().endsWith('.csv')) { toast.error('Please choose a CSV file.'); e.target.value = ''; return; }
                    const reader = new FileReader();
                    reader.onload = () => { setBulkText(String(reader.result || '')); setBulkSource('csv_upload'); setBulkOutcomes([]); };
                    reader.readAsText(file);
                  }} />
                  <Textarea value={bulkText} onChange={(e) => { setBulkText(e.target.value); setBulkSource('pasted_rows'); setBulkOutcomes([]); }} placeholder={'first_name,last_name,email\nMira,Patel,mira@example.org'} className="min-h-[100px] font-mono text-xs" data-testid="textarea-external-contact-import" />
                  <div className="flex items-start gap-2 rounded bg-amber-50 p-2.5">
                    <Checkbox id="bulk-gdpr" checked={bulkGdprAcknowledged} onCheckedChange={(checked) => setBulkGdprAcknowledged(checked === true)} data-testid="checkbox-bulk-gdpr" />
                    <Label htmlFor="bulk-gdpr" className="text-xs leading-5 text-slate-700">I confirm every imported contact has a lawful basis for storage and contact, and this source has been reviewed.</Label>
                  </div>
                  <Button variant="outline" className="w-full" onClick={handleBulkPreview} disabled={contactsSubmitting || !bulkGdprAcknowledged || !bulkText.trim()} data-testid="button-preview-external-import">
                    {contactsSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Validate import
                  </Button>
                  {bulkOutcomes.length > 0 && (
                    <div className="space-y-2" data-testid="external-import-preview">
                      <p className="text-xs font-medium text-slate-700">Authoritative validation · {bulkOutcomes.length} rows</p>
                      <div className="max-h-44 overflow-y-auto rounded border border-slate-200">
                        {bulkOutcomes.map((outcome) => <div key={`${outcome.rowNumber}-${outcome.email}`} className="px-2 py-1.5 border-b last:border-0 text-xs flex gap-2 justify-between"><span className="truncate">{outcome.rowNumber}. {outcome.email || 'No email'}</span><Badge variant={outcome.status === 'valid' ? 'secondary' : 'outline'} className="text-[10px]">{outcome.status.replace(/_/g, ' ')}</Badge>{outcome.error && <span className="text-red-600">{outcome.error}</span>}</div>)}
                      </div>
                      <Button className="w-full" onClick={handleBulkConfirm} disabled={contactsSubmitting || !bulkOutcomes.some((outcome) => outcome.status === 'valid')} data-testid="button-confirm-external-import">
                        {contactsSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Confirm and store valid contacts
                      </Button>
                    </div>
                  )}
                </div>
              </section>
            </div>
            <DialogFooter><Button variant="outline" onClick={() => setExternalContactsList(null)} data-testid="button-close-external-contacts">Done</Button></DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showEditListDialog} onOpenChange={setShowEditListDialog}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>{editingList ? 'Edit List' : 'Create List'}</DialogTitle>
              <DialogDescription>
                {editingList ? 'Update the name or audience segments for this list.' : 'Define a reusable audience list for your email campaigns. You can save without segments and add external contacts afterwards.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2 overflow-y-auto flex-1 min-h-0">
              <div className="space-y-2">
                <Label>List Name</Label>
                <Input
                  value={editListName}
                  onChange={(e) => setEditListName(e.target.value)}
                  placeholder="e.g. AGM Attendees, Newsletter Audience"
                  data-testid="input-edit-list-name"
                />
              </div>
              <div className="rounded-md border border-warning/40 bg-warning/10 p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="switch-ignore-opt-outs" className="text-sm font-medium text-warning">
                      Send to everyone, ignoring opt-out choices
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Bypasses both global and category opt-outs for everyone on this list. Only use for transactional / operationally-required messages (e.g. dietary requirements for a paid event), never for marketing.
                    </p>
                  </div>
                  <Switch
                    id="switch-ignore-opt-outs"
                    checked={editListIgnoreOptOuts}
                    onCheckedChange={setEditListIgnoreOptOuts}
                    data-testid="switch-ignore-opt-outs"
                  />
                </div>
                {editListIgnoreOptOuts && (
                  <div className="flex items-start gap-2 text-xs text-warning" data-testid="text-ignore-opt-outs-warning">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-warning" />
                    <span>Members who have opted out of all communications or this category will still receive emails sent to this list.</span>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label>Audience Segments</Label>
                {editListAudiences.length > 0 && (
                  <div className="space-y-1">
                    {editListAudiences.map((segment, idx) => {
                      if (segment.type === 'individual_members') {
                        const memberIds = segment.ids || [];
                        const names = segment.names || {};
                        return (
                          <div key={idx} className="border rounded-md p-2 space-y-1" data-testid={`edit-list-segment-${idx}`}>
                            <div className="text-xs font-medium text-muted-foreground px-1">Individual Members ({memberIds.length})</div>
                            {memberIds.map(memberId => (
                              <div key={memberId} className="flex items-center justify-between gap-2 pl-1 pr-0.5 py-0.5 text-sm" data-testid={`edit-list-ind-member-${memberId}`}>
                                <span className="truncate">{names[memberId] || memberId}</span>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 shrink-0"
                                  onClick={() => {
                                    if (memberIds.length <= 1) {
                                      setEditListAudiences(prev => prev.filter((_, i) => i !== idx));
                                    } else {
                                      setEditListAudiences(prev => {
                                        const updated = [...prev];
                                        const newIds = (updated[idx].ids || []).filter(id => id !== memberId);
                                        const newNames = { ...(updated[idx].names || {}) };
                                        delete newNames[memberId];
                                        updated[idx] = { ...updated[idx], ids: newIds, names: newNames };
                                        return updated;
                                      });
                                    }
                                  }}
                                  data-testid={`button-remove-ind-member-${memberId}`}
                                >
                                  <X className="w-3 h-3" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        );
                      }
                      return (
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
                      );
                    })}
                  </div>
                )}

                {!showAddListSegment ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setAddListSegmentType('');
                      setAddListSegmentIds([]);
                      setAddListSegmentRoles([]);
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
                    <Select value={addListSegmentType} onValueChange={(v) => { setAddListSegmentType(v); setAddListSegmentIds([]); setAddListSegmentRoles([]); resetIndMemberSearch(); setFieldFilterGroups([{ conditions: [{ entity_scope: 'member', field_key: '', field_type: '', data_type: '', operator: '', value: '', field_label: '' }] }]); }}>
                      <SelectTrigger data-testid="select-add-list-segment-type">
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        {!editListAudiences.some(a => a.type === 'all_members') && (
                          <SelectItem value="all_members">All Members</SelectItem>
                        )}
                        <SelectItem value="communication_category">Categories</SelectItem>
                        <SelectItem value="member_group">Groups</SelectItem>
                        <SelectItem value="member_group_admins">Group Admins</SelectItem>
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
                        <SelectItem value="individual_members">Individual Members</SelectItem>
                        {audienceListEvents.length > 0 && (
                          <SelectItem value="event_attendees">Event Attendees</SelectItem>
                        )}
                        {eventLinkedForms.length > 0 && (
                          <SelectItem value="event_form">Event Form</SelectItem>
                        )}
                        <SelectItem value="field_filter">Field Filter</SelectItem>
                      </SelectContent>
                    </Select>

                    {addListSegmentType === 'individual_members' && (
                      <div className="border rounded-md p-2 space-y-2 bg-background">
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                          <Input
                            placeholder="Search by name or email..."
                            value={indMemberSearchInput}
                            onChange={(e) => {
                              setIndMemberSearchInput(e.target.value);
                              debouncedIndMemberSearch(e.target.value);
                            }}
                            className="pl-8 h-8 text-sm"
                            data-testid="input-ind-member-search"
                          />
                        </div>
                        {indMemberSearchLoading && (
                          <div className="text-xs text-muted-foreground py-1">Searching...</div>
                        )}
                        {indMemberSearchResults.length > 0 && (
                          <div className="max-h-28 overflow-y-auto space-y-0.5">
                            {indMemberSearchResults
                              .filter(m => !indSelectedMembers.some(s => s.id === m.id))
                              .map(m => (
                                <div
                                  key={m.id}
                                  className="flex items-center gap-2 p-1.5 rounded cursor-pointer hover-elevate text-sm"
                                  onClick={() => {
                                    setIndSelectedMembers(prev => [...prev, m]);
                                    setAddListSegmentIds(prev => [...prev, m.id]);
                                    setIndMemberSearchInput('');
                                    setIndMemberSearchResults([]);
                                  }}
                                  data-testid={`ind-member-result-${m.id}`}
                                >
                                  <Plus className="w-3 h-3 text-muted-foreground" />
                                  <span>{m.first_name} {m.last_name}</span>
                                  <span className="text-xs text-muted-foreground">{m.email}</span>
                                </div>
                              ))}
                          </div>
                        )}
                        {indSelectedMembers.length > 0 && (
                          <div className="space-y-0.5 border-t pt-1">
                            {indSelectedMembers.map(m => (
                              <div key={m.id} className="flex items-center justify-between gap-2 p-1 text-sm" data-testid={`ind-member-selected-${m.id}`}>
                                <span>{m.first_name} {m.last_name} <span className="text-xs text-muted-foreground">{m.email}</span></span>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-5 w-5"
                                  onClick={() => {
                                    setIndSelectedMembers(prev => prev.filter(s => s.id !== m.id));
                                    setAddListSegmentIds(prev => prev.filter(i => i !== m.id));
                                  }}
                                  data-testid={`button-remove-ind-member-${m.id}`}
                                >
                                  <X className="w-3 h-3" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {addListSegmentType === 'event_attendees' && (
                      <div className="border rounded-md p-2 space-y-2 bg-background">
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                          <Input
                            placeholder="Search events by title..."
                            value={eventSearchInput}
                            onChange={(e) => setEventSearchInput(e.target.value)}
                            className="pl-8 h-8 text-sm"
                            data-testid="input-event-search"
                          />
                        </div>
                        <div className="max-h-40 overflow-y-auto space-y-0.5">
                          {audienceListEvents
                            .filter(ev => !selectedEvents.some(s => s.id === ev.id))
                            .filter(ev => !eventSearchInput || (ev.title || '').toLowerCase().includes(eventSearchInput.toLowerCase()))
                            .slice(0, 50)
                            .map(ev => (
                              <div
                                key={ev.id}
                                className="flex items-center gap-2 p-1.5 rounded cursor-pointer hover-elevate text-sm"
                                onClick={() => {
                                  setSelectedEvents(prev => [...prev, ev]);
                                  setAddListSegmentIds(prev => [...prev, ev.id]);
                                  setEventSearchInput('');
                                  fetchEventTicketTypes(ev.id);
                                  // Hydrate saved per-event selections from the existing
                                  // segment so re-adding an event doesn't silently reset
                                  // its ticket-type / attendance filters on save.
                                  const savedSeg = editListAudiences.find(a => a.type === 'event_attendees' && (a.ids || []).includes(ev.id));
                                  if (savedSeg) {
                                    const savedTicketSel = savedSeg.ticket_type_selection?.[ev.id];
                                    if (Array.isArray(savedTicketSel) && savedTicketSel.length > 0) {
                                      setEventTicketTypeSelections(prev => (prev[ev.id] !== undefined ? prev : { ...prev, [ev.id]: savedTicketSel }));
                                    }
                                    const savedAtt = savedSeg.attendance_selection?.[ev.id];
                                    if (savedAtt === 'attended' || savedAtt === 'not_attended') {
                                      setEventAttendanceSelections(prev => (prev[ev.id] !== undefined ? prev : { ...prev, [ev.id]: savedAtt }));
                                    }
                                  }
                                }}
                                data-testid={`event-result-${ev.id}`}
                              >
                                <Plus className="w-3 h-3 text-muted-foreground shrink-0" />
                                <span className="truncate">{ev.title}</span>
                                {ev.status && (
                                  <Badge variant="secondary" className="text-[10px] ml-1 shrink-0">{ev.status}</Badge>
                                )}
                                {ev.start_date && (
                                  <span className="text-xs text-muted-foreground ml-auto shrink-0">{formatEventDate(ev.start_date)}</span>
                                )}
                              </div>
                            ))}
                          {audienceListEvents.length === 0 && (
                            <div className="text-xs text-muted-foreground py-1">No events available</div>
                          )}
                        </div>
                        {selectedEvents.length > 0 && (
                          <div className="space-y-1.5 border-t pt-1.5">
                            {selectedEvents.map(ev => {
                              const ticketTypes = eventTicketTypesCache[ev.id] || [];
                              const isLoadingTt = eventTicketTypesLoading[ev.id];
                              const currentSel = eventTicketTypeSelections[ev.id];
                              const selectedNames = Array.isArray(currentSel) ? currentSel.map(tc => tc.name) : [];

                              const toggleTicketType = (tc) => {
                                setEventTicketTypeSelections(prev => {
                                  const cur = Array.isArray(prev[ev.id]) ? prev[ev.id] : [];
                                  const exists = cur.some(s => s.name === tc.name);
                                  if (exists) {
                                    const next = cur.filter(s => s.name !== tc.name);
                                    return { ...prev, [ev.id]: next.length === 0 ? 'all' : next };
                                  }
                                  return { ...prev, [ev.id]: [...cur, tc] };
                                });
                              };

                              const setAllTicketTypes = () => {
                                setEventTicketTypeSelections(prev => ({ ...prev, [ev.id]: 'all' }));
                              };

                              return (
                                <div key={ev.id} className="rounded-md border bg-muted/20 p-1.5 space-y-1" data-testid={`event-selected-${ev.id}`}>
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm truncate flex items-center gap-1.5">
                                      <span className="truncate">{ev.title}</span>
                                      {ev.status && <Badge variant="secondary" className="text-[10px] shrink-0">{ev.status}</Badge>}
                                      {ev.start_date && <span className="text-xs text-muted-foreground shrink-0">({formatEventDate(ev.start_date)})</span>}
                                    </span>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-5 w-5 shrink-0"
                                      onClick={() => {
                                        setSelectedEvents(prev => prev.filter(s => s.id !== ev.id));
                                        setAddListSegmentIds(prev => prev.filter(i => i !== ev.id));
                                        setEventTicketTypeSelections(prev => { const n = { ...prev }; delete n[ev.id]; return n; });
                                        setEventAttendanceSelections(prev => { const n = { ...prev }; delete n[ev.id]; return n; });
                                      }}
                                      data-testid={`button-remove-event-${ev.id}`}
                                    >
                                      <X className="w-3 h-3" />
                                    </Button>
                                  </div>
                                  {isLoadingTt && (
                                    <div className="text-xs text-muted-foreground px-1 flex items-center gap-1">
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                      Loading ticket types...
                                    </div>
                                  )}
                                  {!isLoadingTt && ticketTypes.length > 0 && (
                                    <div className="pl-1 space-y-0.5" data-testid={`event-ticket-types-${ev.id}`}>
                                      <div
                                        className="flex items-center gap-1.5 cursor-pointer"
                                        onClick={setAllTicketTypes}
                                        data-testid={`ticket-type-all-${ev.id}`}
                                      >
                                        <Checkbox
                                          checked={!currentSel || currentSel === 'all' || selectedNames.length === 0}
                                          onCheckedChange={setAllTicketTypes}
                                          className="h-3 w-3"
                                        />
                                        <span className="text-xs text-muted-foreground">All ticket types</span>
                                      </div>
                                      {ticketTypes.map(tc => (
                                        <div
                                          key={tc.name}
                                          className="flex items-center gap-1.5 cursor-pointer"
                                          onClick={() => toggleTicketType(tc)}
                                          data-testid={`ticket-type-${ev.id}-${tc.id}`}
                                        >
                                          <Checkbox
                                            checked={selectedNames.includes(tc.name)}
                                            onCheckedChange={() => toggleTicketType(tc)}
                                            className="h-3 w-3"
                                          />
                                          <span className="text-xs">{tc.name}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  <div className="pl-1 pt-0.5 flex items-center gap-1.5" data-testid={`event-attendance-${ev.id}`}>
                                    <span className="text-xs text-muted-foreground shrink-0">Attendance:</span>
                                    <Select
                                      value={eventAttendanceSelections[ev.id] || 'all'}
                                      onValueChange={(val) => {
                                        setEventAttendanceSelections(prev => {
                                          const n = { ...prev };
                                          if (val === 'all') delete n[ev.id];
                                          else n[ev.id] = val;
                                          return n;
                                        });
                                      }}
                                    >
                                      <SelectTrigger className="h-7 text-xs w-40" data-testid={`select-attendance-${ev.id}`}>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="all">All bookings</SelectItem>
                                        <SelectItem value="attended">Attended</SelectItem>
                                        <SelectItem value="not_attended">Did not attend</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {addListSegmentType === 'event_form' && (
                      <div className="border rounded-md p-2 space-y-2 bg-background">
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                          <Input
                            placeholder="Search forms by name..."
                            value={eventFormSearchInput}
                            onChange={(e) => setEventFormSearchInput(e.target.value)}
                            className="pl-8 h-8 text-sm"
                            data-testid="input-event-form-search"
                          />
                        </div>
                        <div className="max-h-40 overflow-y-auto space-y-0.5">
                          {eventLinkedForms
                            .filter(f => selectedEventForm?.id !== f.id)
                            .filter(f => !eventFormSearchInput || (f.name || '').toLowerCase().includes(eventFormSearchInput.toLowerCase()))
                            .slice(0, 50)
                            .map(f => (
                              <div
                                key={f.id}
                                className="flex items-center gap-2 p-1.5 rounded cursor-pointer hover-elevate text-sm"
                                onClick={() => {
                                  setSelectedEventForm(f);
                                  setEventFormSearchInput('');
                                }}
                                data-testid={`event-form-result-${f.id}`}
                              >
                                <Plus className="w-3 h-3 text-muted-foreground shrink-0" />
                                <span className="truncate">{f.name}</span>
                                {eventLookup[f.related_event_id] && (
                                  <span className="text-xs text-muted-foreground ml-auto shrink-0 truncate">{eventLookup[f.related_event_id]}</span>
                                )}
                              </div>
                            ))}
                          {eventLinkedForms.length === 0 && (
                            <div className="text-xs text-muted-foreground py-1">No event-linked forms available</div>
                          )}
                        </div>
                        {selectedEventForm && (
                          <div className="space-y-2 border-t pt-2">
                            <div className="flex items-center justify-between gap-2 p-1 text-sm" data-testid={`event-form-selected-${selectedEventForm.id}`}>
                              <span className="truncate flex items-center gap-1.5">
                                <span className="truncate">{selectedEventForm.name}</span>
                                {eventLookup[selectedEventForm.related_event_id] && (
                                  <span className="text-xs text-muted-foreground shrink-0">({eventLookup[selectedEventForm.related_event_id]})</span>
                                )}
                              </span>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 shrink-0"
                                onClick={() => setSelectedEventForm(null)}
                                data-testid="button-remove-event-form"
                              >
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                variant={addListEventFormReceived ? 'default' : 'outline'}
                                size="sm"
                                className="flex-1"
                                onClick={() => setAddListEventFormReceived(true)}
                                data-testid="button-event-form-received"
                              >
                                Received
                              </Button>
                              <Button
                                type="button"
                                variant={!addListEventFormReceived ? 'default' : 'outline'}
                                size="sm"
                                className="flex-1"
                                onClick={() => setAddListEventFormReceived(false)}
                                data-testid="button-event-form-not-received"
                              >
                                Not Received
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {addListSegmentType === 'field_filter' && filterableFields && (
                      <div className="border rounded-md p-2 space-y-3 bg-background">
                        {fieldFilterGroups.map((group, gIdx) => (
                          <div key={gIdx} className="space-y-2">
                            {gIdx > 0 && (
                              <div className="flex items-center gap-2">
                                <div className="flex-1 border-t" />
                                <Badge variant="secondary" className="text-xs">OR</Badge>
                                <div className="flex-1 border-t" />
                              </div>
                            )}
                            <div className="space-y-2 border rounded-md p-2 bg-muted/10">
                              {group.conditions.map((cond, cIdx) => {
                                const scopeFields = cond.entity_scope === 'organization'
                                  ? [...(filterableFields.organization?.core || []), ...(filterableFields.organization?.custom || [])]
                                  : cond.entity_scope === 'event'
                                  ? [...(filterableFields.event?.core || []), ...(filterableFields.event?.custom || [])]
                                  : [...(filterableFields.member?.core || []), ...(filterableFields.member?.custom || [])];
                                const selectedField = scopeFields.find(f => f.key === cond.field_key);
                                const operators = getOperatorsForDataType(selectedField?.data_type || cond.data_type || 'text');
                                const needsValue = !['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(cond.operator);
                                const isPicklist = selectedField?.data_type === 'picklist' || selectedField?.data_type === 'dropdown';
                                const isMultiSelect = isMultiSelectDataType(selectedField?.data_type);
                                const isEventField = selectedField?.data_type === 'event_id' || cond.data_type === 'event_id';
                                const fieldOptions = selectedField?.options || [];
                                const eventScopeCore = filterableFields.event?.core || [];
                                const eventScopeCustom = filterableFields.event?.custom || [];
                                const scopeCore = cond.entity_scope === 'member'
                                  ? filterableFields.member?.core
                                  : cond.entity_scope === 'organization'
                                  ? filterableFields.organization?.core
                                  : eventScopeCore;
                                const scopeCustom = cond.entity_scope === 'member'
                                  ? filterableFields.member?.custom
                                  : cond.entity_scope === 'organization'
                                  ? filterableFields.organization?.custom
                                  : eventScopeCustom;
                                const selectedEventValueIds = Array.isArray(cond.value) ? cond.value : (cond.value ? [cond.value] : []);
                                const selectedEventValueObjects = selectedEventValueIds
                                  .map(id => audienceListEvents.find(ev => ev.id === id) || (cond.value_names && cond.value_names[id] ? { id, title: cond.value_names[id] } : { id, title: id }));

                                return (
                                  <div key={cIdx} className="space-y-1.5">
                                    {cIdx > 0 && <div className="text-xs text-muted-foreground font-medium px-1">AND</div>}
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <Select
                                        value={cond.entity_scope}
                                        onValueChange={(v) => {
                                          setFieldFilterGroups(prev => {
                                            const updated = JSON.parse(JSON.stringify(prev));
                                            updated[gIdx].conditions[cIdx] = { entity_scope: v, field_key: '', field_type: '', data_type: '', operator: '', value: '', field_label: '' };
                                            return updated;
                                          });
                                        }}
                                      >
                                        <SelectTrigger className="w-[110px] h-8 text-xs" data-testid={`select-filter-scope-${gIdx}-${cIdx}`}>
                                          <SelectValue placeholder="Scope" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="member">Member</SelectItem>
                                          <SelectItem value="organization">Organisation</SelectItem>
                                          <SelectItem value="event">Event</SelectItem>
                                        </SelectContent>
                                      </Select>
                                      <Select
                                        value={cond.field_key}
                                        onValueChange={(v) => {
                                          const field = scopeFields.find(f => f.key === v);
                                          setFieldFilterGroups(prev => {
                                            const updated = JSON.parse(JSON.stringify(prev));
                                            updated[gIdx].conditions[cIdx] = {
                                              ...updated[gIdx].conditions[cIdx],
                                              field_key: v,
                                              field_type: field?.field_type || 'core',
                                              data_type: field?.data_type || 'text',
                                              field_label: field?.label || v,
                                              operator: '',
                                              value: '',
                                            };
                                            return updated;
                                          });
                                        }}
                                      >
                                        <SelectTrigger className="flex-1 min-w-[120px] h-8 text-xs" data-testid={`select-filter-field-${gIdx}-${cIdx}`}>
                                          <SelectValue placeholder="Select field" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {scopeFields.length === 0 && <SelectItem value="_none" disabled>No fields available</SelectItem>}
                                          {scopeCore?.length > 0 && (
                                            <>
                                              <SelectItem value="_core_label" disabled className="text-xs font-semibold text-muted-foreground">Core Fields</SelectItem>
                                              {scopeCore.map(f => (
                                                <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                                              ))}
                                            </>
                                          )}
                                          {scopeCustom?.length > 0 && (
                                            <>
                                              <SelectItem value="_custom_label" disabled className="text-xs font-semibold text-muted-foreground">Custom Fields</SelectItem>
                                              {scopeCustom.map(f => (
                                                <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                                              ))}
                                            </>
                                          )}
                                        </SelectContent>
                                      </Select>
                                      {cond.field_key && (
                                        <Select
                                          value={cond.operator}
                                          onValueChange={(v) => {
                                            setFieldFilterGroups(prev => {
                                              const updated = JSON.parse(JSON.stringify(prev));
                                              updated[gIdx].conditions[cIdx].operator = v;
                                              if (['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(v)) {
                                                updated[gIdx].conditions[cIdx].value = '';
                                              }
                                              return updated;
                                            });
                                          }}
                                        >
                                          <SelectTrigger className="w-[120px] h-8 text-xs" data-testid={`select-filter-operator-${gIdx}-${cIdx}`}>
                                            <SelectValue placeholder="Operator" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {operators.map(op => (
                                              <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      )}
                                      {cond.operator && needsValue && (
                                        isEventField ? (
                                          <div className="flex-1 min-w-[200px] border rounded-md p-1.5 space-y-1 bg-background" data-testid={`event-filter-value-${gIdx}-${cIdx}`}>
                                            <div className="relative">
                                              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                                              <Input
                                                placeholder="Search events..."
                                                value={eventFilterSearches[`${gIdx}-${cIdx}`] || ''}
                                                onChange={(e) => setEventFilterSearches(prev => ({ ...prev, [`${gIdx}-${cIdx}`]: e.target.value }))}
                                                className="pl-7 h-7 text-xs"
                                                data-testid={`input-event-filter-search-${gIdx}-${cIdx}`}
                                              />
                                            </div>
                                            <div className="max-h-32 overflow-y-auto space-y-0.5">
                                              {audienceListEvents
                                                .filter(ev => !selectedEventValueIds.includes(ev.id))
                                                .filter(ev => {
                                                  const term = (eventFilterSearches[`${gIdx}-${cIdx}`] || '').toLowerCase();
                                                  if (!term) return true;
                                                  return (ev.title || '').toLowerCase().includes(term);
                                                })
                                                .slice(0, 50)
                                                .map(ev => (
                                                  <div
                                                    key={ev.id}
                                                    className="flex items-center gap-1.5 p-1 rounded cursor-pointer hover-elevate text-xs"
                                                    onClick={() => {
                                                      setFieldFilterGroups(prev => {
                                                        const updated = JSON.parse(JSON.stringify(prev));
                                                        const c = updated[gIdx].conditions[cIdx];
                                                        const arr = Array.isArray(c.value) ? [...c.value] : [];
                                                        arr.push(ev.id);
                                                        c.value = arr;
                                                        c.value_names = { ...(c.value_names || {}), [ev.id]: ev.title };
                                                        return updated;
                                                      });
                                                      setEventFilterSearches(prev => ({ ...prev, [`${gIdx}-${cIdx}`]: '' }));
                                                    }}
                                                    data-testid={`event-filter-result-${gIdx}-${cIdx}-${ev.id}`}
                                                  >
                                                    <Plus className="w-3 h-3 text-muted-foreground shrink-0" />
                                                    <span className="truncate">{ev.title}</span>
                                                    {ev.start_date && (
                                                      <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{formatEventDate(ev.start_date)}</span>
                                                    )}
                                                  </div>
                                                ))}
                                              {audienceListEvents.length === 0 && (
                                                <div className="text-[11px] text-muted-foreground py-1 px-1">No events available</div>
                                              )}
                                            </div>
                                            {selectedEventValueObjects.length > 0 && (
                                              <div className="space-y-0.5 border-t pt-1">
                                                {selectedEventValueObjects.map(ev => (
                                                  <div key={ev.id} className="flex items-center justify-between gap-1.5 p-1 text-xs" data-testid={`event-filter-selected-${gIdx}-${cIdx}-${ev.id}`}>
                                                    <span className="truncate flex items-center gap-1">
                                                      <span className="truncate">{ev.title}</span>
                                                      {ev.start_date && <span className="text-[10px] text-muted-foreground shrink-0">({formatEventDate(ev.start_date)})</span>}
                                                    </span>
                                                    <Button
                                                      variant="ghost"
                                                      size="icon"
                                                      className="h-5 w-5 shrink-0"
                                                      onClick={() => {
                                                        setFieldFilterGroups(prev => {
                                                          const updated = JSON.parse(JSON.stringify(prev));
                                                          const c = updated[gIdx].conditions[cIdx];
                                                          const arr = (Array.isArray(c.value) ? c.value : []).filter(id => id !== ev.id);
                                                          c.value = arr;
                                                          if (c.value_names) {
                                                            const names = { ...c.value_names };
                                                            delete names[ev.id];
                                                            c.value_names = names;
                                                          }
                                                          return updated;
                                                        });
                                                      }}
                                                      data-testid={`button-remove-event-filter-${gIdx}-${cIdx}-${ev.id}`}
                                                    >
                                                      <X className="w-3 h-3" />
                                                    </Button>
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        ) : isMultiSelect && cond.operator === 'contains' && fieldOptions.length > 0 ? (
                                          <div className="flex-1 min-w-[100px] border rounded-md p-1.5 max-h-24 overflow-y-auto space-y-0.5 bg-background" data-testid={`checklist-filter-multivalue-${gIdx}-${cIdx}`}>
                                            {fieldOptions.map((opt, oIdx) => {
                                              const optVal = String(typeof opt === 'object' ? (opt.value || opt.label) : opt);
                                              const optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                                              const currentArr = Array.isArray(cond.value) ? cond.value : (cond.value ? [cond.value] : []);
                                              return (
                                                <label key={oIdx} className="flex items-center gap-1.5 cursor-pointer text-xs">
                                                  <input type="checkbox" className="rounded" checked={currentArr.includes(optVal)}
                                                    onChange={(e) => {
                                                      setFieldFilterGroups(prev => {
                                                        const updated = JSON.parse(JSON.stringify(prev));
                                                        const arr = Array.isArray(updated[gIdx].conditions[cIdx].value) ? [...updated[gIdx].conditions[cIdx].value] : (updated[gIdx].conditions[cIdx].value ? [updated[gIdx].conditions[cIdx].value] : []);
                                                        if (e.target.checked) arr.push(optVal);
                                                        else arr.splice(arr.indexOf(optVal), 1);
                                                        updated[gIdx].conditions[cIdx].value = arr;
                                                        return updated;
                                                      });
                                                    }}
                                                  />
                                                  <span>{optLabel}</span>
                                                </label>
                                              );
                                            })}
                                          </div>
                                        ) : isPicklist && cond.operator === 'is_one_of' ? (
                                          <div className="flex-1 min-w-[100px] border rounded-md p-1.5 max-h-24 overflow-y-auto space-y-0.5 bg-background" data-testid={`checklist-filter-value-${gIdx}-${cIdx}`}>
                                            {fieldOptions.map((opt, oIdx) => {
                                              const optVal = String(typeof opt === 'object' ? (opt.value || opt.label) : opt);
                                              const optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                                              const currentArr = Array.isArray(cond.value) ? cond.value : [];
                                              return (
                                                <label key={oIdx} className="flex items-center gap-1.5 cursor-pointer text-xs">
                                                  <input type="checkbox" className="rounded" checked={currentArr.includes(optVal)}
                                                    onChange={(e) => {
                                                      setFieldFilterGroups(prev => {
                                                        const updated = JSON.parse(JSON.stringify(prev));
                                                        const arr = Array.isArray(updated[gIdx].conditions[cIdx].value) ? [...updated[gIdx].conditions[cIdx].value] : [];
                                                        if (e.target.checked) arr.push(optVal);
                                                        else arr.splice(arr.indexOf(optVal), 1);
                                                        updated[gIdx].conditions[cIdx].value = arr;
                                                        return updated;
                                                      });
                                                    }}
                                                  />
                                                  <span>{optLabel}</span>
                                                </label>
                                              );
                                            })}
                                          </div>
                                        ) : isPicklist ? (
                                          <Select
                                            value={Array.isArray(cond.value) ? cond.value[0] || '' : cond.value}
                                            onValueChange={(v) => {
                                              setFieldFilterGroups(prev => {
                                                const updated = JSON.parse(JSON.stringify(prev));
                                                updated[gIdx].conditions[cIdx].value = v;
                                                return updated;
                                              });
                                            }}
                                          >
                                            <SelectTrigger className="flex-1 min-w-[100px] h-8 text-xs" data-testid={`select-filter-value-${gIdx}-${cIdx}`}>
                                              <SelectValue placeholder="Select value" />
                                            </SelectTrigger>
                                            <SelectContent>
                                              {fieldOptions.map((opt, oIdx) => {
                                                const optVal = typeof opt === 'object' ? (opt.value || opt.label) : opt;
                                                const optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                                                return <SelectItem key={oIdx} value={String(optVal)}>{optLabel}</SelectItem>;
                                              })}
                                            </SelectContent>
                                          </Select>
                                        ) : selectedField?.data_type === 'date' ? (
                                          <Input
                                            type="date"
                                            value={cond.value || ''}
                                            onChange={(e) => {
                                              setFieldFilterGroups(prev => {
                                                const updated = JSON.parse(JSON.stringify(prev));
                                                updated[gIdx].conditions[cIdx].value = e.target.value;
                                                return updated;
                                              });
                                            }}
                                            className="flex-1 min-w-[120px] h-8 text-xs"
                                            data-testid={`input-filter-value-${gIdx}-${cIdx}`}
                                          />
                                        ) : (
                                          <Input
                                            type={selectedField?.data_type === 'number' || selectedField?.data_type === 'decimal' ? 'number' : 'text'}
                                            placeholder="Value"
                                            value={cond.value || ''}
                                            onChange={(e) => {
                                              setFieldFilterGroups(prev => {
                                                const updated = JSON.parse(JSON.stringify(prev));
                                                updated[gIdx].conditions[cIdx].value = e.target.value;
                                                return updated;
                                              });
                                            }}
                                            className="flex-1 min-w-[100px] h-8 text-xs"
                                            data-testid={`input-filter-value-${gIdx}-${cIdx}`}
                                          />
                                        )
                                      )}
                                      {group.conditions.length > 1 && (
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6 shrink-0"
                                          onClick={() => {
                                            setFieldFilterGroups(prev => {
                                              const updated = JSON.parse(JSON.stringify(prev));
                                              updated[gIdx].conditions.splice(cIdx, 1);
                                              return updated;
                                            });
                                          }}
                                          data-testid={`button-remove-condition-${gIdx}-${cIdx}`}
                                        >
                                          <X className="w-3 h-3" />
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                              <div className="flex items-center gap-2 pt-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-xs"
                                  onClick={() => {
                                    setFieldFilterGroups(prev => {
                                      const updated = JSON.parse(JSON.stringify(prev));
                                      updated[gIdx].conditions.push({ entity_scope: 'member', field_key: '', field_type: '', data_type: '', operator: '', value: '', field_label: '' });
                                      return updated;
                                    });
                                  }}
                                  data-testid={`button-add-condition-${gIdx}`}
                                >
                                  <Plus className="w-3 h-3 mr-1" />
                                  AND condition
                                </Button>
                                {fieldFilterGroups.length > 1 && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs text-destructive"
                                    onClick={() => {
                                      setFieldFilterGroups(prev => prev.filter((_, i) => i !== gIdx));
                                    }}
                                    data-testid={`button-remove-group-${gIdx}`}
                                  >
                                    <Trash2 className="w-3 h-3 mr-1" />
                                    Remove group
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs w-full"
                          onClick={() => {
                            setFieldFilterGroups(prev => [...prev, { conditions: [{ entity_scope: 'member', field_key: '', field_type: '', data_type: '', operator: '', value: '', field_label: '' }] }]);
                          }}
                          data-testid="button-add-filter-group"
                        >
                          <Plus className="w-3 h-3 mr-1" />
                          OR group
                        </Button>
                      </div>
                    )}

                    {addListSegmentType && addListSegmentType !== 'all_members' && addListSegmentType !== 'individual_members' && addListSegmentType !== 'field_filter' && addListSegmentType !== 'event_form' && (
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
                                const newIds = e.target.checked
                                  ? [...addListSegmentIds, group.id]
                                  : addListSegmentIds.filter(i => i !== group.id);
                                setAddListSegmentIds(newIds);
                                // Drop any selected roles no longer offered by the remaining groups.
                                const stillAvailable = new Set(
                                  memberGroups
                                    .filter(g => newIds.includes(g.id) && Array.isArray(g.roles))
                                    .flatMap(g => g.roles)
                                );
                                setAddListSegmentRoles(prev => prev.filter(r => stillAvailable.has(r)));
                              }} className="rounded" data-testid={`checkbox-group-${group.id}`} />
                            <span className="text-sm">{group.name}</span>
                          </label>
                        ))}
                        {addListSegmentType === 'member_group_admins' && memberGroups.map(group => (
                          <label key={group.id} className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={addListSegmentIds.includes(group.id)}
                              onChange={(e) => {
                                if (e.target.checked) setAddListSegmentIds(prev => [...prev, group.id]);
                                else setAddListSegmentIds(prev => prev.filter(i => i !== group.id));
                              }} className="rounded" data-testid={`checkbox-group-admins-${group.id}`} />
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

                    {addListSegmentType === 'member_group' && addListSegmentIds.length > 0 && availableGroupRoles.length > 0 && (
                      <div className="space-y-1">
                        <Label className="text-xs font-medium text-muted-foreground">Roles (optional — leave empty to include everyone in the selected groups)</Label>
                        <div className="border rounded-md p-2 max-h-32 overflow-y-auto space-y-1 bg-background">
                          {availableGroupRoles.map(roleName => (
                            <label key={roleName} className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={addListSegmentRoles.includes(roleName)}
                                onChange={(e) => {
                                  if (e.target.checked) setAddListSegmentRoles(prev => [...prev, roleName]);
                                  else setAddListSegmentRoles(prev => prev.filter(r => r !== roleName));
                                }} className="rounded" data-testid={`checkbox-group-role-${roleName}`} />
                              <span className="text-sm">{roleName}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {addListSegmentType && (
                      <Button
                        size="sm"
                        onClick={() => {
                          if (addListSegmentType === 'all_members') {
                            setEditListAudiences(prev => [...prev, { type: 'all_members', ids: [] }]);
                          } else if (addListSegmentType === 'field_filter') {
                            const noValueOps = ['is_empty', 'is_not_empty', 'is_true', 'is_false'];
                            const validGroups = fieldFilterGroups
                              .map(g => ({
                                conditions: g.conditions.filter(c => c.field_key && c.operator && (noValueOps.includes(c.operator) || (c.value !== '' && c.value !== undefined && c.value !== null && (!Array.isArray(c.value) || c.value.length > 0))))
                              }))
                              .filter(g => g.conditions.length > 0);
                            if (validGroups.length > 0) {
                              setEditListAudiences(prev => [...prev, { type: 'field_filter', ids: [], filter_groups: validGroups }]);
                            }
                          } else if (addListSegmentType === 'event_attendees' && selectedEvents.length > 0) {
                            const newNames = {};
                            selectedEvents.forEach(ev => { newNames[ev.id] = ev.title; });
                            const newTicketSel = {};
                            const newAttendanceSel = {};
                            selectedEvents.forEach(ev => {
                              const sel = eventTicketTypeSelections[ev.id];
                              if (Array.isArray(sel) && sel.length > 0) {
                                newTicketSel[ev.id] = sel;
                              }
                              const att = eventAttendanceSelections[ev.id];
                              if (att === 'attended' || att === 'not_attended') {
                                newAttendanceSel[ev.id] = att;
                              }
                            });
                            const existingIdx = editListAudiences.findIndex(a => a.type === 'event_attendees');
                            if (existingIdx >= 0) {
                              setEditListAudiences(prev => {
                                const updated = [...prev];
                                const existing = new Set(updated[existingIdx].ids || []);
                                const existingNames = { ...(updated[existingIdx].names || {}) };
                                const existingTicketSel = { ...(updated[existingIdx].ticket_type_selection || {}) };
                                const existingAttendanceSel = { ...(updated[existingIdx].attendance_selection || {}) };
                                selectedEvents.forEach(ev => {
                                  existing.add(ev.id);
                                  existingNames[ev.id] = ev.title;
                                  const sel = eventTicketTypeSelections[ev.id];
                                  if (Array.isArray(sel) && sel.length > 0) {
                                    existingTicketSel[ev.id] = sel;
                                  } else {
                                    delete existingTicketSel[ev.id];
                                  }
                                  const att = eventAttendanceSelections[ev.id];
                                  if (att === 'attended' || att === 'not_attended') {
                                    existingAttendanceSel[ev.id] = att;
                                  } else {
                                    delete existingAttendanceSel[ev.id];
                                  }
                                });
                                const updatedSeg = { ...updated[existingIdx], ids: [...existing], names: existingNames };
                                if (Object.keys(existingTicketSel).length > 0) {
                                  updatedSeg.ticket_type_selection = existingTicketSel;
                                } else {
                                  delete updatedSeg.ticket_type_selection;
                                }
                                if (Object.keys(existingAttendanceSel).length > 0) {
                                  updatedSeg.attendance_selection = existingAttendanceSel;
                                } else {
                                  delete updatedSeg.attendance_selection;
                                }
                                updated[existingIdx] = updatedSeg;
                                return updated;
                              });
                            } else {
                              const seg = { type: 'event_attendees', ids: selectedEvents.map(ev => ev.id), names: newNames };
                              if (Object.keys(newTicketSel).length > 0) seg.ticket_type_selection = newTicketSel;
                              if (Object.keys(newAttendanceSel).length > 0) seg.attendance_selection = newAttendanceSel;
                              setEditListAudiences(prev => [...prev, seg]);
                            }
                          } else if (addListSegmentType === 'event_form' && selectedEventForm) {
                            setEditListAudiences(prev => [
                              ...prev,
                              {
                                type: 'event_form',
                                ids: [selectedEventForm.id],
                                received: addListEventFormReceived,
                                names: { [selectedEventForm.id]: selectedEventForm.name },
                              },
                            ]);
                          } else if (addListSegmentType === 'individual_members' && indSelectedMembers.length > 0) {
                            const newNames = {};
                            indSelectedMembers.forEach(m => { newNames[m.id] = `${m.first_name} ${m.last_name}`; });
                            const existingIdx = editListAudiences.findIndex(a => a.type === 'individual_members');
                            if (existingIdx >= 0) {
                              setEditListAudiences(prev => {
                                const updated = [...prev];
                                const existing = new Set(updated[existingIdx].ids || []);
                                const existingNames = { ...(updated[existingIdx].names || {}) };
                                indSelectedMembers.forEach(m => {
                                  existing.add(m.id);
                                  existingNames[m.id] = `${m.first_name} ${m.last_name}`;
                                });
                                updated[existingIdx] = { ...updated[existingIdx], ids: [...existing], names: existingNames };
                                return updated;
                              });
                            } else {
                              setEditListAudiences(prev => [...prev, { type: 'individual_members', ids: indSelectedMembers.map(m => m.id), names: newNames }]);
                            }
                          } else if (addListSegmentType === 'member_group' && addListSegmentIds.length > 0) {
                            const rolesToSave = addListSegmentRoles.filter(r => availableGroupRoles.includes(r));
                            const existingIdx = editListAudiences.findIndex(a => a.type === 'member_group');
                            if (existingIdx >= 0) {
                              setEditListAudiences(prev => {
                                const updated = [...prev];
                                const existing = new Set(updated[existingIdx].ids || []);
                                addListSegmentIds.forEach(id => existing.add(id));
                                const seg = { ...updated[existingIdx], ids: [...existing] };
                                if (rolesToSave.length > 0) seg.roles = rolesToSave;
                                else delete seg.roles;
                                updated[existingIdx] = seg;
                                return updated;
                              });
                            } else {
                              const seg = { type: 'member_group', ids: addListSegmentIds };
                              if (rolesToSave.length > 0) seg.roles = rolesToSave;
                              setEditListAudiences(prev => [...prev, seg]);
                            }
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
                          setAddListSegmentRoles([]);
                          resetIndMemberSearch();
                          setSelectedEvents([]);
                          setEventSearchInput('');
                          setSelectedEventForm(null);
                          setEventFormSearchInput('');
                          setAddListEventFormReceived(true);
                          setFieldFilterGroups([{ conditions: [{ entity_scope: 'member', field_key: '', field_type: '', data_type: '', operator: '', value: '', field_label: '' }] }]);
                        }}
                        disabled={
                          addListSegmentType === 'field_filter'
                            ? !fieldFilterGroups.some(g => g.conditions.some(c => {
                                if (!c.field_key || !c.operator) return false;
                                const noValueOps = ['is_empty', 'is_not_empty', 'is_true', 'is_false'];
                                if (noValueOps.includes(c.operator)) return true;
                                return c.value !== '' && c.value !== undefined && c.value !== null && (!Array.isArray(c.value) || c.value.length > 0);
                              }))
                            : addListSegmentType === 'individual_members'
                              ? indSelectedMembers.length === 0
                              : addListSegmentType === 'event_attendees'
                                ? selectedEvents.length === 0
                                : addListSegmentType === 'event_form'
                                  ? !selectedEventForm
                                  : (addListSegmentType !== 'all_members' && addListSegmentIds.length === 0)
                        }
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
                disabled={savingListEdit || !editListName.trim()}
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
