import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';
import { isAttestedExpiryOnlyHistory } from '../api/_lib/expiryOnlyRenewalPolicy.js';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const REFERENCE = 'BNMS reviewed nine-record expiry repair: operator approved uniform 90-day grace, then login disabled, no role changes; implementation and production application explicitly authorized.';
export const POLICY = Object.freeze({ renewal_open_days: 90, renewal_grace_days: 90,
  renewal_disable_login: true, renewal_change_role: false, renewal_fallback_role_id: null });
const configurations = {
  full: ['b59692c9-07b0-469d-9f6e-9d314a270926', '2026-2027 Full member', 'Full Membership UK'],
  student: ['57ba60c8-3703-4b2c-83ae-0cf7f0884cf8', '2026-2027 Student', 'Student Membership'],
  associate: ['9b1615b0-0699-487f-8ee5-c34746b72493', '2026-2027 Associate member', 'Associate Membership UK'],
  overseas: ['1e82bb61-a0b3-4e6c-8bad-92cb527cd0ce', '2026-2027 Overseas full member', 'Full Membership Overseas'],
};
export const COHORT = [
  ['c813486a-73b1-5440-ae94-f9dc47eca041','765cb547-4b91-4618-aee2-6fd51685ef67','2026-09-23','full'],
  ['c7e0ba7d-c00e-55ed-a6f0-405a6a406e30','a82eb311-6afc-4e55-855b-0e66e079e880','2026-09-26','full'],
  ['43be9722-d585-51d4-aff4-b4c18ac41ed4','e87c30c0-c3d0-42a7-a85c-5005e5c1f141','2026-09-26','full'],
  ['defca80d-7eb2-5702-aefe-c3bb96552e5b','2d8ccea5-c596-48c2-b741-f9da4f5fb972','2026-09-30','full'],
  ['ad520dc4-5a78-5499-a1c7-602fee481c38','a3ec0f52-697a-4cbb-b47c-7eb68bc02300','2026-10-01','full'],
  ['f5e78ad7-c629-5f77-a6d8-d7551e297403','a75d0431-e908-4e1d-8620-4ee2b0e2048d','2026-09-26','student'],
  ['1cc9ce64-658e-5da1-af8e-ded41dc599c6','273ddbe8-878a-451b-bd36-6c757a89927d','2026-09-30','student'],
  ['a8d2429b-1a25-5f19-abe7-a9ceee73a10d','a82cfa2a-f9c5-4c03-a685-9135078a7043','2026-09-26','associate'],
  ['0ff50f40-15b1-567f-a4d1-c353d9342fae','d91d8aa3-4981-4ba0-b923-ab6ccb092f9f','2026-09-29','overseas'],
].map(([history_id,member_id,expiry_date,kind]) => {
  const [config_id,config_name,tier_label] = configurations[kind];
  return { history_id,member_id,expiry_date,config_id,config_name,tier_label,kind };
});
export const migrationUrl = new URL('../supabase/migrations/20261129_bnms_reviewed_overseas_expiry_exception.sql', import.meta.url);

export async function repair(client, { apply = false } = {}) {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const snapshots = [];
    for (const a of COHORT) {
      const { rows } = await client.query(`SELECT to_jsonb(h) history,to_jsonb(c) config
        FROM member_membership_history h JOIN membership_tier_config c ON c.id=$3 AND c.tenant_id=h.tenant_id
        WHERE h.id=$1 AND h.tenant_id=$2 ${apply ? 'FOR UPDATE OF h,c' : ''}`,
      [a.history_id,TENANT,a.config_id]);
      const { history: h, config: c } = rows[0] || {};
      if (rows.length !== 1 || !isAttestedExpiryOnlyHistory(h,TENANT)
          || h.member_id !== a.member_id || h.term_end_date !== a.expiry_date
          || h.tier_label !== a.tier_label || h.expiry_enforced_at != null
          || c.name !== a.config_name || c.structure_scope_type !== 'member'
          || c.billing_period !== 'annual' || c.is_active !== true
          || c.effective_from > a.expiry_date || c.effective_to != null) {
        throw new Error(`Reviewed binding changed: ${a.history_id}`);
      }
      const expected = a.kind === 'overseas' ? { ...POLICY,renewal_open_days:0,renewal_grace_days:0,renewal_disable_login:false } : POLICY;
      if (Object.entries(expected).some(([key,value])=>c[key] !== value)) throw new Error('Reviewed tier settings changed');
      const saved = (await client.query('SELECT to_jsonb(p) assignment FROM membership_expiry_policy_assignment p WHERE history_id=$1',[a.history_id])).rows[0]?.assignment;
      const assignment = { tenant_id:TENANT,history_id:a.history_id,member_id:a.member_id,
        config_id:a.config_id,config_name:a.config_name,expiry_date:a.expiry_date,
        policy_snapshot:POLICY,approval_source:'operator',approval_reference:REFERENCE };
      if (saved && Object.entries(assignment).some(([k,v])=>!isDeepStrictEqual(saved[k],v))) throw new Error('Conflicting existing assignment');
      snapshots.push({ a,h,c,saved,assignment });
    }
    let inserted = 0;
    if (apply) {
      await client.query(await readFile(migrationUrl,'utf8'));
      for (const row of snapshots) {
        if (!row.saved) {
          const keys = Object.keys(row.assignment);
          const values = keys.map(k=>k==='policy_snapshot'?JSON.stringify(row.assignment[k]):row.assignment[k]);
          await client.query(`INSERT INTO membership_expiry_policy_assignment (${keys.join(',')})
            VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,values);
          inserted++;
        }
        const after = (await client.query(`SELECT to_jsonb(h) history,to_jsonb(c) config
          FROM member_membership_history h JOIN membership_tier_config c ON c.id=$2 WHERE h.id=$1`,
        [row.a.history_id,row.a.config_id])).rows[0];
        if (!isDeepStrictEqual(after.history,row.h) || !isDeepStrictEqual(after.config,row.c)) throw new Error('Historical record or tier unexpectedly changed');
      }
    }
    await client.query('COMMIT');
    return { destination:'DEST',apply,reviewed:snapshots.length,inserted,alreadyAssigned:snapshots.filter(r=>r.saved).length };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function main(args = process.argv.slice(2), connect = connectDestination) {
  const hash = createHash('sha256').update(await readFile(new URL(import.meta.url))).update(await readFile(migrationUrl)).digest('hex');
  if (!args.length) { console.log(JSON.stringify({ offline:true,records:COHORT.length,reviewHash:hash })); return; }
  const apply = args.length===2 && args[0]==='--apply' && args[1]===`--review-sha256=${hash}`;
  if (!apply && !(args.length===1 && args[0]==='--check')) throw new Error('Use --check or --apply --review-sha256=<current script+migration hash>');
  const client = await connect();
  try { console.log(JSON.stringify(await repair(client,{apply}))); } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}