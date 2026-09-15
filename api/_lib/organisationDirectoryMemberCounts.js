const ID_CHUNK = 200;
const PAGE_SIZE = 500;
const MAX_PAGES = 200;

async function checkedRows(query, message) {
  const result = await query;
  if (result.error) throw new Error(message || result.error.message);
  return result.data || [];
}

async function pagedRows(buildQuery, message) {
  const output = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE;
    const batch = await checkedRows(
      buildQuery().range(start, start + PAGE_SIZE - 1),
      message,
    );
    output.push(...batch);
    if (batch.length < PAGE_SIZE) return output;
  }
  // A full final page is ambiguous: it may be exactly at the supported
  // boundary or may be silently truncated.  Probe one row beyond it before
  // declaring the inventory complete, matching the shared organisation
  // directory pager.
  const probeStart = MAX_PAGES * PAGE_SIZE;
  const probe = await checkedRows(
    buildQuery().range(probeStart, probeStart),
    message,
  );
  if (!probe.length) return output;
  throw new Error(message || 'Organisation directory relationship inventory exceeds the supported size');
}

async function chunkedRows(ids, buildQuery, message) {
  const output = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    output.push(...await pagedRows(
      () => buildQuery(ids.slice(offset, offset + ID_CHUNK)),
      message,
    ));
  }
  return output;
}

function objectMemberTopology(definition, objectIds) {
  const sourceObjectId = String(definition.source_custom_object_id || '');
  const targetObjectId = String(definition.target_custom_object_id || '');
  const objectOnSource = definition.source_kind === 'custom_object'
    && objectIds.has(sourceObjectId)
    && definition.target_kind === 'member'
    && !targetObjectId;
  const objectOnTarget = definition.target_kind === 'custom_object'
    && objectIds.has(targetObjectId)
    && definition.source_kind === 'member'
    && !sourceObjectId;
  if (objectOnSource) {
    return {
      objectId: sourceObjectId,
      objectColumn: 'source_record_id',
      memberColumn: 'target_record_id',
    };
  }
  if (objectOnTarget) {
    return {
      objectId: targetObjectId,
      objectColumn: 'target_record_id',
      memberColumn: 'source_record_id',
    };
  }
  return null;
}

function addToSetMap(map, key, value) {
  const values = map.get(key) || new Set();
  values.add(value);
  map.set(key, values);
}

/**
 * Resolve count-only member totals for related Custom Object records.
 *
 * The returned recordCounts map intentionally has no entries for objects that
 * have no active direct object/member relationship definition.  An entry with
 * a value of zero therefore means that the definition is supported but no
 * eligible members are linked.  This distinction lets the CSV projection
 * render unsupported sources as blank instead of accidentally repeating the
 * organisation count.
 *
 * Only direct edges are considered.  In particular, an object -> organisation
 * edge is never traversed to infer members, and member rows are checked again
 * against their owning organisation and the normal directory visibility
 * boundary.
 */
export async function resolveOrganisationDirectoryMemberCounts({
  db,
  context,
  organizationIds = [],
  fields = [],
  objectValues = new Map(),
}) {
  const organizationSet = new Set(organizationIds.map((id) => String(id)));
  const recordContexts = new Map();
  const objectIds = new Set();

  for (const field of fields) {
    if (field?._kind !== 'object') continue;
    const objectId = String(field._source?.object_id || '');
    if (!objectId) continue;
    objectIds.add(objectId);
    const byOrganization = objectValues.get(field.key);
    if (!(byOrganization instanceof Map)) continue;
    for (const [rawOrganizationId, entries] of byOrganization) {
      const organizationId = String(rawOrganizationId);
      if (!organizationSet.has(organizationId) || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        const recordId = String(entry?.recordId || '');
        if (!recordId) continue;
        const contextKey = `${organizationId}:${objectId}:${recordId}`;
        recordContexts.set(contextKey, {
          organizationId,
          objectId,
          recordId,
        });
      }
    }
  }

  const recordCounts = new Map();
  if (!recordContexts.size || !objectIds.size || !organizationSet.size) {
    return { recordCounts };
  }

  const definitions = await pagedRows(() => db.from('custom_object_relationship_definition')
    .select('id, source_kind, target_kind, source_custom_object_id, target_custom_object_id, status, archived_at')
    .eq('tenant_id', context.tenantId)
    .eq('status', 'active')
    .is('archived_at', null)
    .order('id', { ascending: true }),
  'Organisation directory member relationship inventory exceeds the supported size');
  const topologies = definitions.flatMap((definition) => {
    const topology = objectMemberTopology(definition, objectIds);
    return topology ? [{ ...topology, relationshipId: String(definition.id) }] : [];
  });
  if (!topologies.length) return { recordCounts };

  const supportedObjectIds = new Set(topologies.map((item) => item.objectId));
  for (const [contextKey, record] of recordContexts) {
    if (supportedObjectIds.has(record.objectId)) recordCounts.set(contextKey, 0);
  }
  if (!recordCounts.size) return { recordCounts };

  const contextsByObjectRecord = new Map();
  for (const [contextKey, record] of recordContexts) {
    if (!recordCounts.has(contextKey)) continue;
    addToSetMap(
      contextsByObjectRecord,
      `${record.objectId}:${record.recordId}`,
      contextKey,
    );
  }

  const memberContexts = new Map();
  for (const topology of topologies) {
    const recordIds = [...new Set([...recordContexts.values()]
      .filter((record) => record.objectId === topology.objectId)
      .map((record) => record.recordId))];
    if (!recordIds.length) continue;
    const edges = await chunkedRows(recordIds, (ids) =>
      db.from('custom_object_relationship')
        .select(`id, ${topology.objectColumn}, ${topology.memberColumn}`)
        .eq('tenant_id', context.tenantId)
        .eq('relationship_definition_id', topology.relationshipId)
        .is('archived_at', null)
        .in(topology.objectColumn, ids)
        .order(topology.objectColumn, { ascending: true })
        .order('id', { ascending: true }),
    'Organisation directory member relationship values exceed the supported size');
    for (const edge of edges) {
      const objectRecordId = String(edge[topology.objectColumn] || '');
      const memberId = String(edge[topology.memberColumn] || '');
      if (!objectRecordId || !memberId) continue;
      const contexts = contextsByObjectRecord.get(
        `${topology.objectId}:${objectRecordId}`,
      ) || [];
      for (const contextKey of contexts) addToSetMap(memberContexts, memberId, contextKey);
    }
  }

  const memberIds = [...memberContexts.keys()];
  if (!memberIds.length) return { recordCounts };
  const visibleMembers = await chunkedRows(memberIds, (ids) =>
    db.from('member')
      .select('id, organization_id')
      .eq('tenant_id', context.tenantId)
      .in('id', ids)
      .or('show_in_directory.is.null,show_in_directory.neq.false')
      .or('login_enabled.is.null,login_enabled.neq.false')
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .order('id', { ascending: true }),
  'Organisation directory member inventory exceeds the supported size');
  for (const member of visibleMembers) {
    const organizationId = String(member.organization_id || '');
    for (const contextKey of memberContexts.get(String(member.id)) || []) {
      const record = recordContexts.get(contextKey);
      // The organisation endpoint and member row must agree.  This is
      // important when a malformed/old edge links a record across tenants or
      // organisations and also protects the count from cross-org leakage.
      if (record?.organizationId === organizationId) {
        recordCounts.set(contextKey, (recordCounts.get(contextKey) || 0) + 1);
      }
    }
  }
  return { recordCounts };
}
