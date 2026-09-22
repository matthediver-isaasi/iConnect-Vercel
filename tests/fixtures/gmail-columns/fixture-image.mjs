import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crc32 = data => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const name = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
};

// A visible, locally generated RGB placeholder; no source images or remote URLs.
export function createFixtureImage() {
  const width = 240, height = 96;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((1 + width * 3) * height);
  const colors = [[38, 59, 104], [38, 107, 70], [196, 108, 38]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const border = x < 4 || x >= width - 4 || y < 4 || y >= height - 4;
      const color = border ? [255, 255, 255] : colors[Math.floor(x / 80)];
      rows.set(color, y * (1 + width * 3) + 1 + x * 3);
    }
  }
  const image = Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  validateFixtureImage(image);
  return image;
}

export function validateFixtureImage(image) {
  assert(image.subarray(0, 8).equals(signature), 'Invalid PNG signature');
  let offset = 8;
  const chunks = [];
  while (offset < image.length) {
    assert(offset + 12 <= image.length, 'Truncated PNG chunk');
    const length = image.readUInt32BE(offset);
    assert(offset + length + 12 <= image.length, 'PNG chunk exceeds file');
    const type = image.toString('ascii', offset + 4, offset + 8);
    const data = image.subarray(offset + 8, offset + 8 + length);
    assert.equal(image.readUInt32BE(offset + 8 + length),
      crc32(image.subarray(offset + 4, offset + 8 + length)), `Invalid PNG ${type} checksum`);
    chunks.push({ type, data });
    offset += length + 12;
  }
  assert.equal(chunks[0]?.type, 'IHDR');
  const header = chunks[0].data;
  assert.equal(header.readUInt32BE(0), 240);
  assert.equal(header.readUInt32BE(4), 96);
  assert.deepEqual([...header.subarray(8)], [8, 2, 0, 0, 0]);
  assert.equal(chunks.at(-1)?.type, 'IEND');
  const pixels = inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
  assert.equal(pixels.length, (240 * 3 + 1) * 96);
  for (let y = 0; y < 96; y++) assert.equal(pixels[y * 721], 0);
  return { width: 240, height: 96, decodedBytes: pixels.length };
}