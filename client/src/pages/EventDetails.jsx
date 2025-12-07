
import React, { useState, useEffect, useRef, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Calendar, MapPin, Clock, Users, ArrowLeft, Ticket, Plus, Loader2, Video, AlertTriangle, PoundSterling, User, Mic, ChevronRight, X, Lock } from "lucide-react";
import { format } from "date-fns";
import DOMPurify from "dompurify";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import AttendeeList from "../components/booking/AttendeeList";
import PaymentOptions from "../components/booking/PaymentOptions";
import ColleagueSelector from "../components/booking/ColleagueSelector";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useSpeakerModuleName } from "@/hooks/useSpeakerModuleName";

export default function EventDetailsPage() {
  const { memberInfo, organizationInfo, memberRole, isFeatureExcluded, reloadMemberInfo, refreshOrganizationInfo } = useMemberAccess();
  const { singular: speakerSingular, plural: speakerPlural } = useSpeakerModuleName();
  const [memberInfoState, setMemberInfoState] = useState(null);
  const [showTour, setShowTour] = useState(false);
  const [tourAutoShow, setTourAutoShow] = useState(false);

  const currentMemberInfo = memberInfo || memberInfoState;

  const [attendees, setAttendees] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [registrationMode, setRegistrationMode] = useState('colleagues');
  const [memberAttending, setMemberAttending] = useState(false);
  const [showColleagueSelector, setShowColleagueSelector] = useState(false);
  const [selectedTicketClassId, setSelectedTicketClassId] = useState(null);
  const [paymentCanProceed, setPaymentCanProceed] = useState(false);

  // Modal states for description and speaker profiles
  const [showDescriptionModal, setShowDescriptionModal] = useState(false);
  const [showSpeakerModal, setShowSpeakerModal] = useState(false);
  const [selectedSpeaker, setSelectedSpeaker] = useState(null);

  // Guest registration form state (for non-logged-in users)
  const [guestInfo, setGuestInfo] = useState({
    first_name: '',
    last_name: '',
    email: '',
    organization: '',
    phone: '',
    job_title: ''
  });

  // Validate guest form
  const isGuestFormValid = useMemo(() => {
    return guestInfo.first_name.trim() !== '' &&
           guestInfo.last_name.trim() !== '' &&
           guestInfo.email.trim() !== '' &&
           guestInfo.email.includes('@') &&
           guestInfo.organization.trim() !== '';
  }, [guestInfo]);

  // Check if user is a guest (not logged in)
  const isGuestCheckout = !currentMemberInfo;

  // Track if initialization has completed to prevent resets on subsequent renders
  const hasInitialized = useRef(null);

  const urlParams = new URLSearchParams(window.location.search);
  const eventId = urlParams.get('id');
  const debugMode = urlParams.get('debugZoom') === '1';

  // Determine if tours should be shown for this user
  const shouldShowTours = memberRole?.show_tours !== false;

  // Check if user has seen this page's tour
  const hasSeenTour = currentMemberInfo?.page_tours_seen?.EventDetails === true;

  // Auto-show tour on first visit if tours are enabled
  React.useEffect(() => {
    if (shouldShowTours && !hasSeenTour && currentMemberInfo) {
      setTourAutoShow(true);
      setShowTour(true);
    }
  }, [shouldShowTours, hasSeenTour, currentMemberInfo]);

  useEffect(() => {
    if (!memberInfo) {
      const storedMember = sessionStorage.getItem('agcas_member');
      if (storedMember) {
        setMemberInfoState(JSON.parse(storedMember));
      } else {
        setMemberInfoState(null);
      }
    }
  }, [memberInfo]);

  // Initialization useEffect - now only runs once per eventId change
  // Always defaults to 'colleagues' mode with Attendees card shown
  useEffect(() => {
    console.log('[EventDetails] Initialization useEffect - hasInitialized.current:', hasInitialized.current, 'eventId:', eventId);
    
    // Only run initialization logic once per eventId
    if (hasInitialized.current === eventId) {
      console.log('[EventDetails] Already initialized for this eventId, skipping initialization');
      return;
    }

    console.log('[EventDetails] Running initialization logic');
    hasInitialized.current = eventId; // Mark as initialized for this eventId

    if (currentMemberInfo && eventId) {
      const savedRegistration = sessionStorage.getItem(`event_registration_${eventId}`);
      console.log('[EventDetails] Saved registration in sessionStorage:', savedRegistration ? 'exists' : 'not found');

      if (savedRegistration) {
        let { attendees: savedAttendees, memberAttending: savedMemberAttending } = JSON.parse(savedRegistration);
        console.log('[EventDetails] Loaded saved registration - attendees:', savedAttendees.length);

        setAttendees(savedAttendees);
        setRegistrationMode('colleagues');
        setMemberAttending(savedMemberAttending !== undefined ? savedMemberAttending : false);
        
        // Only auto-show colleague selector if no attendees
        if (savedAttendees.length === 0) {
          setShowColleagueSelector(true);
        } else {
          setShowColleagueSelector(false);
        }
      } else {
        // No saved registration - set defaults
        console.log('[EventDetails] No saved registration - initializing defaults');
        setRegistrationMode('colleagues');
        setMemberAttending(false);
        setAttendees([]);
        setShowColleagueSelector(true);
      }
    } else {
      // For unauthenticated users
      console.log('[EventDetails] No memberInfo - setting up for unauthenticated user');
      setAttendees([]);
      setRegistrationMode('colleagues');
      setMemberAttending(false);
      setShowColleagueSelector(true);
    }
  }, [eventId]); // CRITICAL: Only depends on eventId

  // Separate useEffect to save state to sessionStorage
  useEffect(() => {
    // Only save if initialization has completed for the current eventId
    if (eventId && currentMemberInfo && hasInitialized.current === eventId) {
      const registrationData = {
        attendees,
        registrationMode,
        memberAttending
      };
      sessionStorage.setItem(`event_registration_${eventId}`, JSON.stringify(registrationData));
    }
  }, [attendees, registrationMode, memberAttending, eventId, currentMemberInfo]);

  const { data: event, isLoading } = useQuery({
    queryKey: ['event', eventId],
    queryFn: async () => {
      const events = await base44.entities.Event.list();
      return events.find((e) => e.id === eventId);
    },
    enabled: !!eventId
  });

  // Query for speakers assigned to this event
  const { data: eventSpeakers = [] } = useQuery({
    queryKey: ['event-speakers', event?.speaker_ids],
    queryFn: async () => {
      if (!event?.speaker_ids || event.speaker_ids.length === 0) return [];
      const allSpeakers = await base44.entities.Speaker.list();
      return allSpeakers.filter(s => event.speaker_ids.includes(s.id));
    },
    enabled: !!event?.speaker_ids && event.speaker_ids.length > 0
  });

  // Query for webinar join link visibility settings
  const { data: joinLinkSettings } = useQuery({
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

  // Query for webinars to match URLs to webinar IDs
  const { data: webinars = [] } = useQuery({
    queryKey: ['/api/zoom/webinars'],
    queryFn: async () => {
      try {
        const response = await fetch('/api/zoom/webinars');
        if (!response.ok) return [];
        return await response.json();
      } catch {
        return [];
      }
    }
  });

  // Determine if this is an online event and if join link should be shown
  const isOnlineEvent = event?.location?.toLowerCase().startsWith('online');
  const hasUrlInLocation = event?.location?.includes('https://') || event?.location?.includes('http://');
  
  // Find matching webinar by URL if location contains a URL
  const getWebinarIdFromLocation = () => {
    if (!hasUrlInLocation || !webinars?.length || !event?.location) return null;
    const urlMatch = event.location.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) return null;
    const url = urlMatch[0];
    const matchingWebinar = webinars.find(w => w.join_url === url);
    return matchingWebinar?.id || null;
  };

  // Check if join link should be shown based on settings
  const shouldShowJoinLink = () => {
    if (!isOnlineEvent || !hasUrlInLocation) return false;
    const webinarId = getWebinarIdFromLocation();
    if (!webinarId || !joinLinkSettings) return false;
    return joinLinkSettings[webinarId] === true;
  };

  // ========== PRICING/TICKET CLASS HOOKS - MUST BE BEFORE EARLY RETURNS ==========
  // These hooks MUST be called unconditionally to avoid React hooks order violations
  
  // Determine if this is a one-off event (guard for null event)
  const isOneOffEvent = event && (!event.program_tag || event.program_tag === "");
  
  // Get the user's role ID
  const userRoleId = memberRole?.id || currentMemberInfo?.role_id;
  
  // One-off event pricing calculations - parse if it's a JSON string
  const pricingConfig = useMemo(() => {
    // Guard for missing event or not a one-off event
    if (!event || !isOneOffEvent || !event.pricing_config) return null;
    
    let parsed = null;
    
    // Handle case where pricing_config is a JSON string from the database
    if (typeof event.pricing_config === 'string') {
      try {
        parsed = JSON.parse(event.pricing_config);
      } catch (e) {
        console.error('Failed to parse pricing_config:', e);
        return null;
      }
    } else if (typeof event.pricing_config === 'object' && event.pricing_config !== null) {
      // Already an object - make a shallow copy to avoid mutation issues
      parsed = { ...event.pricing_config };
    }
    
    // Validate that parsed is a plain object
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('pricing_config is not a valid object:', parsed);
      return null;
    }
    
    return parsed;
  }, [event, isOneOffEvent]);
  
  // Get ALL normalized ticket classes (for display purposes when "show all" toggle is on)
  const allNormalizedTickets = useMemo(() => {
    if (!isOneOffEvent || !pricingConfig) return [];
    
    // Ensure ticket_classes is an array
    const rawTicketClasses = pricingConfig.ticket_classes;
    const ticketClasses = Array.isArray(rawTicketClasses) ? rawTicketClasses : [];
    
    // If no ticket classes defined, use legacy single-price format
    if (ticketClasses.length === 0) {
      return [{
        id: 'default',
        name: 'Standard Ticket',
        price: Number(pricingConfig.ticket_price) || 0,
        role_ids: [],
        is_default: true,
        visibility_mode: 'members_only', // Legacy tickets are members only
        role_match_only: false,
        offer_type: String(pricingConfig.offer_type || 'none'),
        bogo_logic_type: String(pricingConfig.bogo_logic_type || 'buy_x_get_y_free'),
        bogo_buy_quantity: Number(pricingConfig.bogo_buy_quantity) || 0,
        bogo_get_free_quantity: Number(pricingConfig.bogo_get_free_quantity) || 0,
        bulk_discount_threshold: Number(pricingConfig.bulk_discount_threshold) || 0,
        bulk_discount_percentage: Number(pricingConfig.bulk_discount_percentage) || 0
      }];
    }
    
    // Normalize ticket classes with backwards compatibility for is_public field
    return ticketClasses
      .filter(tc => tc && typeof tc === 'object')
      .map(tc => {
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
          id: String(tc.id || `ticket-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`),
          name: String(tc.name || 'Ticket'),
          price: Number(tc.price) || 0,
          role_ids: Array.isArray(tc.role_ids) ? tc.role_ids : [],
          is_default: Boolean(tc.is_default),
          visibility_mode: visibilityMode,
          role_match_only: Boolean(tc.role_match_only),
          offer_type: String(tc.offer_type || 'none'),
          bogo_logic_type: String(tc.bogo_logic_type || 'buy_x_get_y_free'),
          bogo_buy_quantity: Number(tc.bogo_buy_quantity) || 0,
          bogo_get_free_quantity: Number(tc.bogo_get_free_quantity) || 0,
          bulk_discount_threshold: Number(tc.bulk_discount_threshold) || 0,
          bulk_discount_percentage: Number(tc.bulk_discount_percentage) || 0
        };
      });
  }, [isOneOffEvent, pricingConfig]);
  
  // Helper to check if a ticket is purchasable by the current user
  // Visibility logic:
  // - Members Only: Visible to logged-in members. If role_match_only=true, only if user's role is in role_ids
  // - Members & Public: Same as Members Only + visible to non-logged-in visitors
  // - Public Only: ONLY visible/purchasable by non-logged-in visitors
  const isTicketPurchasable = (ticket) => {
    if (!ticket) return false;
    
    const visibilityMode = ticket.visibility_mode;
    
    // For non-logged-in users
    if (!currentMemberInfo) {
      // Can only purchase public_only tickets (and members_and_public tickets)
      return visibilityMode === 'public_only' || visibilityMode === 'members_and_public';
    }
    
    // For logged-in members
    // Public-only tickets cannot be purchased by logged-in members
    if (visibilityMode === 'public_only') return false;
    
    // Members Only and Members & Public tickets:
    // If role_match_only is false, any logged-in member can purchase
    if (!ticket.role_match_only) return true;
    
    // If role_match_only is true, check if user's role is in the ticket's role_ids
    // Empty role_ids means all roles (no restriction)
    if (ticket.role_ids.length === 0) return true;
    
    return userRoleId && ticket.role_ids.includes(userRoleId);
  };
  
  // Check if admin has enabled showing all tickets to guests
  const allowGuestsToViewAllTickets = pricingConfig?.allowGuestsToViewAllTickets || false;
  
  // Get ticket classes that should be displayed
  // For non-logged-in users: show based on admin setting allowGuestsToViewAllTickets
  // For logged-in users: tickets they have access to based on visibility and role
  const availableTicketClasses = useMemo(() => {
    if (!isOneOffEvent || !pricingConfig) return [];
    
    // For logged-in members, filter based on visibility_mode and role_match_only
    if (currentMemberInfo) {
      return allNormalizedTickets.filter(tc => {
        // Public-only tickets are NOT visible to logged-in members
        if (tc.visibility_mode === 'public_only') return false;
        
        // If role_match_only is false or not set, show the ticket
        if (!tc.role_match_only) return true;
        
        // If role_match_only is true, only show if user's role is in the ticket's role_ids
        // Empty role_ids means all roles (no restriction)
        if (tc.role_ids.length === 0) return true;
        
        // Check if user's role matches any of the ticket's role_ids
        return userRoleId && tc.role_ids.includes(userRoleId);
      });
    }
    
    // For non-logged-in users: if admin enabled allowGuestsToViewAllTickets, show ALL tickets
    if (allowGuestsToViewAllTickets) {
      return allNormalizedTickets;
    }
    
    // Otherwise only show tickets that include public visibility
    return allNormalizedTickets.filter(tc => 
      tc.visibility_mode === 'members_and_public' || tc.visibility_mode === 'public_only'
    );
  }, [isOneOffEvent, pricingConfig, currentMemberInfo, userRoleId, allNormalizedTickets, allowGuestsToViewAllTickets]);
  
  // Auto-select first available PURCHASABLE ticket class
  // Also reset selection if currently selected ticket becomes non-purchasable
  useEffect(() => {
    if (availableTicketClasses.length > 0) {
      // Find the currently selected ticket if any
      const currentSelection = selectedTicketClassId 
        ? availableTicketClasses.find(tc => tc.id === selectedTicketClassId)
        : null;
      
      // If no selection or current selection is not purchasable, select first purchasable ticket
      if (!currentSelection || !isTicketPurchasable(currentSelection)) {
        // Find the first purchasable ticket, preferring the default one
        const purchasableTickets = availableTicketClasses.filter(isTicketPurchasable);
        if (purchasableTickets.length > 0) {
          const defaultPurchasable = purchasableTickets.find(tc => tc.is_default);
          setSelectedTicketClassId(defaultPurchasable?.id || purchasableTickets[0]?.id);
        } else {
          // No purchasable tickets available - clear selection
          setSelectedTicketClassId(null);
        }
      }
    }
  }, [availableTicketClasses, selectedTicketClassId, allowGuestsToViewAllTickets, currentMemberInfo, userRoleId]);
  
  // Get selected ticket class
  const selectedTicketClass = useMemo(() => {
    if (availableTicketClasses.length === 0) return null;
    if (!selectedTicketClassId) return availableTicketClasses[0] || null;
    return availableTicketClasses.find(tc => tc.id === selectedTicketClassId) || availableTicketClasses[0] || null;
  }, [availableTicketClasses, selectedTicketClassId]);
  
  // Check if user can self-register based on selected ticket's role restrictions
  const canSelfRegister = useMemo(() => {
    if (!isOneOffEvent || !selectedTicketClass) return true; // Non-one-off events have no role restrictions
    
    const roleIds = selectedTicketClass.role_ids || [];
    // If no role_ids specified (empty array), ticket is available to all roles
    if (roleIds.length === 0) return true;
    // Check if user's role is in the selected ticket's role_ids
    return userRoleId && roleIds.includes(userRoleId);
  }, [isOneOffEvent, selectedTicketClass, userRoleId]);
  
  
  // When ticket selection changes and user can no longer self-register, handle mode/attendance changes
  useEffect(() => {
    if (isOneOffEvent && !canSelfRegister) {
      // If in self mode, switch to colleagues mode
      if (registrationMode === 'self') {
        console.log('[EventDetails] User can no longer self-register for selected ticket, switching to colleagues mode');
        setRegistrationMode('colleagues');
        setAttendees([]);
        setMemberAttending(false);
      } else if (memberAttending) {
        // If in colleagues mode but was attending, remove self from attendees
        console.log('[EventDetails] User can no longer self-register, removing self from attendees');
        setAttendees(prev => prev.filter(a => !a.isSelf));
        setMemberAttending(false);
      }
    }
  }, [isOneOffEvent, canSelfRegister, registrationMode, memberAttending]);
  
  // ========== END PRICING/TICKET CLASS HOOKS ==========

  const removeAttendee = (index) => {
    setAttendees(attendees.filter((_, i) => i !== index));
  };

  const updateAttendee = (index, field, value) => {
    const updated = [...attendees];
    updated[index][field] = value;
    setAttendees(updated);
  };

  const handleColleagueSelect = (colleagueData) => {
    setAttendees([...attendees, {
      ...colleagueData,
      isValid: true,
      isSelf: false
    }]);
    setShowColleagueSelector(false);
  };

  const toggleMemberAttendance = () => {
    if (!currentMemberInfo) return;

    const newAttendingState = !memberAttending;
    setMemberAttending(newAttendingState);

    if (newAttendingState) {
      const memberAsAttendee = {
        email: currentMemberInfo.email || "",
        first_name: currentMemberInfo.first_name || "",
        last_name: currentMemberInfo.last_name || "",
        isValid: true,
        isSelf: true
      };
      if (!attendees.some((a) => a.isSelf)) {
        setAttendees([memberAsAttendee, ...attendees]);
      } else {
        const filteredAttendees = attendees.filter((a) => !a.isSelf);
        setAttendees([memberAsAttendee, ...filteredAttendees]);
      }
    } else {
      setAttendees(attendees.filter((a) => !a.isSelf));
    }
  };

  const handleTourComplete = async () => {
    setShowTour(false);
    setTourAutoShow(false);
  };

  const handleTourDismiss = async () => {
    setShowTour(false);
    setTourAutoShow(false);
    await updateMemberTourStatus('EventDetails');
  };

  const handleStartTour = () => {
    setShowTour(false);
    setTourAutoShow(false);
    
    setTimeout(() => {
      setShowTour(true);
      setTourAutoShow(true);
    }, 10);
  };

  const updateMemberTourStatus = async (tourKey) => {
    if (currentMemberInfo && !currentMemberInfo.is_team_member) {
      try {
        const allMembers = await base44.entities.Member.listAll();
        const currentMember = allMembers.find(m => m.email === currentMemberInfo.email);
        
        if (currentMember) {
          const updatedTours = { ...(currentMember.page_tours_seen || {}), [tourKey]: true };
          await base44.entities.Member.update(currentMember.id, {
            page_tours_seen: updatedTours
          });
          
          const updatedMemberInfo = { ...currentMemberInfo, page_tours_seen: updatedTours };
          sessionStorage.setItem('agcas_member', JSON.stringify(updatedMemberInfo));
          
          // Notify Layout to reload memberInfo
          if (reloadMemberInfo) {
            reloadMemberInfo();
          }
        }
      } catch (error) {
        console.error('Failed to update tour status:', error);
      }
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-full bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading event...</div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="min-h-full bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto text-center py-16">
          <h2 className="text-2xl font-bold text-slate-900 mb-4">Event not found</h2>
          <Link to={createPageUrl('Events')}>
            <Button>Back to Events</Button>
          </Link>
        </div>
      </div>
    );
  }

  const startDate = event.start_date ? new Date(event.start_date) : null;
  const endDate = event.end_date ? new Date(event.end_date) : null;
  const hasUnlimitedCapacity = event.available_seats === 0 || event.available_seats === null;
  
  // Calculate ticket count and costs
  // For guest checkout, it's always 1 ticket if form is valid
  const ticketsRequired = isGuestCheckout 
    ? (isGuestFormValid ? 1 : 0)
    : (registrationMode === 'links' ? 0 : attendees.filter((a) => a.isValid).length);
  
  // Use selected ticket class price (or legacy price)
  const ticketPrice = selectedTicketClass?.price || pricingConfig?.ticket_price || 0;
  
  // Calculate one-off event cost with offers based on selected ticket class
  const calculateOneOffCost = () => {
    if (!isOneOffEvent || !selectedTicketClass || ticketsRequired === 0) {
      return { totalCost: 0, ticketsToPay: ticketsRequired, freeTickets: 0, discount: 0, discountDescription: '' };
    }
    
    const basePrice = selectedTicketClass.price || 0;
    let ticketsToPay = ticketsRequired;
    let freeTickets = 0;
    let discount = 0;
    let discountDescription = '';
    
    // Use offer configuration from selected ticket class
    const offerType = selectedTicketClass.offer_type || 'none';
    
    if (offerType === 'bogo' && selectedTicketClass.bogo_buy_quantity && selectedTicketClass.bogo_get_free_quantity) {
      const buyQty = selectedTicketClass.bogo_buy_quantity;
      const freeQty = selectedTicketClass.bogo_get_free_quantity;
      
      if (selectedTicketClass.bogo_logic_type === 'enter_total_pay_less') {
        // "Enter Total, Pay Less" - customer enters total tickets they want
        // For every (buyQty + freeQty) tickets, they only pay for buyQty
        const bundleSize = buyQty + freeQty;
        const fullBundles = Math.floor(ticketsRequired / bundleSize);
        const remainder = ticketsRequired % bundleSize;
        
        ticketsToPay = (fullBundles * buyQty) + remainder;
        freeTickets = ticketsRequired - ticketsToPay;
        discountDescription = `Buy ${buyQty}, get ${freeQty} free`;
      } else {
        // "Buy X, Get Y Free" (legacy) - customer pays for X and gets Y free on top
        const bundleSize = buyQty + freeQty;
        const fullBundles = Math.floor(ticketsRequired / bundleSize);
        const remainder = ticketsRequired % bundleSize;
        
        ticketsToPay = (fullBundles * buyQty) + Math.min(remainder, buyQty);
        freeTickets = ticketsRequired - ticketsToPay;
        discountDescription = `Buy ${buyQty}, get ${freeQty} free`;
      }
    } else if (offerType === 'bulk_discount' && selectedTicketClass.bulk_discount_threshold && selectedTicketClass.bulk_discount_percentage) {
      const threshold = selectedTicketClass.bulk_discount_threshold;
      const percentage = selectedTicketClass.bulk_discount_percentage;
      
      if (ticketsRequired >= threshold) {
        discount = (basePrice * ticketsRequired * percentage) / 100;
        discountDescription = `${percentage}% off for ${threshold}+ tickets`;
      }
    }
    
    const totalCost = Math.max(0, (ticketsToPay * basePrice) - discount);
    
    return { totalCost, ticketsToPay, freeTickets, discount, discountDescription };
  };
  
  const oneOffCostDetails = calculateOneOffCost();
  
  // For program events, use the old logic
  const totalCost = isOneOffEvent 
    ? oneOffCostDetails.totalCost 
    : attendees.filter((a) => a.isValid).length * (event.ticket_price || 0);
  
  const availableProgramTickets = event.program_tag && organizationInfo?.program_ticket_balances ?
    organizationInfo.program_ticket_balances[event.program_tag] || 0 : 0;
  const hasEnoughTickets = isOneOffEvent ? true : availableProgramTickets >= ticketsRequired;
  
  // Check if user has no tickets available for their role
  const noTicketsForRole = isOneOffEvent && availableTicketClasses.length === 0;
  
  // For one-off events, use paymentCanProceed from PaymentOptions (includes payment validation)
  // For program events, need enough tickets
  const canConfirmBooking = isOneOffEvent 
    ? paymentCanProceed
    : (hasEnoughTickets && event.program_tag && !submitting && ticketsRequired > 0);

  // Check if available seats display is excluded
  const showAvailableSeats = !isFeatureExcluded || !isFeatureExcluded('element_AvailableSeatsDisplay');

  const handleConfirmBooking = async () => {
    console.log('[EventDetails] handleConfirmBooking called');
    console.log('[EventDetails] canConfirmBooking:', canConfirmBooking);
    console.log('[EventDetails] hasEnoughTickets:', hasEnoughTickets);
    console.log('[EventDetails] event.program_tag:', event?.program_tag);
    console.log('[EventDetails] submitting:', submitting);
    console.log('[EventDetails] ticketsRequired:', ticketsRequired);
    console.log('[EventDetails] attendees:', attendees);
    
    // Validate attendees have all required information
    console.log('[EventDetails] Checking attendee validation, registrationMode:', registrationMode);
    if (registrationMode === 'colleagues' || registrationMode === 'self') {
      const invalidAttendees = attendees.filter((a) => {
        const needsManualName = !a.isSelf && (
          a.validationStatus === 'unregistered_domain_match' ||
          a.validationStatus === 'external');

        if (needsManualName && (!a.first_name || !a.last_name)) {
          return true;
        }

        return false;
      });

      if (invalidAttendees.length > 0) {
        console.log('[EventDetails] Invalid attendees found:', invalidAttendees);
        toast.error('Please provide first and last names for all attendees');
        return;
      }
    }
    console.log('[EventDetails] Passed attendee validation');

    if (!hasEnoughTickets) {
      console.log('[EventDetails] Not enough tickets');
      toast.error("Insufficient program tickets. Please purchase more tickets first.");
      return;
    }
    console.log('[EventDetails] Passed ticket check');

    if (registrationMode === 'colleagues' && attendees.some((a) => !a.isValid)) {
      console.log('[EventDetails] Some attendees are invalid');
      toast.error("Please remove or fix invalid attendee emails");
      return;
    }
    console.log('[EventDetails] Passed colleagues validation');

    if (ticketsRequired === 0) {
      console.log('[EventDetails] No tickets required');
      toast.error("Please add at least one attendee or specify number of links");
      return;
    }
    console.log('[EventDetails] All validation passed, setting submitting=true');

    setSubmitting(true);

    try {
      console.log('[EventDetails] About to call createBooking API');
      const requestPayload = {
        eventId: event.id,
        memberEmail: currentMemberInfo.email,
        attendees: registrationMode === 'colleagues' || registrationMode === 'self' ? attendees.filter((a) => a.isValid) : [],
        registrationMode: registrationMode,
        numberOfLinks: registrationMode === 'links' ? 0 : 0,
        ticketsRequired: ticketsRequired,
        programTag: event.program_tag
      };
      console.log('[EventDetails] Request payload:', JSON.stringify(requestPayload));
      console.log('[EventDetails] Event location:', event.location);
      console.log('[EventDetails] Event backstage_event_id:', event.backstage_event_id);
      
      const response = await base44.functions.invoke('createBooking', requestPayload);
      console.log('[EventDetails] createBooking FULL response:', JSON.stringify(response.data, null, 2));
      console.log('[EventDetails] Event type:', response.data.event_type);
      console.log('[EventDetails] Zoom registration:', JSON.stringify(response.data.zoom_registration, null, 2));
      
      if (response.data.warning) {
        console.warn('[EventDetails] Warning:', response.data.warning);
      }

      if (response.data.success) {
        console.log('[EventDetails] Booking succeeded!');
        sessionStorage.removeItem(`event_registration_${event.id}`);

        // Show different messages based on event type
        if (response.data.event_type === 'zoom') {
          if (response.data.zoom_registration?.webinar_found) {
            const successCount = response.data.zoom_registration.registrations?.filter(r => r.success).length || 0;
            toast.success(`Booking confirmed! ${successCount} attendee(s) registered with Zoom.`);
          } else {
            toast.success("Booking confirmed! (Zoom webinar not found - manual registration may be needed)");
          }
        } else {
          toast.success("Booking confirmed!");
        }
        
        // Debug mode: show full response before redirect
        if (debugMode) {
          try {
            const zoomReg = response.data.zoom_registration || {};
            const debugText = [
              'DEBUG MODE - Booking Response:',
              '',
              'Event Type: ' + (response.data.event_type || 'unknown'),
              'Event Location: ' + (event.location || 'null'),
              'Backstage Event ID: ' + (event.backstage_event_id || 'null'),
              '',
              '--- Zoom Registration ---',
              'Webinar Found: ' + (zoomReg.webinar_found ? 'YES' : 'NO'),
              'Extracted Webinar ID: ' + (zoomReg.debug?.extracted_webinar_id || 'null'),
              'Matched Webinar ID: ' + (zoomReg.debug?.webinar_matched_id || 'null'),
              'Registration Count: ' + (zoomReg.registrations?.length || 0),
              '',
              'Warning: ' + (response.data.warning || 'none')
            ].join('\n');
            alert(debugText);
          } catch (e) {
            alert('Debug Error: ' + e.message);
          }
        }
        
        // Defer organization refresh to avoid React state update conflicts
        setTimeout(() => {
          if (refreshOrganizationInfo) {
            refreshOrganizationInfo();
          }
          window.location.href = createPageUrl('Bookings');
        }, debugMode ? 100 : 1500);
        return; // Exit early, don't setSubmitting(false) as we're navigating away
      } else {
        console.log('[EventDetails] Booking failed:', response.data.error);
        toast.error(response.data.error || "Failed to create booking");
      }
    } catch (error) {
      console.error('[EventDetails] createBooking error:', error);
      toast.error(error.message || error.response?.data?.error || "Failed to create booking");
    }
    setSubmitting(false);
  };

  return (
    <div className="min-h-full bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      {showTour && shouldShowTours && (
        <PageTour
          tourGroupName="EventDetails"
          viewId={null}
          onComplete={handleTourComplete}
          onDismissPermanently={handleTourDismiss}
          autoShow={tourAutoShow}
        />
      )}

      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Link to={createPageUrl('Events')} className="inline-flex items-center gap-2 text-slate-600 hover:text-slate-900">
            <ArrowLeft className="w-4 h-4" />
            Back to Events
          </Link>
          {shouldShowTours && (
            <TourButton onClick={handleStartTour} />
          )}
        </div>

        <div className="grid lg:grid-cols-3 gap-8 mb-8">
          <div className="lg:col-span-2 space-y-6">
            {event.image_url && (
              <div className="rounded-xl overflow-hidden shadow-lg">
                <img
                  src={event.image_url}
                  alt={event.title}
                  className="w-full h-64 object-cover"
                />
              </div>
            )}

            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <div className="flex items-start justify-between gap-4 mb-2">
                  <h1 className="text-3xl font-bold text-slate-900">{event.title}</h1>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    {event.program_tag && (
                      <Badge className="bg-purple-100 text-purple-700 border-purple-200">
                        {event.program_tag}
                      </Badge>
                    )}
                    {event.filter_tags && event.filter_tags.length > 0 && event.filter_tags.map((tag, index) => (
                      <Badge key={index} className="bg-purple-100 text-purple-700 border-purple-200">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
                
                <div className="space-y-3 pt-4">
                  {startDate && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <Calendar className="w-5 h-5 text-slate-400" />
                      <span className="font-medium">{format(startDate, "EEEE, MMMM d, yyyy")}</span>
                      {endDate && startDate.getTime() !== endDate.getTime() && (
                        <span className="text-slate-500">- {format(endDate, "MMMM d, yyyy")}</span>
                      )}
                    </div>
                  )}

                  {startDate && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <Clock className="w-5 h-5 text-slate-400" />
                      <span>{format(startDate, "h:mm a")}</span>
                      {endDate && (
                        <span className="text-slate-500">- {format(endDate, "h:mm a")}</span>
                      )}
                    </div>
                  )}

                  {event.location && (
                    <div className="flex items-center gap-3 text-slate-700">
                      {isOnlineEvent ? (
                        <>
                          <Video className="w-5 h-5 text-green-500" />
                          {shouldShowJoinLink() && hasUrlInLocation ? (
                            <span>{event.location}</span>
                          ) : (
                            <span className="text-green-600 font-medium">Online Event</span>
                          )}
                        </>
                      ) : (
                        <>
                          <MapPin className="w-5 h-5 text-slate-400" />
                          <span>{event.location}</span>
                        </>
                      )}
                    </div>
                  )}

                  {showAvailableSeats && (
                    <div className="flex items-center gap-3">
                      <Users className="w-5 h-5 text-slate-400" />
                      {hasUnlimitedCapacity ? (
                        <span className="text-green-600 font-medium">Open Registration - No Capacity Limit</span>
                      ) : event.available_seats !== undefined && event.available_seats > 0 ? (
                        <span className="text-green-600 font-medium">{event.available_seats} seats available</span>
                      ) : event.available_seats !== undefined ? (
                        <span className="text-red-600 font-medium">Sold out</span>
                      ) : null}
                    </div>
                  )}
                </div>
              </CardHeader>

              {/* Description Preview Section - Shows summary, with link to full description */}
              {(event.summary || event.description) && (
                <CardContent className="pt-6 border-t border-slate-200">
                  <h3 className="font-semibold text-slate-900 mb-3">About this event</h3>
                  <div className="space-y-3">
                    {event.summary && (
                      <p 
                        className="text-slate-600"
                        data-testid="text-event-summary"
                      >
                        {event.summary}
                      </p>
                    )}
                    {event.description && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 px-0 h-auto py-1"
                        onClick={() => setShowDescriptionModal(true)}
                        data-testid="button-more-information"
                      >
                        More information
                        <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              )}

              {/* Speakers Section */}
              {eventSpeakers.length > 0 && (
                <CardContent className="pt-6 border-t border-slate-200">
                  <h3 className="font-semibold text-slate-900 mb-4 flex items-center gap-2">
                    <Mic className="w-5 h-5 text-purple-600" />
                    {speakerPlural}
                  </h3>
                  <div className="flex flex-wrap gap-4">
                    {eventSpeakers.map((speaker) => (
                      <button
                        key={speaker.id}
                        onClick={() => {
                          setSelectedSpeaker(speaker);
                          setShowSpeakerModal(true);
                        }}
                        className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 hover:border-purple-300 hover:bg-purple-50 transition-colors cursor-pointer text-left group"
                        data-testid={`button-speaker-${speaker.id}`}
                      >
                        <Avatar className="h-12 w-12">
                          {speaker.profile_photo_url ? (
                            <AvatarImage src={speaker.profile_photo_url} alt={speaker.full_name} />
                          ) : null}
                          <AvatarFallback className="bg-purple-100 text-purple-700 font-medium">
                            {speaker.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium text-slate-900 group-hover:text-purple-700">
                            {speaker.full_name}
                          </div>
                          {(speaker.job_title || speaker.organization) && (
                            <div className="text-sm text-slate-500">
                              {speaker.job_title}
                              {speaker.job_title && speaker.organization && ', '}
                              {speaker.organization}
                            </div>
                          )}
                        </div>
                        <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-purple-600 ml-2" />
                      </button>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>

            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-200">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xl">
                    {isGuestCheckout ? 'Your Details' : 'Attendees'}
                  </CardTitle>
                  {!isGuestCheckout && (
                    <div className="flex items-center gap-4">
                      {currentMemberInfo && canSelfRegister && (
                        <div className="flex items-center gap-3" id="member-attending-toggle">
                          <Switch
                            id="member-attending"
                            checked={memberAttending}
                            onCheckedChange={toggleMemberAttendance}
                          />
                          <Label htmlFor="member-attending" className="text-sm font-medium text-slate-700 cursor-pointer">
                            I am attending
                          </Label>
                        </div>
                      )}
                      <Button
                        id="add-colleague-button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowColleagueSelector(true)}
                        className="gap-2"
                      >
                        <Plus className="w-4 h-4" />
                        Add Colleague
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-6 space-y-4">
                {/* Guest Registration Form - shown for non-logged-in users */}
                {isGuestCheckout ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <User className="w-5 h-5 text-blue-600" />
                      <p className="text-sm text-blue-800">
                        Please enter your details to register for this event.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="guest-first-name">First Name <span className="text-red-500">*</span></Label>
                        <Input
                          id="guest-first-name"
                          placeholder="Enter your first name"
                          value={guestInfo.first_name}
                          onChange={(e) => setGuestInfo({...guestInfo, first_name: e.target.value})}
                          data-testid="input-guest-first-name"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="guest-last-name">Last Name <span className="text-red-500">*</span></Label>
                        <Input
                          id="guest-last-name"
                          placeholder="Enter your last name"
                          value={guestInfo.last_name}
                          onChange={(e) => setGuestInfo({...guestInfo, last_name: e.target.value})}
                          data-testid="input-guest-last-name"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="guest-email">Email Address <span className="text-red-500">*</span></Label>
                      <Input
                        id="guest-email"
                        type="email"
                        placeholder="your.email@example.com"
                        value={guestInfo.email}
                        onChange={(e) => setGuestInfo({...guestInfo, email: e.target.value})}
                        data-testid="input-guest-email"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="guest-organization">Organisation <span className="text-red-500">*</span></Label>
                      <Input
                        id="guest-organization"
                        placeholder="Your company or organisation"
                        value={guestInfo.organization}
                        onChange={(e) => setGuestInfo({...guestInfo, organization: e.target.value})}
                        data-testid="input-guest-organization"
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="guest-job-title">Job Title</Label>
                        <Input
                          id="guest-job-title"
                          placeholder="Your job title"
                          value={guestInfo.job_title}
                          onChange={(e) => setGuestInfo({...guestInfo, job_title: e.target.value})}
                          data-testid="input-guest-job-title"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="guest-phone">Phone Number</Label>
                        <Input
                          id="guest-phone"
                          type="tel"
                          placeholder="Optional"
                          value={guestInfo.phone}
                          onChange={(e) => setGuestInfo({...guestInfo, phone: e.target.value})}
                          data-testid="input-guest-phone"
                        />
                      </div>
                    </div>

                    {!isGuestFormValid && (
                      <p className="text-xs text-slate-500">
                        <span className="text-red-500">*</span> Required fields
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    {showColleagueSelector && (
                      <div className="p-4 border border-blue-200 rounded-lg bg-blue-50">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="font-medium text-slate-900">Add Colleague</h3>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowColleagueSelector(false)}
                          >
                            Cancel
                          </Button>
                        </div>
                        <div id="colleague-search-input">
                          <ColleagueSelector
                            organizationId={currentMemberInfo?.organization_id}
                            onSelect={handleColleagueSelect}
                            memberInfo={currentMemberInfo}
                            ticketRoleIds={selectedTicketClass?.role_ids || []}
                          />
                        </div>
                      </div>
                    )}

                    {attendees.length === 0 ? (
                      <div className="text-center py-8 text-slate-500">
                        <Users className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                        <p>No attendees added yet</p>
                        {currentMemberInfo && (
                          <p className="text-sm mt-1">Toggle "I am attending" or add colleagues to get started.</p>
                        )}
                      </div>
                    ) : (
                      <>
                        <AttendeeList
                          attendees={attendees}
                          onUpdate={updateAttendee}
                          onRemove={removeAttendee}
                          memberInfo={currentMemberInfo}
                        />
                        
                        {/* Only show confirm button for program events - one-off events use PaymentOptions button */}
                        {!isOneOffEvent && (
                          <div className="pt-4 border-t border-slate-200">
                            <Button
                              onClick={() => {
                                console.log('[EventDetails] Button clicked!');
                                console.log('[EventDetails] Button disabled state:', !canConfirmBooking);
                                handleConfirmBooking();
                              }}
                              disabled={!canConfirmBooking}
                              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
                              size="lg"
                            >
                              {submitting ? (
                                <>
                                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                  Processing...
                                </>
                              ) : (
                                'Confirm Booking'
                              )}
                            </Button>
                            
                            {!hasEnoughTickets && event.program_tag && (
                              <p className="text-xs text-center text-amber-600 mt-2">
                                Insufficient program tickets. You need {ticketsRequired - availableProgramTickets} more ticket{ticketsRequired - availableProgramTickets > 1 ? 's' : ''}.
                              </p>
                            )}
                            
                            {ticketsRequired === 0 && (
                              <p className="text-xs text-center text-slate-500 mt-2">
                                Add attendees to proceed with booking
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-1 space-y-6">
            {/* No tickets available for role message */}
            {isOneOffEvent && noTicketsForRole && (
              <Card className="border-amber-200 bg-amber-50 shadow-sm mb-4">
                <CardContent className="pt-6">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <h3 className="font-medium text-amber-800">No Tickets Available</h3>
                      <p className="text-sm text-amber-700 mt-1">
                        There are no ticket classes available for your role. Please contact the event organizer for assistance.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Ticket Class Selector - Only shown for one-off events with multiple ticket classes */}
            {isOneOffEvent && availableTicketClasses.length > 1 && (
              <Card className="border-slate-200 shadow-sm mb-4">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Ticket className="h-5 w-5 text-blue-600" />
                    Select Ticket Type
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <RadioGroup 
                    value={String(selectedTicketClassId || '')} 
                    onValueChange={(value) => {
                      // Only allow selection of purchasable tickets
                      const ticket = availableTicketClasses.find(tc => String(tc.id) === value);
                      if (ticket && isTicketPurchasable(ticket)) {
                        setSelectedTicketClassId(value);
                      }
                    }}
                    className="space-y-3"
                  >
                    {availableTicketClasses.map((tc) => {
                      const ticketId = String(tc.id || '');
                      const ticketPrice = Number(tc.price) || 0;
                      const purchasable = isTicketPurchasable(tc);
                      const isSelected = String(selectedTicketClassId) === ticketId;
                      
                      return (
                        <div 
                          key={ticketId}
                          className={`relative flex items-center justify-between p-4 rounded-lg border-2 transition-colors ${
                            !purchasable 
                              ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed' 
                              : isSelected 
                                ? 'border-blue-500 bg-blue-50 cursor-pointer' 
                                : 'border-slate-200 hover:bg-slate-50 cursor-pointer'
                          }`}
                          onClick={() => {
                            if (purchasable) {
                              setSelectedTicketClassId(ticketId);
                            }
                          }}
                          data-testid={`ticket-class-${ticketId}`}
                        >
                          <div className="flex items-center gap-3">
                            {/* Lock icon with tooltip for non-purchasable tickets, radio for purchasable */}
                            {!purchasable ? (
                              <TooltipProvider>
                                <Tooltip delayDuration={0}>
                                  <TooltipTrigger asChild>
                                    <div className="relative flex items-center justify-center w-5 h-5">
                                      <div className="w-4 h-4 rounded-full border-2 border-slate-300 bg-slate-100"></div>
                                      <Lock className="absolute h-3 w-3 text-slate-500" />
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent 
                                    side="top" 
                                    className="bg-slate-800 text-white text-sm px-3 py-2 rounded-md shadow-lg"
                                  >
                                    Available to members only
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              <RadioGroupItem 
                                value={ticketId} 
                                id={`ticket-${ticketId}`} 
                              />
                            )}
                            <div>
                              <Label 
                                htmlFor={`ticket-${ticketId}`} 
                                className={`font-medium ${purchasable ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                              >
                                {String(tc.name || 'Ticket')}
                              </Label>
                              {/* Hide offers for guest checkout - they can only purchase 1 ticket */}
                              {!isGuestCheckout && tc.offer_type && tc.offer_type !== 'none' && (
                                <div className="text-xs text-green-600 mt-0.5">
                                  {tc.offer_type === 'bogo' && `Buy ${tc.bogo_buy_quantity || 0}, get ${tc.bogo_get_free_quantity || 0} free`}
                                  {tc.offer_type === 'bulk_discount' && `${tc.bulk_discount_percentage || 0}% off for ${tc.bulk_discount_threshold || 0}+ tickets`}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className={`flex items-center gap-1 text-lg font-semibold ${purchasable ? 'text-slate-900' : 'text-slate-500'}`}>
                            <PoundSterling className="h-4 w-4" />
                            {ticketPrice.toFixed(2)}
                          </div>
                        </div>
                      );
                    })}
                  </RadioGroup>
                  
                  </CardContent>
              </Card>
            )}

            {/* Single ticket class display - shown when only one option */}
            {isOneOffEvent && availableTicketClasses.length === 1 && selectedTicketClass && (
              <Card className="border-slate-200 shadow-sm mb-4">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Ticket className="h-5 w-5 text-blue-600" />
                    Ticket
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {(() => {
                    const purchasable = isTicketPurchasable(selectedTicketClass);
                    return (
                      <div className={`flex items-center justify-between p-4 rounded-lg border border-slate-200 ${purchasable ? 'bg-slate-50' : 'bg-slate-50 opacity-80'}`}>
                        <div className="flex items-center gap-3">
                          {/* Lock icon with tooltip for non-purchasable tickets */}
                          {!purchasable && (
                            <TooltipProvider>
                              <Tooltip delayDuration={0}>
                                <TooltipTrigger asChild>
                                  <div className="flex items-center justify-center w-5 h-5">
                                    <Lock className="h-4 w-4 text-slate-500" />
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent 
                                  side="top" 
                                  className="bg-slate-800 text-white text-sm px-3 py-2 rounded-md shadow-lg"
                                >
                                  Available to members only
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          <div>
                            <div className={`font-medium ${purchasable ? 'text-slate-900' : 'text-slate-500'}`}>{String(selectedTicketClass.name || 'Ticket')}</div>
                            {/* Hide offers for guest checkout - they can only purchase 1 ticket */}
                            {!isGuestCheckout && selectedTicketClass.offer_type && selectedTicketClass.offer_type !== 'none' && (
                              <div className="text-xs text-green-600 mt-0.5">
                                {selectedTicketClass.offer_type === 'bogo' && `Buy ${selectedTicketClass.bogo_buy_quantity || 0}, get ${selectedTicketClass.bogo_get_free_quantity || 0} free`}
                                {selectedTicketClass.offer_type === 'bulk_discount' && `${selectedTicketClass.bulk_discount_percentage || 0}% off for ${selectedTicketClass.bulk_discount_threshold || 0}+ tickets`}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className={`flex items-center gap-1 text-lg font-semibold ${purchasable ? 'text-slate-900' : 'text-slate-500'}`}>
                          <PoundSterling className="h-4 w-4" />
                          {(Number(selectedTicketClass.price) || 0).toFixed(2)}
                        </div>
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>
            )}

            <PaymentOptions
              totalCost={totalCost}
              memberInfo={currentMemberInfo}
              organizationInfo={organizationInfo}
              attendees={isGuestCheckout 
                ? (isGuestFormValid ? [{
                    email: guestInfo.email,
                    first_name: guestInfo.first_name,
                    last_name: guestInfo.last_name,
                    isValid: true,
                    isGuest: true,
                    organization: guestInfo.organization,
                    phone: guestInfo.phone,
                    job_title: guestInfo.job_title
                  }] : [])
                : attendees.filter((a) => a.isValid)}
              numberOfLinks={0}
              event={event}
              submitting={submitting}
              setSubmitting={setSubmitting}
              registrationMode={isGuestCheckout ? 'guest' : registrationMode}
              refreshOrganizationInfo={refreshOrganizationInfo}
              isOneOffEvent={isOneOffEvent}
              oneOffCostDetails={oneOffCostDetails}
              ticketPrice={ticketPrice}
              isFeatureExcluded={isFeatureExcluded}
              selectedTicketClass={selectedTicketClass}
              onCanProceedChange={setPaymentCanProceed}
              isGuestCheckout={isGuestCheckout}
              guestInfo={guestInfo}
            />

          </div>
        </div>
      </div>

      {/* Description Modal - Renders sanitized rich text HTML */}
      <Dialog open={showDescriptionModal} onOpenChange={setShowDescriptionModal}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold">About this event</DialogTitle>
          </DialogHeader>
          <div className="mt-4">
            <div 
              className="text-slate-600 leading-relaxed prose prose-slate max-w-none prose-headings:text-slate-900 prose-p:text-slate-600 prose-a:text-blue-600 prose-li:text-slate-600"
              data-testid="text-description-full"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(event?.description || '') }}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Speaker Profile Modal */}
      <Dialog open={showSpeakerModal} onOpenChange={setShowSpeakerModal}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold">{speakerSingular} Profile</DialogTitle>
          </DialogHeader>
          {selectedSpeaker && (
            <div className="mt-4 space-y-6">
              <div className="flex items-center gap-4">
                <Avatar className="h-20 w-20">
                  {selectedSpeaker.profile_photo_url ? (
                    <AvatarImage src={selectedSpeaker.profile_photo_url} alt={selectedSpeaker.full_name} />
                  ) : null}
                  <AvatarFallback className="bg-purple-100 text-purple-700 font-semibold text-2xl">
                    {selectedSpeaker.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900" data-testid="text-speaker-name">
                    {selectedSpeaker.full_name}
                  </h3>
                  {(selectedSpeaker.job_title || selectedSpeaker.organization) && (
                    <p className="text-slate-500" data-testid="text-speaker-role">
                      {selectedSpeaker.job_title}
                      {selectedSpeaker.job_title && selectedSpeaker.organization && ', '}
                      {selectedSpeaker.organization}
                    </p>
                  )}
                  {selectedSpeaker.email && (
                    <a 
                      href={`mailto:${selectedSpeaker.email}`} 
                      className="text-sm text-blue-600 hover:underline"
                      data-testid="link-speaker-email"
                    >
                      {selectedSpeaker.email}
                    </a>
                  )}
                </div>
              </div>
              {selectedSpeaker.biography && (
                <div>
                  <h4 className="font-medium text-slate-900 mb-2">Biography</h4>
                  <p className="text-slate-600 whitespace-pre-wrap leading-relaxed" data-testid="text-speaker-bio">
                    {selectedSpeaker.biography}
                  </p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
