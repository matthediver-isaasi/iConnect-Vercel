import { randomBytes } from 'node:crypto';

// Separate document, deliberately outside the SPA, tenant analytics, router and
// administrator shell. The bearer is a URL fragment, never a request URL.
export default function handler(req,res) {
  if(req.method!=='GET') return res.status(405).end();
  const nonce=randomBytes(18).toString('base64');
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  res.setHeader('Content-Type','text/html; charset=utf-8');
  return res.status(200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Form submission</title><style nonce="${nonce}">body{font:16px/1.6 system-ui,sans-serif;background:#f1f5f9;color:#172b46;margin:0}main{max-width:800px;margin:40px auto;padding:32px;background:white;border-top:4px solid #31598a}h1{font-size:26px}section{border-top:1px solid #dde4ed;padding:16px 0}h2{font-size:17px;margin:0 0 8px}p{white-space:pre-wrap;overflow-wrap:anywhere}.nested{padding-left:20px}small{color:#52627a}@media(max-width:600px){main{margin:12px;padding:20px}}</style></head><body><main><h1 id="title">Form submission</h1><p id="state" role="status">Loading response…</p><div id="answers"></div><small>Read-only · Confidential link</small></main><script nonce="${nonce}">
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
function add(parent,tag,text){const el=document.createElement(tag);el.textContent=text;parent.appendChild(el);return el}
function render(nodes,parent){for(const node of nodes||[]){const box=document.createElement('section');parent.appendChild(box);add(box,'h2',node.label);if(node.children){const nest=document.createElement('div');nest.className='nested';box.appendChild(nest);render(node.children,nest)}else if(node.rows){node.rows.forEach((row,i)=>{add(box,'h3','Row '+(i+1));render(row,box)})}else if(node.attachment){const button=add(box,'button','Download '+node.attachment.name);button.type='button';button.onclick=async()=>{button.disabled=true;try{const r=await fetch('/api/public/form-alert-response?attachment='+encodeURIComponent(node.attachment.id),{headers:{'X-Form-Alert-Token':token},credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});if(!r.ok)throw Error();const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download=node.attachment.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}catch{add(box,'p','This attachment is unavailable.')}finally{button.disabled=false}}}else add(box,'p',node.value||'Not provided')}}
(async()=>{try{if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error();const r=await fetch('/api/public/form-alert-response',{headers:{'X-Form-Alert-Token':token},credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});if(!r.ok)throw Error();const data=await r.json();document.getElementById('title').textContent=data.form_name;document.getElementById('state').textContent=data.anonymous?'Submitted '+data.submitted_at+' · Anonymous response':'Submitted '+new Date(data.submitted_at).toLocaleString('en-GB',{timeZone:'UTC',timeZoneName:'short'});render(data.answers,document.getElementById('answers'))}catch{document.getElementById('state').textContent='This response is unavailable or the link has expired.'}})();
</script></body></html>`);
}
