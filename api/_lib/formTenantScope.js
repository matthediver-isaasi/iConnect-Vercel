// Authoritative tenant resolution for the form application processor.
//
// The processor's req.body.tenant_id is client-controlled: the public form
// path supplies it, but ANY caller could supply an arbitrary tenant id. The
// tenant that scopes entity resolution and is stamped onto newly created
// records must therefore come from the persisted form (or form_submission)
// row. A supplied body tenant_id is only ever validated for equality against
// the authoritative tenant — a mismatch is rejected by the caller, never
// silently adopted.
//
// Kept dependency-free (the supabase client is injected) so it can be unit
// tested with a fake client — see formTenantScope.test.mjs.

/**
 * Resolve the effective tenant for entity resolution/creation.
 *
 * Precedence:
 *   1. form.tenant_id (by form_id)          — authoritative
 *   2. form_submission.tenant_id (by id)    — authoritative
 *   3. body tenant_id                        — fallback ONLY when no
 *      authoritative tenant could be resolved (legacy/pre-tenant forms)
 *
 * When an authoritative tenant exists AND a body tenant_id was supplied and
 * they differ, returns { mismatch } so the caller can reject the request.
 *
 * @returns {Promise<{ tenantId: string|null, source: string|null, mismatch: null | { supplied: string, authoritative: string } }>}
 */
export async function resolveEffectiveEntityTenant(supabase, { tenant_id, form_id, submission_id }) {
  let authoritative = null;
  let source = null;

  if (form_id) {
    const { data } = await supabase
      .from('form')
      .select('tenant_id')
      .eq('id', form_id)
      .maybeSingle();
    if (data?.tenant_id) {
      authoritative = data.tenant_id;
      source = 'form';
    }
  }
  if (!authoritative && submission_id) {
    const { data } = await supabase
      .from('form_submission')
      .select('tenant_id')
      .eq('id', submission_id)
      .maybeSingle();
    if (data?.tenant_id) {
      authoritative = data.tenant_id;
      source = 'form_submission';
    }
  }

  if (authoritative) {
    if (tenant_id && tenant_id !== authoritative) {
      return { tenantId: authoritative, source, mismatch: { supplied: tenant_id, authoritative } };
    }
    return { tenantId: authoritative, source, mismatch: null };
  }
  return { tenantId: tenant_id || null, source: tenant_id ? 'request_body' : null, mismatch: null };
}

/**
 * A found row is a cross-tenant hit when we know the effective tenant and the
 * row carries a DIFFERENT non-null tenant_id. Rows with a NULL tenant_id
 * (legacy/pre-tenant data) are still considered in-tenant — downstream code
 * adopts them into the tenant on update.
 */
export function isCrossTenantRow(effectiveTenantId, row) {
  return !!(effectiveTenantId && row?.tenant_id && row.tenant_id !== effectiveTenantId);
}
