/**
 * Destination-only GET transport for workforce validation. No RPC or write path.
 * Every collection is ordered, paginated, and reconciled to an exact count.
 */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

export const PROJECT = 'lvmzliemqnieeoruhkik';
export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const SURVEY = '931df885-c3b7-449a-b206-eef31fb9e883';
export const ROW = 'bf123bdb-7227-4f45-b5f9-8344d0f65446';
const TABLES = new Set(['tenant', 'custom_object_definition', 'preference_field',
  'custom_object_relationship_definition', 'custom_object_record', 'custom_object_relationship']);

export function getOnlyFetch(fetchImpl = fetch) {
  return (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (options.method || input.method || 'GET').toUpperCase();
    if (method !== 'GET' || url.origin !== `https://${PROJECT}.supabase.co`
      || !TABLES.has(url.pathname.replace('/rest/v1/', ''))
      || !url.pathname.startsWith('/rest/v1/')) {
      throw new Error('Read-only audit allows only destination table GET requests.');
    }
    return fetchImpl(input, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  };
}

export function destinationClient() {
  if (process.env.DEST_SUPABASE_URL?.replace(/\/$/, '') !== `https://${PROJECT}.supabase.co`
    || !process.env.DEST_SUPABASE_KEY) {
    throw new Error('Destination credentials unavailable or project pin mismatch; no alternate database is allowed.');
  }
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: getOnlyFetch() },
  });
}

export async function readPages(db, table, columns, configure, ledger, label = table) {
  if (!TABLES.has(table)) throw new Error('Table not permitted.');
  const rows = [];
  const seen = new Set();
  let total;
  let requests = 0;
  do {
    const { data, error, count } = await configure(db.from(table).select(columns, { count: 'exact' })
      .order('id', { ascending: true }).range(rows.length, rows.length + 499));
    requests++;
    if (error) throw new Error(`${label} read failed (${error.code || 'transport'}).`);
    if (!Array.isArray(data) || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label} did not return rows and an exact count.`);
    }
    if (total !== undefined && count !== total) throw new Error(`${label} changed during pagination.`);
    total = count;
    for (const row of data) {
      if (!row.id || seen.has(row.id)) throw new Error(`${label} repeated or missing record ID.`);
      seen.add(row.id);
      rows.push(row);
    }
    if (rows.length > total || (!data.length && rows.length < total)) {
      throw new Error(`${label} pagination incomplete.`);
    }
  } while (rows.length < total);
  ledger.push({ label, table, count: total, rowsRead: rows.length, requests, pageSize: 500, complete: true });
  return rows;
}

export async function loadState(db, departmentIds) {
  const ledger = [];
  const tenant = await readPages(db, 'tenant', 'id,name,slug', q => q.eq('id', TENANT), ledger);
  if (tenant.length !== 1 || tenant[0].id !== TENANT
    || !['BNMS', 'British Nuclear Medicine Society'].includes(tenant[0].name)) {
    throw new Error('Destination tenant identity does not match BNMS / British Nuclear Medicine Society.');
  }
  const objects = await readPages(db, 'custom_object_definition', '*', q => q.eq('tenant_id', TENANT), ledger);
  const relevantIds = [...new Set([SURVEY, ROW, ...objects.filter(x => x.object_key === 'org_department').map(x => x.id)])];
  const [fields, definitions, records, edges] = await Promise.all([
    readPages(db, 'preference_field', '*', q => q.eq('tenant_id', TENANT).in('custom_object_id', relevantIds), ledger),
    readPages(db, 'custom_object_relationship_definition', '*', q => q.eq('tenant_id', TENANT), ledger),
    readPages(db, 'custom_object_record', 'id,tenant_id,custom_object_id,archived_at,data',
      q => q.eq('tenant_id', TENANT).in('custom_object_id', relevantIds), ledger),
    readPages(db, 'custom_object_relationship', '*', q => q.eq('tenant_id', TENANT), ledger),
  ]);
  const departments = [];
  // Explicit UUID-only lookup deliberately does not tenant-filter: it distinguishes
  // missing IDs from foreign IDs without fetching foreign record data.
  for (let i = 0; i < departmentIds.length; i += 50) {
    departments.push(...await readPages(db, 'custom_object_record',
      'id,tenant_id,custom_object_id,archived_at', q => q.in('id', departmentIds.slice(i, i + 50)),
      ledger, `Department UUIDs ${i + 1}-${Math.min(i + 50, departmentIds.length)}`));
  }
  const workforceIds = records.filter(x => [SURVEY, ROW].includes(x.custom_object_id)).map(x => x.id);
  const touching = new Map(edges.map(x => [x.id, x]));
  for (let i = 0; i < workforceIds.length; i += 50) {
    const ids = workforceIds.slice(i, i + 50).join(',');
    const found = await readPages(db, 'custom_object_relationship', '*',
      q => q.or(`source_record_id.in.(${ids}),target_record_id.in.(${ids})`),
      ledger, `Workforce incident edges ${i + 1}-${Math.min(i + 50, workforceIds.length)}`);
    found.forEach(x => touching.set(x.id, x));
  }
  return { tenant: tenant[0], objects, fields, definitions, records,
    edges: [...touching.values()].sort((a, b) => a.id.localeCompare(b.id)), departments, ledger };
}

export function stateFingerprint(state) {
  const { ledger, ...data } = state;
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}