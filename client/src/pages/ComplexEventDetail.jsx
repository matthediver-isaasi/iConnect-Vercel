import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import PublicDocumentsSection from "@/components/events/PublicDocumentsSection";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { parseEventTypes } from "@/lib/utils";
import {
  Calendar, MapPin, Clock, Users, ArrowLeft, Ticket, Loader2,
  Video, User, Mic, AlertCircle, Monitor, Building2,
  Plus, Trash2, Layers, Lock, UserPlus, X, ShoppingCart, Mail, FileText, ChevronDown, ChevronUp,
  ChevronLeft, ChevronRight, Copy, ExternalLink, LogIn, CalendarDays, Info
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import ColleagueSelector from "@/components/booking/ColleagueSelector";
import AttendeeOptionsSelector from "@/components/booking/AttendeeOptionsSelector";
import { isAttendeeOptionsCollectionEnabled } from "@/lib/attendeeOptionsSetting";
import { parseISO, isSameDay } from "date-fns";
import DOMPurify from "dompurify";
import {
  DEFAULT_TIMEZONE,
  buildTrackColorStyles,
  buildTrackColorMap,
  formatTime,
  formatDate,
  ScrollableSchedule,
} from "@/components/events/ComplexEventSchedule";
import { publicClient } from "@/api/publicClient";
import { computeComplexEventDayInfo } from "@/lib/complexEventDays";
import { supabase } from "@/api/supabaseClient";
import { getFocalPointStyle } from "@/components/FocalPointPicker";
import { getEffectiveTicketPrice } from "@/lib/ticketPricing";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useComplexEventTicketAvailabilityRealtime } from "@/hooks/useComplexEventTicketAvailabilityRealtime";
import PaymentOptions from "@/components/booking/PaymentOptions";
import EventSponsorsCard from "@/components/events/EventSponsorsCard";


function TrackAccessIndicator({ ticket, tracks }) {
  if (!tracks?.length) return null;

  const trackMap = {};
  tracks.forEach(t => { trackMap[String(t.id)] = t; });

  if (ticket.all_tracks) {
    return (
      <div className="flex items-center gap-1 mt-1.5">
        <Layers className="w-3 h-3 text-slate-400 shrink-0" />
        <span className="text-[11px] text-slate-500">Access to all tracks</span>
      </div>
    );
  }

  const linkedIds = ticket.linked_track_ids || [];
  if (linkedIds.length === 0) return null;

  const linkedTracks = linkedIds.map(id => trackMap[String(id)]).filter(Boolean);
  if (linkedTracks.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
      <Layers className="w-3 h-3 text-slate-400 shrink-0" />
      {linkedTracks.map(t => {
        const colorStyles = t.colour ? buildTrackColorStyles(t.colour) : null;
        return (
          <span
            key={t.id}
            className="inline-flex items-center gap-1 text-[11px] text-slate-600"
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={colorStyles?.dotStyle || { backgroundColor: '#94a3b8' }}
            />
            {t.name}
          </span>
        );
      })}
    </div>
  );
}

function AddAttendeeModal({ open, onOpenChange, ticketClass, memberInfo, organizationInfo, onAddAttendee, existingEmails, isGroupEvent = false }) {
  const [externalFirstName, setExternalFirstName] = useState('');
  const [externalLastName, setExternalLastName] = useState('');
  const [externalEmail, setExternalEmail] = useState('');
  const [externalOrganization, setExternalOrganization] = useState('');

  const resetExternal = () => {
    setExternalFirstName('');
    setExternalLastName('');
    setExternalEmail('');
    setExternalOrganization('');
  };

  const isSelfAlreadyAdded = existingEmails.includes((memberInfo?.email || '').toLowerCase());

  const handleRegisterSelf = () => {
    if (!memberInfo) return;
    if (isSelfAlreadyAdded) {
      toast.info('You are already registered');
      return;
    }
    onAddAttendee({
      first_name: memberInfo.first_name || '',
      last_name: memberInfo.last_name || '',
      email: memberInfo.email || '',
      organization: organizationInfo?.name || '',
      isSelf: true
    });
    onOpenChange(false);
    toast.success('You have been added as an attendee');
  };

  const handleColleagueSelect = (colleague) => {
    const email = (colleague.email || '').toLowerCase();
    if (existingEmails.includes(email)) {
      toast.error('This person is already registered');
      return;
    }
    onAddAttendee({
      first_name: colleague.first_name || '',
      last_name: colleague.last_name || '',
      email: colleague.email || '',
      organization: organizationInfo?.name || '',
      isSelf: false
    });
    onOpenChange(false);
    toast.success(`${colleague.first_name} ${colleague.last_name} added`);
  };

  const handleExternalSubmit = () => {
    if (!externalEmail || !externalEmail.includes('@')) {
      toast.error('Please enter a valid email address');
      return;
    }
    if (!externalFirstName.trim() || !externalLastName.trim()) {
      toast.error('Please enter first and last name');
      return;
    }
    const email = externalEmail.toLowerCase().trim();
    if (existingEmails.includes(email)) {
      toast.error('This person is already registered');
      return;
    }
    onAddAttendee({
      first_name: externalFirstName.trim(),
      last_name: externalLastName.trim(),
      email: email,
      organization: externalOrganization.trim(),
      isSelf: false
    });
    resetExternal();
    onOpenChange(false);
    toast.success(`${externalFirstName.trim()} ${externalLastName.trim()} added`);
  };

  const ticketRoleIds = ticketClass?.role_ids || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-indigo-600" />
            Add Attendee
          </DialogTitle>
          <DialogDescription>
            {ticketClass?.name ? `Adding attendee for: ${ticketClass.name}` : 'Add an attendee to your booking'}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue={memberInfo ? "self" : "external"} className="mt-2">
          <TabsList className="w-full">
            {memberInfo && <TabsTrigger value="self" className="flex-1" data-testid="tab-self">Myself</TabsTrigger>}
            {!isGroupEvent && memberInfo && organizationInfo && (
              <TabsTrigger value="colleague" className="flex-1" data-testid="tab-colleague">Colleague</TabsTrigger>
            )}
            {(!isGroupEvent || !memberInfo) && (
              <TabsTrigger value="external" className="flex-1" data-testid="tab-external">Other</TabsTrigger>
            )}
          </TabsList>

          {memberInfo && (
            <TabsContent value="self" className="space-y-4 mt-4">
              <div className="p-3 rounded-md border border-slate-200 space-y-1">
                <div className="font-medium text-sm text-slate-900">{memberInfo.first_name} {memberInfo.last_name}</div>
                <div className="text-xs text-slate-500">{memberInfo.email}</div>
                {organizationInfo?.name && <div className="text-xs text-slate-500">{organizationInfo.name}</div>}
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={handleRegisterSelf}
                  disabled={isSelfAlreadyAdded}
                  className="flex-1"
                  data-testid="button-register-myself"
                >
                  <User className="w-4 h-4 mr-1.5" />
                  {isSelfAlreadyAdded ? 'Already Added' : 'Register Myself'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  data-testid="button-cancel-self"
                >
                  Cancel
                </Button>
              </div>
            </TabsContent>
          )}

          {memberInfo && organizationInfo && (
            <TabsContent value="colleague" className="space-y-4 mt-4">
              <ColleagueSelector
                organizationId={organizationInfo.id}
                onSelect={handleColleagueSelect}
                memberInfo={memberInfo}
                ticketRoleIds={ticketRoleIds}
              />
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="w-full"
                data-testid="button-cancel-colleague"
              >
                Cancel
              </Button>
            </TabsContent>
          )}

          <TabsContent value="external" className="space-y-3 mt-4">
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="First Name *"
                value={externalFirstName}
                onChange={(e) => setExternalFirstName(e.target.value)}
                data-testid="input-external-first-name"
              />
              <Input
                placeholder="Last Name *"
                value={externalLastName}
                onChange={(e) => setExternalLastName(e.target.value)}
                data-testid="input-external-last-name"
              />
            </div>
            <Input
              type="email"
              placeholder="Email *"
              value={externalEmail}
              onChange={(e) => setExternalEmail(e.target.value)}
              data-testid="input-external-email"
            />
            <Input
              placeholder="Organisation (optional)"
              value={externalOrganization}
              onChange={(e) => setExternalOrganization(e.target.value)}
              data-testid="input-external-org"
            />
            <div className="flex gap-2">
              <Button
                onClick={handleExternalSubmit}
                className="flex-1"
                data-testid="button-add-external"
              >
                <Mail className="w-4 h-4 mr-1.5" />
                Add Attendee
              </Button>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-external"
              >
                Cancel
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function TicketDiscountInput({ ticketClassId, discountInfo, onApply, onRemove, eventId }) {
  const [inputValue, setInputValue] = useState('');
  const [validating, setValidating] = useState(false);
  const hasApplied = !!discountInfo?.code;

  const handleApply = async () => {
    const code = inputValue.trim();
    if (!code) return;
    setValidating(true);
    try {
      const result = await publicClient.validateComplexEventDiscount({
        event_id: eventId,
        ticket_class_id: ticketClassId,
        discount_code: code
      });
      if (result.valid) {
        onApply(ticketClassId, {
          code: code.toUpperCase(),
          discountedPrice: result.discounted_price,
          originalPrice: result.original_price,
          discountType: result.discount_type,
          discountValue: result.discount_value
        });
        toast.success(`Discount applied! Price reduced to \u00a3${result.discounted_price.toFixed(2)}`);
      } else {
        toast.error(result.reason || 'Invalid discount code');
      }
    } catch (err) {
      toast.error('Failed to validate discount code');
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="mt-2 pt-2 border-t border-slate-100" data-testid={`discount-section-${ticketClassId}`}>
      <div className="flex items-center gap-1.5">
        <Input
          type="text"
          placeholder="Discount code"
          value={hasApplied ? discountInfo.code : inputValue}
          onChange={(e) => setInputValue(e.target.value.toUpperCase())}
          disabled={hasApplied || validating}
          className="h-7 text-xs flex-1"
          data-testid={`input-discount-${ticketClassId}`}
        />
        {hasApplied ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { onRemove(ticketClassId); setInputValue(''); }}
            className="h-7 px-2 text-xs text-red-600"
            data-testid={`button-remove-discount-${ticketClassId}`}
          >
            <X className="w-3 h-3" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleApply}
            disabled={!inputValue.trim() || validating}
            className="h-7 px-2 text-xs"
            data-testid={`button-apply-discount-${ticketClassId}`}
          >
            {validating ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Apply'}
          </Button>
        )}
      </div>
      {hasApplied && (
        <p className="text-[10px] text-green-600 mt-0.5">
          {discountInfo.discountType === 'percentage'
            ? `${discountInfo.discountValue}% off`
            : `\u00a3${discountInfo.discountValue.toFixed(2)} off`}
          {' \u2014 '}{'\u00a3'}{discountInfo.discountedPrice.toFixed(2)} per ticket
        </p>
      )}
    </div>
  );
}

function CartSummary({ cart, ticketClasses, onRemoveAttendee, onUpdateAttendee, getEffectiveTicketPrice, eventOptions }) {
  const entries = Object.entries(cart).filter(([, item]) => item.attendees.length > 0);
  if (entries.length === 0) return null;

  const totalAttendees = entries.reduce((sum, [, item]) => sum + item.attendees.length, 0);

  let grandTotal = 0;
  const itemSubtotals = entries.map(([ticketClassId, item]) => {
    const tc = item.ticketClass;
    const ep = tc && getEffectiveTicketPrice ? getEffectiveTicketPrice(tc) : { price: 0 };
    const di = item.discountInfo;
    const effectiveUnitPrice = di ? di.discountedPrice : ep.price;
    const subtotal = effectiveUnitPrice * item.attendees.length;
    grandTotal += subtotal;
    return { ticketClassId, unitPrice: effectiveUnitPrice, originalPrice: ep.price, subtotal, discountInfo: di };
  });

  return (
    <div className="space-y-3" data-testid="cart-summary">
      <div className="flex items-center gap-2">
        <ShoppingCart className="w-4 h-4 text-indigo-600" />
        <Label className="text-sm font-medium">
          Your Cart ({totalAttendees} attendee{totalAttendees !== 1 ? 's' : ''})
        </Label>
      </div>
      {entries.map(([ticketClassId, item], entryIdx) => {
        const sub = itemSubtotals[entryIdx];
        return (
          <div key={ticketClassId} className="space-y-1.5">
            <div className="text-xs font-medium text-slate-600 flex items-center gap-1.5 flex-wrap">
              <Ticket className="w-3 h-3" />
              {item.ticketClass?.name || 'Ticket'}
              {sub.discountInfo && (
                <Badge variant="secondary" className="text-[10px] bg-green-50 text-green-700 border-green-200">
                  {sub.discountInfo.code}
                </Badge>
              )}
              <span className="ml-auto text-[11px] text-slate-500">
                {item.attendees.length} x{' '}
                {sub.discountInfo ? (
                  <>
                    <span className="line-through text-slate-400">{'\u00a3'}{sub.originalPrice.toFixed(2)}</span>
                    {' '}{'\u00a3'}{sub.unitPrice.toFixed(2)}
                  </>
                ) : (
                  <>{'\u00a3'}{sub.unitPrice.toFixed(2)}</>
                )}
                {' = '}{'\u00a3'}{sub.subtotal.toFixed(2)}
              </span>
            </div>
            {item.attendees.map((attendee, i) => (
              <div
                key={i}
                className="p-2 rounded-md bg-slate-50 border border-slate-100 space-y-2"
                data-testid={`cart-attendee-${ticketClassId}-${i}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-800 truncate">
                      {attendee.first_name} {attendee.last_name}
                      {attendee.isSelf && <span className="text-indigo-600 text-xs ml-1">(you)</span>}
                    </div>
                    <div className="text-xs text-slate-500 truncate">{attendee.email}</div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => onRemoveAttendee(ticketClassId, i)}
                    data-testid={`button-remove-cart-attendee-${ticketClassId}-${i}`}
                  >
                    <X className="w-3.5 h-3.5 text-slate-400" />
                  </Button>
                </div>
                {onUpdateAttendee && (
                  <AttendeeOptionsSelector
                    eventOptions={eventOptions}
                    value={attendee}
                    onChange={(next) => onUpdateAttendee(ticketClassId, i, next)}
                    idPrefix={`cart-${ticketClassId}-${i}`}
                  />
                )}
              </div>
            ))}
          </div>
        );
      })}
      <div className="flex items-center justify-between pt-2 border-t border-slate-200" data-testid="cart-grand-total">
        <span className="text-sm font-semibold text-slate-800">Total</span>
        <span className="text-sm font-semibold text-slate-800">{'\u00a3'}{grandTotal.toFixed(2)}</span>
      </div>
    </div>
  );
}

function BookingSection({ event, sessions, memberInfo, organizationInfo, memberGroupIds, onBookingComplete, cart, setCart }) {
  const [attendeeModalOpen, setAttendeeModalOpen] = useState(false);
  const [modalTicketClassId, setModalTicketClassId] = useState(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [thirdPartyConsent, setThirdPartyConsent] = useState(true);
  const collectThirdPartyConsent = event?.collect_third_party_consent === true;

  // Task #1519: Group events (member_group_id set) force self-only registration.
  // No colleagues / external / multi-attendee booking is permitted.
  const isGroupEvent = !!event?.member_group_id;

  const { data: systemSettings = [] } = useQuery({
    queryKey: ['/api/public/system-settings'],
    queryFn: () => publicClient.listSystemSettings()
  });

  const bookingTerms = useMemo(() => {
    const setting = Array.isArray(systemSettings)
      ? systemSettings.find(s => s.setting_key === 'event_booking_terms')
      : null;
    return setting?.setting_value || '';
  }, [systemSettings]);

  const hasBookingTerms = bookingTerms && bookingTerms.trim() !== '' && bookingTerms !== '<p><br></p>';

  const pricingConfig = useMemo(() => {
    if (!event?.pricing_config) return null;
    let parsed = event.pricing_config;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { return null; }
    }
    return parsed;
  }, [event]);

  const ticketClasses = useMemo(() => {
    if (!pricingConfig?.ticket_classes?.length) return [];

    return pricingConfig.ticket_classes.map(tc => ({
      ...tc,
      id: String(tc.id),
      price: Number(tc.price) || 0
    }));
  }, [pricingConfig]);

  const isGuest = !memberInfo;
  const userRoleId = memberInfo?.role_id;

  const { getTicketClassAvailability } = useComplexEventTicketAvailabilityRealtime(
    event?.id,
    { initialTicketClasses: ticketClasses, showSoldOutToast: false }
  );

  // Count-based availability (Task #1760): prefer the live derived value, then
  // the count-based fields embedded by the public API, falling back to the
  // raw capacity only when nothing else is available.
  const isTicketSoldOut = useCallback((tc) => {
    const live = getTicketClassAvailability(tc.id);
    if (live) return live.isSoldOut;
    const isUnlimited = tc.is_unlimited_tickets === true
      || tc.available_count === null
      || tc.available_count === undefined
      || tc.available_count === '';
    if (isUnlimited) return false;
    if (typeof tc.is_sold_out === 'boolean') return tc.is_sold_out;
    if (typeof tc.remaining === 'number') return tc.remaining <= 0;
    return Number(tc.available_count) <= 0;
  }, [getTicketClassAvailability]);

  // Remaining tickets for a finite class, or null when unlimited / unknown.
  const getTicketRemaining = useCallback((tc) => {
    const live = getTicketClassAvailability(tc.id);
    if (live) return live.is_unlimited_tickets ? null : live.remaining;
    const isUnlimited = tc.is_unlimited_tickets === true
      || tc.available_count === null
      || tc.available_count === undefined
      || tc.available_count === '';
    if (isUnlimited) return null;
    if (typeof tc.remaining === 'number') return tc.remaining;
    return null;
  }, [getTicketClassAvailability]);

  const getTicketVisibility = (tc) => {
    if (tc.visibility_mode) return tc.visibility_mode;
    if (tc.is_public === true) return 'members_and_public';
    if (tc.is_public === false) return 'members_only';
    return 'members_and_public';
  };

  const availableTicketClasses = useMemo(() => {
    return ticketClasses.filter(tc => {
      const vis = getTicketVisibility(tc);
      const ticketRoleIds = Array.isArray(tc.role_ids) ? tc.role_ids : [];
      const ticketGroupIds = Array.isArray(tc.member_group_ids) ? tc.member_group_ids : [];
      const hasRestrictions = tc.role_match_only && (ticketRoleIds.length > 0 || ticketGroupIds.length > 0);
      if (isGuest) {
        if (vis === 'members_only') return false;
        // Guests can never satisfy a role/group restriction
        if (hasRestrictions) return false;
        return true;
      }
      if (vis === 'public_only') return false;
      if (!hasRestrictions) return true;
      const roleMatches = !!userRoleId && ticketRoleIds.includes(userRoleId);
      const groupMatches = (memberGroupIds || []).some(g => ticketGroupIds.includes(g));
      return roleMatches || groupMatches;
    });
  }, [ticketClasses, isGuest, userRoleId, memberGroupIds]);

  const isTicketRestricted = (tc) => {
    const vis = getTicketVisibility(tc);
    if (isGuest) return vis === 'members_only';
    return vis === 'public_only';
  };

  // Tenant-wide toggle: when disabled, expose empty option lists so the
  // attendee options selector never renders and no selections can be made.
  const collectAttendeeOptionsEnabled = isAttendeeOptionsCollectionEnabled(systemSettings);

  const eventOptions = useMemo(() => {
    if (!collectAttendeeOptionsEnabled) {
      return { dietary_options: [], allergy_options: [], accessibility_options: [] };
    }
    return {
      dietary_options: Array.isArray(event?.dietary_options) ? event.dietary_options : [],
      allergy_options: Array.isArray(event?.allergy_options) ? event.allergy_options : [],
      accessibility_options: Array.isArray(event?.accessibility_options) ? event.accessibility_options : [],
    };
  }, [event, collectAttendeeOptionsEnabled]);

  const allExistingEmails = useMemo(() => {
    const emails = [];
    Object.values(cart).forEach(item => {
      item.attendees.forEach(a => {
        if (a.email) emails.push(a.email.toLowerCase());
      });
    });
    return emails;
  }, [cart]);

  const handleOpenAttendeeModal = useCallback((ticketClassId) => {
    setModalTicketClassId(ticketClassId);
    setAttendeeModalOpen(true);
  }, []);

  const handleAddAttendee = useCallback((attendee) => {
    if (!modalTicketClassId) return;
    setCart(prev => {
      const tc = ticketClasses.find(t => t.id === modalTicketClassId);
      const existing = prev[modalTicketClassId] || { ticketClass: tc, attendees: [] };
      return {
        ...prev,
        [modalTicketClassId]: {
          ...existing,
          ticketClass: tc,
          attendees: [...existing.attendees, attendee]
        }
      };
    });
  }, [modalTicketClassId, ticketClasses]);

  const handleUpdateAttendee = useCallback((ticketClassId, attendeeIndex, patch) => {
    setCart(prev => {
      const existing = prev[ticketClassId];
      if (!existing) return prev;
      const updatedAttendees = existing.attendees.map((a, i) =>
        i === attendeeIndex ? { ...a, ...patch } : a
      );
      return { ...prev, [ticketClassId]: { ...existing, attendees: updatedAttendees } };
    });
  }, []);

  const handleRemoveAttendee = useCallback((ticketClassId, attendeeIndex) => {
    setCart(prev => {
      const existing = prev[ticketClassId];
      if (!existing) return prev;
      const updated = { ...existing, attendees: existing.attendees.filter((_, i) => i !== attendeeIndex) };
      if (updated.attendees.length === 0) {
        const next = { ...prev };
        delete next[ticketClassId];
        return next;
      }
      return { ...prev, [ticketClassId]: updated };
    });
  }, []);

  const handleApplyDiscount = useCallback((ticketClassId, discountInfo) => {
    setCart(prev => {
      const existing = prev[ticketClassId];
      if (!existing) return prev;
      return {
        ...prev,
        [ticketClassId]: { ...existing, discountInfo: discountInfo || null }
      };
    });
  }, []);

  const handleRemoveDiscount = useCallback((ticketClassId) => {
    setCart(prev => {
      const existing = prev[ticketClassId];
      if (!existing) return prev;
      return {
        ...prev,
        [ticketClassId]: { ...existing, discountInfo: null }
      };
    });
  }, []);

  const flatAttendees = useMemo(() => {
    const result = [];
    Object.values(cart).forEach(item => {
      item.attendees.forEach(a => result.push(a));
    });
    return result;
  }, [cart]);

  const totalAttendeeCount = flatAttendees.length;

  const cartItems = useMemo(() => {
    return Object.entries(cart)
      .filter(([, item]) => item.attendees.length > 0)
      .map(([ticketClassId, item]) => {
        const tc = item.ticketClass;
        const ep = tc ? getEffectiveTicketPrice(tc) : { price: 0, isEarlyBird: false };
        const di = item.discountInfo;
        const effectiveUnitPrice = di ? di.discountedPrice : ep.price;
        return {
          ticketClassId,
          ticketClass: tc,
          attendees: item.attendees,
          unitPrice: effectiveUnitPrice,
          originalUnitPrice: ep.price,
          subtotal: effectiveUnitPrice * item.attendees.length,
          discountCode: di?.code || null,
          discountInfo: di || null
        };
      });
  }, [cart]);

  const grandTotal = useMemo(() => {
    return cartItems.reduce((sum, item) => sum + item.subtotal, 0);
  }, [cartItems]);

  const selectedTicketForModal = useMemo(() => {
    return ticketClasses.find(tc => tc.id === modalTicketClassId) || null;
  }, [ticketClasses, modalTicketClassId]);

  const firstCartTicketClass = useMemo(() => {
    if (cartItems.length === 0) return availableTicketClasses[0] || null;
    return cartItems[0].ticketClass || null;
  }, [cartItems, availableTicketClasses]);

  const complexEventApi = useMemo(() => ({
    createPaymentIntent: (data) => {
      const items = cartItems.map(ci => ({
        ticket_class_id: ci.ticketClassId,
        attendee_count: ci.attendees.length,
        discount_code: ci.discountCode || undefined
      }));
      return publicClient.createComplexEventPaymentIntent({
        event_id: event.id,
        items
      });
    },
    submitBooking: (data) => {
      const savedItems = data._savedCartItems;
      let items;
      if (savedItems && savedItems.length > 0) {
        items = savedItems;
      } else {
        items = cartItems.map(ci => ({
          ticket_class_id: ci.ticketClassId,
          discount_code: ci.discountCode || undefined,
          attendees: ci.attendees.map(a => ({
            email: (a.email || '').toLowerCase().trim(),
            first_name: (a.first_name || '').trim(),
            last_name: (a.last_name || '').trim(),
            organization: (a.organization || '').trim(),
            phone: (a.phone || '').trim(),
            job_title: (a.job_title || '').trim(),
            dietary_selections: a.dietary_selections || [],
            allergy_selections: a.allergy_selections || [],
            accessibility_selections: a.accessibility_selections || []
          }))
        }));
      }
      return publicClient.submitComplexEventBooking({
        event_id: event.id,
        items,
        payment_method: data.payment_method,
        stripe_payment_intent_id: data.stripe_payment_intent_id || null,
        third_party_consent: typeof data.third_party_consent === 'boolean' ? data.third_party_consent : null
      });
    },
    _getCartItems: () => {
      return cartItems.map(ci => ({
        ticket_class_id: ci.ticketClassId,
        discount_code: ci.discountCode || undefined,
        attendees: ci.attendees.map(a => ({
          email: (a.email || '').toLowerCase().trim(),
          first_name: (a.first_name || '').trim(),
          last_name: (a.last_name || '').trim(),
          organization: (a.organization || '').trim(),
          phone: (a.phone || '').trim(),
          job_title: (a.job_title || '').trim(),
          dietary_selections: a.dietary_selections || [],
          allergy_selections: a.allergy_selections || [],
          accessibility_selections: a.accessibility_selections || []
        }))
      }));
    },
  }), [cartItems, event]);

  const paymentOptionsEvent = useMemo(() => ({
    ...event,
    event_type: 'one_off',
    ticket_classes: ticketClasses,
  }), [event, ticketClasses]);

  const oneOffCostDetails = useMemo(() => ({
    ticketPrice: cartItems.length === 1 ? cartItems[0].unitPrice : grandTotal / Math.max(totalAttendeeCount, 1),
    attendeeCount: totalAttendeeCount,
    totalCost: grandTotal,
    freeTickets: 0,
    discount: 0,
  }), [cartItems, grandTotal, totalAttendeeCount]);

  const registrationClosed = event.registration_closes_at && new Date(event.registration_closes_at) < new Date();

  // CTA override "detail_page" mode: hide ticket add-attendee buttons and
  // payment options; show ticket prices + a "Continue to book" button.
  const useCtaOverrideDetailMode = !!event?.cta_override_url
    && event?.cta_override_mode === 'detail_page';
  const isSoldOut = event?.available_seats !== null
    && event?.available_seats !== undefined
    && Number(event.available_seats) <= 0
    && event?.is_unlimited_registration !== true;

  if (registrationClosed) {
    return (
      <Card className="border-slate-200">
        <CardContent className="p-6 text-center">
          <AlertCircle className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <h3 className="font-semibold text-slate-700">Registration Closed</h3>
          <p className="text-sm text-slate-500 mt-1">Registration for this event is no longer available.</p>
        </CardContent>
      </Card>
    );
  }

  const eventTracks = event?.tracks || [];

  const ticketCards = (
    <div className="space-y-3">
      {availableTicketClasses.length > 0 && (
        <Label className="text-sm font-medium">Tickets</Label>
      )}
      {availableTicketClasses.map(tc => {
        const tcPrice = getEffectiveTicketPrice(tc);
        const restricted = isTicketRestricted(tc);
        const soldOut = isTicketSoldOut(tc);
        const remaining = getTicketRemaining(tc);
        const cartEntry = cart[tc.id];
        const count = cartEntry?.attendees?.length || 0;

        return (
          <div
            key={tc.id}
            className={`p-3 rounded-md border transition-colors ${count > 0 ? 'border-indigo-300 bg-indigo-50/50' : 'border-slate-200'}`}
            data-testid={`ticket-class-${tc.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm text-slate-900 flex items-center gap-2 flex-wrap">
                  {tc.name}
                  {restricted && (
                    <Badge variant="secondary" className="text-xs bg-slate-100 text-slate-600">
                      <Lock className="w-3 h-3 mr-1" />
                      {isGuest ? 'Members Only' : 'Public Only'}
                    </Badge>
                  )}
                  {tc.is_group_ticket && tc.group_size > 1 && (
                    <Badge variant="secondary" className="text-xs">
                      <Users className="w-3 h-3 mr-1" />
                      Group ({tc.group_size})
                    </Badge>
                  )}
                  {tcPrice.isEarlyBird && (
                    <Badge variant="secondary" className="text-xs bg-warning/10 text-warning border-warning/30">
                      Early Bird
                    </Badge>
                  )}
                  {soldOut && (
                    <Badge variant="destructive" className="text-xs" data-testid={`badge-sold-out-${tc.id}`}>
                      Sold Out
                    </Badge>
                  )}
                </span>
                {tc.description && (
                  <p className="text-xs text-slate-500 mt-0.5">{tc.description}</p>
                )}
                {event?.show_ticket_availability && !soldOut && remaining !== null && (
                  <p
                    className={`text-xs mt-0.5 ${remaining <= 5 ? 'text-warning' : 'text-slate-500'}`}
                    data-testid={`text-remaining-${tc.id}`}
                  >
                    {remaining <= 5 ? `Only ${remaining} left` : `${remaining} available`}
                  </p>
                )}
                <TrackAccessIndicator ticket={tc} tracks={eventTracks} />
              </div>
              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <div className="text-base font-semibold text-slate-900">
                  {tcPrice.price === 0 ? 'Free' : `\u00a3${tcPrice.price.toFixed(2)}`}
                </div>
                {tcPrice.isEarlyBird && (
                  <div className="text-xs text-slate-400 line-through">
                    {'\u00a3'}{tcPrice.standardPrice.toFixed(2)}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleOpenAttendeeModal(tc.id)}
                disabled={restricted || soldOut || (isGroupEvent && totalAttendeeCount >= 1)}
                data-testid={`button-add-attendee-${tc.id}`}
              >
                <UserPlus className="w-3.5 h-3.5 mr-1" />
                {isGroupEvent ? 'Register Myself' : 'Add Attendee'}
              </Button>
              {count > 0 && (
                <Badge className="bg-indigo-600 text-white">
                  {count} added
                </Badge>
              )}
            </div>
            {count > 0 && tcPrice.price > 0 && (
              <TicketDiscountInput
                ticketClassId={tc.id}
                discountInfo={cartEntry?.discountInfo || null}
                onApply={handleApplyDiscount}
                onRemove={handleRemoveDiscount}
                eventId={event.id}
              />
            )}
          </div>
        );
      })}

      {availableTicketClasses.length === 0 && (
        <p className="text-sm text-center text-slate-500">
          No tickets are currently available for public registration.
        </p>
      )}
    </div>
  );

  const isStripeReturn = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('payment_intent');

  const shouldShowPaymentOptions = totalAttendeeCount > 0 || isStripeReturn;

  const paymentOptionsSection = shouldShowPaymentOptions ? (
    <PaymentOptions
      event={paymentOptionsEvent}
      memberInfo={memberInfo}
      organizationInfo={organizationInfo}
      attendees={flatAttendees}
      registrationMode="colleagues"
      selectedTicketClass={firstCartTicketClass}
      ticketPrice={oneOffCostDetails.ticketPrice}
      totalCost={grandTotal}
      oneOffCostDetails={oneOffCostDetails}
      isComplexEvent={true}
      complexEventApi={complexEventApi}
      onComplexBookingComplete={onBookingComplete}
      renderAsCard={false}
      hasBookingTerms={hasBookingTerms}
      bookingTerms={bookingTerms}
      termsAccepted={termsAccepted}
      setTermsAccepted={setTermsAccepted}
      onShowTermsModal={() => setShowTermsModal(true)}
      collectThirdPartyConsent={collectThirdPartyConsent}
      thirdPartyConsent={thirdPartyConsent}
      setThirdPartyConsent={setThirdPartyConsent}
    />
  ) : null;

  return (
    <Card className="border-slate-200" data-testid="booking-section">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Ticket className="w-5 h-5 text-indigo-600" />
          Register
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {useCtaOverrideDetailMode ? (
          <>
            <div className="space-y-3">
              {availableTicketClasses.length > 0 && (
                <Label className="text-sm font-medium">Tickets</Label>
              )}
              {availableTicketClasses.map(tc => {
                const tcPrice = getEffectiveTicketPrice(tc);
                const soldOut = isTicketSoldOut(tc);
                const remaining = getTicketRemaining(tc);
                return (
                  <div
                    key={tc.id}
                    className="p-3 rounded-md border border-slate-200"
                    data-testid={`ticket-class-${tc.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-sm text-slate-900 flex items-center gap-2 flex-wrap">
                          {tc.name}
                          {tc.is_group_ticket && tc.group_size > 1 && (
                            <Badge variant="secondary" className="text-xs">
                              <Users className="w-3 h-3 mr-1" />
                              Group ({tc.group_size})
                            </Badge>
                          )}
                          {tcPrice.isEarlyBird && (
                            <Badge variant="secondary" className="text-xs bg-warning/10 text-warning border-warning/30">
                              Early Bird
                            </Badge>
                          )}
                          {soldOut && (
                            <Badge variant="destructive" className="text-xs" data-testid={`badge-sold-out-${tc.id}`}>
                              Sold Out
                            </Badge>
                          )}
                        </span>
                        {tc.description && (
                          <p className="text-xs text-slate-500 mt-0.5">{tc.description}</p>
                        )}
                        {event?.show_ticket_availability && !soldOut && remaining !== null && (
                          <p
                            className={`text-xs mt-0.5 ${remaining <= 5 ? 'text-warning' : 'text-slate-500'}`}
                            data-testid={`text-remaining-${tc.id}`}
                          >
                            {remaining <= 5 ? `Only ${remaining} left` : `${remaining} available`}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <div className="text-base font-semibold text-slate-900">
                          {tcPrice.price === 0 ? 'Free' : `\u00a3${tcPrice.price.toFixed(2)}`}
                        </div>
                        {tcPrice.isEarlyBird && (
                          <div className="text-xs text-slate-400 line-through">
                            {'\u00a3'}{tcPrice.standardPrice.toFixed(2)}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {availableTicketClasses.length === 0 && isGuest && (
                <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-md">
                  <Lock className="h-4 w-4 text-blue-600 shrink-0" />
                  <span className="text-sm text-blue-800 font-medium">Member only event</span>
                </div>
              )}
              {availableTicketClasses.length === 0 && !isGuest && (
                <p className="text-sm text-center text-slate-500">
                  No tickets are currently available for your account.
                </p>
              )}
            </div>
            {availableTicketClasses.length === 0 && !isGuest ? null : availableTicketClasses.length === 0 && isGuest ? (
              <Button
                onClick={() => {
                  const currentPath = window.location.pathname + window.location.search;
                  window.location.href = '/login?returnTo=' + encodeURIComponent(currentPath);
                }}
                className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700"
                size="lg"
                data-testid="button-login-to-register"
              >
                <LogIn className="w-5 h-5 mr-2" />
                Login to register
              </Button>
            ) : (
              <Button
                onClick={() => {
                  if (event.cta_override_url) {
                    window.location.href = event.cta_override_url;
                  }
                }}
                disabled={isSoldOut}
                className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700"
                size="lg"
                data-testid="button-continue-to-book"
              >
                {isSoldOut ? 'Sold Out' : (
                  <>
                    <ExternalLink className="w-5 h-5 mr-2" />
                    Continue to book
                  </>
                )}
              </Button>
            )}
          </>
        ) : (
          <>
            {ticketCards}
            <CartSummary cart={cart} ticketClasses={ticketClasses} onRemoveAttendee={handleRemoveAttendee} onUpdateAttendee={handleUpdateAttendee} getEffectiveTicketPrice={getEffectiveTicketPrice} eventOptions={eventOptions} />
            {paymentOptionsSection}
          </>
        )}
      </CardContent>

      <AddAttendeeModal
        open={attendeeModalOpen}
        onOpenChange={setAttendeeModalOpen}
        ticketClass={selectedTicketForModal}
        memberInfo={memberInfo}
        organizationInfo={organizationInfo}
        onAddAttendee={handleAddAttendee}
        existingEmails={allExistingEmails}
        isGroupEvent={isGroupEvent}
      />

      <Dialog open={showTermsModal} onOpenChange={setShowTermsModal}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold flex items-center gap-2">
              <FileText className="w-5 h-5" />
              Terms and Conditions
            </DialogTitle>
          </DialogHeader>
          <div className="mt-4">
            <div
              className="prose prose-slate max-w-none"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bookingTerms) }}
              data-testid="terms-content"
            />
          </div>
          <div className="mt-6 pt-4 border-t flex justify-end">
            <Button onClick={() => setShowTermsModal(false)} data-testid="button-close-terms">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function ComplexEventDetail() {
  const { memberInfo, organizationInfo, isAdmin } = useMemberAccess();
  const [showSpeakerModal, setShowSpeakerModal] = useState(false);
  const [selectedSpeaker, setSelectedSpeaker] = useState(null);
  const [cart, setCart] = useState({});

  // Load the current member's group assignments so tickets restricted by
  // member_group_ids can be matched on the frontend (OR with role match).
  const { data: userMemberGroupIds = [] } = useQuery({
    queryKey: ['member_group_assignment', memberInfo?.id],
    enabled: !!memberInfo?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('member_group_assignment')
        .select('group_id')
        .eq('member_id', memberInfo.id);
      if (error || !Array.isArray(data)) return [];
      return data.map(r => r.group_id).filter(Boolean);
    }
  });

  const routeParams = useParams();
  const urlParams = new URLSearchParams(window.location.search);
  const eventIdFromQuery = urlParams.get('id');
  const eventSlugFromRoute = routeParams.eventSlug;

  const isSlugLookup = !!eventSlugFromRoute && !eventIdFromQuery;

  const { data: slugResolvedEvent, isLoading: isSlugLoading } = useQuery({
    queryKey: ['complex-event-by-slug', eventSlugFromRoute],
    queryFn: async () => await publicClient.getComplexEventBySlug(eventSlugFromRoute),
    enabled: isSlugLookup
  });

  const eventId = eventIdFromQuery || (slugResolvedEvent?.id) || null;

  const { data: event, isLoading: eventLoading } = useQuery({
    queryKey: ['complex-event', eventId],
    queryFn: async () => await publicClient.getComplexEvent(eventId),
    enabled: !!eventId,
    staleTime: 30 * 1000
  });

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['complex-event-sessions-public', eventId],
    queryFn: async () => await publicClient.getComplexEventSessions(eventId) || [],
    enabled: !!eventId
  });

  const { data: detailSystemSettings = [] } = useQuery({
    queryKey: ['/api/public/system-settings'],
    queryFn: () => publicClient.listSystemSettings()
  });

  const sponsorsAfterDate = (Array.isArray(detailSystemSettings)
    ? detailSystemSettings.find(s => s.setting_key === 'event_sponsors_placement')
    : null)?.setting_value === 'after_date';

  const allSpeakerIds = useMemo(() => {
    const ids = new Set(event?.speaker_ids || []);
    sessions.forEach(s => (s.speaker_ids || []).forEach(id => ids.add(id)));
    return [...ids];
  }, [event?.speaker_ids, sessions]);

  const { data: speakers = [] } = useQuery({
    queryKey: ['complex-event-speakers', allSpeakerIds],
    queryFn: async () => await publicClient.listSpeakers(allSpeakerIds) || [],
    enabled: allSpeakerIds.length > 0
  });

  const speakerMap = useMemo(() => {
    const map = {};
    speakers.forEach(s => { map[s.id] = s; });
    return map;
  }, [speakers]);

  const trackColorMap = useMemo(
    () => buildTrackColorMap(sessions, event?.tracks || []),
    [sessions, event]
  );

  const accessibleTrackNames = useMemo(() => {
    const eventTracks = event?.tracks || [];
    if (eventTracks.length === 0) return null;

    let pConfig = event?.pricing_config;
    if (typeof pConfig === 'string') {
      try { pConfig = JSON.parse(pConfig); } catch { pConfig = null; }
    }
    const allTickets = (pConfig?.ticket_classes || []).map(tc => ({
      ...tc,
      id: String(tc.id),
      price: Number(tc.price) || 0
    }));
    if (allTickets.length === 0) return null;

    const isGuest = !memberInfo;
    const userRoleId = memberInfo?.role_id;

    const getVis = (tc) => {
      if (tc.visibility_mode) return tc.visibility_mode;
      if (tc.is_public === true) return 'members_and_public';
      if (tc.is_public === false) return 'members_only';
      return 'members_and_public';
    };

    const visibleTickets = allTickets.filter(tc => {
      const vis = getVis(tc);
      const ticketRoleIds = Array.isArray(tc.role_ids) ? tc.role_ids : [];
      const ticketGroupIds = Array.isArray(tc.member_group_ids) ? tc.member_group_ids : [];
      const hasRestrictions = tc.role_match_only && (ticketRoleIds.length > 0 || ticketGroupIds.length > 0);
      if (isGuest) {
        if (vis === 'members_only') return false;
        // Guests can never satisfy a role/group restriction
        if (hasRestrictions) return false;
        return true;
      }
      if (vis === 'public_only') return false;
      if (!hasRestrictions) return true;
      const roleMatches = !!userRoleId && ticketRoleIds.includes(userRoleId);
      const groupMatches = (userMemberGroupIds || []).some(g => ticketGroupIds.includes(g));
      return roleMatches || groupMatches;
    });

    if (visibleTickets.length === 0) return null;

    const hasAllTracksTicket = visibleTickets.some(tc => tc.all_tracks);
    if (hasAllTracksTicket) return null;

    const accessibleIds = new Set();
    visibleTickets.forEach(tc => {
      (tc.linked_track_ids || []).forEach(id => accessibleIds.add(String(id)));
    });

    if (accessibleIds.size === 0) return null;

    const trackIdToName = {};
    eventTracks.forEach(t => { trackIdToName[String(t.id)] = t.name; });

    const names = new Set();
    accessibleIds.forEach(id => {
      const name = trackIdToName[id];
      if (name) names.add(name);
    });

    return names;
  }, [event, memberInfo, userMemberGroupIds]);

  const filteredSessions = useMemo(() => {
    if (!accessibleTrackNames) return sessions;
    return sessions.filter(s => {
      const names = s.track_names || (s.track_name ? [s.track_name] : []);
      if (names.length === 0) return true;
      return names.some(n => accessibleTrackNames.has(n));
    });
  }, [sessions, accessibleTrackNames]);

  // Task #3266: detect non-consecutive event days (all sessions, not
  // track-filtered) so the header drops the misleading end date.
  const dayInfo = useMemo(
    () => computeComplexEventDayInfo(sessions, event?.timezone),
    [sessions, event?.timezone]
  );
  const showDayCountInsteadOfEndDate = dayInfo.isNonConsecutive && dayInfo.dayCount > 1;

  const filteredTrackColorMap = useMemo(() => {
    if (!accessibleTrackNames) return trackColorMap;
    const filtered = {};
    Object.entries(trackColorMap).forEach(([name, colors]) => {
      if (accessibleTrackNames.has(name)) {
        filtered[name] = colors;
      }
    });
    return filtered;
  }, [trackColorMap, accessibleTrackNames]);

  const speakerSessionsMap = useMemo(() => {
    const map = {};
    filteredSessions.forEach(s => {
      (s.speaker_ids || []).forEach(speakerId => {
        if (!map[speakerId]) map[speakerId] = [];
        map[speakerId].push(s);
      });
    });
    return map;
  }, [filteredSessions]);

  const visibleSpeakers = useMemo(() => {
    return speakers.filter(s => speakerSessionsMap[s.id]?.length > 0);
  }, [speakers, speakerSessionsMap]);

  useEffect(() => {
    if (event) {
      document.title = event.seo_title || event.title || 'Event';
      let metaDescription = document.querySelector('meta[name="description"]');
      if (!metaDescription) {
        metaDescription = document.createElement('meta');
        metaDescription.name = 'description';
        document.head.appendChild(metaDescription);
      }
      metaDescription.content = event.seo_description || event.summary || '';
    }
    return () => { document.title = 'Portal'; };
  }, [event]);

  const isLoading = eventLoading || isSlugLoading;
  const tz = event?.timezone || DEFAULT_TIMEZONE;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!event) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <Card className="border-slate-200 max-w-md w-full mx-4">
          <CardContent className="p-8 text-center">
            <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-slate-900 mb-2" data-testid="text-event-not-found">Event Not Found</h2>
            <p className="text-slate-600 mb-4">This event may have been removed or is not available.</p>
            <Link to="/events">
              <Button variant="outline" data-testid="button-back-to-events">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Events
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6 gap-2 flex-wrap">
          <Link to="/events" className="inline-flex items-center gap-2 text-slate-600 hover:text-slate-900">
            <ArrowLeft className="w-4 h-4" />
            Back to Events
          </Link>
          {memberInfo && event?.id && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const resp = await fetch(`/api/complex-events/${event.id}/duplicate`, {
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
                  // gated group-event UI and returns to the member group page.
                  let dupUrl = `/CreateComplexEvent?id=${data.id}`;
                  if (event?.member_group_id) {
                    dupUrl += `&group_event=1&group_id=${event.member_group_id}`;
                  }
                  window.location.href = dupUrl;
                } catch (err) {
                  toast.error('Duplicate failed: ' + err.message);
                }
              }}
              data-testid={`button-duplicate-complex-event-detail-${event.id}`}
            >
              <Copy className="w-4 h-4 mr-2" />
              Duplicate Event
            </Button>
          )}
        </div>

        <div className="grid lg:grid-cols-3 gap-8 mb-8 lg:items-start">
          <div className="lg:col-span-2 space-y-6 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto lg:pr-2">
            {event.image_url && (
              <div className="rounded-xl overflow-hidden shadow-lg aspect-video max-h-[28rem] mx-auto w-full">
                <img
                  src={event.image_url}
                  alt={event.title}
                  className="w-full h-full object-cover"
                  style={getFocalPointStyle(event.image_focal_point)}
                />
              </div>
            )}

            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                {(event.program_tag || (event.filter_tags && event.filter_tags.length > 0) || parseEventTypes(event.event_type).length > 0) && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {parseEventTypes(event.event_type).map((typeName, etIdx) => (
                      <Badge key={etIdx} className="bg-purple-100 text-purple-700 border-purple-200">
                        {typeName}
                      </Badge>
                    ))}
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
                )}
                <h1 className="text-3xl font-bold text-slate-900 mb-2" data-testid="text-event-title">
                  {event.title}
                </h1>
                {event.status === 'tbc' && (
                  <Badge variant="outline" className="border-warning/30 text-warning mb-2">Dates TBC</Badge>
                )}

                <div className="space-y-3 pt-4">
                  {event.start_date && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <Calendar className="w-5 h-5 text-slate-400" />
                      <span className="font-medium">{formatDate(event.start_date, tz, "EEEE, MMMM d, yyyy")}</span>
                      {event.end_date && !showDayCountInsteadOfEndDate && !isSameDay(parseISO(event.start_date), parseISO(event.end_date)) && (
                        <span className="text-slate-500">- {formatDate(event.end_date, tz, "MMMM d, yyyy")}</span>
                      )}
                    </div>
                  )}

                  {showDayCountInsteadOfEndDate && (
                    <div className="flex items-center gap-3 text-slate-700" data-testid="text-event-day-count">
                      <CalendarDays className="w-5 h-5 text-slate-400" />
                      <span>{dayInfo.dayCount} days</span>
                    </div>
                  )}
                  {showDayCountInsteadOfEndDate && event.custom_duration_explainer && (
                    <div className="flex items-center gap-3 text-slate-700" data-testid="text-event-duration-explainer">
                      <Info className="w-5 h-5 text-slate-400 shrink-0" />
                      <span>{event.custom_duration_explainer}</span>
                    </div>
                  )}

                  {event.start_date && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <Clock className="w-5 h-5 text-slate-400" />
                      <span>{formatTime(event.start_date, tz)}</span>
                      {event.end_date && (
                        <span className="text-slate-500">- {formatTime(event.end_date, tz)}</span>
                      )}
                    </div>
                  )}

                  {event.location && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <MapPin className="w-5 h-5 text-slate-400" />
                      <span>{event.location}</span>
                    </div>
                  )}

                  {event.show_seat_count !== false && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <Users className="w-5 h-5 text-slate-400" />
                      {(event.available_seats === 0 || event.available_seats === null) ? (
                        <span className="text-green-600 font-medium">Open Registration</span>
                      ) : event.available_seats > 0 ? (
                        <span className="text-green-600 font-medium">{event.available_seats} places available</span>
                      ) : (
                        <span className="text-red-600 font-medium">Sold out</span>
                      )}
                    </div>
                  )}

                  {filteredSessions.length > 0 && (
                    <div className="flex items-center gap-3 text-slate-700">
                      <Layers className="w-5 h-5 text-slate-400" />
                      <span>{filteredSessions.length} session{filteredSessions.length !== 1 ? 's' : ''}</span>
                    </div>
                  )}
                </div>
              </CardHeader>
            </Card>

            {sponsorsAfterDate && (
              <EventSponsorsCard eventId={event.id} eventType="complex" />
            )}

            {(event.description || event.summary) && (
              <Card className="border-slate-200">
                <CardContent className="p-6">
                  <h2 className="text-lg font-semibold text-slate-900 mb-3" data-testid="text-about-heading">About this Event</h2>
                  {event.description ? (
                    <div
                      className="prose prose-slate max-w-none text-sm"
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(event.description) }}
                    />
                  ) : (
                    <p className="text-slate-600">{event.summary}</p>
                  )}
                </CardContent>
              </Card>
            )}

            {Array.isArray(event.attached_documents) && event.attached_documents.length > 0 && (
              <Card className="border-slate-200">
                <CardContent className="p-6">
                  <PublicDocumentsSection
                    documents={event.attached_documents}
                    sectionTitle={event.documents_section_title}
                  />
                </CardContent>
              </Card>
            )}

            {!sponsorsAfterDate && (
              <EventSponsorsCard eventId={event.id} eventType="complex" />
            )}

            {filteredSessions.length > 0 && (
              <Card className="border-slate-200">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-indigo-600" />
                    Schedule
                  </CardTitle>
                  {Object.keys(filteredTrackColorMap).length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {Object.entries(filteredTrackColorMap).map(([track, colors]) => (
                        <Badge
                          key={track}
                          variant="outline"
                          className="text-xs border-0"
                          style={{ ...(colors.bgStyle || {}), ...(colors.textStyle || {}) }}
                        >
                          {track}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  <ScrollableSchedule
                    sessions={filteredSessions}
                    timezone={tz}
                    trackColorMap={filteredTrackColorMap}
                    eventTracks={event?.tracks || []}
                    speakerMap={speakerMap}
                    eventImageUrl={event?.image_url}
                    eventImageFocalPoint={event?.image_focal_point}
                    isAdmin={isAdmin}
                  />
                </CardContent>
              </Card>
            )}

            {visibleSpeakers.length > 0 && (
              <Card className="border-slate-200">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Mic className="w-5 h-5 text-purple-600" />
                    Speakers
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid sm:grid-cols-2 gap-4">
                    {visibleSpeakers.map(speaker => {
                      const displayName = speaker.full_name || speaker.name || '?';
                      const speakerSessions = speakerSessionsMap[speaker.id] || [];
                      return (
                        <button
                          key={speaker.id}
                          onClick={() => { setSelectedSpeaker(speaker); setShowSpeakerModal(true); }}
                          className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 hover:border-purple-300 hover:bg-purple-50 transition-colors text-left w-full"
                          data-testid={`button-speaker-${speaker.id}`}
                        >
                          <Avatar className="h-12 w-12 shrink-0">
                            {speaker.profile_photo_url ? (
                              <AvatarImage src={speaker.profile_photo_url} alt={displayName} />
                            ) : null}
                            <AvatarFallback className="bg-purple-100 text-purple-700">
                              {displayName.charAt(0)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-slate-900">{displayName}</div>
                            {speaker.job_title && <div className="text-xs text-slate-500">{speaker.job_title}</div>}
                            {speaker.organization && <div className="text-xs text-slate-500">{speaker.organization}</div>}
                            {speakerSessions.length > 0 && (
                              <div className="mt-1.5 space-y-0.5">
                                <p className="text-xs text-slate-400" data-testid={`speaker-speaking-at-${speaker.id}`}>Speaking at</p>
                                {speakerSessions.map(s => (
                                  <div key={s.id} className="text-xs text-purple-600 truncate" data-testid={`speaker-session-${speaker.id}-${s.id}`}>
                                    {s.title}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-6 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
            <BookingSection
              event={event}
              sessions={sessions}
              memberInfo={memberInfo}
              organizationInfo={organizationInfo}
              memberGroupIds={userMemberGroupIds}
              cart={cart}
              setCart={setCart}
              onBookingComplete={() => { setCart({}); }}
            />
          </div>
        </div>
      </div>

      <Dialog open={showSpeakerModal} onOpenChange={setShowSpeakerModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selectedSpeaker?.full_name || selectedSpeaker?.name}</DialogTitle>
          </DialogHeader>
          {selectedSpeaker && (() => {
            const modalDisplayName = selectedSpeaker.full_name || selectedSpeaker.name || '?';
            const modalSpeakerSessions = speakerSessionsMap[selectedSpeaker.id] || [];
            return (
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <Avatar className="h-16 w-16">
                    {selectedSpeaker.profile_photo_url ? (
                      <AvatarImage src={selectedSpeaker.profile_photo_url} alt={modalDisplayName} />
                    ) : null}
                    <AvatarFallback className="bg-purple-100 text-purple-700 text-lg">
                      {modalDisplayName.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="font-medium text-slate-900">{modalDisplayName}</div>
                    {selectedSpeaker.job_title && <div className="text-sm text-slate-500">{selectedSpeaker.job_title}</div>}
                    {selectedSpeaker.organization && <div className="text-sm text-slate-500">{selectedSpeaker.organization}</div>}
                  </div>
                </div>
                {modalSpeakerSessions.length > 0 && (
                  <div>
                    <div className="text-sm font-medium text-slate-700 mb-1">Sessions</div>
                    <div className="space-y-1">
                      {modalSpeakerSessions.map(s => (
                        <div key={s.id} className="text-sm text-purple-600" data-testid={`modal-speaker-session-${s.id}`}>{s.title}</div>
                      ))}
                    </div>
                  </div>
                )}
                {(selectedSpeaker.biography || selectedSpeaker.bio) && (
                  <div
                    className="prose prose-slate max-w-none text-sm"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selectedSpeaker.biography || selectedSpeaker.bio) }}
                  />
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

    </div>
  );
}
