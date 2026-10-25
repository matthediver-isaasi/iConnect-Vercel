import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { sendEmail } from '../_lib/emailService.js';
import { renderAttendeeCertificate, validCertificateRecipient } from '../_lib/attendeeCpdCertificate.js';
import { uuid, problem, one, validateManualAward, prepareManualCertificate, storeManualCertificate,
  resolveManualCertificate, sanitizeManualMessage } from '../_lib/manualCpdAwards.js';

export function createManualCpdAwardsHandler(overrides = {}) {
  const deps = { db: supabase, getTenantContext, hasAdminAccess, hasFeatureAccess, sendEmail,
    prepareManualCertificate, storeManualCertificate, renderAttendeeCertificate, ...overrides };
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (!['GET','POST'].includes(req.method)) throw problem('Method not allowed',405);
      const context = await deps.getTenantContext(req);
      if (!context?.isAuthenticated || !context.tenantId || context.tenantMismatch) throw problem('Unauthorized',401);
      if (!context.tenantUserId && !(context.roleId && await deps.hasAdminAccess(context)
        && await deps.hasFeatureAccess(context.roleId,'cpd.points-corrections',context.memberExcludedFeatures))) {
        throw problem('CPD points administration permission is required',403);
      }
      const tenantId = context.tenantId, db = deps.db;
      const body = req.body || {};
      const memberId = req.method === 'GET' ? req.query?.member_id : body.member_id;
      if (!uuid(memberId)) throw problem('A valid member is required.');
      const member = await one(db,'member',tenantId,memberId);
      if (!member) throw problem('Member not found',404);
      if (req.method === 'GET') {
        const r = await db.from('cpd_certificate_template').select('id,name').eq('tenant_id',tenantId).eq('status','active').order('name');
        if (r.error) throw r.error;
        return res.json({ templates:r.data, member:{id:memberId,name:[member.first_name,member.last_name].filter(Boolean).join(' '),email:member.email} });
      }
      const actor = context.tenantUserId ? `tenant_user:${context.tenantUserId}` : `member:${context.memberId}`;
      if (body.action === 'preview' || body.action === 'award') {
        const input = validateManualAward(body);
        if (body.action === 'award') {
          if (!uuid(body.idempotency_key)) throw problem('A request key is required.');
          const previous = await db.from('member_cpd_points_ledger').select('*').eq('tenant_id',tenantId)
            .eq('manual_key',body.idempotency_key).maybeSingle();
          if (previous.error) throw previous.error;
          if (previous.data) {
            if (!previous.data.manual_certificate?.input || previous.data.member_id !== memberId
              || previous.data.created_by !== actor || Object.keys(input).some(k => previous.data.manual_certificate.input[k] !== input[k])) {
              throw problem('This request key belongs to a different saved award.',409);
            }
            return res.json({entry:{id:previous.data.id},email_status:'not_sent'});
          }
        }
        const prepared = await deps.prepareManualCertificate(db,tenantId,member,input);
        if (body.action === 'preview') {
          res.setHeader('Content-Type','application/pdf');
          return res.send(prepared.pdf);
        }
        const certificate = await deps.storeManualCertificate(db,tenantId,memberId,prepared,input);
        const result = await db.rpc('record_manual_cpd_award',{p_tenant_id:tenantId,p_member_id:memberId,
          p_key:body.idempotency_key,p_points:input.points_value,p_title:input.activity_title,
          p_date:input.activity_date,p_actor:actor,p_certificate:certificate});
        if (result.error) throw result.error;
        return res.status(201).json({entry:{id:result.data.id},email_status:'not_sent'});
      }
      if (body.action !== 'email' || !uuid(body.ledger_entry_id) || !uuid(body.idempotency_key)) throw problem('Invalid manual CPD action.');
      const row = await one(db,'member_cpd_points_ledger',tenantId,body.ledger_entry_id);
      if (!row || row.member_id !== memberId || row.entry_kind !== 'manual_award') throw problem('Manual award not found',404);
      const resolved = await resolveManualCertificate(db,{tenantId,memberCertificateId:memberId,row});
      if (!resolved.available) throw problem(resolved.reason,409);
      if (!validCertificateRecipient(member.email)) throw problem('The member needs a valid email address.');
      const html = sanitizeManualMessage(body.message_html || '');
      const pdf = await deps.renderAttendeeCertificate(db,resolved);
      const delivery = {tenant_id:tenantId,member_id:memberId,ledger_entry_id:row.id,
        idempotency_key:body.idempotency_key,recipient:member.email,message_html:html,status:'pending'};
      const claim = await db.from('manual_cpd_email_delivery').insert(delivery);
      if (claim.error) {
        if (claim.error.code !== '23505') throw claim.error;
        const existing = await db.from('manual_cpd_email_delivery').select('*').eq('tenant_id',tenantId).eq('ledger_entry_id',row.id).single();
        if (existing.error) throw existing.error;
        if (existing.data.idempotency_key !== body.idempotency_key || existing.data.message_html !== html
          || existing.data.recipient !== member.email) throw problem('An email request already exists for this award. Do not resend until its outcome is confirmed.',409);
        if (existing.data.status !== 'failed') return res.json({status:existing.data.status});
        const retry = await db.from('manual_cpd_email_delivery').update({status:'pending',updated_at:new Date().toISOString()})
          .eq('tenant_id',tenantId).eq('ledger_entry_id',row.id).eq('status','failed').select('ledger_entry_id');
        if (retry.error) throw retry.error;
        if (!retry.data?.length) return res.json({status:'pending'});
      }
      let outcome;
      try {
        const result = await deps.sendEmail({tenantId,to:member.email,subject:'Your CPD certificate',
          html:`<p>Your CPD certificate is attached and is available in your member CPD history.</p>${html}`,
          resolveTransactionalPreferences:true,disableTracking:true,enableTracking:false,
          attachments:[{filename:'cpd-certificate.pdf',data:pdf,contentType:'application/pdf'}]});
        outcome = {status:result.success?'sent':result.ambiguousEffect || !result.status || Number(result.status)>=500?'unknown':'failed',
          provider_message_id:result.success ? result.id || result.messageId || null : null};
      } catch { outcome = {status:'unknown'}; }
      const saved = await db.from('manual_cpd_email_delivery').update({...outcome,updated_at:new Date().toISOString()})
        .eq('tenant_id',tenantId).eq('ledger_entry_id',row.id).eq('status','pending').select('ledger_entry_id');
      if (saved.error || !saved.data?.length) throw problem('The award is saved, but email confirmation could not be recorded. Do not resend.',503);
      return res.json({status:outcome.status});
    } catch (error) {
      return res.status(error.status || (error.code==='23505'?409:error.code==='22023'?400:500))
        .json({error:error.status || ['23505','22023'].includes(error.code) ? error.message : 'Unable to complete the manual CPD request. Retry with the same request.'});
    }
  };
}
export default createManualCpdAwardsHandler();
