import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2, CheckCircle2, XCircle, AlertCircle, UserCheck, Building2, Mail, CalendarClock
} from "lucide-react";

function formatExpiry(dateStr) {
  if (!dateStr) return 'Permanent (no expiry)';
  try {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch {
    return 'Permanent (no expiry)';
  }
}

export default function GuestApprovalPage() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const requestedAction = (searchParams.get('action') || '').toLowerCase();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const autoActioned = useRef(false);

  const submitDecision = useCallback(async (action) => {
    if (action !== 'approve' && action !== 'deny') return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/guest-approval/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || 'Could not record your decision.');
      } else {
        setData(json);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [token]);

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/guest-approval/${token}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || 'This link is invalid or has expired.');
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

  // Auto-submit when arriving from an email link with ?action=. Done client-side
  // (not a GET) so email-scanner prefetches don't consume the token.
  useEffect(() => {
    if (loading || autoActioned.current) return;
    if (data?.status === 'pending' && (requestedAction === 'approve' || requestedAction === 'deny')) {
      autoActioned.current = true;
      submitDecision(requestedAction);
    }
  }, [loading, data, requestedAction, submitDecision]);

  const primaryColor = data?.tenant?.primary_color || undefined;

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg" data-testid="card-guest-approval">
        <CardHeader>
          <div className="flex items-center gap-3">
            {data?.tenant?.logo_url ? (
              <img
                src={data.tenant.logo_url}
                alt={data?.tenant?.name || 'Logo'}
                className="h-10 w-10 rounded-md object-contain"
                data-testid="img-tenant-logo"
              />
            ) : (
              <span
                className="h-10 w-10 rounded-md flex items-center justify-center text-white"
                style={{ backgroundColor: primaryColor || 'hsl(var(--primary))' }}
              >
                <UserCheck className="h-5 w-5" />
              </span>
            )}
            <div>
              <CardTitle data-testid="text-approval-title">Guest signup approval</CardTitle>
              {data?.tenant?.name && (
                <p className="text-sm text-muted-foreground" data-testid="text-tenant-name">
                  {data.tenant.name}
                </p>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground" data-testid="status-loading">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>Loading…</span>
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="status-error">
              <AlertCircle className="w-10 h-10 text-destructive" />
              <p className="text-sm text-foreground">{error}</p>
            </div>
          )}

          {!loading && !error && data && (
            <>
              <div className="rounded-md border border-border p-4 space-y-3" data-testid="section-guest-details">
                <div className="flex items-center gap-2 text-sm">
                  <UserCheck className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground w-28">Name</span>
                  <span className="font-medium" data-testid="text-guest-name">{data.guest?.name || '—'}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground w-28">Email</span>
                  <span className="font-medium break-all" data-testid="text-guest-email">{data.guest?.email || '—'}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Building2 className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground w-28">Organisation</span>
                  <span className="font-medium" data-testid="text-guest-org">{data.guest?.organization_name || '—'}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <CalendarClock className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground w-28">Access until</span>
                  <span className="font-medium" data-testid="text-guest-expiry">{formatExpiry(data.guest?.guest_expires_at)}</span>
                </div>
              </div>

              {data.status === 'pending' && (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground text-center">
                    Approve to enable this guest's login, or deny to keep it disabled.
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <Button
                      onClick={() => submitDecision('approve')}
                      disabled={submitting}
                      data-testid="button-approve"
                    >
                      {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                      Approve access
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => submitDecision('deny')}
                      disabled={submitting}
                      data-testid="button-deny"
                    >
                      {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                      Deny access
                    </Button>
                  </div>
                </div>
              )}

              {data.status === 'approved' && (
                <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="status-approved">
                  <CheckCircle2 className="w-10 h-10 text-green-600" />
                  <p className="text-sm font-medium text-foreground">
                    {data.alreadyHandled ? 'This guest was already approved.' : 'Guest access approved.'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {data.guest?.name || 'The guest'} can now log in.
                  </p>
                  {data.warning && (
                    <p className="text-xs text-destructive">{data.warning}</p>
                  )}
                </div>
              )}

              {data.status === 'denied' && (
                <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="status-denied">
                  <XCircle className="w-10 h-10 text-destructive" />
                  <p className="text-sm font-medium text-foreground">
                    {data.alreadyHandled ? 'This guest was already denied.' : 'Guest access denied.'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {data.guest?.name || 'The guest'} will not be able to log in.
                  </p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
