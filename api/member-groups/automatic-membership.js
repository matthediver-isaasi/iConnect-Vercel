/**
 * Admin-gated API for automatic membership configuration and reconciliation.
 *
 * GET  /api/member-groups/automatic-membership
 *   Without group_id: returns field catalog only (for new-group create UI).
 *   With ?group_id=...: returns field catalog + group status/config.
 *
 * POST /api/member-groups/automatic-membership
 *   Body (canonical): { action: 'preview'|'reconcile', groupId?, config? }
 *   Aliases accepted:  mode -> action, group_id -> groupId
 *
 *   preview:
 *     - config must include { enabled, role, filterGroups, roles? }.
 *     - groupId optional; if provided the saved group is loaded and merged.
 *     - Validates the effective config server-side.
 *     - Runs the filter and returns { matchCount, validationErrors }.
 *     - No DB mutations.
 *
 *   reconcile:
 *     - groupId required.
 *     - Uses ONLY the saved group config (config param is ignored).
 *     - Runs one bounded/resumable batch (up to BATCH_SIZE members).
 *     - Calls the reconcile_automatic_membership RPC with generation+cursor fencing.
 *     - Returns { status, syncStatus, inserted, deleted, matchCount, hasMore }.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  validateAutomaticMembershipSettings,
  fetchAllowedCustomFieldIdsByScope,
  buildFieldMeta,
  roleExistsInGroup,
  ALLOWED_CORE_MEMBER_KEYS,
  ALLOWED_CORE_ORG_KEYS,
} from '../_lib/automaticMembership.js';
import { runFilterQuery } from '../_lib/automaticMembershipQuery.js';

const BATCH_SIZE = 500;

// Server-authoritative core field descriptors
const CORE_MEMBER_FIELDS = [
  { key: 'first_name',                    label: 'First Name',                   data_type: 'text' },
  { key: 'last_name',                     label: 'Last Name',                    data_type: 'text' },
  { key: 'email',                         label: 'Email',                        data_type: 'text' },
  { key: 'job_title',                     label: 'Job Title',                    data_type: 'text' },
  { key: 'role_id',                       label: 'Role',                         data_type: 'text' },
  { key: 'login_enabled',                 label: 'Login Enabled',                data_type: 'boolean' },
  { key: 'communications_opted_out_all',  label: 'Opted Out of All Comms',       data_type: 'boolean' },
];

const CORE_ORG_FIELDS = [
  { key: 'name',   label: 'Organisation Name', data_type: 'text' },
  { key: 'status', label: 'Status',            data_type: 'text' },
];

// Columns to SELECT from member_group for reconciliation
const GROUP_SELECT_COLS = [
  'id', 'name', 'tenant_id', 'roles',
  'automatic_membership_enabled',
  'automatic_membership_role',
  'automatic_membership_filter_groups',
  'automatic_membership_sync_status',
  'automatic_membership_cursor',
  'automatic_membership_generation',
].join(', ');

// Columns to SELECT from member_group for GET response
const GROUP_GET_COLS = [
  'id', 'name', 'roles',
  'automatic_membership_enabled',
  'automatic_membership_role',
  'automatic_membership_filter_groups',
  'allow_members_to_leave',
  'automatic_membership_sync_status',
  'automatic_membership_last_synced_at',
  'automatic_membership_match_count',
  'automatic_membership_sync_error',
  'automatic_membership_cursor',
  'automatic_membership_generation',
].join(', ');

export default async function handler(req, res) {
  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const isAdmin = await hasAdminAccess(tenantCtx);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (req.method === 'GET') {
    return handleGet(req, res, tenantCtx);
  }
  if (req.method === 'POST') {
    return handlePost(req, res, tenantCtx);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------
async function handleGet(req, res, tenantCtx) {
  const groupId = req.query?.group_id;

  // Field catalog is always returned (needed for create UI without group_id)
  const catalog = await buildFieldCatalog(tenantCtx.tenantId);

  if (!groupId) {
    return res.json({ fields: catalog });
  }

  const { data: group, error: groupErr } = await supabase
    .from('member_group')
    .select(GROUP_GET_COLS)
    .eq('id', groupId)
    .eq('tenant_id', tenantCtx.tenantId)
    .maybeSingle();

  if (groupErr) {
    console.error('[AutoMembership GET] group lookup error:', groupErr.message);
    return res.status(500).json({ error: groupErr.message });
  }
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  return res.json({
    fields: catalog,
    group: {
      id: group.id,
      name: group.name,
      roles: group.roles || [],
      automatic_membership_enabled: group.automatic_membership_enabled || false,
      automatic_membership_role: group.automatic_membership_role || null,
      automatic_membership_filter_groups: group.automatic_membership_filter_groups || [],
      allow_members_to_leave: group.allow_members_to_leave !== false,
      automatic_membership_sync_status: group.automatic_membership_sync_status || 'idle',
      automatic_membership_last_synced_at: group.automatic_membership_last_synced_at || null,
      automatic_membership_match_count: group.automatic_membership_match_count ?? null,
      automatic_membership_sync_error: group.automatic_membership_sync_error || null,
      automatic_membership_cursor: group.automatic_membership_cursor || null,
      automatic_membership_generation: group.automatic_membership_generation ?? 0,
    },
  });
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------
async function handlePost(req, res, tenantCtx) {
  const body = req.body || {};

  // Accept canonical { action, groupId, config } and legacy { mode, group_id, config }
  const action  = body.action  || body.mode;
  const groupId = body.groupId || body.group_id;
  const config  = body.config  || null;

  if (action !== 'preview' && action !== 'reconcile') {
    return res.status(400).json({ error: 'action must be "preview" or "reconcile"' });
  }
  if (action === 'reconcile' && !groupId) {
    return res.status(400).json({ error: 'groupId is required for reconcile' });
  }

  const scopeResult = await fetchAllowedCustomFieldIdsByScope(supabase, tenantCtx.tenantId);
  const allowedCustomFieldIdsByScope = scopeResult;
  const fieldMeta = buildFieldMeta(scopeResult);

  if (action === 'preview') {
    return handlePreview(req, res, tenantCtx, groupId, config, allowedCustomFieldIdsByScope, fieldMeta);
  }
  return handleReconcile(req, res, tenantCtx, groupId, allowedCustomFieldIdsByScope, fieldMeta);
}

// ---------------------------------------------------------------------------
// Preview mode
// ---------------------------------------------------------------------------
async function handlePreview(req, res, tenantCtx, groupId, config, allowedCustomFieldIdsByScope, fieldMeta) {
  let savedGroup = null;
  if (groupId) {
    const { data: grp, error: grpErr } = await supabase
      .from('member_group')
      .select('id, roles, automatic_membership_enabled, automatic_membership_role, automatic_membership_filter_groups')
      .eq('id', groupId)
      .eq('tenant_id', tenantCtx.tenantId)
      .maybeSingle();
    if (grpErr) {
      console.error('[AutoMembership preview] group lookup error:', grpErr.message);
      return res.status(500).json({ error: grpErr.message });
    }
    if (!grp) {
      return res.status(404).json({ error: 'Group not found' });
    }
    savedGroup = grp;
  }

  const effectiveConfig = {
    automatic_membership_enabled: savedGroup?.automatic_membership_enabled ?? false,
    automatic_membership_role:    savedGroup?.automatic_membership_role    ?? null,
    automatic_membership_filter_groups: savedGroup?.automatic_membership_filter_groups ?? [],
    roles: savedGroup?.roles ?? [],
    ...(config ? normaliseConfig(config) : {}),
  };

  const groupRoles = (config && Array.isArray(config.roles)) ? config.roles : (effectiveConfig.roles || []);

  const roleCheck = (role) => roleExistsInGroup(role, groupRoles);
  const validation = await validateAutomaticMembershipSettings(effectiveConfig, {
    allowedCustomFieldIdsByScope,
    fieldMeta,
    roleExists: roleCheck,
  });

  if (!validation.ok) {
    return res.status(422).json({ error: validation.error, validationErrors: [validation.error] });
  }

  const filterGroups = effectiveConfig.automatic_membership_filter_groups;
  if (!Array.isArray(filterGroups) || filterGroups.length === 0) {
    return res.json({ matchCount: 0, valid: true, validationErrors: [] });
  }

  try {
    const matchedIds = await runFilterQuery({
      supabase,
      tenantId: tenantCtx.tenantId,
      filterGroups,
      allowedCustomFieldIdsByScope,
    });
    return res.json({ matchCount: matchedIds.length, valid: true, validationErrors: [] });
  } catch (err) {
    console.error('[AutoMembership preview] filter query error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Reconcile mode
// ---------------------------------------------------------------------------
async function handleReconcile(req, res, tenantCtx, groupId, allowedCustomFieldIdsByScope, fieldMeta) {
  const { data: group, error: groupErr } = await supabase
    .from('member_group')
    .select(GROUP_SELECT_COLS)
    .eq('id', groupId)
    .eq('tenant_id', tenantCtx.tenantId)
    .maybeSingle();

  if (groupErr) {
    console.error('[AutoMembership reconcile] group lookup error:', groupErr.message);
    return res.status(500).json({ error: groupErr.message });
  }
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  if (!group.automatic_membership_enabled) {
    return res.status(422).json({ error: 'Automatic membership is not enabled for this group' });
  }

  const roleCheck = (role) => roleExistsInGroup(role, group.roles || []);
  const validation = await validateAutomaticMembershipSettings(group, {
    allowedCustomFieldIdsByScope,
    fieldMeta,
    roleExists: roleCheck,
  });
  if (!validation.ok) {
    return res.status(422).json({ error: validation.error, validationErrors: [validation.error] });
  }

  const filterGroups = group.automatic_membership_filter_groups || [];
  const expectedGeneration = group.automatic_membership_generation ?? 0;
  const expectedCursor     = group.automatic_membership_cursor ?? null;

  let fullTargetIds;
  try {
    fullTargetIds = await runFilterQuery({
      supabase,
      tenantId: tenantCtx.tenantId,
      filterGroups,
      allowedCustomFieldIdsByScope,
    });
  } catch (err) {
    console.error('[AutoMembership reconcile] filter query error:', err.message);
    // Use generation fencing on error update too
    await supabase
      .from('member_group')
      .update({
        automatic_membership_sync_status: 'error',
        automatic_membership_sync_error: err.message,
      })
      .eq('id', group.id)
      .eq('automatic_membership_generation', expectedGeneration);
    return res.status(500).json({ error: err.message });
  }

  const cursorIndex  = parseCursor(expectedCursor);
  const batchSlice   = fullTargetIds.slice(cursorIndex, cursorIndex + BATCH_SIZE);
  const nextIndex    = cursorIndex + batchSlice.length;
  const isFinalBatch = nextIndex >= fullTargetIds.length;
  const nextCursor   = isFinalBatch ? null : String(nextIndex);

  const { data: rpcResult, error: rpcError } = await supabase.rpc(
    'reconcile_automatic_membership',
    {
      p_group_id:            group.id,
      p_tenant_id:           tenantCtx.tenantId,
      p_role:                group.automatic_membership_role,
      p_batch_member_ids:    batchSlice,
      p_full_target_ids:     fullTargetIds,
      p_is_final_batch:      isFinalBatch,
      p_next_cursor:         nextCursor,
      p_full_match_count:    fullTargetIds.length,
      p_expected_generation: expectedGeneration,
      p_expected_cursor:     expectedCursor,
    }
  );

  if (rpcError) {
    console.error('[AutoMembership reconcile] RPC error:', rpcError.message);
    await supabase
      .from('member_group')
      .update({
        automatic_membership_sync_status: 'error',
        automatic_membership_sync_error: rpcError.message,
      })
      .eq('id', group.id)
      .eq('automatic_membership_generation', expectedGeneration);
    return res.status(500).json({ error: rpcError.message });
  }

  if (!rpcResult?.ok) {
    const detail = rpcResult?.detail || 'RPC returned not ok';
    const code   = rpcResult?.code;
    // For STALE_GENERATION / CURSOR_MISMATCH — return 409 Conflict, not 500
    const status = (code === 'STALE_GENERATION' || code === 'CURSOR_MISMATCH') ? 409 : 500;
    return res.status(status).json({ error: detail, code });
  }

  return res.json({
    status: 'ok',
    syncStatus: isFinalBatch ? 'idle' : 'running',
    inserted: rpcResult.inserted || 0,
    deleted: rpcResult.deleted || 0,
    matchCount: fullTargetIds.length,
    hasMore: !isFinalBatch,
    nextCursor,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCursor(cursor) {
  if (!cursor) return 0;
  const n = parseInt(cursor, 10);
  return isNaN(n) ? 0 : n;
}

function normaliseConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return {};
  const out = {};
  if ('enabled'      in cfg) out.automatic_membership_enabled       = cfg.enabled;
  if ('role'         in cfg) out.automatic_membership_role          = cfg.role;
  if ('filterGroups' in cfg) out.automatic_membership_filter_groups = cfg.filterGroups;
  if ('roles'        in cfg) out.roles                              = cfg.roles;
  return out;
}

async function buildFieldCatalog(tenantId) {
  const scopeResult = await fetchAllowedCustomFieldIdsByScope(supabase, tenantId);

  // Custom fields come from memberTypes / organizationTypes metadata maps
  const memberCustomFields = [];
  for (const [id, meta] of (scopeResult.memberTypes instanceof Map ? scopeResult.memberTypes : new Map())) {
    memberCustomFields.push({
      key: id,
      data_type: meta.data_type,
      field_type: 'custom',
      entity_scope: 'member',
      options: meta.options,
    });
  }

  const orgCustomFields = [];
  for (const [id, meta] of (scopeResult.organizationTypes instanceof Map ? scopeResult.organizationTypes : new Map())) {
    orgCustomFields.push({
      key: id,
      data_type: meta.data_type,
      field_type: 'custom',
      entity_scope: 'organization',
      options: meta.options,
    });
  }

  // Fetch labels separately for display (preference_field has name/label)
  const { data: prefFields } = await supabase
    .from('preference_field')
    .select('id, name, label, entity_scope')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  const labelMap = new Map();
  for (const f of prefFields || []) labelMap.set(f.id, f.label || f.name);

  memberCustomFields.forEach(f => { f.label = labelMap.get(f.key) || f.key; });
  orgCustomFields.forEach(f => { f.label = labelMap.get(f.key) || f.key; });

  return {
    member: {
      core: CORE_MEMBER_FIELDS.map(f => ({ ...f, field_type: 'core', entity_scope: 'member' })),
      custom: memberCustomFields,
    },
    organization: {
      core: CORE_ORG_FIELDS.map(f => ({ ...f, field_type: 'core', entity_scope: 'organization' })),
      custom: orgCustomFields,
    },
  };
}
