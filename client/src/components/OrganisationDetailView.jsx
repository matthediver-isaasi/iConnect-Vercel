import { useState, useEffect, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { safeLogoSrc } from "@/lib/safeLogoSrc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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
} from "@/components/ui/dialog";
import { 
  Building2, 
  ArrowLeft, 
  Globe, 
  Users, 
  Phone, 
  Mail, 
  MapPin, 
  Pencil, 
  Save, 
  X, 
  Camera,
  Loader2,
  ExternalLink,
  User,
  Calendar,
  ClipboardList,
  ClipboardCheck,
  Wallet,
  FileText,
  LayoutGrid,
  Plus,
  StickyNote,
  Trash2,
  MessageSquare,
  Search,
  Paperclip,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  FileIcon,
  Image as ImageIcon,
  File as FileGenericIcon,
  Download,
  FileSignature,
  Clock,
  Send,
  CheckCircle2,
  AlertCircle,
  Eye,
  Settings2,
  Tag,
  Lock,
  UserCheck,
  UserPlus,
  Star,
  Infinity as InfinityIcon
} from "lucide-react";
import { toast } from "sonner";
import { showUploadErrorToast } from "@/lib/planQuotaError";
import { showZohoCrmSyncToast } from "@/lib/zohoCrmSyncToast";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { useZohoInboundUpdateNotifier } from "@/hooks/useZohoInboundUpdateNotifier";
import { useOrgDetailLayout, mergeLayoutWithCustomFields, CORE_FIELDS } from "@/hooks/useOrgDetailLayout";
import { useOrgFieldVisibilityRules, evaluateVisibilityRules } from "@/hooks/useOrgFieldVisibilityRules";
import { isDeletedMember } from "@/utils";
import { useDateFormat } from "@/hooks/useDateFormat";
import { COUNTRIES } from "@/data/countries";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { ChevronsUpDown, Check } from "lucide-react";
import OrgMembershipTab from "@/components/OrgMembershipTab";
import MemberJoinLinkSection from "@/components/MemberJoinLinkSection";
import OrgDetailLayoutEditor from "@/components/OrgDetailLayoutEditor";
import OrgFieldVisibilityRulesEditor from "@/components/OrgFieldVisibilityRulesEditor";
import MemberDetailView from "@/components/MemberDetailView";
import CrmTagInput from "@/components/crm/CrmTagInput";
import { useWorkflowConfirmation } from "@/hooks/useWorkflowConfirmation";
import { useMemberTerminology } from "@/contexts/MemberTerminologyContext";
import WorkflowConfirmationModal, { DryRunSimulationModal } from "@/components/WorkflowConfirmationModal";
import { listAllOrganizationsForAdmin } from '@/lib/adminOrgList';
import InviteMemberDialog from "@/components/InviteMemberDialog";
import RelatedOpportunityActivity from "@/components/opportunities/RelatedOpportunityActivity";
import { OrganisationCommercial } from "@/components/sales/SalesReportingWorkspace";
import { RelatedRecordsPanel, useRelatedRecordDefinitions } from "@/pages/customObjects/RelatedRecordsPanel";
import { labelForSide, relationshipTabValue } from "@/pages/customObjects/relationshipHelpers";
import {
  collectRelationshipRecordIdsFromSubmissions,
  formatRelationshipDisplayValue,
  getSubmissionFieldValue,
  isRelationshipDropdownField,
} from "@/lib/relationshipDisplayLabels";
import {
  buildOrganisationCustomValueMap,
  isOrganisationListField,
  normalizeOrganisationCustomValue,
  organisationCustomValuesEqual,
} from "@/lib/myOrganisationSave";

const getMemberName = (m) => {
  return [m?.first_name, m?.last_name].filter(Boolean).join(' ') || m?.full_name || '';
};

// --- List Field Editor Component for Organisations ---
// Exported so the organisation-group detail view (Task #3601) can reuse it.
export function ListFieldEditorOrg({ fieldId, values = [], onChange, placeholder, disabled = false }) {
  const [inputValue, setInputValue] = useState('');
  
  // Ensure values is always a clean array with trimmed entries
  const safeValues = Array.isArray(values) ? values.map(v => String(v).trim()).filter(Boolean) : [];

  const handleAddItem = () => {
    const trimmed = inputValue.trim();
    // Check for duplicates case-insensitively
    if (!trimmed || safeValues.some(v => v.toLowerCase() === trimmed.toLowerCase())) return;
    onChange([...safeValues, trimmed]);
    setInputValue('');
  };

  const handleRemoveItem = (itemToRemove) => {
    onChange(safeValues.filter(item => item !== itemToRemove));
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddItem();
    }
  };

  return (
    <div className="space-y-2">
      {safeValues.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {safeValues.map((item, index) => (
            <Badge 
              key={index} 
              variant="secondary" 
              className="flex items-center gap-1 px-2 py-1"
              data-testid={`list-item-org-${fieldId}-${index}`}
            >
              <span>{item}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleRemoveItem(item)}
                  className="ml-1 hover:text-red-600 transition-colors"
                  data-testid={`button-remove-list-item-org-${fieldId}-${index}`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      
      {!disabled && (
        <div className="flex gap-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={placeholder || 'Add item...'}
            className="flex-1"
            data-testid={`input-list-org-${fieldId}`}
          />
          <Button 
            type="button" 
            variant="outline" 
            onClick={handleAddItem}
            disabled={!inputValue.trim()}
            data-testid={`button-add-list-item-org-${fieldId}`}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

export function OrgCountryMultiSelect({ fieldId, selectedValues, availableCountries, onChange, label, disabled = false }) {
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
            disabled={disabled}
            data-testid={`select-custom-countries-${fieldId}`}
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
              {!disabled && (
                <button
                  type="button"
                  onClick={() => toggleCountry(name)}
                  className="ml-1"
                  data-testid={`button-remove-country-${fieldId}-${name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OrganisationDetailView({ 
  organization, 
  onBack, 
  orgCustomFields = [],
  memberCount = 0,
  isNew = false,
  onCreated 
}) {
  const { isAdmin, memberInfo, isAccessReady, isFeatureExcluded } = useMemberAccess();
  const { memberLabel, memberLabelPlural } = useMemberTerminology();
  const hideTrainingFundCard = isFeatureExcluded('crm.organisations.fund');
  const canViewCommercial = isAccessReady && (isAdmin || (
    !isFeatureExcluded('sales.view') && !isFeatureExcluded('sales.reports.view')
  ));
  const { formatDate } = useDateFormat();
  const queryClient = useQueryClient();
  const relatedRecords = useRelatedRecordDefinitions({
    context: { kind: "organization", recordId: organization?.id },
    enabled: !isNew && !!organization?.id,
  });

  // Subscribe to realtime changes for organization and preference values
  // Only enable when both entity ID and tenant ID are available to ensure tenant scoping
  const realtimeEnabled = !!organization?.id && !!memberInfo?.tenant_id;

  useRealtimeSubscription('organization', [
    ['organizations-crm-paginated'],
    ['organization-direct', organization?.id]
  ], { 
    enabled: realtimeEnabled, 
    tenantId: memberInfo?.tenant_id 
  });

  useRealtimeSubscription('organization_preference_value', [
    ['org-detail-preference-values', organization?.id],
    ['all-org-preference-values-crm']
  ], { 
    enabled: realtimeEnabled && !!organization?.id,
    filter: organization?.id ? `organization_id=eq.${organization.id}` : null
  });

  // Toast + refresh when this organisation is updated by an inbound Zoho sync.
  useZohoInboundUpdateNotifier({
    entityType: 'organization',
    entityId: organization?.id,
    enabled: realtimeEnabled,
    queryKeysToInvalidate: [
      ['organizations-crm-paginated'],
      ['organization-direct', organization?.id],
      ['org-detail-preference-values', organization?.id],
      ['all-org-preference-values-crm']
    ]
  });
  const {
    pendingWorkflows,
    showConfirmationModal,
    setShowConfirmationModal,
    checkForPendingWorkflows,
    handleConfirmWorkflow,
    handleSkipWorkflow,
    handleSkipAllWorkflows,
    dryRunResults,
    showDryRunModal,
    setShowDryRunModal,
    clearDryRunResults,
  } = useWorkflowConfirmation();
  const [isEditing, setIsEditing] = useState(isNew);
  const [activeTab, setActiveTab] = useState('overview');
  const [showLayoutEditor, setShowLayoutEditor] = useState(false);
  const [showRulesEditor, setShowRulesEditor] = useState(false);
  const [isCreatingMember, setIsCreatingMember] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');
  const [noteToDelete, setNoteToDelete] = useState(null);
  const [noteSearchTerm, setNoteSearchTerm] = useState('');
  const [notesPage, setNotesPage] = useState(1);
  const [memberRoleFilter, setMemberRoleFilter] = useState('all');
  const [newNoteAttachments, setNewNoteAttachments] = useState([]);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const notesPerPage = 5;
  const noteFileInputRef = useRef(null);
  const logoFileInputRef = useRef(null);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    website_url: '',
    invoicing_email: '',
    invoicing_address: '',
    description: '',
    organization_group_id: ''
  });
  const [customFieldValues, setCustomFieldValues] = useState({});

  const [orgGuestForm, setOrgGuestForm] = useState({
    enabled: false,
    period_days: 30,
    unlimited: false,
  });

  // Collapsible card sections state
  const [collapsedSections, setCollapsedSections] = useState({});
  
  const toggleSection = (sectionId) => {
    setCollapsedSections(prev => ({
      ...prev,
      [sectionId]: !prev[sectionId]
    }));
  };

  // Sync formData with organization prop when it changes (for realtime updates)
  useEffect(() => {
    if (organization && !isEditing) {
      setFormData({
        name: organization.name || '',
        email: organization.email || '',
        phone: organization.phone || '',
        website_url: organization.website_url || '',
        invoicing_email: organization.invoicing_email || '',
        invoicing_address: organization.invoicing_address || '',
        description: organization.description || '',
        organization_group_id: organization.organization_group_id || ''
      });
    }
  }, [organization, isEditing]);
  
  const { layoutConfig, saveLayout, isSaving: isLayoutSaving, isLoading: isLayoutLoading } = useOrgDetailLayout({ enabled: isAccessReady });
  const { rulesConfig, saveRules, isSaving: isRulesSaving, isLoading: isRulesLoading } = useOrgFieldVisibilityRules({ enabled: isAccessReady });
  const effectiveLayout = useMemo(() => (
    mergeLayoutWithCustomFields(
      layoutConfig,
      orgCustomFields,
      relatedRecords.isSuccess ? relatedRecords.panels : null
    )
  ), [layoutConfig, orgCustomFields, relatedRecords.isSuccess, relatedRecords.panels]);

  const { data: orgMembersRaw = [], isLoading: membersLoading } = useQuery({
    queryKey: ['org-detail-members', organization?.id],
    enabled: !!organization?.id,
    queryFn: async () => {
      const members = await base44.entities.Member.list({
        filter: { organization_id: organization.id }
      });
      return members || [];
    }
  });
  
  const orgMembers = useMemo(() => orgMembersRaw.filter(m => !isDeletedMember(m)), [orgMembersRaw]);

  // Organisation Groups for the group selector / display (tenant-scoped server-side).
  const EMPTY_GROUPS = useMemo(() => [], []);
  const { data: orgGroups = EMPTY_GROUPS } = useQuery({
    queryKey: ['/api/entities/OrganizationGroup'],
    enabled: isAccessReady,
    queryFn: async () => {
      try {
        return await base44.entities.OrganizationGroup.list({ sort: { name: 'asc' } });
      } catch {
        return [];
      }
    }
  });

  const { data: orgValues = [], isLoading: valuesLoading } = useQuery({
    queryKey: ['org-detail-preference-values', organization?.id],
    enabled: !!organization?.id,
    queryFn: async () => {
      try {
        const values = await base44.entities.OrganizationPreferenceValue.list({
          filter: { organization_id: organization.id }
        });
        return values || [];
      } catch {
        return [];
      }
    }
  });

  const { data: tenantGuestAccess = null } = useQuery({
    queryKey: ['tenant-guest-access-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'guest_access');
      let value = { enabled: false, default_period_days: 30, unlimited: false };
      if (setting?.setting_value) {
        try {
          const parsed = JSON.parse(setting.setting_value);
          const days = Number(parsed.default_period_days);
          value = {
            enabled: !!parsed.enabled,
            default_period_days: Number.isFinite(days) && days > 0 ? days : 30,
            unlimited: parsed.default_period_days === null || parsed.unlimited === true,
          };
        } catch {
          // ignore
        }
      }
      return value;
    }
  });

  useEffect(() => {
    if (!organization) return;
    const orgDays = Number(organization.guest_access_period_days);
    const orgUnlimited = !!organization.guest_access_unlimited;
    const orgHasOverride = orgUnlimited || (Number.isFinite(orgDays) && orgDays > 0);
    setOrgGuestForm({
      enabled: !!organization.guest_access_enabled,
      period_days: orgHasOverride && Number.isFinite(orgDays) && orgDays > 0
        ? orgDays
        : (tenantGuestAccess?.default_period_days || 30),
      unlimited: orgHasOverride
        ? orgUnlimited
        : !!tenantGuestAccess?.unlimited,
    });
  }, [organization, tenantGuestAccess?.default_period_days, tenantGuestAccess?.unlimited]);

  const updateOrgGuestAccessMutation = useMutation({
    mutationFn: async (next) => {
      if (!organization?.id) throw new Error('No organisation');
      const payload = {
        guest_access_enabled: !!next.enabled,
        guest_access_unlimited: !!next.unlimited,
        guest_access_period_days: next.unlimited ? null : Number(next.period_days),
      };
      return await base44.entities.Organization.update(organization.id, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-direct', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['organizations-crm-paginated'] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success('Guest Access updated');
    },
    onError: (error) => {
      toast.error('Failed to update Guest Access: ' + (error?.message || ''));
    }
  });

  const persistOrgGuestAccess = (next) => {
    setOrgGuestForm(next);
    updateOrgGuestAccessMutation.mutate(next);
  };

  const { data: orgBookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['org-detail-bookings', organization?.id, orgMembers.length],
    enabled: !!organization?.id && activeTab === 'activity' && orgMembers.length > 0,
    queryFn: async () => {
      try {
        // Only fetch bookings for members of this organisation
        const memberIds = orgMembers.map(m => m.id);
        if (memberIds.length === 0) return [];
        
        // Fetch bookings for each member (limited approach to avoid loading all bookings)
        const bookingPromises = memberIds.slice(0, 10).map(memberId => 
          base44.entities.Booking.list({ filter: { member_id: memberId } })
        );
        const results = await Promise.all(bookingPromises);
        const allBookings = results.flat().sort((a, b) => 
          new Date(b.created_date || 0) - new Date(a.created_date || 0)
        );
        return allBookings.slice(0, 20); // Limit to 20 most recent
      } catch {
        return [];
      }
    }
  });

  // Queries for MemberDetailView when creating new member
  const { data: memberCustomFields = [] } = useQuery({
    queryKey: ['member-custom-fields-for-org'],
    enabled: isCreatingMember,
    queryFn: async () => {
      try {
        const fields = await base44.entities.MemberPreferenceField.list() || [];
        return fields || [];
      } catch {
        return [];
      }
    }
  });

  const { data: allOrganizations = [] } = useQuery({
    queryKey: ['organizations-for-member-create'],
    enabled: isCreatingMember,
    queryFn: async () => {
      try {
        // Paginate past the API's 1000-row cap so large tenants see the
        // full organisation list, sorted alphabetically.
        const orgs = await listAllOrganizationsForAdmin({ sort: { name: 'asc' } });
        return orgs || [];
      } catch (err) {
        console.error('Failed to load organisations for member creation:', err);
        return [];
      }
    }
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles-for-org-members'],
    enabled: !!organization?.id,
    queryFn: async () => {
      try {
        const rolesList = await base44.entities.Role.list() || [];
        return rolesList || [];
      } catch {
        return [];
      }
    }
  });

  const { data: featuredRoleIds = [] } = useQuery({
    queryKey: ['org-team-overview-roles-settings'],
    enabled: !!organization?.id,
    queryFn: async () => {
      try {
        const settings = await base44.entities.SystemSettings.list({
          filter: { setting_key: 'organization_team_overview_roles' }
        });
        if (settings && settings.length > 0) {
          const parsed = JSON.parse(settings[0].setting_value);
          return Array.isArray(parsed) ? parsed : [];
        }
      } catch {
        // ignore
      }
      return [];
    }
  });

  const roleNameById = useMemo(() => {
    const map = {};
    (roles || []).forEach(r => { map[String(r.id)] = r.name; });
    return map;
  }, [roles]);

  const featuredMembers = useMemo(() => {
    if (!featuredRoleIds?.length) return [];
    const order = featuredRoleIds.map(String);
    return orgMembers
      .filter(m => m.role_id && order.includes(String(m.role_id)))
      .sort((a, b) => order.indexOf(String(a.role_id)) - order.indexOf(String(b.role_id)))
      .slice(0, 2);
  }, [featuredRoleIds, orgMembers]);

  const featuredMemberIds = useMemo(
    () => new Set(featuredMembers.map(m => m.id)),
    [featuredMembers]
  );

  const summaryMembers = useMemo(
    () => orgMembers.filter(m => !featuredMemberIds.has(m.id)),
    [orgMembers, featuredMemberIds]
  );

  // Compute roles that have at least one member assigned (for dynamic filtering)
  const availableRolesForFilter = useMemo(() => {
    const roleIdsWithMembers = new Set(orgMembers.map(m => String(m.role_id)).filter(id => id && id !== 'null' && id !== 'undefined'));
    return roles.filter(role => roleIdsWithMembers.has(String(role.id)));
  }, [roles, orgMembers]);

  // Reset filter if selected role is no longer available
  useEffect(() => {
    if (memberRoleFilter !== 'all') {
      const stillAvailable = availableRolesForFilter.some(role => String(role.id) === memberRoleFilter);
      if (!stillAvailable) {
        setMemberRoleFilter('all');
      }
    }
  }, [availableRolesForFilter, memberRoleFilter]);

  // Filter members by selected role
  const filteredOrgMembers = useMemo(() => {
    if (memberRoleFilter === 'all') return orgMembers;
    return orgMembers.filter(m => String(m.role_id) === memberRoleFilter);
  }, [orgMembers, memberRoleFilter]);

  // Organization Notes query
  const { data: orgNotes = [], isLoading: notesLoading } = useQuery({
    queryKey: ['org-notes', organization?.id],
    enabled: !!organization?.id && activeTab === 'notes',
    queryFn: async () => {
      const res = await fetch(`/api/admin/organizations/${organization.id}/notes`, {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to fetch notes');
      return res.json();
    }
  });

  // Organization Contracts query - fetch contracts linked to this org via scoped API
  const { data: orgContractsData, isLoading: contractsLoading } = useQuery({
    queryKey: ['org-contracts', organization?.id],
    enabled: !!organization?.id && activeTab === 'documents',
    queryFn: async () => {
      const res = await fetch(`/api/contracts/by-organization?organizationId=${organization.id}`, {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to fetch contracts');
      return res.json();
    }
  });
  
  const orgContracts = orgContractsData?.contracts || [];

  // Organization Form Submissions query
  const { data: orgFormSubmissions = [], isLoading: formSubmissionsLoading } = useQuery({
    queryKey: ['org-form-submissions', organization?.id],
    enabled: !!organization?.id && (activeTab === 'forms' || activeTab === 'activity'),
    queryFn: async () => {
      try {
        const submissions = await base44.entities.FormSubmission.list({
          filter: { organization_id: organization.id }
        });
        // Sort by created_date descending
        return (submissions || []).sort((a, b) => 
          new Date(b.created_date || 0) - new Date(a.created_date || 0)
        );
      } catch {
        return [];
      }
    }
  });

  // Fetch form details for the submissions
  const { data: formsMap = {}, isFetching: formsMapLoading } = useQuery({
    queryKey: ['forms-for-submissions', orgFormSubmissions.map(s => s.form_id).join(',')],
    enabled: orgFormSubmissions.length > 0,
    queryFn: async () => {
      try {
        const formIds = [...new Set(orgFormSubmissions.map(s => s.form_id).filter(Boolean))];
        const formsData = {};
        for (const formId of formIds) {
          const form = await base44.entities.Form.get(formId);
          if (form) formsData[formId] = form;
        }
        return formsData;
      } catch {
        return {};
      }
    }
  });

  const relationshipSubmissionIds = useMemo(
    () => orgFormSubmissions.filter((submission) => submission?.id).map((submission) => submission.id),
    [orgFormSubmissions],
  );
  const relationshipRecordIds = useMemo(
    () => collectRelationshipRecordIdsFromSubmissions(formsMap, orgFormSubmissions),
    [formsMap, orgFormSubmissions],
  );
  const {
    data: relationshipLabelsByRecordId = {},
    isFetching: relationshipLabelsLoading,
  } = useQuery({
    queryKey: [
      'org-form-submission-relationship-labels',
      relationshipSubmissionIds.join(','),
      relationshipRecordIds.join(','),
    ],
    enabled: relationshipSubmissionIds.length > 0 && relationshipRecordIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const labels = {};
      // Keep each label lookup scoped to the submissions that supplied its
      // record IDs, while respecting the endpoint's 2,000-ID limits.
      for (let submissionOffset = 0; submissionOffset < orgFormSubmissions.length; submissionOffset += 2000) {
        const submissionBatch = orgFormSubmissions
          .slice(submissionOffset, submissionOffset + 2000)
          .filter((submission) => submission?.id);
        if (submissionBatch.length === 0) continue;

        const recordIds = collectRelationshipRecordIdsFromSubmissions(formsMap, submissionBatch);
        for (let recordOffset = 0; recordOffset < recordIds.length; recordOffset += 2000) {
          const response = await fetch('/api/admin/relationship-display-labels', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recordIds: recordIds.slice(recordOffset, recordOffset + 2000),
              submissionIds: submissionBatch.map((submission) => submission.id),
              context: 'form-submissions',
            }),
          });
          if (!response.ok) throw new Error('Failed to resolve relationship labels');
          Object.assign(labels, (await response.json()).labels || {});
        }
      }
      return labels;
    },
  });

  // Form submission preview state
  const [previewSubmission, setPreviewSubmission] = useState(null);
  const [deleteSubmissionId, setDeleteSubmissionId] = useState(null);
  const [deleteConfirmStep, setDeleteConfirmStep] = useState(0);
  const [pdfPreview, setPdfPreview] = useState({ isOpen: false, url: null, fileName: null, isLoading: false });

  // Delete form submission mutation
  const deleteFormSubmissionMutation = useMutation({
    mutationFn: async (submissionId) => {
      await base44.entities.FormSubmission.delete(submissionId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-form-submissions', organization.id] });
      toast.success('Form submission deleted');
      setDeleteSubmissionId(null);
      setDeleteConfirmStep(0);
    },
    onError: (error) => {
      toast.error('Failed to delete submission: ' + error.message);
    }
  });

  // Create note mutation
  const createNoteMutation = useMutation({
    mutationFn: async ({ content, attachments }) => {
      const res = await fetch(`/api/admin/organizations/${organization.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content, attachments })
      });
      if (!res.ok) throw new Error('Failed to create note');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-notes', organization.id] });
      setNewNoteContent('');
      setNewNoteAttachments([]);
      toast.success('Note added');
    },
    onError: (error) => {
      toast.error('Failed to add note: ' + error.message);
    }
  });

  const handleNoteFileUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setIsUploadingFile(true);
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        
        const res = await fetch('/api/integrations/upload-file', {
          method: 'POST',
          body: formData
        });
        
        if (!res.ok) {
          throw new Error('Upload failed');
        }
        
        const result = await res.json();
        setNewNoteAttachments(prev => [...prev, {
          file_url: result.file_url,
          file_name: result.file_name || file.name,
          file_size: result.file_size || file.size,
          mime_type: result.mime_type || file.type
        }]);
      }
      toast.success(`${files.length} file(s) uploaded`);
    } catch (error) {
      console.error('File upload error:', error);
      toast.error('Failed to upload file');
    } finally {
      setIsUploadingFile(false);
      if (noteFileInputRef.current) {
        noteFileInputRef.current.value = '';
      }
    }
  };

  const removeNewNoteAttachment = (index) => {
    setNewNoteAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const isImageFile = (mimeType) => {
    return mimeType && mimeType.startsWith('image/');
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  // Update note mutation
  const updateNoteMutation = useMutation({
    mutationFn: async ({ noteId, content }) => {
      const res = await fetch(`/api/admin/organization-notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content })
      });
      if (!res.ok) throw new Error('Failed to update note');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-notes', organization.id] });
      setEditingNoteId(null);
      setEditingNoteContent('');
      toast.success('Note updated');
    },
    onError: (error) => {
      toast.error('Failed to update note: ' + error.message);
    }
  });

  // Delete note mutation
  const deleteNoteMutation = useMutation({
    mutationFn: async (noteId) => {
      const res = await fetch(`/api/admin/organization-notes/${noteId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to delete note');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-notes', organization.id] });
      toast.success('Note deleted');
    },
    onError: (error) => {
      toast.error('Failed to delete note: ' + error.message);
    }
  });

  // Sync customFieldValues with orgValues when they change (for realtime updates)
  // Only sync when not editing to preserve user edits
  useEffect(() => {
    // DEBUG: Log orgCustomFields to verify correct tenant fields are loaded
    console.log('[OrganisationDetailView DEBUG] orgCustomFields:', orgCustomFields.map(f => ({
      id: f.id,
      name: f.name,
      label: f.label,
      field_type: f.field_type,
      options: f.options,
      tenant_id: f.tenant_id
    })));
    console.log('[OrganisationDetailView DEBUG] orgValues:', orgValues.map(v => ({
      field_id: v.field_id,
      value: v.value
    })));
    
    if (!isEditing && orgCustomFields.length > 0) {
      const valuesMap = buildOrganisationCustomValueMap(orgCustomFields, orgValues);
      console.log('[OrganisationDetailView DEBUG] Final customFieldValues:', valuesMap);
      setCustomFieldValues(valuesMap);
    }
  }, [orgValues, orgCustomFields, isEditing]);

  const createOrgMutation = useMutation({
    mutationFn: async (newOrg) => {
      return await base44.entities.Organization.create(newOrg);
    },
    onSuccess: (createdOrg) => {
      queryClient.invalidateQueries({ queryKey: ['organizations-crm-paginated'] });
      toast.success('Organisation created successfully');
      if (createdOrg?._zohoCrmSync) showZohoCrmSyncToast(createdOrg._zohoCrmSync);
      if (onCreated) {
        onCreated(createdOrg);
      }
    },
    onError: (error) => {
      toast.error('Failed to create organisation: ' + error.message);
    }
  });

  const updateOrgMutation = useMutation({
    mutationFn: async (updates) => {
      return await base44.entities.Organization.update(organization.id, updates);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['organizations-crm-paginated'] });
      queryClient.invalidateQueries({ queryKey: ['organization-direct', organization?.id] });
      toast.success('Organisation updated successfully');
      if (data?._zohoCrmSync) showZohoCrmSyncToast(data._zohoCrmSync);
      setIsEditing(false);
      checkForPendingWorkflows(data);
    },
    onError: (error) => {
      toast.error('Failed to update organisation: ' + error.message);
    }
  });

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file || !organization?.id || isUploadingLogo) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Please upload a valid image file (JPEG, PNG, GIF, or WebP)');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be smaller than 5MB');
      return;
    }

    setIsUploadingLogo(true);
    try {
      const result = await base44.integrations.Core.UploadFile({ file });
      await base44.entities.Organization.update(organization.id, { logo_url: result.file_url });
      queryClient.invalidateQueries({ queryKey: ['organizations-crm-paginated'] });
      queryClient.invalidateQueries({ queryKey: ['organization-direct', organization.id] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success('Logo updated');
    } catch (error) {
      showUploadErrorToast(error, 'Failed to update logo');
    } finally {
      setIsUploadingLogo(false);
    }
  };

  const updateCustomFieldMutation = useMutation({
    mutationFn: async ({ fieldId, value }) => {
      const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value);
      console.log('[CustomField Mutation] fieldId:', fieldId, 'value:', value, 'storedValue:', storedValue, 'orgId:', organization.id);
      
      const res = await fetch('/api/entities/organization-preference-value/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          organization_id: organization.id,
          field_id: fieldId,
          value: storedValue
        })
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to save custom field');
      }
      
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['org-detail-preference-values', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['all-org-preference-values-crm'] });
      // Check for pending workflow confirmations
      checkForPendingWorkflows(data);
    }
  });

  const handleSave = async () => {
    const textareaFields = (orgCustomFields || []).filter(f => 
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

    if (isNew) {
      // Prevent duplicate submissions
      if (createOrgMutation.isPending) return;
      
      // Create mode: create org first, then save custom fields
      if (!formData.name?.trim()) {
        toast.error('Organisation name is required');
        return;
      }
      
      createOrgMutation.mutate(formData, {
        onSuccess: async (createdOrg) => {
          // Save custom field values for the newly created org
          const currentCustomFieldValues = { ...customFieldValues };
          for (const [fieldId, value] of Object.entries(currentCustomFieldValues)) {
            // Use ?? to preserve falsy values like 0 or false
            const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
            // Only skip truly empty strings or empty arrays
            if (storedValue && storedValue !== '[]') {
              try {
                await base44.entities.OrganizationPreferenceValue.create({
                  organization_id: createdOrg.id,
                  field_id: fieldId,
                  value: storedValue
                });
              } catch (err) {
                console.error('Failed to save custom field:', fieldId, err);
              }
            }
          }
          queryClient.invalidateQueries({ queryKey: ['all-org-preference-values-crm'] });
        }
      });
    } else {
      // Update mode: existing behaviour
      updateOrgMutation.mutate(formData);
      
      // Capture current values at save time to avoid stale closure issues
      const currentCustomFieldValues = { ...customFieldValues };
      const currentOrgValues = [...orgValues];
      
      console.log('[handleSave] customFieldValues:', currentCustomFieldValues);
      console.log('[handleSave] orgValues:', currentOrgValues.map(v => ({ field_id: v.field_id, value: v.value })));
      
      Object.entries(currentCustomFieldValues).forEach(([fieldId, value]) => {
        const existingVal = currentOrgValues.find(v => v.field_id === fieldId);
        const field = orgCustomFields.find(candidate => candidate.id === fieldId);
        const changed = !organisationCustomValuesEqual(field, value, existingVal?.value);
        
        console.log('[handleSave] Field:', fieldId, 'newValue:', value, 'existingValue:', existingVal?.value, 'changed:', changed);
        
        if (changed) {
          updateCustomFieldMutation.mutate({ 
            fieldId, 
            value: isOrganisationListField(field)
              ? normalizeOrganisationCustomValue(field, value)
              : value
          });
        }
      });
    }
  };

  const handleCancel = () => {
    if (isNew) {
      // Cancel creating a new org - go back
      onBack?.();
      return;
    }
    
    setFormData({
      name: organization.name || '',
      email: organization.email || '',
      phone: organization.phone || '',
      website_url: organization.website_url || '',
      invoicing_email: organization.invoicing_email || '',
      invoicing_address: organization.invoicing_address || '',
      description: organization.description || ''
    });
    
    const valuesMap = buildOrganisationCustomValueMap(orgCustomFields, orgValues);
    setCustomFieldValues(valuesMap);
    setIsEditing(false);
  };

  const handlePdfPreview = async (submissionId) => {
    setPdfPreview(prev => ({ ...prev, isLoading: true }));
    try {
      const response = await fetch(`/api/contracts/download-pdf?submissionId=${submissionId}`, {
        credentials: 'include'
      });
      const data = await response.json();
      
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to load PDF');
      }
      
      setPdfPreview({
        isOpen: true,
        url: data.downloadUrl,
        fileName: data.fileName || 'signed-contract.pdf',
        isLoading: false
      });
    } catch (error) {
      toast.error(error.message || 'Failed to load PDF');
      setPdfPreview({ isOpen: false, url: null, fileName: null, isLoading: false });
    }
  };

  const handlePdfDownload = () => {
    if (pdfPreview.url) {
      const link = document.createElement('a');
      link.href = pdfPreview.url;
      link.download = pdfPreview.fileName;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast.success('Download started');
    }
  };

  const closePdfPreview = () => {
    setPdfPreview({ isOpen: false, url: null, fileName: null, isLoading: false });
  };

  const renderFieldEditor = (field, isLocked = false) => {
    const value = customFieldValues[field.id];
    const disabledOverride = !isEditing || isLocked;
    
    switch (field.field_type) {
      case 'text':
        return (
          <Input
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={disabledOverride}
            data-testid={`input-custom-${field.id}`}
          />
        );
      case 'textarea':
      case 'long_text': {
        const taCharCount = (value || '').length;
        const taMaxLen = field.max_length;
        const taMinLen = field.min_length;
        const taOverLimit = taMaxLen && taCharCount > taMaxLen;
        const taUnderLimit = taMinLen && taCharCount > 0 && taCharCount < taMinLen;
        return (
          <div className="space-y-1">
            <Textarea
              value={value || ''}
              onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
              disabled={disabledOverride}
              rows={3}
              maxLength={taMaxLen || undefined}
              className={taOverLimit ? 'border-red-500 focus-visible:ring-red-500' : ''}
              data-testid={`textarea-custom-${field.id}`}
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
        );
      }
      case 'number':
      case 'decimal':
        return (
          <Input
            type="number"
            step={field.field_type === 'decimal' ? '0.01' : '1'}
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={disabledOverride}
            data-testid={`input-custom-${field.id}`}
          />
        );
      case 'dropdown':
        return (
          <Select
            value={value || ''}
            onValueChange={(v) => setCustomFieldValues(prev => ({ ...prev, [field.id]: v === '__clear__' ? '' : v }))}
            disabled={disabledOverride}
          >
            <SelectTrigger data-testid={`select-custom-${field.id}`}>
              <SelectValue placeholder={`Select ${field.label}`} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__clear__" className="text-muted-foreground italic" data-testid={`select-custom-${field.id}-clear`}>None (clear selection)</SelectItem>
              {(field.options || []).map((opt, idx) => (
                <SelectItem key={idx} value={opt.value}>{opt.label || opt.value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case 'picklist':
        const selectedValues = normalizeOrganisationCustomValue(field, value);
        return (
          <div className="space-y-2">
            {(field.options || []).map((opt, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Checkbox
                  checked={selectedValues.includes(opt.value)}
                  onCheckedChange={(checked) => {
                    if (disabledOverride) return;
                    const newValues = checked 
                      ? [...selectedValues, opt.value]
                      : selectedValues.filter(v => v !== opt.value);
                    setCustomFieldValues(prev => ({ ...prev, [field.id]: newValues }));
                  }}
                  disabled={disabledOverride}
                  data-testid={`checkbox-custom-${field.id}-${opt.value}`}
                />
                <span className="text-sm">{opt.label || opt.value}</span>
              </div>
            ))}
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
          <Select
            value={resolvedValue}
            onValueChange={(v) => setCustomFieldValues(prev => ({ ...prev, [field.id]: v === '__clear__' ? '' : v }))}
            disabled={disabledOverride}
          >
            <SelectTrigger data-testid={`select-custom-country-${field.id}`}>
              <SelectValue placeholder={`Select ${field.label}`} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__clear__" className="text-muted-foreground italic" data-testid={`select-custom-country-${field.id}-clear`}>None (clear selection)</SelectItem>
              {availableCountries.map((country) => (
                <SelectItem key={country.code} value={country.name}>{country.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center" data-testid={`text-custom-${field.id}`}>
            {resolvedValue || '-'}
          </div>
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
          return (
            <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center" data-testid={`text-custom-${field.id}`}>
              {normalizedSelected.length > 0 ? normalizedSelected.join(', ') : '-'}
            </div>
          );
        }
        return (
          <OrgCountryMultiSelect
            fieldId={field.id}
            selectedValues={normalizedSelected}
            availableCountries={availableCountriesList}
            onChange={(newValues) => setCustomFieldValues(prev => ({ ...prev, [field.id]: newValues }))}
            label={field.label}
            disabled={isLocked}
          />
        );
      }
      case 'list':
        return (
          <ListFieldEditorOrg
            fieldId={field.id}
            values={Array.isArray(value) ? value : []}
            onChange={(newValues) => {
              setCustomFieldValues(prev => ({ ...prev, [field.id]: newValues }));
            }}
            disabled={disabledOverride}
            placeholder={`Add ${field.label.toLowerCase()}...`}
          />
        );
      case 'boolean':
      case 'checkbox': {
        const isChecked = value === 'true' || value === true;
        return isEditing ? (
          <div className="flex items-center gap-2 min-h-9">
            <Switch
              id={`custom-bool-${field.id}`}
              checked={isChecked}
              onCheckedChange={(checked) => setCustomFieldValues(prev => ({ ...prev, [field.id]: checked ? 'true' : 'false' }))}
              disabled={isLocked}
              data-testid={`switch-custom-${field.id}`}
            />
          </div>
        ) : (
          <div className="flex items-center min-h-9" data-testid={`text-custom-${field.id}`}>
            <Switch
              checked={isChecked}
              disabled
              aria-readonly="true"
              data-testid={`switch-custom-${field.id}-readonly`}
            />
          </div>
        );
      }
      case 'date':
        return isEditing ? (
          <Input
            type="date"
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={isLocked}
            data-testid={`input-custom-date-${field.id}`}
          />
        ) : (
          <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
            {formatDate(value) || '-'}
          </div>
        );
      case 'email':
        return isEditing ? (
          <Input
            type="email"
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={isLocked}
            data-testid={`input-custom-email-${field.id}`}
          />
        ) : (
          <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
            {value ? (
              <a href={`mailto:${value}`} className="text-blue-600 hover:underline">{value}</a>
            ) : '-'}
          </div>
        );
      case 'url':
        return isEditing ? (
          <Input
            type="url"
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            placeholder="https://"
            disabled={isLocked}
            data-testid={`input-custom-url-${field.id}`}
          />
        ) : (
          <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
            {value ? (
              <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                {value} <ExternalLink className="w-3 h-3" />
              </a>
            ) : '-'}
          </div>
        );
      default:
        return (
          <Input
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={disabledOverride}
          />
        );
    }
  };

  const renderCoreField = (fieldKey, isLocked = false) => {
    const coreFieldDef = CORE_FIELDS.find(f => f.fieldKey === fieldKey);
    if (!coreFieldDef) return null;
    
    const value = formData[fieldKey];
    const label = coreFieldDef.label;
    const lockBadge = isLocked && isEditing ? (
      <Lock className="w-3 h-3 text-slate-400" data-testid={`lock-icon-${fieldKey}`} />
    ) : null;
    
    if (fieldKey === 'description') {
      return (
        <div className="space-y-2">
          <Label className="text-slate-500 min-h-5 flex items-center gap-1">{label}{lockBadge}</Label>
          {isEditing ? (
            <Textarea
              value={value || ''}
              onChange={(e) => setFormData(prev => ({ ...prev, [fieldKey]: e.target.value }))}
              rows={3}
              disabled={isLocked}
              data-testid={`textarea-${fieldKey}`}
            />
          ) : (
            <div className="min-h-[80px] px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 text-slate-700">
              {value || 'No description provided'}
            </div>
          )}
        </div>
      );
    }
    
    if (fieldKey === 'invoicing_address') {
      return (
        <div className="space-y-2">
          <Label className="text-slate-500 flex items-center gap-1">
            <MapPin className="w-3 h-3" /> {label}{lockBadge}
          </Label>
          {isEditing ? (
            <Textarea
              value={value || ''}
              onChange={(e) => setFormData(prev => ({ ...prev, [fieldKey]: e.target.value }))}
              rows={2}
              disabled={isLocked}
              data-testid={`textarea-${fieldKey}`}
            />
          ) : (
            <div className="min-h-[60px] px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 whitespace-pre-line">
              {value || '-'}
            </div>
          )}
        </div>
      );
    }
    
    if (fieldKey === 'website_url') {
      return (
        <div className="space-y-2">
          <Label className="text-slate-500 flex items-center gap-1">
            <Globe className="w-3 h-3" /> {label}{lockBadge}
          </Label>
          {isEditing ? (
            <Input
              value={value || ''}
              onChange={(e) => setFormData(prev => ({ ...prev, [fieldKey]: e.target.value }))}
              disabled={isLocked}
              data-testid={`input-${fieldKey}`}
            />
          ) : (
            <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
              {value ? (
                <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1">
                  {value}
                  <ExternalLink className="w-3 h-3" />
                </a>
              ) : '-'}
            </div>
          )}
        </div>
      );
    }
    
    if (fieldKey === 'organization_group_id') {
      const currentGroup = orgGroups.find(g => g.id === (isEditing ? value : organization?.organization_group_id));
      return (
        <div className="space-y-2">
          <Label className="text-slate-500 flex items-center gap-1">
            <Building2 className="w-3 h-3" /> {label}{lockBadge}
          </Label>
          {isEditing ? (
            <Select
              value={value || 'none'}
              onValueChange={(v) => setFormData(prev => ({ ...prev, organization_group_id: v === 'none' ? '' : v }))}
              disabled={isLocked}
            >
              <SelectTrigger data-testid="select-organisation-group">
                <SelectValue placeholder="No group" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No group</SelectItem>
                {orgGroups.map(g => (
                  <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center" data-testid="text-organisation-group">
              {currentGroup?.name || '-'}
            </div>
          )}
        </div>
      );
    }

    if (fieldKey === 'created_at') {
      const dateValue = organization?.created_at;
      return (
        <div className="space-y-2">
          <Label className="text-slate-500 flex items-center gap-1">
            <Calendar className="w-3 h-3" /> {label}
          </Label>
          <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
            {formatDate(dateValue)}
          </div>
        </div>
      );
    }
    
    const iconMap = {
      email: <Mail className="w-3 h-3" />,
      invoicing_email: <Mail className="w-3 h-3" />,
      phone: <Phone className="w-3 h-3" />,
      name: null
    };

    const inputType = (fieldKey === 'email' || fieldKey === 'invoicing_email') ? 'email' : 'text';

    return (
      <div className="space-y-2">
        <Label className="text-slate-500 flex items-center gap-1">
          {iconMap[fieldKey]} {label}{lockBadge}
        </Label>
        {isEditing ? (
          <Input
            type={inputType}
            value={value || ''}
            onChange={(e) => setFormData(prev => ({ ...prev, [fieldKey]: e.target.value }))}
            disabled={isLocked}
            data-testid={`input-${fieldKey}`}
          />
        ) : (
          <div className={`min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center ${fieldKey === 'name' ? 'font-medium' : ''}`}>
            {value || '-'}
          </div>
        )}
      </div>
    );
  };

  const { hiddenFields, hiddenCards, lockedFields, lockedCards } = evaluateVisibilityRules(
    rulesConfig, 
    { ...formData, custom_field_values: customFieldValues }, 
    orgCustomFields
  );

  const renderLayoutCard = (card) => {
    if (card.fields.length === 0) return null;
    if (hiddenCards.has(card.id)) return null;
    
    const gridCols = card.columns === 1 ? 'grid-cols-1' : card.columns === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-3';
    const isCardLocked = lockedCards.has(card.id);
    
    const renderField = (field) => {
      if (hiddenFields.has(field.id)) {
        return null;
      }
      
      const isFieldLocked = isCardLocked || lockedFields.has(field.id);
      
      if (field.type === 'relationship') {
        const panel = relatedRecords.panels.find(({ definition, side }) =>
          String(definition.id) === String(field.definitionId) && side === field.side
        );
        if (!panel) return null;
        return (
          <div key={field.id} className="md:col-span-full" data-testid={`organisation-layout-${field.id}`}>
            <RelatedRecordsPanel
              context={relatedRecords.context}
              record={organization}
              definition={panel.definition}
              side={panel.side}
              showHeading={false}
              embedded
            />
          </div>
        );
      }

      if (field.type === 'core') {
        return (
          <div key={field.id}>
            {renderCoreField(field.fieldKey, isFieldLocked)}
          </div>
        );
      } else {
        const customField = orgCustomFields.find(cf => cf.id === field.fieldId);
        if (!customField) return null;
        return (
          <div key={field.id} className="space-y-2">
            <Label className="text-slate-500 min-h-5 flex items-center gap-1">
              {customField.label}
              {isFieldLocked && isEditing && (
                <Lock className="w-3 h-3 text-slate-400" data-testid={`lock-icon-custom-${customField.id}`} />
              )}
            </Label>
            {renderFieldEditor(customField, isFieldLocked)}
          </div>
        );
      }
    };
    
    const isCollapsed = collapsedSections[card.id];
    
    return (
      <Card key={card.id}>
        <CardHeader 
          className="cursor-pointer select-none"
          onClick={() => toggleSection(card.id)}
          data-testid={`card-header-${card.id}`}
        >
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-blue-600" />
            {card.title}
            <span className="ml-auto">
              {isCollapsed ? (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronUp className="w-4 h-4 text-slate-400" />
              )}
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

  // Render MemberDetailView when creating a new member for this organisation
  if (isCreatingMember) {
    return (
      <MemberDetailView
        member={{}}
        onBack={() => setIsCreatingMember(false)}
        memberCustomFields={memberCustomFields}
        organizations={allOrganizations}
        roles={roles}
        isNew={true}
        defaultOrganizationId={organization?.id || ''}
        onCreated={(createdMember) => {
          setIsCreatingMember(false);
          // Refresh the org members list
          queryClient.invalidateQueries({ queryKey: ['org-detail-members', organization?.id] });
          toast.success(`Member "${getMemberName(createdMember) || createdMember.email}" added to organisation`);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back">
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <div className="flex items-center gap-4">
                {isNew ? (
                  <div className="w-14 h-14 rounded-lg bg-green-100 flex items-center justify-center">
                    <Building2 className="w-7 h-7 text-green-600" />
                  </div>
                ) : (() => {
                  const safeSrc = safeLogoSrc(organization?.logo_url);
                  const inner = safeSrc ? (
                    <img src={safeSrc} alt={organization.name} className="w-14 h-14 rounded-lg object-contain bg-slate-100" />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-blue-100 flex items-center justify-center">
                      <Building2 className="w-7 h-7 text-blue-600" />
                    </div>
                  );
                  if (!isAdmin) return inner;
                  return (
                    <>
                      <button
                        type="button"
                        onClick={() => !isUploadingLogo && logoFileInputRef.current?.click()}
                        disabled={isUploadingLogo}
                        aria-label={safeSrc ? 'Change organisation logo' : 'Upload organisation logo'}
                        title={safeSrc ? 'Click to change logo' : 'Click to upload logo'}
                        className="group relative w-14 h-14 rounded-lg overflow-hidden cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-wait"
                        data-testid="button-org-logo-upload"
                      >
                        {inner}
                        {isUploadingLogo ? (
                          <span
                            className="absolute inset-0 flex items-center justify-center bg-black/40"
                            data-testid="status-org-logo-uploading"
                          >
                            <Loader2 className="w-5 h-5 text-white animate-spin" />
                          </span>
                        ) : (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
                            <Camera className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                          </span>
                        )}
                      </button>
                      <input
                        ref={logoFileInputRef}
                        type="file"
                        accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                        className="hidden"
                        onChange={handleLogoUpload}
                        data-testid="input-org-logo-file"
                      />
                    </>
                  );
                })()}
                <div>
                  <h1 className="text-xl font-semibold text-slate-900">
                    {isNew ? 'Add New Organisation' : (organization?.name || 'Organisation')}
                  </h1>
                  {!isNew && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-sm text-slate-500 flex items-center gap-1">
                        <Users className="w-4 h-4" />
                        {orgMembers.length} {orgMembers.length === 1 ? memberLabel.toLowerCase() : memberLabelPlural.toLowerCase()}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            
            {isAdmin && (
              <div className="flex items-center gap-2">
                {isEditing || isNew ? (
                  <>
                    <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-edit">
                      <X className="w-4 h-4 mr-2" />
                      Cancel
                    </Button>
                    <Button 
                      onClick={handleSave} 
                      disabled={isNew ? createOrgMutation.isPending : updateOrgMutation.isPending}
                      data-testid="button-save-org"
                    >
                      {(isNew ? createOrgMutation.isPending : updateOrgMutation.isPending) ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4 mr-2" />
                      )}
                      {isNew ? 'Create Organisation' : 'Save Changes'}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setShowRulesEditor(true)} data-testid="button-visibility-rules">
                      <Settings2 className="w-4 h-4 mr-2" />
                      Rules
                    </Button>
                    <Button variant="outline" onClick={() => setShowLayoutEditor(true)} data-testid="button-customize-layout">
                      <LayoutGrid className="w-4 h-4 mr-2" />
                      Customize Layout
                    </Button>
                    <Button onClick={() => setIsEditing(true)} data-testid="button-edit-org">
                      <Pencil className="w-4 h-4 mr-2" />
                      Edit
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        
        {!isNew && (
          <Tabs value={activeTab} onValueChange={(val) => { setActiveTab(val); setDeleteSubmissionId(null); setDeleteConfirmStep(0); }} className="px-6">
            <TabsList className="bg-transparent border-b-0">
              <TabsTrigger value="overview" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-overview">
                Overview
              </TabsTrigger>
              <TabsTrigger value="members" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-members">
                {memberLabelPlural}
              </TabsTrigger>
              <TabsTrigger value="activity" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-activity">
                Activity
              </TabsTrigger>
              {canViewCommercial && !isNew && (
                <TabsTrigger value="commercial" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-commercial">
                  Commercial
                </TabsTrigger>
              )}
              <TabsTrigger value="notes" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-notes">
                Notes
              </TabsTrigger>
              <TabsTrigger value="forms" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-forms">
                Forms
              </TabsTrigger>
              <TabsTrigger value="documents" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-documents">
                Documents
              </TabsTrigger>
              <TabsTrigger value="membership" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-membership">
                Membership
              </TabsTrigger>
              {relatedRecords.panels.map(({ definition, side, count }) => (
                <TabsTrigger key={`${definition.id}-${side}`} value={relationshipTabValue(definition, side)} className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid={`tab-relationship-${definition.id}-${side}`}>
                  {labelForSide(definition, side)}{count != null ? ` (${count})` : ""}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
      </header>

      {showLayoutEditor && (
        <OrgDetailLayoutEditor
          layout={effectiveLayout}
          customFields={orgCustomFields}
          relationshipPanels={relatedRecords.panels}
          onSave={async (newLayout) => {
            await saveLayout(newLayout);
            setShowLayoutEditor(false);
          }}
          onCancel={() => setShowLayoutEditor(false)}
          isSaving={isLayoutSaving}
        />
      )}

      <OrgFieldVisibilityRulesEditor
        open={showRulesEditor}
        onOpenChange={setShowRulesEditor}
        rulesConfig={rulesConfig}
        customFields={orgCustomFields}
        layoutCards={effectiveLayout?.cards || []}
        relationshipPanels={relatedRecords.panels}
        onSave={saveRules}
        onCancel={() => setShowRulesEditor(false)}
        isSaving={isRulesSaving}
      />

      <main className="p-6">
        {relatedRecords.panels.map(({ definition, side }) => (
          activeTab === relationshipTabValue(definition, side) && (
            <RelatedRecordsPanel
              key={`${definition.id}-${side}`}
              context={relatedRecords.context}
              record={organization}
              definition={definition}
              side={side}
              showHeading={false}
            />
          )
        ))}
        {(activeTab === 'overview' || isNew) && (
          <div className={isNew ? "max-w-4xl mx-auto space-y-6" : "grid grid-cols-1 lg:grid-cols-3 gap-6"}>
            <div className={isNew ? "space-y-6" : "lg:col-span-2 space-y-6"}>
              {isLayoutLoading ? (
                <div className="space-y-6">
                  {[1, 2, 3].map(i => (
                    <Card key={i}>
                      <CardHeader>
                        <div className="h-5 w-40 bg-slate-200 rounded animate-pulse" />
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          <div className="h-4 w-full bg-slate-100 rounded animate-pulse" />
                          <div className="h-4 w-3/4 bg-slate-100 rounded animate-pulse" />
                          <div className="h-4 w-1/2 bg-slate-100 rounded animate-pulse" />
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                effectiveLayout.cards.map(card => renderLayoutCard(card))
              )}
            </div>

            {!isNew && (
              <div className="space-y-6">
                {!hideTrainingFundCard && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base flex items-center gap-2">
                        <Wallet className="w-4 h-4 text-green-600" />
                        Training Fund
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-center py-4">
                        <p className="text-3xl font-bold text-green-600">
                          £{(organization?.training_fund_balance || 0).toFixed(2)}
                        </p>
                        <p className="text-sm text-slate-500 mt-1">Available Balance</p>
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Tag className="w-4 h-4 text-blue-600" />
                      Tags
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CrmTagInput
                      tags={organization?.tags || []}
                      entityType="organization"
                      onChange={async (newTags) => {
                        try {
                          await base44.entities.Organization.update(organization.id, { tags: newTags });
                          queryClient.invalidateQueries({ queryKey: ['organizations-crm-paginated'] });
                          queryClient.invalidateQueries({ queryKey: ['organization-direct', organization.id] });
                          queryClient.invalidateQueries({ queryKey: ['admin-organizations-tags'] });
                        } catch (err) {
                          toast.error('Failed to update tags: ' + err.message);
                        }
                      }}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Users className="w-4 h-4 text-blue-600" />
                      Team Overview
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      <button
                        type="button"
                        onClick={() => setActiveTab('members')}
                        className="flex items-center justify-between w-full text-left rounded-md p-2 -m-2 hover-elevate active-elevate-2 cursor-pointer"
                        data-testid="button-total-members"
                      >
                        <span className="text-slate-500">Total {memberLabelPlural}</span>
                        <span className="font-medium">{orgMembers.length}</span>
                      </button>
                      <Separator />
                      {featuredMembers.length > 0 && (
                        <div className="space-y-2">
                          {featuredMembers.map(member => (
                            <Link
                              key={member.id}
                              to={`/members/${member.id}`}
                              className="flex items-center gap-2 text-sm p-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900 hover-elevate active-elevate-2 cursor-pointer"
                              data-testid={`featured-member-${member.id}`}
                            >
                              <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center flex-shrink-0">
                                <Star className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                              </div>
                              <div className="min-w-0">
                                <p className="font-medium text-slate-700 dark:text-slate-200 truncate">{getMemberName(member) || member.email}</p>
                                <p className="text-xs text-blue-600 dark:text-blue-400 truncate">{roleNameById[String(member.role_id)] || member.job_title || 'Member'}</p>
                              </div>
                            </Link>
                          ))}
                        </div>
                      )}
                      <div className="space-y-2">
                        {summaryMembers.slice(0, 5).map(member => (
                          <Link
                            key={member.id}
                            to={`/members/${member.id}`}
                            className="flex items-center gap-2 text-sm p-2 rounded-md -mx-2 hover-elevate active-elevate-2 cursor-pointer"
                            data-testid={`summary-member-${member.id}`}
                          >
                            <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                              <User className="w-4 h-4 text-slate-400" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-slate-700 truncate">{getMemberName(member) || member.email}</p>
                              <p className="text-xs text-slate-400 truncate">{member.job_title || 'Member'}</p>
                            </div>
                          </Link>
                        ))}
                        {summaryMembers.length > 5 && (
                          <button
                            type="button"
                            onClick={() => setActiveTab('members')}
                            className="text-xs text-slate-400 text-center pt-2 w-full rounded-md hover-elevate active-elevate-2 cursor-pointer"
                            data-testid="button-more-members"
                          >
                            +{summaryMembers.length - 5} more {(summaryMembers.length - 5) === 1 ? memberLabel.toLowerCase() : memberLabelPlural.toLowerCase()}
                          </button>
                        )}
                      </div>
                      {organization?.id && (
                        <>
                          <Separator />
                          <MemberJoinLinkSection organizationId={organization.id} />
                        </>
                      )}
                      {tenantGuestAccess?.enabled && organization?.id && (
                        <>
                          <Separator />
                          <div className="space-y-3">
                            <div className="flex items-center gap-2">
                              <UserCheck className="w-4 h-4 text-slate-500" />
                              <h4 className="text-sm font-semibold text-slate-700">Guest Access</h4>
                            </div>
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1">
                                <Label htmlFor="org_detail_guest_access_enabled" className="text-sm font-medium cursor-pointer">
                                  Allow guests to join this organisation
                                </Label>
                                <p className="text-xs text-slate-500 mt-0.5">
                                  Anyone signing up via the guest sign-up link can be added to this organisation, even if their email domain isn't on the verified list.
                                </p>
                              </div>
                              <Switch
                                id="org_detail_guest_access_enabled"
                                checked={orgGuestForm.enabled}
                                onCheckedChange={(checked) => persistOrgGuestAccess({ ...orgGuestForm, enabled: checked })}
                                disabled={updateOrgGuestAccessMutation.isPending}
                                data-testid="toggle-org-detail-guest-access-enabled"
                              />
                            </div>
                            {orgGuestForm.enabled && (
                              <div className="space-y-2 border-t border-slate-100 pt-3">
                                <Label className="text-xs font-medium text-slate-700">
                                  Default access period for new guests
                                </Label>
                                <div className="flex items-center gap-3 flex-wrap">
                                  <div className="flex items-center gap-2">
                                    <Input
                                      type="number"
                                      min={1}
                                      step={1}
                                      value={orgGuestForm.unlimited ? '' : orgGuestForm.period_days}
                                      onChange={(e) => {
                                        const val = parseInt(e.target.value, 10);
                                        setOrgGuestForm(prev => ({
                                          ...prev,
                                          period_days: Number.isFinite(val) && val > 0 ? val : 1,
                                        }));
                                      }}
                                      onBlur={() => {
                                        if (!orgGuestForm.unlimited) {
                                          persistOrgGuestAccess(orgGuestForm);
                                        }
                                      }}
                                      disabled={orgGuestForm.unlimited || updateOrgGuestAccessMutation.isPending}
                                      className="w-24"
                                      data-testid="input-org-detail-guest-default-days"
                                    />
                                    <span className="text-xs text-slate-600">days</span>
                                  </div>
                                  <label className="flex items-center gap-2 p-1.5 rounded-md hover-elevate cursor-pointer">
                                    <Checkbox
                                      checked={orgGuestForm.unlimited}
                                      onCheckedChange={(checked) => {
                                        persistOrgGuestAccess({ ...orgGuestForm, unlimited: !!checked });
                                      }}
                                      disabled={updateOrgGuestAccessMutation.isPending}
                                      data-testid="checkbox-org-detail-guest-unlimited"
                                    />
                                    <span className="text-xs text-slate-700 inline-flex items-center gap-1">
                                      <InfinityIcon className="w-3.5 h-3.5 text-slate-500" />
                                      Unlimited (Permanent)
                                    </span>
                                  </label>
                                </div>
                                <p className="text-xs text-slate-500">
                                  Pre-filled from the tenant default
                                  ({tenantGuestAccess?.unlimited
                                    ? 'Unlimited'
                                    : `${tenantGuestAccess?.default_period_days || 30} days`}).
                                  Override it here for this organisation only.
                                </p>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}

        {activeTab === 'members' && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5 text-blue-600" />
                  Organisation {memberLabelPlural} ({filteredOrgMembers.length}{memberRoleFilter !== 'all' ? ` of ${orgMembers.length}` : ''})
                </CardTitle>
                <div className="flex items-center gap-2">
                  {availableRolesForFilter.length > 0 && (
                    <Select value={memberRoleFilter} onValueChange={setMemberRoleFilter}>
                      <SelectTrigger className="w-[180px]" data-testid="select-role-filter">
                        <SelectValue placeholder="Filter by Role" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Roles</SelectItem>
                        {availableRolesForFilter.map(role => (
                          <SelectItem key={role.id} value={String(role.id)}>
                            {role.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {isAdmin && (
                    <Button
                      variant="outline"
                      onClick={() => setShowInviteDialog(true)}
                      data-testid="button-invite-org-member"
                    >
                      <UserPlus className="w-4 h-4 mr-2" />
                      Invite {memberLabel}
                    </Button>
                  )}
                  {isAdmin && (
                    <Button 
                      onClick={() => setIsCreatingMember(true)}
                      data-testid="button-add-org-member"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Add {memberLabel}
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {membersLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : orgMembers.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <Users className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No {memberLabelPlural.toLowerCase()} in this organisation</p>
                </div>
              ) : filteredOrgMembers.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <Users className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No {memberLabelPlural.toLowerCase()} match the selected role filter</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Name</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Email</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Job Title</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredOrgMembers.map(member => (
                        <tr key={member.id} className="hover:bg-slate-50" data-testid={`row-member-${member.id}`}>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                                <User className="w-4 h-4 text-blue-600" />
                              </div>
                              <Link
                                to={`/members/${member.id}`}
                                className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                                data-testid={`link-member-${member.id}`}
                              >
                                {getMemberName(member) || '-'}
                              </Link>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-600">{member.email}</td>
                          <td className="px-4 py-3 text-slate-600">{member.job_title || '-'}</td>
                          <td className="px-4 py-3">
                            <Badge variant={!member.disabled ? 'default' : 'secondary'} className="capitalize">
                              {member.disabled ? 'disabled' : 'active'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === 'activity' && (
          <div className="space-y-6">
            <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="w-5 h-5 text-blue-600" />
                Recent Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(bookingsLoading || formSubmissionsLoading) ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : (orgBookings.length === 0 && orgFormSubmissions.length === 0) ? (
                <div className="text-center py-12 text-slate-500">
                  <Calendar className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No recent activity</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {(() => {
                    const bookingItems = orgBookings.slice(0, 10).map(booking => ({
                      type: 'booking',
                      id: booking.id,
                      date: new Date(booking.created_date || 0),
                      data: booking
                    }));
                    const submissionItems = orgFormSubmissions.slice(0, 10).map(submission => ({
                      type: 'form_submission',
                      id: submission.id,
                      date: new Date(submission.created_date || 0),
                      data: submission
                    }));
                    const allItems = [...bookingItems, ...submissionItems]
                      .sort((a, b) => b.date - a.date)
                      .slice(0, 15);
                    
                    return allItems.map(item => {
                      if (item.type === 'booking') {
                        const booking = item.data;
                        return (
                          <div key={`booking-${booking.id}`} className="flex items-start gap-4 p-4 bg-slate-50 dark:bg-slate-800 rounded-lg" data-testid={`activity-booking-${booking.id}`}>
                            <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center flex-shrink-0">
                              <Calendar className="w-5 h-5 text-blue-600" />
                            </div>
                            <div>
                              <p className="font-medium text-slate-900 dark:text-slate-100">{booking.event_title || 'Event Booking'}</p>
                              <p className="text-sm text-slate-500">
                                {booking.created_date ? new Date(booking.created_date).toLocaleDateString('en-GB') : 'Unknown date'}
                              </p>
                              <Badge variant="outline" className="mt-2 capitalize">{booking.status || 'confirmed'}</Badge>
                            </div>
                          </div>
                        );
                      } else {
                        const submission = item.data;
                        const form = formsMap[submission.form_id];
                        return (
                          <div 
                            key={`submission-${submission.id}`} 
                            className="flex items-start gap-4 p-4 bg-slate-50 dark:bg-slate-800 rounded-lg cursor-pointer hover-elevate"
                            onClick={() => setPreviewSubmission(submission)}
                            data-testid={`activity-submission-${submission.id}`}
                          >
                            <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center flex-shrink-0">
                              <ClipboardCheck className="w-5 h-5 text-green-600" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-slate-900 dark:text-slate-100">{form?.name || 'Form Submission'}</p>
                              <p className="text-sm text-slate-500">
                                {submission.created_date ? format(new Date(submission.created_date), 'dd MMM yyyy, HH:mm') : 'Unknown date'}
                              </p>
                              <Badge variant="outline" className="mt-2">Form Submitted</Badge>
                            </div>
                            <Link to={`/FormSubmission/${submission.id}?from=org&orgId=${organization.id}`} onClick={(e) => e.stopPropagation()}>
                              <Button
                                variant="ghost"
                                size="icon"
                                data-testid={`button-activity-preview-${submission.id}`}
                              >
                                <Eye className="w-4 h-4 text-slate-400" />
                              </Button>
                            </Link>
                          </div>
                        );
                      }
                    });
                  })()}
                </div>
              )}
            </CardContent>
            </Card>
            <RelatedOpportunityActivity
              organizationId={organization?.id}
              enabled={activeTab === 'activity'}
            />
          </div>
        )}
        {activeTab === 'commercial' && canViewCommercial && !isNew && (
          <div className="p-6">
            <OrganisationCommercial organizationId={organization?.id} enabled />
          </div>
        )}

        {activeTab === 'notes' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <StickyNote className="w-5 h-5 text-blue-600" />
                Organisation Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Textarea
                  placeholder="Add a note..."
                  value={newNoteContent}
                  onChange={(e) => setNewNoteContent(e.target.value)}
                  className="min-h-[100px]"
                  data-testid="input-new-note"
                />
                
                {newNoteAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {newNoteAttachments.map((att, idx) => (
                      <div key={idx} className="relative group">
                        {isImageFile(att.mime_type) ? (
                          <div className="w-20 h-20 rounded border overflow-hidden">
                            <img src={att.file_url} alt={att.file_name} className="w-full h-full object-cover" />
                          </div>
                        ) : (
                          <div className="w-20 h-20 rounded border bg-slate-100 dark:bg-slate-700 flex flex-col items-center justify-center p-2">
                            <FileGenericIcon className="w-6 h-6 text-slate-400" />
                            <span className="text-xs text-slate-500 truncate max-w-full mt-1">{att.file_name}</span>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => removeNewNoteAttachment(idx)}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                          data-testid={`button-remove-attachment-${idx}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                
                <div className="flex justify-between items-center">
                  <div>
                    <input
                      type="file"
                      ref={noteFileInputRef}
                      onChange={handleNoteFileUpload}
                      className="hidden"
                      multiple
                      accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
                      data-testid="input-note-file"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => noteFileInputRef.current?.click()}
                      disabled={isUploadingFile}
                      data-testid="button-attach-file"
                    >
                      {isUploadingFile ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Paperclip className="w-4 h-4 mr-2" />
                      )}
                      Attach Files
                    </Button>
                  </div>
                  <Button
                    onClick={() => createNoteMutation.mutate({ content: newNoteContent, attachments: newNoteAttachments })}
                    disabled={!newNoteContent.trim() || createNoteMutation.isPending}
                    data-testid="button-add-note"
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
                  data-testid="input-search-notes"
                />
              </div>

              {(() => {
                const searchLower = noteSearchTerm.toLowerCase();
                const filteredNotes = orgNotes.filter(note => 
                  note.content?.toLowerCase().includes(searchLower) ||
                  note.member_name?.toLowerCase().includes(searchLower)
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

                if (orgNotes.length === 0) {
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
                        <div key={note.id} className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg space-y-3" data-testid={`note-${note.id}`}>
                          {editingNoteId === note.id ? (
                            <div className="space-y-3">
                              <Textarea
                                value={editingNoteContent}
                                onChange={(e) => setEditingNoteContent(e.target.value)}
                                className="min-h-[80px]"
                                data-testid={`input-edit-note-${note.id}`}
                              />
                              <div className="flex gap-2 justify-end">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setEditingNoteId(null);
                                    setEditingNoteContent('');
                                  }}
                                  data-testid={`button-cancel-edit-${note.id}`}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => updateNoteMutation.mutate({ noteId: note.id, content: editingNoteContent })}
                                  disabled={!editingNoteContent.trim() || updateNoteMutation.isPending}
                                  data-testid={`button-save-note-${note.id}`}
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
                              
                              {note.attachments && note.attachments.length > 0 && (
                                <div className="flex flex-wrap gap-2 pt-2">
                                  {note.attachments.map((att, idx) => (
                                    <a
                                      key={idx}
                                      href={att.file_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="block group"
                                      data-testid={`attachment-${note.id}-${idx}`}
                                    >
                                      {isImageFile(att.mime_type) ? (
                                        <div className="w-24 h-24 rounded border overflow-hidden hover:ring-2 hover:ring-blue-500 transition-all">
                                          <img src={att.file_url} alt={att.file_name} className="w-full h-full object-cover" />
                                        </div>
                                      ) : (
                                        <div className="flex items-center gap-2 px-3 py-2 bg-white dark:bg-slate-700 rounded border hover:ring-2 hover:ring-blue-500 transition-all">
                                          <FileGenericIcon className="w-5 h-5 text-slate-400" />
                                          <div className="text-sm">
                                            <p className="text-slate-700 dark:text-slate-200 truncate max-w-[150px]">{att.file_name}</p>
                                            <p className="text-xs text-slate-400">{formatFileSize(att.file_size)}</p>
                                          </div>
                                          <Download className="w-4 h-4 text-slate-400 group-hover:text-blue-500" />
                                        </div>
                                      )}
                                    </a>
                                  ))}
                                </div>
                              )}
                              
                              <div className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2 text-slate-500">
                                  <User className="w-3 h-3" />
                                  <span>{note.member_name}</span>
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
                                    data-testid={`button-edit-note-${note.id}`}
                                  >
                                    <Pencil className="w-4 h-4 text-slate-400 hover:text-blue-600" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setNoteToDelete(note.id)}
                                    disabled={deleteNoteMutation.isPending}
                                    data-testid={`button-delete-note-${note.id}`}
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
                            data-testid="button-notes-prev-page"
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
                            data-testid="button-notes-next-page"
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
        )}

        {activeTab === 'forms' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ClipboardCheck className="w-5 h-5 text-blue-600" />
                Form Submissions
              </CardTitle>
            </CardHeader>
            <CardContent>
              {formSubmissionsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : orgFormSubmissions.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <ClipboardCheck className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No form submissions for this organisation</p>
                  <p className="text-sm text-slate-400 mt-1">
                    Form submissions linked to this organisation will appear here
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {orgFormSubmissions.map(submission => {
                    const form = formsMap[submission.form_id];
                    const isDeleting = deleteSubmissionId === submission.id;
                    return (
                      <div 
                        key={submission.id} 
                        className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg"
                        data-testid={`submission-${submission.id}`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <h4 className="font-medium text-slate-900 dark:text-slate-100">
                              {form?.name || 'Unknown Form'}
                            </h4>
                            <p className="text-sm text-slate-500 mt-1">
                              Submitted: {submission.created_date ? format(new Date(submission.created_date), 'dd MMM yyyy, HH:mm') : 'Unknown'}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <Link to={`/FormSubmission/${submission.id}?from=org&orgId=${organization.id}`}>
                              <Button
                                variant="outline"
                                size="sm"
                                data-testid={`button-view-submission-${submission.id}`}
                              >
                                <Eye className="w-4 h-4 mr-1" />
                                View Full
                              </Button>
                            </Link>
                            {isAdmin && (
                              <Button
                                variant={isDeleting && deleteConfirmStep === 1 ? 'destructive' : 'outline'}
                                size="sm"
                                onClick={() => {
                                  if (isDeleting && deleteConfirmStep === 1) {
                                    deleteFormSubmissionMutation.mutate(submission.id);
                                  } else {
                                    setDeleteSubmissionId(submission.id);
                                    setDeleteConfirmStep(1);
                                  }
                                }}
                                disabled={deleteFormSubmissionMutation.isPending}
                                data-testid={`button-delete-submission-${submission.id}`}
                              >
                                {deleteFormSubmissionMutation.isPending && isDeleting ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <>
                                    <Trash2 className="w-4 h-4 mr-1" />
                                    {isDeleting && deleteConfirmStep === 1 ? 'Confirm Delete' : 'Delete'}
                                  </>
                                )}
                              </Button>
                            )}
                            {isDeleting && deleteConfirmStep === 1 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setDeleteSubmissionId(null);
                                  setDeleteConfirmStep(0);
                                }}
                                data-testid={`button-cancel-delete-${submission.id}`}
                              >
                                Cancel
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === 'documents' && (() => {
          // Flatten all signed documents from all contracts
          const signedDocuments = orgContracts.flatMap(contract => 
            (contract.signedSigners || [])
              .filter(signer => signer.submission_id)
              .map(signer => ({
                contractId: contract.id,
                contractName: contract.name,
                signerName: signer.name || signer.email,
                signerEmail: signer.email,
                submissionId: signer.submission_id,
                signedAt: signer.signed_at || contract.lastUpdated
              }))
          );
          return (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  <FileSignature className="w-5 h-5 text-blue-600" />
                  Signed Documents
                </CardTitle>
              </CardHeader>
              <CardContent>
                {contractsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                  </div>
                ) : signedDocuments.length === 0 ? (
                  <div className="text-center py-12 text-slate-500">
                    <FileSignature className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                    <p>No signed documents yet</p>
                    <p className="text-sm text-slate-400 mt-1">
                      Documents will appear here once contracts are fully signed
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {signedDocuments.map(doc => (
                      <div 
                        key={`${doc.contractId}-${doc.submissionId}`} 
                        className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg"
                        data-testid={`signed-document-${doc.submissionId}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-green-100 dark:bg-green-900 rounded-md">
                            <FileText className="w-5 h-5 text-green-600 dark:text-green-400" />
                          </div>
                          <div>
                            <h4 className="font-medium text-slate-900 dark:text-slate-100">
                              {doc.contractName}
                            </h4>
                            <p className="text-xs text-slate-500">
                              Signed by {doc.signerName} {doc.signedAt ? `on ${formatDate(doc.signedAt)}` : ''}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button 
                            variant="outline" 
                            size="sm"
                            onClick={() => handlePdfPreview(doc.submissionId)}
                            disabled={pdfPreview.isLoading}
                            data-testid={`button-view-pdf-${doc.submissionId}`}
                          >
                            {pdfPreview.isLoading ? (
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            ) : (
                              <Eye className="w-3 h-3 mr-1" />
                            )}
                            View PDF
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })()}

        {activeTab === 'membership' && (
          <OrgMembershipTab organizationId={organization?.id} invoicingEmail={organization?.invoicing_email} />
        )}

        <AlertDialog open={!!noteToDelete} onOpenChange={(open) => !open && setNoteToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Note</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete this note? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete-note">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (noteToDelete) {
                    deleteNoteMutation.mutate(noteToDelete);
                    setNoteToDelete(null);
                  }
                }}
                className="bg-red-600 hover:bg-red-700"
                data-testid="button-confirm-delete-note"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={!!previewSubmission} onOpenChange={(open) => !open && setPreviewSubmission(null)}>
          <AlertDialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <ClipboardCheck className="w-5 h-5 text-blue-600" />
                Form Submission Preview
              </AlertDialogTitle>
              <AlertDialogDescription>
                {previewSubmission && formsMap[previewSubmission.form_id]?.name || 'Form Submission'} - 
                Submitted {previewSubmission?.created_date ? format(new Date(previewSubmission.created_date), 'dd MMM yyyy, HH:mm') : 'Unknown'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="py-4">
              {previewSubmission?.submission_data && (
                <div className="space-y-3">
                  {(() => {
                    const form = formsMap[previewSubmission.form_id];
                    const fields = form?.fields || [];
                    const values = previewSubmission.submission_data;

                    if (!form && formsMapLoading) {
                      return (
                        <div className="flex items-center gap-2 text-sm text-slate-500">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading submission fields…
                        </div>
                      );
                    }
                    
                    const displayFields = fields.length > 0 
                      ? fields.map(field => ({
                          key: field.id ?? field.name,
                          label: field.label || field.name || field.id,
                          field,
                          value: getSubmissionFieldValue(values, field),
                        })).filter(f => f.value !== undefined && f.value !== null && f.value !== '')
                      : Object.entries(values).map(([key, value]) => ({
                          key,
                          label: key.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim(),
                          field: null,
                          value
                        }));

                    return displayFields.map(({ key, label, field, value }) => {
                      let displayValue;
                      if (isRelationshipDropdownField(field)) {
                        displayValue = relationshipLabelsLoading
                          ? 'Loading related record…'
                          : formatRelationshipDisplayValue(value, relationshipLabelsByRecordId);
                      } else if (typeof value === 'boolean') {
                        displayValue = value ? 'Yes' : 'No';
                      } else if (Array.isArray(value)) {
                        displayValue = value.join(', ');
                      } else if (typeof value === 'object' && value !== null) {
                        displayValue = JSON.stringify(value, null, 2);
                      } else {
                        displayValue = String(value || '');
                      }
                      
                      return (
                        <div key={key} className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
                            {label}
                          </p>
                          <p className="text-slate-900 dark:text-slate-100 whitespace-pre-wrap">
                            {displayValue || <span className="text-slate-400 italic">Empty</span>}
                          </p>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-close-preview">Close</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={pdfPreview.isOpen} onOpenChange={closePdfPreview}>
          <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-0" data-testid="pdf-preview-modal">
            <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <FileSignature className="w-5 h-5 flex-shrink-0" />
                <span className="font-medium truncate">{pdfPreview.fileName}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePdfDownload}
                  className="gap-2"
                  data-testid="button-download-pdf"
                >
                  <Download className="w-4 h-4" />
                  Download
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => pdfPreview.url && window.open(pdfPreview.url, '_blank')}
                  className="gap-2"
                  data-testid="button-open-new-tab"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open in New Tab
                </Button>
              </div>
            </div>
            <div className="flex-1 bg-muted">
              {pdfPreview.url && (
                <iframe
                  src={pdfPreview.url}
                  className="w-full h-full border-0"
                  title="PDF Preview"
                  data-testid="pdf-preview-iframe"
                />
              )}
            </div>
          </DialogContent>
        </Dialog>

        <WorkflowConfirmationModal
          open={showConfirmationModal}
          onOpenChange={setShowConfirmationModal}
          pendingWorkflows={pendingWorkflows}
          onConfirm={handleConfirmWorkflow}
          onSkip={handleSkipWorkflow}
          onSkipAll={handleSkipAllWorkflows}
        />

        <DryRunSimulationModal
          open={showDryRunModal}
          onOpenChange={(open) => {
            setShowDryRunModal(open);
            if (!open) clearDryRunResults();
          }}
          results={dryRunResults}
        />

        {/* Admin invite-member dialog — sends a tokenised /team-invite link to
            an email address, targeting this specific organisation */}
        <InviteMemberDialog
          open={showInviteDialog}
          onOpenChange={setShowInviteDialog}
          targetOrganization={organization ? { id: organization.id, name: organization.name } : null}
          memberInfo={memberInfo}
          organizationInfo={null}
          existingMembers={orgMembers}
        />
      </main>
    </div>
  );
}
