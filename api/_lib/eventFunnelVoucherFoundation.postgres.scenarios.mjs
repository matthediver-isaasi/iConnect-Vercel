import assert from 'node:assert/strict';

export async function exerciseFunnelVoucherFoundation({db,connect,uuid,tenant,member,sql}) {
  await db.query(`ALTER TABLE organization ADD voucher_allowed_role_ids jsonb DEFAULT '[]';
    CREATE TABLE voucher(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid NOT NULL,value numeric,status text,
      issued_at timestamptz DEFAULT now(),expires_at timestamptz,valid_from timestamptz,used_at timestamptz,funding_source text);
    CREATE TABLE voucher_transaction(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,voucher_id uuid,
      organization_id uuid,member_id uuid,amount numeric,balance_before numeric,balance_after numeric,type text,
      booking_reference text,notes text,created_at timestamptz DEFAULT now());`);
  await db.query(await sql('202610200001_individual_voucher_credit.sql'));
  await db.query(`INSERT INTO system_settings(tenant_id,setting_key,setting_value) VALUES($1,'individual_vouchers_enabled','true')`,[tenant]);
  const voucher=uuid(300);
  await db.query(`SELECT set_config('app.voucher_credit_write','yes',false)`);
  await db.query(`INSERT INTO voucher(id,tenant_id,member_id,value,status,expires_at)
    VALUES($1,$2,$3,40,'active',clock_timestamp()+interval '1 year')`,[voucher,tenant,member]);
  await db.query(`SELECT set_config('app.voucher_credit_write','',false)`);
  const reserve=(client,key,minor)=>client.query(`SELECT voucher_credit_reserve($1,$2,$3,$3,$4,$5,'GBP',true,false) r`,
    [tenant,key,member,[voucher],minor]);
  const peer=await connect();
  const race=await Promise.all([reserve(db,'funnel-foundation-a',3000),reserve(peer,'funnel-foundation-b',3000)]);
  assert.equal(race.reduce((sum,result)=>sum+result.rows[0].r.voucherMinor,0),4000);
  assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[voucher])).rows[0].value),0);
  // The aggregate adapter must reject a short reservation rather than silently
  // increase the card charge. The existing ledger itself never over-reserves.
  assert.ok(race.some(result=>result.rows[0].r.voucherMinor===1000));
  for(const key of ['funnel-foundation-a','funnel-foundation-b']) {
    await db.query(`SELECT voucher_credit_transition($1,$2,'release','not_started')`,[tenant,key]);
  }
  assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[voucher])).rows[0].value),40);
  await reserve(db,'funnel-foundation-commit',2000);
  await db.query(`SELECT voucher_credit_transition($1,'funnel-foundation-commit','commit',NULL)`,[tenant]);
  await db.query(`SELECT voucher_credit_transition($1,'funnel-foundation-commit','commit',NULL)`,[tenant]);
  assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[voucher])).rows[0].value),20);
  assert.equal((await db.query(`SELECT count(*)::int n FROM voucher_transaction WHERE booking_reference='funnel-foundation-commit' AND type='booking_usage'`)).rows[0].n,1);
}
