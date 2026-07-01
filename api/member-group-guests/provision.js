/**
 * Atomic provisioning endpoint for member-group guests.
 *
 * POST  /api/member-group-guests/provision  — create member + marker (rollback on failure)
 * PATCH /api/member-group-guests/provision  — update member then marker; compensating
 *                                             rollback of member if marker write fails.
 *
 * The endpoint NEVER touches is_guest / guest_expires_at / n / n_at on the
 * provisioned member — those belong to the separate org-guest-access feature.
 */
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const isAdmin = await hasAdminAccess(tenantCtx);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { tenantId } = tenantCtx;

  if (req.method === 'POST') {
    return handleCreate(req, res, tenantId);
  }
  return handleUpdate(req, res, tenantId);
}

// ---------------------------------------------------------------------------
// POST — create member + marker atomically
// ---------------------------------------------------------------------------
async function handleCreate(req, res, tenantId) {
  const { first_name, last_name, email, organisation, job_title, role_id } = req.body;

  if (!first_name || !last_name || !email) {
    return res.status(400).json({ error: 'first_name, last_name, and email are required' });
  }
  if (!role_id) {
    return res.status(400).json({ error: 'role_id is required for new guests' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Guard 1: email must not already belong to a tenant member
  const { data: existingMember, error: memberCheckErr } = await supabase
    .from('member')
    .select('id')
    .eq('tenant_id', tenantId)
    .ilike('email', normalizedEmail)
    .not('email', 'ilike', 'deleted_%@deleted.local')
    .limit(1);

  if (memberCheckErr) {
    console.error('[provision-guest] member email check failed:', memberCheckErr.message);
    return res.status(500).json({ error: 'Email validation failed' });
  }
  if (existingMember && existingMember.length > 0) {
    return res.status(409).json({ error: 'This email already belongs to a member of this tenant' });
  }

  // Guard 2: validate role_id belongs to this tenant
  const { data: roleRow, error: roleErr } = await supabase
    .from('role')
    .select('id')
    .eq('id', role_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (roleErr || !roleRow) {
    return res.status(400).json({ error: 'Invalid role_id for this tenant' });
  }

  // Create the member record
  const { data: newMember, error: memberCreateErr } = await supabase
    .from('member')
    .insert({
      tenant_id: tenantId,
      first_name: first_name.trim(),
      last_name: last_name.trim(),
      email: normalizedEmail,
      role_id,
      login_enabled: true,
      // Explicitly do NOT set is_guest / guest_expires_at
    })
    .select('id')
    .single();

  if (memberCreateErr) {
    console.error('[provision-guest] member create failed:', memberCreateErr.message);
    if (memberCreateErr.code === '23505') {
      return res.status(409).json({ error: 'A member with this email already exists' });
    }
    return res.status(500).json({ error: 'Failed to create member record: ' + memberCreateErr.message });
  }

  const memberId = newMember.id;

  // Create the marker row
  const { data: guestRow, error: guestCreateErr } = await supabase
    .from('member_group_guest')
    .insert({
      tenant_id: tenantId,
      first_name: first_name.trim(),
      last_name: last_name.trim(),
      email: normalizedEmail,
      organisation: (organisation || '').trim() || null,
      job_title: (job_title || '').trim() || null,
      is_active: true,
      member_id: memberId,
    })
    .select('*')
    .single();

  if (guestCreateErr) {
    // Rollback: delete the provisioned member so we don't leave an orphan.
    // Use destructuring — Supabase builders do not expose .catch() directly.
    console.error('[provision-guest] marker create failed:', guestCreateErr.message, '— rolling back member');
    const { error: rollbackErr } = await supabase
      .from('member')
      .delete()
      .eq('id', memberId)
      .eq('tenant_id', tenantId);
    if (rollbackErr) {
      console.error('[provision-guest] member rollback failed:', rollbackErr.message, '— orphaned member id:', memberId);
    }
    return res.status(500).json({ error: 'Failed to create guest marker: ' + guestCreateErr.message });
  }

  return res.status(201).json(guestRow);
}

// ---------------------------------------------------------------------------
// PATCH — update member (first) then marker; compensate on partial failure
// ---------------------------------------------------------------------------
async function handleUpdate(req, res, tenantId) {
  const { id: guestId, first_name, last_name, email, organisation, job_title, is_active, role_id } = req.body;

  if (!guestId) {
    return res.status(400).json({ error: 'id is required for update' });
  }

  // Fetch the existing marker to verify ownership and get member_id + old field values
  const { data: existing, error: fetchErr } = await supabase
    .from('member_group_guest')
    .select('*')
    .eq('id', guestId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (fetchErr || !existing) {
    return res.status(404).json({ error: 'Guest not found' });
  }

  const normalizedEmail = email !== undefined ? email.trim().toLowerCase() : existing.email;

  // If email is changing, check it's not already taken by another member
  if (normalizedEmail !== existing.email) {
    const nullUuid = '00000000-0000-0000-0000-000000000000';
    const { data: emailConflict, error: emailCheckErr } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .ilike('email', normalizedEmail)
      .not('email', 'ilike', 'deleted_%@deleted.local')
      .neq('id', existing.member_id || nullUuid)
      .limit(1);

    if (emailCheckErr) {
      return res.status(500).json({ error: 'Email validation failed' });
    }
    if (emailConflict && emailConflict.length > 0) {
      return res.status(409).json({ error: 'This email already belongs to a member of this tenant' });
    }
  }

  // Validate role_id tenant ownership if provided
  if (role_id) {
    const { data: roleRow, error: roleErr } = await supabase
      .from('role')
      .select('id')
      .eq('id', role_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (roleErr || !roleRow) {
      return res.status(400).json({ error: 'Invalid role_id for this tenant' });
    }
  }

  // --- Step 1: update the linked member record first (if provisioned) ---
  // Updating the member first means that if the marker write subsequently fails,
  // the compensating rollback reverts the member back to its pre-update state,
  // keeping both records consistent.
  let memberUpdateApplied = false;
  const memberUpdate = {};
  if (existing.member_id) {
    if (first_name !== undefined) memberUpdate.first_name = first_name.trim();
    if (last_name !== undefined) memberUpdate.last_name = last_name.trim();
    if (email !== undefined) memberUpdate.email = normalizedEmail;
    if (role_id) memberUpdate.role_id = role_id;
    if (is_active !== undefined) memberUpdate.login_enabled = is_active !== false;

    if (Object.keys(memberUpdate).length > 0) {
      const { error: memberUpdateErr } = await supabase
        .from('member')
        .update(memberUpdate)
        .eq('id', existing.member_id)
        .eq('tenant_id', tenantId);

      if (memberUpdateErr) {
        console.error('[provision-guest] member update failed:', memberUpdateErr.message);
        return res.status(500).json({ error: 'Failed to update member record: ' + memberUpdateErr.message });
      }
      memberUpdateApplied = true;
    }
  }

  // --- Step 2: update the marker row ---
  const markerUpdate = {};
  if (first_name !== undefined) markerUpdate.first_name = first_name.trim();
  if (last_name !== undefined) markerUpdate.last_name = last_name.trim();
  if (email !== undefined) markerUpdate.email = normalizedEmail;
  if (organisation !== undefined) markerUpdate.organisation = (organisation || '').trim() || null;
  if (job_title !== undefined) markerUpdate.job_title = (job_title || '').trim() || null;
  if (is_active !== undefined) markerUpdate.is_active = is_active;

  const { data: updatedGuest, error: markerUpdateErr } = await supabase
    .from('member_group_guest')
    .update(markerUpdate)
    .eq('id', guestId)
    .eq('tenant_id', tenantId)
    .select('*')
    .single();

  if (markerUpdateErr) {
    // Compensating rollback: revert the member to its pre-update state so
    // marker and member remain in sync.
    if (memberUpdateApplied && existing.member_id) {
      const revert = {};
      if (memberUpdate.first_name !== undefined) revert.first_name = existing.first_name;
      if (memberUpdate.last_name !== undefined) revert.last_name = existing.last_name;
      if (memberUpdate.email !== undefined) revert.email = existing.email;
      if (memberUpdate.role_id !== undefined) revert.role_id = existing.role_id || null;
      if (memberUpdate.login_enabled !== undefined) revert.login_enabled = existing.is_active !== false;

      const { error: revertErr } = await supabase
        .from('member')
        .update(revert)
        .eq('id', existing.member_id)
        .eq('tenant_id', tenantId);

      if (revertErr) {
        console.error('[provision-guest] member compensating revert failed:', revertErr.message,
          '— member id may be out of sync:', existing.member_id);
      }
    }
    console.error('[provision-guest] marker update failed:', markerUpdateErr.message);
    return res.status(500).json({ error: 'Failed to update guest marker: ' + markerUpdateErr.message });
  }

  return res.json(updatedGuest);
}
