import { useState, useEffect, useMemo, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowLeft, Save, AlertCircle, Calculator, Loader2, NotebookText, X, RotateCcw, History, Check, Edit2, Clock, ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { cn } from "@/lib/utils";
import { format } from 'date-fns';
import FormRenderer from "@/components/forms/FormRenderer";
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
  { id: "new", label: "New", color: "#f97316", is_initial: true, order: 0 },
  { id: "in_review", label: "In Review", color: "#a855f7", is_initial: false, order: 1 },
  { id: "verified", label: "Verified", color: "#3b82f6", is_initial: false, order: 2 },
  { id: "approved", label: "Approved", color: "#22c55e", is_initial: false, order: 3 },
  { id: "rejected", label: "Rejected", color: "#ef4444", is_initial: false, order: 4 }
];

function ScoreGradient({ score, riskLevel, customRiskLevels }) {
  const defaultColors = [
    { threshold: 80, color: "#22c55e" },
    { threshold: 50, color: "#f59e0b" },
    { threshold: 20, color: "#f97316" },
    { threshold: 0, color: "#ef4444" }
  ];
  
  const colors = customRiskLevels?.length > 0 
    ? customRiskLevels.map(l => ({ threshold: l.threshold, color: l.color }))
    : defaultColors;
  
  const sortedColors = [...colors].sort((a, b) => b.threshold - a.threshold);
  let barColor = sortedColors[sortedColors.length - 1].color;
  
  if (score !== null && score !== undefined) {
    for (const c of sortedColors) {
      if (score >= c.threshold) {
        barColor = c.color;
        break;
      }
    }
  }
  
  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between">
        <span className="text-4xl font-bold">
          {score !== null && score !== undefined ? `${score}%` : '--'}
        </span>
        {riskLevel && (
          <Badge 
            style={{ backgroundColor: barColor, color: '#fff' }}
            className="text-xs"
          >
            {riskLevel.replace(/_/g, ' ')}
          </Badge>
        )}
      </div>
      <div className="h-3 bg-white/30 rounded-full overflow-hidden">
        <div 
          className="h-full rounded-full transition-all duration-500"
          style={{ 
            width: score !== null && score !== undefined ? `${score}%` : '0%',
            backgroundColor: barColor
          }}
        />
      </div>
    </div>
  );
}

function ReviewFieldEditor({ 
  field, 
  fieldKey,
  originalValue, 
  reviewedValue, 
  reviewStatus, 
  onChange, 
  onStatusChange,
  note,
  onNoteChange 
}) {
  const [showNote, setShowNote] = useState(!!note);
  const isApproved = reviewStatus === 'approved';
  const isAmended = reviewStatus === 'amended';
  const isPending = reviewStatus === 'pending' || !reviewStatus;
  
  // Use fieldKey (field.id) for state management, but field.name for display/values
  const stateKey = fieldKey || field.name;
  
  const displayOriginal = Array.isArray(originalValue) 
    ? originalValue.join(', ') 
    : (typeof originalValue === 'object' && originalValue !== null)
      ? JSON.stringify(originalValue, null, 2)
      : (originalValue || '');

  return (
    <div 
      className={cn(
        "col-span-2 grid grid-cols-2 gap-4 p-4 border rounded-lg",
        isApproved && "bg-green-50 border-green-200",
        isAmended && "bg-amber-50 border-amber-200",
        isPending && "bg-gray-50 border-gray-200"
      )}
      data-testid={`review-field-${stateKey}`}
    >
      <div className="space-y-1">
        <Label className="text-sm font-medium">{field.label || field.name}</Label>
        <div className="p-2 bg-white rounded border text-sm min-h-[40px]">
          {displayOriginal || <span className="text-muted-foreground italic">No value</span>}
        </div>
      </div>
      
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-sm font-medium">Reviewed Value</Label>
          <div className="flex items-center gap-2">
            <span className={cn("text-xs font-medium", isApproved ? "text-green-600" : "text-muted-foreground")}>
              Approved
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={isAmended}
              onClick={() => onStatusChange(stateKey, isApproved ? 'amended' : 'approved')}
              className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                isApproved ? "bg-green-500" : "bg-amber-500"
              )}
              data-testid={`toggle-status-${stateKey}`}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 transform rounded-full bg-white shadow-lg transition-transform",
                  isAmended ? "translate-x-6" : "translate-x-1"
                )}
              />
            </button>
            <span className={cn("text-xs font-medium", isAmended ? "text-amber-600" : "text-muted-foreground")}>
              Amended
            </span>
          </div>
        </div>
        
        {isAmended ? (
          <FormRenderer
            field={field}
            value={reviewedValue}
            onChange={(value) => onChange(stateKey, value)}
            disabled={false}
            hideLabel={true}
          />
        ) : (
          <div className="p-2 bg-white rounded border text-sm min-h-[40px]">
            {reviewedValue || displayOriginal || <span className="text-muted-foreground italic">No value</span>}
          </div>
        )}
        
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => setShowNote(!showNote)}
            data-testid={`button-toggle-note-${stateKey}`}
          >
            <NotebookText className="w-3 h-3 mr-1" />
            {showNote ? 'Hide Note' : 'Add Note'}
          </Button>
        </div>
        
        {showNote && (
          <Textarea
            value={note || ''}
            onChange={(e) => onNoteChange(stateKey, e.target.value)}
            placeholder="Add reviewer notes..."
            className="text-xs min-h-[60px]"
            data-testid={`textarea-note-${stateKey}`}
          />
        )}
      </div>
    </div>
  );
}

function StaticQuestionReview({ questions, responses, notes, onResponseChange, onNoteChange }) {
  if (!questions || questions.length === 0) return null;
  
  return (
    <div className="space-y-4">
      {questions.map((item, index) => {
        if (item.type === 'header') {
          return (
            <div key={item.id} className="font-semibold text-lg border-b pb-2 mt-4 first:mt-0">
              {item.text}
            </div>
          );
        }
        
        const response = responses[item.id] || '';
        const note = notes[item.id] || '';
        
        return (
          <div key={item.id} className="space-y-2 p-3 bg-white/50 rounded-lg" data-testid={`static-question-${index}`}>
            <p className="text-sm font-medium">{item.question}</p>
            <div className="flex gap-2">
              {['green', 'amber', 'red'].map((color) => (
                <Button
                  key={color}
                  variant={response === color ? "default" : "outline"}
                  size="sm"
                  onClick={() => onResponseChange(item.id, color)}
                  className={cn(
                    "flex-1",
                    response === color && color === 'green' && "bg-green-600 hover:bg-green-700",
                    response === color && color === 'amber' && "bg-amber-500 hover:bg-amber-600",
                    response === color && color === 'red' && "bg-red-600 hover:bg-red-700"
                  )}
                  data-testid={`button-${color}-${item.id}`}
                >
                  {color.charAt(0).toUpperCase() + color.slice(1)}
                </Button>
              ))}
            </div>
            <Input
              value={note}
              onChange={(e) => onNoteChange(item.id, e.target.value)}
              placeholder="Optional note..."
              className="text-xs"
              data-testid={`input-note-${item.id}`}
            />
          </div>
        );
      })}
    </div>
  );
}

function HistoryLogModal({ isOpen, onClose, historyLog }) {
  if (!isOpen) return null;
  
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="w-5 h-5" />
            Submission History
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-3 py-4">
          {historyLog && historyLog.length > 0 ? (
            [...historyLog].reverse().map((entry, index) => (
              <div key={index} className="p-3 bg-muted rounded-lg space-y-1" data-testid={`history-entry-${index}`}>
                <div className="flex items-center justify-between">
                  <Badge variant="outline">{entry.event_type?.replace(/_/g, ' ')}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {entry.timestamp ? format(new Date(entry.timestamp), 'MMM d, yyyy h:mm a') : ''}
                  </span>
                </div>
                <p className="text-sm">{entry.user_email}</p>
                {entry.details && (
                  <pre className="text-xs text-muted-foreground bg-background p-2 rounded mt-2 overflow-x-auto">
                    {JSON.stringify(entry.details, null, 2)}
                  </pre>
                )}
              </div>
            ))
          ) : (
            <p className="text-center text-muted-foreground py-8">No history entries</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} data-testid="button-close-history">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ReviewSubmissionPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  
  // Use useSearchParams from react-router-dom to reactively get query params
  const submissionId = searchParams.get('id');
  
  const [reviewedFormValues, setReviewedFormValues] = useState({});
  const [fieldReviewStatus, setFieldReviewStatus] = useState({});
  const [fieldNotes, setFieldNotes] = useState({});
  const [staticQuestionResponses, setStaticQuestionResponses] = useState({});
  const [staticQuestionNotes, setStaticQuestionNotes] = useState({});
  const [workflowStatus, setWorkflowStatus] = useState('');
  const [notes, setNotes] = useState('');
  const [showNotesEditor, setShowNotesEditor] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [isCalculatingScore, setIsCalculatingScore] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_ReviewSubmission')) {
        window.location.href = createPageUrl('DueDiligenceDashboard');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // Reset initialization state when submissionId changes (e.g., navigating to different submission)
  useEffect(() => {
    setHasInitialized(false);
    setHasUnsavedChanges(false);
  }, [submissionId]);

  const { data: ddSubmissionData, isLoading } = useQuery({
    queryKey: ['dd-submission', submissionId],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/due-diligence/get-submission?id=${submissionId}`);
      return res;
    },
    enabled: !!submissionId && accessChecked
  });

  const ddSubmission = ddSubmissionData?.submission;
  const ddConfig = ddSubmissionData?.config;
  const form = ddSubmissionData?.form;

  const workflowStages = useMemo(() => {
    return ddConfig?.workflow_stages?.length > 0 
      ? [...ddConfig.workflow_stages].sort((a, b) => a.order - b.order)
      : DEFAULT_WORKFLOW_STAGES;
  }, [ddConfig]);

  useEffect(() => {
    if (ddSubmission && form && !hasInitialized) {
      const fields = form?.fields?.filter(f => f.visible !== false) || [];
      const existingReviewedValues = ddSubmission.reviewed_form_values || {};
      const originalValues = ddSubmission.original_form_values || {};
      
      // Initialize reviewed values using field.id as key
      // If we have existing reviewed values (keyed by field.id), use them
      // Otherwise, initialize from original values (keyed by field.name) 
      const initialReviewedValues = { ...existingReviewedValues };
      fields.forEach(field => {
        const fieldKey = field.id || field.name;
        if (initialReviewedValues[fieldKey] === undefined) {
          // Copy from original values using field.name
          initialReviewedValues[fieldKey] = originalValues[field.name];
        }
      });
      setReviewedFormValues(initialReviewedValues);
      
      // Initialize field review status with default from config for unreviewed fields
      const existingStatus = ddSubmission.field_review_status || {};
      const defaultState = ddConfig?.default_review_state || 'amended';
      
      // Apply default state to any field lacking an explicit status
      // Use field.id as the unique identifier (not field.name which may be duplicated)
      const mergedStatus = { ...existingStatus };
      fields.forEach(field => {
        const fieldKey = field.id || field.name;
        if (!mergedStatus[fieldKey]) {
          mergedStatus[fieldKey] = defaultState;
        }
      });
      setFieldReviewStatus(mergedStatus);
      
      setFieldNotes(ddSubmission.field_notes || {});
      setStaticQuestionResponses(ddSubmission.static_question_responses || {});
      setStaticQuestionNotes(ddSubmission.static_question_notes || {});
      setWorkflowStatus(ddSubmission.workflow_status || 'new');
      setNotes(ddSubmission.notes || '');
      setHasInitialized(true);
    }
  }, [ddSubmission, form, ddConfig, hasInitialized]);

  const handleFieldChange = useCallback((fieldName, value) => {
    setReviewedFormValues(prev => ({ ...prev, [fieldName]: value }));
    setHasUnsavedChanges(true);
  }, []);

  // Create a mapping from fieldKey (field.id) to field.name for looking up original values
  const fieldKeyToName = useMemo(() => {
    const mapping = {};
    const fields = form?.fields?.filter(f => f.visible !== false) || [];
    fields.forEach(field => {
      const fieldKey = field.id || field.name;
      mapping[fieldKey] = field.name;
    });
    return mapping;
  }, [form]);

  const handleFieldStatusChange = useCallback((fieldKey, status) => {
    setFieldReviewStatus(prev => ({ ...prev, [fieldKey]: status }));
    if (status === 'approved') {
      // Look up the original value using field.name (not fieldKey)
      const fieldName = fieldKeyToName[fieldKey] || fieldKey;
      setReviewedFormValues(prev => ({
        ...prev,
        [fieldKey]: ddSubmission?.original_form_values?.[fieldName]
      }));
    }
    setHasUnsavedChanges(true);
  }, [ddSubmission, fieldKeyToName]);

  const handleFieldNoteChange = useCallback((fieldName, note) => {
    setFieldNotes(prev => ({ ...prev, [fieldName]: note }));
    setHasUnsavedChanges(true);
  }, []);

  const handleStaticResponseChange = useCallback((questionId, response) => {
    setStaticQuestionResponses(prev => ({ ...prev, [questionId]: response }));
    setHasUnsavedChanges(true);
  }, []);

  const handleStaticNoteChange = useCallback((questionId, note) => {
    setStaticQuestionNotes(prev => ({ ...prev, [questionId]: note }));
    setHasUnsavedChanges(true);
  }, []);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      return await apiRequest('POST', '/api/due-diligence/save-review', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dd-submission', submissionId] });
      setHasUnsavedChanges(false);
      toast.success('Review saved successfully');
    },
    onError: (error) => {
      toast.error('Failed to save: ' + error.message);
    }
  });

  const calculateScoreMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('POST', '/api/due-diligence/calculate-score', {
        submissionId: submissionId,
        formValues: reviewedFormValues,
        scoringApproach: ddConfig?.scoring_approach
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['dd-submission', submissionId] });
      toast.success(`Score calculated: ${data.score}% (${data.risk_level})`);
    },
    onError: (error) => {
      toast.error('Failed to calculate score: ' + error.message);
    }
  });

  const updateStatusMutation = useMutation({
    mutationFn: async (newStatus) => {
      return await apiRequest('POST', '/api/due-diligence/update-status', {
        submissionId: submissionId,
        newStatus: newStatus
      });
    },
    onSuccess: (data) => {
      setWorkflowStatus(data.new_status);
      queryClient.invalidateQueries({ queryKey: ['dd-submission', submissionId] });
      toast.success('Status updated successfully');
      if (data.webhooks_triggered?.length > 0) {
        toast.info(`${data.webhooks_triggered.length} webhook(s) triggered`);
      }
    },
    onError: (error) => {
      toast.error('Failed to update status: ' + error.message);
    }
  });

  const handleSave = () => {
    saveMutation.mutate({
      submissionId: submissionId,
      reviewedFormValues,
      fieldReviewStatus,
      fieldNotes,
      staticQuestionResponses,
      staticQuestionNotes,
      notes
      // NOTE: workflowStatus is NOT sent here - use the Status dropdown which calls update-status endpoint
    });
  };

  const handleCalculateScore = () => {
    setIsCalculatingScore(true);
    calculateScoreMutation.mutate(undefined, {
      onSettled: () => setIsCalculatingScore(false)
    });
  };

  const handleStatusChange = (newStatus) => {
    if (newStatus === workflowStatus) return;
    updateStatusMutation.mutate(newStatus);
  };

  // Get all visible form fields
  const allFormFields = useMemo(() => {
    return form?.fields?.filter(f => f.visible !== false) || [];
  }, [form]);

  // Get pages from form
  const pages = useMemo(() => form?.pages || [], [form]);
  const hasPages = pages.length > 0;

  // Get fields for current page
  const currentPageFields = useMemo(() => {
    if (!hasPages) {
      return allFormFields;
    }
    
    const currentPage = pages[currentPageIndex];
    if (!currentPage) return [];
    
    // Get fields assigned to this page
    const pageFields = allFormFields.filter(f => f.page_id === currentPage.id);
    
    // On first page, also include unassigned fields for backwards compatibility
    if (currentPageIndex === 0) {
      const unassignedFields = allFormFields.filter(f => !f.page_id);
      return [...unassignedFields, ...pageFields];
    }
    
    return pageFields;
  }, [allFormFields, pages, currentPageIndex, hasPages]);

  const isFirstPage = currentPageIndex === 0;
  const isLastPage = !hasPages || currentPageIndex === pages.length - 1;
  const currentPage = hasPages ? pages[currentPageIndex] : null;

  const goToNextPage = () => {
    if (!isLastPage) {
      setCurrentPageIndex(prev => prev + 1);
    }
  };

  const goToPreviousPage = () => {
    if (!isFirstPage) {
      setCurrentPageIndex(prev => prev - 1);
    }
  };

  if (!accessChecked || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen" data-testid="loading-spinner">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!ddSubmission) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Submission not found</AlertDescription>
        </Alert>
      </div>
    );
  }

  const originalFormValues = ddSubmission.original_form_values || {};
  const currentStage = workflowStages.find(s => s.id === workflowStatus);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 bg-white/80 backdrop-blur-sm rounded-xl p-4 shadow-lg">
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={() => navigate('/DueDiligenceDashboard')} data-testid="button-back">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold">{ddSubmission.application_uid}</h1>
              {hasUnsavedChanges && (
                <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-300">
                  Unsaved Changes
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{form?.name}</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowNotesEditor(!showNotesEditor)}
            data-testid="button-toggle-notes"
          >
            <NotebookText className="w-5 h-5" />
          </Button>
          
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Status</Label>
            <Select value={workflowStatus} onValueChange={handleStatusChange} data-testid="select-status">
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workflowStages.map((stage) => (
                  <SelectItem key={stage.id} value={stage.id}>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color }} />
                      {stage.label}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending || !hasUnsavedChanges}
            data-testid="button-save"
          >
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            Save Changes
          </Button>
          
          <Button
            variant="outline"
            onClick={() => setShowHistoryModal(true)}
            data-testid="button-history"
          >
            <History className="w-4 h-4 mr-2" />
            History
          </Button>
        </div>
      </div>

      {showNotesEditor && (
        <Card className="shadow-lg">
          <CardHeader className="bg-slate-700 text-white rounded-t-lg flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <NotebookText className="w-5 h-5" />
              Due Diligence Notes
            </CardTitle>
            <Button variant="ghost" size="icon" onClick={() => setShowNotesEditor(false)} className="text-white hover:bg-slate-600">
              <X className="w-5 h-5" />
            </Button>
          </CardHeader>
          <CardContent className="p-4">
            <Textarea
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setHasUnsavedChanges(true); }}
              placeholder="Add your due diligence notes here..."
              className="min-h-[200px]"
              data-testid="textarea-notes"
            />
          </CardContent>
        </Card>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card className="shadow-lg">
            <CardHeader className="bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-t-lg">
              <CardTitle>Application Fields Review</CardTitle>
              <p className="text-blue-100 text-sm">Review each field and approve or amend as needed</p>
              {hasPages && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-blue-100">
                      {currentPage?.title || `Page ${currentPageIndex + 1}`}
                    </span>
                    <span className="text-sm text-blue-200">
                      {currentPageIndex + 1} of {pages.length}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    {pages.map((_, index) => (
                      <div
                        key={index}
                        className={`h-1.5 flex-1 rounded-full transition-colors ${
                          index <= currentPageIndex ? 'bg-white' : 'bg-blue-400'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              )}
            </CardHeader>
            <CardContent className="p-6 space-y-2">
              {currentPageFields.length > 0 ? (
                <div className="grid grid-cols-2 gap-4">
                  <div className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Original</div>
                  <div className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Reviewed</div>
                  {currentPageFields.map((field, index) => {
                    const fieldKey = field.id || field.name;
                    return (
                      <ReviewFieldEditor
                        key={fieldKey || `field-${index}`}
                        field={field}
                        fieldKey={fieldKey}
                        originalValue={originalFormValues[field.name]}
                        reviewedValue={reviewedFormValues[fieldKey]}
                        reviewStatus={fieldReviewStatus[fieldKey]}
                        onChange={handleFieldChange}
                        onStatusChange={handleFieldStatusChange}
                        note={fieldNotes[fieldKey]}
                        onNoteChange={handleFieldNoteChange}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  <AlertCircle className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>No form fields configured for review</p>
                </div>
              )}
              
              {hasPages && (
                <div className="flex justify-between pt-6 border-t mt-6">
                  {!isFirstPage ? (
                    <Button
                      variant="outline"
                      onClick={goToPreviousPage}
                      data-testid="button-previous-page"
                    >
                      <ChevronLeft className="w-4 h-4 mr-2" />
                      Previous
                    </Button>
                  ) : (
                    <div />
                  )}
                  
                  {!isLastPage ? (
                    <Button
                      onClick={goToNextPage}
                      data-testid="button-next-page"
                    >
                      Next
                      <ChevronRight className="w-4 h-4 ml-2" />
                    </Button>
                  ) : (
                    <div />
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="bg-gradient-to-br from-blue-600 to-blue-700 text-white shadow-lg">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-4">
                <span className="font-medium">Due Diligence Score</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCalculateScore}
                  disabled={isCalculatingScore}
                  data-testid="button-calculate-score"
                >
                  {isCalculatingScore ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Calculator className="w-4 h-4 mr-1" />}
                  Calculate
                </Button>
              </div>
              <ScoreGradient
                score={ddSubmission.due_diligence_score}
                riskLevel={ddSubmission.risk_level}
                customRiskLevels={ddConfig?.custom_risk_levels}
              />
            </CardContent>
          </Card>

          {ddConfig?.scoring_approach === 'static_traffic_light' && (
            <Card className="shadow-lg">
              <CardHeader className="bg-gradient-to-r from-purple-600 to-purple-700 text-white rounded-t-lg">
                <CardTitle className="text-lg">Due Diligence Questions</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <StaticQuestionReview
                  questions={ddConfig?.static_questions || []}
                  responses={staticQuestionResponses}
                  notes={staticQuestionNotes}
                  onResponseChange={handleStaticResponseChange}
                  onNoteChange={handleStaticNoteChange}
                />
              </CardContent>
            </Card>
          )}

          <Card className="shadow-lg">
            <CardHeader>
              <CardTitle className="text-lg">Submission Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{ddSubmission.created_at ? format(new Date(ddSubmission.created_at), 'MMM d, yyyy') : '--'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Updated</span>
                <span>{ddSubmission.updated_at ? format(new Date(ddSubmission.updated_at), 'MMM d, yyyy h:mm a') : '--'}</span>
              </div>
              {ddSubmission.reviewed_by && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reviewed By</span>
                  <span>{ddSubmission.reviewed_by}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Current Stage</span>
                <Badge style={{ backgroundColor: currentStage?.color || '#6b7280', color: '#fff' }}>
                  {currentStage?.label || workflowStatus}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <HistoryLogModal
        isOpen={showHistoryModal}
        onClose={setShowHistoryModal}
        historyLog={ddSubmission.history_log}
      />
    </div>
  );
}
