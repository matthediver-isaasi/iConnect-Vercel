import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_HEIGHT_LEAF_TYPES,
  BLOCK_DEFAULTS,
  BLOCK_TYPES,
  validateBlock,
} from './canvasDesign.js';
import {
  EVENT_REGISTRATION_LAYOUT_CONTRACT,
  EVENT_REGISTRATION_MEASUREMENT_OPTIONS,
  guardEventRegistrationEditorInteraction,
  resolveEventRegistrationSelection,
} from './eventRegistrationBlock.js';

test('Event Registration resolves simple and complex selections without route state', () => {
  assert.deepEqual(
    resolveEventRegistrationSelection({ eventType: 'simple', eventId: '42', eventSlug: 'annual-meeting' }),
    { eventType: 'simple', eventId: '42', eventSlug: 'annual-meeting' },
  );
  assert.deepEqual(
    resolveEventRegistrationSelection({ eventType: 'complex', eventId: 9 }),
    { eventType: 'complex', eventId: '9', eventSlug: null },
  );
  assert.equal(resolveEventRegistrationSelection({ eventType: 'complex' }), null);
  assert.equal(resolveEventRegistrationSelection(null), null);
});

test('Event Registration editor guard prevents embedded actions only in editor mode', () => {
  const calls = [];
  const event = {
    preventDefault: () => calls.push('prevent'),
    stopPropagation: () => calls.push('stop'),
  };
  assert.equal(guardEventRegistrationEditorInteraction(event, false), false);
  assert.deepEqual(calls, []);
  assert.equal(guardEventRegistrationEditorInteraction(event, true), true);
  assert.deepEqual(calls, ['prevent', 'stop']);
});

test('Event Registration defaults and validation require an event selection', () => {
  const defaults = BLOCK_DEFAULTS[BLOCK_TYPES.EVENT_REGISTRATION];
  assert.deepEqual(defaults.content, {
    eventType: 'simple',
    eventId: '',
    eventSlug: '',
  });
  assert.ok(validateBlock({ type: BLOCK_TYPES.EVENT_REGISTRATION, content: defaults.content })
    .includes('Event Registration requires an event.'));
  assert.deepEqual(validateBlock({
    type: BLOCK_TYPES.EVENT_REGISTRATION,
    content: { ...defaults.content, eventType: 'complex', eventId: 'event-1' },
  }), []);
});

test('Event Registration uses overflow-safe, width-only V1 dynamic sizing and V2 auto-height', () => {
  assert.deepEqual(EVENT_REGISTRATION_LAYOUT_CONTRACT, {
    allowOverflow: true,
    autoHeight: true,
    widthResizeOnly: true,
    renderOnlyAutoHeight: true,
    signedAutoHeight: true,
    editorInteractive: false,
  });
  assert.deepEqual(EVENT_REGISTRATION_MEASUREMENT_OPTIONS, {
    includeExtraHeightPublic: true,
  });
  assert.equal(AUTO_HEIGHT_LEAF_TYPES.has(BLOCK_TYPES.EVENT_REGISTRATION), true);
});