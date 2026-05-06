import { supabase } from './database.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve dd_owner display name + email for a Due Diligence submission.
 *
 * Mirrors the canonical lookup used by api/due-diligence/_stageActions.js:
 *   1. Load form_submission_due_diligence by form_submission_id (tenant-scoped).
 *   2. Prefer ddSubmission.owner_name; fall back to
 *      form_due_diligence_config.default_owner_name (per form_id).
 *   3. If owner_member_id is set, look up member.email for the email.
 *
 * Always returns string fields ('' instead of null/undefined) so callers can
 * safely .replace(...) without leaking literal undefined into outbound email.
 *
 * @param {object} args
 * @param {object} args.supabase - Supabase client (defaults to shared one)
 * @param {string} args.tenantId - Tenant id (required for scoping)
 * @param {string|null} args.formSubmissionId - The DD form submission id, if any
 * @param {string|null} [args.formId] - Optional form id (used for default_owner_name fallback when no submission row found)
 * @returns {Promise<{ownerName: string, ownerEmail: string}>}
 */
export async function resolveDdOwnerForSubmission({
  supabase: client = supabase,
  tenantId,
  formSubmissionId,
  formId = null,
} = {}) {
  const empty = { ownerName: '', ownerEmail: '' };
  if (!client || !tenantId) return empty;
  if (!formSubmissionId && !formId) return empty;

  let ownerName = '';
  let ownerEmail = '';
  let ddFormId = formId || null;

  if (formSubmissionId) {
    try {
      const { data: ddSub } = await client
        .from('form_submission_due_diligence')
        .select('owner_name, owner_member_id, form_id')
        .eq('form_submission_id', formSubmissionId)
        .eq('tenant_id', tenantId)
        .single();

      if (ddSub) {
        ownerName = ddSub.owner_name || '';
        if (!ddFormId) ddFormId = ddSub.form_id || null;
        if (ddSub.owner_member_id) {
          const { data: ownerMbr } = await client
            .from('member')
            .select('email')
            .eq('id', ddSub.owner_member_id)
            .eq('tenant_id', tenantId)
            .single();
          ownerEmail = ownerMbr?.email || '';
        }
      }
    } catch {
      // swallow - leave defaults so placeholders collapse to ''
    }
  }

  if (!ddFormId && formSubmissionId) {
    try {
      const { data: sub } = await client
        .from('form_submission')
        .select('form_id')
        .eq('id', formSubmissionId)
        .eq('tenant_id', tenantId)
        .single();
      ddFormId = sub?.form_id || null;
    } catch {
      // ignore
    }
  }

  if (!ownerName && ddFormId) {
    try {
      const { data: cfg } = await client
        .from('form_due_diligence_config')
        .select('default_owner_name')
        .eq('form_id', ddFormId)
        .eq('tenant_id', tenantId)
        .single();
      ownerName = cfg?.default_owner_name || '';
    } catch {
      // ignore
    }
  }

  return { ownerName: ownerName || '', ownerEmail: ownerEmail || '' };
}

/**
 * Apply {{dd_owner}} / {{dd_owner_email}} (case-insensitive) and
 * [[dd_owner]] replacements to a single text blob. Useful for callers that
 * don't already have a [[...]] placeholder map.
 */
export function applyDdOwnerPlaceholders(text, { ownerName = '', ownerEmail = '' } = {}) {
  if (!text) return text;
  return text
    .replace(/\{\{\s*dd_owner\s*\}\}/gi, ownerName || '')
    .replace(/\{\{\s*dd_owner_email\s*\}\}/gi, ownerEmail || '')
    .replace(new RegExp(escapeRegex('[[dd_owner]]'), 'g'), ownerName || '');
}
