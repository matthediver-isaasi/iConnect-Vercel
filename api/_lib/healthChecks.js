import { supabase, supabaseServiceKey, supabaseUrl } from './database.js';

export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2_000;
export const DEFAULT_HEALTH_OVERALL_TIMEOUT_MS = 5_000;

function safeUrl(value) {
  return typeof value === 'string' && value.trim() ? value.replace(/\/+$/, '') : '';
}

function asStatus(value) {
  return value ? 'ok' : 'error';
}

async function boundedProbe(probe, timeoutMs, overallSignal) {
  let timer = null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let removeOverallAbortListener = null;
  try {
    const overallAbort = overallSignal
      ? new Promise((resolve) => {
        if (overallSignal.aborted) {
          controller?.abort();
          resolve(false);
          return;
        }
        const onAbort = () => {
          controller?.abort();
          resolve(false);
        };
        overallSignal.addEventListener('abort', onAbort, { once: true });
        removeOverallAbortListener = () => overallSignal.removeEventListener('abort', onAbort);
      })
      : new Promise(() => {});
    return await Promise.race([
      Promise.resolve().then(() => probe(controller?.signal)).then(Boolean).catch(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
      overallAbort,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    removeOverallAbortListener?.();
    controller?.abort();
  }
}

async function probeDatabase(dbClient, signal) {
  if (!dbClient) return false;
  let query = dbClient.from('tenant').select('id').limit(1);
  if (signal && typeof query.abortSignal === 'function') {
    query = query.abortSignal(signal);
  }
  const { error } = await query;
  return !error;
}

async function probeAuth(url, serviceKey, fetchImpl, signal) {
  if (!url || !serviceKey || typeof fetchImpl !== 'function') return false;
  const response = await fetchImpl(`${safeUrl(url)}/auth/v1/health`, {
    method: 'GET',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    ...(signal ? { signal } : {}),
  });
  return Boolean(response?.ok);
}

async function probeStorage(dbClient, signal) {
  if (!dbClient?.storage) return false;
  const { error } = await dbClient.storage.from('public-assets').list('', {
    limit: 1,
    offset: 0,
  }, signal ? { signal } : undefined);
  return !error;
}

/**
 * Run the three external dependency checks in parallel. Individual probes
 * deliberately return only booleans; callers never receive provider errors.
 */
export async function runHealthChecks({
  dbClient = supabase,
  url = supabaseUrl,
  serviceKey = supabaseServiceKey,
  fetchImpl = globalThis.fetch,
  probeTimeoutMs = DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
  overallTimeoutMs = DEFAULT_HEALTH_OVERALL_TIMEOUT_MS,
} = {}) {
  const statuses = { database: 'error', auth: 'error', storage: 'error' };
  const overallController = typeof AbortController === 'function' ? new AbortController() : null;
  const probes = [
    ['database', (signal) => probeDatabase(dbClient, signal)],
    ['auth', (signal) => probeAuth(url, serviceKey, fetchImpl, signal)],
    ['storage', (signal) => probeStorage(dbClient, signal)],
  ];

  let overallTimer;
  const allProbes = Promise.all(probes.map(async ([name, probe]) => {
    const passed = await boundedProbe(probe, probeTimeoutMs, overallController?.signal);
    statuses[name] = asStatus(passed);
  }));

  try {
    await Promise.race([
      allProbes,
      new Promise((resolve) => {
        overallTimer = setTimeout(() => {
          overallController?.abort();
          resolve();
        }, Math.max(1, overallTimeoutMs));
      }),
    ]);
  } finally {
    if (overallTimer) clearTimeout(overallTimer);
  }

  return statuses;
}