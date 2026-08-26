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
}) {
  const selections = collectFormCommunicationSelections(form, submissionData, mappedSelections);
  if (selections.size === 0) return { kind: 'none', count: 0 };

  const identity = extractSubscriberIdentity(form?.fields, submissionData, fallbackEmail);
  if (!identity.email && !resolvedMemberId) return { kind: 'none', count: 0 };

  const categoryIds = [...selections.keys()];
  const { data: categories, error: categoryError } = await database
    .from('communication_category')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('id', categoryIds);
  if (categoryError) throw categoryError;
  const validIds = new Set((categories || []).map(({ id }) => id));
  const validSelections = [...selections].filter(([categoryId]) => validIds.has(categoryId));
  if (validSelections.length === 0) return { kind: 'none', count: 0 };

  let member = null;
  if (resolvedMemberId) {
    const result = await database
      .from('member')
      .select('id, email, communications_opted_out_all')
      .eq('tenant_id', tenantId)
      .eq('id', resolvedMemberId)
      .maybeSingle();
    if (result.error) throw result.error;
    member = result.data;
    if (!member) throw new Error('Resolved form member was not found in the submission tenant');
  } else {
    const result = await database
      .from('member')
      .select('id, communications_opted_out_all')
      .eq('tenant_id', tenantId)
      .eq('email', identity.email)
      .maybeSingle();
    if (result.error) throw result.error;
    member = result.data;
  }

  if (member) {
    const reconciliationEmail = identity.email || normalizeSubscriberEmail(member.email);
    if (member.communications_opted_out_all && validSelections.some(([, subscribed]) => subscribed)) {
      const { error } = await database
        .from('member')
        .update({ communications_opted_out_all: false })
        .eq('tenant_id', tenantId)
        .eq('id', member.id);
      if (error) throw error;
    }

    for (const [categoryId, isSubscribed] of validSelections) {
      const { error: preferenceError } = await database
        .from('member_communication_preference')
        .upsert({
          member_id: member.id,
          category_id: categoryId,
          is_subscribed: isSubscribed,
          tenant_id: tenantId,
        }, { onConflict: 'member_id,category_id' });
      if (preferenceError) throw preferenceError;

      // Reconcile only this submitter/category, and only after the member
      // preference is safely stored.
      if (reconciliationEmail) {
        const { error: deleteError } = await database
          .from('email_subscriber')
          .delete()
          .eq('tenant_id', tenantId)
          .eq('email', reconciliationEmail)
          .eq('communication_category_id', categoryId);
        if (deleteError) throw deleteError;
      }
    }
    return { kind: 'member', memberId: member.id, count: validSelections.length };
  }

  const now = new Date().toISOString();
  for (const [categoryId, isSubscribed] of validSelections) {
    const { error } = await database
      .from('email_subscriber')
      .upsert({
        tenant_id: tenantId,
        email: identity.email,
        first_name: identity.firstName,
        last_name: identity.lastName,
        form_id: form.id,
        communication_category_id: categoryId,
        opted_out: !isSubscribed,
        subscribed_at: now,
        opted_out_at: isSubscribed ? null : now,
        updated_at: now,
      }, { onConflict: 'tenant_id,email,communication_category_id' });
    if (error) throw error;
  }
  return { kind: 'external', count: validSelections.length };
}