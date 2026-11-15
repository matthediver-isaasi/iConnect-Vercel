import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
test('event sponsor migration preserves categories and enforces event/tenant/organisation boundaries', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('sponsor-scope-');
  const run = (cmd, args, input, fail = false) => {
    const r = spawnSync(cmd,args,{input,encoding:'utf8'});
    if(fail) assert.notEqual(r.status,0, 'invalid operation must fail');
    else assert.equal(r.status,0,r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const sql = (input, fail=false) => run('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At'], input, fail);
  let started=false;
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started=true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid REFERENCES tenant);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid REFERENCES tenant);
      CREATE TABLE complex_event(id uuid PRIMARY KEY,tenant_id uuid REFERENCES tenant);
      INSERT INTO tenant VALUES('${id(1)}'),('${id(2)}');
      INSERT INTO organization VALUES('${id(11)}','${id(1)}'),('${id(12)}','${id(2)}');
      INSERT INTO event VALUES('${id(21)}','${id(1)}'),('${id(22)}','${id(1)}'),('${id(23)}','${id(2)}');
      INSERT INTO complex_event VALUES('${id(24)}','${id(1)}');`);
    for(const file of ['20260331_create_event_sponsor_tables.sql','20260331_fix_event_sponsor_assignment_constraints.sql']) sql(readFileSync(new URL(file,import.meta.url),'utf8'));
    sql(`INSERT INTO event_sponsor_category(id,tenant_id,name) VALUES('${id(31)}','${id(1)}','Gold'),('${id(32)}','${id(1)}','Bronze');
      INSERT INTO event_sponsor(id,tenant_id,name,category_id) VALUES('${id(41)}','${id(1)}','Acme','${id(31)}'),('${id(42)}','${id(2)}','Other',NULL);
      INSERT INTO event_sponsor_assignment(id,tenant_id,event_id,event_type,sponsor_id,category_id)
      VALUES('${id(51)}','${id(1)}','${id(21)}','simple','${id(41)}','${id(32)}'),
      ('${id(52)}','${id(1)}','${id(22)}','simple','${id(41)}',NULL),
      ('${id(53)}','${id(1)}','${id(24)}','complex','${id(41)}','${id(31)}');`);
    sql(readFileSync(new URL('./202701240001_event_owned_sponsor_categories.sql',import.meta.url),'utf8'));
    assert.equal(sql(`SELECT string_agg(c.name,',' ORDER BY a.id) FROM event_sponsor_assignment a JOIN event_sponsor_category c ON c.id=a.category_id`),'Bronze,Gold,Gold');
    assert.equal(sql('SELECT count(DISTINCT category_id) FROM event_sponsor_assignment'),'3');
    sql(`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      SET ROLE service_role; UPDATE event_sponsor SET organization_id='${id(11)}' WHERE id='${id(41)}';`);
    sql(`SET ROLE service_role; UPDATE event_sponsor SET organization_id='${id(12)}' WHERE id='${id(41)}'`,true);
    sql(`UPDATE event_sponsor SET organization_id=NULL WHERE id='${id(41)}'`);
    sql(`UPDATE event_sponsor SET category_id='${id(32)}' WHERE id='${id(41)}'`,true);
    sql(`UPDATE event_sponsor SET tenant_id='${id(2)}' WHERE id='${id(41)}'`,true);
    sql(`UPDATE event_sponsor_assignment SET sponsor_id='${id(42)}' WHERE id='${id(51)}'`,true);
    sql(`UPDATE event_sponsor_assignment SET category_id=(SELECT category_id FROM event_sponsor_assignment WHERE id='${id(52)}') WHERE id='${id(51)}'`,true);
    sql(`UPDATE event_sponsor_assignment SET event_id='${id(22)}' WHERE id='${id(51)}'`,true);
    sql(`UPDATE event_sponsor_category SET event_id='${id(22)}' WHERE event_id='${id(21)}'`,true);
    sql(`UPDATE event_sponsor_category SET legacy_category_id=NULL WHERE event_id='${id(21)}'`,true);
    sql(`INSERT INTO event_sponsor_category(tenant_id,name) VALUES('${id(1)}','Global')`,true);
    sql(`INSERT INTO event_sponsor_category(tenant_id,name,event_id,event_type) VALUES('${id(1)}','Wrong tenant','${id(23)}','simple')`,true);
    sql(`INSERT INTO event_sponsor_category(tenant_id,name,event_id,event_type) VALUES('${id(1)}','Wrong type','${id(24)}','simple')`,true);
    sql(`INSERT INTO event_sponsor_category(tenant_id,name,event_id,event_type) VALUES('${id(1)}','Silver','${id(21)}','simple')`);
    sql(`UPDATE event_sponsor_assignment SET category_id=NULL WHERE id='${id(52)}'`);
    assert.equal(sql(`SELECT category_id IS NULL FROM event_sponsor_assignment WHERE id='${id(52)}'`),'t');
    // Old deployed editors resolve their legacy category to the existing event copy.
    sql(`UPDATE event_sponsor_assignment SET category_id='${id(31)}' WHERE id='${id(52)}'`);
    assert.equal(sql(`SELECT c.event_id FROM event_sponsor_category c JOIN event_sponsor_assignment a ON a.category_id=c.id WHERE a.id='${id(52)}'`),id(22));
    sql(`DELETE FROM event_sponsor_category WHERE event_id='${id(21)}' AND name='Bronze'`);
    assert.equal(sql(`SELECT category_id IS NULL FROM event_sponsor_assignment WHERE id='${id(51)}'`),'t');
    sql(`DELETE FROM complex_event WHERE id='${id(24)}'`);
    assert.equal(sql(`SELECT count(*) FROM event_sponsor_assignment WHERE event_id='${id(24)}'`),'0');
    assert.equal(sql(`SELECT count(*) FROM event_sponsor_category WHERE event_id='${id(24)}'`),'0');
    assert.equal(sql(`SELECT count(*) FROM event_sponsor_assignment WHERE event_id='${id(22)}'`),'1');
    assert.equal(sql(`SELECT has_function_privilege('anon','public.delete_event_sponsor_scope()','EXECUTE') OR has_function_privilege('authenticated','public.guard_event_sponsor_scope()','EXECUTE')`),'f');
  } finally {
    if(started) run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
