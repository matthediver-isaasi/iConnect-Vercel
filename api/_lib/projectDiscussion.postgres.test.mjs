import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = (cmd, args, input = '') => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
  return r.stdout;
};
const actor = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002';
const card = '20000000-0000-0000-0000-000000000001';
const write = (op, extra = '', who = actor) => `write_project_discussion('${card}','${who}','${op}'${extra}${
  op === 'create' && !extra.includes('p_request_id') ? ',p_request_id=>gen_random_uuid()' : ''
})`;
test('disposable discussion lifecycle, ordering, promotion, permissions and concurrent writers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'project-discussions-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'pg.log'), '-o', `-F -k ${socket} -c listen_addresses= -p 55459`, '-w', 'start']); started = true;
    const args = ['-h', socket, '-p', '55459', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
    const sql = input => run('psql', args, input);
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant_identity(id varchar PRIMARY KEY,first_name text,last_name text,email text);
      CREATE TABLE project_board(id uuid PRIMARY KEY,is_archived boolean DEFAULT false);
      CREATE TABLE project_board_member(board_id uuid,identity_id uuid,role text,UNIQUE(board_id,identity_id));
      CREATE TABLE project_card(id uuid PRIMARY KEY,board_id uuid,is_archived boolean DEFAULT false);
      CREATE TABLE project_card_comment(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,card_id uuid NOT NULL REFERENCES project_card(id) ON DELETE CASCADE,identity_id uuid,content text,created_at timestamp DEFAULT now());
      CREATE TABLE project_card_attachment(id uuid PRIMARY KEY,card_id uuid,uploaded_by uuid,name text,url text,file_type text,file_size integer);
      CREATE TABLE project_card_activity(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,card_id uuid,identity_id uuid,action_type text,action_data jsonb);
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    `);
    for (const file of ['202610090002_project_mention_inbox.sql', '202610090004_project_comment_identity_types.sql', '202701250001_project_comment_images.sql', '202701260001_project_discussions.sql']) {
      if (file.endsWith('project_discussions.sql')) sql(`
        INSERT INTO tenant_identity VALUES ('${actor}','Alex','Author','author@example.invalid');
        INSERT INTO project_board VALUES ('10000000-0000-0000-0000-000000000001',false);
        INSERT INTO project_board_member VALUES ('10000000-0000-0000-0000-000000000001','${actor}','member');
        INSERT INTO project_card(id,board_id) VALUES ('${card}','10000000-0000-0000-0000-000000000001');
        INSERT INTO project_card_attachment VALUES('40000000-0000-0000-0000-000000000001','${card}','${actor}','old image','/private/old','image/png',100);
        SELECT create_project_comment_with_images('${card}','${actor}','Legacy <strong>literal</strong>','{}',
          ARRAY['40000000-0000-0000-0000-000000000001']::uuid[],'50000000-0000-0000-0000-000000000001');
      `);
      sql(await readFile(`supabase/migrations/${file}`, 'utf8'));
    }
    sql(`SET ROLE service_role; DO $$ DECLARE original uuid; retried jsonb; BEGIN
      SELECT id INTO original FROM project_card_comment;
      ASSERT (SELECT content FROM project_card_comment)='Legacy <strong>literal</strong>';
      ASSERT (SELECT rich_content IS NULL AND parent_comment_id IS NULL AND edited_at IS NULL FROM project_card_comment);
      ASSERT (SELECT count(*) FROM project_comment_image)=1;
      ASSERT (SELECT count(*) FROM project_card_activity)=1;
      retried := create_project_comment_with_images('${card}','${actor}','Legacy <strong>literal</strong>','{}',
        ARRAY['40000000-0000-0000-0000-000000000001']::uuid[],'50000000-0000-0000-0000-000000000001');
      ASSERT retried->>'id'=original::text;
      ASSERT (SELECT count(*) FROM project_card_comment)=1;
      ASSERT (SELECT count(*) FROM project_card_activity)=1;
      END $$; RESET ROLE;
      TRUNCATE project_board,project_board_member,project_card,project_card_comment,project_card_attachment,project_card_activity,tenant_identity CASCADE;`);
    sql(`
      INSERT INTO tenant_identity VALUES ('${actor}','Alex','Author','author@example.invalid'),('${other}','Bea','Member','member@example.invalid');
      INSERT INTO project_board VALUES ('10000000-0000-0000-0000-000000000001',false);
      INSERT INTO project_board_member VALUES ('10000000-0000-0000-0000-000000000001','${actor}','member'),('10000000-0000-0000-0000-000000000001','${other}','member');
      INSERT INTO project_card(id,board_id) VALUES ('${card}','10000000-0000-0000-0000-000000000001'),('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001');
      INSERT INTO project_card_attachment VALUES('40000000-0000-0000-0000-000000000001','${card}','${actor}','image','/private/image','image/png',100);
      SET ROLE service_role;
      DO $$ DECLARE a jsonb; b jsonb; c jsonb; snap jsonb; root uuid; first_reply uuid; second_reply uuid; before_version bigint; BEGIN
        a := ${write('create', ",p_content=>'literal <b>text</b>\\nnext line',p_request_id=>'50000000-0000-0000-0000-000000000001'")};
        root := (a->'comment'->>'id')::uuid;
        b := ${write('create', ",p_content=>'@Bea Member first reply',p_reply_to_id=>root,p_recipient_ids=>ARRAY['" + other + "']::uuid[],p_attachment_ids=>ARRAY['40000000-0000-0000-0000-000000000001']::uuid[],p_request_id=>'50000000-0000-0000-0000-000000000002'")};
        first_reply := (b->'comment'->>'id')::uuid;
        c := ${write('create', ",p_content=>'reply to reply',p_reply_to_id=>first_reply,p_request_id=>'50000000-0000-0000-0000-000000000003'")};
        second_reply := (c->'comment'->>'id')::uuid;
        ASSERT c->'comment'->>'parent_comment_id'=root::text;
        ASSERT c->'comment'->>'reply_to_comment_id'=first_reply::text;
        -- Three posts, not three additional rows from reactions.
        PERFORM ${write('react', ",p_comment_id=>first_reply,p_emoji=>'👍'")};
        PERFORM ${write('react', ",p_comment_id=>first_reply,p_emoji=>'👍'")};
        ASSERT (SELECT count(*) FROM project_comment_reaction)=1;
        PERFORM ${write('react', ",p_comment_id=>first_reply,p_emoji=>'❤️'")};
        ASSERT (SELECT emoji FROM project_comment_reaction)='❤️';
        ASSERT (SELECT count(*) FROM project_card_comment)=3;
        ASSERT (SELECT count(*) FROM project_mention_inbox)=1;
        PERFORM ${write('edit', `,p_comment_id=>first_reply,p_content=>'@Bea Member formatted',p_rich_content=>'{"version":1,"doc":{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"mention","attrs":{"id":"${other}","label":"Bea Member"}},{"type":"text","text":" formatted","marks":[{"type":"bold"}]}]},{"type":"paragraph","content":[{"type":"commentImage","attrs":{"attachmentId":"40000000-0000-0000-0000-000000000001"}}]}]}}'::jsonb,p_recipient_ids=>ARRAY['${other}']::uuid[],p_attachment_ids=>ARRAY['40000000-0000-0000-0000-000000000001']::uuid[]`)};
        ASSERT (SELECT count(*) FROM project_mention_inbox)=1, 'edit never sends another mention';
        ASSERT (SELECT content FROM project_mention_inbox)='@Bea Member formatted';
        BEGIN
          PERFORM ${write('create', ",p_content=>'bad image',p_attachment_ids=>ARRAY['40000000-0000-0000-0000-000000000099']::uuid[]")};
          RAISE EXCEPTION 'Missing image accepted';
        EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        BEGIN
          UPDATE project_card_comment SET parent_comment_id=first_reply WHERE id=root;
          RAISE EXCEPTION 'Cycle allowed';
        EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        BEGIN
          UPDATE project_card_comment SET card_id='20000000-0000-0000-0000-000000000002' WHERE id=first_reply;
          RAISE EXCEPTION 'Cross-card parent allowed';
        EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        BEGIN
          PERFORM ${write('edit', ",p_comment_id=>root,p_content=>'forged'", other)};
          RAISE EXCEPTION 'Author check missing';
        EXCEPTION WHEN insufficient_privilege THEN NULL; END;
        BEGIN
          PERFORM ${write('create', ",p_content=>'substituted',p_reply_to_id=>first_reply,p_request_id=>'50000000-0000-0000-0000-000000000001'")};
          RAISE EXCEPTION 'Retry target substitution allowed';
        EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        PERFORM ${write('edit', ",p_comment_id=>root,p_content=>'edited original'")};
        ASSERT (SELECT edited_at IS NOT NULL FROM project_card_comment WHERE id=root);
        ASSERT (SELECT count(*) FROM project_mention_inbox)=1;
        -- Retry compares immutable initial evidence, not the edited row.
        a := ${write('create', ",p_content=>'literal <b>text</b>\\nnext line',p_request_id=>'50000000-0000-0000-0000-000000000001'")};
        ASSERT a->'comment'->>'content'='edited original';
        -- Tied timestamps choose UUID deterministically, independent of insert order.
        UPDATE project_card_comment SET created_at='2026-01-01' WHERE id IN(first_reply,second_reply);
        SELECT id INTO first_reply FROM project_card_comment WHERE parent_comment_id=root ORDER BY created_at,id LIMIT 1;
        snap := ${write('delete', ",p_comment_id=>root")};
        ASSERT (SELECT parent_comment_id IS NULL FROM project_card_comment WHERE id=first_reply);
        ASSERT (SELECT count(*) FROM project_card_comment WHERE parent_comment_id=first_reply)=1;
        ASSERT (SELECT count(*) FROM project_comment_image)=1;
        ASSERT EXISTS(SELECT 1 FROM project_card_comment WHERE rich_content->>'version'='1'), 'rich document survives promotion';
        ASSERT (SELECT count(*) FROM project_comment_reaction)=1;
        ASSERT (SELECT count(*) FROM project_mention_inbox)=1;
        ASSERT (SELECT count(*) FROM project_card_attachment)=1;
        ASSERT jsonb_array_length(snap->'comments')=2;
        BEGIN
          PERFORM ${write('create', ",p_content=>'literal <b>text</b>\\nnext line',p_request_id=>'50000000-0000-0000-0000-000000000001'")};
          RAISE EXCEPTION 'Deleted request recreated';
        EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
        -- A deleted reply never promotes or removes siblings.
        SELECT id INTO second_reply FROM project_card_comment WHERE parent_comment_id=first_reply;
        PERFORM ${write('delete', ",p_comment_id=>second_reply")};
        ASSERT (SELECT count(*) FROM project_card_comment)=1;
        PERFORM ${write('delete', ",p_comment_id=>first_reply")};
        ASSERT (SELECT count(*) FROM project_card_comment)=0;
        ASSERT (SELECT count(*) FROM project_comment_reaction)=0;
        ASSERT (SELECT count(*) FROM project_mention_inbox)=0;
        ASSERT (SELECT count(*) FROM project_card_attachment)=1;
        -- Zero replies and exactly one reply.
        a := ${write('create', ",p_content=>'zero'")}; root := (a->'comment'->>'id')::uuid;
        PERFORM ${write('delete', ",p_comment_id=>root")};
        a := ${write('create', ",p_content=>'one'")}; root := (a->'comment'->>'id')::uuid;
        b := ${write('create', ",p_content=>'only reply',p_reply_to_id=>root")};
        PERFORM ${write('delete', ",p_comment_id=>root")};
        ASSERT (SELECT parent_comment_id IS NULL FROM project_card_comment WHERE id=(b->'comment'->>'id')::uuid);
        ASSERT NOT has_function_privilege('authenticated','write_project_discussion(uuid,uuid,text,uuid,text,jsonb,uuid[],uuid[],uuid,uuid,text)','EXECUTE');
        ASSERT NOT has_table_privilege('authenticated','project_comment_reaction','SELECT');
        ASSERT NOT has_table_privilege('anon','project_comment_request','INSERT');
      END $$;
    `);
    // Use real simultaneous transactions. The second writer blocks at the card,
    // not on a partially reparented thread or an individual reaction row.
    const concurrent = input => new Promise((resolve, reject) => {
      const child = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
      child.on('error', reject); child.on('close', code => code ? reject(new Error(err)) : resolve(out));
      child.stdin.end(input);
    });
    const create = async content => JSON.parse(sql(`SET ROLE service_role; SELECT ${write('create', `,p_content=>'${content}'`)};`));
    const rootComment = (await create('race root')).comment.id;
    const first = JSON.parse(sql(`SET ROLE service_role; SELECT ${write('create', `,p_content=>'race first',p_reply_to_id=>'${rootComment}'`)};`)).comment.id;
    await Promise.all([
      concurrent(`SET ROLE service_role; BEGIN; SELECT ${write('delete', `,p_comment_id=>'${rootComment}'`)}; SELECT pg_sleep(0.15); COMMIT;`),
      concurrent(`SET ROLE service_role; SELECT ${write('create', `,p_content=>'concurrent reply to promoted',p_reply_to_id=>'${first}'`)};`),
    ]);
    let snap = JSON.parse(sql(`SET ROLE service_role; SELECT read_project_discussion('${card}','${actor}');`));
    assert.equal(snap.comments.find(c => c.id === first).parent_comment_id, null);
    assert.equal(snap.comments.find(c => c.content === 'concurrent reply to promoted').parent_comment_id, first);
    await Promise.all(Array.from({ length: 4 }, () => concurrent(`SET ROLE service_role; SELECT ${write('react', `,p_comment_id=>'${first}',p_emoji=>'😊'`)};`)));
    snap = JSON.parse(sql(`SET ROLE service_role; SELECT read_project_discussion('${card}','${actor}');`));
    assert.equal(snap.comments.find(c => c.id === first).reactions[0].count, 1);
    assert.equal(snap.comments.find(c => c.id === first).reactions[0].selected, true);
    const duplicateRequest = '50000000-0000-0000-0000-000000000099';
    const duplicates = await Promise.all(Array.from({ length: 3 }, () => concurrent(`SET ROLE service_role;
      SELECT ${write('create', `,p_content=>'duplicate race',p_request_id=>'${duplicateRequest}',p_reply_to_id=>'${first}'`)};`)));
    assert.equal(new Set(duplicates.map(raw => JSON.parse(raw).comment.id)).size, 1);
    const racingRoot = (await create('delete target race')).comment.id;
    const raceResults = await Promise.allSettled([
      concurrent(`SET ROLE service_role; SELECT ${write('delete', `,p_comment_id=>'${racingRoot}'`)};`),
      concurrent(`SET ROLE service_role; SELECT ${write('create', `,p_content=>'raced reply',p_reply_to_id=>'${racingRoot}'`)};`),
    ]);
    assert.equal(raceResults[0].status, 'fulfilled');
    if (raceResults[1].status === 'rejected') assert.match(raceResults[1].reason.message, /Reply target unavailable/);
    sql(`DO $$ BEGIN
      ASSERT NOT EXISTS(SELECT 1 FROM project_card_comment c LEFT JOIN project_card_comment p ON p.id=c.parent_comment_id
        WHERE c.parent_comment_id IS NOT NULL AND (p.id IS NULL OR p.parent_comment_id IS NOT NULL));
      END $$;`);
    // Explicit complete retrieval, beyond the REST API's normal row cap.
    sql(`INSERT INTO project_card_comment(card_id,identity_id,content,parent_comment_id,created_at)
      SELECT '${card}','${actor}','bulk reply '||g,'${first}','2026-01-01' FROM generate_series(1,1105) g;`);
    snap = JSON.parse(sql(`SET ROLE service_role; SELECT read_project_discussion('${card}','${actor}');`));
    assert.equal(snap.comments.filter(c => c.content.startsWith('bulk reply')).length, 1105);
    const bulk = snap.comments.filter(c => c.content.startsWith('bulk reply')).map(c => c.id);
    assert.deepEqual(bulk, [...bulk].sort());
    sql(`INSERT INTO tenant_identity(id,first_name) SELECT '70000000-0000-0000-0000-'||lpad(g::text,12,'0'),'Reactor '||g FROM generate_series(1,1105) g;
      INSERT INTO project_board_member(board_id,identity_id,role)
        SELECT '10000000-0000-0000-0000-000000000001',id::uuid,'member' FROM tenant_identity WHERE id LIKE '70000000-%';
      INSERT INTO project_comment_reaction SELECT '${first}',identity_id,'😊' FROM project_board_member WHERE identity_id::text LIKE '70000000-%';
      INSERT INTO project_card_comment(id,card_id,identity_id,content,created_at) VALUES
        ('80000000-0000-0000-0000-000000000001','${card}','${actor}','tied root a','2030-01-01'),
        ('80000000-0000-0000-0000-000000000002','${card}','${actor}','tied root b','2030-01-01');`);
    snap = JSON.parse(sql(`SET ROLE service_role; SELECT read_project_discussion('${card}','${actor}');`));
    assert.deepEqual(snap.comments.slice(0, 2).map(c => c.content), ['tied root b', 'tied root a']);
    assert.equal(snap.comments.find(c => c.id === first).reactions[0].count, 1106);
    assert.equal(snap.comments.find(c => c.id === first).reactions[0].reactors.length, 1106);
    snap = JSON.parse(sql(`SET ROLE service_role; SELECT ${write('react', `,p_comment_id=>'${first}',p_emoji=>NULL`)};`));
    assert.equal(snap.comments.find(c => c.id === first).reactions[0].selected, false);
    assert.equal(snap.comments.find(c => c.id === first).reactions[0].count, 1105);
    sql(`UPDATE project_board_member SET role='viewer' WHERE identity_id='${actor}';
      DO $$ BEGIN BEGIN PERFORM ${write('react', `,p_comment_id=>'${first}',p_emoji=>NULL`)}; RAISE EXCEPTION 'viewer wrote';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$;`);
    snap = JSON.parse(sql(`SET ROLE service_role; SELECT read_project_discussion('${card}','${actor}');`));
    assert.ok(snap.comments.every(c => c.can_edit === false));
    sql(`DELETE FROM project_board_member WHERE identity_id='${actor}';
      DO $$ BEGIN BEGIN PERFORM read_project_discussion('${card}','${actor}'); RAISE EXCEPTION 'revoked reader';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$;`);
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
