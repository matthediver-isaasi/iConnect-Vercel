// Task 653 backfill: replays the two custom-field values that the form
// processor silently dropped when it submitted application form
// 35cd83a2-af40-4840-b518-bb7395d174dd for member
// 555e3647-0297-4945-88cd-ade69288bf70 ("Postnominals" text field
// 2bab42f4-... and "what_is_your_role" picklist 3b4f312b-...). The drop
// was caused by the trg_member_pref_value_bump_parent trigger updating a
// non-existent member.updated_at column; the trigger has been fixed and
// member.updated_at added in supabase/migrations/20260501_*.sql, and the
// processor itself now logs upsert failures into form_submission.processing_notes
// instead of swallowing them. This script is idempotent: it inserts only
// when no member_preference_value row exists for the (member, field) pair
// and updates the earliest existing row in place otherwise.
//
// Run: DEST_DATABASE_URL=... node scripts/backfill-task653-member-555e3647.mjs
import pg from 'pg';

const SUBMISSION_ID = '35cd83a2-af40-4840-b518-bb7395d174dd';
const MEMBER_ID = '555e3647-0297-4945-88cd-ade69288bf70';
const FIELD_POSTNOMINALS = '2bab42f4-4320-4c1c-82bc-b8f67828427e';
const FIELD_ROLE = '3b4f312b-1d61-41a6-acf4-95482e2a3359';

const c = new pg.Client({ connectionString: process.env.DEST_DATABASE_URL, ssl: { rejectUnauthorized: false }});
await c.connect();

const sub = await c.query('SELECT form_id, submission_data FROM form_submission WHERE id = $1', [SUBMISSION_ID]);
const formValues = sub.rows[0].submission_data || {};
const formId = sub.rows[0].form_id;
const formRow = await c.query('SELECT fields, pages, field_mappings, entity_pipelines FROM form WHERE id = $1', [formId]);
const f = formRow.rows[0];

const fieldByCustomFieldId = new Map();
function visit(field) {
  if (!field || typeof field !== 'object') return;
  if (field.id && field.custom_field_id) fieldByCustomFieldId.set(field.custom_field_id, field.id);
  if (field.id && field.preference_field_id) fieldByCustomFieldId.set(field.preference_field_id, field.id);
}
function walk(obj) {
  if (Array.isArray(obj)) { for (const x of obj) walk(x); return; }
  if (obj && typeof obj === 'object') { visit(obj); for (const v of Object.values(obj)) walk(v); }
}
walk(f.fields); walk(f.pages);

// form.field_mappings: array with target_type='custom', target_field=preference_field_id, source_field_id=form-field id
if (Array.isArray(f.field_mappings)) {
  for (const m of f.field_mappings) {
    if (m.target_type === 'custom' && m.target_field && m.source_field_id) {
      if (!fieldByCustomFieldId.has(m.target_field)) fieldByCustomFieldId.set(m.target_field, m.source_field_id);
    }
  }
}
// entity_pipelines mappings
if (f.entity_pipelines) {
  const eps = Array.isArray(f.entity_pipelines) ? f.entity_pipelines : Object.values(f.entity_pipelines);
  for (const ep of eps) {
    for (const m of (ep.mappings || [])) {
      if (m.target_type === 'custom' && m.target_field && m.source_field_id) {
        if (!fieldByCustomFieldId.has(m.target_field)) fieldByCustomFieldId.set(m.target_field, m.source_field_id);
      }
    }
  }
}

console.log('preference_field -> form_field map (relevant subset):');
for (const id of [FIELD_POSTNOMINALS, FIELD_ROLE]) console.log(`  ${id} -> ${fieldByCustomFieldId.get(id) || '(not mapped)'}`);

async function fetchFieldMeta(fieldId) {
  const r = await c.query('SELECT id, name, field_type FROM preference_field WHERE id = $1', [fieldId]);
  return r.rows[0] || null;
}
function aggregateForFieldType(value, fieldType) {
  const MULTI = new Set(['picklist', 'checkbox', 'multi_select', 'list', 'multiselect']);
  if (Array.isArray(value)) {
    if (MULTI.has((fieldType || '').toLowerCase())) return JSON.stringify(value);
    return value.length > 0 ? String(value[0]) : '';
  }
  return value === null || value === undefined ? '' : String(value);
}

async function backfill(fieldId) {
  const meta = await fetchFieldMeta(fieldId);
  if (!meta) { console.warn('  preference_field not found:', fieldId); return; }
  let raw;
  if (Object.prototype.hasOwnProperty.call(formValues, fieldId)) raw = formValues[fieldId];
  else {
    const formFieldId = fieldByCustomFieldId.get(fieldId);
    if (formFieldId && Object.prototype.hasOwnProperty.call(formValues, formFieldId)) raw = formValues[formFieldId];
  }
  if (raw === undefined || raw === null || raw === '') {
    console.warn(`  no submitted value for "${meta.name}" ${fieldId}`); return;
  }
  const stored = aggregateForFieldType(raw, meta.field_type);
  console.log(`  field "${meta.name}" (${meta.field_type}): submitted=${JSON.stringify(raw)} stored=${JSON.stringify(stored)}`);

  const existing = await c.query(
    'SELECT id, value FROM member_preference_value WHERE member_id = $1 AND field_id = $2 ORDER BY id ASC',
    [MEMBER_ID, fieldId]
  );
  if (existing.rows.length === 0) {
    const ins = await c.query(
      'INSERT INTO member_preference_value (member_id, field_id, value) VALUES ($1, $2, $3) RETURNING id',
      [MEMBER_ID, fieldId, stored]
    );
    console.log(`    INSERTED row id=${ins.rows[0].id}`);
  } else {
    const target = existing.rows[0];
    if (target.value === stored) console.log(`    already up to date (id=${target.id})`);
    else { await c.query('UPDATE member_preference_value SET value = $1 WHERE id = $2', [stored, target.id]); console.log(`    UPDATED row id=${target.id} (was ${JSON.stringify(target.value)})`); }
  }
}

console.log('\nPostnominals:'); await backfill(FIELD_POSTNOMINALS);
console.log('\nRole:');         await backfill(FIELD_ROLE);

console.log('\nFinal state for member', MEMBER_ID, ':');
const final = await c.query(
  `SELECT mpv.field_id, pf.name, pf.field_type, mpv.value FROM member_preference_value mpv JOIN preference_field pf ON pf.id = mpv.field_id WHERE mpv.member_id = $1 ORDER BY pf.name`, [MEMBER_ID]
);
console.table(final.rows);

await c.end();
