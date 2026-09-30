import { supabase as sharedSupabase } from './database.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace [[placeholder]] style tokens in a text blob using the provided map.
 * Missing/undefined values collapse to '' so no literal [[token]] leaks out.
 *
 * @param {string} text
 * @param {Record<string,string>} placeholders - keys WITHOUT the surrounding brackets
 * @returns {string}
 */
export function replaceContractBracketPlaceholders(text, placeholders) {
  if (!text) return text;
  let result = text;
  for (const [key, value] of Object.entries(placeholders || {})) {
    const placeholder = `[[${key}]]`;
    result = result.replace(new RegExp(escapeRegex(placeholder), 'g'), value || '');
  }
  return result;
}

async function fetchOrganizationNameById(client, organizationId) {
  if (!organizationId) return '';
  try {
    const { data: org } = await client
      .from('organization')
      .select('name')
      .eq('id', organizationId)
      .single();
    return org?.name || '';
  } catch {
    return '';
  }
}

async function fetchOrganizationNameFromSubmission(client, formSubmissionId) {
  if (!formSubmissionId) return '';
  try {
    const { data: submission } = await client
      .from('form_submission')
      .select('organization_id, created_organization_id')
      .eq('id', formSubmissionId)
      .single();
    const orgId = submission?.organization_id || submission?.created_organization_id;
    return fetchOrganizationNameById(client, orgId);
  } catch {
    return '';
  }
}

async function fetchTenantName(client, tenantId) {
  if (!tenantId) return '';
  try {
    const { data: tenantData } = await client
      .from('tenant')
      .select('name')
      .eq('id', tenantId)
      .single();
    return tenantData?.name || '';
  } catch {
    return '';
  }
}

/**
 * Build the canonical [[...]] bracket-placeholder map shared by EVERY contract
 * send path (DD stage action, resend, send-original, workflow create_contract,
 * and the reminder/timeout crons) so they can't drift.
 *
 * Organization name resolution priority:
 *   1. explicit `organizationName` (when the caller already looked it up)
 *   2. `organizationId` -> organization.name
 *   3. `formSubmissionId` -> form_submission.(organization_id | created_organization_id) -> organization.name
 *
 * Every value is always a string ('' rather than null/undefined) so callers can
 * safely .replace(...) and never leak a literal [[token]] or "undefined".
 *
 * dd_owner is NOT resolved here (that stays with resolveDdOwnerForSubmission);
 * pass the already-resolved `ownerName` so it lands in the map consistently.
 *
 * @param {object} args
 * @param {object} [args.supabase] - Supabase client (defaults to shared one)
 * @param {string} args.tenantId
 * @param {string|null} [args.formSubmissionId]
 * @param {string|null} [args.organizationId]
 * @param {string|null} [args.organizationName] - pre-resolved org name (skips the org lookup)
 * @param {string|null} [args.tenantName] - pre-resolved tenant name (skips the tenant lookup)
 * @param {object} [args.signer] - { name, first_name, last_name, email }
 * @param {string} [args.contractName]
 * @param {string} [args.ownerName] - already-resolved dd_owner display name
 * @returns {Promise<Record<string,string>>}
 */
export async function buildContractBracketPlaceholders({
  supabase: client = sharedSupabase,
  tenantId,
  formSubmissionId = null,
  organizationId = null,
  organizationName = null,
  tenantName = null,
  signer = {},
  contractName = '',
  ownerName = '',
} = {}) {
  let orgName = organizationName;
  if (orgName == null) {
    if (organizationId) {
      orgName = await fetchOrganizationNameById(client, organizationId);
    } else if (formSubmissionId) {
      orgName = await fetchOrganizationNameFromSubmission(client, formSubmissionId);
    } else {
      orgName = '';
    }
  }

  const resolvedTenantName = tenantName != null ? tenantName : await fetchTenantName(client, tenantId);

  const s = signer || {};
  const signerFirstName = s.first_name || (s.name ? s.name.split(' ')[0] : '') || '';
  const signerLastName = s.last_name || (s.name ? s.name.split(' ').slice(1).join(' ') : '') || '';
  const signerFullName = s.name || [signerFirstName, signerLastName].filter(Boolean).join(' ') || '';

  return {
    'organization.name': orgName || '',
    'tenant.name': resolvedTenantName || '',
    'signer.name': signerFullName,
    'signer.first_name': signerFirstName,
    'signer.last_name': signerLastName,
    'signer.email': s.email || '',
    'contract.name': contractName || '',
    'dd_owner': ownerName || '',
  };
}
