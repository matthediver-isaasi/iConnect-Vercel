import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import GoCardlessDropinFlow from "@/components/gocardless/GoCardlessDropinFlow";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Loader2, CheckCircle2, FileText, CreditCard, ClipboardList,
  AlertCircle, Building2, Landmark, User
} from "lucide-react";

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

export default function MembershipFeePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [poNumber, setPoNumber] = useState('');
  const [submittingPo, setSubmittingPo] = useState(false);
  const [poSubmitted, setPoSubmitted] = useState(false);
  const [invoiceLink, setInvoiceLink] = useState(null);
  const [invoiceNumber, setInvoiceNumber] = useState(null);

  const [paymentMode, setPaymentMode] = useState(null);
  const [creatingPayment, setCreatingPayment] = useState(false);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [completingRedirectPayment, setCompletingRedirectPayment] = useState(false);

  const [startingDd, setStartingDd] = useState(false);
  const [ddStarted, setDdStarted] = useState(false);
  const [ddBanner, setDdBanner] = useState(null); // 'complete' | 'cancelled'
  const [startingCardMonthly, setStartingCardMonthly] = useState(false);
  const [cardBanner, setCardBanner] = useState(null); // 'success' | 'cancelled'
  // GoCardless Drop-in modal state: { flowId, environment, authorisationUrl }
  const [ddDropin, setDdDropin] = useState(null);

  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const cardRef = useRef(null);
  const redirectHandled = useRef(false);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/public/membership-fees/${token}`)
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
        if (result.status === 'paid') {
          setPaymentComplete(true);
        }
        if (result.status === 'po_submitted') {
          setPoSubmitted(true);
          setPoNumber(result.poNumber || '');
        }
        if (result.xeroInvoiceNumber) setInvoiceNumber(result.xeroInvoiceNumber);
        if (result.xeroOnlineInvoiceUrl) setInvoiceLink(result.xeroOnlineInvoiceUrl);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  // Handle 3D Secure redirect return
  useEffect(() => {
    if (!token || redirectHandled.current) return;

    const urlParams = new URLSearchParams(window.location.search);
    const paymentIntentFromUrl = urlParams.get('payment_intent');
    const redirectStatus = urlParams.get('redirect_status');

    // Direct Debit hosted-flow return (?dd=complete / ?dd=cancelled)
    const ddParam = urlParams.get('dd');
    if (ddParam === 'complete' || ddParam === 'cancelled') {
      setDdBanner(ddParam);
      const cleaned = new URLSearchParams(window.location.search);
      cleaned.delete('dd');
      const s = cleaned.toString();
      window.history.replaceState({}, '', window.location.pathname + (s ? '?' + s : ''));
    }

    // Monthly card Checkout return (?card=success / ?card=cancelled)
    const cardParam = urlParams.get('card');
    if (cardParam === 'success' || cardParam === 'cancelled') {
      setCardBanner(cardParam);
      const cleaned = new URLSearchParams(window.location.search);
      cleaned.delete('card');
      const s = cleaned.toString();
      window.history.replaceState({}, '', window.location.pathname + (s ? '?' + s : ''));
    }

    if (!paymentIntentFromUrl) return;

    redirectHandled.current = true;
    console.log('[MembershipFeePage] Detected 3D Secure return:', { paymentIntentFromUrl, redirectStatus });

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

    setCompletingRedirectPayment(true);

    const completePayment = async () => {
      try {
        const confirmRes = await fetch(`/api/public/membership-fees/${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirm_payment', paymentIntentId: paymentIntentFromUrl }),
        });

        if (!confirmRes.ok) {
          const err = await confirmRes.json().catch(() => ({}));
          throw new Error(err.error || 'Your card payment was successful, but we could not finish updating your membership record. It will be reconciled automatically — please do NOT pay again.');
        }

        const body = await confirmRes.json().catch(() => ({}));
        if (body.xeroInvoiceNumber) setInvoiceNumber(body.xeroInvoiceNumber);
        if (body.xeroOnlineInvoiceUrl) setInvoiceLink(body.xeroOnlineInvoiceUrl);
        setPaymentComplete(true);
      } catch (err) {
        setPaymentError(err.message);
      } finally {
        setCompletingRedirectPayment(false);
      }
    };

    completePayment();
  }, [token]);

  const handleSubmitPo = async () => {
    if (!poNumber.trim()) return;
    setSubmittingPo(true);
    try {
      const res = await fetch(`/api/public/membership-fees/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit_po', poNumber: poNumber.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to submit PO number');
      }
      const body = await res.json().catch(() => ({}));
      if (body.xeroInvoiceNumber) setInvoiceNumber(body.xeroInvoiceNumber);
      if (body.xeroOnlineInvoiceUrl) setInvoiceLink(body.xeroOnlineInvoiceUrl);
      setPoSubmitted(true);
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setSubmittingPo(false);
    }
  };

  const handleStartDirectDebit = async () => {
    setStartingDd(true);
    setPaymentError(null);
    try {
      const res = await fetch(`/api/public/membership-fees/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start_direct_debit' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || 'Failed to start Direct Debit set-up');
      }
      if (body.authorisationUrl) {
        if (body.flowId) {
          // Open the GoCardless Drop-in modal on-page; hosted redirect stays
          // as the automatic fallback if the widget fails to load.
          setDdDropin({
            flowId: body.flowId,
            environment: body.environment || 'sandbox',
            authorisationUrl: body.authorisationUrl,
          });
          return;
        }
        window.location.href = body.authorisationUrl;
        return;
      }
      // Reused mandate or already in progress — no hosted flow needed.
      setDdStarted(true);
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setStartingDd(false);
    }
  };

  const handleStartMonthlyCard = async () => {
    setStartingCardMonthly(true);
    setPaymentError(null);
    try {
      const res = await fetch(`/api/public/membership-fees/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start_monthly_card' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || 'Failed to start monthly card set-up');
      }
      if (body.checkoutUrl) {
        window.location.href = body.checkoutUrl;
        return;
      }
      setCardBanner('success');
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setStartingCardMonthly(false);
    }
  };

  const initStripe = async () => {
    if (!data?.stripePublishableKey) return;
    if (isBelowStripeMinimum(data?.totalWithVat || data?.finalCost, data?.currency)) return;
    setCreatingPayment(true);
    setPaymentError(null);

    try {
      const res = await fetch(`/api/public/membership-fees/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_payment' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to initialize payment');
      }
      const { clientSecret } = await res.json();

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
      cardRef.current = cardElement;

      setTimeout(() => {
        const container = document.getElementById('stripe-payment-element');
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
        const confirmRes = await fetch(`/api/public/membership-fees/${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirm_payment', paymentIntentId: paymentIntent.id }),
        });

        if (!confirmRes.ok) {
          const err = await confirmRes.json().catch(() => ({}));
          throw new Error(err.error || 'Your card payment was successful, but we could not finish updating your membership record. It will be reconciled automatically — please do NOT pay again.');
        }

        const confirmBody = await confirmRes.json().catch(() => ({}));
        if (confirmBody.xeroInvoiceNumber) setInvoiceNumber(confirmBody.xeroInvoiceNumber);
        if (confirmBody.xeroOnlineInvoiceUrl) setInvoiceLink(confirmBody.xeroOnlineInvoiceUrl);
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
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <Loader2 className="w-10 h-10 mx-auto mb-4 animate-spin text-blue-600" />
            <h2 className="text-lg font-semibold mb-2">Completing Your Payment</h2>
            <p className="text-sm text-gray-500">Your payment has been verified. We're confirming your membership now...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-12 h-12 mx-auto mb-4 text-red-500" />
            <h2 className="text-lg font-semibold mb-2">Unable to Load</h2>
            <p className="text-sm text-gray-500">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (paymentComplete || data?.status === 'paid') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            {data?.tenant?.logoUrl && (
              <img src={data.tenant.logoUrl} alt={data.tenant.name} className="h-12 mx-auto mb-4" />
            )}
            <CheckCircle2 className="w-16 h-16 mx-auto mb-4" style={{ color: primaryColor }} />
            <h2 className="text-xl font-semibold mb-2">Payment Complete</h2>
            <p className="text-gray-500 mb-4">
              Your membership fee for {data?.membershipYear} has been received.
            </p>
            <div className="p-3 rounded-md bg-gray-50 border">
              <p className="text-sm text-gray-600">Amount Paid</p>
              <p className="text-2xl font-bold" style={{ color: primaryColor }}>
                {formatCurrency(data?.totalWithVat || data?.finalCost, data?.currency)}
              </p>
            </div>
            {(invoiceLink || invoiceNumber) && (
              <div className="mt-4 p-3 rounded-md border bg-white text-left">
                <p className="text-sm text-gray-600 mb-1">
                  {invoiceNumber ? `Invoice ${invoiceNumber}` : 'Your Xero invoice is available online.'}
                </p>
                {invoiceLink ? (
                  <a
                    href={invoiceLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium"
                    style={{ color: primaryColor }}
                    data-testid="link-xero-invoice-paid"
                  >
                    <FileText className="w-4 h-4" /> View invoice
                  </a>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const breakdown = data?.costBreakdown || {};
  const renewalBlocked = data?.renewalAvailable === false;

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-lg mx-auto space-y-4">
        {data?.tenant && (
          <div className="text-center py-4">
            {data.tenant.logoUrl && (
              <img src={data.tenant.logoUrl} alt={data.tenant.name} className="h-10 mx-auto mb-2" />
            )}
            <p className="text-sm text-gray-500">{data.tenant.name}</p>
          </div>
        )}

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-4">
              {data?.isMember
                ? <User className="w-5 h-5" style={{ color: primaryColor }} />
                : <Building2 className="w-5 h-5" style={{ color: primaryColor }} />}
              <h1 className="text-lg font-semibold">Membership Fee</h1>
            </div>

            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-500">{data?.isMember ? 'Member' : 'Organisation'}</span>
              <span className="font-medium" data-testid="text-org-name">{data?.isMember ? (data?.memberName || data?.organizationName) : data?.organizationName}</span>
            </div>
            {data?.renewalLifecycle && (
              <div className="mt-2 text-xs text-gray-500">
                Membership term: {data.renewalLifecycle.termStart} to {data.renewalLifecycle.termEnd}.
                {data.renewalLifecycle.isEarly ? ` Payment is being scheduled for activation on ${data.renewalLifecycle.termStart}.` : ''}
              </div>
            )}
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-500">Period</span>
              <span className="font-medium" data-testid="text-period">{data?.membershipYear}</span>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-500">Tier</span>
              <Badge variant="secondary" data-testid="text-tier">{data?.tierLabel || 'Standard'}</Badge>
            </div>

            <Separator className="my-3" />

            {breakdown.annualCostBeforeDiscounts != null && breakdown.customDiscountTotal > 0 && (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Gross Cost</span>
                  <span>{formatCurrency(breakdown.annualCostBeforeDiscounts, data?.currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Discount</span>
                  <span className="text-green-600">-{formatCurrency(breakdown.customDiscountTotal, data?.currency)}</span>
                </div>
              </>
            )}

            {breakdown.annualCost != null && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Net Cost</span>
                <span>{formatCurrency(breakdown.annualCost, data?.currency)}</span>
              </div>
            )}

            {breakdown.proRataEnabled && breakdown.prorataDays != null && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Pro-rata ({breakdown.prorataDays} days)</span>
                <span>{formatCurrency(breakdown.prorataCost, data?.currency)}</span>
              </div>
            )}

            {breakdown.freeDiscount > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">
                  {breakdown.freePeriodUnit === 'percent'
                    ? `New Member Discount (${breakdown.freePeriodAmount}%)${breakdown.yearNumber === 2 ? ' (rollover from Y1)' : ''}`
                    : breakdown.yearNumber === 2 && breakdown.freeDiscount > 0
                      ? `New Member Discount (${breakdown.freePeriodDaysApplied} days rollover)`
                      : `New Member Discount (${breakdown.freePeriodDaysApplied} free days${breakdown.dailyCost ? ` \u00d7 ${formatCurrency(breakdown.dailyCost, data?.currency)}` : ''})`}
                </span>
                <span className="text-green-600">-{formatCurrency(breakdown.freeDiscount, data?.currency)}</span>
              </div>
            )}

            {Array.isArray(data?.addonLines) && data.addonLines.map((line, idx) => (
              <div key={idx} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-500" data-testid={`text-addon-label-${idx}`}>
                  {line.description}{(Number(line.quantity) || 1) > 1 ? ` (\u00d7${line.quantity})` : ''}
                </span>
                <span data-testid={`text-addon-amount-${idx}`}>{formatCurrency(line.line_total, data?.currency)}</span>
              </div>
            ))}

            {data?.vatAmount > 0 && (
              <>
                <Separator className="my-3" />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Net Amount</span>
                  <span>{formatCurrency(data?.finalCost, data?.currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">VAT{data?.vatRatePercent > 0 ? ` (${data.vatRatePercent}%)` : ''}</span>
                  <span data-testid="text-vat">{formatCurrency(data.vatAmount, data?.currency)}</span>
                </div>
              </>
            )}

            <Separator className="my-3" />

            <div className="flex items-center justify-between">
              <span className="font-medium">Total Due{data?.vatAmount > 0 ? ' (incl. VAT)' : ''}</span>
              <span className="text-2xl font-bold" style={{ color: primaryColor }} data-testid="text-total">
                {formatCurrency(data?.totalWithVat || data?.finalCost, data?.currency)}
              </span>
            </div>
          </CardContent>
        </Card>
        {renewalBlocked && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200" data-testid="banner-renewal-unavailable">
            <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-700">{data?.renewalMessage}</p>
          </div>
        )}

        {!renewalBlocked && !poSubmitted && paymentMode !== 'stripe' && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-3">
                <ClipboardList className="w-4 h-4" style={{ color: primaryColor }} />
                <h2 className="font-medium">Purchase Order Number</h2>
              </div>
              <p className="text-sm text-gray-500 mb-3">
                If your organisation requires a purchase order for this payment, enter it here.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  placeholder="e.g. PO-12345"
                  data-testid="input-public-po"
                />
                <Button
                  onClick={handleSubmitPo}
                  disabled={submittingPo || !poNumber.trim()}
                  style={{ background: primaryColor }}
                  data-testid="button-submit-po"
                >
                  {submittingPo ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Submit'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {poSubmitted && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="w-5 h-5" />
                <span className="font-medium">Purchase Order Submitted</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                PO Number: <span className="font-medium text-gray-700">{poNumber}</span>
              </p>
              {(invoiceLink || invoiceNumber) && (
                <div className="mt-3 pt-3 border-t">
                  <p className="text-sm text-gray-600 mb-1">
                    {invoiceNumber ? `Invoice ${invoiceNumber}` : 'Your Xero invoice is available online.'}
                  </p>
                  {invoiceLink ? (
                    <a
                      href={invoiceLink}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm font-medium"
                      style={{ color: primaryColor }}
                      data-testid="link-xero-invoice-po"
                    >
                      <FileText className="w-4 h-4" /> View invoice
                    </a>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {ddDropin && (
          <GoCardlessDropinFlow
            flowId={ddDropin.flowId}
            environment={ddDropin.environment}
            onSuccess={() => {
              setDdDropin(null);
              setDdBanner('complete');
            }}
            onExit={() => {
              setDdDropin(null);
              setDdBanner('cancelled');
            }}
            onLoadFailure={() => {
              // Fall back to the hosted redirect flow.
              window.location.href = ddDropin.authorisationUrl;
            }}
          />
        )}

        {ddBanner === 'complete' && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="w-5 h-5" />
                <span className="font-medium">Direct Debit Set-Up Complete</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                Thank you — your Direct Debit mandate is being confirmed by your bank. Your membership payments will be collected monthly and no further action is needed.
              </p>
            </CardContent>
          </Card>
        )}

        {ddBanner === 'cancelled' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-700">Direct Debit set-up was cancelled. You can try again below, or use another payment option.</p>
          </div>
        )}

        {ddStarted && ddBanner !== 'complete' && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="w-5 h-5" />
                <span className="font-medium">Direct Debit In Progress</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                Your existing Direct Debit mandate has been reused — your monthly payments have been scheduled.
              </p>
            </CardContent>
          </Card>
        )}

        {cardBanner === 'success' && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="w-5 h-5" />
                <span className="font-medium">Monthly Card Payments Set Up</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                Thank you — your card has been saved securely with Stripe and your membership will be collected in monthly instalments. No further action is needed.
              </p>
            </CardContent>
          </Card>
        )}

        {cardBanner === 'cancelled' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-700">Monthly card set-up was cancelled. You can try again below, or use another payment option.</p>
          </div>
        )}

        {data?.renewal?.status === 'notice_sent' && data?.renewal?.mode === 'confirm' && !paymentComplete && cardBanner !== 'success' && ddBanner !== 'complete' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-blue-50 border border-blue-200" data-testid="banner-renewal-awaiting-confirmation">
            <AlertCircle className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
            <p className="text-sm text-blue-700">
              Your monthly {data.renewal.provider === 'stripe' ? 'card payment' : 'Direct Debit'} plan is ready to renew for this membership year.
              Confirm your renewal by setting up your monthly plan below — {data.renewal.provider === 'stripe' ? 'your saved card details can be reused' : 'your existing Direct Debit mandate will be reused'}.
            </p>
          </div>
        )}

        {data?.renewal?.status === 'failed' && !paymentComplete && cardBanner !== 'success' && ddBanner !== 'complete' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 border border-red-200" data-testid="banner-renewal-failed">
            <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <p className="text-sm text-red-700">
              We couldn't renew your monthly {data.renewal.provider === 'stripe' ? 'card payment' : 'Direct Debit'} plan automatically
              {data.renewal.provider === 'stripe' ? ' — your saved card could not be charged' : ''}.
              Your membership has not been renewed yet. Please choose a payment option below{data.renewal.provider === 'stripe' ? ' to pay with an up-to-date card' : ''}, or contact us for help.
            </p>
          </div>
        )}

        {data?.cardMonthlyEnabled && !paymentComplete && cardBanner !== 'success' && !ddStarted && ddBanner !== 'complete' && !data?.cardStatus?.hasSubscription && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-3">
                <CreditCard className="w-4 h-4" style={{ color: primaryColor }} />
                <h2 className="font-medium">Pay Monthly by Card</h2>
              </div>
              <p className="text-sm text-gray-500 mb-3">
                Spread your membership fee over {data?.cardMonthly?.instalmentCount || 12} monthly card payments of{' '}
                <span className="font-medium text-gray-700">{formatCurrency(data?.cardMonthly?.monthlyAmount, data?.cardMonthly?.currency || data?.currency)}</span>
                {data?.cardMonthly?.planTotal ? <> (total {formatCurrency(data.cardMonthly.planTotal, data?.cardMonthly?.currency || data?.currency)})</> : null}.
                You'll be taken to a secure Stripe page to enter your card details — they never touch our servers.
              </p>
              <Button
                onClick={handleStartMonthlyCard}
                disabled={startingCardMonthly}
                variant="outline"
                className="w-full"
                data-testid="button-setup-monthly-card"
              >
                {startingCardMonthly ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <CreditCard className="w-4 h-4 mr-2" />
                )}
                Set Up Monthly Card Payments
              </Button>
            </CardContent>
          </Card>
        )}

        {data?.ddEnabled && !paymentComplete && !ddStarted && ddBanner !== 'complete' && cardBanner !== 'success' && !data?.cardStatus?.hasSubscription && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-3">
                <Landmark className="w-4 h-4" style={{ color: primaryColor }} />
                <h2 className="font-medium">Pay Monthly by Direct Debit</h2>
              </div>
              <p className="text-sm text-gray-500 mb-3">
                Spread your membership fee over {data?.ddOffer?.instalmentCount || 12} monthly payments of{' '}
                <span className="font-medium text-gray-700">{formatCurrency(data?.ddOffer?.monthlyAmount, data?.ddOffer?.currency || data?.currency)}</span>
                {data?.ddOffer?.planTotal ? <> (total {formatCurrency(data.ddOffer.planTotal, data?.ddOffer?.currency || data?.currency)})</> : null}.
                You'll be taken to our secure Direct Debit provider to set up your mandate.
              </p>
              <Button
                onClick={handleStartDirectDebit}
                disabled={startingDd}
                variant="outline"
                className="w-full"
                data-testid="button-setup-direct-debit"
              >
                {startingDd ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Landmark className="w-4 h-4 mr-2" />
                )}
                Set Up Direct Debit
              </Button>
            </CardContent>
          </Card>
        )}

        {data?.stripeEnabled && !paymentComplete && data?.openPlan && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: primaryColor }} />
                <p className="text-sm text-gray-600" data-testid="text-open-plan-blocks-annual">
                  A monthly payment plan {data.openPlan.provider === 'stripe' ? 'by card' : 'by Direct Debit'} is already in place for this membership year, so the one-off annual payment is unavailable. Please contact your administrator if you need to change how you pay.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {data?.stripeEnabled && !paymentComplete && !data?.openPlan && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-3">
                <CreditCard className="w-4 h-4" style={{ color: primaryColor }} />
                <h2 className="font-medium">Pay Now</h2>
              </div>

              {paymentMode !== 'stripe' ? (
                <>
                  {isBelowStripeMinimum(data?.totalWithVat || data?.finalCost, data?.currency) ? (
                    <p className="text-sm text-gray-500 mb-3">
                      Online payment is not available as the amount is below the minimum that can be processed by card ({formatCurrency(STRIPE_MINIMUMS[data?.currency] || 0.50, data?.currency)}).
                    </p>
                  ) : (
                    <p className="text-sm text-gray-500 mb-3">
                      Pay your membership fee immediately by card.{data?.vatRatePercent > 0 ? ` The amount includes VAT at ${data.vatRatePercent}%.` : ''} Your membership will be activated once payment is confirmed.
                    </p>
                  )}
                  <Button
                    onClick={initStripe}
                    disabled={creatingPayment || isBelowStripeMinimum(data?.totalWithVat || data?.finalCost, data?.currency)}
                    className="w-full"
                    style={{ background: isBelowStripeMinimum(data?.totalWithVat || data?.finalCost, data?.currency) ? '#9ca3af' : primaryColor }}
                    data-testid="button-pay-now"
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
                  <div id="stripe-payment-element" className="min-h-[200px] border rounded-md p-3" />

                  {paymentError && (
                    <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 border border-red-200">
                      <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                      <p className="text-sm text-red-700">{paymentError}</p>
                    </div>
                  )}

                  <Button
                    onClick={handleStripePayment}
                    disabled={processingPayment}
                    className="w-full"
                    style={{ background: primaryColor }}
                    data-testid="button-confirm-payment"
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

        {paymentError && paymentMode !== 'stripe' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 border border-red-200">
            <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <p className="text-sm text-red-700">{paymentError}</p>
          </div>
        )}
      </div>
    </div>
  );
}
