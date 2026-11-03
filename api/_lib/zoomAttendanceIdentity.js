const emailOf = value => String(value || '').trim().toLowerCase();
const add = (map, key, row) => { if (key) map.set(key, [...(map.get(key) || []), row]); };

export async function fetchZoomAttendanceRegistrants(token, zoomId, zoomType, fetchImpl = fetch) {
  const rows = [];
  let next = '';
  for (let page = 0; page < 20; page++) {
    const url = new URL(`https://api.zoom.us/v2/${zoomType === 'webinar' ? 'webinars' : 'meetings'}/${encodeURIComponent(zoomId)}/registrants`);
    url.searchParams.set('page_size','300');
    url.searchParams.set('status','approved');
    if (next) url.searchParams.set('next_page_token',next);
    const response = await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`}});
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 400 && /registration (has not been|is not) enabled/i.test(body.message || '')) return [];
      throw new Error(`Zoom registration evidence unavailable (HTTP ${response.status})`);
    }
    if (!Array.isArray(body.registrants)) throw new Error('Zoom registration list is incomplete');
    rows.push(...body.registrants.map(r=>({id:r.id,email:emailOf(r.email)})));
    next = body.next_page_token || '';
    if (!next) return rows;
  }
  throw new Error('Zoom registration evidence exceeded page limit');
}

export function createZoomAttendanceMatcher(bookings, registrants) {
  const byEmail=new Map(),byId=new Map(),registrationEmail=new Map(),registrationId=new Map();
  for(const b of bookings) { add(byEmail,emailOf(b.attendee_email),b);add(byId,b.zoom_registrant_id,b); }
  for(const r of registrants) { add(registrationEmail,emailOf(r.email),r);add(registrationId,r.id,r); }
  const candidatesFor = registration => {
    const saved=byId.get(registration.id);
    return saved?.length ? saved : (byEmail.get(emailOf(registration.email)) || [])
      .filter(b=>!b.zoom_registrant_id || b.zoom_registrant_id===registration.id);
  };
  return participant => {
    const email=emailOf(participant.user_email || participant.email);
    const explicit=participant.registrant_id;
    let candidates=[],matchedBy=null,registrantId=null;
    if(explicit) {
      const registrations=registrationId.get(explicit) || [];
      if(registrations.length!==1)return {candidates:[],matchedBy:'registration_conflict',registrantId:null};
      candidates=candidatesFor(registrations[0]);matchedBy='registrant_id';registrantId=explicit;
    } else {
      const registrations=registrationEmail.get(email) || [];
      if(registrations.length===1) {
        candidates=candidatesFor(registrations[0]);matchedBy='registration_email';registrantId=registrations[0].id;
      } else if(registrations.length>1) {
        candidates=[...new Map(registrations.flatMap(candidatesFor).map(b=>[b.id,b])).values()];
        matchedBy='registration_ambiguous';
      } else { candidates=byEmail.get(email)||[];matchedBy='email'; }
    }
    return {candidates:candidates.map(b=>({booking_id:b.id,member_id:b.member_id})),matchedBy,registrantId,
      ambiguous:matchedBy==='registration_ambiguous'};
  };
}
