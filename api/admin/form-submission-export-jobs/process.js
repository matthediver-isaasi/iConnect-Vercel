import { createClient } from '@supabase/supabase-js';
import { Document, Packer } from 'docx';
import {
  resolveSubmissionToPrepared,
  renderPreparedSection,
  buildTitleBlock,
  buildFooter,
  loadTenantLogo,
  sanitizeFileName,
  resolveAwardType,
} from '../../../client/src/lib/formSubmissionWordExport.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const STORAGE_BUCKET = 'private-uploads';
// How long a single invocation will spend in the rendering loop before
// checkpointing and self-triggering the next invocation. Well under the
// 300s `maxDuration` so packaging in the same invocation also fits if we
// happen to finish.
const RENDER_TIME_BUDGET_MS = 30 * 1000;
// Maximum number of submissions to render in one invocation regardless of
// the time budget. Acts as a safety cap so very fast hosts still
// checkpoint regularly.
const RENDER_MAX_PER_INVOCATION = 200;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchByIds(table, ids, select) {
  if (!ids.length) return [];
  const out = [];
  for (const part of chunk(ids, 500)) {
    const { data, error } = await supabase.from(table).select(select).in('id', part);
    if (error) throw error;
    out.push(...(data || []));
  }
  return out;
}

function isSafePublicLogoUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '::1' || host === '0.0.0.0') return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 0) return false;
    if (a >= 224) return false;
  }
  if (host.includes(':')) return false;
  return true;
}

function buildServerResolvers(maps, origin) {
  const {
    organisationNamesById,
    memberNamesById,
    roleNamesById,
    resourceCategoryNamesById,
    communicationCategoryNamesById,
    customFieldDefById,
    formsById,
  } = maps;

  const resolveOrgName = (orgId) => {
    if (orgId == null || orgId === '') return '';
    const id = String(orgId);
    return organisationNamesById[id] || id;
  };
  const resolveMemberName = (memberId) => {
    if (memberId == null || memberId === '') return '';
    const id = String(memberId);
    return memberNamesById[id] || id;
  };
  const resolveRoleName = (roleId) => {
    if (roleId == null || roleId === '') return '';
    const id = String(roleId);
    return roleNamesById[id] || id;
  };
  const resolveResourceCategoryLabel = (raw) => {
    if (raw == null || raw === '') return '';
    const key = String(raw);
    return resourceCategoryNamesById[key] || key;
  };
  const resolveCommunicationPreferences = (val) => {
    if (val == null || typeof val !== 'object' || Array.isArray(val)) {
      return val == null ? '' : String(val);
    }
    return Object.entries(val)
      .filter(([, isSubscribed]) => isSubscribed === true)
      .map(([categoryId]) => communicationCategoryNamesById[categoryId] || categoryId)
      .join(', ');
  };
  const resolveImageButtonLabel = (val, fieldDef) => {
    if (val == null || val === '') return '';
    const options = Array.isArray(fieldDef?.image_options) ? fieldDef.image_options : [];
    const match = options.find(opt => opt && opt.value === val);
    return match?.label || String(val);
  };
  const resolveCustomFieldValue = (val, fieldDef) => {
    if (val == null || val === '') return '';
    const customFieldId = fieldDef?.custom_field_id;
    const customDef = customFieldId ? customFieldDefById[customFieldId] : null;
    const options = Array.isArray(customDef?.options) ? customDef.options : [];
    const lookupLabel = (raw) => {
      if (raw == null || raw === '') return '';
      const match = options.find(opt => {
        if (!opt) return false;
        const optValue = opt.value != null ? opt.value : opt.label;
        return optValue === raw;
      });
      return match?.label || String(raw);
    };
    if (Array.isArray(val)) return val.map(lookupLabel).filter(Boolean).join(', ');
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    if (options.length === 0) return String(val);
    return lookupLabel(val);
  };
  const resolveFile = (raw) => {
    if (raw == null || raw === '') return null;
    let parsed = raw;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { parsed = JSON.parse(trimmed); } catch { parsed = trimmed; }
      } else {
        return { name: trimmed.split('/').pop() || 'file', url: trimmed };
      }
    }
    if (Array.isArray(parsed)) return null;
    if (parsed && typeof parsed === 'object') {
      const name = parsed.file_name || parsed.name || (parsed.storage_path ? String(parsed.storage_path).split('/').pop() : 'file');
      if (parsed.bucket && parsed.storage_path) {
        return { name, url: `${origin}/api/storage/secure-url?bucket=${encodeURIComponent(parsed.bucket)}&path=${encodeURIComponent(parsed.storage_path)}&redirect=true` };
      }
      if (parsed.file_url) return { name, url: String(parsed.file_url) };
      return { name, url: null };
    }
    return null;
  };
  const resolveFormName = (submission) => {
    return submission.form_name || formsById[submission.form_id]?.name || 'Unknown Form';
  };
  const getSubmitterEmail = (submission) => {
    if (submission.submitted_by_email) return submission.submitted_by_email;
    if (submission.submission_data) {
      const data = submission.submission_data;
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string' && value.includes('@') && value.includes('.')) {
          const keyLower = key.toLowerCase();
          if (keyLower.includes('email') || keyLower.includes('e-mail')) return value;
        }
      }
      for (const [, value] of Object.entries(data)) {
        if (typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value;
      }
    }
    return null;
  };

  return {
    resolveFormName,
    getSubmitterEmail,
    resolveOrgName,
    resolveMemberName,
    resolveRoleName,
    resolveResourceCategoryLabel,
    resolveCommunicationPreferences,
    resolveImageButtonLabel,
    resolveCustomFieldValue,
    resolveFile,
  };
}

async function updateJob(jobId, patch) {
  const { error } = await supabase
    .from('form_submission_export_job')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) console.error('[form-submission-export-jobs/process] updateJob error:', error);
}

async function failJob(jobId, message) {
  await updateJob(jobId, {
    status: 'error',
    phase: 'error',
    error_message: String(message || 'Unknown error').slice(0, 1000),
    completed_at: new Date().toISOString(),
  });
}

function getOrigin(req) {
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const headerOrigin = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : '';
  return (process.env.VITE_APP_URL || headerOrigin || '').replace(/\/+$/, '');
}

function isAuthorized(req, job) {
  const token = req.query?.token || req.body?.token;
  if (token && job.worker_token && String(token) === String(job.worker_token)) return true;
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;
  return false;
}

// Fire a request at the worker endpoint to continue the job. The downstream
// invocation runs to completion independent of this caller; we abort the
// caller's wait after 2s so we don't pay for idle wall-clock time. Any
// non-abort error is surfaced so callers can record dispatch failures.
async function triggerSelf(origin, jobId, workerToken) {
  if (!origin) {
    return { ok: false, error: 'No origin available for self-trigger' };
  }
  const url = `${origin}/api/admin/form-submission-export-jobs/process?jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(workerToken)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(url, { method: 'POST', signal: controller.signal });
    return { ok: true };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: true };
    console.warn('[form-submission-export-jobs/process] triggerSelf error:', err?.message);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

// --- Phase implementations ------------------------------------------------

async function runLoadingPhase(jobId, job) {
  await updateJob(jobId, {
    status: 'processing',
    phase: 'loading',
    started_at: job.started_at || new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    error_message: null,
  });

  const tenantId = job.tenant_id;
  const submissionIds = Array.isArray(job.submission_ids) ? job.submission_ids.map(String) : [];
  const selectedOptions = Array.isArray(job.selected_options) ? job.selected_options : [];
  const scope = job.scope || 'all';

  const { data: tenantRow } = await supabase
    .from('tenant')
    .select('name, logo_url')
    .eq('id', tenantId)
    .single();
  const tenantName = tenantRow?.name || '';
  const tenantLogoUrl = tenantRow?.logo_url || '';

  const submissionRows = await fetchByIds(
    'form_submission',
    submissionIds,
    'id, form_id, form_name, submitted_by_name, submitted_by_email, submission_data, created_date, status, tenant_id'
  );
  const tenantSubmissions = submissionRows.filter(s => s.tenant_id === tenantId);

  const formIds = Array.from(new Set(tenantSubmissions.map(s => s.form_id).filter(Boolean)));
  const formRows = await fetchByIds(
    'form',
    formIds,
    'id, name, fields, application_level, tenant_id'
  );
  const formsById = {};
  formRows
    .filter(f => f.tenant_id === tenantId)
    .forEach(f => { formsById[f.id] = f; });

  let submissions = tenantSubmissions;
  if (scope === 'team' || scope === 'individual') {
    const wantTeam = scope === 'team';
    submissions = submissions.filter(s => {
      const t = resolveAwardType(s, formsById[s.form_id]);
      return wantTeam ? t === 'team' : t === 'individual';
    });
  }

  if (submissions.length === 0) {
    throw new Error('No submissions match the requested scope');
  }

  // Lookups
  const referencedFieldTypes = new Set();
  const referencedCustomFieldIds = new Set();
  for (const form of Object.values(formsById)) {
    for (const f of form.fields || []) {
      if (f?.type) referencedFieldTypes.add(f.type);
      if (f?.type === 'custom_field' && f.custom_field_id) {
        referencedCustomFieldIds.add(f.custom_field_id);
      }
    }
  }

  const lookups = await Promise.all([
    referencedFieldTypes.has('organisation_dropdown')
      ? supabase.from('organisation').select('id, name').eq('tenant_id', tenantId)
      : Promise.resolve({ data: [] }),
    referencedFieldTypes.has('member_dropdown')
      ? supabase.from('member').select('id, first_name, last_name, full_name, email').eq('tenant_id', tenantId)
      : Promise.resolve({ data: [] }),
    referencedFieldTypes.has('role_dropdown')
      ? supabase.from('role').select('id, name, label').eq('tenant_id', tenantId)
      : Promise.resolve({ data: [] }),
    (referencedFieldTypes.has('category_dropdown') || referencedFieldTypes.has('category_multiselect'))
      ? supabase.from('resource_category').select('id, name').eq('tenant_id', tenantId)
      : Promise.resolve({ data: [] }),
    referencedFieldTypes.has('communication_preferences')
      ? supabase.from('communication_category').select('id, name').eq('tenant_id', tenantId)
      : Promise.resolve({ data: [] }),
    referencedCustomFieldIds.size > 0
      ? supabase.from('preference_field').select('id, options').in('id', Array.from(referencedCustomFieldIds))
      : Promise.resolve({ data: [] }),
  ]);

  const [orgs, members, roles, resourceCats, commCats, prefFields] = lookups.map(r => r.data || []);

  const organisationNamesById = {};
  orgs.forEach(o => { if (o?.id) organisationNamesById[o.id] = o.name || ''; });
  const memberNamesById = {};
  members.forEach(m => {
    if (!m?.id) return;
    const name = (m.full_name || `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email || '').trim();
    memberNamesById[m.id] = name;
  });
  const roleNamesById = {};
  roles.forEach(r => { if (r?.id) roleNamesById[r.id] = r.name || r.label || ''; });
  const resourceCategoryNamesById = {};
  resourceCats.forEach(c => { if (c?.id) resourceCategoryNamesById[c.id] = c.name || ''; });
  const communicationCategoryNamesById = {};
  commCats.forEach(c => { if (c?.id) communicationCategoryNamesById[c.id] = c.name || ''; });
  const customFieldDefById = {};
  prefFields.forEach(p => { if (p?.id) customFieldDefById[p.id] = p; });

  const subById = new Map(submissions.map(s => [String(s.id), s]));
  const orderedSubmissions = submissionIds
    .map(id => subById.get(String(id)))
    .filter(Boolean);

  const snapshot = {
    tenantName,
    tenantLogoUrl,
    selectedOptions,
    submissions: orderedSubmissions,
    formsById,
    lookups: {
      organisationNamesById,
      memberNamesById,
      roleNamesById,
      resourceCategoryNamesById,
      communicationCategoryNamesById,
      customFieldDefById,
    },
  };

  await updateJob(jobId, {
    tenant_snapshot: snapshot,
    phase: 'rendering',
    processed: 0,
    total: orderedSubmissions.length,
    prepared_sections: [],
    heartbeat_at: new Date().toISOString(),
  });
}

async function runRenderingPhase(jobId, job, origin) {
  const snapshot = job.tenant_snapshot;
  if (!snapshot) throw new Error('Missing tenant snapshot for rendering phase');

  const submissions = Array.isArray(snapshot.submissions) ? snapshot.submissions : [];
  const formsById = snapshot.formsById || {};
  const selectedOptions = Array.isArray(snapshot.selectedOptions) ? snapshot.selectedOptions : [];
  const lookups = snapshot.lookups || {};
  const resolvers = buildServerResolvers({ ...lookups, formsById }, origin);

  const existing = Array.isArray(job.prepared_sections) ? job.prepared_sections : [];
  const cursor = Number.isFinite(job.processed) ? job.processed : existing.length;
  const total = submissions.length;

  await updateJob(jobId, {
    phase: 'rendering',
    heartbeat_at: new Date().toISOString(),
  });

  const newSections = [];
  const startedAt = Date.now();
  let i = cursor;
  while (i < total) {
    const submission = submissions[i];
    const form = formsById[submission.form_id] || null;
    const prepared = resolveSubmissionToPrepared({
      submission,
      form,
      selectedOptions,
      resolvers,
    });
    newSections.push(prepared);
    i += 1;

    const elapsed = Date.now() - startedAt;
    const inThisInvocation = i - cursor;
    if (elapsed >= RENDER_TIME_BUDGET_MS || inThisInvocation >= RENDER_MAX_PER_INVOCATION) {
      // Checkpoint: persist the new sections appended to what's already on the row.
      // We read+write to avoid clobbering concurrent updates.
      const combined = existing.concat(newSections);
      await updateJob(jobId, {
        prepared_sections: combined,
        processed: i,
        heartbeat_at: new Date().toISOString(),
      });
      // Update local view so a subsequent loop within this invocation (we won't,
      // but defensive) would have the latest.
      // Hand off to next invocation.
      if (i < total) {
        const trig = await triggerSelf(origin, jobId, job.worker_token);
        if (!trig.ok) {
          console.warn('[form-submission-export-jobs/process] self-trigger failed; cron backstop will resume.');
        }
        return { handedOff: true };
      }
      // If we hit the budget exactly at i === total, fall through to flush below.
      break;
    }
  }

  // Final flush for any sections from this invocation.
  const combined = existing.concat(newSections);
  await updateJob(jobId, {
    prepared_sections: combined,
    processed: i,
    phase: i >= total ? 'packaging' : 'rendering',
    heartbeat_at: new Date().toISOString(),
  });

  if (i < total) {
    const trig = await triggerSelf(origin, jobId, job.worker_token);
    if (!trig.ok) {
      console.warn('[form-submission-export-jobs/process] self-trigger failed; cron backstop will resume.');
    }
    return { handedOff: true };
  }

  return { handedOff: false };
}

async function runPackagingPhase(jobId, job, origin) {
  const snapshot = job.tenant_snapshot || {};
  const prepared = Array.isArray(job.prepared_sections) ? job.prepared_sections : [];
  if (!prepared.length) throw new Error('No prepared sections to package');

  await updateJob(jobId, {
    phase: 'packaging',
    heartbeat_at: new Date().toISOString(),
  });

  const safeLogoUrl = isSafePublicLogoUrl(snapshot.tenantLogoUrl) ? snapshot.tenantLogoUrl : '';
  const tenantLogo = safeLogoUrl ? await loadTenantLogo(safeLogoUrl) : null;

  const body = [];
  body.push(...buildTitleBlock({
    tenantName: snapshot.tenantName || '',
    tenantLogo,
    documentTitle: job.document_title || 'Form Submissions',
  }));

  for (let idx = 0; idx < prepared.length; idx++) {
    body.push(...renderPreparedSection(prepared[idx], idx === prepared.length - 1));
  }

  const doc = new Document({
    creator: 'iConnect',
    title: job.document_title || 'Form Submissions',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{
      properties: {},
      footers: { default: buildFooter() },
      children: body,
    }],
  });

  const buffer = await Packer.toBuffer(doc);

  await updateJob(jobId, {
    phase: 'uploading',
    heartbeat_at: new Date().toISOString(),
  });

  const safeName = sanitizeFileName(
    (job.file_name || 'Form_Submissions').replace(/\.docx$/i, '')
  ) + '.docx';
  const storagePath = `${job.tenant_id}/form-submission-exports/${jobId}/${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    });
  if (uploadError) {
    throw new Error(`Failed to upload export: ${uploadError.message}`);
  }

  // Clear snapshot/prepared_sections from row now that the docx is uploaded —
  // keeps the row small and avoids leaving large blobs in the DB.
  await updateJob(jobId, {
    status: 'complete',
    phase: 'complete',
    file_name: safeName,
    storage_bucket: STORAGE_BUCKET,
    storage_path: storagePath,
    file_size_bytes: buffer.length,
    completed_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    tenant_snapshot: null,
    prepared_sections: [],
    error_message: null,
  });
}

// --- Handler -------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const jobId = req.query?.jobId || req.body?.jobId;
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  const { data: job, error } = await supabase
    .from('form_submission_export_job')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Job not found' });

  if (!isAuthorized(req, job)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (job.status === 'complete') {
    return res.status(200).json({ ok: true, alreadyComplete: true });
  }
  if (job.status === 'error') {
    return res.status(200).json({ ok: true, errored: true });
  }

  // Stale-detection: only one worker should run per job at a time. If another
  // invocation has touched the row within the last 90s, defer to it. A cron
  // backstop will revive truly stuck jobs (heartbeat older than 5 min).
  const STALE_AFTER_MS = 90 * 1000;
  const lastHeartbeat = job.heartbeat_at ? new Date(job.heartbeat_at).getTime() : 0;
  const isFresh = lastHeartbeat && (Date.now() - lastHeartbeat < STALE_AFTER_MS);
  const isMidPhase = job.status === 'processing' && (job.phase === 'rendering' || job.phase === 'loading' || job.phase === 'packaging' || job.phase === 'uploading');
  if (isMidPhase && isFresh) {
    return res.status(200).json({ ok: true, alreadyRunning: true });
  }

  const origin = getOrigin(req);

  try {
    // Phase router. Each invocation runs exactly one phase-step, then either
    // returns (terminal) or hands off via triggerSelf for the next chunk.
    if (job.status === 'queued' || (job.status === 'processing' && (!job.phase || job.phase === 'queued'))) {
      await runLoadingPhase(job.id, job);
      // Re-read job and immediately kick rendering so the user sees progress
      // without waiting for cron tick.
      const { data: refreshed } = await supabase
        .from('form_submission_export_job')
        .select('*')
        .eq('id', job.id)
        .single();
      const trig = await triggerSelf(origin, job.id, refreshed?.worker_token || job.worker_token);
      if (!trig.ok) {
        console.warn('[form-submission-export-jobs/process] post-loading self-trigger failed; cron backstop will resume.');
      }
      return res.status(200).json({ ok: true, phase: 'loading-done' });
    }

    if (job.phase === 'rendering' || job.phase === 'loading') {
      const result = await runRenderingPhase(job.id, job, origin);
      if (result.handedOff) {
        return res.status(200).json({ ok: true, phase: 'rendering', handedOff: true });
      }
      // Rendering completed in this invocation; trigger packaging in a fresh
      // invocation so we don't double-spend time budget.
      const trig = await triggerSelf(origin, job.id, job.worker_token);
      if (!trig.ok) {
        console.warn('[form-submission-export-jobs/process] post-rendering self-trigger failed; cron backstop will resume.');
      }
      return res.status(200).json({ ok: true, phase: 'rendering-done' });
    }

    if (job.phase === 'packaging' || job.phase === 'uploading') {
      await runPackagingPhase(job.id, job, origin);
      return res.status(200).json({ ok: true, phase: 'complete' });
    }

    return res.status(200).json({ ok: true, phase: job.phase, status: job.status });
  } catch (err) {
    console.error('[form-submission-export-jobs/process] job failed:', err);
    await failJob(job.id, err?.message || err);
    return res.status(500).json({ error: 'Job failed', details: err?.message });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
  maxDuration: 300,
};
