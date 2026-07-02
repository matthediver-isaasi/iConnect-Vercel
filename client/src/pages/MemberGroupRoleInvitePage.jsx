import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2, CheckCircle2, XCircle, AlertCircle, UserCheck, Users, BadgeCheck, CalendarClock
} from "lucide-react";
import DOMPurify from "dompurify";

function formatExpiry(dateStr) {
  if (!dateStr) return 'No expiry';
  try {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch {
    return 'No expiry';
  }
}

export default function MemberGroupRoleInvitePage() {
  const { token } = useParams();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const submitDecision = useCallback(async (action) => {
    if (action !== 'accept' && action !== 'decline') return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/member-group-invites/${token}`, {
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
      const res = await fetch(`/api/public/member-group-invites/${token}`);
      const json = await res.json();
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

  const primaryColor = data?.tenant?.primary_color || undefined;
  const termsUrl = data?.terms_url && String(data.terms_url).trim()
    ? String(data.terms_url).trim()
    : '';

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg" data-testid="card-role-invite">
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
                <Users className="h-5 w-5" />
              </span>
            )}
            <div>
              <CardTitle data-testid="text-invite-title">Group role invitation</CardTitle>
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
              <div className="rounded-md border border-border p-4 space-y-3" data-testid="section-invite-details">
                <div className="flex items-center gap-2 text-sm">
                  <UserCheck className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground w-24 shrink-0">Member</span>
                  <span className="font-medium" data-testid="text-member-name">{data.member?.name || '—'}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Users className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground w-24 shrink-0">Group</span>
                  <span className="font-medium" data-testid="text-group-name">{data.group?.name || '—'}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <BadgeCheck className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground w-24 shrink-0">Role</span>
                  <span className="font-medium" data-testid="text-role">{data.role || '—'}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <CalendarClock className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground w-24 shrink-0">Respond by</span>
                  <span className="font-medium" data-testid="text-expiry">{formatExpiry(data.expires_at)}</span>
                </div>
              </div>

              {(termsUrl || data?.has_terms_of_reference) && (
                <div className="space-y-2" data-testid="section-terms">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Terms of reference</p>
                  {termsUrl ? (
                    <div className="rounded-md border border-border p-4 text-sm text-foreground space-y-1">
                      <p>By accepting this invite you are agreeing to the terms of reference which can be found here:</p>
                      <a
                        href={termsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all underline"
                        style={{ color: primaryColor || 'hsl(var(--primary))' }}
                        data-testid="link-terms"
                      >
                        {termsUrl}
                      </a>
                    </div>
                  ) : (
                    <div
                      className="max-h-[40vh] overflow-y-auto rounded-md border border-border bg-muted/30 p-4 text-sm text-foreground prose prose-sm max-w-none"
                      data-testid="text-terms-of-reference"
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(data.effective_terms_of_reference || ''),
                      }}
                    />
                  )}
                </div>
              )}

              {data.status === 'pending' && (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground text-center">
                    Accept to take on this role{termsUrl ? ', agreeing to the terms of reference above' : ''}, or decline.
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <Button
                      onClick={() => submitDecision('accept')}
                      disabled={submitting}
                      data-testid="button-accept"
                    >
                      {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                      Accept role
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => submitDecision('decline')}
                      disabled={submitting}
                      data-testid="button-decline"
                    >
                      {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                      Decline
                    </Button>
                  </div>
                </div>
              )}

              {data.status === 'accepted' && (
                <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="status-accepted">
                  <CheckCircle2 className="w-10 h-10 text-green-600" />
                  <p className="text-sm font-medium text-foreground">
                    {data.alreadyHandled ? 'This invitation was already accepted.' : `You're now ${data.role} of ${data.group?.name || 'the group'}.`}
                  </p>
                  {data.warning && (
                    <p className="text-xs text-destructive">{data.warning}</p>
                  )}
                </div>
              )}

              {data.status === 'declined' && (
                <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="status-declined">
                  <XCircle className="w-10 h-10 text-destructive" />
                  <p className="text-sm font-medium text-foreground">
                    {data.alreadyHandled ? 'This invitation was already declined.' : 'You have declined this invitation.'}
                  </p>
                </div>
              )}

              {(data.status === 'expired' || data.expired) && (
                <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="status-expired">
                  <AlertCircle className="w-10 h-10 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">This invitation has expired.</p>
                  <p className="text-xs text-muted-foreground">
                    Please ask the group administrator to send a new invitation.
                  </p>
                </div>
              )}

              {data.status === 'cancelled' && (
                <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="status-cancelled">
                  <AlertCircle className="w-10 h-10 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">This invitation has been cancelled.</p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
