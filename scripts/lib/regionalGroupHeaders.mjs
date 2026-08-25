import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const TARGET_WIDTH = 1200;
export const TARGET_HEIGHT = 480;
export const TARGET_QUALITY = 85;
export const TARGET_MAX_TOTAL_BYTES = 3_000_000;
export const PUBLIC_BUCKET = 'public-assets';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJson(value[key])]),
  );
}

export function stableJsonString(value) {
  return JSON.stringify(stableJson(value));
}

export function findBlocksByType(root, type) {
  const matches = [];
  const visit = (value, path = []) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (value.type === type) matches.push({ block: value, path });
    for (const [key, child] of Object.entries(value)) {
      visit(child, [...path, key]);
    }
  };
  visit(root);
  return matches;
}

export function buildTargetPath({ tenantId, groupId, sourceSha256 }) {
  return [
    tenantId,
    'member-group-headers',
    'regional-leads',
    groupId,
    `${sourceSha256.slice(0, 24)}-${TARGET_WIDTH}x${TARGET_HEIGHT}-q${TARGET_QUALITY}.webp`,
  ].join('/');
}

export async function inspectImage(buffer) {
  const metadata = await sharp(buffer).metadata();
  return {
    bytes: buffer.length,
    sha256: sha256(buffer),
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    channels: metadata.channels,
    hasAlpha: metadata.hasAlpha,
  };
}

export async function createOptimizedImage(sourceBuffer) {
  return sharp(sourceBuffer)
    .rotate()
    .resize({
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      fit: 'cover',
      position: 'centre',
    })
    .webp({
      quality: TARGET_QUALITY,
      effort: 6,
      smartSubsample: true,
    })
    .toBuffer();
}

export function assertMetadata(actual, expected, label = 'image') {
  const fields = ['bytes', 'sha256', 'format', 'width', 'height', 'channels', 'hasAlpha'];
  for (const field of fields) {
    if (actual[field] !== expected[field]) {
      throw new Error(
        `${label} ${field} changed: expected ${JSON.stringify(expected[field])}, `
        + `received ${JSON.stringify(actual[field])}`,
      );
    }
  }
}

export function withoutHeaderImage(record) {
  const { header_image_url: _headerImageUrl, ...rest } = record || {};
  return rest;
}

export function diffHeaderUrls(beforeRows, afterRows) {
  const before = new Map((beforeRows || []).map((row) => [row.id, row.header_image_url || null]));
  const after = new Map((afterRows || []).map((row) => [row.id, row.header_image_url || null]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids]
    .filter((id) => before.get(id) !== after.get(id))
    .sort()
    .map((id) => ({
      id,
      before: before.get(id),
      after: after.get(id),
    }));
}

export async function verifyOrRollback(verify, rollback) {
  try {
    return await verify();
  } catch (verificationError) {
    try {
      await rollback(verificationError);
    } catch (rollbackError) {
      const combined = new Error(
        `Post-apply verification failed (${verificationError.message}); `
        + `rollback also failed (${rollbackError.message}).`,
        { cause: verificationError },
      );
      combined.rollbackError = rollbackError;
      throw combined;
    }
    throw verificationError;
  }
}