import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Mail, Loader2, CheckCircle2, AlertCircle, Lock, Eye, EyeOff, ArrowLeft } from "lucide-react";
import { SiGoogle } from "react-icons/si";
import { createPageUrl } from "@/utils";
import { getTenantSlugFromLocation } from "@/api/publicClient";

/**
 * Self-contained login/set-password/forgot-password form.
 *
 * Reads URL params (returnTo, resourceId, mode, token, email, error) from
 * window.location.search so it works identically whether rendered standalone
 * in Login.jsx or embedded as a canvas block on a custom /login page.
 *
 * Props:
 *   className  – extra class on the outer wrapper div
 */
export default function LoginForm({ className }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("login");
  const [emailSent, setEmailSent] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [googleLoginEnabled, setGoogleLoginEnabled] = useState(null);
  const [resetToken, setResetToken] = useState("");

  const urlParams = new URLSearchParams(window.location.search);
  const returnTo = urlParams.get('returnTo');
  const resourceId = urlParams.get('resourceId');
  const groupId = urlParams.get('groupId');
  const oauthError = urlParams.get('error');
  const urlMode = urlParams.get('mode');
  const urlToken = urlParams.get('token');
  const urlEmail = urlParams.get('email');

  useEffect(() => {
    if (urlMode === 'set-password' && urlToken) {
      setMode('set-password');
      setResetToken(urlToken);
      if (urlEmail) setEmail(decodeURIComponent(urlEmail));
      window.history.replaceState({}, '', '/login');
    }
  }, [urlMode, urlToken, urlEmail]);

  useEffect(() => {
    if (oauthError) {
      const msgs = {
        'oauth_denied': 'Google sign-in was cancelled',
        'no_account': 'No account found for this Google email. Please sign in with your email and password first.',
        'login_disabled': 'Login is disabled for this account. Please contact an administrator.',
        'link_failed': 'Failed to link Google account. Please try again.',
        'callback_failed': 'Google sign-in failed. Please try again.',
        'invalid_state': 'Sign-in session expired. Please try again.',
        'csrf_error': 'Security check failed. Please try signing in again.',
        'missing_params': 'Sign-in was incomplete. Please try again.',
        'google_disabled': 'Google sign-in is not available for this organization. Please use email and password.',
        'organisation_login_gate': 'Login is not currently available for your organisation. Please contact your administrator.',
      };
      setError(msgs[oauthError] || 'Sign-in failed. Please try again.');
      window.history.replaceState({}, '', '/login');
    }
  }, [oauthError]);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const r = await fetch('/api/auth/me', { credentials: 'include' });
        if (r.ok) {
          const data = await r.json();
          if (data.authenticated && data.member) redirectToLandingPage(data.member);
        }
      } catch {}
    };
    checkAuth();

    const fetchSettings = async () => {
      try {
        const r = await fetch('/api/auth/tenant-public-settings', { credentials: 'include' });
        if (r.ok) {
          const data = await r.json();
          if (data.success && data.settings) {
            setGoogleLoginEnabled(data.settings.member_google_login_enabled !== false);
          } else {
            setGoogleLoginEnabled(true);
          }
        } else {
          setGoogleLoginEnabled(true);
        }
      } catch {
        setGoogleLoginEnabled(true);
      }
    };
    fetchSettings();
  }, []);

  const redirectToLandingPage = async (member) => {
    const sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem('agcas_member', JSON.stringify({ ...member, sessionExpiry }));
    if (returnTo) {
      if (resourceId) {
        window.location.href = `${returnTo}?resourceId=${resourceId}`;
      } else if (groupId) {
        window.location.href = `${returnTo}?id=${groupId}`;
      } else {
        window.location.href = returnTo;
      }
      return;
    }
    let landingPage = 'Preferences';
    if (member.role_id) {
      try {
        const allRoles = await base44.entities.Role.list();
        const userRole = allRoles.find(r => r.id === member.role_id);
        if (userRole?.default_landing_page) landingPage = userRole.default_landing_page;
      } catch {}
    }
    const slug = getTenantSlugFromLocation();
    if (slug && slug.toLowerCase() === 'gsf') {
      landingPage = 'MemberDemo';
    }
    if (slug && slug.toLowerCase() === 'bnms') {
      landingPage = 'BnmsMemberDemo';
    }
    window.location.href = createPageUrl(landingPage);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email.toLowerCase().trim(), password }),
      });
      const data = await r.json();
      if (data.success) {
        const sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        localStorage.setItem('agcas_member', JSON.stringify({ ...data.member, sessionExpiry }));
        if (data.requiresPasswordChange) { setMode("set-password"); setPassword(""); }
        else redirectToLandingPage(data.member);
      } else if (data.needsPasswordSetup) {
        setMode("set-password"); setPassword("");
      } else {
        setError(data.error || "Invalid email or password");
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSetPassword = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    setLoading(true);
    try {
      const payload = { email: email.toLowerCase().trim(), password };
      if (resetToken) payload.token = resetToken;
      const r = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (data.success) {
        const sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        localStorage.setItem('agcas_member', JSON.stringify({ ...data.member, sessionExpiry }));
        redirectToLandingPage(data.member);
      } else {
        setError(data.error || "Failed to set password");
      }
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const r = await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.toLowerCase().trim() }),
      });
      const data = await r.json();
      if (data.success) setEmailSent(true);
      else setError(data.error || "Failed to send reset email");
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={className}>
      <Card className="shadow-xl border-slate-200">
        <CardHeader className="space-y-1 pb-4">
          <CardTitle className="text-2xl font-bold text-center">
            {mode === "login" && "Member Access"}
            {mode === "set-password" && "Create Your Password"}
            {mode === "forgot-password" && "Reset Password"}
          </CardTitle>
          <CardDescription className="text-center">
            {mode === "login" && "Enter your email and password to sign in"}
            {mode === "set-password" && "Create a password for your account"}
            {mode === "forgot-password" && "Enter your email to receive a reset link"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {emailSent ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
                <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium text-green-800">Reset link sent!</p>
                  <p className="text-sm text-green-700 mt-1">
                    We've sent a password reset link to your email. Click the link to reset your password.
                  </p>
                </div>
              </div>
              <Button variant="outline" className="w-full" onClick={() => { setEmailSent(false); setMode("login"); }} data-testid="button-back-to-login">
                <ArrowLeft className="h-4 w-4 mr-2" />Back to login
              </Button>
            </div>
          ) : (
            <>
              {error && (
                <div className="flex items-start gap-3 p-3 mb-4 bg-red-50 border border-red-200 rounded-lg">
                  <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
                  <p className="text-sm text-red-700 whitespace-pre-line" data-testid="text-login-error">{error}</p>
                </div>
              )}

              {mode === "login" && (
                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="lf-email">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <Input id="lf-email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="pl-10" required data-testid="input-email" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lf-password">Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <Input id="lf-password" type={showPassword ? "text" : "password"} placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} className="pl-10 pr-10" required data-testid="input-password" />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" data-testid="button-toggle-password">
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <Button type="submit" className="w-full" disabled={loading || !email || !password} data-testid="button-login">
                    {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Signing in...</> : "Sign In"}
                  </Button>
                  {googleLoginEnabled === true && (
                    <>
                      <div className="relative my-4">
                        <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-slate-200" /></div>
                        <div className="relative flex justify-center text-xs uppercase"><span className="bg-white px-2 text-slate-500">Or continue with</span></div>
                      </div>
                      <Button type="button" variant="outline" className="w-full" onClick={() => { window.location.href = returnTo ? `/api/auth/google?returnTo=${encodeURIComponent(returnTo)}` : '/api/auth/google'; }} data-testid="button-google-login">
                        <SiGoogle className="mr-2 h-4 w-4" />Sign in with Google
                      </Button>
                    </>
                  )}
                  <div className="text-center">
                    <button type="button" onClick={() => setMode("forgot-password")} className="text-sm text-blue-600 hover:text-blue-800" data-testid="link-forgot-password">
                      Forgot password?
                    </button>
                  </div>
                </form>
              )}

              {mode === "set-password" && (
                <form onSubmit={handleSetPassword} className="space-y-4">
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 mb-4">
                    Welcome! Since this is your first time, please create a password for your account.
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lf-email-set">Email</Label>
                    <Input id="lf-email-set" type="email" value={email} disabled className="bg-slate-50" data-testid="input-email-set" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lf-new-password">Create Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <Input id="lf-new-password" type={showPassword ? "text" : "password"} placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} className="pl-10 pr-10" required minLength={8} data-testid="input-new-password" />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lf-confirm-password">Confirm Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <Input id="lf-confirm-password" type={showPassword ? "text" : "password"} placeholder="Confirm your password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="pl-10" required data-testid="input-confirm-password" />
                    </div>
                  </div>
                  <Button type="submit" className="w-full" disabled={loading || !password || !confirmPassword} data-testid="button-set-password">
                    {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating...</> : "Create Password & Sign In"}
                  </Button>
                  <Button type="button" variant="outline" className="w-full" onClick={() => { setMode("login"); setPassword(""); setConfirmPassword(""); }} data-testid="button-back-from-set">
                    <ArrowLeft className="h-4 w-4 mr-2" />Back to login
                  </Button>
                </form>
              )}

              {mode === "forgot-password" && (
                <form onSubmit={handleForgotPassword} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="lf-email-reset">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                      <Input id="lf-email-reset" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="pl-10" required data-testid="input-email-reset" />
                    </div>
                  </div>
                  <Button type="submit" className="w-full" disabled={loading || !email} data-testid="button-send-reset">
                    {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending...</> : "Send Reset Link"}
                  </Button>
                  <Button type="button" variant="outline" className="w-full" onClick={() => setMode("login")} data-testid="button-back-from-reset">
                    <ArrowLeft className="h-4 w-4 mr-2" />Back to login
                  </Button>
                </form>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
