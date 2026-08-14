import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { 
  Calendar, 
  MapPin, 
  ArrowLeft,
  Save,
  Loader2,
  Video,
  Globe,
  PoundSterling,
  Plus,
  Trash2,
  Users,
  Ticket,
  ChevronDown,
  ChevronUp,
  Check,
  Mic,
  X,
  Tag,
  Eye,
  Mail,
  Clock,
  Bell,
  Code,
  FileText,
  Download,
  Copy,
  ExternalLink,
  Gift,
  Bird,
  AlertCircle,
  Handshake,
  QrCode
} from "lucide-react";
import { createFilterTagKey, parseFilterTagKey, normalizeFilterTags, parseEventTypes, serializeEventTypes } from "@/lib/utils";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { TimezoneAwareDateTimeInput } from "@/components/events/TimezoneAwareDateTimeInput";
import EventClashWarningDialog from "@/components/events/EventClashWarningDialog";
import EventBudgetPanel from "@/components/events/EventBudgetPanel";
import { checkEventClashes, buildClashWindows } from "@/lib/eventClash";
import { createPageUrl, getEventUrl } from "@/utils";
import EventImageUpload from "@/components/events/EventImageUpload";
import EventDocumentsManager from "@/components/events/EventDocumentsManager";
import EventSurveysSection from "@/components/surveys/EventSurveysSection";
import EventOptionListsEditor from "@/components/events/EventOptionListsEditor";
import { isAttendeeOptionsCollectionEnabled } from "@/lib/attendeeOptionsSetting";
import ChangeZoomDialog from "@/components/events/ChangeZoomDialog";
import { FocalPointPicker } from "@/components/FocalPointPicker";
import { SpeakerSelectionModal } from "@/components/SpeakerSelectionModal";
import SpeakerAwardsSection, { configToFormState, formStateToConfig } from "@/components/events/SpeakerAwardsSection";
import EventSponsorSelector from "@/components/events/EventSponsorSelector";
import { useSpeakerModuleName } from "@/hooks/useSpeakerModuleName";
import { useEventTypes } from "@/hooks/useEventTypes";
import { useAgendaItemTypes } from "@/hooks/useAgendaItemTypes";
import TrainingAgendaEditor, { validateAgendaLines, agendaTypeBehaviour, sortAgendaLinesChronologically, agendaLineStartDateTime, agendaLineEndDateTime, normalizeAgendaTime } from "@/components/events/TrainingAgendaEditor";
import { persistAgendaLinesWithRollback } from "@/lib/eventAgendaPersistence";
import { useMemberGroupSettings } from "@/hooks/useMemberGroupSettings";
import { useServerAdminAuth } from "@/hooks/useServerAdminAuth";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import SEOSettings from "@/components/blog/SEOSettings";
import EventEmailSettingsEditor, {
  createEmptyEmail,
  formatSchedulingFailures,
  formatSkippedSummary,
  findInvalidCcAddresses,
  mapEmailSaveFailureDetails,
  putEventEmails,
} from "@/components/events/EventEmailSettingsEditor";
import UnfurlPreview from "@/components/UnfurlPreview";
import ZoomPolls from "@/components/events/ZoomPolls";

function toLocalDatetimeString(isoOrLocal) {
  if (!isoOrLocal) return '';
  if (!isoOrLocal.includes('Z') && !isoOrLocal.includes('+')) {
    return isoOrLocal.slice(0, 16);
  }
  const d = new Date(isoOrLocal);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  role_ids: [],
  member_group_ids: [],
  is_default: isDefault,
  visibility_mode: 'members_only', // 'members_only', 'members_and_public', or 'public_only'
  role_match_only: false, // When true AND visibility includes members, ticket only shows if user matches role_ids OR member_group_ids
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
  group_cutoff_date: "",
  early_bird_enabled: false,
  early_bird_price: "",
  early_bird_deadline: ""
});

// Tab panels are always mounted; inactive ones are hidden via CSS so that
// in-progress state (uploads, drafts, measurements) survives tab switches.
const TAB_PANEL_CLASS = "mt-0 data-[state=inactive]:hidden";

export default function EditEvent() {
  const queryClient = useQueryClient();
  const { singular: speakerSingular, plural: speakerPlural } = useSpeakerModuleName();
  const { eventTypes } = useEventTypes();
  const { agendaItemTypes } = useAgendaItemTypes();
  // Training event (Task #3419): simple event + multi-day agenda lines
  const [isTraining, setIsTraining] = useState(false);
  const [agendaLines, setAgendaLines] = useState([]);
  const [initialAgendaIds, setInitialAgendaIds] = useState([]);
  // Snapshot of the agenda rows as loaded (or last saved) — used for
  // compensating rollback if a save fails part-way (Task #3512).
  const initialAgendaRowsRef = useRef([]);
  const { ticketTypeName: groupTicketTypeName, featureName: memberGroupFeatureName } = useMemberGroupSettings();
  const urlParams = new URLSearchParams(window.location.search);
  const eventId = urlParams.get('id');

  // Task #1519: Group-limited mode for Group Admins. Entered either via the
  // GroupEvents nav (?group_event=1&group_id=<uuid>) or defensively when the
  // loaded event belongs to a group and the viewer is NOT a tenant admin.
  // Tenant admins always see the full editor unchanged.
  const groupEventParam = urlParams.get('group_event') === '1';
  const groupIdParam = urlParams.get('group_id') || null;
  const fromParam = urlParams.get('from') || null;
  const { isAdmin } = useServerAdminAuth({ redirectOnDeny: false });
  const [groupEventPublic, setGroupEventPublic] = useState(false);

  // Active editor tab (layout only — saving always persists the whole event).
  const [activeTab, setActiveTab] = useState('details');

  // Program vs One-off toggle
  const [isProgramEvent, setIsProgramEvent] = useState(true);
  
  // Online event toggle (controlled state for TBC compatibility)
  const [isOnlineEvent, setIsOnlineEvent] = useState(false);
  
  // Zoom type selection: webinar or meeting
  const [zoomType, setZoomType] = useState("webinar");
  const [selectedMeetingId, setSelectedMeetingId] = useState("");
  
  // Zoom sync status
  const [zoomSyncStatus, setZoomSyncStatus] = useState(null);
  const [checkingSyncStatus, setCheckingSyncStatus] = useState(false);
  const [syncingFromZoom, setSyncingFromZoom] = useState(false);
  
  // Event timezone (fetched from Zoom record or default)
  const [eventTimezone, setEventTimezone] = useState('Europe/London');
  // Reusable change-zoom dialog: { open, mode } — see ChangeZoomDialog.
  // mode is 'attach' | 'change' | 'detach'. Triggered from the always-on
  // Zoom Link admin panel below so admins can edit Zoom at any time, not
  // just when the event is detected as out-of-sync.
  const [zoomLinkDialog, setZoomLinkDialog] = useState({ open: false, mode: 'change' });
  
  // Event timing: published or tbc - affects date requirements
  const [eventTiming, setEventTiming] = useState("published");
  // TBC-only: replace standard booking elements on the public detail page
  const [replaceBookingElements, setReplaceBookingElements] = useState(false);
  const [bookingReplacementMessage, setBookingReplacementMessage] = useState("");
  const [bookingReplacementCtaLabel, setBookingReplacementCtaLabel] = useState("");
  const [bookingReplacementTitle, setBookingReplacementTitle] = useState("");
  // Event state: active, draft, or closed - affects visibility/registration
  const [eventState, setEventState] = useState("active");
  const [isFeatured, setIsFeatured] = useState(false);

  // Unlimited seats toggle
  const [unlimitedSeats, setUnlimitedSeats] = useState(true);
  
  // Per-event seat visibility
  const [showSeatCount, setShowSeatCount] = useState(true);
  const [showTicketAvailability, setShowTicketAvailability] = useState(false);
  const [qrOnConfirmation, setQrOnConfirmation] = useState(true);
  
  // Handler for timing changes - clears TBC-incompatible fields synchronously
  const handleTimingChange = (newTiming) => {
    if (newTiming === 'tbc') {
      // Clear dates, registration deadline and webinar/meeting when switching to TBC (but keep online mode available)
      setSelectedMeetingId("");
      setFormData(prev => ({
        ...prev,
        start_date: '',
        end_date: '',
        registration_closes_at: '',
        zoom_webinar_id: null,
        zoom_meeting_id: null
      }));
    }
    setEventTiming(newTiming);
  };

  const { data: event, isLoading: loadingEvent, error: eventError } = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => base44.entities.Event.get(eventId),
    enabled: !!eventId
  });

  // Derived group-limited state (depends on the loaded event).
  // Any event that belongs to a member group is edited in the reduced/gated
  // group-event UI — including for tenant admins — so the client never offers
  // options (paid tickets, Zoom, group switching) the server rejects for group
  // events. The URL params keep entering directly from the group surfaces fast.
  const groupId = groupIdParam || event?.member_group_id || null;
  const isGroupLimited = (groupEventParam && !!groupIdParam) || !!event?.member_group_id;

  // Resolve the locked group's name for the read-only banner.
  const { data: limitedGroup } = useQuery({
    queryKey: ['/api/entities/MemberGroup', groupId],
    queryFn: () => base44.entities.MemberGroup.get(groupId),
    enabled: isGroupLimited && !!groupId
  });
  const groupName = limitedGroup?.name || '';

  // Ticket classes state for one-off events
  const [ticketClasses, setTicketClasses] = useState([createEmptyTicketClass(true)]);
  const [expandedTickets, setExpandedTickets] = useState({});

  useEffect(() => {
    if (!isGroupLimited) return;
    if (!groupTicketTypeName || groupTicketTypeName === "Standard Ticket") return;
    setTicketClasses((prev) => {
      if (!prev.some((t) => t.is_default && t.name === "Standard Ticket")) return prev;
      return prev.map((t) =>
        t.is_default && t.name === "Standard Ticket" ? { ...t, name: groupTicketTypeName } : t
      );
    });
  }, [isGroupLimited, groupTicketTypeName, ticketClasses]);

  const [allowGuestsToViewAllTickets, setAllowGuestsToViewAllTickets] = useState(false);
  const [collectThirdPartyConsent, setCollectThirdPartyConsent] = useState(false);

  // Email configuration state
  const [eventEmails, setEventEmails] = useState([]);
  const [isSavingEmails, setIsSavingEmails] = useState(false);
  const [isRequeueingEmails, setIsRequeueingEmails] = useState(false);
  const [emailSaveErrors, setEmailSaveErrors] = useState({}); // Per-email inline save errors keyed by email.id

  // Slug state
  const [slug, setSlug] = useState("");
  const [slugError, setSlugError] = useState(null);
  const [checkingSlug, setCheckingSlug] = useState(false);

  // SEO state
  const [seoTitle, setSeoTitle] = useState("");
  const [attachedDocuments, setAttachedDocuments] = useState([]);
  const [documentsSectionTitle, setDocumentsSectionTitle] = useState("");
  const [dietaryOptions, setDietaryOptions] = useState([]);
  const [allergyOptions, setAllergyOptions] = useState([]);
  const [accessibilityOptions, setAccessibilityOptions] = useState([]);
  const [seoDescription, setSeoDescription] = useState("");
  const [ogImageUrl, setOgImageUrl] = useState("");

  const [donationConfig, setDonationConfig] = useState({
    enabled: false,
    preset_amounts: [5, 10, 25, 50],
    allow_custom_amount: true,
    custom_message: '',
    email_list_key: ''
  });
  const [newPresetAmount, setNewPresetAmount] = useState('');

  const [formData, setFormData] = useState({
    title: "",
    summary: "",
    description: "",
    internal_reference: "",
    xero_account_code: "",
    event_type: "",
    program_tag: "",
    start_date: "",
    end_date: "",
    registration_closes_at: "",
    location: "",
    image_url: "",
    image_focal_point: null,
    available_seats: "",
    zoom_webinar_id: null,
    zoom_meeting_id: null,
    online_meeting_url: "",
    budgeted_costs: "",
    budgeted_income: ""
  });

  // State to track if timezone fetch failed
  const [timezoneFetchFailed, setTimezoneFetchFailed] = useState(false);
  const [timezoneResolved, setTimezoneResolved] = useState(false);

  // Fetch timezone from linked Zoom webinar record if event has one
  const { data: linkedZoomWebinar, isLoading: loadingZoomWebinar, isError: errorZoomWebinar } = useQuery({
    queryKey: ['zoom_webinar', event?.zoom_webinar_id],
    queryFn: async () => {
      const response = await fetch(`/api/zoom/webinars/${event.zoom_webinar_id}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch Zoom webinar');
      return response.json();
    },
    enabled: !!event?.zoom_webinar_id,
    retry: 1
  });

  // Fetch timezone from linked Zoom meeting record if event has one
  const { data: linkedZoomMeeting, isLoading: loadingZoomMeeting, isError: errorZoomMeeting } = useQuery({
    queryKey: ['zoom_meeting', event?.zoom_meeting_id],
    queryFn: async () => {
      const response = await fetch(`/api/zoom/meetings/${event.zoom_meeting_id}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch Zoom meeting');
      return response.json();
    },
    enabled: !!event?.zoom_meeting_id && !event?.zoom_webinar_id,
    retry: 1
  });

  // Track if timezone is still loading for Zoom events
  const isTimezoneLoading = (!!event?.zoom_webinar_id && loadingZoomWebinar) || 
                            (!!event?.zoom_meeting_id && !event?.zoom_webinar_id && loadingZoomMeeting);

  // Set event timezone when linked Zoom record loads or from event's stored timezone
  useEffect(() => {
    if (linkedZoomWebinar?.timezone) {
      // For Zoom webinars, use the Zoom timezone
      setEventTimezone(linkedZoomWebinar.timezone);
      setTimezoneResolved(true);
      setTimezoneFetchFailed(false);
    } else if (linkedZoomMeeting?.timezone) {
      // For Zoom meetings, use the Zoom timezone
      setEventTimezone(linkedZoomMeeting.timezone);
      setTimezoneResolved(true);
      setTimezoneFetchFailed(false);
    } else if (errorZoomWebinar || errorZoomMeeting) {
      // Failed to fetch Zoom record, fall back to event's stored timezone or default
      if (event?.timezone) {
        setEventTimezone(event.timezone);
      }
      setTimezoneFetchFailed(true);
      setTimezoneResolved(true);
    } else if (!event?.zoom_webinar_id && !event?.zoom_meeting_id && event) {
      // Non-Zoom event: use event's stored timezone or default to Europe/London
      if (event.timezone) {
        setEventTimezone(event.timezone);
      }
      setTimezoneResolved(true);
    }
  }, [linkedZoomWebinar, linkedZoomMeeting, errorZoomWebinar, errorZoomMeeting, event?.zoom_webinar_id, event?.zoom_meeting_id, event?.timezone]);

  const { data: programs = [], isLoading: loadingPrograms } = useQuery({
    queryKey: ['/api/entities/Program'],
    queryFn: () => base44.entities.Program.list()
  });

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

  // Fetch bookings for this event to count sold tickets per ticket class
  const { data: eventBookings = [] } = useQuery({
    queryKey: ['event-bookings', eventId],
    queryFn: () => base44.entities.Booking.filter({ event_id: eventId }),
    enabled: !!eventId
  });

  // Fetch event email configurations
  const { data: fetchedEventEmails = [], isLoading: loadingEmails } = useQuery({
    queryKey: ['event-emails', eventId],
    queryFn: async () => {
      const response = await fetch(`/api/event-emails/${eventId}`, {
        credentials: 'include'
      });
      if (!response.ok) {
        if (response.status === 404) return [];
        throw new Error('Failed to fetch event emails');
      }
      return response.json();
    },
    enabled: !!eventId
  });

  // Fetch email templates filtered by 'events' category for template loading
  const { data: emailTemplates = [] } = useQuery({
    queryKey: ['/api/entities/EmailTemplate', 'events'],
    queryFn: async () => {
      const allTemplates = await base44.entities.EmailTemplate.list();
      return allTemplates.filter(t => t.category === 'events' && t.is_active);
    }
  });

  // Fetch current tenant for embed code generation
  const { data: currentTenant } = useQuery({
    queryKey: ['current-tenant'],
    queryFn: async () => {
      const response = await fetch('/api/functions/get-current-tenant');
      const data = await response.json();
      return data.tenant;
    },
    staleTime: 60000,
  });

  // Sync fetched emails to state when loaded
  useEffect(() => {
    if (fetchedEventEmails.length > 0 && eventEmails.length === 0) {
      setEventEmails(fetchedEventEmails);
    }
  }, [fetchedEventEmails]);

  // Calculate sold count per ticket class
  const ticketClassSoldCounts = useMemo(() => {
    const counts = {};
    eventBookings.forEach(booking => {
      if (booking.ticket_class_id && booking.status !== 'cancelled') {
        counts[booking.ticket_class_id] = (counts[booking.ticket_class_id] || 0) + 1;
      }
    });
    return counts;
  }, [eventBookings]);

  // Fetch system settings for summary max length
  const { data: systemSettings = [] } = useQuery({
    queryKey: ['/api/entities/SystemSettings'],
    queryFn: () => base44.entities.SystemSettings.list()
  });

  // Get summary max length from settings (default 150)
  const summaryMaxLength = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'event_summary_max_length');
    return setting ? parseInt(setting.setting_value) || 150 : 150;
  }, [systemSettings]);

  // Check if global seat visibility is enabled (defaults to true)
  const globalShowSeats = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'show_event_seats');
    return !setting || setting.setting_value !== 'false';
  }, [systemSettings]);

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

  // Whether dietary/allergy/accessibility collection is enabled tenant-wide (defaults to true)
  const collectAttendeeOptionsEnabled = useMemo(
    () => isAttendeeOptionsCollectionEnabled(systemSettings),
    [systemSettings]
  );

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

  const isDonationGloballyEnabled = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'event_donation_enabled');
    return setting?.setting_value === 'true';
  }, [systemSettings]);

  const { data: communicationCategories = [] } = useQuery({
    queryKey: ['communication-categories'],
    queryFn: () => base44.entities.CommunicationCategory.list({ sort: { display_order: 'asc' } }),
    enabled: isDonationGloballyEnabled,
    retry: 1,
  });

  // For EditEvent, we do NOT auto-apply default VAT to existing tickets
  // They were intentionally set (or left blank) when created/edited
  // Only newly added tickets via addTicketClass will get the default

  // task-696: never silently truncate the loaded summary. The previous
  // trim-on-load effect ran before SystemSettings resolved (default cap
  // 150) and chopped the last N chars off any longer stored summary.
  // The submit-time check + the counter highlight below make admins
  // consciously shorten over-cap legacy values instead.

  useEffect(() => {
    if (!slug) {
      setSlugError(null);
      return;
    }

    const checkSlugUniqueness = async () => {
      setCheckingSlug(true);
      try {
        const response = await fetch(`/api/public/check-event-slug?slug=${encodeURIComponent(slug)}&excludeEventId=${eventId}`);
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
  }, [slug, eventId]);

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
  
  // Selected sponsors state
  const [selectedSponsors, setSelectedSponsors] = useState([]);
  const [sponsorDetails, setSponsorDetails] = useState({});
  const [sponsorsExpanded, setSponsorsExpanded] = useState(false);

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

  // Task #1509: a speaker can be deleted while still referenced by speaker_ids.
  // Split the selection into ids that resolve to an actual (active) speaker and
  // ids that no longer do, so the count stays honest and the admin can clear
  // stale references rather than being stuck with an invisible entry.
  const resolvedSpeakerIds = useMemo(
    () => selectedSpeakers.filter(id => speakers.some(s => s.id === id)),
    [selectedSpeakers, speakers]
  );
  const unresolvedSpeakerIds = useMemo(
    () => (loadingSpeakers ? [] : selectedSpeakers.filter(id => !speakers.some(s => s.id === id))),
    [selectedSpeakers, speakers, loadingSpeakers]
  );

  // Get speaker names for display
  const getSpeakerNames = (speakerIds) => {
    if (!speakerIds || speakerIds.length === 0) return "No speakers selected";
    return speakerIds
      .map(id => speakers.find(s => s.id === id)?.full_name || 'Unknown')
      .join(', ');
  };

  // Rich text editor modules configuration
  const quillModules = useMemo(() => ({
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
  }), []);

  const quillFormats = [
    'header',
    'bold', 'italic', 'underline', 'strike',
    'color', 'background',
    'list', 'bullet', 'indent',
    'align',
    'link'
  ];

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

  // Email configuration helpers now live in the shared
  // EventEmailSettingsEditor component (Task #3263).
  const addEventEmail = (emailType = 'reminder') => {
    setEventEmails([...eventEmails, createEmptyEmail(emailType)]);
  };

  // Clear any prior save error for an email row once the admin edits it.
  const handleEmailRowEdited = (emailId) => {
    setEmailSaveErrors(prev => {
      if (!prev[emailId]) return prev;
      const { [emailId]: _removed, ...rest } = prev;
      return rest;
    });
  };

  const requeueReminders = async () => {
    setIsRequeueingEmails(true);
    try {
      const response = await fetch(`/api/event-emails/${eventId}/reschedule`, {
        method: 'POST',
        credentials: 'include',
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.error || 'Failed to re-queue reminders');
      }
      if (result.schedulingFailures?.length || result.error) {
        toast.error(formatSchedulingFailures(result));
      } else if ((result.requeued || 0) === 0 && result.skipped?.length > 0) {
        toast.error(`No reminders queued — ${formatSkippedSummary(result.skipped)}`);
      } else {
        const skippedSuffix = result.skipped?.length
          ? ` (${formatSkippedSummary(result.skipped)})`
          : '';
        toast.success(`Queued ${result.requeued} reminder(s) for ${result.bookingsScheduled} booking(s)${skippedSuffix}`);
      }
      queryClient.invalidateQueries({ queryKey: ['event-emails', eventId] });
    } catch (err) {
      console.error('Re-queue reminders error:', err);
      toast.error(err.message || 'Failed to re-queue reminders');
    } finally {
      setIsRequeueingEmails(false);
    }
  };

  const saveEventEmails = async () => {
    const invalidCc = findInvalidCcAddresses(eventEmails);
    if (invalidCc.length > 0) {
      toast.error(`Invalid CC email address: ${invalidCc.join(', ')}`);
      return;
    }
    setEmailSaveErrors({});
    setIsSavingEmails(true);
    const requestEmails = eventEmails;
    try {
      const { response, result } = await putEventEmails(eventId, requestEmails);

      if (response.ok) {
        const savedFromOk = Array.isArray(result)
          ? result
          : (Array.isArray(result?.savedEmails) ? result.savedEmails : []);
        if (savedFromOk.length > 0) {
          setEventEmails(savedFromOk);
        } else if (savedFromOk.length === 0 && requestEmails.length > 0) {
          throw new Error('Server returned empty response — emails may not have been saved');
        }
        queryClient.invalidateQueries({ queryKey: ['event-emails', eventId] });
        const scheduling = !Array.isArray(result) ? result : null;
        const failures = scheduling?.schedulingFailures || [];
        const skipped = scheduling?.skipped || [];
        const schedulerError = scheduling?.schedulerError || scheduling?.error;
        if (failures.length > 0 || schedulerError) {
          toast.error(`Saved, but ${formatSchedulingFailures({ schedulingFailures: failures, error: schedulerError })}`);
        } else if (skipped.length > 0) {
          toast.success(`Email configurations saved (${formatSkippedSummary(skipped)})`);
        } else {
          toast.success('Email configurations saved');
        }
        return;
      }

      // Failure path. The API returns { error, details: [{email_type, error, request_index}], savedEmails }
      // when one or more rows fail to insert/update. Each `details` entry includes the
      // `request_index` (position in the PUT body) so we can map errors back to rows
      // deterministically — even when multiple rows share the same `email_type`.
      const details = Array.isArray(result?.details) ? result.details : [];
      const savedEmails = Array.isArray(result?.savedEmails) ? result.savedEmails : [];

      if (details.length > 0) {
        const { errMap, failedIndexes } = mapEmailSaveFailureDetails(details, requestEmails);
        setEmailSaveErrors(errMap);

        // Merge any successfully-saved rows back in. The API loop processes emails in
        // request order and pushes successes to `savedEmails` in that same order, so
        // walking the non-failed request rows lines up exactly with `savedEmails`.
        if (savedEmails.length > 0 && failedIndexes.size > 0) {
          let savedCursor = 0;
          setEventEmails(prev => prev.map((e, i) => {
            if (failedIndexes.has(i)) return e;
            const saved = savedEmails[savedCursor++];
            return saved ? { ...saved } : e;
          }));
        }

        const total = requestEmails.length;
        const failed = details.length;
        toast.error(
          `${failed} of ${total} email${total === 1 ? '' : 's'} failed to save — see details below`
        );
      } else {
        toast.error(result?.error || 'Failed to save email configurations');
      }
    } catch (error) {
      console.error('Error saving emails:', error);
      toast.error(error.message || 'Failed to save email configurations');
    } finally {
      setIsSavingEmails(false);
    }
  };

  // Query for webinar show join link settings (for online events)
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
    }
  });

  // Check if location has visible join link (starts with "Online - https")
  const hasVisibleJoinLink = formData.location?.startsWith('Online - ');
  
  // Extract the URL from location if it's an online event with visible join link
  const getJoinUrlFromLocation = () => {
    if (hasVisibleJoinLink) {
      return formData.location.replace('Online - ', '');
    }
    return null;
  };

  const updateEventMutation = useMutation({
    mutationFn: async (eventData) => {
      // Agenda applies to any regular event (Tasks #3419, #3512). Agenda
      // mutations run FIRST with compensating rollback on failure, and the
      // parent event update only runs once the agenda saved cleanly — so a
      // failure on either side never leaves a half-committed save. Persist in
      // chronological order (Task #3443) so sort_order always reflects the
      // real sequence regardless of entry/drag order.
      const orderedLines = sortAgendaLinesChronologically(agendaLines);
      const buildAgendaPayload = (line, sortOrder) => {
        const behaviour = agendaTypeBehaviour(line.item_type, agendaItemTypes);
        return {
          event_id: eventId,
          start_date: line.start_date,
          start_time: normalizeAgendaTime(line.start_time) || null,
          end_date: line.end_date || line.start_date,
          end_time: normalizeAgendaTime(line.end_time) || null,
          description: line.description || null,
          item_type: line.item_type || null,
          location: behaviour === 'location' ? (line.location || null) : null,
          zoom_webinar_id: behaviour === 'zoom' ? (line.zoom_webinar_id || null) : null,
          zoom_meeting_id: behaviour === 'zoom' ? (line.zoom_meeting_id || null) : null,
          lms_url: behaviour === 'lms' ? (line.lms_url || null) : null,
          speaker_ids: Array.isArray(line.speaker_ids) ? line.speaker_ids.filter(Boolean) : [],
          sponsor_ids: Array.isArray(line.sponsor_ids) ? line.sponsor_ids.filter(Boolean) : [],
          sort_order: sortOrder,
        };
      };

      let agendaResult;
      try {
        agendaResult = await persistAgendaLinesWithRollback({
          api: {
            create: (payload) => base44.entities.EventAgendaItem.create(payload),
            update: (id, payload) => base44.entities.EventAgendaItem.update(id, payload),
            delete: (id) => base44.entities.EventAgendaItem.delete(id),
          },
          orderedLines,
          initialRows: initialAgendaRowsRef.current || [],
          buildPayload: buildAgendaPayload,
        });
      } catch (agendaErr) {
        console.error('Failed to save agenda lines:', agendaErr);
        // The event itself was not updated. Rollback of agenda mutations is
        // best-effort (no server transaction) — be honest about the outcome.
        const rollbackIncomplete = (agendaErr?.rollbackFailures || []).length > 0;
        const wrapped = new Error(
          'the event agenda could not be saved and the event was not updated'
          + (rollbackIncomplete
            ? ' — some agenda changes could not be automatically rolled back, so please reload the page and review the agenda before saving again'
            : ' — the agenda changes were rolled back; please reload the page to verify, then try again')
          + ' (' + (agendaErr?.message || 'unknown error') + ')'
        );
        wrapped.cause = agendaErr;
        throw wrapped;
      }

      let updated;
      try {
        updated = await base44.entities.Event.update(eventId, eventData);
      } catch (updateErr) {
        // Parent update failed after the agenda saved — best-effort revert of
        // the agenda so the event and its agenda stay consistent. Surface
        // incomplete rollback to the user rather than hiding it.
        let undoFailures = [];
        try { undoFailures = await agendaResult.undo(); } catch (undoErr) {
          console.error('Failed to revert agenda after event update failure:', undoErr);
          undoFailures = [{ op: 'undo', reason: undoErr?.message || 'unknown error' }];
        }
        if (undoFailures.length > 0) {
          const wrapped = new Error(
            (updateErr?.message || 'the event could not be updated')
            + ' — additionally, some agenda changes could not be automatically rolled back; please reload the page and review the agenda'
          );
          wrapped.cause = updateErr;
          throw wrapped;
        }
        throw updateErr;
      }

      setInitialAgendaIds(agendaResult.savedIds);
      // Reconcile local state with what was persisted: newly created lines
      // get their server id (per-line via persistedLines, never by index into
      // the filtered savedIds) so a subsequent save updates instead of
      // re-creating duplicates.
      setAgendaLines((current) => current.map((line) => {
        if (line.id) return line;
        // persistedLines[i] corresponds to orderedLines[i] (same references
        // for pre-existing objects), so map each new line via its position.
        const idx = orderedLines.indexOf(line);
        const persisted = idx >= 0 ? agendaResult.persistedLines[idx] : null;
        return persisted?.id ? { ...line, id: persisted.id } : line;
      }));
      // Refresh the rollback snapshot from the persisted lines — keep only the
      // persisted fields (via the payload builder) plus the server id, so no
      // local-only keys leak into the snapshot.
      initialAgendaRowsRef.current = agendaResult.persistedLines.map((line, i) => {
        const { event_id: _evt, sort_order: _sort, ...fields } = buildAgendaPayload(line, i);
        return { id: line.id, ...fields };
      }).filter((r) => r.id);
      queryClient.invalidateQueries({ queryKey: ['/api/entities/EventAgendaItem'] });

      return updated;
    },
    onError: (error) => {
      console.error('Update event error:', error, {
        method: error?.method,
        path: error?.path,
        status: error?.status,
      });
      const errorMessage = error.message || error.error || 'Unknown error occurred';
      const reqDetail = error?.method && error?.path
        ? ` (${error.method} ${error.path}${error?.status ? ` → ${error.status}` : ''})`
        : '';
      toast.error('Failed to update event: ' + errorMessage + reqDetail);
    }
  });

  // Track if initial data has been loaded to prevent re-populating after user changes
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);
  
  useEffect(() => {
    if (event && !initialDataLoaded) {
      // For TBC events, don't populate dates or zoom_webinar_id
      const isTbcEvent = event.status === 'tbc';
      setFormData({
        title: event.title || "",
        summary: event.summary || "",
        description: event.description || "",
        internal_reference: event.internal_reference || "",
        xero_account_code: event.xero_account_code || "",
        event_type: parseEventTypes(event.event_type),
        program_tag: event.program_tag || "",
        start_date: isTbcEvent ? "" : (event.start_date || ""),
        end_date: isTbcEvent ? "" : (event.end_date || ""),
        registration_closes_at: event.registration_closes_at || "",
        location: event.location || "",
        image_url: event.image_url || "",
        image_focal_point: event.image_focal_point || null,
        // Only show available_seats if it's a positive number (limited seats), otherwise treat as unlimited
        available_seats: event.available_seats !== null && event.available_seats !== undefined && event.available_seats > 0
          ? String(event.available_seats) 
          : "",
        zoom_webinar_id: event.zoom_webinar_id || null,
        zoom_meeting_id: event.zoom_meeting_id || null,
        online_meeting_url: event.online_meeting_url || "",
        cta_override_url: event.cta_override_url || "",
        cta_override_mode: event.cta_override_mode || "card",
        cta_button_label: event.cta_button_label || "",
        budgeted_costs: event.budgeted_costs != null ? String(event.budgeted_costs) : "",
        budgeted_income: event.budgeted_income != null ? String(event.budgeted_income) : ""
      });

      // TBC booking-element replacement fields
      setReplaceBookingElements(event.replace_booking_elements === true);
      setBookingReplacementMessage(event.booking_replacement_message || "");
      setBookingReplacementCtaLabel(event.booking_replacement_cta_label || "");
      setBookingReplacementTitle(event.booking_replacement_title || "");

      // Load the group audience choice (group-limited mode).
      setGroupEventPublic(event.group_event_public === true);

      // Load the agenda lines for any regular event (Tasks #3419, #3512) —
      // agenda is no longer training-only.
      setIsTraining(event.is_training === true);
      {
        base44.entities.EventAgendaItem.list({ filter: { event_id: event.id } })
          .then((rows) => {
            // Chronological display regardless of stored sort_order (legacy
            // rows may have been saved out of sequence — Task #3443).
            const sorted = sortAgendaLinesChronologically(
              (rows || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
            );
            setAgendaLines(sorted.map((r) => ({
              id: r.id,
              start_date: r.start_date || '',
              end_date: r.end_date && r.end_date !== r.start_date ? r.end_date : '',
              start_time: normalizeAgendaTime(r.start_time),
              end_time: normalizeAgendaTime(r.end_time),
              description: r.description || '',
              item_type: r.item_type || '',
              location: r.location || '',
              zoom_webinar_id: r.zoom_webinar_id || null,
              zoom_meeting_id: r.zoom_meeting_id || null,
              lms_url: r.lms_url || '',
              speaker_ids: Array.isArray(r.speaker_ids) ? r.speaker_ids : [],
              sponsor_ids: Array.isArray(r.sponsor_ids) ? r.sponsor_ids : [],
            })));
            setInitialAgendaIds(sorted.map((r) => r.id));
            initialAgendaRowsRef.current = sorted.map((r) => ({
              id: r.id,
              start_date: r.start_date || '',
              end_date: r.end_date && r.end_date !== r.start_date ? r.end_date : '',
              start_time: normalizeAgendaTime(r.start_time),
              end_time: normalizeAgendaTime(r.end_time),
              description: r.description || '',
              item_type: r.item_type || '',
              location: r.location || '',
              zoom_webinar_id: r.zoom_webinar_id || null,
              zoom_meeting_id: r.zoom_meeting_id || null,
              lms_url: r.lms_url || '',
              speaker_ids: Array.isArray(r.speaker_ids) ? r.speaker_ids : [],
              sponsor_ids: Array.isArray(r.sponsor_ids) ? r.sponsor_ids : [],
            }));
          })
          .catch((err) => {
            console.error('Failed to load agenda lines:', err);
            toast.error('Failed to load the training agenda');
          });
      }

      // Set zoom type based on which field is populated
      if (event.zoom_meeting_id) {
        setZoomType("meeting");
        setSelectedMeetingId(event.zoom_meeting_id);
      } else if (event.zoom_webinar_id) {
        setZoomType("webinar");
      }
      
      // Set unlimited seats based on explicit is_unlimited_registration field (preferred)
      // Fallback to old logic for events without the new field
      if (event.is_unlimited_registration === true) {
        setUnlimitedSeats(true);
      } else if (event.is_unlimited_registration === false) {
        setUnlimitedSeats(false);
      } else {
        // Legacy fallback: null available_seats = unlimited
        setUnlimitedSeats(event.available_seats === null);
      }
      
      // Set per-event seat visibility (default to true if not set)
      setShowSeatCount(event.show_seat_count !== false);
      
      // Set per-event ticket availability visibility (default to false if not set)
      setShowTicketAvailability(event.show_ticket_availability === true);
      
      // Set per-event entrance QR on confirmation (default to true if not set)
      setQrOnConfirmation(event.qr_on_confirmation !== false);
      
      setSlug(event.slug || "");
      setSeoTitle(event.seo_title || "");
      setSeoDescription(event.seo_description || "");
      setOgImageUrl(event.og_image_url || "");
      setAttachedDocuments(Array.isArray(event.attached_documents) ? event.attached_documents : []);
      setDocumentsSectionTitle(event.documents_section_title || "");
      setDietaryOptions(Array.isArray(event.dietary_options) ? event.dietary_options : []);
      setAllergyOptions(Array.isArray(event.allergy_options) ? event.allergy_options : []);
      setAccessibilityOptions(Array.isArray(event.accessibility_options) ? event.accessibility_options : []);
      setInitialDataLoaded(true);

      if (event.donation_config) {
        setDonationConfig({
          enabled: event.donation_config.enabled || false,
          preset_amounts: event.donation_config.preset_amounts || [5, 10, 25, 50],
          allow_custom_amount: event.donation_config.allow_custom_amount !== false,
          custom_message: event.donation_config.custom_message || '',
          email_list_key: event.donation_config.email_list_key || ''
        });
      }

      // Set isProgramEvent based on whether event has a program_tag
      const hasProgram = event.program_tag && event.program_tag !== "";
      setIsProgramEvent(hasProgram);

      // Load pricing config for one-off events
      if (event.pricing_config) {
        const config = event.pricing_config;
        
        // Check if using new ticket_classes format or legacy single-price format
        if (config.ticket_classes && Array.isArray(config.ticket_classes) && config.ticket_classes.length > 0) {
          // New ticket classes format
          const loadedTickets = config.ticket_classes.map(tc => {
            const priceValue = tc.price !== null && tc.price !== undefined ? Number(tc.price) : null;
            // Handle backwards compatibility: convert is_public to visibility_mode
            let visibilityMode = tc.visibility_mode;
            if (!visibilityMode) {
              // Legacy tickets: if is_public was true, treat as 'members_and_public', otherwise 'members_only'
              // Handle various truthy/falsy representations of is_public (string "true"/"false", number 1/0, boolean)
              const isPublicValue = tc.is_public;
              const isPublicBool = isPublicValue === true || isPublicValue === 1 || isPublicValue === 'true' || isPublicValue === '1';
              visibilityMode = isPublicBool ? 'members_and_public' : 'members_only';
            }
            return {
              id: tc.id || `ticket-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              name: tc.name || (isGroupLimited ? groupTicketTypeName : "Standard Ticket"),
              price: priceValue !== null ? String(priceValue) : "",
              is_free: priceValue === 0,
              role_ids: tc.role_ids || [],
              member_group_ids: Array.isArray(tc.member_group_ids) ? tc.member_group_ids : [],
              is_default: tc.is_default || false,
              visibility_mode: visibilityMode,
              role_match_only: tc.role_match_only || false,
              offer_type: tc.offer_type || "none",
              bogo_logic_type: tc.bogo_logic_type || "buy_x_get_y_free",
              bogo_buy_quantity: tc.bogo_buy_quantity !== null && tc.bogo_buy_quantity !== undefined 
                ? String(tc.bogo_buy_quantity) : "",
              bogo_get_free_quantity: tc.bogo_get_free_quantity !== null && tc.bogo_get_free_quantity !== undefined 
                ? String(tc.bogo_get_free_quantity) : "",
              bulk_discount_threshold: tc.bulk_discount_threshold !== null && tc.bulk_discount_threshold !== undefined 
                ? String(tc.bulk_discount_threshold) : "",
              bulk_discount_percentage: tc.bulk_discount_percentage !== null && tc.bulk_discount_percentage !== undefined 
                ? String(tc.bulk_discount_percentage) : "",
              // Ticket availability: null = unlimited
              available_count: tc.available_count !== null && tc.available_count !== undefined 
                ? String(tc.available_count) : "",
              is_unlimited_tickets: tc.available_count === null || tc.available_count === undefined || tc.is_unlimited_tickets === true,
              // VAT rate fields for Xero invoice generation
              vat_rate_key: tc.vat_rate_key || null,
              vat_rate_label: tc.vat_rate_label || null,
              vat_rate_percentage: tc.vat_rate_percentage || null,
              is_group_ticket: tc.is_group_ticket || false,
              group_size: tc.group_size !== null && tc.group_size !== undefined ? String(tc.group_size) : "",
              group_cutoff_date: tc.group_cutoff_date || "",
              early_bird_enabled: tc.early_bird_enabled || false,
              early_bird_price: tc.early_bird_price !== null && tc.early_bird_price !== undefined ? String(tc.early_bird_price) : "",
              early_bird_deadline: tc.early_bird_deadline ? toLocalDatetimeString(tc.early_bird_deadline) : ""
            };
          });
          setTicketClasses(loadedTickets);
          // Expand first ticket by default
          if (loadedTickets.length > 0) {
            setExpandedTickets({ [loadedTickets[0].id]: true });
          }
        } else {
          // Legacy single-price format - convert to ticket class
          const legacyPrice = config.ticket_price !== null && config.ticket_price !== undefined 
            ? Number(config.ticket_price) : null;
          const legacyTicket = {
            id: `ticket-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            name: isGroupLimited ? groupTicketTypeName : "Standard Ticket",
            price: legacyPrice !== null ? String(legacyPrice) : "",
            is_free: legacyPrice === 0,
            role_ids: [],
            member_group_ids: [],
            is_default: true,
            visibility_mode: 'members_only',
            role_match_only: false,
            offer_type: config.offer_type || "none",
            bogo_logic_type: config.bogo_logic_type || "buy_x_get_y_free",
            bogo_buy_quantity: config.bogo_buy_quantity !== null && config.bogo_buy_quantity !== undefined 
              ? String(config.bogo_buy_quantity) : "",
            bogo_get_free_quantity: config.bogo_get_free_quantity !== null && config.bogo_get_free_quantity !== undefined 
              ? String(config.bogo_get_free_quantity) : "",
            bulk_discount_threshold: config.bulk_discount_threshold !== null && config.bulk_discount_threshold !== undefined 
              ? String(config.bulk_discount_threshold) : "",
            bulk_discount_percentage: config.bulk_discount_percentage !== null && config.bulk_discount_percentage !== undefined 
              ? String(config.bulk_discount_percentage) : "",
            available_count: "",
            is_unlimited_tickets: true,
            // VAT rate fields (not present in legacy format)
            vat_rate_key: null,
            vat_rate_label: null,
            vat_rate_percentage: null
          };
          setTicketClasses([legacyTicket]);
          setExpandedTickets({ [legacyTicket.id]: true });
        }
        
        // Load allowGuestsToViewAllTickets setting
        setAllowGuestsToViewAllTickets(config.allowGuestsToViewAllTickets || false);
        setCollectThirdPartyConsent(config.collectThirdPartyConsent === true);
      }

      // Task #3285: load speaker award config
      setSpeakerAwards(configToFormState(event.speaker_award_config));

      // Load speaker_ids from event
      if (event.speaker_ids && Array.isArray(event.speaker_ids)) {
        setSelectedSpeakers(event.speaker_ids);
      } else {
        setSelectedSpeakers([]);
      }

      // Load sponsor assignments
      base44.entities.EventSponsorAssignment.list({ filter: { event_id: event.id, event_type: 'simple' } })
        .then(assignments => {
          setSelectedSponsors(assignments.map(a => a.sponsor_id).filter(Boolean));
          const details = {};
          assignments.forEach(a => { if (a.sponsor_id && a.sponsorship_detail) details[a.sponsor_id] = a.sponsorship_detail; });
          setSponsorDetails(details);
        })
        .catch(e => { console.error('Failed to load sponsor assignments:', e); setSelectedSponsors([]); setSponsorDetails({}); });
      
      setIsFeatured(event.is_featured === true);

      // Load timing and state from event with migration for old status values
      // Old values: draft, published, tbc, closed -> New: timing (published/tbc) + state (active/draft/closed)
      const oldStatus = event.status || 'published';
      if (oldStatus === 'draft') {
        setEventTiming('published');
        setEventState('draft');
      } else if (oldStatus === 'closed') {
        setEventTiming('published');
        setEventState('closed');
      } else if (oldStatus === 'tbc') {
        setEventTiming('tbc');
        setEventState(event.event_state || 'active');
      } else {
        // published or any new timing value
        setEventTiming(oldStatus);
        setEventState(event.event_state || 'active');
      }
    }
  }, [event?.id, initialDataLoaded]);

  // Check Zoom sync status when event is loaded and has a Zoom link
  const checkZoomSyncStatus = async () => {
    if (!eventId) return;
    
    setCheckingSyncStatus(true);
    try {
      const response = await fetch(`/api/zoom/check-event-sync?eventId=${eventId}`, {
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        setZoomSyncStatus(data);
        // Set the event timezone from the Zoom record
        if (data.zoomTimezone) {
          setEventTimezone(data.zoomTimezone);
        }
      } else {
        console.error('Failed to check Zoom sync status');
        setZoomSyncStatus(null);
      }
    } catch (error) {
      console.error('Error checking Zoom sync:', error);
      setZoomSyncStatus(null);
    } finally {
      setCheckingSyncStatus(false);
    }
  };

  const syncFromZoom = async () => {
    if (!eventId) return;
    
    setSyncingFromZoom(true);
    try {
      const response = await fetch('/api/zoom/sync-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ eventId })
      });
      
      if (response.ok) {
        const data = await response.json();
        toast.success('Event synced with Zoom');
        
        // Update form data with synced times
        setFormData(prev => ({
          ...prev,
          start_date: data.updated.start_date,
          end_date: data.updated.end_date
        }));
        
        // Refresh sync status
        await checkZoomSyncStatus();
        
        // Invalidate event query to refresh data
        queryClient.invalidateQueries({ queryKey: ['event', eventId] });
      } else {
        const errorData = await response.json();
        toast.error('Failed to sync: ' + (errorData.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Error syncing from Zoom:', error);
      toast.error('Failed to sync with Zoom');
    } finally {
      setSyncingFromZoom(false);
    }
  };

  // Check sync status when event loads and has a Zoom link
  useEffect(() => {
    if (initialDataLoaded && isOnlineEvent && eventId) {
      checkZoomSyncStatus();
    }
  }, [initialDataLoaded, isOnlineEvent, eventId]);
  
  // Separate effect for filter tags - needs to run when categories load
  // This is outside the initialDataLoaded guard so it can run when categories arrive
  const [filterTagsInitialized, setFilterTagsInitialized] = useState(false);
  useEffect(() => {
    if (event && eventCategories.length > 0 && !filterTagsInitialized) {
      // Load filter_tags from event - normalize legacy tags to composite key format
      if (event.filter_tags && Array.isArray(event.filter_tags) && event.filter_tags.length > 0) {
        const normalizedTags = normalizeFilterTags(event.filter_tags, eventCategories);
        setSelectedFilterTags(normalizedTags);
      } else {
        setSelectedFilterTags([]);
      }
      setFilterTagsInitialized(true);
    }
  }, [event?.filter_tags, eventCategories, filterTagsInitialized]);

  // Initialize isOnlineEvent state from event data on load
  // The state is now controlled to support TBC status changes
  // Only initialize once when event loads, and don't override if user switched to TBC
  const [isOnlineInitialized, setIsOnlineInitialized] = useState(false);
  useEffect(() => {
    if (event && !isOnlineInitialized) {
      // Don't set isOnline if event is TBC status
      if (event.status === 'tbc') {
        setIsOnlineEvent(false);
      } else {
        const isOnline = event.is_online === true || 
          (event.is_online === undefined && (
            formData.location?.toLowerCase().includes('online') || 
            formData.location?.includes('zoom.us') ||
            formData.location?.includes('https://')
          ));
        setIsOnlineEvent(isOnline);
      }
      setIsOnlineInitialized(true);
    }
  }, [event?.id, isOnlineInitialized]); // Only run when event changes and not yet initialized

  // One-off event is when isProgramEvent is false
  const isOneOffEvent = !isProgramEvent;

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

  // Training events (Task #3436): the overall start/end are derived from the
  // agenda (earliest start → latest end), shown read-only in the date fields.
  const trainingDerivedDates = useMemo(() => {
    if (!isTraining || agendaLines.length === 0) return null;
    const starts = agendaLines.map(agendaLineStartDateTime).filter(Boolean).sort();
    const ends = agendaLines.map(agendaLineEndDateTime).filter(Boolean).sort();
    if (starts.length === 0) return null;
    return { start: starts[0], end: ends[ends.length - 1] };
  }, [isTraining, agendaLines]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Guard against double-submit while a clash check is already running.
    if (checkingClashes) return;

    // Only require program_tag for program events
    if (!isOneOffEvent && !formData.program_tag) {
      toast.error('Please select a program');
      return;
    }
    
    // Only require start_date for non-TBC events. Training events derive their
    // start/end dates from the agenda lines instead (Task #3419).
    if (eventTiming !== 'tbc' && !formData.start_date && !isTraining) {
      toast.error('Please set a start date');
      return;
    }

    // Training events: validate the agenda lines (at least one line, dates,
    // and the type-conditional location / webinar-meeting / LMS fields).
    // Non-training events may carry an optional agenda (Task #3512) —
    // validate only when lines exist.
    if (isTraining || agendaLines.length > 0) {
      const agendaErrors = validateAgendaLines(agendaLines, agendaItemTypes);
      if (agendaErrors.length > 0) {
        toast.error(agendaErrors[0]);
        return;
      }
    }

    if (!formData.title || !formData.title.trim()) {
      toast.error('Please enter an event title');
      return;
    }

    // Group-limited online events collect a raw meeting link; the input is
    // type="url" but native validation is disabled (noValidate) because
    // inactive tab panels are hidden, so replicate the URL format check here.
    if (isGroupLimited && isOnlineEvent && formData.online_meeting_url) {
      let validMeetingUrl = false;
      try {
        const u = new URL(formData.online_meeting_url);
        validMeetingUrl = u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        validMeetingUrl = false;
      }
      if (!validMeetingUrl) {
        toast.error('Please enter a valid meeting link (e.g. https://meet.example.com/your-meeting)');
        return;
      }
    }

    // Summary length validation
    if (formData.summary && formData.summary.length > summaryMaxLength) {
      toast.error(`Summary exceeds the maximum length of ${summaryMaxLength} characters`);
      return;
    }

    // Validation for one-off event ticket classes
    if (isOneOffEvent) {
      if (ticketClasses.length === 0) {
        toast.error('Please add at least one ticket class');
        return;
      }

      for (let i = 0; i < ticketClasses.length; i++) {
        const ticket = ticketClasses[i];
        const ticketLabel = ticket.name || `Ticket ${i + 1}`;

        if (!ticket.name || ticket.name.trim() === "") {
          toast.error(`Please enter a name for ${ticketLabel}`);
          return;
        }

        // Price validation: either is_free must be true, or price must be > 0
        if (!ticket.is_free) {
          if (ticket.price === "" || ticket.price === null || ticket.price === undefined) {
            toast.error(`Please enter a price for "${ticket.name}" or mark it as free`);
            return;
          }
          const price = parseFloat(ticket.price);
          if (isNaN(price) || price <= 0) {
            toast.error(`Price for "${ticket.name}" must be greater than zero, or mark the ticket as free`);
            return;
          }
        }

        if (ticket.offer_type === "bogo") {
          if (!ticket.bogo_buy_quantity || !ticket.bogo_get_free_quantity) {
            toast.error(`Please enter BOGO quantities for "${ticket.name}"`);
            return;
          }
          const buyQty = parseInt(ticket.bogo_buy_quantity);
          const freeQty = parseInt(ticket.bogo_get_free_quantity);
          if (isNaN(buyQty) || buyQty < 1 || isNaN(freeQty) || freeQty < 1) {
            toast.error(`BOGO quantities for "${ticket.name}" must be positive integers`);
            return;
          }
        }

        if (ticket.offer_type === "bulk_discount") {
          if (!ticket.bulk_discount_threshold || !ticket.bulk_discount_percentage) {
            toast.error(`Please enter bulk discount settings for "${ticket.name}"`);
            return;
          }
          const threshold = parseInt(ticket.bulk_discount_threshold);
          const percentage = parseFloat(ticket.bulk_discount_percentage);
          if (isNaN(threshold) || threshold < 2) {
            toast.error(`Bulk threshold for "${ticket.name}" must be at least 2`);
            return;
          }
          if (isNaN(percentage) || percentage < 0 || percentage > 100) {
            toast.error(`Bulk percentage for "${ticket.name}" must be between 0 and 100`);
            return;
          }
        }

        if (ticket.is_group_ticket) {
          const groupSize = parseInt(ticket.group_size);
          if (!ticket.group_size || isNaN(groupSize) || groupSize < 2) {
            toast.error(`Group size for "${ticket.name}" must be at least 2`);
            return;
          }
        }

        if (ticket.early_bird_enabled) {
          const ebPrice = parseFloat(ticket.early_bird_price);
          if (!ticket.early_bird_price || isNaN(ebPrice) || ebPrice <= 0) {
            toast.error(`Early bird price for "${ticket.name}" must be greater than zero`);
            return;
          }
          const stdPrice = parseFloat(ticket.price);
          if (!isNaN(stdPrice) && ebPrice >= stdPrice) {
            toast.error(`Early bird price for "${ticket.name}" must be less than the standard price (£${stdPrice})`);
            return;
          }
          if (!ticket.early_bird_deadline) {
            toast.error(`Please set an early bird deadline for "${ticket.name}"`);
            return;
          }
          if (new Date(ticket.early_bird_deadline) <= new Date()) {
            toast.error(`Early bird deadline for "${ticket.name}" must be in the future`);
            return;
          }
        }

        // Validate ticket availability is not reduced below sold count
        if (!ticket.is_unlimited_tickets && ticket.available_count !== undefined && ticket.available_count !== "") {
          const soldCount = ticketClassSoldCounts[ticket.id] || 0;
          const availableCount = parseInt(ticket.available_count);
          if (!isNaN(availableCount) && availableCount < soldCount) {
            toast.error(`Cannot reduce availability for "${ticket.name}" below ${soldCount} (tickets already sold)`);
            return;
          }
        }
      }
    }

    // Validate seats when unlimited is off
    if (!unlimitedSeats) {
      const seats = parseInt(formData.available_seats);
      if (!formData.available_seats || isNaN(seats) || seats < 1) {
        toast.error('Please enter a valid number of seats (or enable "Unlimited")');
        return;
      }
    }

    // Validate registration_closes_at is not after end_date
    if (formData.registration_closes_at && formData.end_date) {
      if (new Date(formData.registration_closes_at) > new Date(formData.end_date)) {
        toast.error('Registration close date cannot be after the event end date');
        return;
      }
    }

    // For TBC events, explicitly null out dates and Zoom webinar
    const isTbcEvent = eventTiming === 'tbc';

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
    
    if (slugError || checkingSlug) {
      toast.error(slugError || 'Please wait while the URL slug is being verified');
      return;
    }

    const eventData = {
      title: formData.title,
      slug: slug || null,
      summary: formData.summary || null,
      description: formData.description || null,
      internal_reference: formData.internal_reference || null,
      xero_account_code: isGroupLimited ? null : (formData.xero_account_code || null),
      event_type: serializeEventTypes(formData.event_type),
      // For one-off events, program_tag should be empty string; for program events, use the selected program
      // Visibility is determined by program_tag: empty = one-off event, non-empty = program event
      program_tag: isOneOffEvent ? "" : formData.program_tag,
      is_training: isTraining,
      // For TBC events, dates must be null. Training events span their agenda.
      start_date: isTbcEvent ? null : (isTraining && trainingStart ? trainingStart : (formData.start_date || null)),
      end_date: isTbcEvent ? null : (isTraining && trainingEnd ? trainingEnd : (formData.end_date || formData.start_date || null)),
      registration_closes_at: formData.registration_closes_at || null,
      location: (isOnlineEvent || isTraining) ? null : (formData.location || null),
      image_url: formData.image_url || null,
      image_focal_point: formData.image_focal_point || null,
      available_seats: unlimitedSeats ? null : (formData.available_seats ? parseInt(formData.available_seats) : null),
      is_unlimited_registration: unlimitedSeats,
      // Per-event seat visibility (only meaningful when global setting is ON)
      show_seat_count: showSeatCount,
      // Per-event ticket availability display toggle
      show_ticket_availability: showTicketAvailability,
      // Per-event entrance QR on confirmation emails (only meaningful for in-person events)
      qr_on_confirmation: isOnlineEvent ? false : qrOnConfirmation,
      // TBC events can optionally have a Zoom webinar or meeting.
      // Group-limited events never use Zoom — they use a manual meeting link.
      zoom_webinar_id: isGroupLimited ? null : (zoomType === 'webinar' ? (formData.zoom_webinar_id || null) : null),
      zoom_meeting_id: isGroupLimited ? null : (zoomType === 'meeting' ? (selectedMeetingId || null) : null),
      speaker_ids: selectedSpeakers.length > 0 ? selectedSpeakers : [],
      speaker_award_config: formStateToConfig(speakerAwards),
      // Convert composite keys back to plain labels for database storage
      filter_tags: selectedFilterTags.length > 0 
        ? selectedFilterTags.map(key => parseFilterTagKey(key).label) 
        : [],
      cta_override_url: formData.cta_override_url || null,
      cta_override_mode: formData.cta_override_mode || 'card',
      cta_button_label: (formData.cta_button_label || '').trim() || null,
      // TBC events can still be online, but webinar is optional
      is_online: isOnlineEvent,
      status: eventTiming,
      // TBC-only booking-element replacement (persisted regardless of timing;
      // it only applies on the public page when status === 'tbc')
      replace_booking_elements: replaceBookingElements === true,
      booking_replacement_message: bookingReplacementMessage.trim() || null,
      booking_replacement_cta_label: bookingReplacementCtaLabel.trim() || null,
      booking_replacement_title: bookingReplacementTitle.trim() || null,
      event_state: eventState,
      is_featured: isFeatured,
      timezone: eventTimezone,
      donation_config: isDonationGloballyEnabled ? donationConfig : undefined,
      seo_title: seoTitle || null,
      seo_description: seoDescription || null,
      og_image_url: ogImageUrl || null,
      attached_documents: attachedDocuments,
      documents_section_title: documentsSectionTitle.trim() || null,
      dietary_options: dietaryOptions.map((o) => (o || "").trim()).filter(Boolean),
      allergy_options: allergyOptions.map((o) => (o || "").trim()).filter(Boolean),
      accessibility_options: accessibilityOptions.map((o) => (o || "").trim()).filter(Boolean),
      budgeted_costs: formData.budgeted_costs !== "" && formData.budgeted_costs != null ? Number(formData.budgeted_costs) : null,
      budgeted_income: formData.budgeted_income !== "" && formData.budgeted_income != null ? Number(formData.budgeted_income) : null
    };

    // Group-limited mode: lock the event to its group, carry the audience choice,
    // and store the manual meeting link (no Zoom). Mirrors groupAdminEventWrite.js.
    if (isGroupLimited) {
      eventData.member_group_id = groupId;
      eventData.group_event_public = groupEventPublic === true;
      eventData.online_meeting_url = isOnlineEvent ? (formData.online_meeting_url?.trim() || null) : null;
    }

    // Add ticket classes for one-off events
    if (isOneOffEvent) {
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
          // Group events: ticket visibility follows the event audience choice.
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
          group_cutoff_date: !isGroupLimited && ticket.is_group_ticket && ticket.group_cutoff_date ? ticket.group_cutoff_date : null,
          early_bird_enabled: isGroupLimited ? false : (ticket.early_bird_enabled || false),
          early_bird_price: !isGroupLimited && ticket.early_bird_enabled && ticket.early_bird_price ? parseFloat(ticket.early_bird_price) : null,
          early_bird_deadline: !isGroupLimited && ticket.early_bird_enabled && ticket.early_bird_deadline ? ticket.early_bird_deadline : null
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


    const submitUpdate = () => updateEventMutation.mutate(eventData, {
      onSuccess: async () => {
        // Save sponsor assignments
        try {
          const existingAssignments = await base44.entities.EventSponsorAssignment.list({ filter: { event_id: eventId, event_type: 'simple' } });
          for (const a of existingAssignments) {
            await base44.entities.EventSponsorAssignment.delete(a.id);
          }
          let sponsorCategoryMap = {};
          if (selectedSponsors.length > 0) {
            const allSponsors = await base44.entities.EventSponsor.list();
            (allSponsors || []).forEach(s => { sponsorCategoryMap[s.id] = s.category_id || null; });
          }
          for (const sponsorId of selectedSponsors) {
            const detail = (sponsorDetails[sponsorId] || '').trim();
            await base44.entities.EventSponsorAssignment.create({
              event_id: eventId,
              event_type: 'simple',
              sponsor_id: sponsorId,
              category_id: sponsorCategoryMap[sponsorId] || null,
              sponsorship_detail: detail || null
            });
          }
        } catch (sponsorErr) {
          console.error('Failed to save sponsor assignments:', sponsorErr);
          toast.error('Event saved but sponsor assignments could not be saved');
        }

        toast.success('Event updated successfully');
        queryClient.invalidateQueries({ queryKey: ['events'] });
        queryClient.invalidateQueries({ queryKey: ['event', eventId] });
        queryClient.invalidateQueries({ queryKey: ['/api/entities/EventSponsorAssignment'] });
        // Group events return to where they came from: the group events list
        // (when opened from there) or the member group detail page. Non-group
        // events keep the existing redirect to the general Events list.
        const returnGroupId = groupIdParam || event?.member_group_id || null;
        setTimeout(() => {
          if (returnGroupId) {
            window.location.href = fromParam === 'GroupEvents'
              ? createPageUrl('GroupEvents')
              : createPageUrl('MemberGroupDetail') + '?id=' + returnGroupId;
          } else {
            window.location.href = createPageUrl('Events');
          }
        }, 500);
      }
    });

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
          excludeEventId: eventId,
        });
        if (hasClashes) {
          setPendingSubmit(() => submitUpdate);
          setClashDialog({ open: true, clashes, redacted: !!redacted, clashCount: clashCount ?? 0 });
          setCheckingClashes(false);
          return;
        }
      } catch (err) {
        // Never block saving on a clash-check failure.
      }
      setCheckingClashes(false);
    }

    submitUpdate();
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const renderContent = () => {
    if (!eventId) {
      return (
        <div className="max-w-3xl mx-auto text-center py-16">
          <h1 className="text-2xl font-bold text-slate-900 mb-4">Event Not Found</h1>
          <p className="text-slate-600 mb-6">No event ID was provided.</p>
          <Button onClick={() => window.location.href = createPageUrl('Events')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Events
          </Button>
        </div>
      );
    }

    if (loadingEvent) {
      return (
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            <span className="ml-3 text-slate-600">Loading event...</span>
          </div>
        </div>
      );
    }

    if (eventError || !event) {
      return (
        <div className="max-w-3xl mx-auto text-center py-16">
          <h1 className="text-2xl font-bold text-slate-900 mb-4">Event Not Found</h1>
          <p className="text-slate-600 mb-6">The event you're looking for doesn't exist or has been deleted.</p>
          <Button onClick={() => window.location.href = createPageUrl('Events')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Events
          </Button>
        </div>
      );
    }

    // Hide tabs that would be empty in the current context, and fall back to
    // Details if the active tab becomes hidden (e.g. switching a one-off event
    // to a program event while on the Tickets tab).
    const visibleTabs = new Set(['details', 'location', 'emails', 'surveys']);
    if (isOneOffEvent) visibleTabs.add('tickets');
    if (isDonationGloballyEnabled) visibleTabs.add('donations');
    if (!isGroupLimited) visibleTabs.add('budget');
    if (eventId && currentTenant?.slug) visibleTabs.add('sharing');
    const effectiveTab = visibleTabs.has(activeTab) ? activeTab : 'details';

    return (
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Button 
            variant="ghost" 
            size="icon"
            onClick={() => {
              // Group events return to where they came from: the group events
              // list (when opened from there) or the member group detail page.
              // Non-group events keep returning to the general Events list.
              const backGroupId = groupIdParam || event?.member_group_id || null;
              if (backGroupId) {
                window.location.href = fromParam === 'GroupEvents'
                  ? createPageUrl('GroupEvents')
                  : createPageUrl('MemberGroupDetail') + '?id=' + backGroupId;
              } else {
                window.location.href = createPageUrl('Events');
              }
            }}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-slate-900">Edit Event</h1>
              {isOnlineEvent && (
                <Badge variant="secondary" className="bg-green-100 text-green-700 border-green-200">
                  <Video className="w-3 h-3 mr-1" />
                  Online Event
                </Badge>
              )}
            </div>
            <p className="text-slate-600">Update event details</p>
          </div>
          {eventId && (
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                try {
                  const resp = await fetch(`/api/events/${eventId}/duplicate`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                  });
                  if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.error || 'Duplicate failed');
                  }
                  const data = await resp.json();
                  toast.success('Event duplicated as draft');
                  // Carry group context so the duplicate opens directly in the
                  // gated group-event UI and returns to the group surfaces.
                  const dupGroupId = groupIdParam || event?.member_group_id || null;
                  let dupUrl = createPageUrl('EditEvent') + '?id=' + data.id;
                  if (dupGroupId) {
                    dupUrl += '&group_event=1&group_id=' + dupGroupId;
                    if (fromParam) dupUrl += '&from=' + fromParam;
                  }
                  window.location.href = dupUrl;
                } catch (err) {
                  toast.error('Duplicate failed: ' + err.message);
                }
              }}
              data-testid="button-duplicate-event-header"
            >
              <Copy className="w-4 h-4 mr-2" />
              Duplicate Event
            </Button>
          )}
        </div>


        {/* noValidate: inactive tab panels are display:none, and the browser
            silently blocks submission when a hidden required control is
            invalid ("not focusable") — so native constraints are reproduced
            in handleSubmit (title, start date, meeting-link URL format),
            which reports problems via toasts from any tab. */}
        <form onSubmit={handleSubmit} noValidate>
          {/* All tab panels stay mounted (forceMount + hidden) so state and
              behaviour match the previous single-column layout exactly, and
              saving persists changes made across every tab. */}
          <Tabs value={effectiveTab} onValueChange={setActiveTab}>
            <TabsList className="mb-6 h-auto flex-wrap justify-start">
              <TabsTrigger value="details" data-testid="button-tab-details">Details</TabsTrigger>
              {isOneOffEvent && (
                <TabsTrigger value="tickets" data-testid="button-tab-tickets">Tickets</TabsTrigger>
              )}
              {isDonationGloballyEnabled && (
                <TabsTrigger value="donations" data-testid="button-tab-donations">Donations</TabsTrigger>
              )}
              <TabsTrigger value="location" data-testid="button-tab-location">Location & Media</TabsTrigger>
              <TabsTrigger value="emails" data-testid="button-tab-emails">Emails</TabsTrigger>
              <TabsTrigger value="surveys" data-testid="button-tab-surveys">Surveys</TabsTrigger>
              {!isGroupLimited && (
                <TabsTrigger value="budget" data-testid="button-tab-budget">Budget</TabsTrigger>
              )}
              {eventId && currentTenant?.slug && (
                <TabsTrigger value="sharing" data-testid="button-tab-sharing">Sharing</TabsTrigger>
              )}
            </TabsList>

          <TabsContent value="details" forceMount className={TAB_PANEL_CLASS}>
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
                  className="grid grid-cols-2 gap-4"
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
                </RadioGroup>
                {eventTiming === 'tbc' && (
                  <p className="mt-3 text-sm text-blue-600 bg-blue-50 p-2 rounded">
                    Dates will be shown as "To be confirmed" and Zoom webinar/meeting selection is optional.
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
                    onCheckedChange={setIsTraining}
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
              {/* Program vs One-off Toggle */}
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

              {/* Program Selection - Only shown when isProgramEvent is true */}
              {isProgramEvent && (
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
                  Friendly URL for sharing. Leave empty to use the default URL format.
                </p>
              </div>

              <SEOSettings
                seoTitle={seoTitle}
                onSeoTitleChange={setSeoTitle}
                seoDescription={seoDescription}
                onSeoDescriptionChange={setSeoDescription}
                ogImageUrl={ogImageUrl}
                onOgImageUrlChange={setOgImageUrl}
                defaultTitle={formData.title}
                defaultDescription={formData.summary}
              />
              {(() => {
                const eventPreviewPath = slug
                  ? `/events/${slug}`
                  : eventId
                    ? `/EventDetails?id=${eventId}`
                    : null;
                return (
                  <UnfurlPreview
                    title={seoTitle || formData.title || ''}
                    description={seoDescription || formData.summary || ''}
                    image={ogImageUrl || formData.image_url || ''}
                    url={typeof window !== 'undefined' && eventPreviewPath ? `${window.location.origin}${eventPreviewPath}` : ''}
                    previewPath={eventPreviewPath}
                  />
                );
              })()}

              <div className="space-y-2">
                <Label htmlFor="summary">Summary</Label>
                <Textarea
                  id="summary"
                  value={formData.summary}
                  onChange={(e) => {
                    const value = e.target.value;
                    // task-696: allow change if within cap OR if user is
                    // shortening an over-cap legacy summary.
                    if (value.length <= summaryMaxLength || value.length < formData.summary.length) {
                      handleInputChange('summary', value);
                    }
                  }}
                  placeholder={`Brief summary for event cards (max ${summaryMaxLength} characters)`}
                  className="resize-none"
                  rows={2}
                  data-testid="input-summary"
                />
                <div className="flex justify-between text-xs text-slate-500">
                  <span>
                    {formData.summary.length > summaryMaxLength
                      ? `Please shorten to ${summaryMaxLength} characters before saving`
                      : 'Displayed on event cards and listings'}
                  </span>
                  <span
                    className={
                      formData.summary.length > summaryMaxLength
                        ? 'text-destructive font-medium'
                        : formData.summary.length >= summaryMaxLength - 10
                          ? 'text-warning'
                          : ''
                    }
                    data-testid="text-summary-counter"
                  >
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
                      {resolvedSpeakerIds.length === 0 
                        ? `Click to select ${speakerPlural.toLowerCase()}...` 
                        : `${resolvedSpeakerIds.length} ${resolvedSpeakerIds.length !== 1 ? speakerPlural.toLowerCase() : speakerSingular.toLowerCase()} selected`
                      }
                    </Button>
                    
                    {/* Show selected speakers as chips */}
                    {resolvedSpeakerIds.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {resolvedSpeakerIds.map(speakerId => {
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
                      speakers={speakers.filter(s => resolvedSpeakerIds.includes(s.id))}
                      value={speakerAwards}
                      onChange={setSpeakerAwards}
                      eventId={eventId}
                      eventType="event"
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

                {/* Task #1509: surface unresolved (deleted) speaker references so
                    the admin can clear stale ids that show no speaker. Kept
                    outside the picker conditional above so it stays visible and
                    removable even when no active speakers exist. */}
                {unresolvedSpeakerIds.length > 0 && (
                  <div className="mt-2 p-3 bg-warning/10 border border-warning rounded-md space-y-2" data-testid="alert-unresolved-speakers">
                    <div className="flex items-center gap-2 text-sm text-warning-foreground">
                      <AlertCircle className="h-4 w-4 text-warning" />
                      <span>
                        {unresolvedSpeakerIds.length} unresolved {unresolvedSpeakerIds.length !== 1 ? speakerPlural.toLowerCase() : speakerSingular.toLowerCase()} (the referenced {unresolvedSpeakerIds.length !== 1 ? speakerPlural.toLowerCase() : speakerSingular.toLowerCase()} no longer exist). Remove to fix the count.
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {unresolvedSpeakerIds.map(speakerId => (
                        <div
                          key={speakerId}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-background border border-warning text-warning-foreground"
                        >
                          <Mic className="h-3.5 w-3.5 text-warning" />
                          <span className="text-xs font-mono">{speakerId.slice(0, 8)}…</span>
                          <button
                            type="button"
                            onClick={() => toggleSpeaker(speakerId)}
                            className="ml-1 text-warning hover:opacity-80"
                            data-testid={`button-remove-unresolved-speaker-${speakerId}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              )}

              {/* Event Sponsors - Collapsible */}
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <button
                  type="button"
                  className="w-full flex items-center justify-between p-3 bg-slate-50 hover:bg-slate-100 transition-colors"
                  onClick={() => setSponsorsExpanded(prev => !prev)}
                  data-testid="button-toggle-sponsors-section"
                >
                  <span className="flex items-center gap-2 font-medium text-slate-700">
                    <Handshake className="h-4 w-4 text-blue-600" />
                    Sponsors
                    {selectedSponsors.length > 0 && (
                      <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{selectedSponsors.length}</span>
                    )}
                  </span>
                  {sponsorsExpanded ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                </button>
                {sponsorsExpanded && (
                  <div className="p-4 border-t border-slate-200">
                    <EventSponsorSelector
                      eventId={eventId}
                      eventType="simple"
                      selectedSponsorIds={selectedSponsors}
                      onSelectedSponsorIdsChange={setSelectedSponsors}
                      sponsorDetails={sponsorDetails}
                      onSponsorDetailsChange={(id, val) => setSponsorDetails(prev => ({ ...prev, [id]: val }))}
                    />
                  </div>
                )}
              </div>

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

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {!isGroupLimited && (
                <div className="space-y-2">
                  <Label htmlFor="internal_reference">Internal Reference</Label>
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
                )}

                {!isGroupLimited && (
                <div className="space-y-2">
                  <Label htmlFor="xero_account_code">Xero Account Code</Label>
                  <Input
                    id="xero_account_code"
                    value={formData.xero_account_code}
                    onChange={(e) => handleInputChange('xero_account_code', e.target.value)}
                    placeholder={(() => {
                      const setting = systemSettings.find(s => s.setting_key === 'xero_sales_account_code');
                      return setting?.setting_value || '200';
                    })()}
                    data-testid="input-xero-account-code"
                  />
                  <p className="text-xs text-slate-500">
                    {formData.xero_account_code
                      ? "This event will use its own Xero account code for invoices."
                      : "Using default from Event Settings. Set a value here to override."}
                  </p>
                </div>
                )}
              </div>

              {eventTypes.length > 0 && !isGroupLimited && (
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

              {!isGroupLimited && (
              <div className="space-y-2">
                <Label htmlFor="cta_override_url">CTA Override URL</Label>
                <Input
                  id="cta_override_url"
                  value={formData.cta_override_url || ""}
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
              )}

              {!isGroupLimited && (
              <div className="space-y-2">
                <Label htmlFor="cta_button_label">CTA Button Label</Label>
                <Input
                  id="cta_button_label"
                  value={formData.cta_button_label || ""}
                  onChange={(e) => handleInputChange('cta_button_label', e.target.value)}
                  placeholder={`e.g. Book Now (default: "${tenantDefaultCtaLabel}")`}
                  data-testid="input-cta-button-label"
                />
                <p className="text-xs text-slate-500">
                  Optional. Overrides the event card button label for this event. Leave blank to use the tenant default from Event Settings ("{tenantDefaultCtaLabel}").
                </p>
              </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start_date">
                    Start Date & Time {eventTiming !== 'tbc' && '*'}
                  </Label>
                  <TimezoneAwareDateTimeInput
                    id="start_date"
                    tz={eventTimezone}
                    isReady={!isTimezoneLoading}
                    value={isTraining ? (trainingDerivedDates?.start || '') : formData.start_date}
                    onChange={(iso) => handleInputChange('start_date', iso)}
                    required={eventTiming !== 'tbc' && !isTraining}
                    disabled={eventTiming === 'tbc' || isTraining || (isOnlineEvent && !isGroupLimited) || isTimezoneLoading}
                    className={(eventTiming === 'tbc' || isTraining || (isOnlineEvent && !isGroupLimited) || isTimezoneLoading) ? "bg-slate-100 cursor-not-allowed" : ""}
                    data-testid="input-start-date"
                  />
                  {eventTiming === 'tbc' && (
                    <p className="text-xs text-blue-600">Date disabled for TBC events</p>
                  )}
                  {isTraining && eventTiming !== 'tbc' && (
                    <p className="text-xs text-slate-500">Taken from the earliest agenda date</p>
                  )}
                  {!isTraining && isOnlineEvent && !isGroupLimited && eventTiming !== 'tbc' && (
                    <p className="text-xs text-slate-500">Managed by Zoom {event?.zoom_meeting_id ? 'meeting' : 'webinar'}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end_date">End Date & Time</Label>
                  <TimezoneAwareDateTimeInput
                    id="end_date"
                    tz={eventTimezone}
                    isReady={!isTimezoneLoading}
                    value={isTraining ? (trainingDerivedDates?.end || '') : formData.end_date}
                    onChange={(iso) => handleInputChange('end_date', iso)}
                    disabled={eventTiming === 'tbc' || isTraining || (isOnlineEvent && !isGroupLimited) || isTimezoneLoading}
                    className={(eventTiming === 'tbc' || isTraining || (isOnlineEvent && !isGroupLimited) || isTimezoneLoading) ? "bg-slate-100 cursor-not-allowed" : ""}
                    data-testid="input-end-date"
                  />
                  {isTraining && eventTiming !== 'tbc' && (
                    <p className="text-xs text-slate-500">Taken from the latest agenda date</p>
                  )}
                  {!isTraining && isOnlineEvent && !isGroupLimited && eventTiming !== 'tbc' && (
                    <p className="text-xs text-slate-500">Managed by Zoom webinar</p>
                  )}
                </div>
              </div>
              
              {/* Timezone selector/indicator */}
              {eventTiming !== 'tbc' && (
                <div className="space-y-2 mt-2">
                  {isOnlineEvent && !isGroupLimited ? (
                    <div className={`flex items-center gap-2 text-xs ${timezoneFetchFailed ? 'text-warning' : 'text-slate-500'}`}>
                      <Clock className="h-3 w-3" />
                      <span>
                        {isTimezoneLoading ? (
                          'Loading timezone...'
                        ) : timezoneFetchFailed ? (
                          `Could not fetch Zoom timezone. Showing times in ${eventTimezone.replace('_', ' ')} (default).`
                        ) : (
                          `Timezone: ${eventTimezone.replace('_', ' ')} (managed by Zoom)`
                        )}
                      </span>
                    </div>
                  ) : (
                    <>
                      <Label htmlFor="event_timezone">Event Timezone</Label>
                      <Select
                        value={eventTimezone}
                        onValueChange={(value) => setEventTimezone(value)}
                      >
                        <SelectTrigger id="event_timezone" data-testid="select-event-timezone">
                          <SelectValue placeholder="Select timezone" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Europe/London">Europe/London (UK)</SelectItem>
                          <SelectItem value="Europe/Dublin">Europe/Dublin (Ireland)</SelectItem>
                          <SelectItem value="Europe/Paris">Europe/Paris (Central European)</SelectItem>
                          <SelectItem value="Europe/Berlin">Europe/Berlin (Germany)</SelectItem>
                          <SelectItem value="Europe/Amsterdam">Europe/Amsterdam (Netherlands)</SelectItem>
                          <SelectItem value="Europe/Brussels">Europe/Brussels (Belgium)</SelectItem>
                          <SelectItem value="Europe/Madrid">Europe/Madrid (Spain)</SelectItem>
                          <SelectItem value="Europe/Rome">Europe/Rome (Italy)</SelectItem>
                          <SelectItem value="Europe/Zurich">Europe/Zurich (Switzerland)</SelectItem>
                          <SelectItem value="Europe/Stockholm">Europe/Stockholm (Sweden)</SelectItem>
                          <SelectItem value="America/New_York">America/New_York (US Eastern)</SelectItem>
                          <SelectItem value="America/Chicago">America/Chicago (US Central)</SelectItem>
                          <SelectItem value="America/Denver">America/Denver (US Mountain)</SelectItem>
                          <SelectItem value="America/Los_Angeles">America/Los_Angeles (US Pacific)</SelectItem>
                          <SelectItem value="America/Toronto">America/Toronto (Canada Eastern)</SelectItem>
                          <SelectItem value="America/Vancouver">America/Vancouver (Canada Pacific)</SelectItem>
                          <SelectItem value="Asia/Dubai">Asia/Dubai (UAE)</SelectItem>
                          <SelectItem value="Asia/Singapore">Asia/Singapore</SelectItem>
                          <SelectItem value="Asia/Hong_Kong">Asia/Hong Kong</SelectItem>
                          <SelectItem value="Asia/Tokyo">Asia/Tokyo (Japan)</SelectItem>
                          <SelectItem value="Asia/Shanghai">Asia/Shanghai (China)</SelectItem>
                          <SelectItem value="Asia/Kolkata">Asia/Kolkata (India)</SelectItem>
                          <SelectItem value="Australia/Sydney">Australia/Sydney</SelectItem>
                          <SelectItem value="Australia/Melbourne">Australia/Melbourne</SelectItem>
                          <SelectItem value="Australia/Perth">Australia/Perth</SelectItem>
                          <SelectItem value="Pacific/Auckland">Pacific/Auckland (New Zealand)</SelectItem>
                          <SelectItem value="Africa/Johannesburg">Africa/Johannesburg (South Africa)</SelectItem>
                          <SelectItem value="UTC">UTC (Coordinated Universal Time)</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500">
                        Times will be displayed and stored in this timezone.
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* Registration Closes At - Optional */}
              <div className="space-y-2 mt-4">
                <Label htmlFor="registration_closes_at">Registration Closes On (Optional)</Label>
                <TimezoneAwareDateTimeInput
                  id="registration_closes_at"
                  tz={eventTimezone}
                  isReady={!isTimezoneLoading}
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
                entityId={eventId}
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
          </TabsContent>

          <TabsContent value="tickets" forceMount className={TAB_PANEL_CLASS}>
          {/* Ticket Classes - Only shown for one-off events */}
          {isOneOffEvent && (
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
                    {/* Ticket Header */}
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
                            {ticket.early_bird_enabled && ticket.early_bird_price && (
                              <Badge variant="outline" className="text-xs bg-warning/10 text-warning border-warning/30">
                                <Bird className="h-3 w-3 mr-1" />
                                Early Bird £{ticket.early_bird_price}
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

                        {/* Early Bird Pricing (hidden for group-limited events) */}
                        {!isGroupLimited && !ticket.is_free && (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2">
                              <Switch
                                id={`ticket-early-bird-${ticket.id}`}
                                checked={ticket.early_bird_enabled || false}
                                onCheckedChange={(checked) => {
                                  updateTicketClass(ticket.id, 'early_bird_enabled', checked);
                                  if (!checked) {
                                    updateTicketClass(ticket.id, 'early_bird_price', '');
                                    updateTicketClass(ticket.id, 'early_bird_deadline', '');
                                  }
                                }}
                                data-testid={`switch-early-bird-${ticket.id}`}
                              />
                              <Label htmlFor={`ticket-early-bird-${ticket.id}`} className="text-sm font-medium flex items-center gap-1.5">
                                <Bird className="h-4 w-4 text-warning" />
                                Early Bird Pricing
                              </Label>
                            </div>
                            {ticket.early_bird_enabled && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-2 border-l-2 border-warning/30 ml-1">
                                <div className="space-y-1.5">
                                  <Label htmlFor={`ticket-early-bird-price-${ticket.id}`} className="text-sm">
                                    Early Bird Price (£) *
                                  </Label>
                                  <div className="relative w-28">
                                    <PoundSterling className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                                    <Input
                                      id={`ticket-early-bird-price-${ticket.id}`}
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={ticket.early_bird_price || ''}
                                      onChange={(e) => updateTicketClass(ticket.id, 'early_bird_price', e.target.value)}
                                      placeholder="0.00"
                                      className="pl-9"
                                      data-testid={`input-early-bird-price-${ticket.id}`}
                                    />
                                  </div>
                                  {ticket.early_bird_price && ticket.price && Number(ticket.early_bird_price) >= Number(ticket.price) && (
                                    <p className="text-xs text-red-500">Must be less than standard price (£{ticket.price})</p>
                                  )}
                                </div>
                                <div className="space-y-1.5">
                                  <Label htmlFor={`ticket-early-bird-deadline-${ticket.id}`} className="text-sm">
                                    Deadline *
                                  </Label>
                                  <Input
                                    id={`ticket-early-bird-deadline-${ticket.id}`}
                                    type="datetime-local"
                                    value={ticket.early_bird_deadline ? ticket.early_bird_deadline.slice(0, 16) : ''}
                                    onChange={(e) => updateTicketClass(ticket.id, 'early_bird_deadline', e.target.value || '')}
                                    data-testid={`input-early-bird-deadline-${ticket.id}`}
                                  />
                                  <p className="text-xs text-slate-500">Price reverts to standard after this date/time</p>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

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
                                  min={ticketClassSoldCounts[ticket.id] || 0}
                                  value={ticket.available_count || ""}
                                  onChange={(e) => updateTicketClass(ticket.id, 'available_count', e.target.value)}
                                  placeholder="e.g. 50"
                                  className="w-24"
                                  data-testid={`input-ticket-available-count-${ticket.id}`}
                                />
                                <span className="text-sm text-slate-500">tickets</span>
                                {ticketClassSoldCounts[ticket.id] > 0 && (
                                  <span className="text-xs text-warning">
                                    ({ticketClassSoldCounts[ticket.id]} sold)
                                  </span>
                                )}
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

                        {/* Role Assignment / Visibility / Offer / VAT (hidden for group-limited events) */}
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
                                htmlFor={`edit-offer-none-${ticket.id}`}
                                className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                  ticket.offer_type === 'none' 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:bg-slate-50'
                                }`}
                              >
                                <RadioGroupItem value="none" id={`edit-offer-none-${ticket.id}`} />
                                <span className="text-sm">No Offer</span>
                              </Label>
                              <Label 
                                htmlFor={`edit-offer-bogo-${ticket.id}`}
                                className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                  ticket.offer_type === 'bogo' 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:bg-slate-50'
                                }`}
                              >
                                <RadioGroupItem value="bogo" id={`edit-offer-bogo-${ticket.id}`} />
                                <span className="text-sm">BOGO</span>
                              </Label>
                              <Label 
                                htmlFor={`edit-offer-bulk-${ticket.id}`}
                                className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                  ticket.offer_type === 'bulk_discount' 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:bg-slate-50'
                                }`}
                              >
                                <RadioGroupItem value="bulk_discount" id={`edit-offer-bulk-${ticket.id}`} />
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
                                    <RadioGroupItem value="buy_x_get_y_free" id={`edit-bogo-logic-1-${ticket.id}`} />
                                    <Label htmlFor={`edit-bogo-logic-1-${ticket.id}`} className="text-sm cursor-pointer">
                                      Buy X, Get Y Free
                                    </Label>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <RadioGroupItem value="enter_total_pay_less" id={`edit-bogo-logic-2-${ticket.id}`} />
                                    <Label htmlFor={`edit-bogo-logic-2-${ticket.id}`} className="text-sm cursor-pointer">
                                      Enter Total, Pay Less
                                    </Label>
                                  </div>
                                </div>
                              </RadioGroup>
                              
                              <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                  <Label htmlFor={`edit-bogo-buy-${ticket.id}`}>Buy Quantity *</Label>
                                  <Input
                                    id={`edit-bogo-buy-${ticket.id}`}
                                    type="number"
                                    min="1"
                                    value={ticket.bogo_buy_quantity}
                                    onChange={(e) => updateTicketClass(ticket.id, 'bogo_buy_quantity', e.target.value)}
                                    placeholder="e.g. 2"
                                    data-testid={`input-bogo-buy-${ticket.id}`}
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor={`edit-bogo-free-${ticket.id}`}>Get Free Quantity *</Label>
                                  <Input
                                    id={`edit-bogo-free-${ticket.id}`}
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
                                  <Label htmlFor={`edit-bulk-threshold-${ticket.id}`}>Minimum Tickets *</Label>
                                  <Input
                                    id={`edit-bulk-threshold-${ticket.id}`}
                                    type="number"
                                    min="2"
                                    value={ticket.bulk_discount_threshold}
                                    onChange={(e) => updateTicketClass(ticket.id, 'bulk_discount_threshold', e.target.value)}
                                    placeholder="e.g. 5"
                                    data-testid={`input-bulk-threshold-${ticket.id}`}
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor={`edit-bulk-percentage-${ticket.id}`}>Discount % *</Label>
                                  <Input
                                    id={`edit-bulk-percentage-${ticket.id}`}
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
                          <Label htmlFor="edit-allow-guests-view-all" className="text-sm font-medium text-slate-900 cursor-pointer">
                            Show all ticket types to public visitors
                          </Label>
                          <p className="text-xs text-slate-500 mt-1">
                            When enabled, non-logged-in visitors can see member-only ticket prices (but cannot purchase them)
                          </p>
                        </div>
                      </div>
                      <Switch
                        id="edit-allow-guests-view-all"
                        checked={allowGuestsToViewAllTickets}
                        onCheckedChange={setAllowGuestsToViewAllTickets}
                        data-testid="switch-allow-guests-view-all"
                      />
                    </div>
                    <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg mt-3">
                      <div className="flex items-start gap-3">
                        <Eye className="h-5 w-5 text-slate-600 mt-0.5" />
                        <div>
                          <Label htmlFor="edit-collect-third-party-consent" className="text-sm font-medium text-slate-900 cursor-pointer">
                            Collect third-party data sharing consent
                          </Label>
                          <p className="text-xs text-slate-500 mt-1">
                            When enabled, attendees will see an optional, default-checked checkbox below the terms &amp; conditions agreeing to share their details with relevant third parties. Submission is not required.
                          </p>
                        </div>
                      </div>
                      <Switch
                        id="edit-collect-third-party-consent"
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
          </TabsContent>

          <TabsContent value="donations" forceMount className={TAB_PANEL_CLASS}>
          {isDonationGloballyEnabled && (
            <Card className="border-slate-200 shadow-sm mb-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Gift className="h-5 w-5 text-pink-600" />
                  Donation Configuration
                </CardTitle>
                <CardDescription>
                  Configure the donation option shown to users during checkout
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="donation-event-toggle">Enable Donation for this Event</Label>
                    <p className="text-xs text-slate-500">
                      When enabled, users paying by card will be offered the chance to donate during checkout.
                    </p>
                  </div>
                  <Switch
                    id="donation-event-toggle"
                    checked={donationConfig.enabled}
                    onCheckedChange={(checked) => setDonationConfig(prev => ({ ...prev, enabled: checked }))}
                    data-testid="switch-event-donation"
                  />
                </div>

                {donationConfig.enabled && (
                  <div className="space-y-5 pt-4 border-t border-slate-200">
                    <div className="space-y-3">
                      <Label>Preset Donation Amounts</Label>
                      <p className="text-xs text-slate-500">
                        These amounts will be shown as quick-select options on the donation modal.
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        {donationConfig.preset_amounts.map((amount, index) => (
                          <Badge key={index} variant="secondary" className="text-sm gap-1.5">
                            £{amount}
                            <button
                              type="button"
                              onClick={() => {
                                setDonationConfig(prev => ({
                                  ...prev,
                                  preset_amounts: prev.preset_amounts.filter((_, i) => i !== index)
                                }));
                              }}
                              className="ml-1 hover:text-red-600"
                              data-testid={`button-remove-preset-amount-${index}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          placeholder="e.g., 100"
                          value={newPresetAmount}
                          onChange={(e) => setNewPresetAmount(e.target.value)}
                          className="w-32"
                          data-testid="input-new-preset-amount"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const val = parseFloat(newPresetAmount);
                            if (val > 0 && !donationConfig.preset_amounts.includes(val)) {
                              setDonationConfig(prev => ({
                                ...prev,
                                preset_amounts: [...prev.preset_amounts, val].sort((a, b) => a - b)
                              }));
                              setNewPresetAmount('');
                            }
                          }}
                          data-testid="button-add-preset-amount"
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add
                        </Button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="space-y-1">
                        <Label htmlFor="donation-custom-amount-toggle">Allow Custom Amount</Label>
                        <p className="text-xs text-slate-500">
                          Let donors enter any amount instead of choosing from presets.
                        </p>
                      </div>
                      <Switch
                        id="donation-custom-amount-toggle"
                        checked={donationConfig.allow_custom_amount}
                        onCheckedChange={(checked) => setDonationConfig(prev => ({ ...prev, allow_custom_amount: checked }))}
                        data-testid="switch-donation-custom-amount"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="donation-custom-message">Custom Message</Label>
                      <p className="text-xs text-slate-500">
                        This message will be shown on the donation modal to encourage donations.
                      </p>
                      <Textarea
                        id="donation-custom-message"
                        value={donationConfig.custom_message}
                        onChange={(e) => setDonationConfig(prev => ({ ...prev, custom_message: e.target.value }))}
                        placeholder="e.g., Your donation helps us continue our important work..."
                        rows={3}
                        data-testid="textarea-donation-message"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="donation-email-list">Email Communication List</Label>
                      <p className="text-xs text-slate-500">
                        Donors will be added to this subscription list.
                      </p>
                      <Select
                        value={donationConfig.email_list_key || '_none'}
                        onValueChange={(value) => setDonationConfig(prev => ({ ...prev, email_list_key: value === '_none' ? '' : value }))}
                      >
                        <SelectTrigger data-testid="select-donation-email-list">
                          <SelectValue placeholder="Select a subscription list" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_none">No list</SelectItem>
                          {communicationCategories.filter(cat => cat.is_public && cat.is_active).map((cat) => (
                            <SelectItem key={cat.id} value={cat.id}>
                              {cat.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          </TabsContent>

          <TabsContent value="location" forceMount className={TAB_PANEL_CLASS}>
        {/* task-692: panel is always rendered (regardless of isOnlineEvent /
            sync state) so admins can attach/change/detach Zoom at any time.
            Hidden in group-limited mode — group events never use Zoom — and
            for training events, where Zoom is set per agenda item (Task #3436). */}
          {!isGroupLimited && !isTraining && (
        <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg" data-testid="panel-zoom-link-admin">
          <div className="flex items-center gap-2 mb-2">
            <Globe className="h-4 w-4 text-blue-600" />
            <span className="font-medium text-blue-900">Zoom Link</span>
          </div>
          {(formData.zoom_meeting_id || formData.zoom_webinar_id) ? (
            <p className="text-sm text-blue-800 mb-3">
              Linked to a Zoom {formData.zoom_meeting_id ? 'meeting' : 'webinar'}. Date, time, and location are managed by Zoom and cannot be edited here.
            </p>
          ) : isOnlineEvent ? (
            <p className="text-sm text-blue-800 mb-3">
              This event is marked online but has no Zoom link attached. Confirmed attendees will not receive a join URL until you attach one.
            </p>
          ) : (
            <p className="text-sm text-blue-800 mb-3">
              No Zoom link attached. Attach one to convert this event to online and give confirmed attendees a join URL.
            </p>
          )}

          <div className="flex flex-wrap gap-2 mb-3">
              {!(formData.zoom_meeting_id || formData.zoom_webinar_id) ? (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => setZoomLinkDialog({ open: true, mode: 'attach' })}
                  data-testid="button-attach-zoom-link"
                >
                  <Video className="h-4 w-4 mr-2" />
                  Attach Zoom Link
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setZoomLinkDialog({ open: true, mode: 'change' })}
                    data-testid="button-change-zoom-link"
                  >
                    <Video className="h-4 w-4 mr-2" />
                    Change Zoom Link
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setZoomLinkDialog({ open: true, mode: 'detach' })}
                    data-testid="button-detach-zoom-link"
                  >
                    <X className="h-4 w-4 mr-2" />
                    Detach Zoom Link
                  </Button>
                </>
              )}
            </div>

            {/* Zoom Sync Status (only meaningful when Zoom is attached) */}
            {(formData.zoom_meeting_id || formData.zoom_webinar_id) && (
              <div className="mt-3 pt-3 border-t border-blue-200">
                {checkingSyncStatus ? (
                  <div className="flex items-center gap-2 text-sm text-blue-700">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Checking sync status with Zoom...</span>
                  </div>
                ) : zoomSyncStatus?.error ? (
                  <div className="flex items-center gap-2 text-sm text-red-700">
                    <X className="h-4 w-4" />
                    <span>{zoomSyncStatus.error}</span>
                  </div>
                ) : zoomSyncStatus?.inSync === true ? (
                  <div className="flex items-center gap-2 text-sm text-green-700">
                    <Check className="h-4 w-4" />
                    <span>In sync with Zoom</span>
                    {zoomSyncStatus.zoomTopic && (
                      <span className="text-green-600">({zoomSyncStatus.zoomTopic})</span>
                    )}
                  </div>
                ) : zoomSyncStatus?.inSync === false ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-warning">
                      <Bell className="h-4 w-4" />
                      <span className="font-medium">Out of sync with Zoom</span>
                    </div>
                    {zoomSyncStatus.differences?.start?.zoom && (
                      <div className="text-xs text-warning ml-6">
                        Start time differs: Event has {zoomSyncStatus.differences.start.event ? formatInTimeZone(new Date(zoomSyncStatus.differences.start.event), eventTimezone, 'dd/MM/yyyy HH:mm') : 'none'},
                        Zoom has {formatInTimeZone(new Date(zoomSyncStatus.differences.start.zoom), eventTimezone, 'dd/MM/yyyy HH:mm')}
                      </div>
                    )}
                    {zoomSyncStatus.differences?.end?.zoom && (
                      <div className="text-xs text-warning ml-6">
                        End time differs: Event has {zoomSyncStatus.differences.end.event ? formatInTimeZone(new Date(zoomSyncStatus.differences.end.event), eventTimezone, 'dd/MM/yyyy HH:mm') : 'none'},
                        Zoom has {formatInTimeZone(new Date(zoomSyncStatus.differences.end.zoom), eventTimezone, 'dd/MM/yyyy HH:mm')}
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={syncFromZoom}
                      disabled={syncingFromZoom}
                      className="mt-2"
                      data-testid="button-sync-from-zoom"
                    >
                      {syncingFromZoom ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Syncing...
                        </>
                      ) : (
                        <>
                          <Video className="h-4 w-4 mr-2" />
                          Sync from Zoom
                        </>
                      )}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
        </div>
          )}

          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <MapPin className="h-5 w-5 text-blue-600" />
                Location & Capacity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isGroupLimited && (
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <Globe className="h-5 w-5 text-blue-600" />
                    <div>
                      <p className="font-medium text-slate-900">
                        {isOnlineEvent ? 'Online Event' : 'In-Person Event'}
                      </p>
                      <p className="text-sm text-slate-600">
                        {isOnlineEvent
                          ? 'Event will be hosted via your own meeting link'
                          : 'Event will be held at a physical location'}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={isOnlineEvent}
                    onCheckedChange={setIsOnlineEvent}
                    data-testid="switch-delivery-mode"
                  />
                </div>
              )}
              {isGroupLimited && isOnlineEvent && (
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
              {/* Training events define location per agenda item (Task #3436). */}
              {!isTraining && (
              <div className="space-y-2">
                <Label htmlFor="location">Venue / Location</Label>
                <Input
                  id="location"
                  value={formData.location}
                  onChange={(e) => handleInputChange('location', e.target.value)}
                  placeholder="Enter venue address or location name"
                  disabled={isOnlineEvent}
                  className={isOnlineEvent ? "bg-slate-100 cursor-not-allowed" : ""}
                  data-testid="input-location"
                />
                {isOnlineEvent && !isGroupLimited && (
                  <p className="text-xs text-slate-500">
                    Online event - location is managed by Zoom webinar
                  </p>
                )}
                {isOnlineEvent && !isGroupLimited && (
                  <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <p className="text-sm font-medium text-slate-700">Join Link Visibility</p>
                    <p className="text-sm text-slate-600 mt-1">
                      {hasVisibleJoinLink ? (
                        <>
                          <span className="text-green-700">Join link is visible on this event</span>
                          {getJoinUrlFromLocation() && (
                            <span className="block text-xs text-slate-500 mt-1 break-all">
                              URL: {getJoinUrlFromLocation()}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-warning">Join link is hidden - members must register via ticket purchase</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500 mt-2">
                      To change visibility for future events using this webinar, update the setting in Zoom Webinar Provisioning
                    </p>
                  </div>
                )}
              </div>
              )}

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
                  {isOnlineEvent 
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
                {isOneOffEvent && !isGroupLimited && (
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

                {/* Per-event entrance QR toggle - in-person events only */}
                {!isOnlineEvent && !isGroupLimited && (
                  <div className="flex items-center justify-between pt-2 border-t">
                    <div className="flex items-center gap-2">
                      <QrCode className="h-4 w-4 text-slate-500" />
                      <div>
                        <Label htmlFor="qr-on-confirmation" className="text-sm">Entrance QR code</Label>
                        <p className="text-xs text-slate-500">Attach a check-in QR code to booking confirmation emails</p>
                      </div>
                    </div>
                    <Switch
                      id="qr-on-confirmation"
                      checked={qrOnConfirmation}
                      onCheckedChange={setQrOnConfirmation}
                      data-testid="switch-qr-on-confirmation"
                    />
                  </div>
                )}
              </div>

              <EventImageUpload
                value={formData.image_url}
                onChange={(url) => handleInputChange('image_url', url)}
              />
              
              {formData.image_url && (
                <FocalPointPicker
                  imageUrl={formData.image_url}
                  focalPoint={formData.image_focal_point}
                  onChange={(point) => handleInputChange('image_focal_point', point)}
                />
              )}
            </CardContent>
          </Card>

          {(() => {
            const simpleZoomId = formData.zoom_meeting_id || formData.zoom_webinar_id;
            if (!simpleZoomId) return null;
            const simpleZoomType = formData.zoom_webinar_id ? 'webinar' : 'meeting';
            const eventIsPast = formData.start_date && new Date(formData.start_date) < new Date();

            return (
              <div className="mt-6 mb-6">
                <ZoomPolls
                  zoomId={simpleZoomId}
                  type={simpleZoomType}
                  isPast={eventIsPast}
                />
              </div>
            );
          })()}
          </TabsContent>

          <TabsContent value="emails" forceMount className={TAB_PANEL_CLASS}>
          {/* Email Configuration Section */}
          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Mail className="h-5 w-5 text-blue-600" />
                    Email Configuration
                  </CardTitle>
                  <CardDescription>
                    Configure confirmation and reminder emails for this event
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addEventEmail('booking_confirmation')}
                    data-testid="button-add-confirmation-email"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Confirmation
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addEventEmail('reminder')}
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
                saveErrors={emailSaveErrors}
                onRowEdited={handleEmailRowEdited}
                eventTimezone={eventTimezone}
                isTimezoneLoading={isTimezoneLoading}
                loading={loadingEmails}
                mode="event"
                eventId={eventId}
              />
              {!loadingEmails && eventEmails.length > 0 && (
                <div className="flex flex-wrap justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={requeueReminders}
                    disabled={isRequeueingEmails || isSavingEmails}
                    data-testid="button-requeue-reminders"
                  >
                    {isRequeueingEmails ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Re-queueing...
                      </>
                    ) : (
                      <>Re-queue reminders</>
                    )}
                  </Button>
                  <Button
                    type="button"
                    onClick={saveEventEmails}
                    disabled={isSavingEmails}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-save-emails"
                  >
                    {isSavingEmails ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving Emails...
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4 mr-2" />
                        Save Email Settings
                      </>
                    )}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
          </TabsContent>

          <TabsContent value="surveys" forceMount className={TAB_PANEL_CLASS}>
          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Surveys</CardTitle>
              <CardDescription>
                Attach surveys to this event so attendees can give feedback. Set optional open/close windows and control who can respond.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EventSurveysSection eventId={eventId} eventType="event" />
            </CardContent>
          </Card>
          </TabsContent>

          <TabsContent value="budget" forceMount className={TAB_PANEL_CLASS}>
          {!isGroupLimited && (
          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Budget</CardTitle>
              <CardDescription>
                Plan and track this event's finances. Actual revenue is calculated from ticket sales.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EventBudgetPanel
                eventId={eventId}
                eventKind="simple"
                budgetedCosts={formData.budgeted_costs}
                budgetedIncome={formData.budgeted_income}
                onBudgetedCostsChange={(v) => handleInputChange("budgeted_costs", v)}
                onBudgetedIncomeChange={(v) => handleInputChange("budgeted_income", v)}
              />
            </CardContent>
          </Card>
          )}
          </TabsContent>

          <TabsContent value="sharing" forceMount className={TAB_PANEL_CLASS}>
          {/* Embed on External Websites */}
          {eventId && currentTenant?.slug && (
            <Card className="border-slate-200 shadow-sm bg-white">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Code className="w-5 h-5 text-slate-600" />
                  Embed on External Websites
                </CardTitle>
                <CardDescription>
                  Use this embed code to display this event on your website.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {(() => {
                  const tenantSlug = currentTenant.slug;
                  const embedUrl = `https://${tenantSlug}.iconn.app/EventDetails?id=${eventId}&embed=true&tenant=${tenantSlug}`;
                  const embedCode = `<iframe src="${embedUrl}" style="width: 100%; min-height: 600px; border: none;" loading="lazy"></iframe>
<script>
  window.addEventListener('message', function(e) {
    if (e.data.type === 'iconn-event-resize' && e.data.eventId === '${eventId}' && e.data.tenant === '${tenantSlug}') {
      var iframe = document.querySelector('iframe[src*="id=${eventId}"]');
      if (iframe) iframe.style.height = e.data.height + 'px';
    }
  });
</script>`;
                  return (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label className="text-xs text-slate-500">iFrame Embed Code</Label>
                        <div className="relative">
                          <textarea
                            readOnly
                            value={embedCode}
                            className="w-full p-3 pr-10 bg-slate-100 border border-slate-300 rounded-lg text-xs font-mono resize-none"
                            rows={6}
                            data-testid="input-event-embed-code"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(embedCode);
                              toast.success("Embed code copied to clipboard");
                            }}
                            className="absolute top-2 right-2 p-1.5 bg-white hover:bg-slate-100 rounded border border-slate-300"
                            title="Copy embed code"
                            data-testid="button-copy-embed-code"
                          >
                            <Copy className="w-4 h-4 text-slate-600" />
                          </button>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => window.open(`https://${tenantSlug}.iconn.app/EventDetails?id=${eventId}&embed=true&tenant=${tenantSlug}`, '_blank')}
                        data-testid="button-preview-embed"
                      >
                        <ExternalLink className="w-4 h-4 mr-2" />
                        Preview Embedded Event
                      </Button>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          )}
          </TabsContent>
          </Tabs>

          {!isGroupLimited && !isTraining && (
        <ChangeZoomDialog
          open={zoomLinkDialog.open}
          onOpenChange={(open) => setZoomLinkDialog((s) => ({ ...s, open }))}
          endpointBase={`/api/events/${eventId}`}
          mode={zoomLinkDialog.mode}
          targetLabel="event"
          initialType={formData.zoom_meeting_id ? 'meeting' : 'webinar'}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['event', eventId] });
            window.location.reload();
          }}
        />
          )}

          <div className="flex items-center justify-end gap-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => window.location.href = createPageUrl('Events')}
              disabled={updateEventMutation.isPending}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={updateEventMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
              data-testid="button-save-event"
            >
              {updateEventMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Save Changes
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    );
  };

  return (
    <div className="min-h-screen p-4 md:p-8">
      {renderContent()}
      <EventClashWarningDialog
        open={clashDialog.open}
        clashes={clashDialog.clashes}
        redacted={clashDialog.redacted}
        clashCount={clashDialog.clashCount}
        onConfirm={handleClashConfirm}
        onCancel={handleClashCancel}
        isSaving={updateEventMutation.isPending}
      />
    </div>
  );
}