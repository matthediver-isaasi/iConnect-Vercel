
import React, { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Loader2, Ticket, AlertCircle, PoundSterling, Wallet, CreditCard, Tag, Gift, CheckCircle, CheckCircle2, Users, Wifi, LogIn, Lock, Calendar, MapPin, Copy, ArrowRight, Heart } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import VoucherSelector from "./VoucherSelector";
import { useBalancesRealtime } from "@/hooks/useBalancesRealtime";
import { getEffectiveTicketPrice } from "@/lib/ticketPricing";

// Stripe promise will be initialized dynamically
let stripePromise = null;

function InlineDonationSection({ donationConfig, event, paymentEmail, bookingReference, stripeReady }) {
  const [selectedAmount, setSelectedAmount] = useState(null);
  const [customAmount, setCustomAmount] = useState('');
  const [giftAid, setGiftAid] = useState(false);
  const [giftAidAddress1, setGiftAidAddress1] = useState('');
  const [giftAidAddress2, setGiftAidAddress2] = useState('');
  const [giftAidCity, setGiftAidCity] = useState('');
  const [giftAidPostcode, setGiftAidPostcode] = useState('');
  const [donationSubmitting, setDonationSubmitting] = useState(false);
  const [donationClientSecret, setDonationClientSecret] = useState(null);
  const [donationCompleted, setDonationCompleted] = useState(false);
  const [donationError, setDonationError] = useState(null);

  const presetAmounts = donationConfig?.preset_amounts || [5, 10, 25, 50];
  const allowCustomAmount = donationConfig?.allow_custom_amount !== false;
  const customMessage = donationConfig?.custom_message || '';
  const donationAmount = selectedAmount || parseFloat(customAmount) || 0;
  const giftAidBonus = giftAid ? donationAmount * 0.25 : 0;
  const isGiftAidValid = !giftAid || (giftAidAddress1.trim() && giftAidCity.trim() && giftAidPostcode.trim());
  const canDonate = donationAmount > 0 && isGiftAidValid && !donationSubmitting && stripeReady;

  const handleDonate = async () => {
    if (!canDonate) return;
    setDonationSubmitting(true);
    setDonationError(null);
    try {
      const response = await base44.functions.invoke('createStripePaymentIntent', {
        amount: donationAmount,
        currency: 'gbp',
        memberEmail: paymentEmail,
        metadata: {
          event_id: event.id,
          event_title: (event.title || '').substring(0, 200),
          payment_type: 'donation',
          booking_reference: bookingReference || '',
          gift_aid: giftAid ? 'true' : 'false',
          gift_aid_amount: giftAid ? giftAidBonus.toFixed(2) : '0',
          member_email: paymentEmail
        }
      });

      if (response.data.success) {
        setDonationClientSecret(response.data.clientSecret);
      } else {
        setDonationError('Could not set up donation payment. Please try again.');
        setDonationSubmitting(false);
      }
    } catch (err) {
      console.error('[InlineDonation] Error creating payment intent:', err);
      setDonationError('Something went wrong. Please try again.');
      setDonationSubmitting(false);
    }
  };

  const handleDonationPaymentSuccess = async () => {
    setDonationCompleted(true);
    setDonationClientSecret(null);
    setDonationSubmitting(false);

    try {
      await base44.functions.invoke('recordDonation', {
        event_id: event.id,
        booking_reference: bookingReference,
        amount: donationAmount,
        currency: 'gbp',
        gift_aid: giftAid,
        gift_aid_address: giftAid ? {
          address_line_1: giftAidAddress1.trim(),
          address_line_2: giftAidAddress2.trim(),
          city: giftAidCity.trim(),
          postcode: giftAidPostcode.trim()
        } : null,
        donor_email: paymentEmail
      });
    } catch (err) {
      console.error('[InlineDonation] Error recording donation:', err);
    }

    toast.success('Thank you for your generous donation!');
  };

  if (donationCompleted) {
    return (
      <div className="p-4 rounded-md border border-pink-200 bg-pink-50 dark:border-pink-800 dark:bg-pink-950/20 space-y-2 text-center">
        <div className="flex justify-center">
          <Heart className="w-6 h-6 text-pink-600" />
        </div>
        <p className="text-sm font-medium" data-testid="text-donation-thank-you">Thank you for your donation of {'\u00a3'}{donationAmount.toFixed(2)}</p>
        {giftAid && (
          <p className="text-xs text-muted-foreground">
            With Gift Aid, your total contribution is worth {'\u00a3'}{(donationAmount + giftAidBonus).toFixed(2)}
          </p>
        )}
      </div>
    );
  }

  if (donationClientSecret) {
    if (!stripePromise) {
      return (
        <div className="p-4 rounded-md border border-pink-200 bg-pink-50/50 dark:border-pink-800 dark:bg-pink-950/10 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-pink-600" />
          <span className="text-sm text-muted-foreground">Loading payment...</span>
        </div>
      );
    }
    return (
      <div className="p-4 rounded-md border border-pink-200 bg-pink-50/50 dark:border-pink-800 dark:bg-pink-950/10 space-y-3">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Heart className="w-4 h-4 text-pink-600" />
          Complete Your Donation
        </h3>
        <Elements stripe={stripePromise} options={{ clientSecret: donationClientSecret }}>
          <StripePaymentForm
            clientSecret={donationClientSecret}
            onSuccess={handleDonationPaymentSuccess}
            onCancel={() => {
              setDonationClientSecret(null);
              setDonationSubmitting(false);
            }}
            amount={donationAmount}
            returnUrl={window.location.href}
          />
        </Elements>
      </div>
    );
  }

  return (
    <div className="p-4 rounded-md border border-pink-200 bg-pink-50/50 dark:border-pink-800 dark:bg-pink-950/10 space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Heart className="w-4 h-4 text-pink-600" />
          Would you like to make a donation?
        </h3>
        {customMessage && (
          <p className="text-xs text-muted-foreground">{customMessage}</p>
        )}
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-4 gap-2">
          {presetAmounts.map((amount) => (
            <Button
              key={amount}
              type="button"
              size="sm"
              variant={selectedAmount === amount ? 'default' : 'outline'}
              className={selectedAmount === amount ? 'ring-2 ring-pink-300' : ''}
              onClick={() => {
                setSelectedAmount(amount);
                setCustomAmount('');
              }}
              data-testid={`button-donation-amount-${amount}`}
            >
              {'\u00a3'}{amount}
            </Button>
          ))}
        </div>

        {allowCustomAmount && (
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
              {'\u00a3'}
            </span>
            <Input
              type="number"
              min="1"
              step="0.01"
              placeholder="Custom amount"
              value={customAmount}
              onChange={(e) => {
                setCustomAmount(e.target.value);
                setSelectedAmount(null);
              }}
              className="pl-7"
              data-testid="input-custom-donation-amount"
            />
          </div>
        )}
      </div>

      {donationAmount > 0 && (
        <div className="space-y-3 pt-2 border-t border-pink-200 dark:border-pink-800">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="inline-gift-aid" className="text-xs flex items-center gap-1.5">
                <Gift className="w-3.5 h-3.5 text-green-600" />
                Boost with Gift Aid (25%)
              </Label>
              <p className="text-xs text-muted-foreground">UK taxpayers only</p>
            </div>
            <Switch
              id="inline-gift-aid"
              checked={giftAid}
              onCheckedChange={setGiftAid}
              data-testid="switch-donation-gift-aid"
            />
          </div>

          {giftAid && (
            <div className="space-y-2 p-3 bg-green-50 dark:bg-green-950/20 rounded-md border border-green-200 dark:border-green-800">
              <p className="text-xs text-green-800 dark:text-green-300 flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                I confirm I am a UK taxpayer and understand that if I pay less Income Tax and/or Capital Gains Tax
                than the Gift Aid claimed, it is my responsibility to pay any difference.
              </p>
              <div className="space-y-1.5">
                <Input
                  placeholder="Address line 1 *"
                  value={giftAidAddress1}
                  onChange={(e) => setGiftAidAddress1(e.target.value)}
                  className="text-sm"
                  data-testid="input-donation-gift-aid-address1"
                />
                <Input
                  placeholder="Address line 2"
                  value={giftAidAddress2}
                  onChange={(e) => setGiftAidAddress2(e.target.value)}
                  className="text-sm"
                  data-testid="input-donation-gift-aid-address2"
                />
                <div className="grid grid-cols-2 gap-1.5">
                  <Input
                    placeholder="City / Town *"
                    value={giftAidCity}
                    onChange={(e) => setGiftAidCity(e.target.value)}
                    className="text-sm"
                    data-testid="input-donation-gift-aid-city"
                  />
                  <Input
                    placeholder="Postcode *"
                    value={giftAidPostcode}
                    onChange={(e) => setGiftAidPostcode(e.target.value)}
                    className="text-sm"
                    data-testid="input-donation-gift-aid-postcode"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="p-2 rounded-md bg-pink-100/50 dark:bg-pink-900/20 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Your donation</span>
              <span className="font-semibold">{'\u00a3'}{donationAmount.toFixed(2)}</span>
            </div>
            {giftAid && (
              <>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-green-600 text-xs">Gift Aid (25%)</span>
                  <span className="text-green-600 text-xs font-semibold">+ {'\u00a3'}{giftAidBonus.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between mt-0.5 pt-1 border-t border-pink-200 dark:border-pink-800">
                  <span className="font-medium text-xs">Total impact</span>
                  <span className="font-bold text-sm">{'\u00a3'}{(donationAmount + giftAidBonus).toFixed(2)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {donationError && (
        <div className="flex items-start gap-2 p-2 bg-red-50 border border-red-200 rounded-md">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 text-red-600 shrink-0" />
          <p className="text-xs text-red-800">{donationError}</p>
        </div>
      )}

      {donationAmount > 0 && (
        <Button
          type="button"
          onClick={handleDonate}
          disabled={!canDonate}
          className="w-full bg-gradient-to-r from-pink-500 to-rose-500 text-white"
          data-testid="button-confirm-donation"
        >
          {donationSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              Setting up...
            </>
          ) : (
            <>
              <Heart className="w-4 h-4 mr-1.5" />
              Donate {'\u00a3'}{donationAmount.toFixed(2)}
            </>
          )}
        </Button>
      )}
    </div>
  );
}

// Stripe Payment Form Component
function StripePaymentForm({ clientSecret, onSuccess, onCancel, amount, returnUrl }) {
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
          return_url: returnUrl || window.location.href
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
  isRegistrationClosed = false,
  hasAttendeesWithMissingNames = false,
  hasBookingTerms = false,
  bookingTerms = '',
  termsAccepted = false,
  setTermsAccepted = null,
  onShowTermsModal = null,
  collectThirdPartyConsent = false,
  thirdPartyConsent = true,
  setThirdPartyConsent = null,
  checkGuestEmailIsMember = null,
  checkingMemberEmail = false,
  guestEmailIsMember = false,
  isComplexEvent = false,
  complexEventApi = null,
  onComplexBookingComplete = null,
  renderAsCard = true
}) {
  const [internalSubmitting, setInternalSubmitting] = useState(false);
  const isSubmitting = submitting !== undefined ? submitting : internalSubmitting;
  const doSetSubmitting = setSubmitting || setInternalSubmitting;

  const [selectedVouchers, setSelectedVouchers] = useState([]);
  const [trainingFundAmount, setTrainingFundAmount] = useState(0);
  const [remainingBalancePaymentMethod, setRemainingBalancePaymentMethod] = useState(
    isComplexEvent ? 'card' : (memberInfo ? 'account' : 'card')
  );
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState('');
  const [showStripeModal, setShowStripeModal] = useState(false);
  const [stripeClientSecret, setStripeClientSecret] = useState(null);
  const [stripePaymentIntentId, setStripePaymentIntentId] = useState(null);
  const [stripeAvailable, setStripeAvailable] = useState(false);
  const [poSupplyLater, setPoSupplyLater] = useState(true);
  
  // 3D Secure return handling state
  const [completingPayment, setCompletingPayment] = useState(false);
  const [paymentReturnHandled, setPaymentReturnHandled] = useState(false);
  
  // Booking confirmation state (for guest checkout)
  const [bookingConfirmation, setBookingConfirmation] = useState(null);

  // Duplicate registration check state
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [duplicateAttendees, setDuplicateAttendees] = useState([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);

  // Discount code state
  const [discountCodeInput, setDiscountCodeInput] = useState("");
  const [appliedDiscount, setAppliedDiscount] = useState(null);
  const [applyingDiscount, setApplyingDiscount] = useState(false);

  const queryClient = useQueryClient();

  // Realtime callbacks for balance updates during booking
  const handleVoucherUpdated = useCallback(({ eventType, voucher }) => {
    console.log('[PaymentOptions] Voucher updated via realtime:', eventType, voucher?.id);
    queryClient.invalidateQueries({ queryKey: ['vouchers', organizationInfo?.id] });
    
    if (selectedVouchers.includes(voucher?.id)) {
      toast.warning('Voucher balance changed', {
        description: 'A voucher you selected has been used. Please review your payment options.',
        duration: 5000
      });
    }
  }, [queryClient, organizationInfo?.id, selectedVouchers]);

  const handleTrainingFundUpdated = useCallback(({ oldBalance, newBalance }) => {
    console.log('[PaymentOptions] Training fund updated via realtime:', oldBalance, '->', newBalance);
    if (refreshOrganizationInfo) {
      refreshOrganizationInfo();
    }
    
    if (trainingFundAmount > 0 && newBalance < trainingFundAmount) {
      toast.warning('Training fund balance changed', {
        description: `Available balance is now £${(newBalance || 0).toFixed(2)}. Please adjust your payment.`,
        duration: 5000
      });
      setTrainingFundAmount(Math.min(trainingFundAmount, newBalance || 0));
    }
  }, [refreshOrganizationInfo, trainingFundAmount]);

  // Subscribe to realtime updates for vouchers and training fund
  const { isConnected: realtimeConnected } = useBalancesRealtime(organizationInfo?.id, {
    onVoucherUpdated: handleVoucherUpdated,
    onTrainingFundUpdated: handleTrainingFundUpdated
  });

  // Initialize Stripe by fetching the publishable key from the backend
  useEffect(() => {
    const initStripe = async () => {
      if (stripePromise) {
        setStripeAvailable(true);
        return;
      }
      if (isComplexEvent) {
        setStripeAvailable(true);
        return;
      }
      try {
        const response = await base44.functions.invoke('getStripePublishableKey', { feature: 'events' });
        if (response.data.publishableKey) {
          stripePromise = loadStripe(response.data.publishableKey);
          setStripeAvailable(true);
        }
      } catch (error) {
        console.error('Failed to load Stripe publishable key:', error);
      }
    };
    initStripe();
  }, [isComplexEvent]);

  // Handle 3D Secure redirect return
  // When a user returns from 3D Secure bank verification, the URL will contain
  // payment_intent and redirect_status params. We detect this and auto-complete the booking.
  useEffect(() => {
    if (paymentReturnHandled || !event?.id) return;
    
    const urlParams = new URLSearchParams(window.location.search);
    const paymentIntentFromUrl = urlParams.get('payment_intent');
    const redirectStatus = urlParams.get('redirect_status');
    
    if (!paymentIntentFromUrl) return;
    
    setPaymentReturnHandled(true);
    
    console.log('[PaymentOptions] Detected 3D Secure return:', { paymentIntentFromUrl, redirectStatus });
    
    // Clean only Stripe-specific URL params, preserving all others (id, tenant context, etc.)
    const cleanParams = new URLSearchParams(window.location.search);
    cleanParams.delete('payment_intent');
    cleanParams.delete('payment_intent_client_secret');
    cleanParams.delete('redirect_status');
    const cleanSearch = cleanParams.toString();
    window.history.replaceState({}, '', window.location.pathname + (cleanSearch ? '?' + cleanSearch : ''));
    
    if (redirectStatus !== 'succeeded') {
      const savedPayloadKey = `pending_booking_payload_${event.id}`;
      sessionStorage.removeItem(savedPayloadKey);
      toast.error('Payment was not completed. Please try again.');
      return;
    }
    
    // Retrieve saved booking payload from sessionStorage
    const savedPayloadKey = `pending_booking_payload_${event.id}`;
    const savedPayloadJson = sessionStorage.getItem(savedPayloadKey);
    
    if (!savedPayloadJson) {
      console.error('[PaymentOptions] No saved booking payload found after 3D Secure return');
      toast.error('We could not find your booking details after payment verification. Please contact support with your payment reference.');
      return;
    }
    
    let savedPayload;
    try {
      savedPayload = JSON.parse(savedPayloadJson);
    } catch (e) {
      console.error('[PaymentOptions] Failed to parse saved booking payload:', e);
      toast.error('There was an error recovering your booking details. Please contact support.');
      return;
    }
    
    // Verify the payment intent matches what we saved
    if (savedPayload.stripePaymentIntentId !== paymentIntentFromUrl) {
      console.error('[PaymentOptions] PaymentIntent mismatch:', {
        saved: savedPayload.stripePaymentIntentId,
        fromUrl: paymentIntentFromUrl
      });
      toast.error('Payment reference mismatch. Please contact support.');
      return;
    }
    
    console.log('[PaymentOptions] Completing booking after 3D Secure return with saved payload');
    setCompletingPayment(true);
    
    const completeBookingAfterRedirect = async () => {
      try {
        if (savedPayload.isComplexEvent && complexEventApi) {
          const complexPayload = {
            payment_method: 'card',
            stripe_payment_intent_id: paymentIntentFromUrl,
            _savedCartItems: savedPayload.complexCartItems || []
          };
          if (typeof savedPayload.thirdPartyConsent === 'boolean') {
            complexPayload.third_party_consent = savedPayload.thirdPartyConsent;
          }
          const result = await complexEventApi.submitBooking(complexPayload);
          if (result.success) {
            sessionStorage.removeItem(savedPayloadKey);
            const isPending = result.bookings?.some(b => b.status === 'pending');
            setBookingConfirmation({
              bookingReference: result.booking_group_reference || result.booking_reference,
              bookings: result.bookings || [],
              paymentDetails: result.payment_details || null,
              xeroInvoice: result.xero_invoice || null,
              event: event,
              guestInfo: null,
              attendees: savedPayload.attendees || attendees,
              ticketsRequired: savedPayload.ticketsRequired || attendees.length,
              totalCost: savedPayload.totalCost || totalCost,
              ticketClassName: savedPayload.ticketClassName || selectedTicketClass?.name || 'Standard',
              ticketClassPrice: savedPayload.ticketClassPrice || ticketPrice,
              pricingDetails: savedPayload.pricingDetails || oneOffCostDetails
            });
            if (isPending) {
              toast.success("Booking submitted! Your registration is pending payment confirmation.");
            } else {
              toast.success("Registration confirmed!");
            }
            onComplexBookingComplete?.();
          } else {
            toast.error(result.error || 'Failed to complete booking after payment');
          }
        } else {
          const response = await base44.functions.invoke('createOneOffEventBooking', savedPayload);
          console.log('[PaymentOptions] 3D Secure booking response:', JSON.stringify(response.data));
          
          if (response.data.success) {
            sessionStorage.removeItem(savedPayloadKey);
            sessionStorage.removeItem(`event_registration_${event.id}`);
            
            if (refreshOrganizationInfo && !isGuestCheckout) {
              refreshOrganizationInfo();
            }
            
            const alreadyMsg = response.data.already_processed ? ' (previously confirmed)' : '';
            toast.success(`Booking confirmed${alreadyMsg}!`);
            
            if (isGuestCheckout || savedPayload.isGuestBooking) {
              setBookingConfirmation({
                bookingReference: response.data.booking_reference,
                bookings: response.data.bookings || [],
                paymentDetails: response.data.payment_details,
                xeroInvoice: response.data.xero_invoice,
                groupBooking: response.data.group_booking || null,
                event: event,
                guestInfo: savedPayload.guestInfo || guestInfo,
                attendees: savedPayload.attendees || attendees.filter(a => a.isValid),
                ticketsRequired: savedPayload.ticketsRequired || ticketsRequired,
                totalCost: savedPayload.totalCost || totalCost,
                ticketClassName: savedPayload.ticketClassName || selectedTicketClass?.name || 'Standard',
                ticketClassPrice: savedPayload.ticketClassPrice || ticketPrice,
                pricingDetails: savedPayload.pricingDetails || oneOffCostDetails
              });
            } else {
              setTimeout(() => {
                window.location.href = createPageUrl('Bookings');
              }, 1500);
            }
          } else {
            toast.error(response.data.error || 'Failed to complete booking after payment');
          }
        }
      } catch (error) {
        console.error('[PaymentOptions] Error completing booking after 3D Secure:', error);
        sessionStorage.removeItem(savedPayloadKey);
        toast.error('Failed to complete your booking. Your payment was successful - please contact support to confirm your registration.');
      } finally {
        setCompletingPayment(false);
      }
    };
    
    completeBookingAfterRedirect();
  }, [event?.id, paymentReturnHandled, isGuestCheckout, refreshOrganizationInfo, isComplexEvent, complexEventApi, onComplexBookingComplete]);

  // Fetch vouchers for one-off events
  const { data: vouchers = [] } = useQuery({
    queryKey: ['vouchers', organizationInfo?.id],
    queryFn: async () => {
      if (!organizationInfo?.id) return [];
      // Fetch from Voucher entity (not ProgramTicketTransaction)
      const allVouchers = await base44.entities.Voucher.list() || [];
      const now = new Date();
      return allVouchers.filter(v => 
        v.organization_id === organizationInfo.id && 
        v.status === 'active' &&
        (v.value || 0) > 0 &&
        // Exclude expired vouchers
        (!v.expires_at || new Date(v.expires_at) > now)
      );
    },
    enabled: isOneOffEvent && !!organizationInfo?.id
  });

  const ticketsRequired = isComplexEvent 
    ? attendees.length 
    : (registrationMode === 'links' ? numberOfLinks : attendees.filter(a => a.isValid).length);

  // Get available program tickets for this specific event's program
  const availableProgramTickets = event.program_tag && organizationInfo?.program_ticket_balances 
    ? (organizationInfo.program_ticket_balances[event.program_tag] || 0)
    : 0;

  // Check if we have enough tickets (for program events)
  const hasEnoughTickets = isOneOffEvent ? true : availableProgramTickets >= ticketsRequired;

  const trainingFundAllowedRoles = organizationInfo?.training_fund_allowed_role_ids || [];
  const voucherAllowedRoles = organizationInfo?.voucher_allowed_role_ids || [];
  const memberRoleId = memberInfo?.role_id;
  const isTrainingFundRoleAllowed = trainingFundAllowedRoles.length === 0 || (memberRoleId && trainingFundAllowedRoles.includes(memberRoleId));
  const isVoucherRoleAllowed = voucherAllowedRoles.length === 0 || (memberRoleId && voucherAllowedRoles.includes(memberRoleId));

  // For one-off events: apply discount code FIRST against the base totalCost,
  // then cap vouchers and training fund against the discounted remainder.
  // This matches the complex-event flow (discount on base ticket price first).
  // For complex events this branch isn't used for payment math (handled elsewhere),
  // but we keep the same calculation so the displayed remainingBalance is consistent.
  const discountCodeSavings = appliedDiscount
    ? (appliedDiscount.discount_type === 'percentage'
      ? Math.min((totalCost * appliedDiscount.discount_value) / 100, totalCost)
      : Math.min(appliedDiscount.discount_value, totalCost))
    : 0;

  const costAfterDiscount = Math.max(0, totalCost - discountCodeSavings);

  // Calculate voucher amount from selected vouchers - capped at (costAfterDiscount - trainingFundAmount)
  // This ensures vouchers only cover the remaining cost after discount and training fund are applied
  const voucherAmountRaw = selectedVouchers.reduce((sum, voucherId) => {
    const voucher = vouchers.find((v) => v.id === voucherId);
    return sum + (voucher?.value || 0);
  }, 0);
  const voucherAmount = (isFeatureExcluded('element_EventUseVouchers') || !isVoucherRoleAllowed)
    ? 0
    : Math.max(0, Math.min(voucherAmountRaw, costAfterDiscount - trainingFundAmount));

  // Max available for training fund - capped at (costAfterDiscount - voucherAmount)
  const maxTrainingFund = (isFeatureExcluded('element_EventUseTrainingFund') || !isTrainingFundRoleAllowed) ? 0 : Math.max(0, Math.min(
    organizationInfo?.training_fund_balance || 0,
    costAfterDiscount - voucherAmount
  ));

  // Calculate remaining balance automatically (discount applied before vouchers/TF)
  const remainingBalance = Math.max(0, costAfterDiscount - voucherAmount - trainingFundAmount);

  // Clamp trainingFundAmount down whenever the cap shrinks (e.g. user applies
  // a discount code or selects vouchers that reduce the post-discount ceiling),
  // so the UI state never exceeds the enforceable maximum.
  useEffect(() => {
    if (trainingFundAmount > maxTrainingFund) {
      setTrainingFundAmount(maxTrainingFund);
    }
  }, [maxTrainingFund, trainingFundAmount]);

  // Handle payment allocation changes
  const handleTrainingFundChange = (value) => {
    const numValue = Math.max(0, Math.min(maxTrainingFund, parseFloat(value) || 0));
    setTrainingFundAmount(numValue);
  };

  // Handle discount code application
  const handleApplyDiscount = async () => {
    if (!discountCodeInput.trim()) {
      toast.error('Please enter a discount code');
      return;
    }

    setApplyingDiscount(true);

    try {
      if (isComplexEvent && complexEventApi?.validateDiscountCode) {
        const result = await complexEventApi.validateDiscountCode({
          code: discountCodeInput.trim().toUpperCase(),
          event_id: event?.id,
          ticket_class_id: selectedTicketClass?.id,
          attendee_count: ticketsRequired
        });
        if (result.valid) {
          setAppliedDiscount({
            ...result,
            code: discountCodeInput.trim().toUpperCase()
          });
          toast.success(`Discount code applied! You save £${result.discount_amount.toFixed(2)}`);
        } else {
          toast.error(result.error || result.reason || 'Invalid discount code');
          setAppliedDiscount(null);
        }
      } else {
        const response = await base44.functions.invoke('applyDiscountCode', {
          code: discountCodeInput.trim().toUpperCase(),
          eventId: event?.id,
          memberEmail: memberInfo?.email || guestInfo?.email,
          amount: totalCost,
          ticketClassId: selectedTicketClass?.id
        });

        if (response.data.valid) {
          setAppliedDiscount({
            ...response.data,
            code: discountCodeInput.trim().toUpperCase()
          });
          toast.success(`Discount code applied! You save £${response.data.discount_amount.toFixed(2)}`);
        } else {
          toast.error(response.data.error || 'Invalid discount code');
          setAppliedDiscount(null);
        }
      }
    } catch (error) {
      console.error('Error applying discount:', error);
      const errorMessage = error.response?.data?.error || error.message || 'Invalid discount code';
      toast.error(errorMessage);
      setAppliedDiscount(null);
    } finally {
      setApplyingDiscount(false);
    }
  };

  const handleRemoveDiscount = () => {
    setAppliedDiscount(null);
    setDiscountCodeInput("");
    toast.info('Discount code removed');
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

    doSetSubmitting(true);

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
      doSetSubmitting(false);
    }
  };

  const handleOneOffBooking = async () => {
    console.log('[PaymentOptions] handleOneOffBooking called', {
      isGuestCheckout,
      isComplexEvent,
      ticketsRequired,
      totalCost,
      remainingBalance,
      remainingBalancePaymentMethod,
      attendeesCount: attendees?.length
    });

    if (isComplexEvent) {
      if (ticketsRequired === 0) {
        toast.error("Please add at least one attendee");
        return;
      }
    } else {
      if (isGuestCheckout && checkGuestEmailIsMember) {
        const isMember = await checkGuestEmailIsMember();
        if (isMember) return;
      }

      if (!isGuestCheckout) {
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
    }

    const paymentEmail = isComplexEvent 
      ? (attendees[0]?.email || memberInfo?.email)
      : (isGuestCheckout ? guestInfo?.email : memberInfo?.email);

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

      await proceedToStripePayment(paymentEmail);
      return;
    }

    // If paying by account and user indicated they have a PO number, require it
    if (remainingBalance > 0 && remainingBalancePaymentMethod === 'account' && !purchaseOrderNumber.trim() && !poSupplyLater) {
      toast.error("Please enter a purchase order number");
      return;
    }

    // Process the booking (for free events or when payment is fully covered)
    console.log('[PaymentOptions] Processing booking directly (no Stripe needed)', { remainingBalance, totalCost });
    await processOneOffBooking();
  };

  const proceedToStripePayment = async (paymentEmail) => {
    const chargeAmount = remainingBalance;
    console.log('[PaymentOptions] Creating Stripe payment intent for amount:', chargeAmount);
    doSetSubmitting(true);
    try {
      let clientSecret, paymentIntentId;

      if (isComplexEvent && complexEventApi) {
        const piPayload = {
          event_id: event.id,
          ticket_class_id: selectedTicketClass?.id,
          attendee_count: ticketsRequired
        };
        if (appliedDiscount?.code) {
          piPayload.discount_code = appliedDiscount.code;
        }
        let piResponse;
        try {
          piResponse = await complexEventApi.createPaymentIntent(piPayload);
        } catch (piError) {
          const errMsg = piError?.message || piError?.error || '';
          if (errMsg.includes('zero') || errMsg.includes('free registration')) {
            console.log('[PaymentOptions] Discount reduced total to zero, routing to free booking');
            await processOneOffBooking(null, false);
            return;
          }
          throw piError;
        }
        if (!piResponse.clientSecret || !piResponse.publishableKey) {
          const errMsg = piResponse?.error || '';
          if (errMsg.includes('zero') || errMsg.includes('free registration')) {
            console.log('[PaymentOptions] Discount reduced total to zero, routing to free booking');
            await processOneOffBooking(null, false);
            return;
          }
          toast.error("Unable to initialize card payment. Please try again.");
          return;
        }
        stripePromise = loadStripe(piResponse.publishableKey);
        clientSecret = piResponse.clientSecret;
        const piMatch = piResponse.clientSecret?.match(/^(pi_[^_]+)/);
        paymentIntentId = piMatch ? piMatch[1] : null;
      } else {
        const attendeeEmails = isGuestCheckout 
          ? (guestInfo?.email ? [guestInfo.email] : [])
          : attendees.filter(a => a.isValid).map(a => a.email).filter(Boolean);
        
        const response = await base44.functions.invoke('createStripePaymentIntent', {
          amount: chargeAmount,
          currency: 'gbp',
          memberEmail: paymentEmail,
          metadata: {
            event_id: event.id,
            event_title: (event.title || '').substring(0, 200),
            organization_id: organizationInfo?.id || null,
            booking_type: isGuestCheckout ? 'guest_one_off_event' : 'one_off_event',
            is_guest: isGuestCheckout ? 'true' : 'false',
            attendee_emails: attendeeEmails.slice(0, 5).join(',').substring(0, 450),
            ticket_class: selectedTicketClass?.name || 'default',
            tickets_required: String(ticketsRequired),
            member_email: paymentEmail
          }
        });

        console.log('[PaymentOptions] Stripe payment intent response:', response.data);
        if (!response.data.success) {
          toast.error("Failed to initialize payment: " + (response.data.error || "Unknown error"));
          return;
        }
        clientSecret = response.data.clientSecret;
        paymentIntentId = response.data.paymentIntentId;
      }

      setStripeClientSecret(clientSecret);
      setStripePaymentIntentId(paymentIntentId);
      
      const validAttendees = isComplexEvent 
        ? attendees 
        : attendees.filter(a => a.isValid);
      const savedPayload = {
        eventId: event.id,
        attendees: validAttendees,
        registrationMode: registrationMode,
        ticketsRequired: ticketsRequired,
        totalCost: totalCost,
        pricingDetails: oneOffCostDetails,
        paymentMethod: remainingBalance > 0 ? (isGuestCheckout ? 'card' : remainingBalancePaymentMethod) : 'fully_covered',
        stripePaymentIntentId: paymentIntentId,
        ticketClassId: selectedTicketClass?.id || null,
        ticketClassName: selectedTicketClass?.name || null,
        ticketClassPrice: ticketPrice,
        isGuestBooking: isGuestCheckout,
        isComplexEvent: isComplexEvent,
        discountCodeId: appliedDiscount?.discount_code_id || null,
        discountCodeAmount: discountCodeSavings || 0,
        thirdPartyConsent: collectThirdPartyConsent ? thirdPartyConsent === true : null,
        complexCartItems: isComplexEvent ? (complexEventApi?._getCartItems?.() || []) : undefined,
      };
      
      if (!isGuestCheckout && !isComplexEvent) {
        savedPayload.memberEmail = memberInfo?.email;
        savedPayload.selectedVoucherIds = (isFeatureExcluded('element_EventUseVouchers') || !isVoucherRoleAllowed) ? [] : selectedVouchers;
        savedPayload.trainingFundAmount = (isFeatureExcluded('element_EventUseTrainingFund') || !isTrainingFundRoleAllowed) ? 0 : trainingFundAmount;
        savedPayload.accountAmount = remainingBalancePaymentMethod === 'account' ? remainingBalance : 0;
        savedPayload.purchaseOrderNumber = remainingBalancePaymentMethod === 'account' ? purchaseOrderNumber.trim() : null;
        savedPayload.poToFollow = remainingBalancePaymentMethod === 'account' ? poSupplyLater : false;
      } else if (isGuestCheckout) {
        savedPayload.guestInfo = {
          first_name: guestInfo.first_name,
          last_name: guestInfo.last_name,
          email: guestInfo.email,
          organization: guestInfo.organization,
          phone: guestInfo.phone || null,
          job_title: guestInfo.job_title || null
        };
      }
      
      const savedPayloadKey = `pending_booking_payload_${event.id}`;
      sessionStorage.setItem(savedPayloadKey, JSON.stringify(savedPayload));
      console.log('[PaymentOptions] Saved booking payload to sessionStorage for 3D Secure recovery');
      
      setShowStripeModal(true);
    } catch (error) {
      console.error("[PaymentOptions] Error creating Stripe Payment Intent:", error);
      toast.error("Failed to initialize payment");
    } finally {
      doSetSubmitting(false);
    }
  };


  const processOneOffBooking = async (stripePaymentId = null, testMode = false) => {
    console.log('[PaymentOptions] processOneOffBooking started');
    doSetSubmitting(true);

    try {
      if (isComplexEvent && complexEventApi) {
        const complexPayload = {
          event_id: event.id,
          attendees: attendees.map(a => ({
            email: (a.email || '').toLowerCase().trim(),
            first_name: (a.first_name || '').trim(),
            last_name: (a.last_name || '').trim(),
            organization: (a.organization || '').trim(),
            phone: (a.phone || '').trim(),
            job_title: (a.job_title || '').trim()
          })),
          ticket_class_id: selectedTicketClass?.id || null,
          payment_method: remainingBalance > 0 ? remainingBalancePaymentMethod : 'free',
        };
        if (stripePaymentId) {
          complexPayload.stripe_payment_intent_id = stripePaymentId;
          complexPayload.payment_method = 'card';
        }
        if (appliedDiscount?.code) {
          complexPayload.discount_code = appliedDiscount.code;
        }
        if (collectThirdPartyConsent) {
          complexPayload.third_party_consent = thirdPartyConsent === true;
        }

        const result = await complexEventApi.submitBooking(complexPayload);

        if (result.success) {
          const isPending = result.bookings?.some(b => b.status === 'pending');
          setBookingConfirmation({
            bookingReference: result.booking_group_reference || result.booking_reference,
            bookings: result.bookings || [],
            paymentDetails: result.payment_details || null,
            xeroInvoice: result.xero_invoice || null,
            event: event,
            guestInfo: null,
            attendees: attendees,
            ticketsRequired: attendees.length,
            totalCost: totalCost,
            ticketClassName: selectedTicketClass?.name || 'Standard',
            ticketClassPrice: ticketPrice,
            pricingDetails: oneOffCostDetails
          });
          if (isPending) {
            toast.success("Booking submitted! Your registration is pending payment confirmation.");
          } else {
            toast.success("Registration confirmed!");
          }
          onComplexBookingComplete?.();
        } else {
          toast.error(result.error || "Failed to complete booking");
        }
      } else {
        console.log('[PaymentOptions] All attendees before filter:', JSON.stringify(attendees));
        const validAttendees = attendees.filter(a => a.isValid);
        console.log('[PaymentOptions] Valid attendees after filter:', JSON.stringify(validAttendees));
        
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
          ticketClassPrice: ticketPrice,
          isGuestBooking: isGuestCheckout,
          discountCodeId: appliedDiscount?.discount_code_id || null,
          discountCodeAmount: discountCodeSavings || 0,
          thirdPartyConsent: collectThirdPartyConsent ? thirdPartyConsent === true : null,
          _testMode: testMode
        };

        if (!isGuestCheckout) {
          bookingPayload.memberEmail = memberInfo.email;
          bookingPayload.selectedVoucherIds = (isFeatureExcluded('element_EventUseVouchers') || !isVoucherRoleAllowed) ? [] : selectedVouchers;
          bookingPayload.trainingFundAmount = (isFeatureExcluded('element_EventUseTrainingFund') || !isTrainingFundRoleAllowed) ? 0 : trainingFundAmount;
          bookingPayload.accountAmount = remainingBalancePaymentMethod === 'account' ? remainingBalance : 0;
          bookingPayload.purchaseOrderNumber = remainingBalancePaymentMethod === 'account' ? purchaseOrderNumber.trim() : null;
          bookingPayload.poToFollow = remainingBalancePaymentMethod === 'account' ? poSupplyLater : false;
        } else {
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
          
          if (isGuestCheckout) {
            setBookingConfirmation({
              bookingReference: response.data.booking_reference,
              bookings: response.data.bookings || [],
              paymentDetails: response.data.payment_details,
              xeroInvoice: response.data.xero_invoice,
              groupBooking: response.data.group_booking || null,
              event: event,
              guestInfo: guestInfo,
              attendees: attendees.filter(a => a.isValid),
              ticketsRequired: ticketsRequired,
              totalCost: totalCost,
              ticketClassName: selectedTicketClass?.name || 'Standard',
              ticketClassPrice: ticketPrice,
              pricingDetails: oneOffCostDetails
            });
            toast.success("Booking confirmed!");
          } else {
            toast.success("Booking confirmed!");
            setTimeout(() => {
              window.location.href = createPageUrl('Bookings');
            }, 1500);
          }
        } else {
          toast.error(response.data.error || "Failed to create booking");
        }
      }
    } catch (error) {
      console.error("Booking error:", error);
      const errMsg = error.message || "Failed to create booking";
      const errorData = error.errorData || null;
      const errText = ((errorData?.error || '') + ' ' + (errorData?.message || '')).toLowerCase();
      const isDuplicateError = isComplexEvent && error.status === 409 && errorData && 
        (Array.isArray(errorData.duplicates) || 
         errText.includes('duplicate') || errText.includes('already registered'));
      if (isDuplicateError) {
        const dupes = errorData.duplicates || [];
        if (dupes.length > 0) {
          setDuplicateAttendees(dupes.map(email => ({ email, name: email })));
        } else {
          const emailMatch = (errorData.message || '').match(/already registered:\s*(.+)/i) ||
                             (errorData.message || '').match(/^(.+?)\s+is already registered/i);
          const parsedEmails = emailMatch ? emailMatch[1].split(',').map(e => e.trim()) : [];
          setDuplicateAttendees(parsedEmails.length > 0 
            ? parsedEmails.map(email => ({ email, name: email }))
            : [{ email: 'unknown', name: 'An attendee' }]);
        }
        setShowDuplicateWarning(true);
      } else {
        toast.error(errMsg);
      }
    } finally {
      doSetSubmitting(false);
    }
  };

  // Handle Stripe payment success (non-redirect flow)
  const handleStripePaymentSuccess = async () => {
    setShowStripeModal(false);
    // Clean up saved payload since we're completing normally (no redirect needed)
    const savedPayloadKey = `pending_booking_payload_${event.id}`;
    sessionStorage.removeItem(savedPayloadKey);
    await processOneOffBooking(stripePaymentIntentId);
  };

  // Check for duplicate registrations before proceeding
  const checkForDuplicates = async () => {
    if (isComplexEvent) {
      return { hasDuplicates: false, duplicates: [] };
    }
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
    
    if (isComplexEvent || isOneOffEvent) {
      handleOneOffBooking();
    } else {
      handleProgramBooking();
    }
  };

  const renderOneOffPricing = () => {
    if ((!isOneOffEvent && !isComplexEvent) || !oneOffCostDetails) return null;

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
              <span className="text-blue-700 flex items-center gap-1">
                Ticket Price:
                {getEffectiveTicketPrice(selectedTicketClass).isEarlyBird && (
                  <span className="text-amber-700 text-xs font-medium">(Early Bird)</span>
                )}
              </span>
              <span className="flex items-center gap-2">
                {getEffectiveTicketPrice(selectedTicketClass).isEarlyBird && (
                  <span className="text-xs text-slate-400 line-through">£{(Number(selectedTicketClass?.price) || 0).toFixed(2)}</span>
                )}
                <span className="font-bold text-blue-900">£{ticketPrice.toFixed(2)}</span>
              </span>
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

            {discountCodeSavings > 0 && (
              <div className="flex items-center justify-between text-sm text-purple-700">
                <span className="flex items-center gap-1">
                  <Tag className="w-3 h-3" />
                  Discount Code ({appliedDiscount?.code}):
                </span>
                <span className="font-bold">-£{discountCodeSavings.toFixed(2)}</span>
              </div>
            )}
            
            <div className="flex items-center justify-between text-sm pt-2 border-t border-blue-200">
              <span className="text-blue-700 font-medium">Total Cost:</span>
              <span className="font-bold text-lg text-blue-900">£{(totalCost - discountCodeSavings).toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Payment Options */}
        {totalCost > 0 && ticketsRequired > 0 && (
          <div className="space-y-4">
            {/* Live updates indicator */}
            {realtimeConnected && memberInfo && (
              <div className="flex items-center gap-1.5 text-xs text-green-600" title="Live balance updates enabled">
                <Wifi className="w-3 h-3" />
                <span>Live balance updates</span>
              </div>
            )}
            
            {/* Vouchers - only for logged-in members (not supported for complex events due to split payment limitations) */}
            {memberInfo && !isComplexEvent && !isFeatureExcluded('element_EventUseVouchers') && isVoucherRoleAllowed && (
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
                      maxAmount={costAfterDiscount}
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

            {/* Training Fund - only for logged-in members (not supported for complex events due to split payment limitations) */}
            {memberInfo && !isComplexEvent && !isFeatureExcluded('element_EventUseTrainingFund') && isTrainingFundRoleAllowed && (
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

            {/* Discount Code Section - for complex events, per-ticket discounts are handled in the cart ticket cards */}
            {!isComplexEvent && !isFeatureExcluded('element_EventDiscountCode') && (
              <div id="discount-code-section" className="p-4 rounded-lg border border-slate-200 bg-purple-50">
                <div className="flex items-center gap-2 mb-3">
                  <Tag className="w-4 h-4 text-purple-600" />
                  <Label className="text-sm font-medium">Discount Code</Label>
                </div>
                {appliedDiscount ? (
                  <div className="p-3 bg-green-100 border border-green-200 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-green-600" />
                        <div>
                          <p className="text-sm font-medium text-green-900">{appliedDiscount.code}</p>
                          <p className="text-xs text-green-700">
                            {appliedDiscount.discount_type === 'percentage' 
                              ? `${appliedDiscount.discount_value}% off` 
                              : `£${appliedDiscount.discount_value} off`}
                            {' '}— Saving £{discountCodeSavings.toFixed(2)}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleRemoveDiscount}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        data-testid="button-remove-discount"
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Input
                      placeholder="Enter discount code"
                      value={discountCodeInput}
                      onChange={(e) => setDiscountCodeInput(e.target.value.toUpperCase())}
                      className="flex-1"
                      onKeyDown={(e) => e.key === 'Enter' && handleApplyDiscount()}
                      data-testid="input-discount-code"
                    />
                    <Button
                      onClick={handleApplyDiscount}
                      disabled={applyingDiscount || !discountCodeInput.trim()}
                      variant="outline"
                      data-testid="button-apply-discount"
                    >
                      {applyingDiscount ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        'Apply'
                      )}
                    </Button>
                  </div>
                )}
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

                {!memberInfo ? (
                  <div className="flex items-start space-x-3 p-3 rounded-lg border-2 border-indigo-500 bg-white">
                    <CreditCard className="w-5 h-5 text-indigo-600 mt-0.5" />
                    <div className="flex-1">
                      <Label className="text-sm font-medium">Pay by Credit/Debit Card</Label>
                      {stripeAvailable ? (
                        <p className="text-xs text-slate-500 mt-1">Secure payment via Stripe</p>
                      ) : (
                        <p className="text-xs text-amber-700 mt-1">Card payments not currently available</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <RadioGroup value={remainingBalancePaymentMethod} onValueChange={setRemainingBalancePaymentMethod}>
                    <div className="space-y-3">
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
                            <p className="text-xs text-amber-700 mt-1">Card payments not currently available</p>
                          )}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div
                          className="flex items-start space-x-3 p-3 rounded-lg border-2 transition-colors cursor-pointer hover:bg-slate-100"
                          style={{ borderColor: remainingBalancePaymentMethod === 'account' ? '#6366f1' : '#e2e8f0' }}
                          onClick={() => setRemainingBalancePaymentMethod('account')}
                        >
                          <RadioGroupItem value="account" id="account" className="mt-1" />
                          <div className="flex-1">
                            <Label htmlFor="account" className="text-sm font-medium cursor-pointer">Charge to Organisation Account</Label>
                          </div>
                        </div>

                        {remainingBalancePaymentMethod === 'account' && (
                          <div className="space-y-3 mt-2">
                            <div className="flex items-center space-x-2">
                              <Switch
                                id="po-have-number"
                                checked={!poSupplyLater}
                                onCheckedChange={(checked) => {
                                  setPoSupplyLater(!checked);
                                  if (!checked) {
                                    setPurchaseOrderNumber('');
                                  }
                                }}
                                data-testid="switch-po-have-number"
                              />
                              <Label htmlFor="po-have-number" className="text-sm cursor-pointer">
                                I have a PO number
                              </Label>
                            </div>
                            {!poSupplyLater && (
                              <Input
                                placeholder="Purchase Order Number *"
                                value={purchaseOrderNumber}
                                onChange={(e) => setPurchaseOrderNumber(e.target.value)}
                                className="w-full"
                                data-testid="input-purchase-order"
                              />
                            )}
                          </div>
                        )}
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
                  <AlertCircle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
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
              <AlertCircle className="w-5 h-5 text-amber-700 shrink-0" />
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
  // Also require terms acceptance if terms exist
  const termsRequirementMet = !hasBookingTerms || termsAccepted;
  const canProceed = !isSoldOut && !isRegistrationClosed && !hasAttendeesWithMissingNames && termsRequirementMet && (
    (isComplexEvent || isOneOffEvent)
      ? (ticketsRequired > 0 && !isSubmitting && (totalCost === 0 || isFullyPaid) && !noTicketsForRole)
      : (hasEnoughTickets && event.program_tag && !isSubmitting && ticketsRequired > 0)
  );

  // Notify parent component of canProceed state changes
  useEffect(() => {
    if (onCanProceedChange) {
      onCanProceedChange(canProceed);
    }
  }, [canProceed, onCanProceedChange]);

  if (completingPayment) {
    const completingContent = (
      <div className="flex flex-col items-center justify-center py-8 space-y-4">
        <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
        <p className="text-sm text-slate-600 text-center">
          Your payment has been verified. We're confirming your booking now...
        </p>
      </div>
    );
    if (!renderAsCard) return completingContent;
    return (
      <Card className="border-slate-200 shadow-lg sticky top-8">
        <CardHeader className="border-b border-slate-200">
          <CardTitle className="text-xl">Completing Your Booking</CardTitle>
        </CardHeader>
        <CardContent className="pt-6">{completingContent}</CardContent>
      </Card>
    );
  }

  const confirmationModal = (() => {
    if (!bookingConfirmation) return null;
    const conf = bookingConfirmation;
    const eventDate = conf.event?.date ? new Date(conf.event.date).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }) : null;
    const eventTime = conf.event?.start_time || null;
    const paymentAmount = conf.paymentDetails?.card_amount || conf.paymentDetails?.account_amount || 0;
    const donationEnabled = event?.donation_config?.enabled === true;

    return (
      <Dialog open={!!bookingConfirmation} onOpenChange={(open) => { if (!open) setBookingConfirmation(null); }}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="sr-only">Booking Confirmed</DialogTitle>
            <DialogDescription className="sr-only">Your booking confirmation details</DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-2">
            <div className="text-center space-y-3">
              <div className="flex justify-center">
                <div className="p-3 rounded-full bg-green-100">
                  <CheckCircle2 className="w-10 h-10 text-green-600" />
                </div>
              </div>
              <h2 className="text-xl font-semibold" data-testid="text-booking-confirmed">
                Booking Confirmed
              </h2>
              <p className="text-sm text-muted-foreground">
                Your booking has been confirmed. A confirmation email will be sent to you shortly.
              </p>
            </div>

            {donationEnabled && (
              <InlineDonationSection
                donationConfig={event.donation_config}
                event={event}
                paymentEmail={isGuestCheckout ? guestInfo?.email : memberInfo?.email}
                bookingReference={conf.bookingReference}
                stripeReady={stripeAvailable}
              />
            )}

            <div className="p-4 rounded-md border bg-muted/30 space-y-3">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">Reference</span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-semibold" data-testid="text-booking-reference">{conf.bookingReference}</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(conf.bookingReference);
                      toast.success('Reference copied');
                    }}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid="button-copy-reference"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">Event</span>
                <span className="font-medium text-right" data-testid="text-event-name">{conf.event?.title}</span>
              </div>

              {eventDate && (
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground flex items-center gap-1"><Calendar className="w-3.5 h-3.5" /> Date</span>
                  <span className="font-medium">{eventDate}{eventTime ? ` at ${eventTime}` : ''}</span>
                </div>
              )}

              {conf.event?.location && (
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> Location</span>
                  <span className="font-medium text-right">{conf.event.location}</span>
                </div>
              )}
            </div>

            {conf.totalCost > 0 && (
              <div className="p-4 rounded-md border space-y-2">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <PoundSterling className="w-4 h-4" />
                  Payment Summary
                </h3>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {conf.ticketsRequired} x {conf.ticketClassName}
                    {conf.ticketClassPrice > 0 ? ` @ ${'\u00a3'}${Number(conf.ticketClassPrice).toFixed(2)}` : ''}
                  </span>
                  <span className="font-medium">{'\u00a3'}{(conf.ticketsRequired * (conf.ticketClassPrice || 0)).toFixed(2)}</span>
                </div>
                {conf.pricingDetails?.freeTickets > 0 && (
                  <div className="flex items-center justify-between text-sm text-green-700">
                    <span>{conf.pricingDetails.discountDescription || `${conf.pricingDetails.freeTickets} free ticket(s)`}</span>
                    <span>-{'\u00a3'}{(conf.pricingDetails.freeTickets * (conf.ticketClassPrice || 0)).toFixed(2)}</span>
                  </div>
                )}
                {conf.pricingDetails?.discount > 0 && (
                  <div className="flex items-center justify-between text-sm text-green-700">
                    <span>{conf.pricingDetails.discountDescription || 'Discount'}</span>
                    <span>-{'\u00a3'}{conf.pricingDetails.discount.toFixed(2)}</span>
                  </div>
                )}
                {conf.paymentDetails?.voucher_amount > 0 && (
                  <div className="flex items-center justify-between text-sm text-green-700">
                    <span>Voucher applied</span>
                    <span>-{'\u00a3'}{conf.paymentDetails.voucher_amount.toFixed(2)}</span>
                  </div>
                )}
                {conf.paymentDetails?.training_fund_amount > 0 && (
                  <div className="flex items-center justify-between text-sm text-green-700">
                    <span>Training fund applied</span>
                    <span>-{'\u00a3'}{conf.paymentDetails.training_fund_amount.toFixed(2)}</span>
                  </div>
                )}
                {conf.paymentDetails?.discount_code_amount > 0 && (
                  <div className="flex items-center justify-between text-sm text-green-700">
                    <span>Discount code applied</span>
                    <span>-{'\u00a3'}{conf.paymentDetails.discount_code_amount.toFixed(2)}</span>
                  </div>
                )}
                {paymentAmount > 0 && (
                  <div className="flex items-center justify-between text-sm pt-2 border-t font-semibold">
                    <span>Paid by card</span>
                    <span>{'\u00a3'}{paymentAmount.toFixed(2)}</span>
                  </div>
                )}
                {conf.xeroInvoice?.invoice_number && (
                  <div className="flex items-center justify-between text-sm pt-1 text-muted-foreground">
                    <span>Invoice</span>
                    <span>{conf.xeroInvoice.invoice_number}</span>
                  </div>
                )}
              </div>
            )}

            {conf.groupBooking && (
              <div className="p-4 rounded-md border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950 space-y-3">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Group Booking
                </h3>
                <p className="text-sm text-muted-foreground">
                  You have {conf.groupBooking.group_size} places to fill. Use the link below to add your participants:
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => window.open(conf.groupBooking.group_url, '_blank')}
                  data-testid="button-manage-group"
                >
                  <Users className="w-4 h-4 mr-2" />
                  Manage Your Group
                </Button>
                <button
                  className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
                  onClick={() => {
                    navigator.clipboard.writeText(conf.groupBooking.group_url);
                    toast.success('Group link copied');
                  }}
                  data-testid="button-copy-group-link"
                >
                  Copy link to clipboard
                </button>
                {conf.groupBooking.cutoff_date && (
                  <p className="text-xs text-muted-foreground text-center">
                    Add participants before {new Date(conf.groupBooking.cutoff_date).toLocaleDateString('en-GB', { dateStyle: 'long' })}
                  </p>
                )}
              </div>
            )}

            <Button
              onClick={() => window.location.href = createPageUrl('Events')}
              className="w-full"
              size="lg"
              data-testid="button-back-to-events"
            >
              Back to Events <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  })();

  const mainContent = (
    <>
      {(isOneOffEvent || isComplexEvent) ? renderOneOffPricing() : renderProgramEventDisplay()}

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

          {/* Member only event message for unauthenticated users with no public tickets */}
          {isGuestCheckout && noTicketsForRole ? (
            <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-md">
              <Lock className="h-4 w-4 text-blue-600 shrink-0" />
              <span className="text-sm text-blue-800 font-medium">Member only event</span>
            </div>
          ) : (
            <>
              {/* Terms and Conditions Checkbox */}
              {hasBookingTerms && setTermsAccepted && (
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="terms-payment"
                    checked={termsAccepted}
                    onCheckedChange={setTermsAccepted}
                    data-testid="checkbox-terms-payment"
                  />
                  <label 
                    htmlFor="terms-payment" 
                    className="text-sm text-slate-600 leading-tight cursor-pointer"
                  >
                    I agree to the{' '}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        if (onShowTermsModal) onShowTermsModal();
                      }}
                      className="text-blue-600 hover:text-blue-800 underline"
                      data-testid="link-terms-payment"
                    >
                      terms and conditions
                    </button>
                  </label>
                </div>
              )}

              {hasBookingTerms && collectThirdPartyConsent && setThirdPartyConsent && (
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="third-party-consent-payment"
                    checked={thirdPartyConsent}
                    onCheckedChange={(v) => setThirdPartyConsent(v === true)}
                    data-testid="checkbox-third-party-consent-payment"
                  />
                  <label
                    htmlFor="third-party-consent-payment"
                    className="text-sm text-slate-600 leading-tight cursor-pointer"
                  >
                    I consent to my name, organisation, email and job title being shared with relevant third-party suppliers in connection with this event.
                  </label>
                </div>
              )}
            </>
          )}

          {/* Login to register button for unauthenticated users on member-only events */}
          {isGuestCheckout && noTicketsForRole ? (
            <Button
              id="confirm-booking-button"
              onClick={() => {
                const currentPath = window.location.pathname + window.location.search;
                window.location.href = '/login?returnTo=' + encodeURIComponent(currentPath);
              }}
              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
              size="lg"
              data-testid="button-login-to-register"
            >
              <LogIn className="w-5 h-5 mr-2" />
              Login to register
            </Button>
          ) : (
            <Button
              id="confirm-booking-button"
              onClick={handleSubmit}
              disabled={!canProceed || checkingDuplicates || checkingMemberEmail || guestEmailIsMember}
              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
              size="lg"
            >
              {checkingMemberEmail ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Checking...
                </>
              ) : checkingDuplicates ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Checking...
                </>
              ) : isSubmitting ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Processing...
                </>
              ) : isRegistrationClosed ? (
                'Registration Closed'
              ) : isSoldOut ? (
                'Sold Out'
              ) : (isOneOffEvent || isComplexEvent) ? (
                totalCost > 0 ? `Book & Pay £${remainingBalance.toFixed(2)}` : 'Confirm Booking'
              ) : (
                'Confirm Booking'
              )}
            </Button>
          )}

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
    </>
  );

  return (
    <>
      {confirmationModal}
      {renderAsCard ? (
        <Card className="border-slate-200 shadow-lg sticky top-8">
          <CardHeader className="border-b border-slate-200">
            <CardTitle className="text-xl">Booking Summary</CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            {mainContent}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {mainContent}
        </div>
      )}

      {/* Stripe Payment Drawer */}
      <Sheet open={showStripeModal} onOpenChange={setShowStripeModal}>
        <SheetContent side="right" className="w-full sm:max-w-md flex flex-col h-full">
          <SheetHeader className="flex-shrink-0 mb-6">
            <SheetTitle>Enter Payment Details</SheetTitle>
            <SheetDescription>
              Complete your booking by entering your card information below.
            </SheetDescription>
          </SheetHeader>
          
          <div className="flex-1 overflow-y-auto pb-6">
            {stripeClientSecret && stripePromise && (
              <Elements stripe={stripePromise} options={{ clientSecret: stripeClientSecret }}>
                <StripePaymentForm
                  clientSecret={stripeClientSecret}
                  onSuccess={handleStripePaymentSuccess}
                  onCancel={() => {
                    setShowStripeModal(false);
                    setStripeClientSecret(null);
                    setStripePaymentIntentId(null);
                    doSetSubmitting(false);
                    // Clean up saved payload when user cancels
                    const savedPayloadKey = `pending_booking_payload_${event.id}`;
                    sessionStorage.removeItem(savedPayloadKey);
                  }}
                  amount={remainingBalance}
                  returnUrl={window.location.href}
                />
              </Elements>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Duplicate Registration Warning Modal */}
      <Dialog open={showDuplicateWarning} onOpenChange={setShowDuplicateWarning}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
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
                <Users className="w-4 h-4 text-amber-700" />
                <span className="font-medium text-amber-800">Already Registered:</span>
              </div>
              <ul className="space-y-2">
                {duplicateAttendees.map((attendee, index) => (
                  <li key={index} className="flex items-center gap-2 text-sm text-amber-700">
                    <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0"></span>
                    <span className="font-medium">{attendee.name}</span>
                    <span className="text-amber-700">({attendee.email})</span>
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
