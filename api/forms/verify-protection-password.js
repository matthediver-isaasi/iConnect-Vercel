import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  PROTECTED_DEPARTMENT_FORM_ID,
  authorizeProtectedFormMutation,
  clearProtectedFormPasswordFailures,
  isProtectedDepartmentForm,
  isProtectedFormRateLimited,
  protectedFormAttemptKey,
  recordProtectedFormPasswordFailure,
} from '../_lib/protectedDepartmentForm.js';

export async function handleVerifyProtectionPassword(req, res, dependencies = {}) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }
  const db = dependencies.supabase || supabase;
  if (!db) return res.status(503).json({ error: 'Database not configured', code: 'DATABASE_UNAVAILABLE' });

  const getContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const tenantCtx = await getContext(req);
  if (!tenantCtx?.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTHENTICATION_REQUIRED' });
  }
  if (tenantCtx.tenantMismatch
    || (tenantCtx.effectiveTenantId && tenantCtx.effectiveTenantId !== tenantCtx.tenantId)) {
    return res.status(409).json({ error: 'Your browser session has switched tenant.', code: 'TENANT_CONTEXT_CHANGED' });
  }
  if (!(await checkAdmin(tenantCtx))) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_ACCESS_REQUIRED' });
  }

  const formId = req.body?.form_id;
  if (!isProtectedDepartmentForm(formId)) {
    return res.status(400).json({ error: 'This form does not use password protection.', code: 'FORM_NOT_PROTECTED' });
  }
  const tenantId = tenantCtx.effectiveTenantId || tenantCtx.tenantId;
  const rateKey = protectedFormAttemptKey(req);
  if ((dependencies.isRateLimited || isProtectedFormRateLimited)(rateKey)) {
    return res.status(429).json({ error: 'Too many password attempts. Please try again later.', code: 'PROTECTED_FORM_RATE_LIMITED' });
  }

  const { data: form, error } = await db
    .from('form')
    .select('id')
    .eq('id', PROTECTED_DEPARTMENT_FORM_ID)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to verify protected form.', code: 'FORM_LOOKUP_FAILED' });
  if (!form) return res.status(404).json({ error: 'Form not found', code: 'FORM_NOT_FOUND' });

  const decision = authorizeProtectedFormMutation({
    formId,
    tenantId,
    method: 'PATCH',
    body: {},
    password: req.body?.password,
    env: dependencies.env || process.env,
  });
  if (!decision.ok) {
    if (decision.code === 'PROTECTED_FORM_PASSWORD_INCORRECT') {
      (dependencies.recordFailure || recordProtectedFormPasswordFailure)(rateKey);
    }
    return res.status(decision.status).json({ error: decision.error, code: decision.code });
  }
  (dependencies.clearFailures || clearProtectedFormPasswordFailures)(rateKey);
  return res.status(200).json({ success: true });
}

export default function handler(req, res) {
  return handleVerifyProtectionPassword(req, res);
}