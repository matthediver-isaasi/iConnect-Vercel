import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Search, Filter, RefreshCw, FileText, TrendingUp, AlertTriangle, CheckCircle, CheckCircle2, Clock, Loader2, Settings, GripVertical, Trash2, ArrowRightLeft, ArrowRight, Check, X, FileSignature, Calendar, Gavel } from "lucide-react";
import { format } from 'date-fns';
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { base44 } from "@/api/base44Client";

const DEFAULT_COLUMN_WIDTHS = {
  reference: 200,
  status: 120,
  formName: 180,
  riskLevel: 130,
  created: 120,
  lastUpdated: 120,
  reviewedBy: 160,
  swap: 160,
  actions: 80
};

const COLUMN_WIDTH_STORAGE_KEY = 'dd_dashboard_column_widths';

async function apiRequest(method, url, body = null) {
  const options = {
    method,
    credentials: 'include',
    headers: {}
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

const DEFAULT_WORKFLOW_STAGES = [
  { id: "new", label: "New", color: "#f97316" },
  { id: "in_review", label: "In Review", color: "#a855f7" },
  { id: "verified", label: "Verified", color: "#3b82f6" },
  { id: "approved", label: "Approved", color: "#22c55e" },
  { id: "rejected", label: "Rejected", color: "#ef4444" }
];

const DEFAULT_RISK_LEVELS = [
  { name: "low", color: "#22c55e" },
  { name: "medium", color: "#f59e0b" },
  { name: "high", color: "#f97316" },
  { name: "critical", color: "#ef4444" }
];

const DEMO_SYNOPSIS_DATA = {
  funnel: { totalApplications: 847, conversionRate: 54 },
  verification: { totalVerified: 142, avgTurnaround: 4.2 },
  ddMeetings: { completed: 89, completionRate: 79 },
  decisions: { total: 98, approvalRate: 29 }
};

function SynopsisCardsRow({ demoMode = false }) {
  const { data: funnelStats, isLoading: funnelLoading } = useQuery({
    queryKey: ['/api/reports/application-funnel-stats'],
    queryFn: () => apiRequest('GET', '/api/reports/application-funnel-stats'),
    staleTime: 60000,
    enabled: !demoMode
  });

  const { data: verificationStats, isLoading: verificationLoading } = useQuery({
    queryKey: ['/api/reports/verification-stats'],
    queryFn: () => apiRequest('GET', '/api/reports/verification-stats'),
    staleTime: 60000,
    enabled: !demoMode
  });

  const { data: ddStats, isLoading: ddLoading } = useQuery({
    queryKey: ['/api/reports/due-diligence-stats'],
    queryFn: () => apiRequest('GET', '/api/reports/due-diligence-stats'),
    staleTime: 60000,
    enabled: !demoMode
  });

  const { data: decisionsStats, isLoading: decisionsLoading } = useQuery({
    queryKey: ['/api/reports/decisions-stats'],
    queryFn: () => apiRequest('GET', '/api/reports/decisions-stats'),
    staleTime: 60000,
    enabled: !demoMode
  });

  const funnel = demoMode ? DEMO_SYNOPSIS_DATA.funnel : funnelStats;
  const verification = demoMode ? DEMO_SYNOPSIS_DATA.verification : verificationStats;
  const dd = demoMode ? DEMO_SYNOPSIS_DATA.ddMeetings : ddStats;
  const decisions = demoMode ? DEMO_SYNOPSIS_DATA.decisions : decisionsStats;

  const funnelConversion = funnel?.conversionRate || (funnel?.conversionRates?.length > 0 
    ? funnel.conversionRates[funnel.conversionRates.length - 1]?.rate || 0
    : 0);

  const cards = [
    {
      id: 'application-funnel',
      title: 'Applications',
      icon: Filter,
      value: funnelLoading ? '—' : (funnel?.totalApplications?.toLocaleString() || '0'),
      subValue: funnelLoading ? 'Loading...' : `${funnelConversion}% to final stage`,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50 dark:bg-blue-900/20',
      borderColor: 'border-blue-200 dark:border-blue-800'
    },
    {
      id: 'verification',
      title: 'Verified',
      icon: CheckCircle2,
      value: verificationLoading ? '—' : (verification?.totalVerified?.toLocaleString() || '0'),
      subValue: verificationLoading ? 'Loading...' : `${verification?.avgTurnaround?.toFixed?.(1) || verification?.averageTurnaroundDays?.toFixed?.(1) || 0} days avg`,
      color: 'text-green-600',
      bgColor: 'bg-green-50 dark:bg-green-900/20',
      borderColor: 'border-green-200 dark:border-green-800'
    },
    {
      id: 'due-diligence',
      title: 'DD Meetings',
      icon: Calendar,
      value: ddLoading ? '—' : (dd?.completed?.toLocaleString?.() || dd?.completedMeetings?.toLocaleString() || '0'),
      subValue: ddLoading ? 'Loading...' : `${dd?.completionRate || 0}% completed`,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50 dark:bg-purple-900/20',
      borderColor: 'border-purple-200 dark:border-purple-800'
    },
    {
      id: 'decisions',
      title: 'Decisions',
      icon: Gavel,
      value: decisionsLoading ? '—' : (decisions?.total?.toLocaleString?.() || decisions?.totalDecisions?.toLocaleString() || '0'),
      subValue: decisionsLoading ? 'Loading...' : `${decisions?.approvalRate || decisions?.approved?.percentage || 0}% approved`,
      color: 'text-amber-600',
      bgColor: 'bg-amber-50 dark:bg-amber-900/20',
      borderColor: 'border-amber-200 dark:border-amber-800'
    }
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-testid="container-synopsis-cards">
      {cards.map(card => {
        const Icon = card.icon;
        return (
          <Card 
            key={card.id}
            className={`${card.bgColor} ${card.borderColor}`}
            data-testid={`synopsis-card-${card.id}`}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 flex-1 min-w-0">
                  <p className={`text-xs font-medium ${card.color}`} data-testid={`synopsis-title-${card.id}`}>
                    {card.title}
                  </p>
                  <p className="text-2xl font-bold truncate" data-testid={`synopsis-value-${card.id}`}>
                    {card.value}
                  </p>
                  <p className="text-xs text-muted-foreground truncate" data-testid={`synopsis-subvalue-${card.id}`}>
                    {card.subValue}
                  </p>
                </div>
                <div className={`p-2 rounded-lg ${card.bgColor}`}>
                  <Icon className={`w-5 h-5 ${card.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function StatCard({ title, value, icon: Icon, color, subtitle }) {
  return (
    <Card className="hover-elevate" data-testid={`stat-card-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
          </div>
          <div className="p-3 rounded-full" style={{ backgroundColor: `${color}20` }}>
            <Icon className="w-6 h-6" style={{ color }} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SubmissionRow({ submission, workflowStages, riskLevels, onClick, onDelete, onSwap, cardReferenceField, columnWidths, eligibleForms }) {
  const stage = workflowStages.find(s => s.id === submission.workflow_status) || { label: submission.workflow_status, color: '#6b7280' };
  const riskConfig = riskLevels.find(r => r.name.toLowerCase() === submission.risk_level?.toLowerCase()) || { color: '#6b7280' };
  
  const formValues = submission.form_submission?.submission_data || {};
  const linkedOrgName = submission.form_submission?.organization?.name;
  const currentFormId = submission.form_submission?.form_id;
  
  let displayReference = submission.application_uid;
  if (cardReferenceField === '__organization_name__' && linkedOrgName) {
    displayReference = linkedOrgName;
  } else if (cardReferenceField && formValues[cardReferenceField]) {
    displayReference = formValues[cardReferenceField];
  } else {
    displayReference = linkedOrgName || formValues.organization_name || formValues.company_name || formValues.name || formValues.email || submission.application_uid;
  }

  const reviewerDisplay = submission.reviewed_by_name || submission.reviewed_by || '--';

  const handleDeleteClick = (e) => {
    e.stopPropagation();
    onDelete(submission);
  };

  const handleSwapSelect = (targetFormId) => {
    if (targetFormId) {
      onSwap(submission, targetFormId);
    }
  };

  const swapTargetForms = eligibleForms.filter(f => f.id !== currentFormId);
  const isSwapAllowed = stage.allow_swap !== false;
  
  return (
    <TableRow 
      className="cursor-pointer hover:bg-muted/50" 
      onClick={() => onClick(submission.id)}
      data-testid={`submission-row-${submission.id}`}
    >
      <TableCell className="font-medium" style={{ width: columnWidths.reference, minWidth: columnWidths.reference }}>{displayReference}</TableCell>
      <TableCell style={{ width: columnWidths.status, minWidth: columnWidths.status }}>
        <Badge 
          style={{ backgroundColor: stage.color, color: '#fff' }}
          className="text-xs no-default-hover-elevate no-default-active-elevate"
        >
          {stage.label}
        </Badge>
      </TableCell>
      <TableCell style={{ width: columnWidths.formName, minWidth: columnWidths.formName }}>
        <span className="text-sm truncate block" title={submission.form_name}>
          {submission.form_name || '--'}
        </span>
      </TableCell>
      <TableCell style={{ width: columnWidths.riskLevel, minWidth: columnWidths.riskLevel }}>
        {submission.risk_level ? (
          <Badge 
            variant="outline" 
            style={{ borderColor: riskConfig.color, color: riskConfig.color }}
          >
            {submission.risk_level.replace(/_/g, ' ')}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-sm">--</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm" style={{ width: columnWidths.created, minWidth: columnWidths.created }}>
        {submission.created_at ? format(new Date(submission.created_at), 'MMM d, yyyy') : '--'}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm" style={{ width: columnWidths.lastUpdated, minWidth: columnWidths.lastUpdated }}>
        {submission.updated_at ? format(new Date(submission.updated_at), 'MMM d, yyyy') : '--'}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm" style={{ width: columnWidths.reviewedBy, minWidth: columnWidths.reviewedBy }}>
        {reviewerDisplay}
      </TableCell>
      <TableCell style={{ width: columnWidths.swap, minWidth: columnWidths.swap }} onClick={(e) => e.stopPropagation()}>
        {!isSwapAllowed ? (
          <span className="text-muted-foreground text-xs">Swap disabled</span>
        ) : swapTargetForms.length > 0 ? (
          <Select onValueChange={handleSwapSelect}>
            <SelectTrigger className="h-8 text-xs" data-testid={`select-swap-form-${submission.id}`}>
              <SelectValue placeholder="Swap form..." />
            </SelectTrigger>
            <SelectContent>
              {swapTargetForms.map(form => (
                <SelectItem key={form.id} value={form.id}>
                  <div className="flex items-center gap-2">
                    <ArrowRightLeft className="w-3 h-3" />
                    <span className="truncate">{form.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-muted-foreground text-xs">No other forms</span>
        )}
      </TableCell>
      <TableCell style={{ width: columnWidths.actions, minWidth: columnWidths.actions }}>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleDeleteClick}
          data-testid={`button-delete-dd-${submission.id}`}
          title="Delete submission"
        >
          <Trash2 className="w-4 h-4 text-red-600" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function ResizableTableHead({ label, columnKey, width, onResize }) {
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e) => {
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.max(60, startWidthRef.current + delta);
      onResize(columnKey, newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, columnKey, onResize]);

  return (
    <TableHead 
      className="relative select-none" 
      style={{ width, minWidth: width }}
    >
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <div
          className={`absolute right-0 top-0 bottom-0 w-2 cursor-col-resize flex items-center justify-center hover:bg-primary/20 ${isResizing ? 'bg-primary/30' : ''}`}
          onMouseDown={handleMouseDown}
          data-testid={`resize-handle-${columnKey}`}
        >
          <div className="w-0.5 h-4 bg-border rounded-full" />
        </div>
      </div>
    </TableHead>
  );
}

export default function DueDiligenceDashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAccessReady, memberInfo } = useMemberAccess();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [riskFilter, setRiskFilter] = useState('all');
  const [selectedFormId, setSelectedFormId] = useState('all');
  
  const [submissionToDelete, setSubmissionToDelete] = useState(null);
  const [deleteConfirmStep, setDeleteConfirmStep] = useState(1);
  const isTransitioningRef = useRef(false);
  
  const [swapModalOpen, setSwapModalOpen] = useState(false);
  const [swapSubmission, setSwapSubmission] = useState(null);
  const [swapTargetFormId, setSwapTargetFormId] = useState(null);
  const [swapPreview, setSwapPreview] = useState(null);
  const [swapPreviewLoading, setSwapPreviewLoading] = useState(false);
  const [swapConfirmStep, setSwapConfirmStep] = useState('preview');
  
  const [columnWidths, setColumnWidths] = useState(() => {
    try {
      const saved = localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY);
      if (saved) {
        return { ...DEFAULT_COLUMN_WIDTHS, ...JSON.parse(saved) };
      }
    } catch (e) {}
    return DEFAULT_COLUMN_WIDTHS;
  });

  const handleColumnResize = useCallback((columnKey, newWidth) => {
    setColumnWidths(prev => {
      const updated = { ...prev, [columnKey]: newWidth };
      try {
        localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
  }, []);
  
  const { data: ddForms = [], isLoading: formsLoading } = useQuery({
    queryKey: ['dd-enabled-forms'],
    queryFn: async () => {
      const forms = await base44.entities.Form.list();
      return forms.filter(f => f.due_diligence_required);
    },
    enabled: isAccessReady
  });

  const { data: ddConfigs = [] } = useQuery({
    queryKey: ['dd-configs-all'],
    queryFn: async () => {
      return await base44.entities.FormDueDiligenceConfig.list();
    },
    enabled: isAccessReady
  });

  const cardReferenceFieldByFormId = useMemo(() => {
    const lookup = {};
    ddConfigs.forEach(config => {
      if (config.form_id && config.card_reference_field) {
        lookup[config.form_id] = config.card_reference_field;
      }
    });
    return lookup;
  }, [ddConfigs]);

  const workflowStagesByFormId = useMemo(() => {
    const lookup = {};
    ddConfigs.forEach(config => {
      if (config.form_id && config.workflow_stages?.length > 0) {
        lookup[config.form_id] = config.workflow_stages;
      }
    });
    return lookup;
  }, [ddConfigs]);

  const getDisplayReference = useCallback((submission) => {
    if (!submission) return '';
    const formId = submission.form_submission?.form_id;
    const cardReferenceField = formId ? cardReferenceFieldByFormId[formId] : null;
    const formValues = submission.form_submission?.submission_data || {};
    const linkedOrgName = submission.form_submission?.organization?.name;
    
    if (cardReferenceField === '__organization_name__' && linkedOrgName) {
      return linkedOrgName;
    } else if (cardReferenceField && formValues[cardReferenceField]) {
      return formValues[cardReferenceField];
    } else {
      return linkedOrgName || formValues.organization_name || formValues.company_name || formValues.name || formValues.email || submission.application_uid;
    }
  }, [cardReferenceFieldByFormId]);

  const { data: submissionsData, isLoading: submissionsLoading, refetch } = useQuery({
    queryKey: ['dd-submissions', statusFilter, riskFilter, selectedFormId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (riskFilter !== 'all') params.set('riskLevel', riskFilter);
      if (selectedFormId !== 'all') params.set('formId', selectedFormId);
      params.set('limit', '100');
      
      const res = await apiRequest('GET', `/api/due-diligence/list-submissions?${params.toString()}`);
      return res;
    },
    enabled: isAccessReady
  });

  const submissions = submissionsData?.submissions || [];
  
  const stats = useMemo(() => {
    const total = submissions.length;
    const byStatus = {};
    const byRisk = {};
    let scoredCount = 0;
    let totalScore = 0;
    
    submissions.forEach(sub => {
      byStatus[sub.workflow_status] = (byStatus[sub.workflow_status] || 0) + 1;
      if (sub.risk_level) {
        byRisk[sub.risk_level] = (byRisk[sub.risk_level] || 0) + 1;
      }
      if (sub.due_diligence_score !== null && sub.due_diligence_score !== undefined) {
        scoredCount++;
        totalScore += sub.due_diligence_score;
      }
    });
    
    return {
      total,
      byStatus,
      byRisk,
      avgScore: scoredCount > 0 ? Math.round(totalScore / scoredCount) : null,
      pendingReview: byStatus['new'] || 0,
      approved: byStatus['approved'] || 0,
      highRisk: (byRisk['high'] || 0) + (byRisk['critical'] || 0)
    };
  }, [submissions]);

  const filteredSubmissions = useMemo(() => {
    if (!searchQuery.trim()) return submissions;
    
    const query = searchQuery.toLowerCase();
    return submissions.filter(sub => {
      const uid = sub.application_uid?.toLowerCase() || '';
      const formValues = sub.form_submission?.submission_data || {};
      const linkedOrgName = sub.form_submission?.organization?.name || '';
      const formId = sub.form_submission?.form_id;
      const refField = formId ? cardReferenceFieldByFormId[formId] : null;
      
      let displayRef = '';
      if (refField === '__organization_name__' && linkedOrgName) {
        displayRef = linkedOrgName.toLowerCase();
      } else if (refField && formValues[refField]) {
        displayRef = String(formValues[refField]).toLowerCase();
      } else {
        displayRef = (linkedOrgName || formValues.organization_name || formValues.company_name || formValues.name || formValues.email || '').toLowerCase();
      }
      
      return uid.includes(query) || displayRef.includes(query);
    });
  }, [submissions, searchQuery, cardReferenceFieldByFormId]);

  // Derive available stages based on selected form
  const availableStages = useMemo(() => {
    if (selectedFormId !== 'all') {
      // Use form-specific stages if available, otherwise fall back to defaults
      return workflowStagesByFormId[selectedFormId] || DEFAULT_WORKFLOW_STAGES;
    }
    
    // When "all" forms selected, aggregate unique stages from all forms
    const allFormStages = Object.values(workflowStagesByFormId);
    if (allFormStages.length === 0) {
      return DEFAULT_WORKFLOW_STAGES;
    }
    
    // Combine all stages, keeping unique by id
    const stageMap = new Map();
    allFormStages.forEach(stages => {
      stages.forEach(stage => {
        if (!stageMap.has(stage.id)) {
          stageMap.set(stage.id, stage);
        }
      });
    });
    
    // If no custom stages found, use defaults
    if (stageMap.size === 0) {
      return DEFAULT_WORKFLOW_STAGES;
    }
    
    return Array.from(stageMap.values());
  }, [selectedFormId, workflowStagesByFormId]);

  const riskLevels = DEFAULT_RISK_LEVELS;

  // Reset status filter when form changes and current stage is not in the new form's stages
  useEffect(() => {
    if (statusFilter !== 'all') {
      const stageExists = availableStages.some(s => s.id === statusFilter);
      if (!stageExists) {
        setStatusFilter('all');
      }
    }
  }, [selectedFormId, availableStages, statusFilter]);

  const handleRowClick = (submissionId) => {
    navigate(`/ReviewSubmission?id=${submissionId}`);
  };

  const handleDeleteClick = (submission) => {
    setSubmissionToDelete(submission);
    setDeleteConfirmStep(1);
  };

  const handleCancelDelete = () => {
    setSubmissionToDelete(null);
    setDeleteConfirmStep(1);
  };

  const handleFirstConfirm = () => {
    isTransitioningRef.current = true;
    setDeleteConfirmStep(2);
    setTimeout(() => { isTransitioningRef.current = false; }, 100);
  };

  const deleteMutation = useMutation({
    mutationFn: async (ddSubmissionId) => {
      const response = await apiRequest('DELETE', `/api/due-diligence/delete-submission/${ddSubmissionId}`);
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dd-submissions'] });
      toast.success('Due diligence submission deleted successfully');
      handleCancelDelete();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to delete submission');
    }
  });

  const handleFinalDelete = () => {
    if (submissionToDelete) {
      deleteMutation.mutate(submissionToDelete.id);
    }
  };

  const handleSwapClick = async (submission, targetFormId) => {
    setSwapSubmission(submission);
    setSwapTargetFormId(targetFormId);
    setSwapPreview(null);
    setSwapConfirmStep('preview');
    setSwapModalOpen(true);
    setSwapPreviewLoading(true);
    
    try {
      const response = await apiRequest('POST', '/api/due-diligence/swap-preview', {
        sourceSubmissionId: submission.id,
        targetFormId
      });
      setSwapPreview(response.preview);
    } catch (error) {
      console.error('[Swap] Preview error:', error);
      toast.error('Failed to generate swap preview');
      setSwapModalOpen(false);
    } finally {
      setSwapPreviewLoading(false);
    }
  };

  const handleCancelSwap = () => {
    setSwapModalOpen(false);
    setSwapSubmission(null);
    setSwapTargetFormId(null);
    setSwapPreview(null);
    setSwapConfirmStep('preview');
  };

  const swapMutation = useMutation({
    mutationFn: async ({ sourceSubmissionId, targetFormId }) => {
      const response = await apiRequest('POST', '/api/due-diligence/swap-execute', {
        sourceSubmissionId,
        targetFormId,
        contractAction: 'relink'
      });
      return response;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['dd-submissions'] });
      toast.success('Form swapped successfully');
      handleCancelSwap();
      if (data.newSubmission?.id) {
        navigate(`/ReviewSubmission?id=${data.newSubmission.id}`);
      }
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to swap form');
    }
  });

  const handleConfirmSwap = () => {
    if (swapSubmission && swapTargetFormId) {
      swapMutation.mutate({
        sourceSubmissionId: swapSubmission.id,
        targetFormId: swapTargetFormId
      });
    }
  };

  if (!isAccessReady || formsLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen" data-testid="loading-spinner">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Due Diligence Dashboard</h1>
          <p className="text-muted-foreground">Review and manage form submissions</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => refetch()} data-testid="button-refresh">
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      <SynopsisCardsRow />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Submissions"
          value={stats.total}
          icon={FileText}
          color="#3b82f6"
          subtitle="All time"
        />
        <StatCard
          title="Pending Review"
          value={stats.pendingReview}
          icon={Clock}
          color="#f97316"
          subtitle="Awaiting action"
        />
        <StatCard
          title="Approved"
          value={stats.approved}
          icon={CheckCircle}
          color="#22c55e"
          subtitle="Completed"
        />
        <StatCard
          title="High Risk"
          value={stats.highRisk}
          icon={AlertTriangle}
          color="#ef4444"
          subtitle="Needs attention"
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <CardTitle>Submissions</CardTitle>
              <CardDescription>Click on a submission to review</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search..."
                  className="pl-9 w-48"
                  data-testid="input-search"
                />
              </div>
              <Select value={selectedFormId} onValueChange={setSelectedFormId} data-testid="select-form">
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="All Forms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Forms</SelectItem>
                  {ddForms.map(form => (
                    <SelectItem key={form.id} value={form.id}>{form.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter} data-testid="select-status">
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {availableStages.map(stage => (
                    <SelectItem key={stage.id} value={stage.id}>
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: stage.color }} />
                        {stage.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={riskFilter} onValueChange={setRiskFilter} data-testid="select-risk">
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="All Risk Levels" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Risk Levels</SelectItem>
                  {riskLevels.map(level => (
                    <SelectItem key={level.name} value={level.name}>
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: level.color }} />
                        {level.name.charAt(0).toUpperCase() + level.name.slice(1)}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {submissionsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : filteredSubmissions.length > 0 ? (
            <div className="rounded-md border overflow-x-auto">
              <Table style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
                <TableHeader>
                  <TableRow>
                    <ResizableTableHead label="Reference" columnKey="reference" width={columnWidths.reference} onResize={handleColumnResize} />
                    <ResizableTableHead label="Status" columnKey="status" width={columnWidths.status} onResize={handleColumnResize} />
                    <ResizableTableHead label="Form" columnKey="formName" width={columnWidths.formName} onResize={handleColumnResize} />
                    <ResizableTableHead label="Risk Level" columnKey="riskLevel" width={columnWidths.riskLevel} onResize={handleColumnResize} />
                    <ResizableTableHead label="Created" columnKey="created" width={columnWidths.created} onResize={handleColumnResize} />
                    <ResizableTableHead label="Last Updated" columnKey="lastUpdated" width={columnWidths.lastUpdated} onResize={handleColumnResize} />
                    <ResizableTableHead label="Reviewed By" columnKey="reviewedBy" width={columnWidths.reviewedBy} onResize={handleColumnResize} />
                    <ResizableTableHead label="Swap Form" columnKey="swap" width={columnWidths.swap} onResize={handleColumnResize} />
                    <TableHead style={{ width: columnWidths.actions, minWidth: columnWidths.actions }}>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSubmissions.map((submission) => {
                    const formId = submission.form_submission?.form_id;
                    const refField = formId ? cardReferenceFieldByFormId[formId] : null;
                    const formWorkflowStages = (formId && workflowStagesByFormId[formId]) || DEFAULT_WORKFLOW_STAGES;
                    return (
                      <SubmissionRow
                        key={submission.id}
                        submission={submission}
                        workflowStages={formWorkflowStages}
                        riskLevels={riskLevels}
                        onClick={handleRowClick}
                        onDelete={handleDeleteClick}
                        onSwap={handleSwapClick}
                        cardReferenceField={refField}
                        columnWidths={columnWidths}
                        eligibleForms={ddForms}
                      />
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No submissions found</p>
              <p className="text-sm mt-1">Submissions will appear here when forms with due diligence are submitted</p>
            </div>
          )}
        </CardContent>
      </Card>

      {ddForms.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Due Diligence Enabled Forms</CardTitle>
            <CardDescription>Forms configured for due diligence review</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {ddForms.map(form => {
                const formSubmissionCount = submissions.filter(s => s.form_submission?.form_id === form.id).length;
                return (
                  <Card key={form.id} className="hover-elevate" data-testid={`form-card-${form.id}`}>
                    <CardContent className="pt-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{form.name}</p>
                          <p className="text-sm text-muted-foreground">{formSubmissionCount} submissions</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => navigate(`/DueDiligenceConfig?formId=${form.id}`)}
                          data-testid={`button-config-${form.id}`}
                        >
                          <Settings className="w-4 h-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={!!submissionToDelete && deleteConfirmStep === 1} onOpenChange={(open) => { if (!open && !isTransitioningRef.current) handleCancelDelete(); }}>
        <AlertDialogContent data-testid="delete-dd-confirm-step1">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              Delete Due Diligence Submission
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                Are you sure you want to delete this due diligence submission? 
                This action cannot be undone.
              </p>
              <p className="font-medium text-foreground">
                The following data will be permanently removed:
              </p>
              <ul className="list-disc list-inside text-sm space-y-1 pl-2">
                <li>Due diligence review data and scoring</li>
                <li>Related form submission and uploaded documents</li>
                <li>Contract instances and scheduled reminder jobs</li>
                <li>Reminder logs and notification history</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-step1">Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleFirstConfirm} 
              variant="destructive"
              data-testid="button-confirm-delete-step1"
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!submissionToDelete && deleteConfirmStep === 2} onOpenChange={(open) => { if (!open && !deleteMutation.isPending) handleCancelDelete(); }}>
        <AlertDialogContent data-testid="delete-dd-confirm-step2">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" />
              Final Confirmation
            </AlertDialogTitle>
            <AlertDialogDescription>
              <p className="text-base font-medium text-foreground mb-2">
                This is your final confirmation. 
              </p>
              <p>
                Deleting this submission will remove all associated data including scheduled 
                tasks and uploaded documents. This data cannot be recovered.
              </p>
              {submissionToDelete && (
                <p className="mt-3 p-2 bg-muted rounded text-sm">
                  <span className="font-medium">Submission Reference:</span>{' '}
                  {getDisplayReference(submissionToDelete)}
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-step2">Go Back</AlertDialogCancel>
            <Button 
              onClick={handleFinalDelete}
              disabled={deleteMutation.isPending}
              variant="destructive"
              data-testid="button-confirm-delete-final"
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete Permanently'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={swapModalOpen} onOpenChange={(open) => { if (!open && !swapMutation.isPending) handleCancelSwap(); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col" data-testid="swap-form-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="w-5 h-5" />
              Swap Due Diligence Form
            </DialogTitle>
            <DialogDescription>
              {swapPreview ? (
                <>Swap from <strong>{swapPreview.sourceForm?.name}</strong> to <strong>{swapPreview.targetForm?.name}</strong></>
              ) : 'Loading preview...'}
            </DialogDescription>
          </DialogHeader>
          
          {swapPreviewLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : swapPreview ? (
            <ScrollArea className="flex-1 max-h-[50vh]">
              <div className="space-y-6 pr-4">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <Card className="p-3">
                    <div className="text-2xl font-bold text-green-600">{swapPreview.summary.fieldsWithValues}</div>
                    <div className="text-xs text-muted-foreground">Fields copied</div>
                  </Card>
                  <Card className="p-3">
                    <div className="text-2xl font-bold text-amber-500">{swapPreview.summary.newEmptyFieldsCount}</div>
                    <div className="text-xs text-muted-foreground">New empty fields</div>
                  </Card>
                  <Card className="p-3">
                    <div className="text-2xl font-bold text-slate-500">{swapPreview.summary.ignoredFieldsWithValues}</div>
                    <div className="text-xs text-muted-foreground">Fields ignored</div>
                  </Card>
                </div>

                {swapPreview.fieldMapping.mapped.length > 0 && (
                  <div>
                    <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                      <Check className="w-4 h-4 text-green-600" />
                      Fields to Copy ({swapPreview.fieldMapping.mapped.filter(f => f.hasValue).length})
                    </h4>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {swapPreview.fieldMapping.mapped.filter(f => f.hasValue).map((field, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-xs bg-muted/50 p-2 rounded">
                          <span className="truncate flex-1">{field.sourceFieldLabel}</span>
                          <ArrowRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                          <span className="truncate flex-1">{field.targetFieldLabel}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {swapPreview.fieldMapping.newEmpty.length > 0 && (
                  <div>
                    <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-500" />
                      New Empty Fields ({swapPreview.fieldMapping.newEmpty.length})
                    </h4>
                    <div className="space-y-1 max-h-24 overflow-y-auto">
                      {swapPreview.fieldMapping.newEmpty.map((field, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-xs bg-amber-500/10 p-2 rounded">
                          <span className="truncate">{field.fieldLabel}</span>
                          {field.required && <Badge variant="outline" className="text-[10px] h-4">Required</Badge>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {swapPreview.fieldMapping.ignored.filter(f => f.hasValue).length > 0 && (
                  <div>
                    <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                      <X className="w-4 h-4 text-slate-500" />
                      Fields to Ignore ({swapPreview.fieldMapping.ignored.filter(f => f.hasValue).length})
                    </h4>
                    <div className="space-y-1 max-h-24 overflow-y-auto">
                      {swapPreview.fieldMapping.ignored.filter(f => f.hasValue).map((field, idx) => (
                        <div key={idx} className="text-xs bg-muted/50 p-2 rounded text-muted-foreground">
                          {field.fieldLabel}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {swapPreview.contractStatus.totalActive > 0 && (
                  <div className="border-t pt-4">
                    <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                      <FileSignature className="w-4 h-4" />
                      Contract Status
                    </h4>
                    {swapPreview.contractStatus.willRelink.length > 0 && (
                      <div className="mb-2">
                        <span className="text-xs text-green-600 font-medium">Will be moved to new submission:</span>
                        <div className="space-y-1 mt-1">
                          {swapPreview.contractStatus.willRelink.map((contract, idx) => (
                            <div key={idx} className="text-xs bg-green-500/10 p-2 rounded flex items-center gap-2">
                              <Badge variant="outline" className="text-[10px]">{contract.status}</Badge>
                              <span>{contract.sourceContactFieldLabel}</span>
                              <ArrowRight className="w-3 h-3" />
                              <span>{contract.targetContactFieldLabel}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {swapPreview.contractStatus.willArchive.length > 0 && (
                      <div>
                        <span className="text-xs text-amber-600 font-medium">Will remain with archived submission:</span>
                        <div className="space-y-1 mt-1">
                          {swapPreview.contractStatus.willArchive.map((contract, idx) => (
                            <div key={idx} className="text-xs bg-amber-500/10 p-2 rounded flex items-center gap-2">
                              <Badge variant="outline" className="text-[10px]">{contract.status}</Badge>
                              <span>{contract.sourceContactFieldLabel}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="bg-muted/50 p-3 rounded text-sm">
                  <strong>Note:</strong> The original submission will be archived. You can still view it by 
                  including archived submissions in your search.
                </div>
              </div>
            </ScrollArea>
          ) : null}

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={handleCancelSwap} disabled={swapMutation.isPending} data-testid="button-cancel-swap">
              Cancel
            </Button>
            <Button 
              onClick={handleConfirmSwap} 
              disabled={swapPreviewLoading || swapMutation.isPending}
              data-testid="button-confirm-swap"
            >
              {swapMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Swapping...
                </>
              ) : (
                <>
                  <ArrowRightLeft className="w-4 h-4 mr-2" />
                  Confirm Swap
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
