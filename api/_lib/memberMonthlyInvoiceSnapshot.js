// Project only NEW invoice context at the original collection/service date.
// Existing invoice IDs still follow the pay-only recovery branch; neither the
// original agreement nor historical invoice addresses are rewritten.
export async function projectMonthlyInstalmentSnapshot({db,agreement,snapshot,getPaymentDate}){
  if(snapshot?.collection_price_snapshot || !agreement?.member_id) return snapshot;
  const key=snapshot?.commitment?.term_key;
  if(!key) return snapshot;
  const {data:op,error}=await db.from('member_amendment_provider_operation').select('*')
    .eq('tenant_id',agreement.tenant_id).eq('member_id',agreement.member_id).eq('state','finalized')
    .eq('prepared->input->agreement->>id',agreement.id).eq('prepared->input->authority->>termKey',key).maybeSingle();
  if(error){
    if(['42P01','PGRST205'].includes(error.code))return snapshot;
    throw new Error('Applied monthly invoice scope could not be read.');
  }
  if(!op)return snapshot;
  const app=op.evidence?.application,config=app?.targetSnapshot?.config,band=app?.targetSnapshot?.band;
  if(op.tenant_id!==agreement.tenant_id || op.member_id!==agreement.member_id
    || op.prepared?.input?.agreement?.id!==agreement.id || op.prepared.input.authority?.termKey!==key
    || app?.operationId!==op.id || config?.tenant_id!==agreement.tenant_id || config.structure_scope_type!=='member'
    || app.expiresOn!==snapshot.commitment.membership_renewal_date){
    throw new Error('Applied monthly invoice scope is inconsistent.');
  }
  const date=await getPaymentDate();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw new Error('Original monthly collection date is required for amended invoicing.');
  if(date<app.effectiveDate || date>=app.expiresOn)return snapshot;
  const collectionPrice={
    membership_revision_id:op.id,config_id:config.id,band_id:band?.id||null,config,band:band||null,
    currency:snapshot.currency,tier_label:band?.label||'Flat Rate',
    vat_rate:band?band.vat_rate??null:config.flat_vat_rate??null,
    nominal_code:band?.nominal_code||config.nominal_code||null,
  };
  return {...snapshot,...collectionPrice,collection_price_snapshot:collectionPrice};
}
