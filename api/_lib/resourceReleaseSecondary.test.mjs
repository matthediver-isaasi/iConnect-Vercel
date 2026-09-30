import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { applyResourceReleaseFilter } from '../../shared/resourceRelease.js';
import { isResourceRowVisible, executeQuerySpec } from './memberAiStructured.js';
import { isChunkVisibleToMember } from './memberContentVisibility.js';

const now = Date.parse('2026-05-20T12:00:00Z');
for (const isAdmin of [false, true]) {
  test(`AI release boundary applies to structured and indexed results (admin=${isAdmin})`, () => {
    for (const [release_date, expected] of [
      [null, true],
      ['2026-05-20T11:59:59Z', true],
      ['2026-05-20T12:00:00Z', true],
      ['2026-05-20T12:00:01Z', false],
      ['invalid', false],
    ]) {
      const row = { status: 'active', release_date, content_type: 'resource' };
      assert.equal(isResourceRowVisible(row, { now, isAdmin }), expected);
      assert.equal(isChunkVisibleToMember(row, { now, isAdmin }), expected);
    }
  });
}

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('structured counts exclude scheduled resources using the supplied request clock', async () => {
  const query = {
    select() { return this; }, eq() { return this; },
    async range() {
      return { data: [
        { id: 'released', status: 'active', release_date: new Date(now).toISOString() },
        { id: 'scheduled', status: 'active', release_date: new Date(now + 1).toISOString() },
      ] };
    },
  };
  const result = await executeQuerySpec({
    supabase: { from: () => query }, tenantId: 'tenant',
    spec: { entity: 'resource', aggregation: 'count', filters: [] },
    viewer: { isAdmin: false, groupIds: new Set() }, now,
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.total, 1);
});

test('AI always hydrates tenant-scoped live release fields before ranking', () => {
  const source = read('../member-ai/ask.js');
  const start = source.indexOf("if (visible.some((m) => m.content_type === 'resource'))");
  const end = source.indexOf('if (!visible.length)', start);
  const hydration = source.slice(start, end);
  assert.match(hydration, /release_date, status, member_group_id, allowed_role_ids/);
  assert.match(hydration, /\.eq\('tenant_id', ctx.tenantId\)/);
  assert.match(hydration, /if \(!row\) return false/);
  assert.match(hydration, /isResourceReleased\(row, now\)/);
  assert.doesNotMatch(hydration, /if \(hiddenSubcats.size > 0\)/);
});

test('prerender resource-list applies release filtering before its limit', async () => {
  const source = read('../public/prerender.js');
  const start = source.indexOf('async function renderCanvasDynamicBlock(');
  const end = source.indexOf('async function renderCustomPage(', start);
  const render = vm.runInNewContext(`${source.slice(start, end)}; renderCanvasDynamicBlock`, {
    applyResourceReleaseFilter, clampLimit: () => 6,
  });
  const calls = [];
  const query = {
    select() { return this; }, eq() { return this; }, order() { return this; },
    or(filter) { calls.push(['filter', filter]); return this; },
    async limit(value) { calls.push(['limit', value]); return { data: [] }; },
  };
  await render({ from: () => query }, { id: 'tenant' }, { type: 'resource-list', content: {} }, now);
  assert.equal(calls[0][0], 'filter');
  assert.ok(calls[0][1].includes(new Date(now).toISOString()));
  assert.equal(calls[1][0], 'limit');
});

test('secondary outputs use release filters and private cache policies', () => {
  for (const path of ['../public/search.js', '../bookmarks/enriched.js', '../resources/view-counts.js']) {
    const source = read(path);
    assert.match(source, /const now = Date.now\(\)/);
    assert.match(source, /applyResourceReleaseFilter\(/);
    assert.match(source, /no-store|setMemberContentCacheHeaders/);
  }
  assert.match(read('./entityMeta.js'), /applyResourceReleaseFilter\(q, now\)/);
  assert.match(read('../render.js'), /req.resourceReleaseSensitive/);
});