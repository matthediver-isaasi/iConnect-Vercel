import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('all public event projections select and return both display modes', () => {
  for (const file of [
    'public/event.js',
    'public/events.js',
    'public/complex-event.js',
    'public/complex-events.js',
  ]) {
    const contents = source(file);
    assert.match(contents, /speaker_display_mode/);
    assert.match(contents, /sponsor_display_mode/);
    assert.match(contents, /normalizeEventDisplayMode\(event\.speaker_display_mode\)/);
    assert.match(contents, /normalizeEventDisplayMode\(event\.sponsor_display_mode\)/);
  }
});

test('both event duplication paths preserve display modes', () => {
  for (const file of ['events/[id]/duplicate.js', 'complex-events/[id]/duplicate.js']) {
    const contents = source(file);
    assert.match(contents, /'speaker_display_mode'/);
    assert.match(contents, /'sponsor_display_mode'/);
  }
});

test('generic create and update entity paths validate event display modes', () => {
  for (const file of ['entities/[entity]/index.js', 'entities/[entity]/[id].js']) {
    const contents = source(file);
    assert.match(contents, /validateEventDisplayModePayload\(sanitizedBody\)/);
    assert.match(contents, /INVALID_EVENT_DISPLAY_MODE|displayModeError/);
  }
});