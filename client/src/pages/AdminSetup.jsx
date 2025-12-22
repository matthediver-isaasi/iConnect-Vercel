
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
  const [crmSyncLoading, setCrmSyncLoading] = useState(false);
  const [crmSyncResult, setCrmSyncResult] = useState(null);
  const [crmSyncLogs, setCrmSyncLogs] = useState([]);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [zohoAccountIdInput, setZohoAccountIdInput] = useState("");
  const [singleOrgSyncLoading, setSingleOrgSyncLoading] = useState(false);
  const [singleOrgSyncResult, setSingleOrgSyncResult] = useState(null);
  const [orgSearchTerm, setOrgSearchTerm] = useState("");
  
  // Portal Logo state
  const [logoUrl, setLogoUrl] = useState("");
  const [logoHeight, setLogoHeight] = useState("medium");
  const [logoLink, setLogoLink] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoSaving, setLogoSaving] = useState(false);
  
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

  const { data: tokens = [] } = useQuery({
    queryKey: ['zoho-tokens'],
    queryFn: () => base44.entities.ZohoToken.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  // New query for Xero tokens
  const { data: xeroTokens = [] } = useQuery({
    queryKey: ['xero-tokens'],
    queryFn: () => base44.entities.XeroToken.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const isAuthenticated = tokens.length > 0;
  const isXeroAuthenticated = xeroTokens.length > 0; // New derived state for Xero authentication

  // Query for organizations (for individual sync)
  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 30000,
    enabled: isAuthenticated,
  });

  // Filter organizations by search term
  const filteredOrganizations = organizations.filter(org => 
    org.name?.toLowerCase().includes(orgSearchTerm.toLowerCase())
  ).slice(0, 50); // Limit to 50 for performance

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

  const handleAuthenticate = async () => {
    setLoading(true);
    try {
      const response = await base44.functions.invoke('getZohoAuthUrl');
      const { authUrl } = response.data;
      
      const popup = window.open(authUrl, 'ZohoAuth', 'width=600,height=700');
      setAuthWindow(popup);
      
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          setAuthWindow(null);
          setLoading(false);
          window.location.reload();
        }
      }, 1000);
      
    } catch (error) {
      console.error('Auth error:', error);
      setLoading(false);
    }
  };

  const handleTestFunction = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const response = await base44.functions.invoke('testFunction', {
        accessToken: tokens.length > 0 ? tokens[0].access_token : null
      });
      setTestResult(response.data);
    } catch (error) {
      setTestResult({ 
        success: false, 
        error: error.response?.data?.error || error.message,
        fullError: JSON.stringify(error.response?.data || error, null, 2)
      });
    } finally {
      setTestLoading(false);
    }
  };

  const handleSyncEvents = async () => {
    setSyncLoading(true);
    setSyncResult(null);
    try {
      const response = await base44.functions.invoke('syncBackstageEvents', {});
      setSyncResult(response.data);
    } catch (error) {
      const errorMessage = error.response?.data?.error || error.message;
      const errorDetails = error.response?.data?.details || '';
      const isOAuthScopeError = errorMessage?.includes('OAuthScope') || errorDetails?.includes('OAuthScope');
      
      setSyncResult({ 
        success: false, 
        error: errorMessage,
        isOAuthScopeError
      });
    } finally {
      setSyncLoading(false);
    }
  };

  const handleDisconnectZoho = async () => {
    if (!window.confirm('Are you sure you want to disconnect Zoho? You will need to re-authenticate to use Zoho features.')) {
      return;
    }
    
    setDisconnecting(true);
    try {
      // Delete all Zoho tokens
      for (const token of tokens) {
        await base44.entities.ZohoToken.delete(token.id);
      }
      // Invalidate the query to refresh the UI
      queryClient.invalidateQueries({ queryKey: ['zoho-tokens'] });
      setSyncResult(null);
      setTestResult(null);
    } catch (error) {
      console.error('Failed to disconnect Zoho:', error);
    } finally {
      setDisconnecting(false);
    }
  };

  // New function for Xero authentication
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

  const handleSyncCrmData = async () => {
    setCrmSyncLoading(true);
    setCrmSyncResult(null);
    setCrmSyncLogs([]);
    
    const allLogs = [];
    const syncStartTime = new Date().toISOString();
    allLogs.push({ type: 'info', entity: 'sync', message: `CRM sync started at ${syncStartTime}` });
    
    try {
      // Chunked sync for organizations - auto-continue until complete
      let orgTotals = { synced: 0, created: 0, updated: 0, failed: 0 };
      let orgPageToken = null;
      let orgComplete = false;
      
      allLogs.push({ type: 'info', entity: 'organization', message: 'Starting organization sync...' });
      
      while (!orgComplete) {
        const params = orgPageToken ? { page_token: orgPageToken } : {};
        const orgResponse = await base44.functions.invoke('syncAllOrganizationsFromZoho', params);
        const orgData = orgResponse.data;
        
        if (!orgData.success) {
          allLogs.push({ type: 'error', entity: 'organization', message: orgData.error || 'Organization sync failed' });
          throw new Error(orgData.error || 'Organization sync failed');
        }
        
        orgTotals.synced += orgData.synced || 0;
        orgTotals.created += orgData.created || 0;
        orgTotals.updated += orgData.updated || 0;
        orgTotals.failed += orgData.failed || 0;
        
        // Collect logs from this chunk
        if (orgData.logs && orgData.logs.length > 0) {
          allLogs.push(...orgData.logs);
        }
        
        // Update UI with progress
        setCrmSyncResult(prev => ({
          ...prev,
          success: true,
          organizations: { ...orgTotals, message: orgData.message, complete: orgData.complete }
        }));
        
        if (orgData.complete || !orgData.next_page_token) {
          orgComplete = true;
        } else {
          orgPageToken = orgData.next_page_token;
        }
      }
      
      allLogs.push({ type: 'info', entity: 'organization', message: `Organization sync complete: ${orgTotals.synced} processed, ${orgTotals.created} created, ${orgTotals.updated} updated, ${orgTotals.failed} failed` });
      
      // Chunked sync for members - auto-continue until complete
      let memberTotals = { synced: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
      let memberPageToken = null;
      let memberComplete = false;
      
      allLogs.push({ type: 'info', entity: 'member', message: 'Starting member sync...' });
      
      while (!memberComplete) {
        const params = memberPageToken ? { page_token: memberPageToken } : {};
        const memberResponse = await base44.functions.invoke('syncAllMembersFromZoho', params);
        const memberData = memberResponse.data;
        
        if (!memberData.success) {
          allLogs.push({ type: 'error', entity: 'member', message: memberData.error || 'Member sync failed' });
          throw new Error(memberData.error || 'Member sync failed');
        }
        
        memberTotals.synced += memberData.synced || 0;
        memberTotals.created += memberData.created || 0;
        memberTotals.updated += memberData.updated || 0;
        memberTotals.skipped += memberData.skipped || 0;
        memberTotals.failed += memberData.failed || 0;
        
        // Collect logs from this chunk
        if (memberData.logs && memberData.logs.length > 0) {
          allLogs.push(...memberData.logs);
        }
        
        // Update UI with progress
        setCrmSyncResult(prev => ({
          ...prev,
          success: true,
          members: { ...memberTotals, message: memberData.message, complete: memberData.complete }
        }));
        
        if (memberData.complete || !memberData.next_page_token) {
          memberComplete = true;
        } else {
          memberPageToken = memberData.next_page_token;
        }
      }
      
      allLogs.push({ type: 'info', entity: 'member', message: `Member sync complete: ${memberTotals.synced} processed, ${memberTotals.created} created, ${memberTotals.updated} updated, ${memberTotals.skipped} skipped, ${memberTotals.failed} failed` });
      allLogs.push({ type: 'info', entity: 'sync', message: `CRM sync completed at ${new Date().toISOString()}` });
      
      // Store logs for download
      setCrmSyncLogs(allLogs);
      
      // Final result
      setCrmSyncResult({
        success: true,
        organizations: { ...orgTotals, complete: true, message: `Synced ${orgTotals.synced} organizations (${orgTotals.created} created, ${orgTotals.updated} updated, ${orgTotals.failed} failed)` },
        members: { ...memberTotals, complete: true, message: `Synced ${memberTotals.synced} members (${memberTotals.created} created, ${memberTotals.updated} updated, ${memberTotals.skipped} skipped, ${memberTotals.failed} failed)` }
      });
      
    } catch (error) {
      allLogs.push({ type: 'error', entity: 'sync', message: `Sync failed: ${error.message}` });
      setCrmSyncLogs(allLogs);
      setCrmSyncResult(prev => ({ 
        ...prev,
        success: false, 
        error: error.response?.data?.error || error.message 
      }));
    } finally {
      setCrmSyncLoading(false);
    }
  };
  
  const handleDownloadSyncLog = () => {
    if (crmSyncLogs.length === 0) {
      toast.error('No sync logs available to download');
      return;
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `crm-sync-log-${timestamp}.txt`;
    
    // Build human-readable log content
    let content = `CRM Sync Log\n`;
    content += `Generated: ${new Date().toLocaleString()}\n`;
    content += `${'='.repeat(80)}\n\n`;
    
    // Summary section
    const errors = crmSyncLogs.filter(l => l.type === 'error');
    const skipped = crmSyncLogs.filter(l => l.type === 'skipped');
    const created = crmSyncLogs.filter(l => l.action === 'created');
    const updated = crmSyncLogs.filter(l => l.action === 'updated');
    
    content += `SUMMARY\n`;
    content += `${'-'.repeat(40)}\n`;
    content += `Total log entries: ${crmSyncLogs.length}\n`;
    content += `Created: ${created.length}\n`;
    content += `Updated: ${updated.length}\n`;
    content += `Skipped: ${skipped.length}\n`;
    content += `Errors: ${errors.length}\n\n`;
    
    // Errors section (most important, at the top)
    if (errors.length > 0) {
      content += `ERRORS (${errors.length})\n`;
      content += `${'-'.repeat(40)}\n`;
      for (const log of errors) {
        content += `[${log.entity}] ${log.name || log.email || 'Unknown'}\n`;
        content += `  Zoho ID: ${log.zoho_id || 'N/A'}\n`;
        content += `  Error: ${log.message}\n\n`;
      }
    }
    
    // Skipped section
    if (skipped.length > 0) {
      content += `SKIPPED RECORDS (${skipped.length})\n`;
      content += `${'-'.repeat(40)}\n`;
      for (const log of skipped) {
        content += `[${log.entity}] ${log.name || 'Unknown'} (Zoho ID: ${log.zoho_id})\n`;
        content += `  Reason: ${log.reason}\n\n`;
      }
    }
    
    // Full log
    content += `\nFULL LOG\n`;
    content += `${'-'.repeat(40)}\n`;
    for (const log of crmSyncLogs) {
      const prefix = log.type === 'error' ? 'ERROR' : log.type === 'skipped' ? 'SKIP' : log.type === 'success' ? 'OK' : 'INFO';
      const identifier = log.email || log.name || log.zoho_id || '';
      content += `[${prefix}] [${log.entity}] ${log.action || ''} ${identifier} ${log.message || ''}\n`;
    }
    
    // Create and download file
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    toast.success('Sync log downloaded');
  };

  const handleSyncSingleOrganization = async () => {
    setSingleOrgSyncLoading(true);
    setSingleOrgSyncResult(null);
    try {
      const params = {};
      if (selectedOrgId) {
        params.organization_id = selectedOrgId;
      } else if (zohoAccountIdInput.trim()) {
        params.zoho_account_id = zohoAccountIdInput.trim();
      } else {
        setSingleOrgSyncResult({
          success: false,
          error: 'Please select an organisation or enter a Zoho Account ID'
        });
        setSingleOrgSyncLoading(false);
        return;
      }

      const response = await base44.functions.invoke('syncSingleOrganizationFromZoho', params);
      setSingleOrgSyncResult({
        success: true,
        ...response.data
      });
    } catch (error) {
      setSingleOrgSyncResult({ 
        success: false, 
        error: error.response?.data?.error || error.message 
      });
    } finally {
      setSingleOrgSyncLoading(false);
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
              Upload a custom logo to display in the portal navigation. This replaces the default AGCAS Events branding.
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
                    <p className="text-xs text-slate-400">The default AGCAS Events branding will be shown</p>
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

        <Card className="shadow-xl border-slate-200 mb-6">
          <CardHeader>
            <CardTitle>Test Function</CardTitle>
            <CardDescription>
              Test that backend functions are working correctly
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {testResult && (
              <div className={`flex items-start gap-3 p-4 rounded-lg border ${
                testResult.success 
                  ? 'bg-green-50 border-green-200' 
                  : 'bg-red-50 border-red-200'
              }`}>
                {testResult.success ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                    <div className="w-full">
                      <h3 className="font-semibold text-green-900 mb-1">Test Successful</h3>
                      <p className="text-sm text-green-700">{testResult.message}</p>
                      {testResult.backstageDomain && (
                        <p className="text-xs text-green-600 mt-1">Domain: {testResult.backstageDomain}</p>
                      )}
                      {testResult.portalName && (
                        <p className="text-xs text-green-600 mt-1">Portal: {testResult.portalName}</p>
                      )}
                      {testResult.constructedUrl && (
                        <p className="text-xs text-green-600 mt-1 break-all">URL: {testResult.constructedUrl}</p>
                      )}
                      {testResult.accessTokenPrefix && (
                        <p className="text-xs text-green-600 mt-1">Token: {testResult.accessTokenPrefix}</p>
                      )}
                      {testResult.statusCode && (
                        <p className="text-xs text-green-600 mt-1">Status: {testResult.statusCode}</p>
                      )}
                      {testResult.eventCount !== undefined && (
                        <p className="text-xs text-green-600 mt-1">Events: {testResult.eventCount}</p>
                      )}
                      <p className="text-xs text-green-600 mt-1">{testResult.timestamp}</p>
                    </div>
                  </>
                ) : (
                  <>
                    <ExternalLink className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                    <div className="w-full">
                      <h3 className="font-semibold text-red-900 mb-1">Test Failed</h3>
                      <p className="text-sm text-red-700">{testResult.error}</p>
                      {testResult.fullError && (
                        <pre className="text-xs text-red-600 mt-2 overflow-auto max-h-40 bg-red-100 p-2 rounded">
                          {testResult.fullError}
                        </pre>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            <Button
              onClick={handleTestFunction}
              disabled={testLoading}
              className="w-full"
              size="lg"
            >
              {testLoading ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Testing...
                </>
              ) : (
                'Run Test Function'
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="shadow-xl border-slate-200 mb-6">
          <CardHeader>
            <CardTitle>Zoho Authentication</CardTitle>
            <CardDescription>
              Connect your Zoho CRM and Backstage accounts to sync members and events
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {isAuthenticated ? (
              <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
                <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h3 className="font-semibold text-green-900 mb-1">Connected</h3>
                  <p className="text-sm text-green-700">
                    Your Zoho account is connected and ready to sync data.
                  </p>
                  <p className="text-xs text-green-600 mt-2">
                    Token expires: {new Date(tokens[0].expires_at).toLocaleString()}
                  </p>
                  <div className="mt-3 pt-3 border-t border-green-200">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleDisconnectZoho}
                      disabled={disconnecting}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      {disconnecting ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Disconnecting...</>
                      ) : (
                        <><Unlink className="w-4 h-4 mr-2" /> Disconnect Zoho</>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-sm text-amber-800">
                    <strong>⚠️ Authentication Required</strong><br />
                    You need to authenticate with Zoho before members can access the portal.
                  </p>
                </div>

                <div className="space-y-2 text-sm text-slate-600">
                  <p><strong>This will allow the app to:</strong></p>
                  <ul className="list-disc list-inside space-y-1 ml-2">
                    <li>Search and validate member contacts in Zoho CRM</li>
                    <li>Access organisation and account information</li>
                    <li>Sync events from Zoho Backstage</li>
                    <li>Create registrations and manage bookings</li>
                  </ul>
                </div>
              </div>
            )}

            <Button
              onClick={handleAuthenticate}
              disabled={loading}
              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
              size="lg"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Authenticating...
                </>
              ) : isAuthenticated ? (
                <>
                  <ExternalLink className="w-5 h-5 mr-2" />
                  Re-authenticate with Zoho
                </>
              ) : (
                <>
                  <ExternalLink className="w-5 h-5 mr-2" />
                  Authenticate with Zoho
                </>
              )}
            </Button>

            {isAuthenticated && (
              <div className="pt-4 border-t border-slate-200">
                <p className="text-xs text-slate-500 text-center">
                  The app will automatically refresh tokens as needed. Re-authenticate only if you experience issues.
                </p>
              </div>
            )}
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

        {isAuthenticated && (
          <Card className="shadow-xl border-slate-200">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="w-5 h-5" />
                Backstage Event Sync
              </CardTitle>
              <CardDescription>
                Sync events from Zoho Backstage to make them available in the portal
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {syncResult && (
                <div className={`flex items-start gap-3 p-4 rounded-lg border ${
                  syncResult.success 
                    ? 'bg-green-50 border-green-200' 
                    : 'bg-red-50 border-red-200'
                }`}>
                  {syncResult.success ? (
                    <>
                      <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                      <div>
                        <h3 className="font-semibold text-green-900 mb-1">Sync Complete</h3>
                        <p className="text-sm text-green-700">
                          Successfully synced {syncResult.synced} of {syncResult.total} events
                          {syncResult.errors > 0 && ` (${syncResult.errors} errors)`}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h3 className="font-semibold text-red-900 mb-1">Sync Failed</h3>
                        <p className="text-sm text-red-700">{syncResult.error}</p>
                        {syncResult.isOAuthScopeError && (
                          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                            <p className="text-sm text-amber-800 font-medium mb-2">
                              Your Zoho connection needs to be updated with Backstage permissions.
                            </p>
                            <p className="text-xs text-amber-700 mb-3">
                              Please disconnect and re-connect your Zoho account to grant the required Backstage API access.
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleDisconnectZoho}
                              disabled={disconnecting}
                              className="border-amber-400 text-amber-800 hover:bg-amber-100"
                            >
                              {disconnecting ? (
                                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Disconnecting...</>
                              ) : (
                                <><Unlink className="w-4 h-4 mr-2" /> Disconnect & Re-authenticate</>
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              <Button
                onClick={handleSyncEvents}
                disabled={syncLoading}
                className="w-full"
                size="lg"
              >
                {syncLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Syncing Events...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-5 h-5 mr-2" />
                    Sync Events from Backstage
                  </>
                )}
              </Button>

              <p className="text-xs text-slate-500">
                This will fetch all events from Backstage and update the portal. Existing events will be updated with latest information.
              </p>
            </CardContent>
          </Card>
        )}

        {isAuthenticated && (
          <Card className="shadow-xl border-slate-200 mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5" />
                CRM Data Sync
              </CardTitle>
              <CardDescription>
                Sync organisations and members from Zoho CRM. This ensures the app has the latest data from your CRM.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {crmSyncResult && (
                <div className={`flex items-start gap-3 p-4 rounded-lg border ${
                  crmSyncResult.success 
                    ? 'bg-green-50 border-green-200' 
                    : 'bg-red-50 border-red-200'
                }`}>
                  {crmSyncResult.success ? (
                    <>
                      <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                      <div className="w-full">
                        <h3 className="font-semibold text-green-900 mb-2">Sync Complete</h3>
                        <div className="space-y-2 text-sm text-green-700">
                          <div className="flex items-center gap-2">
                            <Building2 className="w-4 h-4" />
                            <span>
                              Organisations: {crmSyncResult.organizations?.synced || 0} processed, 
                              {' '}{crmSyncResult.organizations?.created || 0} created, 
                              {' '}{crmSyncResult.organizations?.updated || 0} updated
                              {crmSyncResult.organizations?.failed > 0 && (
                                <span className="text-red-600 font-medium">, {crmSyncResult.organizations.failed} failed</span>
                              )}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Users className="w-4 h-4" />
                            <span>
                              Members: {crmSyncResult.members?.synced || 0} processed, 
                              {' '}{crmSyncResult.members?.created || 0} created, 
                              {' '}{crmSyncResult.members?.updated || 0} updated,
                              {' '}{crmSyncResult.members?.skipped || 0} skipped
                              {crmSyncResult.members?.failed > 0 && (
                                <span className="text-red-600 font-medium">, {crmSyncResult.members.failed} failed</span>
                              )}
                            </span>
                          </div>
                        </div>
                        {crmSyncLogs.length > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleDownloadSyncLog}
                            className="mt-3"
                            data-testid="button-download-sync-log"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Download Sync Log
                          </Button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <ExternalLink className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                      <div>
                        <h3 className="font-semibold text-red-900 mb-1">Sync Failed</h3>
                        <p className="text-sm text-red-700">{crmSyncResult.error}</p>
                        {crmSyncLogs.length > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleDownloadSyncLog}
                            className="mt-3"
                            data-testid="button-download-sync-log-error"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Download Sync Log
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {crmSyncLoading && crmSyncResult && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                    <span className="font-medium text-blue-900">Sync in progress...</span>
                  </div>
                  <div className="text-sm text-blue-700 space-y-1">
                    {crmSyncResult.organizations && (
                      <div>
                        Organisations: {crmSyncResult.organizations.synced || 0} processed
                        {!crmSyncResult.organizations.complete && ' (fetching more...)'}
                        {crmSyncResult.organizations.complete && ' (complete)'}
                      </div>
                    )}
                    {crmSyncResult.members && (
                      <div>
                        Members: {crmSyncResult.members.synced || 0} processed
                        {!crmSyncResult.members.complete && ' (fetching more...)'}
                        {crmSyncResult.members.complete && ' (complete)'}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <Button
                onClick={handleSyncCrmData}
                disabled={crmSyncLoading}
                className="w-full"
                size="lg"
                data-testid="button-sync-crm"
              >
                {crmSyncLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Syncing CRM Data...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-5 h-5 mr-2" />
                    Sync Organisations & Members from CRM
                  </>
                )}
              </Button>

              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-xs text-blue-800">
                  <strong>Note:</strong> This sync is one-way from Zoho CRM to the app. It will:
                </p>
                <ul className="text-xs text-blue-700 mt-1 list-disc list-inside ml-2">
                  <li>Fetch all organisations (accounts) from Zoho CRM</li>
                  <li>Fetch all contacts and create/update member records</li>
                  <li>Link members to their organisations based on CRM data</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        )}

        {isAuthenticated && (
          <Card className="shadow-xl border-slate-200 mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="w-5 h-5" />
                Test Individual Organisation Sync
              </CardTitle>
              <CardDescription>
                Sync a single organisation from Zoho CRM to test the integration is working correctly.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {singleOrgSyncResult && (
                <div className={`flex items-start gap-3 p-4 rounded-lg border ${
                  singleOrgSyncResult.success 
                    ? 'bg-green-50 border-green-200' 
                    : 'bg-red-50 border-red-200'
                }`}>
                  {singleOrgSyncResult.success ? (
                    <>
                      <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                      <div className="w-full">
                        <h3 className="font-semibold text-green-900 mb-2">
                          Organisation {singleOrgSyncResult.action === 'created' ? 'Created' : 'Updated'}
                        </h3>
                        <div className="space-y-1 text-sm text-green-700">
                          <p><strong>Name:</strong> {singleOrgSyncResult.organization?.name}</p>
                          <p><strong>Zoho ID:</strong> {singleOrgSyncResult.organization?.zoho_account_id}</p>
                          {singleOrgSyncResult.organization?.domain && (
                            <p><strong>Domain:</strong> {singleOrgSyncResult.organization?.domain}</p>
                          )}
                          <p><strong>Training Fund:</strong> £{singleOrgSyncResult.organization?.training_fund_balance || 0}</p>
                          <p><strong>Purchase Orders:</strong> {singleOrgSyncResult.organization?.purchase_order_enabled ? 'Enabled' : 'Disabled'}</p>
                        </div>
                        
                        {singleOrgSyncResult.members && (
                          <div className="mt-3 pt-3 border-t border-green-200">
                            <h4 className="font-semibold text-green-900 mb-1 flex items-center gap-2">
                              <Users className="w-4 h-4" />
                              Members Synced
                            </h4>
                            <div className="space-y-1 text-sm text-green-700">
                              <p>
                                <strong>Found:</strong> {singleOrgSyncResult.members.attempted} contacts in Zoho
                              </p>
                              <p>
                                <strong>Created:</strong> {singleOrgSyncResult.members.created} | 
                                <strong> Updated:</strong> {singleOrgSyncResult.members.updated} | 
                                <strong> Skipped:</strong> {singleOrgSyncResult.members.skipped}
                              </p>
                              {singleOrgSyncResult.members.errors > 0 && (
                                <p className="text-amber-700">
                                  <strong>Errors:</strong> {singleOrgSyncResult.members.errors}
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                        
                        <p className="text-xs text-green-600 mt-2">
                          Last synced: {new Date(singleOrgSyncResult.organization?.last_synced).toLocaleString()}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <ExternalLink className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                      <div>
                        <h3 className="font-semibold text-red-900 mb-1">Sync Failed</h3>
                        <p className="text-sm text-red-700">{singleOrgSyncResult.error}</p>
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="org-select" className="text-sm font-medium">
                    Select an existing organisation:
                  </Label>
                  <div className="space-y-2">
                    <Input
                      placeholder="Search organisations..."
                      value={orgSearchTerm}
                      onChange={(e) => setOrgSearchTerm(e.target.value)}
                      className="w-full"
                      data-testid="input-org-search"
                    />
                    <Select 
                      value={selectedOrgId} 
                      onValueChange={(value) => {
                        setSelectedOrgId(value);
                        setZohoAccountIdInput(""); // Clear manual input when selecting
                      }}
                    >
                      <SelectTrigger data-testid="select-organization">
                        <SelectValue placeholder="Choose an organisation..." />
                      </SelectTrigger>
                      <SelectContent>
                        {filteredOrganizations.length === 0 ? (
                          <div className="p-2 text-sm text-slate-500">
                            {orgSearchTerm ? 'No organisations match your search' : 'No organisations found'}
                          </div>
                        ) : (
                          filteredOrganizations.map(org => (
                            <SelectItem 
                              key={org.id} 
                              value={org.id}
                              data-testid={`select-org-${org.id}`}
                            >
                              <span className="flex items-center gap-2">
                                <span>{org.name}</span>
                                {org.zoho_account_id && (
                                  <span className="text-xs text-slate-400">
                                    (Zoho: {org.zoho_account_id.substring(0, 8)}...)
                                  </span>
                                )}
                              </span>
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="flex-1 border-t border-slate-200"></div>
                  <span className="text-xs text-slate-500 uppercase">or</span>
                  <div className="flex-1 border-t border-slate-200"></div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="zoho-id-input" className="text-sm font-medium">
                    Enter Zoho Account ID directly:
                  </Label>
                  <Input
                    id="zoho-id-input"
                    placeholder="e.g., 3652397000012345678"
                    value={zohoAccountIdInput}
                    onChange={(e) => {
                      setZohoAccountIdInput(e.target.value);
                      setSelectedOrgId(""); // Clear selection when typing
                    }}
                    data-testid="input-zoho-account-id"
                  />
                  <p className="text-xs text-slate-500">
                    Use this to sync an organisation that doesn't exist in the app yet
                  </p>
                </div>
              </div>

              <Button
                onClick={handleSyncSingleOrganization}
                disabled={singleOrgSyncLoading || (!selectedOrgId && !zohoAccountIdInput.trim())}
                className="w-full"
                size="lg"
                data-testid="button-sync-single-org"
              >
                {singleOrgSyncLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Syncing Organisation...
                  </>
                ) : (
                  <>
                    <Search className="w-5 h-5 mr-2" />
                    Sync Selected Organisation
                  </>
                )}
              </Button>

              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-xs text-amber-800">
                  <strong>Testing tip:</strong> Use this to verify CRM sync is working before running a full sync. 
                  This will sync both the organisation data AND all members (contacts) belonging to that organisation from Zoho CRM.
                </p>
              </div>
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
