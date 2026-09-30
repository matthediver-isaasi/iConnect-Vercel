// Removes blank ("" / whitespace-only) option strings from form.fields[].options.
//
// Dry-run by default; pass --apply to write changes.
// By default only fixes the affected BNMS form (slug below); pass --all to fix
// every form with blank options across all tenants. Always reports all forms
// found with blank options. image_options fields are skipped.
//
// Usage:
//   node scripts/fix-blank-form-options.mjs            # dry-run, report all, would-fix BNMS form
//   node scripts/fix-blank-form-options.mjs --apply    # fix BNMS form
//   node scripts/fix-blank-form-options.mjs --apply --all  # fix all affected forms

import { createClient } from '@supabase/supabase-js';

const TARGET_SLUG = 'bnms-mentoring-scheme-mentor-application';

const apply = process.argv.includes('--apply');
const fixAll = process.argv.includes('--all');

const supabase = createClient(
  process.env.DEST_SUPABASE_URL,
  process.env.DEST_SUPABASE_KEY,
  { auth: { persistSession: false } }
);

const isBlank = (opt) => typeof opt === 'string' && opt.trim() === '';

function cleanFields(fields) {
  let changed = false;
  const out = (fields || []).map((f) => {
    if (!Array.isArray(f?.options) || f?.type === 'image_options') return f;
    const cleaned = f.options.filter((o) => !isBlank(o));
    if (cleaned.length === f.options.length) return f;
    changed = true;
    return { ...f, options: cleaned };
  });
  return { changed, fields: out };
}

async function main() {
  console.log(`Mode: ${apply ? 'APPLY' : 'dry-run'}${fixAll ? ' (all forms)' : ` (fix only slug=${TARGET_SLUG})`}`);

  const pageSize = 500;
  let from = 0;
  const affected = [];
  for (;;) {
    const { data, error } = await supabase
      .from('form')
      .select('id, tenant_id, slug, name, fields')
      .order('id')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    for (const form of data || []) {
      const { changed, fields } = cleanFields(form.fields);
      if (changed) affected.push({ form, cleanedFields: fields });
    }
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  if (affected.length === 0) {
    console.log('No forms with blank options found.');
    return;
  }

  console.log(`\nForms with blank options: ${affected.length}`);
  for (const { form } of affected) {
    const blanks = (form.fields || [])
      .filter((f) => Array.isArray(f?.options) && f.type !== 'image_options')
      .map((f) => ({ label: f.label, n: f.options.filter(isBlank).length }))
      .filter((x) => x.n > 0);
    console.log(`- ${form.id} tenant=${form.tenant_id} slug=${form.slug} "${form.name}"`);
    for (const b of blanks) console.log(`    field "${b.label}": ${b.n} blank option(s)`);
  }

  const toFix = fixAll ? affected : affected.filter(({ form }) => form.slug === TARGET_SLUG);
  console.log(`\n${apply ? 'Fixing' : 'Would fix'} ${toFix.length} form(s).`);

  if (!apply) {
    console.log('Dry-run: no changes written. Re-run with --apply.');
    return;
  }

  for (const { form, cleanedFields } of toFix) {
    const { error } = await supabase
      .from('form')
      .update({ fields: cleanedFields })
      .eq('id', form.id);
    if (error) {
      console.error(`FAILED ${form.id}: ${error.message}`);
      process.exitCode = 1;
    } else {
      console.log(`Fixed ${form.id} (${form.slug})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
