import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2, CheckCircle2, AlertCircle, Users, Mail, Building2, LogIn
} from "lucide-react";

// Public team invite acceptance/signup page (Task #3392). Standalone route
// (/team-invite/:token) outside the authenticated layout — no login required.

export default function TeamInvitePage() {
  const { token } = useParams();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/team-invites/${token}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || "This invitation link is invalid or has expired.");
      } else {
        setData(json);
      }
    } catch {
      setError("Something went wrong loading this page. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadDetails();
  }, [loadDetails]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setFormError("Please enter your first and last name.");
      return;
    }
    if (password.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setFormError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/team-invites/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          password,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setFormError(json?.error || "Could not complete signup. Please try again.");
      } else if (json.existingAccount) {
        setData(json);
      } else if (json.alreadyHandled || (json.status && json.status !== "accepted" && !json.success)) {
        setData(json);
      } else {
        setResult(json);
        if (json.signedIn) {
          // Full reload so the app picks up the new session cookie.
          setTimeout(() => {
            window.location.href = "/";
          }, 1500);
        }
      }
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const primaryColor = data?.tenant?.primary_color || undefined;
  const status = data?.status;
  const loginHref = `/login${data?.email ? `?email=${encodeURIComponent(data.email)}` : ""}`;

  const showSignupForm =
    !loading && !error && data && status === "pending" && !data.existingAccount && !result;

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg" data-testid="card-team-invite">
        <CardHeader>
          <div className="flex items-center gap-3">
            {data?.tenant?.logo_url ? (
              <img
                src={data.tenant.logo_url}
                alt={data?.tenant?.name || "Logo"}
                className="h-10 w-10 rounded-md object-contain"
                data-testid="img-tenant-logo"
              />
            ) : (
              <span
                className="h-10 w-10 rounded-md flex items-center justify-center text-white"
                style={{ backgroundColor: primaryColor || "hsl(var(--primary))" }}
              >
                <Users className="h-5 w-5" />
              </span>
            )}
            <div>
              <CardTitle data-testid="text-invite-title">Team invitation</CardTitle>
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
              <AlertCircle className="w-10 h-10 text-muted-foreground" />
              <p className="text-sm text-foreground">{error}</p>
            </div>
          )}

          {result && (
            <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="status-success">
              <CheckCircle2 className="w-10 h-10 text-green-600" />
              <p className="text-sm font-medium text-foreground">Your account has been created.</p>
              {result.signedIn ? (
                <p className="text-sm text-muted-foreground">Signing you in…</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">You can now log in with your new password.</p>
                  <Button asChild data-testid="button-go-login">
                    <a href={loginHref}>
                      <LogIn className="w-4 h-4" />
                      Go to login
                    </a>
                  </Button>
                </>
              )}
            </div>
          )}

          {!loading && !error && data && !result && (
            <>
              <div className="rounded-md border border-border p-4 space-y-3" data-testid="section-invite-details">
                {data.inviter_name && (
                  <div className="flex items-center gap-2 text-sm">
                    <Users className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground w-28 shrink-0">Invited by</span>
                    <span className="font-medium" data-testid="text-inviter-name">{data.inviter_name}</span>
                  </div>
                )}
                {data.organization?.name && (
                  <div className="flex items-center gap-2 text-sm">
                    <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground w-28 shrink-0">Organization</span>
                    <span className="font-medium" data-testid="text-organization-name">{data.organization.name}</span>
                  </div>
                )}
                {data.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground w-28 shrink-0">Email</span>
                    <span className="font-medium break-all" data-testid="text-invitee-email">{data.email}</span>
                  </div>
                )}
              </div>

              {status === "pending" && data.existingAccount && (
                <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="status-existing-account">
                  <AlertCircle className="w-10 h-10 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">
                    An account with this email already exists.
                  </p>
                  <p className="text-sm text-muted-foreground">Please log in instead.</p>
                  <Button asChild data-testid="button-existing-login">
                    <a href={loginHref}>
                      <LogIn className="w-4 h-4" />
                      Go to login
                    </a>
                  </Button>
                </div>
              )}

              {showSignupForm && (
                <form onSubmit={handleSubmit} className="space-y-4" data-testid="form-signup">
                  <p className="text-sm text-muted-foreground">
                    Create your account to accept this invitation.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="first-name">First name</Label>
                      <Input
                        id="first-name"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        autoComplete="given-name"
                        data-testid="input-first-name"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="last-name">Last name</Label>
                      <Input
                        id="last-name"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        autoComplete="family-name"
                        data-testid="input-last-name"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                      data-testid="input-password"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password">Confirm password</Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                      data-testid="input-confirm-password"
                    />
                  </div>
                  {formError && (
                    <p className="text-sm text-destructive" data-testid="text-form-error">{formError}</p>
                  )}
                  <Button type="submit" className="w-full" disabled={submitting} data-testid="button-create-account">
                    {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    Create account
                  </Button>
                </form>
              )}

              {status === "accepted" && (
                <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="status-accepted">
                  <CheckCircle2 className="w-10 h-10 text-green-600" />
                  <p className="text-sm font-medium text-foreground">This invitation has already been used.</p>
                  <p className="text-sm text-muted-foreground">If this was you, log in with the password you set.</p>
                  <Button asChild variant="outline" data-testid="button-used-login">
                    <a href={loginHref}>
                      <LogIn className="w-4 h-4" />
                      Go to login
                    </a>
                  </Button>
                </div>
              )}

              {status === "expired" && (
                <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="status-expired">
                  <AlertCircle className="w-10 h-10 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">This invitation has expired.</p>
                  <p className="text-sm text-muted-foreground">
                    Please ask the person who invited you to send a new invitation.
                  </p>
                </div>
              )}

              {(status === "superseded" || status === "cancelled") && (
                <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="status-superseded">
                  <AlertCircle className="w-10 h-10 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">This invitation link is no longer active.</p>
                  <p className="text-sm text-muted-foreground">
                    A newer invitation was sent to this email address — please use the link in the most recent email.
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
