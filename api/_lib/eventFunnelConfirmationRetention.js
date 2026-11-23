export async function pruneFunnelConfirmations({db}) {
  const result=await db.rpc('event_funnel_confirmation_prune',{p_limit:100});
  if(result.error||!Number.isInteger(result.data)||result.data<0||result.data>100) {
    throw new Error('Confirmation retention requires retry');
  }
  return {status:'complete',redacted:result.data};
}
