import { createHash, timingSafeEqual } from 'node:crypto';
import {
  PROTECTED_DEPARTMENT_FORM_ID,
  PROTECTED_DEPARTMENT_TENANT_ID,
  PROTECTED_FORM_HELPER_MESSAGE,
  isProtectedDepartmentForm,
} from '../../shared/protectedDepartmentForm.js';

export {
  PROTECTED_DEPARTMENT_FORM_ID,
  PROTECTED_DEPARTMENT_TENANT_ID,
  PROTECTED_FORM_HELPER_MESSAGE,
  isProtectedDepartmentForm,
};

export const FORM_PROTECTION_PASSWORD_HEADER = 'x-form-protection-password';
export const FORM_DEACTIVATION_CONFIRMED_HEADER = 'x-form-deactivation-confirmed';

const digest = value => createHash('sha256').update(String(value), 'utf8').digest();
const failedAttempts = new Map();
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;

export function protectedFormPasswordConfigured(env = process.env) {
  return typeof env?.BNMS_DEPT_SURVEY_SECRET === 'string'
    && env.BNMS_DEPT_SURVEY_SECRET.length > 0;
}

export function verifyProtectedFormPassword(password, env = process.env) {
  if (!protectedFormPasswordConfigured(env) || typeof password !== 'string') return false;
  return timingSafeEqual(
    digest(password),
    digest(env.BNMS_DEPT_SURVEY_SECRET),
  );
}

export function isProtectedDepartmentTenant(tenantId) {
  return String(tenantId || '').trim().toLowerCase() === PROTECTED_DEPARTMENT_TENANT_ID;
}

export function getRequestHeader(req, name) {
  if (typeof req?.get === 'function') return req.get(name);
  const headers = req?.headers || {};
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

export function protectedFormAttemptKey(req) {
  const forwarded = getRequestHeader(req, 'x-forwarded-for');
  const address = String(forwarded || req?.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  return createHash('sha256').update(address, 'utf8').digest('hex');
}

export function isProtectedFormRateLimited(key, now = Date.now()) {
  const recent = (failedAttempts.get(key) || []).filter(at => now - at < ATTEMPT_WINDOW_MS);
  if (recent.length) failedAttempts.set(key, recent);
  else failedAttempts.delete(key);
  return recent.length >= MAX_FAILED_ATTEMPTS;
}

export function recordProtectedFormPasswordFailure(key, now = Date.now()) {
  const recent = (failedAttempts.get(key) || []).filter(at => now - at < ATTEMPT_WINDOW_MS);
  recent.push(now);
  failedAttempts.set(key, recent);
}

export function clearProtectedFormPasswordFailures(key) {
  failedAttempts.delete(key);
}

export function hasCredentialLikeBodyProperty(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body).some(key => /(?:password|secret|protection[_-]?credential)/i.test(key));
}

export function authorizeProtectedFormMutation({
  formId,
  tenantId,
  method,
  body,
  password,
  deactivationConfirmed,
  env = process.env,
}) {
  if (!isProtectedDepartmentForm(formId) || !isProtectedDepartmentTenant(tenantId)) {
    return { ok: true, protected: false };
  }
  if (String(method).toUpperCase() === 'DELETE') {
    return {
      ok: false,
      status: 403,
      code: 'PROTECTED_FORM_DELETE_FORBIDDEN',
      error: PROTECTED_FORM_HELPER_MESSAGE,
    };
  }
  if (hasCredentialLikeBodyProperty(body)) {
    return {
      ok: false,
      status: 400,
      code: 'PROTECTED_FORM_CREDENTIAL_IN_BODY',
      error: 'The form protection password must be sent in the protection header.',
    };
  }
  if (!protectedFormPasswordConfigured(env)) {
    return {
      ok: false,
      status: 503,
      code: 'PROTECTED_FORM_SECRET_NOT_CONFIGURED',
      error: 'Protected form changes are unavailable because protection is not configured.',
    };
  }
  if (!verifyProtectedFormPassword(password, env)) {
    return {
      ok: false,
      status: 403,
      code: 'PROTECTED_FORM_PASSWORD_INCORRECT',
      error: 'The protection password is incorrect.',
    };
  }
  if (body?.is_active === false && String(deactivationConfirmed).toLowerCase() !== 'true') {
    return {
      ok: false,
      status: 409,
      code: 'PROTECTED_FORM_DEACTIVATION_CONFIRMATION_REQUIRED',
      error: 'Final confirmation is required before this protected form can be deactivated.',
    };
  }
  return { ok: true, protected: true };
}