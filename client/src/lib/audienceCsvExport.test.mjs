import test from 'node:test';
import assert from 'node:assert/strict';
import { audiencePreviewToCsv } from './audienceCsvExport.js';
import { rowsToCsv } from './csvExport.js';

test('audience CSV preserves order, accents and punctuation and neutralizes formula cells', () => {
  const recipients = ['=1+1', '+SUM(1)', '-1+2', '@SUM(1)', ' \t=1', '\ttext', '\r=1', '\n=1'].map(first_name =>
    ({ first_name, last_name: 'Éléonore, "Renée"', email: '+formula@example.test' }));
  const csv = audiencePreviewToCsv({ success: true, totalCount: recipients.length, recipients });
  assert.ok(csv.startsWith('First name,Last name,Email\r\n'));
  assert.equal(csv.split('\r\n').length, 9);
  for (const line of csv.split('\r\n').slice(1)) {
    assert.ok(line.startsWith("'"));
    assert.ok(line.endsWith(`,"Éléonore, ""Renée""",'+formula@example.test`));
  }
  assert.equal(rowsToCsv([['=1+1']]), '=1+1', 'unrelated exports remain unchanged');
});

test('audience CSV requires a complete success response and distinguishes empty audiences', () => {
  assert.equal(audiencePreviewToCsv({ success: true, totalCount: 0, recipients: [] }), null);
  for (const data of [
    null, {}, { success: false, recipients: [], totalCount: 0 },
    { success: true, recipients: [], totalCount: 1 },
    { success: true, recipients: [], totalCount: 0, error: 'Review required' },
    { success: true, recipients: [null], totalCount: 1 },
    { success: true, recipients: [{ email: '' }], totalCount: 1 },
  ]) assert.throws(() => audiencePreviewToCsv(data), /complete audience/);
});