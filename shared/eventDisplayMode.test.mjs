import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_DISPLAY_MODES,
  normalizeEventDisplayMode,
  validateEventDisplayModePayload,
} from './eventDisplayMode.js';

test('event display modes expose the shared frontend/backend contract', () => {
  assert.deepEqual(EVENT_DISPLAY_MODES, ['hidden', 'collapsed', 'expanded']);
  for (const mode of EVENT_DISPLAY_MODES) {
    assert.equal(validateEventDisplayModePayload({
      speaker_display_mode: mode,
      sponsor_display_mode: mode,
    }), null);
    assert.equal(normalizeEventDisplayMode(mode), mode);
  }
});

test('event display mode writes reject null, empty and unknown values', () => {
  for (const value of [null, '', 'visible', 'EXPANDED']) {
    const result = validateEventDisplayModePayload({ speaker_display_mode: value });
    assert.equal(result.code, 'INVALID_EVENT_DISPLAY_MODE');
    assert.equal(result.field, 'speaker_display_mode');
  }
  assert.equal(validateEventDisplayModePayload({ title: 'No display mode change' }), null);
  assert.equal(normalizeEventDisplayMode(null), 'expanded');
});