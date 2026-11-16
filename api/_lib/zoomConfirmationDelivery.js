// Claims intentionally do not expire: the mail provider cannot atomically commit
// with our database. An interrupted send is uncertain, not permission to resend.
export function validZoomConfirmationOperation(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function deliverZoomConfirmation(db, identity, send) {
  const { tenantId, scope, resourceId, operationId, bookingId, target } = identity;
  const key = {
    tenant_id: tenantId, scope, resource_id: resourceId,
    operation_id: operationId, booking_id: bookingId,
  };
  const match = query => Object.entries(key).reduce((q, [k, v]) => q.eq(k, v), query);
  const { error: claimError } = await db.from('zoom_confirmation_delivery')
    .insert({ ...key, target, state: 'claimed' });
  if (claimError) {
    if (claimError.code !== '23505') throw new Error('Confirmation delivery claim could not be saved; no email sent');
    const { data, error } = await match(db.from('zoom_confirmation_delivery').select('target,state,results')).single();
    if (error || !data) throw new Error('Confirmation delivery status could not be verified; no email sent');
    if (data.target !== target) throw new Error('Confirmation operation was already used for a different Zoom target');
    if (data.state === 'completed') return data.results;
    throw new Error('Confirmation is in progress or its delivery is uncertain; not resent. Verify delivery before explicitly starting a new resend.');
  }

  // Never release a claim after a throw, partial delivery or an uncertain provider
  // response. A separate, explicitly consented operation may send again.
  const results = await send();
  if (!Array.isArray(results) || results.length === 0 || results.some(r => !r.success)) {
    throw new Error('Confirmation delivery was not fully confirmed; not automatically resent. Check email configuration and delivery before starting a new resend.');
  }
  const { data, error } = await match(db.from('zoom_confirmation_delivery')
    .update({ state: 'completed', results: results.map(r => ({ success: r.success })), completed_at: new Date().toISOString() }))
    .eq('state', 'claimed').select('booking_id').single();
  if (error || !data) throw new Error('Confirmation may have been sent but delivery could not be recorded; not automatically resent');
  return results;
}
