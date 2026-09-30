import multer from 'multer';
import { supabase } from './database.js';
import { getTenantContext } from './tenantContext.js';
import { isResourceExcluded } from './roleVisibility.js';
import { inspectPdf, renderCpdCertificatePdf, MAX_CPD_TEMPLATE_BYTES } from './cpdCertificatePdf.js';

export const CPD_TEMPLATE_CAPABILITY = 'cpd.certificate-templates';
const PRIVATE_BUCKET = 'private-uploads';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CPD_TEMPLATE_BYTES } }).single('file');
const runUpload = (req, res) => new Promise((resolve, reject) => upload(req, res, (error) => error ? reject(error) : resolve()));
async function ensureJsonBody(req) {
  if (req.body !== undefined || !(req.headers?.['content-type'] || '').includes('application/json')) return;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { req.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new Error('Invalid JSON request body'); }
}

function actor(context) {
  return context.memberId ? `member:${context.memberId}` : `tenant_user:${context.tenantUserId}`;
}

export async function authorizeCpdTemplates(req, dependencies = {}) {
  const database = dependencies.supabase || supabase;
  const context = await (dependencies.getTenantContext || getTenantContext)(req);
  if (!context?.isAuthenticated || !context.tenantId) return { status: 401, error: 'Authentication required' };
  // Deliberately do not use hasAdminAccess: tenant-admin status is not this capability.
  if (!context.roleId) return { status: 403, error: 'CPD certificate template capability required' };
  const { data: role, error } = await database
    .from('role').select('excluded_features')
    .eq('id', context.roleId).eq('tenant_id', context.tenantId).maybeSingle();
  if (error || !role) return { status: 403, error: 'CPD certificate template capability required' };
  const exclusions = [
    ...(Array.isArray(role.excluded_features) ? role.excluded_features : []),
    ...(Array.isArray(context.memberExcludedFeatures) ? context.memberExcludedFeatures : []),
  ];
  if (isResourceExcluded(exclusions, CPD_TEMPLATE_CAPABILITY)) {
    return { status: 403, error: 'CPD certificate template capability required' };
  }
  return { context };
}

function validPlaceholders(input) {
  if (!Array.isArray(input)) throw new Error('placeholders must be an array');
  return input.map((p, index) => {
    const key = String(p.placeholder_key || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(key)) throw new Error('Placeholder keys must be valid');
    const numeric = ['page_number', 'x', 'y', 'width', 'height', 'font_size', 'line_height', 'minimum_font_size'];
    for (const field of numeric) if (!Number.isFinite(Number(p[field]))) throw new Error(`Invalid placeholder ${field}`);
    if (Number(p.page_number) < 1 || Number(p.x) < 0 || Number(p.y) < 0 || Number(p.width) <= 0 || Number(p.height) <= 0) {
      throw new Error('Invalid placeholder geometry');
    }
    if (!['Helvetica', 'Times', 'Courier'].includes(p.font_family || 'Helvetica')) throw new Error('Invalid placeholder font family');
    if (!['normal', 'bold', 'italic', 'bolditalic'].includes(p.font_style || 'normal')) throw new Error('Invalid placeholder font style');
    if (!['left', 'center', 'right'].includes(p.alignment || 'left')) throw new Error('Invalid placeholder alignment');
    if (!['top', 'middle', 'bottom'].includes(p.vertical_align || p.vertical_alignment || 'middle')) throw new Error('Invalid placeholder vertical alignment');
    if (!['shrink', 'wrap', 'clip'].includes(p.overflow_policy || 'shrink')) throw new Error('Invalid placeholder overflow policy');
    if (!['blank', 'error', 'literal'].includes(p.missing_policy || 'blank')) throw new Error('Invalid placeholder missing-data policy');
    if (!/^#[0-9A-Fa-f]{6}$/.test(p.color || '#000000')) throw new Error('Invalid placeholder color');
    if (Number(p.font_size || 12) < 4 || Number(p.font_size || 12) > 144
      || Number(p.minimum_font_size || 4) < 4 || Number(p.minimum_font_size || 4) > 144
      || Number(p.line_height || 1.2) < 0.8 || Number(p.line_height || 1.2) > 3) {
      throw new Error('Invalid placeholder typography');
    }
    return {
      placeholder_key: key, page_number: Number(p.page_number), x: Number(p.x), y: Number(p.y),
      label: p.label == null ? null : String(p.label).slice(0, 200),
      field_type: ['text', 'date', 'number'].includes(p.field_type) ? p.field_type : 'text',
      sample_value: p.sample_value == null ? null : String(p.sample_value),
      default_value: p.default_value == null ? null : String(p.default_value),
      display_order: Number.isInteger(Number(p.display_order)) && Number(p.display_order) >= 0
        ? Number(p.display_order)
        : index,
      multiline: Boolean(p.multiline),
      shrink_to_fit: p.shrink_to_fit !== false,
      width: Number(p.width), height: Number(p.height), font_family: p.font_family || 'Helvetica',
      font_size: Number(p.font_size || 12), font_style: p.font_style || 'normal',
      alignment: p.alignment || 'left', color: p.color || '#000000',
      line_height: Number(p.line_height || 1.2), overflow_policy: p.overflow_policy || 'shrink',
      missing_policy: p.missing_policy || 'blank', format: p.format || null,
      minimum_font_size: Number(p.minimum_font_size || 4), vertical_align: p.vertical_align || p.vertical_alignment || 'middle',
    };
  });
}

async function getTemplate(id, tenantId) {
  const { data } = await supabase.from('cpd_certificate_template').select('*')
    .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  if (!data) return null;
  const { data: placeholders } = await supabase.from('cpd_certificate_placeholder').select('*')
    .eq('template_id', id).eq('tenant_id', tenantId).order('page_number').order('display_order').order('created_at');
  return { ...data, placeholders: placeholders || [] };
}

async function replacePlaceholders(template, tenantId, placeholders) {
  const rows = validPlaceholders(placeholders).map((p) => ({ ...p, tenant_id: tenantId, template_id: template.id }));
  const geometry = Array.isArray(template.source_geometry) ? template.source_geometry : [];
  for (const row of rows) {
    const page = geometry[row.page_number - 1];
    if (page && (row.x + row.width > page.width || row.y + row.height > page.height)) throw new Error(`Placeholder ${row.placeholder_key} exceeds page bounds`);
  }
  const { error: deleteError } = await supabase.from('cpd_certificate_placeholder').delete()
    .eq('template_id', template.id).eq('tenant_id', tenantId);
  if (deleteError) throw deleteError;
  if (rows.length) {
    const { error } = await supabase.from('cpd_certificate_placeholder').insert(rows);
    if (error) {
      // Restore the previous complete set: a failed replace must not erase
      // persisted placeholders (the normal path is validation-before-delete).
      if (Array.isArray(template.placeholders) && template.placeholders.length) {
        const restore = template.placeholders.map(({ id, created_at, updated_at, ...row }) => row);
        await supabase.from('cpd_certificate_placeholder').insert(restore);
      }
      throw error;
    }
  }
}

function validateGeometryAgainstSource(placeholders, geometry) {
  for (const row of placeholders || []) {
    const page = geometry[Number(row.page_number) - 1];
    if (!page) throw new Error(`Placeholder ${row.placeholder_key} refers to a missing page`);
    if (Number(row.x) < 0 || Number(row.y) < 0
      || Number(row.x) + Number(row.width) > Number(page.width)
      || Number(row.y) + Number(row.height) > Number(page.height)) {
      throw new Error(`Placeholder ${row.placeholder_key} does not fit the replacement PDF`);
    }
  }
}

async function readUploadedPdf(req, res) {
  if ((req.headers?.['content-type'] || '').startsWith('multipart/form-data')) await runUpload(req, res);
  else await ensureJsonBody(req);
  if (req.file?.buffer) return { buffer: req.file.buffer, filename: req.file.originalname, mimeType: req.file.mimetype };
  const body = req.body || {};
  if (body.sourceBase64) return {
    buffer: Buffer.from(String(body.sourceBase64).replace(/^data:application\/pdf;base64,/, ''), 'base64'),
    filename: body.filename || 'template.pdf', mimeType: body.mimeType || 'application/pdf',
  };
  if (Buffer.isBuffer(body)) return { buffer: body, filename: 'template.pdf', mimeType: req.headers['content-type'] };
  throw new Error('A PDF file is required');
}

async function downloadSource(template) {
  if (template.source_bucket !== PRIVATE_BUCKET || !template.source_path) throw Object.assign(new Error('Template has no source PDF'), { status: 409 });
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).download(template.source_path);
  if (error || !data) throw Object.assign(new Error('Source PDF could not be read'), { status: 502 });
  return Buffer.from(await data.arrayBuffer());
}

export async function handleCpdTemplates(req, res, operation = 'collection') {
  if (!supabase) return res.status(503).json({ error: 'Database service not configured' });
  try {
    const auth = await authorizeCpdTemplates(req);
    if (!auth.context) return res.status(auth.status).json({ error: auth.error });
    const { context } = auth;
    const tenantId = context.tenantId;
    const id = req.query.id;

    if (operation === 'collection') {
      if (req.method === 'GET') {
        const { data, error } = await supabase.from('cpd_certificate_template').select('*')
          .eq('tenant_id', tenantId).order('updated_at', { ascending: false });
        if (error) throw error;
        return res.json({ templates: data || [] });
      }
      if (req.method === 'POST') {
        if ((req.headers?.['content-type'] || '').startsWith('multipart/form-data')) await runUpload(req, res);
        else await ensureJsonBody(req);
        const name = String(req.body?.name || '').trim();
        if (!name || name.length > 200) return res.status(400).json({ error: 'A name of at most 200 characters is required' });
        if (!req.file) return res.status(400).json({ error: 'A PDF file is required to create a template' });
        const inspected = await inspectPdf(req.file.buffer, { mimeType: req.file.mimetype });
        const { data, error } = await supabase.from('cpd_certificate_template').insert({
          tenant_id: tenantId, name, description: req.body.description || null,
          created_by: actor(context), updated_by: actor(context),
        }).select().single();
        if (error) throw error;
        try {
          if (req.body.placeholders) {
            const parsedPlaceholders = typeof req.body.placeholders === 'string' ? JSON.parse(req.body.placeholders) : req.body.placeholders;
            await replacePlaceholders({ ...data, placeholders: [] }, tenantId, parsedPlaceholders);
          }
          const path = `${tenantId}/cpd-certificate-templates/${data.id}/v1.pdf`;
          const { error: uploadError } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, req.file.buffer, { contentType: 'application/pdf', upsert: false });
          if (uploadError) throw uploadError;
          const { error: metadataError } = await supabase.from('cpd_certificate_template').update({
            source_bucket: PRIVATE_BUCKET, source_path: path, source_filename: req.file.originalname,
            source_mime_type: 'application/pdf', source_size_bytes: req.file.buffer.length,
            source_sha256: inspected.sha256, source_page_count: inspected.pages.length, source_geometry: inspected.geometry,
          }).eq('id', data.id).eq('tenant_id', tenantId);
          if (metadataError) { await supabase.storage.from(PRIVATE_BUCKET).remove([path]); throw metadataError; }
        } catch (creationError) {
          await supabase.from('cpd_certificate_template').delete().eq('id', data.id).eq('tenant_id', tenantId);
          throw creationError;
        }
        return res.status(201).json({ template: await getTemplate(data.id, tenantId) });
      }
    }

    const template = await getTemplate(id, tenantId);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    if (operation === 'item') {
      if (req.method === 'GET') return res.json({ template });
      if (req.method === 'DELETE') {
        if (template.status === 'active') return res.status(409).json({ error: 'Active templates must be archived before deletion' });
        if (req.body?.expectedVersion === undefined) return res.status(400).json({ error: 'expectedVersion is required' });
        const { data: deleted, error } = await supabase.from('cpd_certificate_template').delete().eq('id', id).eq('tenant_id', tenantId)
          .eq('version', Number(req.body.expectedVersion)).select('id');
        if (error) throw error;
        if (!deleted?.length) return res.status(409).json({ error: 'Template was modified by another user; refresh and retry' });
        if (template.source_path) await supabase.storage.from(PRIVATE_BUCKET).remove([template.source_path]);
        return res.json({ success: true });
      }
      if (['PATCH', 'PUT'].includes(req.method)) {
        if (template.status === 'active') return res.status(409).json({ error: 'Archive the active template before editing it' });
        if (req.body.expectedVersion === undefined) return res.status(400).json({ error: 'expectedVersion is required' });
        let name = template.name;
        if (req.body.name !== undefined) {
          name = String(req.body.name).trim();
          if (!name || name.length > 200) return res.status(400).json({ error: 'Invalid name' });
        }
        const placeholders = validPlaceholders(req.body.placeholders ?? template.placeholders);
        validateGeometryAgainstSource(placeholders, template.source_geometry || []);
        const { error } = await supabase.rpc('save_cpd_certificate_template', {
          p_template_id: id,
          p_tenant_id: tenantId,
          p_expected_version: Number(req.body.expectedVersion),
          p_name: name,
          p_description: req.body.description !== undefined ? req.body.description || null : template.description,
          p_placeholders: placeholders,
          p_actor: actor(context),
        });
        if (error) {
          if (error.code === '40001' || String(error.message || '').includes('cpd_template_conflict')) {
            return res.status(409).json({ error: 'Template was modified by another user; refresh and retry' });
          }
          throw error;
        }
        return res.json({ template: await getTemplate(id, tenantId) });
      }
    }

    if (operation === 'duplicate' && req.method === 'POST') {
      const { data: copy, error } = await supabase.from('cpd_certificate_template').insert({
        tenant_id: tenantId, name: String(req.body?.name || `${template.name} (copy)`).trim(),
        description: template.description, status: 'draft', source_bucket: null,
        source_path: null, source_filename: null, source_mime_type: null, source_size_bytes: null,
        source_sha256: null, source_page_count: null, source_geometry: template.source_geometry,
        created_by: actor(context), updated_by: actor(context),
      }).select().single();
      if (error) throw error;
      if (template.source_path) {
        const copyPath = `${tenantId}/cpd-certificate-templates/${copy.id}/v1.pdf`;
        const { error: copyError } = await supabase.storage.from(PRIVATE_BUCKET).copy(template.source_path, copyPath);
        if (copyError) {
          await supabase.from('cpd_certificate_template').delete().eq('id', copy.id).eq('tenant_id', tenantId);
          throw copyError;
        }
        const { error: metadataError } = await supabase.from('cpd_certificate_template').update({
          source_bucket: PRIVATE_BUCKET, source_path: copyPath,
          source_filename: template.source_filename, source_mime_type: template.source_mime_type,
          source_size_bytes: template.source_size_bytes, source_sha256: template.source_sha256,
          source_page_count: template.source_page_count, source_geometry: template.source_geometry,
        }).eq('id', copy.id).eq('tenant_id', tenantId);
        if (metadataError) {
          await supabase.storage.from(PRIVATE_BUCKET).remove([copyPath]);
          await supabase.from('cpd_certificate_template').delete().eq('id', copy.id).eq('tenant_id', tenantId);
          throw metadataError;
        }
      }
      try {
        await replacePlaceholders(copy, tenantId, template.placeholders);
      } catch (placeholderError) {
        if (template.source_path) {
          await supabase.storage.from(PRIVATE_BUCKET).remove([
            `${tenantId}/cpd-certificate-templates/${copy.id}/v1.pdf`,
          ]);
        }
        await supabase.from('cpd_certificate_template').delete().eq('id', copy.id).eq('tenant_id', tenantId);
        throw placeholderError;
      }
      return res.status(201).json({ template: await getTemplate(copy.id, tenantId) });
    }

    if (operation === 'lifecycle' && req.method === 'POST') {
      if (req.body?.expectedVersion === undefined) return res.status(400).json({ error: 'expectedVersion is required' });
      const action = req.body?.action;
      const transitions = {
        submit_review: ['draft', 'in_review'], approve: ['in_review', 'approved'],
        activate: ['approved', 'active'], archive: ['draft,in_review,approved,active', 'archived'],
        return_draft: ['in_review,approved', 'draft'],
      };
      const rule = transitions[action];
      if (!rule || !rule[0].split(',').includes(template.status)) return res.status(409).json({ error: 'Invalid lifecycle transition' });
      if (action === 'activate' && !template.source_path) return res.status(409).json({ error: 'A source PDF is required before activation' });
      if (action === 'activate') validateGeometryAgainstSource(template.placeholders, template.source_geometry || []);
      const now = new Date().toISOString();
      const updates = { status: rule[1], version: template.version + 1, updated_at: now, updated_by: actor(context) };
      if (action === 'submit_review') updates.review_requested_at = now;
      if (action === 'approve') Object.assign(updates, { reviewed_at: now, reviewed_by: actor(context), review_note: req.body.review_note || null });
      if (action === 'archive') updates.archived_at = now;
      const lifecycleQuery = supabase.from('cpd_certificate_template').update(updates).eq('id', id).eq('tenant_id', tenantId)
        .eq('version', Number(req.body.expectedVersion));
      const { data: lifecycleUpdated, error } = await lifecycleQuery.select('id');
      if (error) throw error;
      if (!lifecycleUpdated?.length) return res.status(409).json({ error: 'Template was modified by another user; refresh and retry' });
      return res.json({ template: await getTemplate(id, tenantId) });
    }

    if (operation === 'source') {
      if (req.method === 'GET') {
        if (!template.source_path) return res.status(404).json({ error: 'Source PDF not found' });
        const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(template.source_path, 300, { download: req.query.download === 'true' });
        if (error) throw error;
        if (req.query.redirect === 'true') return res.redirect(302, data.signedUrl);
        return res.json({ signedUrl: data.signedUrl, expiresIn: 300 });
      }
      if (['POST', 'PUT'].includes(req.method)) {
        if (template.status === 'active') return res.status(409).json({ error: 'Archive the active template before replacing its source' });
        const file = await readUploadedPdf(req, res);
        const inspected = await inspectPdf(file.buffer, { mimeType: file.mimeType });
        if (req.body?.expectedVersion === undefined) return res.status(400).json({ error: 'expectedVersion is required' });
        validateGeometryAgainstSource(template.placeholders, inspected.geometry);
        const path = `${tenantId}/cpd-certificate-templates/${id}/v${template.version + 1}.pdf`;
        const { error: uploadError } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, file.buffer, { contentType: 'application/pdf', upsert: false });
        if (uploadError) throw uploadError;
        let sourceQuery = supabase.from('cpd_certificate_template').update({
          source_bucket: PRIVATE_BUCKET, source_path: path, source_filename: file.filename,
          source_mime_type: 'application/pdf', source_size_bytes: file.buffer.length,
          source_sha256: inspected.sha256, source_page_count: inspected.pages.length,
          source_geometry: inspected.geometry, version: template.version + 1, status: 'draft',
          updated_at: new Date().toISOString(), updated_by: actor(context),
        }).eq('id', id).eq('tenant_id', tenantId);
        sourceQuery = sourceQuery.eq('version', Number(req.body.expectedVersion));
        const { data: sourceUpdated, error } = await sourceQuery.select('id');
        if (error) { await supabase.storage.from(PRIVATE_BUCKET).remove([path]); throw error; }
        if (!sourceUpdated?.length) {
          await supabase.storage.from(PRIVATE_BUCKET).remove([path]);
          return res.status(409).json({ error: 'Template was modified by another user; refresh and retry' });
        }
        if (template.source_path) await supabase.storage.from(PRIVATE_BUCKET).remove([template.source_path]);
        return res.json({ template: await getTemplate(id, tenantId) });
      }
    }

    if ((operation === 'preview' || operation === 'render') && req.method === 'POST') {
      const source = await downloadSource(template);
      const output = await renderCpdCertificatePdf(source, template.placeholders, req.body?.values || req.body?.data || {});
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${operation === 'render' ? 'attachment' : 'inline'}; filename="${template.name.replace(/["\r\n]/g, '_')}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).send(output);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const status = error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
    console.error('[cpd-certificate-templates]', error);
    return res.status(status).json({ error: error.message || 'Request failed' });
  }
}