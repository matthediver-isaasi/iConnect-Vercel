import test from 'node:test';
import assert from 'node:assert/strict';
import { awardSourceLabel, formatActorLabel } from './memberBadgeAttribution.js';

test('actor labels prefer a readable full name', () => {
  assert.equal(formatActorLabel({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test' }), 'Ada Lovelace');
});

test('actor labels fall back to email and then supplied fallback', () => {
  assert.equal(formatActorLabel({ email: 'admin@example.test' }), 'admin@example.test');
  assert.equal(formatActorLabel(null, 'System'), 'System');
});

test('speaker awards retain understandable system attribution', () => {
  assert.equal(awardSourceLabel({ source: 'speaker_award', created_by: 'system:speaker-awards' }), 'Speaker awards automation');
});

test('snapshotted attribution wins over source fallback', () => {
  assert.equal(awardSourceLabel({ awarded_by_label: 'Alex Admin', source: 'speaker_award' }), 'Alex Admin');
});
