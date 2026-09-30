import { useState, useCallback } from "react";
import { toast } from "sonner";

export function useWorkflowConfirmation() {
  const [pendingWorkflows, setPendingWorkflows] = useState([]);
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  const [dryRunResults, setDryRunResults] = useState(null);
  const [showDryRunModal, setShowDryRunModal] = useState(false);

  const checkForPendingWorkflows = useCallback((responseData) => {
    if (responseData?._workflowReverts?.length > 0) {
      for (const revert of responseData._workflowReverts) {
        toast.warning(
          `"${revert.workflow_name}" conditions were not met. The field "${revert.field_id}" has been reverted to its previous value.`,
          { duration: 8000 }
        );
      }
    }

    if (responseData?._pendingWorkflowConfirmations?.length > 0) {
      setPendingWorkflows(responseData._pendingWorkflowConfirmations);
      setShowConfirmationModal(true);
      return true;
    }
    return false;
  }, []);

  const handleConfirmWorkflow = useCallback(async (workflow) => {
    try {
      const response = await fetch('/api/functions/execute-workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          workflow_id: workflow.workflow_id,
          entity_type: workflow.entity_type,
          entity_id: workflow.entity_id
        }),
      });
      
      const result = await response.json();
      
      if (result.success) {
        const actionResults = result.action_results || [];
        const dryRuns = actionResults.filter(r => r.status === 'dry_run');
        
        if (dryRuns.length > 0) {
          setDryRunResults(dryRuns);
          setShowDryRunModal(true);
        }
      } else {
        toast.error(result.error || 'Failed to execute workflow');
      }
      
      return result;
    } catch (error) {
      console.error('Error executing workflow:', error);
      toast.error('Failed to execute workflow');
      return { success: false, error: error.message };
    }
  }, []);

  const handleSkipWorkflow = useCallback(async (workflow) => {
    if (workflow.conditions_met === false && workflow.revert_on_fail && workflow.revert_field_id) {
      try {
        const response = await fetch('/api/functions/execute-workflow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            workflow_id: workflow.workflow_id,
            entity_type: workflow.entity_type,
            entity_id: workflow.entity_id,
            action: 'revert',
            revert_field_id: workflow.revert_field_id,
            revert_field_type: workflow.revert_field_type,
            revert_previous_value: workflow.revert_previous_value
          }),
        });
        const result = await response.json();
        if (result.success) {
          toast.warning(
            `"${workflow.workflow_name}" conditions were not met. The triggering field has been reverted to its previous value.`,
            { duration: 6000 }
          );
        } else {
          toast.error('Failed to revert field change');
        }
      } catch (error) {
        console.error('Error reverting workflow trigger:', error);
        toast.error('Failed to revert field change');
      }
    } else {
      toast.info(`Skipped workflow "${workflow.workflow_name}"`);
    }
  }, []);

  const handleSkipAllWorkflows = useCallback(async (unprocessedWorkflows) => {
    const workflowsToProcess = unprocessedWorkflows || pendingWorkflows;
    const revertWorkflows = workflowsToProcess.filter(
      w => w.conditions_met === false && w.revert_on_fail && w.revert_field_id
    );
    for (const workflow of revertWorkflows) {
      try {
        await fetch('/api/functions/execute-workflow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            workflow_id: workflow.workflow_id,
            entity_type: workflow.entity_type,
            entity_id: workflow.entity_id,
            action: 'revert',
            revert_field_id: workflow.revert_field_id,
            revert_field_type: workflow.revert_field_type,
            revert_previous_value: workflow.revert_previous_value
          }),
        });
      } catch (e) {
        console.error('Error reverting on skip all:', e);
      }
    }
    if (revertWorkflows.length > 0) {
      toast.warning('Conditions not met - triggering fields have been reverted.', { duration: 6000 });
    } else if (workflowsToProcess.length > 0) {
      toast.info('All pending workflows skipped');
    }
    setPendingWorkflows([]);
    setShowConfirmationModal(false);
  }, [pendingWorkflows]);

  const clearPendingWorkflows = useCallback(() => {
    setPendingWorkflows([]);
    setShowConfirmationModal(false);
  }, []);

  const clearDryRunResults = useCallback(() => {
    setDryRunResults(null);
    setShowDryRunModal(false);
  }, []);

  return {
    pendingWorkflows,
    showConfirmationModal,
    setShowConfirmationModal,
    checkForPendingWorkflows,
    handleConfirmWorkflow,
    handleSkipWorkflow,
    handleSkipAllWorkflows,
    clearPendingWorkflows,
    dryRunResults,
    showDryRunModal,
    setShowDryRunModal,
    clearDryRunResults,
  };
}

export default useWorkflowConfirmation;
