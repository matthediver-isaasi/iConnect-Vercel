/** Pre-provider check, not a new refund authority. The DB trigger is a second
 * barrier; it alone would be too late if a legacy provider refund ran first. */
export async function assertLegacyFunnelReversalAllowed({db,tenantId,source,bookingIds}) {
  if(!tenantId||!['booking','complex_event_booking'].includes(source)
    ||!Array.isArray(bookingIds)||!bookingIds.length||bookingIds.some(id=>typeof id!=='string'||!id)) {
    throw new Error('A valid booking scope is required');
  }
  for(let start=0;start<bookingIds.length;start+=1000) {
    const result=await db.rpc('event_funnel_legacy_reversal_allowed',{
      p_tenant:tenantId,p_source:source,p_ids:bookingIds.slice(start,start+1000),
    });
    // Schema is staged. Only an explicit missing function is legacy-compatible,
    // never network failures, permission failures or an empty/null response.
    if(['42883','PGRST202'].includes(result.error?.code)) return;
    if(result.error||typeof result.data!=='boolean') {
      throw Object.assign(new Error('Shared checkout ownership could not be checked. No reversal was started.'),{code:'FUNNEL_REVERSAL_UNAVAILABLE'});
    }
    if(!result.data) throw Object.assign(new Error(
      'This booking belongs to a shared checkout and requires an allocation-aware cancellation. No reversal was started.'),
    {code:'FUNNEL_REVERSAL_REQUIRED'});
  }
}
