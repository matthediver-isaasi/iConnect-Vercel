import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { reconstructHistoricalEventInvoice } from './eventInvoiceReconstruction.js';

test('isolated historical hydration: original IDs/journal, stale checks, permissions, live-only and ownership', { timeout: 120_000 }, async () => {
  const h = await createLocalPostgresHarness('event-invoice-recovery-historical-');
  const run = (cmd, args, input, fail = false) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (fail) assert.notEqual(result.status, 0, 'unsafe operation must fail');
    else assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const sql = (text, fail = false) => run('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres',
    '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At'], text, fail);
  const tenant = '00000000-0000-4000-8000-000000000001';
  const snapshot = (pi = 'pi_original') => ({
    version: 1, provider: { connectionId: 'connection', xeroTenantId: 'org' },
    contact: { email: 'original@example.test' }, paymentMethod: 'stripe', amount: 166.67, currency: 'GBP',
    invoice: { Type: 'ACCREC', Status: 'AUTHORISED', CurrencyCode: 'GBP', LineAmountTypes: 'Inclusive',
      Contact: { ContactID: 'original' }, Date: '2026-11-01', DueDate: '2026-11-01',
      LineItems: [{ Description: 'Original ticket', UnitAmount: 166.67, Quantity: 1, TaxType: 'OUTPUT2', TaxAmount: 27.78, AccountCode: '200' }] },
    settlement: { paymentIntentId: pi, livemode: true, status: 'succeeded', amount: 166.67, currency: 'GBP',
      paidAt: '2026-11-01T12:00:00Z', accountCode: '090' },
  });
  const evidence = (pi = 'pi_original') => ({ version: 1, kind: 'approved_repair_manifest',
    approvalReference: `isolated:${pi}`, approvedBy: 'isolated-finance', approvedAt: '2026-11-02T00:00:00Z',
    environment: 'live', provenance: ['original verified evidence'], paymentIntentId: pi });
  const json = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const candidate = group => JSON.parse(sql(`SELECT event_invoice_recovery_historical_candidates(1,'${tenant}','booking','${group}');`))[0];
  const approve = (c, s = snapshot(), e = evidence(), fail = false) =>
    sql(`SET ROLE service_role; SELECT event_invoice_recovery_approve_historical(${json(c)},${json(s)},${json(e)});`, fail);
  const hydrate = id => sql(`SET ROLE service_role; SELECT event_invoice_recovery_hydrate_historical(1,'${id}');`);
  const create = (group, pi) => {
    sql(`INSERT INTO booking(tenant_id,booking_group_reference,stripe_payment_intent_id)
      VALUES('${tenant}','${group}','${pi}'),('${tenant}','${group}',NULL);
      SELECT event_invoice_recovery_enqueue('${tenant}','booking','${group}',NULL,false);`);
    return candidate(group);
  };
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE booking(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
      booking_group_reference text,payment_method text DEFAULT 'card',status text DEFAULT 'confirmed',
      payment_status text DEFAULT 'paid',ticket_price numeric DEFAULT 166.67,created_at timestamptz DEFAULT now()-interval '1 hour',
      xero_invoice_id text,xero_invoice_number text,accounting_invoice_id text,stripe_payment_intent_id text);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);`);
    sql(readFileSync(new URL('../../supabase/migrations/202611300001_event_invoice_recovery.sql', import.meta.url), 'utf8'));
    const migration = readFileSync(new URL('../../supabase/migrations/202611300002_event_invoice_recovery_historical.sql', import.meta.url), 'utf8');
    sql(migration);
    for (const role of ['anon','authenticated']) {
      sql(`SET ROLE ${role}; SELECT event_invoice_recovery_historical_candidates();`, true);
      sql(`SET ROLE ${role}; SELECT event_invoice_recovery_hydrate_historical();`, true);
      sql(`SET ROLE ${role}; SELECT * FROM event_invoice_recovery_historical_evidence;`, true);
    }
    sql(`SET ROLE service_role; INSERT INTO event_invoice_recovery_historical_evidence(operation_id) VALUES(gen_random_uuid());`, true);
    let c = create('original','pi_original');
    // Journal markers must survive promotion, including old ambiguous writes.
    sql(`UPDATE event_invoice_recovery SET invoice_write_started_at='2026-01-01',payment_write_started_at='2026-01-02',
      invoice_id='known-invoice',payment_id='known-payment' WHERE id='${c.operationId}';`);
    c = candidate('original');
    assert.equal(JSON.parse(approve(c)).status, 'approved');
    assert.equal(JSON.parse(approve(c)).status, 'already_approved');
    sql(`SET ROLE service_role; UPDATE event_invoice_recovery_historical_evidence SET state='hydrating';`, true);
    sql(`UPDATE event_invoice_recovery SET snapshot=${json(snapshot())} WHERE id='${c.operationId}';`, true);
    sql(`INSERT INTO event_invoice_recovery_connection(connection_id,tenant_id,xero_tenant_id,cooldown_until,
      lease_token,lease_expires_at) VALUES('connection','${tenant}','org',now()+interval '10 minutes',
      gen_random_uuid(),now()+interval '1 minute');`);
    assert.equal(hydrate(c.operationId), '0', 'live connection lease defers without rejection');
    sql(`UPDATE event_invoice_recovery_connection SET lease_expires_at=now()-interval '1 second';`);
    assert.equal(hydrate(c.operationId), '1');
    assert.equal(hydrate(c.operationId), '0');
    const q = JSON.parse(sql(`SELECT row_to_json(q) FROM event_invoice_recovery q WHERE id='${c.operationId}';`));
    assert.equal(q.id,c.operationId); assert.equal(q.status,'pending'); assert.equal(q.snapshot.amount,166.67);
    assert.equal(q.invoice_id,'known-invoice'); assert.equal(q.payment_id,'known-payment');
    assert.ok(q.invoice_write_started_at); assert.ok(q.payment_write_started_at);
    assert.equal(q.settlement_payment_intent_id,'pi_original');
    assert.equal(sql(`SELECT next_attempt_at=cooldown_until FROM event_invoice_recovery q
      JOIN event_invoice_recovery_connection c USING(connection_id) WHERE q.id='${c.operationId}';`), 't');
    assert.equal(sql(`SELECT bool_and(invoice_recovery_status='pending') FROM booking WHERE booking_group_reference='original';`),'t');
    sql(`UPDATE event_invoice_recovery SET snapshot='{}' WHERE id='${c.operationId}';`,true);
    for (const mode of [false, null, 'true']) {
      const t = create(`test-${String(mode)}`,`pi_test${String(mode)}`);
      const s = snapshot(`pi_test${String(mode)}`); s.settlement.livemode=mode;
      approve(t,s,evidence(s.settlement.paymentIntentId),true);
    }
    const stale = create('stale','pi_stale');
    approve(stale,snapshot('pi_stale'),evidence('pi_stale'));
    sql(`UPDATE booking SET ticket_price=200 WHERE booking_group_reference='stale';`);
    assert.equal(hydrate(stale.operationId),'0');
    assert.equal(sql(`SELECT reason_code FROM event_invoice_recovery_historical_evidence WHERE operation_id='${stale.operationId}';`),'historical_candidate_stale');
    assert.equal(sql(`SELECT snapshot IS NULL AND status='needs_review' FROM event_invoice_recovery WHERE id='${stale.operationId}';`),'t');
    const stolen = create('competing-owner','pi_original');
    approve(stolen);
    assert.equal(hydrate(stolen.operationId),'0');
    assert.equal(sql(`SELECT reason_code FROM event_invoice_recovery_historical_evidence WHERE operation_id='${stolen.operationId}';`),'settlement_already_owned');
    const linked = create('linked','pi_linked');
    approve(linked,snapshot('pi_linked'),evidence('pi_linked'));
    sql(`UPDATE booking SET accounting_invoice_id='remote-existing' WHERE id=(
      SELECT id FROM booking WHERE booking_group_reference='linked' LIMIT 1);`);
    assert.equal(hydrate(linked.operationId),'0');
    const invalid = create('invalid','pi_invalid');
    const bad = snapshot('pi_invalid'); bad.invoice.LineAmountTypes='Exclusive';
    approve(invalid,bad,evidence('pi_invalid'),true);
    const wrong = { ...candidate('invalid'), tenantId:'00000000-0000-4000-8000-000000000002' };
    approve(wrong,snapshot('pi_invalid'),evidence('pi_invalid'),true);
    // Invoice/account original evidence uses the same path without acquiring PI ownership.
    sql(`INSERT INTO booking(tenant_id,booking_group_reference,payment_method)
      VALUES('${tenant}','account-history','account');
      SELECT event_invoice_recovery_enqueue('${tenant}','booking','account-history',NULL,false);`);
    const account = candidate('account-history');
    const accountSnapshot = snapshot(); accountSnapshot.paymentMethod='invoice';
    delete accountSnapshot.settlement; accountSnapshot.invoice.Status='DRAFT';
    const accountEvidence = evidence(); delete accountEvidence.paymentIntentId;
    accountEvidence.kind='original_booking_verified_provider';
    approve(account,accountSnapshot,accountEvidence);
    assert.equal(hydrate(account.operationId),'1');
    assert.equal(sql(`SELECT settlement_payment_intent_id IS NULL AND status='pending'
      FROM event_invoice_recovery WHERE id='${account.operationId}';`),'t');
    // A source change between candidate capture and approval cannot persist approval.
    const beforeApproval = create('changed-before-approval','pi_changed');
    sql(`UPDATE booking SET status='cancelled' WHERE booking_group_reference='changed-before-approval';`);
    approve(beforeApproval,snapshot('pi_changed'),evidence('pi_changed'),true);
    // Independent provider connections still cannot acquire two owners for
    // one live payment under overlapping historical hydration transactions.
    const raceA = create('race-a','pi_historicalrace');
    const raceB = create('race-b','pi_historicalrace');
    const snapA = snapshot('pi_historicalrace'); snapA.provider.connectionId='race-connection-a';
    const snapB = snapshot('pi_historicalrace'); snapB.provider.connectionId='race-connection-b';
    approve(raceA,snapA,evidence('pi_historicalrace'));
    approve(raceB,snapB,evidence('pi_historicalrace'));
    const clients = [0,1].map(() => new pg.Client({
      host:h.socket,port:h.port,user:'postgres',database:'postgres',
    }));
    try {
      await Promise.all(clients.map(client => client.connect()));
      await clients[0].query('BEGIN');
      const first = await clients[0].query('SELECT event_invoice_recovery_hydrate_historical(1,$1) AS promoted',[raceA.operationId]);
      const second = clients[1].query('SELECT event_invoice_recovery_hydrate_historical(1,$1) AS promoted',[raceB.operationId]);
      await clients[0].query('COMMIT');
      assert.equal(first.rows[0].promoted,1);
      assert.equal((await second).rows[0].promoted,0);
    } finally {
      await Promise.all(clients.map(client => client.end()));
    }
    assert.equal(sql(`SELECT count(*) FROM event_invoice_recovery WHERE settlement_payment_intent_id='pi_historicalrace';`),'1');
    assert.equal(sql(`SELECT reason_code FROM event_invoice_recovery_historical_evidence WHERE operation_id='${raceB.operationId}';`),'settlement_already_owned');
    const before = sql(`SELECT jsonb_agg(to_jsonb(h) ORDER BY operation_id) FROM event_invoice_recovery_historical_evidence h;`);
    sql(migration);
    assert.equal(sql(`SELECT jsonb_agg(to_jsonb(h) ORDER BY operation_id) FROM event_invoice_recovery_historical_evidence h;`),before);
    // Automatic collection and promotion use this same isolated database only.
    sql(`ALTER TABLE booking ADD COLUMN event_id uuid, ADD COLUMN organization_id uuid,
      ADD COLUMN member_id uuid, ADD COLUMN ticket_class_id text, ADD COLUMN account_amount numeric;
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,title text,xero_account_code text,pricing_config jsonb);
      CREATE TABLE complex_event(LIKE event INCLUDING ALL);
      CREATE TABLE complex_event_ticket_class(id uuid,complex_event_id uuid,tenant_id uuid);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,name text,invoicing_email text);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,first_name text,last_name text,email text);
      CREATE TABLE xero_token(id text,app_tenant_id uuid,tenant_id text,access_token text);
      INSERT INTO xero_token VALUES('auto-connection','${tenant}','org','must-not-leak');
      INSERT INTO organization VALUES('${tenant}','${tenant}','Original buyer',NULL);
      INSERT INTO event VALUES('${tenant}','${tenant}','Original event','201',
        '{"ticket_classes":[{"id":"ticket","name":"Early bird","price":300,"early_bird_price":200,"currency":"GBP","vat_rate_key":"NONE","vat_rate_percentage":0}]}');
      INSERT INTO booking(tenant_id,booking_group_reference,payment_method,ticket_price,account_amount,
        event_id,organization_id,ticket_class_id)
      VALUES('${tenant}','auto-history','account',200,200,'${tenant}','${tenant}','ticket');
      SELECT event_invoice_recovery_enqueue('${tenant}','booking','auto-history',NULL,false);`);
    const automaticMigration = readFileSync(new URL('../../supabase/migrations/202611300003_event_invoice_automatic_reconstruction.sql', import.meta.url), 'utf8');
    sql(automaticMigration); sql(automaticMigration);
    const inclusiveMigration = readFileSync(new URL('../../supabase/migrations/202611300004_event_invoice_inclusive_policy_provenance.sql', import.meta.url), 'utf8');
    sql(inclusiveMigration); sql(inclusiveMigration);
    for (const role of ['anon','authenticated']) {
      sql(`SET ROLE ${role}; SELECT event_invoice_recovery_automatic_candidates();`,true);
      sql(`SET ROLE ${role}; SELECT event_invoice_recovery_automatic_commit('{}');`,true);
    }
    const autoId = candidate('auto-history').operationId;
    const collect = () => JSON.parse(sql(`SET ROLE service_role; SELECT event_invoice_recovery_automatic_candidates(1,'${autoId}');`))[0];
    const commit = (i,s,reason=null) => JSON.parse(sql(`SET ROLE service_role; SELECT
      event_invoice_recovery_automatic_commit(${json(i)},${s ? json(s) : 'NULL'},${reason ? `'${reason}'` : 'NULL'});`));
    let collected = collect();
    assert.doesNotMatch(JSON.stringify(collected),/must-not-leak|access_token/);
    const reconstructed = reconstructHistoricalEventInvoice(collected);
    assert.equal(reconstructed.amount,200);
    sql(`UPDATE event SET title='Changed event' WHERE id='${tenant}';`);
    assert.equal(commit(collected,reconstructed).status,'stale','supporting evidence change vetoes approval');
    collected = collect();
    assert.equal(commit(collected,null,'historical_tax_evidence_missing').status,'needs_review');
    assert.equal(sql(`SELECT reason_code FROM event_invoice_recovery WHERE id='${autoId}';`),'historical_tax_evidence_missing');
    collected = collect();
    assert.equal(commit(collected,reconstructHistoricalEventInvoice(collected)).status,'approved');
    assert.equal(commit(collected,reconstructed).status,'stale','duplicate promotion never overwrites approved evidence');
    assert.equal(hydrate(autoId),'1');
    assert.equal(sql(`SELECT snapshot->>'amount' FROM event_invoice_recovery WHERE id='${autoId}';`),'200');
    assert.equal(sql(`SELECT invoice_id IS NULL AND settlement_payment_intent_id IS NULL
      FROM event_invoice_recovery WHERE id='${autoId}';`),'t');
    sql(`UPDATE event SET pricing_config=jsonb_set(pricing_config,'{ticket_classes,0}',
      '{"id":"ticket","name":"Early bird","price":300,"early_bird_price":200,"currency":"GBP",
      "vat_rate_key":"OUTPUT2","vat_rate_percentage":20,"invoice_line_amount_type":"Inclusive"}') WHERE id='${tenant}';
      INSERT INTO booking(tenant_id,booking_group_reference,payment_method,ticket_price,account_amount,
        event_id,organization_id,ticket_class_id)
      VALUES('${tenant}','inclusive-history','account',200,200,'${tenant}','${tenant}','ticket');
      SELECT event_invoice_recovery_enqueue('${tenant}','booking','inclusive-history',NULL,false);`);
    const inclusiveId = candidate('inclusive-history').operationId;
    const inclusiveInput = JSON.parse(sql(`SET ROLE service_role; SELECT event_invoice_recovery_automatic_candidates(1,'${inclusiveId}');`))[0];
    const inclusiveSnapshot = reconstructHistoricalEventInvoice(inclusiveInput);
    assert.equal(inclusiveSnapshot.invoice.LineItems[0].TaxAmount,33.33);
    assert.equal(commit(inclusiveInput,inclusiveSnapshot).status,'approved');
    assert.equal(hydrate(inclusiveId),'1');
    assert.equal(sql(`SELECT snapshot#>>'{invoice,LineAmountTypes}' FROM event_invoice_recovery WHERE id='${inclusiveId}';`),'Inclusive');
    assert.match(sql(`SELECT evidence->'provenance' FROM event_invoice_recovery_historical_evidence WHERE operation_id='${inclusiveId}';`),/invoice_line_amount_type=Inclusive/);
    assert.equal(sql(`SELECT snapshot#>>'{invoice,LineAmountTypes}' FROM event_invoice_recovery WHERE id='${autoId}';`),'Exclusive',
      'existing frozen evidence never changes with ticket policy');
    // Reproduce the production survey trigger interaction using its actual SQL.
    sql(`ALTER TABLE booking ADD COLUMN survey_invitation_revision bigint NOT NULL DEFAULT 0;
      ALTER TABLE complex_event_booking ADD COLUMN survey_invitation_revision bigint NOT NULL DEFAULT 0;`);
    const surveyMigration = readFileSync(new URL('../../supabase/migrations/20261125_survey_invitation_attendee.sql', import.meta.url), 'utf8');
    const triggerStart = surveyMigration.indexOf('CREATE OR REPLACE FUNCTION public.bump_survey_invitation_revision()');
    sql(surveyMigration.slice(triggerStart, surveyMigration.indexOf('REVOKE ALL ON FUNCTION public.bump_survey_invitation_revision()',triggerStart)));
    for (const table of ['booking','complex_event_booking']) sql(`CREATE TRIGGER survey_invitation_revision
      BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION public.bump_survey_invitation_revision();`);
    sql(`INSERT INTO booking(tenant_id,booking_group_reference,payment_method,ticket_price,account_amount,
      event_id,organization_id,ticket_class_id)
      VALUES('${tenant}','survey-stale','account',200,200,'${tenant}','${tenant}','ticket');
      SELECT event_invoice_recovery_enqueue('${tenant}','booking','survey-stale',NULL,false);`);
    const surveyCandidate = candidate('survey-stale');
    const surveyId = surveyCandidate.operationId;
    const oldRevisions = JSON.parse(sql(`SELECT jsonb_object_agg(id,survey_invitation_revision) FROM booking WHERE booking_group_reference='survey-stale';`));
    const surveyInput = JSON.parse(sql(`SELECT event_invoice_recovery_automatic_candidates(1,'${surveyId}');`))[0];
    const surveySnapshot = reconstructHistoricalEventInvoice(surveyInput);
    approve(surveyCandidate,surveySnapshot,accountEvidence);
    assert.equal(hydrate(surveyId),'0','003 approval no-op mirror reproduces actual survey revision rejection');
    const rejected = JSON.parse(sql(`SELECT to_jsonb(h) FROM event_invoice_recovery_historical_evidence h WHERE operation_id='${surveyId}';`));
    assert.equal(rejected.reason_code,'historical_candidate_stale');
    const surveyFix = readFileSync(new URL('../../supabase/migrations/202611300005_event_invoice_survey_revision_fencing.sql', import.meta.url), 'utf8');
    sql(surveyFix); sql(surveyFix);
    const readmit = (expected = rejected,revisions = oldRevisions,fail = false) => sql(`SET ROLE service_role;
      SELECT event_invoice_recovery_readmit_survey_stale('${surveyId}',${json(expected)},${json(revisions)},'isolated-reviewed-repair');`,fail);
    for (const role of ['anon','authenticated']) {
      sql(`SET ROLE ${role}; SELECT event_invoice_recovery_readmit_survey_stale('${surveyId}','{}','{}','forbidden');`,true);
      sql(`SET ROLE ${role}; SELECT * FROM event_invoice_recovery_readmission_audit;`,true);
    }
    readmit({...rejected,evidence:{}},oldRevisions,true);
    readmit(rejected,{},true);
    readmit(rejected,Object.fromEntries(Object.keys(oldRevisions).map(id => [id,0])),true);
    for (const [field,value] of [['account_amount','201'],['organization_id',"'00000000-0000-4000-8000-000000000099'"]]) {
      sql(`UPDATE booking SET ${field}=${value} WHERE booking_group_reference='survey-stale';`);
      readmit(rejected,oldRevisions,true);
      sql(`UPDATE booking SET ${field}=${field==='account_amount'?'200':`'${tenant}'`} WHERE booking_group_reference='survey-stale';`);
    }
    for (const [field,value] of [['invoice_write_started_at','now()'],['payment_write_started_at','now()'],
      ['invoice_id',"'existing-invoice'"],['invoice_number',"'INV-EXISTING'"],['payment_id',"'existing-payment'"],
      ['lease_token',"'00000000-0000-4000-8000-000000000099'"],['lease_expires_at','now()']]) {
      sql(`UPDATE event_invoice_recovery SET ${field}=${value} WHERE id='${surveyId}';`);
      readmit(rejected,oldRevisions,true);
      sql(`UPDATE event_invoice_recovery SET ${field}=NULL WHERE id='${surveyId}';`);
    }
    const readmitted = JSON.parse(readmit());
    assert.equal(readmitted.status,'approved');
    assert.equal(sql(`SELECT rejected_record=${json(rejected)} FROM event_invoice_recovery_readmission_audit
      WHERE id='${readmitted.auditId}';`),'t','the full rejected record is preserved without deletion');
    sql(`SET ROLE service_role; DELETE FROM event_invoice_recovery_readmission_audit;`,true);
    sql(`UPDATE event_invoice_recovery_readmission_audit SET repair_reference='changed';`,true);
    readmit(rejected,oldRevisions,true);
    assert.equal(hydrate(surveyId),'1','survey-only stale evidence is promoted through unchanged fenced hydration');
    assert.equal(sql(`SELECT snapshot#>>'{invoice,LineItems,0,TaxAmount}' FROM event_invoice_recovery WHERE id='${surveyId}';`),'33.33');
    readmit(rejected,oldRevisions,true);
    // New explicit approvals do not issue a no-op mirror write at all; actual
    // survey revisions still increment on real booking updates.
    sql(`INSERT INTO booking(tenant_id,booking_group_reference,payment_method,ticket_price,account_amount,
      event_id,organization_id,ticket_class_id)
      VALUES('${tenant}','survey-fixed','account',200,200,'${tenant}','${tenant}','ticket');
      SELECT event_invoice_recovery_enqueue('${tenant}','booking','survey-fixed',NULL,false);`);
    const fixedCandidate = candidate('survey-fixed');
    const revBefore = sql(`SELECT survey_invitation_revision FROM booking WHERE booking_group_reference='survey-fixed';`);
    sql(`UPDATE booking SET ticket_price=ticket_price WHERE booking_group_reference='survey-fixed';`);
    assert.equal(Number(sql(`SELECT survey_invitation_revision FROM booking WHERE booking_group_reference='survey-fixed';`)),Number(revBefore)+1);
    assert.equal(candidate('survey-fixed').bookingFingerprint,fixedCandidate.bookingFingerprint);
    approve(fixedCandidate,surveySnapshot,accountEvidence);
    assert.equal(Number(sql(`SELECT survey_invitation_revision FROM booking WHERE booking_group_reference='survey-fixed';`)),Number(revBefore)+1,
      'approval no longer invalidates survey invitations via a no-op booking UPDATE');
    assert.equal(hydrate(fixedCandidate.operationId),'1');
    sql(`INSERT INTO booking(tenant_id,booking_group_reference,payment_method,ticket_price,account_amount,
      event_id,organization_id,ticket_class_id)
      VALUES('${tenant}','survey-auto','account',200,200,'${tenant}','${tenant}','ticket');
      SELECT event_invoice_recovery_enqueue('${tenant}','booking','survey-auto',NULL,false);`);
    const surveyAutoId = candidate('survey-auto').operationId;
    const surveyAutoInput = JSON.parse(sql(`SELECT event_invoice_recovery_automatic_candidates(1,'${surveyAutoId}');`))[0];
    assert.equal(commit(surveyAutoInput,reconstructHistoricalEventInvoice(surveyAutoInput)).status,'approved');
    assert.equal(hydrate(surveyAutoId),'1','automatic approval also works with the real survey bump trigger');
  } finally {
    if (started) run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});