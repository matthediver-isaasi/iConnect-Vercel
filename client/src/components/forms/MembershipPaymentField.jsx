import { useState, useEffect, useRef, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, CheckCircle2, CreditCard, AlertCircle, Info } from "lucide-react";

const CURRENCY_SYMBOLS = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };
const STRIPE_MINIMUMS = { GBP: 0.30, USD: 0.50, EUR: 0.50, AUD: 0.50, NZD: 0.50 };

function formatCurrency(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

function isBelowStripeMinimum(amount, currency) {
  const min = STRIPE_MINIMUMS[currency] || 0.50;
  return parseFloat(amount || 0) < min;
}

export default function MembershipPaymentField({ value, onChange, disabled, field }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [paymentMode, setPaymentMode] = useState(null);
  const [creatingPayment, setCreatingPayment] = useState(false);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [paymentYear, setPaymentYear] = useState(null);

  const cardRef = useRef(null);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const redirectHandled = useRef(false);

  const memberId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('member_id');
  }, []);

  useEffect(() => {
    if (!memberId) {
      setLoading(false);
      return;
    }
    fetchFees();
  }, [memberId]);

  const fetchFees = () => {
    setLoading(true);
    setError(null);
    fetch(`/api/forms/membership-payment?memberId=${encodeURIComponent(memberId)}`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to load fee details');
        }
        return res.json();
      })
      .then((result) => {
        setData(result);
        if (result.existingRecord?.status === 'active') {
          setPaymentComplete(true);
          if (onChange && !value) {
            onChange({
              status: 'already_paid',
              membershipYear: result.membershipYear,
              existingRecordId: result.existingRecord.id,
            });
          }
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (redirectHandled.current || !memberId) return;

    const currentUrlParams = new URLSearchParams(window.location.search);
    const paymentIntentFromUrl = currentUrlParams.get('payment_intent');
    const redirectStatus = currentUrlParams.get('redirect_status');

    if (!paymentIntentFromUrl) return;

    redirectHandled.current = true;
    console.log('[MembershipPaymentField] Detected 3D Secure return:', { paymentIntentFromUrl, redirectStatus });

    const cleanParams = new URLSearchParams(currentUrlParams.toString());
    cleanParams.delete('payment_intent');
    cleanParams.delete('payment_intent_client_secret');
    cleanParams.delete('redirect_status');
    const cleanUrl = cleanParams.toString()
      ? `${window.location.pathname}?${cleanParams.toString()}`
      : window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);

    if (redirectStatus !== 'succeeded') {
      setPaymentError('Payment was not completed. Please try again.');
      return;
    }

    const savedYear = sessionStorage.getItem('pending_form_membership_payment_year');
    const completePayment = async () => {
      setProcessingPayment(true);
      try {
        const confirmRes = await fetch('/api/forms/membership-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            action: 'confirm_payment',
            memberId,
            paymentIntentId: paymentIntentFromUrl,
            membershipYear: savedYear,
          }),
        });
        if (!confirmRes.ok) {
          const err = await confirmRes.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to confirm payment');
        }
        sessionStorage.removeItem('pending_form_membership_payment_year');
        setPaymentComplete(true);
        if (onChange) {
          onChange({
            status: 'paid',
            paymentIntentId: paymentIntentFromUrl,
            membershipYear: savedYear,
          });
        }
      } catch (err) {
        setPaymentError(err.message);
      } finally {
        setProcessingPayment(false);
      }
    };

    completePayment();
  }, [memberId]);

  useEffect(() => {
    if (paymentComplete && cardRef.current) {
      setTimeout(() => {
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [paymentComplete]);

  const initStripe = async () => {
    if (!data?.stripePublishableKey) return;
    if (isBelowStripeMinimum(data?.totalWithVat || data?.finalCost, data?.currency)) return;
    setCreatingPayment(true);
    setPaymentError(null);

    try {
      const res = await fetch('/api/forms/membership-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'create_payment',
          memberId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to initialise payment');
      }
      const { clientSecret, membershipYear: yr } = await res.json();
      setPaymentYear(yr);
      if (yr) {
        sessionStorage.setItem('pending_form_membership_payment_year', yr);
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
        const container = document.getElementById(`form-stripe-payment-element-${field.id}`);
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
        sessionStorage.removeItem('pending_form_membership_payment_year');

        const confirmRes = await fetch('/api/forms/membership-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            action: 'confirm_payment',
            memberId,
            paymentIntentId: paymentIntent.id,
            membershipYear: paymentYear || data?.membershipYear,
          }),
        });

        if (!confirmRes.ok) {
          const err = await confirmRes.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to confirm payment');
        }

        setPaymentComplete(true);
        if (onChange) {
          onChange({
            status: 'paid',
            paymentIntentId: paymentIntent.id,
            membershipYear: paymentYear || data?.membershipYear,
            amount: data?.totalWithVat || data?.finalCost,
            currency: data?.currency,
          });
        }
      }
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setProcessingPayment(false);
    }
  };

  if (!memberId) {
    return (
      <Card data-testid={`membership-payment-no-member-${field.id}`}>
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Info className="h-4 w-4 shrink-0" />
            <p className="text-sm">Member information is required to display membership fees. Please ensure the form link includes a member_id parameter.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card data-testid={`membership-payment-loading-${field.id}`}>
        <CardContent className="pt-6">
          <div className="flex items-center justify-center gap-2 py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading membership fees...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card data-testid={`membership-payment-error-${field.id}`}>
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (paymentComplete) {
    return (
      <Card ref={cardRef} data-testid={`membership-payment-complete-${field.id}`}>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 className="h-10 w-10 text-green-500" />
            <div className="text-center">
              <p className="font-medium" data-testid="text-payment-success">Membership fee paid</p>
              <p className="text-sm text-muted-foreground">
                {data?.membershipYear} - {formatCurrency(data?.totalWithVat || data?.finalCost, data?.currency)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const payableAmount = data.totalWithVat || data.finalCost;
  const belowMinimum = isBelowStripeMinimum(payableAmount, data.currency);

  return (
    <Card data-testid={`membership-payment-${field.id}`}>
      <CardContent className="pt-6 space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm font-medium" data-testid="text-membership-year">{data.membershipYear}</p>
              {data.tierLabel && (
                <p className="text-xs text-muted-foreground" data-testid="text-tier-label">{data.tierLabel}</p>
              )}
            </div>
            {data.entityName && (
              <p className="text-xs text-muted-foreground" data-testid="text-entity-name">{data.entityName}</p>
            )}
          </div>

          <Separator />

          <div className="space-y-1 text-sm">
            {data.costBreakdown?.annualCostBeforeDiscounts != null && data.costBreakdown.annualCostBeforeDiscounts !== data.costBreakdown.annualCost && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">Annual cost (before discounts)</span>
                <span>{formatCurrency(data.costBreakdown.annualCostBeforeDiscounts, data.currency)}</span>
              </div>
            )}

            {data.costBreakdown?.customDiscountTotal > 0 && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">Discount</span>
                <span className="text-green-600">-{formatCurrency(data.costBreakdown.customDiscountTotal, data.currency)}</span>
              </div>
            )}

            <div className="flex justify-between flex-wrap gap-1">
              <span className="text-muted-foreground">Annual cost</span>
              <span>{formatCurrency(data.costBreakdown?.annualCost ?? data.finalCost, data.currency)}</span>
            </div>

            {data.costBreakdown?.proRataEnabled && data.costBreakdown.prorataCost != null && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">
                  Pro-rata{data.costBreakdown.prorataDays != null ? ` (${data.costBreakdown.prorataDays} days)` : ''}
                </span>
                <span>{formatCurrency(data.costBreakdown.prorataCost, data.currency)}</span>
              </div>
            )}

            {data.costBreakdown?.freeDiscount > 0 && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">Free period discount</span>
                <span className="text-green-600">-{formatCurrency(data.costBreakdown.freeDiscount, data.currency)}</span>
              </div>
            )}

            {data.costBreakdown?.rolloverDiscount > 0 && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">Rollover discount</span>
                <span className="text-green-600">-{formatCurrency(data.costBreakdown.rolloverDiscount, data.currency)}</span>
              </div>
            )}

            <Separator />

            <div className="flex justify-between flex-wrap gap-1 font-medium">
              <span>Subtotal</span>
              <span>{formatCurrency(data.finalCost, data.currency)}</span>
            </div>

            {data.vatRatePercent > 0 && (
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-muted-foreground">VAT ({data.vatRatePercent}%)</span>
                <span>{formatCurrency(data.vatAmount, data.currency)}</span>
              </div>
            )}

            <div className="flex justify-between flex-wrap gap-1 font-semibold text-base pt-1">
              <span>Total</span>
              <span data-testid="text-total-amount">{formatCurrency(payableAmount, data.currency)}</span>
            </div>
          </div>
        </div>

        {data.approvalPending && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-md border border-amber-200 dark:border-amber-800">
            <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-800 dark:text-amber-300">{data.approvalMessage}</p>
          </div>
        )}

        {belowMinimum && !data.approvalPending && (
          <div className="flex items-start gap-2 p-3 bg-muted rounded-md">
            <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground">
              The amount is below the minimum for online payment. Please contact your administrator.
            </p>
          </div>
        )}

        {paymentError && (
          <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-md border border-destructive/20">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{paymentError}</p>
          </div>
        )}

        {!data.approvalPending && !belowMinimum && data.stripeEnabled && !paymentMode && (
          <Button
            onClick={initStripe}
            disabled={disabled || creatingPayment}
            className="w-full"
            data-testid={`button-pay-membership-${field.id}`}
          >
            {creatingPayment ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Preparing payment...
              </>
            ) : (
              <>
                <CreditCard className="mr-2 h-4 w-4" />
                Pay {formatCurrency(payableAmount, data.currency)}
              </>
            )}
          </Button>
        )}

        {!data.stripeEnabled && !data.approvalPending && (
          <div className="flex items-start gap-2 p-3 bg-muted rounded-md">
            <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground">
              Online payment is not currently available. Please contact your administrator.
            </p>
          </div>
        )}

        {paymentMode === 'stripe' && (
          <div className="space-y-3">
            <div
              id={`form-stripe-payment-element-${field.id}`}
              className="min-h-[100px] border rounded-md p-3"
              data-testid={`stripe-element-${field.id}`}
            />
            <Button
              onClick={handleStripePayment}
              disabled={processingPayment}
              className="w-full"
              data-testid={`button-confirm-payment-${field.id}`}
            >
              {processingPayment ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing payment...
                </>
              ) : (
                `Confirm payment of ${formatCurrency(payableAmount, data.currency)}`
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
