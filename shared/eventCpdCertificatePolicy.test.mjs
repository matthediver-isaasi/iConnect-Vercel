import assert from 'node:assert/strict';
import test from 'node:test';
import {
  certificateDatePlaceholderValues,
  emptyEventCpdCertificateConfig,
  eventDateOnly,
  formatCertificateActivityDateRange,
  isValidCertificateDate,
  resolveEventCpdCertificatePolicy,
  validateEventCpdCertificateConfig,
} from './eventCpdCertificatePolicy.js';

const templates = [{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }, { id: 'archived', status: 'archived' }];
const event = { start_date: '2026-03-28T23:30:00.000Z', end_date: '2026-03-30T00:30:00.000Z', timezone: 'Europe/London' };
const resolved = (config, ticketReference = null, sourceEvent = event, sourceTemplates = templates) =>
  resolveEventCpdCertificatePolicy({ config, event: sourceEvent, ticketReference, templates: sourceTemplates });

test('strict Gregorian custom dates and ordered optional end date', () => {
  assert.equal(isValidCertificateDate('2024-02-29'), true);
  assert.equal(isValidCertificateDate('0004-02-29'), true);
  assert.equal(isValidCertificateDate('0400-02-29'), true);
  for (const date of ['0001-02-29', '1900-02-29', '2025-02-29', '2026-13-01', '2026-04-31', '2026-1-01', '2026-01-01T00:00:00Z']) {
    assert.equal(isValidCertificateDate(date), false, date);
  }
  const config = emptyEventCpdCertificateConfig();
  config.eventRule.date_mode = 'custom';
  config.eventRule.start_date = '2026-03-02';
  config.eventRule.end_date = '2026-03-01';
  assert.match(validateEventCpdCertificateConfig(config)[0], /end date/);
  config.eventRule.end_date = null;
  assert.deepEqual(validateEventCpdCertificateConfig(config), []);
});

test('activity date range formats a single date or both days without replacing the start-date key', () => {
  assert.equal(formatCertificateActivityDateRange('2026-02-28'), '28 February 2026');
  assert.equal(formatCertificateActivityDateRange('2026-02-28', '2026-02-28'), '28 February 2026');
  assert.equal(formatCertificateActivityDateRange('2026-02-28', '2026-03-01'), '28 February 2026 – 1 March 2026');
  assert.equal(formatCertificateActivityDateRange('2026-03-01', '2026-02-28'), null);
  assert.equal(formatCertificateActivityDateRange('0001-02-29'), null);
  const values = certificateDatePlaceholderValues({ start_date: '2026-02-28', end_date: '2026-03-01' });
  assert.equal(values['cpd.activity_date'], '28 February 2026');
  assert.equal(values['cpd.activity_date_range'], '28 February 2026 – 1 March 2026');
  assert.equal(values['event.end_date'], undefined, 'activity overrides must not redefine event dates');
  const single = certificateDatePlaceholderValues({ start_date: '2026-02-28', end_date: null });
  assert.equal(single['cpd.activity_date_range'], '28 February 2026');
  assert.equal(single['cpd.activity_end_date'], '');
});

test('DST and explicit timezone preserve calendar dates, not UTC date or system timezone', () => {
  assert.equal(eventDateOnly('2026-03-30T00:30:00.000Z', 'Europe/London'), '2026-03-30');
  assert.equal(eventDateOnly('2026-03-29T23:30:00.000Z', 'Europe/London'), '2026-03-30');
  assert.equal(eventDateOnly('2026-03-28T23:30:00.000Z', 'Europe/London'), '2026-03-28');
  assert.equal(eventDateOnly('2026-03-29T00:30:00+02:00', 'Europe/London'), '2026-03-28');
  assert.equal(eventDateOnly('2026-03-29T13:00:00', 'Europe/London'), '2026-03-29');
  assert.equal(eventDateOnly('2026-03-29T13:00:00Z', 'Invalid/Zone'), null);
});

test('template and date overrides are independent for both day 1 and day 2', () => {
  const config = emptyEventCpdCertificateConfig();
  config.eventRule.template_id = 'a';
  config.ticketRules.dates = { template_mode: 'inherit', template_id: null, date_mode: 'custom', start_date: '2026-05-01', end_date: '2026-05-02' };
  config.ticketRules.template = { template_mode: 'override', template_id: 'b', date_mode: 'inherit', start_date: null, end_date: null };
  config.ticketRules.none = { template_mode: 'none', template_id: null, date_mode: 'inherit', start_date: null, end_date: null };
  assert.deepEqual(validateEventCpdCertificateConfig(config, [{ id: 'dates' }, { id: 'template' }, { id: 'none' }]), []);
  assert.deepEqual(
    [resolved(config, 'dates').template_id, resolved(config, 'dates').start_date, resolved(config, 'dates').end_date, resolved(config, 'dates').template_source, resolved(config, 'dates').date_source],
    ['a', '2026-05-01', '2026-05-02', 'event', 'ticket'],
  );
  assert.deepEqual(
    [resolved(config, 'template').template_id, resolved(config, 'template').start_date, resolved(config, 'template').end_date, resolved(config, 'template').template_source],
    ['b', '2026-03-28', '2026-03-30', 'ticket'],
  );
  assert.equal(resolved(config, 'none').reason, 'no_template');
});

test('single day and explicit unavailable template/date states fail closed', () => {
  const config = emptyEventCpdCertificateConfig();
  config.eventRule.template_id = 'a';
  assert.deepEqual([resolved(config, null, { start_date: '2026-03-29', timezone: 'Europe/London' }).start_date,
    resolved(config, null, { start_date: '2026-03-29', timezone: 'Europe/London' }).end_date], ['2026-03-29', null]);
  assert.equal(resolved(config, null, { timezone: 'Europe/London' }).reason, 'date_unavailable');
  assert.equal(resolved(config, null, event, []).reason, 'template_unavailable');
  config.eventRule.template_id = 'archived';
  assert.equal(resolved(config).reason, 'template_inactive');
  config.eventRule.date_mode = 'custom';
  config.eventRule.start_date = '2026-02-30';
  assert.equal(resolved(config).reason, 'invalid_policy');
});