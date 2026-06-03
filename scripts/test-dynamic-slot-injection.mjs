/**
 * Regression test for Dynamic Text slot injection (Task #1247).
 *
 * The visual email builder's "Dynamic Text" block emits a `{{token}}`
 * placeholder into the rendered HTML/subject. Per-send slot values live in
 * design_json.slotValues and are substituted at send time by
 * applyDynamicSlotValues(). This test guards that:
 *   - every provided slot token is replaced in both html and subject
 *   - a missing/empty slot value collapses to empty (no literal token leaks)
 *   - unrelated {{placeholders}} are left untouched for downstream stages
 *
 * Run:
 *   node scripts/test-dynamic-slot-injection.mjs
 *
 * Exits non-zero on any failed assertion.
 */

import { applyDynamicSlotValues, isVisualTemplateRecord } from '../api/_lib/campaignService.js';

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures += 1;
  }
}

console.log('applyDynamicSlotValues — Dynamic Text slot injection tests');

const slotValues = { dynamic_1: 'Spring Sale', dynamic_2: '20% off' };

const html = '<h1>{{dynamic_1}}</h1><p>Save {{dynamic_2}} today, {{first_name}}.</p>';
const filled = applyDynamicSlotValues(html, slotValues);

assert(filled.includes('Spring Sale'), 'html: dynamic_1 replaced with value');
assert(filled.includes('20% off'), 'html: dynamic_2 replaced with value');
assert(!/\{\{dynamic_1\}\}/.test(filled), 'html: no raw dynamic_1 token leaks');
assert(!/\{\{dynamic_2\}\}/.test(filled), 'html: no raw dynamic_2 token leaks');
assert(filled.includes('{{first_name}}'), 'html: unrelated per-recipient placeholder is preserved');

const subject = 'Don\'t miss {{dynamic_1}}!';
const filledSubject = applyDynamicSlotValues(subject, slotValues);
assert(filledSubject === "Don't miss Spring Sale!", 'subject: token replaced');

// Empty slot value collapses to empty string (no literal token left behind).
const emptyFilled = applyDynamicSlotValues('<p>{{dynamic_1}}</p>', { dynamic_1: '' });
assert(emptyFilled === '<p></p>', 'empty slot value collapses to empty (no token leak)');

// No slotValues / non-object: html returned unchanged.
assert(applyDynamicSlotValues(html, null) === html, 'null slotValues returns html unchanged');
assert(applyDynamicSlotValues(html, undefined) === html, 'undefined slotValues returns html unchanged');

// A token present in html but absent from slotValues is left as-is (a later
// stage or a different send may resolve it; we must not blank it out here).
const partial = applyDynamicSlotValues('<p>{{dynamic_1}} {{dynamic_9}}</p>', { dynamic_1: 'Hi' });
assert(partial.includes('{{dynamic_9}}'), 'token absent from slotValues is left untouched');
assert(partial.includes('Hi'), 'token present in slotValues is still replaced when others are absent');

console.log('\nisVisualTemplateRecord — Group Email visual-only template guard');

// A legacy plain-HTML template MUST NOT qualify (cannot be selected/sent).
assert(isVisualTemplateRecord({ editor_type: 'html', design_json: null }) === false,
  'legacy html template (editor_type=html, no design) is NOT visual');
assert(isVisualTemplateRecord({ editor_type: 'html', design_json: { blocks: [] } }) === false,
  'editor_type=html with design still NOT visual (type wins)');
assert(isVisualTemplateRecord({}) === false, 'empty/undefined template is NOT visual');
assert(isVisualTemplateRecord(null) === false, 'null template is NOT visual');

// A genuine visual-builder template qualifies (object or JSON-string design).
assert(isVisualTemplateRecord({ editor_type: 'visual', design_json: { blocks: [{ type: 'TEXT' }] } }) === true,
  'visual template with object design.blocks IS visual');
assert(isVisualTemplateRecord({ editor_type: 'visual', design_json: JSON.stringify({ blocks: [] }) }) === true,
  'visual template with JSON-string design.blocks IS visual');

// editor_type=visual but malformed/missing blocks must fail closed.
assert(isVisualTemplateRecord({ editor_type: 'visual', design_json: null }) === false,
  'editor_type=visual with no design is NOT visual (fail closed)');
assert(isVisualTemplateRecord({ editor_type: 'visual', design_json: '{ not json' }) === false,
  'editor_type=visual with unparseable design is NOT visual');

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll assertions passed.');
