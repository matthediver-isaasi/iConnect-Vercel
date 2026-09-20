import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';

export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const DESTINATION_PROJECT = 'lvmzliemqnieeoruhkik';
export const DESTINATION_URL = `https://${DESTINATION_PROJECT}.supabase.co`;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) => String(value ?? '').trim();

function normalizedSourceDate(value) {
  const raw = text(value);
  if (!raw) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 1000) {
    if (Number.isInteger(value) && value >= 1900 && value <= 2100) return `${value}-01-01`;
    const date = new Date((value - 25569) * 86400000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  if (/^\d{4}$/.test(raw)) return `${raw}-01-01`;
  let match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (match) {
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    return `${year}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
  }
  match = raw.match(/^(\d{1,2})[- ]([A-Za-z]{3,4})[- ](\d{2}|\d{4})$/);
  if (match) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      .indexOf(match[2].slice(0, 3).toLowerCase()) + 1;
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    if (month) return `${year}-${String(month).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

export const SOURCES = Object.freeze([
  ['attached_assets/BNMSResourcesClean_1779888089327.csv', 'new resources', null],
  ['attached_assets/bnms-resources2_1780477749303.csv', 'new resources', null],
  ['attached_assets/bnms-resources3_1780478750493.csv', 'new resources; corrected batch', null],
  ['attached_assets/BNMS-batch3-correct_1780479260692.csv', 'corrected video resource import', null],
  ['attached_assets/Resources_-_categorising-tagging_YOUTUBE_FINALISED_1789471419015.xlsx', 'categorisation-only', null],
  ['attached_assets/Resources_-_categorising-tagging_PRESENTATIONS_FINALISED_1789478058638.xlsx', 'new resources and metadata', 'reports/bnms-presentations'],
  ['attached_assets/Resources_-_categorising-tagging_POSTERS_FINALISED_1789479638626.xlsx', 'new resources and metadata', 'reports/bnms-posters'],
  ['attached_assets/Resources_-_categorising-tagging_FINALISED_1789486104337.xlsx', 'new resources and metadata', 'reports/bnms-final-resources'],
  ['attached_assets/Resources_-_categorising-tagging_2026_PRESENTATIONS_AND_POSTE_1789489599381.xlsx', 'new resources and metadata; overlapping revision', 'reports/bnms-spring-2026-resources'],
  ['attached_assets/Spring_Meeting_2026_resources_1782996382352.xlsx', 'new Spring 2026 resources', null],
].map(([path, intent, evidenceRoot]) => ({ path, intent, evidenceRoot })));

export function resourceIdentity(raw) {
  const literal = text(raw).replaceAll('&amp;', '&');
  try {
    const url = new URL(literal);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
      return { valid: false, identity: null, kind: 'invalid' };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);
    let id = null;
    if (host === 'youtu.be' && parts.length === 1) id = parts[0];
    if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1) id = url.searchParams.get('v');
      else if (['live', 'embed', 'shorts'].includes(parts[0]) && parts.length === 2) id = parts[1];
    }
    if (/^[A-Za-z0-9_-]{11}$/.test(id || '')) return { valid: true, identity: `youtube:${id}`, kind: 'youtube' };
    if (['drive.google.com', 'drive.usercontent.google.com', 'docs.google.com'].includes(host)) {
      const folder = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)\/?$/);
      if (folder) return { valid: true, identity: `folder:${folder[1]}`, kind: 'shared_folder' };
      const file = url.pathname.match(/^\/(?:file|document|presentation|spreadsheets)\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
      const driveId = file?.[1] || (['/download', '/open', '/uc'].includes(url.pathname)
        && url.searchParams.getAll('id').length === 1 ? url.searchParams.get('id') : null);
      if (/^[A-Za-z0-9_-]+$/.test(driveId || '')) return { valid: true, identity: `drive:${driveId}`, kind: 'drive_file' };
    }
    url.hash = '';
    return { valid: true, identity: `url:${url.toString()}`, kind: 'url' };
  } catch {
    return { valid: false, identity: null, kind: 'invalid' };
  }
}

function rowFromObject(source, row, sheet, links = [], formulas = []) {
  const urlHeader = Object.keys(source).find((key) => ['resource url', 'video url'].includes(text(key).toLowerCase()));
  return {
    row,
    sheet,
    source,
    title: text(source.Title),
    sourceUrl: text(source[urlHeader] || ''),
    memberOnly: text(source['Member Only']),
    collection: text(source.Collection),
    resourceType: text(source['Resource Type']),
    hyperlinks: links,
    formulas,
  };
}

export function decodeCsvBytes(bytes) {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''),
      encoding: hasBom ? 'UTF-8 BOM (strictly validated)' : 'UTF-8 (strictly validated)',
    };
  } catch {
    return {
      text: new TextDecoder('windows-1252', { fatal: true }).decode(bytes),
      encoding: 'Windows-1252 (UTF-8 validation failed)',
    };
  }
}

export function readSource(source) {
  const bytes = readFileSync(source.path);
  const inventory = {
    path: source.path,
    checksum: sha256(bytes),
    byteLength: bytes.length,
    intent: source.intent,
    evidenceRoot: source.evidenceRoot,
    sheets: [],
  };
  let rows = [];
  if (source.path.endsWith('.csv')) {
    const decoded = decodeCsvBytes(bytes);
    const raw = decoded.text;
    const delimiter = raw.split(/\r?\n/, 1)[0].includes(';') ? ';' : ',';
    const records = parse(raw, { columns: true, delimiter, skip_empty_lines: true, relax_column_count: true });
    rows = records.map((record, index) => rowFromObject(record, index + 2, 'CSV'))
      .filter((row) => Object.values(row.source).some((value) => text(value)));
    inventory.sheets.push({
      name: 'CSV',
      populatedResourceRows: rows.length,
      rawParsedDataRecords: records.length,
      delimiter,
      encoding: decoded.encoding,
    });
  } else {
    const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: true });
    for (const sheet of workbook.SheetNames) {
      const ws = workbook.Sheets[sheet];
      const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      const headers = (matrix[0] || []).map(text);
      const urlColumn = headers.findIndex((header) => ['resource url', 'video url'].includes(header.toLowerCase()));
      const titleColumn = headers.findIndex((header) => header.toLowerCase() === 'title');
      const isResourceSheet = urlColumn >= 0 && titleColumn >= 0;
      const sheetRows = isResourceSheet ? matrix.slice(1).map((cells, index) => {
        const object = Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? '']));
        const links = headers.map((header, column) => {
          const cell = ws[XLSX.utils.encode_cell({ r: index + 1, c: column })];
          return cell?.l ? { cell: cell.v ?? '', header, target: cell.l.Target ?? '' } : null;
        }).filter(Boolean);
        const formulas = headers.map((header, column) => {
          const cell = ws[XLSX.utils.encode_cell({ r: index + 1, c: column })];
          return cell?.f ? { header, formula: cell.f } : null;
        }).filter(Boolean);
        return rowFromObject(object, index + 2, sheet, links, formulas);
      }).filter((row) => Object.values(row.source).some((value) => text(value))) : [];
      inventory.sheets.push({
        name: sheet,
        range: ws['!ref'] || null,
        handling: isResourceSheet ? 'resource rows' : 'reference only',
        populatedResourceRows: sheetRows.length,
      });
      rows.push(...sheetRows);
    }
  }
  inventory.populatedResourceRows = rows.length;
  return { inventory, rows: rows.map((row) => ({ ...row, sourceFile: source.path })) };
}

export function reconcileRows(sourceRows, resources, historicalByFile = new Map()) {
  const byExact = new Map();
  const byIdentity = new Map();
  const byTitle = new Map();
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const add = (map, key, value) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const resource of resources) {
    add(byExact, text(resource.target_url), resource);
    add(byIdentity, resourceIdentity(resource.target_url).identity, resource);
    add(byTitle, text(resource.title).toLowerCase(), resource);
  }
  return sourceRows.map((row) => {
    const parsed = resourceIdentity(row.sourceUrl);
    const exact = byExact.get(row.sourceUrl) || [];
    const identityCandidates = [...new Map([...exact, ...(parsed.identity ? byIdentity.get(parsed.identity) || [] : [])]
      .map((candidate) => [candidate.id, candidate])).values()];
    const titleCandidates = byTitle.get(row.title.toLowerCase()) || [];
    const history = historicalByFile.get(row.sourceFile)?.get(row.row) || null;
    const executedCurrent = history?.executedId ? byId.get(history.executedId) || null : null;
    // A durable row/id execution join is stronger identity evidence than a
    // mutable URL. It also disambiguates duplicate current URL identities.
    const candidates = executedCurrent ? [executedCurrent] : identityCandidates;
    const desiredPublic = /^yes$/i.test(row.memberOnly) ? false : /^no$/i.test(row.memberOnly) ? true : null;
    const description = text(row.source['Brief Description']);
    const sourceDateRaw = row.source.Date ?? row.source['Date uploaded'];
    const date = normalizedSourceDate(sourceDateRaw);
    const resourceIndex = Object.keys(row.source).findIndex((key) => key === 'Resource Type');
    const topicHeaders = Object.keys(row.source).slice(resourceIndex + 1);
    const selectedTopics = topicHeaders.filter((header) => /^(yes|x)$/i.test(text(row.source[header])))
      .map((header) => header === 'Management and Workforce' ? 'Management & Workforce' : header);
    const hyperlinkConflicts = row.hyperlinks.filter((hyperlink) => {
      if (!['Resource URL', 'Video URL'].includes(hyperlink.header)) return false;
      const literal = resourceIdentity(hyperlink.cell);
      const target = resourceIdentity(hyperlink.target);
      return text(hyperlink.cell) !== text(hyperlink.target)
        && (!literal.identity || literal.identity !== target.identity);
    });
    const issues = [];
    if (!row.title) issues.push('missing_title');
    if (!parsed.valid) issues.push('invalid_url');
    if (row.memberOnly && desiredPublic === null) issues.push('invalid_access_marker');
    const unresolvedIssues = [];
    if (hyperlinkConflicts.length) unresolvedIssues.push('hyperlink_conflict_unresolved');
    if (row.formulas.length) unresolvedIssues.push('formula_requires_review');
    if (parsed.kind === 'shared_folder') unresolvedIssues.push('shared_folder_unresolved');
    issues.push(...unresolvedIssues);
    const matched = candidates.length === 1 ? candidates[0] : null;
    const mismatchFields = {};
    if (matched) {
      if (row.title && text(matched.title) !== row.title) mismatchFields.title = { source: row.title, destination: matched.title };
      if (executedCurrent && row.sourceUrl && text(matched.target_url) !== row.sourceUrl
        && (resourceIdentity(matched.target_url).identity !== parsed.identity
          || identityCandidates.length !== 1)) {
        mismatchFields.target_url = { source: row.sourceUrl, destination: matched.target_url };
      }
      if (description && text(matched.description) !== description) mismatchFields.description = { source: description, destination: matched.description };
      if (date && Date.parse(date) !== Date.parse(matched.release_date)) {
        mismatchFields.release_date = {
          sourceRaw: sourceDateRaw,
          sourceNormalized: date,
          destination: matched.release_date,
        };
      }
      if (desiredPublic !== null && matched.is_public !== desiredPublic) {
        mismatchFields.is_public = { source: desiredPublic, destination: matched.is_public };
      }
      const subs = Array.isArray(matched.subcategories) ? matched.subcategories : [];
      if (row.collection && !subs.includes(row.collection)) mismatchFields.collection = { source: row.collection, destination: subs };
      if (row.resourceType && !subs.includes(row.resourceType)) mismatchFields.resource_type_taxonomy = { source: row.resourceType, destination: subs };
      const missingTopics = selectedTopics.filter((topic) => !subs.includes(topic));
      if (missingTopics.length) mismatchFields.topics = { source: selectedTopics, missingAtDestination: missingTopics, destination: subs };
    }
    let classification;
    const fatalIssues = issues.filter((issue) => !unresolvedIssues.includes(issue));
    if (fatalIssues.length) classification = 'invalid';
    else if (unresolvedIssues.length) classification = 'ambiguous';
    else if (candidates.length > 1) classification = 'ambiguous';
    else if (candidates.length === 1) {
      if (Object.keys(mismatchFields).length) {
        classification = 'metadata_access_mismatch';
      } else classification = 'present';
    } else if (titleCandidates.length || parsed.kind === 'shared_folder') classification = 'ambiguous';
    else if (history?.executedId) classification = 'confirmed_absent_identity';
    else if (history?.held) classification = 'intentional_hold';
    else classification = 'no_execution_evidence';
    const absentFromDestination = candidates.length === 0;
    const historicalTimeline = [
      ...(history?.held ? [{
        stage: 'proposal_or_skip',
        outcome: 'held',
        issues: history.issues || [],
        evidenceFile: history.evidenceFile,
      }] : []),
      ...(history?.executedId ? [{
        stage: 'terminal_execution',
        outcome: 'executed',
        destinationId: history.executedId,
        evidenceFile: history.executionEvidenceFile,
        supersedesProposalHold: Boolean(history.held),
      }] : []),
    ];
    const historicalOutcome = history?.executedId
      ? `terminal execution as destination id ${history.executedId}${history.held ? ' (supersedes earlier proposal/skip hold)' : ''}`
      : history?.held
        ? `historically held: ${(history.issues || []).join('; ') || 'recorded hold'}`
        : 'no surviving row-level execution outcome';
    const currentOutcome = candidates.length === 1
      ? `one current identity match (${candidates[0].id})`
      : candidates.length > 1
        ? `${candidates.length} current identity matches; unresolved`
        : 'identity absent from current destination snapshot';
    const reasonByClass = {
      present: 'Unique current exact/provider identity match with no audited field mismatch.',
      metadata_access_mismatch: `Unique current identity match differs in: ${Object.keys(mismatchFields).join(', ')}.`,
      ambiguous: titleCandidates.length
        ? 'No unique provider match; title-only candidates cannot establish identity.'
        : 'Identity is ambiguous or is a shared folder requiring individual links.',
      invalid: `Unresolved source evidence: ${issues.join(', ')}.`,
      intentional_hold: 'Identity is currently absent and the historical row outcome was an intentional/blocked hold.',
      confirmed_absent_identity: 'A row-level executed identity is absent from the stable current destination snapshot.',
      no_execution_evidence: 'Identity is currently absent, but no surviving row-level execution outcome establishes historical causation.',
    };
    const actionByClass = {
      present: 'No action.',
      metadata_access_mismatch: 'Review the listed field differences and decide whether the source revision should be applied.',
      ambiguous: 'Manually resolve to a single resource identity; do not import or update from title alone.',
      invalid: 'Correct or explicitly waive the unresolved source hyperlink/formula/input issue before any action.',
      intentional_hold: 'Retain the hold unless an owner explicitly approves a new import decision.',
      confirmed_absent_identity: 'Investigate deletion/retirement history before considering restoration.',
      no_execution_evidence: 'Locate stronger execution evidence or obtain a fresh owner decision; do not call this a failed import.',
    };
    return {
      ...row,
      identity: parsed.identity,
      identityKind: parsed.kind,
      classification,
      humanReason: reasonByClass[classification],
      recommendedNextAction: actionByClass[classification],
      historicalOutcome,
      historicalTimeline,
      currentOutcome,
      absentFromDestination,
      issues,
      mismatchFields,
      desiredValues: {
        title: row.title,
        description,
        release_date: date || null,
        is_public: desiredPublic,
        collection: row.collection,
        resourceType: row.resourceType,
        topics: selectedTopics,
      },
      matchedValues: matched ? {
        id: matched.id,
        title: matched.title,
        description: matched.description,
        target_url: matched.target_url,
        release_date: matched.release_date,
        is_public: matched.is_public,
        subcategories: matched.subcategories,
        allowed_role_ids: matched.allowed_role_ids,
        member_group_id: matched.member_group_id,
        status: matched.status,
        resource_type: matched.resource_type,
      } : null,
      contextualAccessEvidence: matched ? {
        is_public: matched.is_public,
        allowed_role_ids: matched.allowed_role_ids,
        member_group_id: matched.member_group_id,
        status: matched.status,
      } : null,
      candidateIds: candidates.map((candidate) => candidate.id),
      urlIdentityCandidateIds: identityCandidates.map((candidate) => candidate.id),
      titleCandidateIds: titleCandidates.map((candidate) => candidate.id),
      matchedResource: candidates.length === 1 ? candidates[0] : null,
      historicalEvidence: history,
      matchMethod: executedCurrent
        ? 'historical_executed_id'
        : exact.length ? 'exact_url' : candidates.length ? 'provider_identity' : 'none',
    };
  });
}

export function deduplicate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.identity || `invalid:${row.sourceFile}:${row.sheet}:${row.row}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([identity, members]) => ({
    identity,
    classification: members.some((row) => ['present', 'metadata_access_mismatch'].includes(row.classification))
      ? (members.some((row) => row.classification === 'metadata_access_mismatch') ? 'metadata_access_mismatch' : 'present')
      : members.some((row) => row.classification === 'intentional_hold') ? 'intentional_hold'
        : members.some((row) => row.classification === 'ambiguous') ? 'ambiguous'
          : members.some((row) => row.classification === 'invalid') ? 'invalid'
            : members.some((row) => row.classification === 'confirmed_absent_identity') ? 'confirmed_absent_identity'
              : 'no_execution_evidence',
    sourceRows: members.map((row) => `${row.sourceFile}#${row.sheet}!${row.row}`),
    titles: [...new Set(members.map((row) => row.title))],
    absentFromDestination: members.every((row) => row.absentFromDestination),
    historicalOutcomes: [...new Set(members.map((row) => row.historicalOutcome))],
    currentOutcomes: [...new Set(members.map((row) => row.currentOutcome))],
  }));
}