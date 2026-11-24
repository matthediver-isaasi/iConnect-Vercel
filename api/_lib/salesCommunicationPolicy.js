/**
 * The database resolves opportunity ownership from the claimed occurrence,
 * never from browser input or a cached quote. Suppression and its audit are
 * committed together. A lookup/write failure throws and remains retryable.
 */
export async function checkSalesAutomaticDelivery(db, { tenantId, category, id, claim }) {
  const { data, error } = await db.rpc('check_sales_automatic_delivery', {
    p_tenant: tenantId, p_category: category, p_id: id, p_claim: String(claim),
  });
  if (error) throw error;
  if (!['permitted', 'suppressed'].includes(data)) {
    throw new Error('Automatic Sales delivery policy could not be resolved');
  }
  return data;
}
