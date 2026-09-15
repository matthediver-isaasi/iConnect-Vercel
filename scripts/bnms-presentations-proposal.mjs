import XLSX from 'xlsx';
import { checksum, youtubeId, parseDate as fullDate, readAll, TENANT_ID } from './bnms-youtube-categorisation.mjs';
export { checksum, readAll, TENANT_ID };
export const INPUT = 'attached_assets/Resources_-_categorising-tagging_PRESENTATIONS_FINALISED_1789478058638.xlsx';
export const HEADERS = ['Page URL','Menu Item','Resource URL','Title','Brief Description','Date','Member Only','Collection','Resource Type','Artificial Intelligence','Audit','Bone','Cardiovascular','Careers','Case Studies','Coding & HRGs','Diagnostics','Educational','Endocrinology','Equipment','Gastro','Haematology','Infection','Lung','Management and Workforce','Metabolic Studies','Molecular Radiotherapy','Neurology','Non Medical Reporting','Oncology','Paediatrics','PET and PET-CT','Physics – dosimetry','Physics – imaging science','Physics – radiation protection','Radiopharmaceutical Development','Renal','Sentinel Node Imaging','Therapeutic','Thyroid','Training','Working in NM','Highlights'];
const trim = v => String(v ?? '').trim();
export const aliases = {'Management and Workforce':'Management & Workforce','Artificial Intelligence':'Artificial intelligence'};
export function marker(v) { const s=trim(v).toLowerCase(); return s==='yes' ? true : s==='' || s==='no' ? false : null; }
export function dateValue(v) {
  if (!trim(v)) return {value:null,kind:'blank'};
  if (/^\d{4}$/.test(trim(v)) && +v>=1900 && +v<=2100) return {value:`${v}-01-01`,kind:'year_only_requires_approval'};
  const value=fullDate(v);
  return {value,kind:value ? typeof v==='number' ? 'excel_serial' : 'calendar_date' : 'invalid'};
}
export function link(raw) {
  try {
    const u=new URL(trim(raw));
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.port) return {valid:false,identity:null};
    const yt=youtubeId(raw);
    if(yt) return {valid:true,identity:`youtube:${yt}`,kind:'youtube'};
    if(['drive.google.com','drive.usercontent.google.com','docs.google.com'].includes(u.hostname)) {
      const folder=u.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)\/?$/);
      if(folder) return {valid:true,identity:`folder:${folder[1]}`,kind:'shared_folder'};
      const file=u.pathname.match(/^\/(?:file|document|presentation|spreadsheets)\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
      const id=file?.[1] || (['/download','/uc','/open'].includes(u.pathname) && u.searchParams.getAll('id').length===1 ? u.searchParams.get('id') : null);
      if(id && /^[A-Za-z0-9_-]+$/.test(id)) return {valid:true,identity:`drive:${id}`,kind:'drive_file'};
    }
    return {valid:true,identity:null,kind:'other'};
  } catch { return {valid:false,identity:null}; }
}
export function readWorkbook(buffer) {
  const wb=XLSX.read(buffer,{type:'buffer'});
  if(wb.Workbook?.WBProps?.date1904) throw Error('Unsupported 1904 dates');
  const ws=wb.Sheets.Resources;
  if(!ws) throw Error('Resources sheet missing');
  const matrix=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:''});
  const headers=matrix[0].map(trim);
  if(headers.length!==HEADERS.length || new Set(headers).size!==headers.length || HEADERS.some(h=>!headers.includes(h))) throw Error('Unexpected or duplicate headers');
  const rows=matrix.slice(1).map((cells,i)=>({
    row:i+2, source:Object.fromEntries(headers.map((h,j)=>[h,cells[j]??''])),
    hyperlinks:Object.fromEntries(headers.map((h,j)=>[h,ws[XLSX.utils.encode_cell({r:i+1,c:j})]?.l?.Target]).filter(([,v])=>v)),
  })).filter(r=>Object.values(r.source).some(v=>trim(v)));
  return {checksum:checksum(buffer),headers,sheets:wb.SheetNames,rows};
}
export function buildReport(workbook,resources,categories) {
  if([...resources,...categories].some(r=>r.tenant_id!==TENANT_ID)) throw Error('Tenant isolation violation');
  const taxonomy={};
  for(const name of ['Collection','Resource Type','Focus Area']) {
    const found=categories.filter(c=>c.name===name);
    if(found.length!==1 || !Array.isArray(found[0].subcategories)) throw Error(`Invalid taxonomy ${name}`);
    taxonomy[name]=found[0];
  }
  const rows=workbook.rows.map(r=>{
    const s=r.source, url=trim(s['Resource URL']), info=link(url), issues=[];
    const date=dateValue(s.Date), access=trim(s['Member Only']).toLowerCase();
    if(!trim(s.Title)) issues.push('missing_title');
    if(!info.valid) issues.push('invalid_url');
    if(!['yes','no'].includes(access)) issues.push('missing_or_invalid_access');
    if(date.kind==='invalid') issues.push('invalid_date');
    const hyperlink=r.hyperlinks['Resource URL'];
    if(hyperlink && trim(hyperlink)!==url && (!info.identity || link(hyperlink).identity!==info.identity)) issues.push('hyperlink_conflict');
    const selected={'Collection':[trim(s.Collection)].filter(Boolean),'Resource Type':[trim(s['Resource Type'])].filter(Boolean),'Focus Area':[]};
    for(const name of ['Collection','Resource Type']) if(!selected[name].length) issues.push(`missing_classification:${name}`);
    for(const h of HEADERS.slice(9)) {
      const value=marker(s[h]);
      if(value===null) issues.push(`invalid_marker:${h}`);
      if(value) selected['Focus Area'].push(aliases[h]||h);
    }
    for(const [group,values] of Object.entries(selected)) for(const value of values) if(!taxonomy[group].subcategories.includes(value)) issues.push(`missing_taxonomy:${group}:${value}`);
    const exact=resources.filter(e=>trim(e.target_url)===url);
    const identity=info.identity && info.kind!=='shared_folder' ? resources.filter(e=>link(e.target_url).identity===info.identity) : [];
    const candidates=[...new Map([...exact,...identity].map(e=>[e.id,e])).values()];
    if(candidates.length>1) issues.push('multiple_destination_matches');
    if(info.kind==='shared_folder') issues.push('shared_folder_requires_individual_link_review');
    const before=candidates.length===1 ? candidates[0] : null;
    const titleCandidates=!candidates.length ? resources.filter(e=>trim(e.title).toLowerCase()===trim(s.Title).toLowerCase()).map(e=>e.id) : [];
    if(titleCandidates.length) issues.push('title_only_candidate_requires_review');
    if(before && (!Array.isArray(before.subcategories??[]) || !Array.isArray(before.tags??[]))) issues.push('invalid_stored_classifications');
    const additions=Object.values(selected).flat().filter(v=>!(before?.subcategories??[]).includes(v));
    const proposed=before ? {...before} : {tenant_id:TENANT_ID,resource_type:'external_link',open_in_new_tab:true,status:'active',allowed_role_ids:[],tags:[],linked_events:[],folder_id:null};
    Object.assign(proposed,{title:trim(s.Title),target_url:before?.target_url??url,
      description:trim(s['Brief Description']) || before?.description || '',
      release_date:date.value || before?.release_date || null,
      is_public:access==='yes' ? false : access==='no' ? (before?.is_public===false ? false : true) : null,
      subcategories:[...new Set([...(before?.subcategories??[]),...additions])]});
    // The destination returns timestamps; do not propose a change solely for
    // the equivalent date representation used by the workbook.
    if(before?.release_date && proposed.release_date &&
      Date.parse(before.release_date)===Date.parse(proposed.release_date)) proposed.release_date=before.release_date;
    const patch=Object.fromEntries(Object.entries(proposed).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(before?.[k])));
    const coreChanges=before ? Object.keys(patch).filter(k=>!['subcategories'].includes(k)) : [];
    return {...r,url,link:info,date,selected,issues,candidateIds:candidates.map(e=>e.id),titleCandidates,
      matchMethod:exact.length?'exact_url':identity.length?'provider_identity':'none',
      before,proposed,patch,coreChanges,accessChange:!!before && 'is_public' in patch,
      status:issues.length?'blocked':before ? Object.keys(patch).length?'update':'unchanged':'insert'};
  });
  const groups=new Map();
  for(const r of rows) { const key=r.link.identity || r.url; if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(r); }
  const duplicateGroups=[];
  for(const [key,group] of groups) if(group.length>1) {
    const identical=group.every(r=>JSON.stringify(r.source)===JSON.stringify(group[0].source));
    duplicateGroups.push({key,rows:group.map(r=>r.row),kind:group[0].link.kind,identical,
      titles:group.map(r=>({row:r.row,title:r.source.Title})),
      differingFields:HEADERS.filter(h=>new Set(group.map(r=>JSON.stringify(r.source[h]))).size>1)});
    // Even identical duplicates await an explicit keep/skip decision.
    for(const r of group) {r.issues.push(identical?'identical_source_duplicate_review':'conflicting_source_duplicate');r.status='blocked';}
  }
  const summary={sourceRows:rows.length,distinctLiteralUrls:new Set(rows.map(r=>r.source['Resource URL'])).size,destinationResources:resources.length,
    inserts:rows.filter(r=>r.status==='insert').length,updates:rows.filter(r=>r.status==='update').length,unchanged:rows.filter(r=>r.status==='unchanged').length,
    blocked:rows.filter(r=>r.status==='blocked').length,exactMatchRows:rows.filter(r=>r.matchMethod==='exact_url').length,
    identityMatchRows:rows.filter(r=>r.matchMethod==='provider_identity').length,unmatchedRows:rows.filter(r=>r.matchMethod==='none').length,
    coreChangeRows:rows.filter(r=>r.coreChanges.length).length,accessChangeRows:rows.filter(r=>r.accessChange).length,
    yearOnlyRows:rows.filter(r=>r.date.kind==='year_only_requires_approval').length,databaseWrites:0};
  return {mode:'READ_ONLY_APPROVAL_REQUIRED',tenantId:TENANT_ID,inputChecksum:workbook.checksum,summary,duplicateGroups,rows,
    missingTaxonomy:[...new Set(rows.flatMap(r=>r.issues.filter(i=>i.startsWith('missing_taxonomy:'))))]};
}