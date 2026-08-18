/**
 * Task #3659 — fix the BNMS "Getting Started" membership application form
 * (tenant ff2df806-b321-4254-b651-3af11fccf1db) on the production (DEST)
 * database. Idempotent: every transformation is keyed on stable ids/values,
 * so re-running is a no-op.
 *
 * What it does:
 *  1. Aligns the "Member Class" radio options AND every rule value that
 *     reads/writes it with the membership structures' match values (which
 *     are also the "Member class" preference-field values), e.g.
 *     "Full member" -> "Full", "Overseas full member junior" ->
 *     "Overseas Full junior".
 *  2. Fixes the circular "Overseas full member junior" rewrite rule
 *     (rule_1787054287521) so it triggers on "Full junior" (the
 *     non-overseas class) + a non-UK work country.
 *  3. Replaces the single hardcoded membership rule (rule_1786382904202,
 *     pinned to the Full structure) with ONE auto-resolve rule: whenever a
 *     Member Class is set, the structure is resolved from that mapped
 *     answer at quote/charge time.
 *  4. Adds a visibility rule hiding the payment field for classes without
 *     a membership structure (Associate, Trainee, Student, and the UK
 *     "with NMC" variants) so those applications submit without payment
 *     instead of showing £0.
 *
 * Run: node scripts/fix-getting-started-form-3659.mjs [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';

const FORM_ID = '1b95a50e-2b5c-42f3-bf39-cc7fa69029d8';
const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const CLASS_FIELD = 'field_1786367685995';          // "Member Class" radio
const COUNTRY_FIELD = 'field_1786371332409';        // "What country do you work in?"
const PAYMENT_FIELD = 'field_1786382412640';        // payment field
const STRUCTURE_PREF_FIELD = '87f120ff-92e6-4d52-944b-9ba9d7b1fac0'; // "Member class" preference field
const MEMBERSHIP_RULE_ID = 'rule_1786382904202';    // old hardcoded rule
const CIRCULAR_RULE_ID = 'rule_1787054287521';
const HIDE_RULE_ID = 'rule_hide_payment_no_tier_3659';

// Old form values -> structure match values / preference-field values.
const VALUE_MAP = {
  'Associate member': 'Associate',
  'Full member': 'Full',
  'Full member junior': 'Full junior',
  'Full member with NMC': 'Full with NMC',
  'Full member junior with NMC': 'Full junior with NMC',
  'Overseas full member': 'Overseas Full',
  'Overseas full member junior': 'Overseas Full junior',
  'Overseas full member with NMC': 'Overseas Full with NMC',
  'Overseas full member junior with NMC': 'Overseas Full junior with NMC',
};

// Aligned option list = the preference field's values.
const NEW_CLASS_OPTIONS = [
  'Associate', 'Full', 'Full junior', 'Trainee', 'Student',
  'Full with NMC', 'Full junior with NMC',
  'Overseas Full', 'Overseas Full junior',
  'Overseas Full with NMC', 'Overseas Full junior with NMC',
];

// Classes with no membership structure today -> hide the payment field.
const NO_TIER_CLASSES = ['Associate', 'Trainee', 'Student', 'Full with NMC', 'Full junior with NMC'];

const dryRun = process.argv.includes('--dry-run');
const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;
if (!url || !key) { console.error('DEST_SUPABASE_URL / DEST_SUPABASE_KEY required'); process.exit(1); }
const sb = createClient(url, key);

const mapVal = (v) => (typeof v === 'string' && VALUE_MAP[v] !== undefined) ? VALUE_MAP[v] : v;

const { data: form, error } = await sb.from('form')
  .select('id, tenant_id, fields, visibility_rules')
  .eq('id', FORM_ID).eq('tenant_id', TENANT_ID).maybeSingle();
if (error || !form) { console.error('Form not found:', error?.message); process.exit(1); }

let changes = [];

// ── 1. Member Class field options ──────────────────────────────────────
const fields = (form.fields || []).map((f) => {
  if (f?.id !== CLASS_FIELD) return f;
  if (JSON.stringify(f.options) !== JSON.stringify(NEW_CLASS_OPTIONS)) {
    changes.push('class field options aligned with structure match values');
    return { ...f, options: NEW_CLASS_OPTIONS };
  }
  return f;
});

// ── 2-4. Rules ──────────────────────────────────────────────────────────
let rules = (form.visibility_rules || []).map((rule) => {
  if (!rule) return rule;
  let r = JSON.parse(JSON.stringify(rule));

  // 2a. Fix the circular rewrite rule FIRST (its condition value is what
  // makes it circular; the corrected trigger is the non-overseas junior
  // class, which after alignment is "Full junior").
  if (r.id === CIRCULAR_RULE_ID) {
    for (const c of r.conditions || []) {
      if (c.field_id === CLASS_FIELD && (c.value === 'Overseas full member junior' || c.value === 'Full member junior')) {
        c.value = 'Full junior';
        changes.push('circular junior-overseas rule now triggers on "Full junior"');
      }
    }
  }

  // 2b. Map every Member Class value in conditions and set_value actions.
  for (const c of r.conditions || []) {
    if (c.field_id === CLASS_FIELD && mapVal(c.value) !== c.value) {
      changes.push(`condition value "${c.value}" -> "${mapVal(c.value)}" (${r.id})`);
      c.value = mapVal(c.value);
    }
  }
  if (r.trigger_field_id === CLASS_FIELD && mapVal(r.value) !== r.value) {
    changes.push(`trigger value "${r.value}" -> "${mapVal(r.value)}" (${r.id})`);
    r.value = mapVal(r.value);
  }
  for (const a of r.actions || []) {
    if (a?.action_type === 'set_value' && a.target_field_id === CLASS_FIELD && mapVal(a.set_value) !== a.set_value) {
      changes.push(`set_value "${a.set_value}" -> "${mapVal(a.set_value)}" (${r.id})`);
      a.set_value = mapVal(a.set_value);
    }
  }

  // 3. Replace the hardcoded membership rule with the auto-resolve rule.
  if (r.id === MEMBERSHIP_RULE_ID) {
    const action = (r.actions || []).find((a) => a?.action_type === 'membership_structure');
    const wantConditions = [{ id: 'cond_membership_auto_3659', field_id: CLASS_FIELD, operator: 'not_empty', value: '' }];
    // NB: jsonb re-orders object keys, so compare semantically, not by JSON string.
    const c0 = (r.conditions || [])[0];
    const alreadyAuto = action?.resolve_mode === 'auto'
      && (r.conditions || []).length === 1
      && c0?.field_id === CLASS_FIELD && c0?.operator === 'not_empty'
      && (action.field_mappings || {})[STRUCTURE_PREF_FIELD] === CLASS_FIELD;
    if (!alreadyAuto) {
      changes.push('membership rule converted to auto-resolve (matches any Member Class)');
      r.logic = 'and';
      r.conditions = wantConditions;
      r.actions = [{
        id: action?.id || 'action_membership_auto_3659',
        action_type: 'membership_structure',
        resolve_mode: 'auto',
        config_id: '',
        field_mappings: { [STRUCTURE_PREF_FIELD]: CLASS_FIELD },
      }];
    }
  }
  return r;
});

// 4. Hide the payment field for classes with no structure.
if (!rules.some((r) => r?.id === HIDE_RULE_ID)) {
  changes.push('added hide-payment rule for classes without a membership structure');
  rules.push({
    id: HIDE_RULE_ID,
    logic: 'or',
    rule_type: 'visibility',
    conditions: NO_TIER_CLASSES.map((v, i) => ({
      id: `cond_hide_pay_3659_${i}`, field_id: CLASS_FIELD, operator: 'equals', value: v,
    })),
    actions: [{
      id: 'action_hide_pay_3659',
      action_type: 'visibility',
      field_states: { [PAYMENT_FIELD]: { enabled: null, visible: false } },
    }],
  });
}

if (changes.length === 0) {
  console.log('No changes needed — form already up to date.');
  process.exit(0);
}
console.log(`${dryRun ? '[dry-run] Would apply' : 'Applying'} ${changes.length} change(s):`);
for (const c of changes) console.log(' -', c);

if (!dryRun) {
  const { error: upErr } = await sb.from('form')
    .update({ fields, visibility_rules: rules })
    .eq('id', FORM_ID).eq('tenant_id', TENANT_ID);
  if (upErr) { console.error('Update failed:', upErr.message); process.exit(1); }
  console.log('Form updated.');
}
