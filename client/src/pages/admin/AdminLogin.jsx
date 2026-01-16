import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Loader2, Lock, Eye, EyeOff, Building2, ChevronRight, Check, ArrowLeft, Mail } from "lucide-react";
import { SiGoogle } from "react-icons/si";

export default function AdminLogin() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [showTenantSelection, setShowTenantSelection] = useState(false);
  const [availableTenants, setAvailableTenants] = useState([]);
  const [identity, setIdentity] = useState(null);
  const [setupMode, setSetupMode] = useState(false);
  const [setupToken, setSetupToken] = useState("");
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false);
  const [isSsoTenantSelection, setIsSsoTenantSelection] = useState(false);

  useEffect(() => {
    const oauthError = searchParams.get('error');
    if (oauthError) {
      const errorMessages = {
        'oauth_denied': 'Google sign-in was cancelled',
        'no_account': 'No tenant account found for this Google email. Please sign in with your email and password first.',
        'account_inactive': 'This account is inactive. Please contact support.',
        'link_failed': 'Failed to link Google account. Please try again.',
        'callback_failed': 'Google sign-in failed. Please try again.',
        'invalid_state': 'Sign-in session expired. Please try again.',
        'csrf_error': 'Security check failed. Please try signing in again.',
        'missing_params': 'Sign-in was incomplete. Please try again.'
      };
      setError(errorMessages[oauthError] || 'Sign-in failed. Please try again.');
      window.history.replaceState({}, '', '/admin/login');
    }

    // Handle SSO tenant selection (redirected from Google OAuth callback)
    const ssoSelectTenant = searchParams.get('sso_select_tenant');
    if (ssoSelectTenant === 'true') {
      try {
        const ssoData = localStorage.getItem('sso_tenant_selection');
        if (ssoData) {
          const { identity: ssoIdentity, tenants } = JSON.parse(ssoData);
          setIdentity(ssoIdentity);
          setAvailableTenants(tenants);
          setShowTenantSelection(true);
          setIsSsoTenantSelection(true);
          setCheckingAuth(false);
          // Clean up localStorage and URL
          localStorage.removeItem('sso_tenant_selection');
          window.history.replaceState({}, '', '/admin/login');
          return;
        }
      } catch (err) {
        console.log('Failed to parse SSO tenant selection data');
      }
    }

    const setup = searchParams.get('setup');
    const setupEmail = searchParams.get('email');
    if (setup && setupEmail) {
      setSetupMode(true);
      setSetupToken(setup);
      setEmail(decodeURIComponent(setupEmail));
      setCheckingAuth(false);
    }
  }, [searchParams]);

  useEffect(() => {
    if (setupMode) return;
    
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/tenant-user-me', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.tenantUser) {
            navigate('/admin/dashboard');
          }
        }
      } catch (err) {
        console.log('Not logged in');
      } finally {
        setCheckingAuth(false);
      }
    };
    checkAuth();
  }, [navigate, setupMode]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Try new multi-tenant login first
      let response = await fetch('/api/auth/tenant-identity-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email.toLowerCase().trim(), password })
      });

      // Fall back to legacy login if new endpoint not available
      if (response.status === 404) {
        response = await fetch('/api/auth/tenant-user-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email: email.toLowerCase().trim(), password })
        });
      }

      const data = await response.json();

      if (data.success) {
        // Check if user needs to select a tenant
        if (data.requiresTenantSelection && data.tenants?.length > 1) {
          setIdentity(data.identity);
          setAvailableTenants(data.tenants);
          setShowTenantSelection(true);
          setLoading(false);
          return;
        }

        localStorage.setItem('saas_admin', JSON.stringify({
          tenantUser: data.tenantUser,
          tenant: data.tenant,
          hasMultipleTenants: data.hasMultipleTenants
        }));
        navigate('/admin/dashboard');
      } else {
        setError(data.error || "Invalid email or password");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleTenantSelect = async (tenantId) => {
    setLoading(true);
    setError("");

    try {
      let response;
      let data;
      
      if (isSsoTenantSelection) {
        // For SSO, we already have a session - use tenant-switch to change tenants
        response = await fetch('/api/auth/tenant-switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ tenantId })
        });
        data = await response.json();
      } else {
        // For email/password login, use tenant-identity-login with the selected tenant
        response = await fetch('/api/auth/tenant-identity-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ 
            email: email.toLowerCase().trim(), 
            password,
            tenantId 
          })
        });
        data = await response.json();
      }

      if (data.success) {
        localStorage.setItem('saas_admin', JSON.stringify({
          tenantUser: data.tenantUser,
          tenant: data.tenant,
          hasMultipleTenants: true
        }));
        navigate('/admin/dashboard');
      } else {
        setError(data.error || "Failed to select workspace");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSetPassword = async (e) => {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/auth/set-admin-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          token: setupToken,
          email: email.toLowerCase().trim(), 
          password 
        })
      });

      const data = await response.json();

      if (data.success) {
        if (data.authenticated) {
          localStorage.setItem('saas_admin', JSON.stringify({
            tenantUser: data.tenantUser,
            tenant: data.tenant
          }));
          navigate('/admin/dashboard');
        } else {
          setSetupMode(false);
          setPassword("");
          setConfirmPassword("");
          window.history.replaceState({}, '', '/admin/login');
        }
      } else {
        setError(data.error || "Failed to set password");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setError("");
    setSuccessMessage("");

    if (!email) {
      setError("Please enter your email address");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/auth/request-admin-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.toLowerCase().trim() })
      });

      const data = await response.json();

      if (data.success) {
        setSuccessMessage("If an account exists with this email, you'll receive a password reset link shortly.");
        setEmail("");
      } else {
        setError(data.error || "Failed to send reset link");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (checkingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Setup password screen for invited users
  if (setupMode) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
        <Card className="w-full max-w-md shadow-2xl border-slate-700 bg-slate-800/50 backdrop-blur">
          <CardHeader className="text-center space-y-4">
            <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
              <Lock className="h-8 w-8 text-primary" />
            </div>
            <div>
              <CardTitle className="text-2xl font-bold text-white" data-testid="text-setup-title">
                Set Your Password
              </CardTitle>
              <CardDescription className="text-slate-400" data-testid="text-setup-description">
                Create a password to complete your account setup
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSetPassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="setup-email" className="text-slate-200">Email</Label>
                <Input
                  id="setup-email"
                  type="email"
                  value={email}
                  disabled
                  className="bg-slate-900/50 border-slate-600 text-slate-400"
                  data-testid="input-setup-email"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-password" className="text-slate-200">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                  <Input
                    id="setup-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="pl-10 pr-10 bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
                    data-testid="input-setup-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm-password" className="text-slate-200">Confirm Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                  <Input
                    id="confirm-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    className="pl-10 bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
                    data-testid="input-confirm-password"
                  />
                </div>
              </div>

              {error && (
                <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm" data-testid="text-setup-error">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={loading}
                data-testid="button-set-password"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Setting up...
                  </>
                ) : (
                  "Set Password & Continue"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Tenant selection screen
  if (showTenantSelection && availableTenants.length > 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
        <Card className="w-full max-w-md shadow-2xl border-slate-700 bg-slate-800/50 backdrop-blur">
          <CardHeader className="text-center space-y-4">
            <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
              <Building2 className="h-8 w-8 text-primary" />
            </div>
            <div>
              <CardTitle className="text-2xl font-bold text-white" data-testid="text-select-workspace-title">
                Select Workspace
              </CardTitle>
              <CardDescription className="text-slate-400" data-testid="text-select-workspace-description">
                Welcome back, {identity?.first_name || email}! Choose a workspace to continue.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {error && (
              <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm" data-testid="text-error">
                {error}
              </div>
            )}
            
            {availableTenants.map((tenant) => (
              <button
                key={tenant.id}
                onClick={() => handleTenantSelect(tenant.id)}
                disabled={loading}
                className="w-full p-4 rounded-lg border border-slate-600 bg-slate-900/50 hover:bg-slate-700/50 hover:border-slate-500 transition-all flex items-center gap-4 text-left group disabled:opacity-50"
                data-testid={`button-select-tenant-${tenant.id}`}
              >
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                  {tenant.logo_url ? (
                    <img src={tenant.logo_url} alt={tenant.name} className="w-8 h-8 rounded object-cover" />
                  ) : (
                    <Building2 className="h-5 w-5 text-primary" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white truncate">{tenant.name}</span>
                    {tenant.is_default && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-primary/20 text-primary">Default</span>
                    )}
                  </div>
                  <span className="text-sm text-slate-400 capitalize">{tenant.role}</span>
                </div>
                <ChevronRight className="h-5 w-5 text-slate-500 group-hover:text-slate-300 transition-colors" />
              </button>
            ))}

            <div className="pt-4">
              <Button
                variant="ghost"
                className="w-full text-slate-400 hover:text-slate-200"
                onClick={() => {
                  setShowTenantSelection(false);
                  setAvailableTenants([]);
                  setIdentity(null);
                  setPassword("");
                }}
                data-testid="button-back-to-login"
              >
                Sign in with a different account
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (forgotPasswordMode) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
        <Card className="w-full max-w-md shadow-2xl border-slate-700 bg-slate-800/50 backdrop-blur">
          <CardHeader className="text-center space-y-4">
            <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
              <Mail className="h-8 w-8 text-primary" />
            </div>
            <div>
              <CardTitle className="text-2xl font-bold text-white" data-testid="text-forgot-password-title">
                Reset Password
              </CardTitle>
              <CardDescription className="text-slate-400" data-testid="text-forgot-password-description">
                Enter your email to receive a password reset link
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleForgotPassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reset-email" className="text-slate-200">Email</Label>
                <Input
                  id="reset-email"
                  type="email"
                  placeholder="admin@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-reset-email"
                />
              </div>

              {error && (
                <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm" data-testid="text-error">
                  {error}
                </div>
              )}

              {successMessage && (
                <div className="p-3 rounded-md bg-green-500/10 border border-green-500/20 text-green-400 text-sm" data-testid="text-success">
                  {successMessage}
                </div>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={loading}
                data-testid="button-send-reset"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  "Send Reset Link"
                )}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full text-slate-400 hover:text-slate-200"
                onClick={() => {
                  setForgotPasswordMode(false);
                  setError("");
                  setSuccessMessage("");
                }}
                data-testid="button-back-to-login"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to sign in
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
      <Card className="w-full max-w-md shadow-2xl border-slate-700 bg-slate-800/50 backdrop-blur">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
            <Building2 className="h-8 w-8 text-primary" />
          </div>
          <div>
            <CardTitle className="text-2xl font-bold text-white" data-testid="text-admin-title">
              Tenant Admin
            </CardTitle>
            <CardDescription className="text-slate-400" data-testid="text-admin-description">
              Sign in to manage your tenant settings
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-slate-200">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="admin@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
                data-testid="input-admin-email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-slate-200">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="pl-10 pr-10 bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-admin-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setForgotPasswordMode(true);
                    setError("");
                    setPassword("");
                  }}
                  className="text-sm text-primary hover:text-primary/80 transition-colors"
                  data-testid="link-forgot-password"
                >
                  Forgot password?
                </button>
              </div>
            </div>

            {error && (
              <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm" data-testid="text-error">
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={loading}
              data-testid="button-admin-login"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign In"
              )}
            </Button>

            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-slate-600" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-slate-800 px-2 text-slate-400">Or continue with</span>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              className="w-full border-slate-600 text-slate-200 hover:bg-slate-700 hover:text-white"
              onClick={() => {
                window.location.href = '/api/tenant/auth/google';
              }}
              data-testid="button-google-login"
            >
              <SiGoogle className="mr-2 h-4 w-4" />
              Sign in with Google
            </Button>
          </form>

          <div className="mt-6 text-center">
            <a 
              href="/login" 
              className="text-sm text-slate-400 hover:text-slate-300 transition-colors"
              data-testid="link-member-login"
            >
              Member portal login
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
