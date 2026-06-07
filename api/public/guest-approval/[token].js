import { supabase } from '../../_lib/database.js';

// Public, tokenised guest-signup approval endpoint (Task #1269).
//
// GET  -> returns the guest's details + tenant branding + current token status
//         so the confirmation page can render. No state change.
// POST -> body { action: 'approve' | 'deny' }. On the first valid action it
//         flips the token from 'pending' and, for approve, enables the guest
//         member's login. Re-clicked links return the existing (already
//         handled) status instead of erroring.

function buildResponse(tokenRow, tenant) {
  return {
    status: tokenRow.status,
    guest: {
      name: tokenRow.guest_name || null,
      email: tokenRow.guest_email || null,
      organization_name: tokenRow.organization_name || null,
      guest_expires_at: tokenRow.guest_expires_at || null,
    },
    decided_at: tokenRow.decided_at || null,
    tenant: tenant
      ? {
          name: tenant.name || null,
          logo_url: tenant.logo_url || null,
          primary_color: tenant.primary_color || null,
        }
      : null,
  };
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token required' });
  }

  const { data: tokenRow, error: tokenErr } = await supabase
    .from('guest_approval_token')
    .select('id, tenant_id, member_id, organization_id, guest_name, guest_email, organization_name, guest_expires_at, status, decided_at')
    .eq('token', token)
    .maybeSingle();

  if (tokenErr || !tokenRow) {
    return res.status(404).json({ error: 'This link is invalid or has been removed.' });
  }

  const { data: tenant } = await supabase
    .from('tenant')
    .select('name, logo_url, primary_color')
    .eq('id', tokenRow.tenant_id)
    .maybeSingle();

  if (req.method === 'GET') {
    return res.json(buildResponse(tokenRow, tenant));
  }

  if (req.method === 'POST') {
    const action = (req.body?.action || '').toString().toLowerCase();
    if (action !== 'approve' && action !== 'deny') {
      return res.status(400).json({ error: "Invalid action. Use 'approve' or 'deny'." });
    }

    // Already handled — return the existing state so a re-clicked link shows a
    // friendly "already handled" message rather than erroring.
    if (tokenRow.status !== 'pending') {
      return res.json({ ...buildResponse(tokenRow, tenant), alreadyHandled: true });
    }

    const newStatus = action === 'approve' ? 'approved' : 'denied';
    const decidedAt = new Date().toISOString();

    // Atomically claim the token: only move it from 'pending'. If a concurrent
    // click already consumed it, the update affects zero rows and we re-read.
    const { data: claimed, error: claimErr } = await supabase
      .from('guest_approval_token')
      .update({ status: newStatus, decided_at: decidedAt })
      .eq('id', tokenRow.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (claimErr) {
      console.error('[GuestApproval] Failed to update token:', claimErr.message);
      return res.status(500).json({ error: 'Could not record your decision. Please try again.' });
    }

    if (!claimed) {
      // Lost the race — re-read and report the final state.
      const { data: fresh } = await supabase
        .from('guest_approval_token')
        .select('id, tenant_id, member_id, organization_id, guest_name, guest_email, organization_name, guest_expires_at, status, decided_at')
        .eq('id', tokenRow.id)
        .maybeSingle();
      return res.json({ ...buildResponse(fresh || tokenRow, tenant), alreadyHandled: true });
    }

    // On approve, enable the guest's login. On deny, leave it disabled.
    if (action === 'approve') {
      const { error: memberErr } = await supabase
        .from('member')
        .update({ login_enabled: true })
        .eq('id', tokenRow.member_id)
        .eq('tenant_id', tokenRow.tenant_id);
      if (memberErr) {
        console.error('[GuestApproval] Failed to enable guest login:', memberErr.message);
        // The decision is recorded; surface a soft warning but still 200 so the
        // approver isn't told it failed when the token state did change.
        return res.json({
          ...buildResponse({ ...tokenRow, status: newStatus, decided_at: decidedAt }, tenant),
          warning: 'Decision recorded, but enabling login failed. Please enable the guest from the Team page.',
        });
      }
    }

    return res.json(buildResponse({ ...tokenRow, status: newStatus, decided_at: decidedAt }, tenant));
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
