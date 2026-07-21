import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { apiRequest } from "@/lib/queryClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { evaluateTermLimit } from "@/lib/memberGroupTermSnapshot";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Users, Plus, Pencil, Trash2, UserPlus, X, Copy, ListPlus, CheckSquare, Calendar, Loader2, Crown, Tag, Mail, Send, RotateCw, CheckCircle2, XCircle, Clock, AlertTriangle, ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format } from "date-fns";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useMemberGroupSettings } from "@/hooks/useMemberGroupSettings";
import { buildTermSnapshot } from "@/lib/memberGroupTermSnapshot";
import { createPageUrl } from "@/utils";
import EventImageUpload from "@/components/events/EventImageUpload";
import SimpleRichTextEditor from "@/components/SimpleRichTextEditor";
import { sanitizeRichText } from "@/components/canvas/blocks/sanitize";

function isDuplicateClassificationError(error) {
  const msg = (error?.message || error?.error || '').toLowerCase();
  return (
    msg.includes('uq_member_group_classification_tenant_name') ||
    msg.includes('duplicate key') ||
    msg.includes('already exists') ||
    error?.code === '23505'
  );
}

function isDuplicateGroupNameError(error) {
  const msg = (error?.message || error?.error || '').toLowerCase();
  return (
    msg.includes('uq_member_group_tenant_name') ||
    msg.includes('duplicate key') ||
    msg.includes('already exists') ||
    error?.code === '23505'
  );
}

export default function MemberGroupManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const { featureName, allowGroupTermsOverride, defaultTermsOfReference } = useMemberGroupSettings();
  const [accessChecked, setAccessChecked] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [showAssignDialog, setShowAssignDialog] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteGroup, setInviteGroup] = useState(null);
  const [inviteForm, setInviteForm] = useState({ member_id: '', role: '' });
  const [inviteMemberSearch, setInviteMemberSearch] = useState('');
  // Advisory max-terms warning before sending a role invite (Task #1630).
  const [inviteTermWarning, setInviteTermWarning] = useState(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showBulkDialog, setShowBulkDialog] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [groupToDelete, setGroupToDelete] = useState(null);
  const [newRole, setNewRole] = useState('');
  const [selectedRoleForTerms, setSelectedRoleForTerms] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [showBulkRoles, setShowBulkRoles] = useState(false);
  const [bulkRolesText, setBulkRolesText] = useState('');
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [showBulkEditDialog, setShowBulkEditDialog] = useState(false);
  const [bulkEditAction, setBulkEditAction] = useState('add');
  const [bulkEditRole, setBulkEditRole] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(12);
  const [sortBy, setSortBy] = useState('name-asc');
  const [classificationFilter, setClassificationFilter] = useState('all');
  const [groupByClassification, setGroupByClassification] = useState(false);
  const [showClassificationDialog, setShowClassificationDialog] = useState(false);
  const [editingClassification, setEditingClassification] = useState(null);
  const [classificationName, setClassificationName] = useState('');
  const [classificationToDelete, setClassificationToDelete] = useState(null);
  const [membersModalGroupId, setMembersModalGroupId] = useState(null);
  const [torOpen, setTorOpen] = useState(false);
  const [groupForm, setGroupForm] = useState({
    name: '',
    description: '',
    roles: [],
    leadership_roles: [],
    is_active: true,
    header_image_url: '',
    allow_self_join: false,
    default_self_join_role: '',
    projects_enabled: false,
    projects_enabled_roles: [],
    events_enabled: false,
    complex_events_enabled: false,
    forum_enabled: false,
    forum_enabled_roles: [],
    classification_id: '',
    linkedin_url: '',
    terms_of_reference: '',
    role_terms_of_reference: {},
    role_terms_url: {},
    role_term_definitions: {},
    resource_subcategories: [],
    approval_email_template_id: '',
    decline_email_template_id: '',
    self_join_closed: false,
    self_join_closed_label: ''
  });
  const [groupSubcategorySearch, setGroupSubcategorySearch] = useState('');
  const [assignForm, setAssignForm] = useState({
    member_id: '',
    guest_id: '',
    group_role: '',
    expires_at: null,
    is_group_admin: false,
    term_start_date: '',
    term_end_date: '',
    term_number: ''
  });
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [debouncedMemberSearch, setDebouncedMemberSearch] = useState('');
  const [assignMode, setAssignMode] = useState(''); // 'guest', 'organization' or 'member'
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('');

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('membership.member-groups')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: groups = [], isLoading: loadingGroups } = useQuery({
    queryKey: ['member-groups'],
    queryFn: () => base44.entities.MemberGroup.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ['members-list'],
    queryFn: () => base44.entities.Member.listAll(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: assignments = [], isLoading: loadingAssignments } = useQuery({
    queryKey: ['member-group-assignments'],
    queryFn: () => base44.entities.MemberGroupAssignment.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: guests = [], isLoading: loadingGuests } = useQuery({
    queryKey: ['member-group-guests'],
    queryFn: () => base44.entities.MemberGroupGuest.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Set of member IDs that back a provisioned guest — used for de-duplication
  // and to identify guest assignments made via member_id (new flow).
  const guestMemberIds = React.useMemo(
    () => new Set(guests.filter((g) => g.member_id).map((g) => g.member_id)),
    [guests]
  );

  const { data: classifications = [], isLoading: loadingClassifications } = useQuery({
    queryKey: ['member-group-classifications'],
    queryFn: () => base44.entities.MemberGroupClassification.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Resource categories drive the per-group subcategory link selector
  // (Task #1701). Only fetched while the create/edit group dialog is open.
  const { data: resourceCategories = [] } = useQuery({
    queryKey: ['resource-categories-for-group-link'],
    queryFn: () => base44.entities.ResourceCategory.list(),
    enabled: showGroupDialog,
    staleTime: 0,
  });

  // Email templates power the group-level approval/decline decision pickers
  // (Task #1700). Both are optional.
  const { data: emailTemplates = [] } = useQuery({
    queryKey: ['email-templates-for-group-decisions'],
    queryFn: () => base44.entities.EmailTemplate.list(),
    staleTime: 5 * 60 * 1000,
  });

  // Organizations for the assign dialog
  const { data: organizations = [], isLoading: organizationsLoading } = useQuery({
    queryKey: ['organizations-for-assignment'],
    queryFn: async () => {
      const orgs = await base44.entities.Organization.list('name');
      return orgs;
    },
    enabled: showAssignDialog
  });

  // Members filtered by organization (only fetch when dialog is open and organization selected)
  const { data: filteredMembers = [], isLoading: filteredMembersLoading } = useQuery({
    queryKey: ['members-for-group-assignment', selectedOrganizationId],
    queryFn: async () => {
      if (selectedOrganizationId === '__no_org__') {
        // Fetch members without an organization
        const allMembers = await base44.entities.Member.list({ limit: 5000 });
        return allMembers.filter(m => !m.organization_id);
      } else if (selectedOrganizationId) {
        // Fetch members for the selected organization
        return await base44.entities.Member.list({ 
          filter: { organization_id: selectedOrganizationId },
          limit: 1000
        });
      }
      return [];
    },
    enabled: showAssignDialog && assignMode === 'organization' && !!selectedOrganizationId
  });

  // Debounce the member search input for the direct "Search Members" mode.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedMemberSearch(memberSearchQuery), 300);
    return () => clearTimeout(t);
  }, [memberSearchQuery]);

  // Direct typeahead search across all members in the tenant, regardless of
  // organisation (Task #1678). Uses /api/members/search (admin-gated).
  const { data: memberSearchResults = [], isLoading: memberSearchLoading } = useQuery({
    queryKey: ['member-search-for-group-assignment', debouncedMemberSearch],
    queryFn: async () => {
      const resp = await fetch(
        `/api/members/search?q=${encodeURIComponent(debouncedMemberSearch.trim())}&limit=20`,
        { credentials: 'include' }
      );
      if (!resp.ok) return [];
      return resp.json();
    },
    enabled: showAssignDialog && assignMode === 'member' && debouncedMemberSearch.trim().length >= 2
  });

  const createGroupMutation = useMutation({
    mutationFn: (data) => base44.entities.MemberGroup.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-groups'] });
      setShowGroupDialog(false);
      resetGroupForm();
      toast.success('Group created successfully');
    },
    onError: (error) => {
      if (isDuplicateGroupNameError(error)) {
        toast.error('A group with this name already exists');
        return;
      }
      toast.error('Failed to create group: ' + error.message);
    }
  });

  const updateGroupMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.MemberGroup.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-groups'] });
      setShowGroupDialog(false);
      resetGroupForm();
      toast.success('Group updated successfully');
    },
    onError: (error) => {
      if (isDuplicateGroupNameError(error)) {
        toast.error('A group with this name already exists');
        return;
      }
      toast.error('Failed to update group: ' + error.message);
    }
  });

  const deleteGroupMutation = useMutation({
    mutationFn: async (groupId) => {
      // The server cascades the group's assignments (member_group_assignment)
      // before deleting the group, so we no longer loop-delete them here — doing
      // so would trip the last-group-admin guard on the group's only admin.
      await base44.entities.MemberGroup.delete(groupId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-groups'] });
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments'] });
      setShowDeleteDialog(false);
      setGroupToDelete(null);
      toast.success('Group deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete group: ' + error.message);
    }
  });

  const assignMemberMutation = useMutation({
    mutationFn: (data) => base44.entities.MemberGroupAssignment.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments'] });
      setShowAssignDialog(false);
      setAssignForm({ member_id: '', guest_id: '', group_role: '', expires_at: null, is_group_admin: false, term_start_date: '', term_end_date: '', term_number: '' });
      setAssignMode('');
      setSelectedOrganizationId('');
      setMemberSearchQuery('');
      toast.success('Member assigned successfully');
    },
    onError: (error) => {
      toast.error('Failed to assign member: ' + error.message);
    }
  });

  const removeAssignmentMutation = useMutation({
    mutationFn: (assignmentId) => base44.entities.MemberGroupAssignment.delete(assignmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments'] });
      toast.success('Member removed from group');
    },
    onError: (error) => {
      toast.error('Failed to remove member: ' + error.message);
    }
  });

  const updateAssignmentAdminMutation = useMutation({
    mutationFn: ({ id, is_group_admin }) =>
      base44.entities.MemberGroupAssignment.update(id, { is_group_admin }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments'] });
      toast.success(variables.is_group_admin ? 'Marked as group admin' : 'Removed group admin');
    },
    onError: (error) => {
      toast.error('Failed to update group admin: ' + error.message);
    }
  });

  const { data: inviteData, isLoading: loadingInvites } = useQuery({
    queryKey: ['member-group-invites', inviteGroup?.id],
    queryFn: () => apiRequest('GET', `/api/member-group-invites?groupId=${inviteGroup.id}`),
    enabled: showInviteDialog && !!inviteGroup?.id
  });
  const invitations = inviteData?.invitations || [];

  const createInviteMutation = useMutation({
    mutationFn: (data) => apiRequest('POST', '/api/member-group-invites', { action: 'create', ...data }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['member-group-invites', inviteGroup?.id] });
      setInviteForm({ member_id: '', role: '' });
      setInviteMemberSearch('');
      if (result?.emailSent === false) {
        toast.warning('Invitation created, but the email could not be sent: ' + (result.emailError || 'unknown error'));
      } else {
        toast.success('Invitation sent');
      }
    },
    onError: (error) => {
      toast.error('Failed to send invitation: ' + error.message);
    }
  });

  const resendInviteMutation = useMutation({
    mutationFn: (invitationId) => apiRequest('POST', '/api/member-group-invites', { action: 'resend', invitationId }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['member-group-invites', inviteGroup?.id] });
      if (result?.emailSent === false) {
        toast.warning('Invitation re-issued, but the email could not be sent: ' + (result.emailError || 'unknown error'));
      } else {
        toast.success('Invitation resent');
      }
    },
    onError: (error) => {
      toast.error('Failed to resend invitation: ' + error.message);
    }
  });

  const cancelInviteMutation = useMutation({
    mutationFn: (invitationId) => apiRequest('POST', '/api/member-group-invites', { action: 'cancel', invitationId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-invites', inviteGroup?.id] });
      toast.success('Invitation cancelled');
    },
    onError: (error) => {
      toast.error('Failed to cancel invitation: ' + error.message);
    }
  });

  const createClassificationMutation = useMutation({
    mutationFn: (data) => base44.entities.MemberGroupClassification.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-classifications'] });
      setEditingClassification(null);
      setClassificationName('');
      toast.success('Classification created');
    },
    onError: (error) => {
      if (isDuplicateClassificationError(error)) {
        toast.error('A classification with this name already exists');
        return;
      }
      toast.error('Failed to create classification: ' + error.message);
    }
  });

  const updateClassificationMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.MemberGroupClassification.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-classifications'] });
      setEditingClassification(null);
      setClassificationName('');
      toast.success('Classification updated');
    },
    onError: (error) => {
      if (isDuplicateClassificationError(error)) {
        toast.error('A classification with this name already exists');
        return;
      }
      toast.error('Failed to update classification: ' + error.message);
    }
  });

  const deleteClassificationMutation = useMutation({
    mutationFn: async (classificationId) => {
      // Unassign any groups still using this classification so they fall back to "no classification".
      const affected = groups.filter(g => g.classification_id === classificationId);
      for (const group of affected) {
        await base44.entities.MemberGroup.update(group.id, { classification_id: null });
      }
      await base44.entities.MemberGroupClassification.delete(classificationId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-classifications'] });
      queryClient.invalidateQueries({ queryKey: ['member-groups'] });
      setClassificationToDelete(null);
      toast.success('Classification deleted');
    },
    onError: (error) => {
      toast.error('Failed to delete classification: ' + error.message);
    }
  });

  const handleSaveClassification = () => {
    const name = classificationName.trim();
    if (!name) {
      toast.error('Classification name is required');
      return;
    }
    const normalized = name.toLowerCase();
    const duplicate = classifications.some((c) =>
      (c.name || '').trim().toLowerCase() === normalized &&
      (!editingClassification || c.id !== editingClassification.id)
    );
    if (duplicate) {
      toast.error('A classification with this name already exists');
      return;
    }
    if (editingClassification) {
      updateClassificationMutation.mutate({ id: editingClassification.id, data: { name } });
    } else {
      createClassificationMutation.mutate({ name, is_active: true });
    }
  };

  const getClassificationName = (classificationId) => {
    const c = classifications.find(c => c.id === classificationId);
    return c ? c.name : null;
  };

  const resetGroupForm = () => {
    setGroupForm({
      name: '',
      description: '',
      who_is_it_for: '',
      about_the_group: '',
      roles: [],
      leadership_roles: [],
      is_active: true,
      header_image_url: '',
      allow_self_join: false,
      default_self_join_role: '',
      projects_enabled: false,
      projects_enabled_roles: [],
      events_enabled: false,
      complex_events_enabled: false,
      forum_enabled: false,
      forum_enabled_roles: [],
      classification_id: '',
      linkedin_url: '',
      terms_of_reference: allowGroupTermsOverride ? (defaultTermsOfReference || '') : '',
      role_terms_of_reference: {},
      role_terms_url: {},
      role_term_definitions: {},
      resource_subcategories: [],
      approval_email_template_id: '',
      decline_email_template_id: '',
      self_join_closed: false,
      self_join_closed_label: ''
    });
    setGroupSubcategorySearch('');
    setTorOpen(false);
    setEditingGroup(null);
  };

  const handleEditGroup = (group) => {
    setTorOpen(false);
    setEditingGroup(group);
    setGroupForm({
      name: group.name,
      description: group.description || '',
      who_is_it_for: group.who_is_it_for || '',
      about_the_group: group.about_the_group || '',
      roles: group.roles || [],
      leadership_roles: Array.isArray(group.leadership_roles) ? group.leadership_roles : [],
      is_active: group.is_active,
      header_image_url: group.header_image_url || '',
      allow_self_join: !!group.allow_self_join,
      default_self_join_role: group.default_self_join_role || '',
      projects_enabled: !!group.projects_enabled,
      projects_enabled_roles: Array.isArray(group.projects_enabled_roles) ? group.projects_enabled_roles : [],
      events_enabled: !!group.events_enabled,
      complex_events_enabled: (group.complex_events_enabled === undefined || group.complex_events_enabled === null) ? !!group.events_enabled : !!group.complex_events_enabled,
      forum_enabled: !!group.forum_enabled,
      forum_enabled_roles: Array.isArray(group.forum_enabled_roles) ? group.forum_enabled_roles : [],
      classification_id: group.classification_id || '',
      linkedin_url: group.linkedin_url || '',
      terms_of_reference: group.terms_of_reference || (allowGroupTermsOverride ? (defaultTermsOfReference || '') : ''),
      role_terms_of_reference: (group.role_terms_of_reference && typeof group.role_terms_of_reference === 'object') ? { ...group.role_terms_of_reference } : {},
      role_terms_url: (group.role_terms_url && typeof group.role_terms_url === 'object') ? { ...group.role_terms_url } : {},
      role_term_definitions: (group.role_term_definitions && typeof group.role_term_definitions === 'object') ? { ...group.role_term_definitions } : {},
      resource_subcategories: Array.isArray(group.resource_subcategories) ? [...group.resource_subcategories] : [],
      approval_email_template_id: group.approval_email_template_id || '',
      decline_email_template_id: group.decline_email_template_id || '',
      self_join_closed: !!group.self_join_closed,
      self_join_closed_label: group.self_join_closed_label || ''
    });
    setGroupSubcategorySearch('');
    setShowGroupDialog(true);
  };

  const handleDuplicateGroup = (group) => {
    setEditingGroup(null);
    setGroupForm({
      name: `${group.name} (Copy)`,
      description: group.description || '',
      who_is_it_for: group.who_is_it_for || '',
      about_the_group: group.about_the_group || '',
      roles: [...(group.roles || [])],
      leadership_roles: Array.isArray(group.leadership_roles) ? [...group.leadership_roles] : [],
      is_active: group.is_active,
      header_image_url: group.header_image_url || '',
      allow_self_join: !!group.allow_self_join,
      default_self_join_role: group.default_self_join_role || '',
      projects_enabled: !!group.projects_enabled,
      projects_enabled_roles: Array.isArray(group.projects_enabled_roles) ? [...group.projects_enabled_roles] : [],
      events_enabled: !!group.events_enabled,
      complex_events_enabled: (group.complex_events_enabled === undefined || group.complex_events_enabled === null) ? !!group.events_enabled : !!group.complex_events_enabled,
      forum_enabled: !!group.forum_enabled,
      forum_enabled_roles: Array.isArray(group.forum_enabled_roles) ? [...group.forum_enabled_roles] : [],
      classification_id: group.classification_id || '',
      linkedin_url: group.linkedin_url || '',
      terms_of_reference: group.terms_of_reference || (allowGroupTermsOverride ? (defaultTermsOfReference || '') : ''),
      role_terms_of_reference: (group.role_terms_of_reference && typeof group.role_terms_of_reference === 'object') ? { ...group.role_terms_of_reference } : {},
      role_terms_url: (group.role_terms_url && typeof group.role_terms_url === 'object') ? { ...group.role_terms_url } : {},
      role_term_definitions: (group.role_term_definitions && typeof group.role_term_definitions === 'object') ? { ...group.role_term_definitions } : {},
      resource_subcategories: Array.isArray(group.resource_subcategories) ? [...group.resource_subcategories] : [],
      approval_email_template_id: group.approval_email_template_id || '',
      decline_email_template_id: group.decline_email_template_id || '',
      self_join_closed: false,
      self_join_closed_label: ''
    });
    setGroupSubcategorySearch('');
    setShowGroupDialog(true);
  };

  const handleBulkCreate = () => {
    if (!bulkText.trim()) {
      toast.error('Please enter group names');
      return;
    }

    const lines = bulkText.split('\n').map(line => line.trim()).filter(Boolean);

    const existingNames = new Set(
      groups.map((g) => (g.name || '').trim().toLowerCase())
    );
    const seenInInput = new Set();
    const groupsToCreate = [];
    let skipped = 0;

    for (const name of lines) {
      const normalized = name.toLowerCase();
      if (existingNames.has(normalized) || seenInInput.has(normalized)) {
        skipped += 1;
        continue;
      }
      seenInInput.add(normalized);
      groupsToCreate.push({
        name,
        description: '',
        roles: [],
        is_active: true
      });
    }

    if (groupsToCreate.length === 0) {
      toast.error(
        skipped > 0
          ? 'All group names already exist'
          : 'Please enter group names'
      );
      return;
    }

    Promise.all(groupsToCreate.map(g => base44.entities.MemberGroup.create(g)))
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['member-groups'] });
        setShowBulkDialog(false);
        setBulkText('');
        const created = groupsToCreate.length;
        toast.success(
          skipped > 0
            ? `Created ${created} group${created === 1 ? '' : 's'}, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`
            : `Created ${created} group${created === 1 ? '' : 's'} successfully`
        );
      })
      .catch(error => {
        toast.error('Failed to create groups: ' + error.message);
      });
  };

  const handleSaveGroup = () => {
    if (!groupForm.name.trim()) {
      toast.error('Group name is required');
      return;
    }

    const normalizedName = groupForm.name.trim().toLowerCase();
    const duplicateName = groups.some((g) =>
      (g.name || '').trim().toLowerCase() === normalizedName &&
      (!editingGroup || g.id !== editingGroup.id)
    );
    if (duplicateName) {
      toast.error('A group with this name already exists');
      return;
    }

    if (groupForm.allow_self_join) {
      if (!groupForm.default_self_join_role) {
        toast.error('Default self-join role is required when self-join is enabled');
        return;
      }
      if (!(groupForm.roles || []).includes(groupForm.default_self_join_role)) {
        toast.error('Default self-join role must be one of the group roles');
        return;
      }
    }

    // Normalise the optional LinkedIn URL: trim, treat blank as null, and
    // validate it parses as a URL when present.
    const trimmedLinkedin = (groupForm.linkedin_url || '').trim();
    if (trimmedLinkedin) {
      let validUrl = false;
      try {
        const parsed = new URL(trimmedLinkedin);
        validUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        validUrl = false;
      }
      if (!validUrl) {
        toast.error('Please enter a valid LinkedIn URL (including https://)');
        return;
      }
    }

    // Normalise the optional terms of reference (rich text / HTML): trim and
    // treat visually-empty content (e.g. "<p></p>") as null so an empty editor
    // doesn't count as having terms.
    const rawTerms = (groupForm.terms_of_reference || '').trim();
    const termsHasText = rawTerms
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|\u00A0/g, ' ')
      .trim().length > 0;
    const trimmedTerms = termsHasText ? rawTerms : '';

    // Normalise the description/purpose (rich text / HTML): trim, treat visually-empty
    // content as empty, and sanitise the markup before it is saved. Legacy
    // plain-text values pass through sanitisation unchanged.
    const rawDescription = (groupForm.description || '').trim();
    const descriptionHasText = rawDescription
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|\u00A0/g, ' ')
      .trim().length > 0;
    const sanitizedDescription = descriptionHasText ? sanitizeRichText(rawDescription) : '';

    // Normalise the optional "Who the group is for" rich text field.
    const rawWhoIsItFor = (groupForm.who_is_it_for || '').trim();
    const whoIsItForHasText = rawWhoIsItFor
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|\u00A0/g, ' ')
      .trim().length > 0;
    const sanitizedWhoIsItFor = whoIsItForHasText ? sanitizeRichText(rawWhoIsItFor) : null;

    // Normalise the optional "About the group" rich text field.
    const rawAboutTheGroup = (groupForm.about_the_group || '').trim();
    const aboutTheGroupHasText = rawAboutTheGroup
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|\u00A0/g, ' ')
      .trim().length > 0;
    const sanitizedAboutTheGroup = aboutTheGroupHasText ? sanitizeRichText(rawAboutTheGroup) : null;

    // Prune leadership_roles / projects_enabled_roles to only roles still on the group.
    const validRoles = new Set(groupForm.roles || []);
    const prunedLeadership = (groupForm.leadership_roles || []).filter((r) => validRoles.has(r));
    const prunedProjects = (groupForm.projects_enabled_roles || []).filter((r) => validRoles.has(r));
    const prunedForum = (groupForm.forum_enabled_roles || []).filter((r) => validRoles.has(r));

    // Prune + normalise per-role terms of reference: keep only roles still on the
    // group, and drop entries whose rich-text content is visually empty.
    const rawRoleTerms = (groupForm.role_terms_of_reference && typeof groupForm.role_terms_of_reference === 'object')
      ? groupForm.role_terms_of_reference
      : {};
    const prunedRoleTerms = {};
    for (const [roleName, html] of Object.entries(rawRoleTerms)) {
      if (!validRoles.has(roleName)) continue;
      const raw = (html || '').trim();
      const hasText = raw
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;|\u00A0/g, ' ')
        .trim().length > 0;
      if (hasText) prunedRoleTerms[roleName] = raw;
    }

    // Prune per-role terms-of-reference URLs (Task #1655): keep only roles still
    // on the group, and drop blank entries.
    const rawRoleTermsUrl = (groupForm.role_terms_url && typeof groupForm.role_terms_url === 'object')
      ? groupForm.role_terms_url
      : {};
    const prunedRoleTermsUrl = {};
    for (const [roleName, url] of Object.entries(rawRoleTermsUrl)) {
      if (!validRoles.has(roleName)) continue;
      const trimmed = (url || '').toString().trim();
      if (trimmed) prunedRoleTermsUrl[roleName] = trimmed;
    }

    // Prune + normalise per-role term definitions (Task #1626): keep only roles
    // still on the group, coerce numeric fields, and drop entries that carry
    // neither a term length nor a max-terms value.
    const rawRoleTermDefs = (groupForm.role_term_definitions && typeof groupForm.role_term_definitions === 'object')
      ? groupForm.role_term_definitions
      : {};
    const prunedRoleTermDefs = {};
    for (const [roleName, def] of Object.entries(rawRoleTermDefs)) {
      if (!validRoles.has(roleName) || !def || typeof def !== 'object') continue;
      const value = Number(def.term_value);
      const maxTerms = Number(def.max_terms);
      const hasValue = Number.isFinite(value) && value > 0;
      const hasMax = Number.isFinite(maxTerms) && maxTerms > 0;
      if (!hasValue && !hasMax) continue;
      prunedRoleTermDefs[roleName] = {
        term_value: hasValue ? Math.floor(value) : null,
        term_unit: hasValue ? (def.term_unit === 'months' ? 'months' : 'years') : null,
        max_terms: hasMax ? Math.floor(maxTerms) : null,
      };
    }

    const payload = {
      ...groupForm,
      description: sanitizedDescription,
      who_is_it_for: sanitizedWhoIsItFor,
      about_the_group: sanitizedAboutTheGroup,
      default_self_join_role: groupForm.allow_self_join ? groupForm.default_self_join_role : null,
      leadership_roles: prunedLeadership,
      projects_enabled: !!groupForm.projects_enabled,
      projects_enabled_roles: groupForm.projects_enabled ? prunedProjects : [],
      events_enabled: !!groupForm.events_enabled,
      complex_events_enabled: !!groupForm.complex_events_enabled,
      forum_enabled: !!groupForm.forum_enabled,
      forum_enabled_roles: groupForm.forum_enabled ? prunedForum : [],
      classification_id: groupForm.classification_id || null,
      linkedin_url: trimmedLinkedin || null,
      terms_of_reference: trimmedTerms || null,
      role_terms_of_reference: prunedRoleTerms,
      role_terms_url: prunedRoleTermsUrl,
      role_term_definitions: prunedRoleTermDefs,
      resource_subcategories: Array.isArray(groupForm.resource_subcategories)
        ? Array.from(new Set(groupForm.resource_subcategories.filter((s) => typeof s === 'string' && s.trim())))
        : [],
      approval_email_template_id: groupForm.approval_email_template_id || null,
      decline_email_template_id: groupForm.decline_email_template_id || null
    };

    if (editingGroup) {
      updateGroupMutation.mutate({ id: editingGroup.id, data: payload });
    } else {
      createGroupMutation.mutate(payload);
    }
  };

  const handleAddRole = () => {
    if (!newRole.trim()) return;
    if (groupForm.roles.includes(newRole.trim())) {
      toast.error('Role already exists');
      return;
    }
    setGroupForm({ ...groupForm, roles: [...groupForm.roles, newRole.trim()] });
    setNewRole('');
  };

  const handleBulkAddRoles = () => {
    if (!bulkRolesText.trim()) {
      toast.error('Please enter role names');
      return;
    }

    const lines = bulkRolesText.split('\n').filter(line => line.trim());
    const newRoles = lines.map(line => line.trim());
    const existingRoles = groupForm.roles || [];
    
    // Filter out duplicates
    const uniqueNewRoles = newRoles.filter(role => !existingRoles.includes(role));
    
    if (uniqueNewRoles.length === 0) {
      toast.error('All roles already exist');
      return;
    }

    setGroupForm({ ...groupForm, roles: [...existingRoles, ...uniqueNewRoles] });
    setBulkRolesText('');
    setShowBulkRoles(false);
    toast.success(`Added ${uniqueNewRoles.length} role(s)`);
  };

  const handleRemoveRole = (role) => {
    const nextRoleTerms = { ...(groupForm.role_terms_of_reference || {}) };
    delete nextRoleTerms[role];
    const nextRoleTermsUrl = { ...(groupForm.role_terms_url || {}) };
    delete nextRoleTermsUrl[role];
    setGroupForm({
      ...groupForm,
      roles: groupForm.roles.filter(r => r !== role),
      leadership_roles: (groupForm.leadership_roles || []).filter(r => r !== role),
      projects_enabled_roles: (groupForm.projects_enabled_roles || []).filter(r => r !== role),
      forum_enabled_roles: (groupForm.forum_enabled_roles || []).filter(r => r !== role),
      default_self_join_role: groupForm.default_self_join_role === role ? '' : groupForm.default_self_join_role,
      role_terms_of_reference: nextRoleTerms,
      role_terms_url: nextRoleTermsUrl
    });
  };

  const toggleLeadershipRole = (role) => {
    const current = new Set(groupForm.leadership_roles || []);
    if (current.has(role)) current.delete(role); else current.add(role);
    setGroupForm({ ...groupForm, leadership_roles: Array.from(current) });
  };

  const toggleProjectsRole = (role) => {
    const current = new Set(groupForm.projects_enabled_roles || []);
    if (current.has(role)) current.delete(role); else current.add(role);
    setGroupForm({ ...groupForm, projects_enabled_roles: Array.from(current) });
  };

  const toggleForumRole = (role) => {
    const current = new Set(groupForm.forum_enabled_roles || []);
    if (current.has(role)) current.delete(role); else current.add(role);
    setGroupForm({ ...groupForm, forum_enabled_roles: Array.from(current) });
  };

  const toggleResourceSubcategory = (sub) => {
    const current = new Set(groupForm.resource_subcategories || []);
    if (current.has(sub)) current.delete(sub); else current.add(sub);
    setGroupForm({ ...groupForm, resource_subcategories: Array.from(current) });
  };

  const handleAssignMember = () => {
    if ((!assignForm.member_id && !assignForm.guest_id) || !assignForm.group_role) {
      toast.error('Please select a member/guest and role');
      return;
    }

    // Check for existing assignment
    const existing = assignments.find(a => {
      if (a.group_id !== selectedGroup.id) return false;
      if (assignForm.member_id && a.member_id === assignForm.member_id) return true;
      if (assignForm.guest_id && a.guest_id === assignForm.guest_id) return true;
      return false;
    });

    if (existing) {
      toast.error('This person is already assigned to this group');
      return;
    }

    const role = assignForm.group_role;
    // Snapshot the role's current term onto the assignment so later role edits
    // don't retroactively change this member's recorded term, matching the
    // award/invite-accept flows (Task #1626/#1628). No prior assignment here
    // (already-assigned people are rejected above), so term_number resets to 1.
    // The role's term-length/unit/max-terms come from the role definition; the
    // admin can override the per-member start/end dates and term number below.
    const roleTermDefs =
      selectedGroup.role_term_definitions && typeof selectedGroup.role_term_definitions === 'object'
        ? selectedGroup.role_term_definitions
        : {};
    const termSnapshot = buildTermSnapshot(roleTermDefs[role], { role });

    // Apply the admin's explicit term overrides, validating like EditTermDialog.
    const startDate = assignForm.term_start_date || '';
    const endDate = assignForm.term_end_date || '';
    if (startDate && endDate && endDate < startDate) {
      toast.error("The term end date can't be before the start date.");
      return;
    }
    let nextTermNumber = null;
    if (assignForm.term_number !== '' && assignForm.term_number != null) {
      const n = Math.floor(Number(assignForm.term_number));
      if (!Number.isFinite(n) || n < 1) {
        toast.error('Term number must be a whole number of 1 or more.');
        return;
      }
      nextTermNumber = n;
    }

    const data = {
      group_role: role,
      group_id: selectedGroup.id,
      is_group_admin: assignForm.is_group_admin === true,
      ...termSnapshot,
      term_start_date: startDate || null,
      term_end_date: endDate || null,
      term_number: nextTermNumber
    };

    if (assignForm.member_id) {
      data.member_id = assignForm.member_id;
    } else if (assignForm.guest_id) {
      data.guest_id = assignForm.guest_id;
    }
    
    if (assignForm.expires_at) {
      data.expires_at = format(assignForm.expires_at, 'yyyy-MM-dd');
    }

    assignMemberMutation.mutate(data);
  };

  const openInviteDialog = (group) => {
    setInviteGroup(group);
    setInviteForm({ member_id: '', role: '' });
    setInviteMemberSearch('');
    setShowInviteDialog(true);
  };

  // Would inviting this member into the selected role push their next term past
  // the role's max_terms? Renewals into the SAME role can exceed; a different /
  // new role resets to term 1 and never warns. Returns the warning or null.
  const evaluateInviteTermLimit = () => {
    if (!inviteGroup || !inviteForm.member_id || !inviteForm.role) return null;
    const role = inviteForm.role;
    const defs = inviteGroup.role_term_definitions;
    const termDef = defs && typeof defs === 'object' ? defs[role] : null;
    const existing = assignments.find(
      (a) => a.group_id === inviteGroup.id && a.member_id === inviteForm.member_id
    ) || null;
    const warning = evaluateTermLimit(termDef, { existingAssignment: existing, role });
    if (!warning) return null;
    return { ...warning, memberName: getMemberName(inviteForm.member_id), role };
  };

  const submitInvite = () => {
    setInviteTermWarning(null);
    createInviteMutation.mutate({
      groupId: inviteGroup.id,
      memberId: inviteForm.member_id,
      role: inviteForm.role
    });
  };

  const handleSendInvite = () => {
    if (!inviteForm.member_id || !inviteForm.role) {
      toast.error('Please select a member and a role');
      return;
    }
    const warning = evaluateInviteTermLimit();
    if (warning) {
      setInviteTermWarning(warning);
      return;
    }
    submitInvite();
  };

  const getGroupAssignments = (groupId) => {
    return assignments.filter(a => a.group_id === groupId);
  };

  const getAssignmentJoinTime = (assignment) => {
    const raw = assignment.created_date || assignment.created_at || null;
    if (!raw) return 0;
    const t = new Date(raw).getTime();
    return Number.isNaN(t) ? 0 : t;
  };

  const getSortedGroupAssignments = (groupId) => {
    return getGroupAssignments(groupId)
      .slice()
      .sort((a, b) => getAssignmentJoinTime(b) - getAssignmentJoinTime(a));
  };

  const getMemberName = (memberId) => {
    const member = members.find(m => m.id === memberId);
    return member ? `${member.first_name} ${member.last_name}` : 'Unknown';
  };

  const getGuestName = (guestId) => {
    const guest = guests.find(g => g.id === guestId);
    return guest ? `${guest.first_name} ${guest.last_name}` : 'Unknown Guest';
  };

  const getAssigneeName = (assignment) => {
    if (assignment.member_id) {
      return getMemberName(assignment.member_id);
    } else if (assignment.guest_id) {
      return getGuestName(assignment.guest_id);
    }
    return 'Unknown';
  };

  const isAssignmentGuest = (assignment) => {
    // Legacy: explicit guest_id set on the row
    if (assignment.guest_id) return true;
    // New flow: guest assigned via their provisioned member_id
    if (assignment.member_id && guestMemberIds.has(assignment.member_id)) return true;
    return false;
  };

  // Filter and sort groups
  const filteredAndSortedGroups = React.useMemo(() => {
    let filtered = groups.filter(group => {
      const matchesSearch = searchQuery === '' || 
        group.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (group.description && group.description.replace(/<[^>]*>/g, ' ').toLowerCase().includes(searchQuery.toLowerCase()));
      const matchesClassification =
        classificationFilter === 'all' ||
        (classificationFilter === '__none__'
          ? !group.classification_id
          : group.classification_id === classificationFilter);
      return matchesSearch && matchesClassification;
    });

    // Sort groups
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'members-asc': {
          const aCount = getGroupAssignments(a.id).length;
          const bCount = getGroupAssignments(b.id).length;
          return aCount - bCount;
        }
        case 'members-desc': {
          const aCount = getGroupAssignments(a.id).length;
          const bCount = getGroupAssignments(b.id).length;
          return bCount - aCount;
        }
        default:
          return 0;
      }
    });

    return filtered;
  }, [groups, searchQuery, sortBy, assignments, classificationFilter]);

  // Pagination
  const totalPages = Math.ceil(filteredAndSortedGroups.length / itemsPerPage);
  const paginatedGroups = filteredAndSortedGroups.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  // Reset to page 1 when search/sort/filter changes
  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sortBy, classificationFilter]);

  const handleSelectGroup = (groupId) => {
    setSelectedGroups(prev => 
      prev.includes(groupId) 
        ? prev.filter(id => id !== groupId)
        : [...prev, groupId]
    );
  };

  const handleSelectAll = () => {
    if (selectedGroups.length === groups.length) {
      setSelectedGroups([]);
    } else {
      setSelectedGroups(groups.map(g => g.id));
    }
  };

  const bulkUpdateGroupsMutation = useMutation({
    mutationFn: async ({ groupIds, action, role }) => {
      const updates = [];
      for (const groupId of groupIds) {
        const group = groups.find(g => g.id === groupId);
        if (!group) continue;

        let newRoles = [...(group.roles || [])];
        
        if (action === 'add') {
          if (!newRoles.includes(role)) {
            newRoles.push(role);
          }
        } else if (action === 'remove') {
          newRoles = newRoles.filter(r => r !== role);
        }

        updates.push(
          base44.entities.MemberGroup.update(groupId, { roles: newRoles })
        );
      }
      await Promise.all(updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-groups'] });
      setShowBulkEditDialog(false);
      setBulkEditRole('');
      setSelectedGroups([]);
      toast.success('Groups updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update groups: ' + error.message);
    }
  });

  const handleBulkEdit = () => {
    if (!bulkEditRole.trim()) {
      toast.error('Please enter a role name');
      return;
    }
    if (selectedGroups.length === 0) {
      toast.error('Please select at least one group');
      return;
    }

    bulkUpdateGroupsMutation.mutate({
      groupIds: selectedGroups,
      action: bulkEditAction,
      role: bulkEditRole.trim()
    });
  };

  const renderAssignmentRow = (assignment) => (
    <div key={assignment.id} className="flex items-center justify-between text-xs bg-slate-50 p-2 rounded">
      <div>
        <div className="font-medium text-slate-900 flex items-center gap-1">
          {getAssigneeName(assignment)}
          {isAssignmentGuest(assignment) && (
            <Badge className="bg-purple-100 text-purple-700 text-[10px] px-1">Guest</Badge>
          )}
          {assignment.is_group_admin === true && (
            <Badge
              className="bg-emerald-100 text-emerald-700 text-[10px] px-1"
              data-testid={`badge-group-admin-${assignment.id}`}
            >
              Admin
            </Badge>
          )}
        </div>
        <div className="text-slate-500">{assignment.group_role}</div>
        {assignment.expires_at && (
          <div className="text-slate-400 flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            Expires: {format(new Date(assignment.expires_at), 'dd MMM yyyy')}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1" title="Group Admin">
          <span className="text-slate-500">Admin</span>
          <Switch
            data-testid={`switch-group-admin-${assignment.id}`}
            checked={assignment.is_group_admin === true}
            disabled={updateAssignmentAdminMutation.isPending}
            onCheckedChange={(checked) =>
              updateAssignmentAdminMutation.mutate({ id: assignment.id, is_group_admin: checked })
            }
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => removeAssignmentMutation.mutate(assignment.id)}
          className="h-6 w-6 p-0 text-red-600 hover:text-red-700"
        >
          <X className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );

  const renderGroupCard = (group) => {
    const groupAssignments = getSortedGroupAssignments(group.id);
    const previewAssignments = groupAssignments.slice(0, 5);
    const isSelected = selectedGroups.includes(group.id);
    return (
      <Card
        key={group.id}
        className={`hover:shadow-lg transition-shadow ${isSelected ? 'ring-2 ring-blue-500' : ''}`}
      >
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => handleSelectGroup(group.id)}
              className="w-4 h-4 cursor-pointer"
            />
            <div className="flex items-start justify-between flex-1">
              <CardTitle className="text-lg">{group.name}</CardTitle>
              {!group.is_active && (
                <Badge className="bg-slate-200 text-slate-700">Inactive</Badge>
              )}
            </div>
          </div>
          {group.classification_id && getClassificationName(group.classification_id) && (
            <Badge
              className="bg-indigo-100 text-indigo-700 w-fit"
              data-testid={`badge-classification-${group.id}`}
            >
              <Tag className="w-3 h-3 mr-1" />
              {getClassificationName(group.classification_id)}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Roles:</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {group.roles?.length > 0 ? (
                group.roles.map((role, idx) => {
                  const isLeader = Array.isArray(group.leadership_roles) && group.leadership_roles.includes(role);
                  return (
                    <Badge
                      key={idx}
                      className={`text-xs ${isLeader ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-700"}`}
                      title={isLeader ? "Leadership role" : undefined}
                    >
                      {isLeader && <Crown className="w-3 h-3 mr-1 fill-current" />}
                      {role}
                    </Badge>
                  );
                })
              ) : (
                <span className="text-xs text-slate-500">No roles defined</span>
              )}
            </div>
          </div>

          <div>
            <span className="text-sm font-medium text-slate-700">
              Members: {groupAssignments.length}
            </span>
          </div>

          <div className="flex gap-2 pt-2 border-t border-slate-200">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedGroup(group);
                setShowAssignDialog(true);
              }}
              className="flex-1"
            >
              <UserPlus className="w-3 h-3 mr-1" />
              Assign
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openInviteDialog(group)}
              className="flex-1"
              data-testid={`button-invite-${group.id}`}
            >
              <Mail className="w-3 h-3 mr-1" />
              Invite
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDuplicateGroup(group)}
              title="Duplicate"
            >
              <Copy className="w-3 h-3" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleEditGroup(group)}
            >
              <Pencil className="w-3 h-3" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setGroupToDelete(group);
                setShowDeleteDialog(true);
              }}
              className="text-red-600 hover:text-red-700"
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>

          {groupAssignments.length > 0 && (
          <div className="pt-2 border-t border-slate-200">
          <div className="space-y-1">
            {previewAssignments.map((assignment) => renderAssignmentRow(assignment))}
          </div>
          {groupAssignments.length > 5 && (
            <Button
              variant="link"
              size="sm"
              onClick={() => setMembersModalGroupId(group.id)}
              className="px-0 mt-1 h-auto"
              data-testid={`button-view-all-members-${group.id}`}
            >
              View all ({groupAssignments.length})
            </Button>
          )}
          </div>
          )}
        </CardContent>
      </Card>
    );
  };

  // Sections for "group by classification" view (operates on the full filtered set, not paginated).
  const classificationSections = React.useMemo(() => {
    const byId = new Map();
    classifications.forEach((c) => byId.set(c.id, { id: c.id, name: c.name, groups: [] }));
    const noneSection = { id: '__none__', name: 'No classification', groups: [] };
    filteredAndSortedGroups.forEach((g) => {
      const section = g.classification_id && byId.has(g.classification_id)
        ? byId.get(g.classification_id)
        : noneSection;
      section.groups.push(g);
    });
    const ordered = [...byId.values()].filter((s) => s.groups.length > 0);
    ordered.sort((a, b) => a.name.localeCompare(b.name));
    if (noneSection.groups.length > 0) ordered.push(noneSection);
    return ordered;
  }, [classifications, filteredAndSortedGroups]);

  const isLoading = !accessChecked || loadingGroups || loadingMembers || loadingAssignments || loadingGuests || loadingClassifications;

  if (isLoading) {
    return (
      <div className="min-h-screen p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-slate-600">Loading member groups...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">{featureName}</h1>
              <p className="text-slate-600">Create and manage member groups with roles</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                onClick={() => { setEditingClassification(null); setClassificationName(''); setShowClassificationDialog(true); }}
                variant="outline"
                data-testid="button-manage-classifications"
              >
                <Tag className="w-4 h-4 mr-2" />
                Classifications
              </Button>
              <Button onClick={() => setShowBulkDialog(true)} variant="outline">
                <ListPlus className="w-4 h-4 mr-2" />
                Bulk Create
              </Button>
              <Button onClick={() => { resetGroupForm(); setShowGroupDialog(true); }} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                New Group
              </Button>
            </div>
          </div>

          {groups.length > 0 && (
            <>
              <Card className="bg-blue-50 border-blue-200 mb-4">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSelectAll}
                        className="bg-white"
                      >
                        <CheckSquare className="w-4 h-4 mr-2" />
                        {selectedGroups.length === groups.length ? 'Deselect All' : 'Select All'}
                      </Button>
                      {selectedGroups.length > 0 && (
                        <span className="text-sm font-medium text-blue-900">
                          {selectedGroups.length} group{selectedGroups.length !== 1 ? 's' : ''} selected
                        </span>
                      )}
                    </div>
                    {selectedGroups.length > 0 && (
                      <Button
                        onClick={() => setShowBulkEditDialog(true)}
                        className="bg-blue-600 hover:bg-blue-700"
                        size="sm"
                      >
                        <Users className="w-4 h-4 mr-2" />
                        Bulk Edit Roles
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="mb-6">
                <CardContent className="p-4">
                  <div className="flex flex-col md:flex-row gap-3">
                    <div className="flex-1">
                      <Input
                        placeholder="Search groups..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full"
                      />
                    </div>
                    <div className="w-full md:w-56">
                      <Select value={classificationFilter} onValueChange={setClassificationFilter}>
                        <SelectTrigger data-testid="select-classification-filter">
                          <SelectValue placeholder="All classifications" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All classifications</SelectItem>
                          <SelectItem value="__none__">No classification</SelectItem>
                          {classifications.map((c) => (
                            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="w-full md:w-56">
                      <Select value={sortBy} onValueChange={setSortBy}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="name-asc">Name (A-Z)</SelectItem>
                          <SelectItem value="name-desc">Name (Z-A)</SelectItem>
                          <SelectItem value="members-desc">Most Members</SelectItem>
                          <SelectItem value="members-asc">Least Members</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-center justify-between flex-wrap gap-2 mt-3">
                    {filteredAndSortedGroups.length > 0 ? (
                      <p className="text-sm text-slate-600">
                        Showing {filteredAndSortedGroups.length} of {groups.length} group{groups.length !== 1 ? 's' : ''}
                      </p>
                    ) : <span />}
                    <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer" data-testid="label-group-by-classification">
                      <Switch
                        checked={groupByClassification}
                        onCheckedChange={setGroupByClassification}
                        data-testid="switch-group-by-classification"
                      />
                      Group by classification
                    </label>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>

        {loadingGroups || loadingMembers || loadingAssignments || loadingGuests ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array(6).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader>
                  <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                  <div className="h-4 bg-slate-200 rounded w-full" />
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Groups Yet</h3>
              <p className="text-slate-600 mb-6">Create your first member group to get started</p>
              <Button onClick={() => { resetGroupForm(); setShowGroupDialog(true); }} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Group
              </Button>
            </CardContent>
          </Card>
        ) : filteredAndSortedGroups.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Groups Found</h3>
              <p className="text-slate-600 mb-4">No groups match your search criteria</p>
              <Button variant="outline" onClick={() => setSearchQuery('')}>
                Clear Search
              </Button>
            </CardContent>
          </Card>
        ) : groupByClassification ? (
          <div className="space-y-8">
            {classificationSections.map((section) => (
              <div key={section.id} data-testid={`section-classification-${section.id}`}>
                <div className="flex items-center gap-2 mb-4">
                  <Tag className="w-4 h-4 text-indigo-600" />
                  <h2 className="text-xl font-semibold text-slate-900">{section.name}</h2>
                  <Badge className="bg-slate-200 text-slate-700">{section.groups.length}</Badge>
                </div>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {section.groups.map((group) => renderGroupCard(group))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {paginatedGroups.map((group) => renderGroupCard(group))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-8 flex justify-center">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    Previous
                  </Button>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                      <Button
                        key={page}
                        variant={currentPage === page ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCurrentPage(page)}
                        className={currentPage === page ? "bg-blue-600 hover:bg-blue-700" : ""}
                      >
                        {page}
                      </Button>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Create/Edit Group Dialog */}
        <Dialog open={showGroupDialog} onOpenChange={(open) => { setShowGroupDialog(open); if (!open) { setTorOpen(false); } }}>
          <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>{editingGroup ? 'Edit Group' : 'Create New Group'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 flex-1 min-h-0 overflow-y-auto py-2">
              <div>
                <Label htmlFor="name">Group Name *</Label>
                <Input
                  id="name"
                  value={groupForm.name}
                  onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                  placeholder="e.g., Board of Directors"
                />
              </div>

              <div>
                <Label htmlFor="description">Purpose</Label>
                <SimpleRichTextEditor
                  content={groupForm.description}
                  onChange={(html) => setGroupForm({ ...groupForm, description: html })}
                  placeholder="What is the purpose of this group?"
                  data-testid="input-group-description"
                />
              </div>

              <div>
                <Label htmlFor="who_is_it_for">Who the group is for</Label>
                <SimpleRichTextEditor
                  content={groupForm.who_is_it_for}
                  onChange={(html) => setGroupForm({ ...groupForm, who_is_it_for: html })}
                  placeholder="Who is this group aimed at? (optional)"
                  data-testid="input-group-who-is-it-for"
                />
              </div>

              <div>
                <Label htmlFor="about_the_group">About the group</Label>
                <SimpleRichTextEditor
                  content={groupForm.about_the_group}
                  onChange={(html) => setGroupForm({ ...groupForm, about_the_group: html })}
                  placeholder="Tell members more about this group... (optional)"
                  data-testid="input-group-about"
                />
              </div>

              <Collapsible open={torOpen} onOpenChange={setTorOpen}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    aria-expanded={torOpen}
                    className="flex w-full items-center justify-between rounded-md py-1 text-sm font-medium hover-elevate"
                    data-testid="button-toggle-terms-of-reference"
                  >
                    <span>Terms of reference</span>
                    <ChevronDown
                      className="h-4 w-4 text-muted-foreground transition-transform duration-200"
                      style={{ transform: torOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="pt-2">
                    {allowGroupTermsOverride ? (
                      <>
                        <SimpleRichTextEditor
                          content={groupForm.terms_of_reference}
                          onChange={(html) => setGroupForm({ ...groupForm, terms_of_reference: html })}
                          placeholder="Terms of reference members must agree to before joining..."
                          className="min-h-[260px] [&_.tiptap]:min-h-[220px]"
                          data-testid="input-group-terms-of-reference"
                        />
                        <p className="text-xs text-muted-foreground mt-1">Optional. When set, members must read and agree to this before they can join from the group's detail page.</p>
                      </>
                    ) : (
                      <>
                        <div
                          className="min-h-[120px] rounded-md border border-input bg-muted/50 p-3 text-sm text-muted-foreground prose prose-sm max-w-none cursor-not-allowed"
                          data-testid="input-group-terms-of-reference-readonly"
                          dangerouslySetInnerHTML={{ __html: defaultTermsOfReference || '<p class="text-muted-foreground italic">No default terms of reference set.</p>' }}
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          Terms of reference are controlled centrally in Member Group Settings. Individual groups cannot override them.
                        </p>
                      </>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>

              <div>
                <Label htmlFor="linkedin_url">LinkedIn URL</Label>
                <Input
                  id="linkedin_url"
                  type="url"
                  value={groupForm.linkedin_url}
                  onChange={(e) => setGroupForm({ ...groupForm, linkedin_url: e.target.value })}
                  placeholder="https://www.linkedin.com/company/..."
                  data-testid="input-group-linkedin-url"
                />
                <p className="text-xs text-slate-500 mt-1">Optional. Shown as a link on the group's detail page.</p>
              </div>

              <div>
                <Label htmlFor="classification">Classification</Label>
                <Select
                  value={groupForm.classification_id || '__none__'}
                  onValueChange={(val) => setGroupForm({ ...groupForm, classification_id: val === '__none__' ? '' : val })}
                >
                  <SelectTrigger id="classification" data-testid="select-group-classification">
                    <SelectValue placeholder="No classification" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No classification</SelectItem>
                    {classifications.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500 mt-1">An organisational label only — used to group and filter member groups.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="approval_email_template">Approval email template</Label>
                  <Select
                    value={groupForm.approval_email_template_id || '__none__'}
                    onValueChange={(val) => setGroupForm({ ...groupForm, approval_email_template_id: val === '__none__' ? '' : val })}
                  >
                    <SelectTrigger id="approval_email_template" data-testid="select-approval-email-template">
                      <SelectValue placeholder="No template" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No template</SelectItem>
                      {emailTemplates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name || t.subject || 'Untitled template'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500 mt-1">Pre-fills the email sent when a vacancy applicant is approved.</p>
                </div>

                <div>
                  <Label htmlFor="decline_email_template">Decline email template</Label>
                  <Select
                    value={groupForm.decline_email_template_id || '__none__'}
                    onValueChange={(val) => setGroupForm({ ...groupForm, decline_email_template_id: val === '__none__' ? '' : val })}
                  >
                    <SelectTrigger id="decline_email_template" data-testid="select-decline-email-template">
                      <SelectValue placeholder="No template" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No template</SelectItem>
                      {emailTemplates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name || t.subject || 'Untitled template'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500 mt-1">Pre-fills the email sent when a vacancy applicant is declined.</p>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Roles within Group</Label>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setShowBulkRoles(!showBulkRoles)}
                    type="button"
                  >
                    <ListPlus className="w-3 h-3 mr-1" />
                    Bulk Add
                  </Button>
                </div>

                {showBulkRoles ? (
                  <div className="space-y-2 mb-2 p-3 bg-slate-50 rounded-lg">
                    <Textarea
                      value={bulkRolesText}
                      onChange={(e) => setBulkRolesText(e.target.value)}
                      placeholder="Chair&#10;Vice Chair&#10;Secretary&#10;Treasurer&#10;Member"
                      rows={5}
                    />
                    <div className="flex gap-2">
                      <Button onClick={handleBulkAddRoles} type="button" size="sm" className="flex-1">
                        Add Roles
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={() => { setShowBulkRoles(false); setBulkRolesText(''); }}
                        type="button"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2 mb-2">
                    <Input
                      value={newRole}
                      onChange={(e) => setNewRole(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleAddRole()}
                      placeholder="e.g., Chair, Vice Chair, Member"
                    />
                    <Button onClick={handleAddRole} type="button">
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {groupForm.roles.map((role, idx) => {
                    const isLeader = (groupForm.leadership_roles || []).includes(role);
                    return (
                      <Badge
                        key={idx}
                        className={isLeader ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-700"}
                        data-testid={`badge-role-${role}`}
                      >
                        {role}
                        <button
                          type="button"
                          onClick={() => toggleLeadershipRole(role)}
                          className={`ml-2 ${isLeader ? "text-amber-700" : "text-slate-400 hover:text-amber-700"}`}
                          title={isLeader ? "Remove from Leadership" : "Mark as Leadership"}
                          data-testid={`button-toggle-leadership-${role}`}
                        >
                          <Crown className={`w-3 h-3 ${isLeader ? "fill-current" : ""}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveRole(role)}
                          className="ml-2 hover:text-red-600"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
                {(groupForm.leadership_roles || []).length > 0 && (
                  <p className="text-xs text-slate-500 mt-2 flex items-center gap-1">
                    <Crown className="w-3 h-3 fill-current text-amber-600" />
                    Leadership roles appear in the group's Leadership section.
                  </p>
                )}

                {(groupForm.roles || []).length > 0 && (
                  <div className="mt-4 space-y-2">
                    <Label htmlFor="role_terms_select">Per-role terms of reference</Label>
                    <p className="text-xs text-slate-500">
                      Optional. Provide a link to where the terms of reference for a specific role can be found. The role invite email and invite page link to this URL. Roles without a link simply show no terms of reference.
                    </p>
                    <Select
                      value={selectedRoleForTerms || ''}
                      onValueChange={(value) => setSelectedRoleForTerms(value)}
                    >
                      <SelectTrigger id="role_terms_select" data-testid="select-role-for-terms">
                        <SelectValue placeholder="Select a role to edit its terms…" />
                      </SelectTrigger>
                      <SelectContent>
                        {(groupForm.roles || []).map((role) => {
                          const hasTerms = !!((groupForm.role_terms_url || {})[role] || '').toString().trim();
                          return (
                            <SelectItem key={role} value={role}>
                              {role}{hasTerms ? ' • has terms link' : ''}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    {selectedRoleForTerms && (groupForm.roles || []).includes(selectedRoleForTerms) && (
                      <div className="space-y-3">
                        <div className="rounded-md border border-slate-200 p-3 space-y-3">
                          <p className="text-xs text-slate-500">
                            Term of office for the <strong>{selectedRoleForTerms}</strong> role. This is shown on any vacancy posted for the role and recorded against members when they're awarded or accept an invite.
                          </p>
                          <div className="flex flex-wrap gap-3">
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="role-term-value">Term length</Label>
                              <div className="flex flex-wrap gap-2">
                                <Input
                                  id="role-term-value"
                                  type="number"
                                  min="0"
                                  value={(groupForm.role_term_definitions || {})[selectedRoleForTerms]?.term_value ?? ''}
                                  onChange={(e) => setGroupForm((prev) => ({
                                    ...prev,
                                    role_term_definitions: {
                                      ...(prev.role_term_definitions || {}),
                                      [selectedRoleForTerms]: {
                                        ...((prev.role_term_definitions || {})[selectedRoleForTerms] || {}),
                                        term_value: e.target.value,
                                      },
                                    },
                                  }))}
                                  placeholder="e.g. 3"
                                  className="w-24"
                                  data-testid="input-role-term-value"
                                />
                                <Select
                                  value={(groupForm.role_term_definitions || {})[selectedRoleForTerms]?.term_unit || 'years'}
                                  onValueChange={(v) => setGroupForm((prev) => ({
                                    ...prev,
                                    role_term_definitions: {
                                      ...(prev.role_term_definitions || {}),
                                      [selectedRoleForTerms]: {
                                        ...((prev.role_term_definitions || {})[selectedRoleForTerms] || {}),
                                        term_unit: v,
                                      },
                                    },
                                  }))}
                                >
                                  <SelectTrigger className="w-[140px]" data-testid="select-role-term-unit">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="months">months</SelectItem>
                                    <SelectItem value="years">years</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="role-max-terms">Maximum terms</Label>
                              <Input
                                id="role-max-terms"
                                type="number"
                                min="0"
                                value={(groupForm.role_term_definitions || {})[selectedRoleForTerms]?.max_terms ?? ''}
                                onChange={(e) => setGroupForm((prev) => ({
                                  ...prev,
                                  role_term_definitions: {
                                    ...(prev.role_term_definitions || {}),
                                    [selectedRoleForTerms]: {
                                      ...((prev.role_term_definitions || {})[selectedRoleForTerms] || {}),
                                      max_terms: e.target.value,
                                    },
                                  },
                                }))}
                                placeholder="e.g. 2"
                                className="w-24"
                                data-testid="input-role-max-terms"
                              />
                            </div>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="role-terms-url">Terms of reference link</Label>
                          <Input
                            id="role-terms-url"
                            type="url"
                            inputMode="url"
                            value={(groupForm.role_terms_url || {})[selectedRoleForTerms] || ''}
                            onChange={(e) => setGroupForm((prev) => ({
                              ...prev,
                              role_terms_url: {
                                ...(prev.role_terms_url || {}),
                                [selectedRoleForTerms]: e.target.value
                              }
                            }))}
                            placeholder="https://example.org/terms-of-reference"
                            data-testid="input-role-terms-url"
                          />
                          <p className="text-xs text-slate-500">
                            The invitee for the <strong>{selectedRoleForTerms}</strong> role is shown a link to this page. Leave blank for no terms of reference.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_active"
                  checked={groupForm.is_active}
                  onChange={(e) => setGroupForm({ ...groupForm, is_active: e.target.checked })}
                  className="w-4 h-4"
                />
                <Label htmlFor="is_active" className="cursor-pointer">Active</Label>
              </div>

              <div className="pt-2 border-t border-slate-200">
                <EventImageUpload
                  value={groupForm.header_image_url}
                  onChange={(url) => setGroupForm({ ...groupForm, header_image_url: url })}
                  label="Header Image"
                  helpText={`Optional: Shown on the ${featureName} page when self-join is enabled`}
                />
              </div>

              <div className="pt-2 border-t border-slate-200 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="allow_self_join" className="cursor-pointer">Allow members to self-join</Label>
                    <span className="text-xs text-slate-500">Members will see this group on the {featureName} page and can join with one click</span>
                  </div>
                  <Switch
                    id="allow_self_join"
                    checked={groupForm.allow_self_join}
                    onCheckedChange={(checked) => setGroupForm({
                      ...groupForm,
                      allow_self_join: checked,
                      default_self_join_role: checked ? groupForm.default_self_join_role : ''
                    })}
                    data-testid="switch-allow-self-join"
                  />
                </div>

                {groupForm.allow_self_join && (
                  <div>
                    <Label htmlFor="default_self_join_role">Default Self-Join Role *</Label>
                    {(groupForm.roles || []).length === 0 ? (
                      <p className="text-xs text-red-600 mt-1">Add at least one role above before enabling self-join.</p>
                    ) : (
                      <Select
                        value={groupForm.default_self_join_role}
                        onValueChange={(val) => setGroupForm({ ...groupForm, default_self_join_role: val })}
                      >
                        <SelectTrigger id="default_self_join_role" data-testid="select-default-self-join-role">
                          <SelectValue placeholder="Select a default role..." />
                        </SelectTrigger>
                        <SelectContent>
                          {groupForm.roles.map((role) => (
                            <SelectItem key={role} value={role}>{role}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}

                {groupForm.allow_self_join && (
                  <div className="pt-2 border-t border-slate-100 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex flex-col gap-1">
                        <Label htmlFor="self_join_closed" className="cursor-pointer">Close registrations</Label>
                        <span className="text-xs text-slate-500">Group stays visible but new members cannot self-join</span>
                      </div>
                      <Switch
                        id="self_join_closed"
                        checked={!!groupForm.self_join_closed}
                        onCheckedChange={(checked) => setGroupForm({ ...groupForm, self_join_closed: checked })}
                        data-testid="switch-self-join-closed"
                      />
                    </div>
                    {groupForm.self_join_closed && (
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="self_join_closed_label">Closed button label</Label>
                        <Input
                          id="self_join_closed_label"
                          value={groupForm.self_join_closed_label}
                          onChange={(e) => setGroupForm({ ...groupForm, self_join_closed_label: e.target.value })}
                          placeholder="Registrations closed"
                          maxLength={80}
                          data-testid="input-self-join-closed-label"
                        />
                        <span className="text-xs text-slate-500">Text shown on the group card and detail page. Defaults to "Registrations closed" if left blank.</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-slate-200 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <Label>Enable project board for this group</Label>
                    <span className="text-xs text-slate-500">
                      Creates a default Kanban board when enabled. Qualifying members will see a "Group Projects" page where they can open boards for the group.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!groupForm.projects_enabled}
                    onChange={(e) => setGroupForm({ ...groupForm, projects_enabled: e.target.checked })}
                    className="w-4 h-4"
                    data-testid="checkbox-projects-enabled"
                  />
                </div>

                {groupForm.projects_enabled && (
                  <>
                    <div className="flex flex-col gap-1">
                      <Label>Roles allowed to access project board</Label>
                      <span className="text-xs text-slate-500">
                        Members assigned one of these roles will see the "Group Projects" page and be added to every board belonging to this group.
                      </span>
                    </div>
                    {(groupForm.roles || []).length === 0 ? (
                      <p className="text-xs text-slate-500">Add at least one role above to choose who can access project boards.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {groupForm.roles.map((role) => {
                          const checked = (groupForm.projects_enabled_roles || []).includes(role);
                          return (
                            <label
                              key={role}
                              className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1 text-sm cursor-pointer hover-elevate"
                              data-testid={`label-projects-role-${role}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleProjectsRole(role)}
                                className="w-4 h-4"
                                data-testid={`checkbox-projects-role-${role}`}
                              />
                              <span>{role}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="pt-2 border-t border-slate-200 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <Label>Allow simple events</Label>
                    <span className="text-xs text-slate-500">
                      Group Admins of this group can create and manage real single events scoped to this group (free tickets only, manual online links). Group members see these events on the Events page; the organiser can also choose to make a group event public.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!groupForm.events_enabled}
                    onChange={(e) => setGroupForm({ ...groupForm, events_enabled: e.target.checked })}
                    className="w-4 h-4"
                    data-testid="checkbox-events-enabled"
                  />
                </div>

                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <Label>Allow multi-session events</Label>
                    <span className="text-xs text-slate-500">
                      Group Admins of this group can create and manage real multi-session (complex) events scoped to this group, with tracks and sessions (free tickets only, manual online links).
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!groupForm.complex_events_enabled}
                    onChange={(e) => setGroupForm({ ...groupForm, complex_events_enabled: e.target.checked })}
                    className="w-4 h-4"
                    data-testid="checkbox-complex-events-enabled"
                  />
                </div>

                {(groupForm.events_enabled || groupForm.complex_events_enabled) && (
                  <p className="text-xs text-slate-500" data-testid="text-events-admin-note">
                    Event management is available to members flagged as Group Admin in the Members list above.
                  </p>
                )}
              </div>

              <div className="pt-2 border-t border-slate-200 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <Label>Enable group forum</Label>
                    <span className="text-xs text-slate-500">
                      Creates a private discussion forum for this group. Members of the group will see it in the Forum alongside any tenant-wide categories. Disabling hides the forum without deleting existing threads or posts.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!groupForm.forum_enabled}
                    onChange={(e) => setGroupForm({ ...groupForm, forum_enabled: e.target.checked })}
                    className="w-4 h-4"
                    data-testid="checkbox-forum-enabled"
                  />
                </div>

                {groupForm.forum_enabled && (
                  <>
                    <div className="flex flex-col gap-1">
                      <Label>Roles allowed to access the forum</Label>
                      <span className="text-xs text-slate-500">
                        Leave all unchecked to give every active group member access. Select specific roles to limit who can see and post in the group forum.
                      </span>
                    </div>
                    {(groupForm.roles || []).length === 0 ? (
                      <p className="text-xs text-slate-500">Add at least one role above to restrict forum access by role. Otherwise all group members get access.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {groupForm.roles.map((role) => {
                          const checked = (groupForm.forum_enabled_roles || []).includes(role);
                          return (
                            <label
                              key={role}
                              className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1 text-sm cursor-pointer hover-elevate"
                              data-testid={`label-forum-role-${role}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleForumRole(role)}
                                className="w-4 h-4"
                                data-testid={`checkbox-forum-role-${role}`}
                              />
                              <span>{role}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="pt-2 border-t border-slate-200 space-y-3">
                <div className="flex flex-col gap-1">
                  <Label>Linked resource subcategories</Label>
                  <span className="text-xs text-slate-500">
                    Select resource subcategories to link to this group. The group's Resources section shows tenant resources tagged with any of these. Resources created within the group are tagged with these subcategories and become visible tenant-wide on the Resources page under the matching filter.
                  </span>
                </div>

                {(() => {
                  const subQuery = groupSubcategorySearch.trim().toLowerCase();
                  const catsWithSubs = (resourceCategories || []).filter(
                    (cat) => Array.isArray(cat.subcategories) && cat.subcategories.length > 0
                  );
                  if (catsWithSubs.length === 0) {
                    return (
                      <p className="text-xs text-slate-500" data-testid="text-no-resource-subcategories">
                        No resource subcategories are defined yet. Add them under Resource Management first.
                      </p>
                    );
                  }
                  const filtered = catsWithSubs
                    .map((cat) => ({
                      ...cat,
                      _matchingSubs: subQuery
                        ? cat.subcategories.filter(
                            (sub) =>
                              sub.toLowerCase().includes(subQuery) ||
                              (cat.name || '').toLowerCase().includes(subQuery)
                          )
                        : cat.subcategories,
                    }))
                    .filter((cat) => cat._matchingSubs.length > 0);
                  return (
                    <>
                      <div className="relative">
                        <Input
                          placeholder="Search subcategories..."
                          value={groupSubcategorySearch}
                          onChange={(e) => setGroupSubcategorySearch(e.target.value)}
                          className="pr-9"
                          data-testid="input-search-resource-subcategories"
                        />
                        {groupSubcategorySearch && (
                          <button
                            type="button"
                            onClick={() => setGroupSubcategorySearch('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                            data-testid="button-clear-subcategory-search"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                      <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-md p-3 space-y-3">
                        {filtered.length === 0 ? (
                          <p className="text-sm text-slate-500 text-center py-4">No matching subcategories found</p>
                        ) : (
                          filtered.map((cat) => (
                            <div key={cat.id} className="space-y-1">
                              <p className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                                {cat.name}
                              </p>
                              <div className="flex flex-wrap gap-2 pl-1">
                                {cat._matchingSubs.map((sub) => {
                                  const checked = (groupForm.resource_subcategories || []).includes(sub);
                                  return (
                                    <label
                                      key={`${cat.id}-${sub}`}
                                      className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1 text-sm cursor-pointer hover-elevate"
                                      data-testid={`label-resource-subcategory-${sub}`}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => toggleResourceSubcategory(sub)}
                                        className="w-4 h-4"
                                        data-testid={`checkbox-resource-subcategory-${sub}`}
                                      />
                                      <span>{sub}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      {(groupForm.resource_subcategories || []).length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          <span className="text-xs font-medium text-slate-600 w-full">
                            Linked: {groupForm.resource_subcategories.length}
                          </span>
                          {groupForm.resource_subcategories.map((sub) => (
                            <Badge key={sub} variant="secondary" data-testid={`badge-linked-subcategory-${sub}`}>
                              {sub}
                              <button
                                type="button"
                                onClick={() => toggleResourceSubcategory(sub)}
                                className="ml-1 hover:text-slate-900"
                                data-testid={`button-remove-subcategory-${sub}`}
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowGroupDialog(false); resetGroupForm(); }}>
                Cancel
              </Button>
              <Button
                onClick={handleSaveGroup}
                disabled={createGroupMutation.isPending || updateGroupMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingGroup ? 'Update' : 'Create'} Group
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Assign Member Dialog */}
        <Dialog open={showAssignDialog} onOpenChange={(open) => {
          setShowAssignDialog(open);
          if (!open) {
            setMemberSearchQuery('');
            setDebouncedMemberSearch('');
            setAssignMode('');
            setSelectedOrganizationId('');
            setAssignForm({ member_id: '', guest_id: '', group_role: '', expires_at: null, is_group_admin: false, term_start_date: '', term_end_date: '', term_number: '' });
          }
        }}>
          <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Assign Member to {selectedGroup?.name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4 flex-1 overflow-hidden flex flex-col">
              {/* Step 1: Select Mode (Guest or Organization) */}
              <div className="space-y-2">
                <Label>Step 1: Select Category *</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={assignMode === 'guest' ? 'default' : 'outline'}
                    onClick={() => {
                      setAssignMode('guest');
                      setSelectedOrganizationId('');
                      setAssignForm({ ...assignForm, member_id: '', guest_id: '' });
                      setMemberSearchQuery('');
                    }}
                    className={assignMode === 'guest' ? 'bg-purple-600 hover:bg-purple-700' : ''}
                  >
                    Guests
                  </Button>
                  <Button
                    type="button"
                    variant={assignMode === 'organization' ? 'default' : 'outline'}
                    onClick={() => {
                      setAssignMode('organization');
                      setSelectedOrganizationId('');
                      setAssignForm({ ...assignForm, member_id: '', guest_id: '' });
                      setMemberSearchQuery('');
                      setDebouncedMemberSearch('');
                    }}
                    className={assignMode === 'organization' ? 'bg-blue-600 hover:bg-blue-700' : ''}
                  >
                    Members by Organisation
                  </Button>
                  <Button
                    type="button"
                    variant={assignMode === 'member' ? 'default' : 'outline'}
                    onClick={() => {
                      setAssignMode('member');
                      setSelectedOrganizationId('');
                      setAssignForm({ ...assignForm, member_id: '', guest_id: '' });
                      setMemberSearchQuery('');
                      setDebouncedMemberSearch('');
                    }}
                    className={assignMode === 'member' ? 'bg-blue-600 hover:bg-blue-700' : ''}
                    data-testid="button-assign-mode-member"
                  >
                    Search Members
                  </Button>
                </div>
              </div>

              {/* Step 2: For Organization mode, select organization */}
              {assignMode === 'organization' && (
                <div className="space-y-2">
                  <Label>Step 2: Select Organisation *</Label>
                  <Select 
                    value={selectedOrganizationId} 
                    onValueChange={(val) => {
                      setSelectedOrganizationId(val);
                      setAssignForm({ ...assignForm, member_id: '', guest_id: '' });
                      setMemberSearchQuery('');
                    }}
                  >
                    <SelectTrigger data-testid="select-organization">
                      <SelectValue placeholder={organizationsLoading ? "Loading organisations..." : "Select an organisation..."} />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      <SelectItem value="__no_org__">Members without organisation</SelectItem>
                      {organizations.map(org => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Step 3: Select Member/Guest */}
              {((assignMode === 'guest') || (assignMode === 'organization' && selectedOrganizationId)) && (
                <div className="space-y-2 flex-1 overflow-hidden flex flex-col">
                  <Label>{assignMode === 'guest' ? 'Step 2: Select Guest *' : 'Step 3: Select Member *'}</Label>
                  <Input
                    value={memberSearchQuery}
                    onChange={(e) => setMemberSearchQuery(e.target.value)}
                    placeholder="Search by name or email..."
                    className="mb-2"
                  />
                  <div className="border border-slate-200 rounded-md flex-1 overflow-y-auto min-h-[150px] max-h-[200px]">
                    {assignMode === 'guest' ? (
                      /* Guest list */
                      <>
                        {guests
                          .filter(guest => {
                            if (guest.is_active === false) return false;
                            const searchLower = memberSearchQuery.toLowerCase();
                            return (
                              guest.first_name?.toLowerCase().includes(searchLower) ||
                              guest.last_name?.toLowerCase().includes(searchLower) ||
                              guest.email?.toLowerCase().includes(searchLower) ||
                              guest.organisation?.toLowerCase().includes(searchLower)
                            );
                          })
                          .map((guest) => {
                            // New flow: provisioned guests use member_id on the assignment.
                            // Legacy (no member_id) fall back to guest_id.
                            const isSelected = guest.member_id
                              ? assignForm.member_id === guest.member_id
                              : assignForm.guest_id === guest.id;
                            return (
                              <button
                                key={`guest-${guest.id}`}
                                type="button"
                                onClick={() =>
                                  guest.member_id
                                    ? setAssignForm({ ...assignForm, member_id: guest.member_id, guest_id: '' })
                                    : setAssignForm({ ...assignForm, guest_id: guest.id, member_id: '' })
                                }
                                className={`w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-b-0 ${
                                  isSelected ? 'bg-purple-50 border-l-4 border-l-purple-600' : ''
                                }`}
                              >
                                <div className="font-medium text-slate-900 flex items-center gap-2">
                                  {guest.first_name} {guest.last_name}
                                  <Badge className="bg-purple-100 text-purple-700 text-[10px]">Guest</Badge>
                                </div>
                                <div className="text-xs text-slate-500">{guest.email}</div>
                                {guest.organisation && (
                                  <div className="text-xs text-slate-400">{guest.organisation}</div>
                                )}
                              </button>
                            );
                          })}
                        {guests.filter(guest => {
                          if (guest.is_active === false) return false;
                          const searchLower = memberSearchQuery.toLowerCase();
                          return (
                            guest.first_name?.toLowerCase().includes(searchLower) ||
                            guest.last_name?.toLowerCase().includes(searchLower) ||
                            guest.email?.toLowerCase().includes(searchLower) ||
                            guest.organisation?.toLowerCase().includes(searchLower)
                          );
                        }).length === 0 && (
                          <div className="px-3 py-4 text-center text-sm text-slate-500">
                            No guests found
                          </div>
                        )}
                      </>
                    ) : (
                      /* Members list filtered by organization */
                      <>
                        {filteredMembersLoading ? (
                          <div className="px-3 py-4 text-center text-sm text-slate-500">
                            Loading members...
                          </div>
                        ) : (
                          <>
                            {filteredMembers
                              .filter(member => {
                                // Exclude provisioned guest members from the regular member list
                                if (guestMemberIds.has(member.id)) return false;
                                const searchLower = memberSearchQuery.toLowerCase();
                                return (
                                  member.first_name?.toLowerCase().includes(searchLower) ||
                                  member.last_name?.toLowerCase().includes(searchLower) ||
                                  member.email?.toLowerCase().includes(searchLower)
                                );
                              })
                              .map((member) => (
                                <button
                                  key={`member-${member.id}`}
                                  type="button"
                                  onClick={() => setAssignForm({ ...assignForm, member_id: member.id, guest_id: '' })}
                                  className={`w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-b-0 ${
                                    assignForm.member_id === member.id ? 'bg-blue-50 border-l-4 border-l-blue-600' : ''
                                  }`}
                                >
                                  <div className="font-medium text-slate-900">
                                    {member.first_name} {member.last_name}
                                  </div>
                                  <div className="text-xs text-slate-500">{member.email}</div>
                                </button>
                              ))}
                            {filteredMembers.filter(member => {
                              if (guestMemberIds.has(member.id)) return false;
                              const searchLower = memberSearchQuery.toLowerCase();
                              return (
                                member.first_name?.toLowerCase().includes(searchLower) ||
                                member.last_name?.toLowerCase().includes(searchLower) ||
                                member.email?.toLowerCase().includes(searchLower)
                              );
                            }).length === 0 && (
                              <div className="px-3 py-4 text-center text-sm text-slate-500">
                                No members found in this organisation
                              </div>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Step 2 (member mode): direct typeahead search across all members */}
              {assignMode === 'member' && (
                <div className="space-y-2 flex-1 overflow-hidden flex flex-col">
                  <Label>Step 2: Search Members *</Label>
                  <Input
                    value={memberSearchQuery}
                    onChange={(e) => setMemberSearchQuery(e.target.value)}
                    placeholder="Search by name or email..."
                    className="mb-2"
                    data-testid="input-member-search"
                  />
                  <div className="border border-slate-200 rounded-md flex-1 overflow-y-auto min-h-[150px] max-h-[200px]">
                    {debouncedMemberSearch.trim().length < 2 ? (
                      <div className="px-3 py-4 text-center text-sm text-slate-500">
                        Type at least 2 characters to search.
                      </div>
                    ) : memberSearchLoading ? (
                      <div className="px-3 py-4 text-center text-sm text-slate-500">
                        Searching members...
                      </div>
                    ) : memberSearchResults.filter((m) => !guestMemberIds.has(m.id)).length === 0 ? (
                      <div className="px-3 py-4 text-center text-sm text-slate-500">
                        No members found
                      </div>
                    ) : (
                      memberSearchResults.filter((m) => !guestMemberIds.has(m.id)).map((member) => (
                        <button
                          key={`member-search-${member.id}`}
                          type="button"
                          onClick={() => setAssignForm({ ...assignForm, member_id: member.id, guest_id: '' })}
                          className={`w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-b-0 ${
                            assignForm.member_id === member.id ? 'bg-blue-50 border-l-4 border-l-blue-600' : ''
                          }`}
                          data-testid={`button-select-member-${member.id}`}
                        >
                          <div className="font-medium text-slate-900">
                            {member.first_name} {member.last_name}
                          </div>
                          <div className="text-xs text-slate-500">{member.email}</div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Role selection */}
              {(assignForm.member_id || assignForm.guest_id) && (
                <div className="space-y-2">
                  <Label>{assignMode === 'organization' ? 'Step 4' : 'Step 3'}: Select Role *</Label>
                  <Select
                    value={assignForm.group_role}
                    onValueChange={(value) => {
                      const roleTermDefs =
                        selectedGroup?.role_term_definitions && typeof selectedGroup.role_term_definitions === 'object'
                          ? selectedGroup.role_term_definitions
                          : {};
                      const snap = buildTermSnapshot(roleTermDefs[value], { role: value });
                      setAssignForm({
                        ...assignForm,
                        group_role: value,
                        term_start_date: snap.term_start_date || '',
                        term_end_date: snap.term_end_date || '',
                        term_number: snap.term_number != null ? String(snap.term_number) : ''
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a role..." />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedGroup?.roles?.map((role, idx) => (
                        <SelectItem key={idx} value={role}>
                          {role}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Expiry Date */}
              {(assignForm.member_id || assignForm.guest_id) && (
                <div className="space-y-2">
                  <Label>Expiry Date (Optional)</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full justify-start text-left font-normal"
                      >
                        <Calendar className="mr-2 h-4 w-4" />
                        {assignForm.expires_at ? format(assignForm.expires_at, 'PPP') : 'No expiry date'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarComponent
                        mode="single"
                        selected={assignForm.expires_at}
                        onSelect={(date) => setAssignForm({ ...assignForm, expires_at: date })}
                        initialFocus
                      />
                      {assignForm.expires_at && (
                        <div className="p-2 border-t">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full"
                            onClick={() => setAssignForm({ ...assignForm, expires_at: null })}
                          >
                            Clear date
                          </Button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>
              )}

              {/* Term */}
              {(assignForm.member_id || assignForm.guest_id) && assignForm.group_role && (
                <div className="space-y-3 rounded-md border border-slate-200 p-3">
                  <div>
                    <Label>Term (Optional)</Label>
                    <p className="text-xs text-slate-500">
                      Pre-filled from the role's configured term. Adjust if this member's term differs.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="assign-term-start">Term start date</Label>
                      <Input
                        id="assign-term-start"
                        type="date"
                        value={assignForm.term_start_date || ''}
                        onChange={(e) => setAssignForm({ ...assignForm, term_start_date: e.target.value })}
                        data-testid="input-assign-term-start-date"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="assign-term-end">Term end date</Label>
                      <Input
                        id="assign-term-end"
                        type="date"
                        value={assignForm.term_end_date || ''}
                        onChange={(e) => setAssignForm({ ...assignForm, term_end_date: e.target.value })}
                        data-testid="input-assign-term-end-date"
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="assign-term-number">Term number</Label>
                    <Input
                      id="assign-term-number"
                      type="number"
                      min="1"
                      step="1"
                      className="w-28"
                      value={assignForm.term_number || ''}
                      onChange={(e) => setAssignForm({ ...assignForm, term_number: e.target.value })}
                      placeholder="e.g. 1"
                      data-testid="input-assign-term-number"
                    />
                  </div>
                </div>
              )}

              {/* Group Admin toggle */}
              {(assignForm.member_id || assignForm.guest_id) && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-slate-200 p-3">
                  <div>
                    <Label htmlFor="assign-group-admin">Group Admin</Label>
                    <p className="text-xs text-slate-500">
                      Designate this person as an admin for this group.
                    </p>
                  </div>
                  <Switch
                    id="assign-group-admin"
                    data-testid="switch-group-admin"
                    checked={assignForm.is_group_admin === true}
                    onCheckedChange={(checked) => setAssignForm({ ...assignForm, is_group_admin: checked })}
                  />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAssignDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleAssignMember}
                disabled={assignMemberMutation.isPending || (!assignForm.member_id && !assignForm.guest_id) || !assignForm.group_role}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Assign Member
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Role Invitation Dialog */}
        <Dialog open={showInviteDialog} onOpenChange={(open) => {
          setShowInviteDialog(open);
          if (!open) {
            setInviteGroup(null);
            setInviteForm({ member_id: '', role: '' });
            setInviteMemberSearch('');
          }
        }}>
          <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Invite to a role{inviteGroup ? ` — ${inviteGroup.name}` : ''}</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              {(!inviteGroup?.roles || inviteGroup.roles.length === 0) ? (
                <p className="text-sm text-slate-500">
                  This group has no roles yet. Add roles to the group before inviting members into them.
                </p>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label>Role</Label>
                    <Select
                      value={inviteForm.role || ''}
                      onValueChange={(value) => setInviteForm({ ...inviteForm, role: value })}
                    >
                      <SelectTrigger data-testid="select-invite-role">
                        <SelectValue placeholder="Select a role…" />
                      </SelectTrigger>
                      <SelectContent>
                        {(inviteGroup.roles || []).map((role) => (
                          <SelectItem key={role} value={role}>{role}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Member</Label>
                    <Input
                      value={inviteMemberSearch}
                      onChange={(e) => setInviteMemberSearch(e.target.value)}
                      placeholder="Search members by name or email…"
                      data-testid="input-invite-member-search"
                    />
                    <div className="border border-slate-200 rounded-md max-h-48 overflow-y-auto">
                      {(() => {
                        const q = inviteMemberSearch.trim().toLowerCase();
                        const filtered = (members || [])
                          .filter((m) => m.email)
                          .filter((m) => {
                            if (!q) return true;
                            const hay = `${m.first_name || ''} ${m.last_name || ''} ${m.email || ''}`.toLowerCase();
                            return hay.includes(q);
                          })
                          .slice(0, 50);
                        if (filtered.length === 0) {
                          return <div className="p-3 text-sm text-slate-500">No members found.</div>;
                        }
                        return filtered.map((m) => (
                          <button
                            type="button"
                            key={m.id}
                            onClick={() => setInviteForm({ ...inviteForm, member_id: m.id })}
                            className={`w-full text-left px-3 py-2 text-sm hover-elevate ${inviteForm.member_id === m.id ? 'bg-blue-50 border-l-4 border-l-blue-600' : ''}`}
                            data-testid={`option-invite-member-${m.id}`}
                          >
                            <div className="font-medium text-slate-900">{`${m.first_name || ''} ${m.last_name || ''}`.trim() || 'Unnamed member'}</div>
                            <div className="text-xs text-slate-500">{m.email}</div>
                          </button>
                        ));
                      })()}
                    </div>
                    {inviteForm.member_id && (
                      <p className="text-xs text-slate-500">
                        Selected: {getMemberName(inviteForm.member_id)}
                      </p>
                    )}
                  </div>

                  <Button
                    onClick={handleSendInvite}
                    disabled={createInviteMutation.isPending || !inviteForm.member_id || !inviteForm.role}
                    className="w-full"
                    data-testid="button-send-invite"
                  >
                    {createInviteMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
                    Send invitation
                  </Button>
                </>
              )}

              <div className="pt-4 border-t border-slate-200">
                <h4 className="text-sm font-medium text-slate-700 mb-2">Invitations</h4>
                {loadingInvites ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                  </div>
                ) : invitations.length === 0 ? (
                  <p className="text-sm text-slate-500 py-2">No invitations yet.</p>
                ) : (
                  <div className="space-y-2 max-h-56 overflow-y-auto">
                    {invitations.map((inv) => (
                      <div key={inv.id} className="flex items-center justify-between gap-2 text-sm bg-slate-50 p-2 rounded" data-testid={`row-invite-${inv.id}`}>
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 truncate">{inv.member_name || inv.member_email || 'Member'}</div>
                          <div className="text-xs text-slate-500 truncate">{inv.group_role}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge
                            className={
                              inv.status === 'accepted' ? 'bg-green-100 text-green-700' :
                              inv.status === 'declined' ? 'bg-red-100 text-red-700' :
                              inv.status === 'pending' ? 'bg-blue-100 text-blue-700' :
                              'bg-slate-200 text-slate-600'
                            }
                            data-testid={`badge-invite-status-${inv.id}`}
                          >
                            {inv.status === 'accepted' && <CheckCircle2 className="w-3 h-3 mr-1" />}
                            {inv.status === 'declined' && <XCircle className="w-3 h-3 mr-1" />}
                            {inv.status === 'pending' && <Clock className="w-3 h-3 mr-1" />}
                            {inv.status}
                          </Badge>
                          {(inv.status === 'pending' || inv.status === 'expired') && (
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => resendInviteMutation.mutate(inv.id)}
                              disabled={resendInviteMutation.isPending}
                              title="Resend"
                              data-testid={`button-resend-invite-${inv.id}`}
                            >
                              <RotateCw className="w-3 h-3" />
                            </Button>
                          )}
                          {inv.status === 'pending' && (
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => cancelInviteMutation.mutate(inv.id)}
                              disabled={cancelInviteMutation.isPending}
                              title="Cancel"
                              className="text-red-600 hover:text-red-700"
                              data-testid={`button-cancel-invite-${inv.id}`}
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={!!inviteTermWarning}
          onOpenChange={(open) => {
            if (!open && !createInviteMutation.isPending) setInviteTermWarning(null);
          }}
        >
          <AlertDialogContent data-testid="dialog-invite-term-limit-warning">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-warning" />
                Maximum terms exceeded
              </AlertDialogTitle>
              <AlertDialogDescription data-testid="text-invite-term-limit-warning">
                Inviting {inviteTermWarning?.memberName} would be their term{' '}
                {inviteTermWarning?.nextTermNumber} as {inviteTermWarning?.role}, which
                exceeds the maximum of {inviteTermWarning?.maxTerms}{' '}
                {inviteTermWarning?.maxTerms === 1 ? 'term' : 'terms'} set for this role.
                You can still proceed, but please confirm this is intended.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={createInviteMutation.isPending}
                data-testid="button-cancel-invite-term-limit"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  submitInvite();
                }}
                disabled={createInviteMutation.isPending}
                data-testid="button-confirm-invite-term-limit"
              >
                Send anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Bulk Create Dialog */}
        <Dialog open={showBulkDialog} onOpenChange={setShowBulkDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Bulk Create Groups</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="bulk-text">Group Names (one per line)</Label>
                <Textarea
                  id="bulk-text"
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder="Board of Directors&#10;Finance Committee&#10;Audit Committee&#10;Nominations Committee"
                  rows={10}
                />
                <p className="text-xs text-slate-500 mt-1">
                  Enter one group name per line. Roles can be added later.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowBulkDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleBulkCreate}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Create Groups
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Bulk Edit Roles Dialog */}
        <Dialog open={showBulkEditDialog} onOpenChange={setShowBulkEditDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Bulk Edit Roles for {selectedGroups.length} Group{selectedGroups.length !== 1 ? 's' : ''}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Action</Label>
                <Select
                  value={bulkEditAction}
                  onValueChange={setBulkEditAction}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="add">Add Role</SelectItem>
                    <SelectItem value="remove">Remove Role</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="bulk-role">Role Name *</Label>
                <Input
                  id="bulk-role"
                  value={bulkEditRole}
                  onChange={(e) => setBulkEditRole(e.target.value)}
                  placeholder="e.g., Chair, Member, etc."
                />
                <p className="text-xs text-slate-500 mt-1">
                  {bulkEditAction === 'add' 
                    ? 'This role will be added to all selected groups (if not already present)'
                    : 'This role will be removed from all selected groups (if present)'}
                </p>
              </div>

              <div className="bg-slate-50 p-3 rounded-lg">
                <p className="text-sm font-medium text-slate-700 mb-2">Selected Groups:</p>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {selectedGroups.map(groupId => {
                    const group = groups.find(g => g.id === groupId);
                    return (
                      <div key={groupId} className="text-xs text-slate-600 flex items-center gap-2">
                        <span>•</span>
                        <span>{group?.name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowBulkEditDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleBulkEdit}
                disabled={bulkUpdateGroupsMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {bulkEditAction === 'add' ? 'Add' : 'Remove'} Role
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete Group</DialogTitle>
            </DialogHeader>
            <p className="text-slate-600">
              Are you sure you want to delete <strong>{groupToDelete?.name}</strong>? 
              This will also remove all member assignments to this group. This action cannot be undone.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => deleteGroupMutation.mutate(groupToDelete.id)}
                disabled={deleteGroupMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete Group
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Manage Classifications Dialog */}
        <Dialog
          open={showClassificationDialog}
          onOpenChange={(open) => {
            setShowClassificationDialog(open);
            if (!open) {
              setEditingClassification(null);
              setClassificationName('');
            }
          }}
        >
          <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Manage Classifications</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-slate-600">
              Classifications are organisational labels for member groups. They don't change permissions or behaviour — they just help you group and filter your groups.
            </p>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="classification-name">
                  {editingClassification ? 'Rename classification' : 'New classification'}
                </Label>
                <Input
                  id="classification-name"
                  value={classificationName}
                  onChange={(e) => setClassificationName(e.target.value)}
                  placeholder="e.g., Committees"
                  data-testid="input-classification-name"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveClassification(); } }}
                />
              </div>
              <Button
                onClick={handleSaveClassification}
                disabled={createClassificationMutation.isPending || updateClassificationMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-save-classification"
              >
                {editingClassification ? 'Save' : 'Add'}
              </Button>
              {editingClassification && (
                <Button
                  variant="outline"
                  onClick={() => { setEditingClassification(null); setClassificationName(''); }}
                >
                  Cancel
                </Button>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-2 mt-2">
              {classifications.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-6">No classifications yet. Add one above.</p>
              ) : (
                classifications.map((c) => {
                  const inUse = groups.filter(g => g.classification_id === c.id).length;
                  return (
                    <div
                      key={c.id}
                      className="flex items-center justify-between gap-2 p-2 rounded-md bg-slate-50"
                      data-testid={`row-classification-${c.id}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Tag className="w-4 h-4 text-indigo-600 shrink-0" />
                        <span className="font-medium text-slate-900 truncate">{c.name}</span>
                        <span className="text-xs text-slate-500 shrink-0">
                          {inUse} group{inUse !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => { setEditingClassification(c); setClassificationName(c.name); }}
                          data-testid={`button-edit-classification-${c.id}`}
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setClassificationToDelete(c)}
                          className="text-red-600 hover:text-red-700"
                          data-testid={`button-delete-classification-${c.id}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowClassificationDialog(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Classification Confirmation */}
        <Dialog open={!!classificationToDelete} onOpenChange={(open) => { if (!open) setClassificationToDelete(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete Classification</DialogTitle>
            </DialogHeader>
            {classificationToDelete && (() => {
              const inUse = groups.filter(g => g.classification_id === classificationToDelete.id).length;
              return (
                <p className="text-slate-600">
                  Are you sure you want to delete <strong>{classificationToDelete.name}</strong>?
                  {inUse > 0 && (
                    <> {inUse} group{inUse !== 1 ? 's' : ''} currently using it will be set to "no classification".</>
                  )} This action cannot be undone.
                </p>
              );
            })()}
            <DialogFooter>
              <Button variant="outline" onClick={() => setClassificationToDelete(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => deleteClassificationMutation.mutate(classificationToDelete.id)}
                disabled={deleteClassificationMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
                data-testid="button-confirm-delete-classification"
              >
                Delete Classification
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* All Members Dialog */}
        <Dialog
          open={!!membersModalGroupId}
          onOpenChange={(open) => { if (!open) setMembersModalGroupId(null); }}
        >
          <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
            {(() => {
              const modalGroup = groups.find(g => g.id === membersModalGroupId);
              const modalAssignments = membersModalGroupId
                ? getSortedGroupAssignments(membersModalGroupId)
                : [];
              return (
                <>
                  <DialogHeader>
                    <DialogTitle>
                      Members{modalGroup ? ` — ${modalGroup.name}` : ''} ({modalAssignments.length})
                    </DialogTitle>
                  </DialogHeader>
                  <div className="space-y-1 overflow-y-auto flex-1" data-testid="list-all-members">
                    {modalAssignments.length > 0 ? (
                      modalAssignments.map((assignment) => renderAssignmentRow(assignment))
                    ) : (
                      <p className="text-sm text-slate-500">No members in this group.</p>
                    )}
                  </div>
                </>
              );
            })()}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}