import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2, AlertCircle, Lock, Eye, EyeOff, ArrowLeft, Check } from "lucide-react";
import { createPageUrl } from "@/utils";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tokenParam = urlParams.get('token');
    const emailParam = urlParams.get('email');
    
    if (tokenParam) setToken(tokenParam);
    if (emailParam) setEmail(decodeURIComponent(emailParam));
    
    if (!tokenParam || !emailParam) {
      setError("Invalid reset link. Please request a new password reset.");
    }
  }, []);

  const handleSubmit = async (e) => {
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
      const response = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          email: email.toLowerCase().trim(), 
          password,
          token 
        })
      });

      const data = await response.json();

      if (data.success) {
        setSuccess(true);
        
        // Store member info for backward compatibility
        if (data.member) {
          const sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          const memberInfo = { ...data.member, sessionExpiry };
          sessionStorage.setItem('agcas_member', JSON.stringify(memberInfo));
        }
        
        // Redirect after short delay
        setTimeout(() => {
          window.location.href = createPageUrl('Preferences');
        }, 2000);
      } else {
        setError(data.error || "Failed to reset password");
      }
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex justify-center p-4">
      <div className="w-full max-w-md" style={{ marginTop: '50px' }}>
        <Card className="shadow-xl border-slate-200">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-2xl font-bold text-center">
              Reset Your Password
            </CardTitle>
            <CardDescription className="text-center">
              {email && `Create a new password for ${email}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {success ? (
              <div className="space-y-4">
                <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
                  <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-medium text-green-800">Password reset successful!</p>
                    <p className="text-sm text-green-700 mt-1">
                      Your password has been updated. Redirecting you now...
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {error && (
                  <div className="flex items-start gap-3 p-3 mb-4 bg-red-50 border border-red-200 rounded-lg">
                    <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
                    <p className="text-sm text-red-700">{error}</p>
                  </div>
                )}

                {token && email ? (
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="new-password">New Password</Label>
                      <div className="relative">
                        <Input
                          id="new-password"
                          type={showPassword ? "text" : "password"}
                          placeholder="Enter your new password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="pr-10"
                          required
                          minLength={8}
                          data-testid="input-new-password"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      
                      {/* Password Strength Indicator */}
                      {password && (
                        <div className="space-y-2">
                          <div className="flex gap-1">
                            {[1, 2, 3, 4, 5].map((level) => {
                              const strength = (() => {
                                let score = 0;
                                if (password.length >= 8) score++;
                                if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
                                if (/[0-9]/.test(password)) score++;
                                if (/[^a-zA-Z0-9]/.test(password)) score++;
                                if (password.length >= 12) score++;
                                return score;
                              })();
                              return (
                                <div
                                  key={level}
                                  className={`h-1 flex-1 rounded-full ${
                                    level <= strength
                                      ? strength <= 2
                                        ? 'bg-red-500'
                                        : strength <= 3
                                        ? 'bg-yellow-500'
                                        : 'bg-green-500'
                                      : 'bg-slate-200'
                                  }`}
                                />
                              );
                            })}
                          </div>
                          <div className="text-xs text-slate-500 space-y-1">
                            <div className={`flex items-center gap-1 ${password.length >= 8 ? 'text-green-600' : ''}`}>
                              {password.length >= 8 ? <Check className="w-3 h-3" /> : <span className="w-3 h-3" />}
                              At least 8 characters
                            </div>
                            <div className={`flex items-center gap-1 ${/[a-z]/.test(password) && /[A-Z]/.test(password) ? 'text-green-600' : ''}`}>
                              {/[a-z]/.test(password) && /[A-Z]/.test(password) ? <Check className="w-3 h-3" /> : <span className="w-3 h-3" />}
                              Upper and lowercase letters
                            </div>
                            <div className={`flex items-center gap-1 ${/[0-9]/.test(password) ? 'text-green-600' : ''}`}>
                              {/[0-9]/.test(password) ? <Check className="w-3 h-3" /> : <span className="w-3 h-3" />}
                              At least one number
                            </div>
                            <div className={`flex items-center gap-1 ${/[^a-zA-Z0-9]/.test(password) ? 'text-green-600' : ''}`}>
                              {/[^a-zA-Z0-9]/.test(password) ? <Check className="w-3 h-3" /> : <span className="w-3 h-3" />}
                              At least one special character
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="confirm-password">Confirm New Password</Label>
                      <Input
                        id="confirm-password"
                        type="password"
                        placeholder="Confirm your new password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        required
                        data-testid="input-confirm-password"
                      />
                      {confirmPassword && password !== confirmPassword && (
                        <p className="text-xs text-red-500">Passwords do not match</p>
                      )}
                      {confirmPassword && password === confirmPassword && (
                        <p className="text-xs text-green-600 flex items-center gap-1">
                          <Check className="w-3 h-3" /> Passwords match
                        </p>
                      )}
                    </div>

                    <Button
                      type="submit"
                      className="w-full bg-blue-600 hover:bg-blue-700"
                      disabled={loading || !password || !confirmPassword || password !== confirmPassword}
                      data-testid="button-reset-password"
                    >
                      {loading ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Setting Password...
                        </>
                      ) : (
                        <>
                          <Lock className="w-4 h-4 mr-2" />
                          Set Password
                        </>
                      )}
                    </Button>
                  </form>
                ) : (
                  <div className="text-center py-4">
                    <a 
                      href="/"
                      className="inline-flex items-center text-blue-600 hover:text-blue-800"
                    >
                      <ArrowLeft className="h-4 w-4 mr-2" />
                      Back to login
                    </a>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
