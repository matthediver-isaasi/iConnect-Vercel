import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { membershipCreditEstimate } from "../lib/membershipCreditEstimate";
import { VoucherExpiry } from "@/components/vouchers/VoucherPresentation";
import GoCardlessDropinFlow from "@/components/gocardless/GoCardlessDropinFlow";
import { directDebitHasFixedTermTotal, directDebitCollectionPolicy } from "@/lib/directDebitConsentSummary";
import { membershipPeriod, membershipHeading, annualMembershipFeeLabel, memberDate, activationText, memberDirectDebitPolicy as directDebitPolicyText, memberFirstCollection as directDebitFirstCollectionText, reusesDirectDebit, creditOwnerLabel } from "@/lib/membershipFeeCopy";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Loader2, CheckCircle2, FileText, CreditCard, ClipboardList,
  AlertCircle, Building2, Landmark, User
} from "lucide-react";

function formatCurrency(amount, currency) {
  if (amount != null && !Number.isFinite(Number(amount))) return 'Not supplied';
  const symbols = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };
  const symbol = symbols[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

const STRIPE_MINIMUMS = { GBP: 0.30, USD: 0.50, EUR: 0.50, AUD: 0.50, NZD: 0.50 };

function isBelowStripeMinimum(amount, currency) {
  const min = STRIPE_MINIMUMS[currency] || 0.50;
  return parseFloat(amount || 0) < min;
}
const savedModeLabel = mode => ({ member_choice: 'Choose your payment method', stripe_upfront: 'One-off card payment', stripe_monthly: 'Monthly card payments', direct_debit: 'Monthly Direct Debit', invoice: 'Invoice', free: 'Free membership' })[mode] || 'Unavailable payment method';
const completeMonthlyOffer = (offer, mode) => {
  if (!offer || !/^[A-Z]{3}$/.test(offer.currency || '') || !offer.activationRule) return false;
  const dynamic = mode === 'direct_debit' && directDebitCollectionPolicy(offer)?.pricing_policy === 'dynamic';
  const required = dynamic ? ['monthlyAmount'] : ['monthlyAmount', 'instalmentCount', 'planTotal'];
  return required.every(key => offer[key] != null && offer[key] !== '' && Number.isFinite(Number(offer[key])) && Number(offer[key]) > 0) &&
    (dynamic || Number.isInteger(Number(offer.instalmentCount)));
};

// Display the server's allocation, never derive a future charge from quote totals.
function VariableCreditSummary({ credit, instalmentCount, offer, currency, estimate }) {
  const count = Number(instalmentCount ?? credit.creditSchedule?.length);
  const first = Array.isArray(credit.creditSchedule) ? credit.creditSchedule.find(row => row?.ordinal === 1) : null;
  const total = Array.isArray(credit.allocations) ? credit.allocations.reduce((sum, row) => sum + row?.amountMinor, 0) : null;
  return <div className="text-sm space-y-1" data-testid="variable-credit-summary">
    {Number.isSafeInteger(total) && <p>Total selected credit: {formatCurrency(total / 100, currency)}.</p>}
    {Number.isInteger(count) && count > 0
      ? <p>Your credit is spread over {count} monthly payments in this membership period, not used all at once.</p>
      : <p>We’ll confirm how your credit is spread over this membership period. Please contact the membership team for the allocation details.</p>}
    {Number.isSafeInteger(first?.allocatedCreditMinor)
      ? <p>Credit towards your first month: {formatCurrency(first.allocatedCreditMinor / 100, currency)}.</p>
      : <p>We can’t confirm the credit towards your first month yet. Please contact the membership team for details.</p>}
    {offer?.monthlyAmount != null && offer.monthlyAmount !== '' && Number.isFinite(Number(offer.monthlyAmount)) && <p>Current monthly payment estimate before credit: {formatCurrency(offer.monthlyAmount, offer.currency || currency)}.</p>}
    {estimate ? <>
      <p className="font-medium">Estimated first monthly payment after credit: {formatCurrency(estimate.firstCashMinor / 100, currency)}.</p>
      <p>Later monthly amounts may differ by pennies as credit is spread across the period.</p>
      {estimate.unusedCreditMinor > 0 && <p>At current rates, {formatCurrency(estimate.unusedCreditMinor / 100, currency)} of selected credit cannot be used and will be returned with its original expiry date.</p>}
    </> : <p>We can’t confirm an after-credit payment estimate yet. Please review a current quote with complete payment details.</p>}
    <p>Your monthly fees and payments may change. These estimates are not a fixed total for this membership period.</p>
    <p>Credit applies only to this membership period, not future renewals. Any unused credit is returned with its original expiry date.</p>
    <p>You still need to continue with Direct Debit for future payments, even if the current estimate after credit is zero.</p>
  </div>;
}

export default function MembershipFeePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [dataToken, setDataToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectingMethod, setSelectingMethod] = useState(null);
  const [selectionError, setSelectionError] = useState(null);
  const [personalCredit, setPersonalCredit] = useState(null);
  const [creditDiscovery, setCreditDiscovery] = useState('idle');
  const [creditDiscoveryError, setCreditDiscoveryError] = useState(null);
  const [creditError, setCreditError] = useState(null);
  const [creditSelection, setCreditSelection] = useState([]);
  const [creditQuote, setCreditQuote] = useState(null);
  const [creditPaymentMode, setCreditPaymentMode] = useState('stripe_upfront');
  const [requoteUpfront, setRequoteUpfront] = useState(false);
  const [quotingCredit, setQuotingCredit] = useState(false);
  const quoteRevision = useRef(0);
  const [estimateNow, setEstimateNow] = useState(Date.now);
  useEffect(() => {
    const expiry = Date.parse(creditQuote?.expiresAt);
    if (!Number.isFinite(expiry)) return;
    const timer = setTimeout(() => setEstimateNow(Date.now()), Math.max(0, Math.min(expiry - Date.now() + 1, 2147483647)));
    return () => clearTimeout(timer);
  }, [creditQuote]);
  const creditEstimate = membershipCreditEstimate({
    funding: data?.voucherFunding, quote: creditQuote, offer: data?.ddOffer,
    currency: data?.currency, instalmentCount: data?.voucherMonthly?.instalmentCount,
    now: Math.max(estimateNow, Date.now()),
  });
  const quoteCurrent = creditQuote && Number.isFinite(Date.parse(creditQuote.expiresAt)) && Date.parse(creditQuote.expiresAt) > Math.max(estimateNow, Date.now());
  const displayPayableAmount = creditEstimate && !creditEstimate.variable ? creditEstimate.cashMinor / 100 : (data?.totalWithVat ?? data?.finalCost);
  const displayMonthlyMode = creditEstimate && !creditEstimate.variable && creditEstimate.count
    ? (data?.voucherMonthly?.paymentMode || creditQuote?.paymentMode) : null;
  const payableAmount = data?.voucherFunding
    ? data.voucherFunding.remainingMinor / 100
    : creditQuote ? creditQuote.cashMinor / 100 : (data?.totalWithVat ?? data?.finalCost);
  const variableCredit = data?.voucherFunding?.variableCredit === true ||
    creditQuote?.monthlySnapshot?.collection_policy?.pricing_policy === 'dynamic';
  const creditOnly = !variableCredit && (data?.voucherFunding || creditQuote) && payableAmount === 0;
  const creditMonthly = creditQuote?.monthlySnapshot ? {
    paymentMode: creditQuote.paymentMode, instalmentCount: creditQuote.monthlySnapshot.instalment_count,
  } : data?.voucherMonthly;
  const selectedCreditMode = data?.memberStart?.paymentMode || data?.voucherRequote?.paymentMode || creditPaymentMode;
  const creditPerMonth = creditEstimate && !creditEstimate.variable ? creditEstimate.monthlyMinor / 100 : null;
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setPersonalCredit(null);
    setCreditDiscovery('idle');
    setCreditDiscoveryError(null);
    setCreditSelection([]);
    quoteRevision.current += 1;
    setQuotingCredit(false);
    setCreditQuote(null);
    setCreditError(null);
    if (!token || dataToken !== token || !data || data.status !== 'pending') return;
    setCreditDiscovery('loading');
    fetch(`/api/public/membership-fees/${encodeURIComponent(token)}?action=vouchers`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to load membership credit');
        if (current) {
          setPersonalCredit(result);
          setCreditDiscovery('success');
        }
      })
      .catch(err => {
        if (current) {
          setCreditDiscoveryError(err.message);
          setCreditDiscovery('error');
        }
      });
    return () => { current = false; controller.abort(); };
  }, [token, dataToken, data?.isMember, data?.status]);

  async function previewPersonalCredit() {
    const revision = ++quoteRevision.current;
    setQuotingCredit(true);
    setCreditError(null);
    setCreditQuote(null);
    try {
      const response = await fetch(`/api/public/membership-fees/${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'quote_vouchers', voucherIds: creditSelection, paymentMode: selectedCreditMode }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to quote credit');
      if (revision === quoteRevision.current) setCreditQuote(result.quote);
    } catch (err) {
      if (revision === quoteRevision.current) setCreditError(err.message);
    } finally {
      if (revision === quoteRevision.current) setQuotingCredit(false);
    }
  }

  async function clearPersonalCredit() {
    quoteRevision.current += 1;
    setQuotingCredit(true);
    setCreditError(null);
    try {
      if (data?.voucherFunding) {
        const response = await fetch(`/api/public/membership-fees/${encodeURIComponent(token)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'release_vouchers' }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Credit cannot yet be released');
        cardRef.current?.unmount();
        setPaymentMode(null);
        const refreshed = await fetch(`/api/public/membership-fees/${encodeURIComponent(token)}`);
        if (!refreshed.ok) throw new Error('Credit was released. Reload the fee page before continuing.');
        setData(await refreshed.json());
      }
      setCreditQuote(null);
      setCreditSelection([]);
    } catch (err) {
      setCreditError(err.message);
    } finally {
      setQuotingCredit(false);
    }
  }

  async function regenerateCreditQuote(mode = selectedCreditMode) {
    setQuotingCredit(true);
    setCreditError(null);
    try {
      const response = await fetch(`/api/public/membership-fees/${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate_voucher_quote', paymentMode: mode }),
      });
      const result = await response.json();
      if (!response.ok) {
        setRequoteUpfront(result.code === 'use_original_upfront_quote');
        throw new Error(result.error || 'Could not create a replacement quote');
      }
      if (!result.replacementUrl) throw new Error('Replacement quote link was not confirmed');
      window.location.assign(result.replacementUrl);
    } catch (err) { setCreditError(err.message); }
    finally { setQuotingCredit(false); }
  }
  const selectingMethodRef = useRef(false);
  // Copy only: only a successful choice made here establishes who chose it.
  // A saved method may have been selected by an administrator.
  const memberChosenMethodRef = useRef(null);
  const isMemberStart = data?.memberStart != null;
  const awaitingMethod = data?.memberStart?.paymentMode === 'member_choice';
  const allowsMode = mode => data?.voucherRequote?.paymentMode
    ? data.voucherRequote.paymentMode === mode : !isMemberStart || data.memberStart.paymentMode === mode;
  const monthlyOfferReady = offer => !isMemberStart || completeMonthlyOffer(offer, data.memberStart.paymentMode);
   const dynamicMemberStart = variableCredit || (isMemberStart && data.memberStart.paymentMode === 'direct_debit' && directDebitCollectionPolicy(data.ddOffer)?.pricing_policy === 'dynamic');

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
  const [accountingWarning, setAccountingWarning] = useState(null);
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

  async function selectMemberMethod(mode) {
    if (!awaitingMethod || selectingMethodRef.current ||
        !data.memberStart.paymentOptions?.some(option => option.mode === mode && option.available)) return;
    selectingMethodRef.current = true;
    setSelectingMethod(mode);
    setSelectionError(null);
    try {
      const response = await fetch(`/api/public/membership-fees/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'select_payment_method', paymentMode: mode }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || 'Unable to confirm your payment method.');
      const refreshed = await fetch(`/api/public/membership-fees/${token}`);
      const next = await refreshed.json();
      if (!refreshed.ok || !['stripe_upfront', 'stripe_monthly', 'direct_debit'].includes(next.memberStart?.paymentMode)) {
        throw new Error('Your selection may have been saved. Reload this page to confirm it before proceeding.');
      }
      memberChosenMethodRef.current = { token, mode: next.memberStart.paymentMode };
      setData(next);
    } catch (err) {
      setSelectionError(`${err.message} No payment has been confirmed.`);
    } finally {
      selectingMethodRef.current = false;
      setSelectingMethod(null);
    }
  }

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setLoading(!!token);
    setError(token ? null : 'Membership fee link is missing.');
    setData(null);
    setDataToken(null);
    if (!token) return;
    fetch(`/api/public/membership-fees/${token}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to load fee details');
        }
        return res.json();
      })
      .then((result) => {
        if (!current) return;
        if (result.replacementUrl) { window.location.replace(result.replacementUrl); return; }
        setData(result);
        setDataToken(token);
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
        if (result.invoiceNumber || result.xeroInvoiceNumber) setInvoiceNumber(result.invoiceNumber || result.xeroInvoiceNumber);
        if (result.invoiceUrl || result.xeroOnlineInvoiceUrl) setInvoiceLink(result.invoiceUrl || result.xeroOnlineInvoiceUrl);
      })
      .catch((err) => { if (current) setError(err.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [token]);

  // Handle 3D Secure redirect return
  useEffect(() => {
    if (!token || !data || redirectHandled.current) return;

    const urlParams = new URLSearchParams(window.location.search);
    const paymentIntentFromUrl = urlParams.get('payment_intent');
    const redirectStatus = urlParams.get('redirect_status');

    // Direct Debit hosted-flow return (?dd=complete / ?dd=cancelled)
    const ddParam = urlParams.get('dd');
    if (allowsMode('direct_debit') && (ddParam === 'complete' || ddParam === 'cancelled')) {
      setDdBanner(ddParam);
      const cleaned = new URLSearchParams(window.location.search);
      cleaned.delete('dd');
      const s = cleaned.toString();
      window.history.replaceState({}, '', window.location.pathname + (s ? '?' + s : ''));
    }

    // Monthly card Checkout return (?card=success / ?card=cancelled)
    const cardParam = urlParams.get('card');
    if (allowsMode('stripe_monthly') && (cardParam === 'success' || cardParam === 'cancelled')) {
      setCardBanner(cardParam);
      const cleaned = new URLSearchParams(window.location.search);
      cleaned.delete('card');
      const s = cleaned.toString();
      window.history.replaceState({}, '', window.location.pathname + (s ? '?' + s : ''));
    }

    if (!paymentIntentFromUrl || !allowsMode('stripe_upfront')) return;

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
        setAccountingWarning(body.warning || null);
        if (body.invoiceNumber || body.xeroInvoiceNumber) setInvoiceNumber(body.invoiceNumber || body.xeroInvoiceNumber);
        if (body.invoiceUrl || body.xeroOnlineInvoiceUrl) setInvoiceLink(body.invoiceUrl || body.xeroOnlineInvoiceUrl);
        setPaymentComplete(true);
      } catch (err) {
        setPaymentError(err.message);
      } finally {
        setCompletingRedirectPayment(false);
      }
    };

    completePayment();
  }, [token, data]);

  const handleSubmitPo = async () => {
    if (!allowsMode('invoice')) return;
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
      if (body.invoiceNumber || body.xeroInvoiceNumber) setInvoiceNumber(body.invoiceNumber || body.xeroInvoiceNumber);
      if (body.invoiceUrl || body.xeroOnlineInvoiceUrl) setInvoiceLink(body.invoiceUrl || body.xeroOnlineInvoiceUrl);
      setPoSubmitted(true);
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setSubmittingPo(false);
    }
  };

  const handleStartDirectDebit = async () => {
    if (!allowsMode('direct_debit') || !monthlyOfferReady(data?.ddOffer)) return;
    setStartingDd(true);
    setPaymentError(null);
    try {
      const res = await fetch(`/api/public/membership-fees/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start_direct_debit', ...(creditQuote ? { voucherQuoteId: creditQuote.id } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || 'Failed to start Direct Debit set-up');
      }
      if (body.success) { setPaymentComplete(true); setAccountingWarning(body.warning || null); return; }
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
    if (!allowsMode('stripe_monthly') || !monthlyOfferReady(data?.cardMonthly)) return;
    setStartingCardMonthly(true);
    setPaymentError(null);
    try {
      const res = await fetch(`/api/public/membership-fees/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start_monthly_card', ...(creditQuote ? { voucherQuoteId: creditQuote.id } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || 'Failed to start monthly card set-up');
      }
      if (body.success) { setPaymentComplete(true); setAccountingWarning(body.warning || null); return; }
      if (body.checkoutUrl) {
        window.top.location.href = body.checkoutUrl;
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
    if (!creditOnly && !allowsMode('stripe_upfront')) return;
    if (!creditOnly && !data?.stripePublishableKey) return;
    if (!creditOnly && isBelowStripeMinimum(payableAmount, data?.currency)) return;
    setCreatingPayment(true);
    setPaymentError(null);

    try {
      const res = await fetch(`/api/public/membership-fees/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: creditOnly ? 'complete_with_vouchers' : 'create_payment', ...(creditQuote ? { voucherQuoteId: creditQuote.id } : {}) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to initialize payment');
      }
      const result = await res.json();
      if (result.success) {
        setPaymentComplete(true);
        setAccountingWarning(result.warning || null);
        return;
      }
      const { clientSecret } = result;
      if (result.funding) setData(current => ({ ...current, voucherFunding: result.funding }));

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
      if (creditQuote) {
        try {
          const refreshed = await fetch(`/api/public/membership-fees/${encodeURIComponent(token)}`);
          if (refreshed.ok) setData(await refreshed.json());
        } catch { /* Preserve the explicit payment error; never assume a failed network call released credit. */ }
      }
    } finally {
      setCreatingPayment(false);
    }
  };

  const handleStripePayment = async () => {
    if (!allowsMode('stripe_upfront')) return;
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
        setAccountingWarning(confirmBody.warning || null);
        if (confirmBody.invoiceNumber || confirmBody.xeroInvoiceNumber) setInvoiceNumber(confirmBody.invoiceNumber || confirmBody.xeroInvoiceNumber);
        if (confirmBody.invoiceUrl || confirmBody.xeroOnlineInvoiceUrl) setInvoiceLink(confirmBody.invoiceUrl || confirmBody.xeroOnlineInvoiceUrl);
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

  if (loading || (data && dataToken !== token)) {
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
              Your membership fee has been received.
            </p>
            {accountingWarning && <p role="status" className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{accountingWarning}</p>}
            <div className="p-3 rounded-md bg-gray-50 border">
              <p className="text-sm text-gray-600">Amount Paid</p>
              <p className="text-2xl font-bold" style={{ color: primaryColor }}>
                {formatCurrency(data?.totalWithVat || data?.finalCost, data?.currency)}
              </p>
            </div>
            {(invoiceLink || invoiceNumber) && (
              <div className="mt-4 p-3 rounded-md border bg-white text-left">
                <p className="text-sm text-gray-600 mb-1">
                  {invoiceNumber ? `Invoice ${invoiceNumber}` : 'Your invoice is available online.'}
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
              <h1 className="text-lg font-semibold">{membershipHeading(data)}</h1>
            </div>

            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-500">{data?.isMember ? 'Member' : 'Organisation'}</span>
              <span className="font-medium" data-testid="text-org-name">{data?.isMember ? (data?.memberName || data?.organizationName) : data?.organizationName}</span>
            </div>
            {data?.renewalLifecycle?.isEarly && memberDate(data.renewalLifecycle.termStart) && (
              <div className="mt-2 text-xs text-gray-500">
                Your renewal is scheduled to start on {memberDate(data.renewalLifecycle.termStart)}.
              </div>
            )}
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-500">Membership period</span>
              <span className="font-medium" data-testid="text-period">{membershipPeriod(data)}</span>
            </div>
            {data?.tierLabel && !/^flat rate$/i.test(data.tierLabel.trim()) && <div className="flex items-center justify-between mb-1">
              <span className="text-sm text-gray-500">Membership type</span>
              <Badge variant="secondary" data-testid="text-tier">{data.tierLabel}</Badge>
            </div>}

            <Separator className="my-3" />

            {creditError && <p role="alert" className="mb-3 text-sm text-red-700">{creditError}</p>}
            {!data.memberStart && data.status === 'pending' && !data.voucherFunding && !paymentComplete && (
              <section className="mb-4 rounded border p-3 text-sm space-y-2">
                <p>To use credit with this link, you may need an updated payment summary. No payment is taken when you update it. Review the amount before continuing.</p>
                <Button variant="outline" onClick={() => regenerateCreditQuote()} disabled={quotingCredit || creatingPayment}>
                  {quotingCredit ? 'Preparing…' : 'Update payment summary'}
                </Button>
                {(requoteUpfront || data.voucherRequote?.creditRequired) && <Button variant="outline" onClick={() => regenerateCreditQuote('stripe_upfront')} disabled={quotingCredit}>
                  Keep original invoice price and apply credit upfront
                </Button>}
                {data.voucherRequote && <p>Payment method: {savedModeLabel(data.voucherRequote.paymentMode)}.</p>}
                {data.voucherRequote?.creditRequired && <p>Apply your credit before continuing so we can confirm your monthly payment amount.</p>}
              </section>
            )}
            {data?.voucherFunding && !paymentComplete && (
              <section className="mb-4 rounded border p-3 space-y-2" aria-label="Reserved membership credit">
                <p className="text-sm font-medium">Credit reserved for this membership period. Payment has not yet been confirmed.</p>
                {!variableCredit && <p>Membership cost: {formatCurrency(data.voucherFunding.payableMinor / 100, data?.currency)}</p>}
                {Array.isArray(data.voucherFunding.allocations) && data.voucherFunding.allocations.filter(row => row && Number.isSafeInteger(row.amountMinor)).map((row, index) => <p key={row.id || row.voucherId || index} className="text-sm">{creditOwnerLabel(row)}: {formatCurrency(row.amountMinor / 100, data?.currency)}</p>)}
                {variableCredit
                  ? <VariableCreditSummary credit={data.voucherFunding} instalmentCount={creditMonthly?.instalmentCount} offer={data.ddOffer} currency={data.currency} estimate={creditEstimate} />
                  : creditEstimate ? <p>Remaining to pay: {formatCurrency(displayPayableAmount, data?.currency)}</p> : <p>We can’t confirm the after-credit amount yet. Please contact the membership team.</p>}
                <Button type="button" variant="outline" onClick={clearPersonalCredit} disabled={quotingCredit || creatingPayment || processingPayment}>
                  Cancel payment and release credit
                </Button>
                {displayMonthlyMode && <p className="text-sm">{creditEstimate.count} monthly payments of {formatCurrency(creditPerMonth, data?.currency)} after credit. Credit applies only to this membership period, not future renewals.</p>}
                {creditOnly && <Button type="button" onClick={initStripe} disabled={creatingPayment}>Complete with membership credit</Button>}
              </section>
            )}
            {data?.status === 'pending' && (!data?.voucherFunding || (personalCredit?.enabled && personalCredit.vouchers.length > 0)) && (
              <section className="mb-4 rounded border p-3 space-y-2" aria-label="Available membership credit"
                aria-busy={creditDiscovery === 'idle' || creditDiscovery === 'loading'}>
                <h2 className="font-medium">Your available credit</h2>
                {!data?.voucherFunding && (creditDiscovery === 'idle' || creditDiscovery === 'loading') && <>
                  <p role="status" className="flex items-center gap-2 text-sm text-gray-600">
                    <Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin shrink-0" data-testid="credit-discovery-spinner" />
                    Checking for available membership credit…
                  </p>
                  <div aria-hidden="true" className="space-y-2" data-testid="credit-discovery-skeleton">
                    <Skeleton className="h-4 w-3/4 motion-reduce:animate-none" />
                    <Skeleton className="h-4 w-1/2 motion-reduce:animate-none" />
                    <Skeleton className="h-9 w-28 motion-reduce:animate-none" />
                  </div>
                </>}
                {!data?.voucherFunding && creditDiscovery === 'error' && <p role="alert" className="text-sm text-red-700">
                  We couldn’t check your available membership credit. {creditDiscoveryError} Please reload the page to try again.
                </p>}
                {!data?.voucherFunding && creditDiscovery === 'success' && !(personalCredit?.enabled && personalCredit.vouchers.length > 0) &&
                  <p role="status" className="text-sm text-gray-600">You have no credit available towards this membership payment.</p>}
                {creditDiscovery === 'success' && personalCredit?.enabled && personalCredit.vouchers.length > 0 && (
                  <p role="status" className="sr-only">Membership credit is available. Select credit below to apply it.</p>
                )}
                {personalCredit?.enabled && personalCredit.vouchers.length > 0 && <>
                <p className="text-sm text-amber-800">You have credit available towards your membership. Select the credit you would like to use and apply it to your payment.</p>
                {!data.memberStart && data.isMember && <label className="block text-sm">
                  How would you like to pay the remaining amount?
                  <select className="block mt-1 rounded border p-2" value={selectedCreditMode}
                    disabled={!!data.voucherFunding || creatingPayment || !!data.voucherRequote}
                    onChange={event => { quoteRevision.current += 1; setQuotingCredit(false); setCreditPaymentMode(event.target.value); setCreditQuote(null); }}>
                    <option value="stripe_upfront">Annual / upfront</option>
                    {monthlyOfferReady(data.cardMonthly) && <option value="stripe_monthly">Monthly card payments</option>}
                    {monthlyOfferReady(data.ddOffer) && <option value="direct_debit">Monthly Direct Debit</option>}
                  </select>
                </label>}
                {personalCredit.vouchers.map(voucher => (
                  <label key={voucher.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" disabled={quotingCredit || creatingPayment || processingPayment || !!data?.voucherFunding}
                      checked={creditSelection.includes(voucher.id)}
                      onChange={event => {
                        quoteRevision.current += 1;
                        setCreditQuote(null);
                        setCreditSelection(selected => event.target.checked
                          ? [...selected, voucher.id] : selected.filter(id => id !== voucher.id));
                      }} />
                    <span>{creditOwnerLabel(voucher)} – {formatCurrency(voucher.value, data?.currency)} ({voucher.code})
                      <span className="block text-xs text-slate-500"><VoucherExpiry voucher={voucher} /></span>
                    </span>
                  </label>
                ))}
                <Button type="button" variant="outline" disabled={!creditSelection.length || quotingCredit || creatingPayment || processingPayment || !!data?.voucherFunding}
                  onClick={previewPersonalCredit}>
                  {quotingCredit ? 'Reviewing…' : 'Apply credit'}
                </Button>
                {creditQuote && !quoteCurrent && <p role="status">Your credit quote is expired or unavailable. Apply credit again to review a current estimate.</p>}
                {quoteCurrent && (
                  <div className="text-sm space-y-1" role="status">
                    {!variableCredit && <p>Membership cost: {formatCurrency(creditQuote.grossMinor / 100, creditQuote.currency)}</p>}
                    {Array.isArray(creditQuote.allocations) && creditQuote.allocations.filter(row => row && Number.isSafeInteger(row.amountMinor)).map((row, index) => <p key={row.voucherId || index}>{creditOwnerLabel(row)}: {formatCurrency(row.amountMinor / 100, creditQuote.currency)}</p>)}
                    {variableCredit
                      ? <VariableCreditSummary credit={creditQuote} instalmentCount={creditMonthly?.instalmentCount} offer={data.ddOffer} currency={creditQuote.currency} estimate={creditEstimate} />
                      : creditEstimate ? <p>Remaining to pay: {formatCurrency(displayPayableAmount, creditQuote.currency)}</p> : <p>We can’t confirm the after-credit amount yet. Please review your credit quote.</p>}
                    {displayMonthlyMode && <p>{creditEstimate.count} monthly payments of {formatCurrency(creditPerMonth, data?.currency)} after credit.
                      Credit applies only to this membership period. Any unused credit stays available; future renewals are not reduced.</p>}
                    <p className="font-medium">Credit selected, not reserved yet. Credit will be reserved when you continue to payment. This quote expires after 15 minutes.</p>
                    {!data?.voucherFunding && <Button type="button" variant="outline" onClick={clearPersonalCredit} disabled={creatingPayment || processingPayment}>Remove credit selection</Button>}
                    {creditOnly && !paymentComplete && (
                      <Button type="button" onClick={initStripe} disabled={creatingPayment || !!data?.approvalPending || !!data?.openPlan}>
                        {creatingPayment ? 'Completing…' : 'Complete with membership credit'}
                      </Button>
                    )}
                  </div>
                )}
                </>}
              </section>
            )}

            {breakdown.annualCostBeforeDiscounts != null && breakdown.customDiscountTotal > 0 && (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">{annualMembershipFeeLabel(data)} before discounts</span>
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
                <span className="text-gray-500">{annualMembershipFeeLabel(data)}{(data?.voucherFunding || creditQuote) ? ' before credit' : ''}</span>
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
                  <span className="text-gray-500">Amount excluding VAT{annualMembershipFeeLabel(data).includes('at current rates') ? ' at current rates' : ''}</span>
                  <span>{formatCurrency(data?.finalCost, data?.currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">VAT{data?.vatRatePercent > 0 ? ` (${data.vatRatePercent}%)` : ''}</span>
                  <span data-testid="text-vat">{formatCurrency(data.vatAmount, data?.currency)}</span>
                </div>
              </>
            )}

            <Separator className="my-3" />

            {creditEstimate && <div className="space-y-2 mb-4 text-sm" data-testid="credit-estimate" role="status">
              <div className="flex items-center justify-between gap-3">
                <span>Credit {creditEstimate.reserved ? 'reserved' : 'selected (not reserved yet)'}</span>
                <span className="font-medium text-green-700">-{formatCurrency(creditEstimate.selectedMinor / 100, data.currency)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>{creditEstimate.variable ? 'Estimated period payments at current rates' : 'Remaining to pay after credit'}</span>
                <span className="font-semibold">{formatCurrency(creditEstimate.cashMinor / 100, data.currency)}</span>
              </div>
              {!creditEstimate.variable && <p>Fee before credit: {formatCurrency(creditEstimate.grossMinor / 100, data.currency)}.</p>}
            </div>}
            <div className="flex items-center justify-between">
              <span className="font-medium">{awaitingMethod ? 'Payment amount' : creditEstimate?.variable ? 'Estimated first monthly payment after credit' : dynamicMemberStart ? (variableCredit ? 'Current monthly payment estimate before credit' : 'Current monthly payment') : creditEstimate ? 'Total due after credit' : <>Total Due{data?.vatAmount > 0 ? ' (incl. VAT)' : ''}</>}</span>
              <span className="text-2xl font-bold" style={{ color: primaryColor }} data-testid="text-total">
                {awaitingMethod ? 'See payment options below' : creditEstimate?.variable ? formatCurrency(creditEstimate.firstCashMinor / 100, data.currency) : dynamicMemberStart ? (data.ddOffer?.monthlyAmount != null ? formatCurrency(data.ddOffer.monthlyAmount, data.ddOffer.currency || data.currency) : 'Not supplied') : formatCurrency(creditEstimate ? creditEstimate.cashMinor / 100 : (data?.totalWithVat || data?.finalCost), data?.currency)}
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

        {data?.paymentMethodsMessage && (
          <p className="text-sm text-gray-600" data-testid="text-renewal-payment-methods">{data.paymentMethodsMessage}</p>
        )}
        {(isMemberStart || membershipHeading(data) === 'Your Membership Renewal') && (
          <div className="rounded-md border bg-white p-3 text-sm space-y-2" data-testid="member-start-payment-authority">
            <p className="font-medium">{membershipHeading(data) === 'Your Membership Renewal' ? 'Your renewal details' : 'Your membership details'}</p>
            <p>{!isMemberStart ? (reusesDirectDebit(data) ? 'Payment method: Monthly Direct Debit.' : 'Review your payment options below.')
              : awaitingMethod ? 'Choose how you would like to pay below.'
              : memberChosenMethodRef.current?.token === token && memberChosenMethodRef.current.mode === data.memberStart.paymentMode
                ? `You have chosen to pay by ${savedModeLabel(data.memberStart.paymentMode).toLowerCase().replace('direct debit', 'Direct Debit')}.`
                : `Payment method: ${savedModeLabel(data.memberStart.paymentMode)}.`}</p>
            {data.memberStart?.paymentMode === 'invoice' && <p>Your invoice remains outstanding until payment is verified.</p>}
            {data.memberStart?.paymentMode === 'free' && <p>There is no membership fee to pay.</p>}
            {['stripe_monthly', 'direct_debit'].includes(data.memberStart?.paymentMode) && !monthlyOfferReady(data.memberStart.paymentMode === 'stripe_monthly' ? data.cardMonthly : data.ddOffer) && <p role="alert">We can’t confirm your monthly payment details yet. Please contact the membership team before continuing.</p>}
          </div>
        )}

        {awaitingMethod && <Card>
          <CardContent className="pt-6 space-y-4" data-testid="member-payment-choice">
            <h2 className="font-medium">Choose how to pay</h2>
            <p className="text-sm">Confirm a method below, then complete payment or setup securely with the provider. To change a confirmed method, contact your membership administrator.</p>
            {(data.memberStart.paymentOptions || []).filter(option => ['stripe_upfront', 'stripe_monthly', 'direct_debit'].includes(option.mode)).map(option => {
              const quote = option.quote;
              const offer = quote?.paymentOffer;
              const monthly = ['stripe_monthly', 'direct_debit'].includes(option.mode);
              const dynamic = option.mode === 'direct_debit' && directDebitCollectionPolicy(offer)?.pricing_policy === 'dynamic';
              const complete = quote && /^[A-Z]{3}$/.test(quote.currency || '') &&
                (monthly ? completeMonthlyOffer(offer, option.mode) : quote.totalWithVat != null && Number.isFinite(Number(quote.totalWithVat)) && Number(quote.totalWithVat) > 0);
              return <div key={option.mode} className="rounded-md border p-3 space-y-2">
                <h3 className="font-medium">{savedModeLabel(option.mode)}</h3>
                {complete && <div className="text-sm space-y-1">
                  {monthly ? dynamic
                    ? <p>Current monthly payment: {formatCurrency(offer.monthlyAmount, offer.currency)}.</p>
                    : <p>{offer.instalmentCount} monthly payments of {formatCurrency(offer.monthlyAmount, offer.currency)} · Plan total: {formatCurrency(offer.planTotal, offer.currency)}</p>
                    : <p>One-off payment: {formatCurrency(quote.totalWithVat, quote.currency)}</p>}
                  {monthly && <p>{activationText(offer.activationRule)}</p>}
                  {option.mode === 'direct_debit' && <><p>{directDebitPolicyText(offer)}</p><p>First collection: {directDebitFirstCollectionText(offer)}.</p></>}
                </div>}
                {(!option.available || !complete) && <p className="text-sm" role="status">{option.reason || 'Complete payment terms are unavailable. Contact your membership administrator.'}</p>}
                <Button type="button" variant="outline" disabled={!!selectingMethod || !option.available || !complete}
                  data-testid={`choose-${option.mode}`} onClick={() => selectMemberMethod(option.mode)}>
                  {selectingMethod === option.mode ? 'Confirming choice…' : `Choose ${savedModeLabel(option.mode).toLowerCase()}`}
                </Button>
              </div>;
            })}
            {!data.memberStart.paymentOptions?.length && <p role="alert">No saved payment options are available. Contact your membership administrator.</p>}
            {selectionError && <p role="alert">{selectionError}</p>}
          </CardContent>
        </Card>}

        {allowsMode('invoice') && !renewalBlocked && data?.poAvailable !== false && !poSubmitted && paymentMode !== 'stripe' && (
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
                    {invoiceNumber ? `Invoice ${invoiceNumber}` : 'Your invoice is available online.'}
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
                <span className="font-medium">{isMemberStart ? 'Direct Debit awaiting confirmation' : 'Direct Debit Set-Up Complete'}</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                {isMemberStart ? 'We’re waiting for confirmation of your Direct Debit and payment. Your payment has not yet been confirmed.' : 'Thank you — your bank is confirming your Direct Debit. Your membership payments will be collected monthly and no further action is needed.'}
              </p>
            </CardContent>
          </Card>
        )}

        {ddBanner === 'cancelled' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-700">Direct Debit set-up was cancelled. {isMemberStart ? 'You can retry the saved payment method below.' : 'You can try again below, or use another payment option.'}</p>
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
                {isMemberStart ? 'We’re waiting for confirmation of your Direct Debit and payment. Your membership is not yet confirmed.' : reusesDirectDebit(data) ? 'Your existing Direct Debit has been reused — your monthly payments have been scheduled.' : 'Your Direct Debit is being processed. We’ll confirm your monthly payments once it is ready.'}
              </p>
            </CardContent>
          </Card>
        )}

        {cardBanner === 'success' && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="w-5 h-5" />
                <span className="font-medium">{isMemberStart ? 'Monthly card payments awaiting confirmation' : 'Monthly Card Payments Set Up'}</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                {isMemberStart ? 'We’re waiting for confirmation from Stripe. Your payment has not yet been confirmed.' : 'Thank you — your card has been saved securely with Stripe and your membership will be collected in monthly instalments. No further action is needed.'}
              </p>
            </CardContent>
          </Card>
        )}

        {cardBanner === 'cancelled' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-700">Monthly card set-up was cancelled. {isMemberStart ? 'You can retry the saved payment method below.' : 'You can try again below, or use another payment option.'}</p>
          </div>
        )}

        {data?.renewal?.status === 'notice_sent' && data?.renewal?.mode === 'confirm' && !paymentComplete && cardBanner !== 'success' && ddBanner !== 'complete' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-blue-50 border border-blue-200" data-testid="banner-renewal-awaiting-confirmation">
            <AlertCircle className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
            <p className="text-sm text-blue-700">
              Your monthly {data.renewal.provider === 'stripe' ? 'card payment' : data.renewal.provider === 'gocardless' ? 'Direct Debit' : 'payment'} plan is ready to renew for this membership year.
              {' '}{data.renewal.provider === 'stripe' ? 'Confirm your renewal below — your saved card details can be reused.'
                : reusesDirectDebit(data) ? 'Confirm your renewal below — your existing Direct Debit will be reused.'
                  : 'Review the details below before continuing.'}
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

        {allowsMode('stripe_monthly') && monthlyOfferReady(data?.cardMonthly) && data?.cardMonthlyEnabled && !paymentComplete && cardBanner !== 'success' && !ddStarted && ddBanner !== 'complete' && !data?.cardStatus?.hasSubscription && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-3">
                <CreditCard className="w-4 h-4" style={{ color: primaryColor }} />
                <h2 className="font-medium">Pay Monthly by Card</h2>
              </div>
              <p className="text-sm text-gray-500 mb-3">
                Spread your membership fee over {isMemberStart ? data.cardMonthly.instalmentCount : (data?.cardMonthly?.instalmentCount || 12)} monthly card payments of{' '}
                <span className="font-medium text-gray-700">{formatCurrency(displayMonthlyMode === 'stripe_monthly' ? creditPerMonth : data?.cardMonthly?.monthlyAmount, data?.cardMonthly?.currency || data?.currency)}</span>
                {data?.cardMonthly?.planTotal ? <> (cash total {formatCurrency(displayMonthlyMode === 'stripe_monthly' ? displayPayableAmount : data.cardMonthly.planTotal, data?.cardMonthly?.currency || data?.currency)})</> : null}.
                {' '}Continue to Stripe to enter your card details securely.
                {isMemberStart && data.cardMonthly.activationRule && <> {activationText(data.cardMonthly.activationRule)}</>}
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

        {allowsMode('direct_debit') && monthlyOfferReady(data?.ddOffer) && data?.ddEnabled && !paymentComplete && !ddStarted && ddBanner !== 'complete' && cardBanner !== 'success' && !data?.cardStatus?.hasSubscription && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-3">
                <Landmark className="w-4 h-4" style={{ color: primaryColor }} />
                <h2 className="font-medium">{reusesDirectDebit(data) ? 'Continue your monthly payments' : 'Set up your monthly payments'}</h2>
              </div>
              <p className="text-sm text-gray-500 mb-3">
                {creditEstimate?.variable ? 'Your estimated first monthly payment after credit is ' : !variableCredit && directDebitHasFixedTermTotal(data.ddOffer) ? <>{isMemberStart ? data.ddOffer.instalmentCount : (data?.ddOffer?.instalmentCount || 12)} monthly payments of{' '}</> : variableCredit ? 'Your current monthly payment estimate before credit is ' : 'Your current monthly payment by Direct Debit is '}
                <span className="font-medium text-gray-700">{formatCurrency(creditEstimate?.variable ? creditEstimate.firstCashMinor / 100 : displayMonthlyMode === 'direct_debit' ? creditPerMonth : data?.ddOffer?.monthlyAmount, data?.ddOffer?.currency || data?.currency)}</span>
                {creditEstimate?.variable && <> (before credit: {formatCurrency(data.ddOffer.monthlyAmount, data.ddOffer.currency)}). Later amounts may differ by pennies and fees may change</>}
                {!variableCredit && directDebitHasFixedTermTotal(data.ddOffer) && data?.ddOffer?.planTotal ? <> (cash total for this term {formatCurrency(displayMonthlyMode === 'direct_debit' ? displayPayableAmount : data.ddOffer.planTotal, data?.ddOffer?.currency || data?.currency)})</> : null}.
                  {' '}First collection: <span data-testid="text-dd-first-collection">{isMemberStart && !data.ddOffer?.firstCollectionRule ? 'we’ll confirm the date with you' : directDebitFirstCollectionText(data.ddOffer)}</span>.
                {' '}{directDebitPolicyText(data.ddOffer)}
                 {' '}{reusesDirectDebit(data) ? 'Your existing Direct Debit will be reused. Confirm below to continue your payments.' : 'To get started, we’ll securely guide you through setting up your Direct Debit.'}
                {isMemberStart && data.ddOffer.activationRule && <> {activationText(data.ddOffer.activationRule)}</>}
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
                {reusesDirectDebit(data) ? 'Confirm Direct Debit Renewal' : 'Continue to Direct Debit Setup'}
              </Button>
            </CardContent>
          </Card>
        )}

        {allowsMode('stripe_upfront') && data?.stripeEnabled && !paymentComplete && data?.openPlan && (
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

        {allowsMode('stripe_upfront') && data?.stripeEnabled && !paymentComplete && !data?.openPlan && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-3">
                <CreditCard className="w-4 h-4" style={{ color: primaryColor }} />
                <h2 className="font-medium">Pay Now</h2>
              </div>

              {paymentMode !== 'stripe' ? (
                <>
                  {isBelowStripeMinimum(payableAmount, data?.currency) && !creditOnly ? (
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
                    disabled={creatingPayment || (!creditOnly && isBelowStripeMinimum(payableAmount, data?.currency))}
                    className="w-full"
                    style={{ background: !creditOnly && isBelowStripeMinimum(payableAmount, data?.currency) ? '#9ca3af' : primaryColor }}
                    data-testid="button-pay-now"
                  >
                    {creatingPayment ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <CreditCard className="w-4 h-4 mr-2" />
                    )}
                    {creditOnly ? 'Complete with membership credit' : `Pay ${formatCurrency(displayPayableAmount, data?.currency)}`}
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
                    {processingPayment ? 'Processing...' : `Confirm Payment - ${formatCurrency(displayPayableAmount, data?.currency)}`}
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
