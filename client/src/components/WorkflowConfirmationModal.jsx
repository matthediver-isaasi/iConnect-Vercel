import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Zap, Mail, Settings, Check, X, Loader2, PlayCircle,
  CheckCircle2, XCircle, AlertTriangle, Info,
  FileText, SkipForward, Database, Undo2
} from "lucide-react";

const ACTION_ICONS = {
  update_field: Settings,
  send_email: Mail,
  create_membership: Database,
  create_contract: FileText,
};

const ACTION_STATUS_CONFIG = {
  success: { icon: CheckCircle2, color: 'text-green-600 dark:text-green-500', label: 'Done' },
  failed: { icon: XCircle, color: 'text-destructive', label: 'Failed' },
  skipped: { icon: SkipForward, color: 'text-muted-foreground', label: 'Skipped' },
  dry_run: { icon: PlayCircle, color: 'text-blue-600 dark:text-blue-400', label: 'Simulated' },
};

function ActionStepList({ actions, results }) {
  return (
    <div className="space-y-0.5">
      {actions.map((action, i) => {
        const Icon = ACTION_ICONS[action.type] || Zap;
        const result = results?.[i];
        const statusCfg = result ? ACTION_STATUS_CONFIG[result.status] : null;
        const StatusIcon = statusCfg?.icon;

        return (
          <div
            key={i}
            className="flex items-start gap-3 py-2.5 px-3 rounded-md"
            data-testid={`action-step-${i}`}
          >
            <div className="flex items-center gap-2 shrink-0 mt-0.5">
              <span className="text-xs font-medium text-muted-foreground w-4 text-right">{i + 1}.</span>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">{action.description}</span>
                {action.dry_run && (
                  <Badge variant="outline" className="text-xs">
                    <PlayCircle className="h-3 w-3 mr-1" />
                    Dry Run
                  </Badge>
                )}
              </div>
              {action.detail && (
                <p className="text-xs text-muted-foreground">{action.detail}</p>
              )}
              {action.approval_warning && (
                <div className="flex items-center gap-1.5 mt-1" data-testid={`action-approval-warning-${i}`}>
                  <AlertTriangle className="h-3.5 w-3.5 text-yellow-700 dark:text-yellow-700 shrink-0" />
                  <span className="text-xs font-medium text-yellow-700 dark:text-yellow-700">{action.approval_warning}</span>
                </div>
              )}
              {action.requires_approval && action.fees_approved && (
                <div className="flex items-center gap-1.5 mt-1" data-testid={`action-approval-ok-${i}`}>
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-500 shrink-0" />
                  <span className="text-xs text-green-600 dark:text-green-500">Fees approved for {action.membership_year}</span>
                </div>
              )}
              {result && (
                <div className="flex items-center gap-1.5 mt-1">
                  {StatusIcon && <StatusIcon className={`h-3.5 w-3.5 ${statusCfg.color}`} />}
                  <span className={`text-xs font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
                  {result.status === 'failed' && result.error && (
                    <span className="text-xs text-destructive"> - {result.error}</span>
                  )}
                  {result.status === 'skipped' && result.message && (
                    <span className="text-xs text-muted-foreground"> - {result.message}</span>
                  )}
                  {result.status === 'success' && result.action_type === 'create_membership' && result.tier_label && (
                    <span className="text-xs text-muted-foreground">
                      {' '}- {result.tier_label}, {result.membership_year}
                    </span>
                  )}
                  {result.status === 'dry_run' && result.final_cost !== undefined && (
                    <span className="text-xs text-muted-foreground">
                      {' '}- {result.tier_label}, Final: {result.currency || 'GBP'} {parseFloat(result.final_cost).toFixed(2)}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConditionChecklist({ workflow }) {
  const summaries = workflow.condition_summaries || [];
  const results = workflow.condition_results || [];
  
  if (summaries.length === 0 && results.length === 0) return null;
  
  const allMet = workflow.conditions_met !== false;
  
  const items = summaries.length > 0
    ? summaries.map((s, i) => {
        const result = results[i];
        const met = result?.met ?? null;
        return { ...s, met, actual: result?.actual };
      })
    : results.map(r => ({
        field_label: r.field_id,
        operator_label: r.operator,
        value: r.expected,
        met: r.met,
        actual: r.actual,
        logic: 'AND',
      }));

  return (
    <div
      className={`rounded-md border p-3 space-y-2 ${allMet ? 'border-green-500/30 bg-green-500/5' : 'border-destructive/30 bg-destructive/5'}`}
      data-testid={`conditions-checklist-${workflow.workflow_id}`}
    >
      <div className="flex items-center gap-2">
        {allMet ? (
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 shrink-0" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
        )}
        <span className={`text-sm font-medium ${allMet ? 'text-green-700 dark:text-green-400' : 'text-destructive'}`}>
          {allMet ? 'All conditions met' : 'Conditions not met'}
        </span>
      </div>
      <div className="space-y-1.5 ml-1">
        {items.map((item, i) => {
          const StatusIcon = item.met === true ? CheckCircle2 : item.met === false ? XCircle : Info;
          const statusColor = item.met === true
            ? 'text-green-600 dark:text-green-500'
            : item.met === false
            ? 'text-destructive'
            : 'text-muted-foreground';
          
          const noValueOps = ['is_empty', 'is_not_empty', 'is empty', 'is not empty'];
          const opKey = item.operator || item.operator_label;
          const showValue = !noValueOps.includes(opKey) && !noValueOps.includes(item.operator_label) && item.value !== undefined && item.value !== '';

          return (
            <div key={i} className="flex items-start gap-2" data-testid={`condition-item-${i}`}>
              <StatusIcon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${statusColor}`} />
              <div className="flex-1 min-w-0">
                <p className="text-xs">
                  {i > 0 && (
                    <span className="text-muted-foreground font-medium mr-1">
                      {item.logic}
                    </span>
                  )}
                  <span className="font-medium">{item.field_label}</span>
                  {' '}
                  <span className="text-muted-foreground">{item.operator_label}</span>
                  {showValue && (
                    <span className="font-medium"> "{item.value}"</span>
                  )}
                </p>
                {item.met === false && item.actual !== undefined && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Current value: "{item.actual}"
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!allMet && workflow.revert_on_fail && (
        <p className="text-xs text-muted-foreground ml-5 mt-1">
          The triggering field will be reverted when dismissed.
        </p>
      )}
    </div>
  );
}

export function WorkflowConfirmationModal({
  open,
  onOpenChange,
  pendingWorkflows = [],
  onConfirm,
  onSkip,
  onSkipAll
}) {
  const [processingWorkflowId, setProcessingWorkflowId] = useState(null);
  const [processedWorkflows, setProcessedWorkflows] = useState([]);
  const [workflowResults, setWorkflowResults] = useState({});

  const handleConfirm = async (workflow) => {
    setProcessingWorkflowId(workflow.workflow_id);
    try {
      const result = await onConfirm(workflow);
      setProcessedWorkflows(prev => [...prev, { id: workflow.workflow_id, action: 'confirmed' }]);
      if (result?.action_results) {
        setWorkflowResults(prev => ({ ...prev, [workflow.workflow_id]: result.action_results }));
      }
    } finally {
      setProcessingWorkflowId(null);
    }
  };

  const handleSkip = (workflow) => {
    onSkip?.(workflow);
    setProcessedWorkflows(prev => {
      const newProcessed = [...prev, { id: workflow.workflow_id, action: 'skipped' }];
      const newRemaining = pendingWorkflows.filter(
        w => !newProcessed.find(p => p.id === w.workflow_id)
      );
      const stillNeedsRevert = newRemaining.some(
        w => w.conditions_met === false && w.revert_on_fail && w.revert_field_id
      );
      if (!stillNeedsRevert && newRemaining.length === 0) {
        setTimeout(() => {
          setProcessedWorkflows([]);
          setWorkflowResults({});
          onOpenChange(false);
        }, 0);
      }
      return newProcessed;
    });
  };

  const handleSkipAll = () => {
    const unprocessedWorkflows = pendingWorkflows.filter(
      w => !processedWorkflows.find(p => p.id === w.workflow_id)
    );
    if (unprocessedWorkflows.length > 0) {
      if (hasCompletedWorkflows) {
        const dismissedWorkflows = unprocessedWorkflows.map(w => 
          (w.conditions_met === false && w.revert_on_fail) ? { ...w, revert_on_fail: false } : w
        );
        onSkipAll?.(dismissedWorkflows);
      } else {
        onSkipAll?.(unprocessedWorkflows);
      }
    }
    onOpenChange(false);
  };

  const remainingWorkflows = pendingWorkflows.filter(
    w => !processedWorkflows.find(p => p.id === w.workflow_id)
  );

  const confirmedWorkflows = pendingWorkflows.filter(
    w => processedWorkflows.find(p => p.id === w.workflow_id && p.action === 'confirmed')
  );

  const allProcessed = remainingWorkflows.length === 0 && pendingWorkflows.length > 0;

  const hasRevertRequired = remainingWorkflows.some(
    w => w.conditions_met === false && w.revert_on_fail && w.revert_field_id
  );

  const hasCompletedWorkflows = processedWorkflows.some(p => p.action === 'confirmed');

  const handleDismissWithoutRevert = (workflow) => {
    onSkip?.({ ...workflow, revert_on_fail: false });
    setProcessedWorkflows(prev => {
      const newProcessed = [...prev, { id: workflow.workflow_id, action: 'skipped' }];
      const newRemaining = pendingWorkflows.filter(
        w => !newProcessed.find(p => p.id === w.workflow_id)
      );
      if (newRemaining.length === 0) {
        setTimeout(() => {
          setProcessedWorkflows([]);
          setWorkflowResults({});
          onOpenChange(false);
        }, 0);
      }
      return newProcessed;
    });
  };

  const handleClose = () => {
    if (hasRevertRequired && !hasCompletedWorkflows) return;
    if (!allProcessed && remainingWorkflows.length > 0) {
      for (const w of remainingWorkflows) {
        if (hasCompletedWorkflows && w.conditions_met === false && w.revert_on_fail) {
          onSkip?.({ ...w, revert_on_fail: false });
        } else {
          onSkip?.(w);
        }
      }
    }
    setProcessedWorkflows([]);
    setWorkflowResults({});
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) {
        if (hasRevertRequired && !hasCompletedWorkflows) return;
        handleClose();
      }
    }}>
      <DialogContent
        className="sm:max-w-lg"
        hideCloseButton={hasRevertRequired && !hasCompletedWorkflows}
        onPointerDownOutside={(hasRevertRequired && !hasCompletedWorkflows) ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={(hasRevertRequired && !hasCompletedWorkflows) ? (e) => e.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            {allProcessed ? 'Workflows Processed' : 'Workflow Confirmation'}
          </DialogTitle>
          <DialogDescription>
            {allProcessed
              ? processedWorkflows.every(p => p.action === 'skipped')
                ? 'All workflows were skipped. No actions were taken.'
                : processedWorkflows.every(p => p.action === 'confirmed')
                  ? 'All workflows have been executed. See the results below.'
                  : 'Your workflow choices have been processed.'
              : 'The following workflows are ready to run based on your changes. Review the actions and confirm.'
            }
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto">
          {allProcessed && confirmedWorkflows.length > 0 ? (
            confirmedWorkflows.map((workflow) => (
              <div key={workflow.workflow_id} className="space-y-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 shrink-0" />
                  <p className="text-sm font-medium" data-testid={`text-workflow-name-${workflow.workflow_id}`}>
                    {workflow.workflow_name}
                  </p>
                </div>
                <div className="ml-1 border rounded-md bg-muted/20">
                  <ActionStepList
                    actions={workflow.actions || []}
                    results={workflowResults[workflow.workflow_id]}
                  />
                </div>
              </div>
            ))
          ) : allProcessed ? (
            <div className="text-center py-4">
              <Check className="h-8 w-8 text-green-500 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">All workflows processed</p>
            </div>
          ) : (
            remainingWorkflows.map((workflow, index) => (
              <div key={workflow.workflow_id}>
                {index > 0 && <Separator className="my-3" />}
                <div className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium" data-testid={`text-workflow-name-${workflow.workflow_id}`}>
                      {workflow.workflow_name}
                    </p>
                    {workflow.conditions_met === false && (
                      <Badge variant="destructive" className="text-xs">
                        Conditions Not Met
                      </Badge>
                    )}
                  </div>

                  <ConditionChecklist workflow={workflow} />

                  <div className="border rounded-md bg-muted/20">
                    <ActionStepList actions={workflow.actions || []} />
                  </div>

                  {hasCompletedWorkflows && workflow.conditions_met === false && workflow.revert_on_fail && (
                    <div className="flex items-start gap-2 p-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
                      <Info className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                      <p className="text-xs text-blue-700 dark:text-blue-300">
                        Other workflows have already completed successfully for this change. Reverting would undo the triggering field change but not the completed workflow actions.
                      </p>
                    </div>
                  )}

                  <div className="flex gap-2 justify-end">
                    {workflow.conditions_met === false && workflow.revert_on_fail ? (
                      <>
                        {hasCompletedWorkflows && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDismissWithoutRevert(workflow)}
                            disabled={processingWorkflowId === workflow.workflow_id}
                            data-testid={`button-dismiss-workflow-${workflow.workflow_id}`}
                          >
                            <X className="h-4 w-4 mr-1" />
                            Dismiss
                          </Button>
                        )}
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleSkip(workflow)}
                          disabled={processingWorkflowId === workflow.workflow_id}
                          data-testid={`button-skip-workflow-${workflow.workflow_id}`}
                        >
                          <Undo2 className="h-4 w-4 mr-1" />
                          Revert & Dismiss
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSkip(workflow)}
                        disabled={processingWorkflowId === workflow.workflow_id}
                        data-testid={`button-skip-workflow-${workflow.workflow_id}`}
                      >
                        <X className="h-4 w-4 mr-1" />
                        Skip
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => handleConfirm(workflow)}
                      disabled={processingWorkflowId === workflow.workflow_id || workflow.conditions_met === false}
                      data-testid={`button-confirm-workflow-${workflow.workflow_id}`}
                    >
                      {processingWorkflowId === workflow.workflow_id ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4 mr-1" />
                      )}
                      Run Workflow
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {!allProcessed && remainingWorkflows.length > 1 && (!hasRevertRequired || hasCompletedWorkflows) && (
            <Button
              variant="ghost"
              onClick={handleSkipAll}
              className="w-full sm:w-auto"
              data-testid="button-skip-all-workflows"
            >
              {hasCompletedWorkflows && hasRevertRequired ? 'Dismiss All' : 'Skip All'}
            </Button>
          )}
          {(!hasRevertRequired || hasCompletedWorkflows) && (
            <Button
              variant={allProcessed ? "default" : "outline"}
              onClick={handleClose}
              className="w-full sm:w-auto"
              data-testid="button-close-workflow-modal"
            >
              {allProcessed ? 'Done' : 'Close'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DryRunSimulationModal({
  open,
  onOpenChange,
  results = [],
}) {
  if (!results || results.length === 0) return null;

  const result = results[0];
  const steps = result?.simulation_steps || [];

  const formatCost = (value, currency = 'GBP') => {
    const num = parseFloat(value);
    if (isNaN(num)) return '-';
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(num);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlayCircle className="w-4 h-4" />
            Dry Run Simulation Results
          </DialogTitle>
          <DialogDescription>
            <span>
              Organisation: <span className="font-medium">{result.organization_name}</span>
              {' | '}Tier: <span className="font-medium">{result.tier_label}</span>
              {' | '}Year: <span className="font-medium">{result.membership_year}</span>
            </span>
          </DialogDescription>
        </DialogHeader>

        {steps.length > 0 && (
          <div className="space-y-1">
            {steps.map((step, idx) => {
              const StatusIcon = step.status === 'error' ? XCircle
                : step.status === 'warning' ? AlertTriangle
                : step.status === 'info' ? Info
                : CheckCircle2;
              const statusColor = step.status === 'error' ? 'text-destructive'
                : step.status === 'warning' ? 'text-yellow-700 dark:text-yellow-700'
                : step.status === 'info' ? 'text-blue-600 dark:text-blue-400'
                : 'text-green-600 dark:text-green-500';

              return (
                <div key={idx} className="flex items-start gap-2 py-1.5 border-b last:border-b-0" data-testid={`dry-run-step-${idx}`}>
                  <StatusIcon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${statusColor}`} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{step.step}</span>
                    <p className="text-xs text-muted-foreground break-words">{step.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-3 p-3 rounded-md bg-muted/50">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Final Cost</span>
            <span className="font-semibold">
              {formatCost(result.final_cost, result.currency)}
            </span>
          </div>
          {result.overrideApplied && (
            <p className="text-xs text-muted-foreground mt-1">Override was applied to this calculation</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="button-close-dry-run"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default WorkflowConfirmationModal;
