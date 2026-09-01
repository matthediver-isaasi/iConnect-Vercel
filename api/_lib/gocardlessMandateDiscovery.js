import { createGocardlessClient } from './gocardless.js';
import { getTenantGocardlessCredentials } from './gocardlessCredentials.js';

export function normalizeDiscoveryEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function summaryFromRows(rows) {
  const summary = {
    total_count: rows.length, matched_count: 0, unmatched_count: 0,
    ambiguous_count: 0, failed_count: 0,
  };
  for (const row of rows) summary[`${row.match_outcome}_count`] += 1;
  return summary;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function loadMembersByEmail(db, tenantId) {
  const members = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db.from('member')
      .select('id, email').eq('tenant_id', tenantId)
      .order('id', { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`Member matching failed: ${error.message}`);
    members.push(...(data || []));
    if ((data || []).length < pageSize) break;
  }
  const byEmail = new Map();
  for (const member of members) {
    const email = normalizeDiscoveryEmail(member.email);
    if (!email) continue;
    const list = byEmail.get(email) || [];
    list.push(member.id);
    byEmail.set(email, list);
  }
  return byEmail;
}

export async function getLatestMandateDiscoveryBatch({ db, tenantId }) {
  const { data, error } = await db.from('gocardless_mandate_discovery_batch')
    .select('id, environment, status, total_count, matched_count, unmatched_count, ambiguous_count, failed_count, error_message, started_at, completed_at')
    .eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Could not load mandate discovery: ${error.message}`);
  return data || null;
}

export async function runMandateDiscovery({
  db, tenantId, actorEmail = null,
  credentialsLoader = getTenantGocardlessCredentials,
  clientFactory = createGocardlessClient,
}) {
  const creds = await credentialsLoader(tenantId, { db });
  if (creds.source !== 'tenant' || String(creds.tenantId) !== String(tenantId)) {
    throw new Error('Tenant-specific GoCardless credentials are required');
  }
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const { error: reclaimError } = await db
    .from('gocardless_mandate_discovery_batch')
    .update({
      status: 'failed',
      error_message: 'The previous sync stopped before it completed and was released for retry.',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId)
    .eq('status', 'running')
    .lt('updated_at', staleBefore);
  if (reclaimError) throw new Error(`Could not check active mandate discovery: ${reclaimError.message}`);

  const { data: batch, error: batchError } = await db
    .from('gocardless_mandate_discovery_batch')
    .insert({ tenant_id: tenantId, environment: creds.environment, status: 'running', started_by: actorEmail })
    .select().single();
  if (batchError) {
    if (batchError.code === '23505') throw new Error('A mandate discovery sync is already running');
    throw new Error(`Could not start mandate discovery: ${batchError.message}`);
  }

  const gc = clientFactory(creds);
  const rows = [];
  let terminalError = null;
  try {
    const membersByEmail = await loadMembersByEmail(db, tenantId);
    let after = null;
    const seenCursors = new Set();
    do {
      if (after && seenCursors.has(after)) throw new Error('GoCardless returned a repeated pagination cursor');
      if (after) seenCursors.add(after);
      const page = await gc.listMandatesPage({ after, limit: 100 });
      const pageRows = await mapWithConcurrency(page.mandates, 10, async (mandate) => {
        const customerId = mandate.links?.customer || null;
        const base = {
          tenant_id: tenantId, batch_id: batch.id,
          gocardless_mandate_id: mandate.id,
          mandate_status: mandate.status || null,
          environment: creds.environment,
          gocardless_customer_id: customerId,
        };
        try {
          if (!customerId) throw new Error('Mandate has no linked customer');
          const customer = await gc.getCustomer(customerId);
          const email = normalizeDiscoveryEmail(customer?.email);
          const matches = email ? (membersByEmail.get(email) || []) : [];
          return {
            ...base,
            customer_email: customer?.email || null,
            normalized_email: email || null,
            matched_member_id: matches.length === 1 ? matches[0] : null,
            match_outcome: matches.length === 1 ? 'matched' : matches.length > 1 ? 'ambiguous' : 'unmatched',
            error_message: null,
          };
        } catch (error) {
          return { ...base, customer_email: null,
            normalized_email: null, matched_member_id: null, match_outcome: 'failed',
            error_message: error.message || 'Customer retrieval failed' };
        }
      });
      if (pageRows.length) {
        const { error: pageWriteError } = await db.from('gocardless_mandate_discovery_row')
          .upsert(pageRows, { onConflict: 'batch_id,gocardless_mandate_id' });
        if (pageWriteError) throw new Error(`Could not stage discovered mandates: ${pageWriteError.message}`);
        rows.push(...pageRows);
      }
      const { error: heartbeatError } = await db.from('gocardless_mandate_discovery_batch')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', batch.id).eq('tenant_id', tenantId);
      if (heartbeatError) throw new Error(`Could not maintain mandate discovery lease: ${heartbeatError.message}`);
      after = page.after;
    } while (after);
  } catch (error) {
    terminalError = error;
  }

  const counts = summaryFromRows(rows);
  const status = terminalError ? (rows.length ? 'partial' : 'failed') : (counts.failed_count ? 'partial' : 'complete');
  const completed = {
    ...counts, status,
    error_message: terminalError?.message || (counts.failed_count ? 'Some customer records could not be retrieved' : null),
    completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const { data: finalBatch, error: updateError } = await db
    .from('gocardless_mandate_discovery_batch')
    .update(completed).eq('id', batch.id).eq('tenant_id', tenantId).select().single();
  if (updateError) throw new Error(`Could not finalize mandate discovery: ${updateError.message}`);
  return finalBatch;
}