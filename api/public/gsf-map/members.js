/**
 * GSF-only public endpoint: Zoho-shaped "Members" payload for GSF's external
 * map/search website. Byte-compatible with the Zoho CRM Accounts payload the
 * site used to poll — see api/_lib/gsfMapPayload.js for full context.
 *
 * Auth: shared secret via `X-Api-Key` header or `?token=` query param
 * (env GSF_MAP_API_SECRET). Hard-scoped to the GSF tenant.
 */
import {
  loadGsfMapData,
  buildMembersPayload,
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
    const payload = buildMembersPayload(data);
    setGsfMapCacheHeaders(res);
    return res.status(200).json(payload);
  } catch (error) {
    console.error('GSF map members endpoint error:', error);
    return res.status(500).json({ error: 'Failed to build members payload' });
  }
}
