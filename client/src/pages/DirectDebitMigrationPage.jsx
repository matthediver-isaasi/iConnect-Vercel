// GoCardless Phase 5 — member-facing migration invite page (/dd-migrate/:token).
// Existing members paying by card/invoice open their secure invite link here,
// see the monthly Direct Debit offer for the switch year, and accept (mandate
// set-up or instant reuse) or decline. The token is the authorisation.
import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, XCircle, Landmark } from "lucide-react";

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

export default function DirectDebitMigrationPage() {
  const { token } = useParams();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [declined, setDeclined] = useState(false);
  const [acceptedNoRedirect, setAcceptedNoRedirect] = useState(false);

  const flowParam = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('flow')
    : null;

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/membership/dd-migration?token=${encodeURIComponent(token)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error || 'This invitation link is invalid or has expired.');
      } else {
        setData(json);
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

  const respond = async (action) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/membership/dd-migration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(json?.error || 'Something went wrong. Please try again.');
      } else if (action === 'decline') {
        setDeclined(true);
      } else if (json.authorisationUrl) {
        window.location.href = json.authorisationUrl;
        return;
      } else {
        // Active mandate reused — subscription created without a bank visit.
        setAcceptedNoRedirect(true);
      }
    } catch {
      setSubmitError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const offer = data?.offer;
  const invite = data?.invite;

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg" data-testid="card-dd-migration">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 flex-wrap">
            <Landmark className="h-5 w-5 text-muted-foreground" />
            Switch to monthly Direct Debit
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
            <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="dd-migrate-error">
              <XCircle className="h-10 w-10 text-destructive" />
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          )}

          {!loading && !error && (declined || flowParam === 'complete' || acceptedNoRedirect) && (
            <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="dd-migrate-done">
              <CheckCircle2 className="h-10 w-10 text-green-500" />
              <div>
                <p className="font-medium">{declined ? 'Thanks — your choice has been recorded' : 'All set'}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {declined
                    ? 'You will keep paying as you do now. Nothing else changes.'
                    : acceptedNoRedirect
                      ? 'Your existing Direct Debit mandate will be used. Your monthly plan starts with the new membership year.'
                      : 'Your bank will confirm the Direct Debit within a few working days. Your monthly plan starts with the new membership year.'}
                </p>
              </div>
            </div>
          )}

          {!loading && !error && !declined && !acceptedNoRedirect && flowParam !== 'complete' && data && (
            <>
              {flowParam === 'cancelled' && (
                <div className="p-3 bg-muted rounded-md text-sm text-muted-foreground" data-testid="dd-migrate-flow-cancelled">
                  The bank set-up was not completed. You can start it again below.
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                {data.memberName ? `Hi ${data.memberName.split(' ')[0]}, you` : 'You'}'ve been invited to pay your
                membership by monthly Direct Debit from the <strong>{invite?.switchFromYear}</strong> membership year.
                Your current membership and payment method are not affected.
              </p>

              <div className="border rounded-md p-4 space-y-1.5 text-sm">
                {offer?.tierLabel && (
                  <div className="flex justify-between flex-wrap gap-1">
                    <span className="text-muted-foreground">Category</span>
                    <span data-testid="text-migrate-tier">{offer.tierLabel}</span>
                  </div>
                )}
                <div className="flex justify-between flex-wrap gap-1">
                  <span className="text-muted-foreground">Monthly amount</span>
                  <span className="font-medium" data-testid="text-migrate-monthly">{formatCurrency(offer?.monthlyAmount, offer?.currency)}</span>
                </div>
                <div className="flex justify-between flex-wrap gap-1">
                  <span className="text-muted-foreground">Instalments</span>
                  <span data-testid="text-migrate-instalments">{offer?.instalmentCount} monthly payments</span>
                </div>
                <div className="flex justify-between flex-wrap gap-1">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-medium" data-testid="text-migrate-total">{formatCurrency(offer?.planTotal, offer?.currency)}</span>
                </div>
              </div>

              {invite?.expiresAt && (
                <p className="text-xs text-muted-foreground" data-testid="text-migrate-expiry">
                  This link expires on {formatDate(invite.expiresAt)}.
                </p>
              )}

              {submitError && (
                <p className="text-sm text-destructive" data-testid="text-migrate-submit-error">{submitError}</p>
              )}

              <div className="flex flex-col gap-2">
                <Button
                  onClick={() => respond('accept')}
                  disabled={submitting}
                  className="w-full"
                  data-testid="button-migrate-accept"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Preparing secure set-up...
                    </>
                  ) : (
                    <>
                      <Landmark className="mr-2 h-4 w-4" />
                      Switch to monthly Direct Debit
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => respond('decline')}
                  disabled={submitting}
                  className="w-full"
                  data-testid="button-migrate-decline"
                >
                  No thanks, keep my current payment method
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Payments are protected by the{' '}
                <a
                  href="https://gocardless.com/direct-debit/guarantee/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  data-testid="link-migrate-guarantee"
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
