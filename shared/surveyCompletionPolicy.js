// Prospective only: legacy anonymous versions deliberately do not opt in.
export function isEnhancedAnonymousSettings(settings) {
  return settings?.anonymous_completion_version === 1
    && ['anonymous', 'anonymous_dedupe'].includes(settings?.response_identity);
}

export function isEnhancedAnonymousSurvey(form) {
  return form?.form_type === 'survey' && isEnhancedAnonymousSettings(form?.survey_settings);
}

export function surveyResponsePolicy(form) {
  return JSON.stringify([
    form?.form_type || 'standard',
    form?.survey_settings?.response_identity || 'identified',
    form?.survey_settings?.anonymous_completion_version ?? null,
    form?.survey_settings?.one_submission_per_respondent === true,
  ]);
}

const present = value => Array.isArray(value) ? value.length > 0
  : value && typeof value === 'object' ? Object.values(value).some(present) : Boolean(value);
const IDENTITY_TYPES = new Set([
  'email', 'tel', 'contact', 'signature', 'file', 'address_lookup',
  'user_name', 'user_email', 'user_organization', 'user_job_title',
  'first_name', 'last_name', 'user_first_name', 'user_last_name',
  'organisation_dropdown', 'organization_dropdown', 'organisation_group_dropdown',
  'relationship_dropdown', 'communication_preferences', 'membership_payment', 'payment',
]);

/** Actionable save/publish errors; never mutate or silently disable configuration. */
export function validateAnonymousCompletionConfiguration(form = {}) {
  const settings = form.survey_settings || {};
  if (settings.anonymous_completion_version == null) return [];
  if (form.form_type !== 'survey') return ['Anonymous completion tracking is available only on Survey forms. Remove the survey completion policy before switching to Standard.'];
  if (settings.anonymous_completion_version !== 1) return ['Unsupported anonymous completion policy version. Select a supported response identity option.'];
  if (!isEnhancedAnonymousSettings(settings)) return ['Anonymous completion tracking requires Anonymous response identity.'];
  const errors = [];
  const reject = (condition, message) => { if (condition) errors.push(message); };
  reject(form.allow_save_continue_later !== false, 'Turn off Save & Continue Later: enhanced anonymous surveys cannot store identity-linked drafts.');
  reject(form.prefill_source && form.prefill_source !== 'none'
    || present(form.prefill_source_field_id) || present(form.prefill_field_id),
  'Remove respondent/record prefill from this survey.');
  reject(settings.invitation_prefill_config?.source && settings.invitation_prefill_config.source !== 'none',
    'Remove invitation attendee prefill from this survey.');
  reject(present(form.field_mappings) || present(form.entity_pipelines)
    || present(form.structured_actions?.actions) || Array.isArray(form.structured_actions) && form.structured_actions.length > 0
    || ['create', 'update', 'upsert'].includes(form.member_entity_action)
    || ['create', 'update', 'upsert'].includes(form.organization_entity_action)
    || present(form.additional_member_creations)
    || ['create', 'update', 'upsert'].includes(form.entity_action),
  'Remove CRM field mappings, entity pipelines and structured record actions from this survey.');
  reject(form.is_application_form || form.is_job_posting || form.is_contract || form.auto_create_entity
    || form.due_diligence_required || form.prevent_duplicate_email_submission || present(form.uniqueness_checks),
  'Remove application, membership, vacancy and due-diligence processing from this survey.');
  reject(form.allow_submitter_email_copy || form.send_submission_email
    || present(form.submission_emails) || present(form.submission_email_template_id)
    || present(form.communication_category_id),
  'Remove submission emails, submitter copies and communication subscriptions from this survey.');
  reject(present(form.redirect_url), 'Remove the post-submission redirect: enhanced anonymous answers must not be forwarded through a URL.');
  const inspectFields = fields => {
    for (const field of Array.isArray(fields) ? fields : []) {
      if (!field || typeof field !== 'object') continue;
      reject(IDENTITY_TYPES.has(field.type) || present(field.prefill_field)
        || present(field.prefill_source) || present(field.relationship_config)
        || /(e-?mail|phone|mobile|telephone|first.?name|last.?name|full.?name|surname|your.?name|contact)/i.test(`${field.id || ''} ${field.label || ''}`),
      `Remove identity-dependent field "${field.label || field.id || field.type}" or use an identified survey.`);
      inspectFields(field.fields);
      inspectFields(field.sub_questions);
      inspectFields(field.children);
      inspectFields(field.columns);
      inspectFields(field.repeatable_row?.children);
      inspectFields(field.repeatable_row?.child_fields);
      inspectFields(field.repeatable_row?.fields);
      inspectFields(field.child_fields);
      inspectFields(field.repeatable_rows?.children);
      inspectFields(field.repeatable_rows?.child_fields);
      inspectFields(field.repeatable_rows?.fields);
    }
  };
  inspectFields(form.fields);
  for (const rule of Array.isArray(form.visibility_rules) ? form.visibility_rules : []) {
    const actions = Array.isArray(rule.actions) ? rule.actions : [rule];
    for (const action of actions) {
      reject(action.action === 'open_form' || action.type === 'open_form' || action.action_type === 'open_form'
        || present(action.set_value_prefill_source_field_id)
        || present(action.set_value_prefill_field)
        || action.set_value_source === 'prefill',
      'Remove identity-dependent prefill and open-form transition rules from this survey.');
    }
  }
  return [...new Set(errors)];
}