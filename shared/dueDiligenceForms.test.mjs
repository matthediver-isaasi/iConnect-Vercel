import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAvailableDueDiligenceForm } from './dueDiligenceForms.js';

test('only unarchived due diligence forms are offered, including inactive restored forms', () => {
  const forms = [
    { id: 'current', due_diligence_required: true, archived_at: null },
    { id: 'legacy', due_diligence_required: true },
    { id: 'archived', due_diligence_required: true, archived_at: '2026-10-13T09:00:00Z' },
    { id: 'restored', due_diligence_required: true, archived_at: null, is_active: false },
    { id: 'ordinary', due_diligence_required: false },
  ];
  assert.deepEqual(forms.filter(isAvailableDueDiligenceForm).map(f => f.id), ['current', 'legacy', 'restored']);
  assert.equal(isAvailableDueDiligenceForm(null), false);
  assert.equal(forms.length, 5, 'historical records are not mutated');
});

test('dashboard choices are filtered without stripping historical field definitions', () => {
  const source = readFileSync(new URL('../client/src/pages/DueDiligenceDashboard.jsx', import.meta.url), 'utf8');
  assert.match(source, /allDdForms\.filter\(isAvailableDueDiligenceForm\)/);
  assert.match(source, /Object\.fromEntries\(allDdForms\.filter/);
  assert.match(source, /formsLoaded && selectedFormId !== 'all'/);
});

test('configuration blocks archived direct links and archive/restore invalidates the selectors', () => {
  const config = readFileSync(new URL('../client/src/pages/DueDiligenceConfig.jsx', import.meta.url), 'utf8');
  assert.match(config, /select: forms => forms\.filter\(isAvailableDueDiligenceForm\)/);
  assert.match(config, /if \(!form \|\| form\.archived_at\)/);
  assert.match(config, /select: forms => forms\.filter\(form => !form\.archived_at\)/);
  const management = readFileSync(new URL('../client/src/pages/FormManagement.jsx', import.meta.url), 'utf8');
  for (const key of ['dd-enabled-forms', 'form-for-dd-config', 'seedable-forms-all']) {
    assert.ok(management.includes(`invalidateQueries({ queryKey: ['${key}'] })`));
  }
});
