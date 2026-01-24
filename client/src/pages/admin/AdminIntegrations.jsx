import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { 
  ArrowLeft, 
  Loader2,
  Save,
  LogOut,
  Video,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Eye,
  EyeOff,
  RefreshCw,
  Plug
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

export default function AdminIntegrations() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [tenantUser, setTenantUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [integrations, setIntegrations] = useState([]);
  
  const [zoomForm, setZoomForm] = useState({
    account_id: '',
    client_id: '',
    client_secret: ''
  });
  const [zoomEnabled, setZoomEnabled] = useState(false);
  const [zoomSaving, setZoomSaving] = useState(false);
  const [zoomTesting, setZoomTesting] = useState(false);
  const [zoomTestResult, setZoomTestResult] = useState(null);
  const [showSecrets, setShowSecrets] = useState(false);
  const [hasZoomCredentials, setHasZoomCredentials] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/tenant-user-me', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.tenantUser) {
            setTenantUser(data.tenantUser);
            setTenant(data.tenant);
            fetchIntegrations();
          } else {
            navigate('/admin/login');
          }
        } else {
          navigate('/admin/login');
        }
      } catch (err) {
        navigate('/admin/login');
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, [navigate]);

  const fetchIntegrations = async () => {
    try {
      const response = await fetch('/api/admin/integrations', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setIntegrations(data.integrations || []);
        
        const zoomIntegration = data.integrations?.find(i => i.integration_type === 'zoom');
        if (zoomIntegration) {
          setZoomEnabled(zoomIntegration.is_enabled);
          setHasZoomCredentials(zoomIntegration.has_credentials);
          if (zoomIntegration.credentials) {
            setZoomForm({
              account_id: zoomIntegration.credentials.account_id || '',
              client_id: zoomIntegration.credentials.client_id || '',
              client_secret: zoomIntegration.credentials.client_secret || ''
            });
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { 
        method: 'POST', 
        credentials: 'include' 
      });
    } catch (err) {
      console.log('Logout error:', err);
    }
    localStorage.removeItem('saas_admin');
    navigate('/admin/login');
  };

  const handleSaveZoom = async () => {
    setZoomSaving(true);
    setZoomTestResult(null);
    
    try {
      const response = await fetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'zoom',
          credentials: zoomForm,
          is_enabled: zoomEnabled
        })
      });

      const data = await response.json();

      if (data.success) {
        toast({
          title: "Saved",
          description: "Zoom integration settings saved successfully"
        });
        setHasZoomCredentials(true);
        fetchIntegrations();
      } else {
        toast({
          title: "Error",
          description: data.error || "Failed to save Zoom settings",
          variant: "destructive"
        });
      }
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to save Zoom settings",
        variant: "destructive"
      });
    } finally {
      setZoomSaving(false);
    }
  };

  const handleTestZoom = async () => {
    setZoomTesting(true);
    setZoomTestResult(null);
    
    try {
      const response = await fetch('/api/admin/integrations/test-zoom', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json();
      setZoomTestResult(data);
      
      if (data.success) {
        toast({
          title: "Connection Successful",
          description: `Connected as ${data.account_email}`
        });
      } else {
        toast({
          title: "Connection Failed",
          description: data.error || "Could not connect to Zoom",
          variant: "destructive"
        });
      }
    } catch (err) {
      setZoomTestResult({ success: false, error: 'Failed to test connection' });
      toast({
        title: "Error",
        description: "Failed to test Zoom connection",
        variant: "destructive"
      });
    } finally {
      setZoomTesting(false);
    }
  };

  const handleToggleZoom = async (enabled) => {
    setZoomEnabled(enabled);
    
    try {
      await fetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'zoom',
          is_enabled: enabled
        })
      });
    } catch (err) {
      console.error('Failed to toggle zoom:', err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-3">
              <Link 
                to="/admin/dashboard"
                className="text-slate-400 hover:text-white transition-colors"
                data-testid="link-back"
              >
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div>
                <h1 className="text-lg font-semibold text-white" data-testid="text-page-title">
                  Integrations
                </h1>
                <p className="text-xs text-slate-400">
                  {tenant?.name || 'Tenant Admin'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-right hidden sm:block">
                <p className="text-sm text-white" data-testid="text-user-name">
                  {tenantUser?.first_name} {tenantUser?.last_name}
                </p>
                <p className="text-xs text-slate-400" data-testid="text-user-email">
                  {tenantUser?.email}
                </p>
              </div>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={handleLogout}
                className="text-slate-400 hover:text-white hover:bg-slate-800"
                data-testid="button-logout"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-6">
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <Video className="h-5 w-5 text-blue-400" />
                  </div>
                  <div>
                    <CardTitle className="text-white">Zoom</CardTitle>
                    <CardDescription className="text-slate-400">
                      Enable Zoom meetings for your booking agents
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {hasZoomCredentials && (
                    <Badge 
                      variant={zoomEnabled ? "default" : "secondary"}
                      className={zoomEnabled ? "bg-green-500/20 text-green-400 border-green-500/30" : ""}
                    >
                      {zoomEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  )}
                  <Switch
                    checked={zoomEnabled}
                    onCheckedChange={handleToggleZoom}
                    disabled={!hasZoomCredentials}
                    data-testid="switch-zoom-enabled"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700">
                <h4 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
                  <Plug className="h-4 w-4 text-slate-400" />
                  Server-to-Server OAuth Credentials
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Create a Server-to-Server OAuth app in the{" "}
                  <a 
                    href="https://marketplace.zoom.us/develop/create" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline inline-flex items-center gap-1"
                  >
                    Zoom Marketplace
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </p>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="account_id" className="text-slate-300">Account ID</Label>
                    <Input
                      id="account_id"
                      type={showSecrets ? "text" : "password"}
                      value={zoomForm.account_id}
                      onChange={(e) => setZoomForm(prev => ({ ...prev, account_id: e.target.value }))}
                      placeholder="Enter your Zoom Account ID"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-zoom-account-id"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="client_id" className="text-slate-300">Client ID</Label>
                    <Input
                      id="client_id"
                      type={showSecrets ? "text" : "password"}
                      value={zoomForm.client_id}
                      onChange={(e) => setZoomForm(prev => ({ ...prev, client_id: e.target.value }))}
                      placeholder="Enter your Zoom Client ID"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-zoom-client-id"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="client_secret" className="text-slate-300">Client Secret</Label>
                    <Input
                      id="client_secret"
                      type={showSecrets ? "text" : "password"}
                      value={zoomForm.client_secret}
                      onChange={(e) => setZoomForm(prev => ({ ...prev, client_secret: e.target.value }))}
                      placeholder="Enter your Zoom Client Secret"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-zoom-client-secret"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSecrets(!showSecrets)}
                      className="text-slate-400 hover:text-white"
                      data-testid="button-toggle-secrets"
                    >
                      {showSecrets ? (
                        <><EyeOff className="h-4 w-4 mr-2" /> Hide values</>
                      ) : (
                        <><Eye className="h-4 w-4 mr-2" /> Show values</>
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              {zoomTestResult && (
                <div className={`rounded-lg p-4 border ${
                  zoomTestResult.success 
                    ? 'bg-green-500/10 border-green-500/30' 
                    : 'bg-red-500/10 border-red-500/30'
                }`}>
                  <div className="flex items-center gap-2">
                    {zoomTestResult.success ? (
                      <CheckCircle2 className="h-5 w-5 text-green-400" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-red-400" />
                    )}
                    <div>
                      <p className={`text-sm font-medium ${
                        zoomTestResult.success ? 'text-green-400' : 'text-red-400'
                      }`}>
                        {zoomTestResult.success ? 'Connection Successful' : 'Connection Failed'}
                      </p>
                      {zoomTestResult.success && zoomTestResult.account_email && (
                        <p className="text-xs text-slate-400">
                          Connected as: {zoomTestResult.account_email} ({zoomTestResult.account_type})
                        </p>
                      )}
                      {!zoomTestResult.success && zoomTestResult.error && (
                        <p className="text-xs text-slate-400">
                          {zoomTestResult.error}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <Button
                  onClick={handleSaveZoom}
                  disabled={zoomSaving}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-zoom"
                >
                  {zoomSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save Credentials
                </Button>
                
                <Button
                  variant="outline"
                  onClick={handleTestZoom}
                  disabled={zoomTesting || !hasZoomCredentials}
                  className="border-slate-600 text-slate-300 hover:bg-slate-700"
                  data-testid="button-test-zoom"
                >
                  {zoomTesting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Test Connection
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700 opacity-60">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center">
                  <Video className="h-5 w-5 text-slate-500" />
                </div>
                <div>
                  <CardTitle className="text-slate-400">Google Meet</CardTitle>
                  <CardDescription className="text-slate-500">
                    Uses member's connected Google Calendar
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-500">
                Google Meet integration is configured per-member through their connected Google Calendar. 
                No additional setup required here.
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
