#!/usr/bin/env node
/*
 * Create (or update) the "BNMS Mentee application form" for the BNMS tenant.
 *
 * Recreates the legacy YourMembership custom form as a native platform Form so
 * it appears in /FormManagement and can be previewed/submitted like any other
 * standard (vertical) form.
 *
 * Idempotent: matches an existing form by (tenant_id, name). Re-running updates
 * that row's fields/visibility_rules in place instead of creating a duplicate.
 *
 * Usage:
 *   node scripts/create-bnms-mentee-application-form.mjs           # dry-run
 *   node scripts/create-bnms-mentee-application-form.mjs --apply   # write
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

const FORM_NAME = 'BNMS Mentee application form';
const FORM_SLUG = 'bnms-mentee-application-form';

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

// --- Applicant details -------------------------------------------------------
addField({
  type: 'select',
  label: 'Title',
  required: true,
  options: ['Mr', 'Mrs', 'Miss', 'Ms', 'Dr', 'Prof', 'Mx', 'No title preferred'],
});
addField({ type: 'text', label: 'First Name', required: true, max_characters: 50 });
addField({ type: 'text', label: 'Last Name', required: true, max_characters: 50 });
addField({ type: 'email', label: 'Email Address', required: true, max_characters: 100 });
addField({ type: 'text', label: 'Job Title', required: true });
addField({ type: 'textarea', label: 'Main responsibilities of your job', required: true });

// --- Organisation / department and contact address ---------------------------
addInstruction('ORGANISATION/DEPARTMENT AND CONTACT ADDRESS');
addField({ type: 'text', label: 'Department', required: true });
addField({ type: 'text', label: 'Trust', required: true });
addField({ type: 'text', label: 'Address Line 1', required: true });
addField({ type: 'text', label: 'Address Line 2', required: true });
addField({ type: 'text', label: 'Town/City', required: true });
addField({ type: 'text', label: 'County', required: true });
addField({ type: 'text', label: 'Postal Code', required: true });
addField({ type: 'tel', label: 'Telephone number', required: true });

// --- Sharing your details ----------------------------------------------------
addInstruction(
  'SHARING YOUR DETAILS',
  '<p>Please indicate that you are happy for your details to be shared with our mentors</p>'
);
addField({
  type: 'checkbox',
  label: "I'm happy",
  required: true,
  options: ['Yes I\u2019m happy for my application details to be shared with BNMS mentors'],
});

// --- Previous mentoring relationships ----------------------------------------
addInstruction(
  'PREVIOUS MENTORING RELATIONSHIPS',
  '<p>Please provide a summary of any mentoring that you have received in the past:</p>'
);
addField({ type: 'textarea', label: 'Previous mentoring summary', required: false });

// --- Your profile - about you ------------------------------------------------
addInstruction(
  'YOUR PROFILE - ABOUT YOU',
  '<p>The information you provide here will be passed to potential mentors to help them decide whether they are able to support you. Please tell us a little about yourself.</p>'
);
addField({ type: 'textarea', label: 'About you', required: true });

// --- Your profile - background and experience --------------------------------
addInstruction(
  'YOUR PROFILE - BACKGROUND AND EXPERIENCE',
  '<p>This concerns your professional background and any specialist experience</p>'
);
const ID_BACKGROUND_MULTI = addField({
  type: 'checkbox',
  label: 'Please tick all that apply and specify where appropriate',
  required: true,
  options: [
    'General management',
    'Administrative & Clerical',
    'Technical',
    'Clinical',
    'Finance/Information',
    'Human Resources',
    'Public Health/Health Promotion',
    'Ex general management trainee',
    'Ex financial management trainee',
    'Education',
    'Local government',
    'Private sector',
    'Other',
  ],
});
const ID_BACKGROUND_OTHER = addField({
  type: 'text',
  label: 'If your response to the above was Other, please provide details',
  required: false,
  starts_hidden: true,
});

// --- Your profile - level ----------------------------------------------------
addInstruction(
  'YOUR PROFILE - LEVEL',
  '<p>Please select your level in your organisation</p>'
);
const ID_LEVEL = addField({
  type: 'select',
  label: 'Please select your level in your organisation',
  required: true,
  // Options TBC — see task Open questions. Placeholder only; do not invent list.
  options: ['\u2014 Options to be confirmed \u2014'],
  description: 'Note: dropdown options to be confirmed by BNMS.',
});
const ID_LEVEL_OTHER = addField({
  type: 'text',
  label: 'If your response to your above selection was Other, please detail',
  required: false,
  starts_hidden: true,
});
addField({
  type: 'select',
  label: 'Your Profile - Gender',
  required: true,
  options: ['\u2014 Options to be confirmed \u2014'],
  description: 'Note: dropdown options to be confirmed by BNMS.',
});
addField({
  type: 'select',
  label: 'Your Profile - pronouns',
  required: true,
  options: ['\u2014 Options to be confirmed \u2014'],
  description: 'Note: dropdown options to be confirmed by BNMS.',
});

// --- Your profile - organisation ---------------------------------------------
addInstruction('YOUR PROFILE - ORGANISATION', '<p>Type of Organisation</p>');
const ID_ORGTYPE = addField({
  type: 'select',
  label: 'What is the type of your organisation?',
  required: true,
  options: ['\u2014 Options to be confirmed \u2014'],
  description: 'Note: dropdown options to be confirmed by BNMS.',
});
const ID_ORGTYPE_OTHER = addField({
  type: 'text',
  label: 'If your answer to the above question was other, please detail',
  required: false,
  starts_hidden: true,
});

// --- Your mentor -------------------------------------------------------------
addInstruction('YOUR MENTOR', '<p>Mentor criteria</p>');
addField({
  type: 'textarea',
  label:
    'Are there any specific characteristics you are looking for in a mentor (background, experience etc)?',
  required: false,
});

// --- Meeting preferences -----------------------------------------------------
addInstruction('MEETING PREFERENCES');
addField({
  type: 'select',
  label: 'Preferred meeting format',
  required: true,
  options: ['\u2014 Options to be confirmed \u2014'],
  description: 'Note: dropdown options to be confirmed by BNMS.',
});
addField({
  type: 'select',
  label: 'Preferred meeting frequency',
  required: true,
  options: ['\u2014 Options to be confirmed \u2014'],
  description: 'Note: dropdown options to be confirmed by BNMS.',
});
addField({ type: 'text', label: 'Location of work base', required: false });
addField({
  type: 'textarea',
  label: 'Preferred meeting place',
  required: false,
  description:
    'Meetings may take place virtually or face-to-face. Please indicate your preferred meeting place and any relevant considerations.',
});

// --- By submitting this form -------------------------------------------------
addInstruction('By submitting this form');
addField({
  type: 'checkbox',
  label: 'Confirmation',
  required: true,
  options: [
    'I confirm that the information I have provided in this application is accurate.',
  ],
});
addInstruction(
  '',
  '<p>If you have any questions about this form or aspects of the mentorship programme please contact us: angelicaspina@bnms.org.uk</p>'
);

// --- Conditional-logic rules: show "If Other" detail fields -------------------
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

// Background & experience is a multi-select checkbox -> use "contains".
showWhen(ID_BACKGROUND_MULTI, 'contains', 'Other', ID_BACKGROUND_OTHER);
// Level / Organisation type are single-select dropdowns -> use "equals".
// (These fire once the real option list including "Other" is configured.)
showWhen(ID_LEVEL, 'equals', 'Other', ID_LEVEL_OTHER);
showWhen(ID_ORGTYPE, 'equals', 'Other', ID_ORGTYPE_OTHER);

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
    description: 'BNMS mentorship-programme mentee application form.',
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
