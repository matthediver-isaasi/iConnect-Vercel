
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Shield, Loader2, CheckCircle2, ExternalLink, RefreshCw, Calendar, Users, Building2, Search, AlertTriangle, Unlink, Upload, Image, Trash2, Database, Download } from "lucide-react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format } from "date-fns";

export default function AdminSetupPage() {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [xeroLoading, setXeroLoading] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [authWindow, setAuthWindow] = useState(null);
  const [xeroAuthWindow, setXeroAuthWindow] = useState(null);
  
  // Portal Logo state
  const [logoUrl, setLogoUrl] = useState("");
  const [logoHeight, setLogoHeight] = useState("medium");
  const [logoLink, setLogoLink] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoSaving, setLogoSaving] = useState(false);
  
  // Site Favicon state
  const [faviconUrl, setFaviconUrl] = useState("");
  const [faviconUploading, setFaviconUploading] = useState(false);
  const [faviconSaving, setFaviconSaving] = useState(false);
  
  // Backfill state
  const [backfillDate, setBackfillDate] = useState(new Date());
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillResult, setBackfillResult] = useState(null);
  
  // Fix blog handles state
  const [fixBlogHandlesLoading, setFixBlogHandlesLoading] = useState(false);
  const [fixBlogHandlesResult, setFixBlogHandlesResult] = useState(null);
  
  // Date format state
  const [dateDisplayFormat, setDateDisplayFormat] = useState("dd MMM yyyy");
  const [dateFormatSaving, setDateFormatSaving] = useState(false);
  
  // Xero VAT rates state
  const [vatSyncLoading, setVatSyncLoading] = useState(false);
  const [vatSyncResult, setVatSyncResult] = useState(null);
  
  // Xero Payment Test state
  const [testPaymentInvoiceId, setTestPaymentInvoiceId] = useState("");
  const [testPaymentAmount, setTestPaymentAmount] = useState("");
  const [testPaymentLoading, setTestPaymentLoading] = useState(false);
  const [testPaymentResult, setTestPaymentResult] = useState(null);
  
  // Email settings state
  const [welcomeEmailFromAddress, setWelcomeEmailFromAddress] = useState("");
  const [welcomeEmailFromName, setWelcomeEmailFromName] = useState("");
  const [emailSettingsSaving, setEmailSettingsSaving] = useState(false);
  
  const DATE_FORMAT_OPTIONS = [
    { value: 'dd/MM/yyyy', label: 'DD/MM/YYYY (31/12/2024)' },
    { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY (12/31/2024)' },
    { value: 'yyyy-MM-dd', label: 'YYYY-MM-DD (2024-12-31)' },
    { value: 'dd MMM yyyy', label: 'DD Mon YYYY (31 Dec 2024)' },
    { value: 'MMM dd, yyyy', label: 'Mon DD, YYYY (Dec 31, 2024)' },
    { value: 'MMMM dd, yyyy', label: 'Month DD, YYYY (December 31, 2024)' },
    { value: 'dd MMMM yyyy', label: 'DD Month YYYY (31 December 2024)' },
  ];

  // Query for Xero tokens
  const { data: xeroTokens = [] } = useQuery({
    queryKey: ['xero-tokens'],
    queryFn: () => base44.entities.XeroToken.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const isXeroAuthenticated = xeroTokens.length > 0;

  // Query for portal logo settings
  const { data: systemSettings = [] } = useQuery({
    queryKey: ['system-settings-logo'],
    queryFn: () => base44.entities.SystemSettings.list(),
  });

  // Load logo settings when data is available
  useEffect(() => {
    if (systemSettings.length > 0) {
      const logoUrlSetting = systemSettings.find(s => s.setting_key === 'portal_logo_url');
      const logoHeightSetting = systemSettings.find(s => s.setting_key === 'portal_logo_height');
      const logoLinkSetting = systemSettings.find(s => s.setting_key === 'portal_logo_link');
      const dateFormatSetting = systemSettings.find(s => s.setting_key === 'date_display_format');
      
      if (logoUrlSetting?.setting_value) setLogoUrl(logoUrlSetting.setting_value);
      if (logoHeightSetting?.setting_value) setLogoHeight(logoHeightSetting.setting_value);
      if (logoLinkSetting?.setting_value) setLogoLink(logoLinkSetting.setting_value);
      if (dateFormatSetting?.setting_value) setDateDisplayFormat(dateFormatSetting.setting_value);
      
      const faviconUrlSetting = systemSettings.find(s => s.setting_key === 'site_favicon_url');
      if (faviconUrlSetting?.setting_value) setFaviconUrl(faviconUrlSetting.setting_value);
      
      const welcomeEmailFromSetting = systemSettings.find(s => s.setting_key === 'welcome_email_from_address');
      const welcomeEmailNameSetting = systemSettings.find(s => s.setting_key === 'welcome_email_from_name');
      if (welcomeEmailFromSetting?.setting_value) setWelcomeEmailFromAddress(welcomeEmailFromSetting.setting_value);
      if (welcomeEmailNameSetting?.setting_value) setWelcomeEmailFromName(welcomeEmailNameSetting.setting_value);
    }
  }, [systemSettings]);

  // Handle logo file upload
  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error('Please upload an image file');
      return;
    }

    setLogoUploading(true);
    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      setLogoUrl(response.file_url);
      toast.success('Logo uploaded successfully');
    } catch (error) {
      console.error('Logo upload error:', error);
      toast.error('Failed to upload logo');
    } finally {
      setLogoUploading(false);
    }
  };

  // Save logo settings
  const handleSaveLogoSettings = async () => {
    setLogoSaving(true);
    try {
      const settingsToSave = [
        { key: 'portal_logo_url', value: logoUrl },
        { key: 'portal_logo_height', value: logoHeight },
        { key: 'portal_logo_link', value: logoLink }
      ];

      for (const setting of settingsToSave) {
        const existing = systemSettings.find(s => s.setting_key === setting.key);
        if (existing) {
          await base44.entities.SystemSettings.update(existing.id, { setting_value: setting.value });
        } else {
          await base44.entities.SystemSettings.create({ 
            setting_key: setting.key, 
            setting_value: setting.value 
          });
        }
      }

      queryClient.invalidateQueries({ queryKey: ['system-settings-logo'] });
      queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      queryClient.invalidateQueries({ queryKey: ['portal-logo-settings'] });
      toast.success('Portal logo settings saved - refresh the portal to see changes');
    } catch (error) {
      console.error('Save logo settings error:', error);
      toast.error('Failed to save logo settings');
    } finally {
      setLogoSaving(false);
    }
  };

  // Remove logo
  const handleRemoveLogo = () => {
    setLogoUrl("");
  };

  // Handle favicon file upload
  const handleFaviconUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type - favicons should be PNG, ICO, or SVG
    const validTypes = ['image/png', 'image/x-icon', 'image/svg+xml', 'image/vnd.microsoft.icon'];
    if (!validTypes.includes(file.type) && !file.name.endsWith('.ico')) {
      toast.error('Please upload a PNG, ICO, or SVG file');
      return;
    }

    setFaviconUploading(true);
    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      setFaviconUrl(response.file_url);
      toast.success('Favicon uploaded successfully');
    } catch (error) {
      console.error('Favicon upload error:', error);
      toast.error('Failed to upload favicon');
    } finally {
      setFaviconUploading(false);
    }
  };

  // Save favicon settings
  const handleSaveFaviconSettings = async () => {
    setFaviconSaving(true);
    try {
      const existing = systemSettings.find(s => s.setting_key === 'site_favicon_url');
      if (existing) {
        await base44.entities.SystemSettings.update(existing.id, { setting_value: faviconUrl });
      } else {
        await base44.entities.SystemSettings.create({ 
          setting_key: 'site_favicon_url', 
          setting_value: faviconUrl 
        });
      }

      queryClient.invalidateQueries({ queryKey: ['system-settings-logo'] });
      queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      queryClient.invalidateQueries({ queryKey: ['portal-logo-settings'] });
      queryClient.invalidateQueries({ queryKey: ['site-favicon'] });
      toast.success('Favicon saved - the new icon will appear shortly');
    } catch (error) {
      console.error('Save favicon settings error:', error);
      toast.error('Failed to save favicon settings');
    } finally {
      setFaviconSaving(false);
    }
  };

  // Remove favicon
  const handleRemoveFavicon = () => {
    setFaviconUrl("");
  };

  // Save date format settings
  const handleSaveDateFormat = async () => {
    setDateFormatSaving(true);
    try {
      const existing = systemSettings.find(s => s.setting_key === 'date_display_format');
      if (existing) {
        await base44.entities.SystemSettings.update(existing.id, { setting_value: dateDisplayFormat });
      } else {
        await base44.entities.SystemSettings.create({ 
          setting_key: 'date_display_format', 
          setting_value: dateDisplayFormat 
        });
      }

      queryClient.invalidateQueries({ queryKey: ['system-settings-logo'] });
      queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      queryClient.invalidateQueries({ queryKey: ['system-settings-date-format'] });
      toast.success('Date format saved successfully');
    } catch (error) {
      console.error('Save date format error:', error);
      toast.error('Failed to save date format');
    } finally {
      setDateFormatSaving(false);
    }
  };

  // Save email settings
  const handleSaveEmailSettings = async () => {
    setEmailSettingsSaving(true);
    try {
      const settingsToSave = [
        { key: 'welcome_email_from_address', value: welcomeEmailFromAddress },
        { key: 'welcome_email_from_name', value: welcomeEmailFromName }
      ];

      for (const setting of settingsToSave) {
        const existing = systemSettings.find(s => s.setting_key === setting.key);
        if (existing) {
          await base44.entities.SystemSettings.update(existing.id, { setting_value: setting.value });
        } else {
          await base44.entities.SystemSettings.create({ 
            setting_key: setting.key, 
            setting_value: setting.value 
          });
        }
      }

      queryClient.invalidateQueries({ queryKey: ['system-settings-logo'] });
      queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      toast.success('Email settings saved successfully');
    } catch (error) {
      console.error('Save email settings error:', error);
      toast.error('Failed to save email settings');
    } finally {
      setEmailSettingsSaving(false);
    }
  };

  // Function for Xero authentication
  const handleXeroAuthenticate = async () => {
    setXeroLoading(true);
    try {
      const response = await base44.functions.invoke('getXeroAuthUrl');
      const { authUrl } = response.data;
      
      const popup = window.open(authUrl, 'XeroAuth', 'width=600,height=700');
      setXeroAuthWindow(popup);
      
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          setXeroAuthWindow(null);
          setXeroLoading(false);
          window.location.reload();
        }
      }, 1000);
      
    } catch (error) {
      console.error('Xero auth error:', error);
      setXeroLoading(false);
    }
  };

  // Sync VAT rates from Xero
  const handleSyncVatRates = async () => {
    setVatSyncLoading(true);
    setVatSyncResult(null);
    try {
      const response = await fetch('/api/xero/sync-vat-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to sync VAT rates');
      }
      
      setVatSyncResult({
        success: true,
        count: data.count,
        rates: data.rates,
        syncedAt: data.syncedAt
      });
      
      // Refresh system settings to show updated data
      queryClient.invalidateQueries({ queryKey: ['system-settings-logo'] });
      
      toast.success(`Successfully synced ${data.count} VAT rates from Xero`);
    } catch (error) {
      console.error('VAT sync error:', error);
      setVatSyncResult({
        success: false,
        error: error.message
      });
      toast.error(error.message || 'Failed to sync VAT rates');
    } finally {
      setVatSyncLoading(false);
    }
  };

  // Test Xero payment recording
  const handleTestPaymentRecording = async () => {
    if (!testPaymentInvoiceId) {
      toast.error('Please enter a Xero invoice ID or number');
      return;
    }
    if (!testPaymentAmount || parseFloat(testPaymentAmount) <= 0) {
      toast.error('Please enter a valid payment amount');
      return;
    }

    setTestPaymentLoading(true);
    setTestPaymentResult(null);
    
    try {
      const response = await base44.functions.invoke('testXeroPaymentRecording', {
        invoiceId: testPaymentInvoiceId,
        amount: parseFloat(testPaymentAmount),
        testReference: `TEST-${Date.now()}`
      });
      
      const data = response.data;
      setTestPaymentResult(data);
      
      if (data.success) {
        toast.success(`Payment recorded successfully: ${data.invoiceNumber}`);
      } else {
        toast.error(data.error || 'Failed to record payment');
      }
    } catch (error) {
      console.error('Test payment error:', error);
      setTestPaymentResult({
        success: false,
        error: error.message
      });
      toast.error(error.message || 'Failed to test payment recording');
    } finally {
      setTestPaymentLoading(false);
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
      if (!response.ok) {
        throw new Error(data.error || 'Failed to backfill dates');
      }
      setBackfillResult({
        success: true,
        updated: data.updated,
        date: data.backfillDate
      });
      toast.success(`Updated ${data.updated} organisations with created date`);
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    } catch (error) {
      setBackfillResult({
        success: false,
        error: error.message
      });
      toast.error(error.message);
    } finally {
      setBackfillLoading(false);
    }
  };

  // Handle fix blog handles
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
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fix blog handles');
      }
      setFixBlogHandlesResult({
        success: true,
        handlesCreated: data.handlesCreated,
        slugsUpdated: data.slugsUpdated,
        totalBlogs: data.totalBlogs,
        errors: data.errors
      });
      toast.success(`Fixed ${data.slugsUpdated} blog slugs, created ${data.handlesCreated} member handles`);
    } catch (error) {
      setFixBlogHandlesResult({
        success: false,
        error: error.message
      });
      toast.error(error.message);
    } finally {
      setFixBlogHandlesLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl shadow-lg mb-4">
            <Shield className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Admin Setup</h1>
          <p className="text-slate-600">Configure portal branding and integrations</p>
        </div>

        {/* Portal Logo Configuration */}
        <Card className="shadow-xl border-slate-200 mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Image className="w-5 h-5" />
              Portal Logo
            </CardTitle>
            <CardDescription>
              Upload a custom logo to display in the portal navigation. This replaces the default branding.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Logo Preview */}
            <div className="space-y-2">
              <Label>Current Logo</Label>
              <div className="border-2 border-dashed border-slate-200 rounded-lg p-4 bg-slate-50">
                {logoUrl ? (
                  <div className="flex items-center gap-4">
                    <div 
                      className="bg-white border border-slate-200 rounded-lg p-2 flex items-center justify-center"
                      style={{ 
                        width: '200px',
                        height: logoHeight === 'small' ? '40px' : logoHeight === 'large' ? '80px' : '60px'
                      }}
                    >
                      <img 
                        src={logoUrl} 
                        alt="Portal Logo" 
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={handleRemoveLogo}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4 mr-1" />
                      Remove
                    </Button>
                  </div>
                ) : (
                  <div className="text-center py-4">
                    <Image className="w-12 h-12 text-slate-300 mx-auto mb-2" />
                    <p className="text-sm text-slate-500">No logo uploaded</p>
                    <p className="text-xs text-slate-400">The default portal branding will be shown</p>
                  </div>
                )}
              </div>
            </div>

            {/* Upload Button */}
            <div className="space-y-2">
              <Label>Upload New Logo</Label>
              <div className="flex items-center gap-3">
                <label className="flex-1">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="hidden"
                    data-testid="input-logo-upload"
                  />
                  <div className="flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                    {logoUploading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                        <span className="text-sm text-blue-600">Uploading...</span>
                      </>
                    ) : (
                      <>
                        <Upload className="w-5 h-5 text-slate-400" />
                        <span className="text-sm text-slate-600">Click to upload image</span>
                      </>
                    )}
                  </div>
                </label>
              </div>
              <p className="text-xs text-slate-500">
                Recommended: PNG or SVG with transparent background. The logo will be constrained to the navigation width.
              </p>
            </div>

            {/* Height Selector */}
            <div className="space-y-2">
              <Label htmlFor="logo-height">Logo Height</Label>
              <Select value={logoHeight} onValueChange={setLogoHeight}>
                <SelectTrigger id="logo-height" data-testid="select-logo-height">
                  <SelectValue placeholder="Select height" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="small">Small (40px)</SelectItem>
                  <SelectItem value="medium">Medium (60px)</SelectItem>
                  <SelectItem value="large">Large (80px)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">
                This controls the height of the logo container in the navigation.
              </p>
            </div>

            {/* Link URL */}
            <div className="space-y-2">
              <Label htmlFor="logo-link">Logo Click Link (optional)</Label>
              <Input
                id="logo-link"
                type="url"
                placeholder="https://example.com"
                value={logoLink}
                onChange={(e) => setLogoLink(e.target.value)}
                data-testid="input-logo-link"
              />
              <p className="text-xs text-slate-500">
                When clicked, the logo will navigate to this URL. Leave empty to link to the Events page.
              </p>
            </div>

            {/* Save Button */}
            <Button
              onClick={handleSaveLogoSettings}
              disabled={logoSaving}
              className="w-full"
              size="lg"
              data-testid="button-save-logo"
            >
              {logoSaving ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-5 h-5 mr-2" />
                  Save Logo Settings
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Site Favicon Configuration */}
        <Card className="shadow-xl border-slate-200 mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Image className="w-5 h-5" />
              Site Favicon
            </CardTitle>
            <CardDescription>
              Upload a custom favicon (the small icon shown in browser tabs). This will replace the default site icon.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Favicon Preview */}
            <div className="space-y-2">
              <Label>Current Favicon</Label>
              <div className="border-2 border-dashed border-slate-200 rounded-lg p-4 bg-slate-50">
                {faviconUrl ? (
                  <div className="flex items-center gap-4">
                    <div 
                      className="bg-white border border-slate-200 rounded-lg p-2 flex items-center justify-center"
                      style={{ width: '64px', height: '64px' }}
                    >
                      <img 
                        src={faviconUrl} 
                        alt="Site Favicon" 
                        className="max-h-full max-w-full object-contain"
                        style={{ imageRendering: 'pixelated' }}
                      />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-slate-700">Favicon uploaded</p>
                      <p className="text-xs text-slate-500">Preview shown at 64x64 pixels</p>
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={handleRemoveFavicon}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      data-testid="button-remove-favicon"
                    >
                      <Trash2 className="w-4 h-4 mr-1" />
                      Remove
                    </Button>
                  </div>
                ) : (
                  <div className="text-center py-4">
                    <Image className="w-12 h-12 text-slate-300 mx-auto mb-2" />
                    <p className="text-sm text-slate-500">No favicon uploaded</p>
                    <p className="text-xs text-slate-400">The default favicon will be used</p>
                  </div>
                )}
              </div>
            </div>

            {/* Upload Button */}
            <div className="space-y-2">
              <Label>Upload New Favicon</Label>
              <div className="flex items-center gap-3">
                <label className="flex-1">
                  <input
                    type="file"
                    accept=".png,.ico,.svg,image/png,image/x-icon,image/svg+xml"
                    onChange={handleFaviconUpload}
                    className="hidden"
                    data-testid="input-favicon-upload"
                  />
                  <div className="flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                    {faviconUploading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                        <span className="text-sm text-blue-600">Uploading...</span>
                      </>
                    ) : (
                      <>
                        <Upload className="w-5 h-5 text-slate-400" />
                        <span className="text-sm text-slate-600">Click to upload favicon</span>
                      </>
                    )}
                  </div>
                </label>
              </div>
            </div>

            {/* Size recommendations */}
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
              <h4 className="text-sm font-medium text-blue-900 mb-2">Recommended Specifications</h4>
              <ul className="text-xs text-blue-700 space-y-1">
                <li><strong>Size:</strong> 32x32 pixels (or 16x16, 48x48, 64x64)</li>
                <li><strong>Format:</strong> PNG (recommended), ICO, or SVG</li>
                <li><strong>Background:</strong> Transparent PNG works best</li>
                <li><strong>Tip:</strong> Keep the design simple - it will appear very small in browser tabs</li>
              </ul>
            </div>

            {/* Save Button */}
            <Button
              onClick={handleSaveFaviconSettings}
              disabled={faviconSaving}
              className="w-full"
              size="lg"
              data-testid="button-save-favicon"
            >
              {faviconSaving ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-5 h-5 mr-2" />
                  Save Favicon
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="shadow-xl border-slate-200 mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5 text-blue-600" />
              Date Display Format
            </CardTitle>
            <CardDescription>
              Configure how dates are displayed across the portal, including organisation and member detail views.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="date-format">Date Format</Label>
              <Select value={dateDisplayFormat} onValueChange={setDateDisplayFormat}>
                <SelectTrigger id="date-format" data-testid="select-date-format">
                  <SelectValue placeholder="Select date format" />
                </SelectTrigger>
                <SelectContent>
                  {DATE_FORMAT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">
                This format will be used for all date fields in organisation and member views.
              </p>
            </div>

            <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
              <p className="text-sm text-slate-600 mb-1">Preview:</p>
              <p className="text-lg font-medium text-slate-900">
                {format(new Date(), dateDisplayFormat)}
              </p>
            </div>

            <Button
              onClick={handleSaveDateFormat}
              disabled={dateFormatSaving}
              className="w-full"
              size="lg"
              data-testid="button-save-date-format"
            >
              {dateFormatSaving ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-5 h-5 mr-2" />
                  Save Date Format
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Xero Authentication Card */}
        <Card className="shadow-xl border-slate-200 mb-6">
          <CardHeader>
            <CardTitle>Xero Authentication</CardTitle>
            <CardDescription>
              Connect your Xero account to automatically create invoices for account charges
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {isXeroAuthenticated ? (
              <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
                <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h3 className="font-semibold text-green-900 mb-1">✓ Connected</h3>
                  <p className="text-sm text-green-700">
                    Your Xero account is connected and ready to create invoices.
                  </p>
                  {xeroTokens[0]?.tenant_name && (
                    <p className="text-sm text-green-700 mt-1">
                      <strong>Company:</strong> {xeroTokens[0].tenant_name}
                    </p>
                  )}
                  {xeroTokens[0] && xeroTokens[0].expires_at && (
                    <p className="text-xs text-green-600 mt-2">
                      Last updated: {new Date(xeroTokens[0].expires_at).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-sm text-amber-800">
                    <strong>⚠️ Authentication Required</strong><br />
                    Connect to Xero to enable automatic invoice creation for account charges.
                  </p>
                </div>

                <div className="space-y-2 text-sm text-slate-600">
                  <p><strong>This will allow the app to:</strong></p>
                  <ul className="list-disc list-inside space-y-1 ml-2">
                    <li>Create invoices in your Xero account</li>
                    <li>Access contact information for billing</li>
                    <li>Track invoice status and payments</li>
                  </ul>
                </div>
              </div>
            )}

            <Button
              onClick={handleXeroAuthenticate}
              disabled={xeroLoading}
              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
              size="lg"
            >
              {xeroLoading ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Authenticating...
                </>
              ) : isXeroAuthenticated ? (
                <>
                  <ExternalLink className="w-5 h-5 mr-2" />
                  Re-authenticate with Xero
                </>
              ) : (
                <>
                  <ExternalLink className="w-5 h-5 mr-2" />
                  Authenticate with Xero
                </>
              )}
            </Button>

            {isXeroAuthenticated && (
              <div className="pt-4 border-t border-slate-200">
                <p className="text-xs text-slate-500 text-center">
                  The app will automatically refresh tokens as needed. Re-authenticate only if you experience issues.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Xero VAT Rates Sync Card - only shown when Xero is authenticated */}
        {isXeroAuthenticated && (
          <Card className="shadow-xl border-slate-200 mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="w-5 h-5" />
                Xero VAT Rates
              </CardTitle>
              <CardDescription>
                Sync VAT rates from Xero for use in invoicing and pricing
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Show existing VAT rates if available */}
              {(() => {
                const vatRatesSetting = systemSettings.find(s => s.setting_key === 'xero_vat_rates');
                if (vatRatesSetting?.setting_value) {
                  try {
                    const vatData = JSON.parse(vatRatesSetting.setting_value);
                    return (
                      <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                        <div className="flex items-center justify-between mb-3">
                          <h4 className="font-medium text-slate-900">Stored VAT Rates</h4>
                          <span className="text-xs text-slate-500">
                            Last synced: {vatData.syncedAt ? new Date(vatData.syncedAt).toLocaleString() : 'Unknown'}
                          </span>
                        </div>
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {vatData.rates?.slice(0, 10).map((rate, idx) => (
                            <div key={idx} className="flex items-center justify-between text-sm py-1 border-b border-slate-100 last:border-0">
                              <span className="text-slate-700">{rate.name}</span>
                              <span className="font-medium text-slate-900">{rate.effectiveRate}%</span>
                            </div>
                          ))}
                          {vatData.rates?.length > 10 && (
                            <p className="text-xs text-slate-500 pt-2">
                              ...and {vatData.rates.length - 10} more rates
                            </p>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-3">
                          Total: {vatData.count || vatData.rates?.length || 0} VAT rates stored
                        </p>
                      </div>
                    );
                  } catch (e) {
                    return null;
                  }
                }
                return (
                  <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                    <p className="text-sm text-amber-800">
                      No VAT rates synced yet. Click the button below to fetch rates from Xero.
                    </p>
                  </div>
                );
              })()}

              {/* Show sync result if just synced */}
              {vatSyncResult && (
                <div className={`flex items-start gap-3 p-4 rounded-lg border ${
                  vatSyncResult.success 
                    ? 'bg-green-50 border-green-200' 
                    : 'bg-red-50 border-red-200'
                }`}>
                  {vatSyncResult.success ? (
                    <>
                      <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                      <div>
                        <h3 className="font-semibold text-green-900 mb-1">Sync Complete</h3>
                        <p className="text-sm text-green-700">
                          Successfully synced {vatSyncResult.count} VAT rates from Xero
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h3 className="font-semibold text-red-900 mb-1">Sync Failed</h3>
                        <p className="text-sm text-red-700">{vatSyncResult.error}</p>
                        {(vatSyncResult.error?.includes('401') || vatSyncResult.error?.includes('expired') || vatSyncResult.error?.includes('re-authenticate')) && (
                          <p className="text-xs text-red-600 mt-2">
                            Please scroll up and click "Re-authenticate with Xero" to refresh your connection.
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              <Button
                onClick={handleSyncVatRates}
                disabled={vatSyncLoading}
                className="w-full"
                variant="outline"
              >
                {vatSyncLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Syncing VAT Rates...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Sync VAT Rates from Xero
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Test Xero Payment Recording - only shown when Xero is authenticated */}
        {isXeroAuthenticated && (
          <Card className="shadow-xl border-slate-200 mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="w-5 h-5" />
                Test Payment Recording
              </CardTitle>
              <CardDescription>
                Test the Stripe payment recording integration by marking a Xero invoice as paid
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-sm text-amber-800">
                  <strong>Testing Tool:</strong> This will create a real payment record in Xero against the specified invoice. 
                  Only use for testing with test invoices or invoices you intend to mark as paid.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="test-invoice-id">Xero Invoice ID or Number</Label>
                  <Input
                    id="test-invoice-id"
                    value={testPaymentInvoiceId}
                    onChange={(e) => setTestPaymentInvoiceId(e.target.value)}
                    placeholder="e.g., INV-0001 or UUID"
                    data-testid="input-test-invoice-id"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="test-payment-amount">Payment Amount (£)</Label>
                  <Input
                    id="test-payment-amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={testPaymentAmount}
                    onChange={(e) => setTestPaymentAmount(e.target.value)}
                    placeholder="e.g., 100.00"
                    data-testid="input-test-payment-amount"
                  />
                </div>
              </div>

              {/* Show result */}
              {testPaymentResult && (
                <div className={`flex items-start gap-3 p-4 rounded-lg border ${
                  testPaymentResult.success 
                    ? 'bg-green-50 border-green-200' 
                    : 'bg-red-50 border-red-200'
                }`}>
                  {testPaymentResult.success ? (
                    <>
                      <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h3 className="font-semibold text-green-900 mb-1">Payment Recorded</h3>
                        <p className="text-sm text-green-700">
                          Invoice: {testPaymentResult.invoiceNumber}<br />
                          Amount: £{testPaymentResult.amount?.toFixed(2)}<br />
                          Bank Account: {testPaymentResult.bankAccount}<br />
                          Payment ID: {testPaymentResult.paymentId}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h3 className="font-semibold text-red-900 mb-1">Payment Failed</h3>
                        <p className="text-sm text-red-700">{testPaymentResult.error}</p>
                        {testPaymentResult.debug && (
                          <details className="mt-2">
                            <summary className="text-xs text-red-600 cursor-pointer">Debug Info</summary>
                            <pre className="text-xs text-red-600 mt-1 overflow-auto max-h-32 bg-red-100 p-2 rounded">
                              {JSON.stringify(testPaymentResult.debug, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              <Button
                onClick={handleTestPaymentRecording}
                disabled={testPaymentLoading || !testPaymentInvoiceId || !testPaymentAmount}
                className="w-full"
                variant="outline"
                data-testid="button-test-payment"
              >
                {testPaymentLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Recording Payment...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    Test Payment Recording
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Email Settings */}
        <Card className="shadow-xl border-slate-200 mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Email Settings
            </CardTitle>
            <CardDescription>
              Configure the from address used for system emails like welcome emails and password resets.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="welcome_email_from_name">From Name</Label>
                <Input
                  id="welcome_email_from_name"
                  value={welcomeEmailFromName}
                  onChange={(e) => setWelcomeEmailFromName(e.target.value)}
                  placeholder="e.g. ICONN Portal"
                  data-testid="input-welcome-email-from-name"
                />
                <p className="text-xs text-slate-500">
                  The name that appears in the "From" field of emails
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="welcome_email_from_address">From Email Address</Label>
                <Input
                  id="welcome_email_from_address"
                  type="email"
                  value={welcomeEmailFromAddress}
                  onChange={(e) => setWelcomeEmailFromAddress(e.target.value)}
                  placeholder="e.g. noreply@mail.iconn.app"
                  data-testid="input-welcome-email-from-address"
                />
                <p className="text-xs text-slate-500">
                  Must be a verified sender address in your Mailgun domain
                </p>
              </div>
            </div>

            <Button
              onClick={handleSaveEmailSettings}
              disabled={emailSettingsSaving}
              data-testid="button-save-email-settings"
            >
              {emailSettingsSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Save Email Settings
                </>
              )}
            </Button>

            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-xs text-blue-800">
                <strong>Note:</strong> These settings are used for welcome emails sent to new members created via application forms. 
                If left blank, the system default from address will be used.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Data Maintenance */}
        <Card className="shadow-xl border-slate-200 mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" />
              Data Maintenance
            </CardTitle>
            <CardDescription>
              Tools for maintaining and fixing data in the database.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div>
                <h3 className="font-medium text-slate-900 mb-2">Backfill Organisation Created Dates</h3>
                <p className="text-sm text-slate-600 mb-4">
                  Set a created date for all organisations that don't have one. This is useful for legacy data imported before date tracking was enabled.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Select backfill date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-start text-left font-normal"
                      data-testid="button-backfill-date"
                    >
                      <Calendar className="mr-2 h-4 w-4" />
                      {backfillDate ? format(backfillDate, "PPP") : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarComponent
                      mode="single"
                      selected={backfillDate}
                      onSelect={(date) => date && setBackfillDate(date)}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <Button
                onClick={handleBackfillOrgDates}
                disabled={backfillLoading}
                className="w-full"
                data-testid="button-backfill-dates"
              >
                {backfillLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Updating...
                  </>
                ) : (
                  <>
                    <Database className="w-4 h-4 mr-2" />
                    Backfill Created Dates
                  </>
                )}
              </Button>

              {backfillResult && (
                <div className={`p-3 rounded-lg border ${
                  backfillResult.success 
                    ? 'bg-green-50 border-green-200' 
                    : 'bg-red-50 border-red-200'
                }`}>
                  {backfillResult.success ? (
                    <div className="flex items-center gap-2 text-green-700">
                      <CheckCircle2 className="w-4 h-4" />
                      <span className="text-sm">
                        Updated {backfillResult.updated} organisations with date {format(new Date(backfillResult.date), "PPP")}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-red-700">
                      <AlertTriangle className="w-4 h-4" />
                      <span className="text-sm">{backfillResult.error}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="border-t border-slate-200 my-6" />

            {/* Fix Blog Handles Section */}
            <div className="space-y-4">
              <div>
                <h3 className="font-medium text-slate-900 mb-2">Fix Blog Author Handles</h3>
                <p className="text-sm text-slate-600 mb-4">
                  Generate unique handles for blog authors who don't have one, and update blog slugs to include the author's handle (e.g., "my-article-by-john-smith").
                </p>
              </div>

              <Button
                onClick={handleFixBlogHandles}
                disabled={fixBlogHandlesLoading}
                className="w-full"
                data-testid="button-fix-blog-handles"
              >
                {fixBlogHandlesLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Processing Blogs...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Fix Blog Handles & Slugs
                  </>
                )}
              </Button>

              {fixBlogHandlesResult && (
                <div className={`p-3 rounded-lg border ${
                  fixBlogHandlesResult.success 
                    ? 'bg-green-50 border-green-200' 
                    : 'bg-red-50 border-red-200'
                }`}>
                  {fixBlogHandlesResult.success ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-green-700">
                        <CheckCircle2 className="w-4 h-4" />
                        <span className="text-sm font-medium">
                          Processed {fixBlogHandlesResult.totalBlogs} blogs
                        </span>
                      </div>
                      <ul className="text-sm text-green-700 ml-6 list-disc">
                        <li>Member handles created: {fixBlogHandlesResult.handlesCreated}</li>
                        <li>Blog slugs updated: {fixBlogHandlesResult.slugsUpdated}</li>
                      </ul>
                      {fixBlogHandlesResult.errors && fixBlogHandlesResult.errors.length > 0 && (
                        <div className="mt-2 p-2 bg-amber-50 rounded border border-amber-200">
                          <p className="text-xs text-amber-800 font-medium">Warnings ({fixBlogHandlesResult.errors.length}):</p>
                          <ul className="text-xs text-amber-700 mt-1 max-h-32 overflow-y-auto">
                            {fixBlogHandlesResult.errors.slice(0, 5).map((err, i) => (
                              <li key={i}>{err}</li>
                            ))}
                            {fixBlogHandlesResult.errors.length > 5 && (
                              <li>...and {fixBlogHandlesResult.errors.length - 5} more</li>
                            )}
                          </ul>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-red-700">
                      <AlertTriangle className="w-4 h-4" />
                      <span className="text-sm">{fixBlogHandlesResult.error}</span>
                    </div>
                  )}
                </div>
              )}

              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-xs text-blue-800">
                  <strong>Note:</strong> This will only affect blogs with member authors. Guest writer blogs are not modified. 
                  Slugs that already have the correct "-by-handle" suffix will be skipped.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
