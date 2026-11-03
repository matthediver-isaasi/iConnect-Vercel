import { getValidXeroAccessToken } from './xero.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Optional display evidence only. Never let Xero availability affect Stripe
// completeness, local matching, or financial arithmetic.
export async function enrichPayoutContacts(rows, tenantId, deps = {}) {
  const deadlineAt = Date.now() + 7000;
  const results = new Map();
  const eligible = rows.filter(r => r.provider === 'xero' && !r.conflict && uuid.test(r.id || '')
    && !rows.some(other => other.id === r.id && (other.conflict
      || (other.provider === r.provider && other.number && r.number && other.number !== r.number)))
    && !rows.some(other => other.provider === r.provider && other.number && other.number === r.number && other.id !== r.id));
  const ids = [...new Set(eligible.map(r => r.id))].slice(0, 20);
  let credentials;
  if (ids.length) {
    try {
      credentials = await (deps.token || getValidXeroAccessToken)(tenantId, {
        timeoutMs: 2000, deadlineAt, signal: AbortSignal.timeout(7000), requireEnabled: true,
      });
    } catch { /* No usable connection; no customer-name fallback. */ }
  }
  if (credentials?.accessToken && credentials?.tenantId && credentials.tenantId !== 'PENDING_SELECTION') {
    for (let i = 0; i < ids.length && Date.now() < deadlineAt; i += 2) {
      await Promise.all(ids.slice(i, i + 2).map(async id => {
        try {
          const response = await (deps.fetch || fetch)(`https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(id)}`, {
            method: 'GET', headers: { Authorization: `Bearer ${credentials.accessToken}`,
              'xero-tenant-id': credentials.tenantId, Accept: 'application/json' },
            signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadlineAt - Date.now()))),
          });
          if (!response.ok) return;
          const data = await response.json();
          const invoice = data?.Invoices?.[0];
          if (data?.Invoices?.length !== 1 || invoice?.InvoiceID !== id || invoice.Type !== 'ACCREC') return;
          // Stored number disagreement is not permission to display a customer.
          if (eligible.some(r => r.id === id && r.number && r.number !== invoice.InvoiceNumber)) return;
          const name = invoice.Contact?.Name;
          if (typeof name === 'string' && name.trim()) results.set(id, name);
        } catch { /* Includes timeout, rate limiting and invalid provider responses. */ }
      }));
    }
  }
  return rows.map(r => ({ ...r, contactName: eligible.includes(r) ? results.get(r.id) || null : null,
    contactStatus: r.provider !== 'xero' ? 'not_xero' : r.conflict || !eligible.includes(r) ? 'invalid_evidence'
      : results.has(r.id) ? 'available' : !credentials ? 'connection_unavailable' : 'lookup_unavailable' }));
}
