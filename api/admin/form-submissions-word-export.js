import { getSessionMember } from '../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { Document, Packer } from 'docx';
import {
  buildSubmissionsDocument,
  buildSubmissionSection,
  buildTitleBlock,
  buildFooter,
  loadTenantLogo,
  sanitizeFileName,
  resolveAwardType,
} from '../../client/src/lib/formSubmissionWordExport.js';
import {
  collectRelationshipRecordIdsFromSubmissions,
  resolveRelationshipDisplayLabel,
} from '../../client/src/lib/relationshipDisplayLabels.js';
import { loadTenantRelationshipDisplayLabels } from '../_lib/relationshipDisplayLabels.js';
import {
  collectRepeatableRelationshipRecordIds,
  getRepeatableRowChildren,
} from '../../shared/repeatableFormRowsFormat.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const MAX_SUBMISSIONS = 2000;

function isSafePublicLogoUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '::1' || host === '0.0.0.0') return false;
  // Reject IPv4 literals in private/loopback/link-local/metadata ranges.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 0) return false;
    if (a >= 224) return false;
  }
  // Reject obvious IPv6 literal forms beyond loopback already handled.
  if (host.includes(':')) return false;
  return true;
}

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

function buildServerResolvers(maps, origin) {
  const {
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
    return submission.form_name || maps.formsById[submission.form_id]?.name || 'Unknown Form';
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
    const excludedFeatures = role?.excluded_features || [];
    if (excludedFeatures.includes('page_FormSubmissions') || excludedFeatures.includes('page_FormManagement')) {
      return res.status(403).json({ error: 'Access denied - insufficient permissions' });
    }
  }

  try {
    const {
      submissionIds,
      selectedOptions,
      scope,
      documentTitle,
      fileName,
    } = req.body || {};

    const { data: tenantRow } = await supabase
      .from('tenant')
      .select('name, logo_url')
      .eq('id', tenantId)
      .single();
    const tenantName = tenantRow?.name || '';
    const tenantLogoUrl = tenantRow?.logo_url || '';

    const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
    const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
    const headerOrigin = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : '';
    const origin = (process.env.VITE_APP_URL || headerOrigin || '').replace(/\/+$/, '');

    if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
      return res.status(400).json({ error: 'submissionIds is required' });
    }
    if (submissionIds.length > MAX_SUBMISSIONS) {
      return res.status(400).json({ error: `Too many submissions (max ${MAX_SUBMISSIONS})` });
    }
    if (!Array.isArray(selectedOptions) || selectedOptions.length === 0) {
      return res.status(400).json({ error: 'selectedOptions is required' });
    }

    const submissionRows = await fetchByIds(
      'form_submission',
      submissionIds.map(String),
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
      return res.status(400).json({ error: 'No submissions match the requested scope' });
    }

    const referencedFieldTypes = new Set();
    const referencedCustomFieldIds = new Set();
    for (const form of Object.values(formsById)) {
      for (const parentField of form.fields || []) {
        const fieldsToInspect = [parentField, ...getRepeatableRowChildren(parentField)];
        for (const f of fieldsToInspect) {
        if (f?.type) referencedFieldTypes.add(f.type);
        if (f?.type === 'custom_field' && f.custom_field_id) {
          referencedCustomFieldIds.add(f.custom_field_id);
        }
        }
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
            ...collectRelationshipRecordIdsFromSubmissions(formsById, submissions),
            ...submissions.flatMap((submission) => collectRepeatableRelationshipRecordIds(
              formsById[submission.form_id]?.fields || [], submission.submission_data,
            )),
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
    }, origin);

    const subById = new Map(submissions.map(s => [String(s.id), s]));
    const orderedSubmissions = submissionIds
      .map(id => subById.get(String(id)))
      .filter(Boolean);

    const safeLogoUrl = isSafePublicLogoUrl(tenantLogoUrl) ? tenantLogoUrl : '';
    const tenantLogo = safeLogoUrl ? await loadTenantLogo(safeLogoUrl) : null;
    const safeName = sanitizeFileName(
      (fileName || 'Form_Submissions').replace(/\.docx$/i, '')
    ) + '.docx';

    const acceptHeader = String(req.headers.accept || '');
    const wantStream = acceptHeader.includes('application/x-ndjson');

    if (wantStream) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const write = (obj) => {
        try { res.write(JSON.stringify(obj) + '\n'); } catch { /* client disconnected */ }
      };

      try {
        const total = orderedSubmissions.length;
        write({ type: 'progress', phase: 'rendering', processed: 0, total });

        const body = [];
        body.push(...buildTitleBlock({ tenantName: tenantName || '', tenantLogo, documentTitle: documentTitle || 'Form Submissions' }));

        for (let i = 0; i < orderedSubmissions.length; i++) {
          const submission = orderedSubmissions[i];
          const form = formsById[submission.form_id] || null;
          body.push(...buildSubmissionSection({
            submission,
            form,
            selectedOptions,
            resolvers,
            isLast: i === orderedSubmissions.length - 1,
          }));
          // Emit progress after every submission (with a yield so the write flushes)
          write({ type: 'progress', phase: 'rendering', processed: i + 1, total });
          // Yield to the event loop so res.write actually flushes to the network.
          await new Promise(resolve => setImmediate(resolve));
        }

        write({ type: 'progress', phase: 'packaging', processed: total, total });

        const doc = new Document({
          creator: 'iConnect',
          title: documentTitle || 'Form Submissions',
          styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
          sections: [{
            properties: {},
            footers: { default: buildFooter() },
            children: body,
          }],
        });

        const buffer = await Packer.toBuffer(doc);
        write({
          type: 'complete',
          fileName: safeName,
          size: buffer.length,
          data: buffer.toString('base64'),
        });
        return res.end();
      } catch (error) {
        console.error('[Form Submissions Word Export] Streaming error:', error);
        write({ type: 'error', error: 'Failed to generate Word document' });
        return res.end();
      }
    }

    const doc = buildSubmissionsDocument({
      submissions: orderedSubmissions,
      formsById,
      selectedOptions,
      resolvers,
      tenantName: tenantName || '',
      tenantLogo,
      documentTitle: documentTitle || 'Form Submissions',
    });

    const buffer = await Packer.toBuffer(doc);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buffer);
  } catch (error) {
    console.error('[Form Submissions Word Export] Error:', error);
    if (res.headersSent) {
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    return res.status(500).json({ error: 'Failed to generate Word document' });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '5mb' },
  },
};
