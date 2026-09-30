import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

function sanitizeFileName(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

async function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    let body = [];
    let boundary = null;

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    if (boundaryMatch) {
      boundary = boundaryMatch[1] || boundaryMatch[2];
    }

    if (!boundary) {
      return reject(new Error('No boundary found in content-type'));
    }

    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(body);
        const boundaryBuffer = Buffer.from(`--${boundary}`);
        const parts = [];
        let start = 0;

        while (true) {
          const idx = buffer.indexOf(boundaryBuffer, start);
          if (idx === -1) break;
          if (start > 0) {
            parts.push(buffer.slice(start, idx - 2));
          }
          start = idx + boundaryBuffer.length + 2;
        }

        let file = null;
        const fields = {};

        for (const part of parts) {
          if (part.length < 4) continue;

          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;

          const headers = part.slice(0, headerEnd).toString();
          const content = part.slice(headerEnd + 4);

          const nameMatch = headers.match(/name="([^"]+)"/);
          const filenameMatch = headers.match(/filename="([^"]+)"/);
          const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

          if (nameMatch) {
            const fieldName = nameMatch[1];

            if (filenameMatch && fieldName === 'file') {
              file = {
                originalname: filenameMatch[1],
                mimetype: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
                buffer: content.slice(0, content.length - 2),
                size: content.length - 2
              };
            } else {
              fields[fieldName] = content.toString().trim();
            }
          }
        }

        resolve({ file, fields });
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (req.method === 'PUT') {
    try {
      const contentType = req.headers['content-type'] || '';
      let body, file;

      if (contentType.includes('multipart/form-data')) {
        const parsed = await parseMultipartForm(req);
        file = parsed.file;
        body = parsed.fields;
      } else {
        body = req.body || {};
      }

      const tenant = await resolveTenantFromRequest(req);
      if (!tenant?.id) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const sessionToken = req.query.session_token;
      if (!sessionToken) {
        return res.status(400).json({ error: 'Session token is required' });
      }

      const { data: tokenRecord, error: tokenError } = await supabase
        .from('fundraising_login_token')
        .select('*')
        .eq('token', sessionToken)
        .eq('tenant_id', tenant.id)
        .eq('type', 'session')
        .single();

      if (tokenError || !tokenRecord || new Date(tokenRecord.expires_at) < new Date()) {
        return res.status(401).json({ error: 'Session expired. Please log in again.' });
      }

      const teamMemberId = body.team_member_id || req.query.team_member_id;
      const field = body.field || req.query.field;

      if (!teamMemberId || !field) {
        return res.status(400).json({ error: 'team_member_id and field are required' });
      }

      const { data: member, error: memberError } = await supabase
        .from('fundraising_team_member')
        .select('id, email, tenant_id')
        .eq('id', teamMemberId)
        .eq('tenant_id', tenant.id)
        .single();

      if (memberError || !member) {
        return res.status(404).json({ error: 'Team member not found' });
      }

      if (member.email?.toLowerCase() !== tokenRecord.email?.toLowerCase()) {
        return res.status(403).json({ error: 'Not authorized to update this profile' });
      }

      const allowedFields = ['personal_message', 'custom_header_image_url', 'avatar_url'];
      if (!allowedFields.includes(field)) {
        return res.status(400).json({ error: 'Invalid field' });
      }

      let updateData = {};

      if (field === 'personal_message') {
        updateData.personal_message = (body.value || '').trim() || null;
      } else if (field === 'custom_header_image_url' || field === 'avatar_url') {
        if (body.value === 'remove') {
          updateData[field] = null;
        } else if (file) {
          const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          if (!allowedTypes.includes(file.mimetype)) {
            return res.status(400).json({ error: 'Invalid file type. Please upload JPEG, PNG, GIF, or WebP.' });
          }

          if (file.size > 5 * 1024 * 1024) {
            return res.status(400).json({ error: 'File too large. Maximum 5MB.' });
          }

          const ext = file.originalname.split('.').pop() || 'jpg';
          const safeName = sanitizeFileName(file.originalname.replace(/\.[^/.]+$/, ''));
          const filePath = `fundraising/${tenant.id}/${field}/${teamMemberId}_${Date.now()}_${safeName}.${ext}`;

          const { error: uploadError } = await supabase.storage
            .from('public-assets')
            .upload(filePath, file.buffer, {
              contentType: file.mimetype,
              upsert: true
            });

          if (uploadError) {
            console.error('[Profile Update] Upload error:', uploadError);
            return res.status(500).json({ error: 'Failed to upload image' });
          }

          const { data: publicUrlData } = supabase.storage
            .from('public-assets')
            .getPublicUrl(filePath);

          updateData[field] = publicUrlData.publicUrl;
        } else {
          return res.status(400).json({ error: 'File or remove action required for image fields' });
        }
      }

      const { error: updateError } = await supabase
        .from('fundraising_team_member')
        .update(updateData)
        .eq('id', teamMemberId);

      if (updateError) {
        console.error('[Profile Update] Update error:', updateError);
        return res.status(500).json({ error: 'Failed to update profile' });
      }

      return res.json({ success: true, ...updateData });
    } catch (err) {
      console.error('[Profile Update] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
