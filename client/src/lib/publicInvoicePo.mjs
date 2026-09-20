export function isPublicInvoicePoAvailable({ event, isGuestCheckout, remainingBalance, ticket }) {
  const visibility = ticket?.visibility_mode
    || (ticket?.is_public === true ? 'members_and_public' : null);
  const isPublicTicket = visibility === 'members_and_public' || visibility === 'public_only';

  return event?.allow_public_invoice_po === true
    && isGuestCheckout === true
    && Number(remainingBalance) > 0
    && isPublicTicket;
}

export function normalizePublicInvoicePurchaser(info = {}) {
  return {
    first_name: String(info.first_name || '').trim(),
    last_name: String(info.last_name || '').trim(),
    email: String(info.email || '').trim().toLowerCase(),
    organization: String(info.organization || '').trim(),
    phone: String(info.phone || '').trim(),
    job_title: String(info.job_title || '').trim(),
  };
}

export function isPublicInvoicePurchaserComplete(info = {}) {
  const normalized = normalizePublicInvoicePurchaser(info);
  return Boolean(
    normalized.first_name
    && normalized.last_name
    && /\S+@\S+\.\S+/.test(normalized.email)
  );
}