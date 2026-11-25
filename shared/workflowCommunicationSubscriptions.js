export const WORKFLOW_COMMUNICATION_FIELD = 'communication_categories';

export function isWorkflowCommunicationConfig(config) {
  return config?.field_type === WORKFLOW_COMMUNICATION_FIELD ||
    config?.field_id === WORKFLOW_COMMUNICATION_FIELD ||
    Object.prototype.hasOwnProperty.call(config || {}, 'communication_subscription');
}

export function normalizeWorkflowCommunicationConfig(config, entityType) {
  const selection = config?.communication_subscription;
  if (entityType !== 'member') throw new Error('Communication Categories requires a member workflow');
  if (config?.field_type !== WORKFLOW_COMMUNICATION_FIELD ||
      config?.field_id !== WORKFLOW_COMMUNICATION_FIELD ||
      !selection || !Array.isArray(selection.category_ids) ||
      !selection.category_ids.length || selection.category_ids.length > 100 ||
      typeof selection.is_subscribed !== 'boolean' ||
      selection.category_ids.some(id => typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('Select 1–100 communication categories and an explicit Subscribe or Unsubscribe value');
  }
  return {
    field_type: WORKFLOW_COMMUNICATION_FIELD,
    field_id: WORKFLOW_COMMUNICATION_FIELD,
    communication_subscription: {
      category_ids: [...new Set(selection.category_ids.map(id => id.toLowerCase()))],
      is_subscribed: selection.is_subscribed,
    },
  };
}

export function workflowUpdateFieldSelection(fieldType, fieldId, fieldLabel) {
  return fieldType === WORKFLOW_COMMUNICATION_FIELD
    ? { field_type: fieldType, field_id: WORKFLOW_COMMUNICATION_FIELD,
        communication_subscription: { category_ids: [], is_subscribed: null } }
    : { field_type: fieldType, field_id: fieldId, field_label: fieldLabel || fieldId, value: '' };
}

export function clearIncompatibleCommunicationActions(actions, entityType) {
  return entityType === 'member' ? actions : actions.map(action =>
    action.type === 'update_field' && isWorkflowCommunicationConfig(action.config)
      ? { ...action, config: workflowUpdateFieldSelection('core', '') } : action);
}
