import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  EXTERNAL_CONTACT_SOURCES,
  analyzeExternalContactRows,
} from '../_lib/externalContactRows.js';

async function requireAdmin(req, res) {
  const context = await getTenantContext(req);
  if (!context.isAuthenticated || !context.tenantId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (!(await hasAdminAccess(context))) {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  return context;
}

async function findOwnedList(listId, tenantId) {
  const { data, error } = await supabase
    .from('audience_list')
    .select('id')
    .eq('id', listId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function resolveActor(context) {
  if (context.tenantUserId) {
    const { data, error } = await supabase
      .from('tenant_user')
      .select('id, name, email')
      .eq('id', context.tenantUserId)
      .eq('tenant_id', context.tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Authenticated tenant user could not be resolved');
    return {
      tenantUserId: data.id,
      memberId: null,
      label: data.name?.trim() || data.email,
    };
  }

  const { data, error } = await supabase
    .from('member')
    .select('id, first_name, last_name, email')
    .eq('id', context.memberId)
    .eq('tenant_id', context.tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Authenticated member could not be resolved');
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
  return { tenantUserId: null, memberId: data.id, label: name || data.email };
}

function toPublicOutcome(outcome) {
  const value = outcome.value || {};
  return {
    rowNumber: outcome.index + 1,
    first_name: value.first_name ?? outcome.row?.first_name ?? '',
    last_name: value.last_name ?? outcome.row?.last_name ?? '',
    email: value.email ?? outcome.row?.email ?? '',
    normalizedEmail: outcome.normalized_email || '',
    status: outcome.status,
    error: outcome.errors?.length ? outcome.errors.join('; ') : undefined,
    id: outcome.id,
  };
}

export default async function handler(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const context = await requireAdmin(req, res);
    if (!context) return;

    const listId = req.method === 'POST' ? req.body?.listId : req.query?.listId;
    if (!listId) return res.status(400).json({ error: 'listId is required' });

    const list = await findOwnedList(listId, context.tenantId);
    if (!list) return res.status(404).json({ error: 'Audience list not found' });

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('audience_list_external_contact')
        .select('*')
        .eq('tenant_id', context.tenantId)
        .eq('audience_list_id', listId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.json({ contacts: data || [] });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: 'id is required' });
      const { data, error } = await supabase
        .from('audience_list_external_contact')
        .delete()
        .eq('id', id)
        .eq('audience_list_id', listId)
        .eq('tenant_id', context.tenantId)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'External contact not found' });
      return res.json({ success: true, id: data.id });
    }

    const { rows, source, gdprAcknowledged, dryRun } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows must be a non-empty array' });
    }
    if (!EXTERNAL_CONTACT_SOURCES.has(source)) {
      return res.status(400).json({
        error: 'source must be individual, csv_upload, or pasted_rows',
      });
    }
    if (source === 'individual' && rows.length !== 1) {
      return res.status(400).json({ error: 'individual source requires exactly one row' });
    }
    if (dryRun !== true && gdprAcknowledged !== true) {
      return res.status(400).json({ error: 'GDPR acknowledgement is required' });
    }

    const candidateEmails = [...new Set(rows
      .map((row) => typeof row?.email === 'string' ? row.email.trim().toLowerCase() : '')
      .filter(Boolean))];
    let existingEmails = [];
    if (candidateEmails.length) {
      const { data, error } = await supabase
        .from('audience_list_external_contact')
        .select('normalized_email')
        .eq('tenant_id', context.tenantId)
        .eq('audience_list_id', listId)
        .in('normalized_email', candidateEmails);
      if (error) throw error;
      existingEmails = (data || []).map((item) => item.normalized_email);
    }

    const outcomes = analyzeExternalContactRows(rows, existingEmails);
    if (dryRun === true) {
      return res.json({ dryRun: true, outcomes: outcomes.map(toPublicOutcome) });
    }

    const actor = await resolveActor(context);
    const acknowledgedAt = new Date().toISOString();
    let inserted = 0;
    for (const outcome of outcomes) {
      if (outcome.status !== 'valid') continue;
      const { data, error } = await supabase
        .from('audience_list_external_contact')
        .insert({
          tenant_id: context.tenantId,
          audience_list_id: listId,
          email: outcome.value.email,
          normalized_email: outcome.value.normalized_email,
          first_name: outcome.value.first_name,
          last_name: outcome.value.last_name,
          addition_source: source,
          gdpr_acknowledged: true,
          gdpr_acknowledged_at: acknowledgedAt,
          added_by_tenant_user_id: actor.tenantUserId,
          added_by_member_id: actor.memberId,
          added_by_actor_label: actor.label,
        })
        .select('id')
        .single();
      if (error?.code === '23505') {
        outcome.status = 'duplicate_existing';
        continue;
      }
      if (error) throw error;
      outcome.id = data.id;
      inserted += 1;
    }

    return res.status(201).json({
      dryRun: false,
      insertedCount: inserted,
      outcomes: outcomes.map((outcome) => {
        if (outcome.status === 'valid') outcome.status = 'inserted';
        return toPublicOutcome(outcome);
      }),
    });
  } catch (error) {
    console.error('[AudienceListExternalContacts] error:', error);
    return res.status(500).json({ error: error.message });
  }
}