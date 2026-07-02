import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Loader2, Building2, CheckCircle2, AlertCircle, Mail } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

// Self-serve signup is now a two-step email-verification flow:
//   1. This page collects the org/admin details and POSTs to /api/public/signup-start
//   2. The user clicks the link in their email, lands on /signup-verify, which
//      calls /api/public/signup-verify to provision the tenant in 'pending'
//      onboarding state and redirect into the wizard.
//
// Captcha (hCaptcha / Turnstile / reCAPTCHA) is enabled when
// VITE_CAPTCHA_PROVIDER + VITE_CAPTCHA_SITE_KEY are set; otherwise the page
// works without it (and the server bypasses captcha in non-production too).

const CAPTCHA_PROVIDER = import.meta.env.VITE_CAPTCHA_PROVIDER || null;
const CAPTCHA_SITE_KEY = import.meta.env.VITE_CAPTCHA_SITE_KEY || null;

export default function TenantSignup() {
  const [searchParams] = useSearchParams();
  const [formData, setFormData] = useState({
    tenantName: "",
    slug: "",
    adminEmail: "",
    adminFirstName: "",
    adminLastName: "",
    password: "",
    confirmPassword: "",
  });
  const [captchaToken, setCaptchaToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [slugAvailable, setSlugAvailable] = useState(null);
  const [checkingSlug, setCheckingSlug] = useState(false);

  useEffect(() => {
    const oauthError = searchParams.get("error");
    if (oauthError) setError("Sign-up failed. Please try again.");
  }, [searchParams]);

  const generateSlug = (name) =>
    name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").substring(0, 50);

  const handleNameChange = (e) => {
    const name = e.target.value;
    setFormData(prev => ({ ...prev, tenantName: name, slug: generateSlug(name) }));
    setSlugAvailable(null);
  };

  const handleSlugChange = (e) => {
    const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setFormData(prev => ({ ...prev, slug }));
    setSlugAvailable(null);
  };

  const checkSlug = async () => {
    if (!formData.slug || formData.slug.length < 3) return;
    setCheckingSlug(true);
    try {
      const r = await fetch(`/api/functions/check-tenant-slug?slug=${formData.slug}`);
      const j = await r.json();
      setSlugAvailable(j.available);
    } finally {
      setCheckingSlug(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (formData.password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (formData.password !== formData.confirmPassword) { setError("Passwords do not match."); return; }
    if (formData.slug.length < 3) { setError("Subdomain must be at least 3 characters."); return; }
    if (CAPTCHA_PROVIDER && CAPTCHA_SITE_KEY && !captchaToken) {
      setError("Please complete the captcha."); return;
    }

    setLoading(true);
    try {
      const resp = await fetch("/api/public/signup-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantName: formData.tenantName,
          slug: formData.slug,
          adminEmail: formData.adminEmail.toLowerCase().trim(),
          adminFirstName: formData.adminFirstName,
          adminLastName: formData.adminLastName,
          password: formData.password,
          captchaToken: captchaToken || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) { setError(data.error || "Could not start signup."); return; }
      setSubmitted(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Mail className="w-6 h-6 text-primary" />
            </div>
            <CardTitle className="mt-4">Check your email</CardTitle>
            <CardDescription>
              We've sent a verification link to <strong>{formData.adminEmail}</strong>. Click it to finish creating your workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground text-center">
              The link expires in 1 hour. Didn't get it? Check your spam folder.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Building2 className="w-6 h-6 text-primary" />
          </div>
          <CardTitle>Create your workspace</CardTitle>
          <CardDescription>Free to start — verify your email and we'll set it up.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="tenantName">Organisation name</Label>
              <Input id="tenantName" placeholder="Acme Corporation" value={formData.tenantName}
                onChange={handleNameChange} required data-testid="input-tenant-name" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">Subdomain</Label>
              <div className="flex items-center gap-2">
                <Input id="slug" placeholder="acme" value={formData.slug} onChange={handleSlugChange}
                  onBlur={checkSlug} required className="flex-1" data-testid="input-slug" />
                <span className="text-sm text-muted-foreground whitespace-nowrap">.iconn.app</span>
              </div>
              {checkingSlug && <p className="text-xs text-muted-foreground">Checking…</p>}
              {slugAvailable === true && (
                <p className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Available</p>
              )}
              {slugAvailable === false && (
                <p className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Already taken</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="adminFirstName">First name</Label>
                <Input id="adminFirstName" placeholder="John" value={formData.adminFirstName}
                  onChange={(e) => setFormData(p => ({ ...p, adminFirstName: e.target.value }))} required data-testid="input-first-name" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="adminLastName">Last name</Label>
                <Input id="adminLastName" placeholder="Doe" value={formData.adminLastName}
                  onChange={(e) => setFormData(p => ({ ...p, adminLastName: e.target.value }))} required data-testid="input-last-name" />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="adminEmail">Email address</Label>
              <Input id="adminEmail" type="email" placeholder="john@acme.com" value={formData.adminEmail}
                onChange={(e) => setFormData(p => ({ ...p, adminEmail: e.target.value }))} required data-testid="input-email" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" placeholder="At least 8 characters" value={formData.password}
                onChange={(e) => setFormData(p => ({ ...p, password: e.target.value }))} required data-testid="input-password" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm password</Label>
              <Input id="confirmPassword" type="password" value={formData.confirmPassword}
                onChange={(e) => setFormData(p => ({ ...p, confirmPassword: e.target.value }))} required data-testid="input-confirm-password" />
            </div>

            {CAPTCHA_PROVIDER && CAPTCHA_SITE_KEY && (
              <div className="space-y-2">
                <Label>Verify you're human</Label>
                <Input
                  placeholder="Paste captcha token"
                  value={captchaToken}
                  onChange={(e) => setCaptchaToken(e.target.value)}
                  data-testid="input-captcha-token"
                />
                <p className="text-xs text-muted-foreground">Captcha widget integration ({CAPTCHA_PROVIDER}) — configure in your provider's docs.</p>
              </div>
            )}
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <Button type="submit" className="w-full"
              disabled={loading || slugAvailable === false}
              data-testid="button-create-workspace">
              {loading ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending verification email…</>) : "Create workspace"}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Already have an account?{" "}
              <a href="/Login" className="text-primary hover:underline" data-testid="link-login">Log in</a>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
