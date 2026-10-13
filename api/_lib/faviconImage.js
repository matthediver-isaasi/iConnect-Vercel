import https from 'node:https';
import { lookup } from 'node:dns';
import sharp from 'sharp';
import { isPrivateIpAddress } from './styleReference.js';

const MAX_BYTES = 2 * 1024 * 1024;
export const FALLBACK_ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#243746"/><circle cx="16" cy="9" r="2" fill="white"/><path d="M14 14h4v11h-4z" fill="white"/></svg>');

// Only public uploaded storage objects, never a tenant page, proxy, signed URL,
// arbitrary web server or local conventional icon (which would recurse).
export function faviconSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return null;
    if (!(url.hostname === 'vault.iconn.app' || /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname))) return null;
    if (!url.pathname.startsWith('/storage/v1/object/public/')) return null;
    if (/%2f|%5c|%2e/i.test(url.pathname)) return null;
    return url;
  } catch { return null; }
}

export function publicLookup(hostname, options, callback, resolve = lookup) {
  resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error || !addresses?.length || addresses.some(({ address }) => isPrivateIpAddress(address))) {
      return callback(new Error('Favicon source is not public'));
    }
    // Pin the actual socket to the validated DNS answers; no second lookup.
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

export function downloadFavicon(url, request = https.get) {
  const source = faviconSource(String(url));
  if (!source) return Promise.reject(new Error('Invalid favicon source'));
  return new Promise((resolve, reject) => {
    const req = request(source, {
      lookup: publicLookup,
      agent: false,
      headers: { Accept: 'image/*' },
    }, (res) => {
      // Redirects are deliberately refused, including redirects within storage.
      if (res.statusCode !== 200 || Number(res.headers['content-length']) > MAX_BYTES) {
        res.destroy();
        return reject(new Error('Favicon download rejected'));
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) req.destroy(new Error('Favicon too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const timer = setTimeout(() => req.destroy(new Error('Favicon deadline exceeded')), 4000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}

export async function normalizeFavicon(bytes, size) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw new Error('Invalid favicon size');
  if (![32, 180, 192, 512].includes(size)) throw new Error('Invalid output size');
  if (bytes.length >= 6 && bytes.readUInt32LE(0) === 0x00010000) {
    const count = bytes.readUInt16LE(4);
    if (!count || count > 16 || bytes.length < 6 + count * 16) throw new Error('Invalid ICO directory');
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
      if (offset < 6 + count * 16 || length < 40 || offset + length > bytes.length) throw new Error('Invalid ICO entry');
      // ICO's directory dimensions are not trusted to bound embedded DIBs.
      if (bytes.readUInt32LE(offset) !== 0x474e5089) {
        const width = bytes.readInt32LE(offset + 4), height = bytes.readInt32LE(offset + 8);
        if (bytes.readUInt32LE(offset) !== 40 || width < 1 || width > 256 || height < 2 || height > 512) throw new Error('Oversized ICO bitmap');
      } else {
        const metadata = await sharp(bytes.subarray(offset, offset + length), { limitInputPixels: 65536 }).metadata();
        if (metadata.width > 256 || metadata.height > 256) throw new Error('Oversized ICO PNG');
      }
    }
    const { decodeIco } = await import('icojs');
    const icons = await decodeIco(bytes);
    icons.sort((a, b) => b.width * b.height - a.width * a.height);
    bytes = Buffer.from(icons[0].buffer);
  }
  // libvips SVG rasterization does not fetch external resources. Reject XML
  // entities and referenced resources as an additional explicit boundary.
  const text = bytes.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY|(?:href\s*=|url\s*\()/i.test(text)) throw new Error('Referenced SVG resources not supported');
  return sharp(bytes, { limitInputPixels: 16 * 1024 * 1024, animated: false })
    .timeout({ seconds: 3 })
    .rotate()
    .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png().toBuffer();
}

// No derived image cache: each request resolves current branding and reads the
// current object, including replacements at the same URL. Never cross tenants.
export async function tenantFaviconImage(tenant, size, download = downloadFavicon) {
  const source = tenant?.id && faviconSource(tenant.favicon_url);
  if (source) {
    try { return await normalizeFavicon(await download(source), size); } catch {}
  }
  return normalizeFavicon(FALLBACK_ICON, size);
}
