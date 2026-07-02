import { getSessionMember } from '../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const MAX_SUBMISSIONS = 5000;

function getOrigin(req) {
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const headerOrigin = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : '';
  return (process.env.VITE_APP_URL || headerOrigin || '').replace(/\/+$/, '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const sessionMember = await getSessionMember(req);
  if (!sessionMember) return res.status(401).json({ error: 'Not authenticated' });

  const tenantId = sessionMember.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });

  const roleId = sessionMember.role_id;
  if (roleId) {
    const { data: role } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', roleId)
      .single();
    const excluded = role?.excluded_features || [];
    if (excluded.includes('page_FormSubmissions') || excluded.includes('page_FormManagement')) {
      return res.status(403).json({ error: 'Access denied - insufficient permissions' });
    }
  }

  const { submissionIds, selectedOptions, scope, documentTitle, fileName } = req.body || {};
  if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
    return res.status(400).json({ error: 'submissionIds is required' });
  }
  if (submissionIds.length > MAX_SUBMISSIONS) {
    return res.status(400).json({ error: `Too many submissions (max ${MAX_SUBMISSIONS})` });
  }
  if (!Array.isArray(selectedOptions) || selectedOptions.length === 0) {
    return res.status(400).json({ error: 'selectedOptions is required' });
  }

  const safeIds = submissionIds.map(String);

  const { data: inserted, error: insertError } = await supabase
    .from('form_submission_export_job')
    .insert({
      tenant_id: tenantId,
      requested_by_member_id: sessionMember.id || null,
      status: 'queued',
      phase: 'queued',
      processed: 0,
      total: safeIds.length,
      submission_ids: safeIds,
      selected_options: selectedOptions,
      scope: scope || 'all',
      document_title: documentTitle || 'Form Submissions',
      file_name: (fileName || 'Form_Submissions.docx').replace(/[\r\n]/g, ''),
    })
    .select('id, worker_token, status, phase, processed, total, created_at')
    .single();

  if (insertError || !inserted) {
    console.error('[form-submission-export-jobs] insert error:', insertError);
    return res.status(500).json({ error: 'Failed to create export job' });
  }

  // Deterministic dispatch: send the worker trigger but abort the caller's
  // wait after a short window so we don't pay for the full worker runtime.
  // The downstream Vercel invocation runs to completion regardless of our
  // signal. If dispatch still fails outright (network refused, etc.) the
  // cron backstop will pick up the job on its next tick.
  try {
    const origin = getOrigin(req);
    if (origin) {
      const url = `${origin}/api/admin/form-submission-export-jobs/process?jobId=${encodeURIComponent(inserted.id)}&token=${encodeURIComponent(inserted.worker_token)}`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.warn('[form-submission-export-jobs] worker trigger failed:', err?.message);
        }
      } finally {
        clearTimeout(t);
      }
    }
  } catch (err) {
    console.warn('[form-submission-export-jobs] could not trigger worker:', err?.message);
  }

  return res.status(202).json({
    jobId: inserted.id,
    status: inserted.status,
    phase: inserted.phase,
    processed: inserted.processed,
    total: inserted.total,
  });
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '5mb' },
  },
};
