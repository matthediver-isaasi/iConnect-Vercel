import { useState, useEffect, useMemo } from "react";
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
  ExternalLink
} from "lucide-react";
import { createFilterTagKey, parseFilterTagKey, normalizeFilterTags } from "@/lib/utils";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import EventImageUpload from "@/components/events/EventImageUpload";
import { FocalPointPicker } from "@/components/FocalPointPicker";
import { SpeakerSelectionModal } from "@/components/SpeakerSelectionModal";
import { useSpeakerModuleName } from "@/hooks/useSpeakerModuleName";
import { useEventTypes } from "@/hooks/useEventTypes";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

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
  is_default: isDefault,
  visibility_mode: 'members_only', // 'members_only', 'members_and_public', or 'public_only'
  role_match_only: false, // When true AND visibility includes members, ticket only shows if user's role matches role_ids
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
  vat_rate_percentage: defaultVatRate?.effectiveRate || null // Percentage value (e.g., 20)
});

export default function EditEvent() {
  const queryClient = useQueryClient();
  const { singular: speakerSingular, plural: speakerPlural } = useSpeakerModuleName();
  const { eventTypes } = useEventTypes();
  const urlParams = new URLSearchParams(window.location.search);
  const eventId = urlParams.get('id');

  // Program vs One-off toggle
  const [isProgramEvent, setIsProgramEvent] = useState(true);
  
  // Online event toggle (controlled state for TBC compatibility)
  const [isOnlineEvent, setIsOnlineEvent] = useState(false);
  
  // Zoom type selection: webinar or meeting
  const [zoomType, setZoomType] = useState("webinar");
  const [selectedMeetingId, setSelectedMeetingId] = useState("");
  
  // Event status: draft, published, tbc
  const [eventStatus, setEventStatus] = useState("published");
  
  // Unlimited seats toggle
  const [unlimitedSeats, setUnlimitedSeats] = useState(true);
  
  // Per-event seat visibility
  const [showSeatCount, setShowSeatCount] = useState(true);
  const [showTicketAvailability, setShowTicketAvailability] = useState(false);
  
  // Handler for status changes - clears TBC-incompatible fields synchronously
  const handleStatusChange = (newStatus) => {
    if (newStatus === 'tbc') {
      // Clear dates and webinar/meeting when switching to TBC (but keep online mode available)
      setSelectedMeetingId("");
      setFormData(prev => ({
        ...prev,
        start_date: '',
        end_date: '',
        zoom_webinar_id: null,
        zoom_meeting_id: null
      }));
    }
    setEventStatus(newStatus);
  };

  // Ticket classes state for one-off events
  const [ticketClasses, setTicketClasses] = useState([createEmptyTicketClass(true)]);
  const [expandedTickets, setExpandedTickets] = useState({});
  const [allowGuestsToViewAllTickets, setAllowGuestsToViewAllTickets] = useState(false);

  // Email configuration state
  const [eventEmails, setEventEmails] = useState([]);
  const [isSavingEmails, setIsSavingEmails] = useState(false);
  const [emailCodeViewMode, setEmailCodeViewMode] = useState({}); // Track code view mode per email

  // Quill modules for rich text editing
  const emailQuillModules = {
    toolbar: [
      [{ 'header': [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'color': [] }, { 'background': [] }],
      [{ 'list': 'ordered' }, { 'list': 'bullet' }],
      [{ 'align': [] }],
      ['link'],
      ['clean']
    ],
  };

  const [formData, setFormData] = useState({
    title: "",
    summary: "",
    description: "",
    internal_reference: "",
    event_type: "",
    program_tag: "",
    start_date: "",
    end_date: "",
    location: "",
    image_url: "",
    image_focal_point: null,
    available_seats: "",
    zoom_webinar_id: null,
    zoom_meeting_id: null
  });

  const { data: event, isLoading: loadingEvent, error: eventError } = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => base44.entities.Event.get(eventId),
    enabled: !!eventId
  });

  const { data: programs = [], isLoading: loadingPrograms } = useQuery({
    queryKey: ['/api/entities/Program'],
    queryFn: () => base44.entities.Program.list()
  });

  // Fetch roles for ticket class assignment
  const { data: roles = [], isLoading: loadingRoles } = useQuery({
    queryKey: ['/api/entities/Role'],
    queryFn: () => base44.entities.Role.list({ sort: { name: 'asc' } })
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

  // For EditEvent, we do NOT auto-apply default VAT to existing tickets
  // They were intentionally set (or left blank) when created/edited
  // Only newly added tickets via addTicketClass will get the default

  // Trim summary if it exceeds the limit when settings load or summary changes
  useEffect(() => {
    if (formData.summary && formData.summary.length > summaryMaxLength) {
      setFormData(prev => ({
        ...prev,
        summary: prev.summary.slice(0, summaryMaxLength)
      }));
    }
  }, [summaryMaxLength, formData.summary]);

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

  // Email configuration helper functions
  const TIMING_OPTIONS = [
    { value: '7_days_before', label: '7 days before' },
    { value: '3_days_before', label: '3 days before' },
    { value: '1_day_before', label: '1 day before' },
    { value: '12_hours_before', label: '12 hours before' },
    { value: '6_hours_before', label: '6 hours before' },
    { value: '1_hour_before', label: '1 hour before' },
    { value: '30_minutes_before', label: '30 minutes before' },
    { value: 'custom', label: 'Custom timing' }
  ];

  const createEmptyEmail = (emailType = 'reminder') => ({
    id: `email-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    email_type: emailType,
    timing_type: emailType === 'booking_confirmation' ? null : '1_day_before',
    custom_hours_before: null,
    subject: emailType === 'booking_confirmation' 
      ? 'Your booking confirmation for {{event_name}}'
      : 'Reminder: {{event_name}} is coming up!',
    body: emailType === 'booking_confirmation'
      ? 'Dear {{attendee_first_name}},\n\nThank you for booking {{event_name}}.\n\nEvent Date: {{event_date}}\nLocation: {{event_location}}\n{{#zoom_link}}Join Link: {{zoom_link}}{{/zoom_link}}\n\nWe look forward to seeing you!'
      : 'Dear {{attendee_first_name}},\n\nThis is a reminder that {{event_name}} is coming up soon.\n\nEvent Date: {{event_date}}\nLocation: {{event_location}}\n{{#zoom_link}}Join Link: {{zoom_link}}{{/zoom_link}}\n\nSee you there!',
    is_enabled: true,
    isNew: true
  });

  const addEventEmail = (emailType = 'reminder') => {
    setEventEmails([...eventEmails, createEmptyEmail(emailType)]);
  };

  const removeEventEmail = (emailId) => {
    setEventEmails(eventEmails.filter(e => e.id !== emailId));
  };

  const updateEventEmail = (emailId, field, value) => {
    setEventEmails(prev => prev.map(e => 
      e.id === emailId ? { ...e, [field]: value } : e
    ));
  };

  const loadTemplateIntoEmail = (emailId, templateId) => {
    const template = emailTemplates.find(t => t.id === templateId);
    if (!template) return;
    
    setEventEmails(prev => prev.map(e => 
      e.id === emailId ? { 
        ...e, 
        subject: template.subject || e.subject,
        body: template.body || e.body,
        loaded_template_id: templateId,
        loaded_template_name: template.name
      } : e
    ));
    toast.success(`Loaded template: ${template.name}`);
  };

  const getTimingLabel = (timingType) => {
    const option = TIMING_OPTIONS.find(o => o.value === timingType);
    return option ? option.label : timingType;
  };

  const saveEventEmails = async () => {
    setIsSavingEmails(true);
    try {
      const response = await fetch(`/api/event-emails/${eventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ emails: eventEmails })
      });
      
      if (!response.ok) {
        throw new Error('Failed to save email configurations');
      }
      
      const savedEmails = await response.json();
      setEventEmails(savedEmails);
      queryClient.invalidateQueries({ queryKey: ['event-emails', eventId] });
      toast.success('Email configurations saved');
    } catch (error) {
      console.error('Error saving emails:', error);
      toast.error('Failed to save email configurations');
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
      return base44.entities.Event.update(eventId, eventData);
    },
    onSuccess: () => {
      toast.success('Event updated successfully');
      queryClient.invalidateQueries({ queryKey: ['events'] });
      queryClient.invalidateQueries({ queryKey: ['event', eventId] });
      setTimeout(() => {
        window.location.href = createPageUrl('Events');
      }, 500);
    },
    onError: (error) => {
      console.error('Update event error:', error);
      const errorMessage = error.message || error.error || 'Unknown error occurred';
      toast.error('Failed to update event: ' + errorMessage);
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
        event_type: event.event_type || "",
        program_tag: event.program_tag || "",
        start_date: isTbcEvent ? "" : (event.start_date || ""),
        end_date: isTbcEvent ? "" : (event.end_date || ""),
        location: event.location || "",
        image_url: event.image_url || "",
        image_focal_point: event.image_focal_point || null,
        // Only show available_seats if it's a positive number (limited seats), otherwise treat as unlimited
        available_seats: event.available_seats !== null && event.available_seats !== undefined && event.available_seats > 0
          ? String(event.available_seats) 
          : "",
        zoom_webinar_id: event.zoom_webinar_id || null,
        zoom_meeting_id: event.zoom_meeting_id || null,
        cta_override_url: event.cta_override_url || ""
      });
      
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
      
      setInitialDataLoaded(true);

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
              name: tc.name || "Standard Ticket",
              price: priceValue !== null ? String(priceValue) : "",
              is_free: priceValue === 0,
              role_ids: tc.role_ids || [],
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
              vat_rate_percentage: tc.vat_rate_percentage || null
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
            name: "Standard Ticket",
            price: legacyPrice !== null ? String(legacyPrice) : "",
            is_free: legacyPrice === 0,
            role_ids: [],
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
      }

      // Load speaker_ids from event
      if (event.speaker_ids && Array.isArray(event.speaker_ids)) {
        setSelectedSpeakers(event.speaker_ids);
      } else {
        setSelectedSpeakers([]);
      }
      
      // Load status from event (default to 'published' for backwards compatibility)
      setEventStatus(event.status || 'published');
    }
  }, [event?.id, initialDataLoaded]);
  
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

  const handleSubmit = (e) => {
    e.preventDefault();
    
    // Only require program_tag for program events
    if (!isOneOffEvent && !formData.program_tag) {
      toast.error('Please select a program');
      return;
    }
    
    // Only require start_date for non-TBC events
    if (eventStatus !== 'tbc' && !formData.start_date) {
      toast.error('Please set a start date');
      return;
    }

    if (!formData.title) {
      toast.error('Please enter an event title');
      return;
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

    // For TBC events, explicitly null out dates and Zoom webinar
    const isTbcEvent = eventStatus === 'tbc';
    
    const eventData = {
      title: formData.title,
      summary: formData.summary || null,
      description: formData.description || null,
      internal_reference: formData.internal_reference || null,
      event_type: formData.event_type || null,
      // For one-off events, program_tag should be empty string; for program events, use the selected program
      // Visibility is determined by program_tag: empty = one-off event, non-empty = program event
      program_tag: isOneOffEvent ? "" : formData.program_tag,
      // For TBC events, dates must be null
      start_date: isTbcEvent ? null : (formData.start_date || null),
      end_date: isTbcEvent ? null : (formData.end_date || formData.start_date || null),
      location: isOnlineEvent ? null : (formData.location || null),
      image_url: formData.image_url || null,
      image_focal_point: formData.image_focal_point || null,
      available_seats: unlimitedSeats ? null : (formData.available_seats ? parseInt(formData.available_seats) : null),
      is_unlimited_registration: unlimitedSeats,
      // Per-event seat visibility (only meaningful when global setting is ON)
      show_seat_count: showSeatCount,
      // Per-event ticket availability display toggle
      show_ticket_availability: showTicketAvailability,
      // TBC events can optionally have a Zoom webinar or meeting
      zoom_webinar_id: zoomType === 'webinar' ? (formData.zoom_webinar_id || null) : null,
      zoom_meeting_id: zoomType === 'meeting' ? (selectedMeetingId || null) : null,
      speaker_ids: selectedSpeakers.length > 0 ? selectedSpeakers : [],
      // Convert composite keys back to plain labels for database storage
      filter_tags: selectedFilterTags.length > 0 
        ? selectedFilterTags.map(key => parseFilterTagKey(key).label) 
        : [],
      cta_override_url: formData.cta_override_url || null,
      // TBC events can still be online, but webinar is optional
      is_online: isOnlineEvent,
      status: eventStatus
    };

    // Add ticket classes for one-off events
    if (isOneOffEvent) {
      const formattedTicketClasses = ticketClasses.map(ticket => {
        const ticketData = {
          id: ticket.id,
          name: ticket.name,
          price: parseFloat(ticket.price),
          role_ids: ticket.role_ids || [],
          is_default: ticket.is_default || false,
          visibility_mode: ticket.visibility_mode || 'members_only',
          role_match_only: ticket.role_match_only || false,
          offer_type: ticket.offer_type,
          // Ticket availability: null = unlimited, number = limited
          available_count: ticket.is_unlimited_tickets ? null : (ticket.available_count ? parseInt(ticket.available_count) : null),
          is_unlimited_tickets: ticket.is_unlimited_tickets !== false,
          // VAT rate fields for Xero invoice generation
          vat_rate_key: ticket.vat_rate_key || null,
          vat_rate_label: ticket.vat_rate_label || null,
          vat_rate_percentage: ticket.vat_rate_percentage || null
        };

        if (ticket.offer_type === "bogo") {
          ticketData.bogo_buy_quantity = parseInt(ticket.bogo_buy_quantity);
          ticketData.bogo_get_free_quantity = parseInt(ticket.bogo_get_free_quantity);
          ticketData.bogo_logic_type = ticket.bogo_logic_type;
        } else if (ticket.offer_type === "bulk_discount") {
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
        allowGuestsToViewAllTickets: allowGuestsToViewAllTickets
      };
    }

    updateEventMutation.mutate(eventData);
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const formatDateForInput = (dateStr) => {
    if (!dateStr) return "";
    try {
      return format(new Date(dateStr), "yyyy-MM-dd'T'HH:mm");
    } catch {
      return "";
    }
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

    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <Button 
            variant="ghost" 
            size="icon"
            onClick={() => window.location.href = createPageUrl('Events')}
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
        </div>

        {isOnlineEvent && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <Globe className="h-4 w-4 text-blue-600" />
              <span className="font-medium text-blue-900">Online Event</span>
            </div>
            <p className="text-sm text-blue-800">
              This is an online event linked to a Zoom {formData.zoom_meeting_id ? 'meeting' : 'webinar'}. The date, time, and location fields are managed by Zoom and cannot be edited here.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Event Status Selector */}
          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <Eye className="h-5 w-5 text-purple-600" />
                Event Status
              </CardTitle>
              <CardDescription>Set the visibility status of this event</CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup
                value={eventStatus}
                onValueChange={handleStatusChange}
                className="grid grid-cols-3 gap-4"
                data-testid="radio-event-status"
              >
                <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${eventStatus === 'draft' ? 'border-amber-500 bg-amber-50' : 'border-slate-200 hover:border-slate-300'}`}>
                  <RadioGroupItem value="draft" id="status-draft" data-testid="radio-status-draft" />
                  <Label htmlFor="status-draft" className="cursor-pointer flex-1">
                    <span className="font-medium">Draft</span>
                    <p className="text-xs text-slate-500">Hidden from members</p>
                  </Label>
                </div>
                <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${eventStatus === 'published' ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:border-slate-300'}`}>
                  <RadioGroupItem value="published" id="status-published" data-testid="radio-status-published" />
                  <Label htmlFor="status-published" className="cursor-pointer flex-1">
                    <span className="font-medium">Published</span>
                    <p className="text-xs text-slate-500">Visible to members</p>
                  </Label>
                </div>
                <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${eventStatus === 'tbc' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                  <RadioGroupItem value="tbc" id="status-tbc" data-testid="radio-status-tbc" />
                  <Label htmlFor="status-tbc" className="cursor-pointer flex-1">
                    <span className="font-medium">To Be Confirmed</span>
                    <p className="text-xs text-slate-500">Dates shown as TBC</p>
                  </Label>
                </div>
              </RadioGroup>
              {eventStatus === 'tbc' && (
                <p className="mt-3 text-sm text-blue-600 bg-blue-50 p-2 rounded">
                  Dates will be shown as "To be confirmed" and Zoom webinar/meeting selection is optional.
                </p>
              )}
            </CardContent>
          </Card>

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
                  <span className={formData.summary.length >= summaryMaxLength - 10 ? 'text-amber-600' : ''}>
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

                {eventTypes.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="event_type">Event Type</Label>
                    <Select
                      value={formData.event_type || "_none"}
                      onValueChange={(val) => handleInputChange('event_type', val === "_none" ? "" : val)}
                    >
                      <SelectTrigger id="event_type" data-testid="select-event-type">
                        <SelectValue placeholder="Select event type..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">None</SelectItem>
                        {eventTypes.map((type, idx) => {
                          const typeName = typeof type === 'string' ? type : type.name;
                          return (
                            <SelectItem key={idx} value={typeName}>{typeName}</SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Categorize this event by type (e.g., Workshop, Training).
                    </p>
                  </div>
                )}
              </div>

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
                  Optional. If set, the event card's CTA button will link to this URL instead of the default event details page. 
                  Use this to link to a custom Event Spotlight page.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start_date">
                    Start Date & Time {eventStatus !== 'tbc' && '*'}
                  </Label>
                  <Input
                    id="start_date"
                    type="datetime-local"
                    value={formatDateForInput(formData.start_date)}
                    onChange={(e) => handleInputChange('start_date', new Date(e.target.value).toISOString())}
                    required={eventStatus !== 'tbc'}
                    disabled={eventStatus === 'tbc' || isOnlineEvent}
                    className={(eventStatus === 'tbc' || isOnlineEvent) ? "bg-slate-100 cursor-not-allowed" : ""}
                    data-testid="input-start-date"
                  />
                  {eventStatus === 'tbc' && (
                    <p className="text-xs text-blue-600">Date disabled for TBC events</p>
                  )}
                  {isOnlineEvent && eventStatus !== 'tbc' && (
                    <p className="text-xs text-slate-500">Managed by Zoom webinar</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end_date">End Date & Time</Label>
                  <Input
                    id="end_date"
                    type="datetime-local"
                    value={formatDateForInput(formData.end_date)}
                    onChange={(e) => handleInputChange('end_date', new Date(e.target.value).toISOString())}
                    disabled={eventStatus === 'tbc' || isOnlineEvent}
                    className={(eventStatus === 'tbc' || isOnlineEvent) ? "bg-slate-100 cursor-not-allowed" : ""}
                    data-testid="input-end-date"
                  />
                  {isOnlineEvent && eventStatus !== 'tbc' && (
                    <p className="text-xs text-slate-500">Managed by Zoom webinar</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

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
                          </div>
                          <div className="flex items-center gap-2 text-sm text-slate-500">
                            <span>£{ticket.price || "0.00"}</span>
                            <span className="text-slate-300">|</span>
                            <span className="flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {getRoleNames(ticket.role_ids)}
                            </span>
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
                          <div className="space-y-2 md:col-span-2">
                            <Label htmlFor={`ticket-name-${ticket.id}`}>Ticket Name *</Label>
                            <Input
                              id={`ticket-name-${ticket.id}`}
                              value={ticket.name}
                              onChange={(e) => updateTicketClass(ticket.id, 'name', e.target.value)}
                              placeholder="e.g. Member Ticket"
                              data-testid={`input-ticket-name-${ticket.id}`}
                            />
                          </div>
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
                                  min={ticketClassSoldCounts[ticket.id] || 0}
                                  value={ticket.available_count || ""}
                                  onChange={(e) => updateTicketClass(ticket.id, 'available_count', e.target.value)}
                                  placeholder="e.g. 50"
                                  className="w-24"
                                  data-testid={`input-ticket-available-count-${ticket.id}`}
                                />
                                <span className="text-sm text-slate-500">tickets</span>
                                {ticketClassSoldCounts[ticket.id] > 0 && (
                                  <span className="text-xs text-amber-600">
                                    ({ticketClassSoldCounts[ticket.id]} sold)
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Role Assignment */}
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

                          {/* Role Match Only Toggle - only show if roles are selected AND visibility includes members */}
                          {(ticket.role_ids || []).length > 0 && ticket.visibility_mode !== 'public_only' && (
                            <div className="mt-3 flex items-center justify-between p-3 bg-amber-50 border border-amber-200 rounded-lg">
                              <div className="flex items-center gap-2">
                                <Users className="h-4 w-4 text-amber-600" />
                                <div>
                                  <Label htmlFor={`role-match-only-${ticket.id}`} className="text-sm font-medium text-amber-800">
                                    Match only to user role
                                  </Label>
                                  <p className="text-xs text-amber-600">
                                    {ticket.role_match_only 
                                      ? "Ticket is hidden from users whose role doesn't match" 
                                      : "Ticket is visible to all users (role only affects who can register)"}
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
                            <p className="text-xs text-amber-600">
                              No VAT rates available. Sync rates from Xero in Admin Setup.
                            </p>
                          )}
                          {ticket.vat_rate_key && (
                            <p className="text-xs text-green-600">
                              {ticket.vat_rate_label} ({ticket.vat_rate_percentage}%)
                            </p>
                          )}
                        </div>
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
                {ticketClasses.length > 0 && (
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
                {isOnlineEvent && (
                  <p className="text-xs text-slate-500">
                    Online event - location is managed by Zoom webinar
                  </p>
                )}
                {isOnlineEvent && (
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
                        <span className="text-amber-700">Join link is hidden - members must register via ticket purchase</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500 mt-2">
                      To change visibility for future events using this webinar, update the setting in Zoom Webinar Provisioning
                    </p>
                  </div>
                )}
              </div>

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
                {globalShowSeats && (
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
                {isOneOffEvent && (
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
              
              {formData.image_url && (
                <FocalPointPicker
                  imageUrl={formData.image_url}
                  focalPoint={formData.image_focal_point}
                  onChange={(point) => handleInputChange('image_focal_point', point)}
                />
              )}
            </CardContent>
          </Card>

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
              {loadingEmails ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                  <span className="ml-2 text-slate-500">Loading email configurations...</span>
                </div>
              ) : eventEmails.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <Mail className="h-12 w-12 mx-auto mb-3 text-slate-300" />
                  <p>No email configurations yet</p>
                  <p className="text-sm mt-1">Add a confirmation or reminder email to get started</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {eventEmails.map((email, index) => (
                    <div 
                      key={email.id} 
                      className={`p-4 border rounded-lg ${email.email_type === 'booking_confirmation' ? 'border-green-200 bg-green-50' : 'border-blue-200 bg-blue-50'}`}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2">
                          {email.email_type === 'booking_confirmation' ? (
                            <Badge variant="outline" className="bg-green-100 text-green-700 border-green-300">
                              <Check className="h-3 w-3 mr-1" />
                              Confirmation
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-blue-100 text-blue-700 border-blue-300">
                              <Bell className="h-3 w-3 mr-1" />
                              Reminder
                            </Badge>
                          )}
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={email.is_enabled}
                              onCheckedChange={(checked) => updateEventEmail(email.id, 'is_enabled', checked)}
                              data-testid={`switch-email-enabled-${email.id}`}
                            />
                            <span className="text-sm text-slate-600">
                              {email.is_enabled ? 'Enabled' : 'Disabled'}
                            </span>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeEventEmail(email.id)}
                          className="text-slate-400 hover:text-red-500"
                          data-testid={`button-remove-email-${email.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      {/* Timing Selection for Reminders */}
                      {email.email_type === 'reminder' && (
                        <div className="mb-3">
                          <Label className="text-sm font-medium flex items-center gap-1 mb-2">
                            <Clock className="h-4 w-4" />
                            Send Timing
                          </Label>
                          <Select
                            value={email.timing_type || '1_day_before'}
                            onValueChange={(value) => updateEventEmail(email.id, 'timing_type', value)}
                          >
                            <SelectTrigger className="w-full bg-white" data-testid={`select-timing-${email.id}`}>
                              <SelectValue placeholder="Select when to send" />
                            </SelectTrigger>
                            <SelectContent>
                              {TIMING_OPTIONS.map(option => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          
                          {email.timing_type === 'custom' && (
                            <div className="mt-2 flex items-center gap-2">
                              <Input
                                type="number"
                                min="1"
                                value={email.custom_hours_before || ''}
                                onChange={(e) => updateEventEmail(email.id, 'custom_hours_before', parseInt(e.target.value) || null)}
                                placeholder="Hours"
                                className="w-24 bg-white"
                                data-testid={`input-custom-hours-${email.id}`}
                              />
                              <span className="text-sm text-slate-600">hours before event</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Load from Template */}
                      {emailTemplates.length > 0 && (
                        <div className="mb-3">
                          <Label className="text-sm font-medium mb-2 block flex items-center gap-2">
                            <Download className="h-4 w-4" />
                            Load from Template
                          </Label>
                          <div className="flex gap-2">
                            <Select
                              value={email.loaded_template_id || "none"}
                              onValueChange={(templateId) => {
                                if (templateId !== "none") {
                                  loadTemplateIntoEmail(email.id, templateId);
                                }
                              }}
                            >
                              <SelectTrigger className="bg-white" data-testid={`select-template-${email.id}`}>
                                <SelectValue placeholder="Select a template to load..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Select a template to load...</SelectItem>
                                {emailTemplates.map(template => (
                                  <SelectItem key={template.id} value={template.id}>
                                    {template.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {email.loaded_template_name && (
                            <p className="text-xs text-slate-500 mt-1">
                              Based on: {email.loaded_template_name} (edits won't affect the original template)
                            </p>
                          )}
                        </div>
                      )}

                      {/* Subject Line */}
                      <div className="mb-3">
                        <Label className="text-sm font-medium mb-2 block">Subject</Label>
                        <Input
                          value={email.subject}
                          onChange={(e) => updateEventEmail(email.id, 'subject', e.target.value)}
                          placeholder="Email subject line"
                          className="bg-white"
                          data-testid={`input-email-subject-${email.id}`}
                        />
                      </div>

                      {/* Email Body with Plain Text / Rich Text Toggle */}
                      <div className="mb-3">
                        <div className="flex items-center justify-between mb-2">
                          <Label className="text-sm font-medium">Body</Label>
                          <div className="flex gap-1">
                            <Button
                              type="button"
                              variant={emailCodeViewMode[email.id] === 'richtext' ? "ghost" : "secondary"}
                              size="sm"
                              onClick={() => setEmailCodeViewMode(prev => ({ ...prev, [email.id]: undefined }))}
                              className="h-7 px-2"
                              data-testid={`button-plain-text-${email.id}`}
                            >
                              <Code className="h-3 w-3 mr-1" />
                              Plain Text
                            </Button>
                            <Button
                              type="button"
                              variant={emailCodeViewMode[email.id] === 'richtext' ? "secondary" : "ghost"}
                              size="sm"
                              onClick={() => setEmailCodeViewMode(prev => ({ ...prev, [email.id]: 'richtext' }))}
                              className="h-7 px-2"
                              data-testid={`button-rich-text-${email.id}`}
                            >
                              <FileText className="h-3 w-3 mr-1" />
                              Rich Text
                            </Button>
                          </div>
                        </div>
                        
                        {emailCodeViewMode[email.id] === 'richtext' ? (
                          <div className="bg-white border rounded-md overflow-hidden">
                            <ReactQuill
                              theme="snow"
                              value={email.body || ''}
                              onChange={(value) => updateEventEmail(email.id, 'body', value)}
                              modules={emailQuillModules}
                              placeholder="Email body content"
                              className="[&_.ql-editor]:min-h-[150px]"
                              data-testid={`quill-email-body-${email.id}`}
                            />
                          </div>
                        ) : (
                          <Textarea
                            value={email.body}
                            onChange={(e) => updateEventEmail(email.id, 'body', e.target.value)}
                            placeholder="Email body content"
                            className="bg-white min-h-[200px]"
                            data-testid={`textarea-email-body-${email.id}`}
                          />
                        )}
                        <p className="text-xs text-slate-500 mt-1">
                          Available placeholders: {'{{event_name}}'}, {'{{event_date}}'}, {'{{event_location}}'}, {'{{attendee_first_name}}'}, {'{{zoom_link}}'}
                        </p>
                      </div>
                    </div>
                  ))}
                  
                  {/* Save Emails Button */}
                  <div className="flex justify-end pt-2">
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
                </div>
              )}
            </CardContent>
          </Card>

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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      {renderContent()}
    </div>
  );
}
