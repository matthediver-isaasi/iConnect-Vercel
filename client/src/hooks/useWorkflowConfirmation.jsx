import { useState, useCallback } from "react";
import { toast } from "sonner";

export function useWorkflowConfirmation() {
  const [pendingWorkflows, setPendingWorkflows] = useState([]);
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  const [dryRunResults, setDryRunResults] = useState(null);
  const [showDryRunModal, setShowDryRunModal] = useState(false);

  const checkForPendingWorkflows = useCallback((responseData) => {
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
        if (result.dry_run_results?.length > 0) {
          setDryRunResults(result.dry_run_results);
          setShowDryRunModal(true);
          toast.info(`Workflow "${workflow.workflow_name}" dry run completed`);
        } else {
          toast.success(`Workflow "${workflow.workflow_name}" executed successfully`);
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

  const handleSkipWorkflow = useCallback((workflow) => {
    toast.info(`Skipped workflow "${workflow.workflow_name}"`);
  }, []);

  const handleSkipAllWorkflows = useCallback(() => {
    toast.info('All pending workflows skipped');
    setPendingWorkflows([]);
    setShowConfirmationModal(false);
  }, []);

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
