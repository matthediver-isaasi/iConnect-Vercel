import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Search, Download, FileText, Building2, Calendar, AlertCircle, Check, ExternalLink } from "lucide-react";
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
  const [selectedProgram, setSelectedProgram] = useState("all");
  const [sortBy, setSortBy] = useState("date_desc");
  const [editingTransaction, setEditingTransaction] = useState(null);
  const [poNumber, setPoNumber] = useState("");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_PendingPurchaseOrdersReport')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: transactions = [], isLoading: loadingTransactions } = useQuery({
    queryKey: ['all-transactions-for-po-report'],
    queryFn: () => base44.entities.ProgramTicketTransaction.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: organizations = [], isLoading: loadingOrganizations } = useQuery({
    queryKey: ['all-organizations'],
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const updateTransactionMutation = useMutation({
    mutationFn: async ({ id, purchase_order_number }) => {
      return await base44.entities.ProgramTicketTransaction.update(id, { purchase_order_number });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-transactions-for-po-report'] });
      toast({
        title: "Success",
        description: "Purchase order number has been saved.",
      });
      setEditingTransaction(null);
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

  const isLoading = loadingTransactions || loadingOrganizations;

  const programs = useMemo(() => {
    const uniquePrograms = [...new Set(transactions.map(t => t.program_name).filter(Boolean))];
    return uniquePrograms.sort();
  }, [transactions]);

  const pendingPOTransactions = useMemo(() => {
    return transactions.filter(t => {
      const hasInvoice = (t.xero_invoice_id && t.xero_invoice_id.trim() !== '') || 
                         (t.xero_invoice_number && t.xero_invoice_number.trim() !== '');
      const missingPO = !t.purchase_order_number || t.purchase_order_number.trim() === '';
      const isPurchase = t.transaction_type === 'purchase';
      const isActive = t.status !== 'cancelled';
      
      return hasInvoice && missingPO && isPurchase && isActive;
    });
  }, [transactions]);

  const filteredAndSortedData = useMemo(() => {
    let filtered = pendingPOTransactions;

    if (selectedProgram !== 'all') {
      filtered = filtered.filter(t => t.program_name === selectedProgram);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(t => {
        const org = organizations.find(o => o.id === t.organization_id);
        const orgName = org?.name || '';
        return (
          orgName.toLowerCase().includes(query) ||
          (t.xero_invoice_number || '').toLowerCase().includes(query) ||
          (t.program_name || '').toLowerCase().includes(query) ||
          (t.member_email || '').toLowerCase().includes(query)
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
          const orgA = organizations.find(o => o.id === a.organization_id)?.name || '';
          const orgB = organizations.find(o => o.id === b.organization_id)?.name || '';
          return orgA.localeCompare(orgB);
        }
        case 'org_desc': {
          const orgA = organizations.find(o => o.id === a.organization_id)?.name || '';
          const orgB = organizations.find(o => o.id === b.organization_id)?.name || '';
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
  }, [pendingPOTransactions, organizations, searchQuery, selectedProgram, sortBy]);

  const handleExportCSV = () => {
    const headers = ['Organisation', 'Program', 'Invoice Number', 'Invoice Date', 'Quantity', 'Total Cost', 'Member Email'];
    const rows = filteredAndSortedData.map(t => {
      const org = organizations.find(o => o.id === t.organization_id);
      return [
        org?.name || 'Unknown',
        t.program_name || '',
        t.xero_invoice_number || '',
        t.created_date ? format(new Date(t.created_date), 'yyyy-MM-dd') : '',
        t.quantity || 0,
        t.total_cost_before_discount || 0,
        t.member_email || ''
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

  const handleAddPO = (transaction) => {
    setEditingTransaction(transaction);
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
      id: editingTransaction.id,
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
            <Select value={selectedProgram} onValueChange={setSelectedProgram}>
              <SelectTrigger className="w-[200px]" data-testid="select-program">
                <SelectValue placeholder="All Programs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Programs</SelectItem>
                {programs.map(program => (
                  <SelectItem key={program} value={program}>{program}</SelectItem>
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
              {filteredAndSortedData.map((transaction) => {
                const org = organizations.find(o => o.id === transaction.organization_id);
                return (
                  <div
                    key={transaction.id}
                    className="border rounded-lg p-4 hover-elevate"
                    data-testid={`card-transaction-${transaction.id}`}
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium" data-testid={`text-org-name-${transaction.id}`}>
                            {org?.name || 'Unknown Organisation'}
                          </span>
                          <Badge variant="secondary" data-testid={`badge-program-${transaction.id}`}>
                            {transaction.program_name}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                          <span className="flex items-center gap-1">
                            <FileText className="h-3 w-3" />
                            <span data-testid={`text-invoice-${transaction.id}`}>
                              Invoice: {transaction.xero_invoice_number || 'N/A'}
                            </span>
                          </span>
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            <span data-testid={`text-date-${transaction.id}`}>
                              {transaction.created_date 
                                ? format(new Date(transaction.created_date), 'dd MMM yyyy')
                                : 'Unknown date'}
                            </span>
                          </span>
                          {transaction.quantity && (
                            <span data-testid={`text-quantity-${transaction.id}`}>
                              Qty: {transaction.quantity}
                            </span>
                          )}
                          {transaction.total_cost_before_discount > 0 && (
                            <span className="font-medium" data-testid={`text-cost-${transaction.id}`}>
                              £{transaction.total_cost_before_discount.toLocaleString()}
                            </span>
                          )}
                        </div>
                        {transaction.member_email && (
                          <div className="text-sm text-muted-foreground" data-testid={`text-email-${transaction.id}`}>
                            Booked by: {transaction.member_email}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {transaction.xero_invoice_pdf_uri && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDownloadInvoice(transaction)}
                            data-testid={`button-download-invoice-${transaction.id}`}
                          >
                            <ExternalLink className="h-4 w-4 mr-1" />
                            View Invoice
                          </Button>
                        )}
                        <Button
                          size="sm"
                          onClick={() => handleAddPO(transaction)}
                          data-testid={`button-add-po-${transaction.id}`}
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

      <Dialog open={!!editingTransaction} onOpenChange={() => setEditingTransaction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Purchase Order Number</DialogTitle>
          </DialogHeader>
          {editingTransaction && (
            <div className="space-y-4 py-4">
              <div className="text-sm text-muted-foreground">
                <p><strong>Organisation:</strong> {organizations.find(o => o.id === editingTransaction.organization_id)?.name || 'Unknown'}</p>
                <p><strong>Invoice:</strong> {editingTransaction.xero_invoice_number}</p>
                <p><strong>Program:</strong> {editingTransaction.program_name}</p>
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
            <Button variant="outline" onClick={() => setEditingTransaction(null)} data-testid="button-cancel-po">
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
