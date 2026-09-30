import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdminOnlyEntity, ADMIN_ONLY_ENTITIES } from './adminOnlyEntities.js';

test('EventCostLine is admin-only in every naming variant', () => {
  assert.equal(isAdminOnlyEntity('EventCostLine'), true);
  assert.equal(isAdminOnlyEntity('event_cost_line'), true);
  assert.equal(isAdminOnlyEntity('eventcostline'), true);
  assert.equal(isAdminOnlyEntity('event-cost-line'), true);
});

test('external writer entities remain admin-only', () => {
  assert.equal(isAdminOnlyEntity('ExternalWriter'), true);
  assert.equal(isAdminOnlyEntity('ExternalWriterDocument'), true);
});

test('ordinary member entities are not admin-only', () => {
  assert.equal(isAdminOnlyEntity('Event'), false);
  assert.equal(isAdminOnlyEntity('ComplexEvent'), false);
  assert.equal(isAdminOnlyEntity('EventAgendaItem'), false);
  assert.equal(isAdminOnlyEntity('Booking'), false);
  assert.equal(isAdminOnlyEntity(''), false);
  assert.equal(isAdminOnlyEntity(null), false);
});

test('list contains no duplicates and is pre-normalised', () => {
  const set = new Set(ADMIN_ONLY_ENTITIES);
  assert.equal(set.size, ADMIN_ONLY_ENTITIES.length);
  for (const name of ADMIN_ONLY_ENTITIES) {
    assert.equal(name, name.replace(/[-_]/g, '').toLowerCase());
  }
});
