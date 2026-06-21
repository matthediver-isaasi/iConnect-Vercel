import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AlertCircle, Loader2, CreditCard, FileText, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

function StripePaymentForm({ amount, onSuccess, onCancel, paymentIntentId }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setProcessing(true);
    setError(null);

    try {
      const { error: submitError, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: window.location.href },
        redirect: "if_required",
      });

      if (submitError) {
        setError(submitError.message);
        setProcessing(false);
        return;
      }

      const confirmedId = paymentIntent?.id || paymentIntentId;
      await onSuccess(confirmedId);
    } catch (err) {
      console.error("[BuyFundsModal] Stripe confirmPayment error:", err);
      setError(err.message);
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="p-3 rounded-md bg-muted">
        <p className="text-sm">
          <span className="font-medium">Amount to charge:</span> £{amount.toFixed(2)}
        </p>
      </div>

      <PaymentElement options={{ layout: "tabs" }} />

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10">
          <AlertCircle className="w-4 h-4 mt-0.5 text-destructive shrink-0" />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={processing} data-testid="button-buy-funds-cancel-payment">
          Cancel
        </Button>
        <Button type="submit" disabled={!stripe || processing} data-testid="button-buy-funds-pay">
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

export default function BuyFundsModal({ open, onOpenChange, onCompleted }) {
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("card");
  const [poNumber, setPoNumber] = useState("");
  const [poToFollow, setPoToFollow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Card flow state
  const [stripePromise, setStripePromise] = useState(null);
  const [clientSecret, setClientSecret] = useState(null);
  const [purchaseId, setPurchaseId] = useState(null);
  const [paymentIntentId, setPaymentIntentId] = useState(null);

  const numericAmount = parseFloat(amount);
  const amountValid = !isNaN(numericAmount) && numericAmount > 0;

  const resetState = () => {
    setAmount("");
    setPaymentMethod("card");
    setPoNumber("");
    setPoToFollow(false);
    setSubmitting(false);
    setError(null);
    setStripePromise(null);
    setClientSecret(null);
    setPurchaseId(null);
    setPaymentIntentId(null);
  };

  const handleClose = (next) => {
    if (!next) resetState();
    onOpenChange(next);
  };

  const handleCreate = async () => {
    if (!amountValid) {
      setError("Please enter an amount greater than zero.");
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const response = await base44.functions.invoke("createTrainingFundPurchase", {
        amount: numericAmount,
        paymentMethod,
        purchaseOrderNumber: poToFollow ? null : (poNumber.trim() || null),
        poToFollow,
      });

      const data = response?.data || response;
      if (!data?.success) {
        throw new Error(data?.error || "Failed to create purchase");
      }

      if (paymentMethod === "invoice") {
        toast.success("Invoice created", {
          description: "These funds are pending and will become available once the invoice is paid.",
        });
        if (onCompleted) onCompleted();
        handleClose(false);
        return;
      }

      // Card flow — set up Stripe Elements.
      if (!data.clientSecret || !data.publishableKey) {
        throw new Error("Payment could not be initialised");
      }
      setStripePromise(loadStripe(data.publishableKey));
      setClientSecret(data.clientSecret);
      setPurchaseId(data.purchaseId);
      setPaymentIntentId(data.paymentIntentId);
      setSubmitting(false);
    } catch (err) {
      console.error("[BuyFundsModal] create error:", err);
      setError(err.message || "Something went wrong");
      setSubmitting(false);
    }
  };

  const handlePaymentSuccess = async (confirmedPaymentIntentId) => {
    try {
      const response = await base44.functions.invoke("confirmTrainingFundPurchasePayment", {
        purchaseId,
        paymentIntentId: confirmedPaymentIntentId || paymentIntentId,
      });
      const data = response?.data || response;
      if (!data?.success) {
        throw new Error(data?.error || "Payment confirmation failed");
      }
      toast.success("Payment successful", {
        description: "Your training fund balance has been topped up.",
      });
      if (onCompleted) onCompleted();
      handleClose(false);
    } catch (err) {
      console.error("[BuyFundsModal] confirm error:", err);
      toast.error("Payment confirmation issue", {
        description: err.message + " Your card may have been charged — please contact support if your balance is not updated.",
      });
    }
  };

  const showStripe = clientSecret && stripePromise;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Buy Training Funds</DialogTitle>
          <DialogDescription>
            Top up your organisation's training fund balance.
          </DialogDescription>
        </DialogHeader>

        {showStripe ? (
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <StripePaymentForm
              amount={numericAmount}
              paymentIntentId={paymentIntentId}
              onSuccess={handlePaymentSuccess}
              onCancel={() => handleClose(false)}
            />
          </Elements>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="buy-funds-amount">Amount (£)</Label>
              <Input
                id="buy-funds-amount"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="input-buy-funds-amount"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="buy-funds-po">Purchase order number (optional)</Label>
              <Input
                id="buy-funds-po"
                type="text"
                placeholder="PO-12345"
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                disabled={poToFollow}
                data-testid="input-buy-funds-po"
              />
              <label className="flex items-center gap-2 cursor-pointer pt-1">
                <Checkbox
                  checked={poToFollow}
                  onCheckedChange={(v) => setPoToFollow(!!v)}
                  data-testid="checkbox-buy-funds-po-later"
                />
                <span className="text-sm text-muted-foreground">I'll supply the PO number later</span>
              </label>
            </div>

            <div className="space-y-2">
              <Label>Payment method</Label>
              <RadioGroup value={paymentMethod} onValueChange={setPaymentMethod} className="gap-2">
                <label
                  className="flex items-center gap-3 rounded-md border p-3 cursor-pointer hover-elevate"
                  data-testid="radio-buy-funds-card"
                >
                  <RadioGroupItem value="card" id="pm-card" />
                  <CreditCard className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Pay by card</p>
                    <p className="text-xs text-muted-foreground">Funds available immediately</p>
                  </div>
                </label>
                <label
                  className="flex items-center gap-3 rounded-md border p-3 cursor-pointer hover-elevate"
                  data-testid="radio-buy-funds-invoice"
                >
                  <RadioGroupItem value="invoice" id="pm-invoice" />
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Pay by invoice</p>
                    <p className="text-xs text-muted-foreground">Funds pending until invoice is paid</p>
                  </div>
                </label>
              </RadioGroup>
            </div>

            {paymentMethod === "invoice" && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-muted">
                <CheckCircle2 className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                <p className="text-xs text-muted-foreground">
                  An invoice will be created in your accounting system. The amount will show as pending
                  and become spendable once payment is confirmed.
                </p>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10">
                <AlertCircle className="w-4 h-4 mt-0.5 text-destructive shrink-0" />
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-3 justify-end">
              <Button type="button" variant="outline" onClick={() => handleClose(false)} disabled={submitting} data-testid="button-buy-funds-cancel">
                Cancel
              </Button>
              <Button type="button" onClick={handleCreate} disabled={submitting || !amountValid} data-testid="button-buy-funds-continue">
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : paymentMethod === "card" ? (
                  "Continue to payment"
                ) : (
                  "Create invoice"
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
