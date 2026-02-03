import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Search, Download, FileText, Building2, Calendar, AlertCircle, Check, ExternalLink, Ticket, GraduationCap, RefreshCw } from "lucide-react";
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
  const [isSyncing, setIsSyncing] = useState(false);

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

  const pendingPORecords = reportData?.records || [];
  const organizations = reportData?.organizations || {};

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pending-purchase-orders-report'] });
      toast({
        title: "Success",
        description: "Purchase order number has been saved.",
      });
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
  }, [pendingPORecords, organizations, searchQuery, selectedSource, sortBy]);

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

  const handleSyncWithXero = async () => {
    if (isSyncing) return;
    
    const recordsWithInvoiceId = filteredAndSortedData.filter(r => r.xero_invoice_id);
    
    if (recordsWithInvoiceId.length === 0) {
      toast({
        title: "No Records",
        description: "No records with Xero invoice IDs to sync.",
      });
      return;
    }

    setIsSyncing(true);
    toast({
      title: "Syncing with Xero...",
      description: `Checking ${recordsWithInvoiceId.length} invoices for PO numbers...`,
    });

    let foundCount = 0;
    try {
      for (const record of recordsWithInvoiceId) {
        try {
          const response = await fetch('/api/pending-purchase-orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              action: 'verify',
              entityType: record.entityType,
              entityId: record.id,
              xeroInvoiceId: record.xero_invoice_id,
            }),
          });

          const result = await response.json();
          if (result.found && result.updated) {
            foundCount++;
          }
        } catch (error) {
          console.error('Sync error for record:', record.id, error);
        }
      }

      queryClient.invalidateQueries({ queryKey: ['pending-purchase-orders-report'] });
      
      toast({
        title: "Sync Complete",
        description: foundCount > 0 
          ? `Found and updated ${foundCount} PO number${foundCount !== 1 ? 's' : ''} from Xero.`
          : "No new PO numbers found in Xero (TBC references are ignored).",
      });
    } finally {
      setIsSyncing(false);
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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" data-testid="loading-spinner"></div>
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
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleSyncWithXero}
            variant="outline"
            className="flex items-center gap-2"
            disabled={filteredAndSortedData.length === 0 || isSyncing}
            data-testid="button-sync-xero"
          >
            <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Syncing...' : 'Sync with Xero'}
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

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
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
          </div>

          {filteredAndSortedData.length === 0 ? (
            <div className="text-center py-12">
              <Check className="h-12 w-12 text-green-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium" data-testid="text-no-pending">All Caught Up!</h3>
              <p className="text-muted-foreground">No invoices are waiting for purchase orders.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredAndSortedData.map((record) => {
                const orgName = organizations[record.organization_id] || 'Unknown Organisation';
                const TypeIcon = record.source_type === 'Event' ? Ticket : GraduationCap;
                const recordKey = `${record.entityType}-${record.id}`;
                return (
                  <div
                    key={recordKey}
                    className="border rounded-lg p-4 hover-elevate"
                    data-testid={`card-record-${recordKey}`}
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
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
                          {record.quantity && (
                            <span data-testid={`text-quantity-${record.id}`}>
                              Qty: {record.quantity}
                            </span>
                          )}
                          {record.total_cost > 0 && (
                            <span className="font-medium" data-testid={`text-cost-${record.id}`}>
                              £{record.total_cost.toLocaleString()}
                            </span>
                          )}
                        </div>
                        {record.member_email && (
                          <div className="text-sm text-muted-foreground" data-testid={`text-email-${record.id}`}>
                            Booked by: {record.member_email}
                          </div>
                        )}
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
    </div>
  );
}
