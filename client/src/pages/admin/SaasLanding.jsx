import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Building2, LogIn, UserPlus, Loader2 } from "lucide-react";

export default function SaasLanding() {
  const navigate = useNavigate();

  useEffect(() => {
    const checkExistingSession = async () => {
      try {
        const response = await fetch('/api/auth/tenant-user-me', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.tenantUser) {
            navigate('/admin/dashboard');
          }
        }
      } catch (err) {
        console.log('Session check error:', err);
      }
    };
    checkExistingSession();
  }, [navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-primary/10 rounded-2xl mb-4">
            <Building2 className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2" data-testid="text-landing-title">
            iConnect Platform
          </h1>
          <p className="text-slate-400">
            Membership management for growing organizations
          </p>
        </div>

        <div className="space-y-4">
          <Card className="bg-slate-800/50 border-slate-700 hover:border-slate-600 transition-colors cursor-pointer"
                onClick={() => navigate('/admin/login')}
                data-testid="card-sign-in">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <LogIn className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg text-white">Sign In</CardTitle>
                  <CardDescription className="text-slate-400">
                    Access your existing workspace
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700 hover:border-slate-600 transition-colors cursor-pointer"
                onClick={() => navigate('/signup')}
                data-testid="card-create-workspace">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                  <UserPlus className="h-5 w-5 text-emerald-400" />
                </div>
                <div>
                  <CardTitle className="text-lg text-white">Create Workspace</CardTitle>
                  <CardDescription className="text-slate-400">
                    Start a 14-day free trial
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>
        </div>

        <p className="text-center text-xs text-slate-500 mt-8">
          By continuing, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  );
}
