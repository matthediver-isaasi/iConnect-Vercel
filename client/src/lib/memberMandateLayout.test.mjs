import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  MEMBER_MANDATE_LAYOUT_FIELDS,
} from './memberMandateLayout.js';

const mandateIds = MEMBER_MANDATE_LAYOUT_FIELDS.map(field => field.id);
// Execute the actual default layout and load-time migration without importing
// the live API client or mounting an authenticated query.
const hookSource = await readFile(new URL('../hooks/useMemberDetailLayout.js', import.meta.url), 'utf8');
const layoutSource = hookSource.slice(hookSource.indexOf('const LAYOUT_SETTING_KEY'),
  hookSource.indexOf('export const MEMBER_CORE_FIELDS')).replaceAll('export ', '');
const migrate = vm.runInNewContext(`${layoutSource}; migrateLayoutWithColumnIndex`, { MEMBER_MANDATE_LAYOUT_FIELDS });
const reload = layout => JSON.parse(JSON.stringify(migrate(JSON.parse(JSON.stringify(layout)))));

test('removing the Direct Debit card survives saving and reloading', () => {
  const original = {
    cards: [{
      id: 'card-contact',
      title: 'Contact',
      columns: 1,
      fields: [{ id: 'core:first_name', type: 'core', fieldKey: 'first_name', columnIndex: 0 }],
    }],
  };
  const migrated = reload(original);
  const mandateCard = migrated.cards.find(card => card.id === 'card-direct-debit');
  assert.equal(mandateCard, undefined);
  assert.deepEqual(migrated, original);
  assert.equal(original.cards.length, 1, 'does not mutate the saved layout object');
});

test('preserves moved mandate fields without restoring deliberately removed fields', () => {
  const layout = {
    cards: [{
      id: 'custom-card',
      title: 'Payments',
      columns: 1,
      fields: [{ ...MEMBER_MANDATE_LAYOUT_FIELDS[0], columnIndex: 0 }],
    }],
  };
  const migrated = reload(layout);
  assert.equal(
    migrated.cards.flatMap(card => card.fields).filter(field => field.id === mandateIds[0]).length,
    1,
  );
  assert.equal(
    migrated.cards.flatMap(card => card.fields).filter(field => field.id === mandateIds[1]).length,
    0,
  );
});

test('leaves a fully configured layout unchanged', () => {
  const layout = {
    cards: [{
      id: 'card-direct-debit',
      title: 'Direct Debit',
      columns: 2,
      fields: MEMBER_MANDATE_LAYOUT_FIELDS.map((field, columnIndex) => ({ ...field, columnIndex })),
    }],
  };
  assert.deepEqual(reload(layout), layout);
});

test('new unconfigured layouts still include Direct Debit', () => {
  const layout = migrate(null);
  assert.deepEqual(Array.from(layout.cards.find(card => card.id === 'card-direct-debit').fields, f => f.id), mandateIds);
});

test('saved empty layouts remain empty and legacy field column migration still runs', () => {
  assert.deepEqual(reload({ cards: [] }), { cards: [] });
  const layout = { cards: [{ id: 'contact', columns: 2, fields: [
    { id: 'core:first_name' }, { id: 'core:last_name' },
  ] }] };
  assert.deepEqual(reload(layout).cards[0].fields.map(f => f.columnIndex), [0, 1]);
});

test('member detail renders endpoint values as read-only text in edit and view modes', async () => {
  const source = await readFile(new URL('../pages/MemberDetail.jsx', import.meta.url), 'utf8');
  assert.match(source, /gocardlessMandate\?\.mandateId/);
  assert.match(source, /gocardlessMandate\?\.statusLabel/);
  assert.match(source, /data-testid=\{`text-member-\$\{fieldKey\}`\}/);
  assert.doesNotMatch(source, /input-member-gocardless_mandate/);
});