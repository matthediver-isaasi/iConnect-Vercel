/**
 * convert-conference-radio-to-boolean.mjs
 *
 * One-off script: converts 3 Yes/No radio fields on the "Annual conference 2026
 * requirements" form (tenant fd82da65-aab7-4a5c-85b8-b2febeb2003d) to boolean
 * toggle fields, updates the visibility rules, and migrates all 334 historical
 * submission values.
 *
 * Usage:
 *   node scripts/convert-conference-radio-to-boolean.mjs            # dry-run (safe)
 *   node scripts/convert-conference-radio-to-boolean.mjs --apply    # write to DB
 *
 * Idempotent: re-running is safe.
 */

import { createClient } from '@supabase/supabase-js';

const DRY_RUN = !process.argv.includes('--apply');

const FORM_ID   = 'c6bf9742-5e4b-4972-9b0e-b4a08b8cee79';
const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

// The three radio fields to convert to boolean
const TARGET_FIELD_IDS = new Set([
  'field_1773817106086', // "Do you have any food allergies?"
  'field_1773816677996', // "Do you have any dietary requirements?"
  'field_1773820217669', // "Will you be attending the Big Welcome on Wednesday 1st July?"
]);

// Visibility rules that reference the target fields (condition value mapping)
// "Yes" → "true", "No" → "false" (string representation used by FormBuilder)
const CONDITION_VALUE_MAP = { Yes: 'true', No: 'false' };

// Submission value migration: radio string/array → JS boolean
function migrateSubmissionValue(v) {
  if (v === true || v === false) return v;           // already migrated
  if (Array.isArray(v)) {
    if (v.length === 1) return migrateSubmissionValue(v[0]);
    return null; // unexpected – don't migrate multi-value arrays
  }
  if (v === 'Yes') return true;
  if (v === 'No')  return false;
  return null; // unexpected value – don't touch
}

async function main() {
  const supabaseUrl = process.env.DEST_SUPABASE_URL;
  const supabaseKey = process.env.DEST_SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing DEST_SUPABASE_URL or DEST_SUPABASE_KEY');
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'APPLY (writing to DB)'}`);
  console.log(`Form: ${FORM_ID}`);
  console.log('');

  // ─── 1. Fetch the form ───────────────────────────────────────────────────
  const { data: form, error: formErr } = await sb
    .from('form')
    .select('id, name, fields, visibility_rules')
    .eq('id', FORM_ID)
    .eq('tenant_id', TENANT_ID)
    .single();

  if (formErr || !form) {
    console.error('Failed to fetch form:', formErr?.message);
    process.exit(1);
  }
  console.log(`Form name: ${form.name}`);

  // ─── 2. Backup originals ─────────────────────────────────────────────────
  console.log('\n=== ORIGINAL FIELDS (target) ===');
  const origFields = (form.fields || []).filter(f => TARGET_FIELD_IDS.has(f.id));
  origFields.forEach(f => console.log(JSON.stringify(f)));

  console.log('\n=== ORIGINAL VISIBILITY RULES (all) ===');
  (form.visibility_rules || []).forEach(r => console.log(JSON.stringify(r)));

  // ─── 3. Build updated fields ─────────────────────────────────────────────
  const updatedFields = (form.fields || []).map(field => {
    if (!TARGET_FIELD_IDS.has(field.id)) return field;

    if (field.type === 'boolean') {
      console.log(`\n[SKIP] Field ${field.id} already type=boolean`);
      return field;
    }

    const updated = {
      id:          field.id,
      type:        'boolean',
      label:       field.label,
      required:    field.required,
      page_id:     field.page_id,
      column_index: field.column_index,
      default_value: false,
    };
    console.log(`\n[CONVERT FIELD] ${field.id}`);
    console.log(`  Before: ${JSON.stringify(field)}`);
    console.log(`  After:  ${JSON.stringify(updated)}`);
    return updated;
  });

  // ─── 4. Build updated visibility rules ───────────────────────────────────
  const updatedRules = (form.visibility_rules || []).map(rule => {
    const conditions = rule.conditions || [];
    let changed = false;

    const newConditions = conditions.map(cond => {
      if (!TARGET_FIELD_IDS.has(cond.field_id)) return cond;

      const mapped = CONDITION_VALUE_MAP[cond.value];
      if (mapped === undefined) {
        // Value not in map — leave untouched (e.g. already "true"/"false")
        if (cond.value === 'true' || cond.value === 'false') {
          console.log(`\n[SKIP CONDITION] Rule ${rule.id} cond ${cond.id}: value already "${cond.value}"`);
        } else {
          console.log(`\n[WARN CONDITION] Rule ${rule.id} cond ${cond.id}: unexpected value "${cond.value}", leaving unchanged`);
        }
        return cond;
      }

      console.log(`\n[CONVERT RULE] Rule ${rule.id}, cond ${cond.id}: value "${cond.value}" → "${mapped}"`);
      changed = true;
      return { ...cond, value: mapped };
    });

    if (!changed) return rule;
    return { ...rule, conditions: newConditions };
  });

  // ─── 5. Fetch and migrate submissions ────────────────────────────────────
  console.log('\n=== SUBMISSIONS MIGRATION ===');

  // Fetch all submissions in pages of 500
  let allSubs = [];
  let from = 0;
  const PAGE_SIZE = 500;
  while (true) {
    const { data: page, error: pageErr } = await sb
      .from('form_submission')
      .select('id, submission_data')
      .eq('form_id', FORM_ID)
      .range(from, from + PAGE_SIZE - 1);
    if (pageErr) { console.error('Fetch error:', pageErr.message); process.exit(1); }
    if (!page || page.length === 0) break;
    allSubs = allSubs.concat(page);
    from += PAGE_SIZE;
    if (page.length < PAGE_SIZE) break;
  }
  console.log(`Fetched ${allSubs.length} submissions`);

  const toUpdate = [];
  const stats = {
    field_1773817106086: { yes: 0, no: 0, array: 0, already: 0, skipped: 0 },
    field_1773816677996: { yes: 0, no: 0, array: 0, already: 0, skipped: 0 },
    field_1773820217669: { yes: 0, no: 0, array: 0, already: 0, skipped: 0 },
  };

  for (const sub of allSubs) {
    const sd = { ...sub.submission_data };
    let changed = false;

    for (const fid of TARGET_FIELD_IDS) {
      if (!(fid in sd)) continue;
      const raw = sd[fid];

      if (raw === true || raw === false) {
        stats[fid].already++;
        continue;
      }

      const migrated = migrateSubmissionValue(raw);
      if (migrated === null) {
        console.log(`[WARN] Sub ${sub.id}, field ${fid}: unexpected value ${JSON.stringify(raw)}, skipping`);
        stats[fid].skipped++;
        continue;
      }

      if (Array.isArray(raw)) stats[fid].array++;
      else if (raw === 'Yes') stats[fid].yes++;
      else if (raw === 'No')  stats[fid].no++;

      sd[fid] = migrated;
      changed = true;
    }

    if (changed) toUpdate.push({ id: sub.id, submission_data: sd });
  }

  console.log('\nConversion stats per field:');
  for (const [fid, s] of Object.entries(stats)) {
    console.log(`  ${fid}: yes=${s.yes} no=${s.no} array=${s.array} already_boolean=${s.already} skipped=${s.skipped}`);
  }
  console.log(`Submissions to update: ${toUpdate.length}`);

  // ─── 6. Apply or dry-run ─────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log('\n✓ DRY-RUN complete. No changes written. Pass --apply to execute.');
    return;
  }

  // 6a. Update form fields + visibility rules
  console.log('\nUpdating form definition...');
  const { error: formUpdateErr } = await sb
    .from('form')
    .update({ fields: updatedFields, visibility_rules: updatedRules })
    .eq('id', FORM_ID)
    .eq('tenant_id', TENANT_ID);

  if (formUpdateErr) {
    console.error('Failed to update form:', formUpdateErr.message);
    process.exit(1);
  }
  console.log('✓ Form definition updated (fields + visibility_rules)');

  // 6b. Update submissions in batches of 50
  console.log(`Updating ${toUpdate.length} submissions...`);
  let updated = 0;
  const BATCH = 50;
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const batch = toUpdate.slice(i, i + BATCH);
    for (const item of batch) {
      const { error: subErr } = await sb
        .from('form_submission')
        .update({ submission_data: item.submission_data })
        .eq('id', item.id)
        .eq('form_id', FORM_ID);
      if (subErr) {
        console.error(`Failed to update submission ${item.id}:`, subErr.message);
      } else {
        updated++;
      }
    }
    process.stdout.write(`  ${Math.min(i + BATCH, toUpdate.length)}/${toUpdate.length}\r`);
  }
  console.log(`\n✓ Updated ${updated}/${toUpdate.length} submissions`);

  // ─── 7. Verify ───────────────────────────────────────────────────────────
  console.log('\n=== POST-APPLY VERIFICATION ===');
  const { data: verForm } = await sb.from('form').select('fields, visibility_rules').eq('id', FORM_ID).single();
  const verFields = (verForm.fields || []).filter(f => TARGET_FIELD_IDS.has(f.id));
  verFields.forEach(f => console.log(`Field ${f.id}: type=${f.type}, default_value=${f.default_value}`));

  const verRules = (verForm.visibility_rules || []).filter(r =>
    (r.conditions || []).some(c => TARGET_FIELD_IDS.has(c.field_id))
  );
  verRules.forEach(r => {
    const conds = (r.conditions || []).filter(c => TARGET_FIELD_IDS.has(c.field_id));
    conds.forEach(c => console.log(`Rule ${r.id}, cond ${c.id}: field=${c.field_id} op=${c.operator} value=${JSON.stringify(c.value)}`));
  });

  // Spot-check submission counts
  const { data: verifySubs } = await sb.from('form_submission').select('id, submission_data').eq('form_id', FORM_ID);
  const vStats = {};
  for (const fid of TARGET_FIELD_IDS) vStats[fid] = { true: 0, false: 0, other: 0 };
  (verifySubs || []).forEach(s => {
    for (const fid of TARGET_FIELD_IDS) {
      const v = s.submission_data[fid];
      if (v === true) vStats[fid].true++;
      else if (v === false) vStats[fid].false++;
      else if (v !== undefined) vStats[fid].other++;
    }
  });
  console.log('\nPost-migration submission distributions:');
  for (const [fid, s] of Object.entries(vStats)) {
    console.log(`  ${fid}: true=${s.true} false=${s.false} other=${s.other}`);
  }

  console.log('\n✓ Migration complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
