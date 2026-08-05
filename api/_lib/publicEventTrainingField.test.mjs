// Regression guard (Task #3419): the public event endpoints must both SELECT
// is_training and include it in the whitelisted response payload — the
// EventDetails page gates the agenda fetch/render on event.is_training, so
// dropping the field from either place silently hides every training agenda.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('api/public/event.js selects and returns is_training', () => {
  const src = readFileSync(join(root, 'api/public/event.js'), 'utf8');
  assert.match(src, /is_training,/, 'is_training must be selected');
  assert.match(src, /is_training:\s*event\.is_training\s*\|\|\s*false/, 'is_training must be in the public payload');
});

test('api/public/events.js selects and returns is_training', () => {
  const src = readFileSync(join(root, 'api/public/events.js'), 'utf8');
  assert.match(src, /is_training,/, 'is_training must be selected');
  assert.match(src, /is_training:\s*event\.is_training\s*\|\|\s*false/, 'is_training must be in the public payload');
});

test('EditEvent persists agenda lines inside the awaited save mutation', () => {
  const src = readFileSync(join(root, 'client/src/pages/EditEvent.jsx'), 'utf8');
  const mutationStart = src.indexOf('const updateEventMutation = useMutation');
  const mutationFnEnd = src.indexOf('onError:', mutationStart);
  const mutationFn = src.slice(mutationStart, mutationFnEnd);
  // Creates/updates/deletes must happen inside mutationFn (awaited before any
  // success toast/redirect), and a failure must reject the mutation.
  assert.match(mutationFn, /EventAgendaItem\.delete/, 'agenda deletes must run in mutationFn');
  assert.match(mutationFn, /EventAgendaItem\.update/, 'agenda updates must run in mutationFn');
  assert.match(mutationFn, /EventAgendaItem\.create/, 'agenda creates must run in mutationFn');
  assert.match(mutationFn, /throw wrapped;/, 'agenda failure must reject the save');
  // No agenda writes may remain in fire-and-forget success callbacks.
  const afterMutation = src.slice(mutationFnEnd);
  assert.ok(!/EventAgendaItem\.(create|update|delete)/.test(afterMutation),
    'no agenda writes outside the awaited mutationFn');
});

test('CreateEvent rolls back the event when agenda persistence fails', () => {
  const src = readFileSync(join(root, 'client/src/pages/CreateEvent.jsx'), 'utf8');
  const createIdx = src.indexOf('await base44.entities.Event.create(eventData)');
  const section = src.slice(createIdx, createIdx + 3000);
  assert.match(section, /EventAgendaItem\.create/, 'agenda lines saved right after event create');
  assert.match(section, /Event\.delete\(createdEvent\.id\)/, 'agenda failure must compensate by deleting the event');
  assert.match(section, /throw wrapped;/, 'agenda failure must fail the create mutation');
});

test('EventDetails gates the agenda fetch and render on is_training', () => {
  const src = readFileSync(join(root, 'client/src/pages/EventDetails.jsx'), 'utf8');
  assert.match(src, /enabled:\s*!!event\?\.id && !!event\?\.is_training/, 'agenda query must be enabled by is_training');
  assert.match(src, /event\.is_training && agendaLines\.length > 0/, 'agenda section must render when lines exist');
  assert.match(src, /\/api\/public\/event-agenda\?event_id=/, 'agenda query must hit the public agenda endpoint');
});
