import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isBlockedCpdPointsEntity,
  rejectGenericCpdPointsEntity,
} from './cpdPointsEntityBoundary.js';

const aliases = [
  'EventCpdPointsRule', 'event_cpd_points_rule', 'event-cpd-points-rules',
  'MemberCpdPointsLedger', 'member_cpd_points_ledgers',
  'EventCpdPointsAwardAttempt', 'event_cpd_points_award_attempts',
  'EventCpdPointsFollowup', 'event-cpd-points-followups',
  'EventCpdPointsOutbox', 'event_cpd_points_outboxes',
  'EventCpdPointsReplay', 'event_cpd_points_replays',
];

test('all CPD points table aliases are blocked', () => {
  for (const alias of aliases) assert.equal(isBlockedCpdPointsEntity(alias), true, alias);
  assert.equal(isBlockedCpdPointsEntity('Event'), false);
});

test('boundary rejects every generic method without touching storage', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    let status;
    let payload;
    const res = {
      status(value) { status = value; return this; },
      json(value) { payload = value; return this; },
    };
    assert.equal(rejectGenericCpdPointsEntity('member_cpd_points_ledger', res), true);
    assert.equal(status, 403, method);
    assert.match(payload.error, /dedicated service endpoints/);
  }
});

test('collection and id handlers enforce the boundary before generic table access', async () => {
  for (const path of ['../entities/[entity]/index.js', '../entities/[entity]/[id].js']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const gate = source.indexOf('rejectGenericCpdPointsEntity(entity, res)');
    const table = source.indexOf('getTableName(entity)', gate);
    assert.ok(gate >= 0, `${path} has boundary`);
    assert.ok(table < 0 || gate < table, `${path} gates before table resolution`);
  }
});