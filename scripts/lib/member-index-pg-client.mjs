/**
 * The recovery runner cannot use the service-role Supabase URL: only the
 * destination Postgres URL is available to it.  This is a deliberately small
 * Supabase-shaped facade for the generation-aware member-content writer.
 *
 * Security properties of this module are intentional:
 *   - table and column names come only from the allowlists below;
 *   - every value, including limits and JSON repair rows, is a pg parameter;
 *   - member_content_chunk is readable, but has no mutation methods;
 *   - member_content_source only permits the claim-token release CAS;
 *   - only the two generation RPCs used by the recovery writer are callable.
 *
 * It is not a general SQL or Supabase compatibility layer.
 */

import crypto from 'node:crypto';

export const MEMBER_CONTENT_TYPES = Object.freeze([
  'resource',
  'event',
  'complex_event',
  'news_post',
  'blog_post',
  'canvas_page',
]);

const SOURCE_TABLES = Object.freeze({
  resource: 'resource',
  event: 'event',
  complex_event: 'complex_event',
  news_post: 'news_post',
  blog_post: 'blog_post',
  canvas_page: 'i_edit_page',
});

const SOURCE_COLUMNS = Object.freeze({
  resource: Object.freeze([
    'id',
    'tenant_id',
    'title',
    'description',
    'resource_type',
    'author_name',
    'tags',
    'subcategories',
    'status',
    'member_group_id',
    'allowed_role_ids',
    'is_public',
    'linked_events',
    'updated_at',
  ]),
  event: Object.freeze([
    'id',
    'tenant_id',
    'title',
    'slug',
    'summary',
    'description',
    'location',
    'start_date',
    'event_type',
    'is_online',
    'status',
    'event_state',
    'member_group_id',
    'group_event_public',
    'updated_at',
  ]),
  complex_event: Object.freeze([
    'id',
    'tenant_id',
    'title',
    'slug',
    'summary',
    'description',
    'location',
    'start_date',
    'event_type',
    'is_online',
    'status',
    'event_state',
    'member_group_id',
    'group_event_public',
    'updated_at',
  ]),
  news_post: Object.freeze([
    'id',
    'tenant_id',
    'title',
    'slug',
    'summary',
    'content',
    'author_name',
    'tags',
    'subcategories',
    'status',
    'published_date',
    'updated_at',
  ]),
  blog_post: Object.freeze([
    'id',
    'tenant_id',
    'title',
    'slug',
    'summary',
    'content',
    'tags',
    'subcategories',
    'status',
    'published_date',
    'updated_at',
  ]),
  canvas_page: Object.freeze([
    'id',
    'tenant_id',
    'title',
    'slug',
    'canvas_design',
    'status',
    'layout_type',
    'builder_type',
    'updated_at',
  ]),
});

// The deployed generation-aware schema has used these fields for the source
// queue.  Keeping this list explicit means a source query can never turn into
// SELECT * as the schema evolves.
const MEMBER_CONTENT_SOURCE_COLUMNS = Object.freeze([
  'id',
  'tenant_id',
  'content_type',
  'source_id',
  'source_generation',
  'active_generation',
  'generation',
  'claim_token',
  'claim_started_at',
  'claim_expires_at',
  'updated_at',
  'created_at',
]);

const MEMBER_CONTENT_CHUNK_COLUMNS = Object.freeze([
  'id',
  'tenant_id',
  'content_type',
  'source_id',
  'slug',
  'title',
  'chunk_index',
  'content',
  'link',
  'status',
  'event_state',
  'member_group_id',
  'group_event_public',
  'allowed_role_ids',
  'is_public',
  'published_date',
  'start_date',
  'feature_key',
  'content_hash',
  'embedding',
  'embedding_model',
  'provenance',
  'metadata',
  'source',
  'access_scope',
  'linked_events',
  'subcategories',
  'created_at',
  'updated_at',
  'source_generation',
  'is_active',
]);

const TABLE_COLUMNS = Object.freeze({
  member_content_chunk: MEMBER_CONTENT_CHUNK_COLUMNS,
  member_content_source: MEMBER_CONTENT_SOURCE_COLUMNS,
  resource: SOURCE_COLUMNS.resource,
  event: SOURCE_COLUMNS.event,
  complex_event: SOURCE_COLUMNS.complex_event,
  news_post: SOURCE_COLUMNS.news_post,
  blog_post: SOURCE_COLUMNS.blog_post,
  i_edit_page: SOURCE_COLUMNS.canvas_page,
});

const RPC_ARGUMENTS = Object.freeze({
  claim_member_content_generation: Object.freeze([
    'p_tenant_id',
    'p_content_type',
    'p_source_id',
  ]),
  publish_member_content_repair: Object.freeze([
    'p_tenant_id',
    'p_content_type',
    'p_source_id',
    'p_generation',
    'p_claim_token',
    'p_rows',
  ]),
});

const PUBLISH_ROW_COLUMNS = new Set([
  'tenant_id',
  'content_type',
  'source_id',
  'slug',
  'title',
  'chunk_index',
  'content',
  'link',
  'status',
  'event_state',
  'member_group_id',
  'group_event_public',
  'allowed_role_ids',
  'is_public',
  'published_date',
  'start_date',
  'feature_key',
  'content_hash',
  'embedding',
  'embedding_model',
  'provenance',
  'metadata',
  'source',
  'access_scope',
  'linked_events',
  'subcategories',
  'updated_at',
  'source_generation',
  'is_active',
]);

const TABLE_SET = new Set(Object.keys(TABLE_COLUMNS));
const QUOTED_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const RUN_QUERY = Symbol('member-index-run-query');

function quoteIdentifier(identifier) {
  // This check is defensive even though all callers use the frozen maps.
  if (!QUOTED_IDENTIFIER.test(identifier)) {
    throw new Error('MEMBER_INDEX_IDENTIFIER_NOT_ALLOWED');
  }
  return `"${identifier}"`;
}

function tableColumns(table) {
  if (!TABLE_SET.has(table)) throw new Error('MEMBER_INDEX_TABLE_NOT_ALLOWED');
  return TABLE_COLUMNS[table];
}

function assertColumn(table, column) {
  if (typeof column !== 'string' || !tableColumns(table).includes(column)) {
    throw new Error('MEMBER_INDEX_COLUMN_NOT_ALLOWED');
  }
  return column;
}

function parseSelectColumns(table, selection) {
  if (typeof selection !== 'string' || !selection.trim()) {
    throw new Error('MEMBER_INDEX_SELECT_COLUMNS_REQUIRED');
  }
  const columns = selection
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
  if (!columns.length || columns.some((column) => !tableColumns(table).includes(column))) {
    throw new Error('MEMBER_INDEX_COLUMN_NOT_ALLOWED');
  }
  return [...new Set(columns)];
}

function errorCode(error, fallback = 'MEMBER_INDEX_PG_ERROR') {
  const code = error?.code;
  return typeof code === 'string' && code.length > 0 ? code : fallback;
}

/**
 * Error values intentionally contain a code only.  Postgres error messages
 * can contain SQL values, and source text/credentials must never be printed by
 * the recovery command.
 */
export function safePgError(error, fallback) {
  return { code: errorCode(error, fallback) };
}

function resultError(error, fallback) {
  return { data: null, error: safePgError(error, fallback) };
}

function assertFiniteInteger(value, name, { min = 0, max = 10000 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`MEMBER_INDEX_${name.toUpperCase()}_INVALID`);
  }
}

const POSTGRES_INT8_MAX = 9223372036854775807n;

function isPositiveGeneration(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0;
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    return false;
  }
  try {
    return BigInt(value) <= POSTGRES_INT8_MAX;
  } catch {
    return false;
  }
}

function assertRpcArgs(name, args) {
  const expected = RPC_ARGUMENTS[name];
  if (!expected || !args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('MEMBER_INDEX_RPC_NOT_ALLOWED');
  }
  const keys = Object.keys(args).sort();
  const expectedKeys = [...expected].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('MEMBER_INDEX_RPC_ARGUMENTS_INVALID');
  }

  const readinessProbe =
    name === 'publish_member_content_repair' &&
    args.p_tenant_id === null &&
    args.p_content_type === null &&
    args.p_source_id === null &&
    args.p_generation === null &&
    args.p_claim_token === null &&
    Array.isArray(args.p_rows) &&
    args.p_rows.length === 0;
  if (readinessProbe) return { readinessProbe: true };

  const requiredValues = ['p_tenant_id', 'p_content_type', 'p_source_id'];
  for (const key of requiredValues) {
    if (args[key] === null || args[key] === undefined) {
      throw new Error('MEMBER_INDEX_RPC_ARGUMENTS_INVALID');
    }
  }
  if (!MEMBER_CONTENT_TYPES.includes(args.p_content_type)) {
    throw new Error('MEMBER_INDEX_CONTENT_TYPE_INVALID');
  }

  if (name === 'publish_member_content_repair') {
    if (
      !isPositiveGeneration(args.p_generation) ||
      !args.p_claim_token ||
      !Array.isArray(args.p_rows) ||
      args.p_rows.length > 500
    ) {
      throw new Error('MEMBER_INDEX_RPC_ARGUMENTS_INVALID');
    }
    for (const row of args.p_rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('MEMBER_INDEX_REPAIR_ROWS_INVALID');
      }
      if (Object.keys(row).some((key) => !PUBLISH_ROW_COLUMNS.has(key))) {
        throw new Error('MEMBER_INDEX_REPAIR_ROW_COLUMN_NOT_ALLOWED');
      }
    }
  }
  return { readinessProbe: false };
}

function rpcSql(name) {
  if (name === 'claim_member_content_generation') {
    return (
      'SELECT * FROM public.claim_member_content_generation(' +
      '$1::uuid, $2::text, $3::uuid)'
    );
  }
  if (name === 'publish_member_content_repair') {
    return (
      'SELECT * FROM public.publish_member_content_repair(' +
      '$1::uuid, $2::text, $3::uuid, $4::bigint, $5::uuid, $6::jsonb)'
    );
  }
  throw new Error('MEMBER_INDEX_RPC_NOT_ALLOWED');
}

function asPromise(value) {
  return Promise.resolve(value);
}

class ReadQueryBuilder {
  constructor(facade, table) {
    this.facade = facade;
    this.table = table;
    this.operation = null;
    this.selected = null;
    this.filters = [];
    this.ordering = null;
    this.maxRows = null;
    this.single = false;
  }

  select(selection) {
    if (this.operation && this.operation !== 'select') {
      throw new Error('MEMBER_INDEX_SELECT_AFTER_UPDATE_NOT_ALLOWED');
    }
    this.operation = 'select';
    this.selected = parseSelectColumns(this.table, selection);
    return this;
  }

  eq(column, value) {
    assertColumn(this.table, column);
    this.filters.push({ operator: 'eq', column, value });
    return this;
  }

  gt(column, value) {
    assertColumn(this.table, column);
    if (value === null || value === undefined) {
      throw new Error('MEMBER_INDEX_GT_VALUE_REQUIRED');
    }
    this.filters.push({ operator: 'gt', column, value });
    return this;
  }

  order(column, options = {}) {
    assertColumn(this.table, column);
    if (options === null || typeof options !== 'object') {
      throw new Error('MEMBER_INDEX_ORDER_OPTIONS_INVALID');
    }
    const ascending = options.ascending === undefined ? true : options.ascending;
    if (typeof ascending !== 'boolean') {
      throw new Error('MEMBER_INDEX_ORDER_OPTIONS_INVALID');
    }
    this.ordering = { column, ascending };
    return this;
  }

  limit(value) {
    assertFiniteInteger(value, 'limit', { min: 0, max: 5000 });
    this.maxRows = value;
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  async execute() {
    if (this.operation !== 'select' || !this.selected) {
      throw new Error('MEMBER_INDEX_SELECT_REQUIRED');
    }

    const values = [];
    const where = [];
    for (const filter of this.filters) {
      const identifier = quoteIdentifier(filter.column);
      if (filter.operator === 'eq' && filter.value === null) {
        where.push(`${identifier} IS NULL`);
        continue;
      }
      values.push(filter.value);
      where.push(
        `${identifier} ${filter.operator === 'eq' ? '=' : '>'} $${values.length}`,
      );
    }

    const sqlParts = [
      `SELECT ${this.selected.map(quoteIdentifier).join(', ')}`,
      `FROM "public".${quoteIdentifier(this.table)}`,
    ];
    if (where.length) sqlParts.push(`WHERE ${where.join(' AND ')}`);
    if (this.ordering) {
      sqlParts.push(
        `ORDER BY ${quoteIdentifier(this.ordering.column)} ${
          this.ordering.ascending ? 'ASC' : 'DESC'
        }`,
      );
    }
    if (this.maxRows !== null) {
      values.push(this.maxRows);
      sqlParts.push(`LIMIT $${values.length}`);
    } else if (this.single) {
      // Fetch one extra row so maybeSingle can report the Supabase-compatible
      // cardinality code without including either row in the error value.
      values.push(2);
      sqlParts.push(`LIMIT $${values.length}`);
    }

    const result = await this.facade[RUN_QUERY](sqlParts.join(' '), values);
    if (result.error) return result;
    const rows = result.rows || [];
    if (this.single) {
      if (rows.length === 0) {
        return { data: null, error: null };
      }
      if (rows.length > 1) {
        return {
          data: null,
          error: {
            code: 'PGRST116',
          },
        };
      }
      return { data: rows[0], error: null };
    }
    return { data: rows, error: null };
  }

  then(resolve, reject) {
    return asPromise(this.execute()).then(resolve, reject);
  }

  catch(reject) {
    return asPromise(this.execute()).catch(reject);
  }

  finally(handler) {
    return asPromise(this.execute()).finally(handler);
  }
}

class SourceQueryBuilder extends ReadQueryBuilder {
  update(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('MEMBER_INDEX_SOURCE_UPDATE_INVALID');
    }
    const keys = Object.keys(values);
    if (
      keys.length !== 2 ||
      !keys.includes('claim_token') ||
      !keys.includes('claim_started_at') ||
      values.claim_token !== null ||
      values.claim_started_at !== null
    ) {
      throw new Error('MEMBER_INDEX_SOURCE_UPDATE_NOT_ALLOWED');
    }
    if (this.operation) throw new Error('MEMBER_INDEX_SOURCE_UPDATE_INVALID');
    this.operation = 'update';
    this.updateValues = values;
    return this;
  }

  async execute() {
    if (this.operation !== 'update') return super.execute();
    if (this.ordering || this.maxRows !== null || this.single || this.selected) {
      throw new Error('MEMBER_INDEX_SOURCE_UPDATE_INVALID');
    }
    const required = new Set([
      'tenant_id',
      'content_type',
      'source_id',
      'generation',
      'claim_token',
    ]);
    const present = new Set(this.filters.map((filter) => filter.column));
    if (
      present.size !== required.size ||
      this.filters.length !== required.size ||
      [...required].some((column) => !present.has(column))
    ) {
      throw new Error('MEMBER_INDEX_SOURCE_CAS_REQUIRED');
    }
    if (this.filters.some((filter) => filter.column === 'claim_token' && filter.value === null)) {
      throw new Error('MEMBER_INDEX_SOURCE_CAS_REQUIRED');
    }

    const values = [null, null];
    const where = [];
    for (const filter of this.filters) {
      const identifier = quoteIdentifier(filter.column);
      if (filter.operator !== 'eq') throw new Error('MEMBER_INDEX_SOURCE_UPDATE_INVALID');
      if (filter.value === null) {
        where.push(`${identifier} IS NULL`);
      } else {
        values.push(filter.value);
        where.push(`${identifier} = $${values.length}`);
      }
    }
    const sql =
      `UPDATE "public"."member_content_source" ` +
      `SET "claim_token" = $1, "claim_started_at" = $2 ` +
      `WHERE ${where.join(' AND ')}`;
    const result = await this.facade[RUN_QUERY](sql, values, { write: true });
    if (result.error) return result;
    return { data: null, error: null };
  }
}

export class MemberIndexPgClient {
  constructor({ client, allowWrites = true } = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('MEMBER_INDEX_PG_CLIENT_REQUIRED');
    }
    this.#client = client;
    this.#allowWrites = allowWrites === true;
  }

  #client;
  #allowWrites;

  from(table) {
    tableColumns(table);
    if (table === 'member_content_source') {
      return new SourceQueryBuilder(this, table);
    }
    return new ReadQueryBuilder(this, table);
  }

  /**
   * A narrow Supabase-style RPC surface.  The SQL function names and argument
   * order are fixed; callers cannot execute an arbitrary function.  The one
   * exception is the exact all-null/empty-row publisher readiness probe,
   * whose function contract returns false before a source row can match.
   */
  rpc(name, args) {
    const { readinessProbe } = assertRpcArgs(name, args);
    if (!this.#allowWrites && !readinessProbe) {
      return Promise.resolve(resultError(null, 'MEMBER_INDEX_DRY_RUN_WRITE_BLOCKED'));
    }
    const sql = rpcSql(name);
    const values =
      name === 'claim_member_content_generation'
        ? [args.p_tenant_id, args.p_content_type, args.p_source_id]
        : [
            args.p_tenant_id,
            args.p_content_type,
            args.p_source_id,
            args.p_generation,
            args.p_claim_token,
            JSON.stringify(args.p_rows),
          ];
    return this[RUN_QUERY](sql, values, { write: !readinessProbe }).then((result) => {
      if (result.error) return resultError(result.error);
      if (name === 'publish_member_content_repair') {
        const rows = result.rows || [];
        if (rows.length === 1) {
          const row = rows[0];
          if (typeof row === 'boolean') return { data: row, error: null };
          if (row && typeof row === 'object') {
            const values = Object.values(row);
            if (values.length === 1 && typeof values[0] === 'boolean') {
              return { data: values[0], error: null };
            }
          }
        }
      }
      return { data: result.rows || [], error: null };
    });
  }

  async [RUN_QUERY](sql, values, { write = false } = {}) {
    if (write && !this.#allowWrites) {
      return resultError(null, 'MEMBER_INDEX_DRY_RUN_WRITE_BLOCKED');
    }
    try {
      const result = await this.#client.query(sql, values);
      return result || { rows: [] };
    } catch (error) {
      return resultError(error);
    }
  }

  /**
   * Read-only, bounded aggregate view used before and after a repair.  This
   * is intentionally not exposed as a general query method.
   */
  async readScopedAggregateCounts({ tenantId, contentType, duplicateLimit = 10 } = {}) {
    if (tenantId === null || tenantId === undefined) {
      throw new Error('MEMBER_INDEX_TENANT_REQUIRED');
    }
    if (contentType !== null && !MEMBER_CONTENT_TYPES.includes(contentType)) {
      throw new Error('MEMBER_INDEX_CONTENT_TYPE_INVALID');
    }
    assertFiniteInteger(duplicateLimit, 'duplicate_limit', { min: 1, max: 100 });

    const typeWhere =
      contentType === null
        ? '"content_type" = ANY($2::text[])'
        : '"content_type" = $2';
    const typeValue = contentType === null ? MEMBER_CONTENT_TYPES : contentType;
    const countSql =
      'SELECT count(*)::int AS chunks, ' +
      'count(*) FILTER (WHERE "embedding" IS NOT NULL)::int AS embedded, ' +
      'count(*) FILTER (WHERE "is_active" IS TRUE)::int AS active ' +
      'FROM "public"."member_content_chunk" ' +
      `WHERE "tenant_id" = $1 AND ${typeWhere}`;
    const duplicateSql =
      'SELECT count(*)::int AS duplicate_groups FROM (' +
      'SELECT "content_type", "source_id", "chunk_index" ' +
      'FROM "public"."member_content_chunk" ' +
      `WHERE "tenant_id" = $1 AND ${typeWhere} ` +
      'GROUP BY "content_type", "source_id", "chunk_index" ' +
      'HAVING count(*) > 1 ' +
      'ORDER BY "content_type", "source_id", "chunk_index" ' +
      'LIMIT $3) AS bounded_duplicates';

    const counts = await this[RUN_QUERY](countSql, [tenantId, typeValue]);
    if (counts.error) return { data: null, error: counts.error };
    const duplicates = await this[RUN_QUERY](duplicateSql, [
      tenantId,
      typeValue,
      duplicateLimit,
    ]);
    if (duplicates.error) return { data: null, error: duplicates.error };

    const countRow = counts.rows?.[0] || {};
    const duplicateRow = duplicates.rows?.[0] || {};
    return {
      data: {
        chunks: Number(countRow.chunks || 0),
        embedded: Number(countRow.embedded || 0),
        active: Number(countRow.active || 0),
        duplicateGroups: Number(duplicateRow.duplicate_groups || 0),
        duplicateLimit,
      },
      error: null,
    };
  }

  /**
   * Read a bounded source plan without invoking a claim or writer.  The
   * returned rows are intentionally only operational metadata; callers should
   * not print them.  This exists for the dry-run command because a denied
   * claim is not a useful dry-run plan.
   */
  async readScopedSourcePlan({
    tenantId,
    contentType = null,
    maxItems = 2,
    cursor = null,
    deadlineMs = null,
  } = {}) {
    if (tenantId === null || tenantId === undefined) {
      throw new Error('MEMBER_INDEX_TENANT_REQUIRED');
    }
    if (contentType !== null && !MEMBER_CONTENT_TYPES.includes(contentType)) {
      throw new Error('MEMBER_INDEX_CONTENT_TYPE_INVALID');
    }
    assertFiniteInteger(maxItems, 'max_items', { min: 1, max: 5 });

    const types = contentType ? [contentType] : Object.keys(SOURCE_TABLES);
    const resumeType = cursor?.type || null;
    const resumeAfterId = cursor?.lastId ?? null;
    const startIndex = resumeType ? types.indexOf(resumeType) : 0;
    const typesToRun = startIndex >= 0 ? types.slice(startIndex) : types;
    let items = 0;

    for (let typeIndex = 0; typeIndex < typesToRun.length; typeIndex += 1) {
      const type = typesToRun[typeIndex];
      let lastId =
        typeIndex === 0 && resumeType === type ? resumeAfterId : null;
      if (deadlineMs != null && Date.now() >= deadlineMs) {
        return {
          data: { items, done: false, nextCursor: { type, lastId } },
          error: null,
        };
      }

      let query = this
        .from(SOURCE_TABLES[type])
        .select('id, tenant_id')
        .eq('tenant_id', tenantId)
        .order('id', { ascending: true })
        .limit(Math.max(1, maxItems - items));
      if (lastId !== null) query = query.gt('id', lastId);
      const result = await query;
      if (result.error) return { data: null, error: result.error };
      const rows = result.data || [];
      if (!rows.length) continue;

      for (const row of rows) {
        items += 1;
        lastId = row.id;
        if (items >= maxItems) {
          return {
            data: {
              items,
              done: false,
              nextCursor: { type, lastId },
            },
            error: null,
          };
        }
        if (deadlineMs != null && Date.now() >= deadlineMs) {
          return {
            data: {
              items,
              done: false,
              nextCursor: { type, lastId },
            },
            error: null,
          };
        }
      }
    }
    return { data: { items, done: true, nextCursor: null }, error: null };
  }

  /**
   * Hash bounded, ordered chunk identity/content-hash/visibility metadata.
   * Source text, embeddings and titles never leave this method.  In
   * particular, activation_token and updated_at are deliberately absent:
   * both are expected to change while a generation is published.
   */
  async readScopedChunkFingerprint({
    tenantId,
    contentType = null,
    limit = 1000,
  } = {}) {
    if (tenantId === null || tenantId === undefined) {
      throw new Error('MEMBER_INDEX_TENANT_REQUIRED');
    }
    if (contentType !== null && !MEMBER_CONTENT_TYPES.includes(contentType)) {
      throw new Error('MEMBER_INDEX_CONTENT_TYPE_INVALID');
    }
    assertFiniteInteger(limit, 'fingerprint_limit', { min: 1, max: 5000 });
    const typeWhere =
      contentType === null
        ? '"content_type" = ANY($2::text[])'
        : '"content_type" = $2';
    const typeValue = contentType === null ? MEMBER_CONTENT_TYPES : contentType;
    const sql =
      'SELECT "id", "created_at", "content_type", "source_id", "chunk_index", ' +
      '"content_hash", "embedding_model", "provenance", "source_generation", ' +
      '"is_active", "slug", "title", "link", "status", "event_state", ' +
      '"member_group_id", "group_event_public", "allowed_role_ids", ' +
      '"is_public", "published_date", "start_date", "feature_key", ' +
      '"access_scope", "linked_events", "subcategories" ' +
      'FROM "public"."member_content_chunk" ' +
      `WHERE "tenant_id" = $1 AND ${typeWhere} ` +
      'ORDER BY "content_type", "source_id", "chunk_index", "id" ' +
      'LIMIT $3';
    const result = await this[RUN_QUERY](sql, [tenantId, typeValue, limit]);
    if (result.error) return { data: null, error: result.error };
    const rows = result.rows || [];
    const canonical = rows.map((row) => [
      row.id ?? null,
      row.created_at ?? null,
      row.content_type ?? null,
      row.source_id ?? null,
      row.chunk_index ?? null,
      row.content_hash ?? null,
      row.embedding_model ?? null,
      row.provenance ?? null,
      row.source_generation ?? null,
      row.is_active ?? null,
      row.slug ?? null,
      row.title ?? null,
      row.link ?? null,
      row.status ?? null,
      row.event_state ?? null,
      row.member_group_id ?? null,
      row.group_event_public ?? null,
      row.allowed_role_ids ?? null,
      row.is_public ?? null,
      row.published_date ?? null,
      row.start_date ?? null,
      row.feature_key ?? null,
      row.access_scope ?? null,
      row.linked_events ?? null,
      row.subcategories ?? null,
    ]);
    const withIds = crypto
      .createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');
    const withoutIds = crypto
      .createHash('sha256')
      .update(JSON.stringify(canonical.map((row) => row.slice(1))))
      .digest('hex');
    return {
      data: {
        rows: rows.length,
        fingerprint: withIds,
        hashFingerprint: withoutIds,
      },
      error: null,
    };
  }
}

export function createMemberIndexPgClient(options) {
  return new MemberIndexPgClient(options);
}

// Names used by small scripts/tests in earlier recovery work.  Keep aliases
// narrow and explicit rather than exposing a generic database client.
export const createMemberContentPgClient = createMemberIndexPgClient;
export const createMemberIndexSupabaseFacade = createMemberIndexPgClient;

export const MEMBER_INDEX_TABLE_COLUMNS = TABLE_COLUMNS;
export const MEMBER_INDEX_RPC_ARGUMENTS = RPC_ARGUMENTS;
export const MEMBER_INDEX_SOURCE_TABLES = SOURCE_TABLES;
