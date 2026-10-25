import { createHash, randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { realCertificatePlaceholders, renderAttendeeCertificate } from './attendeeCpdCertificate.js';

export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const problem = (message, status = 400) => Object.assign(new Error(message), { status });
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function one(db, table, tenantId, id) {
  const r = await db.from(table).select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (r.error) throw r.error;
  return r.data;
}
export function validateManualAward(body) {
  if (!uuid(body.template_id) || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(String(body.points_value))
    || !(Number(body.points_value) > 0) || Number(body.points_value) >= 1e14
    || typeof body.activity_title !== 'string' || !body.activity_title.trim()
    || body.activity_title.trim().length > 300
    || !/^\d{4}-\d{2}-\d{2}$/.test(body.activity_date || '')
    || Number.isNaN(Date.parse(body.activity_date))
    || new Date(body.activity_date).toISOString().slice(0,10) !== body.activity_date) {
    throw problem('Select a certificate and enter positive points, an event name and a valid date.');
  }
  return { template_id: body.template_id, points_value: String(body.points_value),
    activity_title: body.activity_title.trim(), activity_date: body.activity_date };
}
export async function prepareManualCertificate(db, tenantId, member, input) {
  const template = await one(db, 'cpd_certificate_template', tenantId, input.template_id);
  if (!template || template.status !== 'active' || template.source_bucket !== 'private-uploads'
    || !template.source_path?.startsWith(`${tenantId}/`)) throw problem('An active tenant certificate is required.');
  const result = await db.from('cpd_certificate_placeholder').select('*').eq('tenant_id', tenantId)
    .eq('template_id', template.id).order('page_number').order('display_order').order('id');
  if (result.error) throw result.error;
  const keys = new Set((result.data || []).map(p => p.placeholder_key));
  if (!keys.has('cpd.cpd_points') || !['cpd.activity_title','historic_event_title','event.name'].some(k => keys.has(k))) {
    throw problem('This certificate must contain CPD points and an event/activity title field.');
  }
  const name = [member.first_name, member.last_name].filter(Boolean).join(' ').trim();
  if (!name) throw problem('Add the member’s name before creating a certificate.');
  const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(input.activity_date));
  const values = {
    'member.full_name': name, 'member.first_name': member.first_name, 'member.last_name': member.last_name,
    'member.email': member.email, 'member.membership_number': member.membership_number || member.member_number,
    'attendee.full_name': name, 'attendee.first_name': member.first_name, 'attendee.last_name': member.last_name,
    'attendee.email': member.email,
    'cpd.activity_title': input.activity_title, historic_event_title: input.activity_title, 'event.name': input.activity_title,
    'cpd.cpd_points': input.points_value, 'cpd.activity_date': date, 'cpd.activity_date_range': date,
    'cpd.activity_start_date': input.activity_date, 'cpd.activity_end_date': input.activity_date,
    'event.start_date': input.activity_date, 'event.end_date': input.activity_date,
  };
  const real = realCertificatePlaceholders(result.data, values);
  if (real.missing.length) throw problem(`The certificate requires information not supplied by a manual award: ${real.missing.join(', ')}`);
  const pdf = await renderAttendeeCertificate(db, { template, placeholders: real.placeholders, values });
  return { pdf, template, values };
}
export async function resolveManualCertificate(db, { tenantId, memberCertificateId, row }) {
  const certificate = row.manual_certificate;
  if (row.entry_kind !== 'manual_award' || row.member_id !== memberCertificateId
    || !certificate?.path?.startsWith(`${tenantId}/manual-cpd/${memberCertificateId}/`)
    || !/^[a-f0-9]{64}$/.test(certificate.sha256 || '')) {
    return { available: false, reason: 'Manual certificate unavailable.' };
  }
  return { available: true, fingerprint: certificate.sha256,
    template: { source_path: certificate.path, source_sha256: certificate.sha256 },
    placeholders: [], values: {} };
}
export async function storeManualCertificate(db, tenantId, memberId, prepared, input) {
  const path = `${tenantId}/manual-cpd/${memberId}/${randomUUID()}.pdf`;
  const result = await db.storage.from('private-uploads').upload(path, prepared.pdf, { contentType: 'application/pdf', upsert: false });
  if (result.error) throw result.error;
  return { path, sha256: digest(prepared.pdf), template_id: input.template_id,
    template_name: prepared.template.name, input, values: prepared.values };
}
export function sanitizeManualMessage(html) {
  if (typeof html !== 'string' || html.length > 50000) throw problem('The email message is too long.');
  const window = new JSDOM('').window;
  try {
    return createDOMPurify(window).sanitize(html, {
      ALLOWED_TAGS: ['p','br','strong','em','u','s','ul','ol','li','blockquote','a','h2','h3'],
      ALLOWED_ATTR: ['href','title'], ALLOW_DATA_ATTR: false,
    });
  } finally { window.close(); }
}
