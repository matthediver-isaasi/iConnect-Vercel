async function request(url,options={}){
 const response=await fetch(url,{credentials:'include',...options});
 const body=await response.json();
 if(!response.ok)throw Object.assign(new Error(body.error||'Membership-change settings could not be loaded.'),{status:response.status});
 return body;
}
export function loadMemberChangeFormSettings(formId,signal){
 return request(`/api/membership/member-amendments?action=form_change_settings&formId=${encodeURIComponent(formId)}`,{signal});
}
export function saveMemberChangeFormSettings(settings){
 return request('/api/membership/member-amendments',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({...settings,action:'form_change_settings'})});
}
