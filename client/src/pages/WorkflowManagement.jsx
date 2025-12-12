import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { 
  Zap, Plus, Pencil, Trash2, AlertCircle, Mail, Play, Pause, 
  ChevronRight, ChevronLeft, Building2, User, Settings, Clock,
  CheckCircle2, XCircle, History, Filter, ArrowRight
} from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";

const TRIGGER_TYPES = [
  { value: 'field_change', label: 'Field Value Changes', description: 'Triggers when a specific field value changes' },
  { value: 'record_create', label: 'Record Created', description: 'Triggers when a new record is created' },
  { value: 'record_update', label: 'Record Updated', description: 'Triggers when any field is updated' },
];

const CONDITION_OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does Not Equal' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_contains', label: 'Does Not Contain' },
  { value: 'starts_with', label: 'Starts With' },
  { value: 'ends_with', label: 'Ends With' },
  { value: 'is_empty', label: 'Is Empty' },
  { value: 'is_not_empty', label: 'Is Not Empty' },
  { value: 'changed_to', label: 'Changed To' },
  { value: 'changed_from', label: 'Changed From' },
];

const ACTION_TYPES = [
  { value: 'send_email', label: 'Send Email', icon: Mail, description: 'Send an email notification' },
  { value: 'update_field', label: 'Update Field', icon: Settings, description: 'Update a field value on the record' },
];

const ORGANIZATION_CORE_FIELDS = [
  { id: 'name', label: 'Name', type: 'text' },
  { id: 'status', label: 'Status', type: 'text' },
  { id: 'phone', label: 'Phone', type: 'text' },
  { id: 'invoicing_email', label: 'Invoicing Email', type: 'email' },
  { id: 'invoicing_address', label: 'Invoicing Address', type: 'text' },
  { id: 'website_url', label: 'Website URL', type: 'url' },
  { id: 'training_fund_balance', label: 'Training Fund Balance', type: 'number' },
];

const MEMBER_CORE_FIELDS = [
  { id: 'full_name', label: 'Full Name', type: 'text' },
  { id: 'email', label: 'Email', type: 'email' },
  { id: 'phone', label: 'Phone', type: 'text' },
  { id: 'status', label: 'Status', type: 'text' },
  { id: 'job_title', label: 'Job Title', type: 'text' },
];

export default function WorkflowManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [showDialog, setShowDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [workflowToDelete, setWorkflowToDelete] = useState(null);
  const [editingWorkflow, setEditingWorkflow] = useState(null);
  const [activeTab, setActiveTab] = useState('workflows');
  const [builderStep, setBuilderStep] = useState(1);
  const [accessChecked, setAccessChecked] = useState(false);
  
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    entity_type: 'organization',
    trigger_type: 'field_change',
    trigger_config: { field_id: '', field_type: 'core', operator: 'changed_to', value: '' },
    conditions: [],
    actions: [],
    is_active: true,
  });

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady]);

  const { data: workflows = [], isLoading } = useQuery({
    queryKey: ['workflows'],
    queryFn: async () => {
      const result = await base44.entities.Workflow.list();
      return result || [];
    },
    enabled: accessChecked,
  });

  const { data: workflowLogs = [] } = useQuery({
    queryKey: ['workflow-logs'],
    queryFn: async () => {
      const result = await base44.entities.WorkflowLog.list();
      return (result || []).sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));
    },
    enabled: accessChecked && activeTab === 'logs',
  });

  const { data: customFields = [] } = useQuery({
    queryKey: ['preference-fields'],
    queryFn: async () => {
      const result = await base44.entities.PreferenceField.list();
      return result || [];
    },
    enabled: accessChecked,
  });

  const orgCustomFields = customFields.filter(f => f.entity_scope === 'organization');
  const memberCustomFields = customFields.filter(f => !f.entity_scope || f.entity_scope === 'member');

  const getAvailableFields = (entityType) => {
    const coreFields = entityType === 'organization' ? ORGANIZATION_CORE_FIELDS : MEMBER_CORE_FIELDS;
    const customFieldsList = entityType === 'organization' ? orgCustomFields : memberCustomFields;
    
    return [
      ...coreFields.map(f => ({ ...f, field_type: 'core' })),
      ...customFieldsList.map(f => ({ 
        id: f.id, 
        label: f.label, 
        type: f.field_type,
        field_type: 'custom'
      }))
    ];
  };

  const createMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.Workflow.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success('Workflow created successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to create workflow: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      return await base44.entities.Workflow.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success('Workflow updated successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to update workflow: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.Workflow.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success('Workflow deleted');
      setShowDeleteConfirm(false);
      setWorkflowToDelete(null);
    },
    onError: (error) => {
      toast.error('Failed to delete workflow: ' + error.message);
    }
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, is_active }) => {
      return await base44.entities.Workflow.update(id, { is_active });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
    onError: (error) => {
      toast.error('Failed to toggle workflow: ' + error.message);
    }
  });

  const handleCloseDialog = () => {
    setShowDialog(false);
    setEditingWorkflow(null);
    setBuilderStep(1);
    setFormData({
      name: '',
      description: '',
      entity_type: 'organization',
      trigger_type: 'field_change',
      trigger_config: { field_id: '', field_type: 'core', operator: 'changed_to', value: '' },
      conditions: [],
      actions: [],
      is_active: true,
    });
  };

  const handleEditWorkflow = (workflow) => {
    setEditingWorkflow(workflow);
    setFormData({
      name: workflow.name || '',
      description: workflow.description || '',
      entity_type: workflow.entity_type || 'organization',
      trigger_type: workflow.trigger_type || 'field_change',
      trigger_config: workflow.trigger_config || { field_id: '', field_type: 'core', operator: 'changed_to', value: '' },
      conditions: workflow.conditions || [],
      actions: workflow.actions || [],
      is_active: workflow.is_active !== false,
    });
    setBuilderStep(1);
    setShowDialog(true);
  };

  const handleSaveWorkflow = () => {
    if (!formData.name.trim()) {
      toast.error('Please enter a workflow name');
      return;
    }
    if (formData.actions.length === 0) {
      toast.error('Please add at least one action');
      return;
    }

    const payload = {
      ...formData,
      updated_at: new Date().toISOString(),
    };

    if (editingWorkflow) {
      updateMutation.mutate({ id: editingWorkflow.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const addCondition = () => {
    setFormData(prev => ({
      ...prev,
      conditions: [
        ...prev.conditions,
        { field_id: '', field_type: 'core', operator: 'equals', value: '', logic: 'AND' }
      ]
    }));
  };

  const updateCondition = (index, updates) => {
    setFormData(prev => ({
      ...prev,
      conditions: prev.conditions.map((c, i) => i === index ? { ...c, ...updates } : c)
    }));
  };

  const removeCondition = (index) => {
    setFormData(prev => ({
      ...prev,
      conditions: prev.conditions.filter((_, i) => i !== index)
    }));
  };

  const addAction = (type) => {
    const newAction = { type };
    if (type === 'send_email') {
      newAction.config = { to: '', subject: '', body: '' };
    } else if (type === 'update_field') {
      newAction.config = { field_id: '', field_type: 'core', value: '' };
    }
    setFormData(prev => ({
      ...prev,
      actions: [...prev.actions, newAction]
    }));
  };

  const updateAction = (index, updates) => {
    setFormData(prev => ({
      ...prev,
      actions: prev.actions.map((a, i) => i === index ? { ...a, ...updates } : a)
    }));
  };

  const removeAction = (index) => {
    setFormData(prev => ({
      ...prev,
      actions: prev.actions.filter((_, i) => i !== index)
    }));
  };

  const availableFields = getAvailableFields(formData.entity_type);

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Zap className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Workflow Automation</h1>
            <p className="text-muted-foreground">Automate actions based on field changes</p>
          </div>
        </div>
        <Button onClick={() => setShowDialog(true)} data-testid="button-create-workflow">
          <Plus className="h-4 w-4 mr-2" />
          Create Workflow
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="workflows" data-testid="tab-workflows">
            <Zap className="h-4 w-4 mr-2" />
            Workflows
          </TabsTrigger>
          <TabsTrigger value="logs" data-testid="tab-logs">
            <History className="h-4 w-4 mr-2" />
            Execution Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="workflows">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : workflows.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Zap className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">No Workflows Yet</h3>
                <p className="text-muted-foreground text-center mb-4">
                  Create your first workflow to automate actions based on field changes.
                </p>
                <Button onClick={() => setShowDialog(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Workflow
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {workflows.map((workflow) => (
                <Card key={workflow.id} className="hover-elevate" data-testid={`card-workflow-${workflow.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-4">
                        <div className={`p-2 rounded-lg ${workflow.is_active ? 'bg-green-100 dark:bg-green-900/30' : 'bg-gray-100 dark:bg-gray-800'}`}>
                          <Zap className={`h-5 w-5 ${workflow.is_active ? 'text-green-600' : 'text-gray-400'}`} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold">{workflow.name}</h3>
                            <Badge variant={workflow.is_active ? "default" : "secondary"}>
                              {workflow.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                            <Badge variant="outline">
                              {workflow.entity_type === 'organization' ? (
                                <><Building2 className="h-3 w-3 mr-1" /> Organization</>
                              ) : (
                                <><User className="h-3 w-3 mr-1" /> Member</>
                              )}
                            </Badge>
                          </div>
                          {workflow.description && (
                            <p className="text-sm text-muted-foreground mb-2">{workflow.description}</p>
                          )}
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span>
                              Trigger: {TRIGGER_TYPES.find(t => t.value === workflow.trigger_type)?.label || workflow.trigger_type}
                            </span>
                            <span>
                              {workflow.actions?.length || 0} action(s)
                            </span>
                            {workflow.conditions?.length > 0 && (
                              <span>
                                {workflow.conditions.length} condition(s)
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={workflow.is_active}
                          onCheckedChange={(checked) => toggleActiveMutation.mutate({ id: workflow.id, is_active: checked })}
                          data-testid={`switch-workflow-active-${workflow.id}`}
                        />
                        <Button variant="ghost" size="icon" onClick={() => handleEditWorkflow(workflow)} data-testid={`button-edit-workflow-${workflow.id}`}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          onClick={() => {
                            setWorkflowToDelete(workflow);
                            setShowDeleteConfirm(true);
                          }}
                          data-testid={`button-delete-workflow-${workflow.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="logs">
          {workflowLogs.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <History className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">No Execution Logs</h3>
                <p className="text-muted-foreground text-center">
                  Workflow execution logs will appear here once workflows are triggered.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {workflowLogs.map((log) => {
                const workflow = workflows.find(w => w.id === log.workflow_id);
                return (
                  <Card key={log.id} data-testid={`card-log-${log.id}`}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3">
                          {log.status === 'success' ? (
                            <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5" />
                          ) : log.status === 'partial' ? (
                            <AlertCircle className="h-5 w-5 text-yellow-500 mt-0.5" />
                          ) : (
                            <XCircle className="h-5 w-5 text-red-500 mt-0.5" />
                          )}
                          <div>
                            <p className="font-medium">{workflow?.name || 'Unknown Workflow'}</p>
                            <p className="text-sm text-muted-foreground">
                              {log.entity_type} #{log.entity_id}
                            </p>
                            {log.error_message && (
                              <p className="text-sm text-red-500 mt-1">{log.error_message}</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Clock className="h-4 w-4" />
                          {log.executed_at ? format(new Date(log.executed_at), 'MMM d, yyyy HH:mm') : '-'}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={showDialog} onOpenChange={(open) => !open && handleCloseDialog()}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {editingWorkflow ? 'Edit Workflow' : 'Create Workflow'}
            </DialogTitle>
            <DialogDescription>
              Define triggers, conditions, and actions for your automation
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-center gap-2 py-4">
            {[1, 2, 3, 4].map((step) => (
              <div key={step} className="flex items-center">
                <button
                  onClick={() => setBuilderStep(step)}
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                    builderStep === step 
                      ? 'bg-primary text-primary-foreground' 
                      : builderStep > step 
                        ? 'bg-green-500 text-white' 
                        : 'bg-muted text-muted-foreground'
                  }`}
                  data-testid={`button-step-${step}`}
                >
                  {builderStep > step ? <CheckCircle2 className="h-4 w-4" /> : step}
                </button>
                {step < 4 && (
                  <div className={`w-12 h-0.5 mx-1 ${builderStep > step ? 'bg-green-500' : 'bg-muted'}`} />
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-center gap-8 text-xs text-muted-foreground mb-4">
            <span className={builderStep === 1 ? 'text-primary font-medium' : ''}>Basics</span>
            <span className={builderStep === 2 ? 'text-primary font-medium' : ''}>Trigger</span>
            <span className={builderStep === 3 ? 'text-primary font-medium' : ''}>Conditions</span>
            <span className={builderStep === 4 ? 'text-primary font-medium' : ''}>Actions</span>
          </div>

          <ScrollArea className="flex-1 px-1">
            {builderStep === 1 && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Workflow Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g., Send welcome email when status changes"
                    data-testid="input-workflow-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="Describe what this workflow does..."
                    data-testid="input-workflow-description"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Entity Type</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setFormData(prev => ({ ...prev, entity_type: 'organization' }))}
                      className={`p-4 rounded-lg border-2 flex items-center gap-3 transition-colors ${
                        formData.entity_type === 'organization' 
                          ? 'border-primary bg-primary/5' 
                          : 'border-border hover:border-primary/50'
                      }`}
                      data-testid="button-entity-organization"
                    >
                      <Building2 className="h-6 w-6" />
                      <div className="text-left">
                        <p className="font-medium">Organization</p>
                        <p className="text-xs text-muted-foreground">Trigger on organisation changes</p>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData(prev => ({ ...prev, entity_type: 'member' }))}
                      className={`p-4 rounded-lg border-2 flex items-center gap-3 transition-colors ${
                        formData.entity_type === 'member' 
                          ? 'border-primary bg-primary/5' 
                          : 'border-border hover:border-primary/50'
                      }`}
                      data-testid="button-entity-member"
                    >
                      <User className="h-6 w-6" />
                      <div className="text-left">
                        <p className="font-medium">Member</p>
                        <p className="text-xs text-muted-foreground">Trigger on member changes</p>
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {builderStep === 2 && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Trigger Type</Label>
                  <div className="grid gap-3">
                    {TRIGGER_TYPES.map((trigger) => (
                      <button
                        key={trigger.value}
                        type="button"
                        onClick={() => setFormData(prev => ({ ...prev, trigger_type: trigger.value }))}
                        className={`p-4 rounded-lg border-2 text-left transition-colors ${
                          formData.trigger_type === trigger.value 
                            ? 'border-primary bg-primary/5' 
                            : 'border-border hover:border-primary/50'
                        }`}
                        data-testid={`button-trigger-${trigger.value}`}
                      >
                        <p className="font-medium">{trigger.label}</p>
                        <p className="text-sm text-muted-foreground">{trigger.description}</p>
                      </button>
                    ))}
                  </div>
                </div>

                {formData.trigger_type === 'field_change' && (
                  <div className="space-y-4 p-4 bg-muted/50 rounded-lg">
                    <div className="space-y-2">
                      <Label>When this field</Label>
                      <Select
                        value={`${formData.trigger_config.field_type}:${formData.trigger_config.field_id}`}
                        onValueChange={(val) => {
                          const [fieldType, fieldId] = val.split(':');
                          setFormData(prev => ({
                            ...prev,
                            trigger_config: { ...prev.trigger_config, field_type: fieldType, field_id: fieldId }
                          }));
                        }}
                      >
                        <SelectTrigger data-testid="select-trigger-field">
                          <SelectValue placeholder="Select a field" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectLabel>Core Fields</SelectLabel>
                            {availableFields.filter(f => f.field_type === 'core').map((field) => (
                              <SelectItem key={`core:${field.id}`} value={`core:${field.id}`}>
                                {field.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                          {availableFields.filter(f => f.field_type === 'custom').length > 0 && (
                            <SelectGroup>
                              <SelectLabel>Custom Fields</SelectLabel>
                              {availableFields.filter(f => f.field_type === 'custom').map((field) => (
                                <SelectItem key={`custom:${field.id}`} value={`custom:${field.id}`}>
                                  {field.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          )}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Operator</Label>
                      <Select
                        value={formData.trigger_config.operator}
                        onValueChange={(val) => setFormData(prev => ({
                          ...prev,
                          trigger_config: { ...prev.trigger_config, operator: val }
                        }))}
                      >
                        <SelectTrigger data-testid="select-trigger-operator">
                          <SelectValue placeholder="Select operator" />
                        </SelectTrigger>
                        <SelectContent>
                          {CONDITION_OPERATORS.map((op) => (
                            <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {!['is_empty', 'is_not_empty'].includes(formData.trigger_config.operator) && (
                      <div className="space-y-2">
                        <Label>Value</Label>
                        <Input
                          value={formData.trigger_config.value || ''}
                          onChange={(e) => setFormData(prev => ({
                            ...prev,
                            trigger_config: { ...prev.trigger_config, value: e.target.value }
                          }))}
                          placeholder="Enter value"
                          data-testid="input-trigger-value"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {builderStep === 3 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Additional Conditions</p>
                    <p className="text-sm text-muted-foreground">Optional: Add conditions that must also be met</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={addCondition} data-testid="button-add-condition">
                    <Plus className="h-4 w-4 mr-2" />
                    Add Condition
                  </Button>
                </div>

                {formData.conditions.length === 0 ? (
                  <Card>
                    <CardContent className="flex flex-col items-center justify-center py-8">
                      <Filter className="h-8 w-8 text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">No additional conditions</p>
                      <p className="text-xs text-muted-foreground">The workflow will run whenever the trigger fires</p>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="space-y-3">
                    {formData.conditions.map((condition, index) => (
                      <Card key={index}>
                        <CardContent className="p-4">
                          <div className="flex items-start gap-3">
                            {index > 0 && (
                              <Select
                                value={condition.logic}
                                onValueChange={(val) => updateCondition(index, { logic: val })}
                              >
                                <SelectTrigger className="w-20">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="AND">AND</SelectItem>
                                  <SelectItem value="OR">OR</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                            <div className="flex-1 grid grid-cols-3 gap-3">
                              <Select
                                value={`${condition.field_type}:${condition.field_id}`}
                                onValueChange={(val) => {
                                  const [fieldType, fieldId] = val.split(':');
                                  updateCondition(index, { field_type: fieldType, field_id: fieldId });
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Select field" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    <SelectLabel>Core Fields</SelectLabel>
                                    {availableFields.filter(f => f.field_type === 'core').map((field) => (
                                      <SelectItem key={`core:${field.id}`} value={`core:${field.id}`}>
                                        {field.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                  {availableFields.filter(f => f.field_type === 'custom').length > 0 && (
                                    <SelectGroup>
                                      <SelectLabel>Custom Fields</SelectLabel>
                                      {availableFields.filter(f => f.field_type === 'custom').map((field) => (
                                        <SelectItem key={`custom:${field.id}`} value={`custom:${field.id}`}>
                                          {field.label}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  )}
                                </SelectContent>
                              </Select>
                              <Select
                                value={condition.operator}
                                onValueChange={(val) => updateCondition(index, { operator: val })}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Operator" />
                                </SelectTrigger>
                                <SelectContent>
                                  {CONDITION_OPERATORS.map((op) => (
                                    <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {!['is_empty', 'is_not_empty'].includes(condition.operator) && (
                                <Input
                                  value={condition.value || ''}
                                  onChange={(e) => updateCondition(index, { value: e.target.value })}
                                  placeholder="Value"
                                />
                              )}
                            </div>
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              onClick={() => removeCondition(index)}
                              data-testid={`button-remove-condition-${index}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}

            {builderStep === 4 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Actions</p>
                    <p className="text-sm text-muted-foreground">Define what happens when the workflow triggers</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {ACTION_TYPES.map((action) => (
                    <button
                      key={action.value}
                      type="button"
                      onClick={() => addAction(action.value)}
                      className="p-4 rounded-lg border-2 border-dashed border-border hover:border-primary/50 text-left transition-colors"
                      data-testid={`button-add-action-${action.value}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <action.icon className="h-5 w-5" />
                        <p className="font-medium">{action.label}</p>
                      </div>
                      <p className="text-xs text-muted-foreground">{action.description}</p>
                    </button>
                  ))}
                </div>

                {formData.actions.length > 0 && (
                  <div className="space-y-3 mt-4">
                    <Separator />
                    <p className="font-medium">Configured Actions</p>
                    {formData.actions.map((action, index) => (
                      <Card key={index}>
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary" className="uppercase text-xs">
                                {index + 1}
                              </Badge>
                              <span className="font-medium">
                                {ACTION_TYPES.find(a => a.value === action.type)?.label || action.type}
                              </span>
                            </div>
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              onClick={() => removeAction(index)}
                              data-testid={`button-remove-action-${index}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>

                          {action.type === 'send_email' && (
                            <div className="space-y-3">
                              <div className="space-y-2">
                                <Label>To (Email Address or Placeholder)</Label>
                                <Input
                                  value={action.config?.to || ''}
                                  onChange={(e) => updateAction(index, { 
                                    config: { ...action.config, to: e.target.value } 
                                  })}
                                  placeholder="{{member.email}} or specific@email.com"
                                  data-testid={`input-action-email-to-${index}`}
                                />
                                <p className="text-xs text-muted-foreground">
                                  Use {'{{field_name}}'} for dynamic values
                                </p>
                              </div>
                              <div className="space-y-2">
                                <Label>Subject</Label>
                                <Input
                                  value={action.config?.subject || ''}
                                  onChange={(e) => updateAction(index, { 
                                    config: { ...action.config, subject: e.target.value } 
                                  })}
                                  placeholder="Email subject"
                                  data-testid={`input-action-email-subject-${index}`}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label>Body</Label>
                                <Textarea
                                  value={action.config?.body || ''}
                                  onChange={(e) => updateAction(index, { 
                                    config: { ...action.config, body: e.target.value } 
                                  })}
                                  placeholder="Email body content..."
                                  rows={4}
                                  data-testid={`input-action-email-body-${index}`}
                                />
                              </div>
                            </div>
                          )}

                          {action.type === 'update_field' && (
                            <div className="space-y-3">
                              <div className="space-y-2">
                                <Label>Field to Update</Label>
                                <Select
                                  value={`${action.config?.field_type || 'core'}:${action.config?.field_id || ''}`}
                                  onValueChange={(val) => {
                                    const [fieldType, fieldId] = val.split(':');
                                    updateAction(index, { 
                                      config: { ...action.config, field_type: fieldType, field_id: fieldId } 
                                    });
                                  }}
                                >
                                  <SelectTrigger data-testid={`select-action-field-${index}`}>
                                    <SelectValue placeholder="Select field" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      <SelectLabel>Core Fields</SelectLabel>
                                      {availableFields.filter(f => f.field_type === 'core').map((field) => (
                                        <SelectItem key={`core:${field.id}`} value={`core:${field.id}`}>
                                          {field.label}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                    {availableFields.filter(f => f.field_type === 'custom').length > 0 && (
                                      <SelectGroup>
                                        <SelectLabel>Custom Fields</SelectLabel>
                                        {availableFields.filter(f => f.field_type === 'custom').map((field) => (
                                          <SelectItem key={`custom:${field.id}`} value={`custom:${field.id}`}>
                                            {field.label}
                                          </SelectItem>
                                        ))}
                                      </SelectGroup>
                                    )}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-2">
                                <Label>New Value</Label>
                                <Input
                                  value={action.config?.value || ''}
                                  onChange={(e) => updateAction(index, { 
                                    config: { ...action.config, value: e.target.value } 
                                  })}
                                  placeholder="New value"
                                  data-testid={`input-action-field-value-${index}`}
                                />
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}
          </ScrollArea>

          <DialogFooter className="flex items-center justify-between mt-4 pt-4 border-t">
            <div>
              {builderStep > 1 && (
                <Button variant="outline" onClick={() => setBuilderStep(prev => prev - 1)} data-testid="button-step-back">
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleCloseDialog} data-testid="button-cancel">
                Cancel
              </Button>
              {builderStep < 4 ? (
                <Button onClick={() => setBuilderStep(prev => prev + 1)} data-testid="button-step-next">
                  Next
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              ) : (
                <Button 
                  onClick={handleSaveWorkflow} 
                  disabled={createMutation.isPending || updateMutation.isPending}
                  data-testid="button-save-workflow"
                >
                  {(createMutation.isPending || updateMutation.isPending) && (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                  )}
                  {editingWorkflow ? 'Update Workflow' : 'Create Workflow'}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Workflow</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{workflowToDelete?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={() => workflowToDelete && deleteMutation.mutate(workflowToDelete.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
