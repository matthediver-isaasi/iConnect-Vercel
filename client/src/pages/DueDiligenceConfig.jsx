import { useState, useEffect, useMemo, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertCircle, Plus, Trash2, Save, GripVertical, ChevronDown, ArrowLeft, Loader2, Star, ShieldCheck, Clock, FileText, Settings, ChevronRight, Lock, FileCheck, UserCheck, Play, Mail, Send, Calendar, Pencil } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { cn } from "@/lib/utils";

const DEFAULT_WORKFLOW_STAGES = [
  { id: "new", label: "New", color: "#f97316", is_initial: true, include_in_housekeeping: true, order: 0 },
  { id: "in_review", label: "In Review", color: "#a855f7", is_initial: false, include_in_housekeeping: true, order: 1 },
  { id: "verified", label: "Verified", color: "#3b82f6", is_initial: false, include_in_housekeeping: true, order: 2 },
  { id: "approved", label: "Approved", color: "#22c55e", is_initial: false, include_in_housekeeping: false, order: 3 },
  { id: "rejected", label: "Rejected", color: "#ef4444", is_initial: false, include_in_housekeeping: false, order: 4 }
];

const DEFAULT_RISK_LEVELS = [
  { name: "Low Risk", threshold: 80, color: "#22c55e" },
  { name: "Medium Risk", threshold: 50, color: "#f59e0b" },
  { name: "High Risk", threshold: 20, color: "#f97316" },
  { name: "Critical Risk", threshold: 0, color: "#ef4444" }
];

const PRESET_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e",
  "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#6b7280"
];

const DEFAULT_LIGHT_OPTIONS = [
  { id: 'green', label: 'Green', color: '#22c55e', score: 2 },
  { id: 'amber', label: 'Amber', color: '#f59e0b', score: 1 },
  { id: 'red', label: 'Red', color: '#ef4444', score: 0 }
];

export default function DueDiligenceConfigPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  
  const formId = searchParams.get('formId');
  
  const [scoringApproach, setScoringApproach] = useState('dynamic');
  const [defaultReviewState, setDefaultReviewState] = useState('amended');
  const [cardReferenceField, setCardReferenceField] = useState('');
  const [showDescriptionFields, setShowDescriptionFields] = useState(false);
  const [scoringRules, setScoringRules] = useState({ rules: [], risk_thresholds: {} });
  const [staticQuestions, setStaticQuestions] = useState([]);
  const [customRiskLevels, setCustomRiskLevels] = useState(DEFAULT_RISK_LEVELS);
  const [workflowStages, setWorkflowStages] = useState(DEFAULT_WORKFLOW_STAGES);
  const [statusWebhooks, setStatusWebhooks] = useState([]);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [openStageSection, setOpenStageSection] = useState({}); // { stageIndex: 'conditions' | 'actions' | null }
  const [pendingMeetingRequest, setPendingMeetingRequest] = useState(null); // { stageId, templateId, emailField, firstNameField, editId? }

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_DueDiligenceConfig')) {
        window.location.href = createPageUrl('FormManagement');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: ddEnabledForms = [], isLoading: formsLoading } = useQuery({
    queryKey: ['dd-enabled-forms'],
    queryFn: async () => {
      const allForms = await base44.entities.Form.list();
      return allForms.filter(f => f.due_diligence_required === true);
    },
    enabled: !formId && accessChecked
  });

  const { data: ddConfigs = [] } = useQuery({
    queryKey: ['dd-configs-all'],
    queryFn: async () => {
      return await base44.entities.FormDueDiligenceConfig.list();
    },
    enabled: !formId && accessChecked
  });

  const { data: form, isLoading: formLoading } = useQuery({
    queryKey: ['form-for-dd-config', formId],
    queryFn: async () => {
      const forms = await base44.entities.Form.filter({ id: formId });
      return forms[0];
    },
    enabled: !!formId && accessChecked
  });

  const { data: ddConfig, isLoading: configLoading } = useQuery({
    queryKey: ['dd-config', formId],
    queryFn: async () => {
      const configs = await base44.entities.FormDueDiligenceConfig.filter({ form_id: formId });
      return configs[0];
    },
    enabled: !!formId && accessChecked
  });

  const { data: meetingTemplatesData } = useQuery({
    queryKey: ['meeting-templates'],
    queryFn: async () => {
      const response = await fetch('/api/meeting-templates', { credentials: 'include' });
      if (!response.ok) return [];
      const data = await response.json();
      return data.templates || [];
    },
    enabled: !!formId && accessChecked
  });
  const meetingTemplates = meetingTemplatesData || [];

  const { data: stageMeetingRequestsData, refetch: refetchStageMeetingRequests } = useQuery({
    queryKey: ['stage-meeting-requests'],
    queryFn: async () => {
      const response = await fetch('/api/stage-meeting-requests', { credentials: 'include' });
      if (!response.ok) return [];
      const data = await response.json();
      return data.meeting_requests || [];
    },
    enabled: !!formId && accessChecked
  });
  const stageMeetingRequests = stageMeetingRequestsData || [];

  const addStageMeetingRequest = async (stageId, meetingTemplateId, recipientEmailField, firstNameField) => {
    try {
      const response = await fetch('/api/stage-meeting-requests', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          due_diligence_stage_id: stageId,
          meeting_template_id: meetingTemplateId,
          recipient_email_field: recipientEmailField,
          first_name_field: firstNameField
        })
      });
      if (!response.ok) throw new Error('Failed to add meeting request');
      await refetchStageMeetingRequests();
      toast.success('Meeting request action added');
    } catch (err) {
      toast.error(err.message || 'Failed to add meeting request');
    }
  };

  const removeStageMeetingRequest = async (id) => {
    try {
      const response = await fetch(`/api/stage-meeting-requests/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to remove meeting request');
      await refetchStageMeetingRequests();
      toast.success('Meeting request action removed');
    } catch (err) {
      toast.error(err.message || 'Failed to remove meeting request');
    }
  };

  const updateStageMeetingRequest = async (id, meetingTemplateId, recipientEmailField, firstNameField) => {
    try {
      const response = await fetch(`/api/stage-meeting-requests/${id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meeting_template_id: meetingTemplateId,
          recipient_email_field: recipientEmailField,
          first_name_field: firstNameField
        })
      });
      if (!response.ok) throw new Error('Failed to update meeting request');
      await refetchStageMeetingRequests();
      toast.success('Meeting request action updated');
    } catch (err) {
      toast.error(err.message || 'Failed to update meeting request');
    }
  };

  const getEmailFields = () => {
    return (form?.fields || []).filter(f => f.type === 'email');
  };

  const getTextFields = () => {
    return (form?.fields || []).filter(f => f.type === 'text' || f.type === 'short_text');
  };

  const normalizeStaticQuestions = (questions) => {
    if (!questions || !Array.isArray(questions)) return [];
    return questions.map(q => {
      if (q.type === 'header') return q;
      if (!q.options || q.options.length === 0) {
        return {
          ...q,
          options: DEFAULT_LIGHT_OPTIONS.map(opt => ({
            ...opt,
            id: `opt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          }))
        };
      }
      return {
        ...q,
        options: q.options.map(opt => ({
          ...opt,
          id: opt.id || `opt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        }))
      };
    });
  };

  useEffect(() => {
    if (ddConfig && !hasInitialized) {
      setScoringApproach(ddConfig.scoring_approach || 'dynamic');
      setDefaultReviewState(ddConfig.default_review_state || 'amended');
      setCardReferenceField(ddConfig.card_reference_field || '');
      setShowDescriptionFields(ddConfig.show_description_fields || false);
      setScoringRules(ddConfig.scoring_rules || { rules: [], risk_thresholds: {} });
      setStaticQuestions(normalizeStaticQuestions(ddConfig.static_questions));
      setCustomRiskLevels(ddConfig.custom_risk_levels?.length > 0 ? ddConfig.custom_risk_levels : DEFAULT_RISK_LEVELS);
      setWorkflowStages(ddConfig.workflow_stages?.length > 0 ? ddConfig.workflow_stages : DEFAULT_WORKFLOW_STAGES);
      setStatusWebhooks(ddConfig.status_change_webhooks || []);
      setHasInitialized(true);
    }
  }, [ddConfig, hasInitialized]);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      const configData = {
        form_id: formId,
        tenant_id: memberInfo?.tenant_id,
        scoring_approach: data.scoringApproach,
        default_review_state: data.defaultReviewState,
        card_reference_field: data.cardReferenceField || null,
        show_description_fields: data.showDescriptionFields || false,
        scoring_rules: data.scoringRules,
        static_questions: data.staticQuestions,
        custom_risk_levels: data.customRiskLevels,
        workflow_stages: data.workflowStages.map((s, i) => ({ ...s, order: i })),
        status_change_webhooks: data.statusWebhooks,
        is_active: true
      };

      if (ddConfig?.id) {
        return await base44.entities.FormDueDiligenceConfig.update(ddConfig.id, configData);
      } else {
        return await base44.entities.FormDueDiligenceConfig.create(configData);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dd-config', formId] });
      toast.success('Configuration saved successfully');
    },
    onError: (error) => {
      toast.error('Failed to save configuration: ' + error.message);
    }
  });

  const handleSave = () => {
    saveMutation.mutate({
      scoringApproach,
      defaultReviewState,
      cardReferenceField,
      showDescriptionFields,
      scoringRules,
      staticQuestions,
      customRiskLevels,
      workflowStages,
      statusWebhooks
    });
  };

  const addStaticQuestion = (type = 'question') => {
    const newItem = {
      id: `${type === 'header' ? 'h' : 'q'}_${Date.now()}`,
      type,
      ...(type === 'question' ? { 
        question: '', 
        weight: 1,
        options: DEFAULT_LIGHT_OPTIONS.map(opt => ({ ...opt, id: `opt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}` }))
      } : { text: '' })
    };
    setStaticQuestions([...staticQuestions, newItem]);
  };

  const updateStaticQuestion = (index, field, value) => {
    const updated = [...staticQuestions];
    updated[index] = { ...updated[index], [field]: value };
    setStaticQuestions(updated);
  };

  const removeStaticQuestion = (index) => {
    setStaticQuestions(staticQuestions.filter((_, i) => i !== index));
  };

  const addLightOption = (questionIndex) => {
    const updated = [...staticQuestions];
    const question = updated[questionIndex];
    const options = question.options || [];
    const newOption = {
      id: `opt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      label: 'New Option',
      color: PRESET_COLORS[options.length % PRESET_COLORS.length],
      score: 0
    };
    updated[questionIndex] = { ...question, options: [...options, newOption] };
    setStaticQuestions(updated);
  };

  const updateLightOption = (questionIndex, optionIndex, field, value) => {
    const updated = [...staticQuestions];
    const question = updated[questionIndex];
    const options = [...(question.options || [])];
    options[optionIndex] = { ...options[optionIndex], [field]: value };
    updated[questionIndex] = { ...question, options };
    setStaticQuestions(updated);
  };

  const removeLightOption = (questionIndex, optionIndex) => {
    const updated = [...staticQuestions];
    const question = updated[questionIndex];
    const options = question.options || [];
    if (options.length <= 2) {
      toast.error("You must have at least 2 options per question");
      return;
    }
    updated[questionIndex] = { 
      ...question, 
      options: options.filter((_, i) => i !== optionIndex) 
    };
    setStaticQuestions(updated);
  };

  const handleStageDragEnd = (result) => {
    if (!result.destination) return;
    const items = Array.from(workflowStages);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);
    setWorkflowStages(items.map((item, index) => ({ ...item, order: index })));
  };

  const handleQuestionDragEnd = (result) => {
    if (!result.destination) return;
    const items = Array.from(staticQuestions);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);
    setStaticQuestions(items);
  };

  const questionNumbers = useMemo(() => {
    const numbers = {};
    let count = 0;
    staticQuestions.forEach((item) => {
      if (item.type !== 'header') {
        count++;
        numbers[item.id] = count;
      }
    });
    return numbers;
  }, [staticQuestions]);

  const addWorkflowStage = () => {
    const newStage = {
      id: `stage_${Date.now()}`,
      label: "New Stage",
      color: "#6b7280",
      is_initial: false,
      include_in_housekeeping: true,
      order: workflowStages.length,
      selection_conditions: {},
      stage_actions: {}
    };
    setWorkflowStages([...workflowStages, newStage]);
  };

  const updateWorkflowStage = (index, field, value) => {
    const updated = [...workflowStages];
    updated[index] = { ...updated[index], [field]: value };
    setWorkflowStages(updated);
  };

  const removeWorkflowStage = (index) => {
    setWorkflowStages(workflowStages.filter((_, i) => i !== index));
  };

  const setInitialStage = (index) => {
    setWorkflowStages(workflowStages.map((s, i) => ({ ...s, is_initial: i === index })));
  };

  const addRiskLevel = () => {
    setCustomRiskLevels([...customRiskLevels, { name: "New Level", threshold: 50, color: "#3b82f6" }]);
  };

  const updateRiskLevel = (index, field, value) => {
    const updated = [...customRiskLevels];
    updated[index] = { ...updated[index], [field]: value };
    setCustomRiskLevels(updated);
  };

  const removeRiskLevel = (index) => {
    if (customRiskLevels.length <= 2) {
      toast.error("You must have at least 2 risk levels");
      return;
    }
    setCustomRiskLevels(customRiskLevels.filter((_, i) => i !== index));
  };

  const addWebhook = () => {
    const newWebhook = {
      id: `webhook_${Date.now()}`,
      name: "New Webhook",
      trigger_status_id: "",
      webhook_url: "",
      enabled: true,
      reminder_interval_days: 0,
      max_reminders: 0
    };
    setStatusWebhooks([...statusWebhooks, newWebhook]);
  };

  const updateWebhook = (index, field, value) => {
    const updated = [...statusWebhooks];
    updated[index] = { ...updated[index], [field]: value };
    setStatusWebhooks(updated);
  };

  const removeWebhook = (index) => {
    setStatusWebhooks(statusWebhooks.filter((_, i) => i !== index));
  };

  const availableFields = useMemo(() => form?.fields || [], [form]);

  // Get contact fields that have an associated contract form (signatories)
  const signatoryFields = useMemo(() => {
    return (form?.fields || []).filter(f => f.type === 'contact' && f.contract_form_id);
  }, [form]);

  const getConfigStatus = (fId) => {
    const config = ddConfigs.find(c => c.form_id === fId);
    return config ? 'Configured' : 'Not configured';
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-screen" data-testid="loading-spinner">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!formId) {
    if (formsLoading) {
      return (
        <div className="flex items-center justify-center min-h-screen" data-testid="loading-spinner">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      );
    }

    return (
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Due Diligence Configuration</h1>
          <p className="text-muted-foreground">Configure due diligence settings for forms that require review</p>
        </div>

        {ddEnabledForms.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Due Diligence Forms</h3>
              <p className="text-muted-foreground mb-4">
                To configure due diligence, first enable "Due Diligence Required" on a form in the Form Builder.
              </p>
              <Button onClick={() => navigate('/admin/FormManagement')} data-testid="button-goto-forms">
                Go to Form Management
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {ddEnabledForms.map((f) => {
              const configStatus = getConfigStatus(f.id);
              const isConfigured = configStatus === 'Configured';
              return (
                <Card 
                  key={f.id} 
                  className="hover-elevate cursor-pointer transition-colors"
                  onClick={() => navigate(`/admin/DueDiligenceConfig?formId=${f.id}`)}
                  data-testid={`card-form-${f.id}`}
                >
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-md bg-primary/10">
                          <FileText className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                          <h3 className="font-semibold">{f.name}</h3>
                          <p className="text-sm text-muted-foreground">{f.description || 'No description'}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge variant={isConfigured ? "default" : "secondary"}>
                          {isConfigured ? (
                            <>
                              <Settings className="w-3 h-3 mr-1" />
                              Configured
                            </>
                          ) : (
                            'Not configured'
                          )}
                        </Badge>
                        <ChevronRight className="w-5 h-5 text-muted-foreground" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (formLoading || configLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen" data-testid="loading-spinner">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!form) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Form not found. Make sure the form exists and has "Due Diligence Required" enabled.</AlertDescription>
        </Alert>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/admin/DueDiligenceConfig')} data-testid="button-back-to-list">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Forms List
        </Button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/admin/DueDiligenceConfig')} data-testid="button-back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Due Diligence Configuration</h1>
            <p className="text-muted-foreground">{form.name}</p>
          </div>
        </div>
        <Button onClick={handleSave} disabled={saveMutation.isPending} data-testid="button-save-config">
          {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save Configuration
        </Button>
      </div>

      <Tabs defaultValue="settings" className="space-y-6">
        <TabsList data-testid="tabs-config">
          <TabsTrigger value="settings" data-testid="tab-settings">Settings</TabsTrigger>
          <TabsTrigger value="scoring" data-testid="tab-scoring">Scoring</TabsTrigger>
          <TabsTrigger value="workflow" data-testid="tab-workflow">Workflow Stages</TabsTrigger>
          <TabsTrigger value="risk" data-testid="tab-risk">Risk Levels</TabsTrigger>
          <TabsTrigger value="webhooks" data-testid="tab-webhooks">Webhooks</TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Review Settings</CardTitle>
              <CardDescription>Configure default behavior for field reviews</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Label className="text-base font-medium">Default Field Review State</Label>
                <p className="text-sm text-muted-foreground">
                  When a reviewer opens a submission, each field will start in this state.
                </p>
                <div className="flex gap-4">
                  <Label 
                    className={cn(
                      "flex items-center gap-3 p-4 border rounded-lg cursor-pointer transition-colors",
                      defaultReviewState === 'approved' && "border-green-500 bg-green-50"
                    )}
                  >
                    <input
                      type="radio"
                      name="defaultReviewState"
                      value="approved"
                      checked={defaultReviewState === 'approved'}
                      onChange={(e) => setDefaultReviewState(e.target.value)}
                      className="w-4 h-4"
                      data-testid="radio-default-approved"
                    />
                    <div>
                      <span className="font-medium">Approved</span>
                      <p className="text-sm text-muted-foreground">Fields start as approved - reviewers amend only what needs changes</p>
                    </div>
                  </Label>
                  <Label 
                    className={cn(
                      "flex items-center gap-3 p-4 border rounded-lg cursor-pointer transition-colors",
                      defaultReviewState === 'amended' && "border-orange-500 bg-orange-50"
                    )}
                  >
                    <input
                      type="radio"
                      name="defaultReviewState"
                      value="amended"
                      checked={defaultReviewState === 'amended'}
                      onChange={(e) => setDefaultReviewState(e.target.value)}
                      className="w-4 h-4"
                      data-testid="radio-default-amended"
                    />
                    <div>
                      <span className="font-medium">Amended</span>
                      <p className="text-sm text-muted-foreground">Fields start as needing review - reviewers must approve each field</p>
                    </div>
                  </Label>
                </div>
              </div>

              <div className="space-y-3 pt-4 border-t">
                <Label className="text-base font-medium">Dashboard Card Reference</Label>
                <p className="text-sm text-muted-foreground">
                  Choose which form field value to display as the reference on dashboard submission cards.
                </p>
                <Select
                  value={cardReferenceField || '__default__'}
                  onValueChange={(val) => setCardReferenceField(val === '__default__' ? '' : val)}
                  data-testid="select-card-reference-field"
                >
                  <SelectTrigger className="w-full max-w-md">
                    <SelectValue placeholder="Select a field..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">None (use default)</SelectItem>
                    <SelectItem value="__organization_name__">Organization Name (linked record)</SelectItem>
                    {availableFields
                      .filter(f => !f.due_diligence && ['text', 'email', 'select', 'country'].includes(f.type))
                      .map((field) => (
                        <SelectItem key={field.id} value={field.name}>
                          {field.label || field.name}
                        </SelectItem>
                      ))
                    }
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3 pt-4 border-t">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-base font-medium">Show Description Fields</Label>
                    <p className="text-sm text-muted-foreground">
                      Display instruction/description-only fields in the review view. These fields show formatted text but don't collect data.
                    </p>
                  </div>
                  <Switch
                    checked={showDescriptionFields}
                    onCheckedChange={setShowDescriptionFields}
                    data-testid="switch-show-description-fields"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="scoring" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Scoring Approach</CardTitle>
              <CardDescription>Choose how submissions should be scored</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-4">
                <Label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="scoringApproach"
                    value="dynamic"
                    checked={scoringApproach === 'dynamic'}
                    onChange={(e) => setScoringApproach(e.target.value)}
                    className="w-4 h-4"
                    data-testid="radio-scoring-dynamic"
                  />
                  <span>Dynamic Scoring (based on form field values)</span>
                </Label>
                <Label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="scoringApproach"
                    value="static_traffic_light"
                    checked={scoringApproach === 'static_traffic_light'}
                    onChange={(e) => setScoringApproach(e.target.value)}
                    className="w-4 h-4"
                    data-testid="radio-scoring-traffic-light"
                  />
                  <span>Traffic Light (static questions with green/amber/red)</span>
                </Label>
              </div>

            </CardContent>
          </Card>

          {scoringApproach === 'static_traffic_light' && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Static Questions</CardTitle>
                    <CardDescription>Questions reviewers answer with configurable traffic light options</CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => addStaticQuestion('header')} data-testid="button-add-header">
                      <Plus className="w-4 h-4 mr-1" /> Header
                    </Button>
                    <Button size="sm" onClick={() => addStaticQuestion('question')} data-testid="button-add-question">
                      <Plus className="w-4 h-4 mr-1" /> Question
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <DragDropContext onDragEnd={handleQuestionDragEnd}>
                  <Droppable droppableId="static-questions">
                    {(provided) => (
                      <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-4">
                        {staticQuestions.map((item, index) => {
                          const questionNumber = questionNumbers[item.id];
                          return (
                            <Draggable key={item.id} draggableId={item.id} index={index}>
                              {(provided, snapshot) => (
                                <div
                                  ref={provided.innerRef}
                                  {...provided.draggableProps}
                                  className={cn(
                                    "border rounded-lg",
                                    snapshot.isDragging && "shadow-lg"
                                  )}
                                  data-testid={`static-question-${index}`}
                                >
                                  {item.type === 'header' ? (
                                    <div className="flex items-center gap-3 p-3">
                                      <div {...provided.dragHandleProps} className="cursor-grab">
                                        <GripVertical className="w-4 h-4 text-muted-foreground" />
                                      </div>
                                      <Badge variant="secondary" className="shrink-0">Header</Badge>
                                      <Input
                                        value={item.text || ''}
                                        onChange={(e) => updateStaticQuestion(index, 'text', e.target.value)}
                                        placeholder="Section header..."
                                        className="font-semibold flex-1"
                                        data-testid={`input-header-${index}`}
                                      />
                                      <Button variant="ghost" size="icon" onClick={() => removeStaticQuestion(index)} data-testid={`button-remove-question-${index}`}>
                                        <Trash2 className="w-4 h-4 text-destructive" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <Collapsible>
                                      <div className="flex items-center gap-3 p-3">
                                        <div {...provided.dragHandleProps} className="cursor-grab">
                                          <GripVertical className="w-4 h-4 text-muted-foreground" />
                                        </div>
                                        <span className="text-sm font-medium text-muted-foreground w-6 shrink-0">Q{questionNumber}</span>
                                        <CollapsibleTrigger asChild>
                                          <Button variant="ghost" size="icon" className="shrink-0" data-testid={`button-expand-question-${index}`}>
                                            <ChevronDown className="w-4 h-4" />
                                          </Button>
                                        </CollapsibleTrigger>
                                        <Input
                                          value={item.question || ''}
                                          onChange={(e) => updateStaticQuestion(index, 'question', e.target.value)}
                                          placeholder="Enter question..."
                                          className="flex-1"
                                          data-testid={`input-question-${index}`}
                                        />
                                        <div className="flex items-center gap-2 shrink-0">
                                          <span className="text-sm text-muted-foreground">Weight:</span>
                                          <Input
                                            type="number"
                                            value={item.weight || 1}
                                            onChange={(e) => updateStaticQuestion(index, 'weight', parseInt(e.target.value) || 1)}
                                            className="w-16"
                                            min={1}
                                            data-testid={`input-weight-${index}`}
                                          />
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0">
                                          {(item.options || []).map((opt) => (
                                            <div
                                              key={opt.id}
                                              className="w-4 h-4 rounded-full"
                                              style={{ backgroundColor: opt.color }}
                                              title={`${opt.label}: ${opt.score} points`}
                                            />
                                          ))}
                                        </div>
                                        <Button variant="ghost" size="icon" onClick={() => removeStaticQuestion(index)} data-testid={`button-remove-question-${index}`}>
                                          <Trash2 className="w-4 h-4 text-destructive" />
                                        </Button>
                                      </div>
                                      <CollapsibleContent>
                          <div className="px-3 pb-3 pt-0 border-t bg-muted/30">
                            <div className="flex items-center justify-between py-2">
                              <span className="text-sm font-medium">Light Options</span>
                              <Button variant="outline" size="sm" onClick={() => addLightOption(index)} data-testid={`button-add-option-${index}`}>
                                <Plus className="w-3 h-3 mr-1" /> Add Option
                              </Button>
                            </div>
                            <div className="space-y-2">
                              {(item.options || []).map((opt, optIndex) => (
                                <div key={opt.id} className="flex items-center gap-2 p-2 bg-background rounded-md" data-testid={`option-${index}-${optIndex}`}>
                                  <input
                                    type="color"
                                    value={opt.color}
                                    onChange={(e) => updateLightOption(index, optIndex, 'color', e.target.value)}
                                    className="w-8 h-8 rounded-full cursor-pointer border-0 shrink-0"
                                    style={{ backgroundColor: opt.color }}
                                    data-testid={`input-option-color-${index}-${optIndex}`}
                                  />
                                  <div className="flex flex-wrap gap-1 shrink-0">
                                    {PRESET_COLORS.map((presetColor) => (
                                      <button
                                        key={presetColor}
                                        type="button"
                                        className={cn(
                                          "w-5 h-5 rounded-full border transition-transform",
                                          opt.color === presetColor ? "ring-2 ring-offset-1 ring-primary scale-110" : "hover:scale-110"
                                        )}
                                        style={{ backgroundColor: presetColor }}
                                        onClick={() => updateLightOption(index, optIndex, 'color', presetColor)}
                                        data-testid={`button-preset-color-${index}-${optIndex}-${presetColor.replace('#', '')}`}
                                      />
                                    ))}
                                  </div>
                                  <Input
                                    value={opt.label}
                                    onChange={(e) => updateLightOption(index, optIndex, 'label', e.target.value)}
                                    placeholder="Label..."
                                    className="flex-1 min-w-24"
                                    data-testid={`input-option-label-${index}-${optIndex}`}
                                  />
                                  <div className="flex items-center gap-1 shrink-0">
                                    <Input
                                      type="number"
                                      value={opt.score}
                                      onChange={(e) => updateLightOption(index, optIndex, 'score', parseInt(e.target.value) || 0)}
                                      min={0}
                                      className="w-16"
                                      data-testid={`input-option-score-${index}-${optIndex}`}
                                    />
                                    <span className="text-sm text-muted-foreground">pts</span>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => removeLightOption(index, optIndex)}
                                    data-testid={`button-remove-option-${index}-${optIndex}`}
                                  >
                                    <Trash2 className="w-4 h-4 text-destructive" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        </CollapsibleContent>
                                      </Collapsible>
                                    )}
                                  </div>
                                )}
                              </Draggable>
                            );
                          })}
                        {provided.placeholder}
                      </div>
                    )}
                  </Droppable>
                </DragDropContext>
                {staticQuestions.length === 0 && (
                  <p className="text-center text-muted-foreground py-6">No questions added yet</p>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="workflow" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Workflow Stages</CardTitle>
                  <CardDescription>Define the stages submissions progress through</CardDescription>
                </div>
                <Button size="sm" onClick={addWorkflowStage} data-testid="button-add-stage">
                  <Plus className="w-4 h-4 mr-1" /> Add Stage
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <DragDropContext onDragEnd={handleStageDragEnd}>
                <Droppable droppableId="stages">
                  {(provided) => (
                    <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-3">
                      {workflowStages.map((stage, index) => (
                        <Draggable key={stage.id} draggableId={stage.id} index={index}>
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              className={cn(
                                "border rounded-lg",
                                snapshot.isDragging && "shadow-lg",
                                stage.is_initial && "border-primary bg-primary/5"
                              )}
                              data-testid={`workflow-stage-${index}`}
                            >
                              <div>
                                <div className="flex items-center gap-3 p-4">
                                  <div {...provided.dragHandleProps} className="cursor-grab">
                                    <GripVertical className="w-5 h-5 text-muted-foreground" />
                                  </div>
                                  <input
                                    type="color"
                                    value={stage.color}
                                    onChange={(e) => updateWorkflowStage(index, 'color', e.target.value)}
                                    className="w-10 h-10 rounded cursor-pointer border-0"
                                    data-testid={`input-stage-color-${index}`}
                                  />
                                  <Input
                                    value={stage.label}
                                    onChange={(e) => updateWorkflowStage(index, 'label', e.target.value)}
                                    className="flex-1"
                                    data-testid={`input-stage-label-${index}`}
                                  />
                                  <Button 
                                    variant={openStageSection[index] === 'conditions' ? 'default' : 'outline'} 
                                    size="sm" 
                                    onClick={() => setOpenStageSection(prev => ({ 
                                      ...prev, 
                                      [index]: prev[index] === 'conditions' ? null : 'conditions' 
                                    }))}
                                    data-testid={`button-toggle-conditions-${index}`}
                                  >
                                    <Lock className="w-4 h-4 mr-1" />
                                    Conditions
                                    {(stage.selection_conditions?.score_condition?.enabled || 
                                      stage.selection_conditions?.signatories_received || 
                                      stage.selection_conditions?.documents_approved) && (
                                      <Badge variant="secondary" className="ml-2 text-xs">Active</Badge>
                                    )}
                                  </Button>
                                  <Button 
                                    variant={openStageSection[index] === 'actions' ? 'default' : 'outline'} 
                                    size="sm" 
                                    onClick={() => setOpenStageSection(prev => ({ 
                                      ...prev, 
                                      [index]: prev[index] === 'actions' ? null : 'actions' 
                                    }))}
                                    data-testid={`button-toggle-actions-${index}`}
                                  >
                                    <Play className="w-4 h-4 mr-1" />
                                    Actions
                                    {(stage.stage_actions?.send_contracts?.length > 0) && (
                                      <Badge variant="secondary" className="ml-2 text-xs">Active</Badge>
                                    )}
                                  </Button>
                                  <Button
                                    variant={stage.is_initial ? "default" : "outline"}
                                    size="sm"
                                    onClick={() => setInitialStage(index)}
                                    data-testid={`button-set-initial-${index}`}
                                  >
                                    <Star className={cn("w-4 h-4", stage.is_initial && "fill-current")} />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => removeWorkflowStage(index)}
                                    data-testid={`button-remove-stage-${index}`}
                                  >
                                    <Trash2 className="w-4 h-4 text-destructive" />
                                  </Button>
                                </div>
                                
                                {/* Conditions Section */}
                                {openStageSection[index] === 'conditions' && (
                                  <div className="px-4 pb-4 pt-0 border-t bg-muted/30">
                                    <div className="py-3">
                                      <span className="text-sm font-medium">Selection Conditions</span>
                                      <p className="text-xs text-muted-foreground mt-1">
                                        Set conditions that must be met before this stage can be selected
                                      </p>
                                    </div>
                                    <div className="space-y-4">
                                      <div className="p-3 border rounded-lg bg-background space-y-3">
                                        <div className="flex items-center gap-2">
                                          <Switch
                                            checked={stage.selection_conditions?.score_condition?.enabled || false}
                                            onCheckedChange={(checked) => {
                                              const currentConditions = stage.selection_conditions || {};
                                              const scoreCondition = currentConditions.score_condition || { enabled: false, operator: 'above', value: 50 };
                                              updateWorkflowStage(index, 'selection_conditions', {
                                                ...currentConditions,
                                                score_condition: { ...scoreCondition, enabled: checked }
                                              });
                                            }}
                                            data-testid={`switch-score-condition-${index}`}
                                          />
                                          <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                                          <span className="text-sm font-medium">DD Score Requirement</span>
                                        </div>
                                        {stage.selection_conditions?.score_condition?.enabled && (
                                          <div className="flex items-center gap-3 ml-6">
                                            <span className="text-sm text-muted-foreground">Score must be</span>
                                            <Select
                                              value={stage.selection_conditions?.score_condition?.operator || 'above'}
                                              onValueChange={(val) => {
                                                const currentConditions = stage.selection_conditions || {};
                                                const scoreCondition = currentConditions.score_condition || { enabled: true, operator: 'above', value: 50 };
                                                updateWorkflowStage(index, 'selection_conditions', {
                                                  ...currentConditions,
                                                  score_condition: { ...scoreCondition, operator: val }
                                                });
                                              }}
                                              data-testid={`select-score-operator-${index}`}
                                            >
                                              <SelectTrigger className="w-32">
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                <SelectItem value="above">above</SelectItem>
                                                <SelectItem value="below">below</SelectItem>
                                              </SelectContent>
                                            </Select>
                                            <Input
                                              type="number"
                                              min={0}
                                              max={100}
                                              value={stage.selection_conditions?.score_condition?.value ?? 50}
                                              onChange={(e) => {
                                                const currentConditions = stage.selection_conditions || {};
                                                const scoreCondition = currentConditions.score_condition || { enabled: true, operator: 'above', value: 50 };
                                                updateWorkflowStage(index, 'selection_conditions', {
                                                  ...currentConditions,
                                                  score_condition: { ...scoreCondition, value: parseInt(e.target.value) || 0 }
                                                });
                                              }}
                                              className="w-20"
                                              data-testid={`input-score-value-${index}`}
                                            />
                                            <span className="text-sm text-muted-foreground">%</span>
                                          </div>
                                        )}
                                      </div>

                                      <div className="p-3 border rounded-lg bg-background">
                                        <div className="flex items-center gap-2">
                                          <Switch
                                            checked={stage.selection_conditions?.signatories_received || false}
                                            onCheckedChange={(checked) => {
                                              const currentConditions = stage.selection_conditions || {};
                                              updateWorkflowStage(index, 'selection_conditions', {
                                                ...currentConditions,
                                                signatories_received: checked
                                              });
                                            }}
                                            data-testid={`switch-signatories-condition-${index}`}
                                          />
                                          <UserCheck className="w-4 h-4 text-muted-foreground" />
                                          <span className="text-sm font-medium">All Signatories Received</span>
                                        </div>
                                        <p className="text-xs text-muted-foreground ml-10 mt-1">
                                          All contract signatures must be received before this stage can be selected
                                        </p>
                                      </div>

                                      <div className="p-3 border rounded-lg bg-background">
                                        <div className="flex items-center gap-2">
                                          <Switch
                                            checked={stage.selection_conditions?.documents_approved || false}
                                            onCheckedChange={(checked) => {
                                              const currentConditions = stage.selection_conditions || {};
                                              updateWorkflowStage(index, 'selection_conditions', {
                                                ...currentConditions,
                                                documents_approved: checked
                                              });
                                            }}
                                            data-testid={`switch-documents-condition-${index}`}
                                          />
                                          <FileCheck className="w-4 h-4 text-muted-foreground" />
                                          <span className="text-sm font-medium">All Documents Approved</span>
                                        </div>
                                        <p className="text-xs text-muted-foreground ml-10 mt-1">
                                          All uploaded documents must be approved before this stage can be selected
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                )}
                                
                                {/* Actions Section */}
                                {openStageSection[index] === 'actions' && (
                                  <div className="px-4 pb-4 pt-0 border-t bg-muted/30">
                                    <div className="py-3">
                                      <span className="text-sm font-medium">Stage Actions</span>
                                      <p className="text-xs text-muted-foreground mt-1">
                                        Actions to perform when this stage is selected
                                      </p>
                                    </div>
                                    <div className="space-y-4">
                                      <div className="p-3 border rounded-lg bg-background">
                                        <div className="flex items-center gap-2 mb-3">
                                          <Send className="w-4 h-4 text-muted-foreground" />
                                          <span className="text-sm font-medium">Send Contracts for Signing</span>
                                        </div>
                                        <p className="text-xs text-muted-foreground mb-3">
                                          Select which signatory contracts to send when this stage is selected. 
                                          The Initial Email Template configured in the contract form will be used.
                                        </p>
                                        {signatoryFields.length === 0 ? (
                                          <p className="text-sm text-muted-foreground italic">
                                            No signatory fields configured in this form. Add contact fields with associated contract forms in the Form Builder.
                                          </p>
                                        ) : (
                                          <div className="space-y-2">
                                            {signatoryFields.map((sigField) => {
                                              const fieldId = sigField.id || sigField.name;
                                              const isSelected = (stage.stage_actions?.send_contracts || []).includes(fieldId);
                                              return (
                                                <div key={fieldId} className="flex items-center gap-2">
                                                  <Checkbox
                                                    id={`send-contract-${index}-${fieldId}`}
                                                    checked={isSelected}
                                                    onCheckedChange={(checked) => {
                                                      const currentActions = stage.stage_actions || {};
                                                      const currentSendContracts = currentActions.send_contracts || [];
                                                      let newSendContracts;
                                                      if (checked) {
                                                        newSendContracts = [...currentSendContracts, fieldId];
                                                      } else {
                                                        newSendContracts = currentSendContracts.filter(id => id !== fieldId);
                                                      }
                                                      updateWorkflowStage(index, 'stage_actions', {
                                                        ...currentActions,
                                                        send_contracts: newSendContracts
                                                      });
                                                    }}
                                                    data-testid={`checkbox-send-contract-${index}-${fieldId}`}
                                                  />
                                                  <label 
                                                    htmlFor={`send-contract-${index}-${fieldId}`}
                                                    className="text-sm cursor-pointer flex items-center gap-2"
                                                  >
                                                    <Mail className="w-4 h-4 text-muted-foreground" />
                                                    {sigField.label || sigField.name}
                                                  </label>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                      
                                      <div className="p-3 border rounded-lg bg-background">
                                        <div className="flex items-center gap-2 mb-3">
                                          <Calendar className="w-4 h-4 text-muted-foreground" />
                                          <span className="text-sm font-medium">Send Meeting Invitations</span>
                                        </div>
                                        <p className="text-xs text-muted-foreground mb-3">
                                          Send meeting booking invitations when this stage is selected.
                                          The email template configured on the meeting type will be used.
                                        </p>
                                        {meetingTemplates.length === 0 ? (
                                          <p className="text-sm text-muted-foreground italic">
                                            No meeting types configured. Create meeting types in the Booking Agents management page.
                                          </p>
                                        ) : (
                                          <div className="space-y-2">
                                            {(() => {
                                              const stageRequests = stageMeetingRequests.filter(mr => mr.due_diligence_stage_id === stage.id);
                                              return (
                                                <>
                                                  {stageRequests.map((mr) => (
                                                    <div key={mr.id} className="flex items-center justify-between gap-2 p-2 border rounded bg-muted/50">
                                                      <div className="flex items-center gap-2 flex-wrap">
                                                        <Calendar className="w-4 h-4 text-muted-foreground" />
                                                        <span className="text-sm">{mr.meeting_template?.name || 'Unknown meeting type'}</span>
                                                        <Badge variant="outline" className="text-xs">Email: {mr.recipient_email_field}</Badge>
                                                        {mr.first_name_field && (
                                                          <Badge variant="outline" className="text-xs">Name: {mr.first_name_field}</Badge>
                                                        )}
                                                      </div>
                                                      <div className="flex items-center gap-1">
                                                        <Button
                                                          size="icon"
                                                          variant="ghost"
                                                          onClick={() => setPendingMeetingRequest({
                                                            stageId: stage.id,
                                                            templateId: mr.meeting_template_id,
                                                            emailField: mr.recipient_email_field,
                                                            firstNameField: mr.first_name_field || '',
                                                            editId: mr.id
                                                          })}
                                                          data-testid={`button-edit-meeting-request-${mr.id}`}
                                                        >
                                                          <Pencil className="w-4 h-4" />
                                                        </Button>
                                                        <Button
                                                          size="icon"
                                                          variant="ghost"
                                                          onClick={() => removeStageMeetingRequest(mr.id)}
                                                          data-testid={`button-remove-meeting-request-${mr.id}`}
                                                        >
                                                          <Trash2 className="w-4 h-4" />
                                                        </Button>
                                                      </div>
                                                    </div>
                                                  ))}
                                                  
                                                  {pendingMeetingRequest?.stageId === stage.id ? (
                                                    <div className="space-y-3 p-3 border rounded bg-muted/30">
                                                      <div className="space-y-2">
                                                        <Label className="text-xs">Meeting Type</Label>
                                                        <Select
                                                          value={pendingMeetingRequest.templateId || ''}
                                                          onValueChange={(v) => setPendingMeetingRequest(prev => ({ ...prev, templateId: v }))}
                                                        >
                                                          <SelectTrigger data-testid={`select-pending-template-${index}`}>
                                                            <SelectValue placeholder="Select meeting type..." />
                                                          </SelectTrigger>
                                                          <SelectContent>
                                                            {meetingTemplates.filter(t => t.email_template_id).map(template => (
                                                              <SelectItem key={template.id} value={template.id}>
                                                                {template.name}
                                                              </SelectItem>
                                                            ))}
                                                          </SelectContent>
                                                        </Select>
                                                      </div>
                                                      <div className="space-y-2">
                                                        <Label className="text-xs">Recipient Email Field</Label>
                                                        <Select
                                                          value={pendingMeetingRequest.emailField || ''}
                                                          onValueChange={(v) => setPendingMeetingRequest(prev => ({ ...prev, emailField: v }))}
                                                        >
                                                          <SelectTrigger data-testid={`select-pending-email-${index}`}>
                                                            <SelectValue placeholder="Select email field..." />
                                                          </SelectTrigger>
                                                          <SelectContent>
                                                            {getEmailFields().map(field => (
                                                              <SelectItem key={field.id || field.name} value={field.name || field.id}>
                                                                {field.label || field.name}
                                                              </SelectItem>
                                                            ))}
                                                            {getEmailFields().length === 0 && (
                                                              <SelectItem value="none" disabled>No email fields in form</SelectItem>
                                                            )}
                                                          </SelectContent>
                                                        </Select>
                                                      </div>
                                                      <div className="space-y-2">
                                                        <Label className="text-xs">First Name Field (optional)</Label>
                                                        <Select
                                                          value={pendingMeetingRequest.firstNameField || 'none'}
                                                          onValueChange={(v) => setPendingMeetingRequest(prev => ({ ...prev, firstNameField: v === 'none' ? '' : v }))}
                                                        >
                                                          <SelectTrigger data-testid={`select-pending-firstname-${index}`}>
                                                            <SelectValue placeholder="Select name field..." />
                                                          </SelectTrigger>
                                                          <SelectContent>
                                                            <SelectItem value="none">None</SelectItem>
                                                            {getTextFields().map(field => (
                                                              <SelectItem key={field.id || field.name} value={field.name || field.id}>
                                                                {field.label || field.name}
                                                              </SelectItem>
                                                            ))}
                                                          </SelectContent>
                                                        </Select>
                                                      </div>
                                                      <div className="flex gap-2">
                                                        <Button
                                                          size="sm"
                                                          variant="outline"
                                                          onClick={() => setPendingMeetingRequest(null)}
                                                        >
                                                          Cancel
                                                        </Button>
                                                        <Button
                                                          size="sm"
                                                          onClick={async () => {
                                                            if (!pendingMeetingRequest.templateId || !pendingMeetingRequest.emailField) {
                                                              toast.error('Please select a meeting type and email field');
                                                              return;
                                                            }
                                                            if (pendingMeetingRequest.editId) {
                                                              await updateStageMeetingRequest(
                                                                pendingMeetingRequest.editId,
                                                                pendingMeetingRequest.templateId,
                                                                pendingMeetingRequest.emailField,
                                                                pendingMeetingRequest.firstNameField || null
                                                              );
                                                            } else {
                                                              await addStageMeetingRequest(
                                                                stage.id,
                                                                pendingMeetingRequest.templateId,
                                                                pendingMeetingRequest.emailField,
                                                                pendingMeetingRequest.firstNameField || null
                                                              );
                                                            }
                                                            setPendingMeetingRequest(null);
                                                          }}
                                                          data-testid={`button-confirm-meeting-request-${index}`}
                                                        >
                                                          {pendingMeetingRequest.editId ? 'Update' : 'Add'}
                                                        </Button>
                                                      </div>
                                                    </div>
                                                  ) : (
                                                    <Button
                                                      size="sm"
                                                      variant="outline"
                                                      onClick={() => setPendingMeetingRequest({ stageId: stage.id, templateId: '', emailField: '', firstNameField: '' })}
                                                      className="mt-2"
                                                      data-testid={`button-add-meeting-request-${index}`}
                                                    >
                                                      <Plus className="w-4 h-4 mr-1" />
                                                      Add Meeting Invitation
                                                    </Button>
                                                  )}
                                                </>
                                              );
                                            })()}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="risk" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Risk Levels</CardTitle>
                  <CardDescription>Define score thresholds for risk categorization</CardDescription>
                </div>
                <Button size="sm" onClick={addRiskLevel} data-testid="button-add-risk-level">
                  <Plus className="w-4 h-4 mr-1" /> Add Level
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {[...customRiskLevels].sort((a, b) => b.threshold - a.threshold).map((level, displayIndex) => {
                const actualIndex = customRiskLevels.findIndex(l => l.name === level.name && l.threshold === level.threshold);
                return (
                  <div key={actualIndex} className="flex items-center gap-4 p-3 border rounded-lg" data-testid={`risk-level-${actualIndex}`}>
                    <input
                      type="color"
                      value={level.color}
                      onChange={(e) => updateRiskLevel(actualIndex, 'color', e.target.value)}
                      className="w-10 h-10 rounded cursor-pointer border-0"
                      data-testid={`input-risk-color-${actualIndex}`}
                    />
                    <Input
                      value={level.name}
                      onChange={(e) => updateRiskLevel(actualIndex, 'name', e.target.value)}
                      placeholder="Risk level name"
                      className="flex-1"
                      data-testid={`input-risk-name-${actualIndex}`}
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Score ≥</span>
                      <Input
                        type="number"
                        value={level.threshold}
                        onChange={(e) => updateRiskLevel(actualIndex, 'threshold', parseInt(e.target.value) || 0)}
                        min={0}
                        max={100}
                        className="w-20"
                        data-testid={`input-risk-threshold-${actualIndex}`}
                      />
                      <span className="text-sm text-muted-foreground">%</span>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => removeRiskLevel(actualIndex)} data-testid={`button-remove-risk-${actualIndex}`}>
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                );
              })}
              
              {customRiskLevels.length > 0 && (
                <div className="mt-6 space-y-2">
                  <span className="text-sm font-medium">Risk Gradient Preview</span>
                  <div className="relative h-8 rounded-lg overflow-hidden" data-testid="risk-gradient-preview">
                    {(() => {
                      const sortedLevels = [...customRiskLevels].sort((a, b) => a.threshold - b.threshold);
                      return (
                        <>
                          <div 
                            className="absolute inset-0"
                            style={{
                              background: `linear-gradient(to right, ${sortedLevels.map((level, i) => {
                                const nextThreshold = sortedLevels[i + 1]?.threshold ?? 100;
                                return `${level.color} ${level.threshold}%, ${level.color} ${nextThreshold}%`;
                              }).join(', ')})`
                            }}
                          />
                          {sortedLevels.map((level, i) => (
                            level.threshold > 0 && (
                              <div
                                key={i}
                                className="absolute top-0 bottom-0 w-0.5 bg-white"
                                style={{ left: `${level.threshold}%` }}
                                title={`${level.name}: ${level.threshold}%`}
                              />
                            )
                          ))}
                        </>
                      );
                    })()}
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>0%</span>
                    <span>100%</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="webhooks" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Status Change Webhooks</CardTitle>
                  <CardDescription>Trigger external actions when status changes</CardDescription>
                </div>
                <Button size="sm" onClick={addWebhook} data-testid="button-add-webhook">
                  <Plus className="w-4 h-4 mr-1" /> Add Webhook
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {statusWebhooks.map((webhook, index) => (
                <Card key={webhook.id} className="bg-muted/50" data-testid={`webhook-${index}`}>
                  <CardContent className="pt-4 space-y-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 flex-1">
                        <Switch
                          checked={webhook.enabled}
                          onCheckedChange={(v) => updateWebhook(index, 'enabled', v)}
                          data-testid={`switch-webhook-enabled-${index}`}
                        />
                        <Input
                          value={webhook.name}
                          onChange={(e) => updateWebhook(index, 'name', e.target.value)}
                          placeholder="Webhook name"
                          className="flex-1"
                          data-testid={`input-webhook-name-${index}`}
                        />
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => removeWebhook(index)} data-testid={`button-remove-webhook-${index}`}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Trigger on Status</Label>
                        <Select
                          value={webhook.trigger_status_id}
                          onValueChange={(v) => updateWebhook(index, 'trigger_status_id', v)}
                          data-testid={`select-webhook-trigger-${index}`}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select status..." />
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
                      <div>
                        <Label>Webhook URL</Label>
                        <Input
                          value={webhook.webhook_url}
                          onChange={(e) => updateWebhook(index, 'webhook_url', e.target.value)}
                          placeholder="https://..."
                          data-testid={`input-webhook-url-${index}`}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Reminder Interval (days)</Label>
                        <Input
                          type="number"
                          value={webhook.reminder_interval_days || 0}
                          onChange={(e) => updateWebhook(index, 'reminder_interval_days', parseInt(e.target.value) || 0)}
                          min={0}
                          data-testid={`input-webhook-interval-${index}`}
                        />
                      </div>
                      <div>
                        <Label>Max Reminders</Label>
                        <Input
                          type="number"
                          value={webhook.max_reminders || 0}
                          onChange={(e) => updateWebhook(index, 'max_reminders', parseInt(e.target.value) || 0)}
                          min={0}
                          data-testid={`input-webhook-max-${index}`}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {statusWebhooks.length === 0 && (
                <p className="text-center text-muted-foreground py-6">No webhooks configured</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
