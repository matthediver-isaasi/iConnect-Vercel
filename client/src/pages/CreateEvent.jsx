import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { 
  Calendar, 
  MapPin, 
  Video, 
  Building, 
  Tag,
  ArrowLeft,
  Save,
  Loader2,
  Globe,
  Link as LinkIcon,
  PoundSterling,
  Plus,
  Trash2,
  Users,
  Ticket,
  X,
  ChevronDown,
  ChevronUp,
  Check,
  Mic,
  Mail,
  Eye,
  AlertCircle,
  QrCode
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { createFilterTagKey, parseFilterTagKey, parseEventTypes, serializeEventTypes } from "@/lib/utils";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import { TimezoneAwareDateTimeInput } from "@/components/events/TimezoneAwareDateTimeInput";
import EventClashWarningDialog from "@/components/events/EventClashWarningDialog";
import { checkEventClashes, buildClashWindows } from "@/lib/eventClash";
import { createPageUrl, getEventUrl } from "@/utils";
import EventDocumentsManager from "@/components/events/EventDocumentsManager";
import EventOptionListsEditor from "@/components/events/EventOptionListsEditor";
import { isAttendeeOptionsCollectionEnabled } from "@/lib/attendeeOptionsSetting";
import { formatEventDateTime } from "@/utils/timeFormat";
import EventImageUpload from "@/components/events/EventImageUpload";
import { SpeakerSelectionModal } from "@/components/SpeakerSelectionModal";
import SpeakerAwardsSection, { configToFormState, formStateToConfig } from "@/components/events/SpeakerAwardsSection";
import { useSpeakerModuleName } from "@/hooks/useSpeakerModuleName";
import { useEventTypes } from "@/hooks/useEventTypes";
import { useAgendaItemTypes } from "@/hooks/useAgendaItemTypes";
import TrainingAgendaEditor, { validateAgendaLines, agendaTypeBehaviour, sortAgendaLinesChronologically, agendaLineStartDateTime, agendaLineEndDateTime, normalizeAgendaTime } from "@/components/events/TrainingAgendaEditor";
import { useMemberGroupSettings } from "@/hooks/useMemberGroupSettings";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import EventEmailSettingsEditor, {
  createEmptyEmail,
  formatSchedulingFailures,
  findInvalidCcAddresses,
  putEventEmails,
} from "@/components/events/EventEmailSettingsEditor";
import {
  canUseImmediateTiming,
  normalizeSimpleEventTiming,
  SIMPLE_EVENT_TIMING,
} from "@shared/eventTiming.js";

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      ...options.headers,
    }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

// Helper function to create a new ticket class with unique ID
// visibility_mode options:
// - 'members_only': Only visible to logged-in members (respects role_ids if set)
// - 'members_and_public': Visible to both members and public (non-logged-in) users
// - 'public_only': Only visible to public (non-logged-in) users, hidden from members
const createEmptyTicketClass = (isDefault = false, defaultVatRate = null) => ({
  id: `ticket-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
  name: isDefault ? "Standard Ticket" : "",
  price: "",
  is_free: false, // When true, ticket is free (price = 0)
  role_ids: [], // Empty array means "All Roles"
  member_group_ids: [], // Empty array means no group restriction
  is_default: isDefault,
  visibility_mode: 'members_only', // 'members_only', 'members_and_public', or 'public_only'
  role_match_only: false, // When true AND visibility includes members, ticket only shows if user matches one of role_ids OR member_group_ids
  offer_type: "none",
  bogo_logic_type: "buy_x_get_y_free",
  bogo_buy_quantity: "",
  bogo_get_free_quantity: "",
  bulk_discount_threshold: "",
  bulk_discount_percentage: "",
  available_count: "", // Empty = unlimited, number = limited availability
  is_unlimited_tickets: true, // When true, ticket has no quantity limit
  vat_rate_key: defaultVatRate?.taxType || null, // Xero TaxType identifier
  vat_rate_label: defaultVatRate?.name || null, // Display name (e.g., "Standard Rate (20%)")
  vat_rate_percentage: defaultVatRate?.effectiveRate || null, // Percentage value (e.g., 20)
  is_group_ticket: false,
  group_size: "",
  group_cutoff_date: ""
});

export default function CreateEvent() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { singular: speakerSingular, plural: speakerPlural } = useSpeakerModuleName();
  const { eventTypes } = useEventTypes();
  const { agendaItemTypes } = useAgendaItemTypes();

  // Task #1519: Group-limited mode for Group Admins. Entered via
  // ?group_event=1&group_id=<uuid> (GroupEvents.jsx links this way). In this
  // mode the editor locks member_group_id, allows free tickets only, replaces
  // Zoom with a manual meeting link, and exposes an audience (group-only /
  // public) choice — mirroring the server guardrails in groupAdminEventWrite.js.
  const groupSearchParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const groupId = groupSearchParams.get('group_id') || null;
  const isGroupLimited = groupSearchParams.get('group_event') === '1' && !!groupId;
  // Back-arrow target: in group-event mode, return to whichever context launched
  // the flow (Group Events listing or the member group detail page) rather than
  // the general Events page. Honors a `from` origin marker, defaulting to the
  // member group detail page for this group_id.
  const backUrl = useMemo(() => {
    if (!isGroupLimited) return createPageUrl('Events');
    const from = groupSearchParams.get('from');
    if (from === 'GroupEvents') return createPageUrl('GroupEvents');
    return `${createPageUrl('MemberGroupDetail')}?id=${groupId}`;
  }, [isGroupLimited, groupSearchParams, groupId]);
  const [groupEventPublic, setGroupEventPublic] = useState(false);
  // Training event (Task #3419): simple event + multi-day agenda lines.
  // Declare this before deriving Immediate eligibility to avoid a TDZ render error.
  // ?training=1 preselects the toggle (Multi-Day Event card in Create New Event modal)
  const [isTraining, setIsTraining] = useState(() => groupSearchParams.get('training') === '1');

  const [eventTiming, setEventTiming] = useState("published"); // published, tbc, or immediate

  // Task #3691: whether Immediate Access timing is available for this editor session
  // (only for standard non-training non-group simple events)
  const canUseImmediate = canUseImmediateTiming({
    isTraining,
    isComplex: false,
    isGroupLimited,
  });
  // Derived: is the current timing selection "immediate"?
  const isImmediate = eventTiming === SIMPLE_EVENT_TIMING.IMMEDIATE;

  // TBC-only: replace standard booking elements on the public detail page
  const [replaceBookingElements, setReplaceBookingElements] = useState(false);
  const [bookingReplacementMessage, setBookingReplacementMessage] = useState("");
  const [bookingReplacementCtaLabel, setBookingReplacementCtaLabel] = useState("");
  const [bookingReplacementTitle, setBookingReplacementTitle] = useState("");
  const [eventState, setEventState] = useState("active"); // active, draft, or closed - affects visibility/registration
  const [isFeatured, setIsFeatured] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const [isProgramEvent, setIsProgramEvent] = useState(false);
  const [agendaLines, setAgendaLines] = useState([]);
  const [zoomType, setZoomType] = useState("webinar"); // "webinar" or "meeting"
  const [selectedWebinarId, setSelectedWebinarId] = useState("");
  const [selectedMeetingId, setSelectedMeetingId] = useState("");
  const [unlimitedSeats, setUnlimitedSeats] = useState(true); // Default to unlimited
  const [showSeatCount, setShowSeatCount] = useState(true); // Per-event seat visibility (default: show)
  const [showTicketAvailability, setShowTicketAvailability] = useState(false); // Per-event ticket availability display
  const [qrOnConfirmation, setQrOnConfirmation] = useState(false); // Per-event entrance QR on confirmation emails (in-person only, default: off)
  const [attachedDocuments, setAttachedDocuments] = useState([]);
  const [documentsSectionTitle, setDocumentsSectionTitle] = useState("");
  const [dietaryOptions, setDietaryOptions] = useState([]);
  const [allergyOptions, setAllergyOptions] = useState([]);
  const [accessibilityOptions, setAccessibilityOptions] = useState([]);
  
  // Handler for timing changes - clears TBC/immediate-incompatible fields synchronously
  const handleTimingChange = (newTiming) => {
    if (newTiming === 'tbc' || newTiming === SIMPLE_EVENT_TIMING.IMMEDIATE) {
      // Clear dates, registration deadline and webinar/meeting when switching to TBC or Immediate
      setSelectedWebinarId(null);
      setSelectedMeetingId(null);
      setFormData(prev => ({
        ...prev,
        start_date: '',
        end_date: '',
        registration_closes_at: '',
        timezone: newTiming === SIMPLE_EVENT_TIMING.IMMEDIATE ? null : prev.timezone,
        zoom_webinar_id: null,
        zoom_meeting_id: null,
      }));
    }
    setEventTiming(newTiming);
  };
  
  // Ticket classes state for one-off events
  const [ticketClasses, setTicketClasses] = useState([createEmptyTicketClass(true)]);
  const { ticketTypeName: groupTicketTypeName, featureName: memberGroupFeatureName } = useMemberGroupSettings();

  useEffect(() => {
    if (!isGroupLimited) return;
    if (!groupTicketTypeName || groupTicketTypeName === "Standard Ticket") return;
    setTicketClasses((prev) => {
      if (!prev.some((t) => t.is_default && t.name === "Standard Ticket")) return prev;
      return prev.map((t) =>
        t.is_default && t.name === "Standard Ticket" ? { ...t, name: groupTicketTypeName } : t
      );
    });
  }, [isGroupLimited, groupTicketTypeName]);
  const [expandedTickets, setExpandedTickets] = useState({});
  const [allowGuestsToViewAllTickets, setAllowGuestsToViewAllTickets] = useState(false);
  const [collectThirdPartyConsent, setCollectThirdPartyConsent] = useState(false);
  
  // Slug state
  const [slug, setSlug] = useState("");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [slugError, setSlugError] = useState(null);
  const [checkingSlug, setCheckingSlug] = useState(false);

  // Validation error dialog state
  const [showValidationDialog, setShowValidationDialog] = useState(false);
  const [validationErrors, setValidationErrors] = useState([]);
  
  const [formData, setFormData] = useState({
    title: "",
    summary: "",
    description: "",
    internal_reference: "",
    program_tag: "",
    event_type: [],
    start_date: "",
    end_date: "",
    registration_closes_at: "",
    location: "",
    image_url: "",
    available_seats: "",
    delivery_mode: "offline",
    zoom_webinar_id: null,
    zoom_meeting_id: null,
    online_url: "",
    online_meeting_url: "",
    cta_override_url: "",
    cta_override_mode: "card",
    cta_button_label: "",
    timezone: "Europe/London"
  });

  // Common timezones for the selector
  const timezoneOptions = [
    { value: "Europe/London", label: "London (GMT/BST)" },
    { value: "Europe/Dublin", label: "Dublin (GMT/IST)" },
    { value: "Europe/Paris", label: "Paris (CET/CEST)" },
    { value: "Europe/Berlin", label: "Berlin (CET/CEST)" },
    { value: "Europe/Amsterdam", label: "Amsterdam (CET/CEST)" },
    { value: "Europe/Brussels", label: "Brussels (CET/CEST)" },
    { value: "Europe/Madrid", label: "Madrid (CET/CEST)" },
    { value: "Europe/Rome", label: "Rome (CET/CEST)" },
    { value: "Europe/Zurich", label: "Zurich (CET/CEST)" },
    { value: "Europe/Stockholm", label: "Stockholm (CET/CEST)" },
    { value: "Europe/Warsaw", label: "Warsaw (CET/CEST)" },
    { value: "Europe/Athens", label: "Athens (EET/EEST)" },
    { value: "America/New_York", label: "New York (EST/EDT)" },
    { value: "America/Chicago", label: "Chicago (CST/CDT)" },
    { value: "America/Denver", label: "Denver (MST/MDT)" },
    { value: "America/Los_Angeles", label: "Los Angeles (PST/PDT)" },
    { value: "America/Toronto", label: "Toronto (EST/EDT)" },
    { value: "America/Vancouver", label: "Vancouver (PST/PDT)" },
    { value: "Asia/Dubai", label: "Dubai (GST)" },
    { value: "Asia/Singapore", label: "Singapore (SGT)" },
    { value: "Asia/Hong_Kong", label: "Hong Kong (HKT)" },
    { value: "Asia/Tokyo", label: "Tokyo (JST)" },
    { value: "Asia/Shanghai", label: "Shanghai (CST)" },
    { value: "Australia/Sydney", label: "Sydney (AEST/AEDT)" },
    { value: "Australia/Melbourne", label: "Melbourne (AEST/AEDT)" },
    { value: "Pacific/Auckland", label: "Auckland (NZST/NZDT)" },
    { value: "UTC", label: "UTC" }
  ];

  // Rich text editor modules configuration
  const quillModules = {
    toolbar: {
      container: [
        [{ 'header': [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ 'color': [] }, { 'background': [] }],
        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
        [{ 'indent': '-1'}, { 'indent': '+1' }],
        [{ 'align': [] }],
        ['link'],
        ['clean']
      ]
    },
  };

  const quillFormats = [
    'header',
    'bold', 'italic', 'underline', 'strike',
    'color', 'background',
    'list', 'bullet', 'indent',
    'align',
    'link'
  ];

  const { data: programs = [], isLoading: loadingPrograms } = useQuery({
    queryKey: ['/api/entities/Program'],
    queryFn: () => base44.entities.Program.list()
  });

  // Resolve the locked group's name for the read-only banner (group-limited mode).
  const { data: limitedGroup } = useQuery({
    queryKey: ['/api/entities/MemberGroup', groupId],
    queryFn: () => base44.entities.MemberGroup.get(groupId),
    enabled: isGroupLimited && !!groupId
  });
  const groupName = limitedGroup?.name || '';

  // Fetch roles for ticket class assignment
  const { data: roles = [], isLoading: loadingRoles } = useQuery({
    queryKey: ['/api/entities/Role'],
    queryFn: () => base44.entities.Role.list({ sort: { name: 'asc' } })
  });

  // Fetch member groups for ticket class assignment
  const { data: memberGroups = [], isLoading: loadingMemberGroups } = useQuery({
    queryKey: ['/api/entities/MemberGroup'],
    queryFn: () => base44.entities.MemberGroup.list({ filter: { is_active: true }, sort: { name: 'asc' } })
  });

  // Fetch speakers for event assignment
  const { data: speakers = [], isLoading: loadingSpeakers } = useQuery({
    queryKey: ['/api/entities/Speaker'],
    queryFn: () => base44.entities.Speaker.list({ filter: { is_active: true }, sort: { full_name: 'asc' } })
  });

  // Fetch resource categories for filter tag selection
  const { data: resourceCategories = [] } = useQuery({
    queryKey: ['/api/entities/ResourceCategory'],
    queryFn: () => base44.entities.ResourceCategory.list('display_order')
  });

  // Fetch system settings for summary max length
  // Email configuration held in local state until the event is created (Task #3263).
  const [eventEmails, setEventEmails] = useState([]);

  const { data: emailTemplates = [] } = useQuery({
    queryKey: ['email-templates', 'events'],
    queryFn: async () => {
      const allTemplates = await base44.entities.EmailTemplate.list();
      return allTemplates.filter(t => t.category === 'events' && t.is_active);
    }
  });

  const { data: systemSettings = [] } = useQuery({
    queryKey: ['/api/entities/SystemSettings'],
    queryFn: () => base44.entities.SystemSettings.list()
  });

  // Get summary max length from settings (default 150)
  const summaryMaxLength = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'event_summary_max_length');
    return setting ? parseInt(setting.setting_value) || 150 : 150;
  }, [systemSettings]);

  // Whether dietary/allergy/accessibility collection is enabled tenant-wide (defaults to true)
  const collectAttendeeOptionsEnabled = useMemo(
    () => isAttendeeOptionsCollectionEnabled(systemSettings),
    [systemSettings]
  );

  // Tenant-wide default CTA button label (Event Settings > event_cta_button)
  const tenantDefaultCtaLabel = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'event_cta_button');
    if (setting?.setting_value) {
      try {
        const config = JSON.parse(setting.setting_value);
        if (config.label) return config.label;
      } catch { /* fall through */ }
    }
    return 'Register';
  }, [systemSettings]);

  // Whether an internal reference is required to save an event (defaults to false)
  const requireInternalReference = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'require_internal_reference');
    return setting ? setting.setting_value === 'true' : false;
  }, [systemSettings]);

  // Check if global seat visibility is enabled (defaults to true)
  const globalShowSeats = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'show_event_seats');
    return !setting || setting.setting_value !== 'false';
  }, [systemSettings]);

  // Get default VAT rate from settings
  const defaultVatRate = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'event_default_vat_rate');
    if (setting?.setting_value) {
      try {
        return JSON.parse(setting.setting_value);
      } catch (e) {
        return null;
      }
    }
    return null;
  }, [systemSettings]);

  // Get available VAT rates from settings
  const availableVatRates = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'xero_vat_rates');
    if (setting?.setting_value) {
      try {
        const parsed = JSON.parse(setting.setting_value);
        return parsed.rates || [];
      } catch (e) {
        return [];
      }
    }
    return [];
  }, [systemSettings]);

  // Apply default VAT rate to ticket classes that don't have one (for initial load)
  const [vatRateApplied, setVatRateApplied] = useState(false);
  useEffect(() => {
    if (defaultVatRate && !vatRateApplied) {
      setTicketClasses(prev => prev.map(ticket => {
        // Only apply default if ticket has no VAT rate set
        if (!ticket.vat_rate_key) {
          return {
            ...ticket,
            vat_rate_key: defaultVatRate.taxType,
            vat_rate_label: defaultVatRate.name,
            vat_rate_percentage: defaultVatRate.effectiveRate
          };
        }
        return ticket;
      }));
      setVatRateApplied(true);
    }
  }, [defaultVatRate, vatRateApplied]);

  // Trim summary if it exceeds the limit when settings load or summary changes
  useEffect(() => {
    if (formData.summary && formData.summary.length > summaryMaxLength) {
      setFormData(prev => ({
        ...prev,
        summary: prev.summary.slice(0, summaryMaxLength)
      }));
    }
  }, [summaryMaxLength, formData.summary]);

  useEffect(() => {
    if (formData.title && !slugManuallyEdited) {
      const generatedSlug = formData.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      setSlug(generatedSlug);
    }
  }, [formData.title, slugManuallyEdited]);

  useEffect(() => {
    if (!slug) {
      setSlugError(null);
      return;
    }

    const checkSlugUniqueness = async () => {
      setCheckingSlug(true);
      try {
        const response = await fetch(`/api/public/check-event-slug?slug=${encodeURIComponent(slug)}`);
        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`);
        }
        const data = await response.json();
        if (!data.available) {
          setSlugError("This URL slug is already in use. Please choose a different one.");
        } else {
          setSlugError(null);
        }
      } catch (error) {
        console.error('Error checking slug uniqueness:', error);
        setSlugError("Unable to verify slug availability. Please try again.");
      } finally {
        setCheckingSlug(false);
      }
    };

    const timer = setTimeout(checkSlugUniqueness, 500);
    return () => clearTimeout(timer);
  }, [slug]);

  // Get categories that have 'Events' in their applies_to_content_types - with subcategories
  const eventCategories = useMemo(() => {
    return resourceCategories
      .filter(cat => 
        cat.is_active && 
        Array.isArray(cat.applies_to_content_types) && 
        cat.applies_to_content_types.includes('Events') &&
        Array.isArray(cat.subcategories) &&
        cat.subcategories.length > 0
      )
      .map(cat => ({
        id: cat.id,
        name: cat.name,
        subcategories: cat.subcategories || []
      }));
  }, [resourceCategories]);

  // Selected speakers state
  const [selectedSpeakers, setSelectedSpeakers] = useState([]);
  const [speakerModalOpen, setSpeakerModalOpen] = useState(false);

  // Task #3285: speaker awards (vouchers/badges granted at event start)
  const [speakerAwards, setSpeakerAwards] = useState(configToFormState(null));
  
  // Selected filter tags state
  const [selectedFilterTags, setSelectedFilterTags] = useState([]);

  // Speaker toggle function
  const toggleSpeaker = (speakerId) => {
    setSelectedSpeakers(prev => 
      prev.includes(speakerId)
        ? prev.filter(id => id !== speakerId)
        : [...prev, speakerId]
    );
  };

  // Get speaker names for display
  const getSpeakerNames = (speakerIds) => {
    if (!speakerIds || speakerIds.length === 0) return "No speakers selected";
    return speakerIds
      .map(id => speakers.find(s => s.id === id)?.full_name || 'Unknown')
      .join(', ');
  };

  // Ticket class management functions
  const addTicketClass = () => {
    const newTicket = createEmptyTicketClass(false, defaultVatRate);
    setTicketClasses([...ticketClasses, newTicket]);
    setExpandedTickets({ ...expandedTickets, [newTicket.id]: true });
  };

  const removeTicketClass = (ticketId) => {
    if (ticketClasses.length === 1) {
      toast.error('You must have at least one ticket class');
      return;
    }
    setTicketClasses(ticketClasses.filter(t => t.id !== ticketId));
  };

  const updateTicketClass = (ticketId, field, value) => {
    setTicketClasses(prev => prev.map(t => 
      t.id === ticketId ? { ...t, [field]: value } : t
    ));
  };

  const setTicketFree = (ticketId, isFree) => {
    setTicketClasses(prev => prev.map(t => 
      t.id === ticketId ? { ...t, is_free: isFree, price: isFree ? '0' : t.price } : t
    ));
  };

  const toggleRoleForTicket = (ticketId, roleId) => {
    setTicketClasses(ticketClasses.map(t => {
      if (t.id !== ticketId) return t;
      const currentRoles = t.role_ids || [];
      const newRoles = currentRoles.includes(roleId)
        ? currentRoles.filter(id => id !== roleId)
        : [...currentRoles, roleId];
      return { ...t, role_ids: newRoles };
    }));
  };

  const toggleMemberGroupForTicket = (ticketId, groupId) => {
    setTicketClasses(ticketClasses.map(t => {
      if (t.id !== ticketId) return t;
      const currentGroups = t.member_group_ids || [];
      const newGroups = currentGroups.includes(groupId)
        ? currentGroups.filter(id => id !== groupId)
        : [...currentGroups, groupId];
      return { ...t, member_group_ids: newGroups };
    }));
  };

  const toggleExpandTicket = (ticketId) => {
    setExpandedTickets(prev => ({
      ...prev,
      [ticketId]: !prev[ticketId]
    }));
  };

  const getRoleNames = (roleIds) => {
    if (!roleIds || roleIds.length === 0) return "All Roles";
    return roleIds
      .map(id => roles.find(r => r.id === id)?.name || 'Unknown')
      .join(', ');
  };

  const { data: webinars = [], isLoading: loadingWebinars } = useQuery({
    queryKey: ['/api/zoom/webinars'],
    queryFn: async () => {
      const data = await apiRequest('/api/zoom/webinars');
      return data.filter(w => w.status === 'scheduled' && new Date(w.start_time) > new Date());
    },
    enabled: isOnline && zoomType === 'webinar'
  });

  const { data: meetings = [], isLoading: loadingMeetings } = useQuery({
    queryKey: ['/api/zoom/meetings'],
    queryFn: async () => {
      const data = await apiRequest('/api/zoom/meetings');
      return data.filter(m => m.status === 'scheduled' && new Date(m.start_time) > new Date());
    },
    enabled: isOnline && zoomType === 'meeting'
  });

  // Query for webinar show join link settings
  const { data: joinLinkSettings, isLoading: loadingJoinLinkSettings } = useQuery({
    queryKey: ['webinar-join-link-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'webinar_show_join_link');
      if (setting && setting.setting_value) {
        try {
          return JSON.parse(setting.setting_value);
        } catch {
          return {};
        }
      }
      return {};
    },
    enabled: isOnline
  });

  // Get show join link status for a webinar
  const getShowJoinLink = (webinarId) => {
    if (!joinLinkSettings || !webinarId) return false;
    return joinLinkSettings[webinarId] === true;
  };

  const selectedWebinar = webinars.find(w => w.id === selectedWebinarId);
  const selectedMeeting = meetings.find(m => m.id === selectedMeetingId);

  // Get the active timezone from the selected Zoom webinar/meeting
  const activeZoomTimezone = selectedWebinar?.timezone || selectedMeeting?.timezone || null;
  
  // Check if we have an active Zoom selection (webinar or meeting)
  const hasZoomSelection = isOnline && (selectedWebinar || selectedMeeting);

  // Training events (Task #3436): overall start/end derive from the agenda.
  const trainingDerivedDates = useMemo(() => {
    if (!isTraining || agendaLines.length === 0) return null;
    const starts = agendaLines.map(agendaLineStartDateTime).filter(Boolean).sort();
    const ends = agendaLines.map(agendaLineEndDateTime).filter(Boolean).sort();
    if (starts.length === 0) return null;
    return { start: starts[0], end: ends[ends.length - 1] };
  }, [isTraining, agendaLines]);

  // Effective timezone for datetime-local inputs: Zoom timezone takes precedence
  // when a Zoom selection is locked in, otherwise the user-selected event timezone.
  const effectiveTimezone = activeZoomTimezone || formData.timezone || "Europe/London";

  useEffect(() => {
    if (selectedWebinar) {
      const startTime = new Date(selectedWebinar.start_time);
      const endTime = new Date(startTime.getTime() + (selectedWebinar.duration || 60) * 60000);
      
      setFormData(prev => ({
        ...prev,
        title: selectedWebinar.topic || prev.title,
        description: selectedWebinar.agenda || prev.description,
        start_date: startTime.toISOString(),
        end_date: endTime.toISOString(),
        zoom_webinar_id: selectedWebinar.id,
        zoom_meeting_id: null,
        online_url: selectedWebinar.join_url || "",
        delivery_mode: "online",
        location: "Online Event",
        available_seats: 0,
        timezone: selectedWebinar.timezone || "Europe/London"
      }));
    }
  }, [selectedWebinar]);

  useEffect(() => {
    if (selectedMeeting) {
      const startTime = new Date(selectedMeeting.start_time);
      const endTime = new Date(startTime.getTime() + (selectedMeeting.duration_minutes || 60) * 60000);
      
      setFormData(prev => ({
        ...prev,
        title: selectedMeeting.topic || prev.title,
        description: selectedMeeting.agenda || prev.description,
        start_date: startTime.toISOString(),
        end_date: endTime.toISOString(),
        zoom_webinar_id: null,
        zoom_meeting_id: selectedMeeting.id,
        online_url: selectedMeeting.join_url || "",
        delivery_mode: "online",
        location: "Online Event",
        timezone: selectedMeeting.timezone || "Europe/London"
      }));
    }
  }, [selectedMeeting]);

  const createEventMutation = useMutation({
    mutationFn: async (eventData) => {
      const createdEvent = await base44.entities.Event.create(eventData);

      // Training events (Task #3419): persist agenda lines now that the event
      // has an ID. If any line fails, roll the event back (compensating
      // delete) and fail the whole save — never report success for a training
      // event with a missing/partial agenda.
      if (agendaLines.length > 0) {
        try {
          // Persist in chronological order (Task #3443).
          const orderedLines = sortAgendaLinesChronologically(agendaLines);
          for (let i = 0; i < orderedLines.length; i++) {
            const line = orderedLines[i];
            await base44.entities.EventAgendaItem.create({
              event_id: createdEvent.id,
              start_date: line.start_date,
              start_time: normalizeAgendaTime(line.start_time) || null,
              end_date: line.end_date || line.start_date,
              end_time: normalizeAgendaTime(line.end_time) || null,
              description: line.description || null,
              item_type: line.item_type || null,
              location: agendaTypeBehaviour(line.item_type, agendaItemTypes) === 'location' ? (line.location || null) : null,
              zoom_webinar_id: agendaTypeBehaviour(line.item_type, agendaItemTypes) === 'zoom' ? (line.zoom_webinar_id || null) : null,
              zoom_meeting_id: agendaTypeBehaviour(line.item_type, agendaItemTypes) === 'zoom' ? (line.zoom_meeting_id || null) : null,
              lms_url: agendaTypeBehaviour(line.item_type, agendaItemTypes) === 'lms' ? (line.lms_url || null) : null,
              speaker_ids: Array.isArray(line.speaker_ids) ? line.speaker_ids.filter(Boolean) : [],
              sponsor_ids: Array.isArray(line.sponsor_ids) ? line.sponsor_ids.filter(Boolean) : [],
              sort_order: i,
            });
          }
        } catch (err) {
          console.error('Failed to save agenda lines after creation:', err);
          try {
            await base44.entities.Event.delete(createdEvent.id);
          } catch (rollbackErr) {
            console.error('Failed to roll back event after agenda failure:', rollbackErr);
          }
          const wrapped = new Error(
            'the training agenda could not be saved, so the event was not created — please try again ('
            + (err?.message || 'unknown error') + ')'
          );
          wrapped.cause = err;
          throw wrapped;
        }
      }

      // Task #3263: persist emails configured during creation, now that the
      // event has an ID. A failure here must never lose the created event —
      // report it back so onSuccess can route the admin to edit mode.
      let emailError = null;
      let schedulingWarning = null;
      if (eventEmails.length > 0) {
        try {
          const { response, result } = await putEventEmails(createdEvent.id, eventEmails);
          if (!response.ok) {
            throw new Error(result?.error || 'Failed to save email configurations');
          }
          const failures = result?.schedulingFailures || [];
          const schedulerError = result?.schedulerError || result?.error;
          if (failures.length > 0 || schedulerError) {
            schedulingWarning = formatSchedulingFailures({ schedulingFailures: failures, error: schedulerError });
          }
        } catch (err) {
          console.error('Failed to save event emails after creation:', err);
          emailError = err.message || 'Unknown error';
        }
      }

      return { createdEvent, emailError, schedulingWarning };
    },
    onSuccess: ({ createdEvent, emailError, schedulingWarning }) => {
      queryClient.invalidateQueries({ queryKey: ['events'] });
      if (emailError) {
        toast.error(
          `Event created, but email settings could not be saved: ${emailError}. Opening the event so you can fix them in the email section.`,
          { duration: 10000 }
        );
        setTimeout(() => {
          window.location.href = `${createPageUrl('EditEvent')}?id=${createdEvent.id}`;
        }, 500);
        return;
      }
      if (schedulingWarning) {
        toast.error(`Event created and emails saved, but ${schedulingWarning}`);
      }
      toast.success('Event created successfully');
      setTimeout(() => {
        window.location.href = createPageUrl('Events');
      }, 500);
    },
    onError: (error) => {
      console.error('Create event error:', error, {
        method: error?.method,
        path: error?.path,
        status: error?.status,
      });
      const errorMessage = error.message || error.error || 'Unknown error occurred';
      const reqDetail = error?.method && error?.path
        ? ` (${error.method} ${error.path}${error?.status ? ` → ${error.status}` : ''})`
        : '';
      toast.error('Failed to create event: ' + errorMessage + reqDetail);
    }
  });

  const [clashDialog, setClashDialog] = useState({ open: false, clashes: [], redacted: false, clashCount: 0 });
  const [pendingSubmit, setPendingSubmit] = useState(null);
  const [checkingClashes, setCheckingClashes] = useState(false);

  const handleClashConfirm = () => {
    setClashDialog({ open: false, clashes: [], redacted: false, clashCount: 0 });
    const fn = pendingSubmit;
    setPendingSubmit(null);
    if (fn) fn();
  };

  const handleClashCancel = () => {
    setClashDialog({ open: false, clashes: [], redacted: false, clashCount: 0 });
    setPendingSubmit(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Guard against double-submit while a clash check is already running.
    if (checkingClashes) return;

    // Collect all validation errors
    const errors = [];
    
    // Basic field validation
    if (!formData.title) {
      errors.push('Please enter an event title');
    }
    
    // Internal reference required when the tenant setting is enabled
    // (skipped in group-limited mode — the field is hidden there)
    if (requireInternalReference && !isGroupLimited && !formData.internal_reference?.trim()) {
      errors.push('Please enter an internal reference');
    }

    // Emails configured during creation are saved right after the event is
    // created — validate their CC addresses up front (Task #3263).
    if (eventEmails.length > 0) {
      const invalidCc = findInvalidCcAddresses(eventEmails);
      if (invalidCc.length > 0) {
        errors.push(`Invalid CC email address in email settings: ${invalidCc.join(', ')}`);
      }
    }
    
    // Summary length validation
    if (formData.summary && formData.summary.length > summaryMaxLength) {
      errors.push(`Summary exceeds the maximum length of ${summaryMaxLength} characters`);
    }
    
    if (isProgramEvent && !formData.program_tag) {
      errors.push('Please select a program for this event');
    }
    
    // Only require start_date for non-TBC, non-immediate events. Training events derive their
    // start/end dates from the agenda lines instead (Task #3419).
    if (eventTiming !== 'tbc' && !isImmediate && !formData.start_date && !isTraining) {
      errors.push('Please set a start date and time');
    }

    // Training events: validate the agenda lines (at least one line, dates,
    // and the type-conditional location / webinar-meeting / LMS fields).
    // Non-training events may have an optional agenda (Task #3512) — validate
    // only when lines were added.
    if (isTraining || agendaLines.length > 0) {
      errors.push(...validateAgendaLines(agendaLines, agendaItemTypes));
    }
    
    // Group-limited online events use a manual meeting link instead of Zoom.
    // Immediate events never require Zoom (no schedule).
    if (isGroupLimited) {
      if (isOnline && !formData.online_meeting_url?.trim()) {
        errors.push('Please enter a meeting link for this online event');
      }
    } else if (!isImmediate) {
      // Only require Zoom webinar/meeting for non-TBC, non-immediate online events.
      // Training events manage Zoom per agenda item (Task #3436), never event-level.
      if (eventTiming !== 'tbc' && isOnline && !isTraining) {
        const hasZoomSelection = (zoomType === 'webinar' && selectedWebinarId) || (zoomType === 'meeting' && selectedMeetingId);
        if (!hasZoomSelection) {
          errors.push(`Please select a Zoom ${zoomType} for online events`);
        }
      }

      if (eventTiming !== 'tbc' && isOnline && !isTraining && loadingJoinLinkSettings) {
        errors.push('Please wait for settings to finish loading');
      }
    }

    // Validation for one-off event ticket classes
    if (!isProgramEvent) {
      if (ticketClasses.length === 0) {
        errors.push('Please add at least one ticket class');
      } else {
        for (let i = 0; i < ticketClasses.length; i++) {
          const ticket = ticketClasses[i];
          const ticketLabel = ticket.name || `Ticket ${i + 1}`;

          // Name is required
          if (!ticket.name || ticket.name.trim() === "") {
            errors.push(`Please enter a name for ${ticketLabel}`);
          }

          // Price validation: either is_free must be true, or price must be > 0
          // (skipped in group-limited mode — tickets are forced free on save)
          if (!isGroupLimited && !ticket.is_free) {
            if (ticket.price === "" || ticket.price === null || ticket.price === undefined) {
              errors.push(`Ticket "${ticket.name || ticketLabel}": Enter a price or toggle "Free Ticket" on`);
            } else {
              const price = parseFloat(ticket.price);
              if (isNaN(price) || price <= 0) {
                errors.push(`Ticket "${ticket.name}": Price must be greater than zero, or mark as free`);
              }
            }
          }

          // Validate BOGO offer
          if (ticket.offer_type === "bogo") {
            if (!ticket.bogo_buy_quantity || !ticket.bogo_get_free_quantity) {
              errors.push(`Ticket "${ticket.name}": Please enter BOGO quantities`);
            } else {
              const buyQty = parseInt(ticket.bogo_buy_quantity);
              const freeQty = parseInt(ticket.bogo_get_free_quantity);
              if (isNaN(buyQty) || buyQty < 1 || isNaN(freeQty) || freeQty < 1) {
                errors.push(`Ticket "${ticket.name}": BOGO quantities must be positive numbers`);
              }
            }
          }

          // Validate bulk discount offer
          if (ticket.offer_type === "bulk_discount") {
            if (!ticket.bulk_discount_threshold || !ticket.bulk_discount_percentage) {
              errors.push(`Ticket "${ticket.name}": Please enter bulk discount settings`);
            } else {
              const threshold = parseInt(ticket.bulk_discount_threshold);
              const percentage = parseFloat(ticket.bulk_discount_percentage);
              if (isNaN(threshold) || threshold < 2) {
                errors.push(`Ticket "${ticket.name}": Bulk threshold must be at least 2`);
              }
              if (isNaN(percentage) || percentage < 0 || percentage > 100) {
                errors.push(`Ticket "${ticket.name}": Discount percentage must be between 0 and 100`);
              }
            }
          }

          if (ticket.is_group_ticket) {
            const groupSize = parseInt(ticket.group_size);
            if (!ticket.group_size || isNaN(groupSize) || groupSize < 2) {
              errors.push(`Ticket "${ticket.name}": Group size must be at least 2`);
            }
          }
        }
      }
    }
    
    // Validate seats when unlimited is off
    if (!unlimitedSeats) {
      const seats = parseInt(formData.available_seats);
      if (!formData.available_seats || isNaN(seats) || seats < 1) {
        errors.push('Please enter a valid number of seats (or enable "Unlimited")');
      }
    }

    // Validate registration_closes_at is not after end_date
    if (formData.registration_closes_at && formData.end_date) {
      if (new Date(formData.registration_closes_at) > new Date(formData.end_date)) {
        errors.push('Registration close date cannot be after the event end date');
      }
    }
    
    // If there are validation errors, show the dialog
    if (errors.length > 0) {
      setValidationErrors(errors);
      setShowValidationDialog(true);
      return;
    }

    if (slugError || checkingSlug) {
      setValidationErrors([slugError || 'Please wait while the URL slug is being verified']);
      setShowValidationDialog(true);
      return;
    }

    // Build event data - only include fields that exist in the event table
    // For online events: location should be null (is_online field indicates it's online)
    // Training events also carry no event-level location (per agenda item instead).
    let locationValue = (isOnline || isTraining) ? null : (formData.location || null);

    // Training events: the overall start/end span the agenda using the real
    // agenda datetimes (earliest start, latest end — Task #3443).
    let trainingStart = null;
    let trainingEnd = null;
    if (isTraining && agendaLines.length > 0) {
      const starts = agendaLines.map(agendaLineStartDateTime).filter(Boolean).sort();
      const ends = agendaLines.map(agendaLineEndDateTime).filter(Boolean).sort();
      if (starts.length > 0) {
        trainingStart = starts[0];
        trainingEnd = ends[ends.length - 1];
      }
    }

    // Normalise status: never emit immediate from group-limited or when training
    const resolvedStatus = normalizeSimpleEventTiming(eventTiming, {
      isTraining,
      isComplex: false,
      isGroupLimited,
    });
    const isImmediateSave = resolvedStatus === SIMPLE_EVENT_TIMING.IMMEDIATE;
    const suppressSchedule =
      resolvedStatus === SIMPLE_EVENT_TIMING.TBC || isImmediateSave;
    
    const eventData = {
      title: formData.title,
      slug: slug || null,
      summary: formData.summary || null,
      description: formData.description || null,
      internal_reference: formData.internal_reference || null,
      event_type: serializeEventTypes(formData.event_type),
      // Visibility is determined by program_tag: empty = one-off event, non-empty = program event
      program_tag: isProgramEvent ? formData.program_tag : "",
      // For TBC/immediate events, dates must be null
      start_date: suppressSchedule ? null : (isTraining && trainingStart ? trainingStart : (formData.start_date || null)),
      end_date: suppressSchedule ? null : (isTraining && trainingEnd ? trainingEnd : (formData.end_date || formData.start_date || null)),
      registration_closes_at: suppressSchedule ? null : (formData.registration_closes_at || null),
      timezone: isImmediateSave ? null : (formData.timezone || null),
      location: locationValue,
      image_url: formData.image_url || null,
      available_seats: unlimitedSeats ? null : (formData.available_seats ? parseInt(formData.available_seats) : null),
      is_unlimited_registration: unlimitedSeats,
      // Per-event seat visibility (only meaningful when global setting is ON)
      show_seat_count: showSeatCount,
      // Per-event ticket availability display toggle
      show_ticket_availability: showTicketAvailability,
      // Per-event entrance QR on confirmation emails (only meaningful for in-person events)
      qr_on_confirmation: isOnline ? false : qrOnConfirmation,
      // Immediate events clear all Zoom ids. TBC events optionally keep them.
      // Group-limited and training events never use Zoom — they use a manual meeting link.
      zoom_webinar_id: isImmediateSave ? null : ((isGroupLimited || isTraining) ? null : (isOnline && zoomType === 'webinar' && selectedWebinarId ? selectedWebinarId : null)),
      zoom_meeting_id: isImmediateSave ? null : ((isGroupLimited || isTraining) ? null : (isOnline && zoomType === 'meeting' && selectedMeetingId ? selectedMeetingId : null)),
      speaker_ids: selectedSpeakers.length > 0 ? selectedSpeakers : [],
      speaker_award_config: formStateToConfig(speakerAwards),
      // Convert composite keys back to plain labels for database storage
      filter_tags: selectedFilterTags.length > 0 
        ? selectedFilterTags.map(key => parseFilterTagKey(key).label) 
        : [],
      cta_override_url: formData.cta_override_url || null,
      cta_override_mode: formData.cta_override_mode || 'card',
      cta_button_label: (formData.cta_button_label || '').trim() || null,
      // Immediate events are online-capable but have no schedule
      is_online: isOnline,
      is_complex: false,
      is_training: isTraining,
      status: resolvedStatus,
      // TBC-only booking-element replacement (persisted regardless of timing;
      // it only applies on the public page when status === 'tbc')
      replace_booking_elements: replaceBookingElements === true,
      booking_replacement_message: bookingReplacementMessage.trim() || null,
      booking_replacement_cta_label: bookingReplacementCtaLabel.trim() || null,
      booking_replacement_title: bookingReplacementTitle.trim() || null,
      event_state: eventState,
      is_featured: isFeatured,
      attached_documents: attachedDocuments,
      documents_section_title: documentsSectionTitle.trim() || null,
      dietary_options: dietaryOptions.map((o) => (o || "").trim()).filter(Boolean),
      allergy_options: allergyOptions.map((o) => (o || "").trim()).filter(Boolean),
      accessibility_options: accessibilityOptions.map((o) => (o || "").trim()).filter(Boolean)
    };

    // Group-limited mode: lock the event to its group, carry the audience choice,
    // and store the manual meeting link (no Zoom). Mirrors groupAdminEventWrite.js.
    if (isGroupLimited) {
      eventData.member_group_id = groupId;
      eventData.group_event_public = groupEventPublic === true;
      eventData.online_meeting_url = isOnline ? (formData.online_meeting_url?.trim() || null) : null;
      eventData.online_url = null;
    }

    // Add ticket classes for one-off events as JSON in pricing_config field
    if (!isProgramEvent) {
      const formattedTicketClasses = ticketClasses.map(ticket => {
        const ticketData = {
          id: ticket.id,
          name: ticket.name,
          // Group-limited events allow free tickets only.
          price: isGroupLimited ? 0 : parseFloat(ticket.price),
          is_free: isGroupLimited ? true : (ticket.is_free || false),
          role_ids: isGroupLimited ? [] : (ticket.role_ids || []),
          member_group_ids: isGroupLimited ? [] : (ticket.member_group_ids || []),
          is_default: ticket.is_default || false,
          // Group events: ticket visibility follows the event audience choice, so
          // the single free ticket is shown to anyone who can see the event.
          visibility_mode: isGroupLimited ? 'members_and_public' : (ticket.visibility_mode || 'members_only'),
          role_match_only: isGroupLimited ? false : (ticket.role_match_only || false),
          offer_type: isGroupLimited ? 'none' : ticket.offer_type,
          // Ticket availability: null = unlimited, number = limited
          available_count: ticket.is_unlimited_tickets ? null : (ticket.available_count ? parseInt(ticket.available_count) : null),
          is_unlimited_tickets: ticket.is_unlimited_tickets !== false,
          // VAT rate fields for Xero invoice generation (free tickets carry none)
          vat_rate_key: isGroupLimited ? null : (ticket.vat_rate_key || null),
          vat_rate_label: isGroupLimited ? null : (ticket.vat_rate_label || null),
          vat_rate_percentage: isGroupLimited ? null : (ticket.vat_rate_percentage || null),
          is_group_ticket: isGroupLimited ? false : (ticket.is_group_ticket || false),
          group_size: !isGroupLimited && ticket.is_group_ticket && ticket.group_size ? parseInt(ticket.group_size) : null,
          group_cutoff_date: !isGroupLimited && ticket.is_group_ticket && ticket.group_cutoff_date ? ticket.group_cutoff_date : null
        };

        if (!isGroupLimited && ticket.offer_type === "bogo") {
          ticketData.bogo_buy_quantity = parseInt(ticket.bogo_buy_quantity);
          ticketData.bogo_get_free_quantity = parseInt(ticket.bogo_get_free_quantity);
          ticketData.bogo_logic_type = ticket.bogo_logic_type;
        } else if (!isGroupLimited && ticket.offer_type === "bulk_discount") {
          ticketData.bulk_discount_threshold = parseInt(ticket.bulk_discount_threshold);
          ticketData.bulk_discount_percentage = parseFloat(ticket.bulk_discount_percentage);
        }

        return ticketData;
      });

      // For backward compatibility, also set ticket_price to the first/default ticket price
      const defaultTicket = formattedTicketClasses.find(t => t.is_default) || formattedTicketClasses[0];
      
      eventData.pricing_config = {
        ticket_price: defaultTicket.price,
        offer_type: defaultTicket.offer_type,
        ticket_classes: formattedTicketClasses,
        allowGuestsToViewAllTickets: allowGuestsToViewAllTickets,
        collectThirdPartyConsent: collectThirdPartyConsent
      };
    }


    console.log('[CreateEvent] All validation passed, calling mutation with eventData:', JSON.stringify(eventData, null, 2));

    const submitCreate = () => createEventMutation.mutate(eventData);

    // Advisory time-clash check (never blocks saving). Skip for TBC / no dates.
    // Training events contribute one whole-day window per clash-included
    // agenda line instead of the event-level span (Task #3419).
    const clashWindows = buildClashWindows({
      isTraining,
      agendaLines,
      agendaItemTypes,
      eventData,
      timezone: formData.timezone || 'Europe/London',
      title: formData.title || null,
    });
    if (clashWindows.length > 0) {
      setCheckingClashes(true);
      try {
        const { hasClashes, clashes, redacted, clashCount } = await checkEventClashes({
          windows: clashWindows,
        });
        if (hasClashes) {
          setPendingSubmit(() => submitCreate);
          setClashDialog({ open: true, clashes, redacted: !!redacted, clashCount: clashCount ?? 0 });
          setCheckingClashes(false);
          return;
        }
      } catch (err) {
        // Never block saving on a clash-check failure.
      }
      setCheckingClashes(false);
    }

    submitCreate();
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleDeliveryModeChange = (online) => {
    setIsOnline(online);
    if (!online) {
      setSelectedWebinarId("");
      setSelectedMeetingId("");
      setZoomType("webinar");
      setFormData(prev => ({
        ...prev,
        delivery_mode: "offline",
        zoom_webinar_id: null,
        zoom_meeting_id: null,
        online_url: "",
        available_seats: prev.available_seats || ""
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        delivery_mode: "online",
        available_seats: 0
      }));
    }
  };

  const formatWebinarDateTime = (webinar) => {
    if (!webinar.start_time) return '';
    const date = new Date(webinar.start_time);
    return formatEventDateTime(date, systemSettings, webinar.timezone);
  };

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Button 
            variant="ghost" 
            size="icon"
            onClick={() => window.location.href = backUrl}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Create Event</h1>
            <p className="text-slate-600">Set up a new event for your members</p>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Group Event banner + audience choice (group-limited mode only) */}
          {isGroupLimited && (
            <Card className="border-slate-200 shadow-sm mb-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Users className="h-5 w-5 text-blue-600" />
                  Group Event
                </CardTitle>
                <CardDescription>This event belongs to your group</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-900" data-testid="text-group-locked">
                    This event is for <span className="font-semibold">{groupName || 'your group'}</span>.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="text-base font-medium">Who can see this event?</Label>
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      type="button"
                      variant={!groupEventPublic ? 'default' : 'outline'}
                      onClick={() => setGroupEventPublic(false)}
                      data-testid="button-audience-group"
                    >
                      <Users className="h-4 w-4 mr-2" />
                      Group members only
                    </Button>
                    <Button
                      type="button"
                      variant={groupEventPublic ? 'default' : 'outline'}
                      onClick={() => setGroupEventPublic(true)}
                      data-testid="button-audience-public"
                    >
                      <Globe className="h-4 w-4 mr-2" />
                      Public
                    </Button>
                  </div>
                  <p className="text-xs text-slate-500">
                    {groupEventPublic
                      ? 'Anyone can view and register for this event.'
                      : 'Only members of your group can view and register for this event.'}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Event Status Selector */}
          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <Eye className="h-5 w-5 text-purple-600" />
                Event Status
              </CardTitle>
              <CardDescription>Configure when and how members can access this event</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {!isGroupLimited && (
              <div className="flex items-center justify-between p-3 rounded-lg border-2 border-slate-200">
                <div>
                  <Label className="font-medium">Featured Event</Label>
                  <p className="text-xs text-slate-500">Highlight this event at the top of event listings</p>
                </div>
                <Switch
                  checked={isFeatured}
                  onCheckedChange={setIsFeatured}
                  data-testid="switch-is-featured"
                />
              </div>
              )}

              {/* Event Timing - affects date requirements */}
              {!isGroupLimited && (
              <div>
                <Label className="text-sm font-medium mb-3 block">Event Timing</Label>
                <p className="text-xs text-slate-500 mb-3">Determines whether dates are required for this event</p>
                <RadioGroup
                  value={eventTiming}
                  onValueChange={handleTimingChange}
                  className={`grid gap-4 ${canUseImmediate ? 'grid-cols-3' : 'grid-cols-2'}`}
                  data-testid="radio-event-timing"
                >
                  <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${eventTiming === 'published' ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:border-slate-300'}`}>
                    <RadioGroupItem value="published" id="timing-published" data-testid="radio-timing-published" />
                    <Label htmlFor="timing-published" className="cursor-pointer flex-1">
                      <span className="font-medium">Scheduled</span>
                      <p className="text-xs text-slate-500">Event has confirmed dates</p>
                    </Label>
                  </div>
                  <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${eventTiming === 'tbc' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                    <RadioGroupItem value="tbc" id="timing-tbc" data-testid="radio-timing-tbc" />
                    <Label htmlFor="timing-tbc" className="cursor-pointer flex-1">
                      <span className="font-medium">To Be Confirmed</span>
                      <p className="text-xs text-slate-500">Dates not yet set</p>
                    </Label>
                  </div>
                  {/* Task #3691: Immediate Access — only for standard non-training non-group events */}
                  {canUseImmediate && (
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${isImmediate ? 'border-purple-500 bg-purple-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value={SIMPLE_EVENT_TIMING.IMMEDIATE} id="timing-immediate" data-testid="radio-timing-immediate" />
                      <Label htmlFor="timing-immediate" className="cursor-pointer flex-1">
                        <span className="font-medium">Immediate access</span>
                        <p className="text-xs text-slate-500">No schedule — available right now</p>
                      </Label>
                    </div>
                  )}
                </RadioGroup>
                {eventTiming === 'tbc' && (
                  <p className="mt-3 text-sm text-blue-600 bg-blue-50 p-2 rounded">
                    Dates will be shown as "To be confirmed" and Zoom webinar/meeting selection is optional.
                  </p>
                )}
                {/* Task #3691: Immediate access info banner */}
                {isImmediate && (
                  <p className="mt-3 text-sm text-purple-700 bg-purple-50 p-2 rounded" data-testid="immediate-info-banner">
                    This event is immediately accessible — no dates, timezone, or Zoom selection are needed.
                  </p>
                )}
                {eventTiming === 'tbc' && (
                  <div className="mt-3 p-4 border border-slate-200 rounded-lg space-y-3">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <Label htmlFor="replace-booking-elements" className="font-medium">Replace standard booking elements</Label>
                        <p className="text-xs text-slate-500 mt-0.5">Show a custom message and button instead of ticket price and booking summary on the event page</p>
                      </div>
                      <Switch
                        id="replace-booking-elements"
                        checked={replaceBookingElements}
                        onCheckedChange={setReplaceBookingElements}
                        data-testid="switch-replace-booking-elements"
                      />
                    </div>
                    {replaceBookingElements && (
                      <>
                        <div>
                          <Label htmlFor="booking-replacement-message">Helper message</Label>
                          <Textarea
                            id="booking-replacement-message"
                            value={bookingReplacementMessage}
                            onChange={(e) => setBookingReplacementMessage(e.target.value)}
                            rows={3}
                            placeholder="e.g. Register your interest and we'll confirm the details soon."
                            data-testid="input-booking-replacement-message"
                          />
                        </div>
                        <div>
                          <Label htmlFor="booking-replacement-cta-label">CTA button label</Label>
                          <Input
                            id="booking-replacement-cta-label"
                            value={bookingReplacementCtaLabel}
                            onChange={(e) => setBookingReplacementCtaLabel(e.target.value)}
                            placeholder="Confirm Booking"
                            data-testid="input-booking-replacement-cta-label"
                          />
                        </div>
                        <div>
                          <Label htmlFor="booking-replacement-title">Booking summary title</Label>
                          <Input
                            id="booking-replacement-title"
                            value={bookingReplacementTitle}
                            onChange={(e) => setBookingReplacementTitle(e.target.value)}
                            placeholder="Booking Summary"
                            data-testid="input-booking-replacement-title"
                          />
                          <p className="text-xs text-slate-500 mt-1">Optional — replaces the "Booking Summary" heading on the booking card</p>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
              )}

              {/* Event State - affects visibility and registration */}
              <div>
                <Label className="text-sm font-medium mb-3 block">Event State</Label>
                <p className="text-xs text-slate-500 mb-3">Controls visibility and whether members can register</p>
                <RadioGroup
                  value={eventState}
                  onValueChange={setEventState}
                  className="grid grid-cols-3 gap-4"
                  data-testid="radio-event-state"
                >
                  <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${eventState === 'active' ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:border-slate-300'}`}>
                    <RadioGroupItem value="active" id="state-active" data-testid="radio-state-active" />
                    <Label htmlFor="state-active" className="cursor-pointer flex-1">
                      <span className="font-medium">Active</span>
                      <p className="text-xs text-slate-500">Visible, accepting registrations</p>
                    </Label>
                  </div>
                  <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${eventState === 'draft' ? 'border-warning/50 bg-warning/10' : 'border-slate-200 hover:border-slate-300'}`}>
                    <RadioGroupItem value="draft" id="state-draft" data-testid="radio-state-draft" />
                    <Label htmlFor="state-draft" className="cursor-pointer flex-1">
                      <span className="font-medium">Draft</span>
                      <p className="text-xs text-slate-500">Hidden from members</p>
                    </Label>
                  </div>
                  <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${eventState === 'closed' ? 'border-red-500 bg-red-50' : 'border-slate-200 hover:border-slate-300'}`}>
                    <RadioGroupItem value="closed" id="state-closed" data-testid="radio-state-closed" />
                    <Label htmlFor="state-closed" className="cursor-pointer flex-1">
                      <span className="font-medium">Closed</span>
                      <p className="text-xs text-slate-500">Visible, registration closed</p>
                    </Label>
                  </div>
                </RadioGroup>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <Tag className="h-5 w-5 text-blue-600" />
                Event Type
              </CardTitle>
              <CardDescription>Choose whether this is an online or in-person event</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                <div className="flex items-center gap-3">
                  {isOnline ? (
                    <Video className="h-5 w-5 text-green-600" />
                  ) : (
                    <Building className="h-5 w-5 text-blue-600" />
                  )}
                  <div>
                    <p className="font-medium text-slate-900">
                      {isOnline ? 'Online Event' : 'In-Person Event'}
                    </p>
                    <p className="text-sm text-slate-600">
                      {isOnline 
                        ? (isGroupLimited ? 'Event will be hosted via your own meeting link' : 'Event will be hosted via Zoom')
                        : 'Event will be held at a physical location'
                      }
                    </p>
                  </div>
                </div>
                <Switch
                  checked={isOnline}
                  onCheckedChange={handleDeliveryModeChange}
                  data-testid="switch-delivery-mode"
                />
              </div>

              {!isOnline && !isGroupLimited && (
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <QrCode className="h-5 w-5 text-blue-600" />
                    <div>
                      <p className="font-medium text-slate-900">Entrance QR code</p>
                      <p className="text-sm text-slate-600">
                        Attach a check-in QR code to booking confirmation emails
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={qrOnConfirmation}
                    onCheckedChange={setQrOnConfirmation}
                    data-testid="switch-qr-on-confirmation"
                  />
                </div>
              )}

              {isOnline && isGroupLimited && (
                <div className="space-y-2">
                  <Label htmlFor="online_meeting_url">Meeting link</Label>
                  <Input
                    id="online_meeting_url"
                    type="url"
                    placeholder="https://meet.example.com/your-meeting"
                    value={formData.online_meeting_url}
                    onChange={(e) => handleInputChange('online_meeting_url', e.target.value)}
                    data-testid="input-online-meeting-url"
                  />
                  <p className="text-xs text-slate-500">
                    Paste the link attendees will use to join (Zoom, Google Meet, Teams, etc.). Set the start and end times above.
                  </p>
                </div>
              )}

              {/* Training events set Zoom per agenda item (Task #3436), so no event-level Zoom selection.
                  Immediate events (Task #3691) also skip Zoom — they have no schedule. */}
              {isOnline && !isGroupLimited && !isTraining && !isImmediate && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Zoom Event Type</Label>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant={zoomType === 'webinar' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => {
                          setZoomType('webinar');
                          setSelectedMeetingId('');
                        }}
                        data-testid="button-zoom-type-webinar"
                      >
                        <Users className="h-4 w-4 mr-2" />
                        Webinar
                      </Button>
                      <Button
                        type="button"
                        variant={zoomType === 'meeting' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => {
                          setZoomType('meeting');
                          setSelectedWebinarId('');
                        }}
                        data-testid="button-zoom-type-meeting"
                      >
                        <Video className="h-4 w-4 mr-2" />
                        Meeting
                      </Button>
                    </div>
                    <p className="text-xs text-slate-500">
                      {zoomType === 'webinar' 
                        ? 'Webinars are for large audiences with panel and registration features'
                        : 'Meetings are for interactive sessions with all participants able to share video/audio'
                      }
                    </p>
                  </div>

                  {zoomType === 'webinar' && (
                    <>
                      <div className="space-y-2">
                        <Label>Select Zoom Webinar</Label>
                        <Select
                          value={selectedWebinarId}
                          onValueChange={setSelectedWebinarId}
                          disabled={loadingWebinars}
                          data-testid="select-webinar"
                        >
                          <SelectTrigger data-testid="select-webinar-trigger">
                            <SelectValue placeholder={loadingWebinars ? "Loading webinars..." : "Choose a scheduled webinar"} />
                          </SelectTrigger>
                          <SelectContent>
                            {webinars.length === 0 && !loadingWebinars && (
                              <div className="p-4 text-center text-sm text-slate-500">
                                No upcoming webinars available.
                                <Button 
                                  variant="link" 
                                  className="p-0 h-auto ml-1"
                                  onClick={() => window.location.href = createPageUrl('ZoomWebinarProvisioning')}
                                >
                                  Create one first
                                </Button>
                              </div>
                            )}
                            {webinars.map((webinar) => (
                              <SelectItem key={webinar.id} value={webinar.id} data-testid={`select-webinar-${webinar.id}`}>
                                <div className="flex flex-col">
                                  <span className="font-medium">{webinar.topic}</span>
                                  <span className="text-xs text-slate-500">{formatWebinarDateTime(webinar)}</span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {selectedWebinar && (
                        <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                          <div className="flex items-center gap-2 mb-2">
                            <Users className="h-4 w-4 text-green-600" />
                            <span className="font-medium text-green-900">Webinar Selected</span>
                          </div>
                          <div className="space-y-1 text-sm text-green-800">
                            <p><strong>Topic:</strong> {selectedWebinar.topic}</p>
                            <p><strong>Date:</strong> {formatWebinarDateTime(selectedWebinar)}</p>
                            <p><strong>Duration:</strong> {selectedWebinar.duration_minutes || selectedWebinar.duration} minutes</p>
                            {selectedWebinar.timezone && (
                              <p><strong>Timezone:</strong> {selectedWebinar.timezone}</p>
                            )}
                            <div className="mt-2 pt-2 border-t border-green-300">
                              <p className="flex items-center gap-2">
                                <strong>Join Link:</strong>
                                {loadingJoinLinkSettings ? (
                                  <span className="text-slate-500">Loading settings...</span>
                                ) : getShowJoinLink(selectedWebinarId) ? (
                                  <span className="text-green-700">Will be visible on event page</span>
                                ) : (
                                  <span className="text-warning">Hidden - members must register via ticket purchase</span>
                                )}
                              </p>
                              <p className="text-xs text-green-600 mt-1">
                                Change this setting in Zoom Webinar Provisioning
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {zoomType === 'meeting' && (
                    <>
                      <div className="space-y-2">
                        <Label>Select Zoom Meeting</Label>
                        <Select
                          value={selectedMeetingId}
                          onValueChange={setSelectedMeetingId}
                          disabled={loadingMeetings}
                          data-testid="select-meeting"
                        >
                          <SelectTrigger data-testid="select-meeting-trigger">
                            <SelectValue placeholder={loadingMeetings ? "Loading meetings..." : "Choose a scheduled meeting"} />
                          </SelectTrigger>
                          <SelectContent>
                            {meetings.length === 0 && !loadingMeetings && (
                              <div className="p-4 text-center text-sm text-slate-500">
                                No upcoming meetings available.
                                <Button 
                                  variant="link" 
                                  className="p-0 h-auto ml-1"
                                  onClick={() => window.location.href = createPageUrl('ZoomWebinarProvisioning')}
                                >
                                  Create one first
                                </Button>
                              </div>
                            )}
                            {meetings.map((meeting) => (
                              <SelectItem key={meeting.id} value={meeting.id} data-testid={`select-meeting-${meeting.id}`}>
                                <div className="flex flex-col">
                                  <span className="font-medium">{meeting.topic}</span>
                                  <span className="text-xs text-slate-500">{formatWebinarDateTime(meeting)}</span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {selectedMeeting && (
                        <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                          <div className="flex items-center gap-2 mb-2">
                            <Video className="h-4 w-4 text-blue-600" />
                            <span className="font-medium text-blue-900">Meeting Selected</span>
                          </div>
                          <div className="space-y-1 text-sm text-blue-800">
                            <p><strong>Topic:</strong> {selectedMeeting.topic}</p>
                            <p><strong>Date:</strong> {formatWebinarDateTime(selectedMeeting)}</p>
                            <p><strong>Duration:</strong> {selectedMeeting.duration_minutes} minutes</p>
                            {selectedMeeting.timezone && (
                              <p><strong>Timezone:</strong> {selectedMeeting.timezone}</p>
                            )}
                            <div className="mt-2 pt-2 border-t border-blue-300">
                              <p className="text-blue-700">
                                Join link will be visible on event page
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Training event toggle + agenda for all regular events (Tasks #3419, #3512) */}
          {!isGroupLimited && (
            <Card className="border-slate-200 shadow-sm mb-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-blue-600" />
                  Training Event & Agenda
                </CardTitle>
                <CardDescription>
                  Training events run over multiple days. Add one agenda line per day (or date range) — the event's overall dates are taken from the agenda.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label htmlFor="is-training" className="text-base font-medium">This is a Training event</Label>
                  <Switch
                    id="is-training"
                    checked={isTraining}
                    onCheckedChange={(val) => {
                      setIsTraining(val);
                      // Task #3691: training and immediate timing are incompatible — normalise back to published
                      if (val && isImmediate) {
                        setEventTiming(SIMPLE_EVENT_TIMING.SCHEDULED);
                      }
                    }}
                    data-testid="switch-is-training"
                  />
                </div>
                {!isTraining && (
                  <p className="text-sm text-slate-500">
                    You can also add an optional agenda to any event — it renders in confirmation and reminder emails via the {'{{agenda_schedule}}'} placeholder.
                  </p>
                )}
                <TrainingAgendaEditor
                  lines={agendaLines}
                  onChange={setAgendaLines}
                  agendaItemTypes={agendaItemTypes}
                  speakers={speakers}
                />
              </CardContent>
            </Card>
          )}

          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <Calendar className="h-5 w-5 text-blue-600" />
                Event Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Program vs One-off Toggle (hidden for group-limited events — group events are always one-off free events) */}
              {!isGroupLimited && (
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                <div className="space-y-0.5">
                  <Label htmlFor="program-toggle" className="text-base font-medium">
                    {isProgramEvent ? "Program Event" : "One-off Event"}
                  </Label>
                  <p className="text-sm text-slate-500">
                    {isProgramEvent 
                      ? "Event is part of a program - requires program tickets to attend" 
                      : "Standalone event - not linked to any program"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-sm ${!isProgramEvent ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>
                    One-off
                  </span>
                  <Switch
                    id="program-toggle"
                    checked={isProgramEvent}
                    onCheckedChange={(checked) => {
                      setIsProgramEvent(checked);
                      if (!checked) {
                        handleInputChange('program_tag', '');
                      }
                    }}
                    data-testid="switch-program-toggle"
                  />
                  <span className={`text-sm ${isProgramEvent ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>
                    Program
                  </span>
                </div>
              </div>
              )}

              {/* Program Selection - Only shown when isProgramEvent is true */}
              {!isGroupLimited && isProgramEvent && (
                <div className="space-y-2">
                  <Label htmlFor="program">Program *</Label>
                  <Select
                    value={formData.program_tag}
                    onValueChange={(value) => handleInputChange('program_tag', value)}
                    disabled={loadingPrograms}
                    data-testid="select-program"
                  >
                    <SelectTrigger data-testid="select-program-trigger">
                      <SelectValue placeholder={loadingPrograms ? "Loading programs..." : "Select a program"} />
                    </SelectTrigger>
                    <SelectContent>
                      {programs.map((program) => (
                        <SelectItem 
                          key={program.id} 
                          value={program.program_tag || program.name}
                          data-testid={`select-program-${program.id}`}
                        >
                          {program.name || program.program_tag}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">
                    The program determines ticket types that can be used for this event
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="title">Event Title *</Label>
                <Input
                  id="title"
                  value={formData.title}
                  onChange={(e) => handleInputChange('title', e.target.value)}
                  placeholder="Enter event title"
                  required
                  data-testid="input-title"
                />
                {isOnline && selectedWebinar && (
                  <p className="text-xs text-slate-500">Pre-filled from Zoom webinar (editable)</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="slug">URL Slug</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-500 whitespace-nowrap">/events/</span>
                  <Input
                    id="slug"
                    value={slug}
                    onChange={(e) => {
                      const value = e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, '');
                      setSlug(value);
                      setSlugManuallyEdited(true);
                    }}
                    placeholder="my-event-name"
                    data-testid="input-slug"
                  />
                  {checkingSlug && (
                    <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                  )}
                  {!checkingSlug && slug && !slugError && (
                    <Check className="h-4 w-4 text-green-500" />
                  )}
                </div>
                {slugError && (
                  <p className="text-xs text-red-600 flex items-center gap-1" data-testid="text-slug-error">
                    <AlertCircle className="h-3 w-3" />
                    {slugError}
                  </p>
                )}
                <p className="text-xs text-slate-500">
                  Friendly URL for sharing. Auto-generated from title, or enter your own.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="summary">Summary</Label>
                <Textarea
                  id="summary"
                  value={formData.summary}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value.length <= summaryMaxLength) {
                      handleInputChange('summary', value);
                    }
                  }}
                  placeholder={`Brief summary for event cards (max ${summaryMaxLength} characters)`}
                  className="resize-none"
                  rows={2}
                  data-testid="input-summary"
                />
                <div className="flex justify-between text-xs text-slate-500">
                  <span>Displayed on event cards and listings</span>
                  <span className={formData.summary.length >= summaryMaxLength - 10 ? 'text-warning' : ''}>
                    {formData.summary.length}/{summaryMaxLength}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Full Description</Label>
                <div className="border rounded-md overflow-hidden" data-testid="input-description">
                  <ReactQuill
                    theme="snow"
                    value={formData.description || ''}
                    onChange={(value) => handleInputChange('description', value)}
                    modules={quillModules}
                    formats={quillFormats}
                    placeholder="Describe the event..."
                    style={{ minHeight: '150px' }}
                  />
                </div>
                {isOnline && selectedWebinar && (
                  <p className="text-xs text-slate-500">Pre-filled from Zoom webinar (editable)</p>
                )}
              </div>

              {/* Speakers Selection */}
              {!isGroupLimited && (
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <Mic className="h-4 w-4 text-slate-500" />
                  {speakerPlural}
                </Label>
                <p className="text-xs text-slate-500 mb-2">
                  Select {speakerPlural.toLowerCase()} for this event.
                </p>
                
                {loadingSpeakers ? (
                  <div className="text-sm text-slate-500">Loading {speakerPlural.toLowerCase()}...</div>
                ) : speakers.length === 0 ? (
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600">
                    No {speakerPlural.toLowerCase()} available. <a href="/SpeakerManagement" className="text-blue-600 hover:underline" data-testid="link-add-speaker">Add {speakerPlural.toLowerCase()}</a> first.
                  </div>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setSpeakerModalOpen(true)}
                      className="w-full justify-start text-left h-auto py-2"
                      data-testid="button-select-speakers"
                    >
                      <Mic className="h-4 w-4 mr-2 text-purple-600" />
                      {selectedSpeakers.length === 0 
                        ? `Click to select ${speakerPlural.toLowerCase()}...` 
                        : `${selectedSpeakers.length} ${selectedSpeakers.length !== 1 ? speakerPlural.toLowerCase() : speakerSingular.toLowerCase()} selected`
                      }
                    </Button>
                    
                    {/* Show selected speakers as chips */}
                    {selectedSpeakers.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {selectedSpeakers.map(speakerId => {
                          const speaker = speakers.find(s => s.id === speakerId);
                          if (!speaker) return null;
                          return (
                            <div
                              key={speaker.id}
                              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple-100 border border-purple-300 text-purple-800"
                            >
                              {speaker.profile_photo_url ? (
                                <img 
                                  src={speaker.profile_photo_url} 
                                  alt={speaker.full_name}
                                  className="w-5 h-5 rounded-full object-cover"
                                />
                              ) : (
                                <Mic className="h-3.5 w-3.5" />
                              )}
                              <span className="text-sm">{speaker.full_name}</span>
                              <button
                                type="button"
                                onClick={() => toggleSpeaker(speaker.id)}
                                className="ml-1 text-purple-600 hover:text-purple-800"
                                data-testid={`button-remove-speaker-chip-${speaker.id}`}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <SpeakerAwardsSection
                      speakers={speakers.filter(s => selectedSpeakers.includes(s.id))}
                      value={speakerAwards}
                      onChange={setSpeakerAwards}
                    />

                    <SpeakerSelectionModal
                      open={speakerModalOpen}
                      onOpenChange={setSpeakerModalOpen}
                      speakers={speakers}
                      selectedSpeakerIds={selectedSpeakers}
                      onConfirm={setSelectedSpeakers}
                    />
                  </>
                )}
              </div>
              )}

              {/* Event Filter Tags - Grouped by Category */}
              {eventCategories.length > 0 && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Tag className="h-4 w-4 text-slate-500" />
                    Filter Tags
                  </Label>
                  <p className="text-xs text-slate-500 mb-2">
                    Select one or more filter values to help categorize this event.
                  </p>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button 
                        variant="outline" 
                        className="w-full justify-between gap-2"
                        data-testid="filter-tags-trigger"
                      >
                        <div className="flex items-center gap-2">
                          <Tag className="w-4 h-4" />
                          {selectedFilterTags.length === 0 ? (
                            <span className="text-slate-500">Select filter tags...</span>
                          ) : selectedFilterTags.length === 1 ? (
                            <span className="truncate max-w-[200px]">{parseFilterTagKey(selectedFilterTags[0]).label}</span>
                          ) : (
                            <span>{selectedFilterTags.length} selected</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {selectedFilterTags.length > 0 && (
                            <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                              {selectedFilterTags.length}
                            </Badge>
                          )}
                          <ChevronDown className="w-4 h-4 opacity-50" />
                        </div>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 p-0" align="start">
                      <div className="p-2 border-b border-slate-100">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-slate-700">Select filter tags</span>
                          {selectedFilterTags.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-slate-500 hover:text-slate-700"
                              onClick={() => setSelectedFilterTags([])}
                              data-testid="filter-tags-clear"
                            >
                              Clear all
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="max-h-[320px] overflow-y-auto p-1">
                        {eventCategories.map((category) => (
                          <div key={category.id} className="mb-2">
                            <div className="px-2 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                              {category.name}
                            </div>
                            {category.subcategories.map((subcategory) => {
                              const tagKey = createFilterTagKey(category.id, subcategory);
                              const isSelected = selectedFilterTags.includes(tagKey);
                              return (
                                <button
                                  key={tagKey}
                                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${
                                    isSelected 
                                      ? "bg-slate-100 text-slate-900 font-medium" 
                                      : "text-slate-600 hover:bg-slate-50"
                                  }`}
                                  onClick={() => {
                                    if (isSelected) {
                                      setSelectedFilterTags(prev => prev.filter(t => t !== tagKey));
                                    } else {
                                      setSelectedFilterTags(prev => [...prev, tagKey]);
                                    }
                                  }}
                                  data-testid={`filter-tag-${subcategory}`}
                                >
                                  <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                    isSelected ? "bg-primary border-primary" : "border-slate-300"
                                  }`}>
                                    {isSelected && <Check className="w-3 h-3 text-white" />}
                                  </div>
                                  <span className="truncate">{subcategory}</span>
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                  {selectedFilterTags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {selectedFilterTags.map((tagKey, idx) => (
                        <Badge 
                          key={idx} 
                          variant="secondary" 
                          className="text-xs"
                        >
                          {parseFilterTagKey(tagKey).label}
                          <button
                            type="button"
                            className="ml-1 hover:text-slate-900"
                            onClick={() => setSelectedFilterTags(prev => prev.filter(t => t !== tagKey))}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!isGroupLimited && (<>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="internal_reference">Internal Reference{requireInternalReference && ' *'}</Label>
                  <Input
                    id="internal_reference"
                    value={formData.internal_reference}
                    onChange={(e) => handleInputChange('internal_reference', e.target.value)}
                    placeholder="e.g. PROJECT-123, Budget Code, etc."
                    data-testid="input-internal-reference"
                  />
                  <p className="text-xs text-slate-500">
                    For internal use only. Not shown to attendees but included on invoices.
                  </p>
                </div>

                {eventTypes.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="event_type">Event Type</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between font-normal" data-testid="select-event-type">
                          {formData.event_type?.length > 0
                            ? formData.event_type.join(', ')
                            : "Select event types..."}
                          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-full min-w-[260px] p-2" align="start">
                        <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
                          {eventTypes.map((type, idx) => {
                            const typeName = typeof type === 'string' ? type : type.name;
                            const isSelected = formData.event_type?.includes(typeName);
                            return (
                              <button
                                key={idx}
                                type="button"
                                className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left hover-elevate ${isSelected ? 'bg-accent' : ''}`}
                                data-testid={`option-event-type-${idx}`}
                                onClick={() => {
                                  const current = formData.event_type || [];
                                  const updated = isSelected
                                    ? current.filter(t => t !== typeName)
                                    : [...current, typeName];
                                  handleInputChange('event_type', updated);
                                }}
                              >
                                <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${isSelected ? 'bg-primary border-primary' : 'border-input'}`}>
                                  {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                                </div>
                                {typeName}
                              </button>
                            );
                          })}
                        </div>
                        {formData.event_type?.length > 0 && (
                          <button
                            type="button"
                            className="w-full mt-2 pt-2 border-t text-xs text-muted-foreground hover:text-foreground text-center"
                            onClick={() => handleInputChange('event_type', [])}
                            data-testid="button-clear-event-types"
                          >
                            Clear all
                          </button>
                        )}
                      </PopoverContent>
                    </Popover>
                    <p className="text-xs text-slate-500">
                      Categorize this event by type (e.g., Workshop, Training). You can select multiple types.
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="cta_override_url">CTA Override URL</Label>
                <Input
                  id="cta_override_url"
                  value={formData.cta_override_url}
                  onChange={(e) => handleInputChange('cta_override_url', e.target.value)}
                  placeholder="e.g. /my-custom-page or https://example.com/event-page"
                  data-testid="input-cta-override-url"
                />
                <p className="text-xs text-slate-500">
                  Optional. Use this to link to a custom Event Spotlight page or external booking flow.
                </p>
                <div className="space-y-2 pt-2">
                  <Label htmlFor="cta_override_mode">CTA Override Mode</Label>
                  <Select
                    value={formData.cta_override_mode || 'card'}
                    onValueChange={(value) => handleInputChange('cta_override_mode', value)}
                    disabled={!formData.cta_override_url}
                  >
                    <SelectTrigger id="cta_override_mode" data-testid="select-cta-override-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="card" data-testid="option-cta-mode-card">
                        Card CTA links to override URL
                      </SelectItem>
                      <SelectItem value="detail_page" data-testid="option-cta-mode-detail-page">
                        Card opens detail page; "Continue to book" links to override URL
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">
                    {formData.cta_override_url
                      ? 'In "detail page" mode, the event card opens the standard detail page where attendees can see ticket prices before being redirected to the override URL via a "Continue to book" button.'
                      : 'Set a CTA Override URL above to enable this option.'}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cta_button_label">CTA Button Label</Label>
                <Input
                  id="cta_button_label"
                  value={formData.cta_button_label}
                  onChange={(e) => handleInputChange('cta_button_label', e.target.value)}
                  placeholder={`e.g. Book Now (default: "${tenantDefaultCtaLabel}")`}
                  data-testid="input-cta-button-label"
                />
                <p className="text-xs text-slate-500">
                  Optional. Overrides the event card button label for this event. Leave blank to use the tenant default from Event Settings ("{tenantDefaultCtaLabel}").
                </p>
              </div>
              </>)}

              {/* Task #3691: Schedule fields hidden entirely for immediate events */}
              {!isImmediate && (
              <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start_date">
                    Start Date & Time {eventTiming !== 'tbc' && '*'}
                  </Label>
                  <TimezoneAwareDateTimeInput
                    id="start_date"
                    tz={effectiveTimezone}
                    value={isTraining ? (trainingDerivedDates?.start || '') : formData.start_date}
                    onChange={(iso) => handleInputChange('start_date', iso)}
                    required={eventTiming !== 'tbc' && !isTraining}
                    disabled={eventTiming === 'tbc' || isTraining}
                    readOnly={hasZoomSelection}
                    className={(eventTiming === 'tbc' || isTraining || hasZoomSelection) ? "bg-slate-100 cursor-not-allowed" : ""}
                    data-testid="input-start-date"
                  />
                  {eventTiming === 'tbc' && (
                    <p className="text-xs text-blue-600">Date disabled for TBC events</p>
                  )}
                  {isTraining && eventTiming !== 'tbc' && (
                    <p className="text-xs text-slate-500">Taken from the earliest agenda date</p>
                  )}
                  {hasZoomSelection && (
                    <p className="text-xs text-slate-500">Timing is managed by Zoom</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end_date">End Date & Time</Label>
                  <TimezoneAwareDateTimeInput
                    id="end_date"
                    tz={effectiveTimezone}
                    value={isTraining ? (trainingDerivedDates?.end || '') : formData.end_date}
                    onChange={(iso) => handleInputChange('end_date', iso)}
                    disabled={eventTiming === 'tbc' || isTraining}
                    readOnly={hasZoomSelection}
                    className={(eventTiming === 'tbc' || isTraining || hasZoomSelection) ? "bg-slate-100 cursor-not-allowed" : ""}
                    data-testid="input-end-date"
                  />
                  {isTraining && eventTiming !== 'tbc' && (
                    <p className="text-xs text-slate-500">Taken from the latest agenda date</p>
                  )}
                </div>
              </div>

              {/* Timezone Selector */}
              <div className="space-y-2 mt-4">
                <Label htmlFor="timezone">Timezone</Label>
                {hasZoomSelection ? (
                  <div className="flex items-center gap-2">
                    <Input
                      id="timezone"
                      value={timezoneOptions.find(tz => tz.value === activeZoomTimezone)?.label || activeZoomTimezone || "Not specified"}
                      readOnly
                      className="bg-slate-100 cursor-not-allowed"
                      data-testid="input-timezone-readonly"
                    />
                    <p className="text-xs text-slate-500">Timezone is set by Zoom</p>
                  </div>
                ) : (
                  <Select
                    value={formData.timezone}
                    onValueChange={(value) => handleInputChange('timezone', value)}
                    disabled={eventTiming === 'tbc'}
                    data-testid="select-timezone"
                  >
                    <SelectTrigger className={eventTiming === 'tbc' ? "bg-slate-100 cursor-not-allowed" : ""}>
                      <SelectValue placeholder="Select timezone" />
                    </SelectTrigger>
                    <SelectContent>
                      {timezoneOptions.map((tz) => (
                        <SelectItem key={tz.value} value={tz.value}>
                          {tz.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Registration Closes At - Optional */}
              <div className="space-y-2 mt-4">
                <Label htmlFor="registration_closes_at">Registration Closes On (Optional)</Label>
                <TimezoneAwareDateTimeInput
                  id="registration_closes_at"
                  tz={effectiveTimezone}
                  value={formData.registration_closes_at}
                  onChange={(iso) => {
                    // Validate: registration close cannot be after event end
                    if (iso && formData.end_date && new Date(iso) > new Date(formData.end_date)) {
                      toast.error('Registration close date cannot be after the event end date');
                      return;
                    }
                    handleInputChange('registration_closes_at', iso);
                  }}
                  max={formData.end_date || undefined}
                  disabled={eventTiming === 'tbc'}
                  className={eventTiming === 'tbc' ? "bg-slate-100 cursor-not-allowed" : ""}
                  data-testid="input-registration-closes-at"
                />
                <p className="text-xs text-slate-500">
                  If set, registration will automatically close at this time. Must be on or before the event end time.
                </p>
              </div>
              </>
              )}
            </CardContent>
          </Card>

          {/* Ticket Classes - Only shown for one-off events */}
          {!isProgramEvent && (
            <Card className="border-slate-200 shadow-sm mb-6">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Ticket className="h-5 w-5 text-blue-600" />
                      Ticket Classes
                    </CardTitle>
                    <CardDescription>Create different ticket types for different user roles</CardDescription>
                  </div>
                  {!isGroupLimited && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addTicketClass}
                    data-testid="button-add-ticket-class"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Ticket
                  </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {ticketClasses.map((ticket, index) => (
                  <div 
                    key={ticket.id} 
                    className="border border-slate-200 rounded-lg overflow-hidden"
                  >
                    {/* Ticket Header - Always visible */}
                    <div 
                      className="flex items-center justify-between p-4 bg-slate-50 cursor-pointer"
                      onClick={() => toggleExpandTicket(ticket.id)}
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-600 font-medium text-sm">
                          {index + 1}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-900">
                              {ticket.name || "Unnamed Ticket"}
                            </span>
                            {ticket.is_default && (
                              <Badge variant="secondary" className="text-xs">Default</Badge>
                            )}
                            {ticket.visibility_mode === 'members_and_public' && (
                              <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                                <Globe className="h-3 w-3 mr-1" />
                                Members & Public
                              </Badge>
                            )}
                            {ticket.visibility_mode === 'public_only' && (
                              <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">
                                <Globe className="h-3 w-3 mr-1" />
                                Public Only
                              </Badge>
                            )}
                            {ticket.is_group_ticket && (
                              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                                <Users className="h-3 w-3 mr-1" />
                                Group ({ticket.group_size || '?'})
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-sm text-slate-500">
                            <span>{isGroupLimited ? "Free" : `£${ticket.price || "0.00"}`}</span>
                            {!isGroupLimited && (
                              <>
                                <span className="text-slate-300">|</span>
                                <span className="flex items-center gap-1">
                                  <Users className="h-3 w-3" />
                                  {getRoleNames(ticket.role_ids)}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {ticketClasses.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={(e) => { e.stopPropagation(); removeTicketClass(ticket.id); }}
                            className="h-8 w-8 text-slate-400 hover:text-red-500"
                            data-testid={`button-remove-ticket-${ticket.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                        {expandedTickets[ticket.id] ? (
                          <ChevronUp className="h-5 w-5 text-slate-400" />
                        ) : (
                          <ChevronDown className="h-5 w-5 text-slate-400" />
                        )}
                      </div>
                    </div>

                    {/* Ticket Details - Collapsible */}
                    {expandedTickets[ticket.id] && (
                      <div className="p-4 space-y-4 border-t border-slate-200">
                        {/* Ticket Name and Price (price hidden for group-limited events — free only) */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <div className={`space-y-2 ${isGroupLimited ? 'md:col-span-3' : 'md:col-span-2'}`}>
                            <Label htmlFor={`ticket-name-${ticket.id}`}>Ticket Name *</Label>
                            <Input
                              id={`ticket-name-${ticket.id}`}
                              value={ticket.name}
                              onChange={(e) => updateTicketClass(ticket.id, 'name', e.target.value)}
                              placeholder="e.g. Member Ticket"
                              data-testid={`input-ticket-name-${ticket.id}`}
                            />
                            {isGroupLimited && (
                              <p className="text-xs text-slate-500">Group events are free to attend.</p>
                            )}
                          </div>
                          {!isGroupLimited && (
                          <div className="space-y-2">
                            <Label htmlFor={`ticket-price-${ticket.id}`}>Price (£) *</Label>
                            <div className="flex items-center gap-3">
                              <div className="relative w-28">
                                <PoundSterling className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                                <Input
                                  id={`ticket-price-${ticket.id}`}
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={ticket.is_free ? "0" : ticket.price}
                                  onChange={(e) => updateTicketClass(ticket.id, 'price', e.target.value)}
                                  placeholder="0.00"
                                  className="pl-9"
                                  disabled={ticket.is_free}
                                  data-testid={`input-ticket-price-${ticket.id}`}
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <Switch
                                  id={`ticket-free-${ticket.id}`}
                                  checked={ticket.is_free || false}
                                  onCheckedChange={(checked) => setTicketFree(ticket.id, checked)}
                                  data-testid={`switch-free-${ticket.id}`}
                                />
                                <Label htmlFor={`ticket-free-${ticket.id}`} className="text-sm font-medium">
                                  Free
                                </Label>
                              </div>
                            </div>
                          </div>
                          )}
                        </div>

                        {/* Ticket Availability */}
                        <div className="space-y-2">
                          <Label className="flex items-center gap-2">
                            <Ticket className="h-4 w-4 text-slate-500" />
                            Ticket Availability
                          </Label>
                          <p className="text-xs text-slate-500 mb-2">
                            Set how many of this ticket type are available. This is independent of event seat capacity.
                          </p>
                          <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2">
                              <Switch
                                id={`ticket-unlimited-${ticket.id}`}
                                checked={ticket.is_unlimited_tickets !== false}
                                onCheckedChange={(checked) => updateTicketClass(ticket.id, 'is_unlimited_tickets', checked)}
                                data-testid={`switch-unlimited-tickets-${ticket.id}`}
                              />
                              <Label htmlFor={`ticket-unlimited-${ticket.id}`} className="text-sm font-medium">
                                Unlimited
                              </Label>
                            </div>
                            {ticket.is_unlimited_tickets === false && (
                              <div className="flex items-center gap-2">
                                <Input
                                  id={`ticket-available-count-${ticket.id}`}
                                  type="number"
                                  min="0"
                                  value={ticket.available_count || ""}
                                  onChange={(e) => updateTicketClass(ticket.id, 'available_count', e.target.value)}
                                  placeholder="e.g. 50"
                                  className="w-24"
                                  data-testid={`input-ticket-available-count-${ticket.id}`}
                                />
                                <span className="text-sm text-slate-500">tickets</span>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Group Ticket (hidden for group-limited events) */}
                        {!isGroupLimited && (
                        <div className="space-y-3">
                          <div className="flex items-center gap-2">
                            <Switch
                              id={`ticket-group-${ticket.id}`}
                              checked={ticket.is_group_ticket || false}
                              onCheckedChange={(checked) => updateTicketClass(ticket.id, 'is_group_ticket', checked)}
                              data-testid={`switch-group-ticket-${ticket.id}`}
                            />
                            <Label htmlFor={`ticket-group-${ticket.id}`} className="text-sm font-medium flex items-center gap-1.5">
                              <Users className="h-4 w-4 text-slate-500" />
                              Group Ticket
                            </Label>
                          </div>
                          <p className="text-xs text-slate-500">
                            A group ticket covers multiple participants. The booker receives a link to add people by email.
                          </p>
                          {ticket.is_group_ticket && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-2 border-l-2 border-blue-200 ml-1">
                              <div className="space-y-1.5">
                                <Label htmlFor={`ticket-group-size-${ticket.id}`} className="text-sm">
                                  Group Size (max participants) *
                                </Label>
                                <Input
                                  id={`ticket-group-size-${ticket.id}`}
                                  type="number"
                                  min="2"
                                  value={ticket.group_size || ""}
                                  onChange={(e) => updateTicketClass(ticket.id, 'group_size', e.target.value)}
                                  placeholder="e.g. 10"
                                  className="w-28"
                                  data-testid={`input-group-size-${ticket.id}`}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor={`ticket-group-cutoff-${ticket.id}`} className="text-sm">
                                  Cut-off Date/Time
                                </Label>
                                <Input
                                  id={`ticket-group-cutoff-${ticket.id}`}
                                  type="datetime-local"
                                  value={ticket.group_cutoff_date || ""}
                                  onChange={(e) => updateTicketClass(ticket.id, 'group_cutoff_date', e.target.value)}
                                  data-testid={`input-group-cutoff-${ticket.id}`}
                                />
                                <p className="text-xs text-slate-400">
                                  After this time, no more changes to the group can be made.
                                </p>
                              </div>
                            </div>
                          )}
                        </div>
                        )}

                        {/* Role Assignment / Member Group / Visibility (hidden for group-limited events) */}
                        {!isGroupLimited && (
                        <>
                        <div className="space-y-2">
                          <Label className="flex items-center gap-2">
                            <Users className="h-4 w-4 text-slate-500" />
                            Available to Roles
                          </Label>
                          <p className="text-xs text-slate-500 mb-2">
                            Select which roles can purchase this ticket. Leave empty for all roles.
                          </p>
                          
                          {loadingRoles ? (
                            <div className="text-sm text-slate-500">Loading roles...</div>
                          ) : (
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button 
                                  variant="outline" 
                                  className="w-full justify-between gap-2"
                                  data-testid={`role-selector-trigger-${ticket.id}`}
                                >
                                  <div className="flex items-center gap-2">
                                    <Users className="w-4 h-4" />
                                    {(ticket.role_ids || []).length === 0 ? (
                                      <span className="text-green-600 font-medium">All Roles</span>
                                    ) : (ticket.role_ids || []).length === 1 ? (
                                      <span className="truncate max-w-[200px]">
                                        {roles.find(r => r.id === ticket.role_ids[0])?.name || 'Unknown'}
                                      </span>
                                    ) : (
                                      <span>{(ticket.role_ids || []).length} roles selected</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1">
                                    {(ticket.role_ids || []).length > 0 && (
                                      <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                                        {(ticket.role_ids || []).length}
                                      </Badge>
                                    )}
                                    <ChevronDown className="w-4 h-4 opacity-50" />
                                  </div>
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-64 p-0" align="start">
                                <div className="p-2 border-b border-slate-100">
                                  <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium text-slate-700">Select roles</span>
                                    {(ticket.role_ids || []).length > 0 && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 text-xs text-slate-500 hover:text-slate-700"
                                        onClick={() => updateTicketClass(ticket.id, 'role_ids', [])}
                                        data-testid={`role-clear-${ticket.id}`}
                                      >
                                        Clear all
                                      </Button>
                                    )}
                                  </div>
                                </div>
                                <div className="max-h-[280px] overflow-y-auto p-1">
                                  {roles.map(role => {
                                    const isSelected = (ticket.role_ids || []).includes(role.id);
                                    return (
                                      <button
                                        key={role.id}
                                        className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                                          isSelected 
                                            ? "bg-slate-100 text-slate-900 font-medium" 
                                            : "text-slate-600 hover:bg-slate-50"
                                        }`}
                                        onClick={() => toggleRoleForTicket(ticket.id, role.id)}
                                        data-testid={`role-toggle-${ticket.id}-${role.id}`}
                                      >
                                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                          isSelected ? "bg-primary border-primary" : "border-slate-300"
                                        }`}>
                                          {isSelected && <Check className="w-3 h-3 text-white" />}
                                        </div>
                                        <span className="truncate">{role.name}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </PopoverContent>
                            </Popover>
                          )}
                          
                          {(ticket.role_ids || []).length === 0 && (
                            <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded text-sm text-green-700">
                              This ticket is available to all roles
                            </div>
                          )}
                          
                          {(ticket.role_ids || []).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {(ticket.role_ids || []).map(roleId => {
                                const role = roles.find(r => r.id === roleId);
                                return role ? (
                                  <Badge 
                                    key={roleId} 
                                    variant="secondary" 
                                    className="text-xs"
                                  >
                                    {role.name}
                                    <button
                                      type="button"
                                      className="ml-1 hover:text-slate-900"
                                      onClick={() => toggleRoleForTicket(ticket.id, roleId)}
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </Badge>
                                ) : null;
                              })}
                            </div>
                          )}

                        </div>

                        {/* Member Group Assignment */}
                        <div className="space-y-2">
                          <Label className="flex items-center gap-2">
                            <Users className="h-4 w-4 text-slate-500" />
                            Available to {memberGroupFeatureName}
                          </Label>
                          <p className="text-xs text-slate-500 mb-2">
                            Select which member groups can purchase this ticket. Combined with roles using OR logic. Leave empty for no group restriction.
                          </p>

                          {loadingMemberGroups ? (
                            <div className="text-sm text-slate-500">Loading member groups...</div>
                          ) : memberGroups.length === 0 ? (
                            <div className="p-2 bg-slate-50 border border-slate-200 rounded text-sm text-slate-500">
                              No member groups defined yet
                            </div>
                          ) : (
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  className="w-full justify-between gap-2"
                                  data-testid={`group-selector-trigger-${ticket.id}`}
                                >
                                  <div className="flex items-center gap-2">
                                    <Users className="w-4 h-4" />
                                    {(ticket.member_group_ids || []).length === 0 ? (
                                      <span className="text-slate-500">No group restriction</span>
                                    ) : (ticket.member_group_ids || []).length === 1 ? (
                                      <span className="truncate max-w-[200px]">
                                        {memberGroups.find(g => g.id === ticket.member_group_ids[0])?.name || 'Unknown'}
                                      </span>
                                    ) : (
                                      <span>{(ticket.member_group_ids || []).length} groups selected</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1">
                                    {(ticket.member_group_ids || []).length > 0 && (
                                      <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                                        {(ticket.member_group_ids || []).length}
                                      </Badge>
                                    )}
                                    <ChevronDown className="w-4 h-4 opacity-50" />
                                  </div>
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-64 p-0" align="start">
                                <div className="p-2 border-b border-slate-100">
                                  <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium text-slate-700">Select member groups</span>
                                    {(ticket.member_group_ids || []).length > 0 && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 text-xs text-slate-500 hover:text-slate-700"
                                        onClick={() => updateTicketClass(ticket.id, 'member_group_ids', [])}
                                        data-testid={`group-clear-${ticket.id}`}
                                      >
                                        Clear all
                                      </Button>
                                    )}
                                  </div>
                                </div>
                                <div className="max-h-[280px] overflow-y-auto p-1">
                                  {memberGroups.map(group => {
                                    const isSelected = (ticket.member_group_ids || []).includes(group.id);
                                    return (
                                      <button
                                        key={group.id}
                                        type="button"
                                        className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                                          isSelected
                                            ? "bg-slate-100 text-slate-900 font-medium"
                                            : "text-slate-600 hover:bg-slate-50"
                                        }`}
                                        onClick={() => toggleMemberGroupForTicket(ticket.id, group.id)}
                                        data-testid={`group-toggle-${ticket.id}-${group.id}`}
                                      >
                                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                          isSelected ? "bg-primary border-primary" : "border-slate-300"
                                        }`}>
                                          {isSelected && <Check className="w-3 h-3 text-white" />}
                                        </div>
                                        <span className="truncate">{group.name}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </PopoverContent>
                            </Popover>
                          )}

                          {(ticket.member_group_ids || []).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {(ticket.member_group_ids || []).map(groupId => {
                                const group = memberGroups.find(g => g.id === groupId);
                                return group ? (
                                  <Badge
                                    key={groupId}
                                    variant="secondary"
                                    className="text-xs"
                                  >
                                    {group.name}
                                    <button
                                      type="button"
                                      className="ml-1 hover:text-slate-900"
                                      onClick={() => toggleMemberGroupForTicket(ticket.id, groupId)}
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </Badge>
                                ) : null;
                              })}
                            </div>
                          )}

                          {/* Restrict-mode toggle: shown when roles OR groups selected AND visibility includes members */}
                          {((ticket.role_ids || []).length > 0 || (ticket.member_group_ids || []).length > 0) && ticket.visibility_mode !== 'public_only' && (
                            <div className="mt-3 flex items-center justify-between p-3 bg-warning/10 border border-warning/30 rounded-lg">
                              <div className="flex items-center gap-2">
                                <Users className="h-4 w-4 text-warning" />
                                <div>
                                  <Label htmlFor={`role-match-only-${ticket.id}`} className="text-sm font-medium text-warning">
                                    Restrict to selected roles / groups
                                  </Label>
                                  <p className="text-xs text-warning">
                                    {ticket.role_match_only
                                      ? "Ticket is hidden from users whose role and member groups don't match"
                                      : "Ticket is visible to all users (selection only affects who can register)"}
                                  </p>
                                </div>
                              </div>
                              <Switch
                                id={`role-match-only-${ticket.id}`}
                                checked={ticket.role_match_only || false}
                                onCheckedChange={(checked) => updateTicketClass(ticket.id, 'role_match_only', checked)}
                                data-testid={`switch-role-match-only-${ticket.id}`}
                              />
                            </div>
                          )}
                        </div>

                        {/* Ticket Visibility Mode */}
                        <div className="space-y-3">
                          <div className="flex items-center gap-2">
                            <Globe className="h-5 w-5 text-blue-600" />
                            <Label className="text-base font-medium">Ticket Visibility</Label>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                            <div 
                              className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                (ticket.visibility_mode || 'members_only') === 'members_only'
                                  ? 'border-blue-500 bg-blue-50' 
                                  : 'border-slate-200 hover:bg-slate-50'
                              }`}
                              onClick={() => updateTicketClass(ticket.id, 'visibility_mode', 'members_only')}
                              data-testid={`visibility-members-only-${ticket.id}`}
                            >
                              <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                                (ticket.visibility_mode || 'members_only') === 'members_only' 
                                  ? 'border-blue-500' 
                                  : 'border-slate-300'
                              }`}>
                                {(ticket.visibility_mode || 'members_only') === 'members_only' && (
                                  <div className="h-2 w-2 rounded-full bg-blue-500" />
                                )}
                              </div>
                              <div>
                                <p className="text-sm font-medium">Members Only</p>
                                <p className="text-xs text-slate-500">Logged-in members only</p>
                              </div>
                            </div>
                            <div 
                              className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                ticket.visibility_mode === 'members_and_public'
                                  ? 'border-blue-500 bg-blue-50' 
                                  : 'border-slate-200 hover:bg-slate-50'
                              }`}
                              onClick={() => updateTicketClass(ticket.id, 'visibility_mode', 'members_and_public')}
                              data-testid={`visibility-members-and-public-${ticket.id}`}
                            >
                              <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                                ticket.visibility_mode === 'members_and_public' 
                                  ? 'border-blue-500' 
                                  : 'border-slate-300'
                              }`}>
                                {ticket.visibility_mode === 'members_and_public' && (
                                  <div className="h-2 w-2 rounded-full bg-blue-500" />
                                )}
                              </div>
                              <div>
                                <p className="text-sm font-medium">Members & Public</p>
                                <p className="text-xs text-slate-500">Both members and visitors</p>
                              </div>
                            </div>
                            <div 
                              className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                ticket.visibility_mode === 'public_only'
                                  ? 'border-blue-500 bg-blue-50' 
                                  : 'border-slate-200 hover:bg-slate-50'
                              }`}
                              onClick={() => updateTicketClass(ticket.id, 'visibility_mode', 'public_only')}
                              data-testid={`visibility-public-only-${ticket.id}`}
                            >
                              <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                                ticket.visibility_mode === 'public_only' 
                                  ? 'border-blue-500' 
                                  : 'border-slate-300'
                              }`}>
                                {ticket.visibility_mode === 'public_only' && (
                                  <div className="h-2 w-2 rounded-full bg-blue-500" />
                                )}
                              </div>
                              <div>
                                <p className="text-sm font-medium">Public Only</p>
                                <p className="text-xs text-slate-500">Non-logged in visitors only</p>
                              </div>
                            </div>
                          </div>
                        </div>

                        <Separator />

                        {/* Offer Configuration */}
                        <div className="space-y-4">
                          <Label className="text-sm font-medium text-slate-700">Special Offer</Label>
                          <RadioGroup 
                            value={ticket.offer_type} 
                            onValueChange={(value) => updateTicketClass(ticket.id, 'offer_type', value)}
                            className="grid grid-cols-1 md:grid-cols-3 gap-2"
                          >
                              <Label 
                                htmlFor={`offer-none-${ticket.id}`}
                                className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                  ticket.offer_type === 'none' 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:bg-slate-50'
                                }`}
                                data-testid={`offer-none-${ticket.id}`}
                              >
                                <RadioGroupItem value="none" id={`offer-none-${ticket.id}`} />
                                <span className="text-sm">No Offer</span>
                              </Label>
                              <Label 
                                htmlFor={`offer-bogo-${ticket.id}`}
                                className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                  ticket.offer_type === 'bogo' 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:bg-slate-50'
                                }`}
                                data-testid={`offer-bogo-${ticket.id}`}
                              >
                                <RadioGroupItem value="bogo" id={`offer-bogo-${ticket.id}`} />
                                <span className="text-sm">BOGO</span>
                              </Label>
                              <Label 
                                htmlFor={`offer-bulk-${ticket.id}`}
                                className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                  ticket.offer_type === 'bulk_discount' 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:bg-slate-50'
                                }`}
                                data-testid={`offer-bulk-${ticket.id}`}
                              >
                                <RadioGroupItem value="bulk_discount" id={`offer-bulk-${ticket.id}`} />
                                <span className="text-sm">Bulk Discount</span>
                              </Label>
                          </RadioGroup>

                          {/* BOGO Configuration */}
                          {ticket.offer_type === 'bogo' && (
                            <div className="p-4 bg-slate-50 rounded-lg space-y-4">
                              <RadioGroup 
                                value={ticket.bogo_logic_type} 
                                onValueChange={(value) => updateTicketClass(ticket.id, 'bogo_logic_type', value)}
                              >
                                <div className="space-y-2">
                                  <div className="flex items-center gap-2">
                                    <RadioGroupItem value="buy_x_get_y_free" id={`bogo-logic-1-${ticket.id}`} />
                                    <Label htmlFor={`bogo-logic-1-${ticket.id}`} className="text-sm cursor-pointer">
                                      Buy X, Get Y Free
                                    </Label>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <RadioGroupItem value="enter_total_pay_less" id={`bogo-logic-2-${ticket.id}`} />
                                    <Label htmlFor={`bogo-logic-2-${ticket.id}`} className="text-sm cursor-pointer">
                                      Enter Total, Pay Less
                                    </Label>
                                  </div>
                                </div>
                              </RadioGroup>
                              
                              <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                  <Label htmlFor={`bogo-buy-${ticket.id}`}>Buy Quantity *</Label>
                                  <Input
                                    id={`bogo-buy-${ticket.id}`}
                                    type="number"
                                    min="1"
                                    value={ticket.bogo_buy_quantity}
                                    onChange={(e) => updateTicketClass(ticket.id, 'bogo_buy_quantity', e.target.value)}
                                    placeholder="e.g. 2"
                                    data-testid={`input-bogo-buy-${ticket.id}`}
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor={`bogo-free-${ticket.id}`}>Get Free Quantity *</Label>
                                  <Input
                                    id={`bogo-free-${ticket.id}`}
                                    type="number"
                                    min="1"
                                    value={ticket.bogo_get_free_quantity}
                                    onChange={(e) => updateTicketClass(ticket.id, 'bogo_get_free_quantity', e.target.value)}
                                    placeholder="e.g. 1"
                                    data-testid={`input-bogo-free-${ticket.id}`}
                                  />
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Bulk Discount Configuration */}
                          {ticket.offer_type === 'bulk_discount' && (
                            <div className="p-4 bg-slate-50 rounded-lg">
                              <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                  <Label htmlFor={`bulk-threshold-${ticket.id}`}>Minimum Tickets *</Label>
                                  <Input
                                    id={`bulk-threshold-${ticket.id}`}
                                    type="number"
                                    min="2"
                                    value={ticket.bulk_discount_threshold}
                                    onChange={(e) => updateTicketClass(ticket.id, 'bulk_discount_threshold', e.target.value)}
                                    placeholder="e.g. 5"
                                    data-testid={`input-bulk-threshold-${ticket.id}`}
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor={`bulk-percentage-${ticket.id}`}>Discount % *</Label>
                                  <Input
                                    id={`bulk-percentage-${ticket.id}`}
                                    type="number"
                                    step="0.1"
                                    min="0"
                                    max="100"
                                    value={ticket.bulk_discount_percentage}
                                    onChange={(e) => updateTicketClass(ticket.id, 'bulk_discount_percentage', e.target.value)}
                                    placeholder="e.g. 10"
                                    data-testid={`input-bulk-percentage-${ticket.id}`}
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>

                        <Separator />

                        {/* VAT Rate Selection */}
                        <div className="space-y-2">
                          <Label className="text-sm font-medium text-slate-700">VAT Rate</Label>
                          <Select
                            value={ticket.vat_rate_key || "none"}
                            onValueChange={(value) => {
                              if (value === "none") {
                                updateTicketClass(ticket.id, 'vat_rate_key', null);
                                updateTicketClass(ticket.id, 'vat_rate_label', null);
                                updateTicketClass(ticket.id, 'vat_rate_percentage', null);
                              } else {
                                const selectedRate = availableVatRates.find(r => r.taxType === value);
                                if (selectedRate) {
                                  updateTicketClass(ticket.id, 'vat_rate_key', selectedRate.taxType);
                                  updateTicketClass(ticket.id, 'vat_rate_label', selectedRate.name);
                                  updateTicketClass(ticket.id, 'vat_rate_percentage', selectedRate.effectiveRate);
                                }
                              }
                            }}
                          >
                            <SelectTrigger className="w-full" data-testid={`select-vat-rate-${ticket.id}`}>
                              <SelectValue placeholder="Select VAT rate..." />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">No VAT / Tax Exempt</SelectItem>
                              {availableVatRates.map((rate) => (
                                <SelectItem key={rate.taxType} value={rate.taxType}>
                                  {rate.name} ({rate.effectiveRate}%)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {availableVatRates.length === 0 && (
                            <p className="text-xs text-warning">
                              No VAT rates available. Sync rates from Xero in Admin Setup.
                            </p>
                          )}
                          {ticket.vat_rate_key && (
                            <p className="text-xs text-green-600">
                              {ticket.vat_rate_label} ({ticket.vat_rate_percentage}%)
                            </p>
                          )}
                        </div>
                        </>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {ticketClasses.length === 0 && (
                  <div className="text-center py-8 text-slate-500">
                    <Ticket className="h-12 w-12 mx-auto mb-3 text-slate-300" />
                    <p>No ticket classes defined</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addTicketClass}
                      className="mt-3"
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add Your First Ticket
                    </Button>
                  </div>
                )}

                {/* Allow Guests to View All Tickets Toggle */}
                {ticketClasses.length > 0 && !isGroupLimited && (
                  <div className="mt-6 pt-4 border-t border-slate-200">
                    <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                      <div className="flex items-start gap-3">
                        <Eye className="h-5 w-5 text-slate-600 mt-0.5" />
                        <div>
                          <Label htmlFor="allow-guests-view-all" className="text-sm font-medium text-slate-900 cursor-pointer">
                            Show all ticket types to public visitors
                          </Label>
                          <p className="text-xs text-slate-500 mt-1">
                            When enabled, non-logged-in visitors can see member-only ticket prices (but cannot purchase them)
                          </p>
                        </div>
                      </div>
                      <Switch
                        id="allow-guests-view-all"
                        checked={allowGuestsToViewAllTickets}
                        onCheckedChange={setAllowGuestsToViewAllTickets}
                        data-testid="switch-allow-guests-view-all"
                      />
                    </div>
                    <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg mt-3">
                      <div className="flex items-start gap-3">
                        <Eye className="h-5 w-5 text-slate-600 mt-0.5" />
                        <div>
                          <Label htmlFor="collect-third-party-consent" className="text-sm font-medium text-slate-900 cursor-pointer">
                            Collect third-party data sharing consent
                          </Label>
                          <p className="text-xs text-slate-500 mt-1">
                            When enabled, attendees will see an optional, default-checked checkbox below the terms &amp; conditions agreeing to share their details with relevant third parties. Submission is not required.
                          </p>
                        </div>
                      </div>
                      <Switch
                        id="collect-third-party-consent"
                        checked={collectThirdPartyConsent}
                        onCheckedChange={setCollectThirdPartyConsent}
                        data-testid="switch-collect-third-party-consent"
                      />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <MapPin className="h-5 w-5 text-blue-600" />
                Location & Capacity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isOnline ? (
                <div className="space-y-4">
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="flex items-center gap-2 mb-2">
                      <Globe className="h-4 w-4 text-blue-600" />
                      <span className="font-medium text-blue-900">Online Event</span>
                    </div>
                    <p className="text-sm text-blue-800">
                      {isGroupLimited
                        ? 'Participants will join via the meeting link you provided in the Event Type section.'
                        : 'Participants will join via Zoom. The join link will be provided upon registration.'}
                    </p>
                  </div>
                  {isGroupLimited && formData.online_meeting_url && (
                    <div className="space-y-2">
                      <Label>Meeting link</Label>
                      <div className="flex items-center gap-2 p-3 bg-slate-100 rounded-lg">
                        <LinkIcon className="h-4 w-4 text-slate-500" />
                        <span className="text-sm text-slate-600 truncate">{formData.online_meeting_url}</span>
                      </div>
                    </div>
                  )}
                  {!isGroupLimited && formData.online_url && (
                    <div className="space-y-2">
                      <Label>Zoom Join URL</Label>
                      <div className="flex items-center gap-2 p-3 bg-slate-100 rounded-lg">
                        <LinkIcon className="h-4 w-4 text-slate-500" />
                        <span className="text-sm text-slate-600 truncate">{formData.online_url}</span>
                      </div>
                    </div>
                  )}
                </div>
              ) : !isTraining ? (
                <div className="space-y-2">
                  <Label htmlFor="location">Venue / Location *</Label>
                  <Input
                    id="location"
                    value={formData.location}
                    onChange={(e) => handleInputChange('location', e.target.value)}
                    placeholder="Enter venue address or location name"
                    required={!isOnline}
                    data-testid="input-location"
                  />
                </div>
              ) : null}

              {/* Available Seats - shown for all event types */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="available_seats">Available Seats</Label>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="unlimited-seats"
                      checked={unlimitedSeats}
                      onCheckedChange={(checked) => {
                        setUnlimitedSeats(checked);
                        if (checked) {
                          handleInputChange('available_seats', '');
                        }
                      }}
                      data-testid="switch-unlimited-seats"
                    />
                    <Label htmlFor="unlimited-seats" className="text-sm font-normal cursor-pointer">
                      Unlimited
                    </Label>
                  </div>
                </div>
                {!unlimitedSeats && (
                  <Input
                    id="available_seats"
                    type="number"
                    min="1"
                    value={formData.available_seats}
                    onChange={(e) => handleInputChange('available_seats', e.target.value)}
                    placeholder="Enter number of seats"
                    data-testid="input-seats"
                  />
                )}
                <p className="text-xs text-slate-500">
                  {isOnline 
                    ? "For online events, capacity is managed by your Zoom plan limits" 
                    : "Set the maximum number of attendees for this event"}
                </p>
                
                {/* Per-event seat visibility toggle - only shown when global setting is ON */}
                {globalShowSeats && !isGroupLimited && (
                  <div className="flex items-center justify-between pt-2 border-t">
                    <div>
                      <Label htmlFor="show-seat-count" className="text-sm">Show seat count</Label>
                      <p className="text-xs text-slate-500">Display available seats on event cards</p>
                    </div>
                    <Switch
                      id="show-seat-count"
                      checked={showSeatCount}
                      onCheckedChange={setShowSeatCount}
                      data-testid="switch-show-seat-count"
                    />
                  </div>
                )}
                
                {/* Per-event ticket availability visibility toggle - for one-off events */}
                {!isProgramEvent && !isGroupLimited && (
                  <div className="flex items-center justify-between pt-2 border-t">
                    <div>
                      <Label htmlFor="show-ticket-availability" className="text-sm">Show ticket availability</Label>
                      <p className="text-xs text-slate-500">Display remaining tickets per class on event page</p>
                    </div>
                    <Switch
                      id="show-ticket-availability"
                      checked={showTicketAvailability}
                      onCheckedChange={setShowTicketAvailability}
                      data-testid="switch-show-ticket-availability"
                    />
                  </div>
                )}
              </div>

              <EventImageUpload
                value={formData.image_url}
                onChange={(url) => handleInputChange('image_url', url)}
              />
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Documents</CardTitle>
              <CardDescription>
                Upload public files (programmes, agendas, info packs) shown on the event page. PDFs open in an in-page viewer; other files open in a new tab.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EventDocumentsManager
                sectionTitle={documentsSectionTitle}
                onSectionTitleChange={setDocumentsSectionTitle}
                documents={attachedDocuments}
                onDocumentsChange={setAttachedDocuments}
              />
            </CardContent>
          </Card>

          {!isGroupLimited && collectAttendeeOptionsEnabled && (
          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Dietary, Allergy &amp; Accessibility Options</CardTitle>
              <CardDescription>
                Define the options registrants can choose from for each attendee during booking. Sections with no options are hidden from registrants.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EventOptionListsEditor
                dietaryOptions={dietaryOptions}
                allergyOptions={allergyOptions}
                accessibilityOptions={accessibilityOptions}
                onDietaryChange={setDietaryOptions}
                onAllergyChange={setAllergyOptions}
                onAccessibilityChange={setAccessibilityOptions}
              />
            </CardContent>
          </Card>
          )}

          {/* Email Configuration (Task #3263) — saved right after the event is created */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Mail className="h-5 w-5 text-blue-600" />
                    Email Configuration
                  </CardTitle>
                  <CardDescription>
                    Configure confirmation and reminder emails for this event. They will be saved when the event is created.
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEventEmails(prev => [...prev, createEmptyEmail('booking_confirmation')])}
                    data-testid="button-add-confirmation-email"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Confirmation
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEventEmails(prev => [...prev, createEmptyEmail('reminder')])}
                    data-testid="button-add-reminder-email"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Reminder
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <EventEmailSettingsEditor
                emails={eventEmails}
                setEmails={setEventEmails}
                emailTemplates={emailTemplates}
                eventTimezone={formData.timezone || 'Europe/London'}
                mode="event"
              />
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => window.location.href = createPageUrl('Events')}
              disabled={createEventMutation.isPending}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createEventMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
              data-testid="button-create-event"
              onClick={() => console.log('[CreateEvent] Create Event button clicked')}
            >
              {createEventMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Create Event
                </>
              )}
            </Button>
          </div>
        </form>
      </div>

      <EventClashWarningDialog
        open={clashDialog.open}
        clashes={clashDialog.clashes}
        redacted={clashDialog.redacted}
        clashCount={clashDialog.clashCount}
        onConfirm={handleClashConfirm}
        onCancel={handleClashCancel}
        isSaving={createEventMutation.isPending}
      />

      {/* Validation Error Dialog */}
      <Dialog open={showValidationDialog} onOpenChange={setShowValidationDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-warning">
              <AlertCircle className="w-5 h-5" />
              Please Fix the Following Issues
            </DialogTitle>
            <DialogDescription>
              Your event cannot be created until these issues are resolved:
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-4 space-y-2 max-h-[300px] overflow-y-auto">
            {validationErrors.map((error, index) => (
              <div key={index} className="flex items-start gap-2 text-sm text-slate-700 p-2 bg-warning/10 rounded border border-warning/30">
                <span className="text-warning font-bold mt-0.5">{index + 1}.</span>
                <span>{error}</span>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <Button
              onClick={() => setShowValidationDialog(false)}
              className="bg-blue-600 hover:bg-blue-700">
              I'll Fix These
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
