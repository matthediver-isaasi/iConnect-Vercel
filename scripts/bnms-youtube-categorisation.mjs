import XLSX from 'xlsx';
import { createHash } from 'node:crypto';

export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const INPUT = 'attached_assets/Resources_-_categorising-tagging_YOUTUBE_FINALISED_1789471419015.xlsx';
export const COLLECTION_ADDITIONS = ['Events', 'Working in NM', 'Patient and Carers'];
export const HEADERS = ['Video URL','Title','Brief Description','Date uploaded','Member Only','Collection','Resource Type','Bone','Cardiovascular','Careers','Coding & HRGs','Diagnostics','Educational','Endocrinology','Equipment','Gastro','Haematology','Infection','Lung','Management','Management and Workforce','Molecular Radiotherapy','Neurology','Oncology','Paediatrics','PET and PET-CT','Physics – dosimetry','Physics – imaging science','Physics – radiation protection','Radiopharmaceutical Development','Radiopharmacy','Renal','Therapeutic','Thyroid','Training','Working in NM'];
export const mapping = {
  A: 'target_url: identity only; trimmed exact URL, then YouTube ID; no title fallback',
  B: 'title (validation/reference only)', C: 'description (validation/reference only)',
  D: 'release_date (validation/reference only)', E: 'Yes => is_public false; No => true (reference only)',
  F: 'Collection', G: 'Resource Type: Videos', 'H:AJ': 'X/x => selected Focus Area; blank => no removal',
  writableFields: ['subcategories'], preserved: 'All existing subcategories and tags; every other resource field',
};
const trim = v => String(v ?? '').trim();
const union = (...arrays) => [...new Set(arrays.flat())];
export const checksum = value => createHash('sha256').update(value).digest('hex');

export function youtubeId(raw) {
  let value = trim(raw);
  if (/^(?:(?:www|m)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(value)) value = `https://${value}`;
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean);
    let id;
    if (host === 'youtu.be' && parts.length === 1) id = parts[0];
    else if (['youtube.com','www.youtube.com','m.youtube.com','youtube-nocookie.com','www.youtube-nocookie.com'].includes(host)) {
      if (u.pathname === '/watch' && u.searchParams.getAll('v').length === 1) id = u.searchParams.get('v');
      else if (['live','embed','shorts'].includes(parts[0]) && parts.length === 2) id = parts[1];
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

export function parseDate(raw) {
  const value = trim(raw);
  if (!value) return null;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 60 && raw < 100000) {
    return new Date((raw - 25569) * 86400000).toISOString().slice(0,10);
  }
  let y, m, d;
  let match;
  if ((match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [,y,m,d] = match;
  else if ((match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [,d,m,y] = match;
  else if ((match = value.match(/^(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})$/))) {
    d = match[1]; y = match[3];
    m = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[2].slice(0,3).toLowerCase()) + 1;
  } else return null;
  const date = new Date(Date.UTC(+y, +m - 1, +d));
  return date.getUTCFullYear() === +y && date.getUTCMonth() === +m - 1 && date.getUTCDate() === +d ? date.toISOString().slice(0,10) : null;
}

export function readWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  if (wb.Workbook?.WBProps?.date1904) throw new Error('1904 date system is not supported by this pinned mapping');
  const ws = wb.Sheets.Resources;
  if (!ws || !ws['!ref']) throw new Error('Resources worksheet missing');
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', range: 0 });
  if (JSON.stringify(matrix[0].map(trim)) !== JSON.stringify(HEADERS)) throw new Error('Workbook headers differ from the reviewed mapping');
  return { checksum: checksum(buffer), rows: matrix.slice(1).map((cells,i) => ({
    row: i + 2, cells, hyperlink: ws[`A${i+2}`]?.l?.Target ?? null,
  })) };
}

// Read-only count-checked paging, including servers with a lower response cap.
export async function readAll(client, table, columns) {
  const rows = [], pages = [];
  let total;
  do {
    const { data, error, count } = await client.from(table).select(columns, { count: 'exact' })
      .eq('tenant_id', TENANT_ID).order('id', { ascending: true }).range(rows.length, rows.length + 499);
    if (error) throw new Error(`${table} read failed: ${error.code || 'unknown'}`);
    if (!Array.isArray(data) || !Number.isInteger(count) || (total !== undefined && count !== total)) throw new Error(`${table}: inconsistent pagination count`);
    total = count;
    pages.push(data.length);
    if (!data.length && rows.length < total) throw new Error(`${table}: premature empty page`);
    for (const row of data) {
      if (rows.length && row.id <= rows.at(-1).id) throw new Error(`${table}: repeated/unordered IDs`);
      rows.push(row);
    }
  } while (rows.length < total);
  if (rows.length !== total) throw new Error(`${table}: incomplete coverage`);
  return { rows, pages, total };
}

export function buildReport(workbook, resources, categories) {
  const taxonomy = {};
  for (const name of ['Collection','Resource Type','Focus Area']) {
    const found = categories.filter(c => c.name === name);
    if (found.length !== 1 || !Array.isArray(found[0].subcategories)) throw new Error(`Missing, ambiguous or invalid taxonomy: ${name}`);
    taxonomy[name] = found[0];
  }
  const categoryDefinitions = [{
    id: taxonomy.Collection.id, name: 'Collection', current: taxonomy.Collection.subcategories,
    additions: COLLECTION_ADDITIONS.filter(v => !taxonomy.Collection.subcategories.includes(v)),
    resulting: union(taxonomy.Collection.subcategories, COLLECTION_ADDITIONS),
  }];
  const rows = workbook.rows.map(({row,cells,hyperlink}) => {
    const source = cells.map(trim);
    const result = { row, source, hyperlink, status: 'pending', issues: [], resourceId: null, matchMethod: null, current: null, proposedAdditions: [], resulting: null };
    if (source.every(v => !v)) return {...result,status:'ignored_blank'};
    if (source.every((v,i) => !v || (i === 6 && v === 'Videos'))) return {...result,status:'ignored_type_only'};
    const videoId = youtubeId(source[0]);
    result.videoId = videoId;
    result.referenceMapping = { title:source[1], description:source[2], release_date:parseDate(cells[3]), is_public:source[4].toLowerCase() === 'no' ? true : source[4].toLowerCase() === 'yes' ? false : null };
    if (!videoId) result.issues.push('missing_or_malformed_video_link; no title fallback');
    if (hyperlink && youtubeId(hyperlink) !== videoId) result.issues.push('hyperlink_identity_conflict');
    if (!source[1]) result.issues.push('missing_title');
    if (source[3] && !result.referenceMapping.release_date) result.issues.push('invalid_date');
    if (result.referenceMapping.is_public === null) result.issues.push('invalid_member_only');
    if (source[6] !== 'Videos') result.issues.push('invalid_resource_type');
    const selected = { Collection: source[5] ? [source[5]] : [], 'Resource Type': source[6] ? [source[6]] : [], 'Focus Area': [] };
    for (let i=7; i<HEADERS.length; i++) {
      if (!source[i]) continue;
      if (source[i].toLowerCase() !== 'x') { result.issues.push(`unknown_marker:${HEADERS[i]}:${source[i]}`); continue; }
      selected['Focus Area'].push(HEADERS[i] === 'Management and Workforce' ? 'Management & Workforce' : HEADERS[i]);
    }
    result.sourceClassifications = selected;
    for (const [name, values] of Object.entries(selected)) for (const value of values) {
      if (!taxonomy[name].subcategories.includes(value) && !(name === 'Collection' && COLLECTION_ADDITIONS.includes(value))) result.issues.push(`missing_taxonomy:${name}:${value}`);
    }
    if (videoId) {
      const exact = resources.filter(r => trim(r.target_url) === source[0]);
      const identity = resources.filter(r => youtubeId(r.target_url) === videoId);
      const candidates = union(exact,identity);
      result.candidateIds = candidates.map(r=>r.id);
      if (candidates.length > 1) result.issues.push('ambiguous_database_matches');
      else if (candidates.length === 1) {
        result.resourceId = candidates[0].id;
        result.matchMethod = exact.length ? 'exact_url' : 'youtube_identity';
        result.current = { subcategories: candidates[0].subcategories ?? [], tags: candidates[0].tags ?? [] };
        if (!Array.isArray(result.current.subcategories) || !Array.isArray(result.current.tags)) result.issues.push('invalid_stored_classifications');
      }
    }
    result.status = result.issues.length ? 'blocked' : result.resourceId ? 'matched' : 'unmatched_review';
    return result;
  });
  const proposals = [];
  for (const id of union(rows.filter(r=>r.resourceId).map(r=>r.resourceId))) {
    const sources = rows.filter(r=>r.resourceId === id);
    // Do not propose a partial merge when any source for this resource is invalid.
    if (sources.some(r=>r.status !== 'matched')) {
      for (const r of sources) { r.status = 'blocked'; if (!r.issues.length) r.issues.push('blocked_duplicate_source'); }
      continue;
    }
    const current = sources[0].current;
    const selected = union(sources.flatMap(r=>Object.values(r.sourceClassifications).flat()));
    const additions = selected.filter(v=>!current.subcategories.includes(v));
    const resulting = { subcategories:union(current.subcategories,selected), tags:current.tags };
    const p = { resourceId:id, sourceRows:sources.map(r=>r.row), current, proposedAdditions:additions, resulting, status:additions.length ? 'classification_update' : 'unchanged', proposedPatch:additions.length ? {subcategories:resulting.subcategories} : null };
    proposals.push(p);
    for (const r of sources) Object.assign(r, {status:p.status,proposedAdditions:additions,resulting,consolidatedSourceRows:p.sourceRows});
  }
  const count = status => rows.filter(r=>r.status === status).length;
  return { mode:'READ_ONLY', tenantId:TENANT_ID, inputChecksum:workbook.checksum, mapping, categoryDefinitions, rows, proposals,
    summary: { existingResources:resources.length, resourceRows:rows.filter(r=>!r.status.startsWith('ignored')).length,
      validLinkRows:rows.filter(r=>r.videoId).length, exactMatches:rows.filter(r=>r.matchMethod === 'exact_url').length,
      normalizedMatches:rows.filter(r=>r.matchMethod === 'youtube_identity').length,
      resolvedResources:proposals.length, classificationUpdates:proposals.filter(p=>p.status === 'classification_update').length,
      unchangedResources:proposals.filter(p=>p.status === 'unchanged').length,
      unmatchedRows:count('unmatched_review'), blockedRows:count('blocked'), ignoredBlankRows:count('ignored_blank'),
      ignoredTypeOnlyRows:count('ignored_type_only'), duplicateSourceGroups:proposals.filter(p=>p.sourceRows.length > 1).length,
      categoryDefinitionAdditions:categoryDefinitions.reduce((n,c)=>n+c.additions.length,0), databaseWrites:0 } };
}