import React, { useState, useEffect, useMemo, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Building2, Search, ChevronLeft, ChevronRight, Plus, Minus, Wallet, TrendingUp, TrendingDown, History, ArrowLeft, X, Wifi, Download, Loader2, AlertTriangle, CalendarIcon, ArrowUp, ArrowDown, Trash2, Clock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useAdminBalancesRealtime } from "@/hooks/useAdminBalancesRealtime";
import { useSavedExportReports } from "@/hooks/useSavedExportReports";
import ExportReportSwitcher from "@/components/ExportReportSwitcher";
import { listOrganizationsForAdmin } from '@/lib/adminOrgList';

const ITEMS_PER_PAGE = 15;

const EXPORT_COLUMN_DEFS = [
  { key: 'organization', label: 'Organisation' },
  { key: 'date', label: 'Date' },
  { key: 'type', label: 'Type' },
  { key: 'balance_before', label: 'Balance Before' },
  { key: 'amount', label: 'Amount' },
  { key: 'balance_after', label: 'Balance After' },
  { key: 'reason', label: 'Reason' },
  { key: 'created_by', label: 'Created By' },
  { key: 'event_internal_reference', label: 'Event Internal Reference' },
  { key: 'event_date', label: 'Event Date' },
];
const ALL_EXPORT_COLUMN_KEYS = EXPORT_COLUMN_DEFS.map(c => c.key);

const EXPORT_SORT_FIELDS = EXPORT_COLUMN_DEFS.map(c => ({ key: c.key, label: c.label }));

// Data type for each sortable field, used to filter the "If empty, use"
// dropdown so fallbacks are restricted to fields of the same type.
const EXPORT_SORT_FIELD_TYPES = {
  organization: 'text',
  date: 'date',
  type: 'text',
  balance_before: 'number',
  amount: 'number',
  balance_after: 'number',
  reason: 'text',
  created_by: 'text',
  event_internal_reference: 'text',
  event_date: 'date',
};
const DEFAULT_EXPORT_SORT_RULES = [{ field: 'organization', dir: 'asc', fallback: '' }];

// Date columns the from/to range filter can be applied against. Derived from
// EXPORT_SORT_FIELD_TYPES so it stays in sync with the columns above.
const EXPORT_DATE_FILTER_FIELDS = EXPORT_COLUMN_DEFS.filter(
  c => EXPORT_SORT_FIELD_TYPES[c.key] === 'date'
);

export default function TrainingFundManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
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
    settingKey: 'training_fund_export_reports',
    description: 'Training fund export saved reports',
    enabled: !!accessChecked,
  });

  const [searchTerm, setSearchTerm] = useState("");
  const [balanceFilter, setBalanceFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  
  const [adjustingOrg, setAdjustingOrg] = useState(null);
  const [adjustmentType, setAdjustmentType] = useState("add");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [adjustmentDate, setAdjustmentDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [showAdjustDialog, setShowAdjustDialog] = useState(false);
  
  const [selectedOrg, setSelectedOrg] = useState(null);
  
  const queryClient = useQueryClient();

  // Realtime callbacks for admin updates
  const handleTransactionUpdated = useCallback(({ eventType, transaction }) => {
    console.log('[TrainingFundManagement] Transaction updated via realtime:', eventType, transaction?.id);
    if (eventType === 'INSERT') {
      toast.info('New transaction recorded', {
        description: 'A training fund transaction was just created.',
        duration: 3000
      });
    }
  }, []);

  const handleOrganizationUpdated = useCallback(({ organization, oldBalance, newBalance }) => {
    console.log('[TrainingFundManagement] Organization updated via realtime:', organization?.id);
    toast.info('Training fund balance updated', {
      description: `${organization?.name}: £${(oldBalance || 0).toFixed(2)} → £${(newBalance || 0).toFixed(2)}`,
      duration: 3000
    });
  }, []);

  // Subscribe to realtime updates
  const { isConnected: realtimeConnected } = useAdminBalancesRealtime({
    onTrainingFundTransactionUpdated: handleTransactionUpdated,
    onOrganizationUpdated: handleOrganizationUpdated
  });

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_TrainingFundManagement')) {
        window.location.href = createPageUrl('Dashboard');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: organizations = [], isLoading: loadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => listOrganizationsForAdmin(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: driftSummaryData, isLoading: loadingDriftSummary } = useQuery({
    queryKey: ['training-fund-transactions', 'drift-summary'],
    queryFn: async () => {
      const res = await fetch('/api/admin/training-fund-transactions/drift-summary', {
        credentials: 'include'
      });
      if (!res.ok) {
        let msg = 'Failed to load drift summary';
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
        throw new Error(msg);
      }
      return res.json();
    },
    enabled: !!accessChecked,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: orgTransactionsData, isLoading: loadingOrgTransactions } = useQuery({
    queryKey: ['training-fund-transactions', 'by-organization', selectedOrg?.id],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/training-fund-transactions/by-organization?organization_id=${encodeURIComponent(selectedOrg.id)}`,
        { credentials: 'include' }
      );
      if (!res.ok) {
        let msg = 'Failed to load transactions';
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
        throw new Error(msg);
      }
      return res.json();
    },
    enabled: !!selectedOrg?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: members = [] } = useQuery({
    queryKey: ['members-for-transactions'],
    queryFn: () => base44.entities.Member.list(),
    staleTime: 60000,
  });

  const memberMap = useMemo(() => {
    const map = {};
    members.forEach(m => { map[m.id] = m; });
    return map;
  }, [members]);

  // Server returns transactions oldest -> newest for the selected org. Display the card list newest -> oldest.
  const selectedOrgTransactionsAsc = useMemo(() => {
    if (!selectedOrg) return [];
    const fromServer = orgTransactionsData?.transactions;
    return Array.isArray(fromServer) ? fromServer : [];
  }, [orgTransactionsData, selectedOrg]);

  const selectedOrgTransactions = useMemo(
    () => [...selectedOrgTransactionsAsc].reverse(),
    [selectedOrgTransactionsAsc]
  );

  const signedAmountFor = (transaction) => {
    const beforeRaw = transaction.balance_before;
    const afterRaw = transaction.balance_after;
    const before = beforeRaw === null || beforeRaw === undefined || beforeRaw === '' ? NaN : Number(beforeRaw);
    const after = afterRaw === null || afterRaw === undefined || afterRaw === '' ? NaN : Number(afterRaw);
    if (Number.isFinite(before) && Number.isFinite(after)) {
      return { value: after - before, verified: true };
    }
    const amount = Math.abs(Number(transaction.amount) || 0);
    const sign = transaction.type === 'add' ? 1 : -1;
    return { value: sign * amount, verified: false };
  };

  const reconciliation = useMemo(() => {
    if (!selectedOrg) return null;
    const txns = selectedOrgTransactionsAsc;
    const currentBalance = Number(
      orgTransactionsData?.current_balance ?? selectedOrg.training_fund_balance ?? 0
    );
    const sumDeltas = txns.reduce((acc, t) => acc + signedAmountFor(t).value, 0);
    const opening = txns.length > 0 ? Number(txns[0].balance_before) || 0 : 0;
    const sumWithOpening = opening + sumDeltas;
    const drift = currentBalance - sumWithOpening;
    return {
      currentBalance,
      opening,
      sumDeltas,
      sumWithOpening,
      drift,
      hasDrift: Math.abs(drift) > 0.005
    };
  }, [selectedOrg, selectedOrgTransactionsAsc, orgTransactionsData]);

  // Compute drift per organisation from the server-side drift summary so we
  // are not subject to the generic entity endpoint's row cap.
  const orgDriftMap = useMemo(() => {
    const summary = driftSummaryData?.summary || {};
    const result = {};
    organizations.forEach(org => {
      const balance = Number(org.training_fund_balance) || 0;
      const bucket = summary[org.id];
      if (!bucket) {
        // No transactions for this org. Any non-zero stored balance is drift.
        result[org.id] = {
          drift: balance,
          hasDrift: Math.abs(balance) > 0.005,
          unknown: !driftSummaryData
        };
        return;
      }
      const expected = (Number(bucket.opening) || 0) + (Number(bucket.sum_deltas) || 0);
      const drift = balance - expected;
      result[org.id] = {
        drift,
        hasDrift: Math.abs(drift) > 0.005,
        unknown: false
      };
    });
    return result;
  }, [organizations, driftSummaryData]);

  const filteredOrgs = useMemo(() => {
    let filtered = organizations;
    
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(org => 
        org.name?.toLowerCase().includes(term)
      );
    }
    
    if (balanceFilter === "with_balance") {
      filtered = filtered.filter(org => (org.training_fund_balance || 0) > 0);
    } else if (balanceFilter === "zero_balance") {
      filtered = filtered.filter(org => (org.training_fund_balance || 0) === 0);
    } else if (balanceFilter === "with_pending") {
      filtered = filtered.filter(org => (org.training_fund_pending_balance || 0) > 0);
    }
    
    return filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [organizations, searchTerm, balanceFilter]);

  const totalPages = Math.ceil(filteredOrgs.length / ITEMS_PER_PAGE);
  const paginatedOrgs = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredOrgs.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredOrgs, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, balanceFilter]);

  const totalFunds = useMemo(() => {
    return filteredOrgs.reduce((sum, org) => sum + (org.training_fund_balance || 0), 0);
  }, [filteredOrgs]);

  const orgsWithFunds = useMemo(() => {
    return filteredOrgs.filter(org => (org.training_fund_balance || 0) > 0).length;
  }, [filteredOrgs]);

  const totalPending = useMemo(() => {
    return filteredOrgs.reduce((sum, org) => sum + (org.training_fund_pending_balance || 0), 0);
  }, [filteredOrgs]);

  // Balance adjustments go through a dedicated admin endpoint that updates
  // the balance and writes the ledger row atomically server-side, so a
  // partial failure can never leave balance and ledger diverged.
  const updateBalanceMutation = useMutation({
    mutationFn: async ({ orgId, type, amount, reason, createdDate }) => {
      const res = await fetch('/api/admin/training-fund-transactions/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          organization_id: orgId,
          type,
          amount,
          reason: reason || undefined,
          created_date: createdDate || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to adjust balance');
      }
      return data;
    },
    onSuccess: () => {
      console.log('[TrainingFund] Mutation success - invalidating queries');
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['training-fund-transactions'] });
      setShowAdjustDialog(false);
      setAdjustingOrg(null);
      setAdjustmentAmount("");
      setAdjustmentReason("");
      toast.success('Training fund balance updated successfully');
    },
    onError: (error) => {
      console.error('[TrainingFund] Mutation error:', error);
      toast.error('Failed to update balance: ' + error.message);
    }
  });

  const handleAdjust = (org, e) => {
    if (e) e.stopPropagation();
    setAdjustingOrg(org);
    setAdjustmentType("add");
    setAdjustmentAmount("");
    setAdjustmentReason("");
    setAdjustmentDate(format(new Date(), 'yyyy-MM-dd'));
    setShowAdjustDialog(true);
  };

  const handleSaveAdjustment = () => {
    const amount = parseFloat(adjustmentAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error('Please enter a valid amount greater than 0');
      return;
    }

    if (!adjustmentDate || !/^\d{4}-\d{2}-\d{2}$/.test(adjustmentDate)) {
      toast.error('Please select a valid date');
      return;
    }
    const [year, month, day] = adjustmentDate.split('-').map(Number);
    const now = new Date();
    const chosenDate = new Date(year, month - 1, day, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
    if (isNaN(chosenDate.getTime()) || chosenDate.getFullYear() !== year || chosenDate.getMonth() !== month - 1 || chosenDate.getDate() !== day) {
      toast.error('Please select a valid date');
      return;
    }
    const todayStr = format(now, 'yyyy-MM-dd');
    if (adjustmentDate > todayStr) {
      toast.error('The transaction date cannot be in the future');
      return;
    }
    const createdDate = adjustmentDate === todayStr ? now.toISOString() : chosenDate.toISOString();

    if (adjustmentType === 'deduct' && (adjustingOrg.training_fund_balance || 0) - amount < 0) {
      toast.error('Cannot reduce balance below zero');
      return;
    }

    updateBalanceMutation.mutate({
      orgId: adjustingOrg.id,
      type: adjustmentType,
      amount,
      reason: adjustmentReason,
      createdDate
    });
  };

  const handleOrgClick = (org) => {
    setSelectedOrg(org);
  };

  const handleBackToList = () => {
    setSelectedOrg(null);
  };

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
    setActiveExportReportId(null);
    // Pick up reports other admins may have saved since the last open.
    refetchExportReports();
    setShowExportDialog(true);
  };

  const toggleExportColumn = (key) => {
    setExportColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size <= 1) return prev; // keep at least one column selected
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
      // If the field changed and the current fallback no longer matches the
      // new field's data type (or equals the new field), drop it.
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

    const dateField = EXPORT_DATE_FILTER_FIELDS.some(f => f.key === cfg.dateField)
      ? cfg.dateField
      : 'date';
    setExportDateField(dateField);
    const fallbackField =
      cfg.dateFallbackField &&
      cfg.dateFallbackField !== dateField &&
      EXPORT_DATE_FILTER_FIELDS.some(f => f.key === cfg.dateFallbackField)
        ? cfg.dateFallbackField
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
      dateField: stored.dateField || 'date',
      dateFallbackField: stored.dateFallbackField || null,
      allOrgs: stored.allOrgs !== false,
      orgIds: Array.isArray(stored.orgIds) ? [...stored.orgIds].sort() : [],
      sortRules: (Array.isArray(stored.sortRules) ? stored.sortRules : []).map(r => ({
        field: r?.field,
        dir: r?.dir === 'desc' ? 'desc' : 'asc',
        fallback: r?.fallback || null,
      })),
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
  ]);

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

      const response = await fetch(`/api/admin/training-fund-transactions/export-csv?${params.toString()}`, {
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
      link.download = `training_fund_transactions_${today}.csv`;
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

  const formatTransactionType = (type) => {
    switch (type) {
      case 'add': return { label: 'Added', color: 'bg-green-100 text-green-800' };
      case 'deduct': return { label: 'Deducted', color: 'bg-red-100 text-red-800' };
      case 'booking_usage': return { label: 'Booking', color: 'bg-blue-100 text-blue-800' };
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

  if (selectedOrg) {
    const orgBalance = Number(
      orgTransactionsData?.current_balance ?? selectedOrg.training_fund_balance ?? 0
    );
    const orgPending = Number(
      orgTransactionsData?.pending_balance ?? selectedOrg.training_fund_pending_balance ?? 0
    );
    const pendingPurchases = Array.isArray(orgTransactionsData?.pending_purchases)
      ? orgTransactionsData.pending_purchases
      : [];
    
    return (
      <div className="min-h-screen p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6">
            <Button 
              variant="ghost" 
              onClick={handleBackToList}
              className="mb-4"
              data-testid="button-back-to-list"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Organisations
            </Button>
            
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h1 className="text-2xl md:text-3xl font-bold text-slate-900 mb-1">
                  {selectedOrg.name}
                </h1>
                <p className="text-slate-600">Training Fund History</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-500">Current Balance</p>
                <p className={`text-3xl font-bold ${orgBalance > 0 ? 'text-green-600' : 'text-slate-400'}`}>
                  £{orgBalance.toFixed(2)}
                </p>
                {orgPending > 0 && (
                  <div className="flex items-center justify-end gap-1 text-sm text-amber-700 mt-1" data-testid="text-org-pending-balance">
                    <Clock className="w-3.5 h-3.5" />
                    <span>£{orgPending.toFixed(2)} pending (not yet spendable)</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <Card className="border-slate-200 shadow-sm mb-6">
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <History className="w-5 h-5 text-slate-500" />
                  <span className="font-medium text-slate-700">
                    {selectedOrgTransactions.length} {selectedOrgTransactions.length === 1 ? 'transaction' : 'transactions'}
                  </span>
                </div>
                <Button
                  onClick={() => handleAdjust(selectedOrg)}
                  data-testid="button-adjust-from-history"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Adjust Balance
                </Button>
              </div>
            </CardContent>
          </Card>

          {pendingPurchases.length > 0 && (
            <Card className="border-amber-200 shadow-sm mb-6" data-testid="card-pending-purchases">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2 text-amber-800">
                  <Clock className="w-4 h-4" />
                  Pending purchases — awaiting payment
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-sm text-slate-500 mb-3">
                  These purchases have been invoiced but not yet paid. The money is not spendable until the invoice is paid.
                </p>
                <div className="space-y-2">
                  {pendingPurchases.map((p) => {
                    const invoiceNumber = p.accounting_invoice_number || p.xero_invoice_number || null;
                    const invoiceUrl = typeof p.online_invoice_url === 'string' && /^https?:\/\//i.test(p.online_invoice_url)
                      ? p.online_invoice_url
                      : null;
                    return (
                      <div
                        key={p.id}
                        className="flex items-start justify-between gap-4 rounded-md border border-slate-200 p-3 flex-wrap"
                        data-testid={`row-pending-purchase-${p.id}`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <Badge className="bg-amber-100 text-amber-800">
                              {p.payment_method === 'invoice' ? 'Invoice' : 'Card'}
                            </Badge>
                            <span className="text-sm text-slate-500">
                              {p.created_date ? format(new Date(p.created_date), 'dd MMM yyyy') : 'Unknown date'}
                            </span>
                          </div>
                          <div className="text-sm text-slate-600 space-x-3">
                            {invoiceNumber && (
                              invoiceUrl ? (
                                <a
                                  href={invoiceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:underline"
                                  data-testid={`link-pending-invoice-${p.id}`}
                                >
                                  Invoice {invoiceNumber}
                                </a>
                              ) : (
                                <span>Invoice {invoiceNumber}</span>
                              )
                            )}
                            {p.purchase_order_number && <span>PO: {p.purchase_order_number}</span>}
                            {!p.purchase_order_number && p.po_to_follow && <span>PO to follow</span>}
                          </div>
                        </div>
                        <p className="text-lg font-semibold text-amber-700 flex-shrink-0" data-testid={`text-pending-amount-${p.id}`}>
                          £{(Number(p.amount) || 0).toFixed(2)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {reconciliation && (
            <Card className="border-slate-200 shadow-sm mb-6" data-testid="card-reconciliation">
              <CardContent className="p-4">
                <div className="grid sm:grid-cols-3 gap-3 text-sm">
                  <div>
                    <p className="text-slate-500">Sum of transactions</p>
                    <p className="text-lg font-semibold text-slate-900" data-testid="text-sum-transactions">
                      £{reconciliation.sumWithOpening.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500">Current balance</p>
                    <p className="text-lg font-semibold text-slate-900" data-testid="text-current-balance">
                      £{reconciliation.currentBalance.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-500">Status</p>
                    {reconciliation.hasDrift ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span data-testid="badge-drift-warning">
                              <Badge className="bg-warning/10 text-warning">
                                <AlertTriangle className="w-3 h-3 mr-1" />
                                Out of sync by £{Math.abs(reconciliation.drift).toFixed(2)}
                              </Badge>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p>
                              The stored balance does not match the sum of recorded transactions.
                              Likely causes: an opening balance that predates the transaction log,
                              direct edits to the balance column without a transaction row, or
                              deleted transactions. The displayed list is shown as-is — no balances
                              are silently rewritten.
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <Badge className="bg-green-100 text-green-800" data-testid="badge-reconciled">
                        Reconciled
                      </Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {loadingOrgTransactions ? (
            <div className="text-center py-12">Loading transaction history...</div>
          ) : selectedOrgTransactions.length === 0 ? (
            <Card className="border-slate-200 shadow-sm">
              <CardContent className="p-12 text-center">
                <History className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">
                  No Transaction History
                </h3>
                <p className="text-slate-600 mb-4">
                  No adjustments have been made to this organisation's training fund yet
                </p>
                <Button onClick={() => handleAdjust(selectedOrg)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Make First Adjustment
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {reconciliation && reconciliation.opening !== 0 && (
                <Card
                  className="border-slate-200 shadow-sm bg-slate-50"
                  data-testid="card-opening-balance"
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <Badge className="bg-slate-200 text-slate-800">
                            Opening balance
                          </Badge>
                          <span className="text-sm text-slate-500">
                            Before earliest recorded transaction
                          </span>
                        </div>
                        <p className="text-sm text-slate-600">
                          Synthetic row so the displayed list visibly ties to the current balance.
                          Not stored as a real transaction.
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className={`text-xl font-bold ${reconciliation.opening >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {reconciliation.opening >= 0 ? '+' : '−'}£{Math.abs(reconciliation.opening).toFixed(2)}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {selectedOrgTransactions.map((transaction) => {
                const typeInfo = formatTransactionType(transaction.type);
                const createdBy = transaction.created_by ? memberMap[transaction.created_by] : null;
                const { value: signedValue, verified } = signedAmountFor(transaction);
                const isCredit = signedValue >= 0;

                return (
                  <Card 
                    key={transaction.id} 
                    className="border-slate-200 shadow-sm"
                    data-testid={`card-transaction-${transaction.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <Badge className={typeInfo.color}>
                              {isCredit ? <Plus className="w-3 h-3 mr-1" /> : <Minus className="w-3 h-3 mr-1" />}
                              {typeInfo.label}
                            </Badge>
                            {!verified && (
                              <Badge className="bg-warning/10 text-warning" data-testid={`badge-unverified-${transaction.id}`}>
                                <AlertTriangle className="w-3 h-3 mr-1" />
                                Unverified
                              </Badge>
                            )}
                            <span className="text-sm text-slate-500">
                              {transaction.created_date ? format(new Date(transaction.created_date), 'dd MMM yyyy, HH:mm') : 'Unknown date'}
                            </span>
                          </div>
                          
                          {transaction.reason && (
                            <p className="text-slate-700 mb-2">{transaction.reason}</p>
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
                          
                          {createdBy && (
                            <p className="text-xs text-slate-400 mt-2">
                              By: {createdBy.full_name || createdBy.email}
                            </p>
                          )}
                        </div>
                        
                        <div className="text-right flex-shrink-0">
                          <p className={`text-xl font-bold ${isCredit ? 'text-green-600' : 'text-red-600'}`}>
                            {isCredit ? '+' : '−'}£{Math.abs(signedValue).toFixed(2)}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Dialog for selectedOrg view */}
        <Dialog open={showAdjustDialog} onOpenChange={setShowAdjustDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Adjust Training Fund Balance</DialogTitle>
            </DialogHeader>
            
            {adjustingOrg && (
              <div className="space-y-4">
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Building2 className="w-4 h-4 text-slate-500" />
                    <span className="font-medium text-slate-900">{adjustingOrg.name}</span>
                  </div>
                  <p className="text-sm text-slate-500">
                    Current Balance: <span className="font-semibold text-slate-900">£{(adjustingOrg.training_fund_balance || 0).toFixed(2)}</span>
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Adjustment Type</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={adjustmentType === "add" ? "default" : "outline"}
                      className={adjustmentType === "add" ? "bg-green-600 hover:bg-green-700" : ""}
                      onClick={() => setAdjustmentType("add")}
                      data-testid="button-add-funds-history"
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Add Funds
                    </Button>
                    <Button
                      type="button"
                      variant={adjustmentType === "deduct" ? "default" : "outline"}
                      className={adjustmentType === "deduct" ? "bg-red-600 hover:bg-red-700" : ""}
                      onClick={() => setAdjustmentType("deduct")}
                      data-testid="button-deduct-funds-history"
                    >
                      <Minus className="w-4 h-4 mr-1" />
                      Deduct Funds
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="amount-history">Amount (£) *</Label>
                  <Input
                    id="amount-history"
                    type="number"
                    step="0.01"
                    min="0"
                    value={adjustmentAmount}
                    onChange={(e) => setAdjustmentAmount(e.target.value)}
                    placeholder="0.00"
                    data-testid="input-adjustment-amount-history"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="date-history">Transaction Date *</Label>
                  <Input
                    id="date-history"
                    type="date"
                    value={adjustmentDate}
                    max={format(new Date(), 'yyyy-MM-dd')}
                    onChange={(e) => setAdjustmentDate(e.target.value)}
                    data-testid="input-adjustment-date-history"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="reason-history">Reason (optional)</Label>
                  <Textarea
                    id="reason-history"
                    value={adjustmentReason}
                    onChange={(e) => setAdjustmentReason(e.target.value)}
                    placeholder="Reason for adjustment..."
                    rows={2}
                    data-testid="input-adjustment-reason-history"
                  />
                </div>

                {adjustmentAmount && !isNaN(parseFloat(adjustmentAmount)) && (
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <p className="text-sm text-blue-800">
                      New Balance: <span className="font-bold">
                        £{(
                          (adjustingOrg.training_fund_balance || 0) + 
                          (adjustmentType === "add" ? 1 : -1) * parseFloat(adjustmentAmount || 0)
                        ).toFixed(2)}
                      </span>
                    </p>
                  </div>
                )}
              </div>
            )}
            
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAdjustDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleSaveAdjustment} 
                disabled={updateBalanceMutation.isPending}
                className={adjustmentType === "add" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"}
                data-testid="button-save-adjustment-history"
              >
                {updateBalanceMutation.isPending ? 'Saving...' : 
                  adjustmentType === "add" ? 'Add Funds' : 'Deduct Funds'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
                Training Fund Management
              </h1>
              {realtimeConnected && (
                <div className="flex items-center gap-1.5 text-xs text-green-600" title="Live updates enabled">
                  <Wifi className="w-3 h-3" />
                  <span>Live</span>
                </div>
              )}
            </div>
            {isAdmin && (
              <Button
                variant="outline"
                onClick={openExportDialog}
                disabled={isExporting}
                className="gap-2"
                data-testid="button-export-training-fund-transactions-csv"
              >
                {isExporting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                Export CSV
              </Button>
            )}
          </div>
          <p className="text-slate-600">
            View and adjust training fund balances for organisations. Click on an organisation to view its adjustment history.
          </p>
        </div>

        <div className="grid md:grid-cols-4 gap-4 mb-6">
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Wallet className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Total Funds</p>
                  <p className="text-2xl font-bold text-slate-900">£{totalFunds.toFixed(2)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card
            className={`border-slate-200 shadow-sm cursor-pointer hover-elevate ${balanceFilter === 'with_pending' ? 'ring-2 ring-amber-400' : ''}`}
            onClick={() => setBalanceFilter(prev => prev === 'with_pending' ? 'all' : 'with_pending')}
            role="button"
            aria-pressed={balanceFilter === 'with_pending'}
            data-testid="card-pending-funds"
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-100 rounded-lg">
                  <Clock className="w-5 h-5 text-amber-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Pending Funds</p>
                  <p className="text-2xl font-bold text-slate-900" data-testid="text-total-pending">£{totalPending.toFixed(2)}</p>
                  <p className="text-xs text-slate-400">
                    {balanceFilter === 'with_pending' ? 'Showing orgs with pending funds — click to clear' : 'Click to see which organisations'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Building2 className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Orgs with Funds</p>
                  <p className="text-2xl font-bold text-slate-900">{orgsWithFunds}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <Building2 className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Total Organisations</p>
                  <p className="text-2xl font-bold text-slate-900">{organizations.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search by organisation name..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                  data-testid="input-search-orgs"
                />
              </div>
              <div className="flex items-center gap-3">
                <Select value={balanceFilter} onValueChange={setBalanceFilter}>
                  <SelectTrigger className="w-[180px]" data-testid="select-balance-filter">
                    <SelectValue placeholder="Balance filter" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Organisations</SelectItem>
                    <SelectItem value="with_balance">With Balance</SelectItem>
                    <SelectItem value="zero_balance">Zero Balance</SelectItem>
                    <SelectItem value="with_pending">With Pending Funds</SelectItem>
                  </SelectContent>
                </Select>
                <div className="text-sm text-slate-500">
                  {filteredOrgs.length} {filteredOrgs.length === 1 ? 'organisation' : 'organisations'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {loadingOrgs ? (
          <div className="text-center py-12">Loading organisations...</div>
        ) : filteredOrgs.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Search className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Matching Organisations
              </h3>
              <p className="text-slate-600 mb-4">
                No organisations match your search criteria
              </p>
              <Button 
                variant="outline" 
                onClick={() => { setSearchTerm(""); setBalanceFilter("all"); }}
              >
                Clear Filters
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {paginatedOrgs.map((org) => {
              const balance = org.training_fund_balance || 0;
              const pending = org.training_fund_pending_balance || 0;
              const orgTransactionCount = driftSummaryData?.summary?.[org.id]?.transaction_count || 0;
              
              return (
                <Card 
                  key={org.id} 
                  className="border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => handleOrgClick(org)}
                  data-testid={`card-org-${org.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="p-2 bg-slate-100 rounded-lg flex-shrink-0">
                          <Building2 className="w-5 h-5 text-slate-600" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-semibold text-slate-900 truncate">{org.name}</h3>
                          <div className="flex items-center gap-2 text-sm text-slate-500">
                            {org.type && <span>{org.type}</span>}
                            {orgTransactionCount > 0 && (
                              <span className="flex items-center gap-1">
                                <History className="w-3 h-3" />
                                {orgTransactionCount} {orgTransactionCount === 1 ? 'transaction' : 'transactions'}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <p className="text-sm text-slate-500">Balance</p>
                            {driftSummaryData && orgDriftMap[org.id]?.hasDrift && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span data-testid={`drift-indicator-${org.id}`}>
                                      <AlertTriangle className="w-3.5 h-3.5 text-warning" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-xs">
                                    <p>
                                      Out of sync by £{Math.abs(orgDriftMap[org.id].drift).toFixed(2)}.
                                      The stored balance does not match the sum of recorded transactions.
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </div>
                          <p className={`text-xl font-bold ${balance > 0 ? 'text-green-600' : 'text-slate-400'}`}>
                            £{balance.toFixed(2)}
                          </p>
                          {pending > 0 && (
                            <div className="flex items-center justify-end gap-1 text-xs text-amber-700 mt-0.5" data-testid={`text-pending-${org.id}`}>
                              <Clock className="w-3 h-3" />
                              <span>£{pending.toFixed(2)} pending</span>
                            </div>
                          )}
                        </div>
                        
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => handleAdjust(org, e)}
                          data-testid={`button-adjust-${org.id}`}
                        >
                          Adjust
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-slate-200">
                <div className="text-sm text-slate-500">
                  Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1} - {Math.min(currentPage * ITEMS_PER_PAGE, filteredOrgs.length)} of {filteredOrgs.length}
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

        <Dialog open={showAdjustDialog} onOpenChange={setShowAdjustDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Adjust Training Fund Balance</DialogTitle>
            </DialogHeader>
            
            {adjustingOrg && (
              <div className="space-y-4">
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Building2 className="w-4 h-4 text-slate-500" />
                    <span className="font-medium text-slate-900">{adjustingOrg.name}</span>
                  </div>
                  <p className="text-sm text-slate-500">
                    Current Balance: <span className="font-semibold text-slate-900">£{(adjustingOrg.training_fund_balance || 0).toFixed(2)}</span>
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Adjustment Type</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={adjustmentType === "add" ? "default" : "outline"}
                      className={adjustmentType === "add" ? "bg-green-600 hover:bg-green-700" : ""}
                      onClick={() => setAdjustmentType("add")}
                      data-testid="button-add-funds"
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Add Funds
                    </Button>
                    <Button
                      type="button"
                      variant={adjustmentType === "deduct" ? "default" : "outline"}
                      className={adjustmentType === "deduct" ? "bg-red-600 hover:bg-red-700" : ""}
                      onClick={() => setAdjustmentType("deduct")}
                      data-testid="button-deduct-funds"
                    >
                      <Minus className="w-4 h-4 mr-1" />
                      Deduct Funds
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="amount">Amount (£) *</Label>
                  <Input
                    id="amount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={adjustmentAmount}
                    onChange={(e) => setAdjustmentAmount(e.target.value)}
                    placeholder="0.00"
                    data-testid="input-adjustment-amount"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="adjustment-date">Transaction Date *</Label>
                  <Input
                    id="adjustment-date"
                    type="date"
                    value={adjustmentDate}
                    max={format(new Date(), 'yyyy-MM-dd')}
                    onChange={(e) => setAdjustmentDate(e.target.value)}
                    data-testid="input-adjustment-date"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="reason">Reason (optional)</Label>
                  <Textarea
                    id="reason"
                    value={adjustmentReason}
                    onChange={(e) => setAdjustmentReason(e.target.value)}
                    placeholder="Reason for adjustment..."
                    rows={2}
                    data-testid="input-adjustment-reason"
                  />
                </div>

                {adjustmentAmount && !isNaN(parseFloat(adjustmentAmount)) && (
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <p className="text-sm text-blue-800">
                      New Balance: <span className="font-bold">
                        £{(
                          (adjustingOrg.training_fund_balance || 0) + 
                          (adjustmentType === "add" ? 1 : -1) * parseFloat(adjustmentAmount || 0)
                        ).toFixed(2)}
                      </span>
                    </p>
                  </div>
                )}
              </div>
            )}
            
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAdjustDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleSaveAdjustment} 
                disabled={updateBalanceMutation.isPending}
                className={adjustmentType === "add" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"}
                data-testid="button-save-adjustment"
              >
                {updateBalanceMutation.isPending ? 'Saving...' : 
                  adjustmentType === "add" ? 'Add Funds' : 'Deduct Funds'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-export-csv-config">
            <DialogHeader>
              <DialogTitle>Export training fund transactions</DialogTitle>
              <DialogDescription>
                Choose which columns to include, narrow by date or organisation, and pick how the rows should be sorted.
              </DialogDescription>
            </DialogHeader>

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
                    testIdPrefix="export-report"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-sm font-medium">Columns</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setExportColumns(new Set(ALL_EXPORT_COLUMN_KEYS))}
                      data-testid="button-export-columns-select-all"
                    >
                      Select all
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        // Keep one column so the export remains valid.
                        setExportColumns(new Set([ALL_EXPORT_COLUMN_KEYS[0]]));
                      }}
                      data-testid="button-export-columns-clear"
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
                      data-testid={`label-export-column-${col.key}`}
                    >
                      <Checkbox
                        checked={exportColumns.has(col.key)}
                        onCheckedChange={() => toggleExportColumn(col.key)}
                        data-testid={`checkbox-export-column-${col.key}`}
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
                    <SelectTrigger className="mt-1" data-testid="select-export-date-field">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EXPORT_DATE_FILTER_FIELDS.map(f => (
                        <SelectItem key={f.key} value={f.key} data-testid={`select-export-date-field-option-${f.key}`}>
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
                    <SelectTrigger className="mt-1" data-testid="select-export-date-fallback-field">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" data-testid="select-export-date-fallback-field-option-none">
                        No fallback
                      </SelectItem>
                      {EXPORT_DATE_FILTER_FIELDS
                        .filter(f => f.key !== exportDateField)
                        .map(f => (
                          <SelectItem key={f.key} value={f.key} data-testid={`select-export-date-fallback-field-option-${f.key}`}>
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
                        data-testid="button-export-from-date"
                      >
                        <CalendarIcon className="w-4 h-4" />
                        {exportFromDate ? format(exportFromDate, 'PPP') : <span className="text-muted-foreground">No lower bound</span>}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
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
                            data-testid="button-export-from-clear"
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
                        data-testid="button-export-to-date"
                      >
                        <CalendarIcon className="w-4 h-4" />
                        {exportToDate ? format(exportToDate, 'PPP') : <span className="text-muted-foreground">No upper bound</span>}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
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
                            data-testid="button-export-to-clear"
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
                      data-testid="checkbox-export-all-orgs"
                    />
                    <span>All organisations</span>
                  </label>

                  {!exportAllOrgs && (
                    <>
                      <Input
                        placeholder="Search organisations..."
                        value={exportOrgSearch}
                        onChange={(e) => setExportOrgSearch(e.target.value)}
                        data-testid="input-export-org-search"
                      />
                      <ScrollArea className="h-48 rounded border">
                        <div className="p-2 space-y-1">
                          {filteredExportOrgs.length === 0 ? (
                            <p className="text-sm text-muted-foreground p-2">No organisations match your search.</p>
                          ) : filteredExportOrgs.map(org => (
                            <label
                              key={org.id}
                              className="flex items-center gap-2 text-sm cursor-pointer p-1 rounded hover-elevate"
                              data-testid={`label-export-org-${org.id}`}
                            >
                              <Checkbox
                                checked={exportOrgIds.has(org.id)}
                                onCheckedChange={() => toggleExportOrg(org.id)}
                                data-testid={`checkbox-export-org-${org.id}`}
                              />
                              <span>{org.name}</span>
                            </label>
                          ))}
                        </div>
                      </ScrollArea>
                      <p className="text-xs text-muted-foreground" data-testid="text-export-org-count">
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
                        data-testid={`row-export-sort-rule-${idx}`}
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
                              <SelectTrigger className="mt-1" data-testid={`select-export-sort-field-${idx}`}>
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
                              <SelectTrigger className="mt-1" data-testid={`select-export-sort-dir-${idx}`}>
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
                              data-testid={`button-export-sort-up-${idx}`}
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
                              data-testid={`button-export-sort-down-${idx}`}
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
                              data-testid={`button-export-sort-remove-${idx}`}
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
                            <SelectTrigger className="mt-1" data-testid={`select-export-sort-fallback-${idx}`}>
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
                  data-testid="button-export-sort-add"
                >
                  <Plus />
                  Add sort rule
                </Button>
              </div>

              {exportEmptyMessage && (
                <div
                  className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning dark:border-warning dark:bg-warning/20 dark:text-warning"
                  data-testid="text-export-empty-message"
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
                data-testid="button-export-cancel"
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmExport}
                disabled={isExporting || exportColumns.size === 0}
                className="gap-2"
                data-testid="button-export-confirm"
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
