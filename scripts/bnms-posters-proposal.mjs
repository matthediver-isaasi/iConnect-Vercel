import XLSX from 'xlsx';
import { createHash } from 'node:crypto';

export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const INPUT = 'attached_assets/Resources_-_categorising-tagging_POSTERS_FINALISED_1789479638626.xlsx';
export const HEADERS = ['Page URL','Menu Item','Resource URL','Title','Brief Description','Date','Member Only','Collection','Resource Type','Artificial intelligence','Bone','Cardiovascular','Careers','Coding & HRGs','Diagnostics','Educational','Endocrinology','Equipment','Gastro','Haematology','Infection','Lung','Management','Management and Workforce','Molecular Radiotherapy','Neurology','Oncology','Paediatrics','PET and PET-CT','Physics – dosimetry','Physics – imaging science','Physics – radiation protection','Radiopharmaceutical Development','Radiopharmacy','Renal','Therapeutic','Thyroid','Training','Working in NM'];
export const checksum = value => createHash('sha256').update(value).digest('hex');
const trim = v => String(v ?? '').trim();
const unique = a => [...new Set(a)];

export function driveId(raw, kind = 'file') {
  try {
    const u = new URL(trim(raw));
    if (!['https:','http:'].includes(u.protocol) || u.hostname !== 'drive.google.com' || u.username || u.password || u.port) return null;
    let id;
    if (kind === 'folder') id = u.pathname.match(/^\/drive\/folders\/([A-Za-z0-9_-]+)\/?$/)?.[1];
    else {
      id = u.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)(?:\/(?:view|preview|edit))?\/?$/)?.[1];
      if (!id && ['/open','/uc'].includes(u.pathname) && u.searchParams.getAll('id').length === 1) id = u.searchParams.get('id');
    }
    return /^[A-Za-z0-9_-]{10,}$/.test(id || '') ? id : null;
  } catch { return null; }
}

export function yearDate(value) {
  const s = trim(value);
  return /^(201[6-9]|202[0-5])$/.test(s) ? `${s}-01-01` : null;
}

export function readWorkbook(buffer) {
  const wb = XLSX.read(buffer, {type:'buffer',cellFormula:true});
  if (wb.Workbook?.WBProps?.date1904) throw Error('Unexpected 1904 date system');
  const ws = wb.Sheets.Resources;
  if (!ws?.['!ref']) throw Error('Missing Resources sheet');
  const matrix = XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:'',range:0});
  if (JSON.stringify(matrix[0]) !== JSON.stringify(HEADERS)) throw Error('Workbook headers changed');
  const rows = matrix.slice(1).map((cells,i) => {
    const source = Object.fromEntries(HEADERS.map((h,j)=>[h,cells[j] ?? '']));
    const links = [], formulas = [];
    for (let j=0;j<HEADERS.length;j++) {
      const address = XLSX.utils.encode_cell({r:i+1,c:j}), cell = ws[address];
      if (cell?.l) links.push({address,header:HEADERS[j],literal:cell.v,target:cell.l.Target,tooltip:cell.l.Tooltip ?? null});
      if (cell?.f) formulas.push({address,formula:cell.f});
    }
    return {row:i+2,source,links,formulas};
  }).filter(r=>Object.values(r.source).some(v=>trim(v)));
  return {checksum:checksum(buffer),headers:matrix[0],sheets:wb.SheetNames.map(name=>({name,range:wb.Sheets[name]['!ref'],handling:name==='Resources'?'resource records':'reference only; not imported'})),rows};
}

// Advance by actual page length, never assume the server honoured the requested size.
export async function readAll(client, table, columns) {
  const rows = [], pages = [];
  let total;
  do {
    const {data,error,count} = await client.from(table).select(columns,{count:'exact'})
      .eq('tenant_id',TENANT_ID).order('id',{ascending:true}).range(rows.length,rows.length+499);
    if (error) throw Error(`${table}: read failed (${error.code || 'unknown'})`);
    if (!Array.isArray(data) || !Number.isInteger(count) || (total !== undefined && count !== total)) throw Error(`${table}: unstable count`);
    total = count; pages.push(data.length);
    if (!data.length && rows.length < total) throw Error(`${table}: premature empty page`);
    for (const r of data) {
      if (r.tenant_id !== TENANT_ID) throw Error('Tenant isolation failure');
      if (rows.length && r.id <= rows.at(-1).id) throw Error('Unordered/repeated IDs');
      rows.push(r);
    }
  } while (rows.length < total);
  if (rows.length !== total) throw Error('Incomplete coverage');
  return {rows,pages,total};
}

export function buildReport(workbook, resources, categories) {
  if ([...resources,...categories].some(r=>r.tenant_id!==TENANT_ID)) throw Error('Tenant isolation failure');
  const rows = workbook.rows.map(sourceRow=>{
    const {source:s} = sourceRow, issues = [], notes = [];
    const url = s['Resource URL'], id = driveId(url);
    if (!id) issues.push('invalid_resource_file_url');
    if (!trim(s.Title)) issues.push('missing_title');
    if (trim(s['Member Only']).toLowerCase() !== 'yes') issues.push('member_only_must_be_yes');
    const date = yearDate(s.Date);
    if (!date) issues.push('not_a_2016_2025_calendar_year');
    if (trim(s.Collection) !== 'Events' || trim(s['Resource Type']) !== 'Posters') issues.push('unexpected_collection_or_resource_type');
    if (sourceRow.formulas.length) issues.push('formula_requires_review');
    for (const link of sourceRow.links) {
      const kind = link.header === 'Page URL' ? 'folder' : 'file';
      if (!['Page URL','Resource URL'].includes(link.header)) { issues.push(`unexpected_hyperlink:${link.address}`); continue; }
      if (link.literal !== link.target) {
        if (!driveId(link.literal,kind) || driveId(link.literal,kind) !== driveId(link.target,kind)) issues.push(`hyperlink_identity_conflict:${link.address}`);
        else notes.push(`hyperlink_variant_same_${kind}:${link.address}`);
      }
    }
    const selected = {Collection:[trim(s.Collection)],'Resource Type':[trim(s['Resource Type'])],'Focus Area':[]};
    for (const h of HEADERS.slice(9)) {
      const marker = trim(s[h]);
      if (!marker) continue;
      if (marker.toLowerCase() !== 'x') {issues.push(`unknown_marker:${h}:${marker}`);continue;}
      selected['Focus Area'].push(h === 'Management and Workforce' ? 'Management & Workforce' : h);
    }
    const taxonomy = [];
    for (const [category,values] of Object.entries(selected)) for (const value of values) {
      if (categories.filter(c=>c.name===category).length !== 1) issues.push(`ambiguous_or_missing_category:${category}`);
      const matches = categories.filter(c=>c.name===category && Array.isArray(c.subcategories) && c.subcategories.includes(value));
      taxonomy.push({category,value,categoryIds:matches.map(c=>c.id)});
      if (matches.length !== 1) issues.push(`missing_or_ambiguous_taxonomy:${category}:${value}`);
      else if (matches[0].subcategories.filter(v=>v===value).length !== 1) issues.push(`duplicate_taxonomy_value:${category}:${value}`);
    }
    const exact = resources.filter(r=>r.target_url === url);
    const identity = id ? resources.filter(r=>driveId(r.target_url)===id) : [];
    const candidates = unique([...exact,...identity]);
    let before = null, method = null;
    if (candidates.length > 1) issues.push('ambiguous_database_matches');
    else if (candidates.length === 1) {before=candidates[0];method=exact.length?'exact_url':'drive_identity';}
    // Title coincidences are evidence for review, never update identities.
    const titleOnly = resources.filter(r=>trim(r.title)===trim(s.Title) && !candidates.includes(r)).map(r=>r.id);
    if (titleOnly.length) notes.push('same_title_other_urls_not_used_for_matching');
    for (const field of ['subcategories','tags','allowed_role_ids']) if (before?.[field] != null && !Array.isArray(before[field])) issues.push(`invalid_existing_array:${field}`);
    const proposed = {
      ...(before || {tenant_id:TENANT_ID,status:'active',resource_type:'download',allowed_role_ids:[],tags:[],open_in_new_tab:true}),
      title:s.Title,description:s['Brief Description'],target_url:url,release_date:date,is_public:false,
      subcategories:unique([...(Array.isArray(before?.subcategories)?before.subcategories:[]),...Object.values(selected).flat()]),
    };
    const changes = {};
    for (const key of ['title','description','target_url','release_date','is_public','subcategories']) {
      const old = before?.[key];
      const equivalent = key === 'release_date' && old && date ? old.slice(0,10)===date : JSON.stringify(old)===JSON.stringify(proposed[key]);
      if (!before || !equivalent) changes[key]={before:old ?? null,proposed:proposed[key]};
      else if (key === 'release_date') proposed[key] = old;
    }
    const decisions = ['Approve January 1 as a year-only convention, not a known event date.',
      'Retain Page URL and Menu Item as audit context only; no navigation, folder, tag or collection creation.'];
    if (!id) decisions.push('Confirm the intended Resource URL and approve a correction separately; literal malformed URL is retained here, not silently repaired.');
    if (issues.length) decisions.push('Resolve all blocking issues before this row can be included in execution.');
    if (!before) decisions.push('Approve new active member-only Download resource pointing to the original Drive URL; no rehosting.');
    if (changes.is_public && before) decisions.push('Approve changing existing public/unspecified access to member-only; existing role restrictions retained.');
    if (before && Object.keys(changes).some(k=>!['is_public','subcategories'].includes(k))) decisions.push('Approve the listed metadata changes, including blank descriptions if shown.');
    if (before && before.resource_type !== 'download') decisions.push(`Existing display type ${before.resource_type} is preserved. Download is an optional separate decision, NOT in this proposal.`);
    return {...sourceRow,driveFileId:id,issues,notes,taxonomy,candidateIds:candidates.map(r=>r.id),candidateBefore:candidates,
      titleOnlyCandidateIds:titleOnly,matchMethod:method,before,proposed,changes,decisions,
      status:issues.length?'blocked':before?(Object.keys(changes).length?'update':'unchanged'):'insert'};
  });
  for (const row of rows) {
    const peers = rows.filter(r=>r!==row && ((row.driveFileId && r.driveFileId===row.driveFileId) || (row.before && r.before?.id===row.before.id)));
    if (peers.length) {row.issues.push(`duplicate_source_identity:rows_${peers.map(r=>r.row).join('_')}`);row.status='blocked';}
  }
  const summary = {sourceRows:rows.length,distinctLiteralUrls:unique(rows.map(r=>r.source['Resource URL'])).length,
    distinctTitles:unique(rows.map(r=>r.source.Title)).length,existingResources:resources.length,
    exactMatches:rows.filter(r=>r.matchMethod==='exact_url').length,driveIdentityMatches:rows.filter(r=>r.matchMethod==='drive_identity').length,
    ambiguousMatches:rows.filter(r=>r.candidateIds.length>1).length,unmatchedRows:rows.filter(r=>!r.candidateIds.length).length,
    ...Object.fromEntries(['insert','update','unchanged','blocked'].map(s=>[s,rows.filter(r=>r.status===s).length])),
    accessChanges:rows.filter(r=>r.before && r.changes.is_public).length,
    nonBlockedAccessChanges:rows.filter(r=>r.status!=='blocked' && r.before && r.changes.is_public).length,
    titleChanges:rows.filter(r=>r.before && r.changes.title).length,
    taxonomyIssues:rows.filter(r=>r.issues.some(i=>i.includes('taxonomy'))).length,
    titleOnlyCoincidenceRows:rows.filter(r=>r.titleOnlyCandidateIds.length).length,
    preservedNonDownloadTypes:rows.filter(r=>r.before && r.before.resource_type!=='download').length,
    hyperlinkConflicts:rows.filter(r=>r.issues.some(i=>i.startsWith('hyperlink_identity_conflict'))).length,databaseWrites:0};
  return {mode:'READ_ONLY_APPROVAL_REQUIRED',tenantId:TENANT_ID,inputChecksum:workbook.checksum,sheets:workbook.sheets,summary,rows};
}