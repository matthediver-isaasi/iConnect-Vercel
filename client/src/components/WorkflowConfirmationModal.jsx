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
import { Zap, Mail, Settings, Check, X, Loader2 } from "lucide-react";

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

  const handleConfirm = async (workflow) => {
    setProcessingWorkflowId(workflow.workflow_id);
    try {
      await onConfirm(workflow);
      setProcessedWorkflows(prev => [...prev, { id: workflow.workflow_id, action: 'confirmed' }]);
    } finally {
      setProcessingWorkflowId(null);
    }
  };

  const handleSkip = (workflow) => {
    setProcessedWorkflows(prev => [...prev, { id: workflow.workflow_id, action: 'skipped' }]);
    onSkip?.(workflow);
  };

  const handleSkipAll = () => {
    onSkipAll?.();
    onOpenChange(false);
  };

  const remainingWorkflows = pendingWorkflows.filter(
    w => !processedWorkflows.find(p => p.id === w.workflow_id)
  );

  const allProcessed = remainingWorkflows.length === 0 && pendingWorkflows.length > 0;

  const handleClose = () => {
    // Clear processed workflows and reset modal state
    setProcessedWorkflows([]);
    // Clear parent's pending workflows to prevent them from showing again
    if (allProcessed || remainingWorkflows.length === 0) {
      onSkipAll?.();
    }
    onOpenChange(false);
  };

  const getActionIcon = (actionType) => {
    switch (actionType) {
      case 'send_email':
        return <Mail className="h-4 w-4" />;
      case 'update_field':
        return <Settings className="h-4 w-4" />;
      default:
        return <Zap className="h-4 w-4" />;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            {allProcessed ? 'Workflows Processed' : 'Workflow Confirmation'}
          </DialogTitle>
          <DialogDescription>
            {allProcessed ? (
              processedWorkflows.every(p => p.action === 'skipped') 
                ? 'All workflows were skipped. No actions were taken.'
                : processedWorkflows.every(p => p.action === 'confirmed')
                  ? 'All workflows have been executed successfully.'
                  : 'Your workflow choices have been processed.'
            ) : (
              'The following workflows are ready to run based on your changes. Would you like to execute them?'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {allProcessed ? (
            <div className="text-center py-4">
              <Check className="h-8 w-8 text-green-500 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">All workflows processed</p>
            </div>
          ) : (
            remainingWorkflows.map((workflow, index) => (
              <div key={workflow.workflow_id}>
                {index > 0 && <Separator className="my-4" />}
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <p className="font-medium" data-testid={`text-workflow-name-${workflow.workflow_id}`}>
                        {workflow.workflow_name}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {workflow.actions?.map((action, i) => (
                          <Badge key={i} variant="secondary" className="text-xs">
                            {getActionIcon(action.type)}
                            <span className="ml-1">{action.description}</span>
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex gap-2 justify-end">
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
                    <Button
                      size="sm"
                      onClick={() => handleConfirm(workflow)}
                      disabled={processingWorkflowId === workflow.workflow_id}
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
          {!allProcessed && remainingWorkflows.length > 1 && (
            <Button 
              variant="ghost" 
              onClick={handleSkipAll}
              className="w-full sm:w-auto"
              data-testid="button-skip-all-workflows"
            >
              Skip All
            </Button>
          )}
          <Button 
            variant={allProcessed ? "default" : "outline"} 
            onClick={handleClose}
            className="w-full sm:w-auto"
            data-testid="button-close-workflow-modal"
          >
            {allProcessed ? 'Done' : 'Close'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default WorkflowConfirmationModal;
