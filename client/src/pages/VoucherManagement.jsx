import React, { useState, useEffect, useMemo, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { Ticket, Plus, Pencil, Trash2, Search, ChevronLeft, ChevronRight, Building2, Calendar as CalendarIcon, EyeOff, Eye, AlertCircle, Check, ChevronsUpDown, Wifi, ArrowLeft, History, Download, Loader2, ArrowUp, ArrowDown } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useAdminBalancesRealtime } from "@/hooks/useAdminBalancesRealtime";

const ITEMS_PER_PAGE = 10;

const EXPORT_COLUMN_DEFS = [
  { key: 'organization', label: 'Organisation' },
  { key: 'voucher_code', label: 'Voucher Code' },
  { key: 'voucher_description', label: 'Voucher Description' },
  { key: 'voucher_expiry_date', label: 'Voucher Expiry Date' },
  { key: 'date', label: 'Date' },
  { key: 'type', label: 'Type' },
  { key: 'balance_before', label: 'Balance Before' },
  { key: 'amount', label: 'Amount' },
  { key: 'balance_after', label: 'Balance After' },
  { key: 'booking_reference', label: 'Booking Reference' },
  { key: 'event_internal_reference', label: 'Event Internal Reference' },
  { key: 'event_date', label: 'Event Date' },
  { key: 'event_title', label: 'Event Title' },
  { key: 'member', label: 'Member' },
];
const ALL_EXPORT_COLUMN_KEYS = EXPORT_COLUMN_DEFS.map(c => c.key);

const EXPORT_SORT_FIELDS = EXPORT_COLUMN_DEFS.map(c => ({ key: c.key, label: c.label }));

const EXPORT_SORT_FIELD_TYPES = {
  organization: 'text',
  voucher_code: 'text',
  voucher_description: 'text',
  voucher_expiry_date: 'date',
  date: 'date',
  type: 'text',
  balance_before: 'number',
  amount: 'number',
  balance_after: 'number',
  booking_reference: 'text',
  event_internal_reference: 'text',
  event_date: 'date',
  event_title: 'text',
  member: 'text',
};
const DEFAULT_EXPORT_SORT_RULES = [{ field: 'organization', dir: 'asc', fallback: '' }];

const EXPORT_DATE_FILTER_FIELDS = EXPORT_COLUMN_DEFS.filter(
  c => EXPORT_SORT_FIELD_TYPES[c.key] === 'date'
);

export default function VoucherManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editingVoucher, setEditingVoucher] = useState(null);
  
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [orgFilter, setOrgFilter] = useState("all");
  const [showExpired, setShowExpired] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const [showDialog, setShowDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [voucherToDelete, setVoucherToDelete] = useState(null);
  const [orgSearchOpen, setOrgSearchOpen] = useState(false);
  const [selectedVoucher, setSelectedVoucher] = useState(null);
  const [isExporting, setIsExporting] = useState(false);

  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportColumns, setExportColumns] = useState(() => new Set(ALL_EXPORT_COLUMN_KEYS));
  const [exportFromDate, setExportFromDate] = useState(null);
  const [exportToDate, setExportToDate] = useState(null);
  const [exportFromOpen, setExportFromOpen] = useState(false);
  const [exportToOpen, setExportToOpen] = useState(false);
  const [exportAllOrgs, setExportAllOrgs] = useState(true);
  const [exportOrgIds, setExportOrgIds] = useState(() => new Set());
  const [exportOrgSearch, setExportOrgSearch] = useState("");
  const [exportSortRules, setExportSortRules] = useState(() => DEFAULT_EXPORT_SORT_RULES.map(r => ({ ...r })));
  const [exportDateField, setExportDateField] = useState('date');
  const [exportDateFallbackField, setExportDateFallbackField] = useState('');
  const [exportEmptyMessage, setExportEmptyMessage] = useState("");

  const queryClient = useQueryClient();

  // Realtime callbacks for admin updates
  const handleVoucherUpdated = useCallback(({ eventType, voucher }) => {
    console.log('[VoucherManagement] Voucher updated via realtime:', eventType, voucher?.id);
    if (eventType === 'UPDATE') {
      toast.info('Voucher updated', {
        description: 'A voucher was just modified.',
        duration: 3000
      });
    } else if (eventType === 'INSERT') {
      toast.info('New voucher created', {
        description: 'A new voucher was just added.',
        duration: 3000
      });
    }
  }, []);

  // Subscribe to realtime updates
  const { isConnected: realtimeConnected } = useAdminBalancesRealtime({
    onVoucherUpdated: handleVoucherUpdated
  });

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_VoucherManagement')) {
        window.location.href = createPageUrl('Dashboard');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: vouchers = [], isLoading: loadingVouchers } = useQuery({
    queryKey: ['vouchers-admin'],
    queryFn: () => base44.entities.Voucher.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch voucher transactions for selected voucher
  const { data: voucherTransactions = [], isLoading: loadingTransactions } = useQuery({
    queryKey: ['voucher-transactions', selectedVoucher?.id],
    queryFn: async () => {
      if (!selectedVoucher?.id) return [];
      const allTransactions = await base44.entities.VoucherTransaction.list();
      return allTransactions
        .filter(tx => tx.voucher_id === selectedVoucher.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },
    enabled: !!selectedVoucher?.id,
    staleTime: 0,
  });

  // Keep selectedVoucher in sync with the latest data from vouchers query
  useEffect(() => {
    if (selectedVoucher && vouchers.length > 0) {
      const updatedVoucher = vouchers.find(v => v.id === selectedVoucher.id);
      if (updatedVoucher && (
        updatedVoucher.value !== selectedVoucher.value ||
        updatedVoucher.status !== selectedVoucher.status
      )) {
        console.log('[VoucherManagement] Syncing selectedVoucher with latest data');
        setSelectedVoucher(updatedVoucher);
      }
    }
  }, [vouchers, selectedVoucher]);

  // Sort organizations alphabetically for better UX
  const sortedOrganizations = useMemo(() => {
    return [...organizations].sort((a, b) => 
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    );
  }, [organizations]);

  const filteredVouchers = useMemo(() => {
    let filtered = vouchers;
    
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(v => 
        v.code?.toLowerCase().includes(term) ||
        v.description?.toLowerCase().includes(term) ||
        organizations.find(o => o.id === v.organization_id)?.name?.toLowerCase().includes(term)
      );
    }
    
    if (statusFilter !== "all") {
      if (statusFilter === "expired") {
        filtered = filtered.filter(v => {
          const isPastExpiry = v.expires_at && new Date(v.expires_at) < new Date();
          return v.status === 'expired' || isPastExpiry;
        });
      } else {
        filtered = filtered.filter(v => v.status === statusFilter);
      }
    }
    
    if (orgFilter !== "all") {
      filtered = filtered.filter(v => v.organization_id === orgFilter);
    }
    
    if (!showExpired && statusFilter !== "expired") {
      filtered = filtered.filter(v => {
        if (!v.expires_at) return true;
        return new Date(v.expires_at) >= new Date();
      });
    }
    
    return filtered.sort((a, b) => {
      const dateA = new Date(a.expires_at || 0);
      const dateB = new Date(b.expires_at || 0);
      return dateB.getTime() - dateA.getTime();
    });
  }, [vouchers, searchTerm, statusFilter, orgFilter, showExpired, organizations]);

  const totalPages = Math.ceil(filteredVouchers.length / ITEMS_PER_PAGE);
  const paginatedVouchers = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredVouchers.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredVouchers, currentPage]);

  const orgSummary = useMemo(() => {
    const summaryMap = {};
    filteredVouchers.forEach(v => {
      const orgId = v.organization_id;
      if (!orgId) return;
      if (!summaryMap[orgId]) {
        summaryMap[orgId] = { activeCount: 0, totalValue: 0 };
      }
      summaryMap[orgId].totalValue += (v.value || 0);
      const isExpired = v.expires_at && new Date(v.expires_at) < new Date();
      if (v.status === 'active' && !isExpired) {
        summaryMap[orgId].activeCount += 1;
      }
    });
    return Object.entries(summaryMap)
      .map(([orgId, data]) => {
        const org = organizations.find(o => o.id === orgId);
        return {
          orgId,
          name: org?.name || 'Unknown Organisation',
          activeCount: data.activeCount,
          totalValue: data.totalValue,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [filteredVouchers, organizations]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, orgFilter, showExpired]);

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Voucher.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vouchers-admin'] });
      setShowDialog(false);
      setEditingVoucher(null);
      toast.success('Voucher created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create voucher: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Voucher.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vouchers-admin'] });
      queryClient.invalidateQueries({ queryKey: ['voucher-transactions'] });
      setShowDialog(false);
      setEditingVoucher(null);
      toast.success('Voucher updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update voucher: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Voucher.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vouchers-admin'] });
      setShowDeleteConfirm(false);
      setVoucherToDelete(null);
      toast.success('Voucher deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete voucher: ' + error.message);
    }
  });

  const openExportDialog = () => {
    setExportColumns(new Set(ALL_EXPORT_COLUMN_KEYS));
    setExportFromDate(null);
    setExportToDate(null);
    setExportAllOrgs(true);
    setExportOrgIds(new Set());
    setExportOrgSearch("");
    setExportSortRules(DEFAULT_EXPORT_SORT_RULES.map(r => ({ ...r })));
    setExportDateField('date');
    setExportDateFallbackField('');
    setExportEmptyMessage("");
    setShowExportDialog(true);
  };

  const toggleExportColumn = (key) => {
    setExportColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size <= 1) return prev;
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const updateExportSortRule = (idx, patch) => {
    setExportSortRules(prev => {
      const next = prev.map(r => ({ ...r }));
      const current = { ...next[idx], ...patch };
      if (
        current.fallback &&
        (current.fallback === current.field ||
          EXPORT_SORT_FIELD_TYPES[current.fallback] !== EXPORT_SORT_FIELD_TYPES[current.field])
      ) {
        current.fallback = '';
      }
      next[idx] = current;
      return next;
    });
  };
  const addExportSortRule = () => {
    setExportSortRules(prev => {
      const used = new Set(prev.map(r => r.field));
      const nextField = EXPORT_SORT_FIELDS.find(f => !used.has(f.key));
      if (!nextField) return prev;
      return [...prev, { field: nextField.key, dir: 'asc', fallback: '' }];
    });
  };
  const removeExportSortRule = (idx) => {
    setExportSortRules(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx));
  };
  const moveExportSortRule = (idx, delta) => {
    setExportSortRules(prev => {
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const toggleExportOrg = (id) => {
    setExportOrgIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const filteredExportOrgs = useMemo(() => {
    const term = exportOrgSearch.trim().toLowerCase();
    const sorted = [...organizations].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!term) return sorted;
    return sorted.filter(o => (o.name || '').toLowerCase().includes(term));
  }, [organizations, exportOrgSearch]);

  const toIsoDateOnly = (d) => {
    if (!d) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const handleConfirmExport = async () => {
    setExportEmptyMessage("");
    if (exportColumns.size === 0) {
      toast.error('Select at least one column to export');
      return;
    }
    if (!exportAllOrgs && exportOrgIds.size === 0) {
      toast.error('Select at least one organisation, or choose "All organisations"');
      return;
    }
    if (exportFromDate && exportToDate && exportFromDate > exportToDate) {
      toast.error('"From" date must be on or before "To" date');
      return;
    }
    if (!EXPORT_DATE_FILTER_FIELDS.some(f => f.key === exportDateField)) {
      toast.error('Invalid date field selected for the date range');
      return;
    }
    if (exportDateFallbackField) {
      if (!EXPORT_DATE_FILTER_FIELDS.some(f => f.key === exportDateFallbackField)) {
        toast.error('Invalid fallback date field selected');
        return;
      }
      if (exportDateFallbackField === exportDateField) {
        toast.error('Fallback date field must differ from the primary date field');
        return;
      }
    }
    if (exportSortRules.length === 0) {
      toast.error('Add at least one sort rule');
      return;
    }
    {
      const seen = new Set();
      for (const rule of exportSortRules) {
        if (!rule.field || !EXPORT_SORT_FIELD_TYPES[rule.field]) {
          toast.error('Invalid sort field selected');
          return;
        }
        if (seen.has(rule.field)) {
          toast.error('Each sort field can only be used once');
          return;
        }
        seen.add(rule.field);
        if (rule.fallback) {
          if (rule.fallback === rule.field) {
            toast.error('Fallback field must differ from the primary sort field');
            return;
          }
          if (EXPORT_SORT_FIELD_TYPES[rule.fallback] !== EXPORT_SORT_FIELD_TYPES[rule.field]) {
            toast.error('Fallback field must be the same data type as the primary sort field');
            return;
          }
        }
      }
    }

    setIsExporting(true);
    try {
      const params = new URLSearchParams();
      const orderedCols = ALL_EXPORT_COLUMN_KEYS.filter(k => exportColumns.has(k));
      params.set('columns', orderedCols.join(','));
      if (exportFromDate) params.set('from', toIsoDateOnly(exportFromDate));
      if (exportToDate) params.set('to', toIsoDateOnly(exportToDate));
      if (exportFromDate || exportToDate) {
        params.set('date_field', exportDateField);
        if (exportDateFallbackField) {
          params.set('date_fallback_field', exportDateFallbackField);
        }
      }
      if (!exportAllOrgs) params.set('organization_ids', Array.from(exportOrgIds).join(','));
      for (const rule of exportSortRules) {
        const parts = [rule.field, rule.dir];
        if (rule.fallback) parts.push(rule.fallback);
        params.append('sort', parts.join(':'));
      }

      const response = await fetch(`/api/admin/voucher-transactions/export-csv?${params.toString()}`, {
        credentials: 'include'
      });
      if (!response.ok) {
        let message = 'Export failed';
        try {
          const errBody = await response.json();
          if (errBody?.error) message = errBody.error;
        } catch {}
        throw new Error(message);
      }

      const rowCountHeader = response.headers.get('X-Export-Row-Count');
      const rowCount = rowCountHeader != null ? parseInt(rowCountHeader, 10) : null;
      if (rowCount === 0) {
        setExportEmptyMessage('No transactions match the selected filters. Adjust your filters and try again.');
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const today = new Date().toISOString().split('T')[0];
      link.download = `training_voucher_transactions_${today}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success('CSV file downloaded successfully');
      setShowExportDialog(false);
    } catch (err) {
      toast.error('Failed to export transactions: ' + (err.message || 'Unknown error'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleCreateNew = () => {
    setEditingVoucher({
      organization_id: "",
      code: "",
      value: 0,
      description: "",
      issued_at: format(new Date(), "yyyy-MM-dd"),
      expires_at: "",
      status: "active"
    });
    setShowDialog(true);
  };

  const handleEdit = (voucher) => {
    const issuedSource = voucher.issued_at || voucher.created_at;
    setEditingVoucher({
      ...voucher,
      issued_at: issuedSource ? format(new Date(issuedSource), "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd"),
      expires_at: voucher.expires_at ? format(new Date(voucher.expires_at), "yyyy-MM-dd") : "",
      _originalValue: voucher.value
    });
    setShowDialog(true);
  };

  const handleDelete = (voucher) => {
    if (voucher.status === 'used') {
      toast.error('Cannot delete a voucher that has been used');
      return;
    }
    setVoucherToDelete(voucher);
    setShowDeleteConfirm(true);
  };

  const handleSave = async () => {
    if (!editingVoucher.organization_id) {
      toast.error('Organisation is required');
      return;
    }
    if (!editingVoucher.code.trim()) {
      toast.error('Code is required');
      return;
    }
    if (editingVoucher.value <= 0) {
      toast.error('Value must be greater than 0');
      return;
    }
    if (!editingVoucher.expires_at) {
      toast.error('Expiry date is required');
      return;
    }
    if (!editingVoucher.issued_at) {
      toast.error('Awarded date is required');
      return;
    }

    const newValue = parseFloat(editingVoucher.value);
    const data = {
      organization_id: editingVoucher.organization_id,
      code: editingVoucher.code.toUpperCase().trim(),
      value: newValue,
      description: editingVoucher.description || "",
      issued_at: new Date(editingVoucher.issued_at).toISOString(),
      expires_at: new Date(editingVoucher.expires_at).toISOString(),
      status: editingVoucher.status
    };

    if (editingVoucher.id) {
      const originalValue = editingVoucher._originalValue || 0;
      const valueChanged = Math.abs(newValue - originalValue) > 0.001;
      
      if (valueChanged) {
        const adjustmentAmount = newValue - originalValue;
        const transactionData = {
          voucher_id: editingVoucher.id,
          organization_id: editingVoucher.organization_id,
          amount: Math.abs(adjustmentAmount),
          balance_before: originalValue,
          balance_after: newValue,
          type: adjustmentAmount > 0 ? 'credit_adjustment' : 'debit_adjustment'
        };
        
        try {
          await base44.entities.VoucherTransaction.create(transactionData);
        } catch (err) {
          console.error('Failed to record adjustment transaction:', err);
        }
      }
      
      updateMutation.mutate({ id: editingVoucher.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const getStatusBadge = (status, expiresAt) => {
    const isExpired = expiresAt && new Date(expiresAt) < new Date();
    
    if (status === 'used') {
      return <Badge className="bg-slate-200 text-slate-700">Used</Badge>;
    }
    if (isExpired || status === 'expired') {
      return <Badge className="bg-red-100 text-red-700">Expired</Badge>;
    }
    if (status === 'active') {
      return <Badge className="bg-green-100 text-green-700">Active</Badge>;
    }
    return <Badge className="bg-slate-200 text-slate-700">{status}</Badge>;
  };

  const handleVoucherClick = (voucher) => {
    setSelectedVoucher(voucher);
  };

  const handleBackToList = () => {
    setSelectedVoucher(null);
  };

  const formatTransactionType = (type) => {
    switch (type) {
      case 'booking_usage': return { label: 'Booking', color: 'bg-blue-100 text-blue-800' };
      case 'credit_adjustment': return { label: 'Credit', color: 'bg-green-100 text-green-800' };
      case 'debit_adjustment': return { label: 'Debit', color: 'bg-warning/10 text-warning' };
      case 'adjustment': return { label: 'Adjustment', color: 'bg-warning/10 text-warning' };
      default: return { label: type, color: 'bg-slate-100 text-slate-800' };
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  // Voucher detail view with transaction history
  if (selectedVoucher) {
    const org = organizations.find(o => o.id === selectedVoucher.organization_id);
    
    return (
      <div className="min-h-screen p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6">
            <Button 
              variant="ghost" 
              onClick={handleBackToList}
              className="mb-4"
              data-testid="button-back-to-vouchers"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Vouchers
            </Button>
            
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h1 className="text-2xl md:text-3xl font-bold text-slate-900">
                    {selectedVoucher.code}
                  </h1>
                  {getStatusBadge(selectedVoucher.status, selectedVoucher.expires_at)}
                </div>
                <p className="text-slate-600">{org?.name || 'Unknown Organisation'}</p>
                {selectedVoucher.description && (
                  <p className="text-slate-500 text-sm mt-1">{selectedVoucher.description}</p>
                )}
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-500">Current Value</p>
                <p className={`text-3xl font-bold ${(selectedVoucher.value || 0) > 0 ? 'text-green-600' : 'text-slate-400'}`}>
                  £{(selectedVoucher.value || 0).toFixed(2)}
                </p>
                {(selectedVoucher.issued_at || selectedVoucher.created_at) && (
                  <p className="text-xs text-slate-400 mt-1" data-testid="text-voucher-awarded-detail">
                    Awarded: {format(new Date(selectedVoucher.issued_at || selectedVoucher.created_at), 'dd MMM yyyy')}
                  </p>
                )}
                {selectedVoucher.expires_at && (
                  <p className="text-xs text-slate-400 mt-1">
                    Expires: {format(new Date(selectedVoucher.expires_at), 'dd MMM yyyy')}
                  </p>
                )}
              </div>
            </div>
          </div>

          <Card className="border-slate-200 shadow-sm mb-6">
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-slate-500" />
                <span className="font-medium text-slate-700">
                  {voucherTransactions.length} {voucherTransactions.length === 1 ? 'transaction' : 'transactions'}
                </span>
              </div>
            </CardContent>
          </Card>

          {loadingTransactions ? (
            <div className="text-center py-12">Loading transaction history...</div>
          ) : voucherTransactions.length === 0 ? (
            <Card className="border-slate-200 shadow-sm">
              <CardContent className="p-12 text-center">
                <History className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">
                  No Transaction History
                </h3>
                <p className="text-slate-600">
                  This voucher hasn't been used yet
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {voucherTransactions.map((transaction) => {
                const typeInfo = formatTransactionType(transaction.type);
                
                return (
                  <Card 
                    key={transaction.id} 
                    className="border-slate-200 shadow-sm"
                    data-testid={`card-voucher-transaction-${transaction.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <Badge className={typeInfo.color}>
                              {typeInfo.label}
                            </Badge>
                            <span className="text-sm text-slate-500">
                              {transaction.created_at ? format(new Date(transaction.created_at), 'dd MMM yyyy, HH:mm') : 'Unknown date'}
                            </span>
                          </div>
                          
                          {transaction.event_title && (
                            <p className="text-slate-700 mb-2">
                              Event: {transaction.event_title}
                            </p>
                          )}
                          
                          {transaction.booking_reference && (
                            <p className="text-sm text-slate-500 mb-2">
                              Booking: {transaction.booking_reference}
                            </p>
                          )}
                          
                          <div className="flex items-center gap-4 text-sm text-slate-500">
                            <span>
                              Before: <span className="font-medium text-slate-700">£{(transaction.balance_before || 0).toFixed(2)}</span>
                            </span>
                            <span>→</span>
                            <span>
                              After: <span className="font-medium text-slate-700">£{(transaction.balance_after || 0).toFixed(2)}</span>
                            </span>
                          </div>
                          
                          {transaction.member_email && (
                            <p className="text-xs text-slate-400 mt-2">
                              Used by: {transaction.member_email}
                            </p>
                          )}
                        </div>
                        
                        <div className="text-right flex-shrink-0">
                          {transaction.type === 'credit_adjustment' ? (
                            <span className="text-lg font-bold text-green-600">
                              +£{(transaction.amount || 0).toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-lg font-bold text-red-600">
                              -£{(transaction.amount || 0).toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8 gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
                Training Voucher Management
              </h1>
              {realtimeConnected && (
                <div className="flex items-center gap-1.5 text-xs text-green-600" title="Live updates enabled">
                  <Wifi className="w-3 h-3" />
                  <span>Live</span>
                </div>
              )}
            </div>
            <p className="text-slate-600">
              Create and manage training vouchers for organisations
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isAdmin && (
              <Button
                variant="outline"
                onClick={openExportDialog}
                disabled={isExporting}
                className="gap-2"
                data-testid="button-export-training-voucher-transactions-csv"
              >
                {isExporting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                Export CSV
              </Button>
            )}
            <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700" data-testid="button-create-voucher">
              <Plus className="w-4 h-4 mr-2" />
              Create Voucher
            </Button>
          </div>
        </div>

        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search by code, description, or organisation..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                  data-testid="input-search-vouchers"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[140px]" data-testid="select-status-filter">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="used">Used</SelectItem>
                    <SelectItem value="expired">Expired</SelectItem>
                  </SelectContent>
                </Select>
                
                <Select value={orgFilter} onValueChange={setOrgFilter}>
                  <SelectTrigger className="w-[180px]" data-testid="select-org-filter">
                    <SelectValue placeholder="Organisation" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Organisations</SelectItem>
                    {sortedOrganizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <button
                  onClick={() => setShowExpired(!showExpired)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors ${
                    showExpired 
                      ? 'bg-warning/10 border-warning/30 text-warning' 
                      : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                  data-testid="button-toggle-expired"
                >
                  {showExpired ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  {showExpired ? 'Showing expired' : 'Hiding expired'}
                </button>
                
                <div className="text-sm text-slate-500">
                  {filteredVouchers.length} {filteredVouchers.length === 1 ? 'voucher' : 'vouchers'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            {loadingVouchers ? (
              <div className="text-center py-12">Loading vouchers...</div>
            ) : vouchers.length === 0 ? (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-12 text-center">
                  <Ticket className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">
                    No Vouchers Yet
                  </h3>
                  <p className="text-slate-600 mb-6">
                    Create your first training voucher for an organisation
                  </p>
                  <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
                    <Plus className="w-4 h-4 mr-2" />
                    Create First Voucher
                  </Button>
                </CardContent>
              </Card>
            ) : filteredVouchers.length === 0 ? (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-12 text-center">
                  <Search className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">
                    No Matching Vouchers
                  </h3>
                  <p className="text-slate-600 mb-4">
                    No vouchers match your search criteria
                  </p>
                  <Button 
                    variant="outline" 
                    onClick={() => { setSearchTerm(""); setStatusFilter("all"); setOrgFilter("all"); setShowExpired(true); }}
                  >
                    Clear Filters
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {paginatedVouchers.map((voucher) => {
                  const org = organizations.find(o => o.id === voucher.organization_id);
                  const isExpired = voucher.expires_at && new Date(voucher.expires_at) < new Date();
                  const canDelete = voucher.status !== 'used';
                  
                  return (
                    <Card 
                      key={voucher.id} 
                      className={`border-2 cursor-pointer transition-shadow hover:shadow-md ${
                        voucher.status === 'used' ? 'border-slate-200 bg-slate-50' : 
                        isExpired ? 'border-red-200 bg-red-50' :
                        'border-slate-200'
                      }`}
                      onClick={() => handleVoucherClick(voucher)}
                      data-testid={`card-voucher-${voucher.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-3 mb-2 flex-wrap">
                              <Ticket className="w-5 h-5 text-blue-600 flex-shrink-0" />
                              <span className="text-xl font-bold text-slate-900">{voucher.code}</span>
                              {getStatusBadge(voucher.status, voucher.expires_at)}
                              <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                                £{(voucher.value || 0).toFixed(2)}
                              </Badge>
                            </div>
                            
                            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
                              <div className="flex items-center gap-1">
                                <Building2 className="w-4 h-4" />
                                <span>{org?.name || 'Unknown Organisation'}</span>
                              </div>
                              {(voucher.issued_at || voucher.created_at) && (
                                <div className="flex items-center gap-1" data-testid={`text-voucher-awarded-${voucher.id}`}>
                                  <CalendarIcon className="w-4 h-4" />
                                  <span>
                                    Awarded: {format(new Date(voucher.issued_at || voucher.created_at), 'MMM d, yyyy')}
                                  </span>
                                </div>
                              )}
                              {voucher.expires_at && (
                                <div className="flex items-center gap-1">
                                  <CalendarIcon className="w-4 h-4" />
                                  <span className={isExpired ? 'text-red-600' : ''}>
                                    Expires: {format(new Date(voucher.expires_at), 'MMM d, yyyy')}
                                  </span>
                                </div>
                              )}
                            </div>
                            
                            {voucher.description && (
                              <p className="text-sm text-slate-500 mt-2">{voucher.description}</p>
                            )}
                            
                            {voucher.used_at && (
                              <p className="text-xs text-slate-400 mt-2">
                                Used on: {format(new Date(voucher.used_at), 'MMM d, yyyy h:mm a')}
                              </p>
                            )}
                          </div>
                          
                          <div className="flex gap-2 flex-shrink-0">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={(e) => { e.stopPropagation(); handleEdit(voucher); }}
                              data-testid={`button-edit-voucher-${voucher.id}`}
                            >
                              <Pencil className="w-3 h-3 mr-1" />
                              Edit
                            </Button>
                            {canDelete && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => { e.stopPropagation(); handleDelete(voucher); }}
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                data-testid={`button-delete-voucher-${voucher.id}`}
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-6 pt-4 border-t border-slate-200">
                    <div className="text-sm text-slate-500">
                      Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1} - {Math.min(currentPage * ITEMS_PER_PAGE, filteredVouchers.length)} of {filteredVouchers.length}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        data-testid="button-prev-page"
                      >
                        <ChevronLeft className="w-4 h-4 mr-1" />
                        Previous
                      </Button>
                      <div className="flex items-center gap-1">
                        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                          let pageNum;
                          if (totalPages <= 5) {
                            pageNum = i + 1;
                          } else if (currentPage <= 3) {
                            pageNum = i + 1;
                          } else if (currentPage >= totalPages - 2) {
                            pageNum = totalPages - 4 + i;
                          } else {
                            pageNum = currentPage - 2 + i;
                          }
                          return (
                            <Button
                              key={pageNum}
                              variant={currentPage === pageNum ? "default" : "outline"}
                              size="sm"
                              onClick={() => setCurrentPage(pageNum)}
                              className="w-9"
                              data-testid={`button-page-${pageNum}`}
                            >
                              {pageNum}
                            </Button>
                          );
                        })}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        data-testid="button-next-page"
                      >
                        Next
                        <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="lg:col-span-1">
            <Card className="border-slate-200 shadow-sm lg:sticky lg:top-8" data-testid="card-org-summary">
              <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-slate-500" />
                  Organisation Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {loadingVouchers ? (
                  <div className="px-4 pb-4 text-center text-sm text-slate-500">
                    Loading...
                  </div>
                ) : orgSummary.length === 0 ? (
                  <div className="px-4 pb-4 text-center text-sm text-slate-500">
                    No organisations to display
                  </div>
                ) : (
                  <div className="max-h-[calc(100vh-16rem)] overflow-y-auto">
                    {orgSummary.map((org) => (
                      <div
                        key={org.orgId}
                        className="flex items-center justify-between gap-3 px-4 py-3 border-t border-slate-100"
                        data-testid={`row-org-summary-${org.orgId}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-900 truncate">{org.name}</p>
                          <p className="text-xs text-slate-500">
                            {org.activeCount} active {org.activeCount === 1 ? 'voucher' : 'vouchers'}
                          </p>
                        </div>
                        <div className="flex-shrink-0 text-right">
                          <p className="text-sm font-semibold text-slate-900">£{org.totalValue.toFixed(2)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {editingVoucher?.id ? 'Edit Voucher' : 'Create New Voucher'}
              </DialogTitle>
            </DialogHeader>
            
            {editingVoucher && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="organization">Organisation *</Label>
                  <Popover open={orgSearchOpen} onOpenChange={setOrgSearchOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={orgSearchOpen}
                        className="w-full justify-between font-normal"
                        data-testid="select-voucher-org"
                      >
                        {editingVoucher.organization_id
                          ? organizations.find(o => o.id === editingVoucher.organization_id)?.name || "Select organisation..."
                          : "Select organisation..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[400px] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search organisations..." />
                        <CommandList>
                          <CommandEmpty>No organisation found.</CommandEmpty>
                          <CommandGroup>
                            {sortedOrganizations.map(org => (
                              <CommandItem
                                key={org.id}
                                value={org.name}
                                onSelect={() => {
                                  setEditingVoucher({ ...editingVoucher, organization_id: org.id });
                                  setOrgSearchOpen(false);
                                }}
                                data-testid={`org-option-${org.id}`}
                              >
                                <Check
                                  className={`mr-2 h-4 w-4 ${
                                    editingVoucher.organization_id === org.id ? "opacity-100" : "opacity-0"
                                  }`}
                                />
                                {org.name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="code">Voucher Code *</Label>
                    <Input
                      id="code"
                      value={editingVoucher.code}
                      onChange={(e) => setEditingVoucher({ ...editingVoucher, code: e.target.value.toUpperCase() })}
                      placeholder="e.g., TRAIN2024"
                      data-testid="input-voucher-code"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="value">Value (£) *</Label>
                    <Input
                      id="value"
                      type="number"
                      step="0.01"
                      min="0"
                      value={editingVoucher.value}
                      onChange={(e) => setEditingVoucher({ ...editingVoucher, value: e.target.value })}
                      data-testid="input-voucher-value"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="issued_at">Awarded Date *</Label>
                    <Input
                      id="issued_at"
                      type="date"
                      value={editingVoucher.issued_at || ""}
                      onChange={(e) => setEditingVoucher({ ...editingVoucher, issued_at: e.target.value })}
                      data-testid="input-voucher-issued"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="expires_at">Expiry Date *</Label>
                    <Input
                      id="expires_at"
                      type="date"
                      value={editingVoucher.expires_at}
                      onChange={(e) => setEditingVoucher({ ...editingVoucher, expires_at: e.target.value })}
                      data-testid="input-voucher-expiry"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="status">Status</Label>
                    <Select
                      value={editingVoucher.status}
                      onValueChange={(value) => setEditingVoucher({ ...editingVoucher, status: value })}
                    >
                      <SelectTrigger data-testid="select-voucher-status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="used">Used</SelectItem>
                        <SelectItem value="expired">Expired</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Input
                    id="description"
                    value={editingVoucher.description || ""}
                    onChange={(e) => setEditingVoucher({ ...editingVoucher, description: e.target.value })}
                    placeholder="e.g., Annual Conference 2024"
                    data-testid="input-voucher-description"
                  />
                </div>
              </div>
            )}
            
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleSave} 
                disabled={createMutation.isPending || updateMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-save-voucher"
              >
                {createMutation.isPending || updateMutation.isPending ? 'Saving...' : 'Save Voucher'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-red-500" />
                Delete Voucher
              </DialogTitle>
            </DialogHeader>
            <p className="text-slate-600">
              Are you sure you want to delete voucher <strong>{voucherToDelete?.code}</strong>? 
              This action cannot be undone.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </Button>
              <Button 
                variant="destructive" 
                onClick={() => deleteMutation.mutate(voucherToDelete.id)}
                disabled={deleteMutation.isPending}
                data-testid="button-confirm-delete"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-export-voucher-csv-config">
            <DialogHeader>
              <DialogTitle>Export training voucher transactions</DialogTitle>
              <DialogDescription>
                Choose which columns to include, narrow by date or organisation, and pick how the rows should be sorted.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-6">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-sm font-medium">Columns</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setExportColumns(new Set(ALL_EXPORT_COLUMN_KEYS))}
                      data-testid="button-export-voucher-columns-select-all"
                    >
                      Select all
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setExportColumns(new Set([ALL_EXPORT_COLUMN_KEYS[0]]));
                      }}
                      data-testid="button-export-voucher-columns-clear"
                    >
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-md border p-3">
                  {EXPORT_COLUMN_DEFS.map(col => (
                    <label
                      key={col.key}
                      className="flex items-center gap-2 text-sm cursor-pointer"
                      data-testid={`label-export-voucher-column-${col.key}`}
                    >
                      <Checkbox
                        checked={exportColumns.has(col.key)}
                        onCheckedChange={() => toggleExportColumn(col.key)}
                        data-testid={`checkbox-export-voucher-column-${col.key}`}
                      />
                      <span>{col.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium">Date field</Label>
                  <Select
                    value={exportDateField}
                    onValueChange={(v) => {
                      setExportDateField(v);
                      if (exportDateFallbackField === v) setExportDateFallbackField('');
                    }}
                  >
                    <SelectTrigger className="mt-1" data-testid="select-export-voucher-date-field">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EXPORT_DATE_FILTER_FIELDS.map(f => (
                        <SelectItem key={f.key} value={f.key} data-testid={`select-export-voucher-date-field-option-${f.key}`}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-sm font-medium">If empty, use</Label>
                  <Select
                    value={exportDateFallbackField || '__none__'}
                    onValueChange={(v) => setExportDateFallbackField(v === '__none__' ? '' : v)}
                  >
                    <SelectTrigger className="mt-1" data-testid="select-export-voucher-date-fallback-field">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" data-testid="select-export-voucher-date-fallback-field-option-none">
                        No fallback
                      </SelectItem>
                      {EXPORT_DATE_FILTER_FIELDS
                        .filter(f => f.key !== exportDateField)
                        .map(f => (
                          <SelectItem key={f.key} value={f.key} data-testid={`select-export-voucher-date-fallback-field-option-${f.key}`}>
                            {f.label}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-sm font-medium">From date</Label>
                  <Popover open={exportFromOpen} onOpenChange={setExportFromOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full justify-start gap-2 mt-1 font-normal"
                        data-testid="button-export-voucher-from-date"
                      >
                        <CalendarIcon className="w-4 h-4" />
                        {exportFromDate ? format(exportFromDate, 'PPP') : <span className="text-muted-foreground">No lower bound</span>}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarPicker
                        mode="single"
                        selected={exportFromDate || undefined}
                        onSelect={(d) => { setExportFromDate(d || null); setExportFromOpen(false); }}
                      />
                      {exportFromDate && (
                        <div className="p-2 border-t">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="w-full"
                            onClick={() => { setExportFromDate(null); setExportFromOpen(false); }}
                            data-testid="button-export-voucher-from-clear"
                          >
                            Clear
                          </Button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>
                <div>
                  <Label className="text-sm font-medium">To date</Label>
                  <Popover open={exportToOpen} onOpenChange={setExportToOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full justify-start gap-2 mt-1 font-normal"
                        data-testid="button-export-voucher-to-date"
                      >
                        <CalendarIcon className="w-4 h-4" />
                        {exportToDate ? format(exportToDate, 'PPP') : <span className="text-muted-foreground">No upper bound</span>}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarPicker
                        mode="single"
                        selected={exportToDate || undefined}
                        onSelect={(d) => { setExportToDate(d || null); setExportToOpen(false); }}
                      />
                      {exportToDate && (
                        <div className="p-2 border-t">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="w-full"
                            onClick={() => { setExportToDate(null); setExportToOpen(false); }}
                            data-testid="button-export-voucher-to-clear"
                          >
                            Clear
                          </Button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium">Organisations</Label>
                <div className="mt-1 rounded-md border p-3 space-y-2">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={exportAllOrgs}
                      onCheckedChange={(v) => {
                        const next = v === true;
                        setExportAllOrgs(next);
                        if (next) setExportOrgIds(new Set());
                      }}
                      data-testid="checkbox-export-voucher-all-orgs"
                    />
                    <span>All organisations</span>
                  </label>

                  {!exportAllOrgs && (
                    <>
                      <Input
                        placeholder="Search organisations..."
                        value={exportOrgSearch}
                        onChange={(e) => setExportOrgSearch(e.target.value)}
                        data-testid="input-export-voucher-org-search"
                      />
                      <ScrollArea className="h-48 rounded border">
                        <div className="p-2 space-y-1">
                          {filteredExportOrgs.length === 0 ? (
                            <p className="text-sm text-muted-foreground p-2">No organisations match your search.</p>
                          ) : filteredExportOrgs.map(org => (
                            <label
                              key={org.id}
                              className="flex items-center gap-2 text-sm cursor-pointer p-1 rounded hover-elevate"
                              data-testid={`label-export-voucher-org-${org.id}`}
                            >
                              <Checkbox
                                checked={exportOrgIds.has(org.id)}
                                onCheckedChange={() => toggleExportOrg(org.id)}
                                data-testid={`checkbox-export-voucher-org-${org.id}`}
                              />
                              <span>{org.name}</span>
                            </label>
                          ))}
                        </div>
                      </ScrollArea>
                      <p className="text-xs text-muted-foreground" data-testid="text-export-voucher-org-count">
                        {exportOrgIds.size} selected
                      </p>
                    </>
                  )}
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium">Sort by</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Rules are applied in order. The first rule is the primary sort; later rules break ties. Use "If empty, use" to fall back to another field of the same type when the primary value is missing.
                </p>
                <div className="mt-2 space-y-2">
                  {exportSortRules.map((rule, idx) => {
                    const usedFields = new Set(exportSortRules.map(r => r.field));
                    const ruleType = EXPORT_SORT_FIELD_TYPES[rule.field];
                    const fallbackOptions = EXPORT_SORT_FIELDS.filter(
                      f => f.key !== rule.field && EXPORT_SORT_FIELD_TYPES[f.key] === ruleType
                    );
                    return (
                      <div
                        key={idx}
                        className="rounded-md border p-3 space-y-2"
                        data-testid={`row-export-voucher-sort-rule-${idx}`}
                      >
                        <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_auto] gap-2 items-end">
                          <div>
                            <Label className="text-xs text-muted-foreground">
                              {idx === 0 ? 'Primary sort field' : `Tiebreaker #${idx}`}
                            </Label>
                            <Select
                              value={rule.field}
                              onValueChange={(v) => updateExportSortRule(idx, { field: v })}
                            >
                              <SelectTrigger className="mt-1" data-testid={`select-export-voucher-sort-field-${idx}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {EXPORT_SORT_FIELDS.map(f => (
                                  <SelectItem
                                    key={f.key}
                                    value={f.key}
                                    disabled={f.key !== rule.field && usedFields.has(f.key)}
                                  >
                                    {f.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Direction</Label>
                            <Select
                              value={rule.dir}
                              onValueChange={(v) => updateExportSortRule(idx, { dir: v })}
                            >
                              <SelectTrigger className="mt-1" data-testid={`select-export-voucher-sort-dir-${idx}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="asc">Ascending</SelectItem>
                                <SelectItem value="desc">Descending</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() => moveExportSortRule(idx, -1)}
                              disabled={idx === 0}
                              aria-label="Move rule up"
                              data-testid={`button-export-voucher-sort-up-${idx}`}
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() => moveExportSortRule(idx, 1)}
                              disabled={idx === exportSortRules.length - 1}
                              aria-label="Move rule down"
                              data-testid={`button-export-voucher-sort-down-${idx}`}
                            >
                              <ArrowDown />
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() => removeExportSortRule(idx)}
                              disabled={exportSortRules.length <= 1}
                              aria-label="Remove rule"
                              data-testid={`button-export-voucher-sort-remove-${idx}`}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            If empty, use
                          </Label>
                          <Select
                            value={rule.fallback || '__none__'}
                            onValueChange={(v) => updateExportSortRule(idx, { fallback: v === '__none__' ? '' : v })}
                            disabled={fallbackOptions.length === 0}
                          >
                            <SelectTrigger className="mt-1" data-testid={`select-export-voucher-sort-fallback-${idx}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">(none)</SelectItem>
                              {fallbackOptions.map(f => (
                                <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {fallbackOptions.length === 0 && (
                            <p className="text-xs text-muted-foreground mt-1">
                              No other fields share this field's data type.
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2 gap-2"
                  onClick={addExportSortRule}
                  disabled={exportSortRules.length >= EXPORT_SORT_FIELDS.length}
                  data-testid="button-export-voucher-sort-add"
                >
                  <Plus />
                  Add sort rule
                </Button>
              </div>

              {exportEmptyMessage && (
                <div
                  className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning dark:border-warning dark:bg-warning/20 dark:text-warning"
                  data-testid="text-export-voucher-empty-message"
                >
                  {exportEmptyMessage}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowExportDialog(false)}
                disabled={isExporting}
                data-testid="button-export-voucher-cancel"
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmExport}
                disabled={isExporting || exportColumns.size === 0}
                className="gap-2"
                data-testid="button-export-voucher-confirm"
              >
                {isExporting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                Download CSV
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
