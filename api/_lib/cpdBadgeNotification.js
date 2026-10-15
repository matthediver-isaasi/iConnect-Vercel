import {createHash} from 'node:crypto';

// Reuse event CPD email configuration, never a purchaser or a generic member badge.
export async function resolveBadgeNotification(db, identity, resolveCertificate) {
  const result=await resolveCertificate(db,{...identity,emailOnly:true});
  if(!result.available) return result;
  const {data:awards,error}=await db.from('member_badge').select('id,member_id,badge_id')
    .eq('tenant_id',identity.tenantId).eq('booking_id',identity.bookingId)
    .eq('booking_type',identity.bookingSource==='standard'?'booking':'complex_event_booking')
    .eq('event_id',result.event_id).eq('source','event_cpd').is('revoked_at',null).order('id');
  if(error) throw error;
  if(!awards?.length) return {...result,can_send:false,send_reason:'No unrevoked CPD badge awarded for this registration.'};
  const members=[...new Set(awards.map(a=>a.member_id))];
  const {data:member,error:memberError}=members.length===1
    ? await db.from('member').select('email').eq('tenant_id',identity.tenantId).eq('id',members[0]).maybeSingle()
    : {data:null,error:null};
  if(memberError) throw memberError;
  if(!member || String(member.email||'').trim().toLowerCase()!==String(result.recipient).trim().toLowerCase()){
    return {...result,can_send:false,send_reason:'The badge owner no longer matches the attendee email.'};
  }
  // The certificate default explicitly promises a PDF attachment, so it cannot
  // be silently reused as a badge-only notification.
  if(!result.email_template_id) return {...result,can_send:false,
    send_reason:'Select an email template in the event CPD configuration before sending a badge-only notification.'};
  return {...result,fingerprint:createHash('sha256').update(JSON.stringify([result.fingerprint,awards])).digest('hex')};
}
