import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEventSettingsWriter, createSettingsCollector, saveCollectedSettings } from './eventSettingsSaving.js';
import { normalizeTbcAnchor, isValidTbcAnchor, isTbcHash, parseTbcBannerConfig, getTbcJumpDescription, getTbcJumpLabel } from './tbcEventsBanner.js';

function fixture(initial = []) {
  let rows = structuredClone(initial);
  const calls = [];
  let reject = false;
  const entity = {
    list: async () => rows,
    create: async data => { calls.push(data); if (reject) throw new Error('503'); return { id: `row-${calls.length}`, ...data }; },
    update: async (id, data) => { calls.push(data); if (reject) throw new Error('503'); return { id, ...data }; },
  };
  const writer = createEventSettingsWriter({ entity, getRows: () => rows,
    acknowledge: row => { rows = [...rows.filter(item => item.setting_key !== row.setting_key), row]; } });
  return { writer, calls, rows: () => rows, fail: value => { reject = value; } };
}

test('banner roundtrip includes helper, jump label, styling and anchor; skips unrelated writes', async () => {
  const f = fixture();
  const collector = createSettingsCollector([]);
  const cfg = { enabled: true, jumpDescription: 'Draft helper', jumpLabel: 'Join list', mode: 'gradient', from: '#123456', to: '#abcdef', sectionAnchor: 'waitinglist' };
  collector.create({ setting_key: 'unrelated', setting_value: 'will not write' });
  collector.create({ setting_key: 'tbc_events_banner', setting_value: JSON.stringify(cfg) });
  await saveCollectedSettings(collector.entries, ['tbc_events_banner'], f.writer);
  assert.equal(f.calls.length, 1);
  const reloaded = parseTbcBannerConfig(f.rows());
  assert.deepEqual(reloaded, cfg);
  assert.equal(getTbcJumpDescription(reloaded), 'Draft helper');
  assert.equal(getTbcJumpLabel(reloaded), 'Join list');
  await saveCollectedSettings(collector.entries, ['tbc_events_banner'], f.writer);
  assert.equal(f.calls.length, 1, 'unchanged save is zero writes');
});

test('failed writes keep snapshot retryable; partial success is not re-created', async () => {
  const f = fixture();
  const entries = new Map([['one', { setting_value: '1' }], ['two', { setting_value: '2' }]]);
  await saveCollectedSettings(entries, ['one'], f.writer);
  f.fail(true);
  await assert.rejects(saveCollectedSettings(entries, ['one', 'two'], f.writer), /503/);
  assert.equal(f.rows().length, 1);
  f.fail(false);
  await saveCollectedSettings(entries, ['one', 'two'], f.writer);
  assert.equal(f.rows().length, 2);
  assert.equal(f.calls.length, 3);
});

test('duplicate settings and fulfilled error envelopes cannot report success', async () => {
  const f = fixture([{ id: 'a', setting_key: 'x' }, { id: 'b', setting_key: 'x' }]);
  await assert.rejects(f.writer.create({ setting_key: 'x', setting_value: 'new' }), /Duplicate/);
  assert.equal(f.calls.length, 0);
  const writer = createEventSettingsWriter({
    entity: { create: async () => ({ error: 'denied' }) }, getRows: () => [], acknowledge: () => assert.fail('not acknowledged'),
  });
  await assert.rejects(writer.create({ setting_key: 'x', setting_value: 'new' }), /Could not confirm/);
});

test('anchors are safe, default-compatible and unrelated/malformed hashes are ignored', () => {
  for (const value of ['', 'waitinglist', 'Wait-list_2']) assert.equal(isValidTbcAnchor(value), true);
  for (const value of ['#waitinglist', 'two words', '123', '<script>', 'a'.repeat(81)]) {
    assert.equal(isValidTbcAnchor(value), false);
    assert.equal(normalizeTbcAnchor(value), 'tbc-events-banner');
  }
  assert.equal(normalizeTbcAnchor(undefined), 'tbc-events-banner');
  assert.equal(isTbcHash('#waitinglist', 'waitinglist'), true);
  assert.equal(isTbcHash('#tbc-events-banner', 'waitinglist'), true);
  assert.equal(isTbcHash('#other', 'waitinglist'), false);
  assert.equal(isTbcHash('#%XX', 'waitinglist'), false);
});

test('every shared save button declares a non-empty write scope', async () => {
  const { EVENT_SETTINGS_SAVE_KEYS } = await import('./eventSettingsSaving.js');
  const source = fs.readFileSync(new URL('../pages/EventSettings.jsx', import.meta.url), 'utf8');
  const buttons = [...source.matchAll(/onClick=\{handleSaveSettings\}([\s\S]*?)>/g)];
  assert.equal(buttons.length, 20);
  for (const [, attributes] of buttons) {
    const explicit = attributes.match(/data-save-keys="([^"]+)"/)?.[1];
    const testId = attributes.match(/data-testid="([^"]+)"/)?.[1];
    assert.ok(explicit || EVENT_SETTINGS_SAVE_KEYS[testId]?.length, `Missing scope: ${testId}`);
  }
});
