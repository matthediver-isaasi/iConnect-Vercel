import { refreshReplacement } from './gocardlessMandateReplacement.js';
import { validateGocardlessProviderContext } from './gocardlessFormProviderContext.js';

export async function routeReplacementEvent(event, { db, gc }) {
  const fields = {
    billing_requests: ['billing_request_id'],
    mandates: ['old_mandate_id', 'new_mandate_id'],
    subscriptions: ['new_subscription_id'],
  };
  const key = { billing_requests: 'billing_request', mandates: 'mandate', subscriptions: 'subscription' }[event.resource_type];
  const id = event.links?.[key];
  if (!id || !fields[event.resource_type]) return null;
  let operation = null;
  for (const field of fields[event.resource_type]) {
    const result = await db.from('membership_mandate_replacements').select('*')
      .eq(field, id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (['42P01', 'PGRST205'].includes(result.error?.code)) return null;
    if (result.error) throw new Error('Replacement event authority unavailable');
    if (result.data) { operation = result.data; break; }
  }
  // The old subscription lives in the immutable purchase snapshot.
  if (!operation && event.resource_type === 'subscriptions') {
    const result = await db.from('membership_mandate_replacements').select('*')
      .eq('snapshot->subscription->>id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (result.error) throw new Error('Historical subscription authority unavailable');
    operation = result.data;
  }
  if (!operation) return null;
  const client = typeof gc.gocardlessForTenant === 'function'
    ? await gc.gocardlessForTenant(operation.tenant_id, { db }) : gc;
  if (validateGocardlessProviderContext(operation.provider_context, client.providerContext,
    { environment: operation.environment })) throw new Error('Replacement event account mismatch');
  if (event.resource_type === 'billing_requests'
      || (event.resource_type === 'mandates' && id === operation.new_mandate_id && operation.status !== 'completed')) {
    await refreshReplacement({ db, gc: client, operation });
    return { handled: true, detail: 'replacement candidate reconciled separately from purchase consent' };
  }
  const retiring = ['stop_intent', 'create_intent', 'verify_successor', 'commit_intent', 'retire_intent', 'complete'].includes(operation.phase);
  if (retiring && ((event.resource_type === 'mandates' && id === operation.old_mandate_id)
      || (event.resource_type === 'subscriptions' && id === operation.snapshot?.subscription?.id))) {
    return { handled: true, detail: 'historical replacement authority; membership cancellation not implied' };
  }
  if (event.resource_type === 'subscriptions' && id === operation.new_subscription_id
      && (operation.status !== 'completed' || ['created', 'customer_approval_granted'].includes(event.action))) {
    return { handled: true, detail: 'replacement subscription creation does not reset existing instalments' };
  }
  return null;
}
