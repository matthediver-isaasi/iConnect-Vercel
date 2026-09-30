#!/usr/bin/env node
// Read-only destination verification. Output is deliberately counts-only.

const PROJECT = 'lvmzliemqnieeoruhkik';
const EXPECTED_ORIGIN = `https://${PROJECT}.supabase.co`;
const originalFetch = globalThis.fetch;

function pinDestinationRuntime(env) {
  if (!env.DEST_SUPABASE_URL || !env.DEST_SUPABASE_KEY) {
    throw new Error('Pinned destination REST credentials are unavailable.');
  }
  const destination = new URL(env.DEST_SUPABASE_URL);
  if (destination.origin !== EXPECTED_ORIGIN
    || destination.username || destination.password || destination.search || destination.hash
    || (destination.pathname !== '/' && destination.pathname !== '')) {
    throw new Error('Destination Supabase origin pin mismatch.');
  }

  // database.js and campaignService.js capture these values during import, so
  // pin them before either module (or any of their dependencies) is loaded.
  env.SUPABASE_URL = destination.origin;
  env.SUPABASE_SERVICE_KEY = env.DEST_SUPABASE_KEY;
  return destination.origin;
}

function installReadOnlyNetworkFence(destinationOrigin) {
  let allowedRequests = 0;
  globalThis.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const method = String(init.method || request?.method || 'GET').toUpperCase();
    const url = new URL(request?.url || input);
    if (!['GET', 'HEAD'].includes(method)
      || url.origin !== destinationOrigin
      || !url.pathname.startsWith('/rest/v1/')) {
      throw new Error('Read-only network fence rejected a mutation or non-destination request.');
    }
    allowedRequests += 1;
    return originalFetch(input, init);
  };
  return () => allowedRequests;
}

async function withSuppressedApplicationLogs(operation) {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await operation();
  } finally {
    Object.assign(console, original);
  }
}

export async function main(env = process.env) {
  const destinationOrigin = pinDestinationRuntime(env);
  const requestCount = installReadOnlyNetworkFence(destinationOrigin);

  try {
    const [{ supabase }, { getTargetRecipients }] = await Promise.all([
      import('../api/_lib/database.js'),
      import('../api/_lib/campaignService.js'),
    ]);
    if (!supabase) throw new Error('Destination database client was not initialized.');

    const { data: lists, error } = await supabase
      .from('audience_list')
      .select('id, tenant_id')
      .eq('category_review_required', false)
      .not('tenant_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(`Valid audience-list lookup failed (${error.code || 'unknown'}).`);

    let listsChecked = 0;
    let resolved = null;
    for (const list of lists || []) {
      listsChecked += 1;
      const result = await withSuppressedApplicationLogs(() => getTargetRecipients({
        target_audiences: [{ type: 'audience_list', ids: [list.id] }],
      }, list.tenant_id, true, false));
      if (result.success) {
        resolved = result;
        // Prefer a non-empty proof, while accepting a genuinely empty valid list.
        if (result.count > 0) break;
      }
    }

    if (!resolved) {
      throw new Error('No existing valid saved audience list could be resolved.');
    }

    console.log(JSON.stringify({
      verified: true,
      readOnly: true,
      writesPerformed: false,
      savedListCount: 1,
      recipientsTotal: resolved.count,
      totalAudienceBeforeSuppression: resolved.stats?.totalAudience ?? null,
      globalOptOuts: resolved.stats?.globalOptOuts ?? null,
      categoryOptOuts: resolved.stats?.categoryOptOuts ?? null,
      duplicatesRemoved: resolved.stats?.duplicatesRemoved ?? null,
      listsChecked,
      restReadRequests: requestCount(),
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      verified: false,
      readOnly: true,
      writesPerformed: false,
      error: error.message,
    }));
    process.exitCode = 1;
  });
}