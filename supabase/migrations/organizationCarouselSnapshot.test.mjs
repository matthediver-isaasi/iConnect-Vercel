import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('./202610190002_organization_carousel_snapshot.sql', import.meta.url), 'utf8');

test('snapshot migration pins definer scope and grants only the exact service-role signature', () => {
  assert.match(sql, /STABLE\s+SECURITY DEFINER\s+SET search_path = pg_catalog/);
  const signature = 'public.organization_carousel_snapshot(uuid, text, text, text)';
  assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`));
  assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${signature} FROM anon, authenticated;`));
  assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`));
  assert.equal((sql.match(/GRANT EXECUTE/g) || []).length, 1);
  assert.match(sql, /JOIN organizations o ON o.id = v.organization_id AND o.tenant_id = p_tenant_id/);
  assert.match(sql, /JOIN fields f ON f.id = v.field_id AND f.tenant_id = p_tenant_id AND f.entity_scope = 'organization'/);
});

test('snapshot migration includes all eligibility names, deterministic ordering and explicit oversize failure', () => {
  for (const name of ['application_status', 'org_type', 'organisation_type', 'organization_type', 'verified_domains']) {
    assert.ok(sql.includes(`'${name}'`));
  }
  assert.match(sql, /jsonb_agg\(row ORDER BY id COLLATE "C"\)/);
  assert.match(sql, /LIMIT 100001/g);
  assert.match(sql, /RAISE EXCEPTION 'Organisation carousel snapshot exceeds safety limits'/);
  assert.match(sql, /octet_length\(result::text\) > 33554432/);
});
