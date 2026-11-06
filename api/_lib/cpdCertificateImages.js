import sharp from 'sharp';
import { createHash } from 'node:crypto';

export const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;
export const MAX_SIGNATURE_PIXELS = 16 * 1024 * 1024;
export const signatureHash = bytes => createHash('sha256').update(bytes).digest('hex');

// Decode the entire image, not merely its header or caller-supplied MIME type.
// Small immutable blobs live in a service-only table, so publication and asset
// ownership are transactional and failed uploads cannot leave storage orphans.
export async function inspectSignature(input) {
  let bytes = Buffer.from(input || []);
  if (!bytes.length || bytes.length > MAX_SIGNATURE_BYTES) throw new Error('Choose a JPG or PNG signature no larger than 2 MB.');
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_SIGNATURE_PIXELS, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!['jpeg', 'png'].includes(metadata.format) || (metadata.pages || 1) !== 1) {
      throw new Error('unsupported');
    }
    await image.clone().raw().toBuffer();
    // PDF and browsers disagree about EXIF orientation; bake only that transform
    // into JPEG pixels. Ordinary JPEG and transparent PNG bytes are unchanged.
    if (metadata.orientation && metadata.orientation !== 1) bytes = await image.rotate().toBuffer();
    if (bytes.length > MAX_SIGNATURE_BYTES) throw new Error('size');
    const normalized = await sharp(bytes).metadata();
    return { bytes, sha256: signatureHash(bytes), mime_type: metadata.format === 'png' ? 'image/png' : 'image/jpeg',
      width: normalized.width, height: normalized.height };
  } catch {
    throw new Error('The signature could not be decoded. Upload a valid single-image JPG or PNG under 2 MB and 16 megapixels.');
  }
}

export async function readSignature(db, { tenantId, templateId, assetId, sha256 }) {
  const { data, error } = await db.from('cpd_certificate_image_binding').select('asset_id')
    .eq('tenant_id', tenantId).eq('template_id', templateId).eq('asset_id', assetId).maybeSingle();
  if (error || !data) throw new Error('Signature image is not available for this template. Upload it again and save the template.');
  const result = await db.from('cpd_certificate_image').select('*')
    .eq('tenant_id', tenantId).eq('id', assetId).maybeSingle();
  if (result.error || !result.data) throw new Error('Required signature image is missing. Restore the image before generating certificates.');
  const asset = result.data;
  const bytes = Buffer.from(asset.content_base64, 'base64');
  if (signatureHash(bytes) !== asset.sha256 || (sha256 && sha256 !== asset.sha256)) {
    throw new Error('Signature image integrity check failed. Upload it again and save the template.');
  }
  return { ...asset, bytes };
}

export function signatureResolver(db, template) {
  const cache = new Map();
  return async field => {
    const key = `${field.image_asset_id}:${field.image_sha256}`;
    if (!cache.has(key)) cache.set(key, readSignature(db, {
      tenantId: template.tenant_id, templateId: template.id,
      assetId: field.image_asset_id, sha256: field.image_sha256,
    }));
    return cache.get(key);
  };
}
