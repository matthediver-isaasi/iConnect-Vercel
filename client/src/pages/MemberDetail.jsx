import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/api/supabaseClient";
import { Loader2, ArrowLeft, User, Pencil, Save, X, Building2, Mail, Smartphone, PhoneCall, Briefcase, Shield, CalendarDays, LogIn, Users, Globe, ClipboardList, Calendar, FolderTree, Trophy, StickyNote, Plus, Search, MessageSquare, Trash2, ChevronLeft, ChevronRight, Key, Copy, Check, UserCheck, LayoutGrid, ChevronDown, ChevronUp, ExternalLink, AlertTriangle, Wallet, Settings2, Tag } from "lucide-react";
import MemberEmails from "@/components/MemberEmails";
import MemberMembershipTab from "@/components/MemberMembershipTab";
import CrmTagInput from "@/components/crm/CrmTagInput";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import { useMemberDetailLayout, mergeLayoutWithCustomFields, MEMBER_CORE_FIELDS } from "@/hooks/useMemberDetailLayout";
import MemberDetailLayoutEditor from "@/components/MemberDetailLayoutEditor";
import { useMemberFieldVisibilityRules, evaluateVisibilityRules } from "@/hooks/useMemberFieldVisibilityRules";
import MemberFieldVisibilityRulesEditor from "@/components/MemberFieldVisibilityRulesEditor";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useZohoInboundUpdateNotifier } from "@/hooks/useZohoInboundUpdateNotifier";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useWorkflowConfirmation } from "@/hooks/useWorkflowConfirmation";
import WorkflowConfirmationModal from "@/components/WorkflowConfirmationModal";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import MemberLoginStatusBadge from "@/components/MemberLoginStatusBadge";
import GuestAccessControl from "@/components/GuestAccessControl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { COUNTRIES } from "@/data/countries";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { ChevronsUpDown } from "lucide-react";

function MemberDetailCountryMultiSelect({ fieldId, selectedValues, availableCountries, onChange, label }) {
  const [open, setOpen] = useState(false);

  const toggleCountry = (countryName) => {
    if (selectedValues.includes(countryName)) {
      onChange(selectedValues.filter(v => v !== countryName));
    } else {
      onChange([...selectedValues, countryName]);
    }
  };

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="justify-between font-normal w-full min-h-9"
            data-testid={`select-countries-${fieldId}`}
          >
            <span className="truncate text-left flex-1 text-sm">
              {selectedValues.length === 0
                ? `Select ${label.toLowerCase()}`
                : `${selectedValues.length} countr${selectedValues.length === 1 ? 'y' : 'ies'} selected`}
            </span>
            <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search countries..." />
            <CommandList>
              <CommandEmpty>No countries found.</CommandEmpty>
              <CommandGroup className="max-h-[250px] overflow-auto">
                {availableCountries.map(country => (
                  <CommandItem
                    key={country.code}
                    value={country.name}
                    onSelect={() => toggleCountry(country.name)}
                  >
                    <Check className={`mr-2 h-4 w-4 ${selectedValues.includes(country.name) ? 'opacity-100' : 'opacity-0'}`} />
                    {country.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selectedValues.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedValues.map(name => (
            <Badge key={name} variant="secondary" className="text-xs">
              {name}
              <button
                type="button"
                onClick={() => toggleCountry(name)}
                className="ml-1"
                data-testid={`button-remove-country-${name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MemberDetail() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { isAdmin, isAccessReady, isFeatureExcluded } = useMemberAccess();
  const { formatDate } = useDateFormat();

  const {
    pendingWorkflows,
    showConfirmationModal,
    setShowConfirmationModal,
    checkForPendingWorkflows,
    handleConfirmWorkflow,
    handleSkipWorkflow,
    handleSkipAllWorkflows,
  } = useWorkflowConfirmation();
  const [isEditing, setIsEditing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    mobile: '',
    landline: '',
    job_title: '',
    biography: '',
    organization_id: '',
    login_enabled: true,
    show_in_directory: true
  });
  const [selectedRoleId, setSelectedRoleId] = useState(null);
  const [selectedSubcategories, setSelectedSubcategories] = useState([]);
  const [isSavingCategories, setIsSavingCategories] = useState(false);
  const [openingBalances, setOpeningBalances] = useState({
    eventsAttended: 0,
    articlesPublished: 0,
    jobsPosted: 0,
    awards: 0,
    engagementAwards: 0
  });
  const [isSavingBalances, setIsSavingBalances] = useState(false);
  
  // Notes state
  const [newNoteContent, setNewNoteContent] = useState('');
  const [noteSearchTerm, setNoteSearchTerm] = useState('');
  const [notesPage, setNotesPage] = useState(1);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');
  const [noteToDelete, setNoteToDelete] = useState(null);
  const notesPerPage = 10;
  
  // Layout state
  const [showLayoutEditor, setShowLayoutEditor] = useState(false);
  const [showRulesEditor, setShowRulesEditor] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState({});
  const [customFieldValues, setCustomFieldValues] = useState({});

  // Delete member state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // Communications state
  const [updatingCommPrefs, setUpdatingCommPrefs] = useState(new Set());
  const [updatingOptOutAll, setUpdatingOptOutAll] = useState(false);
  
  // Password reset state
  const [isGeneratingResetLink, setIsGeneratingResetLink] = useState(false);
  const [generatedResetLink, setGeneratedResetLink] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  
  // Handler for generating password reset link
  const handleGenerateResetLink = async () => {
    if (!member?.id) return;
    
    setIsGeneratingResetLink(true);
    setGeneratedResetLink('');
    setLinkCopied(false);
    try {
      const response = await fetch(`/api/admin/members/${member.id}/generate-reset-link`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate reset link');
      }
      
      setGeneratedResetLink(data.resetUrl);
      toast.success('Password reset link generated! Valid for 24 hours.');
    } catch (error) {
      console.error('Error generating reset link:', error);
      toast.error(error.message || 'Failed to generate password reset link');
    } finally {
      setIsGeneratingResetLink(false);
    }
  };
  
  const [isMasquerading, setIsMasquerading] = useState(false);

  const handleMasquerade = async () => {
    if (!member?.id) return;
    
    setIsMasquerading(true);
    try {
      const response = await fetch('/api/auth/masquerade', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: member.id, returnUrl: window.location.pathname }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to start masquerade');
      }
      
      toast.success(`Now viewing as ${member.first_name} ${member.last_name}`);
      window.location.href = '/';
    } catch (error) {
      console.error('Error starting masquerade:', error);
      toast.error(error.message || 'Failed to masquerade as member');
    } finally {
      setIsMasquerading(false);
    }
  };

  // Handler for copying reset link to clipboard
  const handleCopyResetLink = async () => {
    if (!generatedResetLink) return;
    try {
      await navigator.clipboard.writeText(generatedResetLink);
      setLinkCopied(true);
      toast.success('Link copied to clipboard!');
      setTimeout(() => setLinkCopied(false), 2000);
    } catch (error) {
      toast.error('Failed to copy link');
    }
  };

  // Data queries
  const { data: member, isLoading: memberLoading } = useQuery({
    queryKey: ['member-detail', id],
    enabled: isAccessReady && !!id,
    queryFn: () => base44.entities.Member.get(id)
  });

  // Toast + refresh when this member is updated by an inbound Zoho sync.
  useZohoInboundUpdateNotifier({
    entityType: 'member',
    entityId: id,
    enabled: !!id && isAccessReady,
    queryKeysToInvalidate: [
      ['member-detail', id],
      ['member-pref-values', id],
      ['members-paginated']
    ]
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations-for-member-detail'],
    enabled: isAccessReady,
    queryFn: () => base44.entities.Organization.list('name')
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles-for-member-detail'],
    enabled: isAccessReady,
    queryFn: () => base44.entities.Role.list()
  });

  const { layoutConfig, isLoading: isLayoutLoading, saveLayout, isSaving: isLayoutSaving } = useMemberDetailLayout({ enabled: isAccessReady });
  const { rulesConfig, saveRules, isSaving: isRulesSaving } = useMemberFieldVisibilityRules({ enabled: isAccessReady });

  const { data: memberCustomFields = [] } = useQuery({
    queryKey: ['member-custom-fields-for-detail'],
    enabled: isAccessReady,
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

  const { data: memberPrefValues = [] } = useQuery({
    queryKey: ['member-pref-values', id],
    enabled: !!id && isAccessReady,
    queryFn: async () => {
      try {
        const values = await base44.entities.MemberPreferenceValue.list({
          filter: { member_id: id }
        });
        return values || [];
      } catch {
        return [];
      }
    }
  });

  const effectiveLayout = useMemo(() => 
    mergeLayoutWithCustomFields(layoutConfig, memberCustomFields),
    [layoutConfig, memberCustomFields]
  );

  const toggleSection = (cardId) => {
    setCollapsedSections(prev => ({ ...prev, [cardId]: !prev[cardId] }));
  };

  // Activity tab queries
  const { data: memberBookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['member-detail-bookings', id, member?.email],
    enabled: !!id && activeTab === 'activity',
    queryFn: async () => {
      const memberEmail = (member?.email || '').trim();
      try {
        const queries = [
          base44.entities.Booking.list({ filter: { member_id: id } })
        ];
        if (memberEmail) {
          queries.push(
            base44.entities.Booking.list({ filter: { attendee_email: { ilike: memberEmail } } })
          );
        }
        const results = await Promise.all(queries.map(p => p.catch((err) => {
          console.error('[MemberDetail] member-detail-bookings sub-query failed', err);
          return [];
        })));
        const seen = new Set();
        const merged = [];
        for (const list of results) {
          for (const b of (list || [])) {
            if (b && b.id && !seen.has(b.id)) {
              seen.add(b.id);
              merged.push(b);
            }
          }
        }
        return merged.sort((a, b) =>
          new Date(b.created_date || 0) - new Date(a.created_date || 0)
        );
      } catch (err) {
        console.error('[MemberDetail] member-detail-bookings query failed', err);
        return [];
      }
    }
  });

  const { data: complexBookings = [], isLoading: complexBookingsLoading } = useQuery({
    queryKey: ['member-detail-complex-bookings', id, member?.email],
    enabled: !!id && activeTab === 'activity',
    queryFn: async () => {
      const memberEmail = (member?.email || '').trim();
      try {
        const queries = [
          base44.entities.ComplexEventBooking.list({ filter: { member_id: id } })
        ];
        if (memberEmail) {
          queries.push(
            base44.entities.ComplexEventBooking.list({ filter: { attendee_email: { ilike: memberEmail } } })
          );
        }
        const results = await Promise.all(queries.map(p => p.catch((err) => {
          console.error('[MemberDetail] member-detail-complex-bookings sub-query failed', err);
          return [];
        })));
        const seen = new Set();
        const merged = [];
        for (const list of results) {
          for (const b of (list || [])) {
            if (b && b.id && !seen.has(b.id)) {
              seen.add(b.id);
              merged.push(b);
            }
          }
        }
        return merged;
      } catch (err) {
        console.error('[MemberDetail] member-detail-complex-bookings query failed', err);
        return [];
      }
    }
  });

  const { data: events = [] } = useQuery({
    queryKey: ['events-for-member-detail'],
    enabled: activeTab === 'activity' && memberBookings.length > 0,
    queryFn: async () => {
      try {
        return await base44.entities.Event.list();
      } catch (err) {
        console.error('[MemberDetail] events-for-member-detail query failed', err);
        return [];
      }
    }
  });

  const complexEventIds = useMemo(() => {
    const ids = new Set();
    for (const b of complexBookings) {
      if (b?.event_id) ids.add(b.event_id);
    }
    return Array.from(ids);
  }, [complexBookings]);

  const { data: complexEvents = [] } = useQuery({
    queryKey: ['complex-events-for-member-detail', complexEventIds],
    enabled: activeTab === 'activity' && complexEventIds.length > 0,
    queryFn: async () => {
      try {
        return await base44.entities.ComplexEvent.list({
          filter: { id: { in: complexEventIds } }
        }) || [];
      } catch (err) {
        console.error('[MemberDetail] complex-events-for-member-detail query failed', err);
        return [];
      }
    }
  });

  const memberEmailLower = (member?.email || '').trim().toLowerCase();

  const unifiedBookings = useMemo(() => {
    const buildAttendeeName = (b) => {
      const first = (b?.attendee_first_name || '').trim();
      const last = (b?.attendee_last_name || '').trim();
      const full = `${first} ${last}`.trim();
      return full || (b?.attendee_email || '').trim() || '';
    };

    const simpleItems = (memberBookings || []).map(b => {
      const event = events.find(e => e.id === b.event_id);
      const isBuyer = !!(id && b.member_id && b.member_id === id);
      const attendeeEmail = (b.attendee_email || '').trim().toLowerCase();
      const isAttendee = !!(memberEmailLower && attendeeEmail === memberEmailLower);
      const bookingDate = b.created_date || b.created_at || null;
      return {
        key: `simple-${b.id}`,
        id: b.id,
        source: 'simple',
        title: event?.title || 'Unknown Event',
        eventDate: event?.start_date || null,
        bookingDate,
        date: bookingDate,
        attendeeName: buildAttendeeName(b),
        ticketClassName: b.ticket_class_name || null,
        status: b.status || 'confirmed',
        isAttendeeOnly: !isBuyer && isAttendee,
      };
    });

    const complexItems = (complexBookings || []).map(b => {
      const ev = complexEvents.find(e => e.id === b.event_id);
      const isBuyer = !!(id && b.member_id && b.member_id === id);
      const attendeeEmail = (b.attendee_email || '').trim().toLowerCase();
      const isAttendee = !!(memberEmailLower && attendeeEmail === memberEmailLower);
      const bookingDate = b.created_at || null;
      return {
        key: `complex-${b.id}`,
        id: b.id,
        source: 'complex',
        title: ev?.title || 'Unknown Event',
        eventDate: ev?.start_date || null,
        bookingDate,
        date: bookingDate,
        attendeeName: buildAttendeeName(b),
        ticketClassName: b.ticket_class_name || null,
        status: b.status || 'confirmed',
        isAttendeeOnly: !isBuyer && isAttendee,
      };
    });

    return [...simpleItems, ...complexItems]
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 20);
  }, [memberBookings, complexBookings, events, complexEvents, id, memberEmailLower]);

  const anyBookingsLoading = bookingsLoading || complexBookingsLoading;

  // Categories tab queries
  const { data: resourceCategories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['resource-categories-for-member-detail'],
    enabled: activeTab === 'categories',
    queryFn: async () => {
      try {
        const categories = await base44.entities.ResourceCategory.list({
          filter: { is_active: true }
        });
        return categories || [];
      } catch {
        return [];
      }
    }
  });

  const { data: memberCategorySelections = [], isLoading: selectionsLoading } = useQuery({
    queryKey: ['member-resource-categories', id],
    enabled: !!id && activeTab === 'categories',
    queryFn: async () => {
      try {
        const response = await fetch(`/api/members/${id}/categories`, {
          credentials: 'include'
        });
        if (!response.ok) return [];
        return await response.json();
      } catch {
        return [];
      }
    }
  });

  // Notes query
  const { data: memberNotes = [], isLoading: notesLoading } = useQuery({
    queryKey: ['member-notes', id],
    enabled: !!id && activeTab === 'notes',
    queryFn: async () => {
      const res = await fetch(`/api/admin/members/${id}/notes`, {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to fetch notes');
      return res.json();
    }
  });

  // Notes mutations
  const createNoteMutation = useMutation({
    mutationFn: async ({ content }) => {
      const res = await fetch(`/api/admin/members/${id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content })
      });
      if (!res.ok) throw new Error('Failed to create note');
      return res.json();
    },
    onSuccess: () => {
      setNewNoteContent('');
      queryClient.invalidateQueries({ queryKey: ['member-notes', id] });
      toast.success('Note added');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to create note');
    }
  });

  const updateNoteMutation = useMutation({
    mutationFn: async ({ noteId, content }) => {
      const res = await fetch(`/api/admin/member-notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content })
      });
      if (!res.ok) throw new Error('Failed to update note');
      return res.json();
    },
    onSuccess: () => {
      setEditingNoteId(null);
      setEditingNoteContent('');
      queryClient.invalidateQueries({ queryKey: ['member-notes', id] });
      toast.success('Note updated');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update note');
    }
  });

  const deleteNoteMutation = useMutation({
    mutationFn: async (noteId) => {
      const res = await fetch(`/api/admin/member-notes/${noteId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to delete note');
      return res.json();
    },
    onSuccess: () => {
      setNoteToDelete(null);
      queryClient.invalidateQueries({ queryKey: ['member-notes', id] });
      toast.success('Note deleted');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to delete note');
    }
  });

  const deleteMemberMutation = useMutation({
    mutationFn: async () => {
      await base44.entities.Member.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members-paginated'] });
      setShowDeleteDialog(false);
      setDeleteConfirmText('');
      toast.success('Member deleted successfully');
      window.location.href = '/members';
    },
    onError: (error) => {
      toast.error(error.message || 'Could not delete member. Please try again.');
    }
  });

  // Communication categories and preferences (tenant-scoped via entity API)
  const { data: communicationCategories = [], isLoading: communicationCategoriesLoading } = useQuery({
    queryKey: ["communicationCategories"],
    enabled: activeTab === 'communications' || activeTab === 'overview',
    queryFn: async () => {
      const categories = await base44.entities.CommunicationCategory.list({
        filter: { is_active: true },
        sort: { display_order: 'asc' }
      });
      const roleAssignments = await base44.entities.CommunicationCategoryRole.list();
      return (categories || []).map(cat => ({
        ...cat,
        communication_category_role: (roleAssignments || []).filter(r => r.category_id === cat.id)
      }));
    },
  });

  const { data: communicationPreferences = [] } = useQuery({
    queryKey: ["communicationPreferences", id],
    enabled: !!id && (activeTab === 'communications' || activeTab === 'overview'),
    queryFn: async () => {
      if (!id) return [];
      const { data, error } = await supabase
        .from("member_communication_preference")
        .select("*")
        .eq("member_id", id);
      if (error) throw error;
      return data || [];
    },
  });

  const memberRoleIds = useMemo(() => {
    const roleId = formData.role_id || member?.role_id;
    if (!roleId) return [];
    if (Array.isArray(roleId)) return roleId;
    return [roleId];
  }, [formData.role_id, member?.role_id]);

  const availableCommCategories = useMemo(() => {
    if (!communicationCategories.length) return [];
    
    return communicationCategories.filter(category => {
      if (!category.communication_category_role?.length) return true;
      const categoryRoleIds = category.communication_category_role.map(r => r.role_id);
      return memberRoleIds.some(roleId => categoryRoleIds.includes(roleId));
    });
  }, [communicationCategories, memberRoleIds]);

  const handleCommunicationToggle = async (categoryId, isSubscribed) => {
    if (!member?.id) return;
    
    setUpdatingCommPrefs(prev => new Set(prev).add(categoryId));
    
    try {
      const response = await fetch(
        `/api/admin/members/${member.id}/communication-preferences/${categoryId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ is_subscribed: isSubscribed }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update preference');
      }
      
      queryClient.invalidateQueries({ queryKey: ["communicationPreferences", id] });
      toast.success(isSubscribed ? "Subscribed to updates" : "Unsubscribed from updates");
    } catch (error) {
      console.error("Failed to update communication preference:", error);
      toast.error(error.message || "Failed to update preference");
    } finally {
      setUpdatingCommPrefs(prev => {
        const next = new Set(prev);
        next.delete(categoryId);
        return next;
      });
    }
  };

  const handleOptOutAllToggle = async (optOut) => {
    if (!member?.id) return;
    setUpdatingOptOutAll(true);
    try {
      const { error } = await supabase
        .from("member")
        .update({ communications_opted_out_all: optOut })
        .eq("id", member.id);
      if (error) throw error;

      if (optOut && availableCommCategories.length > 0) {
        for (const category of availableCommCategories) {
          const existingPref = communicationPreferences.find(p => p.category_id === category.id);
          if (existingPref) {
            await supabase
              .from('member_communication_preference')
              .update({ is_subscribed: false })
              .eq('id', existingPref.id);
          } else {
            await supabase
              .from('member_communication_preference')
              .insert({
                member_id: member.id,
                category_id: category.id,
                is_subscribed: false
              });
          }
        }
      }

      queryClient.invalidateQueries({ queryKey: ['member-detail', id] });
      queryClient.invalidateQueries({ queryKey: ["communicationPreferences", id] });
      toast.success(optOut ? "Opted out of all communications" : "Communications re-enabled");
    } catch (error) {
      console.error("Failed to update opt-out-all:", error);
      toast.error("Failed to update opt-out preference");
    } finally {
      setUpdatingOptOutAll(false);
    }
  };

  // Sync formData with member
  useEffect(() => {
    if (member?.id && !isEditing) {
      setFormData({
        first_name: member.first_name || '',
        last_name: member.last_name || '',
        email: member.email || '',
        mobile: member.mobile || '',
        landline: member.landline || '',
        job_title: member.job_title || '',
        biography: member.biography || '',
        organization_id: member.organization_id || '',
        login_enabled: member.login_enabled !== false,
        show_in_directory: member.show_in_directory !== false
      });
      setSelectedRoleId(member.role_id || null);
    }
  }, [member, isEditing]);

  useEffect(() => {
    if (memberCustomFields.length > 0 && memberPrefValues.length >= 0) {
      const vals = {};
      memberPrefValues.forEach(pv => {
        const field = memberCustomFields.find(f => f.id === pv.field_id);
        if (field) {
          if ((field.field_type === 'picklist' || field.field_type === 'list' || field.field_type === 'countries') && typeof pv.value === 'string') {
            try { vals[field.id] = JSON.parse(pv.value); } catch { vals[field.id] = pv.value; }
          } else {
            vals[field.id] = pv.value;
          }
        }
      });
      setCustomFieldValues(vals);
    }
  }, [memberPrefValues, memberCustomFields]);

  // Sync category selections when data loads
  useEffect(() => {
    if (memberCategorySelections.length > 0) {
      setSelectedSubcategories(memberCategorySelections.map(s => ({
        category_id: s.category_id,
        subcategory_name: s.subcategory_name || null
      })));
    }
  }, [memberCategorySelections]);

  // Sync opening balances from member data
  useEffect(() => {
    if (member?.opening_balances) {
      const ob = member.opening_balances;
      setOpeningBalances({
        eventsAttended: ob.eventsAttended || 0,
        articlesPublished: ob.articlesPublished || 0,
        jobsPosted: ob.jobsPosted || 0,
        awards: ob.awards || 0,
        engagementAwards: ob.engagementAwards || 0
      });
    }
  }, [member?.opening_balances]);

  // Mutation
  const updateMutation = useMutation({
    mutationFn: (data) => base44.entities.Member.update(id, data),
    onSuccess: async () => {
      try {
        await saveCustomFieldValues();
      } catch (error) {
        console.error('Failed to save custom fields:', error);
      }
      toast.success("Member updated successfully");
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ['members-paginated'] });
      queryClient.invalidateQueries({ queryKey: ['member-detail', id] });
    },
    onError: (error) => {
      toast.error("Failed to update member: " + (error.message || "Unknown error"));
    }
  });

  // Helpers
  const getMemberName = (m) => [m?.first_name, m?.last_name].filter(Boolean).join(' ') || '';
  const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };
  const getOrganization = () => organizations.find(o => o.id === member?.organization_id);
  const getRoleName = (roleId) => {
    const role = roles.find(r => r.id === roleId);
    if (role) return role.name;
    // Role not in this tenant's loaded role list — surface a clear "Unknown
    // role" label and emit a console.warn so cross-tenant role leaks (see
    // task-647) become visible immediately instead of being hidden behind a
    // raw UUID render. Never expose the offending UUID in the UI.
    if (roleId) {
      console.warn('[MemberDetail] Unknown role on member', {
        role_id: roleId,
        member_id: member?.id,
        tenant_id: member?.tenant_id,
      });
    }
    return 'Unknown role';
  };

  // Category helpers
  const isSubcategorySelected = (categoryId, subcategoryName) => {
    return selectedSubcategories.some(s => 
      s.category_id === categoryId && s.subcategory_name === subcategoryName
    );
  };

  const toggleSubcategory = (categoryId, subcategoryName) => {
    setSelectedSubcategories(prev => {
      const exists = prev.some(s => 
        s.category_id === categoryId && s.subcategory_name === subcategoryName
      );
      if (exists) {
        return prev.filter(s => 
          !(s.category_id === categoryId && s.subcategory_name === subcategoryName)
        );
      } else {
        return [...prev, { category_id: categoryId, subcategory_name: subcategoryName }];
      }
    });
  };

  const handleSaveCategories = async () => {
    if (!member?.id) return;
    setIsSavingCategories(true);
    try {
      const response = await fetch(`/api/members/${member.id}/categories`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ selections: selectedSubcategories })
      });
      if (!response.ok) throw new Error('Failed to save');
      toast.success('Category preferences saved');
      queryClient.invalidateQueries({ queryKey: ['member-resource-categories', id] });
    } catch (error) {
      toast.error('Failed to save category preferences');
    } finally {
      setIsSavingCategories(false);
    }
  };

  const handleSaveOpeningBalances = async () => {
    if (!member?.id) return;
    setIsSavingBalances(true);
    try {
      await base44.entities.Member.update(member.id, {
        opening_balances: openingBalances
      });
      toast.success('Opening balances saved');
      queryClient.invalidateQueries({ queryKey: ['member-detail', id] });
    } catch (error) {
      toast.error('Failed to save opening balances');
    } finally {
      setIsSavingBalances(false);
    }
  };

  const saveCustomFieldValues = async () => {
    if (!member?.id || Object.keys(customFieldValues).length === 0) return;
    const updates = Object.entries(customFieldValues).map(async ([fieldId, value]) => {
      const existingValue = memberPrefValues.find(pv => pv.field_id === fieldId);
      const field = memberCustomFields.find(f => f.id === fieldId);
      let storedValue = value;
      if ((field?.field_type === 'picklist' || field?.field_type === 'list' || field?.field_type === 'countries') && Array.isArray(value)) {
        storedValue = JSON.stringify(value);
      }
      const existingStored = existingValue?.value || '';
      const newStored = Array.isArray(storedValue) ? JSON.stringify(storedValue) : String(storedValue ?? '');
      if (newStored === existingStored) return;
      if (!existingValue && (storedValue === undefined || storedValue === '' || storedValue === null)) return;

      const res = await fetch('/api/entities/member-preference-value/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          member_id: member.id,
          field_id: fieldId,
          value: newStored
        })
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to save custom field');
      }
      const data = await res.json();
      checkForPendingWorkflows(data);
      return data;
    });
    await Promise.all(updates);
    queryClient.invalidateQueries({ queryKey: ['member-pref-values', id] });
    queryClient.invalidateQueries({ queryKey: ['all-member-preference-values-crm'] });
  };

  // Handlers
  const handleSave = () => {
    const textareaFields = (memberCustomFields || []).filter(f =>
      (f.field_type === 'textarea' || f.field_type === 'long_text') && (f.min_length || f.max_length)
    );
    for (const field of textareaFields) {
      const val = customFieldValues[field.id] || '';
      const len = val.length;
      if (field.min_length && len > 0 && len < field.min_length) {
        toast.error(`${field.label} must be at least ${field.min_length} characters`);
        return;
      }
      if (field.max_length && len > field.max_length) {
        toast.error(`${field.label} must be at most ${field.max_length} characters`);
        return;
      }
    }
    updateMutation.mutate({ ...formData, role_id: selectedRoleId });
  };

  const handleCancel = () => {
    setFormData({
      first_name: member.first_name || '',
      last_name: member.last_name || '',
      email: member.email || '',
      mobile: member.mobile || '',
      landline: member.landline || '',
      job_title: member.job_title || '',
      biography: member.biography || '',
      organization_id: member.organization_id || '',
      login_enabled: member.login_enabled !== false,
      show_in_directory: member.show_in_directory !== false
    });
    setSelectedRoleId(member.role_id || null);
    setIsEditing(false);
  };

  const renderMemberCustomFieldEditor = (field, isLocked = false) => {
    const value = customFieldValues[field.id];
    const disabledOverride = !isEditing || isLocked;
    switch (field.field_type) {
      case 'text':
        return isEditing ? (
          <Input value={value || ''} onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))} disabled={isLocked} data-testid={`input-member-custom-${field.id}`} />
        ) : (
          <p className="text-sm">{value || '-'}</p>
        );
      case 'number':
      case 'decimal':
        return isEditing ? (
          <Input type="number" step={field.field_type === 'decimal' ? '0.01' : '1'} value={value || ''} onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))} disabled={isLocked} data-testid={`input-member-custom-${field.id}`} />
        ) : (
          <p className="text-sm">{value || '-'}</p>
        );
      case 'dropdown':
        return isEditing ? (
          <Select value={value || ''} onValueChange={(v) => setCustomFieldValues(prev => ({ ...prev, [field.id]: v }))} disabled={isLocked}>
            <SelectTrigger data-testid={`select-member-custom-${field.id}`}><SelectValue placeholder={`Select ${field.label}`} /></SelectTrigger>
            <SelectContent>
              {(field.options || []).map((opt, idx) => (
                <SelectItem key={idx} value={opt.value}>{opt.label || opt.value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-sm">{(field.options || []).find(o => o.value === value)?.label || value || '-'}</p>
        );
      case 'picklist': {
        const selectedValues = Array.isArray(value) ? value : [];
        return isEditing ? (
          <div className="space-y-2">
            {(field.options || []).map((opt, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Checkbox
                  checked={selectedValues.includes(opt.value)}
                  onCheckedChange={(checked) => {
                    if (isLocked) return;
                    const newValues = checked ? [...selectedValues, opt.value] : selectedValues.filter(v => v !== opt.value);
                    setCustomFieldValues(prev => ({ ...prev, [field.id]: newValues }));
                  }}
                  disabled={isLocked}
                  data-testid={`checkbox-member-custom-${field.id}-${opt.value}`}
                />
                <span className="text-sm">{opt.label || opt.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm">{selectedValues.length > 0 ? selectedValues.join(', ') : '-'}</p>
        );
      }
      case 'date':
        return isEditing ? (
          <Input type="date" value={value || ''} onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))} disabled={isLocked} data-testid={`input-member-custom-date-${field.id}`} />
        ) : (
          <p className="text-sm">{value ? formatDate(value) : '-'}</p>
        );
      case 'email':
        return isEditing ? (
          <Input type="email" value={value || ''} onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))} disabled={isLocked} data-testid={`input-member-custom-email-${field.id}`} />
        ) : (
          <p className="text-sm">{value ? <a href={`mailto:${value}`} className="text-blue-600 hover:underline">{value}</a> : '-'}</p>
        );
      case 'url':
        return isEditing ? (
          <Input type="url" value={value || ''} onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))} placeholder="https://" disabled={isLocked} data-testid={`input-member-custom-url-${field.id}`} />
        ) : (
          <p className="text-sm">{value ? <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">{value} <ExternalLink className="w-3 h-3" /></a> : '-'}</p>
        );
      case 'textarea':
      case 'long_text': {
        const taCharCount = (value || '').length;
        const taMaxLen = field.max_length;
        const taMinLen = field.min_length;
        const taOverLimit = taMaxLen && taCharCount > taMaxLen;
        const taUnderLimit = taMinLen && taCharCount > 0 && taCharCount < taMinLen;
        return isEditing ? (
          <div className="space-y-1">
            <Textarea
              value={value || ''}
              onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
              rows={3}
              maxLength={taMaxLen || undefined}
              disabled={isLocked}
              className={taOverLimit ? 'border-red-500 focus-visible:ring-red-500' : ''}
              data-testid={`textarea-member-custom-${field.id}`}
            />
            {(taMaxLen || taMinLen) && (
              <div className="flex justify-between text-xs">
                {taMinLen ? (
                  <span className={taUnderLimit ? 'text-red-500 font-medium' : 'text-slate-400'}>
                    Min: {taMinLen} characters
                  </span>
                ) : <span />}
                {taMaxLen ? (
                  <span className={taOverLimit ? 'text-red-500 font-medium' : 'text-slate-400'}>
                    {taCharCount} / {taMaxLen}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{value || '-'}</p>
        );
      }
      case 'boolean':
        return (
          <div className="flex items-center gap-3">
            <Switch
              checked={value === 'true' || value === true}
              onCheckedChange={(checked) => setCustomFieldValues(prev => ({ ...prev, [field.id]: checked ? 'true' : 'false' }))}
              disabled={disabledOverride}
              data-testid={`switch-member-custom-${field.id}`}
            />
            <span className="text-sm">{value === 'true' || value === true ? 'Yes' : 'No'}</span>
          </div>
        );
      case 'country': {
        const availableCountries = field.all_countries !== false
          ? COUNTRIES
          : COUNTRIES.filter(c => {
              const sel = Array.isArray(field.selected_countries) ? field.selected_countries : [];
              return sel.includes(c.code) || sel.includes(c.name);
            });
        const resolvedValue = (() => {
          if (!value) return '';
          const byCode = COUNTRIES.find(c => c.code === value);
          return byCode ? byCode.name : value;
        })();
        return isEditing ? (
          <Select value={resolvedValue} onValueChange={(v) => setCustomFieldValues(prev => ({ ...prev, [field.id]: v }))} disabled={isLocked}>
            <SelectTrigger data-testid={`select-member-custom-${field.id}`}><SelectValue placeholder={`Select ${field.label}`} /></SelectTrigger>
            <SelectContent>
              {availableCountries.map((country) => (
                <SelectItem key={country.code} value={country.name}>{country.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-sm">{resolvedValue || '-'}</p>
        );
      }
      case 'countries': {
        const selectedCountries = Array.isArray(value) ? value : [];
        const normalizedSelected = selectedCountries.map(v => {
          const byCode = COUNTRIES.find(c => c.code === v);
          return byCode ? byCode.name : v;
        });
        const availableCountriesList = field.all_countries !== false
          ? COUNTRIES
          : COUNTRIES.filter(c => {
              const sel = Array.isArray(field.selected_countries) ? field.selected_countries : [];
              return sel.includes(c.code) || sel.includes(c.name);
            });
        if (!isEditing) {
          return <p className="text-sm">{normalizedSelected.length > 0 ? normalizedSelected.join(', ') : '-'}</p>;
        }
        return (
          <MemberDetailCountryMultiSelect
            fieldId={field.id}
            selectedValues={normalizedSelected}
            availableCountries={availableCountriesList}
            onChange={(newValues) => setCustomFieldValues(prev => ({ ...prev, [field.id]: newValues }))}
            label={field.label}
            disabled={isLocked}
          />
        );
      }
      default:
        return isEditing ? (
          <Input value={value || ''} onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))} disabled={isLocked} data-testid={`input-member-custom-${field.id}`} />
        ) : (
          <p className="text-sm">{value || '-'}</p>
        );
    }
  };

  const renderMemberCoreField = (fieldKey, isLocked = false) => {
    const coreFieldDef = MEMBER_CORE_FIELDS.find(f => f.fieldKey === fieldKey);
    if (!coreFieldDef) return null;
    const label = coreFieldDef.label;
    const lockBadge = isLocked && isEditing ? (
      <Lock className="w-3 h-3 text-slate-400" data-testid={`lock-icon-member-${fieldKey}`} />
    ) : null;

    switch (fieldKey) {
      case 'first_name':
      case 'last_name':
      case 'mobile':
      case 'landline':
      case 'job_title':
        return (
          <div className="space-y-1">
            <Label className="text-xs text-slate-500 flex items-center gap-1">{label}{lockBadge}</Label>
            {isEditing ? (
              <Input value={formData[fieldKey] || ''} onChange={(e) => setFormData(prev => ({ ...prev, [fieldKey]: e.target.value }))} disabled={isLocked} data-testid={`input-member-${fieldKey}`} />
            ) : (
              <p className="text-sm font-medium">{member[fieldKey] || '-'}</p>
            )}
          </div>
        );
      case 'email':
        return (
          <div className="space-y-1">
            <Label className="text-xs text-slate-500 flex items-center gap-1">{label}{lockBadge}</Label>
            {isEditing ? (
              <Input type="email" value={formData.email || ''} onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))} disabled={isLocked} data-testid="input-member-email" />
            ) : (
              <p className="text-sm">{member.email ? <a href={`mailto:${member.email}`} className="text-blue-600 hover:underline">{member.email}</a> : '-'}</p>
            )}
          </div>
        );
      case 'biography':
        return (
          <div className="space-y-1">
            <Label className="text-xs text-slate-500 flex items-center gap-1">{label}{lockBadge}</Label>
            {isEditing ? (
              <Textarea value={formData.biography || ''} onChange={(e) => setFormData(prev => ({ ...prev, biography: e.target.value }))} rows={4} disabled={isLocked} data-testid="textarea-member-biography" />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{member.biography || '-'}</p>
            )}
          </div>
        );
      default:
        return null;
    }
  };

  const { hiddenFields, hiddenCards, lockedFields, lockedCards } = evaluateVisibilityRules(
    rulesConfig,
    { ...formData, custom_field_values: customFieldValues },
    memberCustomFields
  );

  const renderLayoutCard = (card) => {
    if (card.fields.length === 0) return null;
    if (hiddenCards.has(card.id)) return null;
    const gridCols = card.columns === 1 ? 'grid-cols-1' : card.columns === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-3';
    const isCollapsed = collapsedSections[card.id];
    const isCardLocked = lockedCards.has(card.id);

    const renderField = (field) => {
      if (hiddenFields.has(field.id)) return null;
      const isFieldLocked = isCardLocked || lockedFields.has(field.id);
      if (field.type === 'core') {
        return <div key={field.id}>{renderMemberCoreField(field.fieldKey, isFieldLocked)}</div>;
      } else {
        const customField = memberCustomFields.find(cf => cf.id === field.fieldId);
        if (!customField) return null;
        return (
          <div key={field.id} className="space-y-1">
            <Label className="text-xs text-slate-500 flex items-center gap-1">
              {customField.label}
              {isFieldLocked && isEditing && (
                <Lock className="w-3 h-3 text-slate-400" data-testid={`lock-icon-member-custom-${customField.id}`} />
              )}
            </Label>
            {renderMemberCustomFieldEditor(customField, isFieldLocked)}
          </div>
        );
      }
    };

    return (
      <Card key={card.id}>
        <CardHeader className="cursor-pointer select-none" onClick={() => toggleSection(card.id)} data-testid={`member-card-header-${card.id}`}>
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-blue-600" />
            {card.title}
            <span className="ml-auto">
              {isCollapsed ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronUp className="w-4 h-4 text-slate-400" />}
            </span>
          </CardTitle>
        </CardHeader>
        {!isCollapsed && (
          <CardContent>
            <div className={`grid ${gridCols} gap-4`}>
              {Array.from({ length: card.columns }).map((_, colIndex) => {
                const colFields = card.fields.filter(f =>
                  f.columnIndex !== undefined ? f.columnIndex === colIndex : (card.fields.indexOf(f) % card.columns === colIndex)
                );
                return (
                  <div key={colIndex} className="space-y-4">
                    {colFields.map(field => renderField(field))}
                  </div>
                );
              })}
            </div>
          </CardContent>
        )}
      </Card>
    );
  };

  if (memberLoading || !member) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const org = getOrganization();

  return (
    <div className="p-6 space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/members" data-testid="link-back-to-members">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12">
              <AvatarImage src={member?.profile_photo_url} />
              <AvatarFallback className="bg-blue-100 text-blue-700">
                {getInitials(getMemberName(member))}
              </AvatarFallback>
            </Avatar>
            <div>
              <h1 className="text-xl font-semibold text-slate-900">
                {getMemberName(member) || 'Unknown Member'}
              </h1>
              <p className="text-sm text-slate-500 flex items-center gap-2">
                {member?.job_title && <span>{member.job_title}</span>}
                {member?.job_title && org && <span>•</span>}
                {org && <span>{org.name}</span>}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {member?.id && (
            <MemberLoginStatusBadge
              memberId={member.id}
              fallbackEnabled={member?.login_enabled !== false}
            />
          )}
          {member?.id && member?.is_guest && (
            <GuestAccessControl
              member={member}
              canManage={isAccessReady && isFeatureExcluded && !isFeatureExcluded('element_TeamLoginAccessToggle')}
            />
          )}
          {isAdmin && !isEditing && (
            <>
              <Button variant="outline" size="sm" onClick={() => setShowLayoutEditor(true)} disabled={isLayoutLoading} data-testid="button-customize-member-layout">
                <LayoutGrid className="w-4 h-4 mr-1" />
                Customize Layout
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowRulesEditor(true)} data-testid="button-member-visibility-rules">
                <Settings2 className="w-4 h-4 mr-1" />
                Rules
              </Button>
              <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} data-testid="button-edit-member">
                <Pencil className="w-4 h-4 mr-1" />
                Edit
              </Button>
              <Button 
                variant="outline" 
                size="icon" 
                onClick={() => setShowDeleteDialog(true)}
                className="text-destructive hover:text-destructive"
                data-testid="button-delete-member-detail"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </>
          )}
          {isEditing && (
            <>
              <Button variant="ghost" size="sm" onClick={handleCancel} data-testid="button-cancel-edit-member">
                <X className="w-4 h-4 mr-1" />
                Cancel
              </Button>
              <Button 
                size="sm" 
                onClick={handleSave} 
                disabled={updateMutation.isPending} 
                data-testid="button-save-member"
              >
                {updateMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Save className="w-4 h-4 mr-1" />
                )}
                Save
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="overview" className="gap-1" data-testid="tab-member-overview">
            <User className="w-4 h-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1" data-testid="tab-member-activity">
            <ClipboardList className="w-4 h-4" />
            Activity
          </TabsTrigger>
          <TabsTrigger value="roles" className="gap-1" data-testid="tab-member-roles">
            <Shield className="w-4 h-4" />
            Roles
          </TabsTrigger>
          <TabsTrigger value="categories" className="gap-1" data-testid="tab-member-categories">
            <FolderTree className="w-4 h-4" />
            Categories
          </TabsTrigger>
          <TabsTrigger value="balances" className="gap-1" data-testid="tab-member-balances">
            <Trophy className="w-4 h-4" />
            Balances
          </TabsTrigger>
          <TabsTrigger value="notes" className="gap-1" data-testid="tab-member-notes">
            <StickyNote className="w-4 h-4" />
            Notes
          </TabsTrigger>
          <TabsTrigger value="communications" className="gap-1" data-testid="tab-member-communications">
            <Mail className="w-4 h-4" />
            Communications
          </TabsTrigger>
          {!member?.organization_id && (
            <TabsTrigger value="membership" className="gap-1" data-testid="tab-member-membership">
              <Wallet className="w-4 h-4" />
              Membership
            </TabsTrigger>
          )}
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left column - customizable layout */}
            <div className="space-y-6">
              {effectiveLayout.cards.map(card => renderLayoutCard(card))}

              {!isEditing && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Key className="w-4 h-4 text-blue-600" />
                      Account Actions
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {isAccessReady && isFeatureExcluded && !isFeatureExcluded('crm.members.password_reset') && (
                      <div className="space-y-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleGenerateResetLink}
                          disabled={isGeneratingResetLink}
                          className="w-full"
                          data-testid="button-generate-reset-link"
                        >
                          {isGeneratingResetLink ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Key className="w-4 h-4 mr-2" />
                          )}
                          Generate Reset Password Link
                        </Button>
                        {generatedResetLink && (
                          <div className="space-y-1">
                            <p className="text-xs text-slate-500">Password Reset Link (valid for 24 hours)</p>
                            <div className="flex items-center gap-2">
                              <Input readOnly value={generatedResetLink} className="text-xs font-mono" data-testid="input-reset-link" />
                              <Button variant="outline" size="icon" onClick={handleCopyResetLink} data-testid="button-copy-reset-link">
                                {linkCopied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {isAccessReady && isFeatureExcluded && !isFeatureExcluded('crm.members.masquerade') && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleMasquerade}
                        disabled={isMasquerading}
                        className="w-full"
                        data-testid="button-masquerade"
                      >
                        {isMasquerading ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <UserCheck className="w-4 h-4 mr-2" />
                        )}
                        Masquerade as Member
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Right column - Organisation & Membership */}
            <div className="space-y-6">
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-blue-600" />
                    Organisation
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-3">
                  {isEditing ? (
                    <div className="space-y-2">
                      <Label>Organisation</Label>
                      <Select
                        value={formData.organization_id || '__none__'}
                        onValueChange={(v) => setFormData(prev => ({ ...prev, organization_id: v === '__none__' ? '' : v }))}
                      >
                        <SelectTrigger data-testid="select-member-org">
                          <SelectValue placeholder="Select organisation" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">No Organisation</SelectItem>
                          {organizations.filter(o => o.id).map(o => (
                            <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : org ? (
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                        <Building2 className="w-4 h-4 text-blue-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium text-slate-900 text-sm">{org.name}</p>
                          <Link to={`/organisations/${org.id}`} className="text-slate-400 hover:text-blue-600 transition-colors" data-testid="link-go-to-org">
                            <ExternalLink className="w-3.5 h-3.5" />
                          </Link>
                        </div>
                        {org.website_url && (
                          <a
                            href={org.website_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                          >
                            <Globe className="w-3 h-3" />
                            {org.website_url}
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">No organisation assigned</p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="w-4 h-4 text-purple-600" />
                    Membership
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-3 space-y-3">
                  <div className="flex items-center gap-3">
                    <CalendarDays className="w-4 h-4 text-slate-400" />
                    <div>
                      <p className="text-xs text-slate-500">Member Since</p>
                      <p className="text-sm font-medium">
                        {member.created_on ? formatDate(member.created_on) : '-'}
                      </p>
                    </div>
                  </div>
                  <Separator />
                  <div className="flex items-center gap-3">
                    <Shield className="w-4 h-4 text-slate-400" />
                    <div>
                      <p className="text-xs text-slate-500">Role</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {member.role_id ? (
                          <Badge variant="secondary" className="text-xs">
                            {getRoleName(member.role_id)}
                          </Badge>
                        ) : (
                          <span className="text-sm text-slate-500">No role assigned</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <LogIn className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">Login Enabled</p>
                        <p className="text-sm font-medium">
                          {isEditing ? (formData.login_enabled ? 'Yes' : 'No') : (member.login_enabled !== false ? 'Yes' : 'No')}
                        </p>
                      </div>
                    </div>
                    {isEditing && (
                      <Switch
                        checked={formData.login_enabled}
                        onCheckedChange={(checked) => setFormData(prev => ({ ...prev, login_enabled: checked }))}
                        data-testid="switch-login-enabled"
                      />
                    )}
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <Users className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">Show in Directory</p>
                        <p className="text-sm font-medium">
                          {isEditing ? (formData.show_in_directory ? 'Yes' : 'No') : (member.show_in_directory !== false ? 'Yes' : 'No')}
                        </p>
                      </div>
                    </div>
                    {isEditing && (
                      <Switch
                        checked={formData.show_in_directory}
                        onCheckedChange={(checked) => setFormData(prev => ({ ...prev, show_in_directory: checked }))}
                        data-testid="switch-show-in-directory"
                      />
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Mail className="w-4 h-4 text-blue-600" />
                    Communication Preferences
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-3 space-y-3">
                  {(() => {
                    const isOptedOutAll = member?.communications_opted_out_all === true;
                    return (
                      <>
                        <div
                          className={`flex items-center justify-between gap-3 p-3 rounded-lg border ${isOptedOutAll ? 'bg-red-50 border-red-200' : 'bg-warning/10 border-warning/30'}`}
                          data-testid="comm-opt-out-all"
                        >
                          <div className="space-y-0.5">
                            <h4 className="text-sm font-medium text-slate-900">
                              Opt out of all communications
                            </h4>
                            <p className="text-xs text-slate-500">
                              {isOptedOutAll
                                ? "Opted out of all marketing communications"
                                : "Stop all marketing communications"}
                            </p>
                          </div>
                          <Switch
                            checked={isOptedOutAll}
                            onCheckedChange={(checked) => handleOptOutAllToggle(checked)}
                            disabled={updatingOptOutAll}
                            data-testid="switch-opt-out-all"
                          />
                        </div>

                        {communicationCategoriesLoading ? (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                          </div>
                        ) : availableCommCategories.length === 0 ? (
                          <p className="text-sm text-slate-500 text-center py-4">No communication categories available.</p>
                        ) : (
                          <div className={`space-y-2 ${isOptedOutAll ? 'opacity-50' : ''}`}>
                            {availableCommCategories.map((category) => {
                              const pref = communicationPreferences.find(p => p.category_id === category.id);
                              const isSubscribed = isOptedOutAll ? false : (pref ? pref.is_subscribed : false);
                              return (
                                <div
                                  key={category.id}
                                  className="flex items-center justify-between gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200"
                                  data-testid={`comm-category-${category.id}`}
                                >
                                  <div className="space-y-0.5">
                                    <h4 className="text-sm font-medium text-slate-900">{category.name}</h4>
                                    {category.description && (
                                      <p className="text-xs text-slate-500">{category.description}</p>
                                    )}
                                  </div>
                                  <Switch
                                    checked={isSubscribed}
                                    onCheckedChange={(checked) => handleCommunicationToggle(category.id, checked)}
                                    disabled={updatingCommPrefs.has(category.id) || isOptedOutAll}
                                    data-testid={`switch-comm-${category.id}`}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Tag className="w-4 h-4 text-blue-600" />
                    Tags
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-3">
                  <CrmTagInput
                    tags={member?.tags || []}
                    entityType="member"
                    onChange={async (newTags) => {
                      try {
                        await base44.entities.Member.update(member.id, { tags: newTags });
                        queryClient.invalidateQueries({ queryKey: ['member-detail', id] });
                        queryClient.invalidateQueries({ queryKey: ['members-paginated'] });
                        queryClient.invalidateQueries({ queryKey: ['admin-members-tags'] });
                      } catch (err) {
                        toast.error('Failed to update tags: ' + err.message);
                      }
                    }}
                  />
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* Roles Tab */}
        <TabsContent value="roles" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Shield className="w-5 h-5 text-blue-600" />
                Assigned Roles
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <div className="space-y-3">
                  {roles.map(role => (
                    <div 
                      key={role.id} 
                      className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg cursor-pointer"
                      onClick={() => setSelectedRoleId(role.id)}
                    >
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        selectedRoleId === role.id ? 'border-blue-600 bg-blue-600' : 'border-slate-300'
                      }`}>
                        {selectedRoleId === role.id && (
                          <div className="w-2 h-2 bg-white rounded-full" />
                        )}
                      </div>
                      <Label className="flex-1 cursor-pointer">
                        <p className="font-medium text-sm">{role.name}</p>
                        {role.description && (
                          <p className="text-xs text-slate-500">{role.description}</p>
                        )}
                      </Label>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {!member.role_id ? (
                    <p className="text-sm text-slate-500">No role assigned</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary" className="text-sm">
                        {getRoleName(member.role_id)}
                      </Badge>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Activity Tab */}
        <TabsContent value="activity" className="space-y-6">
          {member.created_on && (
            <Card>
              <CardContent className="py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
                    <CalendarDays className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Member Since</p>
                    <p className="font-medium text-sm" data-testid="text-member-created-date">
                      {formatDate(member.created_on)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-blue-600" />
                Recent Bookings
              </CardTitle>
            </CardHeader>
            <CardContent>
              {anyBookingsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                </div>
              ) : unifiedBookings.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8" data-testid="text-no-bookings">No bookings found</p>
              ) : (
                <div className="space-y-3">
                  {unifiedBookings.map(item => (
                    <div
                      key={item.key}
                      className="flex items-start justify-between gap-3 p-3 bg-slate-50 rounded-lg"
                      data-testid={`row-booking-${item.source}-${item.id}`}
                    >
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                          <Calendar className="w-5 h-5 text-blue-600" />
                        </div>
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <p className="font-medium text-sm truncate" data-testid={`text-booking-title-${item.source}-${item.id}`}>
                            {item.title}
                          </p>
                          {item.attendeeName && (
                            <p className="text-xs text-slate-600 truncate" data-testid={`text-booking-attendee-${item.source}-${item.id}`}>
                              Attendee: {item.attendeeName}
                              {item.ticketClassName ? ` · ${item.ticketClassName}` : ''}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                            <span data-testid={`text-booking-event-date-${item.source}-${item.id}`}>
                              Event: {item.eventDate ? formatDate(item.eventDate) : '—'}
                            </span>
                            <span data-testid={`text-booking-booked-on-${item.source}-${item.id}`}>
                              Booked: {item.bookingDate ? formatDate(item.bookingDate) : '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {item.isAttendeeOnly && (
                          <Badge variant="secondary" data-testid={`badge-attendee-${item.source}-${item.id}`}>Attendee</Badge>
                        )}
                        <Badge variant="outline" data-testid={`badge-booking-status-${item.source}-${item.id}`}>
                          {item.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Categories Tab */}
        <TabsContent value="categories" className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <FolderTree className="w-5 h-5 text-blue-600" />
                Category Preferences
              </CardTitle>
              {member?.id && (
                <Button 
                  size="sm" 
                  onClick={handleSaveCategories} 
                  disabled={isSavingCategories || categoriesLoading || selectionsLoading}
                  data-testid="button-save-categories"
                >
                  {isSavingCategories ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  ) : (
                    <Save className="w-4 h-4 mr-1" />
                  )}
                  Save Categories
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {(categoriesLoading || selectionsLoading) ? (
                <div className="space-y-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="border border-slate-200 rounded-lg p-3 animate-pulse">
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 bg-slate-200 rounded" />
                        <div className="h-4 bg-slate-200 rounded w-32" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : resourceCategories.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">No categories available</p>
              ) : (() => {
                const categoriesWithSubcats = resourceCategories.filter(c => 
                  c.subcategories && Array.isArray(c.subcategories) && c.subcategories.length > 0
                );
                const flatCategories = resourceCategories.filter(c => 
                  !c.subcategories || !Array.isArray(c.subcategories) || c.subcategories.length === 0
                );
                
                return (
                  <div className="space-y-6">
                    <p className="text-sm text-slate-600">
                      Select the categories that interest this member. These preferences help personalize content recommendations.
                    </p>
                    
                    {flatCategories.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                          <FolderTree className="w-4 h-4 text-slate-500" />
                          Categories
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          {flatCategories.map(category => {
                            const isSelected = isSubcategorySelected(category.id, null);
                            return (
                              <div 
                                key={category.id} 
                                className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                                  isSelected 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                                }`}
                                onClick={() => toggleSubcategory(category.id, null)}
                                data-testid={`category-card-${category.id}`}
                              >
                                <div className="flex items-start gap-3">
                                  <Checkbox
                                    id={`cat-${category.id}`}
                                    checked={isSelected}
                                    onCheckedChange={() => toggleSubcategory(category.id, null)}
                                    data-testid={`checkbox-category-${category.id}`}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <Label 
                                      htmlFor={`cat-${category.id}`} 
                                      className="font-medium text-sm cursor-pointer text-slate-900"
                                    >
                                      {category.name}
                                    </Label>
                                    {category.description && (
                                      <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                                        {category.description}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    
                    {categoriesWithSubcats.map(category => {
                      const selectedCount = (category.subcategories || []).filter(subName => 
                        isSubcategorySelected(category.id, subName)
                      ).length;
                      
                      return (
                        <div key={category.id} className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                              <FolderTree className="w-4 h-4 text-slate-500" />
                              {category.name}
                            </h3>
                            {selectedCount > 0 && (
                              <Badge variant="secondary" className="text-xs">
                                {selectedCount} selected
                              </Badge>
                            )}
                          </div>
                          {category.description && (
                            <p className="text-xs text-slate-500 -mt-1">{category.description}</p>
                          )}
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {(category.subcategories || []).map((subcatName, idx) => {
                              const isSelected = isSubcategorySelected(category.id, subcatName);
                              const uniqueKey = `${category.id}-${subcatName}`;
                              return (
                                <div 
                                  key={uniqueKey} 
                                  className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                                    isSelected 
                                      ? 'border-blue-500 bg-blue-50' 
                                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                                  }`}
                                  onClick={() => toggleSubcategory(category.id, subcatName)}
                                  data-testid={`subcategory-card-${category.id}-${idx}`}
                                >
                                  <div className="flex items-start gap-3">
                                    <Checkbox
                                      id={`subcat-${uniqueKey}`}
                                      checked={isSelected}
                                      onCheckedChange={() => toggleSubcategory(category.id, subcatName)}
                                      data-testid={`checkbox-subcategory-${category.id}-${idx}`}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <Label 
                                        htmlFor={`subcat-${uniqueKey}`} 
                                        className="font-medium text-sm cursor-pointer text-slate-900"
                                      >
                                        {subcatName}
                                      </Label>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    
                    {selectedSubcategories.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-slate-200">
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">{selectedSubcategories.length}</span> {selectedSubcategories.length === 1 ? 'item' : 'items'} selected
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Balances Tab */}
        <TabsContent value="balances" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Trophy className="w-5 h-5 text-warning" />
                Engagement Opening Balances
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600 mb-6">
                Set opening balances for engagement metrics. These values will be added to the calculated totals in the Team Engagement Report.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="balance-events">Events Attended</Label>
                  <Input
                    id="balance-events"
                    type="number"
                    min="0"
                    value={openingBalances.eventsAttended}
                    onChange={(e) => setOpeningBalances(prev => ({ 
                      ...prev, 
                      eventsAttended: parseInt(e.target.value) || 0 
                    }))}
                    data-testid="input-balance-events"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="balance-articles">Articles Published</Label>
                  <Input
                    id="balance-articles"
                    type="number"
                    min="0"
                    value={openingBalances.articlesPublished}
                    onChange={(e) => setOpeningBalances(prev => ({ 
                      ...prev, 
                      articlesPublished: parseInt(e.target.value) || 0 
                    }))}
                    data-testid="input-balance-articles"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="balance-jobs">Jobs Posted</Label>
                  <Input
                    id="balance-jobs"
                    type="number"
                    min="0"
                    value={openingBalances.jobsPosted}
                    onChange={(e) => setOpeningBalances(prev => ({ 
                      ...prev, 
                      jobsPosted: parseInt(e.target.value) || 0 
                    }))}
                    data-testid="input-balance-jobs"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="balance-awards">Awards (Online + Offline)</Label>
                  <Input
                    id="balance-awards"
                    type="number"
                    min="0"
                    value={openingBalances.awards}
                    onChange={(e) => setOpeningBalances(prev => ({ 
                      ...prev, 
                      awards: parseInt(e.target.value) || 0 
                    }))}
                    data-testid="input-balance-awards"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="balance-engagement">Engagement Awards</Label>
                  <Input
                    id="balance-engagement"
                    type="number"
                    min="0"
                    value={openingBalances.engagementAwards}
                    onChange={(e) => setOpeningBalances(prev => ({ 
                      ...prev, 
                      engagementAwards: parseInt(e.target.value) || 0 
                    }))}
                    data-testid="input-balance-engagement"
                  />
                </div>
              </div>
              
              <div className="mt-6 pt-4 border-t border-slate-200">
                <Button 
                  onClick={handleSaveOpeningBalances}
                  disabled={isSavingBalances}
                  data-testid="button-save-balances"
                >
                  {isSavingBalances ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-1" />
                  )}
                  Save Opening Balances
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notes Tab */}
        <TabsContent value="notes" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <StickyNote className="w-5 h-5 text-blue-600" />
                Member Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Textarea
                  placeholder="Add a note..."
                  value={newNoteContent}
                  onChange={(e) => setNewNoteContent(e.target.value)}
                  className="min-h-[100px]"
                  data-testid="input-new-member-note"
                />
                <div className="flex justify-end">
                  <Button
                    onClick={() => createNoteMutation.mutate({ content: newNoteContent })}
                    disabled={!newNoteContent.trim() || createNoteMutation.isPending}
                    data-testid="button-add-member-note"
                  >
                    {createNoteMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4 mr-2" />
                    )}
                    Add Note
                  </Button>
                </div>
              </div>

              <Separator />

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search notes by content or creator..."
                  value={noteSearchTerm}
                  onChange={(e) => {
                    setNoteSearchTerm(e.target.value);
                    setNotesPage(1);
                  }}
                  className="pl-10"
                  data-testid="input-search-member-notes"
                />
              </div>

              {(() => {
                const searchLower = noteSearchTerm.toLowerCase();
                const filteredNotes = memberNotes.filter(note => 
                  note.content?.toLowerCase().includes(searchLower) ||
                  note.author_name?.toLowerCase().includes(searchLower)
                );
                const totalPages = Math.max(1, Math.ceil(filteredNotes.length / notesPerPage));
                const clampedPage = Math.min(notesPage, totalPages);
                if (clampedPage !== notesPage && filteredNotes.length > 0) {
                  setTimeout(() => setNotesPage(clampedPage), 0);
                }
                const paginatedNotes = filteredNotes.slice(
                  (clampedPage - 1) * notesPerPage,
                  clampedPage * notesPerPage
                );

                if (notesLoading) {
                  return (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                    </div>
                  );
                }

                if (memberNotes.length === 0) {
                  return (
                    <div className="text-center py-12 text-slate-500">
                      <MessageSquare className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                      <p>No notes yet</p>
                      <p className="text-sm text-slate-400 mt-1">Add a note above to get started</p>
                    </div>
                  );
                }

                if (filteredNotes.length === 0) {
                  return (
                    <div className="text-center py-12 text-slate-500">
                      <Search className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                      <p>No notes match your search</p>
                      <p className="text-sm text-slate-400 mt-1">Try a different search term</p>
                    </div>
                  );
                }

                return (
                  <>
                    <div className="space-y-4">
                      {paginatedNotes.map(note => (
                        <div key={note.id} className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg space-y-3" data-testid={`member-note-${note.id}`}>
                          {editingNoteId === note.id ? (
                            <div className="space-y-3">
                              <Textarea
                                value={editingNoteContent}
                                onChange={(e) => setEditingNoteContent(e.target.value)}
                                className="min-h-[80px]"
                                data-testid={`input-edit-member-note-${note.id}`}
                              />
                              <div className="flex gap-2 justify-end">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setEditingNoteId(null);
                                    setEditingNoteContent('');
                                  }}
                                  data-testid={`button-cancel-edit-member-note-${note.id}`}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => updateNoteMutation.mutate({ noteId: note.id, content: editingNoteContent })}
                                  disabled={!editingNoteContent.trim() || updateNoteMutation.isPending}
                                  data-testid={`button-save-member-note-${note.id}`}
                                >
                                  {updateNoteMutation.isPending ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    'Save'
                                  )}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p className="text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{note.content}</p>
                              <div className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2 text-slate-500">
                                  <User className="w-3 h-3" />
                                  <span>{note.author_name}</span>
                                  <span className="text-slate-300">|</span>
                                  <span>{note.created_at ? format(new Date(note.created_at), 'dd MMM yyyy, HH:mm') : ''}</span>
                                  {note.updated_at && note.updated_at !== note.created_at && (
                                    <span className="italic text-slate-400">(edited)</span>
                                  )}
                                </div>
                                <div className="flex gap-1">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => {
                                      setEditingNoteId(note.id);
                                      setEditingNoteContent(note.content);
                                    }}
                                    data-testid={`button-edit-member-note-${note.id}`}
                                  >
                                    <Pencil className="w-4 h-4 text-slate-400 hover:text-blue-600" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setNoteToDelete(note.id)}
                                    disabled={deleteNoteMutation.isPending}
                                    data-testid={`button-delete-member-note-${note.id}`}
                                  >
                                    <Trash2 className="w-4 h-4 text-slate-400 hover:text-red-600" />
                                  </Button>
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    {totalPages > 1 && (
                      <div className="flex items-center justify-between pt-4">
                        <p className="text-sm text-slate-500">
                          Showing {(clampedPage - 1) * notesPerPage + 1} - {Math.min(clampedPage * notesPerPage, filteredNotes.length)} of {filteredNotes.length} notes
                        </p>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setNotesPage(p => Math.max(1, p - 1))}
                            disabled={clampedPage === 1}
                            data-testid="button-member-notes-prev-page"
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </Button>
                          <span className="text-sm text-slate-600">
                            Page {clampedPage} of {totalPages}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setNotesPage(p => Math.min(totalPages, p + 1))}
                            disabled={clampedPage === totalPages}
                            data-testid="button-member-notes-next-page"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Communications Tab */}
        <TabsContent value="communications" className="space-y-6">
          {member.id && (
            <MemberEmails 
              memberId={member.id}
              memberEmail={member.email}
              memberName={`${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email}
            />
          )}
        </TabsContent>

          {!member?.organization_id && (
            <TabsContent value="membership" className="space-y-6">
              <MemberMembershipTab memberId={member?.id} memberEmail={member?.email} />
            </TabsContent>
          )}
      </Tabs>

      {/* Delete Note Confirmation Dialog */}
      <AlertDialog open={!!noteToDelete} onOpenChange={() => setNoteToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Note</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this note? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteNoteMutation.mutate(noteToDelete)}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Member Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={(open) => { if (!open) { setShowDeleteDialog(false); setDeleteConfirmText(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Delete Member
            </DialogTitle>
            <DialogDescription className="text-left space-y-3 pt-2">
              <p>
                You are about to permanently delete <strong>{member?.first_name} {member?.last_name}</strong>.
              </p>
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
              onClick={() => { setShowDeleteDialog(false); setDeleteConfirmText(''); }}
              data-testid="button-cancel-member-delete"
            >
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={() => deleteMemberMutation.mutate()}
              disabled={deleteConfirmText !== 'DELETE' || deleteMemberMutation.isPending}
              data-testid="button-confirm-member-delete"
            >
              {deleteMemberMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete Member
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showLayoutEditor && (
        <MemberDetailLayoutEditor
          layout={effectiveLayout}
          customFields={memberCustomFields}
          onSave={async (newLayout) => {
            await saveLayout(newLayout);
            setShowLayoutEditor(false);
          }}
          onCancel={() => setShowLayoutEditor(false)}
          isSaving={isLayoutSaving}
        />
      )}

      <MemberFieldVisibilityRulesEditor
        open={showRulesEditor}
        onOpenChange={setShowRulesEditor}
        rulesConfig={rulesConfig}
        customFields={memberCustomFields}
        layoutCards={effectiveLayout?.cards || []}
        onSave={saveRules}
        onCancel={() => setShowRulesEditor(false)}
        isSaving={isRulesSaving}
      />

      <WorkflowConfirmationModal
        open={showConfirmationModal}
        onOpenChange={setShowConfirmationModal}
        pendingWorkflows={pendingWorkflows}
        onConfirm={handleConfirmWorkflow}
        onSkip={handleSkipWorkflow}
        onSkipAll={handleSkipAllWorkflows}
      />
    </div>
  );
}
