import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  getTierEffectivePeriod,
  getTierLifecycle,
  getTierScopeLabel,
  filterTierStructures,
  groupTierStructures,
  isHistoricalTierSelection,
  isTierSelectionReadOnly,
  shouldBootstrapTierSelection,
  isAnnualTierStructure,
} from './membershipTierNavigation.js';

const date = value => value ? value.replaceAll('-', '/') : '';
const pageSource = readFileSync(new URL('../pages/MembershipTierManagement.jsx', import.meta.url), 'utf8');

test('groups structures by their API lifecycle without changing semantics', () => {
  const grouped = groupTierStructures([
    { id: 'a', status: 'active' },
    { id: 's', status: 'scheduled' },
    { id: 'h', status: 'historical' },
  ]);
  assert.deepEqual(grouped.active.map(x => x.id), ['a']);
  assert.deepEqual(grouped.scheduled.map(x => x.id), ['s']);
  assert.deepEqual(grouped.historical.map(x => x.id), ['h']);
});

test('filters structures by normalized displayed name, lifecycle, scope, and effective period', () => {
  const items = [
    { id: 'north', name: 'Regional rates', status: 'active', structure_field_id: 'region', structure_match_value: 'North', effective_from: '2026-01-01' },
    { id: 'future', name: 'Standard fees', status: 'scheduled', structure_scope_type: 'member', effective_from: '2027-04-01' },
    { id: 'past', name: 'Legacy pricing', status: 'historical', effective_from: '2025-01-01', effective_to: '2025-12-31' },
  ];
  const options = { formatDate: date, getFieldLabel: item => item.structure_field_id === 'region' ? 'Region' : undefined };

  assert.deepEqual(filterTierStructures(items, '  REGIONAL ', options).map(x => x.id), ['north']);
  assert.deepEqual(filterTierStructures(items, 'current', options).map(x => x.id), ['north']);
  assert.deepEqual(filterTierStructures(items, 'member', options).map(x => x.id), ['future']);
  assert.deepEqual(filterTierStructures(items, '2025/12/31', options).map(x => x.id), ['past']);
  assert.equal(filterTierStructures(items, 'missing', options).length, 0);
  assert.equal(filterTierStructures(items, '', options), items);
});

test('describes scoped and unscoped structures clearly', () => {
  assert.equal(getTierScopeLabel({ structure_scope_type: 'member' }), 'All members');
  assert.equal(getTierScopeLabel({
    structure_scope_type: 'organization',
    structure_field_id: 'region',
    structure_match_value: 'North',
  }, 'Region'), 'Organisation · Region = North');
});

test('formats scheduled, current and historical effective periods', () => {
  assert.equal(getTierEffectivePeriod({ status: 'scheduled', effective_from: '2027-01-01' }, date), 'Starts 2027/01/01');
  assert.equal(getTierEffectivePeriod({ status: 'active', effective_from: '2026-01-01' }, date), '2026/01/01 – Present');
  assert.equal(getTierEffectivePeriod({
    status: 'historical',
    effective_from: '2025-01-01',
    effective_to: '2025-12-31',
  }, date), '2025/01/01 – 2025/12/31');
  assert.equal(getTierLifecycle({ effective_to: '2025-12-31' }), 'historical');
});

test('historical selection becomes read-only from navigation data before detail loading', () => {
  const items = [
    { id: 'scheduled', status: 'scheduled' },
    { id: 'past', status: 'historical' },
  ];
  assert.equal(isHistoricalTierSelection('past', items), true);
  assert.equal(isHistoricalTierSelection('scheduled', items), false);
  assert.equal(isHistoricalTierSelection(null, items), false);
});

test('server-immutable structures are read-only even while still date-active', () => {
  const items = [
    { id: 'ending-current', status: 'active', effective_to: '2026-12-31' },
    { id: 'open-current', status: 'active', effective_to: null },
  ];
  assert.equal(isTierSelectionReadOnly('ending-current', items), true);
  assert.equal(isTierSelectionReadOnly('open-current', items), false);
});

test('tier list refetches do not replace an explicit editor selection', () => {
  assert.equal(shouldBootstrapTierSelection({
    selectedId: null,
    viewingHistorical: null,
    isCreatingNew: false,
  }), true);
  assert.equal(shouldBootstrapTierSelection({
    selectedId: 'selected-active',
    viewingHistorical: null,
    isCreatingNew: false,
  }), false);
  assert.equal(shouldBootstrapTierSelection({
    selectedId: null,
    viewingHistorical: 'historical',
    isCreatingNew: false,
  }), false);
  assert.equal(shouldBootstrapTierSelection({
    selectedId: null,
    viewingHistorical: null,
    isCreatingNew: true,
  }), false);
});

test('annual renewal visibility is based on the structure period, not payment rails', () => {
  assert.equal(isAnnualTierStructure({ billing_period: 'annual' }), true);
  assert.equal(isAnnualTierStructure({ billing_period: 'annual', dd_enabled: true }), true);
  assert.equal(isAnnualTierStructure({ billing_period: 'annual', card_monthly_enabled: true }), true);
  assert.equal(isAnnualTierStructure({ billing_period: 'monthly' }), false);
  assert.equal(isAnnualTierStructure({ billing_period: 'quarterly' }), false);
});

test('membership tier editor uses the annual structure boundary for policy controls and summary', () => {
  assert.match(pageSource, /const isAnnualStructure = isAnnualTierStructure\(config\)/);
  assert.equal((pageSource.match(/\{isAnnualStructure && \(/g) || []).length, 2);
  assert.match(pageSource, /This policy applies to annual, non-recurring memberships/);
  assert.match(pageSource, /active recurring agreement continue through the recurring lifecycle/);
  assert.doesNotMatch(pageSource, /isAnnualNonRecurring/);
});

test('page enters the structure browser first and editor renders only the loaded card', () => {
  assert.match(pageSource, /useState\('list'\)/);
  assert.match(pageSource, /data-testid="tier-structure-browser"/);
  assert.match(pageSource, /!isCreatingNew && loadedHistoryItem && renderStructureNavItem\(loadedHistoryItem\)/);
  assert.doesNotMatch(pageSource, /summary-loaded-context/);
});

test('structure browser exposes responsive search, accessible view switching, both renderers and distinct result states', () => {
  assert.match(pageSource, /aria-label="Search tier structures"/);
  assert.match(pageSource, /role="group" aria-label="Structure view"/);
  assert.match(pageSource, /aria-pressed=\{structureViewMode === 'card'\}/);
  assert.match(pageSource, /aria-pressed=\{structureViewMode === 'list'\}/);
  assert.match(pageSource, /sm:flex-row sm:items-center/);
  assert.match(pageSource, /structure-card-\$\{item\.id\}/);
  assert.match(pageSource, /structure-row-\$\{item\.id\}/);
  assert.match(pageSource, /historyItems\.length === 0/);
  assert.match(pageSource, /filteredStructures\.length === 0/);
  assert.match(pageSource, /groupedStructures\[key\]\.length/);
});

test('structure browser derivation hooks run before the access-loading early return', () => {
  const filteredHookIndex = pageSource.indexOf('const filteredStructures = useMemo');
  const groupedHookIndex = pageSource.indexOf('const groupedStructures = useMemo');
  const accessReturnIndex = pageSource.indexOf('if (!accessChecked)');

  assert.notEqual(filteredHookIndex, -1);
  assert.notEqual(groupedHookIndex, -1);
  assert.notEqual(accessReturnIndex, -1);
  assert.ok(filteredHookIndex < accessReturnIndex);
  assert.ok(groupedHookIndex < accessReturnIndex);
});

test('duplicate drafts retain Direct Debit settings and per-band monthly amounts', () => {
  const duplicateHandler = pageSource.slice(
    pageSource.indexOf('const handleDuplicateHistorical'),
    pageSource.indexOf('const handleSwitchActiveConfig'),
  );
  assert.match(duplicateHandler, /\.\.\.ddFieldsFromConfig\(c\)/);
  assert.match(duplicateHandler, /dd_monthly_amount: b\.dd_monthly_amount != null/);
});