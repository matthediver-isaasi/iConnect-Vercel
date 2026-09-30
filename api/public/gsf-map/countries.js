/**
 * GSF-only public endpoint: Zoho-shaped "Countries" payload (one row per
 * member organisation x country of operation) for GSF's external map site.
 * Byte-compatible with the Zoho CRM payload the site used to poll — see
 * api/_lib/gsfMapPayload.js for full context.
 *
 * Auth: shared secret via `X-Api-Key` header or `?token=` query param
 * (env GSF_MAP_API_SECRET). Hard-scoped to the GSF tenant.
 */
import {
  loadGsfMapData,
  buildCountriesPayload,
  checkGsfMapAuth,
  setGsfMapCacheHeaders
} from '../../_lib/gsfMapPayload.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!checkGsfMapAuth(req, res)) return;

  try {
    const data = await loadGsfMapData();
    const payload = buildCountriesPayload(data);
    setGsfMapCacheHeaders(res);
    return res.status(200).json(payload);
  } catch (error) {
    console.error('GSF map countries endpoint error:', error);
    return res.status(500).json({ error: 'Failed to build countries payload' });
  }
}
