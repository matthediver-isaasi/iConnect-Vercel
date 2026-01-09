import { useState, useEffect, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  ArrowLeft, 
  Loader2,
  Save,
  Upload,
  LogOut,
  Image,
  Trash2,
  Calendar,
  Mail,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Database,
  Users,
  Building2,
  Menu,
  Eye
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { format } from "date-fns";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";

const DATE_FORMAT_OPTIONS = [
  { value: 'dd/MM/yyyy', label: 'DD/MM/YYYY (31/12/2024)' },
  { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY (12/31/2024)' },
  { value: 'yyyy-MM-dd', label: 'YYYY-MM-DD (2024-12-31)' },
  { value: 'dd MMM yyyy', label: 'DD Mon YYYY (31 Dec 2024)' },
  { value: 'MMM dd, yyyy', label: 'Mon DD, YYYY (Dec 31, 2024)' },
  { value: 'MMMM dd, yyyy', label: 'Month DD, YYYY (December 31, 2024)' },
  { value: 'dd MMMM yyyy', label: 'DD Month YYYY (31 December 2024)' },
];

export default function AdminSettings() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [tenantUser, setTenantUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  
  const [formData, setFormData] = useState({
    name: '',
    billing_email: '',
    logo_url: '',
    favicon_url: '',
    settings: {
      logo_height: 'medium',
      logo_link: '',
      date_display_format: 'dd MMM yyyy',
      welcome_email_from_address: '',
      welcome_email_from_name: ''
    }
  });
  
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingFavicon, setUploadingFavicon] = useState(false);
  
  const [xeroLoading, setXeroLoading] = useState(false);
  const [xeroTokens, setXeroTokens] = useState([]);
  const [vatSyncLoading, setVatSyncLoading] = useState(false);
  const [vatSyncResult, setVatSyncResult] = useState(null);
  
  const [backfillDate, setBackfillDate] = useState(new Date());
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillResult, setBackfillResult] = useState(null);
  
  const [fixBlogHandlesLoading, setFixBlogHandlesLoading] = useState(false);
  const [fixBlogHandlesResult, setFixBlogHandlesResult] = useState(null);
  
  const [navDiagnosticsLoading, setNavDiagnosticsLoading] = useState(false);
  const [navDiagnosticsResult, setNavDiagnosticsResult] = useState(null);
  const [navBackfillLoading, setNavBackfillLoading] = useState(false);
  const [navBackfillResult, setNavBackfillResult] = useState(null);
  
  const logoInputRef = useRef(null);
  const faviconInputRef = useRef(null);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/tenant-user-me', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.tenantUser) {
            setTenantUser(data.tenantUser);
            setTenant(data.tenant);
            const settings = data.tenant?.settings || {};
            setFormData({
              name: data.tenant?.name || '',
              billing_email: data.tenant?.billing_email || '',
              logo_url: data.tenant?.logo_url || '',
              favicon_url: data.tenant?.favicon_url || '',
              settings: {
                logo_height: settings.logo_height || 'medium',
                logo_link: settings.logo_link || '',
                date_display_format: settings.date_display_format || 'dd MMM yyyy',
                welcome_email_from_address: settings.welcome_email_from_address || '',
                welcome_email_from_name: settings.welcome_email_from_name || ''
              }
            });
            
            fetchXeroTokens(data.tenant?.id);
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

  const fetchXeroTokens = async (tenantId) => {
    try {
      const response = await fetch(`/api/admin/xero-status?tenant_id=${tenantId}`, { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setXeroTokens(data.tokens || []);
      }
    } catch (err) {
      console.error('Failed to fetch Xero status:', err);
    }
  };

  const handleFileUpload = async (file, type) => {
    if (!file) return;
    
    const isLogo = type === 'logo';
    const setUploading = isLogo ? setUploadingLogo : setUploadingFavicon;
    
    if (isLogo && !file.type.startsWith('image/')) {
      toast({ title: "Invalid file", description: "Please upload an image file", variant: "destructive" });
      return;
    }
    
    if (!isLogo) {
      const validTypes = ['image/png', 'image/x-icon', 'image/svg+xml', 'image/vnd.microsoft.icon'];
      if (!validTypes.includes(file.type) && !file.name.endsWith('.ico')) {
        toast({ title: "Invalid file", description: "Please upload a PNG, ICO, or SVG file", variant: "destructive" });
        return;
      }
    }
    
    setUploading(true);
    
    try {
      const formDataUpload = new FormData();
      formDataUpload.append('file', file);
      
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: formDataUpload
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
      }
      
      const result = await response.json();
      
      setFormData(prev => ({
        ...prev,
        [isLogo ? 'logo_url' : 'favicon_url']: result.file_url
      }));
      
      toast({
        title: "File uploaded",
        description: `${isLogo ? 'Logo' : 'Favicon'} uploaded successfully.`
      });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err.message || "Failed to upload file.",
        variant: "destructive"
      });
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);

    try {
      const response = await fetch('/api/admin/tenant', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: formData.name,
          billing_email: formData.billing_email,
          logo_url: formData.logo_url,
          favicon_url: formData.favicon_url,
          settings: formData.settings
        })
      });

      if (response.ok) {
        toast({
          title: "Settings saved",
          description: "Your tenant settings have been updated."
        });
      } else {
        throw new Error('Failed to save');
      }
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to save settings. Please try again.",
        variant: "destructive"
      });
    } finally {
      setSaving(false);
    }
  };

  const handleXeroAuthenticate = async () => {
    setXeroLoading(true);
    try {
      const response = await fetch('/api/xero/auth-url', {
        method: 'POST',
        credentials: 'include'
      });
      
      if (!response.ok) throw new Error('Failed to get auth URL');
      
      const { authUrl } = await response.json();
      const popup = window.open(authUrl, 'XeroAuth', 'width=600,height=700');
      
      const checkClosed = setInterval(() => {
        if (popup?.closed) {
          clearInterval(checkClosed);
          setXeroLoading(false);
          if (tenant?.id) fetchXeroTokens(tenant.id);
        }
      }, 1000);
    } catch (error) {
      console.error('Xero auth error:', error);
      toast({ title: "Error", description: "Failed to start Xero authentication", variant: "destructive" });
      setXeroLoading(false);
    }
  };

  const handleSyncVatRates = async () => {
    setVatSyncLoading(true);
    setVatSyncResult(null);
    try {
      const response = await fetch('/api/xero/sync-vat-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      const data = await response.json();
      
      if (!response.ok) throw new Error(data.error || 'Failed to sync VAT rates');
      
      setVatSyncResult({ success: true, count: data.count });
      toast({ title: "Success", description: `Synced ${data.count} VAT rates from Xero` });
    } catch (error) {
      setVatSyncResult({ success: false, error: error.message });
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setVatSyncLoading(false);
    }
  };

  const handleBackfillOrgDates = async () => {
    setBackfillLoading(true);
    setBackfillResult(null);
    try {
      const response = await fetch('/api/admin/backfill-organization-dates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ date: backfillDate.toISOString() })
      });
      const data = await response.json();
      
      if (!response.ok) throw new Error(data.error || 'Failed to backfill dates');
      
      setBackfillResult({ success: true, updated: data.updated });
      toast({ title: "Success", description: `Updated ${data.updated} organisations` });
    } catch (error) {
      setBackfillResult({ success: false, error: error.message });
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setBackfillLoading(false);
    }
  };

  const handleFixBlogHandles = async () => {
    setFixBlogHandlesLoading(true);
    setFixBlogHandlesResult(null);
    try {
      const response = await fetch('/api/admin/fix-blog-handles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      const data = await response.json();
      
      if (!response.ok) throw new Error(data.error || 'Failed to fix blog handles');
      
      setFixBlogHandlesResult({ success: true, ...data });
      toast({ title: "Success", description: `Fixed ${data.slugsUpdated} blog slugs` });
    } catch (error) {
      setFixBlogHandlesResult({ success: false, error: error.message });
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setFixBlogHandlesLoading(false);
    }
  };

  const handleNavDiagnostics = async () => {
    setNavDiagnosticsLoading(true);
    setNavDiagnosticsResult(null);
    try {
      const response = await fetch('/api/admin/navigation-diagnostics', {
        method: 'GET',
        credentials: 'include'
      });
      const data = await response.json();
      
      if (!response.ok) throw new Error(data.error || 'Failed to get diagnostics');
      
      setNavDiagnosticsResult({ success: true, ...data });
      toast({ title: "Success", description: "Navigation diagnostics loaded" });
    } catch (error) {
      setNavDiagnosticsResult({ success: false, error: error.message });
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setNavDiagnosticsLoading(false);
    }
  };

  const handleNavBackfill = async () => {
    if (!tenant?.id) {
      toast({ title: "Error", description: "No tenant selected", variant: "destructive" });
      return;
    }
    
    setNavBackfillLoading(true);
    setNavBackfillResult(null);
    try {
      const response = await fetch('/api/admin/backfill-tenant-navigation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ targetTenantId: tenant.id })
      });
      const data = await response.json();
      
      if (!response.ok) throw new Error(data.error || 'Failed to backfill');
      
      setNavBackfillResult({ success: true, ...data });
      const totalUpdated = Object.values(data.updated || {}).reduce((sum, t) => sum + (t.count || 0), 0);
      toast({ title: "Success", description: `Updated ${totalUpdated} navigation records` });
    } catch (error) {
      setNavBackfillResult({ success: false, error: error.message });
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setNavBackfillLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (err) {}
    localStorage.removeItem('saas_admin');
    navigate('/admin/login');
  };

  const isXeroAuthenticated = xeroTokens.length > 0;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  const logoHeightPx = formData.settings.logo_height === 'small' ? '40px' 
    : formData.settings.logo_height === 'large' ? '80px' : '60px';

  return (
    <div className="min-h-screen bg-slate-900">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-3">
              <Link 
                to="/admin/dashboard"
                className="w-10 h-10 bg-slate-800 hover:bg-slate-700 rounded-lg flex items-center justify-center transition-colors"
                data-testid="button-back"
              >
                <ArrowLeft className="h-5 w-5 text-slate-400" />
              </Link>
              <div>
                <h1 className="text-lg font-semibold text-white">Tenant Settings</h1>
                <p className="text-xs text-slate-400">{tenant?.name}</p>
              </div>
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
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <form onSubmit={handleSubmit} className="space-y-6">
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white">Basic Information</CardTitle>
              <CardDescription className="text-slate-400">
                Update your tenant's basic details
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-slate-200">Tenant Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="bg-slate-900/50 border-slate-600 text-white"
                  data-testid="input-tenant-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="billing_email" className="text-slate-200">Billing Email</Label>
                <Input
                  id="billing_email"
                  type="email"
                  value={formData.billing_email}
                  onChange={(e) => setFormData({ ...formData, billing_email: e.target.value })}
                  placeholder="billing@company.com"
                  className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-billing-email"
                />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Image className="w-5 h-5" />
                Portal Logo
              </CardTitle>
              <CardDescription className="text-slate-400">
                Upload a custom logo to display in the portal navigation
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label className="text-slate-200">Current Logo</Label>
                <div className="border-2 border-dashed border-slate-600 rounded-lg p-4 bg-slate-900/50">
                  {formData.logo_url ? (
                    <div className="flex items-center gap-4">
                      <div 
                        className="bg-white border border-slate-600 rounded-lg p-2 flex items-center justify-center"
                        style={{ width: '200px', height: logoHeightPx }}
                      >
                        <img 
                          src={formData.logo_url} 
                          alt="Portal Logo" 
                          className="max-h-full max-w-full object-contain"
                        />
                      </div>
                      <Button 
                        type="button"
                        variant="outline" 
                        size="sm"
                        onClick={() => setFormData({ ...formData, logo_url: '' })}
                        className="text-red-400 hover:text-red-300 border-slate-600"
                        data-testid="button-remove-logo"
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <div className="text-center py-4">
                      <Image className="w-12 h-12 text-slate-500 mx-auto mb-2" />
                      <p className="text-sm text-slate-400">No logo uploaded</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-slate-200">Upload New Logo</Label>
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleFileUpload(e.target.files?.[0], 'logo')}
                  data-testid="input-logo-file"
                />
                <div 
                  onClick={() => !uploadingLogo && logoInputRef.current?.click()}
                  className="flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-slate-600 rounded-lg cursor-pointer hover:border-blue-500 hover:bg-slate-800 transition-colors"
                >
                  {uploadingLogo ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
                      <span className="text-sm text-blue-400">Uploading...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-5 h-5 text-slate-400" />
                      <span className="text-sm text-slate-300">Click to upload image</span>
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="logo-height" className="text-slate-200">Logo Height</Label>
                <Select 
                  value={formData.settings.logo_height} 
                  onValueChange={(value) => setFormData({
                    ...formData, 
                    settings: { ...formData.settings, logo_height: value }
                  })}
                >
                  <SelectTrigger className="bg-slate-900/50 border-slate-600 text-white" data-testid="select-logo-height">
                    <SelectValue placeholder="Select height" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">Small (40px)</SelectItem>
                    <SelectItem value="medium">Medium (60px)</SelectItem>
                    <SelectItem value="large">Large (80px)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="logo-link" className="text-slate-200">Logo Click Link (optional)</Label>
                <Input
                  id="logo-link"
                  type="url"
                  placeholder="https://example.com"
                  value={formData.settings.logo_link}
                  onChange={(e) => setFormData({
                    ...formData,
                    settings: { ...formData.settings, logo_link: e.target.value }
                  })}
                  className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-logo-link"
                />
                <p className="text-xs text-slate-500">
                  When clicked, the logo will navigate to this URL. Leave empty to link to Events page.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Image className="w-5 h-5" />
                Site Favicon
              </CardTitle>
              <CardDescription className="text-slate-400">
                Upload a custom favicon (browser tab icon)
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label className="text-slate-200">Current Favicon</Label>
                <div className="border-2 border-dashed border-slate-600 rounded-lg p-4 bg-slate-900/50">
                  {formData.favicon_url ? (
                    <div className="flex items-center gap-4">
                      <div 
                        className="bg-white border border-slate-600 rounded-lg p-2 flex items-center justify-center"
                        style={{ width: '64px', height: '64px' }}
                      >
                        <img 
                          src={formData.favicon_url} 
                          alt="Site Favicon" 
                          className="max-h-full max-w-full object-contain"
                          style={{ imageRendering: 'pixelated' }}
                        />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-200">Favicon uploaded</p>
                        <p className="text-xs text-slate-400">Preview at 64x64 pixels</p>
                      </div>
                      <Button 
                        type="button"
                        variant="outline" 
                        size="sm"
                        onClick={() => setFormData({ ...formData, favicon_url: '' })}
                        className="text-red-400 hover:text-red-300 border-slate-600"
                        data-testid="button-remove-favicon"
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <div className="text-center py-4">
                      <Image className="w-12 h-12 text-slate-500 mx-auto mb-2" />
                      <p className="text-sm text-slate-400">No favicon uploaded</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-slate-200">Upload New Favicon</Label>
                <input
                  ref={faviconInputRef}
                  type="file"
                  accept=".png,.ico,.svg,image/png,image/x-icon,image/svg+xml"
                  className="hidden"
                  onChange={(e) => handleFileUpload(e.target.files?.[0], 'favicon')}
                  data-testid="input-favicon-file"
                />
                <div 
                  onClick={() => !uploadingFavicon && faviconInputRef.current?.click()}
                  className="flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-slate-600 rounded-lg cursor-pointer hover:border-blue-500 hover:bg-slate-800 transition-colors"
                >
                  {uploadingFavicon ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
                      <span className="text-sm text-blue-400">Uploading...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-5 h-5 text-slate-400" />
                      <span className="text-sm text-slate-300">Click to upload favicon</span>
                    </>
                  )}
                </div>
              </div>

              <div className="p-4 bg-blue-900/30 rounded-lg border border-blue-800">
                <h4 className="text-sm font-medium text-blue-300 mb-2">Recommended Specifications</h4>
                <ul className="text-xs text-blue-200 space-y-1">
                  <li><strong>Size:</strong> 32x32 pixels (or 16x16, 48x48, 64x64)</li>
                  <li><strong>Format:</strong> PNG (recommended), ICO, or SVG</li>
                  <li><strong>Background:</strong> Transparent PNG works best</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Calendar className="w-5 h-5" />
                Date Display Format
              </CardTitle>
              <CardDescription className="text-slate-400">
                Configure how dates are displayed across the portal
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="date-format" className="text-slate-200">Date Format</Label>
                <Select 
                  value={formData.settings.date_display_format} 
                  onValueChange={(value) => setFormData({
                    ...formData,
                    settings: { ...formData.settings, date_display_format: value }
                  })}
                >
                  <SelectTrigger className="bg-slate-900/50 border-slate-600 text-white" data-testid="select-date-format">
                    <SelectValue placeholder="Select date format" />
                  </SelectTrigger>
                  <SelectContent>
                    {DATE_FORMAT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-600">
                <p className="text-sm text-slate-400 mb-1">Preview:</p>
                <p className="text-lg font-medium text-white">
                  {format(new Date(), formData.settings.date_display_format)}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Mail className="w-5 h-5" />
                Email Settings
              </CardTitle>
              <CardDescription className="text-slate-400">
                Configure outgoing email sender details
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email-from-name" className="text-slate-200">Welcome Email From Name</Label>
                <Input
                  id="email-from-name"
                  value={formData.settings.welcome_email_from_name}
                  onChange={(e) => setFormData({
                    ...formData,
                    settings: { ...formData.settings, welcome_email_from_name: e.target.value }
                  })}
                  placeholder="Your Organization"
                  className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-email-from-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email-from-address" className="text-slate-200">Welcome Email From Address</Label>
                <Input
                  id="email-from-address"
                  type="email"
                  value={formData.settings.welcome_email_from_address}
                  onChange={(e) => setFormData({
                    ...formData,
                    settings: { ...formData.settings, welcome_email_from_address: e.target.value }
                  })}
                  placeholder="noreply@yourdomain.com"
                  className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
                  data-testid="input-email-from-address"
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button 
              type="submit" 
              disabled={saving}
              className="min-w-[140px]"
              data-testid="button-save"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save All Settings
                </>
              )}
            </Button>
          </div>
        </form>

        <div className="mt-8 space-y-6">
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white">Xero Integration</CardTitle>
              <CardDescription className="text-slate-400">
                Connect your Xero account for automatic invoice creation
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isXeroAuthenticated ? (
                <div className="flex items-start gap-3 p-4 bg-green-900/30 border border-green-800 rounded-lg">
                  <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h3 className="font-semibold text-green-300 mb-1">Connected</h3>
                    <p className="text-sm text-green-200">
                      Your Xero account is connected and ready to create invoices.
                    </p>
                    {xeroTokens[0]?.tenant_name && (
                      <p className="text-sm text-green-200 mt-1">
                        <strong>Company:</strong> {xeroTokens[0].tenant_name}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-amber-900/30 border border-amber-800 rounded-lg">
                  <p className="text-sm text-amber-200">
                    <strong>Authentication Required</strong> - Connect to Xero to enable automatic invoice creation.
                  </p>
                </div>
              )}

              <Button
                type="button"
                onClick={handleXeroAuthenticate}
                disabled={xeroLoading}
                className="w-full"
                data-testid="button-xero-auth"
              >
                {xeroLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Authenticating...
                  </>
                ) : isXeroAuthenticated ? (
                  <>
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Re-authenticate with Xero
                  </>
                ) : (
                  <>
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Authenticate with Xero
                  </>
                )}
              </Button>

              {isXeroAuthenticated && (
                <>
                  <div className="pt-4 border-t border-slate-700">
                    <h4 className="text-sm font-medium text-slate-200 mb-3">VAT Rates</h4>
                    {vatSyncResult && (
                      <div className={`mb-3 flex items-start gap-2 p-3 rounded-lg ${
                        vatSyncResult.success 
                          ? 'bg-green-900/30 border border-green-800' 
                          : 'bg-red-900/30 border border-red-800'
                      }`}>
                        {vatSyncResult.success ? (
                          <>
                            <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5" />
                            <span className="text-sm text-green-200">Synced {vatSyncResult.count} VAT rates</span>
                          </>
                        ) : (
                          <>
                            <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5" />
                            <span className="text-sm text-red-200">{vatSyncResult.error}</span>
                          </>
                        )}
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleSyncVatRates}
                      disabled={vatSyncLoading}
                      className="w-full border-slate-600 text-slate-200"
                      data-testid="button-sync-vat"
                    >
                      {vatSyncLoading ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Syncing...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-4 h-4 mr-2" />
                          Sync VAT Rates from Xero
                        </>
                      )}
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Database className="w-5 h-5" />
                Database Utilities
              </CardTitle>
              <CardDescription className="text-slate-400">
                Administrative tools for data maintenance
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <h4 className="text-sm font-medium text-slate-200 flex items-center gap-2">
                  <Building2 className="w-4 h-4" />
                  Backfill Organisation Created Dates
                </h4>
                <p className="text-xs text-slate-400">
                  Set a created date for organisations that don't have one.
                </p>
                <div className="flex gap-3">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="border-slate-600 text-slate-200" data-testid="button-backfill-date">
                        <Calendar className="w-4 h-4 mr-2" />
                        {format(backfillDate, 'dd MMM yyyy')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0">
                      <CalendarComponent
                        mode="single"
                        selected={backfillDate}
                        onSelect={(date) => date && setBackfillDate(date)}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleBackfillOrgDates}
                    disabled={backfillLoading}
                    className="border-slate-600 text-slate-200"
                    data-testid="button-backfill-run"
                  >
                    {backfillLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Running...
                      </>
                    ) : (
                      'Run Backfill'
                    )}
                  </Button>
                </div>
                {backfillResult && (
                  <div className={`flex items-center gap-2 text-sm ${
                    backfillResult.success ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {backfillResult.success ? (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        Updated {backfillResult.updated} organisations
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-4 h-4" />
                        {backfillResult.error}
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="border-t border-slate-700 pt-6 space-y-3">
                <h4 className="text-sm font-medium text-slate-200 flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Fix Blog Author Handles
                </h4>
                <p className="text-xs text-slate-400">
                  Create member handles and fix blog author slugs for existing posts.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleFixBlogHandles}
                  disabled={fixBlogHandlesLoading}
                  className="border-slate-600 text-slate-200"
                  data-testid="button-fix-handles"
                >
                  {fixBlogHandlesLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Running...
                    </>
                  ) : (
                    'Fix Blog Handles'
                  )}
                </Button>
                {fixBlogHandlesResult && (
                  <div className={`flex items-center gap-2 text-sm ${
                    fixBlogHandlesResult.success ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {fixBlogHandlesResult.success ? (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        Fixed {fixBlogHandlesResult.slugsUpdated} slugs, created {fixBlogHandlesResult.handlesCreated} handles
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-4 h-4" />
                        {fixBlogHandlesResult.error}
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="border-t border-slate-700 pt-6 space-y-3">
                <h4 className="text-sm font-medium text-slate-200 flex items-center gap-2">
                  <Menu className="w-4 h-4" />
                  Navigation Tenant Assignment
                </h4>
                <p className="text-xs text-slate-400">
                  View and fix tenant assignments for portal navigation items, menus, and navigation items.
                </p>
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleNavDiagnostics}
                    disabled={navDiagnosticsLoading}
                    className="border-slate-600 text-slate-200"
                    data-testid="button-nav-diagnostics"
                  >
                    {navDiagnosticsLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <Eye className="w-4 h-4 mr-2" />
                        View Diagnostics
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleNavBackfill}
                    disabled={navBackfillLoading}
                    className="border-slate-600 text-slate-200"
                    data-testid="button-nav-backfill"
                  >
                    {navBackfillLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Running...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Backfill to Current Tenant
                      </>
                    )}
                  </Button>
                </div>
                {navBackfillResult && (
                  <div className={`flex items-center gap-2 text-sm ${
                    navBackfillResult.success ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {navBackfillResult.success ? (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        Backfill complete for {navBackfillResult.targetTenant}
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-4 h-4" />
                        {navBackfillResult.error}
                      </>
                    )}
                  </div>
                )}
                {navDiagnosticsResult && navDiagnosticsResult.success && (
                  <div className="mt-4 space-y-3">
                    <div className="text-xs text-slate-400">
                      <strong className="text-slate-200">Tenants:</strong>
                      <ul className="mt-1 ml-4 list-disc">
                        {navDiagnosticsResult.tenants?.map(t => (
                          <li key={t.id}>{t.name} ({t.slug}) - {t.id}</li>
                        ))}
                      </ul>
                    </div>
                    {Object.entries(navDiagnosticsResult.navigation || {}).map(([table, info]) => (
                      <div key={table} className="text-xs text-slate-400">
                        <strong className="text-slate-200">{table}:</strong> {info.total || 0} records
                        {info.byTenantId && (
                          <ul className="mt-1 ml-4 list-disc">
                            {Object.entries(info.byTenantId).map(([tid, items]) => (
                              <li key={tid}>
                                tenant_id={tid === 'null' ? <span className="text-yellow-400">NULL</span> : tid.substring(0, 8) + '...'}: {items.length} items
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
