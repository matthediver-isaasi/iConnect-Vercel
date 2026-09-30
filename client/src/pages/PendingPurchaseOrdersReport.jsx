import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Search, Download, FileText, Building2, Calendar, AlertCircle, Check, ExternalLink, Ticket, GraduationCap, RefreshCw, Settings, ChevronLeft, ChevronRight, Mail, ChevronDown, Send, Info, Copy, X, Bell } from "lucide-react";
// Note: email template picker removed; reminders use a hardwired in-code template.
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useToast } from "@/components/ui/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";

const HIDE_PAID_STORAGE_KEY = 'pendingPOReport.hidePaidInvoices';

const DAYS_OF_WEEK = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const ITEMS_PER_PAGE = 20;
const BULK_SEND_CONCURRENCY = 4;

export default function PendingPurchaseOrdersReport() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSource, setSelectedSource] = useState("all");
  const [sortBy, setSortBy] = useState("date_desc");
  const [editingRecord, setEditingRecord] = useState(null);
  const [poNumber, setPoNumber] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedDays, setSelectedDays] = useState([]);
  const [sendAfterDays, setSendAfterDays] = useState(7);
  const [repeatEveryDays, setRepeatEveryDays] = useState(7);
  const [maxSends, setMaxSends] = useState(3);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sendingReminderId, setSendingReminderId] = useState(null);
  const [reminderPreview, setReminderPreview] = useState(null);
  const [previewLoadingKey, setPreviewLoadingKey] = useState(null);
  const [confirmSending, setConfirmSending] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [failedKeys, setFailedKeys] = useState(() => new Set());
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  const [hidePaidInvoices, setHidePaidInvoices] = useState(() => {
    if (typeof window === 'undefined') return true;
    try {
      const stored = window.localStorage.getItem(HIDE_PAID_STORAGE_KEY);
      if (stored === null) return true;
      return stored === 'true';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(HIDE_PAID_STORAGE_KEY, String(hidePaidInvoices));
    } catch {
      // ignore storage errors (e.g. private mode)
    }
  }, [hidePaidInvoices]);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_PendingPurchaseOrdersReport')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: reportData, isLoading, error, refetch } = useQuery({
    queryKey: ['pending-purchase-orders-report'],
    queryFn: async () => {
      const response = await fetch('/api/pending-purchase-orders', {
        credentials: 'include',
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch report data');
      }
      return response.json();
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: reminderSettings } = useQuery({
    queryKey: ['pending-purchase-orders-settings'],
    queryFn: async () => {
      const response = await fetch('/api/pending-purchase-orders?action=get_settings', {
        credentials: 'include',
      });
      if (!response.ok) {
        return { reminderDays: [] };
      }
      return response.json();
    },
    staleTime: 0,
  });

  useEffect(() => {
    if (reminderSettings) {
      setSelectedDays(reminderSettings.reminderDays || []);
      setSendAfterDays(reminderSettings.sendAfterDays ?? 7);
      setRepeatEveryDays(reminderSettings.repeatEveryDays ?? 7);
      setMaxSends(reminderSettings.maxSends ?? 3);
    }
  }, [reminderSettings]);

  const pendingPORecords = reportData?.records || [];
  const organizations = reportData?.organizations || {};
  const xeroCheckPerformed = reportData?.xeroCheckPerformed || false;
  const xeroError = reportData?.xeroError || null;
  const paidInXero = reportData?.paidInXero || 0;

  const updateTransactionMutation = useMutation({
    mutationFn: async ({ id, entityType, purchase_order_number }) => {
      const response = await fetch('/api/pending-purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'update_po',
          entityType,
          entityId: id,
          purchaseOrderNumber: purchase_order_number,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Failed to update');
      }
      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['pending-purchase-orders-report'] });
      if (result?.xeroUpdated === false && result?.xeroError) {
        toast({
          title: "Saved locally — Xero not updated",
          description: `The PO number was saved, but the Xero invoice could not be updated: ${result.xeroError}`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Success",
          description: "Purchase order number has been saved.",
        });
      }
      setEditingRecord(null);
      setPoNumber("");
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save purchase order number.",
        variant: "destructive",
      });
    },
  });

  const sourceTypes = useMemo(() => {
    const types = [...new Set(pendingPORecords.map(r => r.source_type))];
    return types.sort();
  }, [pendingPORecords]);

  const filteredAndSortedData = useMemo(() => {
    let filtered = [...pendingPORecords];

    if (hidePaidInvoices && xeroCheckPerformed) {
      filtered = filtered.filter(r => r.xero_status !== 'PAID');
    }

    if (selectedSource !== 'all') {
      filtered = filtered.filter(r => r.source_type === selectedSource);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(r => {
        const orgName = organizations[r.organization_id] || '';
        return (
          orgName.toLowerCase().includes(query) ||
          (r.xero_invoice_number || '').toLowerCase().includes(query) ||
          (r.source_name || '').toLowerCase().includes(query) ||
          (r.member_email || '').toLowerCase().includes(query)
        );
      });
    }

    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'date_desc':
          return new Date(b.created_date || 0) - new Date(a.created_date || 0);
        case 'date_asc':
          return new Date(a.created_date || 0) - new Date(b.created_date || 0);
        case 'org_asc': {
          const orgA = organizations[a.organization_id] || '';
          const orgB = organizations[b.organization_id] || '';
          return orgA.localeCompare(orgB);
        }
        case 'org_desc': {
          const orgA = organizations[a.organization_id] || '';
          const orgB = organizations[b.organization_id] || '';
          return orgB.localeCompare(orgA);
        }
        case 'invoice_asc':
          return (a.xero_invoice_number || '').localeCompare(b.xero_invoice_number || '');
        case 'invoice_desc':
          return (b.xero_invoice_number || '').localeCompare(a.xero_invoice_number || '');
        default:
          return 0;
      }
    });

    return filtered;
  }, [pendingPORecords, organizations, searchQuery, selectedSource, sortBy, hidePaidInvoices, xeroCheckPerformed]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedSource, sortBy, hidePaidInvoices, xeroCheckPerformed]);

  // Reset selection when filter set changes meaningfully
  useEffect(() => {
    setSelectedKeys(new Set());
    setFailedKeys(new Set());
  }, [searchQuery, selectedSource, hidePaidInvoices, xeroCheckPerformed]);

  const getRecordKey = (record) =>
    record.entityType === 'invoice' ? record.id : `${record.entityType}-${record.id}`;

  const filteredKeys = useMemo(
    () => filteredAndSortedData.map(getRecordKey),
    [filteredAndSortedData]
  );

  const selectedFilteredCount = useMemo(
    () => filteredKeys.reduce((acc, k) => acc + (selectedKeys.has(k) ? 1 : 0), 0),
    [filteredKeys, selectedKeys]
  );

  const allFilteredSelected =
    filteredKeys.length > 0 && selectedFilteredCount === filteredKeys.length;
  const someFilteredSelected =
    selectedFilteredCount > 0 && selectedFilteredCount < filteredKeys.length;

  const isSelected = (record) => selectedKeys.has(getRecordKey(record));

  const toggleOne = (record) => {
    const key = getRecordKey(record);
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setFailedKeys(prev => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    if (allFilteredSelected) {
      // Deselect every filtered key (preserve any keys outside the current filter, which shouldn't exist normally)
      setSelectedKeys(prev => {
        const next = new Set(prev);
        for (const k of filteredKeys) next.delete(k);
        return next;
      });
    } else {
      setSelectedKeys(prev => {
        const next = new Set(prev);
        for (const k of filteredKeys) next.add(k);
        return next;
      });
    }
  };

  const clearSelection = () => {
    setSelectedKeys(new Set());
    setFailedKeys(new Set());
  };

  const totalPages = Math.ceil(filteredAndSortedData.length / ITEMS_PER_PAGE);
  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredAndSortedData.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [filteredAndSortedData, currentPage]);

  const handleExportCSV = () => {
    const headers = ['Organisation', 'Type', 'Event/Program', 'Invoice Number', 'Invoice Date', 'Quantity', 'Total Cost', 'Member Email'];
    const rows = filteredAndSortedData.map(r => {
      return [
        organizations[r.organization_id] || 'Unknown',
        r.source_type,
        r.source_name || '',
        r.xero_invoice_number || '',
        r.created_date ? format(new Date(r.created_date), 'yyyy-MM-dd') : '',
        r.quantity || 0,
        r.total_cost || 0,
        r.member_email || ''
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `pending-purchase-orders-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    link.click();
  };

  const handleRefresh = async () => {
    if (isRefreshing) return;
    
    setIsRefreshing(true);
    try {
      await refetch();
      toast({
        title: "Refreshed",
        description: "Report data has been updated with latest Xero invoice status.",
      });
    } catch (error) {
      toast({
        title: "Refresh Failed",
        description: error.message || "Failed to refresh report data.",
        variant: "destructive",
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleDownloadInvoice = async (transaction) => {
    if (!transaction.xero_invoice_pdf_uri) {
      toast({
        title: "No Invoice PDF",
        description: "No invoice PDF is available for this transaction.",
        variant: "destructive",
      });
      return;
    }

    try {
      const response = await base44.integrations.Core.CreateFileSignedUrl({
        file_uri: transaction.xero_invoice_pdf_uri,
        expires_in: 300
      });
      
      if (response?.signed_url) {
        window.open(response.signed_url, '_blank');
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to download invoice PDF.",
        variant: "destructive",
      });
    }
  };

  const handleAddPO = (record) => {
    setEditingRecord(record);
    setPoNumber("");
  };

  const toggleDay = (dayValue) => {
    setSelectedDays(prev => 
      prev.includes(dayValue) 
        ? prev.filter(d => d !== dayValue)
        : [...prev, dayValue].sort((a, b) => a - b)
    );
  };

  const handleSaveSettings = async () => {
    setIsSavingSettings(true);
    try {
      const response = await fetch('/api/pending-purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'save_settings',
          reminderDays: selectedDays,
          sendAfterDays,
          repeatEveryDays,
          maxSends,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save settings');
      }

      queryClient.invalidateQueries({ queryKey: ['pending-purchase-orders-settings'] });
      toast({
        title: "Settings Saved",
        description: "Your reminder settings have been saved.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error.message || "Failed to save settings.",
        variant: "destructive",
      });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const sendReminderRequest = async (record) => {
    const response = await fetch('/api/pending-purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        action: 'send_reminder',
        recordId: record.id,
        entityType: record.entityType,
      }),
    });

    if (!response.ok) {
      let errorMessage = 'Failed to send reminder';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }
  };

  const handleSendReminder = async (record) => {
    const recordKey = getRecordKey(record);
    setPreviewLoadingKey(recordKey);

    try {
      const response = await fetch('/api/pending-purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'preview_reminder',
          recordId: record.id,
          entityType: record.entityType,
        }),
      });

      if (!response.ok) {
        let errorMessage = 'Failed to load reminder preview';
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          // ignore JSON parse errors
        }
        throw new Error(errorMessage);
      }

      const preview = await response.json();
      const orgName = organizations[record.organization_id] || 'the organisation';
      setReminderPreview({
        record,
        recordKey,
        orgName,
        recipientEmail: preview.recipientEmail,
        subject: preview.subject,
        html: preview.html,
        submitUrl: preview.submitUrl,
        token: preview.token,
        expiresAt: preview.expiresAt,
      });
    } catch (error) {
      toast({
        title: "Cannot send reminder",
        description: error.message || "Failed to load reminder preview.",
        variant: "destructive",
      });
    } finally {
      setPreviewLoadingKey(null);
    }
  };

  const handleCopySubmitLink = async () => {
    if (!reminderPreview?.submitUrl) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(reminderPreview.submitUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = reminderPreview.submitUrl;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'absolute';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      toast({
        title: "Link copied",
        description: "The submit-PO link has been copied to your clipboard.",
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description: error.message || "Could not copy link to clipboard.",
        variant: "destructive",
      });
    }
  };

  const handleConfirmSendReminder = async () => {
    if (!reminderPreview?.token) return;
    setConfirmSending(true);
    try {
      const response = await fetch('/api/pending-purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'send_reminder',
          token: reminderPreview.token,
        }),
      });

      if (!response.ok) {
        let errorMessage = 'Failed to send reminder';
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          // ignore JSON parse errors
        }
        throw new Error(errorMessage);
      }

      toast({
        title: "Reminder Sent",
        description: `PO reminder email sent to ${reminderPreview.orgName}.`,
      });
      setReminderPreview(null);
    } catch (error) {
      toast({
        title: "Error",
        description: error.message || "Failed to send reminder email.",
        variant: "destructive",
      });
    } finally {
      setConfirmSending(false);
    }
  };

  const handleBulkSendReminders = async () => {
    if (selectedKeys.size === 0) return;

    const selectedRecords = filteredAndSortedData.filter(r => selectedKeys.has(getRecordKey(r)));
    if (selectedRecords.length === 0) return;

    setBulkSending(true);
    setFailedKeys(new Set());
    setBulkProgress({ done: 0, total: selectedRecords.length });

    let successCount = 0;
    const newFailedKeys = new Set();
    let cursor = 0;

    const worker = async () => {
      while (cursor < selectedRecords.length) {
        const idx = cursor++;
        const record = selectedRecords[idx];
        try {
          await sendReminderRequest(record);
          successCount++;
        } catch (err) {
          newFailedKeys.add(getRecordKey(record));
        } finally {
          setBulkProgress(prev => ({ done: prev.done + 1, total: prev.total }));
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(BULK_SEND_CONCURRENCY, selectedRecords.length) },
      () => worker()
    );
    await Promise.all(workers);

    const failureCount = newFailedKeys.size;

    if (failureCount === 0) {
      toast({
        title: "Reminders Sent",
        description: `Successfully sent ${successCount} reminder${successCount !== 1 ? 's' : ''}.`,
      });
      setSelectedKeys(new Set());
      setFailedKeys(new Set());
    } else {
      toast({
        title: "Reminders Sent with Errors",
        description: `${successCount} sent, ${failureCount} failed. Failed rows remain selected — you can retry them.`,
        variant: "destructive",
      });
      // Keep only failed rows selected for retry
      setSelectedKeys(new Set(newFailedKeys));
      setFailedKeys(newFailedKeys);
    }

    setBulkSending(false);
    setBulkProgress({ done: 0, total: 0 });
  };

  const handleSavePO = () => {
    if (!poNumber.trim()) {
      toast({
        title: "Error",
        description: "Please enter a purchase order number.",
        variant: "destructive",
      });
      return;
    }

    updateTransactionMutation.mutate({
      id: editingRecord.id,
      entityType: editingRecord.entityType,
      purchase_order_number: poNumber.trim()
    });
  };

  if (!accessChecked && isAccessReady) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4" data-testid="loading-container">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary mx-auto" data-testid="loading-spinner"></div>
          <div className="space-y-2">
            <p className="font-medium text-lg">Loading Pending Purchase Orders</p>
            <p className="text-muted-foreground text-sm">Checking invoice status with Xero...</p>
            <p className="text-muted-foreground text-xs">Invoices already paid in Xero are flagged</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="py-12 text-center">
            <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h3 className="text-lg font-medium" data-testid="text-error-title">Failed to Load Report</h3>
            <p className="text-muted-foreground mt-2" data-testid="text-error-message">
              {error.message || 'An error occurred while fetching the report data.'}
            </p>
            <Button onClick={() => refetch()} className="mt-4" data-testid="button-retry">
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <FileText className="h-6 w-6" />
            Pending Purchase Orders
          </h1>
          <p className="text-muted-foreground mt-1" data-testid="text-page-description">
            Invoices awaiting purchase order numbers
          </p>
          {xeroCheckPerformed && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge variant="outline" className="text-xs" data-testid="badge-xero-status">
                <Check className="h-3 w-3 mr-1" />
                Xero synced
              </Badge>
              {paidInXero > 0 && (
                <Badge variant="secondary" className="text-xs" data-testid="badge-paid-in-xero">
                  {paidInXero} paid in Xero
                </Badge>
              )}
            </div>
          )}
          {xeroError && (
            <div className="flex items-center gap-2 mt-2">
              <Badge variant="destructive" className="text-xs" data-testid="badge-xero-error">
                <AlertCircle className="h-3 w-3 mr-1" />
                Xero check failed
              </Badge>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={handleRefresh}
            variant="outline"
            className="flex items-center gap-2"
            disabled={isRefreshing}
            data-testid="button-refresh"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
          <Button
            onClick={handleExportCSV}
            variant="outline"
            className="flex items-center gap-2"
            disabled={filteredAndSortedData.length === 0}
            data-testid="button-export-csv"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Card data-testid="card-reminder-settings">
          <CollapsibleTrigger asChild>
            <CardHeader className="pb-4 cursor-pointer hover-elevate">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Settings className="h-5 w-5 text-muted-foreground" />
                  <CardTitle>Reminder Settings</CardTitle>
                </div>
                <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${settingsOpen ? 'rotate-180' : ''}`} />
              </div>
              <CardDescription>
                Configure automated email reminders for pending purchase orders
              </CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Send reminders on</Label>
                <div className="flex flex-wrap gap-2">
                  {DAYS_OF_WEEK.map(day => (
                    <Button
                      key={day.value}
                      type="button"
                      variant={selectedDays.includes(day.value) ? "default" : "outline"}
                      size="sm"
                      onClick={() => toggleDay(day.value)}
                      data-testid={`button-day-${day.label.toLowerCase()}`}
                    >
                      {day.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="input-send-after-days">Send first reminder after (days)</Label>
                  <Input
                    id="input-send-after-days"
                    type="number"
                    min={1}
                    value={sendAfterDays}
                    onChange={(e) => setSendAfterDays(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    data-testid="input-send-after-days"
                  />
                  <p className="text-xs text-muted-foreground">
                    Wait this many days after the invoice is raised before the first chase.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="input-repeat-every-days">Repeat every (days)</Label>
                  <Input
                    id="input-repeat-every-days"
                    type="number"
                    min={1}
                    value={repeatEveryDays}
                    onChange={(e) => setRepeatEveryDays(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    data-testid="input-repeat-every-days"
                  />
                  <p className="text-xs text-muted-foreground">
                    Minimum gap between chases for the same invoice.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="input-max-sends">Maximum reminders</Label>
                  <Input
                    id="input-max-sends"
                    type="number"
                    min={1}
                    value={maxSends}
                    onChange={(e) => setMaxSends(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    data-testid="input-max-sends"
                  />
                  <p className="text-xs text-muted-foreground">
                    Stop chasing an invoice after this many reminders.
                  </p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground" data-testid="text-reminder-template-info">
                Reminder emails use a built-in template that includes the invoice details and
                a secure link for the recipient to submit their purchase order number.
              </p>
              <Button
                onClick={handleSaveSettings}
                disabled={isSavingSettings}
                className="flex items-center gap-2"
                data-testid="button-save-settings"
              >
                {isSavingSettings ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                {isSavingSettings ? 'Saving...' : 'Save Reminder Settings'}
              </Button>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-warning" />
              <span data-testid="text-pending-count">{filteredAndSortedData.length} Invoice{filteredAndSortedData.length !== 1 ? 's' : ''} Pending PO</span>
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 md:flex-row md:items-center mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by organisation, invoice number, or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
                data-testid="input-search"
              />
            </div>
            <Select value={selectedSource} onValueChange={setSelectedSource}>
              <SelectTrigger className="w-[200px]" data-testid="select-source">
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {sourceTypes.map(type => (
                  <SelectItem key={type} value={type}>{type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-[180px]" data-testid="select-sort">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date_desc">Newest First</SelectItem>
                <SelectItem value="date_asc">Oldest First</SelectItem>
                <SelectItem value="org_asc">Organisation A-Z</SelectItem>
                <SelectItem value="org_desc">Organisation Z-A</SelectItem>
                <SelectItem value="invoice_asc">Invoice # A-Z</SelectItem>
                <SelectItem value="invoice_desc">Invoice # Z-A</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Switch
                id="hide-paid-invoices"
                checked={hidePaidInvoices && xeroCheckPerformed}
                onCheckedChange={setHidePaidInvoices}
                disabled={!xeroCheckPerformed}
                data-testid="switch-hide-paid"
              />
              <Label htmlFor="hide-paid-invoices" className="text-sm whitespace-nowrap cursor-pointer">
                Hide paid invoices
              </Label>
            </div>
          </div>

          {filteredAndSortedData.length === 0 ? (
            <div className="text-center py-12">
              <Check className="h-12 w-12 text-green-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium" data-testid="text-no-pending">All Caught Up!</h3>
              <p className="text-muted-foreground">No invoices are waiting for purchase orders.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4 p-3 border rounded-md bg-muted/30">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="select-all-filtered"
                      checked={
                        allFilteredSelected
                          ? true
                          : someFilteredSelected
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={toggleAllFiltered}
                      disabled={bulkSending || filteredKeys.length === 0}
                      data-testid="checkbox-select-all-filtered"
                    />
                    <Label
                      htmlFor="select-all-filtered"
                      className="text-sm cursor-pointer whitespace-nowrap"
                    >
                      Select all (all pages)
                    </Label>
                  </div>
                  <span
                    className="text-sm text-muted-foreground"
                    data-testid="text-selection-count"
                  >
                    {selectedFilteredCount} of {filteredKeys.length} selected
                  </span>
                  {selectedFilteredCount > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearSelection}
                      disabled={bulkSending}
                      data-testid="button-clear-selection"
                    >
                      Clear selection
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  {bulkSending && (
                    <span
                      className="text-sm text-muted-foreground"
                      data-testid="text-bulk-progress"
                    >
                      Sending {bulkProgress.done} of {bulkProgress.total}…
                    </span>
                  )}
                  <Button
                    type="button"
                    onClick={handleBulkSendReminders}
                    disabled={selectedFilteredCount === 0 || bulkSending}
                    data-testid="button-bulk-send-reminders"
                  >
                    {bulkSending ? (
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4 mr-2" />
                    )}
                    {bulkSending
                      ? 'Sending...'
                      : `Send Reminders to Selected${selectedFilteredCount > 0 ? ` (${selectedFilteredCount})` : ''}`}
                  </Button>
                </div>
              </div>
              <p
                className="text-xs text-muted-foreground mb-3 flex items-center gap-1"
                data-testid="text-recipient-helper"
              >
                <Info className="h-3 w-3" />
                Reminders are sent to the organisation's primary contact. If no
                primary contact is set, the booker receives the reminder instead.
              </p>
            <div className="space-y-3">
              {paginatedData.map((record) => {
                const orgName = organizations[record.organization_id] || 'Unknown Organisation';
                const TypeIcon = record.source_type === 'Event'
                  ? Ticket
                  : record.source_type === 'Mixed'
                    ? FileText
                    : GraduationCap;
                const recordKey = getRecordKey(record);
                const rowSelected = isSelected(record);
                const rowFailed = failedKeys.has(recordKey);
                const attendees = Array.isArray(record.attendees) ? record.attendees : [];
                const attendeeCount = attendees.length || 1;
                const isMultiAttendee = attendeeCount > 1;
                return (
                  <div
                    key={recordKey}
                    className={`border rounded-lg p-4 hover-elevate ${rowFailed ? 'border-destructive' : ''}`}
                    data-testid={`card-record-${recordKey}`}
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div className="flex items-start gap-3 flex-1">
                        <Checkbox
                          checked={rowSelected}
                          onCheckedChange={() => toggleOne(record)}
                          disabled={bulkSending}
                          aria-label={`Select ${orgName}`}
                          data-testid={`checkbox-po-${record.entityType}-${record.id}`}
                          className="mt-1"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium" data-testid={`text-org-name-${record.id}`}>
                            {orgName}
                          </span>
                          <Badge variant="secondary" className="flex items-center gap-1" data-testid={`badge-source-${record.id}`}>
                            <TypeIcon className="h-3 w-3" />
                            {record.source_name}
                          </Badge>
                          <Badge variant="outline" data-testid={`badge-type-${record.id}`}>
                            {record.source_type}
                          </Badge>
                          {record.xero_status === 'PAID' && (
                            <Badge variant="secondary" data-testid={`badge-paid-in-xero-${record.id}`}>
                              Paid in Xero
                            </Badge>
                          )}
                          <Badge variant="outline" className="flex items-center gap-1" data-testid={`badge-reminders-sent-${record.id}`}>
                            <Bell className="h-3 w-3" />
                            {(record.remindersSent || 0) > 0
                              ? `${record.remindersSent} reminder${record.remindersSent !== 1 ? 's' : ''} sent`
                              : 'No reminders sent yet'}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                          <span className="flex items-center gap-1">
                            <FileText className="h-3 w-3" />
                            <span data-testid={`text-invoice-${record.id}`}>
                              Invoice: {record.xero_invoice_number || 'N/A'}
                            </span>
                          </span>
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            <span data-testid={`text-date-${record.id}`}>
                              {record.created_date 
                                ? format(new Date(record.created_date), 'dd MMM yyyy')
                                : 'Unknown date'}
                            </span>
                          </span>
                          <span className="flex items-center gap-1" data-testid={`text-next-reminder-${record.id}`}>
                            <Bell className="h-3 w-3" />
                            {record.nextReminderStatus === 'no_days'
                              ? 'Automatic reminders off'
                              : record.nextReminderStatus === 'max_reached'
                                ? 'All reminders sent'
                                : record.nextReminderAt
                                  ? `Next reminder: ${format(new Date(record.nextReminderAt), 'dd MMM yyyy')}`
                                  : 'Next reminder: pending'}
                          </span>
                          {record.quantity ? (
                            <span data-testid={`text-quantity-${record.id}`}>
                              Qty: {record.quantity}
                            </span>
                          ) : null}
                          {record.total_cost > 0 && (
                            <span className="font-medium" data-testid={`text-cost-${record.id}`}>
                              £{record.total_cost.toLocaleString()}
                            </span>
                          )}
                          {isMultiAttendee && (
                            <Badge variant="outline" data-testid={`badge-bookings-count-${record.id}`}>
                              {attendeeCount} bookings
                            </Badge>
                          )}
                        </div>
                        {isMultiAttendee ? (
                          <Collapsible>
                            <CollapsibleTrigger asChild>
                              <button
                                type="button"
                                className="text-sm text-muted-foreground inline-flex items-center gap-1 hover:underline"
                                data-testid={`button-toggle-attendees-${record.id}`}
                              >
                                <ChevronDown className="h-3 w-3" />
                                Show {attendeeCount} attendees
                              </button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <ul className="mt-2 space-y-1 text-sm text-muted-foreground border-l pl-3">
                                {attendees.map((a, idx) => (
                                  <li
                                    key={`${a.entityType}-${a.id}-${idx}`}
                                    data-testid={`text-attendee-${record.id}-${idx}`}
                                  >
                                    {a.email || 'Unknown'}
                                    {a.source_name ? ` — ${a.source_name}` : ''}
                                  </li>
                                ))}
                              </ul>
                            </CollapsibleContent>
                          </Collapsible>
                        ) : (
                          record.member_email && (
                            <div className="text-sm text-muted-foreground" data-testid={`text-email-${record.id}`}>
                              Booked by: {record.member_email}
                            </div>
                          )
                        )}
                        {rowFailed && (
                          <div
                            className="text-xs text-destructive flex items-center gap-1"
                            data-testid={`text-bulk-error-${record.id}`}
                          >
                            <AlertCircle className="h-3 w-3" />
                            Last bulk send failed — try again.
                          </div>
                        )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {record.xero_invoice_pdf_uri && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDownloadInvoice(record)}
                            data-testid={`button-download-invoice-${record.id}`}
                          >
                            <ExternalLink className="h-4 w-4 mr-1" />
                            View Invoice
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleSendReminder(record)}
                          disabled={previewLoadingKey === recordKey || sendingReminderId === recordKey}
                          data-testid={`button-send-reminder-${record.id}`}
                        >
                          {previewLoadingKey === recordKey ? (
                            <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <Send className="h-4 w-4 mr-1" />
                          )}
                          {previewLoadingKey === recordKey ? 'Loading...' : 'Send Reminder'}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleAddPO(record)}
                          data-testid={`button-add-po-${record.id}`}
                        >
                          Add PO Number
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            </>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-6 border-t mt-6" data-testid="pagination-controls">
              <p className="text-sm text-muted-foreground">
                Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1} to {Math.min(currentPage * ITEMS_PER_PAGE, filteredAndSortedData.length)} of {filteredAndSortedData.length} records
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <span className="text-sm px-2">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  data-testid="button-next-page"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editingRecord} onOpenChange={() => setEditingRecord(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Purchase Order Number</DialogTitle>
          </DialogHeader>
          {editingRecord && (
            <div className="space-y-4 py-4">
              <div className="text-sm text-muted-foreground">
                <p><strong>Organisation:</strong> {organizations[editingRecord.organization_id] || 'Unknown'}</p>
                <p><strong>Invoice:</strong> {editingRecord.xero_invoice_number}</p>
                <p><strong>{editingRecord.source_type}:</strong> {editingRecord.source_name}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="po-number">Purchase Order Number</Label>
                <Input
                  id="po-number"
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  placeholder="Enter PO number..."
                  data-testid="input-po-number"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingRecord(null)} data-testid="button-cancel-po">
              Cancel
            </Button>
            <Button 
              onClick={handleSavePO} 
              disabled={updateTransactionMutation.isPending}
              data-testid="button-save-po"
            >
              {updateTransactionMutation.isPending ? 'Saving...' : 'Save PO Number'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!reminderPreview}
        onOpenChange={(open) => {
          if (!open && !confirmSending) setReminderPreview(null);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-reminder-preview">
          <DialogHeader>
            <DialogTitle>Send PO Reminder</DialogTitle>
          </DialogHeader>
          {reminderPreview && (
            <div className="space-y-4 py-2">
              <div className="space-y-1 text-sm">
                <div className="flex flex-wrap gap-x-2">
                  <span className="text-muted-foreground">To:</span>
                  <span className="font-medium" data-testid="text-preview-recipient">
                    {reminderPreview.recipientEmail}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <span className="text-muted-foreground">Organisation:</span>
                  <span className="font-medium" data-testid="text-preview-org">
                    {reminderPreview.orgName}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <span className="text-muted-foreground">Subject:</span>
                  <span className="font-medium" data-testid="text-preview-subject">
                    {reminderPreview.subject}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Email preview</Label>
                <div
                  className="border rounded-md bg-white p-3 max-h-80 overflow-y-auto"
                  data-testid="container-preview-html"
                >
                  <iframe
                    title="Reminder email preview"
                    srcDoc={reminderPreview.html}
                    sandbox=""
                    className="w-full h-72 border-0"
                    data-testid="iframe-preview-html"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="submit-po-link">Submit PO link</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="submit-po-link"
                    readOnly
                    value={reminderPreview.submitUrl}
                    onFocus={(e) => e.target.select()}
                    data-testid="input-preview-submit-url"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCopySubmitLink}
                    data-testid="button-copy-submit-url"
                  >
                    <Copy className="h-4 w-4 mr-1" />
                    Copy Link
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Copy this link if you'd like to compose your own email instead of sending the
                  preview above.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReminderPreview(null)}
              disabled={confirmSending}
              data-testid="button-cancel-reminder"
            >
              <X className="h-4 w-4 mr-1" />
              Cancel
            </Button>
            <Button
              onClick={handleConfirmSendReminder}
              disabled={confirmSending}
              data-testid="button-confirm-send-reminder"
            >
              {confirmSending ? (
                <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              {confirmSending ? 'Sending...' : 'Send Email'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
