import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { 
  ArrowLeft, 
  Loader2,
  Globe,
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Clock,
  Copy,
  ExternalLink,
  Info,
  Mail,
  Settings
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || error.message || 'Request failed');
  }
  
  return response.json();
}

export default function AdminDomains() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [tenantUser, setTenantUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [domains, setDomains] = useState([]);
  const [newDomain, setNewDomain] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [newEmailDomain, setNewEmailDomain] = useState("");
  const [configuringEmailDomain, setConfiguringEmailDomain] = useState(false);
  const [actionLoading, setActionLoading] = useState({});

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/tenant-user-me', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.tenantUser) {
            setTenantUser(data.tenantUser);
            setTenant(data.tenant);
            fetchDomainData();
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

  const fetchDomainData = async () => {
    try {
      const data = await apiRequest('/api/functions/get-tenant-domains');
      setTenant(prev => ({ ...prev, ...data.tenant }));
      setDomains(data.domains || []);
    } catch (err) {
      console.error('Failed to fetch domain data:', err);
      toast({
        title: "Error",
        description: "Failed to load domain settings",
        variant: "destructive"
      });
    }
  };

  const handleAddDomain = async (e) => {
    e.preventDefault();
    if (!newDomain.trim()) return;
    
    const domain = newDomain.trim().toLowerCase();
    if (!domain.includes('.') || domain.includes(' ')) {
      toast({
        title: "Invalid domain",
        description: "Please enter a valid domain name (e.g., example.com)",
        variant: "destructive"
      });
      return;
    }
    
    setActionLoading(prev => ({ ...prev, addDomain: true }));
    try {
      await apiRequest('/api/functions/add-tenant-domain', {
        method: 'POST',
        body: JSON.stringify({ domain }),
      });
      setNewDomain("");
      setAddingDomain(false);
      toast({
        title: "Domain added",
        description: "Your custom domain has been added. Please configure your DNS."
      });
      fetchDomainData();
    } catch (err) {
      toast({
        title: "Failed to add domain",
        description: err.message || "Please try again.",
        variant: "destructive"
      });
    } finally {
      setActionLoading(prev => ({ ...prev, addDomain: false }));
    }
  };

  const handleRemoveDomain = async (domain) => {
    setActionLoading(prev => ({ ...prev, [`remove-${domain}`]: true }));
    try {
      await apiRequest('/api/functions/remove-tenant-domain', {
        method: 'POST',
        body: JSON.stringify({ domain }),
      });
      toast({
        title: "Domain removed",
        description: "Your custom domain has been removed."
      });
      fetchDomainData();
    } catch (err) {
      toast({
        title: "Failed to remove domain",
        description: err.message || "Please try again.",
        variant: "destructive"
      });
    } finally {
      setActionLoading(prev => ({ ...prev, [`remove-${domain}`]: false }));
    }
  };

  const handleVerifyDomain = async (domain) => {
    setActionLoading(prev => ({ ...prev, [`verify-${domain}`]: true }));
    try {
      const data = await apiRequest('/api/functions/verify-tenant-domain', {
        method: 'POST',
        body: JSON.stringify({ domain }),
      });
      if (data.verified) {
        toast({
          title: "Domain verified",
          description: "Your domain is now active and SSL certificate has been issued."
        });
      } else {
        toast({
          title: "Verification pending",
          description: "DNS records not yet detected. This can take up to 48 hours."
        });
      }
      fetchDomainData();
    } catch (err) {
      toast({
        title: "Verification failed",
        description: err.message || "Please check your DNS settings.",
        variant: "destructive"
      });
    } finally {
      setActionLoading(prev => ({ ...prev, [`verify-${domain}`]: false }));
    }
  };

  const handleProvisionEmailDomain = async (customDomain = null) => {
    setActionLoading(prev => ({ ...prev, provisionEmail: true }));
    try {
      const body = customDomain ? { emailDomain: customDomain } : {};
      const result = await apiRequest('/api/functions/provision-mailgun-domain', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setNewEmailDomain("");
      setConfiguringEmailDomain(false);
      toast({
        title: "Email domain provisioned",
        description: result.is_custom 
          ? "Email domain created. Please configure the required DNS records at your domain registrar."
          : "Mailgun domain and DNS records have been created. Verification may take a few minutes."
      });
      fetchDomainData();
    } catch (err) {
      toast({
        title: "Failed to provision email domain",
        description: err.message || "Please try again.",
        variant: "destructive"
      });
    } finally {
      setActionLoading(prev => ({ ...prev, provisionEmail: false }));
    }
  };

  const handleSubmitEmailDomain = (e) => {
    e.preventDefault();
    if (!newEmailDomain.trim()) {
      handleProvisionEmailDomain();
      return;
    }
    const domain = newEmailDomain.trim().toLowerCase();
    if (!domain.includes('.') || domain.includes(' ')) {
      toast({
        title: "Invalid domain",
        description: "Please enter a valid domain name (e.g., mail.example.com)",
        variant: "destructive"
      });
      return;
    }
    handleProvisionEmailDomain(domain);
  };

  const handleVerifyEmailDomain = async () => {
    setActionLoading(prev => ({ ...prev, verifyEmail: true }));
    try {
      const data = await apiRequest('/api/functions/verify-mailgun-domain', {
        method: 'POST',
      });
      if (data.verified || data.status === 'verified') {
        toast({
          title: "Email domain verified",
          description: "Your email domain is now active and ready to send emails."
        });
      } else {
        toast({
          title: "Verification pending",
          description: "DNS records are propagating. This can take a few hours."
        });
      }
      fetchDomainData();
    } catch (err) {
      toast({
        title: "Verification failed",
        description: err.message || "Please try again later.",
        variant: "destructive"
      });
    } finally {
      setActionLoading(prev => ({ ...prev, verifyEmail: false }));
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'verified':
      case 'active':
        return <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"><CheckCircle2 className="w-3 h-3 mr-1" /> Active</Badge>;
      case 'pending':
        return <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"><Clock className="w-3 h-3 mr-1" /> Pending DNS</Badge>;
      case 'error':
        return <Badge variant="destructive"><AlertCircle className="w-3 h-3 mr-1" /> Error</Badge>;
      default:
        return <Badge variant="outline"><Clock className="w-3 h-3 mr-1" /> {status}</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  const defaultDomain = tenant?.slug ? `${tenant.slug}.iconn.app` : null;
  const emailDomain = tenant?.settings?.email_domain;
  const emailStatus = emailDomain?.status;
  const emailDomainName = emailDomain?.domain;
  const fromEmail = emailDomain?.from_email;

  return (
    <div className="min-h-screen bg-slate-900">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center h-16 gap-4">
            <Link 
              to="/admin/dashboard"
              className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
              data-testid="link-back"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back to Dashboard</span>
            </Link>
            <div className="flex-1">
              <h1 className="text-lg font-semibold text-white" data-testid="text-page-title">Domain Management</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Globe className="w-5 h-5" />
              Default Domain
            </CardTitle>
            <CardDescription className="text-slate-400">
              Your workspace is always accessible at this subdomain
            </CardDescription>
          </CardHeader>
          <CardContent>
            {defaultDomain ? (
              <div className="flex items-center justify-between gap-2 p-3 bg-slate-700/50 rounded-lg">
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-slate-400" />
                  <span className="font-mono text-sm text-white" data-testid="text-default-domain">{defaultDomain}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="bg-green-900 text-green-200">
                    <CheckCircle2 className="w-3 h-3 mr-1" /> Active
                  </Badge>
                  <Button 
                    size="icon" 
                    variant="ghost"
                    onClick={() => window.open(`https://${defaultDomain}`, '_blank')}
                    className="text-slate-400 hover:text-white"
                    data-testid="button-open-default-domain"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-center py-4 text-slate-400">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No default domain configured</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Globe className="w-5 h-5" />
              Custom Domains
            </CardTitle>
            <CardDescription className="text-slate-400">
              Add your own domains to access your workspace
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {addingDomain ? (
              <form onSubmit={handleAddDomain} className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-white">Domain Name</Label>
                  <Input
                    placeholder="example.com"
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    className="bg-slate-700 border-slate-600 text-white"
                    data-testid="input-new-domain"
                  />
                </div>
                <div className="flex gap-2">
                  <Button 
                    type="submit" 
                    disabled={actionLoading.addDomain}
                    data-testid="button-add-domain-submit"
                  >
                    {actionLoading.addDomain && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Add Domain
                  </Button>
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={() => setAddingDomain(false)}
                    className="border-slate-600 text-slate-300"
                    data-testid="button-cancel-add-domain"
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <Button 
                variant="outline" 
                onClick={() => setAddingDomain(true)}
                className="w-full border-slate-600 text-slate-300 hover:bg-slate-700"
                data-testid="button-add-domain"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Custom Domain
              </Button>
            )}

            {domains.length > 0 && (
              <div className="space-y-2">
                {domains.map((domain) => (
                  <div 
                    key={domain.name} 
                    className="flex items-center justify-between gap-2 p-3 border border-slate-600 rounded-lg"
                    data-testid={`domain-item-${domain.name}`}
                  >
                    <div className="flex items-center gap-3">
                      <Globe className="w-4 h-4 text-slate-400" />
                      <span className="font-mono text-sm text-white">{domain.name}</span>
                      {getStatusBadge(domain.verified ? 'verified' : 'pending')}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleVerifyDomain(domain.name)}
                        disabled={actionLoading[`verify-${domain.name}`]}
                        className="border-slate-600 text-slate-300"
                        data-testid={`button-verify-${domain.name}`}
                      >
                        <RefreshCw className={`w-4 h-4 mr-1 ${actionLoading[`verify-${domain.name}`] ? 'animate-spin' : ''}`} />
                        Verify
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleRemoveDomain(domain.name)}
                        disabled={actionLoading[`remove-${domain.name}`]}
                        className="text-red-400 hover:text-red-300"
                        data-testid={`button-remove-${domain.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Mail className="w-5 h-5" />
              Email Domain
            </CardTitle>
            <CardDescription className="text-slate-400">
              Configure your email sending domain for outbound emails
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(!emailDomain || emailStatus === 'pending_setup' || !emailDomainName) ? (
              <div className="space-y-4">
                {configuringEmailDomain ? (
                  <form onSubmit={handleSubmitEmailDomain} className="space-y-4">
                    <div className="space-y-2">
                      <Label className="text-white">Email Domain (Optional)</Label>
                      <Input
                        placeholder="mail.example.com (leave blank for default)"
                        value={newEmailDomain}
                        onChange={(e) => setNewEmailDomain(e.target.value)}
                        className="bg-slate-700 border-slate-600 text-white"
                        data-testid="input-email-domain"
                      />
                      <p className="text-xs text-slate-400">
                        Enter your custom domain for emails, or leave blank to use the default subdomain. 
                        Custom domains require you to configure DNS records yourself.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button 
                        type="submit" 
                        disabled={actionLoading.provisionEmail}
                        data-testid="button-submit-email-domain"
                      >
                        {actionLoading.provisionEmail && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        {newEmailDomain.trim() ? 'Set Custom Domain' : 'Use Default Domain'}
                      </Button>
                      <Button 
                        type="button" 
                        variant="outline" 
                        onClick={() => { setConfiguringEmailDomain(false); setNewEmailDomain(""); }}
                        className="border-slate-600 text-slate-300"
                        data-testid="button-cancel-email-domain"
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="text-center py-6 text-slate-400">
                      <Mail className="w-12 h-12 mx-auto mb-4 opacity-50" />
                      <p>Email domain not configured</p>
                      <p className="text-sm">Set up a dedicated email domain for this workspace</p>
                    </div>
                    <Button
                      onClick={() => setConfiguringEmailDomain(true)}
                      className="w-full"
                      data-testid="button-configure-email-domain"
                    >
                      <Settings className="w-4 h-4 mr-2" />
                      Configure Email Domain
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {configuringEmailDomain ? (
                  <form onSubmit={handleSubmitEmailDomain} className="space-y-4">
                    <div className="p-3 bg-slate-700/50 rounded-lg">
                      <div className="flex items-center gap-2 text-sm text-slate-400 mb-2">
                        <span>Current domain:</span>
                        <span className="font-mono text-white">{emailDomainName}</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-white">New Email Domain (Optional)</Label>
                      <Input
                        placeholder="mail.example.com (leave blank for default)"
                        value={newEmailDomain}
                        onChange={(e) => setNewEmailDomain(e.target.value)}
                        className="bg-slate-700 border-slate-600 text-white"
                        data-testid="input-new-email-domain"
                      />
                      <p className="text-xs text-slate-400">
                        Enter your custom domain for emails, or leave blank to use the default subdomain. 
                        Custom domains require you to configure DNS records yourself.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button 
                        type="submit" 
                        disabled={actionLoading.provisionEmail}
                        data-testid="button-submit-new-email-domain"
                      >
                        {actionLoading.provisionEmail && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        {newEmailDomain.trim() ? 'Set Custom Domain' : 'Use Default Domain'}
                      </Button>
                      <Button 
                        type="button" 
                        variant="outline" 
                        onClick={() => { setConfiguringEmailDomain(false); setNewEmailDomain(""); }}
                        className="border-slate-600 text-slate-300"
                        data-testid="button-cancel-new-email-domain"
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2 p-3 bg-slate-700/50 rounded-lg">
                      <div className="flex items-center gap-2">
                        <Mail className="w-4 h-4 text-slate-400" />
                        <span className="font-mono text-sm text-white" data-testid="text-email-domain">{emailDomainName}</span>
                        {emailDomain?.is_custom && (
                          <Badge variant="outline" className="border-slate-500 text-slate-400 text-xs" data-testid="badge-email-custom">Custom</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {emailStatus === 'verified' ? (
                          <Badge variant="secondary" className="bg-green-900 text-green-200">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Verified
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-yellow-900 text-yellow-200">
                            <Clock className="w-3 h-3 mr-1" /> Pending Verification
                          </Badge>
                        )}
                      </div>
                    </div>
                    
                    {fromEmail && (
                      <div className="flex items-center gap-2 text-sm text-slate-400">
                        <span>Sending from:</span>
                        <span className="font-mono">{fromEmail}</span>
                      </div>
                    )}
                    
                    <div className="flex gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        onClick={handleVerifyEmailDomain}
                        disabled={actionLoading.verifyEmail}
                        className="border-slate-600 text-slate-300"
                        data-testid="button-verify-email-domain"
                      >
                        <RefreshCw className={`w-4 h-4 mr-2 ${actionLoading.verifyEmail ? 'animate-spin' : ''}`} />
                        Verify Status
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setConfiguringEmailDomain(true)}
                        className="border-slate-600 text-slate-300"
                        data-testid="button-change-email-domain"
                      >
                        <Settings className="w-4 h-4 mr-2" />
                        Change Domain
                      </Button>
                    </div>
                  </>
                )}
                
                {emailStatus !== 'verified' && emailDomain?.is_custom && emailDomain?.required_dns_records && (
                  <Alert className="bg-slate-700/50 border-slate-600" data-testid="alert-dns-records">
                    <AlertCircle className="h-4 w-4 text-yellow-400" />
                    <AlertTitle className="text-white">DNS Configuration Required</AlertTitle>
                    <AlertDescription className="text-slate-300">
                      <p className="mb-2">Add the following DNS records at your domain registrar:</p>
                      <div className="space-y-2 font-mono text-xs overflow-x-auto">
                        {emailDomain.required_dns_records.map((record, idx) => (
                          <div key={idx} className="p-2 bg-slate-800/50 rounded flex flex-col gap-1" data-testid={`dns-record-${idx}`}>
                            <div className="flex items-center gap-2">
                              <span className="text-slate-400 w-12">{record.type}</span>
                              <span className="text-white">{record.name}</span>
                            </div>
                            <div className="flex items-center gap-2 pl-14">
                              <span className="text-slate-400">Value:</span>
                              <span className="text-green-400 break-all">{record.value}</span>
                              {record.priority && (
                                <>
                                  <span className="text-slate-400 ml-2">Priority:</span>
                                  <span className="text-yellow-400">{record.priority}</span>
                                </>
                              )}
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="self-end text-slate-400 hover:text-white h-6 px-2"
                              onClick={() => copyToClipboard(record.value)}
                              data-testid={`button-copy-dns-${idx}`}
                            >
                              <Copy className="w-3 h-3 mr-1" />
                              Copy
                            </Button>
                          </div>
                        ))}
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
                
                {emailStatus !== 'verified' && !emailDomain?.is_custom && (
                  <Alert className="bg-slate-700/50 border-slate-600">
                    <AlertCircle className="h-4 w-4 text-yellow-400" />
                    <AlertTitle className="text-white">Verification In Progress</AlertTitle>
                    <AlertDescription className="text-slate-300">
                      DNS records have been created. Verification typically completes within a few minutes to a few hours.
                      Click "Verify Status" to check the current state.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {domains.some(d => !d.verified) && (
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-white">
                <Info className="w-5 h-5" />
                DNS Configuration
              </CardTitle>
              <CardDescription className="text-slate-400">
                Configure these DNS records at your domain registrar
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert className="bg-slate-700/50 border-slate-600">
                <AlertCircle className="h-4 w-4 text-yellow-400" />
                <AlertTitle className="text-white">Action Required</AlertTitle>
                <AlertDescription className="text-slate-300">
                  Add the following DNS records to verify your domain. DNS changes can take up to 48 hours to propagate.
                </AlertDescription>
              </Alert>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-white">For root domain (example.com):</Label>
                  <div className="flex items-center gap-2 p-3 bg-slate-700/50 rounded-lg font-mono text-sm text-white">
                    <div className="flex-1">
                      <span className="text-slate-400">Type:</span> A<br />
                      <span className="text-slate-400">Name:</span> @<br />
                      <span className="text-slate-400">Value:</span> 76.76.21.21
                    </div>
                    <Button 
                      size="icon" 
                      variant="ghost"
                      onClick={() => copyToClipboard("76.76.21.21")}
                      className="text-slate-400 hover:text-white"
                      data-testid="button-copy-a-record"
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                <Separator className="bg-slate-700" />

                <div className="space-y-2">
                  <Label className="text-white">For subdomain (www.example.com):</Label>
                  <div className="flex items-center gap-2 p-3 bg-slate-700/50 rounded-lg font-mono text-sm text-white">
                    <div className="flex-1">
                      <span className="text-slate-400">Type:</span> CNAME<br />
                      <span className="text-slate-400">Name:</span> www<br />
                      <span className="text-slate-400">Value:</span> cname.vercel-dns.com
                    </div>
                    <Button 
                      size="icon" 
                      variant="ghost"
                      onClick={() => copyToClipboard("cname.vercel-dns.com")}
                      className="text-slate-400 hover:text-white"
                      data-testid="button-copy-cname"
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
