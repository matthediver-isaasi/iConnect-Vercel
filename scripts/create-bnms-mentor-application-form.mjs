#!/usr/bin/env node
/*
 * Create (or update) the "BNMS Mentoring Scheme - Mentor Application" form for
 * the BNMS tenant.
 *
 * Recreates the legacy YourMembership custom form as a native platform Form so
 * it appears in /FormManagement and can be previewed/submitted like any other
 * standard (vertical) form. Companion to create-bnms-mentee-application-form.mjs.
 *
 * Idempotent: matches an existing form by (tenant_id, name). Re-running updates
 * that row's fields/visibility_rules in place instead of creating a duplicate.
 *
 * Usage:
 *   node scripts/create-bnms-mentor-application-form.mjs           # dry-run
 *   node scripts/create-bnms-mentor-application-form.mjs --apply   # write
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

const FORM_NAME = 'BNMS Mentoring Scheme - Mentor Application';
const FORM_SLUG = 'bnms-mentoring-scheme-mentor-application';

// Stable, unique field id generator (matches the builder's field_<n> shape).
let seq = 1700100000000;
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
addField({ type: 'text', label: 'Job Title', required: true });
addField({ type: 'text', label: 'Grade', required: true });
addField({ type: 'textarea', label: 'Main responsibilities of your job', required: true });

// --- Organisation / department and contact address ---------------------------
addField({
  type: 'textarea',
  label: 'Organisation/Department and Contact Address',
  required: true,
});
addField({ type: 'tel', label: 'Organisation Telephone', required: true });
addField({ type: 'email', label: 'Organisation Email', required: true, max_characters: 100 });
addField({
  type: 'select',
  label: 'Have you attended any formal monitoring training?',
  required: true,
  options: ['Yes', 'No'],
});

// --- Sharing your details ----------------------------------------------------
addInstruction(
  'SHARING YOUR DETAILS',
  '<p>Please indicate whether you would be happy for your details to be given to other mentors who may be interested in networking.</p>'
);
addField({
  type: 'select',
  label: 'Sharing your details choice',
  required: true,
  options: ['Yes', 'No'],
});

// --- Mentor availability -----------------------------------------------------
addInstruction('MENTOR AVAILABILITY', '<p>Please indicate your availability:</p>');
addField({ type: 'textarea', label: 'Please indicate your availability', required: false });

// --- Current mentoring relationships -----------------------------------------
addInstruction(
  'CURRENT MENTORING RELATIONSHIPS',
  '<p>Please provide a summary of your mentoring experience</p>'
);
addField({ type: 'textarea', label: 'Summary of your mentoring experience', required: false });

// --- Meeting preferences -----------------------------------------------------
addInstruction('MEETING PREFERENCES');
addField({
  type: 'select',
  label: 'Preferred meeting format',
  required: true,
  // Options TBC — source lists no choices. Placeholder only; do not invent list.
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

// --- Your profile - background & experience ----------------------------------
addInstruction(
  'YOUR PROFILE - BACKGROUND & EXPERIENCE',
  '<p>This concerns your professional background and any specialist experience - please mark all that apply and specify where appropriate.</p>'
);
const ID_BACKGROUND_MULTI = addField({
  type: 'checkbox',
  label: 'Background',
  required: true,
  options: [
    'Radiologist',
    'Nuclear Medicine Physician',
    'Administration & Clerical',
    'Technologist',
    'Radiographer',
    'Medical Physicist',
    'Nurse',
    'Radio-pharmacist/chemist',
    'Healthcare Assistant',
    'Other background',
  ],
});
const ID_BACKGROUND_OTHER = addField({
  type: 'text',
  label: 'If Other background, please specify',
  required: false,
  starts_hidden: true,
});
const ID_EXPERIENCE_MULTI = addField({
  type: 'checkbox',
  label: 'Experience',
  required: true,
  options: [
    'Service Leadership',
    'Administrative & Clerical',
    'Equipment Management',
    'Clinical - Diagnostic NM',
    'Clinical - Therapeutic NM',
    'Clinical - DEXA',
    'Clinical Reporting',
    'Documentation: policies, risk assessments',
    'Radiation Protection',
    'Education',
    'Scientific',
    'Research & Innovation',
    'Staff Management',
    'Radiopharmacy',
    'Other Experience',
  ],
});
const ID_EXPERIENCE_OTHER = addField({
  type: 'text',
  label: 'If Other experience, please specify',
  required: false,
  starts_hidden: true,
});

// --- Educational experience / roles ------------------------------------------
addInstruction(
  'EDUCATIONAL EXPERIENCE/ROLES',
  '<p>Please give details of any relevant educational experience/roles</p>'
);
addField({ type: 'textarea', label: 'Educational Experience', required: true });

// --- What can you offer a mentee? --------------------------------------------
addInstruction(
  'WHAT CAN YOU OFFER A MENTEE?',
  '<p>This is the only information that will be passed onto potential mentees and is your opportunity to outline your skills, experience and qualities. The remaining data will be used to match you with any requirements specified by the mentee and for evaluation purposes.</p>'
);
addField({ type: 'textarea', label: 'MENTOR PROFILE', required: true });

// --- Location of work base ---------------------------------------------------
addInstruction('LOCATION OF WORK BASE');
addField({ type: 'text', label: 'Preferred meeting place', required: false });

// --- Accuracy / confirmation -------------------------------------------------
addInstruction('Accuracy');
addField({
  type: 'checkbox',
  label: 'Confirmation',
  required: true,
  options: [
    'By submitting this form, I confirm that the information I have provided in this application is accurate.',
  ],
});
addInstruction(
  '',
  '<p>If you have any questions about this form or aspects of the mentorship programme please contact us: angelicaspina@bnms.org.uk</p><p>For your records: once you have submitted your form, you will be able to print your submission on the next page for your records.</p>'
);

// --- Conditional-logic rules: show "If Other" detail fields -------------------
let ruleSeq = 1700910000000;
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

// Background & Experience are multi-select checkboxes -> use "contains".
// Values must match the option strings exactly.
showWhen(ID_BACKGROUND_MULTI, 'contains', 'Other background', ID_BACKGROUND_OTHER);
showWhen(ID_EXPERIENCE_MULTI, 'contains', 'Other Experience', ID_EXPERIENCE_OTHER);

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
    description: 'BNMS mentorship-programme mentor application form.',
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
