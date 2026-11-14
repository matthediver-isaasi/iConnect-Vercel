export const messageCategories=['application_confirmation','application_deadline','judge_invitation','judge_invitation_reminder',
  'judging_deadline','incomplete_assessment','moderation_invitation','shortlist','unsuccessful','winner','certificate'];
export const messageKeys=['award.name','round.name','application.reference','outcome.name','deadline','link'];
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy={
  application_confirmation:'Your application {{application.reference}} for {{award.name}} has been received.',
  application_deadline:'The application deadline for {{award.name}} is {{deadline}}.',
  judge_invitation:'You are invited to judge {{award.name}}, {{round.name}}. Open the link to accept or decline.',
  judge_invitation_reminder:'Your invitation to judge {{award.name}} is awaiting a response. Use your invitation email to accept or decline.',
  judging_deadline:'The judging deadline for {{award.name}}, {{round.name}}, is {{deadline}}.',
  incomplete_assessment:'You have incomplete assessments for {{award.name}}, {{round.name}}. The deadline is {{deadline}}.',
  moderation_invitation:'You are invited to review moderation for {{award.name}}, {{round.name}}.',
  shortlist:'An authorised shortlist update is available for {{award.name}}.',
  unsuccessful:'Your released outcome for {{award.name}} is {{outcome.name}}.',
  winner:'Your released outcome for {{award.name}} is {{outcome.name}}.',
  certificate:'Your award certificate for {{award.name}} is available.',
};
export function renderAwardMessage(category,values,template=null){
  if(!messageCategories.includes(category))throw new Error('Unknown award message category');
  const replace=(text,html)=>String(text||'').replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_,key)=>{
    if(!messageKeys.includes(key))throw new Error(`Unsupported awards placeholder: ${key}`);
    const value=values[key]??'';
    return html?escape(value):String(value);
  });
  if(template){
    if(category==='judge_invitation'&&!/\{\{\s*link\s*\}\}/.test(String(template.body||'')))throw new Error('Invitation templates must include {{link}}');
    const subject=replace(template.subject,false).replace(/[\r\n]/g,' ').slice(0,998);
    const html=replace(template.body,true);
    if(!subject.trim()||!html.trim())throw new Error('Email template subject and body are required');
    return{subject,html};
  }
  const text=replace(copy[category],false)+`\n\n${values.link||''}`;
  return{subject:`${category==='application_confirmation'?'Application received':'Awards update'}: ${values['award.name']}`.replace(/[\r\n]/g,' ').slice(0,998),
    text,html:`<p>${escape(replace(copy[category],false))}</p><p><a href="${escape(values.link)}">Open awards</a></p>`};
}
