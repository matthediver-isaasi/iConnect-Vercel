import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureImage, validateFixtureImage } from './fixture-image.mjs';

test('fixture PNG decodes completely and all chunk checksums match', () => {
  assert.deepEqual(validateFixtureImage(createFixtureImage()), {
    width: 240, height: 96, decodedBytes: 69216,
  });
});

test('rejects corruption and truncation before any email is sent', () => {
  const image = createFixtureImage();
  const corrupted = Buffer.from(image);
  corrupted[45] ^= 1;
  assert.throws(() => validateFixtureImage(corrupted));
  assert.throws(() => validateFixtureImage(image.subarray(0, -1)));
});