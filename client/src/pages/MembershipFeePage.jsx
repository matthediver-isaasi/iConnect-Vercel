import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Loader2, CheckCircle2, FileText, CreditCard, ClipboardList,
  AlertCircle, Building2
} from "lucide-react";

function formatCurrency(amount, currency) {
  const symbols = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };
  const symbol = symbols[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

export default function MembershipFeePage() {
  const { token } = useParams();
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

  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const cardRef = useRef(null);

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
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
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
      setPoSubmitted(true);
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setSubmittingPo(false);
    }
  };

  const initStripe = async () => {
    if (!data?.stripePublishableKey) return;
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
                {formatCurrency(data?.finalCost, data?.currency)}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const breakdown = data?.costBreakdown || {};

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
              <Building2 className="w-5 h-5" style={{ color: primaryColor }} />
              <h1 className="text-lg font-semibold">Membership Fee</h1>
            </div>

            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-500">Organisation</span>
              <span className="font-medium" data-testid="text-org-name">{data?.organizationName}</span>
            </div>
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
                <span className="text-gray-500">Free Period Discount</span>
                <span className="text-green-600">-{formatCurrency(breakdown.freeDiscount, data?.currency)}</span>
              </div>
            )}

            <Separator className="my-3" />

            <div className="flex items-center justify-between">
              <span className="font-medium">Total Due</span>
              <span className="text-2xl font-bold" style={{ color: primaryColor }} data-testid="text-total">
                {formatCurrency(data?.finalCost, data?.currency)}
              </span>
            </div>
          </CardContent>
        </Card>

        {!poSubmitted && paymentMode !== 'stripe' && (
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
            </CardContent>
          </Card>
        )}

        {data?.stripeEnabled && !paymentComplete && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-3">
                <CreditCard className="w-4 h-4" style={{ color: primaryColor }} />
                <h2 className="font-medium">Pay Now</h2>
              </div>

              {paymentMode !== 'stripe' ? (
                <>
                  <p className="text-sm text-gray-500 mb-3">
                    Pay your membership fee immediately by card. Your membership will be activated once payment is confirmed.
                  </p>
                  <Button
                    onClick={initStripe}
                    disabled={creatingPayment}
                    className="w-full"
                    style={{ background: primaryColor }}
                    data-testid="button-pay-now"
                  >
                    {creatingPayment ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <CreditCard className="w-4 h-4 mr-2" />
                    )}
                    Pay {formatCurrency(data?.finalCost, data?.currency)}
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
                    {processingPayment ? 'Processing...' : `Confirm Payment - ${formatCurrency(data?.finalCost, data?.currency)}`}
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
