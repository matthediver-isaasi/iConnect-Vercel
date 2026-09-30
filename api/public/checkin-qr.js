import QRCode from 'qrcode';
import { resolveCheckinToken, buildCheckinUrl } from '../_lib/checkinService.js';

/**
 * Returns a QR PNG for a given check-in token. The QR encodes the staff
 * check-in screen URL for that token. Hosted PNG (not a data URI) so email
 * clients render it. Online events have no token, so unknown/online tokens
 * 404.
 */
export default async function handler(req, res) {
  try {
    const token = (req.query.token || '').toString().trim();
    if (!token) {
      res.status(400).json({ error: 'Missing token' });
      return;
    }

    const resolved = await resolveCheckinToken(token);
    if (!resolved || resolved.isOnline) {
      res.status(404).json({ error: 'Invalid check-in token' });
      return;
    }

    const checkinUrl = buildCheckinUrl(token, req);
    const png = await QRCode.toBuffer(checkinUrl, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
      color: { dark: '#000000ff', light: '#ffffffff' },
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).end(png);
  } catch (err) {
    console.error('[checkin-qr] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
}
