#!/usr/bin/env node
/*
 * Create (or update) the "BNMS Celebrations" form for the BNMS tenant.
 *
 * Recreates the legacy custom form as a native platform Form so it appears in
 * /FormManagement and can be previewed/submitted like any other standard
 * (vertical) form. Members use it to highlight colleagues who are retiring or
 * deserve recognition to the Honorary Secretary, for the monthly Newsletter,
 * the BNMS website and social media.
 *
 * Follows the same recreation pattern as
 * scripts/create-bnms-mentee-application-form.mjs.
 *
 * Idempotent: matches an existing form by (tenant_id, name). Re-running updates
 * that row's fields/visibility_rules in place instead of creating a duplicate.
 *
 * Usage:
 *   node scripts/create-bnms-celebrations-form.mjs           # dry-run
 *   node scripts/create-bnms-celebrations-form.mjs --apply   # write
 *
 * DB access uses @supabase/supabase-js against the DEST (prod) project, per
 * replit.md ("Database connection"). The Supabase direct host is unreachable
 * from this workspace; the REST endpoint used here is IPv4-reachable.
 */
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const FORM_NAME = 'BNMS Celebrations';
const FORM_SLUG = 'bnms-celebrations';

// Stable, unique field id generator (matches the builder's field_<n> shape).
let seq = 1700000000000;
const fid = () => `field_${seq++}`;

const fields = [];
const rules = [];

const addField = (f) => {
  const base = {
    id: f.id || fid(),
    type: f.type,
    label: f.label || '',
    options: f.options || [],
    page_id: null,
    required: Boolean(f.required),
    allow_other: Boolean(f.allow_other),
    description: f.description || '',
    placeholder: f.placeholder || '',
    column_index: 0,
    starts_hidden: Boolean(f.starts_hidden),
  };
  if (f.type === 'instructions') base.content = f.content || '';
  if (f.max_characters) base.max_characters = f.max_characters;
  fields.push(base);
  return base.id;
};

const addInstruction = (label, content = '') =>
  addField({ type: 'instructions', label, content });

// --- Intro copy (display-only, top of form) ----------------------------------
addInstruction(
  '',
  '<p>We are asking members to highlight to the Honorary Secretary any colleagues who are retiring or deserve a shoutout for achievements in nuclear medicine.</p>' +
    '<p>These will be recognised in the monthly Newsletter, the BNMS website and on social media.</p>' +
    '<p>Please complete the form below</p>'
);

// --- Proposer details --------------------------------------------------------
addField({ type: 'text', label: 'Proposer First Name', required: true, max_characters: 50 });
addField({ type: 'text', label: 'Proposer Last Name', required: true, max_characters: 50 });
addField({ type: 'email', label: 'Proposer Email Address', required: true, max_characters: 100 });

// --- Person to be celebrated -------------------------------------------------
addField({
  type: 'text',
  label: 'Name and title of person to be celebrated',
  required: true,
});

const ID_REASON = addField({
  type: 'select',
  label: 'Reason for celebration',
  required: true,
  // Options TBC — see task Open questions. Placeholder only; do not invent list.
  // "Other" is included so the conditional detail field below can fire.
  options: ['\u2014 Options to be confirmed \u2014', 'Other'],
  description: 'Note: dropdown options to be confirmed by BNMS.',
});
const ID_REASON_OTHER = addField({
  type: 'text',
  label: 'If Other, please provide details',
  required: false,
  starts_hidden: true,
});

addField({
  type: 'textarea',
  label:
    'Please describe in maximum 200 words why you would like to celebrate this person',
  required: true,
});

addField({
  type: 'file',
  label: 'Please upload a photo of the person to be celebrated',
  required: false,
});

// --- Conditional-logic rules: show "If Other" detail field -------------------
let ruleSeq = 1700900000000;
const rid = () => `rule_${ruleSeq++}`;
const cid = () => `cond_${ruleSeq++}`;
const aid = () => `action_${ruleSeq++}`;

const showWhen = (triggerFieldId, operator, value, targetFieldId) => {
  rules.push({
    id: rid(),
    logic: 'and',
    actions: [
      {
        id: aid(),
        action_type: 'visibility',
        field_states: {
          [targetFieldId]: { enabled: null, visible: true },
        },
      },
    ],
    conditions: [
      { id: cid(), value, field_id: triggerFieldId, operator },
    ],
  });
};

// Reason for celebration is a single-select dropdown -> use "equals".
showWhen(ID_REASON, 'equals', 'Other', ID_REASON_OTHER);

async function main() {
  const { data: tenant, error: tErr } = await supabase
    .from('tenant')
    .select('id, slug, name')
    .eq('slug', 'bnms')
    .single();
  if (tErr || !tenant) {
    console.error('Failed to resolve BNMS tenant:', tErr?.message);
    process.exit(1);
  }
  console.log('Tenant:', tenant.id, tenant.slug);
  console.log('Fields:', fields.length, '| Visibility rules:', rules.length);

  const { data: existing, error: exErr } = await supabase
    .from('form')
    .select('id, name, slug')
    .eq('tenant_id', tenant.id)
    .eq('name', FORM_NAME)
    .maybeSingle();
  if (exErr) {
    console.error('Lookup failed:', exErr.message);
    process.exit(1);
  }

  const payload = {
    name: FORM_NAME,
    slug: FORM_SLUG,
    description:
      'Highlight colleagues retiring or deserving recognition in nuclear medicine to the Honorary Secretary.',
    layout_type: 'standard',
    is_contract: false,
    is_active: true,
    require_authentication: false,
    submit_button_text: 'Submit',
    success_message: 'Thank you for your submission!',
    fields,
    pages: [],
    visibility_rules: rules,
    entity_pipelines: { members: [], organisations: [] },
    tenant_id: tenant.id,
  };

  if (!APPLY) {
    console.log('\n[DRY-RUN] Would', existing ? `UPDATE form ${existing.id}` : 'CREATE new form');
    console.log('Field summary:');
    fields.forEach((f, i) =>
      console.log(
        `  ${String(i + 1).padStart(2)}. [${f.type}]${f.required ? '*' : ' '} ${f.label || '(section body)'}${f.starts_hidden ? '  (hidden)' : ''}`
      )
    );
    console.log('\nRe-run with --apply to write.');
    return;
  }

  if (existing) {
    // Keep the existing slug to avoid breaking any public URL already shared.
    const { slug, ...updateFields } = payload;
    const { error } = await supabase
      .from('form')
      .update(updateFields)
      .eq('id', existing.id)
      .eq('tenant_id', tenant.id);
    if (error) {
      console.error('Update failed:', error.message);
      process.exit(1);
    }
    console.log('Updated existing form:', existing.id);
  } else {
    const { data, error } = await supabase
      .from('form')
      .insert(payload)
      .select('id, name, slug')
      .single();
    if (error) {
      console.error('Insert failed:', error.message);
      process.exit(1);
    }
    console.log('Created form:', data.id, data.slug);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
