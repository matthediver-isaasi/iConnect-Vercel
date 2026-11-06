import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serializeItemCpdPoints, validateItemCpdPoints, validateTrainingAgendaCpdPoints } from './itemCpdPoints.js';
import { certificateSampleValues, serializeCertificatePlaceholder } from './cpdCertificateContract.js';

test('blank is legacy null; explicit zero is preserved', () => {
  for (const value of [null, undefined, '', '  ']) {
    assert.equal(validateItemCpdPoints(value), null);
    assert.equal(serializeItemCpdPoints(value), null);
  }
  for (const value of [0, '0', '0.000000']) assert.equal(serializeItemCpdPoints(value), 0);
});

test('bounded numeric payloads preserve six-place decimals', () => {
  for (const value of [10000, '10000.000000', '9999.123456', '.5', '0.000001', 2.125]) {
    assert.equal(validateItemCpdPoints(value), null);
    assert.equal(serializeItemCpdPoints(value), Number(value));
  }
  for (const value of [-1, '-0.1', '10000.000001', '0.1234567', 'NaN', Infinity, '1e2', 'two', '1,5']) {
    assert.ok(validateItemCpdPoints(value), String(value));
    assert.throws(() => serializeItemCpdPoints(value));
  }
});

test('daily certificate sample survives serialization with wrapping', () => {
  const sample = 'Monday 5th January 2026 – 2 points\nTuesday 6th January 2026 – 1 point';
  const field = { key: 'cpd.daily_points', sample, multiline: true };
  const payload = serializeCertificatePlaceholder(field);
  assert.equal(payload.placeholder_key, 'cpd.daily_points');
  assert.equal(payload.sample_value, sample);
  assert.equal(payload.multiline, true);
  assert.equal(payload.overflow_policy, 'wrap');
  assert.equal(certificateSampleValues([field])['cpd.daily_points'], sample);
});

test('positive training CPD needs a single day; blank and zero permit date ranges', () => {
  const line = { start_date: '2026-01-05', end_date: '2026-01-06' };
  for (const cpd_points of [1, '2.5', '0.000001', 10000]) {
    assert.match(validateTrainingAgendaCpdPoints({ ...line, cpd_points }), /separate agenda lines per day/);
    for (const end_date of [null, '', line.start_date]) {
      assert.equal(validateTrainingAgendaCpdPoints({ ...line, cpd_points, end_date }), null);
    }
  }
  for (const cpd_points of [null, undefined, '', ' ', 0, '0.000000']) {
    assert.equal(validateTrainingAgendaCpdPoints({ ...line, cpd_points }), null);
  }
  assert.ok(validateTrainingAgendaCpdPoints({ ...line, cpd_points: 'invalid' }));
  const editor = readFileSync(new URL('../components/events/TrainingAgendaEditor.jsx', import.meta.url), 'utf8');
  assert.match(editor, /const cpdError = validateTrainingAgendaCpdPoints\(line\)/);
  assert.match(editor, /validationError=\{validateTrainingAgendaCpdPoints\(line\)\}/);
});

test('training-only controls and save/load boundaries retain item points', () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const page of ['CreateEvent', 'EditEvent']) {
    const text = source(`../pages/${page}.jsx`);
    assert.match(text, /isTraining=\{isTraining\}/);
    assert.match(text, /isTraining \? \{ cpd_points: serializeItemCpdPoints\(line.cpd_points\)/);
    assert.match(text, /validateAgendaLines\(agendaLines, agendaItemTypes, attendancePolicy, isTraining\)/);
  }
  const edit = source('../pages/EditEvent.jsx');
  assert.equal((edit.match(/cpd_points: r.cpd_points \?\? null/g) || []).length, 2, 'loaded rows and rollback snapshot');
  const complex = source('../pages/CreateComplexEvent.jsx');
  assert.match(complex, /cpd_points: session.cpd_points \?\? null/);
  assert.match(complex, /cpd_points: serializeItemCpdPoints\(session.cpd_points\)/);
});
