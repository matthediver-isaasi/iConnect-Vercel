
import React, { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Ticket, Loader2, ShoppingCart, Wallet, CreditCard, ArrowLeft, AlertCircle, Tag, X, FileText } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import VoucherSelector from "../components/booking/VoucherSelector";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckCircle2 } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useProgramTicketRealtime } from "@/hooks/useProgramTicketRealtime";
import { useMemberAccess } from "@/hooks/useMemberAccess";

// Load Stripe outside component to avoid recreating on every render
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
          return_url: window.location.href // Redirect back to this page after 3D Secure etc.
        },
        redirect: 'if_required' // Handle redirects for 3D Secure or other payment methods
      });

      if (submitError) {
        setError(submitError.message);
        setProcessing(false);
      } else {
        // Payment successful (or requires further action handled by redirect)
        // If redirect: 'if_required' is used, confirmPayment might not resolve directly
        // in a success state on this page, but rather redirect the user.
        // For this flow, we'll assume a success means the user can proceed.
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

      {/* Stripe Payment Element - no special container */}
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
          className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
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

export default function BuyProgramTicketsPage({ 
  memberInfo: propsMemberInfo, 
  organizationInfo: propsOrganizationInfo, 
  refreshOrganizationInfo: propsRefreshOrganizationInfo, 
  isFeatureExcluded: propsIsFeatureExcluded,
  memberRole: propsMemberRole,
  reloadMemberInfo: propsReloadMemberInfo,
}) {
  // Get values from context (preferred) or fall back to props
  const { 
    hasBanner,
    memberInfo: contextMemberInfo,
    organizationInfo: contextOrganizationInfo,
    memberRole: contextMemberRole,
    isFeatureExcluded: contextIsFeatureExcluded,
    refreshOrganizationInfo: contextRefreshOrganizationInfo,
    reloadMemberInfo: contextReloadMemberInfo,
  } = useLayoutContext();

  // Get memberRole from useMemberAccess hook as additional fallback
  const { memberRole: hookMemberRole } = useMemberAccess();
  
  // Use context values if available, otherwise fall back to props, then hook
  const memberInfo = contextMemberInfo || propsMemberInfo;
  const organizationInfo = contextOrganizationInfo || propsOrganizationInfo;
  const memberRole = contextMemberRole || propsMemberRole || hookMemberRole;
  const isFeatureExcluded = contextIsFeatureExcluded || propsIsFeatureExcluded || (() => false);
  const refreshOrganizationInfo = contextRefreshOrganizationInfo || propsRefreshOrganizationInfo || (() => {});
  const reloadMemberInfo = contextReloadMemberInfo || propsReloadMemberInfo || (() => {});
  const [selectedProgram, setSelectedProgram] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Payment allocation state
  const [selectedVouchers, setSelectedVouchers] = useState([]);
  const [trainingFundAmount, setTrainingFundAmount] = useState(0);
  const [remainingBalancePaymentMethod, setRemainingBalancePaymentMethod] = useState('account');

  // Discount code state
  const [discountCodeInput, setDiscountCodeInput] = useState("");
  const [appliedDiscount, setAppliedDiscount] = useState(null);
  const [applyingDiscount, setApplyingDiscount] = useState(false);

  // Success modal state
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [purchaseDetails, setPurchaseDetails] = useState(null);

  // Stripe payment modal state
  const [showStripeModal, setShowStripeModal] = useState(false);
  const [stripeClientSecret, setStripeClientSecret] = useState(null);
  const [stripePaymentIntentId, setStripePaymentIntentId] = useState(null);

  // Tour state - separate tours for list view and form view
  const [showListTour, setShowListTour] = useState(false);
  const [showFormTour, setShowFormTour] = useState(false);
  const [tourAutoShowList, setTourAutoShowList] = useState(false);
  const [tourAutoShowForm, setTourAutoShowForm] = useState(false);
  
  // Add refs to track if tours have been auto-started in this session
  const hasAutoStartedListTour = useRef(false);
  const hasAutoStartedFormTour = useRef(false);
  const hasUpdatedExpiredVouchers = useRef(false);

  const queryClient = useQueryClient();

  // Subscribe to realtime updates for ticket purchases
  // Pass refreshOrganizationInfo to update the Layout context when changes are detected
  useProgramTicketRealtime(organizationInfo?.id, ['vouchers'], refreshOrganizationInfo);

  // Refresh organization info on mount to get latest ticket balances
  useEffect(() => {
    if (refreshOrganizationInfo) {
      console.log('[BuyProgramTickets] Refreshing organization info on mount');
      refreshOrganizationInfo();
    }
  }, []); // Only run on mount

  // Check if tours should be shown for this user's role
  const shouldShowTours = memberInfo && !memberInfo.is_team_member && memberRole && memberRole.show_tours !== false;

  // Initialize Stripe
  useEffect(() => {
    const initStripe = async () => {
      try {
        const response = await base44.functions.invoke('getStripePublishableKey');
        if (response.data.publishableKey) {
          stripePromise = loadStripe(response.data.publishableKey);
        } else {
          console.warn('Stripe publishable key not found in response.');
        }
      } catch (error) {
        console.error('Failed to load Stripe publishable key:', error);
      }
    };
    initStripe();
  }, []);

  // Update expired vouchers - disabled to prevent infinite loop
  // TODO: Re-implement this with proper state management
  // useEffect(() => {
  //   let isMounted = true;
  //   const updateExpiredVouchers = async () => {
  //     try {
  //       console.log('[BuyProgramTickets] Updating expired vouchers...');
  //       const response = await base44.functions.invoke('updateExpiredVouchers');
  //       if (!isMounted) return;
  //       if (response.data.success && response.data.updated_count > 0) {
  //         console.log('[BuyProgramTickets] Updated expired vouchers:', response.data.updated_count);
  //         queryClient.invalidateQueries({ queryKey: ['vouchers'] });
  //       }
  //     } catch (error) {
  //       console.error('[BuyProgramTickets] Failed to update expired vouchers:', error);
  //     }
  //   };
  //   if (memberInfo && organizationInfo) {
  //     updateExpiredVouchers();
  //   }
  //   return () => { isMounted = false; };
  // }, []);

  // Auto-show tours based on member role (simplified to prevent re-render loops)
  useEffect(() => {
    if (!memberInfo || !memberRole || !shouldShowTours) return;
    
    // Only auto-show tour once per component mount
    if (hasAutoStartedListTour.current) return;
    
    const pageToursSeen = memberInfo.page_tours_seen || {};
    if (!pageToursSeen['BuyProgramTickets_list'] && selectedProgram === null) {
      hasAutoStartedListTour.current = true;
      setShowListTour(true);
    }
  }, []); // Empty deps - only run on mount

  // Auto-show form tour when program is selected
  useEffect(() => {
    if (!memberInfo || !memberRole || !shouldShowTours || selectedProgram === null) return;
    
    if (hasAutoStartedFormTour.current) return;
    
    const pageToursSeen = memberInfo.page_tours_seen || {};
    if (!pageToursSeen['BuyProgramTickets_form']) {
      hasAutoStartedFormTour.current = true;
      setShowFormTour(true);
    }
  }, [selectedProgram?.id]);


  // Fetch programs
  const { data: programs = [], isLoading } = useQuery({
    queryKey: ['programs'],
    queryFn: () => base44.entities.Program.filter({ is_active: true }),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch events to show count per program
  const { data: events = [] } = useQuery({
    queryKey: ['events'],
    queryFn: () => base44.entities.Event.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch vouchers to calculate total value of selected ones
  const { data: vouchers = [] } = useQuery({
    queryKey: ['vouchers', organizationInfo?.id],
    queryFn: async () => {
      if (!organizationInfo?.id) return [];
      return await base44.entities.Voucher.filter({
        organization_id: organizationInfo.id,
        status: 'active'
      });
    },
    enabled: !!organizationInfo?.id && !isFeatureExcluded('payment_training_vouchers'), // Only fetch if feature is not excluded
    staleTime: 0,
    refetchOnMount: true,
  });

  // Load saved program purchase data on program selection (only depends on selectedProgram ID)
  useEffect(() => {
    if (!selectedProgram) {
      // Reset all states when no program is selected
      setSelectedVouchers([]);
      setTrainingFundAmount(0);
      setRemainingBalancePaymentMethod('account');
      setPurchaseOrderNumber("");
      setQuantity(1);
      setAppliedDiscount(null);
      setDiscountCodeInput("");
      return;
    }

    // Load saved data for this program
    const savedPurchase = sessionStorage.getItem(`program_purchase_${selectedProgram.id}`);
    if (savedPurchase) {
      try {
        const { selectedVouchers: saved, trainingFund, paymentMethod, po, qty } = JSON.parse(savedPurchase);
        setSelectedVouchers(saved || []);
        setTrainingFundAmount(trainingFund || 0);
        setRemainingBalancePaymentMethod(paymentMethod || 'account');
        setPurchaseOrderNumber(po || "");
        setQuantity(qty || 1);
        setAppliedDiscount(null);
        setDiscountCodeInput("");
      } catch (e) {
        // Invalid saved data, reset to defaults
        setSelectedVouchers([]);
        setTrainingFundAmount(0);
        setRemainingBalancePaymentMethod('account');
        setPurchaseOrderNumber("");
        setQuantity(1);
        setAppliedDiscount(null);
        setDiscountCodeInput("");
      }
    } else {
      // No saved data for this program, initialize defaults
      setSelectedVouchers([]);
      setTrainingFundAmount(0);
      setRemainingBalancePaymentMethod('account');
      setPurchaseOrderNumber("");
      setQuantity(1);
      setAppliedDiscount(null);
      setDiscountCodeInput("");
    }
  }, [selectedProgram?.id]);

  // Save purchase state to sessionStorage (non-blocking side effect)
  useEffect(() => {
    if (!selectedProgram) return;

    const state = {
      selectedVouchers,
      trainingFund: trainingFundAmount,
      paymentMethod: remainingBalancePaymentMethod,
      po: purchaseOrderNumber,
      qty: quantity
    };
    sessionStorage.setItem(`program_purchase_${selectedProgram.id}`, JSON.stringify(state));
  }, [selectedProgram?.id, selectedVouchers, trainingFundAmount, remainingBalancePaymentMethod, purchaseOrderNumber, quantity]);

  // Clear discount when quantity changes
  useEffect(() => {
    if (quantity !== 1 && selectedProgram) {
      setAppliedDiscount(null);
      setDiscountCodeInput("");
    }
  }, [quantity, selectedProgram?.id]);

  const updateMemberTourStatus = async (tourKey) => {
    if (memberInfo && !memberInfo.is_team_member) {
      try {
        const allMembers = await base44.entities.Member.listAll();
        const currentMember = allMembers.find(m => m.email === memberInfo.email);
        
        if (currentMember) {
          const updatedTours = { ...(currentMember.page_tours_seen || {}), [tourKey]: true };
          await base44.entities.Member.update(currentMember.id, {
            page_tours_seen: updatedTours
          });
          
          const updatedMemberInfo = { ...memberInfo, page_tours_seen: updatedTours };
          localStorage.setItem('agcas_member', JSON.stringify(updatedMemberInfo));

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

  const handleListTourComplete = async () => {
    setShowListTour(false);
    setTourAutoShowList(false);
  };

  const handleListTourDismiss = async () => {
    setShowListTour(false);
    setTourAutoShowList(false);
    await updateMemberTourStatus('BuyProgramTickets_list');
  };

  const handleFormTourComplete = async () => {
    setShowFormTour(false);
    setTourAutoShowForm(false);
  };

  const handleFormTourDismiss = async () => {
    setShowFormTour(false);
    setTourAutoShowForm(false);
    await updateMemberTourStatus('BuyProgramTickets_form');
  };

  const handleStartListTour = () => {
    setShowListTour(true);
    setTourAutoShowList(true);
  };

  const handleStartFormTour = () => {
    setShowFormTour(true);
    setTourAutoShowForm(true);
  };

  if (!memberInfo || !organizationInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>);

  }

  const organizationTotalTickets = organizationInfo.program_ticket_balances ?
    Object.values(organizationInfo.program_ticket_balances).reduce((sum, val) => sum + val, 0) :
    0;

  const eventCountByProgram = events.reduce((acc, event) => {
    if (event.program_tag) {
      acc[event.program_tag] = (acc[event.program_tag] || 0) + 1;
    }
    return acc;
  }, {});

  const calculateCost = (program, qty) => {
    const offerType = program.offer_type || "none";
    
    // Determine effective offer type, falling back to legacy fields if 'none'
    let effectiveOfferType = offerType;
    if (offerType === "none") {
      if (program.bogo_buy_quantity && program.bogo_get_free_quantity) {
        effectiveOfferType = "bogo";
      } else if (program.bulk_discount_threshold && program.bulk_discount_percentage) {
        effectiveOfferType = "bulk_discount";
      }
    }
    
    const basePrice = program.program_ticket_price * qty;
    
    if (effectiveOfferType === "bogo") {
      const bogoLogicType = program.bogo_logic_type || 'buy_x_get_y_free';
      
      if (bogoLogicType === 'buy_x_get_y_free') {
        // LEGACY LOGIC: User enters qty to purchase, pays for qty
        if (program.bogo_buy_quantity && program.bogo_get_free_quantity &&
            qty >= program.bogo_buy_quantity) {
          return basePrice;
        }
      } else { // 'enter_total_pay_less'
        // NEW LOGIC: User enters total tickets wanted, pays for fewer
        if (program.bogo_buy_quantity && program.bogo_get_free_quantity &&
            qty >= (program.bogo_buy_quantity + program.bogo_get_free_quantity)) {
          const bogoSetSize = program.bogo_buy_quantity + program.bogo_get_free_quantity;
          const completeBlocks = Math.floor(qty / bogoSetSize);
          const remainingTickets = qty % bogoSetSize;
          
          const ticketsToPay = (completeBlocks * program.bogo_buy_quantity) + remainingTickets;
          return program.program_ticket_price * ticketsToPay;
        }
      }
    } else if (effectiveOfferType === "bulk_discount") {
      // Percentage bulk discount
      if (program.bulk_discount_threshold && program.bulk_discount_percentage &&
          qty >= program.bulk_discount_threshold) {
        const discount = basePrice * (program.bulk_discount_percentage / 100);
        return basePrice - discount;
      }
    }
    
    return basePrice;
  };

  const calculateFreeTickets = (program, qty) => {
    const offerType = program.offer_type || "none";
    
    // Determine effective offer type, falling back to legacy fields if 'none'
    let effectiveOfferType = offerType;
    if (offerType === "none" && program.bogo_buy_quantity && program.bogo_get_free_quantity) {
      effectiveOfferType = "bogo";
    }
    
    if (effectiveOfferType === "bogo") {
      const bogoLogicType = program.bogo_logic_type || 'buy_x_get_y_free';
      
      if (bogoLogicType === 'buy_x_get_y_free') {
        // LEGACY: User enters qty to buy, gets free tickets on top
        if (program.bogo_buy_quantity && program.bogo_get_free_quantity &&
            qty >= program.bogo_buy_quantity) {
          const bogoBlocks = Math.floor(qty / program.bogo_buy_quantity);
          return bogoBlocks * program.bogo_get_free_quantity;
        }
      } else { // bogoLogicType === 'enter_total_pay_less'
        // NEW: User enters total qty, free tickets are built into that total
        if (program.bogo_buy_quantity && program.bogo_get_free_quantity &&
            qty >= (program.bogo_buy_quantity + program.bogo_get_free_quantity)) {
          const bogoSetSize = program.bogo_buy_quantity + program.bogo_get_free_quantity;
          const completeBlocks = Math.floor(qty / bogoSetSize);
          return completeBlocks * program.bogo_get_free_quantity;
        }
      }
    }
    
    return 0;
  };

  const calculateTotalTickets = (program, qty) => {
    const bogoLogicType = program.bogo_logic_type || 'buy_x_get_y_free';
    
    if (bogoLogicType === 'buy_x_get_y_free') {
      // LEGACY: Total = entered qty + free tickets
      return qty + calculateFreeTickets(program, qty);
    } else {
      // NEW: Total = entered qty (it's already the total they want)
      return qty;
    }
  };

  const handleProgramSelect = (program) => {
    setSelectedProgram(program);
    // When a new program is selected, ensure we reset purchase states
    // The useEffect for `selectedProgram` will then load from session storage
    // or initialize if no saved data exists for the new program.
    // Explicitly resetting here to ensure immediate state consistency
    // before the useEffect potentially overrides it.
    setQuantity(1);
    setPurchaseOrderNumber("");
    setSelectedVouchers([]);
    setTrainingFundAmount(0);
    setRemainingBalancePaymentMethod('account');
    setAppliedDiscount(null); // Clear discount when a new program is selected
    setDiscountCodeInput("");
  };

  const totalCostBeforeDiscount = selectedProgram ? calculateCost(selectedProgram, quantity) : 0;
  const totalCost = appliedDiscount ? appliedDiscount.totalCostAfterDiscount : totalCostBeforeDiscount;
  const freeTickets = selectedProgram ? calculateFreeTickets(selectedProgram, quantity) : 0;
  const totalTickets = selectedProgram ? calculateTotalTickets(selectedProgram, quantity) : 0;

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

  const handleApplyDiscount = async () => {
    if (!discountCodeInput.trim()) {
      toast.error('Please enter a discount code');
      return;
    }
    if (!selectedProgram) {
      toast.error('Please select a program first.');
      return;
    }

    setApplyingDiscount(true);

    try {
      const response = await base44.functions.invoke('applyDiscountCode', {
        code: discountCodeInput.trim().toUpperCase(),
        totalCost: totalCostBeforeDiscount,
        programTag: selectedProgram.program_tag,
        memberEmail: memberInfo.email
      });

      if (response.data.success) {
        setAppliedDiscount(response.data);
        toast.success(response.data.message);
      } else {
        toast.error(response.data.error || 'Invalid discount code');
        setAppliedDiscount(null);
      }
    } catch (error) {
      console.error('Error applying discount:', error);
      // Handle error response from function (400/404 status codes)
      const errorMessage = error.response?.data?.error || 'Invalid discount code';
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

  const totalAllocated = voucherAmount + trainingFundAmount + remainingBalance;
  const isFullyPaid = Math.abs(totalAllocated - totalCost) < 0.01;

  const handleStripePaymentSuccess = async () => {
    setShowStripeModal(false);
    setSubmitting(true);

    try {
      const response = await base44.functions.invoke('processProgramTicketPurchase', {
        memberEmail: memberInfo.email,
        programName: selectedProgram.name, // Use name for purchase, tag in metadata etc
        quantity: parseInt(quantity),
        purchaseOrderNumber: null, // No PO for card payments
        selectedVoucherIds: isFeatureExcluded('payment_training_vouchers') ? [] : selectedVouchers,
        trainingFundAmount: isFeatureExcluded('payment_training_fund') ? 0 : trainingFundAmount,
        accountAmount: 0, // No account amount for card payments
        paymentMethod: 'card',
        stripePaymentIntentId: stripePaymentIntentId, // Pass the payment intent ID
        appliedDiscountId: appliedDiscount?.discountId || null
      });

      if (response?.data?.success === true) {
        // Clear saved state for this program
        if (selectedProgram) {
          sessionStorage.removeItem(`program_purchase_${selectedProgram.id}`);
        }

        if (refreshOrganizationInfo) {
          await refreshOrganizationInfo();
        }

        // Store purchase details for modal
        setPurchaseDetails({
          programName: selectedProgram.name,
          // Show total tickets received including free ones in the modal
          quantity: totalTickets,
          totalCost: totalCost,
          isSimulatedPayment: false, // This is a real payment
          paymentMethod: 'card'
        });

        // Show success modal
        setShowSuccessModal(true);

        // Reset form
        setSelectedProgram(null);
        setQuantity(1);
        setPurchaseOrderNumber("");
        setSelectedVouchers([]);
        setTrainingFundAmount(0);
        setRemainingBalancePaymentMethod('account');
        setStripeClientSecret(null); // Clear Stripe state
        setStripePaymentIntentId(null); // Clear Stripe state
        setAppliedDiscount(null); // Clear discount state
        setDiscountCodeInput("");
      } else {
        console.error('[BuyProgramTickets] FAILED - response.data:', response.data);
        toast.error(response.data?.error || "Failed to process purchase");
      }
    } catch (error) {
      console.error('[BuyProgramTickets] CAUGHT ERROR during handleStripePaymentSuccess:', error);
      const errorMsg = error.response?.data?.error || error.message || "Failed to process purchase after card payment";
      toast.error(errorMsg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (quantity === '' || quantity < 1) {
      toast.error("Please enter a valid quantity (at least 1)");
      return;
    }

    if (!isFullyPaid) {
      toast.error("Please allocate the full amount across payment methods");
      return;
    }

    if (remainingBalance > 0 && remainingBalancePaymentMethod === 'account' && !purchaseOrderNumber.trim()) {
      toast.error("Please enter a purchase order number for account charges");
      return;
    }

    // If card payment and there's a remaining balance, initiate Stripe
    if (remainingBalancePaymentMethod === 'card' && remainingBalance > 0) {
      setSubmitting(true);
      try {
        const response = await base44.functions.invoke('createStripePaymentIntent', {
          amount: remainingBalance, // Amount in GBP, will be converted to minor units on backend
          currency: 'gbp',
          memberEmail: memberInfo.email, // Added memberEmail for authentication context
          metadata: { // Optional metadata
            program_name: selectedProgram.program_tag,
            quantity: quantity,
            organization_id: organizationInfo.id, // Include organization ID for context
            discount_code: appliedDiscount?.code || null
          }
        });

        if (response.data.success) {
          setStripeClientSecret(response.data.clientSecret);
          setStripePaymentIntentId(response.data.paymentIntentId);
          setShowStripeModal(true);
        } else {
          toast.error("Failed to initialize payment: " + (response.data.error || "Unknown error"));
        }
      } catch (error) {
        console.error("Error creating Stripe Payment Intent:", error);
        toast.error("Failed to initialize payment");
      } finally {
        setSubmitting(false);
      }
      return; // Stop here, the rest of the purchase will be handled after Stripe payment is confirmed
    }

    // Otherwise (account charge or fully covered by internal funds) process directly
    setSubmitting(true);

    try {
      const response = await base44.functions.invoke('processProgramTicketPurchase', {
        memberEmail: memberInfo.email,
        programName: selectedProgram.name, // This is the quantity being paid for
        quantity: parseInt(quantity),
        purchaseOrderNumber: remainingBalancePaymentMethod === 'account' ? purchaseOrderNumber.trim() : null,
        selectedVoucherIds: isFeatureExcluded('payment_training_vouchers') ? [] : selectedVouchers,
        trainingFundAmount: isFeatureExcluded('payment_training_fund') ? 0 : trainingFundAmount,
        accountAmount: remainingBalancePaymentMethod === 'account' ? remainingBalance : 0,
        // cardAmount is no longer directly passed here for direct processing
        paymentMethod: remainingBalancePaymentMethod,
        appliedDiscountId: appliedDiscount?.discountId || null
      });

      console.log('[BuyProgramTickets] RAW RESPONSE:', JSON.stringify(response, null, 2));
      console.log('[BuyProgramTickets] response.data:', response.data);
      console.log('[BuyProgramTickets] response.data.success:', response.data?.success);

      if (response?.data?.success === true) {
        // Clear saved state for this program
        if (selectedProgram) {
          sessionStorage.removeItem(`program_purchase_${selectedProgram.id}`);
        }

        if (refreshOrganizationInfo) {
          await refreshOrganizationInfo();
        }

        // Store purchase details for modal
        setPurchaseDetails({
          programName: selectedProgram.name,
          // Show total tickets received including free ones in the modal
          quantity: totalTickets,
          totalCost: totalCost,
          isSimulatedPayment: false, // Not simulated anymore, either account or fully covered
          paymentMethod: remainingBalancePaymentMethod
        });

        // Show success modal
        setShowSuccessModal(true);

        // Reset form
        setSelectedProgram(null);
        setQuantity(1);
        setPurchaseOrderNumber("");
        setSelectedVouchers([]);
        setTrainingFundAmount(0);
        setRemainingBalancePaymentMethod('account');
        setAppliedDiscount(null); // Clear discount state
        setDiscountCodeInput("");
      } else {
        console.error('[BuyProgramTickets] FAILED - response.data:', response.data);
        toast.error(response.data?.error || "Failed to process purchase");
      }
    } catch (error) {
      console.error('[BuyProgramTickets] CAUGHT ERROR');
      console.error('[BuyProgramTickets] Error object:', error);
      console.error('[BuyProgramTickets] Error.toString():', error.toString());
      console.error('[BuyProgramTickets] JSON.stringify(error):', JSON.stringify(error, Object.getOwnPropertyNames(error)));

      const errorMsg = error.response?.data?.error || error.message || "Failed to process purchase";
      toast.error(errorMsg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCloseSuccessModal = () => {
    setShowSuccessModal(false);
    setPurchaseDetails(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      {/* Tour for List View */}
      {showListTour && shouldShowTours && !selectedProgram && (
        <PageTour 
          tourGroupName="BuyProgramTickets"
          viewId="list"
          onComplete={handleListTourComplete}
          onDismissPermanently={handleListTourDismiss}
          autoShow={tourAutoShowList}
        />
      )}

      {/* Tour for Form View */}
      {showFormTour && shouldShowTours && selectedProgram && (
        <PageTour 
          tourGroupName="BuyProgramTickets"
          viewId="form"
          onComplete={handleFormTourComplete}
          onDismissPermanently={handleFormTourDismiss}
          autoShow={tourAutoShowForm}
        />
      )}

      <div className="max-w-7xl mx-auto">
        {!selectedProgram ? (
          <>
            {/* Program Selection View - Header hidden when custom banner is present */}
            {!hasBanner && (
              <div className="mb-8">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">Buy unpacked tickets</h1>
                    {/*
                    <p className="text-slate-600">
                      Purchase tickets for specific programs that can be used for any event in that program
                    </p>
                    */}
                  </div>
                  {shouldShowTours && (
                    <TourButton onClick={handleStartListTour} />
                  )}
                </div>
              </div>
            )}

                        {/*}
            UNPACKED ONLY
            <div className="mb-6">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Available Programs</h2>
            </div>
            */}
            {isLoading ? (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {Array(3).fill(0).map((_, i) =>
                  <Card key={i} className="animate-pulse border-slate-200">
                    <div className="h-48 bg-slate-200" />
                    <CardHeader>
                      <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                      <div className="h-4 bg-slate-200 rounded w-full" />
                    </CardHeader>
                  </Card>
                )}
              </div>
            ) : programs.length === 0 ? (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-12 text-center">
                  <Ticket className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">
                    No Programs Available
                  </h3>
                  <p className="text-slate-600">
                    Program tickets will be available here once programs are configured
                  </p>
                </CardContent>
              </Card>
            ) : (

              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {programs.map((program, index) => {
                  const currentBalance = organizationInfo.program_ticket_balances?.[program.program_tag] || 0;
                  const eventCount = eventCountByProgram[program.program_tag] || 0;

                  return (
                    <button
                      key={program.id}
                      id={index === 0 ? "first-program-card" : undefined}
                      onClick={() => handleProgramSelect(program)}
                      className="text-left group">

                      <Card className="border-slate-200 hover:border-purple-300 hover:shadow-lg transition-all overflow-hidden h-full">
                        {program.image_url &&
                          <div className="h-48 overflow-hidden bg-slate-100">
                            <img
                              src={program.image_url}
                              alt={program.name}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />

                          </div>
                        }
                        
                        <CardHeader className="pb-3">
                          <CardTitle className="text-lg group-hover:text-purple-600 transition-colors">
                            {program.name}
                          </CardTitle>
                        </CardHeader>
                        
                        <CardContent className="space-y-3">
                          {program.description &&
                            <p className="text-sm text-slate-600 line-clamp-2">
                              {program.description}
                            </p>
                          }
                          
                          <div className="pt-2 border-t border-slate-100 space-y-2">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-slate-500">{eventCount} {eventCount === 1 ? 'event' : 'events'}</span>
                              <div className="flex items-baseline gap-1">
                                <span className="text-lg font-bold text-slate-900">£{program.program_ticket_price}</span>
                                <span className="text-xs text-slate-500">per ticket</span>
                              </div>
                            </div>
                            
                            {program.bogo_buy_quantity && program.bogo_get_free_quantity &&
                              <p className="text-xs text-green-600 font-medium">
                                Buy {program.bogo_buy_quantity}, Get {program.bogo_get_free_quantity} Free!
                              </p>
                            }
                            
                            {!program.bogo_buy_quantity && program.bulk_discount_threshold && program.bulk_discount_percentage &&
                              <p className="text-xs text-green-600">
                                {program.bulk_discount_percentage}% off when buying {program.bulk_discount_threshold}+ tickets
                              </p>
                            }
                          </div>
                          
                          {/* Available Tickets Display */}
                          <div className="pt-3 mt-3 border-t border-slate-200">
                            <div className="flex items-center gap-2 text-purple-700 bg-purple-50 px-3 py-2 rounded-lg">
                              <Ticket className="w-5 h-5" />
                              <span className="text-sm font-medium">
                                Tickets Purchased: <span className="font-bold text-lg">{currentBalance}</span>
                              </span>
                            </div>
                          </div>
        
                        </CardContent>
                      </Card>
                    </button>);

                })}
              </div>
            )}
          </>
        ) : (
          <>
            {/* Purchase Form View */}
            <button
              onClick={() => setSelectedProgram(null)}
              className="inline-flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-6"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Programs
            </button>

            {shouldShowTours && (
              <div className="mb-6 flex justify-end">
                <TourButton onClick={handleStartFormTour} />
              </div>
            )}

            <div className="grid lg:grid-cols-3 gap-8">
              {/* Program Details */}
              <div className="lg:col-span-2 space-y-6">
                <Card className="border-slate-200 shadow-sm">
                  {selectedProgram.image_url &&
                    <div className="h-48 overflow-hidden bg-slate-100">
                      <img
                        src={selectedProgram.image_url}
                        alt={selectedProgram.name}
                        className="w-full h-full object-cover" />

                    </div>
                  }
                  
                  <CardHeader>
                    <CardTitle className="text-2xl">{selectedProgram.name}</CardTitle>
                    {selectedProgram.description &&
                      <p className="text-slate-600 mt-2">{selectedProgram.description}</p>
                    }
                  </CardHeader>
                  
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                      <span className="text-slate-600">Current Balance:</span>
                      <div className="flex items-center gap-2">
                        <Ticket className="w-5 h-5 text-purple-600" />
                        <span className="text-xl font-bold text-purple-600">
                          {organizationInfo.program_ticket_balances?.[selectedProgram.program_tag] || 0}
                        </span>
                      </div>
                
                    </div>
                    
                    <div className="space-y-2"> 

                      <p className="text-xs text-slate-500">
                        This is the number of tickets your organisation has already purchased but not yet allocated to attendees
                      </p>
                    </div>


                    <div className="space-y-2">
                      <Label htmlFor="quantity-input" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                        {selectedProgram.bogo_logic_type === 'enter_total_pay_less' 
                          ? 'Enter total number of tickets you want to receive'
                          : 'Enter number of tickets to purchase'
                        }
                      </Label>
                      <Input
                        id="quantity-input"
                        type="number"
                        min="1"
                        max="1000"
                        value={quantity}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value === '') {
                            setQuantity('');
                          } else {
                            const numValue = parseInt(value);
                            if (!isNaN(numValue) && numValue >= 0) {
                              setQuantity(numValue);
                            }
                          }
                        }}
                        onBlur={(e) => {
                          const numValue = parseInt(e.target.value);
                          if (isNaN(numValue) || numValue < 1) {
                            setQuantity(1);
                          } else {
                            setQuantity(numValue);
                          }
                        }}
                        placeholder="Enter quantity"
                        className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                      {/*
                                             <p className="text-xs text-slate-500">
                                               Each ticket can be used for one event in {selectedProgram.name}
                                             </p>
                                             */}
                    </div>

                    <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-slate-700">Price per Ticket:</span>
                        <span className="text-lg font-bold text-slate-900">
                          £{selectedProgram.program_ticket_price}
                        </span>
                      </div>
                      
                      {freeTickets > 0 && (
                        <div className="flex items-center justify-between py-2 border-t border-purple-200">
                          <span className="text-sm font-medium text-green-700">
                            {selectedProgram.bogo_logic_type === 'enter_total_pay_less' 
                              ? 'Discount Applied (Free Tickets):'
                              : 'Free Tickets:'
                            }
                          </span>
                          <span className="text-lg font-bold text-green-600">
                            {selectedProgram.bogo_logic_type === 'enter_total_pay_less'
                              ? `${freeTickets} ticket${freeTickets > 1 ? 's' : ''}`
                              : `+${freeTickets}`
                            }
                          </span>
                        </div>
                      )}
                      
                      <div className="flex items-center justify-between py-2 border-t border-purple-200">
                        <span className="text-sm font-medium text-slate-700">Total Tickets You'll Receive:</span>
                        <span className="text-xl font-bold text-purple-600">
                          {totalTickets}
                        </span>
                      </div>
                      
                      <div className="flex items-center justify-between border-t border-purple-200 pt-2">
                        <span className="text-sm font-medium text-slate-700">Total Cost:</span>
                        <span className="text-2xl font-bold text-purple-600">
                          £{totalCostBeforeDiscount.toFixed(2)}
                        </span>
                      </div>
                      
                      {(() => {
                        const offerType = selectedProgram.offer_type || "none";
                        let effectiveOfferType = offerType;
                        if (offerType === "none") {
                          if (selectedProgram.bogo_buy_quantity && selectedProgram.bogo_get_free_quantity) {
                            effectiveOfferType = "bogo";
                          } else if (selectedProgram.bulk_discount_threshold && selectedProgram.bulk_discount_percentage) {
                            effectiveOfferType = "bulk_discount";
                          }
                        }
                        
                        if (effectiveOfferType === "bogo" && freeTickets > 0) {
                          return (
                            <p className="text-xs text-green-600 mt-2 font-medium">
                              {selectedProgram.bogo_logic_type === 'enter_total_pay_less'
                                ? `✓ BOGO offer applied: You entered ${quantity} ticket${quantity > 1 ? 's' : ''}, paying for ${quantity - freeTickets}!`
                                : `✓ Buy ${selectedProgram.bogo_buy_quantity}, Get ${selectedProgram.bogo_get_free_quantity} Free offer applied!`
                              }
                            </p>
                          );
                        } else if (effectiveOfferType === "bulk_discount" && 
                                   selectedProgram.bulk_discount_threshold && 
                                   selectedProgram.bulk_discount_percentage &&
                                   quantity >= selectedProgram.bulk_discount_threshold) {
                          return (
                            <p className="text-xs text-green-600 mt-2">
                              ✓ {selectedProgram.bulk_discount_percentage}% bulk discount applied!
                            </p>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Payment Allocation */}
              <div className="lg:col-span-1">
                <Card id="payment-options-card" className="border-slate-200 shadow-lg sticky top-8">
                  <CardHeader className="border-b border-slate-200">
                    <CardTitle className="font-semibold tracking-tight text-xl">Payment Options</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-6 space-y-6">
                    {/* Training Vouchers - only show if not excluded */}
                    {!isFeatureExcluded('payment_training_vouchers') && (
                      <div id="training-vouchers-section" className="p-4 rounded-lg border border-slate-200 bg-blue-50">
                        <div className="flex items-center gap-2 mb-3">
                          <Ticket className="w-4 h-4 text-blue-600" />
                          <Label className="text-sm font-medium">Training Vouchers</Label>
                        </div>
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
                      </div>
                    )}

                    {/* Training Fund - only show if not excluded */}
                    {!isFeatureExcluded('payment_training_fund') && (
                      <div id="training-fund-section" className="p-4 rounded-lg border border-slate-200 bg-green-50">
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

                    {/* Remaining Balance Payment Method Selection */}
                    {remainingBalance > 0 && (
                      <div id="remaining-balance-section" className="p-4 rounded-lg border border-slate-200 bg-slate-50">
                        <div className="flex items-center gap-2 mb-4">
                          <CreditCard className="w-4 h-4 text-indigo-600" />
                          <Label className="peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-sm font-medium">Pay Balance</Label>
                        </div>
                        
                        <div id="amount-due-display" className="mb-4 p-3 bg-white rounded-lg border border-slate-200">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-slate-600">Amount Due:</span>
                            <span className="text-lg font-bold text-slate-900">£{remainingBalance.toFixed(2)}</span>
                          </div>
                        </div>

                        <RadioGroup value={remainingBalancePaymentMethod} onValueChange={setRemainingBalancePaymentMethod}>
                          <div className="space-y-3">
                            <div className="space-y-2"> {/* Wrapper for account option and its PO field */}
                              <div
                                id="account-payment-option"
                                className="flex items-start space-x-3 p-3 rounded-lg border-2 transition-colors cursor-pointer hover:bg-slate-100"
                                style={{ borderColor: remainingBalancePaymentMethod === 'account' ? '#6366f1' : '#e2e8f0' }}
                                onClick={() => setRemainingBalancePaymentMethod('account')}
                              >
                                <RadioGroupItem value="account" id="account" className="mt-1" />
                                <div className="flex-1">
                                  <Label htmlFor="account" className="text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 font-medium cursor-pointer">Charge to Organisation Account</Label>
                                  <p className="text-xs text-slate-500 mt-1">Requires purchase order number</p>
                                </div>
                              </div>

                              {/* Show PO number input immediately under account option */}
                              {remainingBalancePaymentMethod === 'account' && (
                                <div id="purchase-order-field" className="flex items-start gap-2 ml-2">
                                  <div className="pt-6">
                                    <FileText className="w-4 h-4 text-indigo-600" />
                                  </div>
                                  <div className="flex-1">
                                    <Label htmlFor="po-number" className="text-xs text-slate-600 mb-1 block">Purchase Order Number *</Label>
                                    <Input
                                      id="po-number"
                                      type="text"
                                      value={purchaseOrderNumber}
                                      onChange={(e) => setPurchaseOrderNumber(e.target.value)}
                                      placeholder="e.g., PO-2024-001"
                                      required
                                    />
                                  </div>
                                </div>
                              )}
                            </div>

                            <div
                              id="card-payment-option"
                              className="flex items-start space-x-3 p-3 rounded-lg border-2 transition-colors cursor-pointer hover:bg-slate-100"
                              style={{ borderColor: remainingBalancePaymentMethod === 'card' ? '#6366f1' : '#e2e8f0' }}
                              onClick={() => setRemainingBalancePaymentMethod('card')}
                            >
                              <RadioGroupItem value="card" id="card" className="mt-1" />
                              <div className="flex-1">
                                <Label htmlFor="card" className="font-medium cursor-pointer">Credit/Debit Card</Label>
                                <p className="text-xs text-slate-500 mt-1">Secure payment via Stripe</p>
                              </div>
                            </div>
                          </div>
                        </RadioGroup>
                      </div>
                    )}

                    {/* Summary */}
                    <div className="pt-4 border-t border-slate-200 space-y-3">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Subtotal</span>
                        <span className={appliedDiscount ? "line-through text-slate-400" : "font-semibold text-slate-900"}>
                          £{totalCostBeforeDiscount.toFixed(2)}
                        </span>
                      </div>

                      {/* Discount Code Input */}
                      {!appliedDiscount ? (
                        <div id="discount-code-section" className="p-4 rounded-lg border border-slate-200 bg-slate-50">
                          <div className="flex items-center gap-2 mb-3">
                            <Tag className="w-4 h-4 text-purple-600" />
                            <Label className="text-sm font-medium">Discount Code</Label>
                          </div>
                          <div className="flex gap-2">
                            <Input
                              placeholder="Enter code"
                              value={discountCodeInput}
                              onChange={(e) => setDiscountCodeInput(e.target.value.toUpperCase())}
                              onKeyPress={(e) => e.key === 'Enter' && handleApplyDiscount()}
                              disabled={applyingDiscount}
                            />
                            <Button
                              onClick={handleApplyDiscount}
                              disabled={applyingDiscount || !discountCodeInput.trim()}
                              size="sm"
                              variant="outline"
                            >
                              {applyingDiscount ? (
                                <>
                                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                                  Applying...
                                </>
                              ) : (
                                'Apply'
                              )}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="p-4 rounded-lg border border-green-200 bg-green-50">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Tag className="w-4 h-4 text-green-600" />
                              <div>
                                <p className="text-sm font-medium text-green-900">{appliedDiscount.code}</p>
                                <p className="text-xs text-green-700">
                                  {appliedDiscount.type === 'percentage' 
                                    ? `${appliedDiscount.value}% off` 
                                    : `£${appliedDiscount.value} off`
                                  }
                                </p>
                              </div>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-green-700 hover:text-green-900 hover:bg-green-100"
                              onClick={handleRemoveDiscount}
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          </div>
                          <div className="mt-2 pt-2 border-t border-green-200">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-green-700">Discount:</span>
                              <span className="font-semibold text-green-900">-£{appliedDiscount.discountAmount.toFixed(2)}</span>
                            </div>
                          </div>
                        </div>
                      )}
                      
                      {(voucherAmount > 0 || trainingFundAmount > 0) &&
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Vouchers & Training Fund</span>
                          <span className="font-semibold text-green-600">-£{(voucherAmount + trainingFundAmount).toFixed(2)}</span>
                        </div>
                      }
                      
                      <div className="pt-2 border-t border-slate-200">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-slate-700">Amount Due</span>
                          <span className={`text-xl font-bold ${remainingBalance === 0 ? 'text-green-600' : 'text-slate-900'}`}>
                            £{remainingBalance.toFixed(2)}
                          </span>
                        </div>
                        {remainingBalance === 0 &&
                          <p className="text-xs text-green-600 mt-1">
                            Fully covered by vouchers & training fund
                          </p>
                        }
                        {remainingBalance > 0 &&
                          <p className="text-xs text-slate-500 mt-1">
                            To be paid by {remainingBalancePaymentMethod === 'account' ? 'account charge' : 'credit/debit card'}
                          </p>
                        }
                      </div>
                    </div>

                    <Button
                      id="complete-purchase-button"
                      onClick={handleSubmit}
                      disabled={!isFullyPaid || submitting || quantity === ''}
                      className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
                      size="lg"
                    >
                      {submitting ?
                        <>
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          Processing...
                        </> :

                        <>
                          <ShoppingCart className="w-5 h-5 mr-2" />
                          Complete Purchase
                        </>
                      }
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Stripe Payment Modal */}
      <Dialog open={showStripeModal} onOpenChange={setShowStripeModal}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Enter Payment Details</DialogTitle>
            <DialogDescription>
              Complete your purchase by entering your card information below.
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

      {/* Success Modal */}
      <Dialog open={showSuccessModal} onOpenChange={setShowSuccessModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-green-100 rounded-full">
              <CheckCircle2 className="w-10 h-10 text-green-600" />
            </div>
            <DialogTitle className="text-center text-2xl">Purchase Successful!</DialogTitle>
            <DialogDescription className="text-center pt-4">
              {purchaseDetails && (
                <div className="space-y-2">
                  <p className="text-base text-slate-700">
                    You've successfully purchased <span className="font-bold text-purple-600">{purchaseDetails.quantity}</span> ticket{purchaseDetails.quantity > 1 ? 's' : ''} for
                  </p>
                  <p className="text-lg font-semibold text-slate-900">
                  {/*
                    {purchaseDetails.programName}
                    */}
                    International Employability
                  </p>
                  
                  <p className="text-sm text-slate-600 paddingTop-2">
                    Register your attendees now.
                  </p>
                </div>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 w-full mt-4">
            <Button
              onClick={() => {
                handleCloseSuccessModal();
                window.location.href = createPageUrl('Events');
              }}
              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
            >
              Register
            </Button>
            <Button
              variant="outline"
              onClick={handleCloseSuccessModal}
              className="w-full"
            >
              Buy More Tickets
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
