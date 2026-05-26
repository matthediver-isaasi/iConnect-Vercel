/**
 * Plan quota enforcement (Task #1026)
 *
 * Looks up a tenant's current `plan` row and compares live usage against the
 * `quotas` JSONB (keys: `members`, `events_per_month`, `storage_mb`,
 * `emails_per_month`). Quota values are integers; `null` / missing means
 * unlimited.
 *
 * Returns a discriminated result so callers can decide whether to 4xx the
 * request with a clear upgrade-prompt payload, or proceed.
 *
 *   const check = await checkMemberQuota(tenantId);
 *   if (!check.ok) return res.status(check.status).json(check.body);
 *
 * The error body has a stable shape so the frontend can render a "Upgrade
 * plan" CTA pointing at `/admin/plan-usage` (the v1 stub upgrade page).
 */

import { supabase } from './database.js';

const UPGRADE_PATH = '/admin/plan-usage';

const QUOTA_LABELS = {
  members: 'members',
  events_per_month: 'events this month',
  storage_mb: 'storage',
  emails_per_month: 'emails this month',
};

async function getTenantPlan(tenantId) {
  if (!tenantId || !supabase) return null;
  const { data: tenant } = await supabase
    .from('tenant')
    .select('plan_code')
    .eq('id', tenantId)
    .single();
  const planCode = tenant?.plan_code || 'free';
  const { data: plan } = await supabase
    .from('plan')
    .select('code, name, quotas')
    .eq('code', planCode)
    .single();
  return plan || { code: planCode, name: planCode, quotas: {} };
}

function monthStartIso() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function buildOverLimitBody(quotaKey, plan, current, limit, extra = {}) {
  const label = QUOTA_LABELS[quotaKey] || quotaKey;
  const planName = plan?.name || plan?.code || 'your current plan';
  return {
    error: `Your ${planName} plan is limited to ${limit} ${label}. Upgrade your plan to add more.`,
    code: 'PLAN_QUOTA_EXCEEDED',
    quota: {
      key: quotaKey,
      limit,
      current,
      plan: plan?.code || null,
      plan_name: plan?.name || null,
      upgrade_url: UPGRADE_PATH,
      ...extra,
    },
  };
}

function readQuota(plan, key) {
  const q = plan?.quotas || {};
  const v = q[key];
  if (v === null || v === undefined) return null; // unlimited
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function checkMemberQuota(tenantId, { addingCount = 1 } = {}) {
  const plan = await getTenantPlan(tenantId);
  const limit = readQuota(plan, 'members');
  if (limit === null) return { ok: true };

  const { count } = await supabase
    .from('member')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('is_sample', false);
  const current = count || 0;

  if (current + addingCount > limit) {
    return {
      ok: false,
      status: 402,
      body: buildOverLimitBody('members', plan, current, limit),
    };
  }
  return { ok: true };
}

export async function checkEventQuota(tenantId, { addingCount = 1 } = {}) {
  const plan = await getTenantPlan(tenantId);
  const limit = readQuota(plan, 'events_per_month');
  if (limit === null) return { ok: true };

  // Exclude sample seed rows so onboarding-seeded events don't eat the quota.
  const { count } = await supabase
    .from('event')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('is_sample', false)
    .gte('created_at', monthStartIso());
  const current = count || 0;

  if (current + addingCount > limit) {
    return {
      ok: false,
      status: 402,
      body: buildOverLimitBody('events_per_month', plan, current, limit),
    };
  }
  return { ok: true };
}

/**
 * Count emails delivered/sent this calendar month for a tenant. Best-effort:
 * joins email_campaign_recipient -> email_campaign to scope by tenant.
 */
async function countEmailsSentThisMonth(tenantId) {
  // email_campaign has tenant_id, email_campaign_recipient links via campaign_id.
  const { data: campaigns } = await supabase
    .from('email_campaign')
    .select('id')
    .eq('tenant_id', tenantId)
    .gte('sent_at', monthStartIso());

  const ids = (campaigns || []).map((c) => c.id);
  if (ids.length === 0) return 0;

  const { count } = await supabase
    .from('email_campaign_recipient')
    .select('id', { count: 'exact', head: true })
    .in('campaign_id', ids)
    .in('status', ['sent', 'delivered', 'opened', 'clicked']);
  return count || 0;
}

export async function checkEmailQuota(tenantId, { addingCount = 0 } = {}) {
  const plan = await getTenantPlan(tenantId);
  const limit = readQuota(plan, 'emails_per_month');
  if (limit === null) return { ok: true };

  let current;
  try {
    current = await countEmailsSentThisMonth(tenantId);
  } catch (err) {
    // Fail-closed: if we cannot compute current usage, refuse the send
    // rather than silently allow it to exceed the plan.
    console.error('[planQuota] email usage count failed, blocking send:', err?.message);
    return {
      ok: false,
      status: 503,
      body: {
        error: 'Unable to verify your plan email usage right now. Please try again in a moment.',
        code: 'PLAN_QUOTA_CHECK_FAILED',
        quota: { key: 'emails_per_month', upgrade_url: UPGRADE_PATH },
      },
    };
  }

  if (current + addingCount > limit) {
    return {
      ok: false,
      status: 402,
      body: buildOverLimitBody('emails_per_month', plan, current, limit, {
        attempted: addingCount,
      }),
    };
  }
  return { ok: true };
}

/**
 * Storage check. We do not yet track cumulative tenant storage, so v1
 * enforces a per-upload cap: a single file must not exceed the tenant's
 * total storage quota (a 500MB-plan tenant uploading a 1GB file is rejected).
 * Cumulative metering is left for a follow-up.
 */
export async function checkStorageQuota(tenantId, { fileSizeBytes = 0 } = {}) {
  const plan = await getTenantPlan(tenantId);
  const limitMb = readQuota(plan, 'storage_mb');
  if (limitMb === null) return { ok: true };
  const limitBytes = limitMb * 1024 * 1024;

  if (fileSizeBytes > limitBytes) {
    return {
      ok: false,
      status: 402,
      body: buildOverLimitBody(
        'storage_mb',
        plan,
        null,
        limitMb,
        { attempted_bytes: fileSizeBytes, limit_bytes: limitBytes }
      ),
    };
  }
  return { ok: true };
}

export const __test = { getTenantPlan, readQuota, buildOverLimitBody };
