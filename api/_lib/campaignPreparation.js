import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

export const preparationContext = new AsyncLocalStorage();
export const PREPARATION_BUDGET_MS = 14_000;
const MARGIN_MS = 1500;
export class PreparationYield extends Error {
  constructor() { super('Campaign preparation budget exhausted; checkpoint retained'); this.code = 'PREPARATION_YIELD'; }
}

export function preparationError(error) {
  return Object.assign(new Error(error?.message || String(error)), {
    code: error?.code, status: error?.status, retryable: error?.retryable,
  });
}

// Unknown failures are terminal: silently retrying invalid policy/configuration
// forever is worse than requiring operator review. Only known operational
// failures and quota shortages retain the resumable generation.
export function isRetryablePreparationError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  const code = String(error?.code || '');
  return /^(08|40|53)/.test(code) ||
    /^(55P03|57014|57P01|57P02|57P03|PGRST000|PGRST001|PGRST002|PGRST003|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)$/.test(code) ||
    [408,429,500,502,503,504].includes(Number(error?.status)) ||
    /(?:plan .*quota exceeded|plan quota exceeded|unable to authorize campaign quota|fetch failed|failed to fetch|network error|connection reset|socket hang up|statement timeout)/i.test(error?.message || '');
}

// Async-local routing never replaces a process-global client while concurrent
// campaigns/requests are executing. Only audience resolution enters this scope.
export function preparationDatabase(db) {
  if (!db) return db;
  return new Proxy(db, { get(target, key) {
    const client = preparationContext.getStore()?.db || target;
    const value = client[key];
    return typeof value === 'function' ? value.bind(client) : value;
  } });
}

export async function preparationStep(db, generation, owner, action, payload = {}) {
  const { data, error } = await db.rpc('campaign_preparation_step', {
    p_generation: generation, p_owner: owner, p_action: action, p_payload: payload,
  });
  if (error) throw preparationError(error);
  return data;
}

// Read results are a durable journal, not a Promise.race around running writes.
// Each lookup loads only the requested read, never all prior history. Failed or
// aborted reads are never checkpointed. The proxy throws DB errors even for
// legacy resolver branches which previously ignored the error property.
export function journalDatabase(db, state, owner, deadline, now = Date.now) {
  const check = () => { if (now() >= deadline - MARGIN_MS) throw new PreparationYield(); };
  let sequence = 0;
  const pages = new Map();
  const pageSize = 8;
  const loadPage = (index, signal) => {
    if (!pages.has(index)) {
      // Bounded read-ahead avoids one network round trip per replayed query.
      // Retain at most two pages rather than loading all generation history.
      if (pages.size >= 2) pages.delete(pages.keys().next().value);
      pages.set(index, db.from('campaign_preparation_read').select('sequence,key,result')
        .eq('generation', state.id).eq('segment', state.segment)
        .gte('sequence', index * pageSize).lt('sequence', (index + 1) * pageSize)
        .order('sequence').limit(pageSize).abortSignal(signal).then(result => {
          if (result.error) throw result.error;
          return result.data || [];
        }));
    }
    return pages.get(index);
  };
  const build = (table, calls = []) => new Proxy({}, { get(_, method) {
    if (method === 'then') return (resolve, reject) => (async () => {
      check();
      const querySequence = sequence++;
      const key = createHash('sha256').update(JSON.stringify([table, calls])).digest('hex');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - now() - MARGIN_MS));
      try {
        const rows = await loadPage(Math.floor(querySequence / pageSize), controller.signal);
        let cached = rows.find(row => row.key === key);
        // Promise.all branches may resume in a different order on replay.
        // Query identity, not timing/order of completion, is authoritative.
        if (!cached) {
          const exact = await db.from('campaign_preparation_read').select('result')
            .eq('generation', state.id).eq('segment', state.segment).eq('key', key)
            .abortSignal(controller.signal).maybeSingle();
          if (exact.error) throw exact.error;
          cached = exact.data;
        }
        check();
        if (cached) {
          return structuredClone(cached.result);
        }
        let query = typeof table === 'string' ? db.from(table) : db.rpc(table.rpc, table.args);
        for (const [name, args] of calls) query = query[name](...args);
        const result = await (typeof query.abortSignal === 'function' ? query.abortSignal(controller.signal) : query);
        if (result.error) throw result.error;
        // The reserved margin is for checkpointing a successfully completed
        // read. Yield before the NEXT read, not before saving this progress.
        const saved = { data: result.data, count: result.count ?? null, error: null };
        await preparationStep(db, state.id, owner, 'read', {
          segment: state.segment, sequence: querySequence, key, result: saved,
        });
        return saved;
      } catch (error) {
        if (controller.signal.aborted) throw new PreparationYield();
        throw error;
      } finally { clearTimeout(timer); }
    })().then(resolve, reject);
    if (['insert', 'update', 'delete', 'upsert'].includes(method)) {
      throw new Error('Audience preparation must not mutate source data');
    }
    return (...args) => build(table, [...calls, [method, args]]);
  } });
  return { from: table => build(table), rpc: (name, args) => {
    if (!['campaign_preparation_email_members','campaign_preparation_attended_bookings'].includes(name)) {
      throw new Error('Audience resolution attempted an unauthorized RPC');
    }
    return build({ rpc: name, args });
  } };
}

export async function prepareCampaignAudience({
  db, generation, resolve, resolveChunk, authorize, quota, deadline = Date.now() + PREPARATION_BUDGET_MS,
  now = Date.now, owner = randomUUID(),
}) {
  let state = await preparationStep(db, generation, owner, 'claim');
  if (!state) return { success: true, status: 'preparing', busy: true };
  const check = () => { if (now() >= deadline - MARGIN_MS) throw new PreparationYield(); };
  try {
    if (state.authorization_error) throw new Error(state.authorization_error);
    check();
    await authorize(state.snapshot);
    const segments = state.snapshot.target_audiences?.length
      ? state.snapshot.target_audiences
      : [{ type: state.snapshot.target_type, ids: state.snapshot.target_ids || [] }];
    while (state.phase === 'resolve' && state.segment < segments.length) {
      check();
      const journal = journalDatabase(db, state, owner, deadline, now);
      if (resolveChunk) {
        const chunk = await resolveChunk({ db: journal, state });
        // This mutation commits output, facts and continuation together.
        // Completed transitions delete their tiny read journal; only an
        // interrupted single transition is ever replayed.
        state = await preparationStep(db, generation, owner, 'stream', {
          segment: state.segment, expected: state.continuation || {},
          continuation: chunk.continuation, done: chunk.done === true,
          facts: chunk.facts || [], candidates: chunk.candidates || [],
        });
        continue;
      }
      const result = await preparationContext.run({ db: journal, at: state.snapshot.sent_at }, () =>
        resolve({ ...state.snapshot, target_audiences: [segments[state.segment]] }, state.tenant_id));
      check();
      if (!result.success) throw new Error(result.error || 'Audience resolution failed');
      while (state.cursor < result.recipients.length) {
        check();
        const recipients = result.recipients.slice(state.cursor, state.cursor + 200).map(r => ({
          member_id: r.member_id !== undefined ? r.member_id : r.id,
          email: r.email, first_name: r.first_name || '', last_name: r.last_name || '',
          bypass_opt_out: r.bypass_opt_out === true,
        }));
        state = await preparationStep(db, generation, owner, 'stage', {
          segment: state.segment, cursor: state.cursor, recipients,
        });
      }
      check();
      state = await preparationStep(db, generation, owner, 'segment', { segment: state.segment });
    }
    if (state.phase === 'resolve') {
      check();
      state = await preparationStep(db, generation, owner, resolveChunk ? 'stream_resolved' : 'resolved');
    }
    while (['global_consent','consent'].includes(state.phase)) {
      check();
      state = await preparationStep(db, generation, owner, state.phase, { cursor: state.cursor });
    }
    if (state.phase === 'quota') {
      check();
      const result = await quota(state.tenant_id, { addingCount: state.total });
      if (!result.ok) throw Object.assign(new Error(result.body?.error || 'Unable to authorize campaign quota'), { retryable: true });
      check();
      state = await preparationStep(db, generation, owner, 'quota');
    }
    while (state.phase === 'insert' && state.cursor < state.total) {
      check();
      state = await preparationStep(db, generation, owner, 'insert', { cursor: state.cursor });
    }
    if (state.phase === 'insert') {
      check();
      // Quota and authority are fresh at promotion, including a retry days
      // after quota approval. Nothing can be submitted before this checkpoint.
      await authorize(state.snapshot);
      const result = await quota(state.tenant_id, { addingCount: state.total });
      if (!result.ok) throw Object.assign(new Error(result.body?.error || 'Unable to authorize campaign quota'), { retryable: true });
      check();
      state = await preparationStep(db, generation, owner, 'complete');
    }
    return { success: true, status: 'sending', totalRecipients: state.total };
  } catch (error) {
    const yielded = error instanceof PreparationYield || error.code === 'PREPARATION_YIELD'
      || (error.name === 'AbortError' && now() >= deadline - MARGIN_MS);
    const retryable = yielded || isRetryablePreparationError(error);
    // Await release. If cancellation won, its lock has already fenced all
    // later writes and the lease may harmlessly expire.
    let failed = false;
    try {
      await preparationStep(db, generation, owner, retryable ? 'release' : 'fail', { error: yielded ? null : error.message });
      failed = !retryable;
    } catch (checkpointError) {
      // A concurrent cancellation/version change wins. Never claim that a
      // terminal checkpoint committed when its fenced mutation was rejected.
      return { success: false, error: error.message, checkpointError: checkpointError.message };
    }
    return { success: yielded, status: failed ? 'failed' : 'preparing', preparationPending: !failed,
      retryable, terminal: failed,
      ...(yielded ? { budgetExhausted: true } : { error: error.message }) };
  }
}