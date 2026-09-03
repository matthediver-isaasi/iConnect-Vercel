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
  TestTube2,
  BarChart3,
  Building2
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
import { base44, setActiveTenantId } from "@/api/base44Client";
import { adminFetch } from "@/lib/adminFetch";

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

  const [adzunaForm, setAdzunaForm] = useState({ app_id: '', app_key: '', country: 'gb' });
  const [adzunaEnabled, setAdzunaEnabled] = useState(false);
  const [adzunaSaving, setAdzunaSaving] = useState(false);
  const [adzunaTesting, setAdzunaTesting] = useState(false);
  const [adzunaTestResult, setAdzunaTestResult] = useState(null);
  const [hasAdzunaCredentials, setHasAdzunaCredentials] = useState(false);
  const [showAdzunaSecrets, setShowAdzunaSecrets] = useState(false);

  const [zohoForm, setZohoForm] = useState({
    client_id: '',
    client_secret: '',
    region: 'us'
  });
  const [zohoEnabled, setZohoEnabled] = useState(false);
  const [zohoSaving, setZohoSaving] = useState(false);
  const [zohoConnecting, setZohoConnecting] = useState(false);
  const [zohoDisconnecting, setZohoDisconnecting] = useState(false);
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

  const [accountingProvider, setAccountingProvider] = useState('none');
  const [qbForm, setQbForm] = useState({
    client_id: '',
    client_secret: '',
    environment: 'sandbox'
  });
  const [qbEnabled, setQbEnabled] = useState(false);
  const [qbSaving, setQbSaving] = useState(false);
  const [qbConnecting, setQbConnecting] = useState(false);
  const [qbConnected, setQbConnected] = useState(false);
  const [qbCompanyName, setQbCompanyName] = useState('');
  const [qbEnvironmentConnected, setQbEnvironmentConnected] = useState('');
  const [qbExpiresAt, setQbExpiresAt] = useState(null);
  const [qbLastRefreshed, setQbLastRefreshed] = useState(null);
  const [hasQbCredentials, setHasQbCredentials] = useState(false);
  const [showQbSecrets, setShowQbSecrets] = useState(false);
  const [qbItems, setQbItems] = useState([]);
  const [qbItemsLoading, setQbItemsLoading] = useState(false);
  const [qbAccounts, setQbAccounts] = useState([]);
  const [qbAccountsLoading, setQbAccountsLoading] = useState(false);
  const [qbMembershipItemId, setQbMembershipItemId] = useState('');
  const [qbStripeBankAccountId, setQbStripeBankAccountId] = useState('');
  const [qbDefaultTaxCodeId, setQbDefaultTaxCodeId] = useState('');
  const [qbDefaultTaxCodeSettingId, setQbDefaultTaxCodeSettingId] = useState(null);
  const [qbTaxCodes, setQbTaxCodes] = useState([]);
  const [qbTaxCodesLoading, setQbTaxCodesLoading] = useState(false);
  const [qbMembershipItemSettingId, setQbMembershipItemSettingId] = useState(null);
  const [qbStripeBankSettingId, setQbStripeBankSettingId] = useState(null);
  const [qbSettingsSaving, setQbSettingsSaving] = useState(false);

  const [stripeForm, setStripeForm] = useState({
    secret_key: '',
    publishable_key: '',
    test_secret_key: '',
    test_publishable_key: ''
  });
  const [stripeModes, setStripeModes] = useState({
    stripe_mode_forms: 'live',
    stripe_mode_events: 'live',
    stripe_mode_membership: 'live',
    stripe_mode_jobs: 'live',
    stripe_mode_fundraising: 'live'
  });
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [stripeSaving, setStripeSaving] = useState(false);
  const [hasStripeCredentials, setHasStripeCredentials] = useState(false);
  const [showStripeSecrets, setShowStripeSecrets] = useState(false);
  const [stripeTestModalOpen, setStripeTestModalOpen] = useState(false);
  const [stripeTestLoading, setStripeTestLoading] = useState(false);
  const [stripeTestError, setStripeTestError] = useState(null);
  const [stripePromise, setStripePromise] = useState(null);

  const [gcForm, setGcForm] = useState({
    access_token: '',
    webhook_secret: '',
    environment: 'sandbox',
    creditor_id: ''
  });
  const [gcEnabled, setGcEnabled] = useState(false);
  const [gcSaving, setGcSaving] = useState(false);
  const [gcDeleting, setGcDeleting] = useState(false);
  const [hasGcCredentials, setHasGcCredentials] = useState(false);
  const [showGcSecrets, setShowGcSecrets] = useState(false);
  const [gcWebhookUrl, setGcWebhookUrl] = useState('');
  const [gcWebhookUrlCopied, setGcWebhookUrlCopied] = useState(false);
  const [gcDiscoveryBatch, setGcDiscoveryBatch] = useState(null);
  const [gcDiscoveryLoading, setGcDiscoveryLoading] = useState(false);
  const [gcDiscoveryConfirmOpen, setGcDiscoveryConfirmOpen] = useState(false);
  const [gcAutoRetry, setGcAutoRetry] = useState({
    enabled: false,
    intervalDays: 3,
    maxAttempts: 3
  });

  const [outlookSyncFrequency, setOutlookSyncFrequency] = useState(15);
  const [outlookConnectedAccounts, setOutlookConnectedAccounts] = useState(0);
  const [outlookSyncSaving, setOutlookSyncSaving] = useState(false);
  const [outlookSyncLoaded, setOutlookSyncLoaded] = useState(false);

  const [wpWebhookUrl, setWpWebhookUrl] = useState('');
  const [wpApiKey, setWpApiKey] = useState('');
  const [wpSaving, setWpSaving] = useState(false);
  const [wpTesting, setWpTesting] = useState(false);
  const [wpTestResult, setWpTestResult] = useState(null);
  const [wpLoaded, setWpLoaded] = useState(false);
  const [showWpApiKey, setShowWpApiKey] = useState(false);

  const [ga4MeasurementId, setGa4MeasurementId] = useState('');
  const [ga4SavedId, setGa4SavedId] = useState('');
  const [ga4Saving, setGa4Saving] = useState(false);
  const [ga4Loaded, setGa4Loaded] = useState(false);
  const [idealPostcodesEnabled, setIdealPostcodesEnabled] = useState(false);
  const [idealPostcodesPlatformConfigured, setIdealPostcodesPlatformConfigured] = useState(false);
  const [idealPostcodesSaving, setIdealPostcodesSaving] = useState(false);

  const ZOHO_REGIONS = [
    { value: 'us', label: 'United States', accountsDomain: 'https://accounts.zoho.com', campaignsDomain: 'https://campaigns.zoho.com' },
    { value: 'eu', label: 'Europe', accountsDomain: 'https://accounts.zoho.eu', campaignsDomain: 'https://campaigns.zoho.eu' },
    { value: 'in', label: 'India', accountsDomain: 'https://accounts.zoho.in', campaignsDomain: 'https://campaigns.zoho.in' },
    { value: 'au', label: 'Australia', accountsDomain: 'https://accounts.zoho.com.au', campaignsDomain: 'https://campaigns.zoho.com.au' }
  ];

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await adminFetch('/api/auth/tenant-user-me', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.tenantUser) {
            setTenantUser(data.tenantUser);
            setTenant(data.tenant);
            setActiveTenantId(data.tenant?.id);
            const settings = data.tenant?.settings || {};
            const savedGa4 = settings.ga4_measurement_id || '';
            setGa4MeasurementId(savedGa4);
            setGa4SavedId(savedGa4);
            setGa4Loaded(true);
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
      const response = await adminFetch('/api/zoho-campaigns/oauth?action=status');
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
      const response = await adminFetch('/api/admin/xero-status');
      if (response.ok) {
        const data = await response.json();
        const hasValidToken = data.tokens && data.tokens.length > 0 && 
          data.tokens.some(t => t.tenant_id !== 'PENDING_SELECTION');
        setXeroConnected(hasValidToken);
        if (hasValidToken) {
          const token = data.tokens.find(t => t.tenant_id !== 'PENDING_SELECTION');
          setXeroTenantName(token?.tenant_name || '');
        }

        const qb = data.accounting?.quickbooks || null;
        const qbValid = !!(qb && (qb.connected || qb.realm_id));
        setQbConnected(qbValid);
        setQbCompanyName(qb?.company_name || '');
        setQbEnvironmentConnected(qb?.environment || '');
        setQbExpiresAt(qb?.expires_at || null);
        setQbLastRefreshed(qb?.updated_at || null);
        if (qb && typeof qb.has_credentials === 'boolean') {
          setHasQbCredentials(qb.has_credentials);
        }

        const activeProvider = data.accounting?.provider;
        if (activeProvider === 'xero' || activeProvider === 'quickbooks') {
          setAccountingProvider(activeProvider);
        } else if (qbValid) {
          setAccountingProvider('quickbooks');
        } else if (hasValidToken) {
          setAccountingProvider('xero');
        }

        return { xeroConnected: hasValidToken, qbConnected: qbValid };
      }
      return { xeroConnected: false, qbConnected: false };
    } catch (err) {
      console.error('Failed to fetch Xero status:', err);
      return { xeroConnected: false, qbConnected: false };
    }
  };

  const fetchQuickBooksStatus = fetchXeroStatus;

  const fetchZohoWebhookUrl = async () => {
    try {
      const response = await adminFetch('/api/zoho-campaigns/webhook-url');
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
      const response = await adminFetch('/api/admin/integrations', { credentials: 'include' });
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

        const adzunaIntegration = data.integrations?.find(i => i.integration_type === 'adzuna');
        if (adzunaIntegration) {
          setAdzunaEnabled(adzunaIntegration.is_enabled === true);
          setHasAdzunaCredentials(adzunaIntegration.has_credentials === true);
          if (adzunaIntegration.credentials) {
            setAdzunaForm({
              app_id: adzunaIntegration.credentials.app_id || '',
              app_key: adzunaIntegration.credentials.app_key || '',
              country: 'gb'
            });
          }
        }

        const idealPostcodesIntegration = data.integrations?.find(i => i.integration_type === 'ideal_postcodes');
        setIdealPostcodesEnabled(idealPostcodesIntegration?.is_enabled === true);
        setIdealPostcodesPlatformConfigured(idealPostcodesIntegration?.platform_configured === true);

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

        const qbIntegration = data.integrations?.find(i => i.integration_type === 'quickbooks');
        if (qbIntegration) {
          setQbEnabled(qbIntegration.is_enabled);
          setHasQbCredentials(qbIntegration.has_credentials);
          if (qbIntegration.credentials) {
            setQbForm({
              client_id: qbIntegration.credentials.client_id || '',
              client_secret: qbIntegration.credentials.client_secret || '',
              environment: qbIntegration.credentials.environment === 'production' ? 'production' : 'sandbox'
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
              publishable_key: stripeIntegration.credentials.publishable_key || '',
              test_secret_key: stripeIntegration.credentials.test_secret_key || '',
              test_publishable_key: stripeIntegration.credentials.test_publishable_key || ''
            });
            setStripeModes({
              stripe_mode_forms: stripeIntegration.credentials.stripe_mode_forms || 'live',
              stripe_mode_events: stripeIntegration.credentials.stripe_mode_events || 'live',
              stripe_mode_membership: stripeIntegration.credentials.stripe_mode_membership || 'live',
              stripe_mode_jobs: stripeIntegration.credentials.stripe_mode_jobs || 'live',
              stripe_mode_fundraising: stripeIntegration.credentials.stripe_mode_fundraising || 'live'
            });
          }
        }

        if (data.gocardless_webhook_url) {
          setGcWebhookUrl(data.gocardless_webhook_url);
        }

        const gcIntegration = data.integrations?.find(i => i.integration_type === 'gocardless');
        if (gcIntegration) {
          setGcEnabled(gcIntegration.is_enabled);
          setHasGcCredentials(gcIntegration.has_credentials);
          if (gcIntegration.credentials) {
            setGcForm({
              access_token: gcIntegration.credentials.access_token || '',
              webhook_secret: gcIntegration.credentials.webhook_secret || '',
              environment: gcIntegration.credentials.environment === 'live' ? 'live' : 'sandbox',
              creditor_id: gcIntegration.credentials.creditor_id || ''
            });
          }
          const retryPolicy = gcIntegration.auto_retry_policy || {};
          setGcAutoRetry({
            enabled: retryPolicy.enabled === true,
            intervalDays: Number.isInteger(retryPolicy.intervalDays) ? retryPolicy.intervalDays : 3,
            maxAttempts: Number.isInteger(retryPolicy.maxAttempts) ? retryPolicy.maxAttempts : 3
          });
          fetchGcDiscovery();
        } else {
          setGcEnabled(false);
          setHasGcCredentials(false);
          setGcDiscoveryBatch(null);
          setGcAutoRetry({ enabled: false, intervalDays: 3, maxAttempts: 3 });
        }

        fetchZohoStatus();
        fetchXeroStatus();
        fetchOutlookSyncSettings();
        fetchWpSyncSettings();
      }
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
    }
  };

  const fetchWpSyncSettings = async () => {
    try {
      const response = await adminFetch('/api/admin/wp-sync-settings', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setWpWebhookUrl(data.webhook_url || '');
        setWpApiKey(data.api_key || '');
        setWpLoaded(true);
      }
    } catch (err) {
      console.error('Failed to fetch WP sync settings:', err);
    }
  };

  const handleSaveWpSync = async () => {
    setWpSaving(true);
    try {
      const response = await adminFetch('/api/admin/wp-sync-settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: wpWebhookUrl, api_key: wpApiKey }),
      });
      if (response.ok) {
        toast({ title: 'WordPress sync settings saved' });
      } else {
        const err = await response.json();
        toast({ title: 'Failed to save', description: err.error, variant: 'destructive' });
      }
    } catch (err) {
      toast({ title: 'Failed to save', description: err.message, variant: 'destructive' });
    } finally {
      setWpSaving(false);
    }
  };

  const handleSaveGa4 = async () => {
    const trimmedId = ga4MeasurementId.trim();
    if (trimmedId && !/^G-[A-Z0-9]{4,20}$/.test(trimmedId)) {
      toast({
        title: 'Invalid format',
        description: 'GA4 Measurement ID should be in the format G-XXXXXXXXXX',
        variant: 'destructive'
      });
      return;
    }

    setGa4Saving(true);
    try {
      const response = await adminFetch('/api/admin/tenant', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { ga4_measurement_id: trimmedId || null }
        })
      });
      if (response.ok) {
        setGa4SavedId(trimmedId);
        toast({ title: 'Saved', description: 'Google Analytics settings saved successfully' });
      } else {
        const err = await response.json();
        toast({ title: 'Failed to save', description: err.error, variant: 'destructive' });
      }
    } catch (err) {
      toast({ title: 'Failed to save', description: err.message, variant: 'destructive' });
    } finally {
      setGa4Saving(false);
    }
  };

  const handleTestWpWebhook = async () => {
    setWpTesting(true);
    setWpTestResult(null);
    try {
      const response = await adminFetch('/api/admin/wp-sync-settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: wpWebhookUrl, api_key: wpApiKey, test: true }),
      });
      const result = await response.json();
      setWpTestResult(result);
    } catch {
      setWpTestResult({ success: false, statusText: 'Network error' });
    } finally {
      setWpTesting(false);
    }
  };

  const fetchOutlookSyncSettings = async () => {
    try {
      const response = await adminFetch('/api/admin/outlook-sync-settings', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setOutlookSyncFrequency(data.frequency_minutes || 15);
        setOutlookConnectedAccounts(data.connected_accounts || 0);
        setOutlookSyncLoaded(true);
      }
    } catch (err) {
      console.error('Failed to fetch Outlook sync settings:', err);
    }
  };

  const handleSaveOutlookSync = async () => {
    setOutlookSyncSaving(true);
    try {
      const response = await adminFetch('/api/admin/outlook-sync-settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency_minutes: outlookSyncFrequency })
      });
      if (response.ok) {
        toast({ title: "Saved", description: "Outlook sync frequency updated successfully" });
      } else {
        const data = await response.json();
        toast({ title: "Error", description: data.error || "Failed to save setting", variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Error", description: "Failed to save setting", variant: "destructive" });
    } finally {
      setOutlookSyncSaving(false);
    }
  };

  const handleConnectZoho = async () => {
    setZohoConnecting(true);
    try {
      const response = await adminFetch('/api/zoho-campaigns/oauth?action=auth-url', {
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
      await adminFetch('/api/auth/logout', { 
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
      const response = await adminFetch('/api/admin/integrations', {
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
      const response = await adminFetch('/api/admin/integrations/test-zoom', {
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
      await adminFetch('/api/admin/integrations', {
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

  const handleToggleIdealPostcodes = async (enabled) => {
    if (!idealPostcodesPlatformConfigured) return;
    setIdealPostcodesSaving(true);
    try {
      const response = await adminFetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integration_type: 'ideal_postcodes', is_enabled: enabled })
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to update Ideal Postcodes');
      }
      setIdealPostcodesEnabled(enabled);
      toast({
        title: enabled ? 'Ideal Postcodes enabled' : 'Ideal Postcodes disabled',
        description: enabled
          ? 'Address lookup is now available to form authors.'
          : 'Address lookup is no longer available for new form fields.'
      });
      fetchIntegrations();
    } catch (error) {
      toast({
        title: 'Unable to update Ideal Postcodes',
        description: error.message || 'Please try again.',
        variant: 'destructive'
      });
    } finally {
      setIdealPostcodesSaving(false);
    }
  };

  const handleSaveAdzuna = async () => {
    if (!adzunaForm.app_id.trim() || !adzunaForm.app_key.trim()) {
      toast({ title: "Credentials required", description: "Enter both the Adzuna API ID and API key.", variant: "destructive" });
      return;
    }
    setAdzunaSaving(true);
    setAdzunaTestResult(null);
    try {
      const response = await adminFetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'adzuna',
          credentials: adzunaForm,
          is_enabled: adzunaEnabled
        })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to save Adzuna settings');
      setHasAdzunaCredentials(true);
      toast({ title: "Saved", description: "Adzuna credentials were saved securely." });
      await fetchIntegrations();
    } catch (error) {
      toast({ title: "Error", description: error.message || "Failed to save Adzuna settings", variant: "destructive" });
    } finally {
      setAdzunaSaving(false);
    }
  };

  const handleTestAdzuna = async () => {
    setAdzunaTesting(true);
    setAdzunaTestResult(null);
    try {
      const response = await adminFetch('/api/admin/integrations/test-adzuna', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      setAdzunaTestResult(data);
      toast({
        title: data.success ? "Connection Successful" : "Connection Failed",
        description: data.message || data.error,
        variant: data.success ? "default" : "destructive"
      });
    } catch {
      setAdzunaTestResult({ success: false, error: 'Unable to test the connection.' });
    } finally {
      setAdzunaTesting(false);
    }
  };

  const handleToggleAdzuna = async (enabled) => {
    setAdzunaEnabled(enabled);
    setAdzunaTestResult(null);
    if (!hasAdzunaCredentials) return;
    try {
      const response = await adminFetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integration_type: 'adzuna', is_enabled: enabled })
      });
      if (!response.ok) throw new Error();
    } catch {
      setAdzunaEnabled(!enabled);
      toast({ title: "Could not update Adzuna", description: "Please try again.", variant: "destructive" });
    }
  };

  const handleSaveZoho = async () => {
    setZohoSaving(true);
    
    try {
      const selectedRegion = ZOHO_REGIONS.find(r => r.value === zohoForm.region);
      const response = await adminFetch('/api/admin/integrations', {
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
      await adminFetch('/api/admin/integrations', {
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
      const response = await adminFetch('/api/admin/integrations', {
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
      await adminFetch('/api/admin/integrations', {
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
      const response = await adminFetch('/api/xero/auth-url', {
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
        const status = await fetchXeroStatus();
        if (status && status.xeroConnected) {
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
      const response = await adminFetch('/api/xero/disconnect', {
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

  const handleSaveQuickBooks = async () => {
    setQbSaving(true);
    try {
      const response = await adminFetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'quickbooks',
          credentials: {
            client_id: qbForm.client_id,
            client_secret: qbForm.client_secret,
            environment: qbForm.environment
          },
          is_enabled: qbEnabled
        })
      });
      const data = await response.json();
      if (data.success) {
        toast({ title: 'Saved', description: 'QuickBooks credentials saved successfully' });
        setHasQbCredentials(true);
        fetchIntegrations();
      } else {
        toast({ title: 'Error', description: data.error || 'Failed to save QuickBooks settings', variant: 'destructive' });
      }
    } catch (err) {
      toast({ title: 'Error', description: 'Failed to save QuickBooks settings', variant: 'destructive' });
    } finally {
      setQbSaving(false);
    }
  };

  const handleToggleQuickBooks = async (enabled) => {
    setQbEnabled(enabled);
    try {
      await adminFetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integration_type: 'quickbooks', is_enabled: enabled })
      });
    } catch (err) {
      console.error('Failed to toggle quickbooks:', err);
    }
  };

  const handleConnectQuickBooks = async () => {
    setQbConnecting(true);
    try {
      const response = await adminFetch('/api/quickbooks/auth-url', {
        method: 'POST',
        credentials: 'include'
      });
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to get auth URL');
      }
      const { authUrl } = await response.json();
      window.open(authUrl, 'qbo-auth', 'width=700,height=800');

      const checkInterval = setInterval(async () => {
        const status = await fetchXeroStatus();
        if (status && status.qbConnected) {
          clearInterval(checkInterval);
          setQbConnecting(false);
          toast({ title: 'Connected', description: 'QuickBooks Online connected successfully' });
        }
      }, 2000);

      setTimeout(() => {
        clearInterval(checkInterval);
        setQbConnecting(false);
        fetchXeroStatus();
      }, 120000);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Connection Failed',
        description: error.message || 'Failed to initiate QuickBooks connection'
      });
      setQbConnecting(false);
    }
  };

  const handleDisconnectQuickBooks = async () => {
    try {
      const response = await adminFetch('/api/quickbooks/disconnect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeCredentials: false })
      });
      if (response.ok) {
        setQbConnected(false);
        setQbCompanyName('');
        setQbEnvironmentConnected('');
        setQbExpiresAt(null);
        setQbLastRefreshed(null);
        toast({ title: 'Disconnected', description: 'QuickBooks account has been disconnected' });
        fetchXeroStatus();
      }
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to disconnect QuickBooks account' });
    }
  };

  const loadQuickBooksSettings = async () => {
    try {
      const settings = await base44.entities.SystemSettings.list();
      const list = Array.isArray(settings) ? settings : [];
      const itemSetting =
        list.find((s) => s.setting_key === 'quickbooks_membership_item_id') ||
        list.find((s) => s.setting_key === 'accounting_membership_item_id');
      const bankSetting =
        list.find((s) => s.setting_key === 'quickbooks_stripe_bank_account_id') ||
        list.find((s) => s.setting_key === 'accounting_stripe_bank_account_id');
      const taxCodeSetting = list.find((s) => s.setting_key === 'quickbooks_default_tax_code_id');
      setQbMembershipItemId(itemSetting?.setting_value || '');
      setQbMembershipItemSettingId(
        itemSetting && itemSetting.setting_key === 'quickbooks_membership_item_id' ? itemSetting.id : null,
      );
      setQbStripeBankAccountId(bankSetting?.setting_value || '');
      setQbStripeBankSettingId(
        bankSetting && bankSetting.setting_key === 'quickbooks_stripe_bank_account_id' ? bankSetting.id : null,
      );
      setQbDefaultTaxCodeId(taxCodeSetting?.setting_value || '');
      setQbDefaultTaxCodeSettingId(taxCodeSetting?.id || null);
    } catch (err) {
      console.error('Failed to load QuickBooks settings:', err);
    }
  };

  const loadQuickBooksItemsAndAccounts = async () => {
    setQbItemsLoading(true);
    setQbAccountsLoading(true);
    setQbTaxCodesLoading(true);
    try {
      const [itemsResp, accountsResp, taxCodesResp] = await Promise.all([
        fetch('/api/quickbooks/list-items', { credentials: 'include' }),
        fetch('/api/quickbooks/list-accounts', { credentials: 'include' }),
        fetch('/api/quickbooks/list-tax-codes', { credentials: 'include' }),
      ]);
      if (itemsResp.ok) {
        const data = await itemsResp.json();
        setQbItems(data.items || []);
      }
      if (accountsResp.ok) {
        const data = await accountsResp.json();
        setQbAccounts(data.accounts || []);
      }
      if (taxCodesResp.ok) {
        const data = await taxCodesResp.json();
        setQbTaxCodes(data.taxCodes || []);
      }
    } catch (err) {
      console.error('Failed to load QuickBooks items/accounts/tax codes:', err);
    } finally {
      setQbItemsLoading(false);
      setQbAccountsLoading(false);
      setQbTaxCodesLoading(false);
    }
  };

  useEffect(() => {
    if (qbConnected) {
      loadQuickBooksSettings();
      loadQuickBooksItemsAndAccounts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qbConnected]);

  const upsertSystemSetting = async (key, value, description, currentId, setId) => {
    if (currentId) {
      await base44.entities.SystemSettings.update(currentId, { setting_value: value || '' });
    } else {
      const created = await base44.entities.SystemSettings.create({
        setting_key: key,
        setting_value: value || '',
        description,
      });
      if (created?.id) setId(created.id);
    }
  };

  const handleSaveQuickBooksSettings = async () => {
    if (!qbMembershipItemId) {
      toast({ variant: 'destructive', title: 'Missing item', description: 'Pick a Membership item before saving.' });
      return;
    }
    setQbSettingsSaving(true);
    try {
      await upsertSystemSetting(
        'quickbooks_membership_item_id',
        qbMembershipItemId,
        'QuickBooks Online Item id used as the line item on membership invoices',
        qbMembershipItemSettingId,
        setQbMembershipItemSettingId,
      );
      await upsertSystemSetting(
        'quickbooks_stripe_bank_account_id',
        qbStripeBankAccountId,
        'QuickBooks Online bank account id used as DepositToAccountRef when applying Stripe payments to invoices',
        qbStripeBankSettingId,
        setQbStripeBankSettingId,
      );
      await upsertSystemSetting(
        'quickbooks_default_tax_code_id',
        qbDefaultTaxCodeId,
        'QuickBooks Online default TaxCode id used on invoice/credit note lines when the membership band and Item do not specify one',
        qbDefaultTaxCodeSettingId,
        setQbDefaultTaxCodeSettingId,
      );
      toast({ title: 'Saved', description: 'QuickBooks settings saved successfully' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Save failed', description: err.message || 'Failed to save QuickBooks settings' });
    } finally {
      setQbSettingsSaving(false);
    }
  };

  const handleAccountingProviderChange = (value) => {
    const previous = accountingProvider;
    if (value === previous) return;
    if (value === 'quickbooks' && xeroConnected) {
      if (!window.confirm('Switching to QuickBooks will disconnect your active Xero connection. Continue?')) {
        return;
      }
    }
    if (value === 'xero' && qbConnected) {
      if (!window.confirm('Switching to Xero will disconnect your active QuickBooks connection. Continue?')) {
        return;
      }
    }
    setAccountingProvider(value);
  };

  const handleDisconnectZoho = async () => {
    setZohoDisconnecting(true);
    try {
      const response = await adminFetch('/api/zoho-campaigns/disconnect', {
        method: 'POST',
        credentials: 'include'
      });
      
      if (response.ok) {
        setZohoConnected(false);
        setZohoWebhookUrl('');
        toast({
          title: "Disconnected",
          description: "Zoho account has been disconnected. You can now reconnect with updated permissions."
        });
      } else {
        throw new Error('Failed to disconnect');
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to disconnect Zoho account"
      });
    } finally {
      setZohoDisconnecting(false);
    }
  };

  const handleSaveStripe = async () => {
    setStripeSaving(true);
    
    try {
      const response = await adminFetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'stripe',
          credentials: {
            secret_key: stripeForm.secret_key,
            publishable_key: stripeForm.publishable_key,
            test_secret_key: stripeForm.test_secret_key,
            test_publishable_key: stripeForm.test_publishable_key,
            ...stripeModes
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
      await adminFetch('/api/admin/integrations', {
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

  const handleSaveGocardless = async () => {
    setGcSaving(true);
    try {
      const response = await adminFetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'gocardless',
          credentials: {
            access_token: gcForm.access_token,
            webhook_secret: gcForm.webhook_secret,
            environment: gcForm.environment === 'live' ? 'live' : 'sandbox',
            creditor_id: gcForm.creditor_id
          },
          auto_retry_policy: {
            enabled: gcAutoRetry.enabled,
            intervalDays: Number(gcAutoRetry.intervalDays),
            maxAttempts: Number(gcAutoRetry.maxAttempts)
          },
          is_enabled: gcEnabled
        })
      });

      const data = await response.json();

      if (data.success) {
        toast({
          title: "Saved",
          description: "GoCardless credentials and retry policy saved successfully"
        });
        setHasGcCredentials(true);
        fetchIntegrations();
      } else {
        toast({
          title: "Error",
          description: data.error || "Failed to save GoCardless settings",
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save GoCardless settings"
      });
    } finally {
      setGcSaving(false);
    }
  };

  const handleToggleGocardless = async (enabled) => {
    setGcEnabled(enabled);
    try {
      await adminFetch('/api/admin/integrations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_type: 'gocardless',
          is_enabled: enabled
        })
      });
    } catch (err) {
      console.error('Failed to toggle gocardless:', err);
    }
  };

  const handleDeleteGocardless = async () => {
    if (!window.confirm('Remove the GoCardless connection? Direct Debit will fall back to the platform-level credentials (if configured).')) {
      return;
    }
    setGcDeleting(true);
    try {
      const response = await adminFetch('/api/admin/integrations?integration_type=gocardless', {
        method: 'DELETE',
        credentials: 'include'
      });
      const data = await response.json();
      if (data.success) {
        setGcForm({ access_token: '', webhook_secret: '', environment: 'sandbox', creditor_id: '' });
        setGcEnabled(false);
        setHasGcCredentials(false);
        setGcAutoRetry({ enabled: false, intervalDays: 3, maxAttempts: 3 });
        toast({ title: "Removed", description: "GoCardless connection removed" });
        fetchIntegrations();
      } else {
        toast({ title: "Error", description: data.error || "Failed to remove GoCardless connection", variant: "destructive" });
      }
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: "Failed to remove GoCardless connection" });
    } finally {
      setGcDeleting(false);
    }
  };

  const handleCopyGcWebhookUrl = async () => {
    try {
      await navigator.clipboard.writeText(gcWebhookUrl);
      setGcWebhookUrlCopied(true);
      setTimeout(() => setGcWebhookUrlCopied(false), 2000);
    } catch {
      toast({ variant: "destructive", title: "Copy failed", description: "Could not copy to clipboard" });
    }
  };

  const fetchGcDiscovery = async () => {
    try {
      const response = await adminFetch('/api/admin/gocardless-mandate-discovery', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setGcDiscoveryBatch(data.batch || null);
      }
    } catch (error) {
      console.error('Failed to load GoCardless mandate discovery:', error);
    }
  };

  const handleGcDiscovery = async () => {
    setGcDiscoveryConfirmOpen(false);
    setGcDiscoveryLoading(true);
    try {
      const response = await adminFetch('/api/admin/gocardless-mandate-discovery', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await response.json();
      if (data.batch) setGcDiscoveryBatch(data.batch);
      if (!response.ok || data.batch?.status === 'failed') {
        throw new Error(data.error || data.batch?.error_message || 'Mandate discovery failed');
      }
      toast({
        title: data.batch?.status === 'complete' ? 'Mandate discovery complete' : 'Mandate discovery incomplete',
        description: data.batch?.status === 'complete'
          ? `${data.batch.total_count} mandates retrieved across the connected GoCardless account`
          : (data.batch?.error_message || 'Some mandates could not be retrieved'),
        variant: data.batch?.status === 'complete' ? undefined : 'destructive',
      });
    } catch (error) {
      toast({ title: 'Mandate discovery failed', description: error.message, variant: 'destructive' });
      await fetchGcDiscovery();
    } finally {
      setGcDiscoveryLoading(false);
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
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center">
                    <Building2 className="h-5 w-5 text-violet-400" />
                  </div>
                  <div>
                    <CardTitle className="text-white">Ideal Postcodes</CardTitle>
                    <CardDescription className="text-slate-400">
                      UK postcode address lookup for forms
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge className={idealPostcodesPlatformConfigured
                    ? (idealPostcodesEnabled ? "bg-green-500/20 text-green-400 border-green-500/30" : "")
                    : "bg-amber-500/20 text-amber-300 border-amber-500/30"}
                  >
                    {!idealPostcodesPlatformConfigured ? 'Unavailable' : idealPostcodesEnabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                  <Switch
                    checked={idealPostcodesEnabled}
                    onCheckedChange={handleToggleIdealPostcodes}
                    disabled={!idealPostcodesPlatformConfigured || idealPostcodesSaving}
                    data-testid="switch-ideal-postcodes-enabled"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {idealPostcodesPlatformConfigured ? (
                <p className="text-sm text-slate-400">
                  This platform-managed service does not require tenant credentials. Enable it to let form authors add an editable postcode address lookup field.
                </p>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <p className="text-sm text-amber-100">
                    Address lookup is unavailable because the platform Ideal Postcodes key has not been configured.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center">
                    <Building2 className="h-5 w-5 text-green-400" />
                  </div>
                  <div>
                    <CardTitle className="text-white">Adzuna Job Feed</CardTitle>
                    <CardDescription className="text-slate-400">
                      Import UK vacancies from Adzuna into this tenant's job board
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {hasAdzunaCredentials && (
                    <Badge className={adzunaEnabled ? "bg-green-500/20 text-green-400 border-green-500/30" : ""}>
                      {adzunaEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  )}
                  <Switch
                    checked={adzunaEnabled}
                    onCheckedChange={handleToggleAdzuna}
                    data-testid="switch-adzuna-enabled"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700">
                <p className="text-xs text-slate-400 mb-4">
                  Create API credentials in the{" "}
                  <a href="https://developer.adzuna.com/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline inline-flex items-center gap-1">
                    Adzuna developer portal <ExternalLink className="h-3 w-3" />
                  </a>. Saved values are encrypted and shown only in masked form.
                </p>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="adzuna_app_id" className="text-slate-300">API ID</Label>
                    <Input
                      id="adzuna_app_id"
                      type={showAdzunaSecrets ? "text" : "password"}
                      value={adzunaForm.app_id}
                      onChange={(e) => setAdzunaForm(prev => ({ ...prev, app_id: e.target.value }))}
                      placeholder="Enter your Adzuna API ID"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-adzuna-app-id"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="adzuna_app_key" className="text-slate-300">API Key</Label>
                    <Input
                      id="adzuna_app_key"
                      type={showAdzunaSecrets ? "text" : "password"}
                      value={adzunaForm.app_key}
                      onChange={(e) => setAdzunaForm(prev => ({ ...prev, app_key: e.target.value }))}
                      placeholder="Enter your Adzuna API key"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-adzuna-app-key"
                    />
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setShowAdzunaSecrets(v => !v)} className="text-slate-400 hover:text-white">
                    {showAdzunaSecrets ? <><EyeOff className="h-4 w-4 mr-2" /> Hide values</> : <><Eye className="h-4 w-4 mr-2" /> Show values</>}
                  </Button>
                </div>
              </div>

              {adzunaTestResult && (
                <div className={`rounded-lg p-4 border ${adzunaTestResult.success ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
                  <div className="flex items-center gap-2">
                    {adzunaTestResult.success ? <CheckCircle2 className="h-5 w-5 text-green-400" /> : <AlertTriangle className="h-5 w-5 text-red-400" />}
                    <p className={adzunaTestResult.success ? 'text-sm text-green-400' : 'text-sm text-red-400'}>
                      {adzunaTestResult.message || adzunaTestResult.error}
                    </p>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Button onClick={handleSaveAdzuna} disabled={adzunaSaving} className="bg-primary hover:bg-primary/90" data-testid="button-save-adzuna">
                  {adzunaSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                  Save Credentials
                </Button>
                <Button variant="outline" onClick={handleTestAdzuna} disabled={adzunaTesting || !hasAdzunaCredentials || !adzunaEnabled} className="border-slate-600 text-slate-300 hover:bg-slate-700" data-testid="button-test-adzuna">
                  {adzunaTesting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                  Test Connection
                </Button>
              </div>
            </CardContent>
          </Card>

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
                      Connect your organisation's Zoom account for event webinars and meetings
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
                  <div className="w-10 h-10 rounded-lg bg-warning/10 flex items-center justify-center">
                    <Mail className="h-5 w-5 text-warning" />
                  </div>
                  <div>
                    <CardTitle className="text-white">Zoho</CardTitle>
                    <CardDescription className="text-slate-400">
                      Sync member communication preferences and connect to Zoho CRM for Due Diligence workflows
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
                    className="text-warning hover:underline inline-flex items-center gap-1"
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
                <code className="text-xs bg-slate-800 px-2 py-1 rounded text-warning block">
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
                    className="bg-warning text-warning-foreground"
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
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-5 w-5 text-green-400" />
                        <div>
                          <p className="text-sm font-medium text-green-400">Connected to Zoho</p>
                          <p className="text-xs text-slate-400">
                            Go to Communications Management to map categories to Zoho lists and sync subscribers.
                          </p>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleDisconnectZoho}
                        disabled={zohoDisconnecting}
                        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                        data-testid="button-disconnect-zoho"
                      >
                        {zohoDisconnecting ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Unplug className="h-4 w-4 mr-2" />
                        )}
                        Disconnect
                      </Button>
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
                      <p className="text-xs text-warning mt-2">
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
                <div className="rounded-lg bg-warning/10 p-4 border border-warning/30">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-warning" />
                    <div>
                      <p className="text-sm font-medium text-warning">Not Connected</p>
                      <p className="text-xs text-slate-400">
                        Click "Connect Zoho Account" to authorize access to your Zoho Campaigns account.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700">
                <h4 className="text-sm font-medium text-white mb-1">Zoho CRM Sync</h4>
                <p className="text-xs text-slate-400 mb-3">
                  Map iConnect member and organisation fields to Zoho CRM modules (Contacts, Leads, Accounts) and review sync history.
                </p>
                <a
                  href="/admin/zoho-crm-sync"
                  className="inline-flex items-center gap-2 text-sm text-warning hover:underline"
                  data-testid="link-zoho-crm-sync"
                >
                  Configure Zoho CRM sync
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                  <FileText className="h-5 w-5 text-emerald-400" />
                </div>
                <div>
                  <CardTitle className="text-white">Accounting package</CardTitle>
                  <CardDescription className="text-slate-400">
                    Choose which accounting system to use for invoicing and credit notes.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <Label className="text-slate-300">Active provider</Label>
                <Select value={accountingProvider} onValueChange={handleAccountingProviderChange}>
                  <SelectTrigger
                    className="bg-slate-800 border-slate-600 text-white"
                    data-testid="select-accounting-provider"
                  >
                    <SelectValue placeholder="Select accounting package" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" data-testid="option-accounting-none">None</SelectItem>
                    <SelectItem value="xero" data-testid="option-accounting-xero">Xero</SelectItem>
                    <SelectItem value="quickbooks" data-testid="option-accounting-quickbooks">QuickBooks Online</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-400">
                  Only one accounting provider can be active at a time. Connecting one will disconnect the other.
                </p>
              </div>
            </CardContent>
          </Card>

          {accountingProvider === 'xero' && (
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
                <div className="rounded-lg bg-warning/10 p-4 border border-warning/30">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-warning" />
                    <div>
                      <p className="text-sm font-medium text-warning">Not Connected</p>
                      <p className="text-xs text-slate-400">
                        Click "Connect Xero Account" to authorize access to your Xero account.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          )}

          {accountingProvider === 'quickbooks' && (
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <Building2 className="h-5 w-5 text-blue-400" />
                  </div>
                  <div>
                    <CardTitle className="text-white">QuickBooks Online</CardTitle>
                    <CardDescription className="text-slate-400">
                      Create invoices and sync accounting data with QuickBooks Online
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {hasQbCredentials && (
                    <Badge
                      variant={qbEnabled ? "default" : "secondary"}
                      className={qbEnabled ? "bg-green-500/20 text-green-400 border-green-500/30" : ""}
                    >
                      {qbEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  )}
                  <Switch
                    checked={qbEnabled}
                    onCheckedChange={handleToggleQuickBooks}
                    disabled={!hasQbCredentials}
                    data-testid="switch-quickbooks-enabled"
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
                    href="https://developer.intuit.com/app/developer/myapps"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline inline-flex items-center gap-1"
                  >
                    Intuit Developer Portal
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </p>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="qb_environment" className="text-slate-300">Environment</Label>
                    <Select
                      value={qbForm.environment}
                      onValueChange={(v) => setQbForm(prev => ({ ...prev, environment: v }))}
                    >
                      <SelectTrigger
                        id="qb_environment"
                        className="bg-slate-800 border-slate-600 text-white"
                        data-testid="select-quickbooks-environment"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sandbox" data-testid="option-qb-env-sandbox">Sandbox (testing)</SelectItem>
                        <SelectItem value="production" data-testid="option-qb-env-production">Production (live)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Match this to the keys configured for your Intuit app.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="qb_client_id" className="text-slate-300">Client ID</Label>
                    <Input
                      id="qb_client_id"
                      type={showQbSecrets ? "text" : "password"}
                      value={qbForm.client_id}
                      onChange={(e) => setQbForm(prev => ({ ...prev, client_id: e.target.value }))}
                      placeholder="Enter your QuickBooks Client ID"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-quickbooks-client-id"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="qb_client_secret" className="text-slate-300">Client Secret</Label>
                    <Input
                      id="qb_client_secret"
                      type={showQbSecrets ? "text" : "password"}
                      value={qbForm.client_secret}
                      onChange={(e) => setQbForm(prev => ({ ...prev, client_secret: e.target.value }))}
                      placeholder="Enter your QuickBooks Client Secret"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-quickbooks-client-secret"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowQbSecrets(!showQbSecrets)}
                      className="text-slate-400 hover:text-white"
                      data-testid="button-toggle-quickbooks-secrets"
                    >
                      {showQbSecrets ? (
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
                  Add this redirect URI in your Intuit app settings (for both Development and Production keys):
                </p>
                <code className="text-xs bg-slate-800 px-2 py-1 rounded text-blue-400 block" data-testid="text-quickbooks-redirect-uri">
                  {typeof window !== 'undefined' ? `${window.location.origin}/api/quickbooks/callback` : '/api/quickbooks/callback'}
                </code>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button
                  onClick={handleSaveQuickBooks}
                  disabled={qbSaving}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-quickbooks"
                >
                  {qbSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save Credentials
                </Button>

                {hasQbCredentials && !qbConnected && (
                  <Button
                    onClick={handleConnectQuickBooks}
                    disabled={qbConnecting}
                    className="bg-blue-500 hover:bg-blue-600"
                    data-testid="button-connect-quickbooks"
                  >
                    {qbConnecting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Plug className="h-4 w-4 mr-2" />
                    )}
                    Connect QuickBooks
                  </Button>
                )}
              </div>

              {hasQbCredentials && qbConnected && (
                <div className="rounded-lg bg-green-500/10 p-4 border border-green-500/30">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5 text-green-400" />
                      <div>
                        <p className="text-sm font-medium text-green-400" data-testid="text-quickbooks-connected">
                          Connected to {qbCompanyName || 'QuickBooks'}
                          {qbEnvironmentConnected ? ` (${qbEnvironmentConnected === 'sandbox' ? 'Sandbox' : 'Production'})` : ''}
                        </p>
                        {qbExpiresAt && (
                          <p className="text-xs text-slate-400">
                            Token expires: {new Date(qbExpiresAt).toLocaleString()}
                          </p>
                        )}
                        {qbLastRefreshed && (
                          <p className="text-xs text-slate-400">
                            Last refreshed: {new Date(qbLastRefreshed).toLocaleString()}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDisconnectQuickBooks}
                      className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                      data-testid="button-disconnect-quickbooks"
                    >
                      <Unplug className="h-4 w-4 mr-2" />
                      Disconnect
                    </Button>
                  </div>
                </div>
              )}

              {hasQbCredentials && !qbConnected && (
                <div className="rounded-lg bg-warning/10 p-4 border border-warning/30">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-warning" />
                    <div>
                      <p className="text-sm font-medium text-warning">Not Connected</p>
                      <p className="text-xs text-slate-400">
                        Click "Connect QuickBooks" to authorize access to your QuickBooks company.
                        {xeroConnected && ' This will disconnect your current Xero connection.'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {qbConnected && (
                <div className="space-y-4 pt-4 border-t border-slate-700">
                  <div>
                    <h4 className="text-sm font-medium text-white">Invoicing settings</h4>
                    <p className="text-xs text-slate-400">
                      Pick the QuickBooks Item used on membership invoice lines and (optionally) the bank account
                      where Stripe payments are deposited.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="qb-membership-item" className="text-slate-300">
                      Membership Item <span className="text-red-400">*</span>
                    </Label>
                    <Select
                      value={qbMembershipItemId || ''}
                      onValueChange={setQbMembershipItemId}
                      disabled={qbItemsLoading || qbItems.length === 0}
                    >
                      <SelectTrigger
                        id="qb-membership-item"
                        className="bg-slate-900 border-slate-700 text-white"
                        data-testid="select-quickbooks-membership-item"
                      >
                        <SelectValue
                          placeholder={
                            qbItemsLoading
                              ? 'Loading items...'
                              : qbItems.length === 0
                              ? 'No items found in QuickBooks'
                              : 'Select an item'
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {qbItems.map((it) => (
                          <SelectItem key={it.id} value={it.id}>
                            {it.name}{it.type ? ` (${it.type})` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-400">
                      Required. Without this, membership invoices fail to create in QuickBooks.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="qb-stripe-bank" className="text-slate-300">
                      Stripe Deposit Account (optional)
                    </Label>
                    <Select
                      value={qbStripeBankAccountId || '__none'}
                      onValueChange={(v) => setQbStripeBankAccountId(v === '__none' ? '' : v)}
                      disabled={qbAccountsLoading || qbAccounts.length === 0}
                    >
                      <SelectTrigger
                        id="qb-stripe-bank"
                        className="bg-slate-900 border-slate-700 text-white"
                        data-testid="select-quickbooks-stripe-bank"
                      >
                        <SelectValue
                          placeholder={
                            qbAccountsLoading
                              ? 'Loading accounts...'
                              : qbAccounts.length === 0
                              ? 'No bank accounts found'
                              : 'Use QuickBooks default'
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">— Use QuickBooks default —</SelectItem>
                        {qbAccounts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}{a.type ? ` (${a.type})` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-400">
                      Used as DepositToAccountRef when Stripe payments are applied to QuickBooks invoices.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="qb-default-tax-code" className="text-slate-300">
                      Default VAT / Tax Code (optional)
                    </Label>
                    <Select
                      value={qbDefaultTaxCodeId || '__none'}
                      onValueChange={(v) => setQbDefaultTaxCodeId(v === '__none' ? '' : v)}
                      disabled={qbTaxCodesLoading || qbTaxCodes.length === 0}
                    >
                      <SelectTrigger
                        id="qb-default-tax-code"
                        className="bg-slate-900 border-slate-700 text-white"
                        data-testid="select-quickbooks-default-tax-code"
                      >
                        <SelectValue
                          placeholder={
                            qbTaxCodesLoading
                              ? 'Loading tax codes...'
                              : qbTaxCodes.length === 0
                              ? 'No tax codes found'
                              : 'No default (require band VAT rate)'
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">— No default —</SelectItem>
                        {qbTaxCodes.map((tc) => (
                          <SelectItem key={tc.id} value={tc.id}>
                            {tc.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-400">
                      Fallback tax code used on invoice/credit note lines when the membership band has no VAT rate
                      set and the QuickBooks Item has no SalesTaxCodeRef. Without it, invoice creation fails with
                      "Make sure all your transactions have a VAT rate".
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      onClick={handleSaveQuickBooksSettings}
                      disabled={qbSettingsSaving}
                      data-testid="button-save-quickbooks-settings"
                    >
                      {qbSettingsSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                      Save QuickBooks Settings
                    </Button>
                    <Button
                      variant="outline"
                      onClick={loadQuickBooksItemsAndAccounts}
                      disabled={qbItemsLoading || qbAccountsLoading || qbTaxCodesLoading}
                      data-testid="button-refresh-quickbooks-lists"
                    >
                      <RefreshCw className={`h-4 w-4 mr-2 ${(qbItemsLoading || qbAccountsLoading || qbTaxCodesLoading) ? 'animate-spin' : ''}`} />
                      Refresh
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          )}

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
                  Live API Keys
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
                    <Label htmlFor="stripe_secret_key" className="text-slate-300">Live Secret Key</Label>
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
                      Your Stripe live secret key (starts with sk_live_)
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="stripe_publishable_key" className="text-slate-300">Live Publishable Key</Label>
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
                      Your Stripe live publishable key (starts with pk_live_)
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

              <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700">
                <h4 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
                  <TestTube2 className="h-4 w-4 text-slate-400" />
                  Test API Keys
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Optional. Enter your Stripe test keys to enable test mode for individual features.
                </p>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="stripe_test_secret_key" className="text-slate-300">Test Secret Key</Label>
                    <Input
                      id="stripe_test_secret_key"
                      type={showStripeSecrets ? "text" : "password"}
                      value={stripeForm.test_secret_key}
                      onChange={(e) => setStripeForm(prev => ({ ...prev, test_secret_key: e.target.value }))}
                      placeholder="sk_test_..."
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-stripe-test-secret-key"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="stripe_test_publishable_key" className="text-slate-300">Test Publishable Key</Label>
                    <Input
                      id="stripe_test_publishable_key"
                      type={showStripeSecrets ? "text" : "password"}
                      value={stripeForm.test_publishable_key}
                      onChange={(e) => setStripeForm(prev => ({ ...prev, test_publishable_key: e.target.value }))}
                      placeholder="pk_test_..."
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-stripe-test-publishable-key"
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700">
                <h4 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-slate-400" />
                  Feature Payment Modes
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Choose whether each feature uses your live or test Stripe keys. Test keys must be saved above for test mode to work.
                </p>

                <div className="space-y-3">
                  {[
                    { key: 'stripe_mode_forms', label: 'Forms' },
                    { key: 'stripe_mode_events', label: 'Events' },
                    { key: 'stripe_mode_membership', label: 'Membership' },
                    { key: 'stripe_mode_jobs', label: 'Jobs' },
                    { key: 'stripe_mode_fundraising', label: 'Fundraising' }
                  ].map(({ key, label }) => {
                    const isTest = stripeModes[key] === 'test';
                    return (
                      <div key={key} className="flex items-center justify-between py-2 px-3 rounded-md bg-slate-800/50 border border-slate-700/50">
                        <span className="text-sm text-slate-300">{label}</span>
                        <div className="flex items-center gap-3">
                          <Badge
                            variant="outline"
                            className={isTest
                              ? "border-warning/50 text-warning bg-warning/10"
                              : "border-green-500/50 text-green-400 bg-green-500/10"
                            }
                          >
                            {isTest ? 'Test' : 'Live'}
                          </Badge>
                          <Switch
                            checked={isTest}
                            onCheckedChange={(checked) =>
                              setStripeModes(prev => ({ ...prev, [key]: checked ? 'test' : 'live' }))
                            }
                            data-testid={`switch-${key}`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {(stripeModes.stripe_mode_forms === 'test' || stripeModes.stripe_mode_events === 'test' || stripeModes.stripe_mode_membership === 'test' || stripeModes.stripe_mode_jobs === 'test' || stripeModes.stripe_mode_fundraising === 'test') &&
                  (!stripeForm.test_secret_key || !stripeForm.test_publishable_key) && (
                  <div className="mt-3 rounded-md bg-warning/10 p-3 border border-warning/30">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
                      <p className="text-xs text-warning">
                        One or more features are set to test mode but complete test keys haven't been entered. Card payment for those features will remain unavailable until both test keys are saved.
                      </p>
                    </div>
                  </div>
                )}
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
                <div className="rounded-lg bg-warning/10 p-4 border border-warning/30">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-warning" />
                    <div>
                      <p className="text-sm font-medium text-warning">Stripe Disabled</p>
                      <p className="text-xs text-slate-400">
                        Your credentials are saved but the integration is disabled. Toggle the switch to enable payments.
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
                    <Building2 className="h-5 w-5 text-cyan-400" />
                  </div>
                  <div>
                    <CardTitle className="text-white">GoCardless</CardTitle>
                    <CardDescription className="text-slate-400">
                      Collect Direct Debit payments for memberships
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {hasGcCredentials && (
                    <Badge
                      variant={gcEnabled ? "default" : "secondary"}
                      className={gcEnabled ? "bg-green-500/20 text-green-400 border-green-500/30" : ""}
                    >
                      {gcEnabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  )}
                  <Switch
                    checked={gcEnabled}
                    onCheckedChange={handleToggleGocardless}
                    disabled={!hasGcCredentials}
                    data-testid="switch-gocardless-enabled"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700">
                <h4 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
                  <Plug className="h-4 w-4 text-slate-400" />
                  API Credentials
                </h4>
                <p className="text-xs text-slate-400 mb-4">
                  Create an access token in the{" "}
                  <a
                    href="https://manage.gocardless.com/developers"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cyan-400 hover:underline inline-flex items-center gap-1"
                  >
                    GoCardless Dashboard
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  {" "}(or the sandbox dashboard for testing)
                </p>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-slate-300">Environment</Label>
                    <Select
                      value={gcForm.environment}
                      onValueChange={(value) => setGcForm(prev => ({ ...prev, environment: value }))}
                    >
                      <SelectTrigger className="bg-slate-800 border-slate-600 text-white" data-testid="select-gocardless-environment">
                        <SelectValue placeholder="Select environment" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sandbox">Sandbox (testing)</SelectItem>
                        <SelectItem value="live">Live</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Must match your access token — sandbox tokens start with sandbox_, live tokens with live_
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="gocardless_access_token" className="text-slate-300">Access Token</Label>
                    <Input
                      id="gocardless_access_token"
                      type={showGcSecrets ? "text" : "password"}
                      value={gcForm.access_token}
                      onChange={(e) => setGcForm(prev => ({ ...prev, access_token: e.target.value }))}
                      placeholder={gcForm.environment === 'live' ? 'live_...' : 'sandbox_...'}
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-gocardless-access-token"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="gocardless_webhook_secret" className="text-slate-300">Webhook Secret</Label>
                    <Input
                      id="gocardless_webhook_secret"
                      type={showGcSecrets ? "text" : "password"}
                      value={gcForm.webhook_secret}
                      onChange={(e) => setGcForm(prev => ({ ...prev, webhook_secret: e.target.value }))}
                      placeholder="Webhook endpoint secret"
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-gocardless-webhook-secret"
                    />
                    <p className="text-xs text-slate-500">
                      The secret you set when creating the webhook endpoint in GoCardless
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="gocardless_creditor_id" className="text-slate-300">Creditor ID (optional)</Label>
                    <Input
                      id="gocardless_creditor_id"
                      type="text"
                      value={gcForm.creditor_id}
                      onChange={(e) => setGcForm(prev => ({ ...prev, creditor_id: e.target.value }))}
                      placeholder="CR..."
                      className="bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-gocardless-creditor-id"
                    />
                    <p className="text-xs text-slate-500">
                      Only needed if your GoCardless account has multiple creditors
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowGcSecrets(!showGcSecrets)}
                      className="text-slate-400 hover:text-white"
                      data-testid="button-toggle-gocardless-secrets"
                    >
                      {showGcSecrets ? (
                        <><EyeOff className="h-4 w-4 mr-2" /> Hide values</>
                      ) : (
                        <><Eye className="h-4 w-4 mr-2" /> Show values</>
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              {gcWebhookUrl && (
                <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700">
                  <h4 className="text-sm font-medium text-white mb-2 flex items-center gap-2">
                    <Plug className="h-4 w-4 text-slate-400" />
                    Webhook URL
                  </h4>
                  <p className="text-xs text-slate-400 mb-3">
                    Register this URL as a webhook endpoint in your GoCardless dashboard, using the same webhook secret you save above.
                  </p>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={gcWebhookUrl}
                      className="bg-slate-800 border-slate-600 text-slate-300 text-xs font-mono"
                      data-testid="input-gocardless-webhook-url"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopyGcWebhookUrl}
                      className="border-slate-600 text-slate-300 shrink-0"
                      data-testid="button-copy-gocardless-webhook-url"
                    >
                      {gcWebhookUrlCopied ? (
                        <><Check className="h-4 w-4 mr-2 text-green-400" /> Copied</>
                      ) : (
                        <><Copy className="h-4 w-4 mr-2" /> Copy</>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              <div
                className="rounded-lg bg-slate-900/50 p-4 border border-slate-700 space-y-4"
                data-testid="gocardless-auto-retry-settings"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h4 className="text-sm font-medium text-white">Automatic collection retries</h4>
                    <p className="text-xs text-slate-400 mt-1">
                      Ask iConnect to retry a failed membership collection automatically.
                    </p>
                  </div>
                  <Switch
                    checked={gcAutoRetry.enabled}
                    onCheckedChange={(enabled) => setGcAutoRetry(prev => ({ ...prev, enabled }))}
                    data-testid="switch-gocardless-auto-retries"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="gocardless_auto_retry_interval" className="text-slate-300">
                      Days between attempts
                    </Label>
                    <Input
                      id="gocardless_auto_retry_interval"
                      type="number"
                      min="1"
                      max="30"
                      step="1"
                      value={gcAutoRetry.intervalDays}
                      onChange={(event) => setGcAutoRetry(prev => ({ ...prev, intervalDays: Number(event.target.value) }))}
                      disabled={!gcAutoRetry.enabled}
                      className="bg-slate-800 border-slate-600 text-white"
                      data-testid="input-gocardless-auto-retry-interval"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="gocardless_auto_retry_max" className="text-slate-300">
                      Maximum automatic retries
                    </Label>
                    <Input
                      id="gocardless_auto_retry_max"
                      type="number"
                      min="0"
                      max="10"
                      step="1"
                      value={gcAutoRetry.maxAttempts}
                      onChange={(event) => setGcAutoRetry(prev => ({ ...prev, maxAttempts: Number(event.target.value) }))}
                      disabled={!gcAutoRetry.enabled}
                      className="bg-slate-800 border-slate-600 text-white"
                      data-testid="input-gocardless-auto-retry-max"
                    />
                  </div>
                </div>
                <p className="text-xs text-slate-400">
                  The maximum counts automatic retries after the original failed collection.
                  Member and admin manual retries are not included. iConnect never requests a
                  retry at or after the agreement&apos;s existing grace deadline.
                </p>
              </div>

              {hasGcCredentials && (
                <div className="rounded-lg bg-slate-900/50 p-4 border border-slate-700 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-medium text-white">Existing mandates</h4>
                      <p className="text-xs text-slate-400">
                        Retrieve and stage mandates for email matching only. This does not change live billing.
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => setGcDiscoveryConfirmOpen(true)}
                      disabled={!gcEnabled || !hasGcCredentials || gcDiscoveryLoading || gcDiscoveryBatch?.status === 'running'}
                      className="border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/10"
                      data-testid="button-sync-gocardless-mandates"
                    >
                      {gcDiscoveryLoading || gcDiscoveryBatch?.status === 'running'
                        ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        : <RefreshCw className="h-4 w-4 mr-2" />}
                      Sync existing mandates
                    </Button>
                  </div>
                  {gcDiscoveryBatch && (
                    <div
                      className={`rounded-md border p-3 ${
                        gcDiscoveryBatch.status === 'complete'
                          ? 'border-green-500/30 bg-green-500/10'
                          : 'border-amber-500/30 bg-amber-500/10'
                      }`}
                      data-testid="gocardless-discovery-summary"
                    >
                      <div className="flex items-center gap-2">
                        {gcDiscoveryBatch.status === 'complete'
                          ? <CheckCircle2 className="h-4 w-4 text-green-400" />
                          : <AlertTriangle className="h-4 w-4 text-amber-400" />}
                        <p className="text-sm font-medium text-white">
                          {gcDiscoveryBatch.status === 'complete' ? 'Last sync complete'
                            : gcDiscoveryBatch.status === 'running' ? 'Sync in progress'
                            : gcDiscoveryBatch.status === 'partial' ? 'Last sync incomplete'
                            : 'Last sync failed'}
                        </p>
                      </div>
                      <p className="mt-2 text-xs text-slate-300">
                        {gcDiscoveryBatch.status === 'complete' ? 'Completed: ' : ''}
                        {gcDiscoveryBatch.total_count} retrieved · {gcDiscoveryBatch.matched_count} matched ·{' '}
                        {gcDiscoveryBatch.unmatched_count} unmatched · {gcDiscoveryBatch.ambiguous_count} ambiguous ·{' '}
                        {gcDiscoveryBatch.failed_count} failed
                      </p>
                      {gcDiscoveryBatch.error_message && (
                        <p className="mt-2 text-xs text-amber-300" data-testid="gocardless-discovery-error">
                          {gcDiscoveryBatch.error_message}
                        </p>
                      )}
                    </div>
                  )}
                  {!gcEnabled && (
                    <p className="text-xs text-amber-300">Enable this tenant-specific connection before syncing.</p>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <Button
                  onClick={handleSaveGocardless}
                  disabled={gcSaving}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-gocardless"
                >
                  {gcSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save GoCardless settings
                </Button>
                {hasGcCredentials && (
                  <Button
                    variant="outline"
                    onClick={handleDeleteGocardless}
                    disabled={gcDeleting}
                    className="border-red-500/50 text-red-400 hover:bg-red-500/10"
                    data-testid="button-delete-gocardless"
                  >
                    {gcDeleting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Unplug className="h-4 w-4 mr-2" />
                    )}
                    Remove Connection
                  </Button>
                )}
              </div>

              {hasGcCredentials && gcEnabled && (
                <div className="rounded-lg bg-green-500/10 p-4 border border-green-500/30">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-400" />
                    <div>
                      <p className="text-sm font-medium text-green-400">GoCardless Configured</p>
                      <p className="text-xs text-slate-400">
                        Your GoCardless credentials are saved and enabled. Direct Debit collections use this account.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {hasGcCredentials && !gcEnabled && (
                <div className="rounded-lg bg-warning/10 p-4 border border-warning/30">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-warning" />
                    <div>
                      <p className="text-sm font-medium text-warning">GoCardless Disabled</p>
                      <p className="text-xs text-slate-400">
                        Your credentials are saved but the integration is disabled. Direct Debit falls back to the platform-level credentials (if configured).
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Dialog open={gcDiscoveryConfirmOpen} onOpenChange={setGcDiscoveryConfirmOpen}>
            <DialogContent className="bg-slate-900 border-slate-700 text-white">
              <DialogHeader>
                <DialogTitle>Sync existing GoCardless mandates?</DialogTitle>
                <DialogDescription className="text-slate-400">
                  This retrieves all mandates from this tenant’s connected account and stages email-based matches.
                  It will not create plans, subscriptions, billing agreements, or membership records.
                </DialogDescription>
              </DialogHeader>
              <div className="flex justify-end gap-3">
                <Button variant="outline" onClick={() => setGcDiscoveryConfirmOpen(false)}>Cancel</Button>
                <Button onClick={handleGcDiscovery} data-testid="button-confirm-sync-gocardless-mandates">
                  Start sync
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                  <Mail className="h-5 w-5 text-blue-400" />
                </div>
                <div>
                  <CardTitle className="text-white">Outlook Email Sync</CardTitle>
                  <CardDescription className="text-slate-400">
                    Automatically sync emails from connected Outlook accounts
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <p className="text-sm text-slate-400">
                  Connected Outlook accounts will have their emails synced automatically in the background.
                  Choose how often the sync should run for your tenant.
                </p>

                {outlookSyncLoaded && (
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="border-blue-500/30 text-blue-400" data-testid="badge-outlook-connected-count">
                      {outlookConnectedAccounts} connected {outlookConnectedAccounts === 1 ? 'account' : 'accounts'}
                    </Badge>
                  </div>
                )}

                <div className="space-y-2">
                  <Label className="text-slate-300">Sync Frequency</Label>
                  <div className="flex items-center gap-3 flex-wrap">
                    <Select
                      value={String(outlookSyncFrequency)}
                      onValueChange={(val) => setOutlookSyncFrequency(Number(val))}
                      data-testid="select-outlook-sync-frequency"
                    >
                      <SelectTrigger className="w-[200px] bg-slate-900/50 border-slate-600 text-white" data-testid="select-trigger-outlook-sync-frequency">
                        <SelectValue placeholder="Select frequency" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="5">Every 5 minutes</SelectItem>
                        <SelectItem value="15">Every 15 minutes</SelectItem>
                        <SelectItem value="30">Every 30 minutes</SelectItem>
                        <SelectItem value="60">Every hour</SelectItem>
                        <SelectItem value="240">Every 4 hours</SelectItem>
                        <SelectItem value="720">Every 12 hours</SelectItem>
                        <SelectItem value="1440">Daily</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      onClick={handleSaveOutlookSync}
                      disabled={outlookSyncSaving}
                      className="border-blue-500/50 text-blue-400"
                      data-testid="button-save-outlook-sync"
                    >
                      {outlookSyncSaving ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4 mr-2" />
                      )}
                      Save
                    </Button>
                  </div>
                  <p className="text-xs text-slate-500">
                    The background sync checks every 5 minutes and processes accounts that are due based on this frequency.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                    <Plug className="h-5 w-5 text-blue-400" />
                  </div>
                  <div>
                    <CardTitle className="text-white">WordPress</CardTitle>
                    <CardDescription className="text-slate-400">
                      Sync articles to your WordPress site
                    </CardDescription>
                  </div>
                </div>
                {wpWebhookUrl && (
                  <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Configured
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-slate-400">
                When articles are created, updated, or deleted, iConnect will notify your WordPress site to sync immediately. Requires the iConnect Content Sync plugin.
              </p>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-slate-300">Webhook URL</Label>
                  <Input
                    value={wpWebhookUrl}
                    onChange={(e) => { setWpWebhookUrl(e.target.value); setWpTestResult(null); }}
                    placeholder="https://yoursite.com/wp-json/iconnect-sync/v1/webhook"
                    className="bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-500"
                    data-testid="input-wp-webhook-url"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-slate-300">API Key (optional)</Label>
                  <div className="flex gap-2">
                    <Input
                      type={showWpApiKey ? 'text' : 'password'}
                      value={wpApiKey}
                      onChange={(e) => { setWpApiKey(e.target.value); setWpTestResult(null); }}
                      placeholder="Enter API key if configured in WordPress"
                      className="bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-500"
                      data-testid="input-wp-api-key"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setShowWpApiKey(!showWpApiKey)}
                      className="border-slate-600 text-slate-300 shrink-0"
                      data-testid="button-toggle-wp-api-key"
                    >
                      {showWpApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              </div>

              {wpTestResult && (
                <div className={`flex items-center gap-2 p-3 rounded-lg border ${wpTestResult.success ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
                  {wpTestResult.success 
                    ? <CheckCircle2 className="h-4 w-4 text-green-400" />
                    : <AlertTriangle className="h-4 w-4 text-red-400" />
                  }
                  <span className={`text-sm ${wpTestResult.success ? 'text-green-400' : 'text-red-400'}`}>
                    {wpTestResult.success
                      ? `Connection successful (HTTP ${wpTestResult.status})`
                      : `Connection failed: ${wpTestResult.statusText || 'Unknown error'}${wpTestResult.status ? ` (HTTP ${wpTestResult.status})` : ''}`
                    }
                  </span>
                </div>
              )}

              <div className="flex gap-2 flex-wrap">
                <Button
                  onClick={handleSaveWpSync}
                  disabled={wpSaving}
                  className="bg-blue-600 hover:bg-blue-700"
                  data-testid="button-save-wp-sync"
                >
                  {wpSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                  Save
                </Button>
                <Button
                  variant="outline"
                  onClick={handleTestWpWebhook}
                  disabled={wpTesting || !wpWebhookUrl.trim()}
                  className="border-slate-600 text-slate-300"
                  data-testid="button-test-wp-webhook"
                >
                  {wpTesting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <TestTube2 className="h-4 w-4 mr-2" />}
                  Test Webhook
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700" data-testid="card-ga4-integration">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-warning/20 flex items-center justify-center">
                  <BarChart3 className="h-5 w-5 text-warning" />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-white">Google Analytics (GA4)</CardTitle>
                  <CardDescription className="text-slate-400">
                    Track visitor analytics on your member portal
                  </CardDescription>
                </div>
                {ga4Loaded && ga4SavedId && (
                  <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                    Active
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-slate-300">Measurement ID</Label>
                <Input
                  value={ga4MeasurementId}
                  onChange={(e) => setGa4MeasurementId(e.target.value)}
                  placeholder="G-XXXXXXXXXX"
                  className="bg-slate-700/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-ga4-measurement-id"
                />
                <p className="text-xs text-slate-500">
                  Find this in your Google Analytics account under Admin &gt; Data Streams &gt; Web
                </p>
              </div>
              <Button
                onClick={handleSaveGa4}
                disabled={ga4Saving}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-save-ga4"
              >
                {ga4Saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                Save
              </Button>
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
