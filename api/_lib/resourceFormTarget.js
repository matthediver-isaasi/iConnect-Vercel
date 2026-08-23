export const TENANT_FORM_RESOURCE_TYPE = 'tenant_form';

/**
 * Tenant-form resources always point to the established standalone FormView
 * route. Keeping the target as a normal resource URL preserves the existing
 * resource contract while letting FormView own authentication and prefill.
 */
export function buildTenantFormResourceUrl(slug) {
  const normalizedSlug = String(slug || '').trim();
  return `/FormView?slug=${encodeURIComponent(normalizedSlug)}`;
}

export function getTenantFormSlugFromTarget(targetUrl) {
  if (typeof targetUrl !== 'string' || !targetUrl.trim()) return null;
  try {
    const parsed = new URL(targetUrl.trim(), 'https://resource.local');
    if (parsed.pathname !== '/FormView') return null;
    const slug = parsed.searchParams.get('slug');
    return slug?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Verify a form resource against the current tenant and replace any equivalent
 * manually composed URL with the canonical standalone FormView destination.
 * Mutates `resourceBody` so callers persist the normalized target.
 */
export async function normalizeTenantFormResourceTarget({
  supabase,
  tenantId,
  resourceBody,
  existingResource = null,
}) {
  if (existingResource
      && !Object.prototype.hasOwnProperty.call(resourceBody || {}, 'resource_type')
      && !Object.prototype.hasOwnProperty.call(resourceBody || {}, 'target_url')) {
    return { ok: true };
  }
  const effectiveType = resourceBody?.resource_type ?? existingResource?.resource_type;
  if (effectiveType !== TENANT_FORM_RESOURCE_TYPE) return { ok: true };

  const targetUrl = resourceBody?.target_url ?? existingResource?.target_url;
  const slug = getTenantFormSlugFromTarget(targetUrl);
  if (!tenantId || !slug) {
    return {
      ok: false,
      status: 400,
      error: 'Select an active form from this tenant for a tenant form resource',
    };
  }

  const { data: form, error } = await supabase
    .from('form')
    .select('id, slug')
    .eq('tenant_id', tenantId)
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    console.error('[Resource form target] Failed to validate selected form:', error.message);
    return { ok: false, status: 500, error: 'Failed to validate the selected form' };
  }
  if (!form) {
    return {
      ok: false,
      status: 400,
      error: 'The selected form is unavailable in this tenant',
    };
  }

  resourceBody.target_url = buildTenantFormResourceUrl(form.slug);
  return { ok: true, form };
}