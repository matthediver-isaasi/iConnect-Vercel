import pg from 'pg';
import { getTenantContext } from '../_lib/tenantContext.js';

const { Pool } = pg;

const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.DEST_DATABASE_URL ||
  process.env.SUPABASE_DB_URL;

let _pool = null;
function getPool() {
  if (!_pool && databaseUrl) {
    _pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }
  return _pool;
}

const CONFIG_CLONE_COLUMNS = [
  'scoring_approach',
  'scoring_rules',
  'static_questions',
  'custom_risk_levels',
  'default_review_state',
  'workflow_stages',
  'status_change_webhooks',
  'enforce_stage_sequence',
  'crm_attachment_config',
  'crm_logo_upload_config',
  'applicant_name_field',
  'applicant_email_field',
  'applicant_organization_name_field',
  'card_reference_field',
  'show_description_fields',
  'on_first_edit_stage',
  'owner_role_ids',
  'default_owner_name',
  'is_active',
];

const EMAIL_ACTION_CLONE_COLUMNS = [
  'due_diligence_stage_id',
  'email_template_id',
  'recipient_email_field',
  'recipient_name_field',
  'cc_emails',
  'prompt_custom_message',
  'sort_order',
  'is_active',
];

const MEMBER_ACTION_CLONE_COLUMNS = [
  'due_diligence_stage_id',
  'first_name_field',
  'last_name_field',
  'email_field',
  'field_mappings',
  'role_id',
  'welcome_email_template_id',
  'sort_order',
  'is_active',
  'login_enabled',
];

const FIELD_MAPPING_ACTION_CLONE_COLUMNS = [
  'due_diligence_stage_id',
  'field_mappings',
  'sort_order',
  'is_active',
];

const ZOHO_CRM_ACTION_CLONE_COLUMNS = [
  'due_diligence_stage_id',
  'field_mappings',
  'sort_order',
  'is_active',
];

const MEETING_REQUEST_CLONE_COLUMNS = [
  'due_diligence_stage_id',
  'meeting_template_id',
  'recipient_email_field',
  'first_name_field',
  'sort_order',
  'is_active',
];

function collectStageIds(workflowStages) {
  if (!Array.isArray(workflowStages)) return [];
  return workflowStages
    .map(s => (s && typeof s === 'object' ? s.id : null))
    .filter(id => typeof id === 'string' && id.length > 0);
}

function buildInsertSQL(table, columns, rows, extraColumns) {
  // Returns { text, values } that inserts `rows.length` rows.
  // Each row: pickColumns(row, columns) + extraColumns (object, same for all rows).
  const extraKeys = Object.keys(extraColumns || {});
  const allCols = [...columns, ...extraKeys];
  const values = [];
  const tuples = rows.map((row) => {
    const placeholders = allCols.map((col) => {
      const v = extraKeys.includes(col) ? extraColumns[col] : row[col];
      values.push(v === undefined ? null : v);
      return `$${values.length}`;
    });
    return `(${placeholders.join(',')})`;
  });
  const colList = allCols.map((c) => `"${c}"`).join(',');
  return {
    text: `INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(',')}`,
    values,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!databaseUrl) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const tenantId = tenantCtx.tenantId;
  if (!tenantId || tenantId === 'undefined') {
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  const { sourceFormId, targetFormId } = req.body || {};
  if (!sourceFormId || !targetFormId) {
    return res.status(400).json({ error: 'sourceFormId and targetFormId are required' });
  }
  if (sourceFormId === targetFormId) {
    return res.status(400).json({ error: 'sourceFormId and targetFormId must differ' });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    // Look up forms (tenant guarded)
    const formsResult = await client.query(
      `SELECT id, name FROM "form" WHERE id IN ($1, $2) AND tenant_id = $3`,
      [sourceFormId, targetFormId, tenantId]
    );
    const sourceForm = formsResult.rows.find(f => f.id === sourceFormId);
    const targetForm = formsResult.rows.find(f => f.id === targetFormId);
    if (!sourceForm) return res.status(404).json({ error: 'Source form not found in this tenant' });
    if (!targetForm) return res.status(404).json({ error: 'Target form not found in this tenant' });

    const sourceConfigResult = await client.query(
      `SELECT * FROM "form_due_diligence_config" WHERE form_id = $1 AND tenant_id = $2`,
      [sourceFormId, tenantId]
    );
    const sourceConfig = sourceConfigResult.rows[0];
    if (!sourceConfig) {
      return res.status(400).json({ error: 'Source form has no due diligence configuration to copy' });
    }

    const targetConfigResult = await client.query(
      `SELECT id, workflow_stages FROM "form_due_diligence_config" WHERE form_id = $1 AND tenant_id = $2`,
      [targetFormId, tenantId]
    );
    const existingTargetConfig = targetConfigResult.rows[0];

    // ============================================================
    // TRANSACTION
    // ============================================================
    await client.query('BEGIN');

    // Delete target's existing stage actions
    await client.query(
      `DELETE FROM "stage_email_action" WHERE tenant_id = $1 AND form_id = $2`,
      [tenantId, targetFormId]
    );
    await client.query(
      `DELETE FROM "stage_member_action" WHERE tenant_id = $1 AND (form_id = $2 OR form_due_diligence_config_id = $3)`,
      [tenantId, targetFormId, existingTargetConfig?.id || null]
    );
    await client.query(
      `DELETE FROM "stage_field_mapping_action" WHERE tenant_id = $1 AND form_id = $2`,
      [tenantId, targetFormId]
    );
    await client.query(
      `DELETE FROM "stage_zoho_crm_action" WHERE tenant_id = $1 AND form_id = $2`,
      [tenantId, targetFormId]
    );
    await client.query(
      `DELETE FROM "stage_meeting_request" WHERE tenant_id = $1 AND (form_id = $2 OR form_due_diligence_config_id = $3)`,
      [tenantId, targetFormId, existingTargetConfig?.id || null]
    );

    // Upsert config row on target
    const configPayload = {};
    for (const col of CONFIG_CLONE_COLUMNS) {
      if (sourceConfig[col] !== undefined) configPayload[col] = sourceConfig[col];
    }
    configPayload.tenant_id = tenantId;
    configPayload.form_id = targetFormId;
    configPayload.updated_at = new Date();

    let targetConfigId;
    if (existingTargetConfig?.id) {
      const setCols = Object.keys(configPayload);
      const setClause = setCols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
      const vals = setCols.map(c => {
        const v = configPayload[c];
        return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
      });
      vals.push(existingTargetConfig.id, tenantId);
      const updateRes = await client.query(
        `UPDATE "form_due_diligence_config" SET ${setClause} WHERE id = $${setCols.length + 1} AND tenant_id = $${setCols.length + 2} RETURNING id`,
        vals
      );
      targetConfigId = updateRes.rows[0]?.id;
    } else {
      const cols = Object.keys(configPayload);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
      const vals = cols.map(c => {
        const v = configPayload[c];
        return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
      });
      const insertRes = await client.query(
        `INSERT INTO "form_due_diligence_config" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${placeholders}) RETURNING id`,
        vals
      );
      targetConfigId = insertRes.rows[0]?.id;
    }

    if (!targetConfigId) {
      throw new Error('Failed to obtain target config id');
    }

    // Mark target form as DD enabled
    await client.query(
      `UPDATE "form" SET due_diligence_required = true WHERE id = $1 AND tenant_id = $2`,
      [targetFormId, tenantId]
    );

    // Clone source stage actions
    const cloned = {
      email_actions: 0,
      member_actions: 0,
      field_mapping_actions: 0,
      zoho_crm_actions: 0,
      meeting_requests: 0,
    };

    const srcEmail = await client.query(
      `SELECT * FROM "stage_email_action" WHERE tenant_id = $1 AND form_id = $2`,
      [tenantId, sourceFormId]
    );
    if (srcEmail.rows.length) {
      const { text, values } = buildInsertSQL(
        'stage_email_action',
        EMAIL_ACTION_CLONE_COLUMNS,
        srcEmail.rows,
        { tenant_id: tenantId, form_id: targetFormId }
      );
      await client.query(text, values);
      cloned.email_actions = srcEmail.rows.length;
    }

    const srcMember = await client.query(
      `SELECT * FROM "stage_member_action" WHERE tenant_id = $1 AND (form_id = $2 OR form_due_diligence_config_id = $3)`,
      [tenantId, sourceFormId, sourceConfig.id]
    );
    if (srcMember.rows.length) {
      // jsonb columns come back as objects; need to stringify when re-inserting via pg
      const memberRows = srcMember.rows.map(r => ({
        ...r,
        field_mappings:
          r.field_mappings && typeof r.field_mappings === 'object'
            ? JSON.stringify(r.field_mappings)
            : r.field_mappings,
      }));
      const { text, values } = buildInsertSQL(
        'stage_member_action',
        MEMBER_ACTION_CLONE_COLUMNS,
        memberRows,
        {
          tenant_id: tenantId,
          form_id: targetFormId,
          form_due_diligence_config_id: targetConfigId,
        }
      );
      await client.query(text, values);
      cloned.member_actions = srcMember.rows.length;
    }

    const srcFm = await client.query(
      `SELECT * FROM "stage_field_mapping_action" WHERE tenant_id = $1 AND form_id = $2`,
      [tenantId, sourceFormId]
    );
    if (srcFm.rows.length) {
      const fmRows = srcFm.rows.map(r => ({
        ...r,
        field_mappings:
          r.field_mappings && typeof r.field_mappings === 'object'
            ? JSON.stringify(r.field_mappings)
            : r.field_mappings,
      }));
      const { text, values } = buildInsertSQL(
        'stage_field_mapping_action',
        FIELD_MAPPING_ACTION_CLONE_COLUMNS,
        fmRows,
        { tenant_id: tenantId, form_id: targetFormId }
      );
      await client.query(text, values);
      cloned.field_mapping_actions = srcFm.rows.length;
    }

    const srcZoho = await client.query(
      `SELECT * FROM "stage_zoho_crm_action" WHERE tenant_id = $1 AND form_id = $2`,
      [tenantId, sourceFormId]
    );
    if (srcZoho.rows.length) {
      const zohoRows = srcZoho.rows.map(r => ({
        ...r,
        field_mappings:
          r.field_mappings && typeof r.field_mappings === 'object'
            ? JSON.stringify(r.field_mappings)
            : r.field_mappings,
      }));
      const { text, values } = buildInsertSQL(
        'stage_zoho_crm_action',
        ZOHO_CRM_ACTION_CLONE_COLUMNS,
        zohoRows,
        { tenant_id: tenantId, form_id: targetFormId }
      );
      await client.query(text, values);
      cloned.zoho_crm_actions = srcZoho.rows.length;
    }

    // Source meeting requests: only rows explicitly scoped to the source
    // form/config are cloned. Legacy (NULL form_id) rows are NOT pulled
    // via stage-id heuristics — that would risk cloning unrelated forms'
    // meeting actions when default stage IDs (e.g. "new") are shared.
    // The migration backfills unambiguous legacy rows; anything still
    // unscoped must be remediated manually.
    const srcMtg = await client.query(
      `SELECT * FROM "stage_meeting_request"
         WHERE tenant_id = $1
           AND (form_id = $2 OR form_due_diligence_config_id = $3)`,
      [tenantId, sourceFormId, sourceConfig.id]
    );
    if (srcMtg.rows.length) {
      const { text, values } = buildInsertSQL(
        'stage_meeting_request',
        MEETING_REQUEST_CLONE_COLUMNS,
        srcMtg.rows,
        {
          tenant_id: tenantId,
          form_id: targetFormId,
          form_due_diligence_config_id: targetConfigId,
        }
      );
      await client.query(text, values);
      cloned.meeting_requests = srcMtg.rows.length;
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      target_form_id: targetFormId,
      target_config_id: targetConfigId,
      cloned,
      source_form_name: sourceForm.name,
      target_form_name: targetForm.name,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    console.error('[dd seed-config] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  } finally {
    client.release();
  }
}
