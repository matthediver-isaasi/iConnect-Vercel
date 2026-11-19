import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSupportedNode } from './check-node-runtime.mjs';

test('accepts the patched Node 24 baseline and newer stable releases on that line', () => {
  for (const version of ['24.22.3', 'v24.22.3', '24.22.4', '24.23.0']) {
    assert.doesNotThrow(() => assertSupportedNode(version));
  }
});
test('rejects older, unsupported, malformed and prerelease runtimes', () => {
  for (const version of ['20.20.0', '22.23.5', '24.22.1', '24.22.2', '24.21.99',
    '26.13.1', '24.x', '24.22.3-rc.1', '']) {
    assert.throws(() => assertSupportedNode(version), /unsupported/);
  }
});
