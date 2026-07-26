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
import { useSavedExportReports } from "@/hooks/useSavedExportReports";
import ExportReportSwitcher from "@/components/ExportReportSwitcher";

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
  { key: 'voucher_valid_from', label: 'Voucher Valid From' },
  { key: 'funding_source', label: 'Funding Source' },
  { key: 'created_by', label: 'Created By' },
  { key: 'voucher_notes', label: 'Voucher Notes' },
  { key: 'notes', label: 'Transaction Notes' },
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
  voucher_valid_from: 'date',
  funding_source: 'text',
  created_by: 'text',
  voucher_notes: 'text',
  notes: 'text',
};
const DEFAULT_EXPORT_SORT_RULES = [{ field: 'organization', dir: 'asc', fallback: '' }];

// Date-range filter fields for the export dialog. Mirrors the page's
// voucher-level filter options (Issued / Expiry / Used) plus Event date,
// which filters individual transaction rows by the linked event's start date.
const EXPORT_DATE_FILTER_FIELDS = [
  { key: 'issued', label: 'Issued date' },
  { key: 'expiry', label: 'Expiry date' },
  { key: 'used', label: 'Used date' },
  { key: 'event_date', label: 'Event date' },
];
// Old saved reports may reference the previous field keys; map them to the
// nearest new option ("date" was the transaction date, closest to Used).
const LEGACY_EXPORT_DATE_FIELD_MAP = { date: 'used', voucher_expiry_date: 'expiry' };
const normalizeExportDateField = (v) => (v ? (LEGACY_EXPORT_DATE_FIELD_MAP[v] || v) : v);

export default function VoucherManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editingVoucher, setEditingVoucher] = useState(null);
  
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [orgFilter, setOrgFilter] = useState("all");
  const [showExpired, setShowExpired] = useState(false);
  const [dateFilterField, setDateFilterField] = useState("issued");
  const [dateFilterFrom, setDateFilterFrom] = useState("");
  const [dateFilterTo, setDateFilterTo] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  // Bulk expiry adjustment: selection can span pages (ids persist across pagination)
  const [selectedVoucherIds, setSelectedVoucherIds] = useState(() => new Set());
  const [showBulkExpiryDialog, setShowBulkExpiryDialog] = useState(false);
  const [bulkExpiryDays, setBulkExpiryDays] = useState("");
  const [bulkExpiryDirection, setBulkExpiryDirection] = useState("extend");
  const [isBulkAdjusting, setIsBulkAdjusting] = useState(false);

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
  const [exportDateField, setExportDateField] = useState('issued');
  const [exportDateFallbackField, setExportDateFallbackField] = useState('');
  const [exportExcludeExpired, setExportExcludeExpired] = useState(false);
  const [exportSuppressTransactions, setExportSuppressTransactions] = useState(false);
  const [exportEmptyMessage, setExportEmptyMessage] = useState("");

  // Tenant-shared saved export reports: one SystemSettings row per tenant
  // holding a named list of export configurations any admin can reuse.
  const {
    reports: exportReports,
    refetch: refetchExportReports,
    activeReportId: activeExportReportId,
    setActiveReportId: setActiveExportReportId,
    activeReport: activeExportReport,
    createReport: createExportReport,
    updateReport: updateExportReport,
    renameReport: renameExportReport,
    deleteReport: deleteExportReport,
    isSaving: isSavingExportReport,
  } = useSavedExportReports({
    settingKey: 'voucher_export_reports',
    description: 'Training voucher export saved reports',
    enabled: !!accessChecked,
  });

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
      const response = await fetch(`/api/admin/voucher-transactions?voucher_id=${encodeURIComponent(selectedVoucher.id)}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Failed to load transaction history');
      }
      const payload = await response.json();
      return payload.transactions || [];
    },
    enabled: !!selectedVoucher?.id,
    staleTime: 0,
  });

  const dateFilterActive = !!(dateFilterFrom || dateFilterTo);

  // Redemption (booking_usage) transaction dates keyed by voucher id.
  // Fetched lazily: only when the "Used" date filter is actually in play.
  const {
    data: redemptionDatesByVoucher = {},
    isLoading: loadingRedemptionDates,
  } = useQuery({
    queryKey: ['voucher-redemption-dates'],
    queryFn: async () => {
      const response = await fetch('/api/admin/voucher-transactions?redemption_dates=1', {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Failed to load redemption dates');
      }
      const payload = await response.json();
      return payload.redemption_dates || {};
    },
    enabled: !!accessChecked && dateFilterField === 'used' && dateFilterActive,
    staleTime: 0,
    refetchOnMount: true,
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

    if (dateFilterFrom || dateFilterTo) {
      // Inclusive local-date range; either end may be empty (open-ended).
      const fromMs = dateFilterFrom ? new Date(`${dateFilterFrom}T00:00:00`).getTime() : null;
      const toMs = dateFilterTo ? new Date(`${dateFilterTo}T23:59:59.999`).getTime() : null;
      const inRange = (dateStr) => {
        if (!dateStr) return false;
        const ms = new Date(dateStr).getTime();
        if (isNaN(ms)) return false;
        if (fromMs !== null && ms < fromMs) return false;
        if (toMs !== null && ms > toMs) return false;
        return true;
      };
      if (dateFilterField === 'used') {
        // Only apply once the redemption-date map has loaded, so the list
        // doesn't flash empty while the lazy fetch is in flight.
        if (!loadingRedemptionDates) {
          filtered = filtered.filter(v => {
            const dates = redemptionDatesByVoucher[v.id];
            return Array.isArray(dates) && dates.some(inRange);
          });
        }
      } else if (dateFilterField === 'expiry') {
        filtered = filtered.filter(v => inRange(v.expires_at));
      } else {
        filtered = filtered.filter(v => inRange(v.issued_at || v.created_at));
      }
    }

    return filtered.sort((a, b) => {
      const dateA = new Date(a.expires_at || 0);
      const dateB = new Date(b.expires_at || 0);
      return dateB.getTime() - dateA.getTime();
    });
  }, [vouchers, searchTerm, statusFilter, orgFilter, showExpired, organizations, dateFilterField, dateFilterFrom, dateFilterTo, redemptionDatesByVoucher, loadingRedemptionDates]);

  const totalPages = Math.ceil(filteredVouchers.length / ITEMS_PER_PAGE);
  const paginatedVouchers = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredVouchers.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredVouchers, currentPage]);

  // Prune selection when the underlying voucher list changes (e.g. deletions)
  useEffect(() => {
    if (selectedVoucherIds.size === 0 || vouchers.length === 0) return;
    const validIds = new Set(vouchers.map(v => v.id));
    const next = new Set([...selectedVoucherIds].filter(id => validIds.has(id)));
    if (next.size !== selectedVoucherIds.size) setSelectedVoucherIds(next);
  }, [vouchers]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleVoucherSelected = (id) => {
    setSelectedVoucherIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allOnPageSelected = paginatedVouchers.length > 0 && paginatedVouchers.every(v => selectedVoucherIds.has(v.id));
  const someOnPageSelected = paginatedVouchers.some(v => selectedVoucherIds.has(v.id));

  const toggleSelectAllOnPage = () => {
    setSelectedVoucherIds(prev => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        paginatedVouchers.forEach(v => next.delete(v.id));
      } else {
        paginatedVouchers.forEach(v => next.add(v.id));
      }
      return next;
    });
  };

  const selectedVouchers = useMemo(
    () => vouchers.filter(v => selectedVoucherIds.has(v.id)),
    [vouchers, selectedVoucherIds]
  );

  // Preview of the bulk adjustment: which vouchers will shift, which will be
  // skipped (no expiry date), and how many end up with a past expiry.
  const bulkExpiryPreview = useMemo(() => {
    const days = parseInt(bulkExpiryDays, 10);
    const validDays = Number.isFinite(days) && days > 0 ? days : 0;
    const signedDays = bulkExpiryDirection === 'reduce' ? -validDays : validDays;
    const now = new Date();
    const adjustable = [];
    const skipped = [];
    let movesIntoPast = 0;
    for (const v of selectedVouchers) {
      if (!v.expires_at) {
        skipped.push(v);
        continue;
      }
      const newDate = new Date(v.expires_at);
      newDate.setDate(newDate.getDate() + signedDays);
      if (validDays > 0 && newDate < now) movesIntoPast += 1;
      adjustable.push({ voucher: v, newDate });
    }
    return { validDays, signedDays, adjustable, skipped, movesIntoPast };
  }, [selectedVouchers, bulkExpiryDays, bulkExpiryDirection]);

  const openBulkExpiryDialog = () => {
    setBulkExpiryDays("");
    setBulkExpiryDirection("extend");
    setShowBulkExpiryDialog(true);
  };

  const handleBulkExpiryApply = async () => {
    const { validDays, adjustable, skipped } = bulkExpiryPreview;
    if (!validDays) {
      toast.error('Enter a number of days greater than 0');
      return;
    }
    if (adjustable.length === 0) {
      toast.error('None of the selected vouchers have an expiry date to adjust');
      return;
    }
    setIsBulkAdjusting(true);
    const now = new Date();
    let updated = 0;
    const failures = [];
    for (const { voucher, newDate } of adjustable) {
      // Recompute status from the new expiry, consistent with how the rest of
      // the voucher system derives expired/active from expires_at. 'used'
      // vouchers keep their status.
      const data = { expires_at: newDate.toISOString() };
      if (voucher.status === 'expired' && newDate >= now) {
        data.status = 'active';
      } else if (voucher.status === 'active' && newDate < now) {
        data.status = 'expired';
      }
      try {
        await base44.entities.Voucher.update(voucher.id, data);
        updated += 1;
      } catch (err) {
        failures.push({ code: voucher.code, error: err.message });
      }
    }
    setIsBulkAdjusting(false);
    queryClient.invalidateQueries({ queryKey: ['vouchers-admin'] });
    queryClient.invalidateQueries({ queryKey: ['voucher-transactions'] });

    const parts = [`${updated} voucher${updated === 1 ? '' : 's'} updated`];
    if (skipped.length > 0) parts.push(`${skipped.length} skipped (no expiry date)`);
    if (failures.length > 0) parts.push(`${failures.length} failed`);
    const summary = parts.join(', ');
    if (failures.length > 0) {
      toast.error(`${summary}. First error: ${failures[0].error}`);
    } else if (updated > 0) {
      toast.success(summary);
    } else {
      toast.info(summary);
    }
    if (failures.length === 0) {
      setSelectedVoucherIds(new Set());
      setShowBulkExpiryDialog(false);
    } else {
      // Keep only failed vouchers selected so the admin can retry
      const failedCodes = new Set(failures.map(f => f.code));
      setSelectedVoucherIds(new Set(
        adjustable.filter(a => failedCodes.has(a.voucher.code)).map(a => a.voucher.id)
      ));
      setShowBulkExpiryDialog(false);
    }
  };

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
  }, [searchTerm, statusFilter, orgFilter, showExpired, dateFilterField, dateFilterFrom, dateFilterTo]);

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
    setExportDateField('issued');
    setExportDateFallbackField('');
    setExportExcludeExpired(false);
    setExportEmptyMessage("");
    setActiveExportReportId(null);
    // Pick up reports other admins may have saved since the last open.
    refetchExportReports();
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

  const parseIsoDateOnly = (str) => {
    if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
    const [y, m, d] = str.split('-').map(n => parseInt(n, 10));
    const date = new Date(y, m - 1, d);
    if (
      date.getFullYear() !== y ||
      date.getMonth() !== m - 1 ||
      date.getDate() !== d
    ) return null;
    return date;
  };

  // Snapshot the current export dialog settings as a saved-report config.
  // Normalized (column order fixed, org ids sorted) so configs can be
  // compared for the "Modified" indicator.
  const serializeExportConfig = () => ({
    columns: ALL_EXPORT_COLUMN_KEYS.filter(k => exportColumns.has(k)),
    fromDate: exportFromDate ? toIsoDateOnly(exportFromDate) : null,
    toDate: exportToDate ? toIsoDateOnly(exportToDate) : null,
    dateField: exportDateField,
    dateFallbackField: exportDateFallbackField || null,
    allOrgs: exportAllOrgs,
    orgIds: exportAllOrgs ? [] : Array.from(exportOrgIds).sort(),
    sortRules: exportSortRules.map(r => ({
      field: r.field,
      dir: r.dir === 'desc' ? 'desc' : 'asc',
      fallback: r.fallback || null,
    })),
    suppressTransactions: exportSuppressTransactions,
  });

  // Hydrate the export dialog state from a saved report config, gracefully
  // dropping anything that no longer exists (columns, fields, org ids).
  const applyExportReport = (report) => {
    const cfg = report?.config || {};

    const cols = Array.isArray(cfg.columns)
      ? ALL_EXPORT_COLUMN_KEYS.filter(k => cfg.columns.includes(k))
      : [];
    setExportColumns(new Set(cols.length > 0 ? cols : ALL_EXPORT_COLUMN_KEYS));

    setExportFromDate(parseIsoDateOnly(cfg.fromDate));
    setExportToDate(parseIsoDateOnly(cfg.toDate));

    const normalizedDateField = normalizeExportDateField(cfg.dateField);
    const dateField = EXPORT_DATE_FILTER_FIELDS.some(f => f.key === normalizedDateField)
      ? normalizedDateField
      : 'issued';
    setExportDateField(dateField);
    const normalizedFallback = normalizeExportDateField(cfg.dateFallbackField);
    const fallbackField =
      normalizedFallback &&
      normalizedFallback !== dateField &&
      EXPORT_DATE_FILTER_FIELDS.some(f => f.key === normalizedFallback)
        ? normalizedFallback
        : '';
    setExportDateFallbackField(fallbackField);

    // Skip organisation ids that no longer resolve. Only filter against the
    // loaded org list when we actually have one, so a slow orgs query can't
    // wipe a valid selection.
    const knownOrgIds = new Set(organizations.map(o => o.id));
    const rawOrgIds = Array.isArray(cfg.orgIds) ? cfg.orgIds : [];
    const resolvedOrgIds = organizations.length > 0
      ? rawOrgIds.filter(id => knownOrgIds.has(id))
      : rawOrgIds;
    // Keep the stored all-orgs/restricted choice as configured. If every
    // stored org id has stopped resolving, the selection ends up empty and
    // the existing pre-export validation asks the admin to re-select rather
    // than silently exporting every organisation.
    const allOrgs = cfg.allOrgs !== false;
    setExportAllOrgs(allOrgs);
    setExportOrgIds(new Set(allOrgs ? [] : resolvedOrgIds));
    setExportOrgSearch("");

    // Rebuild sort rules, dropping unknown/duplicate fields and any fallback
    // that no longer matches the primary field's data type.
    const seenSortFields = new Set();
    const sortRules = (Array.isArray(cfg.sortRules) ? cfg.sortRules : [])
      .filter(r =>
        r &&
        typeof r === 'object' &&
        EXPORT_SORT_FIELD_TYPES[r.field] &&
        !seenSortFields.has(r.field) &&
        (seenSortFields.add(r.field) || true)
      )
      .map(r => ({
        field: r.field,
        dir: r.dir === 'desc' ? 'desc' : 'asc',
        fallback:
          r.fallback &&
          r.fallback !== r.field &&
          EXPORT_SORT_FIELD_TYPES[r.fallback] === EXPORT_SORT_FIELD_TYPES[r.field]
            ? r.fallback
            : '',
      }));
    setExportSortRules(
      sortRules.length > 0 ? sortRules : DEFAULT_EXPORT_SORT_RULES.map(r => ({ ...r }))
    );

    setExportSuppressTransactions(cfg.suppressTransactions === true);

    setExportEmptyMessage("");
    setActiveExportReportId(report.id);
  };

  const exportReportIsDirty = useMemo(() => {
    if (!activeExportReport) return false;
    // Normalize the stored config through the same shape rules used when
    // serializing so cosmetic differences (missing keys, order) don't count.
    const stored = activeExportReport.config || {};
    const normalizedStored = {
      columns: Array.isArray(stored.columns)
        ? ALL_EXPORT_COLUMN_KEYS.filter(k => stored.columns.includes(k))
        : [],
      fromDate: typeof stored.fromDate === 'string' ? stored.fromDate : null,
      toDate: typeof stored.toDate === 'string' ? stored.toDate : null,
      dateField: normalizeExportDateField(stored.dateField) || 'issued',
      dateFallbackField: normalizeExportDateField(stored.dateFallbackField) || null,
      allOrgs: stored.allOrgs !== false,
      orgIds: Array.isArray(stored.orgIds) ? [...stored.orgIds].sort() : [],
      sortRules: (Array.isArray(stored.sortRules) ? stored.sortRules : []).map(r => ({
        field: r?.field,
        dir: r?.dir === 'desc' ? 'desc' : 'asc',
        fallback: r?.fallback || null,
      })),
      suppressTransactions: stored.suppressTransactions === true,
    };
    return JSON.stringify(serializeExportConfig()) !== JSON.stringify(normalizedStored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeExportReport,
    exportColumns,
    exportFromDate,
    exportToDate,
    exportDateField,
    exportDateFallbackField,
    exportAllOrgs,
    exportOrgIds,
    exportSortRules,
    exportSuppressTransactions,
  ]);

  const handleConfirmExport = async () => {
    setExportEmptyMessage("");
    if (!exportSuppressTransactions && exportColumns.size === 0) {
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
    if (!exportSuppressTransactions && exportSortRules.length === 0) {
      toast.error('Add at least one sort rule');
      return;
    }
    if (!exportSuppressTransactions) {
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
      if (exportSuppressTransactions) {
        // Vouchers-only mode: fixed voucher-level columns and sort on the
        // server; the column selector and sort rules don't apply.
        params.set('vouchers_only', 'true');
      } else {
        const orderedCols = ALL_EXPORT_COLUMN_KEYS.filter(k => exportColumns.has(k));
        params.set('columns', orderedCols.join(','));
      }
      if (exportFromDate) params.set('from', toIsoDateOnly(exportFromDate));
      if (exportToDate) params.set('to', toIsoDateOnly(exportToDate));
      if (exportFromDate || exportToDate) {
        params.set('date_field', exportDateField);
        if (exportDateFallbackField) {
          params.set('date_fallback_field', exportDateFallbackField);
        }
        if (exportExcludeExpired) {
          params.set('exclude_expired_in_range', 'true');
        }
      }
      if (!exportAllOrgs) params.set('organization_ids', Array.from(exportOrgIds).join(','));
      // The page's active voucher date-range filter narrows the export to
      // the same vouchers shown in the list, like the other filters do.
      // When the export dialog applies its own range on the SAME field,
      // the dialog's range supersedes the page filter so the two never
      // apply contradictory ranges to one field. Different fields combine
      // (both must match).
      const exportRangeActive = !!(exportFromDate || exportToDate);
      const pageFilterSuperseded =
        exportRangeActive && exportDateField === dateFilterField;
      if (dateFilterActive && !pageFilterSuperseded) {
        params.set('voucher_date_field', dateFilterField);
        if (dateFilterFrom) params.set('voucher_from', dateFilterFrom);
        if (dateFilterTo) params.set('voucher_to', dateFilterTo);
      }
      if (!exportSuppressTransactions) {
        for (const rule of exportSortRules) {
          const parts = [rule.field, rule.dir];
          if (rule.fallback) parts.push(rule.fallback);
          params.append('sort', parts.join(':'));
        }
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
        setExportEmptyMessage(exportSuppressTransactions
          ? 'No vouchers match the selected filters. Adjust your filters and try again.'
          : 'No transactions match the selected filters. Adjust your filters and try again.');
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const today = new Date().toISOString().split('T')[0];
      link.download = exportSuppressTransactions
        ? `training_vouchers_${today}.csv`
        : `training_voucher_transactions_${today}.csv`;
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

  const handleExportCurrentView = () => {
    if (filteredVouchers.length === 0) {
      toast.error('No vouchers to export in the current view');
      return;
    }
    const escapeCsv = (val) => {
      const s = val == null ? '' : String(val);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const deriveStatus = (v) => {
      if (v.status === 'used') return 'Used';
      const isExpired = v.expires_at && new Date(v.expires_at) < new Date();
      if (isExpired || v.status === 'expired') return 'Expired';
      if (v.status === 'active') return 'Active';
      return v.status || '';
    };
    const fmtDate = (d) => {
      if (!d) return '';
      const dt = new Date(d);
      return isNaN(dt.getTime()) ? '' : format(dt, 'yyyy-MM-dd');
    };
    const header = ['Code', 'Organisation', 'Description', 'Status', 'Value (£)', 'Awarded', 'Expires', 'Used On'];
    const rows = filteredVouchers.map(v => [
      v.code || '',
      organizations.find(o => o.id === v.organization_id)?.name || 'Unknown Organisation',
      v.description || '',
      deriveStatus(v),
      (v.value || 0).toFixed(2),
      fmtDate(v.issued_at || v.created_at),
      fmtDate(v.expires_at),
      fmtDate(v.used_at)
    ]);
    const csv = [header, ...rows].map(r => r.map(escapeCsv).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const today = new Date().toISOString().split('T')[0];
    link.download = `training_vouchers_current_view_${today}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success('CSV file downloaded successfully');
  };

  const handleCreateNew = () => {
    setEditingVoucher({
      organization_id: "",
      code: "",
      value: 0,
      description: "",
      issued_at: format(new Date(), "yyyy-MM-dd"),
      expires_at: "",
      status: "active",
      valid_from: "",
      funding_source: "",
      notes: ""
    });
    setShowDialog(true);
  };

  const handleEdit = (voucher) => {
    const issuedSource = voucher.issued_at || voucher.created_at;
    setEditingVoucher({
      ...voucher,
      issued_at: issuedSource ? format(new Date(issuedSource), "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd"),
      expires_at: voucher.expires_at ? format(new Date(voucher.expires_at), "yyyy-MM-dd") : "",
      valid_from: voucher.valid_from ? format(new Date(voucher.valid_from), "yyyy-MM-dd") : "",
      funding_source: voucher.funding_source || "",
      notes: voucher.notes || "",
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
      status: editingVoucher.status,
      valid_from: editingVoucher.valid_from ? new Date(editingVoucher.valid_from).toISOString() : null,
      funding_source: editingVoucher.funding_source || "",
      notes: editingVoucher.notes || ""
    };

    if (!editingVoucher.id && memberInfo?.email) {
      data.created_by = memberInfo.email;
    }

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
      case 'cancellation_refund': return { label: 'Cancellation Refund', color: 'bg-green-100 text-green-800' };
      case 'voucher_awarded': return { label: 'Awarded', color: 'bg-green-100 text-green-800' };
      case 'credit_adjustment': return { label: 'Credit', color: 'bg-green-100 text-green-800' };
      case 'debit_adjustment': return { label: 'Debit', color: 'bg-warning/10 text-warning' };
      case 'adjustment': return { label: 'Adjustment', color: 'bg-warning/10 text-warning' };
      case 'expiry': return { label: 'Expired', color: 'bg-red-100 text-red-800' };
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
                          
                          {transaction.usage_description && (
                            <p className="text-slate-700 mb-1" data-testid={`text-usage-${transaction.id}`}>
                              {transaction.usage_description}
                            </p>
                          )}

                          {(transaction.event_date || transaction.event_internal_reference) && (
                            <p className="text-sm text-slate-500 mb-1" data-testid={`text-event-detail-${transaction.id}`}>
                              {[
                                transaction.event_date ? `Event date: ${format(new Date(transaction.event_date), 'dd MMM yyyy')}` : null,
                                transaction.event_internal_reference ? `Ref: ${transaction.event_internal_reference}` : null,
                              ].filter(Boolean).join(' · ')}
                            </p>
                          )}

                          {transaction.booking_reference && (
                            <p className="text-sm text-slate-500 mb-2">
                              Booking: {transaction.booking_reference}
                            </p>
                          )}

                          {transaction.notes && (
                            <p className="text-sm text-slate-500 mb-2" data-testid={`text-txn-notes-${transaction.id}`}>
                              Notes: {transaction.notes}
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
                          
                          {(transaction.member_name || transaction.member_email) && (
                            <p className="text-xs text-slate-400 mt-2" data-testid={`text-used-by-${transaction.id}`}>
                              Used by: {transaction.member_name || transaction.member_email}
                              {transaction.member_name && transaction.member_email ? ` (${transaction.member_email})` : ''}
                            </p>
                          )}
                        </div>
                        
                        <div className="text-right flex-shrink-0">
                          {['credit_adjustment', 'cancellation_refund', 'voucher_awarded'].includes(transaction.type) ? (
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
                Report Generator
              </Button>
            )}
            {isAdmin && (
              <Button
                variant="outline"
                onClick={handleExportCurrentView}
                disabled={filteredVouchers.length === 0}
                className="gap-2"
                data-testid="button-export-current-view-csv"
              >
                <Download className="w-4 h-4" />
                Export current view
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

                <div className="flex flex-wrap items-center gap-2">
                  <Select value={dateFilterField} onValueChange={setDateFilterField}>
                    <SelectTrigger className="w-[130px]" data-testid="select-date-filter-field">
                      <SelectValue placeholder="Date field" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="issued">Issued date</SelectItem>
                      <SelectItem value="expiry">Expiry date</SelectItem>
                      <SelectItem value="used">Used date</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    type="date"
                    value={dateFilterFrom}
                    onChange={(e) => setDateFilterFrom(e.target.value)}
                    className="w-[150px]"
                    aria-label="From date"
                    data-testid="input-date-filter-from"
                  />
                  <span className="text-sm text-slate-400">to</span>
                  <Input
                    type="date"
                    value={dateFilterTo}
                    onChange={(e) => setDateFilterTo(e.target.value)}
                    className="w-[150px]"
                    aria-label="To date"
                    data-testid="input-date-filter-to"
                  />
                  {dateFilterActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setDateFilterFrom(""); setDateFilterTo(""); }}
                      data-testid="button-clear-date-filter"
                    >
                      Clear dates
                    </Button>
                  )}
                  {dateFilterField === 'used' && dateFilterActive && loadingRedemptionDates && (
                    <Loader2 className="w-4 h-4 animate-spin text-slate-400" aria-label="Loading redemption dates" />
                  )}
                </div>

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
                    onClick={() => { setSearchTerm(""); setStatusFilter("all"); setOrgFilter("all"); setShowExpired(true); setDateFilterFrom(""); setDateFilterTo(""); }}
                  >
                    Clear Filters
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 flex-wrap px-1">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={allOnPageSelected ? true : (someOnPageSelected ? 'indeterminate' : false)}
                      onCheckedChange={toggleSelectAllOnPage}
                      aria-label="Select all vouchers on this page"
                      data-testid="checkbox-select-all-page"
                    />
                    <span className="text-sm text-slate-600">Select all on this page</span>
                    {selectedVoucherIds.size > 0 && (
                      <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200" data-testid="badge-selected-count">
                        {selectedVoucherIds.size} selected
                      </Badge>
                    )}
                  </div>
                  {selectedVoucherIds.size > 0 && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedVoucherIds(new Set())}
                        data-testid="button-clear-selection"
                      >
                        Clear selection
                      </Button>
                      <Button
                        size="sm"
                        onClick={openBulkExpiryDialog}
                        className="bg-blue-600 hover:bg-blue-700"
                        data-testid="button-bulk-adjust-expiry"
                      >
                        <CalendarIcon className="w-4 h-4 mr-2" />
                        Adjust expiry dates
                      </Button>
                    </div>
                  )}
                </div>
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
                          <div
                            className="flex-shrink-0 pt-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Checkbox
                              checked={selectedVoucherIds.has(voucher.id)}
                              onCheckedChange={() => toggleVoucherSelected(voucher.id)}
                              aria-label={`Select voucher ${voucher.code}`}
                              data-testid={`checkbox-select-voucher-${voucher.id}`}
                            />
                          </div>
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

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="valid_from">Valid From</Label>
                    <Input
                      id="valid_from"
                      type="date"
                      value={editingVoucher.valid_from || ""}
                      onChange={(e) => setEditingVoucher({ ...editingVoucher, valid_from: e.target.value })}
                      data-testid="input-voucher-valid-from"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="funding_source">Funding Source / Reason</Label>
                    <Input
                      id="funding_source"
                      value={editingVoucher.funding_source || ""}
                      onChange={(e) => setEditingVoucher({ ...editingVoucher, funding_source: e.target.value })}
                      placeholder="e.g., Regional training grant"
                      data-testid="input-voucher-funding-source"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="voucher_notes">Notes</Label>
                  <Input
                    id="voucher_notes"
                    value={editingVoucher.notes || ""}
                    onChange={(e) => setEditingVoucher({ ...editingVoucher, notes: e.target.value })}
                    placeholder="Optional notes about this allocation"
                    data-testid="input-voucher-notes"
                  />
                </div>

                {editingVoucher.id && editingVoucher.created_by && (
                  <p className="text-xs text-slate-500" data-testid="text-voucher-created-by">
                    Created by: {editingVoucher.created_by}
                  </p>
                )}
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

        <Dialog open={showBulkExpiryDialog} onOpenChange={(open) => { if (!isBulkAdjusting) setShowBulkExpiryDialog(open); }}>
          <DialogContent className="max-w-md" data-testid="dialog-bulk-adjust-expiry">
            <DialogHeader>
              <DialogTitle>Adjust expiry dates</DialogTitle>
              <DialogDescription>
                Shift the expiry date of {selectedVoucherIds.size} selected voucher{selectedVoucherIds.size === 1 ? '' : 's'} forward or backward by a number of days.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <Label htmlFor="bulk-expiry-days">Number of days</Label>
                  <Input
                    id="bulk-expiry-days"
                    type="number"
                    min="1"
                    step="1"
                    value={bulkExpiryDays}
                    onChange={(e) => setBulkExpiryDays(e.target.value)}
                    placeholder="e.g. 7"
                    data-testid="input-bulk-expiry-days"
                  />
                </div>
                <div className="flex-1">
                  <Label>Direction</Label>
                  <Select value={bulkExpiryDirection} onValueChange={setBulkExpiryDirection}>
                    <SelectTrigger data-testid="select-bulk-expiry-direction">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="extend">Extend (later)</SelectItem>
                      <SelectItem value="reduce">Reduce (earlier)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {bulkExpiryPreview.validDays > 0 && (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800" data-testid="text-bulk-expiry-preview">
                  Expiry will move {bulkExpiryPreview.validDays} day{bulkExpiryPreview.validDays === 1 ? '' : 's'} {bulkExpiryDirection === 'reduce' ? 'earlier' : 'later'} for {bulkExpiryPreview.adjustable.length} voucher{bulkExpiryPreview.adjustable.length === 1 ? '' : 's'}.
                  {' '}Vouchers that become expired or active as a result will have their status updated.
                </div>
              )}

              {bulkExpiryPreview.skipped.length > 0 && (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600" data-testid="text-bulk-expiry-skipped">
                  {bulkExpiryPreview.skipped.length} selected voucher{bulkExpiryPreview.skipped.length === 1 ? ' has' : 's have'} no expiry date and will be skipped.
                </div>
              )}

              {bulkExpiryPreview.validDays > 0 && bulkExpiryPreview.movesIntoPast > 0 && (
                <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning flex items-start gap-2" data-testid="text-bulk-expiry-past-warning">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>
                    {bulkExpiryPreview.movesIntoPast} voucher{bulkExpiryPreview.movesIntoPast === 1 ? "'s" : "s'"} new expiry date will be in the past — {bulkExpiryPreview.movesIntoPast === 1 ? 'it' : 'they'} will become expired.
                  </span>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowBulkExpiryDialog(false)} disabled={isBulkAdjusting}>
                Cancel
              </Button>
              <Button
                onClick={handleBulkExpiryApply}
                disabled={isBulkAdjusting || !bulkExpiryPreview.validDays || bulkExpiryPreview.adjustable.length === 0}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-confirm-bulk-expiry"
              >
                {isBulkAdjusting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Updating...
                  </>
                ) : (
                  'Apply adjustment'
                )}
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

            {dateFilterActive && (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800" data-testid="text-export-list-date-filter-note">
                {(exportFromDate || exportToDate) && exportDateField === dateFilterField ? (
                  <>
                    The page's active date filter uses the same field ({dateFilterField === 'used' ? 'Used' : dateFilterField === 'expiry' ? 'Expiry' : 'Issued'} date)
                    as this export, so the export's From/To range below replaces it — no double filtering.
                  </>
                ) : (
                  <>
                    The page's active date filter ({dateFilterField === 'used' ? 'Used' : dateFilterField === 'expiry' ? 'Expiry' : 'Issued'} date
                    {dateFilterFrom ? `, from ${dateFilterFrom}` : ''}{dateFilterTo ? `, to ${dateFilterTo}` : ''}) will also be applied:
                    only transactions for vouchers matching that range are exported. Clear the date filter on the page to export everything.
                  </>
                )}
              </div>
            )}

            <div className="space-y-6">
              <div>
                <Label className="text-sm font-medium">Saved report</Label>
                <div className="mt-1">
                  <ExportReportSwitcher
                    reports={exportReports}
                    activeReportId={activeExportReportId}
                    isDirty={exportReportIsDirty}
                    isSaving={isSavingExportReport}
                    onApplyReport={applyExportReport}
                    onClearReport={() => setActiveExportReportId(null)}
                    onCreateReport={async (name) => {
                      const report = await createExportReport(name, serializeExportConfig());
                      if (report?.id) setActiveExportReportId(report.id);
                    }}
                    onUpdateReport={(report) => updateExportReport(report.id, serializeExportConfig())}
                    onRenameReport={(report, name) => renameExportReport(report.id, name)}
                    onDeleteReport={(report) => deleteExportReport(report.id)}
                    testIdPrefix="voucher-export-report"
                  />
                </div>
              </div>

              <div>
                <label
                  className="flex items-center gap-2 text-sm cursor-pointer"
                  data-testid="label-export-voucher-suppress-transactions"
                >
                  <Checkbox
                    checked={exportSuppressTransactions}
                    onCheckedChange={(v) => setExportSuppressTransactions(v === true)}
                    data-testid="checkbox-export-voucher-suppress-transactions"
                  />
                  <span>Suppress transactions</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1">
                  Export one row per voucher (organisation, code, description, issued and expiry dates, initial and current balance) instead of one row per transaction. Date and organisation filters still apply.
                </p>
              </div>

              {!exportSuppressTransactions && (
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
              )}

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
                <label
                  className={`flex items-center gap-2 text-sm ${(exportFromDate || exportToDate) ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                  data-testid="label-export-voucher-exclude-expired"
                >
                  <Checkbox
                    checked={exportExcludeExpired && !!(exportFromDate || exportToDate)}
                    disabled={!exportFromDate && !exportToDate}
                    onCheckedChange={(v) => setExportExcludeExpired(v === true)}
                    data-testid="checkbox-export-voucher-exclude-expired"
                  />
                  <span>Exclude vouchers that expired in this date range</span>
                </label>
                {!exportFromDate && !exportToDate && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Set a From and/or To date to enable this option.
                  </p>
                )}
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

              {!exportSuppressTransactions && (
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
              )}

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
                disabled={isExporting || (!exportSuppressTransactions && exportColumns.size === 0)}
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
