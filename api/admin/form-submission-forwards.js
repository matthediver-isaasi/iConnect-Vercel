import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { authorizeFormSubmissionDelete } from '../_lib/formSubmissionDeleteAccess.js';
import { createFormAlertToken, projectFormAlertCapability } from '../_lib/formAlertCapabilities.js';
import { sendEmail } from '../_lib/emailService.js';
import { getTenantTrustedBaseUrl } from '../_lib/publicBaseUrl.js';
import {
  FORWARD_DAYS, FORWARD_PUBLIC_FIELDS, forwardUuid as uuid, forwardError as problem,
  sanitizeForwardMessage, escapeForwardHtml as escape, forwardDeliveryStatus,
} from '../_lib/formSubmissionForwards.js';

const publicRow = row => Object.fromEntries(FORWARD_PUBLIC_FIELDS.split(',').map(key => [key, row[key] ?? null]));
async function single(db, table, tenantId, id, select = '*') {
  const { data, error } = await db.from(table).select(select).eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export default async function handler(req, res, overrides = {}) {
  const deps = { db: supabase, getTenantContext, authorize: authorizeFormSubmissionDelete,
    sendEmail, project: projectFormAlertCapability, ...overrides };
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    if (!['GET','POST'].includes(req.method)) throw problem('Method not allowed',405);
    const context = await deps.getTenantContext(req);
    if (!context?.isAuthenticated || !context.tenantId || context.tenantMismatch) throw problem('Authentication required',401);
    const denied = await deps.authorize(deps.db, context);
    if (denied) throw problem(denied.error, denied.status);
    const { db } = deps, tenantId = context.tenantId, body = req.body || {}, query = req.query || {};
    const actor = context.tenantUserId ? `tenant_user:${context.tenantUserId}` : `member:${context.memberId}`;
    if (req.method === 'GET' && query.submission_ids) {
      const ids = [...new Set(String(query.submission_ids).split(','))];
      if (!ids.length || ids.length > 100 || !ids.every(uuid)) throw problem('Select up to 100 submissions.');
      // Range-page to avoid PostgREST's default cap silently omitting history.
      const forwards = [];
      for (let offset=0; ; offset+=500) {
        const r = await db.from('form_submission_forward').select(FORWARD_PUBLIC_FIELDS).eq('tenant_id',tenantId)
          .in('submission_id',ids).order('created_at',{ascending:false}).order('id').range(offset,offset+499);
        if (r.error) throw r.error;
        forwards.push(...r.data);
        if (r.data.length < 500) break;
        if (offset >= 9500) throw problem('Too much forwarding history. Open a single submission.',409);
      }
      return res.json({ forwards });
    }
    const submissionId = req.method === 'GET' ? query.submission_id : body.submission_id;
    if (!uuid(submissionId)) throw problem('A submission is required.');
    const submission = await single(db,'form_submission',tenantId,submissionId,'id,form_id');
    if (!submission) throw problem('Submission unavailable',404);
    if (req.method === 'GET') {
      if (query.action === 'members') {
        const search = String(query.q || '').trim();
        if (search.length < 2) return res.json({members:[]});
        if (search.length > 100 || /[(),*%\\]/.test(search)) throw problem('Use a name or email to search.');
        const r = await db.from('member').select('id,first_name,last_name,email').eq('tenant_id',tenantId)
          .eq('status','active').not('email','is',null)
          .or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`)
          .order('last_name').order('id').limit(30);
        if (r.error) throw r.error;
        return res.json({members:r.data.filter(m => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(m.email))});
      }
      const r = await db.from('form_submission_forward').select(FORWARD_PUBLIC_FIELDS).eq('tenant_id',tenantId)
        .eq('submission_id',submissionId).order('created_at',{ascending:false}).order('id').limit(501);
      if (r.error) throw r.error;
      if (r.data.length > 500) throw problem('Too much forwarding history to display.',409);
      return res.json({forwards:r.data,can_forward:true});
    }
    if (body.action === 'revoke') {
      if (!uuid(body.forward_id)) throw problem('Select a forwarded link.');
      const r = await db.from('form_submission_forward')
        .update({revoked_at:new Date().toISOString(),revoked_by:actor,token_hash:null})
        .eq('tenant_id',tenantId).eq('submission_id',submissionId).eq('id',body.forward_id)
        .select(FORWARD_PUBLIC_FIELDS).maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) throw problem('Forwarded link unavailable',404);
      return res.json({forward:r.data});
    }
    if (body.action && body.action !== 'send') throw problem('Invalid action.');
    if (!uuid(body.member_id) || !uuid(body.idempotency_key)) throw problem('Select a member and provide a request key.');
    const message = sanitizeForwardMessage(body.message_html);
    const prior = await db.from('form_submission_forward').select('*').eq('tenant_id',tenantId)
      .eq('idempotency_key',body.idempotency_key).maybeSingle();
    if (prior.error) throw prior.error;
    if (prior.data) {
      if (prior.data.submission_id !== submissionId || prior.data.member_id !== body.member_id
        || prior.data.actor !== actor || prior.data.message_html !== message) throw problem('This request key has already been used.',409);
      if (prior.data.status !== 'failed' || prior.data.revoked_at) return res.json({forward:publicRow(prior.data)});
      if (Date.parse(prior.data.expires_at) <= Date.now()) throw problem('This forwarding request has expired.',409);
    }
    const member = await single(db,'member',tenantId,body.member_id,'id,first_name,last_name,email,status');
    if (!member || member.status !== 'active' || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(member.email || '')) {
      throw problem('Select an active member in this tenant with a valid email address.');
    }
    if (prior.data && prior.data.recipient_email !== member.email) {
      throw problem('The recipient email has changed. The original request cannot be retried.',409);
    }
    const form = await single(db,'form',tenantId,submission.form_id,'id,name,fields,form_type');
    if (!form) throw problem('Form unavailable',404);
    const snapshot = await db.from('form_alert_submission_snapshot').select('form_snapshot')
      .eq('tenant_id',tenantId).eq('form_id',form.id).eq('submission_id',submissionId).maybeSingle();
    if (snapshot.error) throw snapshot.error;
    const formSnapshot = prior.data?.form_snapshot || snapshot.data?.form_snapshot || {name:form.name,fields:form.fields,form_type:form.form_type};
    // Check anonymous/published-version policy BEFORE creating an email, and
    // repeat the same policy at every public read. Never email raw answers.
    const projection = await deps.project(db,tenantId,{form_id:form.id,submission_id:submissionId,form_snapshot:formSnapshot});
    if (!projection) throw problem('This submission cannot be shared under its current privacy settings.',409);
    const tenant = await singleTenant(db,tenantId);
    const {token,hash} = createFormAlertToken();
    const url = new URL('/api/public/form-submission-forward-view',getTenantTrustedBaseUrl(null,tenant));
    url.hash = token;
    const name = prior.data?.recipient_name || [member.first_name,member.last_name].filter(Boolean).join(' ').trim() || member.email;
    const insert = prior.data
      ? await db.from('form_submission_forward').update({status:'sending',token_hash:hash})
        .eq('tenant_id',tenantId).eq('id',prior.data.id).eq('status','failed').is('revoked_at',null).select('*').maybeSingle()
      : await db.from('form_submission_forward').insert({
      tenant_id:tenantId,form_id:form.id,submission_id:submissionId,member_id:member.id,
      recipient_name:name,recipient_email:member.email,actor,idempotency_key:body.idempotency_key,
      message_html:message,form_snapshot:formSnapshot,status:'sending',token_hash:hash,
      expires_at:new Date(Date.now()+FORWARD_DAYS*86400000).toISOString(),
    }).select('*').single();
    if (insert.error?.code === '23505') throw problem('This send is already being processed. Retry to check its status.',409);
    if (insert.error) throw insert.error;
    if (!insert.data) throw problem('This send is already being processed or was revoked. Check its status.',409);
    let result;
    try {
      result = await deps.sendEmail({
        tenantId,to:member.email,subject:`Forwarded form submission – ${String(formSnapshot.name || 'Form').replace(/[\r\n]/g,' ')}`,
        html:`<p>Hello ${escape(name)},</p><p>A form submission has been shared with you.</p>${message}<p><a href="${escape(url.href)}">View submission</a></p><p>This confidential, read-only link expires in ${FORWARD_DAYS} days. You do not need to sign in. Anyone with the link can view the submission; please do not share it.</p>`,
        disableTracking:true,skipFooter:true,resolveTransactionalPreferences:false,confidentialDiagnostics:true,
        campaignDeadlineAt:Date.now()+20000,
      });
    } catch { result = null; }
    const status = forwardDeliveryStatus(result);
    const finish = await db.from('form_submission_forward').update({
      status,sent_at:status==='sent'?new Date().toISOString():null,
      provider_id:result?.messageId || result?.id || null,
      ...(status==='sent'?{}:{token_hash:null}),
    }).eq('tenant_id',tenantId).eq('id',insert.data.id).eq('status','sending')
      .select(FORWARD_PUBLIC_FIELDS).single();
    if (finish.error) throw problem('Delivery status could not be confirmed. Reopen forwarding history before sending again.',503);
    return res.status(201).json({forward:finish.data});
  } catch (error) {
    return res.status(error.status || 503).json({error:error.status ? error.message : 'Forwarding is unavailable. Retry the same request or contact your administrator.'});
  }
}

async function singleTenant(db,tenantId) {
  const r = await db.from('tenant').select('id,slug,domain').eq('id',tenantId).maybeSingle();
  if (r.error) throw r.error;
  if (!r.data) throw problem('Tenant unavailable',404);
  return r.data;
}
