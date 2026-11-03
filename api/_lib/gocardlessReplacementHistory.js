// Historical identities remain evidence, not current collection authority.
export async function replacementPaymentPlan(db, { subscriptionId, mandateId, paymentId, plan }) {
  if (!subscriptionId && (!plan || !mandateId || !paymentId)) return null;
  let query = db.from('membership_mandate_replacements').select('*');
  query = subscriptionId ? query.eq('snapshot->subscription->>id', subscriptionId)
    : query.eq('tenant_id', plan.tenant_id).eq('old_mandate_id', mandateId);
  const result = await query.in('phase', ['retire_intent', 'complete']).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (['42P01', 'PGRST205'].includes(result.error?.code)) return null;
  if (result.error) throw new Error('Historical mandate authority unavailable');
  const operation = result.data;
  if (!operation?.snapshot?.plan?.id) return null;
  if (plan && (operation.snapshot.plan.id !== plan.id
      || !operation.snapshot.payments.some(p => p.id === paymentId && p.links?.mandate === mandateId))) return null;
  const current = await db.from('membership_payment_plans').select('*')
    .eq('id', operation.snapshot.plan.id).eq('tenant_id', operation.tenant_id).maybeSingle();
  if (current.error) throw new Error('Historical payment plan unavailable');
  return current.data ? { ...current.data, gocardless_mandate_id: operation.old_mandate_id } : null;
}
