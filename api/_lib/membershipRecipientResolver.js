import { supabase as defaultSupabase } from './database.js';

const DELETED_MAILBOX_PATTERN = /^deleted_.*@deleted\.local$/i;

function normalize(email) {
  return (email || '').trim().toLowerCase();
}

function isValidAddress(email) {
  const e = normalize(email);
  if (!e) return false;
  if (DELETED_MAILBOX_PATTERN.test(e)) return false;
  return true;
}

function readRecipientSpec(tierConfig) {
  if (!tierConfig) return null;

  if (tierConfig.invoice_recipients && typeof tierConfig.invoice_recipients === 'object') {
    const spec = tierConfig.invoice_recipients;
    return {
      invoicing_email: !!spec.invoicing_email,
      primary_contact: !!spec.primary_contact,
      role_ids: Array.isArray(spec.role_ids) ? spec.role_ids.filter(Boolean) : [],
    };
  }

  const legacyField = tierConfig.invoice_email_field_name;
  const legacyRoles = Array.isArray(tierConfig.invoice_recipient_role_ids)
    ? tierConfig.invoice_recipient_role_ids.filter(Boolean)
    : [];
  return {
    invoicing_email: true,
    primary_contact: legacyField !== 'invoicing_email',
    role_ids: legacyRoles,
  };
}

async function fetchInvoicingEmail(client, organizationId) {
  const { data } = await client
    .from('organization')
    .select('invoicing_email')
    .eq('id', organizationId)
    .maybeSingle();
  return data?.invoicing_email || null;
}

async function fetchPrimaryContactEmail(client, organizationId) {
  const { data } = await client
    .from('member')
    .select('email')
    .eq('organization_id', organizationId)
    .eq('is_primary_contact', true)
    .limit(1)
    .maybeSingle();
  return data?.email || null;
}

async function fetchRoleMemberEmails(client, organizationId, roleIds) {
  if (!roleIds.length) return [];
  const { data } = await client
    .from('member')
    .select('email')
    .eq('organization_id', organizationId)
    .in('role_id', roleIds);
  return (data || []).map((m) => m.email).filter(Boolean);
}

/**
 * Resolve the address list for a tier-configured email send.
 *
 * Reads `invoice_recipients` (jsonb { invoicing_email, primary_contact, role_ids })
 * with a legacy fallback to `invoice_email_field_name` + `invoice_recipient_role_ids`
 * so unmigrated tier configs still work.
 *
 * If the configured recipients all resolve to empty/invalid addresses (e.g. the
 * org's invoicing_email is blank, primary contact missing, role memberships
 * empty), the resolver falls back to invoicing email -> primary contact and
 * sets `usedFallback: true` so callers can log a warning.
 *
 * @param {object} args
 * @param {object} [args.client]
 * @param {string} args.tenantId
 * @param {string} args.organizationId
 * @param {object} args.tierConfig
 * @returns {Promise<{ recipients: string[], usedFallback: boolean, spec: object|null }>}
 */
export async function resolveTierRecipients({
  client = defaultSupabase,
  tenantId: _tenantId,
  organizationId,
  tierConfig,
}) {
  if (!client || !organizationId) {
    return { recipients: [], usedFallback: false, spec: null };
  }

  const spec = readRecipientSpec(tierConfig);
  const out = new Set();

  if (spec) {
    if (spec.invoicing_email) {
      const e = await fetchInvoicingEmail(client, organizationId);
      if (isValidAddress(e)) out.add(normalize(e));
    }
    if (spec.primary_contact) {
      const e = await fetchPrimaryContactEmail(client, organizationId);
      if (isValidAddress(e)) out.add(normalize(e));
    }
    if (spec.role_ids.length > 0) {
      const emails = await fetchRoleMemberEmails(client, organizationId, spec.role_ids);
      for (const e of emails) {
        if (isValidAddress(e)) out.add(normalize(e));
      }
    }
  }

  if (out.size > 0) {
    return { recipients: [...out], usedFallback: false, spec };
  }

  // Safety net: tier said something, but nothing resolved to a real address.
  // Fall back to invoicing email -> primary contact so we never silently skip
  // a renewal email.
  const fallback = new Set();
  const inv = await fetchInvoicingEmail(client, organizationId);
  if (isValidAddress(inv)) fallback.add(normalize(inv));
  if (fallback.size === 0) {
    const pc = await fetchPrimaryContactEmail(client, organizationId);
    if (isValidAddress(pc)) fallback.add(normalize(pc));
  }

  return {
    recipients: [...fallback],
    usedFallback: fallback.size > 0,
    spec,
  };
}

/**
 * Validate the saved `invoice_recipients` shape. Returns null when OK or
 * an error string when the config has nothing selected.
 */
export function validateInvoiceRecipientsShape(spec) {
  if (!spec || typeof spec !== 'object') {
    return 'Invoice recipients are required: pick at least one entry.';
  }
  const hasInvoicing = !!spec.invoicing_email;
  const hasPrimary = !!spec.primary_contact;
  const hasRoles = Array.isArray(spec.role_ids) && spec.role_ids.length > 0;
  if (!hasInvoicing && !hasPrimary && !hasRoles) {
    return 'Pick at least one invoice recipient (organisation invoicing email, primary contact, or a role).';
  }
  return null;
}

export function normalizeInvoiceRecipients(spec) {
  if (!spec || typeof spec !== 'object') return null;
  return {
    invoicing_email: !!spec.invoicing_email,
    primary_contact: !!spec.primary_contact,
    role_ids: Array.isArray(spec.role_ids)
      ? [...new Set(spec.role_ids.filter(Boolean))]
      : [],
  };
}
