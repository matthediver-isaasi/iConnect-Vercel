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
  Plug,
  Mail
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
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

  const [zohoForm, setZohoForm] = useState({
    client_id: '',
    client_secret: '',
    region: 'us'
  });
  const [zohoEnabled, setZohoEnabled] = useState(false);
  const [zohoSaving, setZohoSaving] = useState(false);
  const [zohoConnecting, setZohoConnecting] = useState(false);
  const [zohoConnected, setZohoConnected] = useState(false);
  const [hasZohoCredentials, setHasZohoCredentials] = useState(false);
  const [showZohoSecrets, setShowZohoSecrets] = useState(false);

  const ZOHO_REGIONS = [
    { value: 'us', label: 'United States', accountsDomain: 'https://accounts.zoho.com', campaignsDomain: 'https://campaigns.zoho.com' },
    { value: 'eu', label: 'Europe', accountsDomain: 'https://accounts.zoho.eu', campaignsDomain: 'https://campaigns.zoho.eu' },
    { value: 'in', label: 'India', accountsDomain: 'https://accounts.zoho.in', campaignsDomain: 'https://campaigns.zoho.in' },
    { value: 'au', label: 'Australia', accountsDomain: 'https://accounts.zoho.com.au', campaignsDomain: 'https://campaigns.zoho.com.au' }
  ];

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

  const fetchZohoStatus = async () => {
    try {
      const response = await fetch('/api/zoho-campaigns/oauth?action=status', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setZohoConnected(data.connected === true);
      }
    } catch (err) {
      console.error('Failed to fetch Zoho status:', err);
    }
  };

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

        const zohoIntegration = data.integrations?.find(i => i.integration_type === 'zoho_campaigns');
        if (zohoIntegration) {
          setZohoEnabled(zohoIntegration.is_enabled);
          setHasZohoCredentials(zohoIntegration.has_credentials);
          if (zohoIntegration.credentials) {
            setZohoForm({
              client_id: zohoIntegration.credentials.client_id || '',
              client_secret: zohoIntegration.credentials.client_secret || '',
              region: zohoIntegration.credentials.region || 'us'
            });
          }
        }
        
        fetchZohoStatus();
      }
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
    }
  };

  const handleConnectZoho = async () => {
    setZohoConnecting(true);
    try {
      const response = await fetch('/api/zoho-campaigns/oauth?action=auth-url', {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to get auth URL');
      const { authUrl } = await response.json();
      window.location.href = authUrl;
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Connection Failed",
        description: "Failed to initiate Zoho connection"
      });
      setZohoConnecting(false);
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

  const handleSaveZoho = async () => {
    setZohoSaving(true);
    
    try {
      const selectedRegion = ZOHO_REGIONS.find(r => r.value === zohoForm.region);
      const response = await fetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'zoho_campaigns',
          credentials: {
            client_id: zohoForm.client_id,
            client_secret: zohoForm.client_secret,
            region: zohoForm.region,
            accounts_domain: selectedRegion?.accountsDomain,
            campaigns_domain: selectedRegion?.campaignsDomain
          },
          is_enabled: zohoEnabled
        })
      });

      const data = await response.json();

      if (data.success) {
        toast({
          title: "Saved",
          description: "Zoho Campaigns credentials saved successfully"
        });
        setHasZohoCredentials(true);
        fetchIntegrations();
      } else {
        toast({
          title: "Error",
          description: data.error || "Failed to save Zoho settings",
          variant: "destructive"
        });
      }
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to save Zoho settings",
        variant: "destructive"
      });
    } finally {
      setZohoSaving(false);
    }
  };

  const handleToggleZoho = async (enabled) => {
    setZohoEnabled(enabled);
    
    try {
      await fetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'zoho_campaigns',
          is_enabled: enabled
        })
      });
    } catch (err) {
      console.error('Failed to toggle zoho:', err);
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

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-orange-500/10 flex items-center justify-center">
                    <Mail className="h-5 w-5 text-orange-400" />
                  </div>
                  <div>
                    <CardTitle className="text-white">Zoho Campaigns</CardTitle>
                    <CardDescription className="text-slate-400">
                      Sync member communication preferences to Zoho mailing lists
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {hasZohoCredentials && (
                    <Badge 
                      variant={zohoEnabled ? "default" : "secondary"}
                      className={zohoEnabled ? "bg-green-500/20 text-green-400 border-green-500/30" : ""}
                    >
                      {zohoEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  )}
                  <Switch
                    checked={zohoEnabled}
                    onCheckedChange={handleToggleZoho}
                    disabled={!hasZohoCredentials}
                    data-testid="switch-zoho-enabled"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700">
                <h4 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
                  <Plug className="h-4 w-4 text-slate-400" />
                  OAuth2 Credentials
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Create a Server-based Application in the{" "}
                  <a 
                    href="https://api-console.zoho.com/" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-orange-400 hover:underline inline-flex items-center gap-1"
                  >
                    Zoho API Console
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </p>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="zoho_region" className="text-slate-300">Region / Data Center</Label>
                    <Select
                      value={zohoForm.region}
                      onValueChange={(value) => setZohoForm(prev => ({ ...prev, region: value }))}
                    >
                      <SelectTrigger className="bg-slate-800 border-slate-600 text-white" data-testid="select-zoho-region">
                        <SelectValue placeholder="Select your Zoho data center" />
                      </SelectTrigger>
                      <SelectContent>
                        {ZOHO_REGIONS.map(region => (
                          <SelectItem key={region.value} value={region.value}>
                            {region.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Select the region where your Zoho account is hosted
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="zoho_client_id" className="text-slate-300">Client ID</Label>
                    <Input
                      id="zoho_client_id"
                      type={showZohoSecrets ? "text" : "password"}
                      value={zohoForm.client_id}
                      onChange={(e) => setZohoForm(prev => ({ ...prev, client_id: e.target.value }))}
                      placeholder="Enter your Zoho Client ID"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-zoho-client-id"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="zoho_client_secret" className="text-slate-300">Client Secret</Label>
                    <Input
                      id="zoho_client_secret"
                      type={showZohoSecrets ? "text" : "password"}
                      value={zohoForm.client_secret}
                      onChange={(e) => setZohoForm(prev => ({ ...prev, client_secret: e.target.value }))}
                      placeholder="Enter your Zoho Client Secret"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-zoho-client-secret"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowZohoSecrets(!showZohoSecrets)}
                      className="text-slate-400 hover:text-white"
                      data-testid="button-toggle-zoho-secrets"
                    >
                      {showZohoSecrets ? (
                        <><EyeOff className="h-4 w-4 mr-2" /> Hide values</>
                      ) : (
                        <><Eye className="h-4 w-4 mr-2" /> Show values</>
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700">
                <h4 className="text-sm font-medium text-white mb-2">Redirect URI</h4>
                <p className="text-xs text-slate-400 mb-2">
                  Add this redirect URI in your Zoho API Console:
                </p>
                <code className="text-xs bg-slate-800 px-2 py-1 rounded text-orange-400 block">
                  {typeof window !== 'undefined' ? `${window.location.origin}/api/zoho-campaigns/oauth?action=callback` : '/api/zoho-campaigns/oauth?action=callback'}
                </code>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button
                  onClick={handleSaveZoho}
                  disabled={zohoSaving}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-zoho"
                >
                  {zohoSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save Credentials
                </Button>
                
                {hasZohoCredentials && !zohoConnected && (
                  <Button
                    onClick={handleConnectZoho}
                    disabled={zohoConnecting}
                    className="bg-orange-500"
                    data-testid="button-connect-zoho"
                  >
                    {zohoConnecting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Plug className="h-4 w-4 mr-2" />
                    )}
                    Connect Zoho Account
                  </Button>
                )}
              </div>

              {hasZohoCredentials && zohoConnected && (
                <div className="rounded-lg bg-green-500/10 p-4 border border-green-500/30">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-400" />
                    <div>
                      <p className="text-sm font-medium text-green-400">Connected to Zoho Campaigns</p>
                      <p className="text-xs text-slate-400">
                        Go to Communications Management to map categories to Zoho lists and sync subscribers.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {hasZohoCredentials && !zohoConnected && (
                <div className="rounded-lg bg-amber-500/10 p-4 border border-amber-500/30">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-amber-400" />
                    <div>
                      <p className="text-sm font-medium text-amber-400">Not Connected</p>
                      <p className="text-xs text-slate-400">
                        Click "Connect Zoho Account" to authorize access to your Zoho Campaigns account.
                      </p>
                    </div>
                  </div>
                </div>
              )}
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
