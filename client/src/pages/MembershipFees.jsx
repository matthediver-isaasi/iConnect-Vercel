import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Loader2, CheckCircle2, CreditCard, ClipboardList,
  AlertCircle, Building2, FileText, RefreshCw, ShieldAlert, Send
} from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";

function formatCurrency(amount, currency) {
  const symbols = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };
  const symbol = symbols[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

const STRIPE_MINIMUMS = { GBP: 0.30, USD: 0.50, EUR: 0.50, AUD: 0.50, NZD: 0.50 };

function isBelowStripeMinimum(amount, currency) {
  const min = STRIPE_MINIMUMS[currency] || 0.50;
  return parseFloat(amount || 0) < min;
}

export default function MembershipFees() {
  const { memberInfo, isFeatureExcluded } = useMemberAccess();

  const canSubmitPo = !isFeatureExcluded('commerce.membership.submit-po');
  const canPayOnline = !isFeatureExcluded('commerce.membership.pay-online');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [poNumber, setPoNumber] = useState('');
  const [submittingPo, setSubmittingPo] = useState(false);
  const [poSubmitted, setPoSubmitted] = useState(false);

  const [paymentMode, setPaymentMode] = useState(null);
  const [creatingPayment, setCreatingPayment] = useState(false);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [paymentYear, setPaymentYear] = useState(null);
  const [completingRedirectPayment, setCompletingRedirectPayment] = useState(false);

  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const redirectHandled = useRef(false);

  const fetchFees = (year) => {
    setLoading(true);
    setError(null);
    const url = year
      ? `/api/membership/member-fees?year=${encodeURIComponent(year)}`
      : '/api/membership/member-fees';

    fetch(url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to load fee details');
        }
        return res.json();
      })
      .then((result) => {
        setData(result);
        if (result.poNumber) {
          setPoNumber(result.poNumber);
        }
        if (result.existingRecord?.status === 'active' && result.existingRecord?.paymentMethod === 'stripe') {
          setPaymentComplete(true);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchFees(null);
  }, []);

  // Handle 3D Secure redirect return
  useEffect(() => {
    if (redirectHandled.current) return;

    const urlParams = new URLSearchParams(window.location.search);
    const paymentIntentFromUrl = urlParams.get('payment_intent');
    const redirectStatus = urlParams.get('redirect_status');

    if (!paymentIntentFromUrl) return;

    redirectHandled.current = true;
    console.log('[MembershipFees] Detected 3D Secure return:', { paymentIntentFromUrl, redirectStatus });

    // Clean Stripe params from URL
    const cleanParams = new URLSearchParams(window.location.search);
    cleanParams.delete('payment_intent');
    cleanParams.delete('payment_intent_client_secret');
    cleanParams.delete('redirect_status');
    const cleanSearch = cleanParams.toString();
    window.history.replaceState({}, '', window.location.pathname + (cleanSearch ? '?' + cleanSearch : ''));

    if (redirectStatus !== 'succeeded') {
      setPaymentError('Payment was not completed. Please try again.');
      return;
    }

    // Retrieve saved membership year from sessionStorage
    const savedYear = sessionStorage.getItem('pending_membership_payment_year');
    setCompletingRedirectPayment(true);

    const completePayment = async () => {
      try {
        const confirmRes = await fetch('/api/membership/member-fees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            action: 'confirm_payment',
            paymentIntentId: paymentIntentFromUrl,
            membershipYear: savedYear || null,
          }),
        });

        if (!confirmRes.ok) {
          const err = await confirmRes.json().catch(() => ({}));
          throw new Error(err.error || 'Payment was taken but confirmation failed. Please contact support.');
        }

        sessionStorage.removeItem('pending_membership_payment_year');
        setPaymentComplete(true);
      } catch (err) {
        setPaymentError(err.message);
      } finally {
        setCompletingRedirectPayment(false);
      }
    };

    completePayment();
  }, []);

  const handleSubmitPo = async () => {
    if (!poNumber.trim()) return;
    setSubmittingPo(true);
    setPaymentError(null);
    try {
      const res = await fetch('/api/membership/member-fees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'submit_po',
          poNumber: poNumber.trim(),
          membershipYear: data?.membershipYear,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to submit PO number');
      }
      setPoSubmitted(true);
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setSubmittingPo(false);
    }
  };

  const initStripe = async () => {
    if (!data?.stripePublishableKey) return;
    if (isBelowStripeMinimum(data?.totalWithVat || data?.finalCost, data?.currency)) return;
    setCreatingPayment(true);
    setPaymentError(null);

    try {
      const res = await fetch('/api/membership/member-fees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'create_payment',
          membershipYear: data?.membershipYear,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to initialize payment');
      }
      const { clientSecret, membershipYear: yr } = await res.json();
      setPaymentYear(yr);
      // Save membership year for 3D Secure redirect recovery
      if (yr) {
        sessionStorage.setItem('pending_membership_payment_year', yr);
      }

      if (!window.Stripe) {
        const script = document.createElement('script');
        script.src = 'https://js.stripe.com/v3/';
        script.async = true;
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = () => reject(new Error('Failed to load Stripe'));
          document.head.appendChild(script);
        });
      }

      const stripe = window.Stripe(data.stripePublishableKey);
      stripeRef.current = stripe;

      const elements = stripe.elements({ clientSecret });
      elementsRef.current = elements;

      const cardElement = elements.create('payment');

      setTimeout(() => {
        const container = document.getElementById('portal-stripe-payment-element');
        if (container) {
          cardElement.mount(container);
        }
      }, 100);

      setPaymentMode('stripe');
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setCreatingPayment(false);
    }
  };

  const handleStripePayment = async () => {
    if (!stripeRef.current || !elementsRef.current) return;
    setProcessingPayment(true);
    setPaymentError(null);

    try {
      const { error: submitError } = await elementsRef.current.submit();
      if (submitError) {
        throw new Error(submitError.message);
      }

      const { error: confirmError, paymentIntent } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        confirmParams: {
          return_url: window.location.href,
        },
        redirect: 'if_required',
      });

      if (confirmError) {
        throw new Error(confirmError.message);
      }

      if (paymentIntent?.status === 'succeeded') {
        // Clean up sessionStorage since payment completed without redirect
        sessionStorage.removeItem('pending_membership_payment_year');
        
        const confirmRes = await fetch('/api/membership/member-fees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            action: 'confirm_payment',
            paymentIntentId: paymentIntent.id,
            membershipYear: paymentYear || data?.membershipYear,
          }),
        });

        if (!confirmRes.ok) {
          const err = await confirmRes.json().catch(() => ({}));
          throw new Error(err.error || 'Payment was taken but confirmation failed. Please contact support.');
        }

        setPaymentComplete(true);
      }
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setProcessingPayment(false);
    }
  };

  const primaryColor = data?.tenant?.primaryColor || '#5C0085';

  if (completingRedirectPayment) {
    return (
      <div className="flex items-center justify-center p-12">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <Loader2 className="w-10 h-10 mx-auto mb-4 animate-spin text-blue-600" />
            <h2 className="text-lg font-semibold mb-2">Completing Your Payment</h2>
            <p className="text-sm text-muted-foreground">Your payment has been verified. We're confirming your membership now...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <Card>
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-10 h-10 mx-auto mb-3 text-destructive" />
            <h2 className="text-lg font-semibold mb-2">Unable to Load Fees</h2>
            <p className="text-sm text-muted-foreground mb-4">{error}</p>
            <Button variant="outline" onClick={() => fetchFees(null)} data-testid="button-retry-fees">
              <RefreshCw className="w-4 h-4 mr-2" />
              Try Again
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (paymentComplete) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <Card>
          <CardContent className="pt-6 text-center">
            <CheckCircle2 className="w-14 h-14 mx-auto mb-4 text-green-500" />
            <h2 className="text-xl font-semibold mb-2">Payment Complete</h2>
            <p className="text-muted-foreground mb-4">
              Your membership fee for {data?.membershipYear} has been received.
            </p>
            <div className="p-4 rounded-md bg-muted">
              <p className="text-sm text-muted-foreground">Amount Paid</p>
              <p className="text-2xl font-bold">
                {formatCurrency(data?.finalCost, data?.currency)}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const breakdown = data?.costBreakdown || {};
  const isStripePayment = data?.existingRecord?.paymentMethod === 'stripe';
  const alreadyPaid = data?.existingRecord?.status === 'active' && isStripePayment;
  const invoiceSent = data?.existingRecord?.status === 'active' && !isStripePayment;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Building2 className="w-5 h-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold" data-testid="text-page-title">Membership Fees</h1>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-base">Fee Summary</CardTitle>
          {alreadyPaid && (
            <Badge variant="secondary" data-testid="badge-paid">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Paid
            </Badge>
          )}
          {invoiceSent && (
            <Badge variant="outline" data-testid="badge-invoice-sent">
              <Send className="w-3 h-3 mr-1" />
              Invoice Sent
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Organisation</span>
              <span className="font-medium text-sm" data-testid="text-org-name">{data?.organizationName}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Period</span>
              <span className="font-medium text-sm" data-testid="text-period">{data?.membershipYear}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Tier</span>
              <Badge variant="secondary" data-testid="text-tier">{data?.tierLabel || 'Standard'}</Badge>
            </div>

            <Separator />

            {breakdown.annualCostBeforeDiscounts != null && breakdown.customDiscountTotal > 0 && (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Gross Cost</span>
                  <span>{formatCurrency(breakdown.annualCostBeforeDiscounts, data?.currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Discount</span>
                  <span className="text-green-600">-{formatCurrency(breakdown.customDiscountTotal, data?.currency)}</span>
                </div>
              </>
            )}

            {breakdown.annualCost != null && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Net Cost</span>
                <span>{formatCurrency(breakdown.annualCost, data?.currency)}</span>
              </div>
            )}

            {breakdown.proRataEnabled && breakdown.prorataDays != null && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Pro-rata ({breakdown.prorataDays} days)</span>
                <span>{formatCurrency(breakdown.prorataCost, data?.currency)}</span>
              </div>
            )}

            {breakdown.freeDiscount > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {breakdown.freePeriodUnit === 'percent'
                    ? `New Member Discount (${breakdown.freePeriodAmount}%)${breakdown.yearNumber === 2 ? ' (rollover from Y1)' : ''}`
                    : breakdown.yearNumber === 2 && breakdown.freeDiscount > 0
                      ? `New Member Discount (${breakdown.freePeriodDaysApplied} days rollover)`
                      : `New Member Discount (${breakdown.freePeriodDaysApplied} free days${breakdown.dailyCost ? ` \u00d7 ${formatCurrency(breakdown.dailyCost, data?.currency)}` : ''})`}
                </span>
                <span className="text-green-600">-{formatCurrency(breakdown.freeDiscount, data?.currency)}</span>
              </div>
            )}

            {data?.vatRatePercent > 0 && data?.vatAmount > 0 && (
              <>
                <Separator />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Net Amount</span>
                  <span>{formatCurrency(data?.finalCost, data?.currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">VAT ({data.vatRatePercent}%)</span>
                  <span data-testid="text-vat">{formatCurrency(data.vatAmount, data?.currency)}</span>
                </div>
              </>
            )}

            <Separator />

            <div className="flex items-center justify-between">
              <span className="font-medium">Total Due{data?.vatRatePercent > 0 ? ' (incl. VAT)' : ''}</span>
              <span className="text-xl font-bold" data-testid="text-total">
                {formatCurrency(data?.totalWithVat || data?.finalCost, data?.currency)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {data?.approvalPending && !alreadyPaid && !invoiceSent && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-warning mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-sm mb-1" data-testid="text-approval-pending-title">Fees Pending Approval</p>
                <p className="text-sm text-muted-foreground" data-testid="text-approval-pending-message">
                  {data.approvalMessage || 'Your membership fees are currently being reviewed. You will be notified when they are ready for payment.'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {canSubmitPo && !alreadyPaid && !invoiceSent && !poSubmitted && !data?.poNumber && paymentMode !== 'stripe' && !data?.approvalPending && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              Purchase Order Number
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              If your organisation requires a purchase order for this payment, enter it here.
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                placeholder="e.g. PO-12345"
                data-testid="input-portal-po"
              />
              <Button
                onClick={handleSubmitPo}
                disabled={submittingPo || !poNumber.trim()}
                data-testid="button-portal-submit-po"
              >
                {submittingPo ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Submit'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {(poSubmitted || data?.poNumber) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              Purchase Order Number
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Input
                value={poSubmitted ? poNumber : data?.poNumber}
                readOnly
                disabled
                data-testid="input-portal-po-locked"
              />
              <Badge variant="secondary" data-testid="badge-po-submitted">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Submitted
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {canPayOnline && data?.stripeEnabled && !alreadyPaid && !invoiceSent && !paymentComplete && !data?.approvalPending && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="w-4 h-4" />
              Pay Now
            </CardTitle>
          </CardHeader>
          <CardContent>
            {paymentMode !== 'stripe' ? (
              <>
                {isBelowStripeMinimum(data?.totalWithVat || data?.finalCost, data?.currency) ? (
                  <p className="text-sm text-muted-foreground mb-3">
                    Online payment is not available as the amount is below the minimum that can be processed by card ({formatCurrency(STRIPE_MINIMUMS[data?.currency] || 0.50, data?.currency)}).
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground mb-3">
                    Pay your membership fee immediately by card.{data?.vatRatePercent > 0 ? ` The amount includes VAT at ${data.vatRatePercent}%.` : ''} Your membership will be activated once payment is confirmed.
                  </p>
                )}
                <Button
                  onClick={initStripe}
                  disabled={creatingPayment || isBelowStripeMinimum(data?.totalWithVat || data?.finalCost, data?.currency)}
                  className="w-full"
                  data-testid="button-portal-pay-now"
                >
                  {creatingPayment ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <CreditCard className="w-4 h-4 mr-2" />
                  )}
                  Pay {formatCurrency(data?.totalWithVat || data?.finalCost, data?.currency)}
                </Button>
              </>
            ) : (
              <div className="space-y-4">
                <div id="portal-stripe-payment-element" className="min-h-[200px] border rounded-md p-3" />

                {paymentError && (
                  <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
                    <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                    <p className="text-sm text-destructive">{paymentError}</p>
                  </div>
                )}

                <Button
                  onClick={handleStripePayment}
                  disabled={processingPayment}
                  className="w-full"
                  data-testid="button-portal-confirm-payment"
                >
                  {processingPayment ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <CreditCard className="w-4 h-4 mr-2" />
                  )}
                  {processingPayment ? 'Processing...' : `Confirm Payment - ${formatCurrency(data?.totalWithVat || data?.finalCost, data?.currency)}`}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {alreadyPaid && (
        <Card>
          <CardContent className="pt-6 text-center">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-2 text-green-500" />
            <p className="font-medium">Membership fee already paid for this period</p>
          </CardContent>
        </Card>
      )}

      {invoiceSent && (
        <Card>
          <CardContent className="pt-6 text-center">
            <Send className="w-10 h-10 mx-auto mb-2 text-muted-foreground" />
            <p className="font-medium">Invoice sent for this period</p>
          </CardContent>
        </Card>
      )}

      {paymentError && paymentMode !== 'stripe' && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
          <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
          <p className="text-sm text-destructive">{paymentError}</p>
        </div>
      )}
    </div>
  );
}
