/**
 * One-time, DEST-only GFI configuration update. No member writes.
 * Dry run: node scripts/update-gfi-role-alignment.mjs
 * Apply: add --apply --review-sha256=<dry-run hash>
 * Evidence is written before mutation and after commit under docs/.
 * The owner approved ONLY the Employer Engagement display-label correction.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
import { normalizePreferenceFieldOption as normalize, preparePreferenceFieldOptions } from '../client/src/lib/preferenceFieldOptions.mjs';

const TENANT = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const FIELD = 'd40255e9-13df-42a9-9cb2-b26452d692ad';
const CATEGORY = 'a4bb8421-8895-450d-b003-3a4a6af80972';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function mergeOptions(existing, themes) {
  assert.ok(Array.isArray(existing) && Array.isArray(themes));
  assert.equal(preparePreferenceFieldOptions(existing).error, null);
  const options = structuredClone(existing);
  const added = [];
  for (const label of themes) {
    assert.ok(typeof label === 'string' && label.trim() === label && label.length > 0);
    const matches = options.map((o, i) => ({ ...normalize(o), i }))
      .filter(o => o.label.trim().toLowerCase() === label.toLowerCase());
    assert.ok(matches.length <= 1, `Ambiguous label: ${label}`);
    if (matches.length) {
      const match = matches[0];
      if (match.label !== label) {
        assert.ok(label === 'Employer Engagement' && match.label === 'Employer engagement'
          && match.value === 'Employer engagement', `Unapproved label correction: ${label}`);
        options[match.i] = { ...normalize(options[match.i]), label };
      }
      continue;
    }
    assert.ok(!options.some(o => normalize(o).value.toLowerCase() === label.toLowerCase()),
      `Stored value collision: ${label}`);
    options.push({ value: label, label });
    added.push(label);
  }
  assert.equal(preparePreferenceFieldOptions(options).error, null);
  return { options, added };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await connectDestination();
  try {
    await db.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const tenant = (await db.query('select id,name,slug from tenant where id=$1', [TENANT])).rows;
    assert.deepEqual(tenant, [{ id: TENANT, name: 'Graduate Futures Institute', slug: 'gfi' }]);
    const fields = (await db.query(`select to_jsonb(f) row from preference_field f
      where tenant_id=$1 and name='role_alignment' ${apply ? 'for update' : ''}`, [TENANT])).rows;
    assert.equal(fields.length, 1);
    const before = fields[0].row;
    assert.equal(before.id, FIELD);
    assert.equal(before.entity_scope, 'member');
    assert.ok(['dropdown', 'picklist'].includes(before.field_type));
    const categories = (await db.query(`select to_jsonb(c) row from resource_category c
      where tenant_id=$1 and lower(name)='theme' ${apply ? 'for share' : ''}`, [TENANT])).rows;
    assert.equal(categories.length, 1);
    const category = categories[0].row;
    assert.equal(category.id, CATEGORY);
    assert.equal(category.is_active, true);
    const merged = mergeOptions(before.options, category.subcategories);
    const expected = { ...before, options: merged.options };
    const reviewSha256 = hash({ before, category, expected });
    const changed = hash(before) !== hash(expected);
    // Hash complete saved answers without retaining member identifiers or answers.
    const answerDigest = async () => (await db.query(`select count(*)::int count,
      md5(coalesce(string_agg(to_jsonb(v)::text, '' order by v.id), '')) digest
      from member_preference_value v where field_id=$1`, [FIELD])).rows[0];
    const answersBefore = await answerDigest();
    const evidence = { project: PROJECT, tenant: tenant[0], before, category, expected,
      reviewSha256, added: merged.added, answersBefore };
    if (apply && changed) {
      assert.ok(process.argv.includes(`--review-sha256=${reviewSha256}`), 'Fresh review hash required');
      // Never overwrite the original recovery evidence on replay.
      writeFileSync('docs/gfi-role-alignment-before.json', JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
      const result = await db.query(`update preference_field f set options=$1::jsonb
        where id=$2 and tenant_id=$3 and to_jsonb(f)=$4::jsonb returning to_jsonb(f) row`,
      [JSON.stringify(merged.options), FIELD, TENANT, JSON.stringify(before)]);
      assert.equal(result.rowCount, 1, 'Concurrent configuration change');
      assert.deepEqual(result.rows[0].row, expected, 'Unexpected field settings changed');
      assert.deepEqual(await answerDigest(), answersBefore, 'Saved answers changed');
    }
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
    if (apply) {
      const after = (await db.query('select to_jsonb(f) row from preference_field f where id=$1 and tenant_id=$2', [FIELD, TENANT])).rows[0].row;
      const categoryAfter = (await db.query('select to_jsonb(c) row from resource_category c where id=$1 and tenant_id=$2', [CATEGORY, TENANT])).rows[0].row;
      assert.deepEqual(after, expected);
      assert.deepEqual(categoryAfter, category);
      assert.deepEqual(await answerDigest(), answersBefore);
      assert.equal(mergeOptions(after.options, categoryAfter.subcategories).added.length, 0);
      if (changed) writeFileSync('docs/gfi-role-alignment-after.json', JSON.stringify({
        project: PROJECT, verifiedAt: new Date().toISOString(), after, categoryUnchanged: true,
        answersUnchanged: true, answers: answersBefore, repeatAdds: 0,
        authenticatedUiVerified: false,
      }, null, 2) + '\n', { flag: 'wx' });
    }
    console.log(JSON.stringify({ project: PROJECT, applied: apply && changed, reviewSha256,
      added: merged.added, resultingOptions: merged.options, answers: answersBefore }, null, 2));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
