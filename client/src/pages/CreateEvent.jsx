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
  Eye
} from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import EventImageUpload from "@/components/events/EventImageUpload";
import { SpeakerSelectionModal } from "@/components/SpeakerSelectionModal";
import { useSpeakerModuleName } from "@/hooks/useSpeakerModuleName";
import { useEventTypes } from "@/hooks/useEventTypes";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

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
const createEmptyTicketClass = (isDefault = false) => ({
  id: `ticket-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
  name: isDefault ? "Standard Ticket" : "",
  price: "",
  is_free: false, // When true, ticket is free (price = 0)
  role_ids: [], // Empty array means "All Roles"
  is_default: isDefault,
  visibility_mode: 'members_only', // 'members_only', 'members_and_public', or 'public_only'
  role_match_only: false, // When true AND visibility includes members, ticket only shows if user's role matches role_ids
  offer_type: "none",
  bogo_logic_type: "buy_x_get_y_free",
  bogo_buy_quantity: "",
  bogo_get_free_quantity: "",
  bulk_discount_threshold: "",
  bulk_discount_percentage: ""
});

export default function CreateEvent() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { singular: speakerSingular, plural: speakerPlural } = useSpeakerModuleName();
  const { eventTypes } = useEventTypes();
  const [isOnline, setIsOnline] = useState(false);
  const [isProgramEvent, setIsProgramEvent] = useState(true);
  const [selectedWebinarId, setSelectedWebinarId] = useState("");
  
  // Ticket classes state for one-off events
  const [ticketClasses, setTicketClasses] = useState([createEmptyTicketClass(true)]);
  const [expandedTickets, setExpandedTickets] = useState({});
  const [allowGuestsToViewAllTickets, setAllowGuestsToViewAllTickets] = useState(false);
  
  const [formData, setFormData] = useState({
    title: "",
    summary: "",
    description: "",
    internal_reference: "",
    program_tag: "",
    event_type: "",
    start_date: "",
    end_date: "",
    location: "",
    image_url: "",
    available_seats: "",
    delivery_mode: "offline",
    zoom_webinar_id: null,
    online_url: ""
  });

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

  // Ticket class management functions
  const addTicketClass = () => {
    const newTicket = createEmptyTicketClass(false);
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

  const { data: webinars = [], isLoading: loadingWebinars } = useQuery({
    queryKey: ['/api/zoom/webinars'],
    queryFn: async () => {
      const data = await apiRequest('/api/zoom/webinars');
      return data.filter(w => w.status === 'scheduled' && new Date(w.start_time) > new Date());
    },
    enabled: isOnline
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
        online_url: selectedWebinar.join_url || "",
        delivery_mode: "online",
        location: "Online Event",
        available_seats: 0
      }));
    }
  }, [selectedWebinar]);

  const createEventMutation = useMutation({
    mutationFn: async (eventData) => {
      return base44.entities.Event.create(eventData);
    },
    onSuccess: () => {
      toast.success('Event created successfully');
      queryClient.invalidateQueries({ queryKey: ['events'] });
      setTimeout(() => {
        window.location.href = createPageUrl('Events');
      }, 500);
    },
    onError: (error) => {
      console.error('Create event error:', error);
      const errorMessage = error.message || error.error || 'Unknown error occurred';
      toast.error('Failed to create event: ' + errorMessage);
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (isProgramEvent && !formData.program_tag) {
      toast.error('Please select a program');
      return;
    }
    
    if (!formData.start_date) {
      toast.error('Please set a start date');
      return;
    }
    
    if (isOnline && !selectedWebinarId) {
      toast.error('Please select a Zoom webinar for online events');
      return;
    }

    if (isOnline && loadingJoinLinkSettings) {
      toast.error('Please wait for settings to load');
      return;
    }

    if (!formData.title) {
      toast.error('Please enter an event title');
      return;
    }

    // Validation for one-off event ticket classes
    if (!isProgramEvent) {
      if (ticketClasses.length === 0) {
        toast.error('Please add at least one ticket class');
        return;
      }

      for (let i = 0; i < ticketClasses.length; i++) {
        const ticket = ticketClasses[i];
        const ticketLabel = ticket.name || `Ticket ${i + 1}`;

        // Name is required
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

        // Validate BOGO offer
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

        // Validate bulk discount offer
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
      }
    }

    // Build event data - only include fields that exist in the event table
    // For online events: store URL in location only if show join link setting is enabled
    let locationValue = formData.location;
    if (isOnline) {
      const showJoinLink = getShowJoinLink(selectedWebinarId);
      if (showJoinLink && formData.online_url) {
        locationValue = `Online - ${formData.online_url}`;
      } else {
        locationValue = 'Online Event';
      }
    }

    const eventData = {
      title: formData.title,
      summary: formData.summary || null,
      description: formData.description || null,
      internal_reference: formData.internal_reference || null,
      event_type: formData.event_type || null,
      // Visibility is determined by program_tag: empty = one-off event, non-empty = program event
      program_tag: isProgramEvent ? formData.program_tag : "",
      start_date: formData.start_date,
      end_date: formData.end_date || formData.start_date,
      location: locationValue,
      image_url: formData.image_url || null,
      available_seats: isOnline ? null : (formData.available_seats ? parseInt(formData.available_seats) : null),
      zoom_webinar_id: isOnline && selectedWebinarId ? selectedWebinarId : null,
      speaker_ids: selectedSpeakers.length > 0 ? selectedSpeakers : [],
      filter_tags: selectedFilterTags.length > 0 ? selectedFilterTags : []
    };

    // Add ticket classes for one-off events as JSON in pricing_config field
    if (!isProgramEvent) {
      const formattedTicketClasses = ticketClasses.map(ticket => {
        const ticketData = {
          id: ticket.id,
          name: ticket.name,
          price: parseFloat(ticket.price),
          role_ids: ticket.role_ids || [],
          is_default: ticket.is_default || false,
          visibility_mode: ticket.visibility_mode || 'members_only',
          role_match_only: ticket.role_match_only || false,
          offer_type: ticket.offer_type
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

    createEventMutation.mutate(eventData);
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleDeliveryModeChange = (online) => {
    setIsOnline(online);
    if (!online) {
      setSelectedWebinarId("");
      setFormData(prev => ({
        ...prev,
        delivery_mode: "offline",
        zoom_webinar_id: null,
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
    return format(date, "MMM d, yyyy 'at' h:mm a");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
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
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Create Event</h1>
            <p className="text-slate-600">Set up a new event for your members</p>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
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
                        ? 'Event will be hosted via Zoom webinar'
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

              {isOnline && (
                <div className="space-y-3">
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

                  {selectedWebinar && (
                    <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                      <div className="flex items-center gap-2 mb-2">
                        <Video className="h-4 w-4 text-green-600" />
                        <span className="font-medium text-green-900">Webinar Selected</span>
                      </div>
                      <div className="space-y-1 text-sm text-green-800">
                        <p><strong>Topic:</strong> {selectedWebinar.topic}</p>
                        <p><strong>Date:</strong> {formatWebinarDateTime(selectedWebinar)}</p>
                        <p><strong>Duration:</strong> {selectedWebinar.duration} minutes</p>
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
                              <span className="text-amber-700">Hidden - members must register via ticket purchase</span>
                            )}
                          </p>
                          <p className="text-xs text-green-600 mt-1">
                            Change this setting in Zoom Webinar Provisioning
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
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
                  readOnly={isOnline && selectedWebinar}
                  className={isOnline && selectedWebinar ? "bg-slate-100" : ""}
                  data-testid="input-title"
                />
                {isOnline && selectedWebinar && (
                  <p className="text-xs text-slate-500">Title is synced from the Zoom webinar</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="summary">Summary</Label>
                <Textarea
                  id="summary"
                  value={formData.summary}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value.length <= 150) {
                      handleInputChange('summary', value);
                    }
                  }}
                  placeholder="Brief summary for event cards (max 150 characters)"
                  className="resize-none"
                  rows={2}
                  data-testid="input-summary"
                />
                <div className="flex justify-between text-xs text-slate-500">
                  <span>Displayed on event cards and listings</span>
                  <span className={formData.summary.length >= 140 ? 'text-amber-600' : ''}>
                    {formData.summary.length}/150
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Full Description</Label>
                <div className={`border rounded-md overflow-hidden ${isOnline && selectedWebinar ? "bg-slate-100" : ""}`} data-testid="input-description">
                  <ReactQuill
                    theme="snow"
                    value={formData.description || ''}
                    onChange={(value) => handleInputChange('description', value)}
                    modules={quillModules}
                    formats={quillFormats}
                    placeholder="Describe the event..."
                    style={{ minHeight: '150px' }}
                    readOnly={isOnline && selectedWebinar}
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
                            <span className="truncate max-w-[200px]">{selectedFilterTags[0]}</span>
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
                              const isSelected = selectedFilterTags.includes(subcategory);
                              return (
                                <button
                                  key={subcategory}
                                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${
                                    isSelected 
                                      ? "bg-slate-100 text-slate-900 font-medium" 
                                      : "text-slate-600 hover:bg-slate-50"
                                  }`}
                                  onClick={() => {
                                    if (isSelected) {
                                      setSelectedFilterTags(prev => prev.filter(t => t !== subcategory));
                                    } else {
                                      setSelectedFilterTags(prev => [...prev, subcategory]);
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
                      {selectedFilterTags.map((tag, idx) => (
                        <Badge 
                          key={idx} 
                          variant="secondary" 
                          className="text-xs"
                        >
                          {tag}
                          <button
                            type="button"
                            className="ml-1 hover:text-slate-900"
                            onClick={() => setSelectedFilterTags(prev => prev.filter(t => t !== tag))}
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
                        {eventTypes.map((type, idx) => (
                          <SelectItem key={idx} value={type}>{type}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Categorize this event by type (e.g., Workshop, Training).
                    </p>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start_date">Start Date & Time *</Label>
                  <Input
                    id="start_date"
                    type="datetime-local"
                    value={formData.start_date ? format(new Date(formData.start_date), "yyyy-MM-dd'T'HH:mm") : ""}
                    onChange={(e) => handleInputChange('start_date', new Date(e.target.value).toISOString())}
                    required
                    readOnly={isOnline && selectedWebinar}
                    className={isOnline && selectedWebinar ? "bg-slate-100" : ""}
                    data-testid="input-start-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end_date">End Date & Time</Label>
                  <Input
                    id="end_date"
                    type="datetime-local"
                    value={formData.end_date ? format(new Date(formData.end_date), "yyyy-MM-dd'T'HH:mm") : ""}
                    onChange={(e) => handleInputChange('end_date', new Date(e.target.value).toISOString())}
                    readOnly={isOnline && selectedWebinar}
                    className={isOnline && selectedWebinar ? "bg-slate-100" : ""}
                    data-testid="input-end-date"
                  />
                </div>
              </div>
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
                        {/* Ticket Name and Price */}
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
                          >
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                              <div 
                                className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                  ticket.offer_type === 'none' 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:bg-slate-50'
                                }`}
                                onClick={() => updateTicketClass(ticket.id, 'offer_type', 'none')}
                              >
                                <RadioGroupItem value="none" id={`offer-none-${ticket.id}`} />
                                <Label htmlFor={`offer-none-${ticket.id}`} className="text-sm cursor-pointer">No Offer</Label>
                              </div>
                              <div 
                                className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                  ticket.offer_type === 'bogo' 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:bg-slate-50'
                                }`}
                                onClick={() => updateTicketClass(ticket.id, 'offer_type', 'bogo')}
                              >
                                <RadioGroupItem value="bogo" id={`offer-bogo-${ticket.id}`} />
                                <Label htmlFor={`offer-bogo-${ticket.id}`} className="text-sm cursor-pointer">BOGO</Label>
                              </div>
                              <div 
                                className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                  ticket.offer_type === 'bulk_discount' 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:bg-slate-50'
                                }`}
                                onClick={() => updateTicketClass(ticket.id, 'offer_type', 'bulk_discount')}
                              >
                                <RadioGroupItem value="bulk_discount" id={`offer-bulk-${ticket.id}`} />
                                <Label htmlFor={`offer-bulk-${ticket.id}`} className="text-sm cursor-pointer">Bulk Discount</Label>
                              </div>
                            </div>
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
                      Participants will join via Zoom. The join link will be provided upon registration.
                    </p>
                  </div>
                  {formData.online_url && (
                    <div className="space-y-2">
                      <Label>Zoom Join URL</Label>
                      <div className="flex items-center gap-2 p-3 bg-slate-100 rounded-lg">
                        <LinkIcon className="h-4 w-4 text-slate-500" />
                        <span className="text-sm text-slate-600 truncate">{formData.online_url}</span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
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

                  <div className="space-y-2">
                    <Label htmlFor="available_seats">Available Seats</Label>
                    <Input
                      id="available_seats"
                      type="number"
                      min="0"
                      value={formData.available_seats}
                      onChange={(e) => handleInputChange('available_seats', e.target.value)}
                      placeholder="Leave empty for unlimited"
                      data-testid="input-seats"
                    />
                    <p className="text-xs text-slate-500">
                      Leave empty or set to 0 for unlimited capacity
                    </p>
                  </div>
                </>
              )}

              <EventImageUpload
                value={formData.image_url}
                onChange={(url) => handleInputChange('image_url', url)}
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
    </div>
  );
}
