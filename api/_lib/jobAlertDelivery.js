import { jobAlertSettings, jobBoardEligible, jobStillOpen, jobAlertContent } from './jobAlerts.js';
import { isActiveCommunicationMember } from '../../shared/communicationCategoryMembership.js';
import { getTenantTrustedBaseUrl } from './publicBaseUrl.js';

async function read(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Re-read at delivery time: opt-outs, tenant disablement, removed roles and closed
// vacancies must suppress an already queued notification.
export async function resolveJobAlert(db, delivery, req) {
  const settings = await jobAlertSettings(db, delivery.tenant_id);
  if (!settings.enabled || settings.category_id !== delivery.category_id) return null;
  const [member, job, preference, tenant] = await Promise.all([
    read(db.from('member').select('*').eq('tenant_id', delivery.tenant_id).eq('id', delivery.member_id).maybeSingle()),
    read(db.from('job_posting').select('id,title,company_name,location,status,closing_date,expiry_date')
      .eq('tenant_id', delivery.tenant_id).eq('id', delivery.job_id).maybeSingle()),
    read(db.from('member_communication_preference').select('is_subscribed').eq('tenant_id', delivery.tenant_id)
      .eq('member_id', delivery.member_id).eq('category_id', delivery.category_id).maybeSingle()),
    read(db.from('tenant').select('id,slug,domain').eq('id', delivery.tenant_id).maybeSingle()),
  ]);
  if (!isActiveCommunicationMember(member) || member.communications_opted_out_all === true
      || !preference?.is_subscribed || !jobStillOpen(job) || !tenant || !await jobBoardEligible(db, member)) return null;
  const email = member.email.trim().toLowerCase();
  const pattern = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [unsubscribes, bounces] = await Promise.all([
    read(db.from('email_unsubscribe').select('unsubscribe_type,communication_category_id')
      .eq('tenant_id', delivery.tenant_id).filter('email', 'imatch', `^${pattern}$`).limit(1000)),
    read(db.from('email_address_bounce').select('id').eq('tenant_id', delivery.tenant_id)
      .eq('email', email).is('resolved_at', null).limit(1)),
  ]);
  if (unsubscribes.length >= 1000) throw new Error('Incomplete suppression result');
  if (bounces.length || unsubscribes.some(row => row.unsubscribe_type === 'all' ||
      (row.unsubscribe_type === 'category' && row.communication_category_id === delivery.category_id))) return null;
  const url = `${getTenantTrustedBaseUrl(req, tenant)}/JobDetails?id=${encodeURIComponent(job.id)}&jobAlert=1`;
  return { email, ...jobAlertContent(job, url) };
}

export async function processJobAlert(db, delivery, { send, req, deadlineAt, resolve = resolveJobAlert }) {
  const update = async (values, status) => read(db.from('job_alert_delivery').update(values)
    .eq('id', delivery.id).eq('lease_id', delivery.lease_id).eq('status', status).select('id'));
  let sending = false;
  try {
    const content = await resolve(db, delivery, req);
    if (!content) {
      await update({ status: 'skipped', last_error: 'No longer eligible for job alerts' }, 'claimed');
      return 'skipped';
    }
    const claimed = await update({ status: 'sending', lease_until: new Date(Date.now() + 180000).toISOString() }, 'claimed');
    if (!claimed.length) return 'lost_lease';
    sending = true;
    const result = await send({
      tenantId: delivery.tenant_id, to: content.email, subject: content.subject, html: content.html,
      includeRenderedContent: true, confidentialDiagnostics: true, campaignDeadlineAt: deadlineAt,
      // Inbox is finalized atomically with the durable provider receipt below.
    });
    if (result.success) {
      const args = { p_id: delivery.id, p_lease: delivery.lease_id, p_message_id: result.messageId,
        p_email: content.email, p_subject: result.renderedSubject || content.subject, p_html: result.renderedHtml || content.html };
      // A failed response can be an already-committed transaction. Idempotent
      // finalization is safe to retry; provider submission is not.
      let error;
      for (let attempt = 0; attempt < 3; attempt++) {
        ({ error } = await db.rpc('finish_job_alert_delivery', args));
        if (!error) return 'sent';
      }
      throw error;
    }
    const transient = result.notSubmitted || result.rateLimited || [408,425,429,500,502,503,504].includes(Number(result.status));
    const attempts = delivery.attempts + (transient ? 0 : 1);
    const status = result.ambiguousEffect ? 'uncertain' : (attempts >= 5 ? 'failed' : 'pending');
    await update({ status, attempts, available_at: new Date(Date.now() + 300000).toISOString(),
      last_error: result.ambiguousEffect ? 'Provider outcome uncertain; evidence review required' : 'Provider did not accept notification' }, 'sending');
    return status;
  } catch (error) {
    await update({ status: sending ? 'uncertain' : 'pending',
      available_at: new Date(Date.now() + 300000).toISOString(),
      last_error: sending ? 'Delivery outcome needs provider evidence review' : 'Eligibility temporarily unavailable' },
    sending ? 'sending' : 'claimed');
    return sending ? 'uncertain' : 'pending';
  }
}
