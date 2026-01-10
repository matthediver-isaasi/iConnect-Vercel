import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Loader2, Building2, CheckCircle2, AlertCircle, Globe, Mail, User } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SiGoogle } from "react-icons/si";
import { Separator } from "@/components/ui/separator";

export default function TenantSignup() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [googleData, setGoogleData] = useState(null);
  const [formData, setFormData] = useState({
    tenantName: "",
    slug: "",
    adminEmail: "",
    adminFirstName: "",
    adminLastName: "",
    password: "",
    confirmPassword: ""
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [createdTenant, setCreatedTenant] = useState(null);
  const [slugAvailable, setSlugAvailable] = useState(null);
  const [checkingSlug, setCheckingSlug] = useState(false);
  const [showLinkAccountOption, setShowLinkAccountOption] = useState(false);
  const [linkingAccount, setLinkingAccount] = useState(false);

  useEffect(() => {
    const oauthError = searchParams.get('error');
    if (oauthError) {
      const errorMessages = {
        'oauth_denied': 'Google sign-up was cancelled',
        'invalid_state': 'Sign-up session expired. Please try again.',
        'csrf_error': 'Security check failed. Please try again.',
        'missing_params': 'Sign-up was incomplete. Please try again.',
        'callback_failed': 'Google sign-up failed. Please try again.'
      };
      setError(errorMessages[oauthError] || 'Sign-up failed. Please try again.');
      window.history.replaceState({}, '', '/signup');
    }
    
    if (searchParams.get('google') === 'true') {
      fetch('/api/tenant/auth/google-signup/data', { credentials: 'include' })
        .then(res => {
          if (res.ok) return res.json();
          throw new Error('Failed to fetch Google data');
        })
        .then(data => {
          setGoogleData(data);
          setFormData(prev => ({
            ...prev,
            adminEmail: data.email || '',
            adminFirstName: data.firstName || '',
            adminLastName: data.lastName || ''
          }));
        })
        .catch(e => {
          console.error('Failed to fetch Google data:', e);
          setError('Failed to retrieve Google account information. Please try again.');
        });
      window.history.replaceState({}, '', '/signup');
    }
  }, [searchParams]);

  const generateSlug = (name) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 50);
  };

  const handleNameChange = (e) => {
    const name = e.target.value;
    setFormData(prev => ({
      ...prev,
      tenantName: name,
      slug: generateSlug(name)
    }));
    setSlugAvailable(null);
  };

  const handleSlugChange = (e) => {
    const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    setFormData(prev => ({ ...prev, slug }));
    setSlugAvailable(null);
  };

  const checkSlugAvailability = async () => {
    if (!formData.slug || formData.slug.length < 3) return;
    
    setCheckingSlug(true);
    try {
      const response = await fetch(`/api/functions/check-tenant-slug?slug=${formData.slug}`);
      const data = await response.json();
      setSlugAvailable(data.available);
    } catch (err) {
      console.error('Error checking slug:', err);
    } finally {
      setCheckingSlug(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!googleData) {
      if (formData.password.length < 8) {
        setError("Password must be at least 8 characters");
        return;
      }

      if (formData.password !== formData.confirmPassword) {
        setError("Passwords do not match");
        return;
      }
    }

    if (formData.slug.length < 3) {
      setError("Subdomain must be at least 3 characters");
      return;
    }

    setLoading(true);

    try {
      const payload = {
        tenantName: formData.tenantName,
        slug: formData.slug,
        adminEmail: formData.adminEmail.toLowerCase().trim(),
        adminFirstName: formData.adminFirstName,
        adminLastName: formData.adminLastName
      };

      if (googleData) {
        payload.googleId = googleData.googleId;
      } else {
        payload.password = formData.password;
      }

      const response = await fetch('/api/functions/provision-tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (data.success) {
        setSuccess(true);
        setCreatedTenant(data.tenant);
      } else if (response.status === 409 && data.canLinkAccount) {
        // Existing account found - offer to link
        setShowLinkAccountOption(true);
        setError("");
      } else {
        setError(data.error || "Failed to create account. Please try again.");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleLinkAccount = async () => {
    setLinkingAccount(true);
    setError("");

    try {
      const payload = {
        tenantName: formData.tenantName,
        slug: formData.slug,
        adminEmail: formData.adminEmail.toLowerCase().trim(),
        adminFirstName: formData.adminFirstName,
        adminLastName: formData.adminLastName,
        linkExistingAccount: true
      };

      if (googleData) {
        payload.googleId = googleData.googleId;
      } else {
        payload.password = formData.password;
      }

      const response = await fetch('/api/functions/provision-tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (data.success) {
        setSuccess(true);
        setCreatedTenant(data.tenant);
      } else {
        setError(data.error || "Failed to link account. Please try again.");
        setShowLinkAccountOption(false);
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
      setShowLinkAccountOption(false);
    } finally {
      setLinkingAccount(false);
    }
  };

  const handleGoogleSignup = () => {
    window.location.href = '/api/tenant/auth/google-signup';
  };

  if (success && createdTenant) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center mb-4">
              <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-400" />
            </div>
            <CardTitle>Account Created!</CardTitle>
            <CardDescription>
              Your workspace is ready to use
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-muted rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Building2 className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium">{createdTenant.name}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Globe className="w-4 h-4 text-muted-foreground" />
                <span className="text-primary">{createdTenant.slug}.iconn.app</span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground text-center">
              You can now log in with your email and password to access your workspace.
            </p>
          </CardContent>
          <CardFooter>
            <Button 
              className="w-full" 
              onClick={() => window.location.href = `https://${createdTenant.slug}.iconn.app/Login`}
              data-testid="button-go-to-workspace"
            >
              Go to Your Workspace
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <Building2 className="w-6 h-6 text-primary" />
          </div>
          <CardTitle>Create Your Workspace</CardTitle>
          <CardDescription>
            Set up your organization on iconn.app
          </CardDescription>
          <p className="text-xs text-muted-foreground mt-2">v2.1-multi-tenant</p>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {showLinkAccountOption && (
              <Alert className="border-primary bg-primary/5">
                <User className="h-4 w-4 text-primary" />
                <AlertDescription className="space-y-3">
                  <p>
                    <strong>You already have an account!</strong>
                  </p>
                  <p className="text-muted-foreground">
                    An account with <strong>{formData.adminEmail}</strong> already exists. 
                    Would you like to add this new workspace to your existing account?
                  </p>
                  <div className="flex gap-2 pt-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleLinkAccount}
                      disabled={linkingAccount}
                      data-testid="button-link-account"
                    >
                      {linkingAccount ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Linking...
                        </>
                      ) : (
                        "Yes, Add Workspace"
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setShowLinkAccountOption(false);
                        setFormData(prev => ({ ...prev, adminEmail: "" }));
                      }}
                      data-testid="button-use-different-email"
                    >
                      Use Different Email
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {!googleData && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={handleGoogleSignup}
                  data-testid="button-google-signup"
                >
                  <SiGoogle className="mr-2 h-4 w-4" />
                  Continue with Google
                </Button>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <Separator className="w-full" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">
                      Or continue with email
                    </span>
                  </div>
                </div>
              </>
            )}

            {googleData && (
              <Alert>
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <AlertDescription>
                  Signed in with Google as {googleData.email}
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="tenantName">Organization Name</Label>
              <Input
                id="tenantName"
                placeholder="Acme Corporation"
                value={formData.tenantName}
                onChange={handleNameChange}
                required
                data-testid="input-tenant-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">Subdomain</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="slug"
                  placeholder="acme"
                  value={formData.slug}
                  onChange={handleSlugChange}
                  onBlur={checkSlugAvailability}
                  required
                  className="flex-1"
                  data-testid="input-slug"
                />
                <span className="text-sm text-muted-foreground whitespace-nowrap">.iconn.app</span>
              </div>
              {checkingSlug && (
                <p className="text-xs text-muted-foreground">Checking availability...</p>
              )}
              {slugAvailable === true && (
                <p className="text-xs text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Available
                </p>
              )}
              {slugAvailable === false && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> Already taken
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="adminFirstName">First Name</Label>
                <Input
                  id="adminFirstName"
                  placeholder="John"
                  value={formData.adminFirstName}
                  onChange={(e) => setFormData(prev => ({ ...prev, adminFirstName: e.target.value }))}
                  required
                  data-testid="input-first-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="adminLastName">Last Name</Label>
                <Input
                  id="adminLastName"
                  placeholder="Doe"
                  value={formData.adminLastName}
                  onChange={(e) => setFormData(prev => ({ ...prev, adminLastName: e.target.value }))}
                  required
                  data-testid="input-last-name"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="adminEmail">Email Address</Label>
              <Input
                id="adminEmail"
                type="email"
                placeholder="john@acme.com"
                value={formData.adminEmail}
                onChange={(e) => setFormData(prev => ({ ...prev, adminEmail: e.target.value }))}
                required
                readOnly={!!googleData}
                className={googleData ? "bg-muted" : ""}
                data-testid="input-email"
              />
            </div>

            {!googleData && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="At least 8 characters"
                    value={formData.password}
                    onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                    required
                    data-testid="input-password"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder="Confirm your password"
                    value={formData.confirmPassword}
                    onChange={(e) => setFormData(prev => ({ ...prev, confirmPassword: e.target.value }))}
                    required
                    data-testid="input-confirm-password"
                  />
                </div>
              </>
            )}
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <Button 
              type="submit" 
              className="w-full" 
              disabled={loading || slugAvailable === false || showLinkAccountOption}
              data-testid="button-create-workspace"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating Workspace...
                </>
              ) : (
                "Create Workspace"
              )}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Already have an account?{" "}
              <a href="/Login" className="text-primary hover:underline" data-testid="link-login">
                Log in
              </a>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
