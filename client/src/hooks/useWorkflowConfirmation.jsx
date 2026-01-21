import { useState, useCallback } from "react";
import { toast } from "sonner";

export function useWorkflowConfirmation() {
  const [pendingWorkflows, setPendingWorkflows] = useState([]);
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);

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
          // Don't send before_data/after_data - server fetches fresh data for security
        }),
      });
      
      const result = await response.json();
      
      if (result.success) {
        toast.success(`Workflow "${workflow.workflow_name}" executed successfully`);
        // Remove this workflow from pending list
        setPendingWorkflows(prev => prev.filter(w => w.workflow_id !== workflow.workflow_id));
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
    // Remove this workflow from pending list
    setPendingWorkflows(prev => prev.filter(w => w.workflow_id !== workflow.workflow_id));
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

  return {
    pendingWorkflows,
    showConfirmationModal,
    setShowConfirmationModal,
    checkForPendingWorkflows,
    handleConfirmWorkflow,
    handleSkipWorkflow,
    handleSkipAllWorkflows,
    clearPendingWorkflows,
  };
}

export default useWorkflowConfirmation;
