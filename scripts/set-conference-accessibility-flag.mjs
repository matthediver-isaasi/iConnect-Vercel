/**
 * set-conference-accessibility-flag.mjs
 *
 * One-off script: on the "Annual conference 2026 requirements" form
 * (form c6bf9742-5e4b-4972-9b0e-b4a08b8cee79, tenant fd82da65-aab7-4a5c-85b8-b2febeb2003d),
 * set the boolean field "Accessibility needs" (field_1782826635051) to `true`
 * for every submission that gave a REAL answer in the accessibility free-text
 * field (field_1773817890416).
 *
 * Per the request owner's decision, dismissive answers ("N/A", "None", "No",
 * etc.) are EXCLUDED — only substantive accessibility requests get flagged.
 *
 * Usage:
 *   node scripts/set-conference-accessibility-flag.mjs            # dry-run (safe)
 *   node scripts/set-conference-accessibility-flag.mjs --apply    # write to DB
 *
 * Idempotent: re-running is safe (submissions already true are skipped).
 * Writes a pre-apply backup of every affected submission's prior value.
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';

const DRY_RUN = !process.argv.includes('--apply');

const FORM_ID   = 'c6bf9742-5e4b-4972-9b0e-b4a08b8cee79';
const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

const TEXT_FIELD = 'field_1773817890416'; // accessibility free-text question
const BOOL_FIELD = 'field_1782826635051'; // "Accessibility needs" boolean

// Exact-match dismissive tokens (after normalize + polite-filler stripping).
const DISMISSIVE_TOKENS = new Set([
  'n/a', 'na', 'n.a', 'n.a.', 'none', 'no', 'nope', 'nil', 'not applicable',
  '-', '.', 'x', 'n', 'no needs', 'testing', 'test',
]);

// Junk / test submissions that are not genuine answers.
const JUNK_PATTERNS = [/^test(ing)?$/];

// Phrase-level "no needs" leads: a real request never begins this way.
const DISMISSIVE_LEAD = /^(no|none|nothing|nil|nope)\b(?:\s+(?:additional|specific|particular|special|adjustments?|adaptations?|amendments?|alterations?|accommodations?|accessibility|access|requirements?|required|needs?|needed|necessary|expected|in\s+particular|at\s+(?:this|the)\s+(?:time|moment|stage)|for\s+me|that\s+i\s+can\s+think\s+of|i\s+can\s+think\s+of|to\s+(?:add|mention|note|report|declare|flag))?)*$/;

function normalize(str) {
  return String(str).trim().toLowerCase().replace(/[.!,;:\s]+$/g, '').trim();
}

// Strip polite filler so the dismissive core can be matched.
function coreText(str) {
  let s = normalize(str).replace(/[.,!;:]+/g, ' ');
  s = s.replace(/\b(thank you so much|many thanks|thank-you|thank you|thankyou|thanks|please|kind regards|best regards|regards|cheers)\b/g, ' ');
  s = s.replace(/\b(really\s+)?looking forward to (it|this|the event|the conference|attending|seeing (you|everyone|you all)).*$/g, ' ');
  s = s.replace(/\b(really\s+)?looking forward.*$/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// Returns true when the answer represents a REAL accessibility request.
function isRealAccessibilityAnswer(value) {
  if (value === undefined || value === null) return false;
  const str = typeof value === 'string' ? value : String(value);
  if (str.trim() === '') return false;
  const core = coreText(str);
  if (core === '') return false;
  if (DISMISSIVE_TOKENS.has(core)) return false;
  if (JUNK_PATTERNS.some(re => re.test(core))) return false;
  if (DISMISSIVE_LEAD.test(core)) return false;
  return true;
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
  console.log(`Text field: ${TEXT_FIELD}  →  Boolean field: ${BOOL_FIELD}\n`);

  // Fetch all submissions
  let allSubs = [];
  let from = 0;
  const PAGE_SIZE = 500;
  while (true) {
    const { data: page, error } = await sb
      .from('form_submission')
      .select('id, submission_data')
      .eq('form_id', FORM_ID)
      .eq('tenant_id', TENANT_ID)
      .range(from, from + PAGE_SIZE - 1);
    if (error) { console.error('Fetch error:', error.message); process.exit(1); }
    if (!page || page.length === 0) break;
    allSubs = allSubs.concat(page);
    from += PAGE_SIZE;
    if (page.length < PAGE_SIZE) break;
  }
  console.log(`Fetched ${allSubs.length} submissions\n`);

  const toUpdate = [];
  const excludedDismissive = [];
  let alreadyTrue = 0;

  for (const sub of allSubs) {
    const text = sub.submission_data?.[TEXT_FIELD];
    if (!isRealAccessibilityAnswer(text)) {
      if (text !== undefined && text !== null && String(text).trim() !== '') {
        excludedDismissive.push({ id: sub.id, text: String(text).slice(0, 60) });
      }
      continue;
    }
    // Real answer → ensure boolean is true
    const current = sub.submission_data?.[BOOL_FIELD];
    if (current === true) { alreadyTrue++; continue; }

    const newData = { ...sub.submission_data, [BOOL_FIELD]: true };
    toUpdate.push({
      id: sub.id,
      submission_data: newData,
      _prior: current,
      _text: String(text).slice(0, 80),
    });
  }

  console.log(`Real accessibility answers (will set true): ${toUpdate.length + alreadyTrue}`);
  console.log(`  - already true (skipped): ${alreadyTrue}`);
  console.log(`  - to update: ${toUpdate.length}`);
  console.log(`Dismissive answers excluded: ${excludedDismissive.length}\n`);

  console.log('=== SUBMISSIONS TO BE SET true ===');
  toUpdate.forEach(u => console.log(`  ${u.id.slice(0, 8)}  prior=${JSON.stringify(u._prior)}  text="${u._text}"`));

  console.log('\n=== DISMISSIVE (excluded) ===');
  excludedDismissive.forEach(e => console.log(`  ${e.id.slice(0, 8)}  text="${e.text}"`));

  // Pre-apply backup artifact
  if (!DRY_RUN && toUpdate.length > 0) {
    mkdirSync('.local/backups', { recursive: true });
    const backupPath = `.local/backups/accessibility-flag-backup-${Date.now()}.json`;
    writeFileSync(backupPath, JSON.stringify(
      toUpdate.map(u => ({ id: u.id, prior_bool_value: u._prior ?? null, text: u._text })),
      null, 2
    ));
    console.log(`\nBackup written: ${backupPath}`);
  }

  if (DRY_RUN) {
    console.log('\n✓ DRY-RUN complete. No changes written. Pass --apply to execute.');
    return;
  }

  // Apply updates with strict failure tracking
  console.log(`\nUpdating ${toUpdate.length} submissions...`);
  let updated = 0;
  const failures = [];
  for (const item of toUpdate) {
    const { error } = await sb
      .from('form_submission')
      .update({ submission_data: item.submission_data })
      .eq('id', item.id)
      .eq('form_id', FORM_ID);
    if (error) failures.push({ id: item.id, error: error.message });
    else updated++;
  }
  console.log(`✓ Updated ${updated}/${toUpdate.length} submissions`);
  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} update(s) FAILED:`);
    failures.forEach(f => console.error(`  ${f.id}: ${f.error}`));
    process.exit(1);
  }

  // Verify
  const { data: verify } = await sb
    .from('form_submission')
    .select('id, submission_data')
    .eq('form_id', FORM_ID)
    .eq('tenant_id', TENANT_ID);
  let trueCount = 0, realButNotTrue = 0;
  (verify || []).forEach(s => {
    const isReal = isRealAccessibilityAnswer(s.submission_data?.[TEXT_FIELD]);
    const b = s.submission_data?.[BOOL_FIELD];
    if (b === true) trueCount++;
    if (isReal && b !== true) realButNotTrue++;
  });
  console.log(`\n=== VERIFICATION ===`);
  console.log(`Submissions with "${BOOL_FIELD}" === true: ${trueCount}`);
  console.log(`Real answers NOT flagged true (should be 0): ${realButNotTrue}`);
  console.log('\n✓ Migration complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
