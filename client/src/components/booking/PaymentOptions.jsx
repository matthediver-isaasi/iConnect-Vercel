
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Ticket, AlertCircle, PoundSterling, Wallet, CreditCard, Tag, Gift, CheckCircle, Users } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import VoucherSelector from "./VoucherSelector";

// Stripe promise will be initialized dynamically
let stripePromise = null;

// Stripe Payment Form Component
function StripePaymentForm({ clientSecret, onSuccess, onCancel, amount }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      const { error: submitError } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: window.location.href
        },
        redirect: 'if_required'
      });

      if (submitError) {
        setError(submitError.message);
        setProcessing(false);
      } else {
        onSuccess();
      }
    } catch (err) {
      console.error("Stripe confirmPayment error:", err);
      setError(err.message);
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <p className="text-sm text-blue-900">
          <strong>Amount to charge:</strong> £{amount.toFixed(2)}
        </p>
      </div>

      <div>
        <PaymentElement options={{ layout: "tabs" }} />
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle className="w-4 h-4 mr-0.5 mt-0.5 text-red-600 shrink-0" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={processing}
          className="flex-1"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!stripe || processing}
          className="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
        >
          {processing ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Processing...
            </>
          ) : (
            `Pay £${amount.toFixed(2)}`
          )}
        </Button>
      </div>
    </form>
  );
}

export default function PaymentOptions({ 
  totalCost, 
  memberInfo, 
  organizationInfo, 
  attendees, 
  numberOfLinks, 
  event, 
  submitting, 
  setSubmitting, 
  registrationMode, 
  refreshOrganizationInfo,
  isOneOffEvent = false,
  oneOffCostDetails = null,
  ticketPrice = 0,
  isFeatureExcluded = () => false,
  selectedTicketClass = null,
  onCanProceedChange = null,
  isGuestCheckout = false,
  guestInfo = null,
  noTicketsForRole = false,
  isSoldOut = false,
  hasAttendeesWithMissingNames = false
}) {
  // Payment state for one-off events
  const [selectedVouchers, setSelectedVouchers] = useState([]);
  const [trainingFundAmount, setTrainingFundAmount] = useState(0);
  // For non-logged-in users (public checkout), default to card payment
  const [remainingBalancePaymentMethod, setRemainingBalancePaymentMethod] = useState(memberInfo ? 'account' : 'card');
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState('');
  const [showStripeModal, setShowStripeModal] = useState(false);
  const [stripeClientSecret, setStripeClientSecret] = useState(null);
  const [stripePaymentIntentId, setStripePaymentIntentId] = useState(null);
  const [stripeAvailable, setStripeAvailable] = useState(false);
  const [poSupplyLater, setPoSupplyLater] = useState(false);
  
  // Duplicate registration check state
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [duplicateAttendees, setDuplicateAttendees] = useState([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);

  // Initialize Stripe by fetching the publishable key from the backend
  useEffect(() => {
    const initStripe = async () => {
      if (stripePromise) {
        setStripeAvailable(true);
        return;
      }
      try {
        const response = await base44.functions.invoke('getStripePublishableKey');
        if (response.data.publishableKey) {
          stripePromise = loadStripe(response.data.publishableKey);
          setStripeAvailable(true);
        }
      } catch (error) {
        console.error('Failed to load Stripe publishable key:', error);
      }
    };
    initStripe();
  }, []);

  // Fetch vouchers for one-off events
  const { data: vouchers = [] } = useQuery({
    queryKey: ['vouchers', organizationInfo?.id],
    queryFn: async () => {
      if (!organizationInfo?.id) return [];
      // Fetch from Voucher entity (not ProgramTicketTransaction)
      const allVouchers = await base44.entities.Voucher.list();
      return allVouchers.filter(v => 
        v.organization_id === organizationInfo.id && 
        v.status === 'active' &&
        (v.value || 0) > 0
      );
    },
    enabled: isOneOffEvent && !!organizationInfo?.id
  });

  // Calculate tickets required based on registration mode
  const ticketsRequired = registrationMode === 'links' ? numberOfLinks : attendees.filter(a => a.isValid).length;

  // Get available program tickets for this specific event's program
  const availableProgramTickets = event.program_tag && organizationInfo?.program_ticket_balances 
    ? (organizationInfo.program_ticket_balances[event.program_tag] || 0)
    : 0;

  // Check if we have enough tickets (for program events)
  const hasEnoughTickets = isOneOffEvent ? true : availableProgramTickets >= ticketsRequired;

  // Calculate voucher amount from selected vouchers - capped at totalCost
  const voucherAmountRaw = selectedVouchers.reduce((sum, voucherId) => {
    const voucher = vouchers.find((v) => v.id === voucherId);
    return sum + (voucher?.value || 0);
  }, 0);
  const voucherAmount = isFeatureExcluded('payment_training_vouchers') ? 0 : Math.min(voucherAmountRaw, totalCost);

  // Max available for training fund
  const maxTrainingFund = isFeatureExcluded('payment_training_fund') ? 0 : Math.min(
    organizationInfo?.training_fund_balance || 0,
    totalCost - voucherAmount
  );

  // Calculate remaining balance automatically
  const remainingBalance = Math.max(0, totalCost - voucherAmount - trainingFundAmount);

  // Handle payment allocation changes
  const handleTrainingFundChange = (value) => {
    const numValue = Math.max(0, Math.min(maxTrainingFund, parseFloat(value) || 0));
    setTrainingFundAmount(numValue);
  };

  // Check if fully paid for one-off events
  // For guest checkout, card is the only payment option
  const isFullyPaid = Math.abs(remainingBalance) < 0.01 || 
    (remainingBalance > 0 && (
      isGuestCheckout || // Guest checkout always uses card
      remainingBalancePaymentMethod === 'card' || 
      (remainingBalancePaymentMethod === 'account' && (purchaseOrderNumber.trim() || poSupplyLater))
    ));

  // Handle program event booking (existing logic)
  const handleProgramBooking = async () => {
    // Validate attendees have all required information
    if (registrationMode === 'colleagues' || registrationMode === 'self') {
      const invalidAttendees = attendees.filter(a => {
        const needsManualName = !a.isSelf && 
                               (a.validationStatus === 'unregistered_domain_match' || 
                                a.validationStatus === 'external');
        
        if (needsManualName && (!a.first_name || !a.last_name)) {
          return true;
        }
        
        return false;
      });

      if (invalidAttendees.length > 0) {
        toast.error('Please provide first and last names for all attendees');
        return;
      }
    }

    if (!hasEnoughTickets) {
      toast.error("Insufficient program tickets. Please purchase more tickets first.");
      return;
    }

    if (registrationMode === 'colleagues' && attendees.some(a => !a.isValid)) {
      toast.error("Please remove or fix invalid attendee emails");
      return;
    }

    if (ticketsRequired === 0) {
      toast.error("Please add at least one attendee or specify number of links");
      return;
    }

    setSubmitting(true);

    try {
      const response = await base44.functions.invoke('createBooking', {
        eventId: event.id,
        memberEmail: memberInfo.email,
        attendees: (registrationMode === 'colleagues' || registrationMode === 'self') ? attendees.filter(a => a.isValid) : [],
        registrationMode: registrationMode,
        numberOfLinks: registrationMode === 'links' ? numberOfLinks : 0,
        ticketsRequired: ticketsRequired,
        programTag: event.program_tag
      });

      if (response.data.success) {
        sessionStorage.removeItem(`event_registration_${event.id}`);
        
        if (refreshOrganizationInfo) {
          refreshOrganizationInfo();
        }
        
        toast.success("Booking confirmed!");
        setTimeout(() => {
          window.location.href = createPageUrl('Bookings');
        }, 1500);
      } else {
        toast.error(response.data.error || "Failed to create booking");
      }
    } catch (error) {
      toast.error(error.response?.data?.error || "Failed to create booking");
    } finally {
      setSubmitting(false);
    }
  };

  // Handle one-off event booking with payment
  const handleOneOffBooking = async () => {
    console.log('[PaymentOptions] handleOneOffBooking called', {
      isGuestCheckout,
      ticketsRequired,
      totalCost,
      remainingBalance,
      remainingBalancePaymentMethod,
      guestInfo: guestInfo ? { email: guestInfo.email, first_name: guestInfo.first_name } : null,
      attendeesCount: attendees?.length
    });

    // For guest checkout, skip member-specific validations
    if (!isGuestCheckout) {
      // Validate attendees
      if (registrationMode === 'colleagues' || registrationMode === 'self') {
        const invalidAttendees = attendees.filter(a => {
          const needsManualName = !a.isSelf && 
                                 (a.validationStatus === 'unregistered_domain_match' || 
                                  a.validationStatus === 'external');
          
          if (needsManualName && (!a.first_name || !a.last_name)) {
            return true;
          }
          
          return false;
        });

        if (invalidAttendees.length > 0) {
          toast.error('Please provide first and last names for all attendees');
          return;
        }
      }

      if (registrationMode === 'colleagues' && attendees.some(a => !a.isValid)) {
        toast.error("Please remove or fix invalid attendee emails");
        return;
      }
    }

    if (ticketsRequired === 0) {
      toast.error(isGuestCheckout ? "Please fill in your details" : "Please add at least one attendee");
      return;
    }

    // Determine email for Stripe payment - use guest email for guest checkout
    const paymentEmail = isGuestCheckout ? guestInfo?.email : memberInfo?.email;

    // If paying by card and there's a remaining balance, create Stripe payment intent
    // For guest checkout, card is the only payment option
    console.log('[PaymentOptions] Checking Stripe condition:', {
      remainingBalance,
      remainingBalancePaymentMethod,
      isGuestCheckout,
      conditionResult: remainingBalance > 0 && (remainingBalancePaymentMethod === 'card' || isGuestCheckout)
    });

    if (remainingBalance > 0 && (remainingBalancePaymentMethod === 'card' || isGuestCheckout)) {
      if (!paymentEmail) {
        toast.error("Please provide a valid email address");
        console.log('[PaymentOptions] No payment email, returning early');
        return;
      }

      console.log('[PaymentOptions] Creating Stripe payment intent for amount:', remainingBalance);
      setSubmitting(true);
      try {
        const response = await base44.functions.invoke('createStripePaymentIntent', {
          amount: remainingBalance,
          currency: 'gbp',
          memberEmail: paymentEmail,
          metadata: {
            event_id: event.id,
            event_title: event.title,
            organization_id: organizationInfo?.id || null,
            booking_type: isGuestCheckout ? 'guest_one_off_event' : 'one_off_event',
            is_guest: isGuestCheckout ? 'true' : 'false'
          }
        });

        console.log('[PaymentOptions] Stripe payment intent response:', response.data);
        if (response.data.success) {
          console.log('[PaymentOptions] Setting Stripe modal state to true');
          setStripeClientSecret(response.data.clientSecret);
          setStripePaymentIntentId(response.data.paymentIntentId);
          setShowStripeModal(true);
        } else {
          console.error('[PaymentOptions] Stripe payment intent failed:', response.data.error);
          toast.error("Failed to initialize payment: " + (response.data.error || "Unknown error"));
        }
      } catch (error) {
        console.error("[PaymentOptions] Error creating Stripe Payment Intent:", error);
        toast.error("Failed to initialize payment");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // If paying by account, require PO number or "supply later" toggle
    if (remainingBalance > 0 && remainingBalancePaymentMethod === 'account' && !purchaseOrderNumber.trim() && !poSupplyLater) {
      toast.error("Please enter a purchase order number or select 'Supply later'");
      return;
    }

    // Process the booking (for free events or when payment is fully covered)
    console.log('[PaymentOptions] Processing booking directly (no Stripe needed)', { remainingBalance, totalCost });
    await processOneOffBooking();
  };

  // Process one-off booking (after payment if needed)
  const processOneOffBooking = async (stripePaymentId = null) => {
    console.log('[PaymentOptions] processOneOffBooking started');
    setSubmitting(true);

    try {
      // Log attendees before filtering
      console.log('[PaymentOptions] All attendees before filter:', JSON.stringify(attendees));
      const validAttendees = attendees.filter(a => a.isValid);
      console.log('[PaymentOptions] Valid attendees after filter:', JSON.stringify(validAttendees));
      console.log('[PaymentOptions] Valid attendees count:', validAttendees.length);
      
      const bookingPayload = {
        eventId: event.id,
        attendees: validAttendees,
        registrationMode: registrationMode,
        ticketsRequired: ticketsRequired,
        totalCost: totalCost,
        pricingDetails: oneOffCostDetails,
        paymentMethod: remainingBalance > 0 ? (isGuestCheckout ? 'card' : remainingBalancePaymentMethod) : 'fully_covered',
        stripePaymentIntentId: stripePaymentId,
        ticketClassId: selectedTicketClass?.id || null,
        ticketClassName: selectedTicketClass?.name || null,
        ticketClassPrice: selectedTicketClass?.price || ticketPrice,
        isGuestBooking: isGuestCheckout
      };

      // Add member-specific fields for logged-in users
      if (!isGuestCheckout) {
        bookingPayload.memberEmail = memberInfo.email;
        bookingPayload.selectedVoucherIds = isFeatureExcluded('payment_training_vouchers') ? [] : selectedVouchers;
        bookingPayload.trainingFundAmount = isFeatureExcluded('payment_training_fund') ? 0 : trainingFundAmount;
        bookingPayload.accountAmount = remainingBalancePaymentMethod === 'account' ? remainingBalance : 0;
        bookingPayload.purchaseOrderNumber = remainingBalancePaymentMethod === 'account' ? purchaseOrderNumber.trim() : null;
        bookingPayload.poToFollow = remainingBalancePaymentMethod === 'account' ? poSupplyLater : false;
      } else {
        // Add guest-specific fields
        bookingPayload.guestInfo = {
          first_name: guestInfo.first_name,
          last_name: guestInfo.last_name,
          email: guestInfo.email,
          organization: guestInfo.organization,
          phone: guestInfo.phone || null,
          job_title: guestInfo.job_title || null
        };
      }

      console.log('[PaymentOptions] Calling createOneOffEventBooking API with payload:', JSON.stringify(bookingPayload));
      const response = await base44.functions.invoke('createOneOffEventBooking', bookingPayload);
      console.log('[PaymentOptions] API response received:', JSON.stringify(response.data));

      if (response.data.success) {
        sessionStorage.removeItem(`event_registration_${event.id}`);
        
        if (refreshOrganizationInfo && !isGuestCheckout) {
          refreshOrganizationInfo();
        }
        
        // Log Xero debug info for troubleshooting (temporary)
        if (response.data.xero_debug) {
          console.log('XERO DEBUG INFO:', JSON.stringify(response.data.xero_debug, null, 2));
          // Store in sessionStorage so we can display it
          if (response.data.xero_debug.attempted || response.data.xero_debug.conditionsMet) {
            sessionStorage.setItem('xero_debug_info', JSON.stringify(response.data.xero_debug, null, 2));
            // Open debug info in new tab with copyable content
            const debugWindow = window.open('', '_blank');
            if (debugWindow) {
              debugWindow.document.write(`
                <html>
                <head><title>Xero Debug Info</title></head>
                <body style="font-family: monospace; padding: 20px; background: #1e1e1e; color: #d4d4d4;">
                  <h2 style="color: #4fc3f7;">Xero Invoice Debug Info</h2>
                  <p style="color: #81c784;">Copy the JSON below:</p>
                  <textarea id="debug-text" style="width: 100%; height: 400px; font-family: monospace; font-size: 14px; background: #2d2d2d; color: #d4d4d4; border: 1px solid #555; padding: 10px;">${JSON.stringify(response.data.xero_debug, null, 2)}</textarea>
                  <br><br>
                  <button onclick="navigator.clipboard.writeText(document.getElementById('debug-text').value); this.textContent='Copied!';" style="padding: 10px 20px; font-size: 16px; cursor: pointer; background: #4fc3f7; border: none; border-radius: 4px;">Copy to Clipboard</button>
                </body>
                </html>
              `);
            }
          }
        }
        
        toast.success("Booking confirmed!");
        
        // For guest checkout, redirect to a confirmation page or Events page
        // For member checkout, redirect to Bookings page
        setTimeout(() => {
          if (isGuestCheckout) {
            window.location.href = createPageUrl('Events');
          } else {
            window.location.href = createPageUrl('Bookings');
          }
        }, 1500);
      } else {
        toast.error(response.data.error || "Failed to create booking");
      }
    } catch (error) {
      console.error("Booking error:", error);
      toast.error(error.message || "Failed to create booking");
    } finally {
      setSubmitting(false);
    }
  };

  // Handle Stripe payment success
  const handleStripePaymentSuccess = async () => {
    setShowStripeModal(false);
    await processOneOffBooking(stripePaymentIntentId);
  };

  // Check for duplicate registrations before proceeding
  const checkForDuplicates = async () => {
    // Get list of attendee emails to check
    let emailsToCheck = [];
    
    if (isGuestCheckout && guestInfo?.email) {
      emailsToCheck = [guestInfo.email];
    } else if (attendees && attendees.length > 0) {
      emailsToCheck = attendees
        .filter(a => a.isValid && a.email)
        .map(a => a.email.toLowerCase().trim());
    }
    
    if (emailsToCheck.length === 0) {
      return { hasDuplicates: false, duplicates: [] };
    }
    
    try {
      setCheckingDuplicates(true);
      const response = await base44.functions.invoke('checkDuplicateRegistrations', {
        eventId: event.id,
        attendeeEmails: emailsToCheck
      });
      
      if (response.data.success && response.data.hasDuplicates) {
        return { hasDuplicates: true, duplicates: response.data.duplicates };
      }
      return { hasDuplicates: false, duplicates: [] };
    } catch (error) {
      console.error('Error checking for duplicates:', error);
      // If check fails, allow booking to proceed (fail open)
      return { hasDuplicates: false, duplicates: [] };
    } finally {
      setCheckingDuplicates(false);
    }
  };

  // Main submit handler with duplicate check
  const handleSubmit = async () => {
    // Check for duplicate registrations first
    const { hasDuplicates, duplicates } = await checkForDuplicates();
    
    if (hasDuplicates) {
      setDuplicateAttendees(duplicates);
      setShowDuplicateWarning(true);
      return;
    }
    
    // No duplicates, proceed with booking
    if (isOneOffEvent) {
      handleOneOffBooking();
    } else {
      handleProgramBooking();
    }
  };

  // Render one-off event pricing summary
  const renderOneOffPricing = () => {
    if (!isOneOffEvent || !oneOffCostDetails) return null;

    return (
      <div className="space-y-4">
        {/* Ticket Pricing Card */}
        <div className="p-4 rounded-lg border-2 border-blue-200 bg-blue-50" id="booking-summary-pricing">
          <div className="flex items-center gap-2 mb-3">
            <PoundSterling className="w-5 h-5 text-blue-600" />
            <h3 className="font-semibold text-blue-900">Ticket Pricing</h3>
          </div>
          
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-blue-700">Ticket Price:</span>
              <span className="font-bold text-blue-900">£{ticketPrice.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-blue-700">Attendees:</span>
              <span className="font-bold text-blue-900">{ticketsRequired}</span>
            </div>
            
            {oneOffCostDetails.freeTickets > 0 && (
              <div className="flex items-center justify-between text-sm text-green-700">
                <span className="flex items-center gap-1">
                  <Gift className="w-3 h-3" />
                  Free Tickets:
                </span>
                <span className="font-bold">-{oneOffCostDetails.freeTickets}</span>
              </div>
            )}
            
            {oneOffCostDetails.discount > 0 && (
              <div className="flex items-center justify-between text-sm text-green-700">
                <span className="flex items-center gap-1">
                  <Tag className="w-3 h-3" />
                  Discount:
                </span>
                <span className="font-bold">-£{oneOffCostDetails.discount.toFixed(2)}</span>
              </div>
            )}
            
            {oneOffCostDetails.discountDescription && (
              <div className="mt-2 p-2 bg-green-100 border border-green-200 rounded text-xs text-green-800">
                {oneOffCostDetails.discountDescription}
              </div>
            )}
            
            <div className="flex items-center justify-between text-sm pt-2 border-t border-blue-200">
              <span className="text-blue-700 font-medium">Total Cost:</span>
              <span className="font-bold text-lg text-blue-900">£{totalCost.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Payment Options */}
        {totalCost > 0 && ticketsRequired > 0 && (
          <div className="space-y-4">
            {/* Vouchers - only for logged-in members */}
            {memberInfo && !isFeatureExcluded('payment_training_vouchers') && (
              <div className="p-4 rounded-lg border border-slate-200 bg-blue-50">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Ticket className="w-4 h-4 text-blue-600" />
                    <Label className="text-sm font-medium">Training Vouchers</Label>
                  </div>
                  {vouchers.length > 0 && (
                    <span className="text-xs text-slate-500">
                      {vouchers.length} voucher{vouchers.length !== 1 ? 's' : ''} available
                    </span>
                  )}
                </div>
                {vouchers.length > 0 ? (
                  <>
                    <VoucherSelector
                      organizationId={organizationInfo?.id}
                      selectedVouchers={selectedVouchers}
                      onVoucherToggle={setSelectedVouchers}
                      maxAmount={totalCost}
                    />
                    {voucherAmount > 0 && (
                      <div className="mt-3 pt-3 border-t border-blue-200">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-blue-700">Voucher Value Applied:</span>
                          <span className="font-bold text-blue-900">£{voucherAmount.toFixed(2)}</span>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-slate-500">No training vouchers available for your organisation</p>
                )}
              </div>
            )}

            {/* Training Fund - only for logged-in members */}
            {memberInfo && !isFeatureExcluded('payment_training_fund') && (
              <div className="p-4 rounded-lg border border-slate-200 bg-green-50">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-green-600" />
                    <Label className="text-sm font-medium">Training Fund</Label>
                  </div>
                  <span className="text-xs text-slate-500">Available: £{(organizationInfo?.training_fund_balance || 0).toFixed(2)}</span>
                </div>
                <Input
                  type="number"
                  min="0"
                  max={maxTrainingFund}
                  step="0.01"
                  placeholder="Amount in £"
                  value={trainingFundAmount || ''}
                  onChange={(e) => handleTrainingFundChange(e.target.value)}
                  disabled={maxTrainingFund === 0}
                />
              </div>
            )}

            {/* Remaining Balance Payment */}
            {remainingBalance > 0 && (
              <div className="p-4 rounded-lg border border-slate-200 bg-slate-50">
                <div className="flex items-center gap-2 mb-4">
                  <CreditCard className="w-4 h-4 text-indigo-600" />
                  <Label className="text-sm font-medium">Pay Balance</Label>
                </div>
                
                <div className="mb-4 p-3 bg-white rounded-lg border border-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">Amount Due:</span>
                    <span className="text-lg font-bold text-slate-900">£{remainingBalance.toFixed(2)}</span>
                  </div>
                </div>

                {/* For non-logged-in users, only show card payment option */}
                {!memberInfo ? (
                  <div className="flex items-start space-x-3 p-3 rounded-lg border-2 border-indigo-500 bg-white">
                    <CreditCard className="w-5 h-5 text-indigo-600 mt-0.5" />
                    <div className="flex-1">
                      <Label className="text-sm font-medium">Pay by Credit/Debit Card</Label>
                      {stripeAvailable ? (
                        <p className="text-xs text-slate-500 mt-1">Secure payment via Stripe</p>
                      ) : (
                        <p className="text-xs text-amber-600 mt-1">Card payments not currently available</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <RadioGroup value={remainingBalancePaymentMethod} onValueChange={setRemainingBalancePaymentMethod}>
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <div
                          className="flex items-start space-x-3 p-3 rounded-lg border-2 transition-colors cursor-pointer hover:bg-slate-100"
                          style={{ borderColor: remainingBalancePaymentMethod === 'account' ? '#6366f1' : '#e2e8f0' }}
                          onClick={() => setRemainingBalancePaymentMethod('account')}
                        >
                          <RadioGroupItem value="account" id="account" className="mt-1" />
                          <div className="flex-1">
                            <Label htmlFor="account" className="text-sm font-medium cursor-pointer">Charge to Organisation Account</Label>
                            <p className="text-xs text-slate-500 mt-1">Requires purchase order number</p>
                          </div>
                        </div>

                        {remainingBalancePaymentMethod === 'account' && (
                          <div className="ml-6 space-y-3">
                            {!poSupplyLater && (
                              <Input
                                placeholder="Purchase Order Number *"
                                value={purchaseOrderNumber}
                                onChange={(e) => setPurchaseOrderNumber(e.target.value)}
                                className="mt-2"
                                data-testid="input-purchase-order"
                              />
                            )}
                            <div className="flex items-center space-x-2 mt-2">
                              <Switch
                                id="po-supply-later"
                                checked={poSupplyLater}
                                onCheckedChange={(checked) => {
                                  setPoSupplyLater(checked);
                                  if (checked) {
                                    setPurchaseOrderNumber('');
                                  }
                                }}
                                data-testid="switch-po-supply-later"
                              />
                              <Label htmlFor="po-supply-later" className="text-sm cursor-pointer">
                                Supply later
                              </Label>
                            </div>
                          </div>
                        )}
                      </div>

                      <div
                        className={`flex items-start space-x-3 p-3 rounded-lg border-2 transition-colors ${stripeAvailable ? 'cursor-pointer hover:bg-slate-100' : 'opacity-60 cursor-not-allowed'}`}
                        style={{ borderColor: remainingBalancePaymentMethod === 'card' ? '#6366f1' : '#e2e8f0' }}
                        onClick={() => stripeAvailable && setRemainingBalancePaymentMethod('card')}
                      >
                        <RadioGroupItem value="card" id="card" className="mt-1" disabled={!stripeAvailable} />
                        <div className="flex-1">
                          <Label htmlFor="card" className={`text-sm font-medium ${stripeAvailable ? 'cursor-pointer' : 'cursor-not-allowed'}`}>Pay by Credit/Debit Card</Label>
                          {stripeAvailable ? (
                            <p className="text-xs text-slate-500 mt-1">Secure payment via Stripe</p>
                          ) : (
                            <p className="text-xs text-amber-600 mt-1">Card payments not currently available</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </RadioGroup>
                )}
              </div>
            )}

            {/* Payment Summary */}
            {(voucherAmount > 0 || trainingFundAmount > 0) && (
              <div className="p-4 rounded-lg border-2 border-green-200 bg-green-50">
                <h4 className="text-sm font-medium text-green-900 mb-2">Payment Summary</h4>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between text-green-700">
                    <span>Total Cost:</span>
                    <span>£{totalCost.toFixed(2)}</span>
                  </div>
                  {voucherAmount > 0 && (
                    <div className="flex justify-between text-green-700">
                      <span>Vouchers:</span>
                      <span>-£{voucherAmount.toFixed(2)}</span>
                    </div>
                  )}
                  {trainingFundAmount > 0 && (
                    <div className="flex justify-between text-green-700">
                      <span>Training Fund:</span>
                      <span>-£{trainingFundAmount.toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between pt-2 border-t border-green-200 font-bold text-green-900">
                    <span>Balance to Pay:</span>
                    <span>£{remainingBalance.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Render program event display (existing logic)
  const renderProgramEventDisplay = () => {
    if (isOneOffEvent) return null;

    return (
      <>
        {event.program_tag ? (
          <div className="p-4 rounded-lg border-2 border-purple-200 bg-purple-50" id="booking-summary-tickets">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Ticket className="w-5 h-5 text-purple-600" />
                <h3 className="font-semibold text-purple-900">Program Tickets</h3>
              </div>
              <span className="text-xs text-purple-600">
                Available: {availableProgramTickets}
              </span>
            </div>
            
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-purple-700">Tickets Required:</span>
                <span className="font-bold text-purple-900">{ticketsRequired}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-purple-700">Tickets Available:</span>
                <span className="font-bold text-purple-900">{availableProgramTickets}</span>
              </div>
              <div className="flex items-center justify-between text-sm pt-2 border-t border-purple-200">
                <span className="text-purple-700">Remaining After Booking:</span>
                <span className={`font-bold ${hasEnoughTickets ? 'text-green-600' : 'text-red-600'}`}>
                  {Math.max(0, availableProgramTickets - ticketsRequired)}
                </span>
              </div>
            </div>

            {!hasEnoughTickets && (
              <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="text-xs text-amber-800">
                    <p className="font-medium mb-1">Insufficient tickets</p>
                    <p>You need {ticketsRequired - availableProgramTickets} more {event.program_tag} ticket{ticketsRequired - availableProgramTickets > 1 ? 's' : ''} to complete this booking.</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 rounded-lg border-2 border-amber-200 bg-amber-50">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
              <div className="text-sm text-amber-800">
                <p className="font-medium mb-1">No Program Required</p>
                <p>This event is not associated with a program and cannot be booked through this system.</p>
              </div>
            </div>
          </div>
        )}
      </>
    );
  };

  // Determine if booking can proceed
  // For one-off events, also block if no tickets available for user's role
  // Also block if event is sold out or if attendees are missing required names
  const canProceed = !isSoldOut && !hasAttendeesWithMissingNames && (isOneOffEvent 
    ? (ticketsRequired > 0 && !submitting && (totalCost === 0 || isFullyPaid) && !noTicketsForRole)
    : (hasEnoughTickets && event.program_tag && !submitting && ticketsRequired > 0));

  // Notify parent component of canProceed state changes
  useEffect(() => {
    if (onCanProceedChange) {
      onCanProceedChange(canProceed);
    }
  }, [canProceed, onCanProceedChange]);

  return (
    <>
      <Card className="border-slate-200 shadow-lg sticky top-8">
        <CardHeader className="border-b border-slate-200">
          <CardTitle className="text-xl">Booking Summary</CardTitle>
        </CardHeader>
        <CardContent className="pt-6 space-y-6">
          {isOneOffEvent ? renderOneOffPricing() : renderProgramEventDisplay()}

          {/* Action Buttons */}
          {!isOneOffEvent && !hasEnoughTickets && event.program_tag && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => window.location.href = createPageUrl('BuyProgramTickets')}
            >
              <Ticket className="w-4 h-4 mr-2" />
              Buy {event.program_tag} Tickets
            </Button>
          )}

          <Button
            id="confirm-booking-button"
            onClick={handleSubmit}
            disabled={!canProceed || checkingDuplicates}
            className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
            size="lg"
          >
            {checkingDuplicates ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Checking...
              </>
            ) : submitting ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Processing...
              </>
            ) : isSoldOut ? (
              'Sold Out'
            ) : isOneOffEvent ? (
              totalCost > 0 ? `Book & Pay £${remainingBalance.toFixed(2)}` : 'Confirm Booking'
            ) : (
              'Confirm Booking'
            )}
          </Button>

          {ticketsRequired === 0 && registrationMode === 'colleagues' && (
            <p className="text-xs text-center text-slate-500">
              Add attendees to proceed with booking
            </p>
          )}
          
          {hasAttendeesWithMissingNames && (
            <p className="text-xs text-center text-red-600 mt-2">
              Please enter first and last names for all external attendees
            </p>
          )}
        </CardContent>
      </Card>

      {/* Stripe Payment Modal */}
      <Dialog open={showStripeModal} onOpenChange={setShowStripeModal}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Enter Payment Details</DialogTitle>
            <DialogDescription>
              Complete your booking by entering your card information below.
            </DialogDescription>
          </DialogHeader>
          
          {stripeClientSecret && stripePromise && (
            <Elements stripe={stripePromise} options={{ clientSecret: stripeClientSecret }}>
              <StripePaymentForm
                clientSecret={stripeClientSecret}
                onSuccess={handleStripePaymentSuccess}
                onCancel={() => {
                  setShowStripeModal(false);
                  setStripeClientSecret(null);
                  setStripePaymentIntentId(null);
                  setSubmitting(false);
                }}
                amount={remainingBalance}
              />
            </Elements>
          )}
        </DialogContent>
      </Dialog>

      {/* Duplicate Registration Warning Modal */}
      <Dialog open={showDuplicateWarning} onOpenChange={setShowDuplicateWarning}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertCircle className="w-5 h-5" />
              Duplicate Registration Detected
            </DialogTitle>
            <DialogDescription>
              The following attendees are already registered for this event and cannot be booked again.
            </DialogDescription>
          </DialogHeader>
          
          <div className="mt-4 space-y-3">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Users className="w-4 h-4 text-amber-600" />
                <span className="font-medium text-amber-800">Already Registered:</span>
              </div>
              <ul className="space-y-2">
                {duplicateAttendees.map((attendee, index) => (
                  <li key={index} className="flex items-center gap-2 text-sm text-amber-700">
                    <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0"></span>
                    <span className="font-medium">{attendee.name}</span>
                    <span className="text-amber-500">({attendee.email})</span>
                  </li>
                ))}
              </ul>
            </div>
            
            <p className="text-sm text-slate-600">
              Please remove the duplicate attendees from your registration and try again.
            </p>
          </div>

          <div className="mt-4 flex justify-end">
            <Button
              onClick={() => setShowDuplicateWarning(false)}
              className="bg-amber-600 hover:bg-amber-700"
              data-testid="button-close-duplicate-warning"
            >
              OK, I'll Update Attendees
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
