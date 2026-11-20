import { randomUUID } from 'node:crypto';
import { validateReportSort, reportDefinitionKey } from '../../shared/customObjectReportSort.mjs';
import { CSV_BOM, CSV_ROW_SEPARATOR, escapeCsvCell } from './csvCell.js';

// A sorted report is collected in bounded natural-cursor pages, then ordered
// once in PostgreSQL. Preview and CSV read the same immutable ranked rows.
export function createReportSortService({ db, tenantId, context, now, validate, execute, ErrorType }) {
  const fail = (status, message) => { throw new ErrorType(status, message); };
  const checked = result => {
    if (result.error) fail(['42P01', 'PGRST202', 'PGRST205'].includes(result.error.code) ? 503 : 500,
      /42P01|PGRST202|PGRST205/.test(result.error.code || '')
        ? 'Sorted reports require migration 20261120_custom_object_report_sort.sql.'
        : result.error.message || 'Sorted report database operation failed');
    return result.data;
  };
  function owned(query, objectId, mode) {
    query = query.eq('tenant_id', tenantId).eq('custom_object_id', objectId).eq('mode', mode);
    if (context.tenantUserId) return query.eq('requested_by_tenant_user_id', context.tenantUserId);
    if (context.memberId) return query.eq('requested_by_member_id', context.memberId);
    fail(403, 'Report requires an authenticated owner');
  }
  const publicJob = job => ({
    ...job, claim_token: undefined,
    status: job.status === 'ready' ? 'complete' : job.status,
    chunk_count: job.status === 'ready' ? Math.ceil(Number(job.processed) / job.chunk_size) || 1 : 0,
  });
  async function load(objectId, mode, id, definition) {
    const job = checked(await owned(db.from('custom_object_report_sort_job').select('*'), objectId, mode)
      .eq('id', id).maybeSingle());
    if (!job) fail(404, 'Sorted report was not found');
    if (new Date(job.expires_at).getTime() <= Date.now()) fail(410, 'Sorted report expired. Prepare the report again.');
    if (definition && reportDefinitionKey(job.definition) !== reportDefinitionKey(definition)) fail(409, 'Report definition changed. Prepare the report again.');
    await validate(objectId, job.definition);
    return job;
  }
  async function start(objectId, mode, body) {
    const definition = body.definition;
    const validated = await validate(objectId, definition);
    const rules = validateReportSort(definition);
    if (!rules.length) fail(400, 'A sorted report needs at least one sort rule');
    const hop = validated.grain.hops.at(-1);
    const many = hop && (hop.definition.cardinality === 'many_to_many'
      || (hop.definition.cardinality === 'one_to_many' && hop.fromSide === 'source')
      || (hop.definition.cardinality === 'many_to_one' && hop.fromSide === 'target'));
    if (validated.report.version === 1 && hop && (validated.grain.hops.length !== 1 || !many)) {
      fail(400, 'Sorting a complex legacy report requires a new current-version report; the saved legacy report was not changed.');
    }
    // Bound retention cleanup as well as collection: avoid a large cascade in
    // a serverless request when an old snapshot contains many rows.
    checked(await db.rpc('custom_object_report_sort_prune', { p_tenant_id: tenantId }));
    const filename = `${String(body.name || 'custom-object-report').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'report'}.csv`;
    return checked(await db.from('custom_object_report_sort_job').insert({
      tenant_id: tenantId, custom_object_id: objectId, mode, definition,
      sort_rules: rules, filename, headers: [], status: 'queued',
      requested_by_member_id: context.tenantUserId ? null : context.memberId || null,
      requested_by_tenant_user_id: context.tenantUserId || null,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      created_at: now(), updated_at: now(),
    }).select('*').single());
  }
  async function process(objectId, mode, job) {
    if (['ready', 'failed'].includes(job.status)) return job;
    const claim = randomUUID();
    if (job.claim_token && Date.now() - new Date(job.updated_at).getTime() < 120_000) return job;
    let q = owned(db.from('custom_object_report_sort_job').update({
      claim_token: claim, status: 'processing', updated_at: now(),
    }), objectId, mode).eq('id', job.id).eq('next_page', job.next_page);
    q = job.claim_token ? q.eq('claim_token', job.claim_token) : q.is('claim_token', null);
    const claimed = checked(await q.select('*').maybeSingle());
    if (!claimed) return load(objectId, mode, job.id);
    try {
      const result = await execute(objectId, job.definition, {
        page: job.next_page, pageSize: job.chunk_size, exportCursor: job.cursor_value,
        includeTotal: job.next_page === 1, sortMaterialization: true,
      });
      if (!result.bounded || !Array.isArray(result.data) || typeof result.has_more !== 'boolean') fail(503, 'Report source did not return a complete bounded page');
      if (result.has_more && (!result.next_cursor || result.next_cursor === job.cursor_value)) fail(503, 'Sorted report source cursor did not advance');
      const updated = checked(await db.rpc('custom_object_report_sort_commit', {
        p_tenant_id: tenantId, p_object_id: objectId, p_job_id: job.id,
        p_claim_token: claim, p_page: job.next_page,
        p_rows: result.data.map(row => ({ id: row.id, values: row.values, sort_values: row.sort_values })),
        p_headers: result.columns.map(c => c.label),
        p_next_cursor: result.next_cursor, p_has_more: result.has_more,
      }));
      if (!updated) fail(409, 'Sorted report claim expired');
      return updated;
    } catch (error) {
      checked(await owned(db.from('custom_object_report_sort_job').update({
        status: 'failed', error_message: error.message, claim_token: null, updated_at: now(),
      }), objectId, mode).eq('id', job.id).eq('claim_token', claim));
      throw error;
    }
  }
  async function page(objectId, job, offset, size) {
    if (job.status !== 'ready') fail(409, 'Sorted report is not ready');
    const rows = checked(await db.from('custom_object_report_sort_row').select('row_identity,row_values,position')
      .eq('tenant_id', tenantId).eq('job_id', job.id).gte('position', offset + 1)
      .lt('position', offset + size + 1).order('position', { ascending: true }).limit(size));
    const expected = Math.min(size, Math.max(0, Number(job.processed) - offset));
    if (!Array.isArray(rows) || rows.length !== expected) fail(503, 'Sorted report result is incomplete');
    return rows.map(r => ({ id: r.row_identity, values: r.row_values }));
  }
  return {
    async preview(objectId, body) {
      const action = body.action || 'start';
      if (!['start', 'process', 'page'].includes(action)) fail(400, 'Unknown sorted preview action');
      let job = action === 'start' ? await start(objectId, 'preview', body)
        : await load(objectId, 'preview', body.job_id, body.definition);
      if (action === 'process') job = await process(objectId, 'preview', job);
      if (job.status !== 'ready') return { sort_job: publicJob(job) };
      const requestedPage = Math.max(1, Number.parseInt(body.page, 10) || 1);
      const size = Math.min(500, Math.max(1, Number.parseInt(body.pageSize, 10) || 50));
      return { sort_job: publicJob(job), columns: job.headers.map(label => ({ label })),
        data: await page(objectId, job, (requestedPage - 1) * size, size), total: Number(job.processed),
        page: requestedPage, pageSize: size, has_more: requestedPage * size < Number(job.processed),
        page_count: Math.ceil(Number(job.processed) / size), bounded: true };
    },
    async export(objectId, body) {
      const action = body.action || 'start';
      if (!['start', 'status', 'process', 'chunk'].includes(action)) fail(400, 'Unknown sorted export action');
      let job = action === 'start' ? await start(objectId, 'export', body)
        : await load(objectId, 'export', body.job_id);
      if (action === 'process') job = await process(objectId, 'export', job);
      if (action !== 'chunk') return publicJob(job);
      const index = Number(body.chunk_index);
      const count = Math.ceil(Number(job.processed) / job.chunk_size) || 1;
      if (!Number.isInteger(index) || index < 0 || index >= count) fail(400, 'Invalid sorted export chunk');
      const rows = await page(objectId, job, index * job.chunk_size, job.chunk_size);
      return { chunk_index: index, csv_text:
        (index === 0 ? CSV_BOM + job.headers.map(escapeCsvCell).join(',') + CSV_ROW_SEPARATOR : '')
        + rows.map(row => row.values.map(escapeCsvCell).join(',')).join(CSV_ROW_SEPARATOR)
        + (rows.length ? CSV_ROW_SEPARATOR : '') };
    },
  };
}
