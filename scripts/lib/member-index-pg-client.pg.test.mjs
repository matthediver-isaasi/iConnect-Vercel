/**
 * A real pg protocol check for the two generation RPCs.
 *
 * This is intentionally separate from the fast facade unit tests.  node-pg
 * serializes a JavaScript array as a PostgreSQL array, not JSON; the publisher
 * function's jsonb parameter catches that mistake with a real parser.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createMemberIndexPgClient } from './member-index-pg-client.mjs';

function commandExists(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], {
    stdio: 'ignore',
  }).status === 0;
}

const HAS_POSTGRES = ['initdb', 'pg_ctl', 'postgres'].every(commandExists);

test(
  'facade RPCs use real jsonb serialization and preserve int8 generation strings',
  { skip: !HAS_POSTGRES },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'member-index-pg-'));
    const dataDir = path.join(root, 'data');
    const socketDir = path.join(root, 'socket');
    const port = 54000 + (process.pid % 1000);
    let client;

    try {
      await fs.mkdir(socketDir);
      execFileSync('initdb', [
        '-D',
        dataDir,
        '--no-locale',
        '--encoding=UTF8',
        '--auth=trust',
        '--username=postgres',
      ], { stdio: 'ignore' });
      execFileSync('pg_ctl', [
        '-D',
        dataDir,
        '-o',
        `-k ${socketDir} -p ${port}`,
        '-w',
        'start',
      ], { stdio: 'ignore' });

      client = new pg.Client({
        host: '127.0.0.1',
        port,
        user: 'postgres',
        database: 'postgres',
      });
      await client.connect();
      await client.query(`
        CREATE FUNCTION public.claim_member_content_generation(
          p_tenant_id uuid,
          p_content_type text,
          p_source_id uuid
        ) RETURNS TABLE(generation bigint, claim_token uuid)
        LANGUAGE sql
        AS $fn$
          SELECT 1::bigint, '33333333-3333-4333-8333-333333333333'::uuid
        $fn$;

        CREATE FUNCTION public.publish_member_content_repair(
          p_tenant_id uuid,
          p_content_type text,
          p_source_id uuid,
          p_generation bigint,
          p_claim_token uuid,
          p_rows jsonb
        ) RETURNS boolean
        LANGUAGE plpgsql
        AS $fn$
        BEGIN
          IF p_tenant_id IS NULL OR p_content_type IS NULL OR
             p_source_id IS NULL OR p_generation IS NULL OR
             p_claim_token IS NULL THEN
            RETURN false;
          END IF;
          IF jsonb_typeof(p_rows) <> 'array' THEN
            RAISE EXCEPTION 'publisher rows must be a jsonb array';
          END IF;
          RETURN true;
        END
        $fn$;
      `);

      const facade = createMemberIndexPgClient({ client });
      const claim = await facade.rpc('claim_member_content_generation', {
        p_tenant_id: '11111111-1111-4111-8111-111111111111',
        p_content_type: 'blog_post',
        p_source_id: '22222222-2222-4222-8222-222222222222',
      });
      assert.equal(claim.error, null);
      assert.equal(claim.data[0].generation, '1');

      const published = await facade.rpc('publish_member_content_repair', {
        p_tenant_id: '11111111-1111-4111-8111-111111111111',
        p_content_type: 'blog_post',
        p_source_id: '22222222-2222-4222-8222-222222222222',
        p_generation: claim.data[0].generation,
        p_claim_token: claim.data[0].claim_token,
        p_rows: [{ chunk_index: 0, content_hash: 'persisted' }],
      });
      assert.deepEqual(published, { data: true, error: null });

      const probe = await facade.rpc('publish_member_content_repair', {
        p_tenant_id: null,
        p_content_type: null,
        p_source_id: null,
        p_generation: null,
        p_claim_token: null,
        p_rows: [],
      });
      assert.deepEqual(probe, { data: false, error: null });
    } finally {
      await client?.end().catch(() => {});
      spawnSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop'], {
        stdio: 'ignore',
      });
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
