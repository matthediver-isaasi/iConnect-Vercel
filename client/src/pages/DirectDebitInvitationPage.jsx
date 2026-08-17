import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, CheckCircle2, XCircle, Landmark, Building2 } from "lucide-react";
import GoCardlessDropinFlow from "@/components/gocardless/GoCardlessDropinFlow";

const CURRENCY_SYMBOLS = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };

function formatCurrency(amount, currency) {
  if (amount == null) return '';
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
  return `${symbol}${Number(amount).toFixed(2)}`;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return null;
  }
}

export default function DirectDebitInvitationPage() {
  const { token } = useParams();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // GoCardless Drop-in modal state: { flowId, environment, authorisationUrl }
  const [ddDropin, setDdDropin] = useState(null);
  // Local outcome from the Drop-in modal ('complete' | 'cancelled'); takes
  // precedence over the redirect-return ?flow= param.
  const [ddOutcome, setDdOutcome] = useState(null);

  const urlFlowParam = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('flow')
    : null;
  const flowParam = ddOutcome || urlFlowParam;

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/dd-invitations/${token}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error || 'This payment set-up link is invalid or has expired.');
      } else {
        setData(json.invitation);
      }
    } catch {
      setError('Something went wrong loading this page. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadDetails();
  }, [loadDetails]);

  const accept = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/public/dd-invitations/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept', confirmAuthority: confirmed }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(json?.error || 'Could not start the Direct Debit set-up.');
      } else if (json.authorisationUrl) {
        if (json.flowId) {
          // Open the GoCardless Drop-in modal on-page; hosted redirect stays
          // as the automatic fallback if the widget fails to load.
          setDdOutcome(null);
          setDdDropin({
            flowId: json.flowId,
            environment: json.environment || 'sandbox',
            authorisationUrl: json.authorisationUrl,
          });
          return;
        }
        window.location.href = json.authorisationUrl;
        return;
      } else {
        setSubmitError('Could not start the Direct Debit set-up.');
      }
    } catch {
      setSubmitError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      {ddDropin && (
        <GoCardlessDropinFlow
          flowId={ddDropin.flowId}
          environment={ddDropin.environment}
          onSuccess={() => {
            setDdDropin(null);
            setDdOutcome('complete');
          }}
          onExit={() => {
            setDdDropin(null);
            setDdOutcome('cancelled');
          }}
          onLoadFailure={() => {
            // Fall back to the hosted redirect flow.
            window.location.href = ddDropin.authorisationUrl;
          }}
        />
      )}
      <Card className="w-full max-w-lg" data-testid="card-dd-invitation">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 flex-wrap">
            <Landmark className="h-5 w-5 text-muted-foreground" />
            Direct Debit set-up
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Checking your link...</span>
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="dd-invite-error">
              <XCircle className="h-10 w-10 text-destructive" />
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          )}

          {!loading && !error && flowParam === 'complete' && (
            <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="dd-invite-flow-complete">
              <CheckCircle2 className="h-10 w-10 text-green-500" />
              <div>
                <p className="font-medium">Thank you — Direct Debit details submitted</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Your bank will confirm the Direct Debit within a few working days. The organisation will be notified automatically.
                </p>
              </div>
            </div>
          )}

          {!loading && !error && flowParam !== 'complete' && data && (
            <>
              {flowParam === 'cancelled' && (
                <div className="p-3 bg-muted rounded-md text-sm text-muted-foreground" data-testid="dd-invite-flow-cancelled">
                  The bank set-up was not completed. You can start it again below.
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                {data.invitedName ? `Hi ${data.invitedName.split(' ')[0]}, you` : 'You'}'ve been asked to set up
                the Direct Debit for this organisation's membership.
              </p>

              <div className="border rounded-md p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-medium" data-testid="text-dd-org-name">{data.organizationName}</span>
                </div>
                <div className="space-y-1.5 text-sm">
                  {data.membershipYear && (
                    <div className="flex justify-between flex-wrap gap-1">
                      <span className="text-muted-foreground">Membership year</span>
                      <span data-testid="text-dd-year">{data.membershipYear}</span>
                    </div>
                  )}
                  {data.tierLabel && (
                    <div className="flex justify-between flex-wrap gap-1">
                      <span className="text-muted-foreground">Category</span>
                      <span data-testid="text-dd-tier">{data.tierLabel}</span>
                    </div>
                  )}
                  <div className="flex justify-between flex-wrap gap-1">
                    <span className="text-muted-foreground">Monthly amount</span>
                    <span className="font-medium" data-testid="text-dd-monthly">{formatCurrency(data.monthlyAmount, data.currency)}</span>
                  </div>
                  <div className="flex justify-between flex-wrap gap-1">
                    <span className="text-muted-foreground">Instalments</span>
                    <span data-testid="text-dd-instalments">{data.instalmentCount} monthly payments</span>
                  </div>
                  <div className="flex justify-between flex-wrap gap-1">
                    <span className="text-muted-foreground">Total</span>
                    <span className="font-medium" data-testid="text-dd-total">{formatCurrency(data.planTotal, data.currency)}</span>
                  </div>
                </div>
              </div>

              {data.expiresAt && (
                <p className="text-xs text-muted-foreground" data-testid="text-dd-expiry">
                  This link expires on {formatDate(data.expiresAt)}.
                </p>
              )}

              <label className="flex items-start gap-2 text-sm cursor-pointer" data-testid="label-dd-authority">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(v) => setConfirmed(v === true)}
                  className="mt-0.5"
                  disabled={submitting}
                  data-testid="checkbox-dd-authority"
                />
                <span>
                  I confirm I am authorised to set up Direct Debit payments on this organisation's bank account.
                </span>
              </label>

              {submitError && (
                <p className="text-sm text-destructive" data-testid="text-dd-submit-error">{submitError}</p>
              )}

              <Button
                onClick={accept}
                disabled={!confirmed || submitting}
                className="w-full"
                data-testid="button-dd-continue"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Preparing secure set-up...
                  </>
                ) : (
                  <>
                    <Landmark className="mr-2 h-4 w-4" />
                    Continue to bank set-up
                  </>
                )}
              </Button>

              <p className="text-xs text-muted-foreground">
                Payments are protected by the{' '}
                <a
                  href="https://gocardless.com/direct-debit/guarantee/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  data-testid="link-dd-guarantee"
                >
                  Direct Debit Guarantee
                </a>.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
