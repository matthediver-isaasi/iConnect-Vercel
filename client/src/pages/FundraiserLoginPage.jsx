import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Heart, Loader2, Mail, CheckCircle2 } from "lucide-react";
import { getTenantSlugFromLocation } from "@/api/publicClient";

export default function FundraiserLoginPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);
  const [tenantBranding, setTenantBranding] = useState(null);

  useEffect(() => {
    const tenantSlug = getTenantSlugFromLocation();
    if (tenantSlug) {
      fetch(`/api/public/tenant-branding?tenant=${tenantSlug}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => { if (data) setTenantBranding(data); })
        .catch(() => {});
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const tenantSlug = getTenantSlugFromLocation();
      const url = tenantSlug
        ? `/api/public/fundraising/login?tenant=${tenantSlug}`
        : '/api/public/fundraising/login';

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Something went wrong');
      }

      setSubmitted(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30 p-4">
        <div className="max-w-md w-full space-y-6">
          {tenantBranding?.logo_url && (
            <div className="flex justify-center">
              <img
                src={tenantBranding.logo_url}
                alt={tenantBranding.name || 'Logo'}
                className="h-12 object-contain"
                data-testid="img-tenant-logo"
              />
            </div>
          )}
          <Card>
            <CardContent className="pt-8 pb-8 text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-7 h-7 text-green-600 dark:text-green-400" />
              </div>
              <h2 className="text-xl font-semibold" data-testid="text-success-heading">Check Your Email</h2>
              <p className="text-muted-foreground text-sm leading-relaxed" data-testid="text-success-message">
                If you have registered for any campaigns, you'll receive a login link at{' '}
                <strong>{email}</strong>. The link expires in 1 hour.
              </p>
              <Button
                variant="outline"
                onClick={() => { setSubmitted(false); setEmail(''); }}
                data-testid="button-try-another"
              >
                Try a different email
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30 p-4">
      <div className="max-w-md w-full space-y-6">
        {tenantBranding?.logo_url && (
          <div className="flex justify-center">
            <img
              src={tenantBranding.logo_url}
              alt={tenantBranding.name || 'Logo'}
              className="h-12 object-contain"
              data-testid="img-tenant-logo"
            />
          </div>
        )}
        <Card>
          <CardContent className="pt-8 pb-8 space-y-6">
            <div className="text-center space-y-2">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                <Heart className="w-6 h-6 text-primary" />
              </div>
              <h1 className="text-2xl font-bold" data-testid="text-login-heading">Fundraiser Dashboard</h1>
              <p className="text-muted-foreground text-sm">
                Enter your email to access your fundraising campaigns
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="pl-10"
                    required
                    data-testid="input-email"
                  />
                </div>
              </div>

              {error && (
                <p className="text-sm text-destructive" data-testid="text-error">{error}</p>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={loading || !email.trim()}
                data-testid="button-send-link"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <Mail className="w-4 h-4 mr-2" />
                )}
                Send Login Link
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
