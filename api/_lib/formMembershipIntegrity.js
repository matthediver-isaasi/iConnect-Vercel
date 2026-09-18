// Only processor-persisted submission links authorize membership creation.
// Caller IDs and prefill references are not proofs and never repair a mismatch.
export const MAX_ENTITY_ATTEMPTS = 8;
export const MAX_ENTITY_WAIT_MS = 24 * 60 * 60 * 1000;

export function membershipIsBlocked(progress) {
  return progress?.status === 'blocked'
    || progress?.integrity_state === 'blocked'
    || progress?.invoice_state === 'blocked'
    || progress?.settlement_state === 'blocked';
}

export function membershipIntegrityError(code) {
  const error = new Error(code);
  error.code = code;
  error.membershipIntegrity = true;
  return error;
}

export async function authoritativeMembershipEntity(supabase, submission, target) {
  if (!['member', 'organization'].includes(target)) {
    throw membershipIntegrityError('MEMBERSHIP_TARGET_INVALID');
  }
  const id = target === 'member' ? submission.created_member_id : submission.organization_id;
  if (!id) return null;
  const { data, error } = await supabase.from(target).select('id, tenant_id')
    .eq('id', id).eq('tenant_id', submission.tenant_id).maybeSingle();
  if (error) throw new Error('Membership entity validation unavailable');
  if (!data || String(data.id) !== String(id) || data.tenant_id !== submission.tenant_id) {
    throw membershipIntegrityError('MEMBERSHIP_ENTITY_TENANT_INVALID');
  }
  return id;
}

export function missingMembershipEntityOutcome(submission, prior = {}, processor = null, now = Date.now()) {
  // Exact-operation waiting is owned by the pipeline observer, not an entity
  // diagnostic attempt. Never age an actively observed operation into failure.
  if (processor?.awaitingOperation) return { status: 'awaiting_entity', waitingOperation: true };
  const meta = submission.payment_meta || {};
  const pending = meta.structured_actions_pending || meta.related_records_pending || meta.stripe_address_mappings_pending;
  const finished = !pending && !processor?.failed && !processor?.partial && (submission.entity_processing_completed_at
    || (processor?.ran && !processor.failed && !processor.partial));
  const attempts = Number(prior.attempts || 0) + 1;
  const first = prior.entity_wait_started_at || new Date(now).toISOString();
  const age = now - Date.parse(first);
  const code = finished ? 'MEMBERSHIP_PROCESSOR_TARGET_MISSING'
    : attempts >= MAX_ENTITY_ATTEMPTS || age >= MAX_ENTITY_WAIT_MS ? 'MEMBERSHIP_ENTITY_WAIT_EXHAUSTED' : null;
  return {
    status: code ? 'blocked' : 'awaiting_entity',
    attempts,
    entity_wait_started_at: first,
    ...(code ? { integrity_state: 'blocked', integrity_error_code: code } : {}),
  };
}