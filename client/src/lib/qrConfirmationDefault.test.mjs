// Regression tests for the Entrance QR ("qr_on_confirmation") default.
//
// New events (simple + complex) must default the toggle OFF, and no save path
// may force the flag back to true (the old online-event branches did exactly
// that, silently re-enabling QR). These are source-level guards because the
// logic lives inline in large page components.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

test('CreateEvent: QR toggle defaults off and online branch persists false', () => {
  const src = read('client/src/pages/CreateEvent.jsx');
  assert.match(src, /const \[qrOnConfirmation, setQrOnConfirmation\] = useState\(false\)/);
  assert.doesNotMatch(src, /qr_on_confirmation:\s*[^,\n]*\?\s*true/);
});

test('CreateComplexEvent: QR toggle defaults off, edit path loads stored value', () => {
  const src = read('client/src/pages/CreateComplexEvent.jsx');
  assert.match(src, /const \[qrOnConfirmation, setQrOnConfirmation\] = useState\(false\)/);
  // Edit mode must keep loading the stored value with the legacy !== false read.
  assert.match(src, /setQrOnConfirmation\(existingEvent\.qr_on_confirmation !== false\)/);
  assert.doesNotMatch(src, /qr_on_confirmation:\s*[^,\n]*\?\s*true/);
});

test('EditEvent: loads stored value and never forces QR back on when saving', () => {
  const src = read('client/src/pages/EditEvent.jsx');
  assert.match(src, /setQrOnConfirmation\(event\.qr_on_confirmation !== false\)/);
  assert.doesNotMatch(src, /qr_on_confirmation:\s*[^,\n]*\?\s*true/);
});

test('group-admin event write coerces hidden QR field to the off default', () => {
  const src = read('api/_lib/groupAdminEventWrite.js');
  assert.match(src, /if \('qr_on_confirmation' in out\) out\.qr_on_confirmation = false;/);
});

test('confirmation email path keeps the legacy !== false fallback for old events', () => {
  const src = read('api/_lib/eventConfirmationEmail.js');
  assert.match(src, /event\.qr_on_confirmation !== false/);
});
