// Corrections are append-only server authority, not attendee email guesses.
export async function loadPublicPoBooker(db, tenantId, source, booking) {
 const originalBooker = booking.purchaser_context?.details;
 const {data:correction,error} = await db.from('public_po_booker_correction').select('*')
  .eq('tenant_id',tenantId).eq('source',source).eq('booking_group_reference',booking.booking_group_reference).maybeSingle();
 if(error)throw Object.assign(Error('Unable to verify booking contact corrections.'),{status:503});
 if(correction && (correction.event_id!==booking.event_id
   || !sameJson(correction.original_context,booking.purchaser_context))) {
  throw Object.assign(Error('The booking contact correction needs review.'),{status:409});
 }
 return {originalBooker,booker:correction?.corrected_details||originalBooker,correction};
}
function sameJson(a,b){
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 const keys=Object.keys(a);
 return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&sameJson(a[k],b[k]));
}
