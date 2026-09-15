import XLSX from 'xlsx';
import {
  checksum,
  readAll as readAllFromPresentations,
  TENANT_ID,
} from './bnms-presentations-proposal.mjs';
import { parseDate, youtubeId } from './bnms-youtube-categorisation.mjs';

export { checksum, TENANT_ID };
export const readAll = readAllFromPresentations;

export const INPUT = 'attached_assets/Resources_-_categorising-tagging_FINALISED_1789486104337.xlsx';
export const DESTINATION_PROJECT = 'lvmzliemqnieeoruhkik';
export const DESTINATION_URL = `https://${DESTINATION_PROJECT}.supabase.co`;

// This is deliberately the source workbook's complete Resources header set.
// Do not reuse the presentations header list: Management and Radiopharmacy are
// both valid columns in this workbook.
export const HEADERS = Object.freeze([
  'Page URL',
  'Menu Item',
  'Resource URL',
  'Title',
  'Brief Description',
  'Date',
  'Member Only',
  'Collection',
  'Resource Type',
  'Bone',
  'Cardiovascular',
  'Careers',
  'Coding & HRGs',
  'Diagnostics',
  'Educational',
  'Endocrinology',
  'Equipment',
  'Gastro',
  'Haematology',
  'Infection',
  'Lung',
  'Management',
  'Management and Workforce',
  'Molecular Radiotherapy',
  'Neurology',
  'Oncology',
  'Paediatrics',
  'PET and PET-CT',
  'Physics – dosimetry',
  'Physics – imaging science',
  'Physics – radiation protection',
  'Radiopharmaceutical Development',
  'Radiopharmacy',
  'Renal',
  'Therapeutic',
  'Thyroid',
  'Training',
  'Working in NM',
]);

export const TOPIC_HEADERS = Object.freeze(HEADERS.slice(9));
export const aliases = Object.freeze({
  'Management and Workforce': 'Management & Workforce',
});
export const topicMapping = Object.freeze(Object.fromEntries(
  TOPIC_HEADERS.map((header) => [header, aliases[header] || header]),
));

const trim = (value) => String(value ?? '').trim();
const unique = (values) => [...new Set(values)];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function marker(value) {
  const valueText = trim(value).toLowerCase();
  if (valueText === 'yes') return true;
  if (valueText === '' || valueText === 'no') return false;
  return null;
}

export function dateValue(value) {
  if (!trim(value)) return { value: null, kind: 'blank' };
  // Check the raw display value first. Excel year-only cells are numeric
  // values (for example 2025), not strings.
  if (/^\d{4}$/.test(trim(value)) && Number(value) >= 1900 && Number(value) <= 2100) {
    return { value: `${trim(value)}-01-01`, kind: 'year_only_requires_approval' };
  }
  const parsed = parseDate(value);
  return {
    value: parsed,
    kind: parsed
      ? typeof value === 'number' ? 'excel_serial' : 'calendar_date'
      : 'invalid',
  };
}

function decodeHref(value) {
  // Excel hyperlink relationships may serialise ampersands as &amp;. Decode
  // only for identity parsing; retain the literal and target in the audit.
  return trim(value).replaceAll('&amp;', '&');
}

export function link(raw) {
  const value = decodeHref(raw);
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.port) {
      return { valid: false, identity: null };
    }
    const videoId = youtubeId(value);
    if (videoId) return { valid: true, identity: `youtube:${videoId}`, kind: 'youtube' };
    if (['drive.google.com', 'drive.usercontent.google.com', 'docs.google.com'].includes(url.hostname)) {
      const folder = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)\/?$/);
      if (folder) return { valid: true, identity: `folder:${folder[1]}`, kind: 'shared_folder' };
      const file = url.pathname.match(/^\/(?:file|document|presentation|spreadsheets)\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
      const id = file?.[1]
        || (['/download', '/open', '/uc'].includes(url.pathname)
          && url.searchParams.getAll('id').length === 1
          ? url.searchParams.get('id')
          : null);
      if (id && /^[A-Za-z0-9_-]+$/.test(id)) {
        return { valid: true, identity: `drive:${id}`, kind: 'drive_file' };
      }
    }
    return { valid: true, identity: null, kind: 'other' };
  } catch {
    return { valid: false, identity: null };
  }
}

function readCellLinksAndFormulas(ws, rowIndex, headers = HEADERS) {
  const hyperlinks = [];
  const formulas = [];
  for (let column = 0; column < HEADERS.length; column += 1) {
    const address = XLSX.utils.encode_cell({ r: rowIndex, c: column });
    const cell = ws[address];
    if (cell?.l) {
      hyperlinks.push({
        address,
        header: headers[column],
        literal: cell.v ?? '',
        target: cell.l.Target ?? '',
        tooltip: cell.l.Tooltip ?? null,
      });
    }
    if (cell?.f) formulas.push({ address, header: HEADERS[column], formula: cell.f });
  }
  return { hyperlinks, formulas };
}

export function readWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
  if (workbook.Workbook?.WBProps?.date1904) {
    throw new Error('Unsupported 1904 date system');
  }
  const sheet = workbook.Sheets.Resources;
  if (!sheet?.['!ref']) throw new Error('Resources sheet missing');
  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
    range: 0,
  });
  const headers = (matrix[0] ?? []).map(trim);
  if (headers.length !== HEADERS.length
    || new Set(headers).size !== headers.length
    || HEADERS.some((header) => !headers.includes(header))) {
    throw new Error('Unexpected or duplicate Resources headers');
  }
  const rows = matrix.slice(1).map((cells, index) => {
    const source = Object.fromEntries(headers.map((header, column) => [
      header,
      cells[column] ?? '',
    ]));
    const { hyperlinks, formulas } = readCellLinksAndFormulas(sheet, index + 1, headers);
    return { row: index + 2, source, hyperlinks, formulas };
  }).filter((row) => Object.values(row.source).some((value) => trim(value)));
  return {
    checksum: checksum(buffer),
    headers,
    sheets: workbook.SheetNames.map((name) => ({
      name,
      range: workbook.Sheets[name]?.['!ref'] ?? null,
      handling: name === 'Resources' ? 'resource records' : 'reference only; not imported',
    })),
    rows,
  };
}

function taxonomyDefinitions(categories) {
  const taxonomy = {};
  for (const name of ['Collection', 'Resource Type', 'Focus Area']) {
    const found = categories.filter((category) => category.name === name);
    taxonomy[name] = found.length === 1 && Array.isArray(found[0].subcategories)
      ? found[0]
      : null;
  }
  return taxonomy;
}

function destinationCandidates(resources, sourceUrl, resourceLink) {
  const exact = resources.filter((resource) => trim(resource.target_url) === sourceUrl);
  const identity = resourceLink.identity && resourceLink.kind !== 'shared_folder'
    ? resources.filter((resource) => link(resource.target_url).identity === resourceLink.identity)
    : [];
  const candidates = [...new Map([...exact, ...identity].map((resource) => [
    resource.id,
    resource,
  ])).values()];
  return { exact, identity, candidates };
}

const CORE_FIELDS = Object.freeze([
  'target_url',
  'title',
  'description',
  'release_date',
]);

function dateEquivalent(oldValue, newValue) {
  return Boolean(oldValue && newValue)
    && !Number.isNaN(Date.parse(oldValue))
    && !Number.isNaN(Date.parse(newValue))
    && Date.parse(oldValue) === Date.parse(newValue);
}

export function buildReport(workbook, resources, categories) {
  if ([...resources, ...categories].some((row) => row.tenant_id !== TENANT_ID)) {
    throw new Error('Tenant isolation violation');
  }
  const taxonomy = taxonomyDefinitions(categories);
  const rows = workbook.rows.map((workbookRow) => {
    const { source } = workbookRow;
    const issues = [];
    const notes = [];
    const sourceUrl = trim(source['Resource URL']);
    const resourceLink = link(sourceUrl);
    const date = dateValue(source.Date);
    const memberOnly = trim(source['Member Only']).toLowerCase();

    if (!trim(source.Title)) issues.push('missing_title');
    if (!resourceLink.valid) issues.push('invalid_url');
    if (!['yes', 'no'].includes(memberOnly)) issues.push('missing_or_invalid_access');
    if (date.kind === 'invalid') issues.push('invalid_date');
    if (date.kind === 'year_only_requires_approval') {
      notes.push('date_year_only_requires_approval');
    }

    // Hyperlinks and formulas are retained in the audit. A formula is not
    // imported as a computed value without explicit review.
    for (const hyperlink of workbookRow.hyperlinks) {
      if (!trim(hyperlink.target)) {
        issues.push(`blank_hyperlink_target:${hyperlink.address}`);
        continue;
      }
      if (!trim(hyperlink.literal)) {
        issues.push(`blank_hyperlink_literal:${hyperlink.address}`);
      }
      if (!['Page URL', 'Resource URL'].includes(hyperlink.header)) {
        issues.push(`unexpected_hyperlink:${hyperlink.address}`);
        continue;
      }
      if (decodeHref(hyperlink.literal) !== decodeHref(hyperlink.target)) {
        const literalIdentity = link(hyperlink.literal).identity;
        const targetIdentity = link(hyperlink.target).identity;
        if (literalIdentity && literalIdentity === targetIdentity) {
          notes.push(`hyperlink_variant_same_identity:${hyperlink.address}`);
        } else {
          issues.push(`hyperlink_conflict:${hyperlink.address}`);
        }
      } else if (trim(hyperlink.literal) !== trim(hyperlink.target)) {
        // Excel may expose an otherwise identical query string with XML
        // entities in the relationship target.
        notes.push(`hyperlink_xml_normalized:${hyperlink.address}`);
      }
    }
    if (workbookRow.formulas.length) issues.push('formula_requires_review');

    const selected = {
      Collection: [trim(source.Collection)].filter(Boolean),
      'Resource Type': [trim(source['Resource Type'])].filter(Boolean),
      'Focus Area': [],
    };
    for (const header of TOPIC_HEADERS) {
      const value = marker(source[header]);
      if (value === null) issues.push(`invalid_marker:${header}`);
      if (value) selected['Focus Area'].push(topicMapping[header]);
    }
    for (const [categoryName, values] of Object.entries(selected)) {
      if (!values.length && ['Collection', 'Resource Type'].includes(categoryName)) {
        issues.push(`missing_classification:${categoryName}`);
      }
      for (const value of values) {
        const definition = taxonomy[categoryName];
        if (!definition || !definition.subcategories.includes(value)) {
          issues.push(`missing_taxonomy:${categoryName}:${value}`);
        }
      }
    }

    const { exact, identity, candidates } = destinationCandidates(
      resources,
      sourceUrl,
      resourceLink,
    );
    const candidateIds = candidates.map((resource) => resource.id);
    if (candidates.length > 1) issues.push('multiple_destination_matches');
    if (resourceLink.kind === 'shared_folder') {
      issues.push('shared_folder_requires_individual_link_review');
    }
    const before = candidates.length === 1 ? candidates[0] : null;
    const titleCandidates = candidates.length === 0
      ? resources.filter((resource) => trim(resource.title).toLowerCase() === trim(source.Title).toLowerCase())
        .map((resource) => resource.id)
      : [];
    if (titleCandidates.length) issues.push('title_only_candidate_requires_review');
    if (before) {
      for (const field of ['subcategories', 'tags', 'allowed_role_ids']) {
        if (before[field] != null && !Array.isArray(before[field])) {
          issues.push(`invalid_stored_classifications:${field}`);
        }
      }
    }

    const existingSubcategories = Array.isArray(before?.subcategories)
      ? before.subcategories
      : [];
    const knownSelected = Object.entries(selected).flatMap(([categoryName, values]) => (
      values.filter((value) => taxonomy[categoryName]?.subcategories.includes(value))
    ));
    const additions = knownSelected.filter((value) => !existingSubcategories.includes(value));
    const proposed = before
      ? { ...before }
      : {
        tenant_id: TENANT_ID,
        resource_type: 'external_link',
        open_in_new_tab: true,
        status: 'active',
        allowed_role_ids: [],
        tags: [],
        linked_events: [],
        folder_id: null,
      };
    Object.assign(proposed, {
      title: trim(source.Title),
      // Preserve an existing URL variant after an identity match. The source
      // URL is still used for inserts and retained in the row-level audit.
      target_url: before?.target_url ?? sourceUrl,
      // Empty source descriptions do not erase an existing description.
      description: trim(source['Brief Description']) || before?.description || '',
      release_date: date.value || before?.release_date || null,
      // A member-only existing record remains restricted even if a source
      // row says "No"; never silently widen access.
      is_public: memberOnly === 'yes'
        ? false
        : memberOnly === 'no'
          ? before?.is_public === false ? false : true
          : null,
      subcategories: unique([...existingSubcategories, ...additions]),
    });
    if (before?.release_date && proposed.release_date
      && dateEquivalent(before.release_date, proposed.release_date)) {
      proposed.release_date = before.release_date;
    }

    const patch = Object.fromEntries(Object.entries(proposed).filter(([key, value]) => (
      !same(value, before?.[key])
    )));
    const coreChanges = before
      ? CORE_FIELDS.filter((field) => Object.hasOwn(patch, field))
      : [];
    const accessChange = Boolean(before && Object.hasOwn(patch, 'is_public'));
    const classificationChange = Boolean(before && Object.hasOwn(patch, 'subcategories'));
    const status = issues.length
      ? 'blocked'
      : before
        ? Object.keys(patch).length ? 'update' : 'unchanged'
        : 'insert';
    return {
      ...workbookRow,
      url: sourceUrl,
      link: resourceLink,
      date,
      selected,
      knownSelected,
      additions,
      issues,
      notes,
      candidateIds,
      titleCandidates,
      matchMethod: exact.length ? 'exact_url' : identity.length ? 'provider_identity' : 'none',
      before,
      proposed,
      patch,
      coreChanges,
      accessChange,
      classificationChange,
      status,
    };
  });

  const groups = new Map();
  for (const row of rows) {
    const key = row.link.identity || row.url;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const duplicateGroups = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const identical = group.every((row) => same(row.source, group[0].source));
    duplicateGroups.push({
      key,
      kind: group[0].link.kind ?? 'literal_url',
      rows: group.map((row) => row.row),
      identical,
      titles: group.map((row) => ({ row: row.row, title: row.source.Title })),
      differingFields: HEADERS.filter((header) => new Set(
        group.map((row) => JSON.stringify(row.source[header])),
      ).size > 1),
    });
    for (const row of group) {
      row.issues.push(identical
        ? 'identical_source_duplicate_review'
        : 'conflicting_source_duplicate');
      row.status = 'blocked';
    }
  }

  const issueRows = (predicate) => rows.filter(predicate).length;
  const fieldChangeCounts = Object.fromEntries(CORE_FIELDS.map((field) => [
    field,
    rows.filter((row) => row.coreChanges.includes(field)).length,
  ]));
  const summary = {
    sourceRows: rows.length,
    distinctLiteralUrls: unique(rows.map((row) => row.url)).length,
    destinationResources: resources.length,
    inserts: issueRows((row) => row.status === 'insert'),
    updates: issueRows((row) => row.status === 'update'),
    unchanged: issueRows((row) => row.status === 'unchanged'),
    blocked: issueRows((row) => row.status === 'blocked'),
    exactMatchRows: issueRows((row) => row.matchMethod === 'exact_url'),
    providerIdentityMatchRows: issueRows((row) => row.matchMethod === 'provider_identity'),
    unmatchedRows: issueRows((row) => row.matchMethod === 'none'),
    // Keep the terminology used by the earlier BNMS approval packages as
    // aliases while retaining the more explicit providerIdentity name.
    exactMatches: issueRows((row) => row.matchMethod === 'exact_url'),
    identityMatchRows: issueRows((row) => row.matchMethod === 'provider_identity'),
    multipleDestinationRows: issueRows((row) => row.issues.includes('multiple_destination_matches')),
    titleOnlyRows: issueRows((row) => row.issues.includes('title_only_candidate_requires_review')),
    coreChangeRows: issueRows((row) => row.coreChanges.length > 0),
    nonBlockedCoreChangeRows: issueRows((row) => row.status !== 'blocked' && row.coreChanges.length > 0),
    coreChangeFields: fieldChangeCounts,
    accessChangeRows: issueRows((row) => row.accessChange),
    accessChanges: issueRows((row) => row.accessChange),
    nonBlockedAccessChangeRows: issueRows((row) => row.status !== 'blocked' && row.accessChange),
    classificationChangeRows: issueRows((row) => row.classificationChange),
    yearOnlyRows: issueRows((row) => row.date.kind === 'year_only_requires_approval'),
    invalidDateRows: issueRows((row) => row.issues.includes('invalid_date')),
    missingTaxonomyRows: issueRows((row) => row.issues.some((issue) => issue.startsWith('missing_taxonomy:'))),
    duplicateSourceGroups: duplicateGroups.length,
    duplicateSourceRows: duplicateGroups.reduce((total, group) => total + group.rows.length, 0),
    hyperlinkRows: issueRows((row) => row.hyperlinks.length > 0),
    hyperlinkConflicts: issueRows((row) => row.issues.some((issue) => issue.startsWith('hyperlink_conflict:'))),
    formulaRows: issueRows((row) => row.formulas.length > 0),
    databaseWrites: 0,
  };
  return {
    mode: 'READ_ONLY_APPROVAL_REQUIRED',
    tenantId: TENANT_ID,
    inputChecksum: workbook.checksum,
    headers: workbook.headers,
    sheets: workbook.sheets,
    topicMapping,
    summary,
    duplicateGroups,
    missingTaxonomy: unique(rows.flatMap((row) => row.issues.filter(
      (issue) => issue.startsWith('missing_taxonomy:'),
    ))),
    rows,
  };
}