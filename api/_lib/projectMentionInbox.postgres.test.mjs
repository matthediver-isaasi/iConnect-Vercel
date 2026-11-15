import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = (command,args,input='') => {
  const result=spawnSync(command,args,{input,encoding:'utf8'});
  assert.equal(result.status,0,`${command}: ${result.stderr}`);
  return result.stdout;
};
test('mention creation is atomic, board-scoped, deduplicated and service-only', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'project-mentions-'));
  const data=path.join(root,'data'), socket=path.join(root,'socket');
  await mkdir(socket);
  let started=false;
  try {
    run('initdb',['-D',data,'-A','trust','-U','postgres','--no-instructions']);
    run('pg_ctl',['-D',data,'-l',path.join(root,'pg.log'),'-o',`-F -k ${socket} -c listen_addresses= -p 55449`,'-w','start']); started=true;
    const args=['-h',socket,'-p','55449','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-q'];
    run('psql',args,`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant_identity(id varchar PRIMARY KEY, first_name text,last_name text,email text);
      CREATE TABLE project_board(id uuid PRIMARY KEY,is_archived boolean DEFAULT false);
      CREATE TABLE project_board_member(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,board_id uuid,identity_id uuid,role text,UNIQUE(board_id,identity_id));
      CREATE TABLE project_card(id uuid PRIMARY KEY,board_id uuid,is_archived boolean DEFAULT false);
      CREATE TABLE project_card_comment(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,card_id uuid,identity_id uuid,content text,created_at timestamp DEFAULT now());
      CREATE TABLE project_card_attachment(id uuid PRIMARY KEY,card_id uuid,uploaded_by uuid,name text,url text,file_type varchar(100),file_size integer);
      CREATE TABLE project_card_activity(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,card_id uuid,identity_id uuid,action_type text,action_data jsonb);
      ALTER TABLE project_board ADD COLUMN tenant_id uuid DEFAULT '30000000-0000-0000-0000-000000000001', ADD COLUMN name text DEFAULT 'Board';
      ALTER TABLE project_card ADD COLUMN title text DEFAULT 'Card';
      CREATE TABLE member_inbox_folder(id uuid PRIMARY KEY);
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    `);
    run('psql',args,await readFile('supabase/migrations/202610090002_project_mention_inbox.sql','utf8'));
    run('psql',args,await readFile('supabase/migrations/202610090003_project_mentions_main_inbox.sql','utf8'));
    run('psql',args,await readFile('supabase/migrations/202610090004_project_comment_identity_types.sql','utf8'));
    run('psql',args,await readFile('supabase/migrations/202701250001_project_comment_images.sql','utf8'));
    run('psql',args,`
      INSERT INTO tenant_identity VALUES
        ('00000000-0000-0000-0000-000000000001','Alex','Author','author@example.invalid'),
        ('00000000-0000-0000-0000-000000000002','Bea','Recipient','recipient@example.invalid'),
        ('00000000-0000-0000-0000-000000000003','Cai','Outsider','outsider@example.invalid');
      INSERT INTO project_board(id) VALUES ('10000000-0000-0000-0000-000000000001');
      INSERT INTO project_card(id,board_id) VALUES ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
      INSERT INTO project_board_member(board_id,identity_id,role) VALUES
        ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','member'),
        ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','viewer');
      SET ROLE service_role;
      SELECT create_project_comment_with_mentions('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Hello @Bea Recipient',
        ARRAY['00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002']::uuid[]);
      SELECT create_project_comment_with_mentions('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Ordinary comment');
      DO $$ BEGIN
        ASSERT (SELECT count(*) FROM project_mention_inbox)=1;
        ASSERT (SELECT count(*) FROM project_card_comment)=2;
        ASSERT (SELECT count(*) FROM project_card_activity)=2;
        BEGIN
          PERFORM create_project_comment_with_mentions('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
            '@Bea Recipient @Cai Outsider',ARRAY['00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003']::uuid[]);
          RAISE EXCEPTION 'should reject non-member';
        EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        BEGIN
          PERFORM create_project_comment_with_mentions('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
            'Deleted mention',ARRAY['00000000-0000-0000-0000-000000000002']::uuid[]);
          RAISE EXCEPTION 'should reject removed mention';
        EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        BEGIN
          PERFORM create_project_comment_with_mentions('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','viewer comment');
          RAISE EXCEPTION 'should reject viewer author';
        EXCEPTION WHEN insufficient_privilege THEN NULL; END;
        ASSERT (SELECT count(*) FROM project_mention_inbox)=1;
        ASSERT (SELECT count(*) FROM project_card_comment)=2;
        ASSERT NOT has_table_privilege('anon','project_mention_inbox','SELECT');
        ASSERT NOT has_table_privilege('authenticated','project_mention_inbox','UPDATE');
        ASSERT NOT has_function_privilege('authenticated','create_project_comment_with_mentions(uuid,uuid,text,uuid[])','EXECUTE');
      END $$;
      DO $$ BEGIN
        ASSERT (SELECT count(*) FROM project_mention_inbox_visible)=1;
        ASSERT NOT has_table_privilege('authenticated','project_mention_inbox_visible','SELECT');
        ASSERT NOT has_table_privilege('anon','project_mention_inbox_visible','SELECT');
      END $$;
      UPDATE project_mention_inbox SET read_at=now(), pinned_at=now();
      DO $$ BEGIN
        ASSERT (SELECT count(*) FROM project_mention_inbox_visible WHERE read_at IS NOT NULL AND pinned_at IS NOT NULL)=1;
      END $$;
      UPDATE project_mention_inbox SET is_archived=true;
      DO $$ BEGIN
        ASSERT (SELECT count(*) FROM project_mention_inbox WHERE is_archived=false)=0;
        ASSERT (SELECT count(*) FROM project_mention_inbox_visible WHERE is_archived=true)=1;
      END $$;
      UPDATE project_mention_inbox SET is_archived=false, read_at=NULL;
      UPDATE project_card SET is_archived=true;
      DO $$ BEGIN ASSERT (SELECT count(*) FROM project_mention_inbox_visible)=0; END $$;
      UPDATE project_card SET is_archived=false,board_id='10000000-0000-0000-0000-000000000002';
      DO $$ BEGIN ASSERT (SELECT count(*) FROM project_mention_inbox_visible)=0; END $$;
      UPDATE project_card SET board_id='10000000-0000-0000-0000-000000000001';
      UPDATE project_board SET is_archived=true;
      DO $$ BEGIN ASSERT (SELECT count(*) FROM project_mention_inbox_visible)=0; END $$;
      UPDATE project_board SET is_archived=false;
      INSERT INTO member_inbox_folder VALUES ('40000000-0000-0000-0000-000000000001');
      UPDATE project_mention_inbox SET folder_id='40000000-0000-0000-0000-000000000001';
      DELETE FROM member_inbox_folder;
      DO $$ BEGIN ASSERT (SELECT folder_id IS NULL FROM project_mention_inbox); END $$;
      DELETE FROM project_board_member WHERE identity_id='00000000-0000-0000-0000-000000000002';
      DO $$ BEGIN ASSERT (SELECT count(*) FROM project_mention_inbox)=0; END $$;
    `);
    run('psql',args,`
      SET ROLE service_role;
      INSERT INTO project_board_member(board_id,identity_id,role) VALUES
        ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','viewer');
      INSERT INTO project_card_attachment VALUES
        ('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
         '00000000-0000-0000-0000-000000000001','screenshot.png','https://fixture.invalid/screenshot.png','image/png',100),
        ('50000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002',
         '00000000-0000-0000-0000-000000000001','other.png','https://fixture.invalid/other.png','image/png',100),
        ('50000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001',
         '00000000-0000-0000-0000-000000000002','not-yours.png','https://fixture.invalid/not-yours.png','image/png',100),
        ('50000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001',
         '00000000-0000-0000-0000-000000000001','unsafe.svg','https://fixture.invalid/unsafe.svg','image/svg+xml',100);
      DO $$
      DECLARE
        c uuid := '20000000-0000-0000-0000-000000000001';
        a uuid := '00000000-0000-0000-0000-000000000001';
        i uuid := '50000000-0000-0000-0000-000000000001';
        request uuid := gen_random_uuid();
        result jsonb; retry jsonb; invalid uuid;
        before_comments int; before_mentions int; before_activity int;
      BEGIN
        SELECT count(*) INTO before_comments FROM project_card_comment;
        SELECT count(*) INTO before_mentions FROM project_mention_inbox;
        SELECT count(*) INTO before_activity FROM project_card_activity;
        result := create_project_comment_with_images(c,a,'','{}',ARRAY[i],request);
        retry := create_project_comment_with_images(c,a,'','{}',ARRAY[i],request);
        ASSERT result = retry, 'retry returns the original image comment';
        ASSERT result->>'content' = '';
        ASSERT result->'images'->0->'attachment'->>'id' = i::text;
        ASSERT (SELECT count(*) FROM project_card_comment)=before_comments+1;
        ASSERT (SELECT count(*) FROM project_card_activity)=before_activity+1;
        ASSERT (SELECT count(*) FROM project_mention_inbox)=before_mentions;
        FOREACH invalid IN ARRAY ARRAY[
          '50000000-0000-0000-0000-000000000002'::uuid,
          '50000000-0000-0000-0000-000000000003'::uuid,
          '50000000-0000-0000-0000-000000000004'::uuid,
          '50000000-0000-0000-0000-000000000005'::uuid
        ] LOOP
          BEGIN
            PERFORM create_project_comment_with_images(c,a,'Rejected @Bea Recipient',
              ARRAY['00000000-0000-0000-0000-000000000002'::uuid],ARRAY[invalid],gen_random_uuid());
            RAISE EXCEPTION 'accepted invalid image';
          EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        END LOOP;
        ASSERT (SELECT count(*) FROM project_card_comment)=before_comments+1;
        ASSERT (SELECT count(*) FROM project_mention_inbox)=before_mentions;
        BEGIN
          PERFORM create_project_comment_with_images(c,'00000000-0000-0000-0000-000000000002','viewer','{}',ARRAY[i],gen_random_uuid());
          RAISE EXCEPTION 'accepted viewer';
        EXCEPTION WHEN insufficient_privilege THEN NULL; END;
        BEGIN
          PERFORM create_project_comment_with_images(c,a,'changed','{}',ARRAY[i],request);
          RAISE EXCEPTION 'accepted changed retry';
        EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
        retry := create_project_comment_with_images(c,a,'Hello @Bea Recipient',
          ARRAY['00000000-0000-0000-0000-000000000002'::uuid],ARRAY[i],gen_random_uuid());
        ASSERT (SELECT count(*) FROM project_mention_inbox)=before_mentions+1;
        ASSERT (SELECT count(*) FROM project_comment_image)=2;
        DELETE FROM project_card_comment WHERE id=(result->>'id')::uuid;
        ASSERT (SELECT count(*) FROM project_comment_image)=1;
        ASSERT EXISTS(SELECT 1 FROM project_card_attachment WHERE id=i), 'comment deletion retains shared files';
        DELETE FROM project_card_attachment WHERE id=i;
        ASSERT (SELECT count(*) FROM project_comment_image)=0;
        ASSERT EXISTS(SELECT 1 FROM project_card_comment WHERE id=(retry->>'id')::uuid);
        ASSERT NOT has_table_privilege('authenticated','project_comment_image','INSERT');
        ASSERT NOT has_table_privilege('anon','project_activity_upload','SELECT');
        ASSERT NOT has_function_privilege('authenticated','create_project_comment_with_images(uuid,uuid,text,uuid[],uuid[],uuid)','EXECUTE');
      END $$;
    `);
  } finally {
    if(started) run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    await rm(root,{recursive:true,force:true});
  }
});
