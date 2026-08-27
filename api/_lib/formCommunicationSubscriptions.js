import { randomUUID } from 'node:crypto';
import { filterCommunicationCategoriesForMember } from '../../shared/communicationCategoryMembership.js';

export function normalizeSubscriberEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function collectFormCommunicationSelections(form, submissionData, mappedSelections = []) {
  const selections = new Map();
  // Preserve the application processor's established precedence: the form-level
  // opt-in is the default, submitted communication_preferences fields override
  // it, and explicit field-to-category mappings are applied last.
  if (form?.communication_category_id) {
    selections.set(form.communication_category_id, true);
  }
  for (const field of form?.fields || []) {
    if (!field || field.type !== 'communication_preferences') continue;
    const values = submissionData?.[field.id];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [categoryId, isSubscribed] of Object.entries(values)) {
      if (categoryId) selections.set(categoryId, Boolean(isSubscribed));
    }
  }
  const entries = mappedSelections instanceof Map
    ? mappedSelections
    : Array.isArray(mappedSelections)
      ? mappedSelections
      : Object.entries(mappedSelections || {});
  for (const entry of entries) {
    const [categoryId, isSubscribed] = Array.isArray(entry)
      ? entry
      : [entry?.category_id, entry?.is_subscribed];
    if (categoryId) selections.set(categoryId, Boolean(isSubscribed));
  }
  return selections;
}

function communicationMappingBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase().trim());
  }
  if (typeof value === 'number') return value !== 0;
  return Boolean(value);
}

export function collectMemberPipelineCommunicationSelections(entityPipelines, submissionData) {
  const memberPipelines = Array.isArray(entityPipelines?.members) ? entityPipelines.members : [];
  const primary = memberPipelines.find((pipeline) => pipeline?.isPrimary || pipeline?.is_primary);
  if (!primary || !Array.isArray(primary.mappings)) return [];

  const selections = new Map();
  for (const mapping of primary.mappings) {
    if (!mapping || mapping.target_type !== 'communication' || !mapping.target_field) continue;
    let value;
    if (mapping.source_type === 'static') {
      value = mapping.static_value;
    } else if (mapping.source_field_id) {
      value = submissionData?.[mapping.source_field_id];
      if (mapping.source_category_id && value && typeof value === 'object' && !Array.isArray(value)) {
        value = value[mapping.source_category_id] ?? null;
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      value = value[mapping.target_field] ?? null;
    }
    selections.set(mapping.target_field, communicationMappingBoolean(value));
  }
  return [...selections].map(([category_id, is_subscribed]) => ({ category_id, is_subscribed }));
}

export function createFormCommunicationSnapshot({
  form,
  submissionData,
  mappedSelections = [],
  resolvedMemberId = null,
  fallbackEmail = '',
}) {
  const selections = [...collectFormCommunicationSelections(form, submissionData, mappedSelections)]
    .map(([category_id, is_subscribed]) => ({ category_id, is_subscribed: Boolean(is_subscribed) }));
  const identity = extractSubscriberIdentity(form?.fields, submissionData, fallbackEmail);
  const canApply = Boolean(resolvedMemberId || identity.email);
  return {
    version: 1,
    status: selections.length && canApply ? 'pending' : 'completed',
    member_id: resolvedMemberId || null,
    email: identity.email || null,
    first_name: identity.firstName,
    last_name: identity.lastName,
    selections,
    attempts: 0,
    error: null,
  };
}

export function prepareInitialMemberCommunicationSnapshot(snapshot, hasMemberPipeline) {
  if (!hasMemberPipeline || !snapshot?.selections?.length) return snapshot;
  return { ...snapshot, status: 'awaiting_member' };
}

export function safeSubscriptionDiagnostic(error) {
  return {
    code: typeof error?.code === 'string' ? error.code.slice(0, 80) : null,
    message: String(error?.message || error || 'Unknown communication finalization error').slice(0, 500),
    details: typeof error?.details === 'string' ? error.details.slice(0, 500) : null,
    hint: typeof error?.hint === 'string' ? error.hint.slice(0, 300) : null,
  };
}

export async function promoteAwaitingMemberCommunicationSnapshot(database, submission, targetSnapshot = null) {
  const state = submission?.communication_finalization_state;
  if (!state) return null;
  if (state.status !== 'awaiting_member' && !targetSnapshot?.member_id) return state;
  if (!submission?.created_member_id && !targetSnapshot) return null;
  const nextState = state.status === 'awaiting_member'
    ? {
        ...(targetSnapshot || state),
        status: 'pending',
        member_id: targetSnapshot?.member_id || submission.created_member_id || null,
      }
    : targetSnapshot;
  const { data, error } = await database.rpc('promote_form_communication_finalization', {
    p_submission_id: submission.id,
    p_member_id: nextState.member_id,
    p_snapshot: nextState,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) || null;
}

async function loadFinalizationState(database, submissionId) {
  const { data, error } = await database
    .from('form_submission')
    .select('communication_finalization_state')
    .eq('id', submissionId)
    .maybeSingle();
  if (error) throw error;
  return data?.communication_finalization_state || null;
}

export async function finalizeFormCommunicationSnapshot({
  database,
  tenantId,
  submissionId,
  formId,
  snapshot,
}) {
  if (!snapshot || snapshot.status === 'completed') return snapshot;
  const ownerToken = randomUUID();
  const { data: claimedRows, error: claimError } = await database.rpc(
    'claim_form_communication_finalization',
    {
      p_submission_id: submissionId,
      p_expected_status: snapshot.status,
      p_expected_attempts: Number(snapshot.attempts || 0),
      p_owner_token: ownerToken,
    }
  );
  if (claimError) throw claimError;
  const claimed = Array.isArray(claimedRows) ? claimedRows[0] : claimedRows;
  if (!claimed) {
    const current = await loadFinalizationState(database, submissionId);
    if (current?.status === 'completed') return current;
    const error = new Error('Communication finalization is already in progress');
    error.code = 'COMMUNICATION_FINALIZATION_IN_PROGRESS';
    throw error;
  }

  try {
    const persistenceResult = await persistFormCommunicationSubscriptions({
      database,
      tenantId,
      form: { id: formId, fields: [] },
      submissionData: {},
      mappedSelections: claimed.selections,
      resolvedMemberId: claimed.member_id,
      fallbackEmail: claimed.email || '',
      identityOverride: {
        email: claimed.email,
        firstName: claimed.first_name,
        lastName: claimed.last_name,
      },
    });

    if (persistenceResult.kind === 'none') {
      const { data: completedRows, error: completeError } = await database.rpc(
        'finish_form_communication_finalization',
        {
          p_submission_id: submissionId,
          p_owner_token: ownerToken,
          p_status: 'completed',
          p_error: null,
          p_member_id: claimed.member_id,
        }
      );
      if (completeError) throw completeError;
      return (Array.isArray(completedRows) ? completedRows[0] : completedRows) || claimed;
    }

    const appliedSelections = persistenceResult.selections || [];
    const categoryIds = appliedSelections.map(({ category_id }) => category_id);
    const isMember = persistenceResult.kind === 'member';
    const verificationQuery = isMember
      ? database
          .from('member_communication_preference')
          .select('category_id, is_subscribed')
          .eq('tenant_id', tenantId)
          .eq('member_id', persistenceResult.memberId)
          .in('category_id', categoryIds)
      : database
          .from('email_subscriber')
          .select('communication_category_id, opted_out')
          .eq('tenant_id', tenantId)
          .eq('email', claimed.email)
          .in('communication_category_id', categoryIds);
    const { data: preferences, error: verifyError } = await verificationQuery;
    if (verifyError) throw verifyError;
    const actual = new Map((preferences || []).map((row) => isMember
      ? [row.category_id, row.is_subscribed]
      : [row.communication_category_id, !row.opted_out]
    ));
    const missing = appliedSelections.filter(
      ({ category_id, is_subscribed }) => actual.get(category_id) !== is_subscribed
    );
    if (missing.length) {
      const error = new Error(`Communication preference verification failed for ${missing.length} category selection(s)`);
      error.code = 'COMMUNICATION_VERIFICATION_FAILED';
      throw error;
    }

    const { data: completedRows, error: completeError } = await database.rpc(
      'finish_form_communication_finalization',
      {
        p_submission_id: submissionId,
        p_owner_token: ownerToken,
        p_status: 'completed',
        p_error: null,
        p_member_id: isMember ? persistenceResult.memberId : null,
      }
    );
    if (completeError) throw completeError;
    const completed = Array.isArray(completedRows) ? completedRows[0] : completedRows;
    if (completed) return completed;
    const current = await loadFinalizationState(database, submissionId);
    if (current?.status === 'completed') return current;
    throw Object.assign(new Error('Communication finalization completion lease was lost'), {
      code: 'COMMUNICATION_FINALIZATION_LEASE_LOST',
    });
  } catch (error) {
    if (error.code === 'COMMUNICATION_FINALIZATION_IN_PROGRESS') throw error;
    const diagnostic = safeSubscriptionDiagnostic(error);
    try {
      const { error: finishError } = await database.rpc(
        'finish_form_communication_finalization',
        {
          p_submission_id: submissionId,
          p_owner_token: ownerToken,
          p_status: 'failed',
          p_error: diagnostic,
          p_member_id: claimed.member_id,
        }
      );
      if (finishError) throw finishError;
    } catch (stateError) {
      error.finalizationStateError = safeSubscriptionDiagnostic(stateError);
    }
    throw error;
  }
}

export function extractSubscriberIdentity(fields, submissionData, fallbackEmail = '') {
  let email = normalizeSubscriberEmail(fallbackEmail);
  let firstName = null;
  let lastName = null;
  for (const field of fields || []) {
    const value = submissionData?.[field.id];
    if (typeof value !== 'string' || !value.trim()) continue;
    const id = String(field.id || '').toLowerCase();
    const label = String(field.label || '').toLowerCase();
    if (!email && (field.type === 'email' || id.includes('email'))) {
      email = normalizeSubscriberEmail(value);
    }
    if (!firstName && field.type === 'text' && (id.includes('first_name') || label.includes('first name'))) {
      firstName = value.trim();
    }
    if (!lastName && field.type === 'text' && (id.includes('last_name') || label.includes('last name'))) {
      lastName = value.trim();
    }
  }
  return { email, firstName, lastName };
}

export async function persistFormCommunicationSubscriptions({
  database,
  tenantId,
  form,
  submissionData,
  mappedSelections = [],
  resolvedMemberId = null,
  fallbackEmail = '',
  identityOverride = null,
}) {
  const selections = collectFormCommunicationSelections(form, submissionData, mappedSelections);
  if (selections.size === 0) return { kind: 'none', count: 0, reason: 'no_selections', selections: [] };

  const extractedIdentity = extractSubscriberIdentity(form?.fields, submissionData, fallbackEmail);
  const identity = identityOverride
    ? {
        email: normalizeSubscriberEmail(identityOverride.email) || extractedIdentity.email,
        firstName: identityOverride.firstName ?? extractedIdentity.firstName,
        lastName: identityOverride.lastName ?? extractedIdentity.lastName,
      }
    : extractedIdentity;
  if (!identity.email && !resolvedMemberId) return { kind: 'none', count: 0, reason: 'no_identity', selections: [] };

  const categoryIds = [...selections.keys()];
  const { data: categories, error: categoryError } = await database
    .from('communication_category')
    .select('id, is_public, member_enabled')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .in('id', categoryIds);
  if (categoryError) throw categoryError;
  const validIds = new Set((categories || []).map(({ id }) => id));
  const categoryById = new Map((categories || []).map((category) => [category.id, category]));
  const validSelections = [...selections].filter(([categoryId]) => validIds.has(categoryId));
  const appliedSelections = validSelections.map(([category_id, is_subscribed]) => ({
    category_id,
    is_subscribed,
  }));
  if (validSelections.length === 0) return { kind: 'none', count: 0, reason: 'no_valid_categories', selections: [] };

  let member = null;
  if (resolvedMemberId) {
    const result = await database
      .from('member')
      .select('id, email, role_id, communications_opted_out_all')
      .eq('tenant_id', tenantId)
      .eq('id', resolvedMemberId)
      .maybeSingle();
    if (result.error) throw result.error;
    member = result.data;
    if (!member) throw new Error('Resolved form member was not found in the submission tenant');
  } else {
    const result = await database
      .from('member')
      .select('id, email, role_id, communications_opted_out_all')
      .eq('tenant_id', tenantId)
      .eq('email', identity.email)
      .maybeSingle();
    if (result.error) throw result.error;
    member = result.data;
  }

  if (member) {
    const { data: roleAssignments, error: roleError } = await database
      .from('communication_category_role')
      .select('category_id, role_id')
      .eq('tenant_id', tenantId)
      .in('category_id', validSelections.map(([categoryId]) => categoryId));
    if (roleError) throw roleError;

    const eligibleCategoryIds = new Set(
      filterCommunicationCategoriesForMember(categories || [], roleAssignments || [], member)
        .map(({ id }) => id)
    );
    const unauthorizedOptIn = validSelections.find(
      ([categoryId, isSubscribed]) => isSubscribed && !eligibleCategoryIds.has(categoryId)
    );
    if (unauthorizedOptIn) {
      const error = new Error('Member is not eligible for a selected communication category');
      error.code = 'COMMUNICATION_CATEGORY_ROLE_FORBIDDEN';
      throw error;
    }

    const { error } = await database.rpc('set_form_communication_preference_state', {
      p_tenant_id: tenantId,
      p_email: normalizeSubscriberEmail(member.email) || identity.email,
      p_member_id: member.id,
      p_form_id: form.id,
      p_first_name: identity.firstName,
      p_last_name: identity.lastName,
      p_category_ids: validSelections.map(([categoryId]) => categoryId),
      p_is_subscribed: validSelections.map(([, isSubscribed]) => isSubscribed),
    });
    if (error) throw error;
    return { kind: 'member', memberId: member.id, count: validSelections.length, selections: appliedSelections };
  }

  const externalSelections = validSelections.filter(
    ([categoryId, isSubscribed]) =>
      !isSubscribed || categoryById.get(categoryId)?.is_public === true
  );
  if (externalSelections.length === 0) {
    return { kind: 'none', count: 0, reason: 'no_public_categories', selections: [] };
  }
  const externalAppliedSelections = externalSelections.map(([category_id, is_subscribed]) => ({
    category_id,
    is_subscribed,
  }));

  const { error } = await database.rpc('set_form_communication_preference_state', {
    p_tenant_id: tenantId,
    p_email: identity.email,
    p_member_id: null,
    p_form_id: form.id,
    p_first_name: identity.firstName,
    p_last_name: identity.lastName,
    p_category_ids: externalSelections.map(([categoryId]) => categoryId),
    p_is_subscribed: externalSelections.map(([, isSubscribed]) => isSubscribed),
  });
  if (error) throw error;
  return {
    kind: 'external',
    count: externalSelections.length,
    selections: externalAppliedSelections,
  };
}