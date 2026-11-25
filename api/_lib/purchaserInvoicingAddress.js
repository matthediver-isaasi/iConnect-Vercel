import { INVOICING_ADDRESS_KEYS, invoicingAddressError } from '../../shared/publicInvoicePoAddress.js';

// Copies the invoice address a non-member entered at Invoice / PO checkout onto
// their member record's core invoicing fields (private storage). Fill-only: an
// address already saved on the member is never overwritten. The booking's
// frozen purchaser evidence remains the invoice authority either way.
// Never throws: the booking is already committed when this runs.
export async function savePurchaserInvoicingAddress({ db, tenantId, memberId, details, logger = console }) {
  if (!db || !tenantId || !memberId || !details || typeof details !== 'object') return { state: 'not_applicable' };
  const address = Object.fromEntries(INVOICING_ADDRESS_KEYS.map(key => [
    key, typeof details[key] === 'string' && details[key].trim() ? details[key].trim() : null,
  ]));
  if (!address.invoicing_address_line1 || invoicingAddressError(address)) return { state: 'no_address' };
  try {
    const inserted = await db.from('invoicing_address_private')
      .insert({ tenant_id: tenantId, owner_type: 'member', owner_id: memberId, ...address });
    if (!inserted.error) return { state: 'saved' };
    if (inserted.error.code !== '23505') throw inserted.error;
    const existing = await db.from('invoicing_address_private').select(INVOICING_ADDRESS_KEYS.join(','))
      .eq('tenant_id', tenantId).eq('owner_type', 'member').eq('owner_id', memberId).maybeSingle();
    if (existing.error) throw existing.error;
    if (INVOICING_ADDRESS_KEYS.some(key => typeof existing.data?.[key] === 'string' && existing.data[key].trim())) {
      return { state: 'kept_existing' };
    }
    const patched = await db.rpc('patch_private_invoicing_address', {
      p_tenant_id: tenantId, p_owner_type: 'member', p_owner_id: memberId, p_address: address,
    });
    if (patched.error) throw patched.error;
    return { state: 'saved' };
  } catch (error) {
    logger?.error?.('[PurchaserInvoicingAddress] Could not save invoice address to member record:', error?.code || error?.message);
    return { state: 'retryable' };
  }
}

// Finds the member record provisioning created for the purchaser of a public
// ticket purchase. Provisioning only ever creates new people.
export async function purchaserMemberId(db, purchaseId) {
  let result;
  try {
    result = await db.from('public_ticket_member_link').select('member_id,participation')
      .eq('purchase_id', purchaseId).limit(102);
  } catch { return null; }
  if (result.error || !Array.isArray(result.data)) return null;
  const rows = result.data.filter(row => Array.isArray(row.participation)
    && row.participation.some(link => link?.kind === 'purchaser'));
  return rows.length === 1 ? rows[0].member_id : null;
}
