import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  TARGET_HEIGHT,
  TARGET_WIDTH,
  assertMetadata,
  buildTargetPath,
  createOptimizedImage,
  diffHeaderUrls,
  findBlocksByType,
  inspectImage,
  verifyOrRollback,
  withoutHeaderImage,
} from './regionalGroupHeaders.mjs';

test('findBlocksByType returns the exact nested member-group block', () => {
  const wanted = { id: 'wanted', type: 'member-group-cards' };
  const design = {
    root: {
      sections: [{ children: [{ type: 'text' }, wanted] }],
    },
  };
  assert.deepEqual(findBlocksByType(design, 'member-group-cards'), [{
    block: wanted,
    path: ['root', 'sections', 0, 'children', 1],
  }]);
});

test('buildTargetPath is tenant scoped and immutable for a source hash', () => {
  assert.equal(
    buildTargetPath({
      tenantId: 'tenant',
      groupId: 'group',
      sourceSha256: 'abcdef0123456789abcdef0123456789',
    }),
    'tenant/member-group-headers/regional-leads/group/abcdef0123456789abcdef01-1200x480-q85.webp',
  );
});

test('createOptimizedImage emits a valid 5:2 WebP using the centre crop', async () => {
  const source = await sharp({
    create: {
      width: 1500,
      height: 1000,
      channels: 3,
      background: '#00ff00',
    },
  })
    .composite([
      {
        input: {
          create: {
            width: 1500,
            height: 250,
            channels: 3,
            background: '#ff0000',
          },
        },
        top: 0,
        left: 0,
      },
      {
        input: {
          create: {
            width: 1500,
            height: 250,
            channels: 3,
            background: '#0000ff',
          },
        },
        top: 750,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  const output = await createOptimizedImage(source);
  const metadata = await inspectImage(output);
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, TARGET_WIDTH);
  assert.equal(metadata.height, TARGET_HEIGHT);

  const { data, info } = await sharp(output)
    .extract({ left: 590, top: 230, width: 20, height: 20 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channelMeans = [0, 1, 2].map((channel) => {
    let sum = 0;
    for (let index = channel; index < data.length; index += info.channels) sum += data[index];
    return sum / (data.length / info.channels);
  });
  assert.ok(channelMeans[1] > 240, `expected green centre pixel, received ${channelMeans}`);
  assert.ok(channelMeans[0] < 20 && channelMeans[2] < 20);
});

test('assertMetadata fails closed on changed source bytes', () => {
  const expected = {
    bytes: 100,
    sha256: 'expected',
    format: 'png',
    width: 10,
    height: 10,
    channels: 3,
    hasAlpha: false,
  };
  assert.throws(
    () => assertMetadata({ ...expected, bytes: 101 }, expected, 'source'),
    /source bytes changed/,
  );
});

test('record and tenant-wide verification isolates header-only changes', () => {
  const before = [
    { id: 'one', name: 'One', header_image_url: 'old' },
    { id: 'two', name: 'Two', header_image_url: 'same' },
  ];
  const after = [
    { id: 'one', name: 'One', header_image_url: 'new' },
    { id: 'two', name: 'Two', header_image_url: 'same' },
  ];
  assert.deepEqual(withoutHeaderImage(before[0]), withoutHeaderImage(after[0]));
  assert.deepEqual(diffHeaderUrls(before, after), [{
    id: 'one',
    before: 'old',
    after: 'new',
  }]);
});

test('post-apply verification failure runs rollback before rethrowing', async () => {
  const calls = [];
  await assert.rejects(
    verifyOrRollback(
      async () => {
        calls.push('verify');
        throw new Error('verification failed');
      },
      async (error) => {
        calls.push(`rollback:${error.message}`);
      },
    ),
    /verification failed/,
  );
  assert.deepEqual(calls, ['verify', 'rollback:verification failed']);
});

test('post-apply verification reports both verification and rollback failures', async () => {
  await assert.rejects(
    verifyOrRollback(
      async () => {
        throw new Error('verification failed');
      },
      async () => {
        throw new Error('rollback failed');
      },
    ),
    /verification failed.*rollback also failed.*rollback failed/,
  );
});