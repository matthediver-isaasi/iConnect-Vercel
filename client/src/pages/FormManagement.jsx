import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Loader2, Plus, Pencil, Trash2, Eye, EyeOff, FileText, BarChart3, Copy,
  FileSignature, Building2, Clock, Send, FilePlus, Search, X, ChevronLeft, ChevronRight,
  LayoutGrid, List, ArrowUpDown, Pin, PinOff,
} from "lucide-react";
import ManualSubmissionDialog from "@/components/ManualSubmissionDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { listOrganizationsForAdmin } from '@/lib/adminOrgList';

const PAGE_SIZE_OPTIONS = [12, 24, 48];
const DEFAULT_PAGE_SIZE = 12;

const initialFilters = {
  search: "",
  status: "all",
  auth: "all",
  layout: "all",
  organization: "all",
};

const SORT_OPTIONS = [
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
  { value: "status", label: "Active first" },
  { value: "submissions", label: "Most submissions" },
];

const DEFAULT_SORT = "name_asc";

function FilterBar({ filters, setFilters, isContract, testIdPrefix, organizations, sortBy, setSortBy, viewMode, setViewMode }) {
  const hasActiveFilters =
    filters.search !== '' ||
    filters.status !== 'all' ||
    filters.auth !== 'all' ||
    (!isContract && filters.layout !== 'all') ||
    (isContract && filters.organization !== 'all');

  return (
    <div className="mb-4 flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
      <div className="relative flex-1 min-w-[220px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          placeholder="Search by name, description, or slug..."
          className="pl-9"
          data-testid={`${testIdPrefix}-input-search`}
        />
      </div>
      <Select value={filters.status} onValueChange={(v) => setFilters({ ...filters, status: v })}>
        <SelectTrigger className="w-full md:w-[160px]" data-testid={`${testIdPrefix}-select-status`}>
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="inactive">Inactive</SelectItem>
        </SelectContent>
      </Select>
      <Select value={filters.auth} onValueChange={(v) => setFilters({ ...filters, auth: v })}>
        <SelectTrigger className="w-full md:w-[170px]" data-testid={`${testIdPrefix}-select-auth`}>
          <SelectValue placeholder="Auth required" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any auth</SelectItem>
          <SelectItem value="yes">Auth required</SelectItem>
          <SelectItem value="no">No auth</SelectItem>
        </SelectContent>
      </Select>
      {!isContract && (
        <Select value={filters.layout} onValueChange={(v) => setFilters({ ...filters, layout: v })}>
          <SelectTrigger className="w-full md:w-[170px]" data-testid={`${testIdPrefix}-select-layout`}>
            <SelectValue placeholder="Layout" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All layouts</SelectItem>
            <SelectItem value="standard">Standard</SelectItem>
            <SelectItem value="card_swipe">Card Swipe</SelectItem>
          </SelectContent>
        </Select>
      )}
      {isContract && (
        <Select value={filters.organization} onValueChange={(v) => setFilters({ ...filters, organization: v })}>
          <SelectTrigger className="w-full md:w-[220px]" data-testid={`${testIdPrefix}-select-organization`}>
            <SelectValue placeholder="Organisation" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All organisations</SelectItem>
            {organizations.map(org => (
              <SelectItem key={org.id} value={String(org.id)}>{org.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFilters(initialFilters)}
          data-testid={`${testIdPrefix}-button-clear-filters`}
        >
          <X className="w-3 h-3 mr-1" />
          Clear
        </Button>
      )}
      <div className="flex items-center gap-3 md:ml-auto">
        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="w-full md:w-[190px]" data-testid={`${testIdPrefix}-select-sort`}>
            <ArrowUpDown className="w-4 h-4 mr-1 text-slate-400" />
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1 rounded-md border border-slate-200 p-1">
          <Button
            variant="ghost"
            size="icon"
            className={`toggle-elevate ${viewMode === 'card' ? 'toggle-elevated' : ''}`}
            onClick={() => setViewMode('card')}
            title="Card view"
            aria-pressed={viewMode === 'card'}
            data-testid={`${testIdPrefix}-button-view-card`}
          >
            <LayoutGrid className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={`toggle-elevate ${viewMode === 'list' ? 'toggle-elevated' : ''}`}
            onClick={() => setViewMode('list')}
            title="List view"
            aria-pressed={viewMode === 'list'}
            data-testid={`${testIdPrefix}-button-view-list`}
          >
            <List className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function PaginationBar({ page, setPage, totalPages, pageSize, setPageSize, totalItems, filteredCount, testIdPrefix }) {
  return (
    <div className="mt-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="text-sm text-slate-600" data-testid={`${testIdPrefix}-showing-count`}>
        Showing {filteredCount === 0 ? 0 : (page - 1) * pageSize + 1}
        –{Math.min(page * pageSize, filteredCount)} of {filteredCount}
        {filteredCount !== totalItems && ` (filtered from ${totalItems})`}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-600">Per page</span>
          <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
            <SelectTrigger className="w-[80px]" data-testid={`${testIdPrefix}-select-page-size`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map(size => (
                <SelectItem key={size} value={String(size)}>{size}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page <= 1}
            data-testid={`${testIdPrefix}-button-prev-page`}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm text-slate-600" data-testid={`${testIdPrefix}-page-indicator`}>
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            data-testid={`${testIdPrefix}-button-next-page`}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function NoMatchesState({ onClear, isContract }) {
  return (
    <Card className="border-slate-200">
      <CardContent className="p-12 text-center">
        <Search className="w-16 h-16 text-slate-300 mx-auto mb-4" />
        <h3 className="text-xl font-semibold text-slate-900 mb-2">No matching {isContract ? 'contracts' : 'forms'}</h3>
        <p className="text-slate-600 mb-6">Try adjusting your search or filters.</p>
        <Button variant="outline" onClick={onClear} data-testid={`button-clear-filters-empty-${isContract ? 'contracts' : 'standard'}`}>
          <X className="w-4 h-4 mr-2" />
          Clear filters
        </Button>
      </CardContent>
    </Card>
  );
}

export default function FormManagementPage() {
  const { isFeatureExcluded, isAccessReady, authResolved, sessionValidated } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingForm, setDeletingForm] = useState(null);
  const [manualSubmissionOpen, setManualSubmissionOpen] = useState(false);
  const [manualSubmissionForm, setManualSubmissionForm] = useState(null);

  const [activeTab, setActiveTab] = useState("standard");
  const [standardFilters, setStandardFilters] = useState(initialFilters);
  const [contractFilters, setContractFilters] = useState(initialFilters);
  const [standardPage, setStandardPage] = useState(1);
  const [contractPage, setContractPage] = useState(1);
  const [standardPageSize, setStandardPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [contractPageSize, setContractPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [viewMode, setViewMode] = useState("card");
  const [sortBy, setSortBy] = useState(DEFAULT_SORT);

  const queryClient = useQueryClient();

  const isAuthenticated = authResolved && sessionValidated;

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_FormManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: forms = [], isLoading } = useQuery({
    queryKey: ['forms'],
    queryFn: async () => {
      return await base44.entities.Form.list();
    },
    staleTime: 0,
    enabled: isAuthenticated,
  });

  const { data: submissions = [] } = useQuery({
    queryKey: ['form-submissions-all'],
    queryFn: async () => {
      return await base44.entities.FormSubmission.listAll();
    },
    staleTime: 0,
    enabled: isAuthenticated,
  });

  const submissionCounts = useMemo(() => {
    const counts = {};
    submissions.forEach(sub => {
      if (sub.form_id) {
        counts[sub.form_id] = (counts[sub.form_id] || 0) + 1;
      }
    });
    return counts;
  }, [submissions]);

  const { data: formPins = [] } = useQuery({
    queryKey: ['form-pins'],
    queryFn: async () => {
      const res = await fetch('/api/bookmarks?entity_type=form', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch pinned forms');
      const data = await res.json();
      return data.bookmarks || [];
    },
    staleTime: 0,
    enabled: isAuthenticated,
  });

  const pinnedFormIds = useMemo(
    () => new Set(formPins.map(b => b.entity_id)),
    [formPins]
  );

  const togglePinMutation = useMutation({
    mutationFn: async ({ formId, pinned }) => {
      const res = await fetch('/api/bookmarks', {
        method: pinned ? 'DELETE' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: 'form', entity_id: formId }),
      });
      if (!res.ok) throw new Error('Failed to toggle pin');
      return !pinned;
    },
    onMutate: async ({ formId, pinned }) => {
      await queryClient.cancelQueries({ queryKey: ['form-pins'] });
      const previous = queryClient.getQueryData(['form-pins']);
      queryClient.setQueryData(['form-pins'], (old = []) => {
        if (pinned) return old.filter(b => b.entity_id !== formId);
        return [...old, { entity_type: 'form', entity_id: formId }];
      });
      return { previous };
    },
    onError: (err, vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['form-pins'], context.previous);
      }
      toast.error('Failed to update pin');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['form-pins'] });
    },
  });

  const handleTogglePin = (form) => {
    togglePinMutation.mutate({ formId: form.id, pinned: pinnedFormIds.has(form.id) });
  };

  const { standardForms, contractForms } = useMemo(() => {
    const standard = forms.filter(form => !form.is_contract);
    const contracts = forms.filter(form => form.is_contract);
    return { standardForms: standard, contractForms: contracts };
  }, [forms]);

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations-for-form-management'],
    queryFn: async () => {
      return await listOrganizationsForAdmin('name');
    },
    enabled: isAuthenticated,
  });

  const deleteFormMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.Form.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
      toast.success('Form deleted successfully');
      setDeleteDialogOpen(false);
      setDeletingForm(null);
    },
    onError: (error) => {
      toast.error('Failed to delete form');
    }
  });

  const duplicateFormMutation = useMutation({
    mutationFn: async (form) => {
      const { id, created_date, updated_date, created_by, submission_count, ...formData } = form;

      const newForm = {
        ...formData,
        name: `Copy of ${form.name}`,
        slug: `${form.slug}-copy-${Date.now()}`,
        submission_count: 0
      };

      return await base44.entities.Form.create(newForm);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
      toast.success('Form duplicated successfully');
    },
    onError: (error) => {
      toast.error('Failed to duplicate form');
    }
  });

  const handleDelete = () => {
    if (!deletingForm) return;
    deleteFormMutation.mutate(deletingForm.id);
  };

  const handleDuplicate = (form) => {
    duplicateFormMutation.mutate(form);
  };

  const matchesSearch = (form, search) => {
    if (!search) return true;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      (form.name || '').toLowerCase().includes(q) ||
      (form.description || '').toLowerCase().includes(q) ||
      (form.slug || '').toLowerCase().includes(q)
    );
  };

  const applyCommonFilters = (form, filters) => {
    if (!matchesSearch(form, filters.search)) return false;
    if (filters.status !== 'all') {
      const wantActive = filters.status === 'active';
      if (Boolean(form.is_active) !== wantActive) return false;
    }
    if (filters.auth !== 'all') {
      const wantAuth = filters.auth === 'yes';
      if (Boolean(form.require_authentication) !== wantAuth) return false;
    }
    return true;
  };

  const filteredStandardForms = useMemo(() => {
    return standardForms.filter(form => {
      if (!applyCommonFilters(form, standardFilters)) return false;
      if (standardFilters.layout !== 'all') {
        const layout = form.layout_type === 'card_swipe' ? 'card_swipe' : 'standard';
        if (layout !== standardFilters.layout) return false;
      }
      return true;
    });
  }, [standardForms, standardFilters]);

  const filteredContractForms = useMemo(() => {
    return contractForms.filter(form => {
      if (!applyCommonFilters(form, contractFilters)) return false;
      if (contractFilters.organization !== 'all') {
        const orgId = form.contract_settings?.organization_id || '';
        if (String(orgId) !== contractFilters.organization) return false;
      }
      return true;
    });
  }, [contractForms, contractFilters]);

  const sortForms = useMemo(() => {
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    const applySort = (arr) => {
      switch (sortBy) {
        case 'name_desc':
          return arr.sort((a, b) => byName(b, a));
        case 'status':
          return arr.sort((a, b) => (Number(Boolean(b.is_active)) - Number(Boolean(a.is_active))) || byName(a, b));
        case 'submissions':
          return arr.sort((a, b) => ((submissionCounts[b.id] || 0) - (submissionCounts[a.id] || 0)) || byName(a, b));
        case 'name_asc':
        default:
          return arr.sort(byName);
      }
    };
    return (list) => {
      const pinned = [];
      const unpinned = [];
      list.forEach(form => (pinnedFormIds.has(form.id) ? pinned : unpinned).push(form));
      return [...applySort(pinned), ...applySort(unpinned)];
    };
  }, [sortBy, submissionCounts, pinnedFormIds]);

  const sortedStandardForms = useMemo(() => sortForms(filteredStandardForms), [sortForms, filteredStandardForms]);
  const sortedContractForms = useMemo(() => sortForms(filteredContractForms), [sortForms, filteredContractForms]);

  // Reset pagination when filters / sort / tab change
  useEffect(() => { setStandardPage(1); }, [standardFilters, standardPageSize, activeTab, sortBy]);
  useEffect(() => { setContractPage(1); }, [contractFilters, contractPageSize, activeTab, sortBy]);

  const standardTotalPages = Math.max(1, Math.ceil(sortedStandardForms.length / standardPageSize));
  const contractTotalPages = Math.max(1, Math.ceil(sortedContractForms.length / contractPageSize));

  const safeStandardPage = Math.min(standardPage, standardTotalPages);
  const safeContractPage = Math.min(contractPage, contractTotalPages);

  const pagedStandardForms = useMemo(() => {
    const start = (safeStandardPage - 1) * standardPageSize;
    return sortedStandardForms.slice(start, start + standardPageSize);
  }, [sortedStandardForms, safeStandardPage, standardPageSize]);

  const pagedContractForms = useMemo(() => {
    const start = (safeContractPage - 1) * contractPageSize;
    return sortedContractForms.slice(start, start + contractPageSize);
  }, [sortedContractForms, safeContractPage, contractPageSize]);

  if (!accessChecked || isLoading) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const getOrgName = (orgId) => {
    const org = organizations.find(o => o.id === orgId);
    return org?.name || 'Unknown';
  };

  const PinButton = ({ form }) => {
    const isPinned = pinnedFormIds.has(form.id);
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => handleTogglePin(form)}
        title={isPinned ? 'Unpin from top' : 'Pin to top'}
        aria-pressed={isPinned}
        className={`shrink-0 ${isPinned ? 'text-blue-600' : 'text-slate-400'}`}
        data-testid={`button-pin-${form.id}`}
      >
        {isPinned ? <Pin className="w-4 h-4 fill-current" /> : <PinOff className="w-4 h-4" />}
      </Button>
    );
  };

  const FormCard = ({ form, isContract = false }) => (
    <Card
      key={form.id}
      className={`hover:shadow-lg transition-shadow ${pinnedFormIds.has(form.id) ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200'}`}
      data-testid={`form-card-${form.id}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">
            <CardTitle className="text-base mb-2">{form.name}</CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              {isContract ? (
                <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50">
                  <FileSignature className="w-3 h-3 mr-1" />
                  Contract
                </Badge>
              ) : (
                <Badge variant="outline">
                  {form.layout_type === 'card_swipe' ? 'Card Swipe' : 'Standard'}
                </Badge>
              )}
              <Badge variant={form.is_active ? "default" : "secondary"}>
                {form.is_active ? (
                  <>
                    <Eye className="w-3 h-3 mr-1" />
                    Active
                  </>
                ) : (
                  <>
                    <EyeOff className="w-3 h-3 mr-1" />
                    Inactive
                  </>
                )}
              </Badge>
              {form.require_authentication && (
                <Badge variant="secondary">Auth Required</Badge>
              )}
            </div>
          </div>
          <PinButton form={form} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {form.description && (
          <p className="text-xs text-slate-600 line-clamp-2">{form.description}</p>
        )}
        {isContract && form.contract_settings?.organization_id && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600 flex items-center gap-1">
              <Building2 className="w-3 h-3" />
              Organisation:
            </span>
            <Badge variant="secondary">{getOrgName(form.contract_settings.organization_id)}</Badge>
          </div>
        )}
        {isContract && form.contract_settings?.timeout_days && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Timeout:
            </span>
            <Badge variant="secondary">{form.contract_settings.timeout_days} days</Badge>
          </div>
        )}
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-600">Fields:</span>
          <Badge variant="secondary">{form.fields?.length || 0}</Badge>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-600">Submissions:</span>
          <div className="flex items-center gap-1.5">
            {form.form_type === 'survey' && (
              <Link to={`${createPageUrl('SurveyReports')}?formId=${form.id}`}>
                <Badge variant="secondary" className="cursor-pointer hover:bg-slate-200" data-testid={`link-survey-report-${form.id}`}>
                  Report
                </Badge>
              </Link>
            )}
            <Link to={`${createPageUrl('FormSubmissions')}?formId=${form.id}`}>
              <Badge variant="secondary" className="gap-1 cursor-pointer hover:bg-slate-200">
                <BarChart3 className="w-3 h-3" />
                {submissionCounts[form.id] || 0}
              </Badge>
            </Link>
          </div>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-600">Slug:</span>
          <code className="text-xs bg-slate-100 px-2 py-1 rounded">{form.slug}</code>
        </div>
        <div className="flex gap-2 pt-2">
          <Link to={`${createPageUrl('FormBuilder')}?formId=${form.id}`} className="flex-1">
            <Button variant="outline" size="sm" className="w-full" data-testid={`button-edit-${form.id}`}>
              <Pencil className="w-3 h-3 mr-1" />
              Edit
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setManualSubmissionForm(form);
              setManualSubmissionOpen(true);
            }}
            title="Add manual submission"
            data-testid={`button-manual-submission-${form.id}`}
          >
            <FilePlus className="w-3 h-3" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleDuplicate(form)}
            disabled={duplicateFormMutation.isPending}
            title="Duplicate form"
            data-testid={`button-duplicate-${form.id}`}
          >
            <Copy className="w-3 h-3" />
          </Button>
          <Link to={`${createPageUrl('FormView')}?slug=${form.slug}`}>
            <Button variant="outline" size="sm" data-testid={`button-view-${form.id}`}>
              <Eye className="w-3 h-3" />
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDeletingForm(form);
              setDeleteDialogOpen(true);
            }}
            data-testid={`button-delete-${form.id}`}
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  const FormActions = ({ form }) => (
    <>
      <Link to={`${createPageUrl('FormBuilder')}?formId=${form.id}`}>
        <Button variant="outline" size="sm" data-testid={`button-edit-${form.id}`}>
          <Pencil className="w-3 h-3 mr-1" />
          Edit
        </Button>
      </Link>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setManualSubmissionForm(form);
          setManualSubmissionOpen(true);
        }}
        title="Add manual submission"
        data-testid={`button-manual-submission-${form.id}`}
      >
        <FilePlus className="w-3 h-3" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => handleDuplicate(form)}
        disabled={duplicateFormMutation.isPending}
        title="Duplicate form"
        data-testid={`button-duplicate-${form.id}`}
      >
        <Copy className="w-3 h-3" />
      </Button>
      <Link to={`${createPageUrl('FormView')}?slug=${form.slug}`}>
        <Button variant="outline" size="sm" title="View form" data-testid={`button-view-${form.id}`}>
          <Eye className="w-3 h-3" />
        </Button>
      </Link>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setDeletingForm(form);
          setDeleteDialogOpen(true);
        }}
        title="Delete form"
        data-testid={`button-delete-${form.id}`}
      >
        <Trash2 className="w-3 h-3" />
      </Button>
    </>
  );

  const FormRow = ({ form, isContract = false }) => (
    <Card
      key={form.id}
      className={pinnedFormIds.has(form.id) ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200'}
      data-testid={`form-row-${form.id}`}
    >
      <CardContent className="p-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <PinButton form={form} />
            <span className="font-medium text-slate-900 truncate" data-testid={`text-form-name-${form.id}`}>
              {form.name}
            </span>
            {isContract ? (
              <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50">
                <FileSignature className="w-3 h-3 mr-1" />
                Contract
              </Badge>
            ) : (
              <Badge variant="outline">
                {form.layout_type === 'card_swipe' ? 'Card Swipe' : 'Standard'}
              </Badge>
            )}
            <Badge variant={form.is_active ? "default" : "secondary"}>
              {form.is_active ? (
                <>
                  <Eye className="w-3 h-3 mr-1" />
                  Active
                </>
              ) : (
                <>
                  <EyeOff className="w-3 h-3 mr-1" />
                  Inactive
                </>
              )}
            </Badge>
            {form.require_authentication && (
              <Badge variant="secondary">Auth Required</Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap lg:flex-nowrap lg:justify-end">
          {form.form_type === 'survey' && (
            <Link to={`${createPageUrl('SurveyReports')}?formId=${form.id}`}>
              <Badge variant="secondary" className="cursor-pointer hover:bg-slate-200" title="Survey report" data-testid={`link-survey-report-row-${form.id}`}>
                Report
              </Badge>
            </Link>
          )}
          <Link to={`${createPageUrl('FormSubmissions')}?formId=${form.id}`}>
            <Badge variant="secondary" className="gap-1 cursor-pointer hover:bg-slate-200" title="Submissions">
              <BarChart3 className="w-3 h-3" />
              {submissionCounts[form.id] || 0}
            </Badge>
          </Link>
          <FormActions form={form} />
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Form Management
            </h1>
            <p className="text-slate-600">Create and manage custom forms and contracts</p>
          </div>
          <Link to={createPageUrl('FormBuilder')}>
            <Button className="bg-blue-600 hover:bg-blue-700" data-testid="button-create-form">
              <Plus className="w-4 h-4 mr-2" />
              Create Form
            </Button>
          </Link>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="mb-6" data-testid="form-management-tabs">
            <TabsTrigger value="standard" data-testid="tab-standard-forms">
              <FileText className="w-4 h-4 mr-2" />
              Standard Forms
              {standardForms.length > 0 && (
                <Badge variant="secondary" className="ml-2">{standardForms.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="contracts" data-testid="tab-contracts">
              <FileSignature className="w-4 h-4 mr-2" />
              Contracts
              {contractForms.length > 0 && (
                <Badge variant="secondary" className="ml-2">{contractForms.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="standard">
            {standardForms.length === 0 ? (
              <Card className="border-slate-200">
                <CardContent className="p-12 text-center">
                  <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No standard forms yet</h3>
                  <p className="text-slate-600 mb-6">Create your first form to get started</p>
                  <Link to={createPageUrl('FormBuilder')}>
                    <Button className="bg-blue-600 hover:bg-blue-700">
                      <Plus className="w-4 h-4 mr-2" />
                      Create Form
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ) : (
              <>
                <FilterBar
                  filters={standardFilters}
                  setFilters={setStandardFilters}
                  isContract={false}
                  testIdPrefix="standard"
                  organizations={organizations}
                  sortBy={sortBy}
                  setSortBy={setSortBy}
                  viewMode={viewMode}
                  setViewMode={setViewMode}
                />
                {filteredStandardForms.length === 0 ? (
                  <NoMatchesState onClear={() => setStandardFilters(initialFilters)} isContract={false} />
                ) : (
                  <>
                    {viewMode === 'list' ? (
                      <div className="flex flex-col gap-3">
                        {pagedStandardForms.map(form => (
                          <FormRow key={form.id} form={form} isContract={false} />
                        ))}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {pagedStandardForms.map(form => (
                          <FormCard key={form.id} form={form} isContract={false} />
                        ))}
                      </div>
                    )}
                    <PaginationBar
                      page={safeStandardPage}
                      setPage={setStandardPage}
                      totalPages={standardTotalPages}
                      pageSize={standardPageSize}
                      setPageSize={setStandardPageSize}
                      totalItems={standardForms.length}
                      filteredCount={filteredStandardForms.length}
                      testIdPrefix="standard"
                    />
                  </>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="contracts">
            {contractForms.length === 0 ? (
              <Card className="border-slate-200">
                <CardContent className="p-12 text-center">
                  <FileSignature className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No contracts yet</h3>
                  <p className="text-slate-600 mb-6">Create a form with Contract Mode enabled to see it here</p>
                  <Link to={createPageUrl('FormBuilder')}>
                    <Button className="bg-blue-600 hover:bg-blue-700">
                      <Plus className="w-4 h-4 mr-2" />
                      Create Contract
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ) : (
              <>
                <FilterBar
                  filters={contractFilters}
                  setFilters={setContractFilters}
                  isContract={true}
                  testIdPrefix="contracts"
                  organizations={organizations}
                  sortBy={sortBy}
                  setSortBy={setSortBy}
                  viewMode={viewMode}
                  setViewMode={setViewMode}
                />
                {filteredContractForms.length === 0 ? (
                  <NoMatchesState onClear={() => setContractFilters(initialFilters)} isContract={true} />
                ) : (
                  <>
                    {viewMode === 'list' ? (
                      <div className="flex flex-col gap-3">
                        {pagedContractForms.map(form => (
                          <FormRow key={form.id} form={form} isContract={true} />
                        ))}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {pagedContractForms.map(form => (
                          <FormCard key={form.id} form={form} isContract={true} />
                        ))}
                      </div>
                    )}
                    <PaginationBar
                      page={safeContractPage}
                      setPage={setContractPage}
                      totalPages={contractTotalPages}
                      pageSize={contractPageSize}
                      setPageSize={setContractPageSize}
                      totalItems={contractForms.length}
                      filteredCount={filteredContractForms.length}
                      testIdPrefix="contracts"
                    />
                  </>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the form "{deletingForm?.name}" and all its submissions. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ManualSubmissionDialog
        open={manualSubmissionOpen}
        onOpenChange={setManualSubmissionOpen}
        form={manualSubmissionForm}
      />
    </div>
  );
}
