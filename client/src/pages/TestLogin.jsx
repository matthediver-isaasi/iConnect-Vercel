import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  User,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Shield,
  Copy
} from "lucide-react";
import { createPageUrl } from "@/utils";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";

export default function TestLoginPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  // Load roles via base44 client
  const {
    data: roles = [],
    isLoading: rolesLoading,
    error: rolesError,
  } = useQuery({
    queryKey: ["roles"],
    queryFn: async () => {
      try {
        console.log("[TestLogin] Fetching roles...");
        const data = await base44.entities.Role.list({ sort: { name: 'asc' } });
        console.log("[TestLogin] Roles fetched:", data?.length || 0, "roles", data);
        return data || [];
      } catch (error) {
        console.error("[TestLogin] Error loading roles:", error);
        throw error;
      }
    },
    staleTime: 0, // Always fetch fresh data
    refetchOnMount: true,
  });

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    setSuccess(false);

    try {
      console.log("[TestLogin] Validating member by email:", email);

      // 1. Use validateMember endpoint which syncs from Zoho CRM if needed
      const validateResponse = await fetch('/api/functions/validateMember', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.toLowerCase().trim() })
      });

      const validateResult = await validateResponse.json();

      if (!validateResponse.ok || !validateResult.success) {
        setError(validateResult.error || "No member found with that email.");
        return;
      }

      console.log("[TestLogin] Member validated:", validateResult.member.email);

      // 2. Fetch the full member record from database (to get id and all fields)
      const members = await base44.entities.Member.list({ 
        filter: { email: email.toLowerCase().trim() } 
      });
      const member = members && members.length > 0 ? members[0] : null;

      if (!member) {
        // This shouldn't happen after successful validation, but handle it
        setError("Member validation succeeded but record not found. Please try again.");
        return;
      }

      // 3. Build memberData with a 24h session expiry, merging validated data
      const memberData = {
        ...member,
        // Override with validated data from CRM
        organization_name: validateResult.member.organization_name,
        training_fund_balance: validateResult.member.training_fund_balance,
        purchase_order_enabled: validateResult.member.purchase_order_enabled,
        program_ticket_balances: validateResult.member.program_ticket_balances,
        is_team_member: validateResult.member.is_team_member,
        sessionExpiry: new Date(
          Date.now() + 24 * 60 * 60 * 1000
        ).toISOString(),
      };

      // Establish server session for cross-tab persistence
      try {
        const sessionResponse = await fetch('/api/auth/test-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ memberId: member.id })
        });
        
        if (sessionResponse.ok) {
          console.log("[TestLogin] Server session established for cross-tab persistence");
        } else {
          console.warn("[TestLogin] Could not establish server session, using sessionStorage only");
        }
      } catch (sessionErr) {
        console.warn("[TestLogin] Server session error:", sessionErr.message);
      }

      // Store in sessionStorage for backwards compatibility
      localStorage.setItem("agcas_member", JSON.stringify(memberData));
      
      // Clear old organization cache and store new one from validated data
      localStorage.removeItem("agcas_organization");
      if (validateResult.member.organization_id) {
        // Fetch and cache the organization
        try {
          const orgs = await base44.entities.Organization.list({ 
            filter: { id: validateResult.member.organization_id } 
          });
          if (orgs && orgs.length > 0) {
            localStorage.setItem("agcas_organization", JSON.stringify(orgs[0]));
            console.log("[TestLogin] Cached organization:", orgs[0].name);
          }
        } catch (orgErr) {
          console.warn("[TestLogin] Could not cache organization:", orgErr.message);
        }
      }

      // 4. Update last_login (only for non-team-members)
      try {
        if (!memberData.is_team_member && memberData.id) {
          await base44.entities.Member.update(memberData.id, { 
            last_login: new Date().toISOString() 
          });
          console.log("[TestLogin] Updated last_login for member:", memberData.email);
        }
      } catch (updateErr) {
        console.warn("[TestLogin] Exception updating last_login:", updateErr.message);
      }

      setSuccess(true);

      // 5. Determine landing page based on role
      let landingPage = "Preferences"; // default fallback

      if (memberData.role_id) {
        try {
          const role = await base44.entities.Role.get(memberData.role_id);
          if (role && role.default_landing_page) {
            landingPage = role.default_landing_page;
            console.log("[TestLogin] Using role default landing page:", landingPage);
          }
        } catch (roleErr) {
          console.warn("[TestLogin] Exception determining role landing page:", roleErr);
        }
      }

      // 6. Redirect after a brief delay
      setTimeout(() => {
        window.location.href = createPageUrl(landingPage);
      }, 1000);
    } catch (err) {
      console.error("[TestLogin] Error:", err);
      setError(err.message || "An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl">
        {/* Warning Banner */}
        <div className="mb-6 p-4 bg-amber-500 text-amber-950 rounded-lg border-2 border-amber-600">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-bold text-sm">TEST MODE ONLY</h3>
              <p className="text-xs mt-1">
                This page is for development testing only. Remove before
                production deployment.
              </p>
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Login Card */}
          <Card className="border-slate-700 shadow-2xl bg-slate-800/50 backdrop-blur">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="p-3 bg-purple-600 rounded-lg">
                  <User className="w-6 h-6 text-white" />
                </div>
                <div>
                  <CardTitle className="text-2xl text-white">Test Login</CardTitle>
                  <p className="text-sm text-slate-400 mt-1">
                    Login as any member for testing
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-2">
                  <label
                    htmlFor="test-email"
                    className="text-sm font-medium text-slate-300"
                  >
                    Member Email Address
                  </label>
                  <Input
                    id="test-email"
                    type="email"
                    placeholder="Enter member email..."
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={loading}
                    className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400"
                  />
                  <p className="text-xs text-slate-400">
                    This will look up the member in the portal database and log
                    you in for testing.
                  </p>
                </div>

                {error && (
                  <div className="flex items-start gap-2 p-3 bg-red-950/50 border border-red-800 rounded-lg">
                    <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                    <p className="text-sm text-red-200">{error}</p>
                  </div>
                )}

                {success && (
                  <div className="flex items-start gap-2 p-3 bg-green-950/50 border border-green-800 rounded-lg">
                    <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
                    <p className="text-sm text-green-200">
                      Login successful! Redirecting...
                    </p>
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white"
                  disabled={loading || success}
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Validating member...
                    </>
                  ) : success ? (
                    "Redirecting..."
                  ) : (
                    "Login as Member"
                  )}
                </Button>
              </form>

              <div className="mt-6 pt-6 border-t border-slate-700">
                <h4 className="text-sm font-semibold text-slate-300 mb-2">
                  How It Works
                </h4>
                <div className="space-y-2 text-xs text-slate-400">
                  <p>1. Enter any member email from your portal data</p>
                  <p>2. System looks up the member in Supabase</p>
                  <p>3. Stores a test session in your browser</p>
                  <p>4. Redirects you to the member&apos;s landing page</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Roles Reference Card */}
          <Card className="border-slate-700 shadow-2xl bg-slate-800/50 backdrop-blur">
            <CardHeader>
              <div className="flex items-center gap-3 mb-2">
                <div className="p-3 bg-blue-600 rounded-lg">
                  <Shield className="w-6 h-6 text-white" />
                </div>
                <div>
                  <CardTitle className="text-2xl text-white">
                    Available Roles
                  </CardTitle>
                  <p className="text-sm text-slate-400 mt-1">
                    Copy role IDs to assign to members
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {rolesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                </div>
              ) : rolesError ? (
                <div className="text-center py-8">
                  <Shield className="w-12 h-12 text-red-600 mx-auto mb-3" />
                  <p className="text-sm text-red-400">
                    Error loading roles from Supabase
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Check the role table and Supabase connection.
                  </p>
                </div>
              ) : roles.length === 0 ? (
                <div className="text-center py-8">
                  <Shield className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                  <p className="text-sm text-slate-400">No roles created yet</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Import roles into the{" "}
                    <code className="px-1 py-0.5 bg-slate-700 rounded">
                      role
                    </code>{" "}
                    table in Supabase.
                  </p>
                </div>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {roles.map((role) => (
                    <div
                      key={role.id}
                      className="p-3 bg-slate-700/50 rounded-lg border border-slate-600 hover:border-slate-500 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold text-white truncate">
                              {role.name}
                            </h3>
                            {role.is_default && (
                              <Badge className="bg-green-600 text-white text-xs">
                                Default
                              </Badge>
                            )}
                          </div>
                          {role.description && (
                            <p className="text-xs text-slate-400 mb-2">
                              {role.description}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs bg-slate-900 text-blue-300 px-2 py-1 rounded overflow-x-auto">
                          {role.id}
                        </code>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            copyToClipboard(role.id, "Role ID")
                          }
                          className="shrink-0 text-slate-400 hover:text-white h-7"
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                      </div>

                      {role.excluded_features &&
                        role.excluded_features.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-slate-600">
                            <p className="text-xs text-slate-500">
                              {role.excluded_features.length} feature(s) restricted
                            </p>
                          </div>
                        )}
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-4 pt-4 border-t border-slate-700">
                <h4 className="text-sm font-semibold text-slate-300 mb-2">
                  How to Use
                </h4>
                <ol className="space-y-1 text-xs text-slate-400 list-decimal list-inside">
                  <li>Click copy button to copy a role ID</li>
                  <li>In Supabase, ensure your member records have a role_id</li>
                  <li>
                    Use this page to test login and landing page behaviour for each
                    role
                  </li>
                </ol>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="mt-4 text-center">
          <a
            href={createPageUrl("Home")}
            className="text-sm text-slate-400 hover:text-slate-300 transition-colors"
          >
            ← Back to normal login
          </a>
        </div>
      </div>
    </div>
  );
}
