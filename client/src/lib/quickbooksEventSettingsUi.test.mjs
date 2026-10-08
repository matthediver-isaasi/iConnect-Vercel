import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../pages/admin/AdminIntegrations.jsx', import.meta.url), 'utf8');
const eventKeys = [
  'quickbooks_event_item_id',
  'quickbooks_event_tax_code_id',
  'quickbooks_event_stripe_bank_account_id',
];

test('event settings load only dedicated keys, retaining explicit empty mappings', async () => {
  const body = source.match(/const loadQuickBooksSettings = async \(\) => \{([\s\S]*?)\n  \};/)[1];
  const names = [...new Set(body.match(/\bsetQb\w+/g))];
  const values = {};
  const settings = [
    { setting_key: 'quickbooks_membership_item_id', setting_value: 'membership-item' },
    { setting_key: 'quickbooks_default_tax_code_id', setting_value: 'membership-tax' },
    { setting_key: 'quickbooks_stripe_bank_account_id', setting_value: 'membership-bank' },
    ...eventKeys.map((setting_key, index) => ({ setting_key, setting_value: '', id: `event-${index}` })),
  ];
  const run = new Function('base44', ...names, `return (async () => {${body}})();`);
  await run(
    { entities: { SystemSettings: { list: async () => settings } } },
    ...names.map((name) => (value) => { values[name] = value; }),
  );
  assert.equal(values.setQbEventItemId, '');
  assert.equal(values.setQbEventTaxCodeId, '');
  assert.equal(values.setQbEventStripeBankAccountId, '');
  assert.equal(values.setQbEventItemSettingId, 'event-0');
  assert.equal(values.setQbEventTaxCodeSettingId, 'event-1');
  assert.equal(values.setQbEventStripeBankSettingId, 'event-2');
  assert.equal(values.setQbEventSettingsLoaded, true);
  settings.splice(3);
  await run(
    { entities: { SystemSettings: { list: async () => settings } } },
    ...names.map((name) => (value) => { values[name] = value; }),
  );
  assert.equal(values.setQbEventItemId, '');
  assert.equal(values.setQbEventTaxCodeId, '');
  assert.equal(values.setQbEventStripeBankAccountId, '');
  assert.equal(values.setQbEventItemSettingId, null);
});

test('event save is independent of membership and persists explicit clears', async () => {
  const body = source.match(/const handleSaveQuickBooksEventSettings = async \(\) => \{([\s\S]*?)\n  \};/)[1];
  assert.doesNotMatch(body, /qbMembershipItemId|handleSaveQuickBooksSettings/);
  const calls = [];
  const context = {
    qbEventSettingsLoaded: true,
    qbEventItemId: '',
    qbEventTaxCodeId: '',
    qbEventStripeBankAccountId: '',
    qbEventItemSettingId: 'item-setting',
    qbEventTaxCodeSettingId: 'tax-setting',
    qbEventStripeBankSettingId: 'bank-setting',
    setQbEventSettingsSaving: () => {},
    setQbEventItemSettingId: () => {},
    setQbEventTaxCodeSettingId: () => {},
    setQbEventStripeBankSettingId: () => {},
    upsertSystemSetting: async (...args) => { calls.push(args); },
    toast: () => {},
  };
  const run = new Function(...Object.keys(context), `return (async () => {${body}})();`);
  await run(...Object.values(context));
  assert.deepEqual(calls.map(([key, value]) => [key, value]), eventKeys.map((key) => [key, '']));
  assert.deepEqual(calls.map((call) => call[3]), ['item-setting', 'tax-setting', 'bank-setting']);
  calls.length = 0;
  context.qbEventSettingsLoaded = false;
  await run(...Object.values(context));
  assert.equal(calls.length, 0);
});

test('event selectors ignore empty hydration while allowing explicit clearing', () => {
  const body = source.match(/onValueChange=\{\(value\) => \{([\s\S]*?)\}\}/)[1];
  const values = [];
  const change = new Function('field', 'value', body);
  const field = { setValue: (value) => values.push(value) };
  change(field, '');
  change(field, '__none');
  change(field, 'event-mapping');
  assert.deepEqual(values, ['', 'event-mapping']);
  assert.match(source, /Existing accepted requests retain their frozen mappings/);
  assert.match(source, /does not replay historical bookings/);
  assert.match(source, /Missing event mappings pause new event invoice recovery until configured/);
});
