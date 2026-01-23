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
import { ArrowLeft, Save, AlertCircle, Calculator, Loader2, NotebookText, X, RotateCcw, History, Check, Edit2, Clock, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, ClipboardList, Lock, Calendar } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { cn } from "@/lib/utils";
import { format } from 'date-fns';
import FormRenderer from "@/components/forms/FormRenderer";
import DocumentsCard from "@/components/due-diligence/DocumentsCard";
import SignatoriesCard from "@/components/due-diligence/SignatoriesCard";
import MeetingRequestsCard from "@/components/due-diligence/MeetingRequestsCard";
import DocumentDetailModal from "@/components/due-diligence/DocumentDetailModal";
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
  
  // Check if this is a due diligence only field (reviewer-only, not from submission)
  const isDueDiligenceOnly = field.due_diligence === true;
  
  // Check if this is an instructions/description-only field
  const isInstructionsField = field.type === 'instructions';
  
  const displayOriginal = Array.isArray(originalValue) 
    ? originalValue.join(', ') 
    : (typeof originalValue === 'object' && originalValue !== null)
      ? JSON.stringify(originalValue, null, 2)
      : (originalValue || '');

  // Instructions/description-only fields: display formatted content, no interaction
  if (isInstructionsField) {
    return (
      <div 
        className="col-span-2 p-4 border rounded-lg bg-slate-50 border-slate-200"
        data-testid={`review-field-instructions-${stateKey}`}
      >
        {field.label && (
          <Label className="text-sm font-medium mb-2 block">{field.label}</Label>
        )}
        <div 
          className="prose prose-sm max-w-none text-muted-foreground"
          dangerouslySetInnerHTML={{ __html: field.content || '<p>No instructions provided.</p>' }}
        />
      </div>
    );
  }

  // Due diligence only fields: single column, blue background, no toggle
  if (isDueDiligenceOnly) {
    return (
      <div 
        className="col-span-2 p-4 border rounded-lg bg-blue-50 border-blue-200"
        data-testid={`review-field-dd-${stateKey}`}
      >
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label className="text-sm font-medium">{field.label || field.name}</Label>
            <Badge variant="outline" className="text-xs bg-blue-100 text-blue-700 border-blue-300">
              Due Diligence Only
            </Badge>
          </div>
          <FormRenderer
            field={field}
            value={reviewedValue}
            onChange={(value) => onChange(stateKey, value)}
            disabled={false}
            hideLabel={true}
          />
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

  // Regular submission fields: two columns with approve/amend toggle
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
            {(() => {
              const val = reviewedValue ?? displayOriginal;
              if (!val) return <span className="text-muted-foreground italic">No value</span>;
              if (typeof val === 'string') return val;
              if (Array.isArray(val)) return val.join(', ');
              if (typeof val === 'object') {
                if (val.firstName || val.lastName) {
                  return [val.firstName, val.lastName].filter(Boolean).join(' ');
                }
                return JSON.stringify(val, null, 2);
              }
              return String(val);
            })()}
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

const DEFAULT_LIGHT_OPTIONS = [
  { id: 'green', label: 'Green', color: '#22c55e', score: 100 },
  { id: 'amber', label: 'Amber', color: '#f59e0b', score: 50 },
  { id: 'red', label: 'Red', color: '#ef4444', score: 0 }
];

function StaticQuestionReview({ questions, responses, notes, onResponseChange, onNoteChange, hideCompleted = false }) {
  if (!questions || questions.length === 0) return null;
  
  const questionNumbers = useMemo(() => {
    const numbers = {};
    let count = 0;
    questions.forEach((item) => {
      if (item.type !== 'header') {
        count++;
        numbers[item.id] = count;
      }
    });
    return numbers;
  }, [questions]);
  
  const visibleQuestions = useMemo(() => {
    if (!hideCompleted) return questions;
    
    return questions.filter((item) => {
      if (item.type === 'header') {
        const nextQuestionIndex = questions.findIndex((q, i) => i > questions.indexOf(item) && q.type !== 'header');
        if (nextQuestionIndex === -1) return false;
        for (let i = nextQuestionIndex; i < questions.length; i++) {
          const q = questions[i];
          if (q.type === 'header') break;
          if (!responses[q.id]) return true;
        }
        return false;
      }
      return !responses[item.id];
    });
  }, [questions, responses, hideCompleted]);
  
  if (hideCompleted && visibleQuestions.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        All questions have been answered!
      </div>
    );
  }
  
  return (
    <div className="space-y-4">
      {visibleQuestions.map((item, index) => {
        if (item.type === 'header') {
          return (
            <div key={item.id} className="font-semibold text-lg border-b pb-2 mt-4 first:mt-0">
              {item.text}
            </div>
          );
        }
        
        const response = responses[item.id] || '';
        const note = notes[item.id] || '';
        const options = item.options || DEFAULT_LIGHT_OPTIONS;
        const questionNumber = questionNumbers[item.id];
        
        return (
          <div key={item.id} className="space-y-4 p-3 bg-muted/50 rounded-lg" data-testid={`static-question-${index}`}>
            <p className="text-sm font-medium pb-1">
              <span className="text-muted-foreground mr-2">Q{questionNumber}.</span>
              {item.question}
            </p>
            <div className="flex items-center justify-center gap-3">
              {options.map((opt) => {
                const optColor = opt.color || '#6b7280';
                const isSelected = response === opt.id;
                const scoreValue = opt.score !== undefined ? opt.score : (opt.value !== undefined ? opt.value : '');
                return (
                  <div
                    key={opt.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onResponseChange(item.id, opt.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onResponseChange(item.id, opt.id); }}
                    className="relative flex flex-col items-center gap-2 cursor-pointer"
                    data-testid={`light-${opt.id}-${item.id}`}
                  >
                    <div
                      className={`flex items-center justify-center text-white font-bold text-sm ${isSelected ? '' : 'opacity-60'}`}
                      style={{ 
                        width: '48px',
                        height: '48px',
                        borderRadius: '50%',
                        backgroundColor: optColor,
                        boxShadow: isSelected ? `0 0 0 4px white, 0 0 0 6px ${optColor}, 0 0 16px 4px ${optColor}` : `0 2px 4px rgba(0,0,0,0.2)`
                      }}
                    >
                      {scoreValue !== '' ? scoreValue : ''}
                    </div>
                    <span className={`text-xs ${isSelected ? 'font-semibold' : 'text-muted-foreground'}`}>
                      {opt.label || 'Option'}
                    </span>
                  </div>
                );
              })}
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
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [showDocumentModal, setShowDocumentModal] = useState(false);
  const [showQuestionsDrawer, setShowQuestionsDrawer] = useState(false);
  const [hideCompletedQuestions, setHideCompletedQuestions] = useState(false);
  const [isCalculatingScore, setIsCalculatingScore] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [agentSelectionModal, setAgentSelectionModal] = useState({ open: false, agents: [], pendingStatus: null, meetingActions: [] });
  const [selectedAgentId, setSelectedAgentId] = useState(null);

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
  const organization = ddSubmissionData?.organization;

  // Query for documents status (for condition checking)
  const { data: documentsData } = useQuery({
    queryKey: ['submission-documents', ddSubmission?.form_submission_id],
    queryFn: async () => {
      const result = await apiRequest('GET', `/api/due-diligence/documents/list?formSubmissionId=${ddSubmission.form_submission_id}`);
      return result.documents || [];
    },
    enabled: !!ddSubmission?.form_submission_id
  });

  // Query for signatories/contracts status (for condition checking)
  const { data: contractsData } = useQuery({
    queryKey: ['/api/contracts/by-submission', ddSubmission?.form_submission_id],
    queryFn: () => apiRequest('GET', `/api/contracts/by-submission?formSubmissionId=${ddSubmission.form_submission_id}`),
    enabled: !!ddSubmission?.form_submission_id
  });

  const displayReference = useMemo(() => {
    if (!ddSubmission) return '';
    const cardReferenceField = ddConfig?.card_reference_field;
    const formValues = ddSubmission.original_form_values || {};
    
    // Helper to safely convert any value to a display string
    const toDisplayString = (val) => {
      if (!val) return '';
      if (typeof val === 'string') return val;
      if (typeof val === 'object') {
        // Handle contact field objects
        if (val.firstName || val.lastName) {
          return [val.firstName, val.lastName].filter(Boolean).join(' ');
        }
        // Handle other objects
        return JSON.stringify(val);
      }
      return String(val);
    };
    
    if (cardReferenceField === '__organization_name__' && organization?.name) {
      return organization.name;
    } else if (cardReferenceField && formValues[cardReferenceField]) {
      return toDisplayString(formValues[cardReferenceField]);
    }
    
    const fallbackValue = organization?.name || formValues.organization_name || formValues.company_name || formValues.name || ddSubmission.application_uid;
    return toDisplayString(fallbackValue);
  }, [ddSubmission, ddConfig, organization]);

  const workflowStages = useMemo(() => {
    return ddConfig?.workflow_stages?.length > 0 
      ? [...ddConfig.workflow_stages].sort((a, b) => a.order - b.order)
      : DEFAULT_WORKFLOW_STAGES;
  }, [ddConfig]);

  useEffect(() => {
    if (ddSubmission && form && !hasInitialized) {
      const fields = form?.fields?.filter(f => f.visible !== false) || [];
      const existingReviewedValues = ddSubmission.reviewed_form_values || {};
      
      // Initialize reviewed values using field.id as key
      // Only use existing reviewed values - do NOT copy from original values
      // Original values should only appear in the left column (disabled)
      // Reviewed values should start empty unless previously saved
      setReviewedFormValues(existingReviewedValues);
      
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
    mutationFn: async ({ newStatus, selectedAgentId }) => {
      return await apiRequest('POST', '/api/due-diligence/update-status', {
        submissionId: submissionId,
        newStatus: newStatus,
        selectedAgentId: selectedAgentId || null
      });
    },
    onSuccess: (data) => {
      setWorkflowStatus(data.new_status);
      queryClient.invalidateQueries({ queryKey: ['dd-submission', submissionId] });
      queryClient.invalidateQueries({ queryKey: ['contracts-by-submission', ddSubmission?.form_submission_id] });
      toast.success('Status updated successfully');
      if (data.webhooks_triggered?.length > 0) {
        toast.info(`${data.webhooks_triggered.length} webhook(s) triggered`);
      }
      // Show notification for stage actions (e.g., contracts sent, meeting invitations)
      if (data.stage_actions_results?.length > 0) {
        const contractsSent = data.stage_actions_results.filter(r => r.action === 'send_contract' && r.status === 'success');
        if (contractsSent.length > 0) {
          const totalSent = contractsSent.reduce((sum, r) => sum + (r.sent_count || 0), 0);
          toast.success(`${totalSent} contract invitation(s) sent`);
        }
        
        // Show meeting request results
        const meetingRequests = data.stage_actions_results.filter(r => r.action === 'send_meeting_request');
        meetingRequests.forEach(result => {
          if (result.status === 'success') {
            toast.success(`Meeting invitation sent to ${result.recipient_email}`);
          } else if (result.status === 'error') {
            toast.error(`Failed to send meeting invitation: ${result.error}`);
          }
        });
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

  const handleStatusChange = async (newStatus) => {
    if (newStatus === workflowStatus) return;
    
    // Check if this stage has meeting request actions with multiple agents
    try {
      const formId = form?.id || ddSubmission?.form_submission?.form_id;
      if (formId) {
        const checkResult = await apiRequest('POST', '/api/due-diligence/check-stage-actions', {
          stageId: newStatus,
          formId: formId
        });
        
        if (checkResult.requires_agent_selection && checkResult.meeting_actions?.length > 0) {
          // Get all unique agents from all meeting actions
          const allAgents = [];
          const seenIds = new Set();
          checkResult.meeting_actions.forEach(action => {
            action.agents.forEach(agent => {
              if (!seenIds.has(agent.identity_id)) {
                seenIds.add(agent.identity_id);
                allAgents.push(agent);
              }
            });
          });
          
          // Only show modal if there are valid agents to select from
          if (allAgents.length > 1) {
            setAgentSelectionModal({
              open: true,
              agents: allAgents,
              pendingStatus: newStatus,
              meetingActions: checkResult.meeting_actions
            });
            setSelectedAgentId(allAgents[0]?.identity_id || null);
            return;
          } else if (allAgents.length === 0) {
            toast.error('No booking agents available for this meeting type. Please configure agents first.');
            return;
          }
          // If only 1 agent, proceed without modal (will auto-select first)
        }
      }
    } catch (error) {
      console.error('Error checking stage actions:', error);
      // Show error for auth/access issues but allow proceeding for other errors
      if (error.message?.includes('Authentication') || error.message?.includes('Tenant')) {
        toast.error('Unable to change status: ' + error.message);
        return;
      }
    }
    
    // No agent selection needed, proceed directly
    updateStatusMutation.mutate({ newStatus, selectedAgentId: null });
  };

  const handleConfirmAgentSelection = () => {
    const { pendingStatus } = agentSelectionModal;
    setAgentSelectionModal({ open: false, agents: [], pendingStatus: null, meetingActions: [] });
    updateStatusMutation.mutate({ newStatus: pendingStatus, selectedAgentId });
  };

  const handleCancelAgentSelection = () => {
    setAgentSelectionModal({ open: false, agents: [], pendingStatus: null, meetingActions: [] });
    setSelectedAgentId(null);
  };

  // Check if we should show description/instructions fields
  const showDescriptionFields = ddConfig?.show_description_fields || false;

  // Helper to check if a field value contains file upload data
  const isFileUploadValue = useCallback((value) => {
    if (!value) return false;
    if (typeof value === 'string' && value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value);
        return !!(parsed.file_url || parsed.file_name);
      } catch {
        return false;
      }
    }
    if (typeof value === 'object' && value !== null) {
      return !!(value.file_url || value.file_name);
    }
    return false;
  }, []);

  // Helper to check if a field is a file upload type (for placeholder rendering)
  const isFileUploadField = useCallback((field) => {
    if (field.type === 'file' || field.type === 'image') return true;
    if (field.type === 'custom_field' && (field.field_type === 'file' || field.field_type === 'image')) return true;
    // Check if custom field submission data contains file upload content
    if (field.type === 'custom_field') {
      const submissionData = ddSubmission?.original_form_values || {};
      const fieldKey = field.name || field.id;
      const rawValue = submissionData?.[fieldKey] || submissionData?.[field.id];
      if (isFileUploadValue(rawValue)) return true;
    }
    return false;
  }, [ddSubmission, isFileUploadValue]);

  // Get all visible form fields (optionally filtering out instructions fields)
  // File uploads and contact fields with contracts are kept but rendered as placeholders
  const allFormFields = useMemo(() => {
    let fields = form?.fields?.filter(f => f.visible !== false) || [];
    if (!showDescriptionFields) {
      fields = fields.filter(f => f.type !== 'instructions');
    }
    // Keep all fields - file uploads and contact fields with contracts will be rendered as placeholders
    return fields;
  }, [form, showDescriptionFields]);

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

  // Calculate live traffic light score based on current responses
  const liveTrafficLightScore = useMemo(() => {
    if (ddConfig?.scoring_approach !== 'static_traffic_light') return null;
    
    const questions = (ddConfig?.static_questions || []).filter(q => q.type !== 'header');
    if (questions.length === 0) return { score: 0, percentage: 0, maxScore: 0, riskLevel: null, answeredCount: 0, totalQuestions: 0 };
    
    let actualScore = 0;
    let maxPossibleScore = 0;
    let answeredCount = 0;
    
    for (const question of questions) {
      const options = question.light_options || question.options || [];
      
      // Calculate max possible score for this question (highest option score)
      const maxOptionScore = options.reduce((max, opt) => {
        const optScore = opt.score ?? opt.value ?? 0;
        return Math.max(max, optScore);
      }, 0);
      maxPossibleScore += maxOptionScore;
      
      // Get actual score if answered
      const selectedOptionId = staticQuestionResponses[question.id];
      if (selectedOptionId !== undefined && selectedOptionId !== null) {
        answeredCount++;
        const selectedOption = options.find(opt => opt.id === selectedOptionId);
        if (selectedOption) {
          const optionScore = selectedOption.score ?? selectedOption.value ?? 0;
          actualScore += optionScore;
        }
      }
    }
    
    // Calculate percentage (actual / max * 100)
    const percentage = maxPossibleScore > 0 ? Math.round((actualScore / maxPossibleScore) * 100) : 0;
    
    // Determine risk level based on percentage
    const customLevels = ddConfig?.custom_risk_levels || [];
    const defaultLevels = [
      { name: 'low', threshold: 80 },
      { name: 'medium', threshold: 50 },
      { name: 'high', threshold: 20 },
      { name: 'critical', threshold: 0 }
    ];
    const levels = customLevels.length > 0 
      ? customLevels.map(l => ({ name: l.name.toLowerCase().replace(' ', '_'), threshold: l.threshold }))
      : defaultLevels;
    const sortedLevels = [...levels].sort((a, b) => b.threshold - a.threshold);
    
    let riskLevel = sortedLevels[sortedLevels.length - 1]?.name || 'unknown';
    for (const level of sortedLevels) {
      if (percentage >= level.threshold) {
        riskLevel = level.name;
        break;
      }
    }
    
    return { 
      score: actualScore, 
      maxScore: maxPossibleScore, 
      percentage, 
      riskLevel, 
      answeredCount, 
      totalQuestions: questions.length 
    };
  }, [ddConfig, staticQuestionResponses]);

  // Compute condition status for each stage
  const stageConditionStatus = useMemo(() => {
    const status = {};
    const stages = ddConfig?.workflow_stages || [];
    
    // Use live traffic light score if available, otherwise use stored score
    const effectiveScore = liveTrafficLightScore?.answeredCount > 0 
      ? liveTrafficLightScore.percentage 
      : ddSubmission?.due_diligence_score;
    
    for (const stage of stages) {
      const conditions = stage.selection_conditions || {};
      const unmetReasons = [];
      
      // Check score condition
      if (conditions.score_condition?.enabled) {
        const currentScore = effectiveScore;
        const requiredValue = conditions.score_condition.value ?? 50;
        const operator = conditions.score_condition.operator || 'above';
        
        if (currentScore === null || currentScore === undefined) {
          unmetReasons.push('Score not calculated');
        } else if (operator === 'above' && currentScore < requiredValue) {
          unmetReasons.push(`Score must be above ${requiredValue}%`);
        } else if (operator === 'below' && currentScore > requiredValue) {
          unmetReasons.push(`Score must be below ${requiredValue}%`);
        }
      }
      
      // Check signatories received condition
      // If enabled: block if there are no contracts OR if any contract is not received
      if (conditions.signatories_received) {
        const contracts = contractsData?.contracts || [];
        const hasContracts = contracts.length > 0;
        
        if (!hasContracts) {
          // No contracts exist yet - block selection
          unmetReasons.push('No signatories to verify');
        } else {
          const allReceived = contracts.every(c => 
            c.status === 'received' || c.status === 'completed' || c.status === 'signed'
          );
          if (!allReceived) {
            unmetReasons.push('Not all signatories received');
          }
        }
      }
      
      // Check documents approved condition
      // If enabled: block if there are no documents OR if any document is not approved
      if (conditions.documents_approved) {
        const documents = documentsData || [];
        const hasDocuments = documents.length > 0;
        
        if (!hasDocuments) {
          // No documents exist yet - block selection
          unmetReasons.push('No documents to verify');
        } else {
          const allApproved = documents.every(d => d.status === 'approved');
          if (!allApproved) {
            unmetReasons.push('Not all documents approved');
          }
        }
      }
      
      status[stage.id] = {
        met: unmetReasons.length === 0,
        reasons: unmetReasons
      };
    }
    
    return status;
  }, [ddConfig, ddSubmission, documentsData, contractsData, liveTrafficLightScore]);

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
              <h1 className="text-xl font-bold">{displayReference}</h1>
              {hasUnsavedChanges && (
                <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-300">
                  Unsaved Changes
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{form?.name}</p>
          </div>
        </div>
        
        <div className="flex items-end gap-3">
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
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workflowStages.map((stage) => {
                  const conditionStatus = stageConditionStatus[stage.id];
                  const isLocked = conditionStatus && !conditionStatus.met;
                  const isCurrentStage = stage.id === workflowStatus;
                  
                  return (
                    <Tooltip key={stage.id}>
                      <TooltipTrigger asChild>
                        <div>
                          <SelectItem 
                            value={stage.id} 
                            disabled={isLocked && !isCurrentStage}
                            className={cn(isLocked && !isCurrentStage && "opacity-50")}
                          >
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color }} />
                              <span>{stage.label}</span>
                              {isLocked && !isCurrentStage && (
                                <Lock className="w-3 h-3 text-muted-foreground ml-1" />
                              )}
                            </div>
                          </SelectItem>
                        </div>
                      </TooltipTrigger>
                      {isLocked && !isCurrentStage && conditionStatus.reasons.length > 0 && (
                        <TooltipContent side="left" className="max-w-64">
                          <div className="space-y-1">
                            <p className="font-medium text-xs">Conditions not met:</p>
                            <ul className="text-xs space-y-0.5">
                              {conditionStatus.reasons.map((reason, i) => (
                                <li key={i} className="flex items-center gap-1">
                                  <span className="w-1 h-1 rounded-full bg-current" />
                                  {reason}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  );
                })}
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
                    
                    // Contact fields with contracts are shown as placeholders (displayed in Signatories card)
                    if (field.type === 'contact' && field.contract_form_id) {
                      return (
                        <div 
                          key={fieldKey || `field-${index}`}
                          className="col-span-2 p-4 border rounded-lg bg-slate-50 border-slate-200"
                          data-testid={`field-signatory-placeholder-${fieldKey}`}
                        >
                          <Label className="text-sm font-medium">{field.label || field.name}</Label>
                          <p className="text-sm text-muted-foreground mt-1 italic">See Signatories card</p>
                        </div>
                      );
                    }
                    
                    // File upload fields are shown as placeholders (displayed in Documents card)
                    if (isFileUploadField(field)) {
                      return (
                        <div 
                          key={fieldKey || `field-${index}`}
                          className="col-span-2 p-4 border rounded-lg bg-slate-50 border-slate-200"
                          data-testid={`field-document-placeholder-${fieldKey}`}
                        >
                          <Label className="text-sm font-medium">{field.label || field.name}</Label>
                          <p className="text-sm text-muted-foreground mt-1 italic">See Documents card</p>
                        </div>
                      );
                    }
                    
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
              <div className="flex items-center justify-between gap-2 mb-4">
                <span className="font-medium">Due Diligence Score</span>
                {ddConfig?.scoring_approach === 'static_traffic_light' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowQuestionsDrawer(true)}
                    data-testid="button-open-questions-modal"
                  >
                    <ClipboardList className="w-4 h-4 mr-1" />
                    Questions
                  </Button>
                )}
              </div>
              <ScoreGradient
                score={liveTrafficLightScore?.answeredCount > 0 ? liveTrafficLightScore.percentage : ddSubmission.due_diligence_score}
                riskLevel={liveTrafficLightScore?.answeredCount > 0 ? liveTrafficLightScore.riskLevel : ddSubmission.risk_level}
                customRiskLevels={ddConfig?.custom_risk_levels}
              />
              {liveTrafficLightScore?.answeredCount > 0 && (
                <div className="mt-2 text-xs opacity-80">
                  Score: {liveTrafficLightScore.score} / {liveTrafficLightScore.maxScore}
                </div>
              )}
            </CardContent>
          </Card>


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
              {(ddSubmission.reviewed_by_name || ddSubmission.reviewed_by) && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reviewed By</span>
                  <span>{ddSubmission.reviewed_by_name || ddSubmission.reviewed_by}</span>
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

          <DocumentsCard
            formSubmissionId={ddSubmission.form_submission_id}
            submissionData={ddSubmission.form_submission?.submission_data}
            formSchema={form}
            onDocumentClick={(doc) => {
              setSelectedDocument(doc);
              setShowDocumentModal(true);
            }}
          />

          <SignatoriesCard
            formSubmissionId={ddSubmission.form_submission_id}
            submissionData={ddSubmission.form_submission?.submission_data}
            formSchema={form}
          />

          <MeetingRequestsCard
            formSubmissionId={ddSubmission.form_submission_id}
          />
        </div>
      </div>

      <DocumentDetailModal
        isOpen={showDocumentModal}
        onClose={() => {
          setShowDocumentModal(false);
          setSelectedDocument(null);
        }}
        document={selectedDocument}
        formSubmissionId={ddSubmission?.form_submission_id}
        onDocumentUpdated={() => {
          queryClient.invalidateQueries(['submission-documents', ddSubmission?.form_submission_id]);
        }}
      />

      <HistoryLogModal
        isOpen={showHistoryModal}
        onClose={setShowHistoryModal}
        historyLog={ddSubmission.history_log}
      />

      <Dialog open={agentSelectionModal.open} onOpenChange={(open) => !open && handleCancelAgentSelection()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              Select Meeting Host
            </DialogTitle>
            <DialogDescription>
              This status change will send a meeting invitation. Please select which team member should host the meeting.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            {agentSelectionModal.agents.map((agent) => (
              <label
                key={agent.identity_id}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedAgentId === agent.identity_id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover-elevate'
                }`}
                data-testid={`agent-option-${agent.identity_id}`}
              >
                <input
                  type="radio"
                  name="agent"
                  value={agent.identity_id}
                  checked={selectedAgentId === agent.identity_id}
                  onChange={() => setSelectedAgentId(agent.identity_id)}
                  className="sr-only"
                />
                <div className="flex-1">
                  <div className="font-medium">{agent.name}</div>
                  <div className="text-sm text-muted-foreground">{agent.email}</div>
                </div>
                {selectedAgentId === agent.identity_id && (
                  <Check className="w-5 h-5 text-primary" />
                )}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelAgentSelection} data-testid="button-cancel-agent">
              Cancel
            </Button>
            <Button onClick={handleConfirmAgentSelection} disabled={!selectedAgentId} data-testid="button-confirm-agent">
              Confirm & Change Status
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {ddConfig?.scoring_approach === 'static_traffic_light' && (
        <Dialog open={showQuestionsDrawer} onOpenChange={setShowQuestionsDrawer}>
          <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0">
            <div className="bg-gradient-to-br from-blue-600 to-blue-700 text-white p-6 rounded-t-lg">
              <div className="flex items-center gap-2 mb-3">
                <ClipboardList className="w-5 h-5" />
                <span className="font-semibold text-lg">Due Diligence Questions</span>
              </div>
              <ScoreGradient
                score={liveTrafficLightScore?.answeredCount > 0 ? liveTrafficLightScore.percentage : ddSubmission.due_diligence_score}
                riskLevel={liveTrafficLightScore?.answeredCount > 0 ? liveTrafficLightScore.riskLevel : ddSubmission.risk_level}
                customRiskLevels={ddConfig?.custom_risk_levels}
              />
              {liveTrafficLightScore?.answeredCount > 0 && (
                <div className="mt-1 text-sm opacity-80">
                  Score: {liveTrafficLightScore.score} / {liveTrafficLightScore.maxScore}
                </div>
              )}
              {liveTrafficLightScore && (
                <div className="mt-4 space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>Progress</span>
                    <span>{liveTrafficLightScore.answeredCount} of {liveTrafficLightScore.totalQuestions} questions answered</span>
                  </div>
                  <div className="h-2 bg-white/30 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-white rounded-full transition-all duration-300"
                      style={{ width: `${liveTrafficLightScore.totalQuestions > 0 ? Math.round((liveTrafficLightScore.answeredCount / liveTrafficLightScore.totalQuestions) * 100) : 0}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between px-6 py-3 border-b bg-muted/30">
              <Label className="flex items-center gap-2 cursor-pointer">
                <Switch
                  checked={hideCompletedQuestions}
                  onCheckedChange={setHideCompletedQuestions}
                  data-testid="switch-hide-completed"
                />
                <span className="text-sm">Hide completed questions</span>
              </Label>
            </div>
            <div className="flex-1 overflow-y-auto p-6 min-h-0">
              <StaticQuestionReview
                questions={ddConfig?.static_questions || []}
                responses={staticQuestionResponses}
                notes={staticQuestionNotes}
                onResponseChange={handleStaticResponseChange}
                onNoteChange={handleStaticNoteChange}
                hideCompleted={hideCompletedQuestions}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
