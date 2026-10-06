import { certificateFingerprint, realCertificatePlaceholders } from './attendeeCpdCertificate.js';
import { createHash } from 'node:crypto';
import { inspectPdf, renderCpdCertificatePdf } from './cpdCertificatePdf.js';
import { hasHistoricCertificateFields } from '../../shared/historicCpdCertificateContract.js';

const unavailable = () => ({ available: false, reason: 'Historic certificate unavailable. Please contact your administrator.' });
export async function resolveHistoricCertificate(db, { tenantId, memberCertificateId, row }) {
  const get = async (table, column, value) => {
    const result = await db.from(table).select('*').eq('tenant_id', tenantId).eq(column, value).maybeSingle();
    if (result.error) throw result.error;
    return result.data;
  };
  const designation = await get('historic_cpd_certificate', 'tenant_id', tenantId);
  if (!designation) return unavailable();
  const template = await get('cpd_certificate_template', 'id', designation.template_id);
  if (!template || template.status !== 'active' || template.source_bucket !== 'private-uploads'
    || !template.source_path?.startsWith(`${tenantId}/`) || !/^[a-f0-9]{64}$/.test(template.source_sha256 || '')) return unavailable();
  const member = await get('member', 'id', memberCertificateId);
  if (!member) return unavailable();
  const result = await db.from('cpd_certificate_placeholder').select('*')
    .eq('tenant_id', tenantId).eq('template_id', template.id).order('page_number').order('display_order').order('id');
  if (result.error) throw result.error;
  if (!hasHistoricCertificateFields(result.data)) return unavailable();
  const name = [member.first_name, member.last_name].filter(Boolean).join(' ').trim();
  const date = row.activity_date && !Number.isNaN(Date.parse(row.activity_date)) ? row.activity_date : null;
  const values = {
    'member.full_name': name, 'member.first_name': member.first_name, 'member.last_name': member.last_name,
    'member.email': member.email, 'member.membership_number': member.membership_number || member.member_number,
    historic_event_title: row.activity_title, 'cpd.activity_title': row.activity_title,
    'cpd.activity_date': date, 'cpd.activity_start_date': date,
    'cpd.activity_date_range': date ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(date)) : null,
    'cpd.cpd_points': row.points_value,
  };
  const real = realCertificatePlaceholders(result.data, values);
  if (!name || !row.activity_title?.trim() || real.missing.length) return unavailable();
  const source = await db.storage.from('private-uploads').download(template.source_path);
  if (source.error || !source.data) throw new Error('Private source temporarily unavailable');
  const bytes = Buffer.from(await source.data.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== template.source_sha256) return unavailable();
  try {
    await inspectPdf(bytes);
    // Validate real typography and source geometry, not illustrative samples.
    await renderCpdCertificatePdf(bytes, real.placeholders, values);
  } catch { return unavailable(); }
  return { available: true, template, placeholders: real.placeholders, values,
    fingerprint: certificateFingerprint({ designation, template, placeholders: real.placeholders, values, awardId: row.id }) };
}
