#!/usr/bin/env node
/**
 * Repair dangling `source_field_id`s on stage_field_mapping_action rows that
 * were copied across forms (Seed-from-another-form / duplicate + edit).
 *
 * Background: a field-mapping action stores `source_field_id` — a DD form field
 * id. When DD config is copied from one form to another the mappings keep the
 * SOURCE form's field ids. On the target/duplicate form those ids don't exist,
 * so at execution nothing is written and in the config editor the source
 * dropdown renders blank.
 *
 * This script re-points each broken `source_field_id` on the TARGET form to the
 * target form's equivalent field, matched by field LABEL (falling back to name,
 * then key). The dangling id is resolved against the SOURCE form's fields to
 * recover the original label. Mappings whose source can't be translated are
 * reported (never guessed) and left untouched.
 *
 * Defaults to DRY-RUN. Pass `--apply` to write. Idempotent: a second run finds
 * nothing broken and makes no changes.
 *
 * Defaults are pinned to the two forms from the original report on tenant
 * 21296ad6-1350-483a-a90c-1b06ece70501:
 *   source (original) = 4c030808-8f38-4587-9a98-df9e6686ae0c  (SO Long form fees)
 *   target (duplicate)= 9f954871-0ac8-4a3b-b976-3575de2bd8be  (ESO Long form fees)
 *
 * Usage:
 *   node scripts/fix-dd-field-mapping-source-ids.mjs                 # dry-run, default forms
 *   node scripts/fix-dd-field-mapping-source-ids.mjs --apply         # apply, default forms
 *   node scripts/fix-dd-field-mapping-source-ids.mjs \
 *     --tenant=<uuid> --source-form=<uuid> --target-form=<uuid> [--apply]
 */

import { createClient } from '@supabase/supabase-js';
import { remapFieldMappings, isFieldSourceMapping, sourceFieldExistsOnForm } from '../api/_lib/fieldMappingRemap.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) return [a, true];
    return [m[1], m[2] ?? true];
  })
);

const APPLY = args.apply === true || args.apply === 'true';
const TENANT_ID = args.tenant || '21296ad6-1350-483a-a90c-1b06ece70501';
const SOURCE_FORM_ID = args['source-form'] || '4c030808-8f38-4587-9a98-df9e6686ae0c';
const TARGET_FORM_ID = args['target-form'] || '9f954871-0ac8-4a3b-b976-3575de2bd8be';

const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL || process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY (or SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

function fieldLabelFor(sourceId, formFields) {
  const sid = String(sourceId);
  const f = (formFields || []).find(
    (x) => x && (String(x.id) === sid || (x.name != null && String(x.name) === sid) || (x.key != null && String(x.key) === sid))
  );
  if (!f) return '(unknown — not on source form)';
  return f.label || f.name || f.key || '(no label)';
}

async function run() {
  console.log('================================================================');
  console.log('  DD FIELD-MAPPING SOURCE-ID REMEDIATION' + (APPLY ? '  [APPLY]' : '  [DRY-RUN]'));
  console.log('================================================================');
  console.log(`Tenant:        ${TENANT_ID}`);
  console.log(`Source form:   ${SOURCE_FORM_ID}`);
  console.log(`Target form:   ${TARGET_FORM_ID}`);
  console.log('');

  const { data: forms, error: formsErr } = await supabase
    .from('form')
    .select('id, name, fields')
    .in('id', [SOURCE_FORM_ID, TARGET_FORM_ID])
    .eq('tenant_id', TENANT_ID);
  if (formsErr) { console.error('Error loading forms:', formsErr.message); process.exit(2); }

  const sourceForm = forms?.find((f) => f.id === SOURCE_FORM_ID);
  const targetForm = forms?.find((f) => f.id === TARGET_FORM_ID);
  if (!sourceForm) { console.error('Source form not found in tenant'); process.exit(2); }
  if (!targetForm) { console.error('Target form not found in tenant'); process.exit(2); }

  const sourceFormFields = sourceForm.fields || [];
  const targetFormFields = targetForm.fields || [];
  console.log(`Source: "${sourceForm.name}" (${sourceFormFields.length} fields)`);
  console.log(`Target: "${targetForm.name}" (${targetFormFields.length} fields)`);
  console.log('');

  const { data: fmas, error: fmaErr } = await supabase
    .from('stage_field_mapping_action')
    .select('*')
    .eq('tenant_id', TENANT_ID)
    .eq('form_id', TARGET_FORM_ID)
    .order('sort_order', { ascending: true });
  if (fmaErr) { console.error('Error loading field-mapping actions:', fmaErr.message); process.exit(2); }

  if (!fmas || fmas.length === 0) {
    console.log('No stage_field_mapping_action rows on the target form. Nothing to do.');
    return;
  }

  let totalRepaired = 0;
  let totalUnmatched = 0;
  let rowsToUpdate = 0;

  for (const fma of fmas) {
    const mappings = fma.field_mappings || [];
    const brokenBefore = mappings.filter(
      (m) => isFieldSourceMapping(m) && m.source_field_id && !sourceFieldExistsOnForm(m.source_field_id, targetFormFields)
    );
    if (brokenBefore.length === 0) continue;

    console.log(`--- FMA ${fma.id} (stage=${fma.due_diligence_stage_id}, sort=${fma.sort_order ?? '-'}) : ${brokenBefore.length} broken`);

    // Keep unmatched mappings in place (dropUnmatched:false) so we never silently
    // discard a row during remediation — we report them instead.
    const { mappings: remapped, dropped } = remapFieldMappings(
      mappings,
      sourceFormFields,
      targetFormFields,
      { dropUnmatched: false }
    );

    // Log per-mapping outcome for the broken ones.
    for (let i = 0; i < mappings.length; i++) {
      const before = mappings[i];
      if (!(isFieldSourceMapping(before) && before.source_field_id && !sourceFieldExistsOnForm(before.source_field_id, targetFormFields))) continue;
      const after = remapped[i];
      const label = fieldLabelFor(before.source_field_id, sourceFormFields);
      if (after && after.source_field_id !== before.source_field_id) {
        totalRepaired += 1;
        console.log(`    REPAIR  "${label}"  ${before.source_field_id} -> ${after.source_field_id}  (target ${before.target_type}:${before.target_field})`);
      } else {
        totalUnmatched += 1;
        console.log(`    UNMATCHED  "${label}"  ${before.source_field_id}  — no equivalent on target form (target ${before.target_type}:${before.target_field}) [left as-is]`);
      }
    }
    if (dropped.length) {
      // With dropUnmatched:false these are the same unmatched entries; already logged above.
    }

    const changed = JSON.stringify(remapped) !== JSON.stringify(mappings);
    if (changed) {
      rowsToUpdate += 1;
      if (APPLY) {
        const { error: updErr } = await supabase
          .from('stage_field_mapping_action')
          .update({ field_mappings: remapped })
          .eq('id', fma.id)
          .eq('tenant_id', TENANT_ID);
        if (updErr) {
          console.error(`    ERROR updating FMA ${fma.id}:`, updErr.message);
        } else {
          console.log(`    ✓ updated`);
        }
      }
    }
    console.log('');
  }

  console.log('================================================================');
  console.log(`Broken mappings repaired: ${totalRepaired}`);
  console.log(`Broken mappings unmatched (left as-is, needs manual fix): ${totalUnmatched}`);
  console.log(`Rows ${APPLY ? 'updated' : 'that would be updated'}: ${rowsToUpdate}`);
  if (!APPLY) console.log('\nDRY-RUN — no changes written. Re-run with --apply to persist.');
  console.log('================================================================');
}

run().catch((e) => { console.error(e); process.exit(1); });
