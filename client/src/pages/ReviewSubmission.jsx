import { useState, useEffect, useMemo, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowLeft, Save, AlertCircle, Calculator, Loader2, NotebookText, X, RotateCcw, History, Check, Edit2, Clock, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, ClipboardList, Lock, Calendar, Mail, AlertTriangle, FileSignature, Bell, CalendarClock, XCircle, CheckCircle2, Timer, Info, User, FileText, PenLine, UserPlus } from "lucide-react";
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
  onNoteChange,
  organisations = [],
  linkedOrganisationId = null
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
  
  // Check if this is an organisation dropdown field that matches the linked organisation
  const isOrganisationField = field.type === 'organisation_dropdown';
  const isLinkedOrganisation = isOrganisationField && originalValue === linkedOrganisationId;
  
  // For organisation dropdown fields, look up the display name
  const getDisplayValue = (value) => {
    if (isOrganisationField && value && organisations.length > 0) {
      const org = organisations.find(o => o.id === value);
      return org?.name || value;
    }
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object' && value !== null) return JSON.stringify(value, null, 2);
    return value || '';
  };
  
  const displayOriginal = getDisplayValue(originalValue);

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
  // Lock the field if it's the linked organisation (cannot be amended)
  const isLocked = isLinkedOrganisation;
  
  return (
    <div 
      className={cn(
        "col-span-2 p-4 border rounded-lg space-y-3",
        isLocked && "bg-slate-50 border-slate-300",
        !isLocked && isApproved && "bg-green-50 border-green-200",
        !isLocked && isAmended && "bg-amber-50 border-amber-200",
        !isLocked && isPending && "bg-gray-50 border-gray-200"
      )}
      data-testid={`review-field-${stateKey}`}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">{field.label || field.name}</Label>
          {isLocked && (
            <Badge variant="outline" className="text-xs bg-slate-100 text-slate-600 border-slate-300">
              <Lock className="w-3 h-3 mr-1" />
              Linked Organisation
            </Badge>
          )}
        </div>
        {!isLocked && (
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
        )}
      </div>
      
      <div className="grid grid-cols-2 gap-4">
        <div className="p-2 bg-white rounded border text-sm min-h-[40px]">
          {displayOriginal || <span className="text-muted-foreground italic">No value</span>}
        </div>
        
        {isLocked ? (
          <div className="p-2 bg-slate-100 rounded border border-slate-200 text-sm min-h-[40px] flex items-center">
            <span className="text-slate-500 italic">Cannot be amended</span>
          </div>
        ) : isAmended ? (
          <FormRenderer
            field={field}
            value={reviewedValue}
            onChange={(value) => onChange(stateKey, value)}
            disabled={false}
            hideLabel={true}
          />
        ) : (
          <div className="p-2 bg-white rounded border text-sm min-h-[40px] flex items-center">
            <span className="text-green-600 italic">Approved as original</span>
          </div>
        )}
      </div>
      
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
  );
}

const DEFAULT_LIGHT_OPTIONS = [
  { id: 'green', label: 'Green', color: '#22c55e', score: 100 },
  { id: 'amber', label: 'Amber', color: '#f59e0b', score: 50 },
  { id: 'red', label: 'Red', color: '#ef4444', score: 0 }
];

function StaticQuestionReview({ questions, responses, notes, notApplicable = {}, onResponseChange, onNoteChange, onNotApplicableChange, hideCompleted = false }) {
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
        const isNA = notApplicable[item.id] || false;
        const options = item.options || DEFAULT_LIGHT_OPTIONS;
        const questionNumber = questionNumbers[item.id];
        
        return (
          <div 
            key={item.id} 
            className={`space-y-4 p-3 rounded-lg transition-opacity ${isNA ? 'bg-muted/30 opacity-50' : 'bg-muted/50'}`} 
            data-testid={`static-question-${index}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className={`text-sm font-medium pb-1 flex-1 ${isNA ? 'line-through text-muted-foreground' : ''}`}>
                <span className="text-muted-foreground mr-2">Q{questionNumber}.</span>
                {item.question}
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">N/A</span>
                <Switch
                  checked={isNA}
                  onCheckedChange={(checked) => onNotApplicableChange?.(item.id, checked)}
                  data-testid={`switch-na-${item.id}`}
                />
              </div>
            </div>
            <div className={`flex items-center justify-center gap-3 ${isNA ? 'pointer-events-none' : ''}`}>
              {options.map((opt) => {
                const optColor = opt.color || '#6b7280';
                const isSelected = response === opt.id;
                const scoreValue = opt.score !== undefined ? opt.score : (opt.value !== undefined ? opt.value : '');
                return (
                  <div
                    key={opt.id}
                    role="button"
                    tabIndex={isNA ? -1 : 0}
                    onClick={() => !isNA && onResponseChange(item.id, opt.id)}
                    onKeyDown={(e) => { if (!isNA && (e.key === 'Enter' || e.key === ' ')) onResponseChange(item.id, opt.id); }}
                    className={`relative flex flex-col items-center gap-2 ${isNA ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    data-testid={`light-${opt.id}-${item.id}`}
                  >
                    <div
                      className={`flex items-center justify-center text-white font-bold text-sm ${isSelected && !isNA ? '' : 'opacity-60'} ${isNA ? 'grayscale' : ''}`}
                      style={{ 
                        width: '48px',
                        height: '48px',
                        borderRadius: '50%',
                        backgroundColor: optColor,
                        boxShadow: isSelected && !isNA ? `0 0 0 4px white, 0 0 0 6px ${optColor}, 0 0 16px 4px ${optColor}` : `0 2px 4px rgba(0,0,0,0.2)`
                      }}
                    >
                      {scoreValue !== '' ? scoreValue : ''}
                    </div>
                    <span className={`text-xs ${isSelected && !isNA ? 'font-semibold' : 'text-muted-foreground'}`}>
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
              disabled={isNA}
              data-testid={`input-note-${item.id}`}
            />
          </div>
        );
      })}
    </div>
  );
}

function getEventIcon(eventType) {
  const icons = {
    submission_received: <ClipboardList className="w-4 h-4 text-blue-500" />,
    submission_updated: <Save className="w-4 h-4 text-green-500" />,
    status_changed: <ArrowLeft className="w-4 h-4 text-purple-500 rotate-180" />,
    score_calculated: <Calculator className="w-4 h-4 text-orange-500" />,
    email_sent: <Mail className="w-4 h-4 text-blue-500" />,
    contract_sent: <ClipboardList className="w-4 h-4 text-indigo-500" />,
    contract_signed: <Check className="w-4 h-4 text-green-500" />,
    meeting_request_sent: <Calendar className="w-4 h-4 text-teal-500" />,
    meeting_booked: <Calendar className="w-4 h-4 text-green-500" />,
    member_created: <Check className="w-4 h-4 text-green-500" />,
    swapped_from_form: <RotateCcw className="w-4 h-4 text-amber-500" />,
    archived_due_to_swap: <X className="w-4 h-4 text-gray-500" />
  };
  return icons[eventType] || <History className="w-4 h-4 text-muted-foreground" />;
}

function getEventLabel(eventType) {
  const labels = {
    submission_received: 'Submission Received',
    submission_updated: 'Review Saved',
    status_changed: 'Stage Changed',
    score_calculated: 'Score Calculated',
    email_sent: 'Email Sent',
    contract_sent: 'Contract Sent',
    contract_signed: 'Contract Signed',
    meeting_request_sent: 'Meeting Request Sent',
    meeting_booked: 'Meeting Booked',
    member_created: 'Member Created',
    swapped_from_form: 'Form Swapped',
    archived_due_to_swap: 'Archived (Swap)'
  };
  return labels[eventType] || eventType?.replace(/_/g, ' ') || 'Event';
}

function formatEventDetails(entry, stages = []) {
  const { event_type, details } = entry;
  if (!details) return null;
  
  const getStageName = (stageId) => {
    const stage = stages.find(s => s.id === stageId);
    return stage?.name || stageId;
  };
  
  switch (event_type) {
    case 'status_changed': {
      const from = getStageName(details.previous_status);
      const to = getStageName(details.new_status);
      const trigger = details.trigger === 'first_edit_auto_transition' ? ' (auto)' : '';
      return (
        <div className="space-y-1">
          <p className="text-sm">
            <span className="text-muted-foreground">From:</span> <span className="font-medium">{from}</span>
            <span className="mx-2 text-muted-foreground">→</span>
            <span className="text-muted-foreground">To:</span> <span className="font-medium">{to}</span>
            {trigger && <span className="text-xs text-muted-foreground">{trigger}</span>}
          </p>
          {details.custom_message && (
            <p className="text-sm text-muted-foreground italic">"{details.custom_message}"</p>
          )}
        </div>
      );
    }
    
    case 'submission_updated': {
      const fields = details.fields_updated || [];
      if (fields.length === 0) return null;
      return (
        <p className="text-sm text-muted-foreground">
          Updated {fields.length} field{fields.length !== 1 ? 's' : ''}
        </p>
      );
    }
    
    case 'score_calculated': {
      return (
        <div className="flex items-center gap-3 text-sm">
          <span>Score: <span className="font-medium">{details.score}</span></span>
          {details.risk_level && (
            <Badge variant="outline" className={cn(
              details.risk_level === 'low' && 'bg-green-50 text-green-700 border-green-200',
              details.risk_level === 'medium' && 'bg-amber-50 text-amber-700 border-amber-200',
              details.risk_level === 'high' && 'bg-red-50 text-red-700 border-red-200'
            )}>
              {details.risk_level} risk
            </Badge>
          )}
        </div>
      );
    }
    
    case 'email_sent': {
      return (
        <div className="space-y-1 text-sm">
          {details.template_name && <p>Template: <span className="font-medium">{details.template_name}</span></p>}
          {details.recipient && <p className="text-muted-foreground">To: {details.recipient}</p>}
          {details.recipients && details.recipients.length > 0 && (
            <p className="text-muted-foreground">To: {details.recipients.join(', ')}</p>
          )}
        </div>
      );
    }
    
    case 'contract_sent': {
      return (
        <div className="space-y-1 text-sm">
          {details.contract_name && <p>Contract: <span className="font-medium">{details.contract_name}</span></p>}
          {details.signers && details.signers.length > 0 && (
            <p className="text-muted-foreground">Sent to: {details.signers.join(', ')}</p>
          )}
        </div>
      );
    }
    
    case 'contract_signed': {
      return (
        <div className="space-y-1 text-sm">
          {details.contract_name && <p>Contract: <span className="font-medium">{details.contract_name}</span></p>}
          {details.signer && <p className="text-muted-foreground">Signed by: {details.signer}</p>}
        </div>
      );
    }
    
    case 'meeting_request_sent': {
      return (
        <div className="space-y-1 text-sm">
          {details.template_name && <p>Meeting: <span className="font-medium">{details.template_name}</span></p>}
          {details.recipient && <p className="text-muted-foreground">Sent to: {details.recipient}</p>}
          {details.agent_name && <p className="text-muted-foreground">Agent: {details.agent_name}</p>}
        </div>
      );
    }
    
    case 'meeting_booked': {
      return (
        <div className="space-y-1 text-sm">
          {details.meeting_name && <p>Meeting: <span className="font-medium">{details.meeting_name}</span></p>}
          {details.date_time && <p className="text-muted-foreground">Scheduled: {format(new Date(details.date_time), 'MMM d, yyyy h:mm a')}</p>}
          {details.attendee && <p className="text-muted-foreground">Attendee: {details.attendee}</p>}
        </div>
      );
    }
    
    case 'member_created': {
      return (
        <div className="space-y-1 text-sm">
          {details.member_name && <p>Member: <span className="font-medium">{details.member_name}</span></p>}
          {details.member_email && <p className="text-muted-foreground">{details.member_email}</p>}
        </div>
      );
    }
    
    case 'swapped_from_form': {
      return details.source_form_name ? (
        <p className="text-sm text-muted-foreground">From: {details.source_form_name}</p>
      ) : null;
    }
    
    default:
      return null;
  }
}

function ScheduleStatusBadge({ status }) {
  const config = {
    scheduled: { label: 'Scheduled', variant: 'outline', icon: Timer, className: 'text-blue-600 border-blue-200 bg-blue-50' },
    pending: { label: 'Pending', variant: 'outline', icon: Clock, className: 'text-amber-600 border-amber-200 bg-amber-50' },
    sent: { label: 'Sent', variant: 'outline', icon: CheckCircle2, className: 'text-green-600 border-green-200 bg-green-50' },
    completed: { label: 'Completed', variant: 'outline', icon: CheckCircle2, className: 'text-green-600 border-green-200 bg-green-50' },
    cancelled: { label: 'Cancelled', variant: 'outline', icon: XCircle, className: 'text-muted-foreground border-muted bg-muted/50' },
    missed: { label: 'Missed', variant: 'outline', icon: AlertCircle, className: 'text-red-600 border-red-200 bg-red-50' },
    awaiting_send: { label: 'Awaiting Send', variant: 'outline', icon: Clock, className: 'text-slate-600 border-slate-200 bg-slate-50' },
    info: { label: 'Info', variant: 'outline', icon: Info, className: 'text-blue-600 border-blue-200 bg-blue-50' }
  };
  const c = config[status] || config.pending;
  const Icon = c.icon;
  return (
    <Badge variant={c.variant} className={cn("gap-1", c.className)}>
      <Icon className="w-3 h-3" />
      {c.label}
    </Badge>
  );
}

function ScheduleEventIcon({ type }) {
  switch (type) {
    case 'contract_reminder':
      return <Bell className="w-3 h-3 text-blue-500" />;
    case 'contract_timeout':
      return <AlertTriangle className="w-3 h-3 text-amber-500" />;
    case 'meeting_request':
      return <Calendar className="w-3 h-3 text-purple-500" />;
    case 'meeting_reminder':
      return <Bell className="w-3 h-3 text-purple-500" />;
    case 'info':
      return <Info className="w-3 h-3 text-blue-500" />;
    default:
      return <Clock className="w-3 h-3" />;
  }
}

function ScheduleTab({ formSubmissionId }) {
  const [testResult, setTestResult] = useState(null);
  const [testingEventIndex, setTestingEventIndex] = useState(null);
  
  const { data: scheduleData, isLoading, error } = useQuery({
    queryKey: ['submission-schedule', formSubmissionId],
    queryFn: async () => {
      const response = await fetch(`/api/due-diligence/submission-schedule?form_submission_id=${formSubmissionId}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch schedule');
      return response.json();
    },
    enabled: !!formSubmissionId
  });

  const testFireMutation = useMutation({
    mutationFn: async ({ eventType, payload }) => {
      const endpoint = eventType === 'contract_timeout' 
        ? '/api/due-diligence/test-fire-timeout'
        : '/api/due-diligence/test-fire-reminder';
      
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const data = await response.json();
      return data;
    },
    onSuccess: (data) => {
      setTestResult(data);
      setTestingEventIndex(null);
    },
    onError: (error) => {
      toast.error('Test failed: ' + error.message);
      setTestingEventIndex(null);
    }
  });

  const handleTestFire = (event, index) => {
    setTestingEventIndex(index);
    
    // Validate required fields before making the request
    if (!event.contract?.id) {
      toast.error('Contract instance ID not found for this event');
      setTestingEventIndex(null);
      return;
    }
    
    console.log('[handleTestFire] Event data:', {
      type: event.type,
      contractId: event.contract?.id,
      reminderId: event.reminder_config?.id,
      signerEmail: event.recipient?.email
    });
    
    if (event.type === 'contract_timeout') {
      testFireMutation.mutate({
        eventType: 'contract_timeout',
        payload: {
          contractInstanceId: event.contract.id,
          dryRun: true
        }
      });
    } else if (event.type === 'contract_reminder') {
      if (!event.recipient?.email) {
        toast.error('Signer email not found for this reminder');
        setTestingEventIndex(null);
        return;
      }
      testFireMutation.mutate({
        eventType: 'contract_reminder',
        payload: {
          contractInstanceId: event.contract.id,
          reminderId: event.reminder_config?.id || event.reminder_id,
          signerEmail: event.recipient.email,
          dryRun: true
        }
      });
    } else {
      toast.info('Test fire not available for this event type');
      setTestingEventIndex(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center text-muted-foreground py-8">
        Failed to load schedule
      </div>
    );
  }

  const events = scheduleData?.scheduled_events || [];

  if (events.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        No scheduled events
      </div>
    );
  }

  const getEventTypeLabel = (type) => {
    switch (type) {
      case 'contract_reminder': return 'Contract Reminder';
      case 'contract_timeout': return 'Contract Timeout';
      case 'meeting_request': return 'Meeting Request';
      case 'meeting_reminder': return 'Meeting Reminder';
      default: return 'Event';
    }
  };

  const canTestFire = (event) => {
    return event.type === 'contract_reminder' || event.type === 'contract_timeout';
  };

  return (
    <>
      <div className="space-y-3">
        {events.map((event, index) => (
          <div 
            key={index}
            className={cn(
              "p-3 rounded-lg border space-y-2",
              event.status === 'cancelled' || event.status === 'missed' ? 'opacity-60' : ''
            )}
            data-testid={`schedule-event-${index}`}
          >
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center">
                  <ScheduleEventIcon type={event.type} />
                </div>
                <div>
                  <span className="font-medium text-sm">{event.name}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    {getEventTypeLabel(event.type)}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ScheduleStatusBadge status={event.status} />
                {canTestFire(event) && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleTestFire(event, index)}
                          disabled={testingEventIndex !== null}
                          data-testid={`button-test-fire-${index}`}
                        >
                          {testingEventIndex === index ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <>
                              <Timer className="w-3 h-3 mr-1" />
                              Test
                            </>
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Test what CRON would do (dry run)</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
            
            <div className="pl-8 space-y-1 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <CalendarClock className="w-3.5 h-3.5" />
                <span>
                  {event.status === 'sent' && event.actual_sent_date ? (
                    <>Sent: {format(new Date(event.actual_sent_date), 'MMM d, yyyy h:mm a')}</>
                  ) : event.scheduled_date ? (
                    <>Scheduled: {format(new Date(event.scheduled_date), 'MMM d, yyyy h:mm a')}</>
                  ) : event.status === 'awaiting_send' ? (
                    <>Timing: {event.reminder_config?.days || '?'} days {event.reminder_config?.timing_type === 'before_timeout' ? 'before timeout' : 'after send'}</>
                  ) : (
                    'Date pending'
                  )}
                </span>
              </div>
              
              {event.contract?.name && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <FileText className="w-3.5 h-3.5" />
                  <span>{event.contract.name}</span>
                </div>
              )}
              
              {(event.recipient?.title || event.contact_title) && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <PenLine className="w-3.5 h-3.5" />
                  <span>{event.recipient?.title || event.contact_title}</span>
                </div>
              )}
              
              {event.recipient?.name && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <User className="w-3.5 h-3.5" />
                  <span>{event.recipient.name}</span>
                </div>
              )}
              
              {event.recipient?.email && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Mail className="w-3.5 h-3.5" />
                  <span>{event.recipient.email}</span>
                </div>
              )}
              
              {event.status_reason && (
                <p className="text-xs text-muted-foreground italic">{event.status_reason}</p>
              )}
              
              {event.meeting && event.meeting.starts_at && (
                <div className="mt-2 p-2 bg-green-50 dark:bg-green-950/30 rounded text-green-700 dark:text-green-400 text-xs">
                  Meeting booked: {format(new Date(event.meeting.starts_at), 'MMM d, yyyy h:mm a')}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={!!testResult} onOpenChange={() => setTestResult(null)}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Timer className="w-5 h-5" />
              Test Fire Result
              {testResult?.dryRun && (
                <Badge variant="outline" className="ml-2">Dry Run</Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {testResult?.success 
                ? 'The CRON job would successfully process this event.'
                : testResult?.error || 'The CRON job would skip this event.'}
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto space-y-4">
            {testResult?.action && (
              <div className={cn(
                "p-3 rounded-lg text-sm font-medium",
                testResult.action === 'would_send' || testResult.action === 'sent' 
                  ? "bg-green-100 dark:bg-green-950 text-green-800 dark:text-green-300"
                  : testResult.action === 'skipped' || testResult.action === 'would_skip'
                  ? "bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300"
                  : "bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-300"
              )}>
                Action: {testResult.action === 'would_send' ? 'Would Send Email' :
                         testResult.action === 'sent' ? 'Email Sent' :
                         testResult.action === 'skipped' ? 'Skipped' :
                         testResult.action === 'would_skip' ? 'Would Skip' :
                         testResult.action === 'failed' ? 'Failed' : testResult.action}
              </div>
            )}

            {testResult?.checks?.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Checks Performed:</h4>
                <div className="space-y-1">
                  {testResult.checks.map((check, i) => (
                    <div 
                      key={i} 
                      className={cn(
                        "flex items-start gap-2 p-2 rounded text-xs",
                        check.passed 
                          ? "bg-green-50 dark:bg-green-950/30" 
                          : "bg-red-50 dark:bg-red-950/30"
                      )}
                    >
                      {check.passed ? (
                        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1">
                        <span className="font-medium">{check.check}</span>
                        {check.reason && (
                          <p className="text-muted-foreground mt-0.5">{check.reason}</p>
                        )}
                        {check.details && (
                          <pre className="text-[10px] mt-1 p-1 bg-muted rounded overflow-x-auto">
                            {JSON.stringify(check.details, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {testResult?.emailDetails && (
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Email Details:</h4>
                <div className="p-3 bg-muted rounded-lg space-y-2 text-xs">
                  <div className="flex gap-2">
                    <span className="font-medium w-16">To:</span>
                    <span>{testResult.emailDetails.to}</span>
                  </div>
                  {testResult.emailDetails.from && (
                    <div className="flex gap-2">
                      <span className="font-medium w-16">From:</span>
                      <span>{testResult.emailDetails.from}</span>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <span className="font-medium w-16">Subject:</span>
                    <span>{testResult.emailDetails.subject}</span>
                  </div>
                  {testResult.emailDetails.templateUsed && (
                    <div className="flex gap-2">
                      <span className="font-medium w-16">Template:</span>
                      <span>{testResult.emailDetails.templateUsed.name || testResult.emailDetails.templateUsed.id}</span>
                    </div>
                  )}
                  <div className="pt-2 border-t">
                    <span className="font-medium">Email Preview:</span>
                    {testResult.emailDetails.hasFooter && (
                      <span className="ml-2 text-xs text-green-600 dark:text-green-400">(includes footer)</span>
                    )}
                    <div 
                      className="mt-1 p-3 bg-white dark:bg-gray-900 rounded border text-sm max-h-64 overflow-y-auto"
                      dangerouslySetInnerHTML={{ 
                        __html: testResult.emailDetails.bodyHtml || testResult.emailDetails.bodyPreview 
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestResult(null)} data-testid="button-close-test-result">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HistoryLogModal({ isOpen, onClose, historyLog, stages = [], formSubmissionId }) {
  if (!isOpen) return null;
  
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="w-5 h-5" />
            Submission Details
          </DialogTitle>
        </DialogHeader>
        
        <Tabs defaultValue="history" className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="history" className="gap-2" data-testid="tab-history">
              <History className="w-4 h-4" />
              History
            </TabsTrigger>
            <TabsTrigger value="schedule" className="gap-2" data-testid="tab-schedule">
              <CalendarClock className="w-4 h-4" />
              Schedule
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="history" className="flex-1 overflow-y-auto py-4 mt-0">
            {historyLog && historyLog.length > 0 ? (
              <div className="relative">
                <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-border" />
                <div className="space-y-4">
                  {[...historyLog].reverse().map((entry, index) => (
                    <div 
                      key={index} 
                      className="relative pl-10"
                      data-testid={`history-entry-${index}`}
                    >
                      <div className="absolute left-2 top-1 w-5 h-5 rounded-full bg-background border-2 border-border flex items-center justify-center">
                        {getEventIcon(entry.event_type)}
                      </div>
                      <div className="p-3 bg-muted rounded-lg space-y-2">
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{getEventLabel(entry.event_type)}</span>
                          </div>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {entry.timestamp ? format(new Date(entry.timestamp), 'MMM d, yyyy h:mm a') : ''}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">{entry.user_email}</p>
                        {formatEventDetails(entry, stages)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-8">No history entries</p>
            )}
          </TabsContent>
          
          <TabsContent value="schedule" className="flex-1 overflow-y-auto py-4 mt-0">
            <ScheduleTab formSubmissionId={formSubmissionId} />
          </TabsContent>
        </Tabs>
        
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
  const [staticQuestionNotApplicable, setStaticQuestionNotApplicable] = useState({});
  const [workflowStatus, setWorkflowStatus] = useState('');
  const [isProcessingStatusChange, setIsProcessingStatusChange] = useState(false);
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
  const [agentSelectionModal, setAgentSelectionModal] = useState({ open: false, agents: [], pendingStatus: null, meetingActions: [], requiresCustomMessage: false, emailActions: [] });
  const [skipWarningModal, setSkipWarningModal] = useState({ open: false, pendingStatus: null, skippedStages: [] });
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [customMessageModal, setCustomMessageModal] = useState({ open: false, pendingStatus: null, emailActions: [], pendingAgentId: null });
  const [customMessageText, setCustomMessageText] = useState('');
  const [stageActionResultsModal, setStageActionResultsModal] = useState({ open: false, results: [] });

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

  // Query for organisations (for organisation_dropdown field display)
  const { data: organisations = [] } = useQuery({
    queryKey: ['organisations-for-dd-review'],
    queryFn: async () => await publicClient.listOrganizations() || [],
    staleTime: 5 * 60 * 1000,
    enabled: accessChecked
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
      setStaticQuestionNotApplicable(ddSubmission.static_question_not_applicable || {});
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
    // Look up the original value using fieldKey first, then field.name as fallback
    const fieldName = fieldKeyToName[fieldKey] || fieldKey;
    const originalValue = ddSubmission?.original_form_values?.[fieldKey] ?? ddSubmission?.original_form_values?.[fieldName];
    
    if (status === 'amended') {
      // When switching to amended, copy original value to reviewed for editing
      setReviewedFormValues(prev => ({
        ...prev,
        [fieldKey]: originalValue
      }));
    } else if (status === 'approved') {
      // When approved, clear the reviewed value (original is approved as-is)
      setReviewedFormValues(prev => ({
        ...prev,
        [fieldKey]: undefined
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

  const handleStaticNotApplicableChange = useCallback((questionId, isNA) => {
    setStaticQuestionNotApplicable(prev => ({ ...prev, [questionId]: isNA }));
    setHasUnsavedChanges(true);
  }, []);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      return await apiRequest('POST', '/api/due-diligence/save-review', data);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['dd-submission', submissionId] });
      setHasUnsavedChanges(false);
      
      // Check if an auto-transition occurred on first edit
      if (data.first_edit_transition?.triggered) {
        setWorkflowStatus(data.first_edit_transition.new_status);
        toast.success(`Review saved - Stage changed to "${data.first_edit_transition.stage_label}"`);
      } else {
        toast.success('Review saved successfully');
      }
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
    mutationFn: async ({ newStatus, selectedAgentId, customMessage }) => {
      return await apiRequest('POST', '/api/due-diligence/update-status', {
        submissionId: submissionId,
        newStatus: newStatus,
        selectedAgentId: selectedAgentId || null,
        customMessage: customMessage || null
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

        // Check for skipped member creation actions and show modal warning
        const memberCreationResults = data.stage_actions_results.filter(r => r.action === 'create_member');
        const skippedMembers = memberCreationResults.filter(r => r.status === 'skipped');
        const successfulMembers = memberCreationResults.filter(r => r.status === 'success');
        
        if (successfulMembers.length > 0) {
          toast.success(`${successfulMembers.length} member(s) created successfully`);
        }
        
        if (skippedMembers.length > 0) {
          setStageActionResultsModal({ open: true, results: skippedMembers });
        }
      }
    },
    onError: (error) => {
      toast.error('Failed to update status: ' + error.message);
    },
    onSettled: () => {
      setIsProcessingStatusChange(false); // Always release lock when mutation completes
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
      staticQuestionNotApplicable,
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
    console.log('[ReviewSubmission] handleStatusChange called');
    console.log('[ReviewSubmission] newStatus:', newStatus);
    console.log('[ReviewSubmission] currentStatus:', workflowStatus);
    
    if (newStatus === workflowStatus) {
      console.log('[ReviewSubmission] Status unchanged, returning early');
      return;
    }
    
    // Immediately show lock overlay to prevent race conditions
    setIsProcessingStatusChange(true);
    
    const formId = form?.id || ddSubmission?.form_submission?.form_id;
    
    // Check if stages are being skipped and if they have actions
    const currentStageIndex = workflowStages.findIndex(s => s.id === workflowStatus);
    const targetStageIndex = workflowStages.findIndex(s => s.id === newStatus);
    
    if (targetStageIndex > currentStageIndex + 1 && formId) {
      // Stages are being skipped - check if any have actions
      const skippedStageIds = workflowStages
        .slice(currentStageIndex + 1, targetStageIndex)
        .map(s => s.id);
      
      console.log('[ReviewSubmission] Skipped stages:', skippedStageIds);
      
      try {
        // Check each skipped stage for actions
        const skippedWithActions = [];
        for (const stageId of skippedStageIds) {
          const checkResult = await apiRequest('POST', '/api/due-diligence/check-stage-actions', {
            stageId,
            formId
          });
          
          const stage = workflowStages.find(s => s.id === stageId);
          const actions = [];
          
          if (checkResult.email_actions?.length > 0) {
            checkResult.email_actions.forEach(ea => {
              actions.push({ type: 'email', name: ea.template_name || 'Email Action' });
            });
          }
          if (checkResult.meeting_actions?.length > 0) {
            checkResult.meeting_actions.forEach(ma => {
              actions.push({ type: 'meeting', name: ma.template_name || 'Meeting Request' });
            });
          }
          // Check stage_actions from workflow config for contracts
          if (stage?.stage_actions?.send_contracts?.length > 0) {
            stage.stage_actions.send_contracts.forEach(c => {
              actions.push({ type: 'contract', name: c.form_name || 'Contract' });
            });
          }
          
          if (actions.length > 0) {
            skippedWithActions.push({
              stageId,
              stageLabel: stage?.label || stageId,
              stageColor: stage?.color || '#888',
              actions
            });
          }
        }
        
        if (skippedWithActions.length > 0) {
          console.log('[ReviewSubmission] Skipped stages with actions:', skippedWithActions);
          setIsProcessingStatusChange(false); // Release lock to allow modal interaction
          setSkipWarningModal({
            open: true,
            pendingStatus: newStatus,
            skippedStages: skippedWithActions
          });
          return;
        }
      } catch (error) {
        console.error('[ReviewSubmission] Error checking skipped stage actions:', error);
        // Continue with status change if we can't check skipped actions
      }
    }
    
    // Check if this stage has meeting request actions with multiple agents or email actions with custom message
    try {
      let requiresAgentSelection = false;
      let requiresCustomMessage = false;
      let allAgents = [];
      let emailActions = [];
      let meetingActions = [];
      
      if (formId) {
        console.log('[ReviewSubmission] Calling check-stage-actions API...');
        const checkResult = await apiRequest('POST', '/api/due-diligence/check-stage-actions', {
          stageId: newStatus,
          formId: formId
        });
        
        console.log('[ReviewSubmission] check-stage-actions response:', checkResult);
        console.log('[ReviewSubmission] requires_agent_selection:', checkResult.requires_agent_selection);
        console.log('[ReviewSubmission] requires_custom_message:', checkResult.requires_custom_message);
        console.log('[ReviewSubmission] meeting_actions length:', checkResult.meeting_actions?.length);
        console.log('[ReviewSubmission] email_actions length:', checkResult.email_actions?.length);
        console.log('[ReviewSubmission] DEBUG INFO:', checkResult._debug);
        
        requiresAgentSelection = checkResult.requires_agent_selection;
        requiresCustomMessage = checkResult.requires_custom_message;
        meetingActions = checkResult.meeting_actions || [];
        emailActions = checkResult.email_actions || [];
        
        if (requiresAgentSelection && meetingActions.length > 0) {
          // Get all unique agents from all meeting actions
          const seenIds = new Set();
          meetingActions.forEach(action => {
            action.agents.forEach(agent => {
              if (!seenIds.has(agent.identity_id)) {
                seenIds.add(agent.identity_id);
                allAgents.push(agent);
              }
            });
          });
          
          console.log('[ReviewSubmission] allAgents collected:', allAgents);
          console.log('[ReviewSubmission] allAgents count:', allAgents.length);
          
          // Show modal if there are any agents to select from (even just 1 for confirmation)
          if (allAgents.length >= 1) {
            console.log('[ReviewSubmission] Opening agent selection modal');
            setIsProcessingStatusChange(false); // Release lock to allow modal interaction
            setAgentSelectionModal({
              open: true,
              agents: allAgents,
              pendingStatus: newStatus,
              meetingActions: meetingActions,
              requiresCustomMessage: requiresCustomMessage,
              emailActions: emailActions
            });
            setSelectedAgentId(allAgents[0]?.identity_id || null);
            return;
          } else if (allAgents.length === 0) {
            console.log('[ReviewSubmission] No agents available');
            setIsProcessingStatusChange(false); // Release lock on error
            toast.error('No booking agents available for this meeting type. Please configure agents first.');
            return;
          }
          console.log('[ReviewSubmission] Only 1 agent, auto-selecting');
        } else {
          console.log('[ReviewSubmission] Agent selection not required or no meeting actions');
        }
        
        // If no agent selection needed but custom message is required, show custom message modal
        if (!requiresAgentSelection && requiresCustomMessage) {
          console.log('[ReviewSubmission] Opening custom message modal (no agent selection needed)');
          setIsProcessingStatusChange(false); // Release lock to allow modal interaction
          setCustomMessageModal({
            open: true,
            pendingStatus: newStatus,
            emailActions: emailActions,
            pendingAgentId: null
          });
          setCustomMessageText('');
          return;
        }
      } else {
        console.log('[ReviewSubmission] No formId available, skipping stage action checks');
      }
    } catch (error) {
      console.error('[ReviewSubmission] Error checking stage actions:', error);
      // Show error for auth/access issues but allow proceeding for other errors
      if (error.message?.includes('Authentication') || error.message?.includes('Tenant')) {
        setIsProcessingStatusChange(false); // Release lock on error
        toast.error('Unable to change status: ' + error.message);
        return;
      }
    }
    
    // No modals needed, proceed directly
    console.log('[ReviewSubmission] Proceeding with status update, no modals needed');
    updateStatusMutation.mutate({ newStatus, selectedAgentId: null, customMessage: null });
  };

  const handleConfirmAgentSelection = () => {
    const { pendingStatus, requiresCustomMessage, emailActions } = agentSelectionModal;
    console.log('[ReviewSubmission] handleConfirmAgentSelection called');
    console.log('[ReviewSubmission] pendingStatus:', pendingStatus);
    console.log('[ReviewSubmission] selectedAgentId:', selectedAgentId);
    console.log('[ReviewSubmission] requiresCustomMessage:', requiresCustomMessage);
    
    setAgentSelectionModal({ open: false, agents: [], pendingStatus: null, meetingActions: [], requiresCustomMessage: false, emailActions: [] });
    
    // If custom message is also required, show that modal next
    if (requiresCustomMessage) {
      console.log('[ReviewSubmission] Opening custom message modal after agent selection');
      setCustomMessageModal({
        open: true,
        pendingStatus: pendingStatus,
        emailActions: emailActions || [],
        pendingAgentId: selectedAgentId
      });
      setCustomMessageText('');
      return;
    }
    
    updateStatusMutation.mutate({ newStatus: pendingStatus, selectedAgentId, customMessage: null });
  };

  const handleCancelAgentSelection = () => {
    setAgentSelectionModal({ open: false, agents: [], pendingStatus: null, meetingActions: [], requiresCustomMessage: false, emailActions: [] });
    setSelectedAgentId(null);
  };

  const handleConfirmCustomMessage = () => {
    const { pendingStatus, pendingAgentId } = customMessageModal;
    console.log('[ReviewSubmission] handleConfirmCustomMessage called');
    console.log('[ReviewSubmission] pendingStatus:', pendingStatus);
    console.log('[ReviewSubmission] pendingAgentId:', pendingAgentId);
    console.log('[ReviewSubmission] customMessageText:', customMessageText);
    
    setCustomMessageModal({ open: false, pendingStatus: null, emailActions: [], pendingAgentId: null });
    updateStatusMutation.mutate({ newStatus: pendingStatus, selectedAgentId: pendingAgentId, customMessage: customMessageText });
  };

  const handleCancelCustomMessage = () => {
    setCustomMessageModal({ open: false, pendingStatus: null, emailActions: [], pendingAgentId: null });
    setCustomMessageText('');
  };

  const handleConfirmSkipWarning = async () => {
    const { pendingStatus } = skipWarningModal;
    setSkipWarningModal({ open: false, pendingStatus: null, skippedStages: [] });
    
    // Continue with status change flow - need to check target stage for agent selection/custom message
    const formId = form?.id || ddSubmission?.form_submission?.form_id;
    
    if (formId) {
      try {
        const checkResult = await apiRequest('POST', '/api/due-diligence/check-stage-actions', {
          stageId: pendingStatus,
          formId
        });
        
        const requiresAgentSelection = checkResult.requires_agent_selection;
        const requiresCustomMessage = checkResult.requires_custom_message;
        const meetingActions = checkResult.meeting_actions || [];
        const emailActions = checkResult.email_actions || [];
        
        if (requiresAgentSelection && meetingActions.length > 0) {
          const seenIds = new Set();
          const allAgents = [];
          meetingActions.forEach(action => {
            action.agents.forEach(agent => {
              if (!seenIds.has(agent.identity_id)) {
                seenIds.add(agent.identity_id);
                allAgents.push(agent);
              }
            });
          });
          
          if (allAgents.length >= 1) {
            setAgentSelectionModal({
              open: true,
              agents: allAgents,
              pendingStatus: pendingStatus,
              meetingActions: meetingActions,
              requiresCustomMessage: requiresCustomMessage,
              emailActions: emailActions
            });
            setSelectedAgentId(allAgents[0]?.identity_id || null);
            return;
          }
        }
        
        if (!requiresAgentSelection && requiresCustomMessage) {
          setCustomMessageModal({
            open: true,
            pendingStatus: pendingStatus,
            emailActions: emailActions,
            pendingAgentId: null
          });
          setCustomMessageText('');
          return;
        }
      } catch (error) {
        console.error('[ReviewSubmission] Error checking target stage actions after skip:', error);
      }
    }
    
    // No modals needed, proceed directly
    updateStatusMutation.mutate({ newStatus: pendingStatus, selectedAgentId: null, customMessage: null });
  };

  const handleCancelSkipWarning = () => {
    setSkipWarningModal({ open: false, pendingStatus: null, skippedStages: [] });
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
      // Scroll to top of page for better UX
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const goToPreviousPage = () => {
    if (!isFirstPage) {
      setCurrentPageIndex(prev => prev - 1);
      // Scroll to top of page for better UX
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // Calculate live traffic light score based on current responses
  const liveTrafficLightScore = useMemo(() => {
    if (ddConfig?.scoring_approach !== 'static_traffic_light') return null;
    
    const questions = (ddConfig?.static_questions || []).filter(q => q.type !== 'header');
    if (questions.length === 0) return { score: 0, percentage: 0, maxScore: 0, riskLevel: null, answeredCount: 0, totalQuestions: 0, naCount: 0 };
    
    let actualScore = 0;
    let maxPossibleScore = 0;
    let answeredCount = 0;
    let naCount = 0;
    
    for (const question of questions) {
      // Skip N/A questions from scoring
      if (staticQuestionNotApplicable[question.id] === true) {
        naCount++;
        continue;
      }
      
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
    
    // Applicable questions = total minus N/A
    const applicableQuestions = questions.length - naCount;
    
    return { 
      score: actualScore, 
      maxScore: maxPossibleScore, 
      percentage, 
      riskLevel, 
      answeredCount, 
      totalQuestions: questions.length,
      applicableQuestions,
      naCount
    };
  }, [ddConfig, staticQuestionResponses, staticQuestionNotApplicable]);

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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6 space-y-6 relative">
      {(isProcessingStatusChange || updateStatusMutation.isPending) && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center" data-testid="status-processing-overlay">
          <div className="bg-white rounded-xl p-8 shadow-2xl flex flex-col items-center gap-4">
            <Loader2 className="w-12 h-12 animate-spin text-primary" />
            <div className="text-center">
              <p className="font-semibold text-lg">Processing Status Change</p>
              <p className="text-sm text-muted-foreground">Please wait while we update the status and execute any configured actions...</p>
            </div>
          </div>
        </div>
      )}
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
                  const isConditionLocked = conditionStatus && !conditionStatus.met;
                  const isCurrentStage = stage.id === workflowStatus;
                  
                  // Check if stage is locked due to sequence enforcement
                  const currentStageIndex = workflowStages.findIndex(s => s.id === workflowStatus);
                  const stageIndex = workflowStages.findIndex(s => s.id === stage.id);
                  // Only enforce sequence lock if current stage is found in the list
                  const isSequenceLocked = ddConfig?.enforce_stage_sequence && 
                    currentStageIndex >= 0 && stageIndex >= 0 && stageIndex < currentStageIndex;
                  
                  const isLocked = isConditionLocked || isSequenceLocked;
                  
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
                      {isLocked && !isCurrentStage && (isSequenceLocked || conditionStatus?.reasons?.length > 0) && (
                        <TooltipContent side="left" className="max-w-64">
                          <div className="space-y-1">
                            {isSequenceLocked && (
                              <p className="text-xs">This stage has been passed and cannot be selected (stage sequence is enforced)</p>
                            )}
                            {isConditionLocked && conditionStatus?.reasons?.length > 0 && (
                              <>
                                <p className="font-medium text-xs">Conditions not met:</p>
                                <ul className="text-xs space-y-0.5">
                                  {conditionStatus.reasons.map((reason, i) => (
                                    <li key={i} className="flex items-center gap-1">
                                      <span className="w-1 h-1 rounded-full bg-current" />
                                      {reason}
                                    </li>
                                  ))}
                                </ul>
                              </>
                            )}
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
                        originalValue={originalFormValues[fieldKey] ?? originalFormValues[field.name]}
                        reviewedValue={reviewedFormValues[fieldKey]}
                        reviewStatus={fieldReviewStatus[fieldKey]}
                        onChange={handleFieldChange}
                        onStatusChange={handleFieldStatusChange}
                        note={fieldNotes[fieldKey]}
                        onNoteChange={handleFieldNoteChange}
                        organisations={organisations}
                        linkedOrganisationId={organization?.id}
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
            formId={form?.id || ddSubmission?.form_submission?.form_id}
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
        stages={ddConfig?.workflow_stages || []}
        formSubmissionId={ddSubmission?.form_submission_id}
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
            {agentSelectionModal.meetingActions?.length > 0 && (
              <div className="mt-2 text-sm font-medium">
                Meeting: {agentSelectionModal.meetingActions.map(a => a.template_name).filter(Boolean).join(', ')}
              </div>
            )}
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

      <Dialog open={customMessageModal.open} onOpenChange={(open) => !open && handleCancelCustomMessage()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5" />
              Add Custom Message
            </DialogTitle>
            <DialogDescription>
              Enter a custom message to include in the email{customMessageModal.emailActions?.length > 1 ? 's' : ''} that will be sent when changing to this stage.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              value={customMessageText}
              onChange={(e) => setCustomMessageText(e.target.value)}
              placeholder="Enter your custom message here..."
              rows={4}
              data-testid="textarea-custom-message"
            />
            <p className="text-xs text-muted-foreground mt-2">
              This message will replace the <code className="bg-muted px-1 rounded">{"{{custom_message}}"}</code> placeholder in the email template.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelCustomMessage} data-testid="button-cancel-custom-message">
              Cancel
            </Button>
            <Button onClick={handleConfirmCustomMessage} data-testid="button-confirm-custom-message">
              Confirm & Change Status
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={skipWarningModal.open} onOpenChange={(open) => !open && handleCancelSkipWarning()}>
        <DialogContent className="max-w-lg" data-testid="dialog-skip-warning">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              Skipping Stages with Actions
            </DialogTitle>
            <DialogDescription>
              You are about to skip one or more stages that have actions configured. These actions will NOT be executed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {skipWarningModal.skippedStages.map((skippedStage) => (
              <div key={skippedStage.stageId} className="border rounded-lg p-3 bg-amber-50 dark:bg-amber-950/30">
                <div className="flex items-center gap-2 mb-2">
                  <div 
                    className="w-3 h-3 rounded-full" 
                    style={{ backgroundColor: skippedStage.stageColor }} 
                  />
                  <span className="font-medium">{skippedStage.stageLabel}</span>
                </div>
                <ul className="space-y-1 ml-5">
                  {skippedStage.actions.map((action, idx) => (
                    <li key={idx} className="flex items-center gap-2 text-sm text-muted-foreground">
                      {action.type === 'email' && <Mail className="w-3 h-3" />}
                      {action.type === 'meeting' && <Calendar className="w-3 h-3" />}
                      {action.type === 'contract' && <FileSignature className="w-3 h-3" />}
                      <span>{action.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelSkipWarning} data-testid="button-cancel-skip">
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmSkipWarning} data-testid="button-confirm-skip">
              Skip Actions & Proceed
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={stageActionResultsModal.open} onOpenChange={(open) => !open && setStageActionResultsModal({ open: false, results: [] })}>
        <DialogContent className="max-w-lg" data-testid="dialog-stage-action-results">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              Member Creation Warning
            </DialogTitle>
            <DialogDescription>
              Some members could not be created during this stage transition. The stage change was successful, but the following members were skipped:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4 max-h-[300px] overflow-y-auto">
            {stageActionResultsModal.results.map((result, idx) => (
              <div key={idx} className="flex items-start gap-3 p-3 rounded-lg border bg-amber-50 dark:bg-amber-950/30">
                <UserPlus className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {result.reason || 'Member could not be created'}
                  </div>
                  {result.existing_member_id && (
                    <div className="text-xs text-muted-foreground mt-1">
                      A member with this email already exists in the system
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={() => setStageActionResultsModal({ open: false, results: [] })} data-testid="button-close-action-results">
              Understood
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
                notApplicable={staticQuestionNotApplicable}
                onResponseChange={handleStaticResponseChange}
                onNoteChange={handleStaticNoteChange}
                onNotApplicableChange={handleStaticNotApplicableChange}
                hideCompleted={hideCompletedQuestions}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
