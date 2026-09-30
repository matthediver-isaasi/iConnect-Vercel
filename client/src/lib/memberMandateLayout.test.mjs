import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ensureMemberMandateLayoutFields,
  MEMBER_MANDATE_LAYOUT_FIELDS,
} from './memberMandateLayout.js';

const mandateIds = MEMBER_MANDATE_LAYOUT_FIELDS.map(field => field.id);

test('adds a visible Direct Debit card to an existing saved member layout', () => {
  const original = {
    cards: [{
      id: 'card-contact',
      title: 'Contact',
      columns: 1,
      fields: [{ id: 'core:first_name', type: 'core', fieldKey: 'first_name', columnIndex: 0 }],
    }],
  };
  const migrated = ensureMemberMandateLayoutFields(original);
  const mandateCard = migrated.cards.find(card => card.id === 'card-direct-debit');
  assert.ok(mandateCard);
  assert.deepEqual(mandateCard.fields.map(field => field.id), mandateIds);
  assert.equal(original.cards.length, 1, 'does not mutate the saved layout object');
});

test('preserves an existing placement and adds only the missing mandate field', () => {
  const layout = {
    cards: [{
      id: 'custom-card',
      title: 'Payments',
      columns: 1,
      fields: [{ ...MEMBER_MANDATE_LAYOUT_FIELDS[0], columnIndex: 0 }],
    }],
  };
  const migrated = ensureMemberMandateLayoutFields(layout);
  assert.equal(
    migrated.cards.flatMap(card => card.fields).filter(field => field.id === mandateIds[0]).length,
    1,
  );
  assert.equal(
    migrated.cards.flatMap(card => card.fields).filter(field => field.id === mandateIds[1]).length,
    1,
  );
});

test('leaves a fully configured layout unchanged', () => {
  const layout = {
    cards: [{
      id: 'card-direct-debit',
      title: 'Direct Debit',
      columns: 2,
      fields: MEMBER_MANDATE_LAYOUT_FIELDS,
    }],
  };
  assert.equal(ensureMemberMandateLayoutFields(layout), layout);
});

test('member detail renders endpoint values as read-only text in edit and view modes', async () => {
  const source = await readFile(new URL('../pages/MemberDetail.jsx', import.meta.url), 'utf8');
  assert.match(source, /gocardlessMandate\?\.mandateId/);
  assert.match(source, /gocardlessMandate\?\.statusLabel/);
  assert.match(source, /data-testid=\{`text-member-\$\{fieldKey\}`\}/);
  assert.doesNotMatch(source, /input-member-gocardless_mandate/);
});