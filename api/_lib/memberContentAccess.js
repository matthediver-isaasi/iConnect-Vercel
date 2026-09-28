// Live authorization for the Member AI content corpus.
//
// Vector metadata is useful to constrain the initial database search, but it
// cannot be the authority after a source, group, role, booking, or publication
// changes.  This module performs the second, current-source check immediately
// before chunks become model context/citations.  It deliberately reads only
// entitlement fields and approved CMS source rows; it never turns member,
// booking, or CRM records into answer material.

import { isChunkVisibleToMember } from './memberContentVisibility.js';
import { CONTENT_TYPE_CONFIG, buildMemberContentMetadata } from './memberContentIndexer.js';
import {
  fetchCategoriesWithAccess,
  computeHiddenSubcategories,
  isResourceHiddenByCategories,
} from './resourceCategoryAccess.js';
import { evaluateGalleryAccessPolicy } from './galleryAccessPolicy.js';

const MAX_PRE_RANK_PDF_CHUNKS = 400;
const MAX_PRE_RANK_PDF_SOURCES = 200;
const MAX_PRE_RANK_PDF_FILES = 200;

function preRankLimitError(kind, limit) {
  const error = new Error(`Member-content PDF pre-ranking exceeded the ${kind} limit (${limit})`);
  error.code = 'MEMBER_CONTENT_PRERANK_LIMIT';
  return error;
}

/**
 * Fetch confirmed bookings belonging to a member.  Do not use `ilike` for an
 * email entitlement: `%` and `_` are SQL wildcards and would let a member
 * whose email contains either character match another attendee.  Two exact
 * equality queries also preserve the legitimate "booked by account" and
 * "booked using attendee email" cases without constructing PostgREST filter
 * syntax from identity data.
 */
export async function fetchExactMemberBookings({
  supabase,
  table,
  tenantId,
  member,
  columns,
  eventIds = null,
}) {
  if (!supabase || !table || !tenantId || !member?.id) {
    return { data: [], error: null };
  }
  const build = (field, value) => {
    let query = supabase
      .from(table)
      .select(columns)
      .eq('tenant_id', tenantId)
      .eq('status', 'confirmed')
      .eq(field, value);
    if (Array.isArray(eventIds) && eventIds.length) query = query.in('event_id', eventIds);
    return query;
  };
  const requests = [build('member_id', member.id)];
  const email = typeof member.email === 'string' ? member.email.trim() : '';
  if (email) requests.push(build('attendee_email', email));
  const results = await Promise.all(requests);
  const error = results.find((result) => result.error)?.error || null;
  if (error) return { data: [], error };
  // The same booking can meet both predicates.  Keep only its one row without
  // exposing or retaining any booking material beyond the requested columns.
  const seen = new Set();
  const data = [];
  for (const row of results.flatMap((result) => result.data || [])) {
    const key = row.id || `${row.event_id || ''}:${row.ticket_class_id || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      data.push(row);
    }
  }
  return { data, error: null };
}

export async function resolveAccessibleEventIds({ supabase, tenantId, member }) {
  if (!supabase || !tenantId || !member?.id) return new Set();
  const eventIds = new Set();
  // These records are authorization input only.  We select no attendee or
  // booking content and retain only event ids.
  const [simple, complex] = await Promise.all([
    fetchExactMemberBookings({
      supabase, table: 'booking', tenantId, member, columns: 'id, event_id',
    }),
    fetchExactMemberBookings({
      supabase, table: 'complex_event_booking', tenantId, member, columns: 'id, event_id',
    }),
  ]);
  if (simple.error) throw simple.error;
  if (complex.error) throw complex.error;
  for (const row of [...(simple.data || []), ...(complex.data || [])]) {
    if (row.event_id) eventIds.add(row.event_id);
  }
  return eventIds;
}

/**
 * Produce the member's currently accessible complex-event session ids for the
 * retrieval RPC. This is authorization input only and uses the same confirmed
 * booking/ticket-track semantics as the portal's My Tickets route.
 */
export async function resolveAccessibleSessionIds({ supabase, tenantId, member }) {
  if (!supabase || !tenantId || !member?.id) return new Set();
  const { data: bookings, error: bookingError } = await fetchExactMemberBookings({
    supabase,
    table: 'complex_event_booking',
    tenantId,
    member,
    columns: 'id, event_id, ticket_class_id',
  });
  if (bookingError) throw bookingError;
  const eventIds = [...new Set((bookings || []).map((booking) => booking.event_id).filter(Boolean))];
  if (!eventIds.length) return new Set();
  const ticketClassIds = [...new Set(
    (bookings || []).map((booking) => booking.ticket_class_id).filter(Boolean)
  )];
  const [sessionsResult, ticketClassesResult] = await Promise.all([
    supabase
      .from('complex_event_session')
      .select('id, event_id, complex_event_track_id')
      .eq('tenant_id', tenantId)
      .in('event_id', eventIds),
    ticketClassIds.length
      ? supabase
        .from('complex_event_ticket_class')
        .select('id, linked_track_ids, all_tracks')
        .eq('tenant_id', tenantId)
        .in('id', ticketClassIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sessionsResult.error) throw sessionsResult.error;
  if (ticketClassesResult.error) throw ticketClassesResult.error;
  const ticketClasses = new Map(
    (ticketClassesResult.data || []).map((ticketClass) => [ticketClass.id, ticketClass])
  );
  const bookingsByEvent = new Map();
  for (const booking of bookings || []) {
    if (!bookingsByEvent.has(booking.event_id)) bookingsByEvent.set(booking.event_id, []);
    bookingsByEvent.get(booking.event_id).push(booking);
  }
  const allowed = new Set();
  for (const session of sessionsResult.data || []) {
    const eventBookings = bookingsByEvent.get(session.event_id) || [];
    if (eventBookings.some((booking) => {
      const ticket = booking.ticket_class_id
        ? ticketClasses.get(booking.ticket_class_id)
        : null;
      return (
        !ticket ||
        ticket.all_tracks === true ||
        !Array.isArray(ticket.linked_track_ids) ||
        ticket.linked_track_ids.length === 0 ||
        ticket.linked_track_ids.includes(session.complex_event_track_id)
      );
    })) {
      allowed.add(session.id);
    }
  }
  return allowed;
}

export async function resolveMemberContentGroupIds({ supabase, tenantId, memberId }) {
  if (!supabase || !tenantId || !memberId) return new Set();
  const nowIso = new Date().toISOString();
  const { data: assignments, error } = await supabase
    .from('member_group_assignment')
    .select('group_id, expires_at')
    .eq('member_id', memberId);
  if (error) throw error;
  const ids = (assignments || [])
    .filter((assignment) =>
      assignment.group_id &&
      (!assignment.expires_at || new Date(assignment.expires_at).toISOString() > nowIso)
    )
    .map((assignment) => assignment.group_id);
  if (!ids.length) return new Set();
  const { data: groups, error: groupsError } = await supabase
    .from('member_group')
    .select('id, is_active')
    .eq('tenant_id', tenantId)
    .in('id', [...new Set(ids)]);
  if (groupsError) throw groupsError;
  return new Set((groups || []).filter((group) => group.is_active !== false).map((group) => group.id));
}

export function linkedResourceIsEntitled(linkedEvents, accessibleEventIds, accessibleSessionIds = new Set()) {
  if (!Array.isArray(linkedEvents) || linkedEvents.length === 0) return true;
  if (!accessibleEventIds || accessibleEventIds.size === 0) return false;
  return linkedEvents.some(
    (entry) => entry &&
      typeof entry.event_id === 'string' &&
      accessibleEventIds.has(entry.event_id) &&
      (!entry.session_id || accessibleSessionIds.has(entry.session_id))
  );
}

async function resolveLinkedSessionEntitlements({ supabase, tenantId, member, resources }) {
  const entries = (resources || [])
    .flatMap((resource) => Array.isArray(resource.linked_events) ? resource.linked_events : [])
    .filter((entry) => entry?.event_id && entry?.session_id);
  if (!entries.length || !member?.id) return new Set();
  const eventIds = [...new Set(entries.map((entry) => entry.event_id))];
  const sessionIds = [...new Set(entries.map((entry) => entry.session_id))];
  const { data: bookings, error: bookingError } = await fetchExactMemberBookings({
    supabase,
    table: 'complex_event_booking',
    tenantId,
    member,
    columns: 'id, event_id, ticket_class_id',
    eventIds,
  });
  if (bookingError) throw bookingError;
  const ticketClassIds = [...new Set((bookings || []).map((row) => row.ticket_class_id).filter(Boolean))];
  const [classesRes, tracksRes] = await Promise.all([
    ticketClassIds.length
      ? supabase
        .from('complex_event_ticket_class')
        .select('id, linked_track_ids, all_tracks')
        .eq('tenant_id', tenantId)
        .in('id', ticketClassIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('complex_event_session_track')
      .select('complex_event_session_id, complex_event_track_id')
      .eq('tenant_id', tenantId)
      .in('complex_event_session_id', sessionIds),
  ]);
  if (classesRes.error) throw classesRes.error;
  if (tracksRes.error) throw tracksRes.error;
  const classes = new Map((classesRes.data || []).map((row) => [row.id, row]));
  const tracksBySession = new Map();
  for (const track of tracksRes.data || []) {
    if (!tracksBySession.has(track.complex_event_session_id)) {
      tracksBySession.set(track.complex_event_session_id, new Set());
    }
    tracksBySession.get(track.complex_event_session_id).add(track.complex_event_track_id);
  }
  const bookingsByEvent = new Map();
  for (const booking of bookings || []) {
    if (!bookingsByEvent.has(booking.event_id)) bookingsByEvent.set(booking.event_id, []);
    bookingsByEvent.get(booking.event_id).push(booking);
  }
  const allowed = new Set();
  for (const entry of entries) {
    const bookingsForEvent = bookingsByEvent.get(entry.event_id) || [];
    const tracks = tracksBySession.get(entry.session_id) || new Set();
    if (bookingsForEvent.some((booking) => {
      if (!booking.ticket_class_id || tracks.size === 0) return true;
      const ticket = classes.get(booking.ticket_class_id);
      return ticket?.all_tracks === true ||
        (Array.isArray(ticket?.linked_track_ids) &&
          ticket.linked_track_ids.some((trackId) => tracks.has(trackId)));
    })) allowed.add(entry.session_id);
  }
  return allowed;
}

function privateStoragePathParts(file) {
  const bucket = typeof file?.bucket === 'string' ? file.bucket : '';
  const storagePath = typeof file?.storage_path === 'string' ? file.storage_path : '';
  return {
    isPrivate: bucket === 'private-uploads',
    parts: storagePath.split('/').filter(Boolean),
  };
}

/**
 * Reuse the file access boundaries which are stricter than an otherwise
 * eligible resource.  A service-role storage download is an implementation
 * detail, never an authorization decision.
 *
 * File Repository folders may inherit their access group from any ancestor.
 * Gallery policies are evaluated with the same helper as secure-url.  CRM
 * opportunity files remain excluded from this knowledge corpus entirely:
 * linking one from a Resource must not turn CRM material into editorial
 * knowledge.
 */
export async function isResourcePdfFileAccessible({
  supabase,
  file,
  visibilityCtx,
}) {
  if (!supabase || !file || !visibilityCtx?.tenantId) return false;
  const {
    tenantId, isAdmin = false, roleId = null, groupIds = new Set(), member,
    isAuthenticated,
  } = visibilityCtx;
  const { isPrivate, parts } = privateStoragePathParts(file);

  // Public repository objects have no extra file gate.  Parent resource
  // visibility remains mandatory in the caller.
  if (!isPrivate) return true;
  // `private-uploads` must never be an anonymous corpus source.  Do this
  // before considering an otherwise unrestricted folder or gallery policy.
  // A verified tenant administrator is permitted to use the management
  // bypass, matching secure-url; every non-admin needs a current member.
  if (!isAdmin && (isAuthenticated === false || !member?.id)) return false;
  if (!file.storage_path || !file.bucket) return false;

  // Folder membership is a separate entitlement from the resource itself.
  // Walk the bounded hierarchy since a child can sit below a group-restricted
  // ancestor.  Missing/deleted hierarchy rows fail closed.
  let folderId = file.folder_id || null;
  const visited = new Set();
  for (let depth = 0; folderId && depth < 20; depth++) {
    if (visited.has(folderId)) return false;
    visited.add(folderId);
    const { data: folder, error } = await supabase
      .from('file_repository_folder')
      .select('id, parent_folder_id, member_group_id')
      .eq('tenant_id', tenantId)
      .eq('id', folderId)
      .maybeSingle();
    if (error || !folder) return false;
    if (!isAdmin && folder.member_group_id && !groupIds.has(folder.member_group_id)) {
      return false;
    }
    folderId = folder.parent_folder_id || null;
  }
  if (folderId) return false; // hierarchy too deep: don't guess at access

  // Do not turn an opportunity (CRM) document into a knowledge source merely
  // because somebody placed its URL in a Resource record.
  if (parts[1] === 'opportunities') return false;

  // Gallery files follow the gallery's current policy even though the file is
  // fetched internally.  A malformed/deleted gallery mapping is denied.
  const { data: photo, error: photoError } = await supabase
    .from('gallery_photo')
    .select('gallery_id')
    .eq('tenant_id', tenantId)
    .eq('bucket', file.bucket)
    .eq('storage_path', file.storage_path)
    .maybeSingle();
  if (photoError) return false;
  if (photo?.gallery_id) {
    const { data: gallery, error: galleryError } = await supabase
      .from('gallery')
      .select('id, is_public, access_policy')
      .eq('tenant_id', tenantId)
      .eq('id', photo.gallery_id)
      .maybeSingle();
    if (galleryError || !gallery) return false;
    const access = await evaluateGalleryAccessPolicy({
      supabase,
      tenantId,
      memberId: member?.id || null,
      roleId,
      policy: gallery.access_policy,
      isManager: isAdmin,
    });
    return access.allowed === true;
  }
  // private-uploads/{tenant}/galleries/... must have a database photo row.
  if (parts[1] === 'galleries') return false;
  return true;
}

/**
 * Resolve authoritative file-policy eligibility before vector ranking.  PDF
 * chunks are the only derived corpus records whose access depends on a
 * repository folder, gallery, and current file mapping rather than solely on
 * their parent-resource columns.  Returning their ids to the RPC prevents an
 * inaccessible PDF from occupying one of the top-K positions.  Any lookup
 * failure intentionally returns an empty set, excluding PDFs but never
 * broadening access to them.
 */
export async function resolvePreRankEligiblePdfChunkIds({
  supabase,
  tenantId,
  visibilityCtx,
}) {
  if (!supabase || !tenantId || !visibilityCtx) return [];
  try {
    const { data: chunks, error: chunksError } = await supabase
      .from('member_content_chunk')
      .select('id, source_id, provenance')
      .eq('tenant_id', tenantId)
      .eq('content_type', 'resource')
      .eq('is_active', true)
      .contains('provenance', { kind: 'resource_pdf' })
      // Fetch one extra row so hitting the bound is an explicit unavailable
      // state, never a silent omission from an incomplete PDF allow-list.
      .limit(MAX_PRE_RANK_PDF_CHUNKS + 1);
    if (chunksError) return [];
    if ((chunks || []).length > MAX_PRE_RANK_PDF_CHUNKS) {
      throw preRankLimitError('derived-PDF chunk', MAX_PRE_RANK_PDF_CHUNKS);
    }

    const candidates = (chunks || []).filter((chunk) =>
      chunk?.id && chunk?.source_id && chunk?.provenance?.fileId
    );
    if (!candidates.length) return [];
    const sourceIds = [...new Set(candidates.map((chunk) => chunk.source_id))];
    const fileIds = [...new Set(candidates.map((chunk) => chunk.provenance.fileId))];
    if (sourceIds.length > MAX_PRE_RANK_PDF_SOURCES) {
      throw preRankLimitError('derived-PDF source', MAX_PRE_RANK_PDF_SOURCES);
    }
    if (fileIds.length > MAX_PRE_RANK_PDF_FILES) {
      throw preRankLimitError('derived-PDF file', MAX_PRE_RANK_PDF_FILES);
    }
    const [resourcesResult, filesResult] = await Promise.all([
      supabase
        .from('resource')
        .select('id, target_url')
        .eq('tenant_id', tenantId)
        .in('id', sourceIds),
      supabase
        .from('file_repository')
        .select('id, file_url, bucket, storage_path, folder_id')
        .eq('tenant_id', tenantId)
        .in('id', fileIds),
    ]);
    if (resourcesResult.error || filesResult.error) return [];
    const resources = new Map((resourcesResult.data || []).map((row) => [row.id, row]));
    const files = new Map((filesResult.data || []).map((row) => [row.id, row]));
    // Bulk source/file reads above are bounded.  Evaluate each distinct
    // resource-file pair once (rather than once per PDF page chunk), so folder
    // ancestry and gallery-policy reads cannot scale with chunk count.
    const pairs = new Map();
    for (const chunk of candidates) {
      const resource = resources.get(chunk.source_id);
      const file = files.get(chunk.provenance.fileId);
      if (!resource || !file || file.file_url !== resource.target_url) continue;
      const key = `${chunk.source_id}:${chunk.provenance.fileId}`;
      if (!pairs.has(key)) pairs.set(key, { resource, file });
    }
    const accessByPair = new Map();
    await Promise.all([...pairs.entries()].map(async ([key, { file }]) => {
      accessByPair.set(key, await isResourcePdfFileAccessible({
        supabase, file, visibilityCtx,
      }));
    }));
    return candidates
      .filter((chunk) => accessByPair.get(`${chunk.source_id}:${chunk.provenance.fileId}`))
      .map((chunk) => chunk.id);
  } catch (error) {
    if (error?.code === 'MEMBER_CONTENT_PRERANK_LIMIT') throw error;
    return [];
  }
}

/**
 * Compare a chunk's activation generation with the source registry maintained
 * by the indexing lifecycle.  This is deliberately separate from the CMS
 * `updated_at` convention: several established source tables do not have that
 * column and a source generation also fences dependent file/symbol changes.
 *
 * The lifecycle migration owns `member_content_source` and must maintain
 * `(tenant_id, content_type, source_id, generation)` atomically whenever
 * source content or access changes.  Until that migration and a fenced
 * reindex are live, old chunks have no generation and fail closed.
 */
export async function resolveCurrentSourceGenerations({
  supabase,
  tenantId,
  candidates,
}) {
  const sourceIds = [...new Set([
    ...(candidates || []).map((candidate) => candidate?.source_id),
    ...(candidates || []).flatMap((candidate) =>
      Array.isArray(candidate?.provenance?.dependencies)
        ? candidate.provenance.dependencies.map((dependency) => dependency?.sourceId)
        : []
    ),
  ].filter(Boolean))];
  if (!sourceIds.length) return new Map();
  const { data, error } = await supabase
    .from('member_content_source')
    .select('content_type, source_id, active_generation')
    .eq('tenant_id', tenantId)
    .in('source_id', sourceIds);
  // The registry is a security dependency.  A missing migration/RLS failure
  // must result in no AI context, not a fallback to stale vector metadata.
  if (error) return null;
  return new Map(
    (data || [])
      .filter((row) => row?.content_type && row?.source_id && normalizeGeneration(row.active_generation) !== null)
      .map((row) => [`${row.content_type}:${row.source_id}`, row])
  );
}

function normalizeGeneration(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return value;
  return null;
}

export function isSourceGenerationCurrent(chunkGeneration, registryGeneration) {
  const chunk = normalizeGeneration(chunkGeneration);
  const current = normalizeGeneration(registryGeneration);
  return chunk !== null && current !== null && chunk === current;
}

/**
 * Re-read candidate source rows and apply the normal current access contract.
 * A missing/error source is denied rather than preserving stale index text.
 */
export async function revalidateMemberContentCandidates({
  supabase,
  candidates,
  visibilityCtx,
  accessibleEventIds = new Set(),
  accessibleSessionIds: suppliedAccessibleSessionIds = null,
}) {
  if (!supabase || !visibilityCtx?.tenantId || !Array.isArray(candidates)) return [];
  const currentGenerations = await resolveCurrentSourceGenerations({
    supabase,
    tenantId: visibilityCtx.tenantId,
    candidates,
  });
  if (!currentGenerations) return [];
  const sourceRows = new Map();
  const idsByType = new Map();
  for (const candidate of candidates) {
    const cfg = CONTENT_TYPE_CONFIG[candidate?.content_type];
    if (!cfg || !candidate?.source_id) continue;
    if (!idsByType.has(candidate.content_type)) idsByType.set(candidate.content_type, new Set());
    idsByType.get(candidate.content_type).add(candidate.source_id);
  }
  for (const [type, ids] of idsByType) {
    const cfg = CONTENT_TYPE_CONFIG[type];
    let query = supabase
      .from(cfg.table)
      // Source generations are the freshness fence.  Do not assume every
      // legacy CMS table has `updated_at`; source access needs only the
      // authoritative fields in the rest of this configured projection.
      .select(cfg.columns
        .split(',')
        .map((column) => column.trim())
        .filter((column) => column !== 'updated_at')
        .join(', '))
      .eq('tenant_id', visibilityCtx.tenantId)
      .in('id', [...ids]);
    if (cfg.filterEq) {
      for (const [column, value] of Object.entries(cfg.filterEq)) query = query.eq(column, value);
    }
    const { data, error } = await query;
    if (error) throw error;
    for (const row of data || []) sourceRows.set(`${type}:${row.id}`, row);
  }
  const canvasMicrositeIds = [...sourceRows.values()]
    .filter((row) => row.microsite_id)
    .map((row) => row.microsite_id);
  if (canvasMicrositeIds.length) {
    const { data, error } = await supabase
      .from('microsite')
      .select('id, path_prefix, is_active')
      .eq('tenant_id', visibilityCtx.tenantId)
      .in('id', [...new Set(canvasMicrositeIds)]);
    if (error) throw error;
    const activeSites = new Map((data || [])
      .filter((microsite) => microsite.is_active === true)
      .map((microsite) => [microsite.id, microsite]));
    for (const [key, source] of sourceRows) {
      if (!key.startsWith('canvas_page:') || !source.microsite_id) continue;
      const site = activeSites.get(source.microsite_id);
      // Availability is an access rule, including for members/admins and
      // history replay. Never trust an old active generation or stored prefix.
      if (!site) sourceRows.delete(key);
      else source._micrositePrefix = site.path_prefix || '';
    }
  }
  const pdfFileIds = new Set(
    candidates
      .filter((candidate) => candidate?.provenance?.kind === 'resource_pdf')
      .map((candidate) => candidate.provenance.fileId)
      .filter(Boolean)
  );
  const pdfFilesById = new Map();
  if (pdfFileIds.size) {
    const { data, error } = await supabase
      .from('file_repository')
      .select('id, file_url, bucket, storage_path, folder_id')
      .eq('tenant_id', visibilityCtx.tenantId)
      .in('id', [...pdfFileIds]);
    if (error) throw error;
    for (const file of data || []) pdfFilesById.set(file.id, file);
  }

  // Resource category access is intentionally evaluated from its authoritative
  // current rows, not copied into embeddings.  If category access cannot be
  // resolved, protected-category sources fail closed.
  let hiddenSubcategories = null;
  if (candidates.some((c) => c?.content_type === 'resource')) {
    const categories = await fetchCategoriesWithAccess(supabase, visibilityCtx.tenantId);
    hiddenSubcategories = computeHiddenSubcategories(categories, {
      roleId: visibilityCtx.roleId,
      isPrivileged: visibilityCtx.isAdmin,
    });
  }
  const resourceSources = [...sourceRows.entries()]
    .filter(([key]) => key.startsWith('resource:'))
    .map(([, source]) => source);
  const accessibleSessionIds = visibilityCtx.isAdmin
    ? new Set()
    : suppliedAccessibleSessionIds instanceof Set
      ? suppliedAccessibleSessionIds
    : await resolveLinkedSessionEntitlements({
      supabase,
      tenantId: visibilityCtx.tenantId,
      member: visibilityCtx.member,
      resources: resourceSources,
    });

  const authorized = [];
  for (const candidate of candidates) {
    const source = sourceRows.get(`${candidate.content_type}:${candidate.source_id}`);
    if (!source) continue;
    const registry = currentGenerations.get(
      `${candidate.content_type}:${candidate.source_id}`
    );
    if (
      !registry ||
      !isSourceGenerationCurrent(candidate.source_generation, registry.active_generation)
    ) continue;
    const dependencies = candidate?.provenance?.dependencies;
    // Indexed derived text is usable only while every declared source
    // dependency remains on its activated registry generation. This covers
    // Canvas symbols and repository PDFs without assuming updated_at columns.
    if (
      (candidate?.provenance?.kind === 'resource_pdf' && !Array.isArray(dependencies)) ||
      (Array.isArray(dependencies) && !dependencies.every((dependency) => {
        const dependencyRegistry = currentGenerations.get(
          `${dependency?.contentType}:${dependency?.sourceId}`
        );
        return isSourceGenerationCurrent(
          dependency?.generation,
          dependencyRegistry?.active_generation
        );
      }))
    ) continue;
    const current = {
      ...candidate,
      ...buildMemberContentMetadata(candidate.content_type, source),
      // A member-only Canvas projection remains member-only even if the source
      // row itself is public/hybrid.
      access_scope: candidate.access_scope || 'public',
    };
    if (candidate?.provenance?.kind === 'resource_pdf') {
      const file = pdfFilesById.get(candidate.provenance.fileId);
      if (
        !file ||
        file.file_url !== source.target_url ||
        !(await isResourcePdfFileAccessible({
          supabase,
          file,
          visibilityCtx,
        }))
      ) continue;
    }
    if (!isChunkVisibleToMember(current, visibilityCtx)) continue;
    if (
      current.content_type === 'resource' &&
      hiddenSubcategories &&
      isResourceHiddenByCategories(source, hiddenSubcategories)
    ) {
      continue;
    }
    if (
      current.content_type === 'resource' &&
      !visibilityCtx.isAdmin &&
      !linkedResourceIsEntitled(source.linked_events, accessibleEventIds, accessibleSessionIds)
    ) {
      continue;
    }
    authorized.push(current);
  }
  return authorized;
}