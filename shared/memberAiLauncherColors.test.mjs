import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemberAiLauncherStyle as style } from './memberAiLauncherColors.js';

test('launcher preserves default theme and independent text overrides', () => {
  assert.equal(style(), undefined);
  assert.equal(style({ textColor: 'red', backgroundColor: {} }), undefined);
  assert.deepEqual(style({ textColor: '#FFFFFF' }), { color: '#FFFFFF' });
  assert.equal(style({ backgroundColor: '#ffffff' }).color, '#111827');
  assert.equal(style({ backgroundColor: '#000000' }).color, '#ffffff');
  assert.equal(style({ backgroundColor: '#9333EA', textColor: '#FFFFFF' }).color, '#FFFFFF');
  assert.equal(style({ backgroundColor: '#ffffff', textColor: '' }).color, '#111827');
});
