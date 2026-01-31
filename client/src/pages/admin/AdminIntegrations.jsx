import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
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
  Mail,
  Copy,
  Check,
  FileText,
  Unplug,
  CreditCard,
  TestTube2
} from "lucide-react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement } from "@stripe/react-stripe-js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

function StripeTestCardForm({ onReady }) {
  const [ready, setReady] = useState(false);

  const handleReady = () => {
    setReady(true);
    if (onReady) onReady();
  };

  const cardStyle = {
    style: {
      base: {
        color: '#fff',
        fontFamily: '"Inter", sans-serif',
        fontSmoothing: 'antialiased',
        fontSize: '16px',
        '::placeholder': {
          color: '#94a3b8'
        }
      },
      invalid: {
        color: '#ef4444',
        iconColor: '#ef4444'
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="p-4 bg-slate-800 border border-slate-600 rounded-lg">
        <CardElement options={cardStyle} onReady={handleReady} data-testid="stripe-card-element" />
      </div>
      {ready && (
        <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/30 rounded-lg" data-testid="text-stripe-test-success">
          <CheckCircle2 className="h-5 w-5 text-green-400" />
          <p className="text-sm text-green-400">Stripe Elements loaded successfully - your publishable key is valid!</p>
        </div>
      )}
    </div>
  );
}

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
  const [webhookUrlCopied, setWebhookUrlCopied] = useState(false);
  const [zohoWebhookUrl, setZohoWebhookUrl] = useState('');

  const [xeroForm, setXeroForm] = useState({
    client_id: '',
    client_secret: ''
  });
  const [xeroEnabled, setXeroEnabled] = useState(false);
  const [xeroSaving, setXeroSaving] = useState(false);
  const [xeroConnecting, setXeroConnecting] = useState(false);
  const [xeroConnected, setXeroConnected] = useState(false);
  const [hasXeroCredentials, setHasXeroCredentials] = useState(false);
  const [showXeroSecrets, setShowXeroSecrets] = useState(false);
  const [xeroTenantName, setXeroTenantName] = useState('');

  const [stripeForm, setStripeForm] = useState({
    secret_key: '',
    publishable_key: ''
  });
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [stripeSaving, setStripeSaving] = useState(false);
  const [hasStripeCredentials, setHasStripeCredentials] = useState(false);
  const [showStripeSecrets, setShowStripeSecrets] = useState(false);
  const [stripeTestModalOpen, setStripeTestModalOpen] = useState(false);
  const [stripeTestLoading, setStripeTestLoading] = useState(false);
  const [stripeTestError, setStripeTestError] = useState(null);
  const [stripePromise, setStripePromise] = useState(null);

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
        
        if (data.connected) {
          fetchZohoWebhookUrl();
        }
      }
    } catch (err) {
      console.error('Failed to fetch Zoho status:', err);
    }
  };

  const fetchXeroStatus = async () => {
    try {
      const response = await fetch('/api/admin/xero-status', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        const hasValidToken = data.tokens && data.tokens.length > 0 && 
          data.tokens.some(t => t.tenant_id !== 'PENDING_SELECTION');
        setXeroConnected(hasValidToken);
        if (hasValidToken) {
          const token = data.tokens.find(t => t.tenant_id !== 'PENDING_SELECTION');
          setXeroTenantName(token?.tenant_name || '');
        }
        return hasValidToken;
      }
      return false;
    } catch (err) {
      console.error('Failed to fetch Xero status:', err);
      return false;
    }
  };

  const fetchZohoWebhookUrl = async () => {
    try {
      const response = await fetch('/api/zoho-campaigns/webhook-url', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        if (data.webhookUrl) {
          setZohoWebhookUrl(data.webhookUrl);
        }
      }
    } catch (err) {
      console.error('Failed to fetch Zoho webhook URL:', err);
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

        const xeroIntegration = data.integrations?.find(i => i.integration_type === 'xero');
        if (xeroIntegration) {
          setXeroEnabled(xeroIntegration.is_enabled);
          setHasXeroCredentials(xeroIntegration.has_credentials);
          if (xeroIntegration.credentials) {
            setXeroForm({
              client_id: xeroIntegration.credentials.client_id || '',
              client_secret: xeroIntegration.credentials.client_secret || ''
            });
          }
        }

        const stripeIntegration = data.integrations?.find(i => i.integration_type === 'stripe');
        if (stripeIntegration) {
          setStripeEnabled(stripeIntegration.is_enabled);
          setHasStripeCredentials(stripeIntegration.has_credentials);
          if (stripeIntegration.credentials) {
            setStripeForm({
              secret_key: stripeIntegration.credentials.secret_key || '',
              publishable_key: stripeIntegration.credentials.publishable_key || ''
            });
          }
        }
        
        fetchZohoStatus();
        fetchXeroStatus();
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

  const handleSaveXero = async () => {
    setXeroSaving(true);
    
    try {
      const response = await fetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'xero',
          credentials: {
            client_id: xeroForm.client_id,
            client_secret: xeroForm.client_secret
          },
          is_enabled: xeroEnabled
        })
      });

      const data = await response.json();

      if (data.success) {
        toast({
          title: "Saved",
          description: "Xero credentials saved successfully"
        });
        setHasXeroCredentials(true);
        fetchIntegrations();
      } else {
        toast({
          title: "Error",
          description: data.error || "Failed to save Xero settings",
          variant: "destructive"
        });
      }
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to save Xero settings",
        variant: "destructive"
      });
    } finally {
      setXeroSaving(false);
    }
  };

  const handleToggleXero = async (enabled) => {
    setXeroEnabled(enabled);
    
    try {
      await fetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'xero',
          is_enabled: enabled
        })
      });
    } catch (err) {
      console.error('Failed to toggle xero:', err);
    }
  };

  const handleConnectXero = async () => {
    setXeroConnecting(true);
    try {
      const response = await fetch('/api/xero/auth-url', {
        method: 'POST',
        credentials: 'include'
      });
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to get auth URL');
      }
      const { authUrl } = await response.json();
      window.open(authUrl, 'xero-auth', 'width=600,height=700');
      
      const checkInterval = setInterval(async () => {
        const isConnected = await fetchXeroStatus();
        if (isConnected) {
          clearInterval(checkInterval);
          setXeroConnecting(false);
          toast({
            title: "Xero Connected",
            description: "Your Xero account has been connected successfully."
          });
        }
      }, 2000);
      
      setTimeout(() => {
        clearInterval(checkInterval);
        setXeroConnecting(false);
      }, 120000);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Connection Failed",
        description: error.message || "Failed to initiate Xero connection"
      });
      setXeroConnecting(false);
    }
  };

  const handleDisconnectXero = async () => {
    try {
      const response = await fetch('/api/xero/disconnect', {
        method: 'POST',
        credentials: 'include'
      });
      
      if (response.ok) {
        setXeroConnected(false);
        setXeroTenantName('');
        toast({
          title: "Disconnected",
          description: "Xero account has been disconnected"
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to disconnect Xero account"
      });
    }
  };

  const handleSaveStripe = async () => {
    setStripeSaving(true);
    
    try {
      const response = await fetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'stripe',
          credentials: {
            secret_key: stripeForm.secret_key,
            publishable_key: stripeForm.publishable_key
          },
          is_enabled: stripeEnabled
        })
      });

      const data = await response.json();

      if (data.success) {
        toast({
          title: "Saved",
          description: "Stripe credentials saved successfully"
        });
        setHasStripeCredentials(true);
        fetchIntegrations();
      } else {
        toast({
          title: "Error",
          description: data.error || "Failed to save Stripe settings",
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save Stripe settings"
      });
    } finally {
      setStripeSaving(false);
    }
  };

  const handleToggleStripe = async (enabled) => {
    setStripeEnabled(enabled);
    
    try {
      await fetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'stripe',
          is_enabled: enabled
        })
      });
    } catch (err) {
      console.error('Failed to toggle stripe:', err);
    }
  };

  const handleTestStripe = async () => {
    const publishableKey = stripeForm.publishable_key;
    
    if (!publishableKey) {
      toast({
        title: "Missing Publishable Key",
        description: "Please enter your Stripe publishable key first",
        variant: "destructive"
      });
      return;
    }
    
    if (!publishableKey.startsWith('pk_')) {
      toast({
        title: "Invalid Publishable Key",
        description: "Publishable key should start with 'pk_live_' or 'pk_test_'",
        variant: "destructive"
      });
      return;
    }
    
    setStripeTestLoading(true);
    setStripeTestError(null);
    setStripeTestModalOpen(true);
    
    try {
      const stripe = await loadStripe(publishableKey);
      
      if (!stripe) {
        setStripeTestError("Failed to initialize Stripe - please check your publishable key");
        setStripePromise(null);
      } else {
        setStripePromise(Promise.resolve(stripe));
      }
    } catch (err) {
      setStripeTestError(err.message || "Failed to initialize Stripe");
      setStripePromise(null);
    } finally {
      setStripeTestLoading(false);
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
                <div className="space-y-4">
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

                  {zohoWebhookUrl && (
                    <div className="rounded-lg bg-slate-700/50 p-4 border border-slate-600">
                      <Label className="text-sm font-medium text-slate-300">Webhook URL for Unsubscribe Events</Label>
                      <p className="text-xs text-slate-400 mt-1 mb-2">
                        Configure this URL in Zoho Campaigns to receive unsubscribe notifications and keep member preferences in sync.
                      </p>
                      <div className="flex items-center gap-2">
                        <Input
                          value={zohoWebhookUrl}
                          readOnly
                          className="bg-slate-800 border-slate-600 text-slate-300 text-sm font-mono"
                          data-testid="input-zoho-webhook-url"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          data-testid="button-copy-webhook-url"
                          onClick={() => {
                            navigator.clipboard.writeText(zohoWebhookUrl);
                            setWebhookUrlCopied(true);
                            setTimeout(() => setWebhookUrlCopied(false), 2000);
                            toast({
                              title: "Copied!",
                              description: "Webhook URL copied to clipboard"
                            });
                          }}
                        >
                          {webhookUrlCopied ? (
                            <Check className="h-4 w-4 text-green-400" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                      <p className="text-xs text-amber-400 mt-2">
                        Keep this URL secret. It contains an authentication token.
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        In Zoho Campaigns, go to Settings → Developer Space → Webhooks to add this URL for unsubscribe events.
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        Note: Only "Do Not Mail" global unsubscribes will fully opt members out. List-specific unsubscribes require the list key in the webhook payload to update individual category preferences.
                      </p>
                    </div>
                  )}
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

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                    <FileText className="h-5 w-5 text-cyan-400" />
                  </div>
                  <div>
                    <CardTitle className="text-white">Xero</CardTitle>
                    <CardDescription className="text-slate-400">
                      Create invoices and sync accounting data with Xero
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {hasXeroCredentials && (
                    <Badge 
                      variant={xeroEnabled ? "default" : "secondary"}
                      className={xeroEnabled ? "bg-green-500/20 text-green-400 border-green-500/30" : ""}
                    >
                      {xeroEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  )}
                  <Switch
                    checked={xeroEnabled}
                    onCheckedChange={handleToggleXero}
                    disabled={!hasXeroCredentials}
                    data-testid="switch-xero-enabled"
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
                  Create an app in the{" "}
                  <a 
                    href="https://developer.xero.com/app/manage" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-cyan-400 hover:underline inline-flex items-center gap-1"
                  >
                    Xero Developer Portal
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </p>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="xero_client_id" className="text-slate-300">Client ID</Label>
                    <Input
                      id="xero_client_id"
                      type={showXeroSecrets ? "text" : "password"}
                      value={xeroForm.client_id}
                      onChange={(e) => setXeroForm(prev => ({ ...prev, client_id: e.target.value }))}
                      placeholder="Enter your Xero Client ID"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-xero-client-id"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="xero_client_secret" className="text-slate-300">Client Secret</Label>
                    <Input
                      id="xero_client_secret"
                      type={showXeroSecrets ? "text" : "password"}
                      value={xeroForm.client_secret}
                      onChange={(e) => setXeroForm(prev => ({ ...prev, client_secret: e.target.value }))}
                      placeholder="Enter your Xero Client Secret"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-xero-client-secret"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowXeroSecrets(!showXeroSecrets)}
                      className="text-slate-400 hover:text-white"
                      data-testid="button-toggle-xero-secrets"
                    >
                      {showXeroSecrets ? (
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
                  Add this redirect URI in your Xero app settings:
                </p>
                <code className="text-xs bg-slate-800 px-2 py-1 rounded text-cyan-400 block">
                  {typeof window !== 'undefined' ? `${window.location.origin}/api/xero/callback` : '/api/xero/callback'}
                </code>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button
                  onClick={handleSaveXero}
                  disabled={xeroSaving}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-xero"
                >
                  {xeroSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save Credentials
                </Button>
                
                {hasXeroCredentials && !xeroConnected && (
                  <Button
                    onClick={handleConnectXero}
                    disabled={xeroConnecting}
                    className="bg-cyan-500 hover:bg-cyan-600"
                    data-testid="button-connect-xero"
                  >
                    {xeroConnecting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Plug className="h-4 w-4 mr-2" />
                    )}
                    Connect Xero Account
                  </Button>
                )}
              </div>

              {hasXeroCredentials && xeroConnected && (
                <div className="rounded-lg bg-green-500/10 p-4 border border-green-500/30">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5 text-green-400" />
                      <div>
                        <p className="text-sm font-medium text-green-400">Connected to Xero</p>
                        {xeroTenantName && (
                          <p className="text-xs text-slate-400">
                            Organization: {xeroTenantName}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDisconnectXero}
                      className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                      data-testid="button-disconnect-xero"
                    >
                      <Unplug className="h-4 w-4 mr-2" />
                      Disconnect
                    </Button>
                  </div>
                </div>
              )}

              {hasXeroCredentials && !xeroConnected && (
                <div className="rounded-lg bg-amber-500/10 p-4 border border-amber-500/30">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-amber-400" />
                    <div>
                      <p className="text-sm font-medium text-amber-400">Not Connected</p>
                      <p className="text-xs text-slate-400">
                        Click "Connect Xero Account" to authorize access to your Xero account.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center">
                    <CreditCard className="h-5 w-5 text-purple-400" />
                  </div>
                  <div>
                    <CardTitle className="text-white">Stripe</CardTitle>
                    <CardDescription className="text-slate-400">
                      Accept payments for events, memberships, and job postings
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {hasStripeCredentials && (
                    <Badge 
                      variant={stripeEnabled ? "default" : "secondary"}
                      className={stripeEnabled ? "bg-green-500/20 text-green-400 border-green-500/30" : ""}
                    >
                      {stripeEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  )}
                  <Switch
                    checked={stripeEnabled}
                    onCheckedChange={handleToggleStripe}
                    disabled={!hasStripeCredentials}
                    data-testid="switch-stripe-enabled"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700">
                <h4 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
                  <Plug className="h-4 w-4 text-slate-400" />
                  API Keys
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Get your API keys from the{" "}
                  <a 
                    href="https://dashboard.stripe.com/apikeys" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:underline inline-flex items-center gap-1"
                  >
                    Stripe Dashboard
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </p>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="stripe_secret_key" className="text-slate-300">Secret Key</Label>
                    <Input
                      id="stripe_secret_key"
                      type={showStripeSecrets ? "text" : "password"}
                      value={stripeForm.secret_key}
                      onChange={(e) => setStripeForm(prev => ({ ...prev, secret_key: e.target.value }))}
                      placeholder="sk_live_..."
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-stripe-secret-key"
                    />
                    <p className="text-xs text-slate-500">
                      Your Stripe secret key (starts with sk_live_ or sk_test_)
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="stripe_publishable_key" className="text-slate-300">Publishable Key</Label>
                    <Input
                      id="stripe_publishable_key"
                      type={showStripeSecrets ? "text" : "password"}
                      value={stripeForm.publishable_key}
                      onChange={(e) => setStripeForm(prev => ({ ...prev, publishable_key: e.target.value }))}
                      placeholder="pk_live_..."
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-stripe-publishable-key"
                    />
                    <p className="text-xs text-slate-500">
                      Your Stripe publishable key (starts with pk_live_ or pk_test_)
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowStripeSecrets(!showStripeSecrets)}
                      className="text-slate-400 hover:text-white"
                      data-testid="button-toggle-stripe-secrets"
                    >
                      {showStripeSecrets ? (
                        <><EyeOff className="h-4 w-4 mr-2" /> Hide values</>
                      ) : (
                        <><Eye className="h-4 w-4 mr-2" /> Show values</>
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button
                  onClick={handleSaveStripe}
                  disabled={stripeSaving}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-stripe"
                >
                  {stripeSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save Credentials
                </Button>
                <Button
                  variant="outline"
                  onClick={handleTestStripe}
                  disabled={!stripeForm.publishable_key || stripeTestLoading}
                  className="border-purple-500/50 text-purple-400"
                  data-testid="button-test-stripe"
                >
                  {stripeTestLoading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <TestTube2 className="h-4 w-4 mr-2" />
                  )}
                  Test Connection
                </Button>
              </div>

              {hasStripeCredentials && stripeEnabled && (
                <div className="rounded-lg bg-green-500/10 p-4 border border-green-500/30">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-400" />
                    <div>
                      <p className="text-sm font-medium text-green-400">Stripe Configured</p>
                      <p className="text-xs text-slate-400">
                        Your Stripe credentials are saved and enabled. Payments are ready to accept.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {hasStripeCredentials && !stripeEnabled && (
                <div className="rounded-lg bg-amber-500/10 p-4 border border-amber-500/30">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-amber-400" />
                    <div>
                      <p className="text-sm font-medium text-amber-400">Stripe Disabled</p>
                      <p className="text-xs text-slate-400">
                        Your credentials are saved but the integration is disabled. Toggle the switch to enable payments.
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

      <Dialog open={stripeTestModalOpen} onOpenChange={(open) => {
        setStripeTestModalOpen(open);
        if (!open) {
          setStripePromise(null);
          setStripeTestError(null);
        }
      }}>
        <DialogContent className="bg-slate-800 border-slate-700 max-w-md" data-testid="dialog-stripe-test">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-purple-400" />
              Test Stripe Connection
            </DialogTitle>
            <DialogDescription className="text-slate-400">
              If the card input form appears below, your Stripe publishable key is valid and working.
            </DialogDescription>
          </DialogHeader>
          
          {stripeTestLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
            </div>
          )}
          
          {stripeTestError && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg" data-testid="text-stripe-test-error">
              <AlertTriangle className="h-5 w-5 text-red-400" />
              <p className="text-sm text-red-400">{stripeTestError}</p>
            </div>
          )}
          
          {!stripeTestLoading && !stripeTestError && stripePromise && (
            <Elements stripe={stripePromise}>
              <StripeTestCardForm onReady={() => {}} />
            </Elements>
          )}

          <div className="flex justify-end gap-2 mt-4">
            <Button 
              variant="outline" 
              onClick={() => setStripeTestModalOpen(false)}
              className="border-slate-600 text-slate-300"
              data-testid="button-close-stripe-test"
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
