// Task #944: Email the public form submitter a Word (DOCX) copy of their
// own submission. Invoked from api/public/form-submission.js when the form
// has `allow_submitter_email_copy` enabled AND the submitter ticked the
// "email me a copy" checkbox with a valid email address.
//
// Reuses the same DOCX builder as the admin Form Submissions Word Export
// (api/admin/form-submissions-word-export.js) so the output is identical
// to what an admin would download for that submission. All tenant-scoped
// lookups (members / organisations / roles / categories / custom fields /
// tenant logo) run with the form's own tenant_id, so there is no risk of
// cross-tenant data leakage.
//
// This helper never throws — failures are logged and reported via the
// returned result object. The caller MUST NOT let an email failure block
// the form submission itself (per task spec).
import { createClient } from '@supabase/supabase-js';
import { Packer } from 'docx';
import {
  buildSubmissionsDocument,
  loadTenantLogo,
  sanitizeFileName,
} from '../../client/src/lib/formSubmissionWordExport.js';
import { sendEmail } from '../_lib/emailService.js';
import { buildInboxDelivery } from '../_lib/transactionalInbox.js';
import { loadTenantRelationshipDisplayLabels } from '../_lib/relationshipDisplayLabels.js';
import {
  collectRelationshipRecordIds,
  resolveRelationshipDisplayLabel,
} from '../../client/src/lib/relationshipDisplayLabels.js';
import {
  collectRepeatableRelationshipRecordIds,
  getRepeatableRowChildren,
} from '../../shared/repeatableFormRowsFormat.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Lifted verbatim from api/admin/form-submissions-word-export.js so the
// generated DOCX matches the admin export field-for-field.
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
    formsById,
    organisationNamesById,
    organisationGroupNamesById,
    memberNamesById,
    roleNamesById,
    resourceCategoryNamesById,
    communicationCategoryNamesById,
    customFieldDefById,
    relationshipLabelsByRecordId,
  } = maps;

  const resolveOrgName = (orgId) => {
    if (orgId == null || orgId === '') return '';
    const id = String(orgId);
    return organisationNamesById[id] || id;
  };
  const resolveOrgGroupName = (groupId) => {
    if (groupId == null || groupId === '') return '';
    return organisationGroupNamesById[String(groupId)] || 'Unavailable organisation group';
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
  const resolveRelationshipLabel = (value) =>
    resolveRelationshipDisplayLabel(value, relationshipLabelsByRecordId);
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
    organisationNamesById,
    resolveOrgGroupName,
    resolveMemberName,
    resolveRoleName,
    resolveResourceCategoryLabel,
    resolveCommunicationPreferences,
    resolveImageButtonLabel,
    resolveCustomFieldValue,
    resolveRelationshipLabel,
    resolveFile,
  };
}

// Default selectedOptions for a submitter copy: include the standard
// submission metadata followed by every field on the form (in order),
// using the field label as the column label. This mirrors what an admin
// would pick when exporting "everything" for a single submission.
function buildDefaultSelectedOptions(form) {
  const opts = [
    { key: '__form_name', label: 'Form' },
    { key: '__submission_date', label: 'Submitted' },
    { key: '__submitter_name', label: 'Submitted by' },
    { key: '__submitter_email', label: 'Submitter email' },
  ];
  const skipTypes = new Set([
    'instructions', 'image', 'section_header', 'heading',
    'paragraph', 'divider', 'spacer', 'html',
  ]);
  for (const f of form?.fields || []) {
    if (!f || !f.id) continue;
    if (skipTypes.has(f.type)) continue;
    opts.push({ key: f.id, label: f.label || f.id });
  }
  return opts;
}

/**
 * Generate a single-submission DOCX and email it to the submitter.
 *
 * @param {object} args
 * @param {object} args.form - Form row including id, name, tenant_id, fields
 * @param {object} args.submission - form_submission row that was just inserted
 * @param {string} args.recipientEmail - validated submitter email
 * @param {string} [args.origin] - base URL used for secure file links inside the DOCX
 * @returns {Promise<{success: boolean, error?: string, messageId?: string, skipped?: boolean}>}
 */
export async function sendSubmitterCopyEmail({ form, submission, recipientEmail, origin = '' }) {
  if (!supabase) {
    return { success: false, error: 'Database not configured' };
  }
  if (!form || !submission) {
    return { success: false, error: 'Missing form or submission' };
  }
  if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return { success: false, error: 'Invalid recipient email' };
  }

  const tenantId = form.tenant_id;
  if (!tenantId) {
    return { success: false, error: 'Form is missing tenant_id' };
  }

  // Tenant info for title block + logo + branded From address.
  const { data: tenantRow } = await supabase
    .from('tenant')
    .select('name, logo_url')
    .eq('id', tenantId)
    .single();
  const tenantName = tenantRow?.name || '';
  const tenantLogoUrl = tenantRow?.logo_url || '';

  // Build per-field-type lookup tables, scoped to this tenant only.
  const referencedFieldTypes = new Set();
  const referencedCustomFieldIds = new Set();
  const lookupFields = (form.fields || []).flatMap((field) => [
    field,
    ...getRepeatableRowChildren(field),
  ]);
  for (const f of lookupFields) {
    if (f?.type) referencedFieldTypes.add(f.type);
    if (f?.type === 'custom_field' && f.custom_field_id) {
      referencedCustomFieldIds.add(f.custom_field_id);
    }
  }

  const lookups = await Promise.all([
    referencedFieldTypes.has('organisation_dropdown')
      ? supabase.from('organization').select('id, name').eq('tenant_id', tenantId)
      : Promise.resolve({ data: [] }),
    referencedFieldTypes.has('organisation_group_dropdown')
      ? supabase.from('organization_group').select('id, name').eq('tenant_id', tenantId)
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
    referencedFieldTypes.has('relationship_dropdown')
      ? loadTenantRelationshipDisplayLabels(
        supabase,
        tenantId,
        [
          ...collectRelationshipRecordIds(form.fields || [], submission.submission_data),
          ...collectRepeatableRelationshipRecordIds(form.fields || [], submission.submission_data),
        ],
      ).then(data => ({ data }))
      : Promise.resolve({ data: {} }),
  ]);

  const [orgs, orgGroups, members, roles, resourceCats, commCats, prefFields, relationshipLabelsByRecordId] =
    lookups.map(r => r.data || []);

  const organisationNamesById = {};
  orgs.forEach(o => { if (o?.id) organisationNamesById[o.id] = o.name || ''; });
  const organisationGroupNamesById = {};
  orgGroups.forEach(group => { if (group?.id) organisationGroupNamesById[group.id] = group.name || ''; });
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

  const formsById = { [form.id]: form };
  const resolvers = buildServerResolvers({
    formsById,
    organisationNamesById,
    organisationGroupNamesById,
    memberNamesById,
    roleNamesById,
    resourceCategoryNamesById,
    communicationCategoryNamesById,
    customFieldDefById,
    relationshipLabelsByRecordId,
  }, (origin || '').replace(/\/+$/, ''));

  const safeLogoUrl = isSafePublicLogoUrl(tenantLogoUrl) ? tenantLogoUrl : '';
  const tenantLogo = safeLogoUrl ? await loadTenantLogo(safeLogoUrl) : null;

  const selectedOptions = buildDefaultSelectedOptions(form);
  const documentTitle = `Your submission to ${form.name || 'this form'}`;

  const doc = buildSubmissionsDocument({
    submissions: [submission],
    formsById,
    selectedOptions,
    resolvers,
    tenantName,
    tenantLogo,
    documentTitle,
  });

  const buffer = await Packer.toBuffer(doc);

  const baseName = sanitizeFileName(
    `Submission-${form.name || 'form'}`
  ).replace(/\.docx$/i, '');
  const fileName = `${baseName || 'Submission'}.docx`;

  const subject = `Your submission to ${form.name || 'our form'}`;
  const safeTenantName = tenantName ? ` (${tenantName})` : '';
  const html = `
    <p>Hi,</p>
    <p>Thank you for your submission to <strong>${form.name || 'our form'}</strong>${safeTenantName}. A Word (DOCX) copy of your responses is attached for your records.</p>
    <p>If you didn't request this email, you can safely ignore it.</p>
  `;

  const inboxDelivery = await buildInboxDelivery({
    tenantId,
    email: recipientEmail,
    labelKey: 'forms',
  });

  const emailResult = await sendEmail({
    to: recipientEmail,
    subject,
    html,
    tenantId,
    inboxDelivery,
    attachments: [{
      filename: fileName,
      data: buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }],
  });

  return emailResult;
}

export default async function handler(req, res) {
  // This module is primarily used as a helper imported by
  // api/public/form-submission.js, but is exposed as an HTTP endpoint too
  // so it can be re-used by internal callers in the future. It deliberately
  // requires an internal secret because it sends emails on behalf of the
  // tenant without a logged-in session.
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
  const providedToken = req.body?.internalToken;
  if (!INTERNAL_API_SECRET || providedToken !== INTERNAL_API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { form_id, submission_id, recipient_email, origin } = req.body || {};
    if (!form_id || !submission_id || !recipient_email) {
      return res.status(400).json({ error: 'form_id, submission_id and recipient_email are required' });
    }
    const { data: form } = await supabase
      .from('form')
      .select('id, name, tenant_id, fields, allow_submitter_email_copy')
      .eq('id', form_id)
      .single();
    if (!form) return res.status(404).json({ error: 'Form not found' });
    if (!form.allow_submitter_email_copy) {
      return res.json({ success: true, skipped: true, reason: 'Form does not allow submitter copies' });
    }
    const { data: submission } = await supabase
      .from('form_submission')
      .select('*')
      .eq('id', submission_id)
      .eq('tenant_id', form.tenant_id)
      .single();
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    const result = await sendSubmitterCopyEmail({ form, submission, recipientEmail: recipient_email, origin });
    return res.json(result);
  } catch (error) {
    console.error('[SubmitterCopy] Error:', error);
    return res.status(500).json({ error: 'Failed to send submitter copy', details: error.message });
  }
}
