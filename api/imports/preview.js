import { createClient } from '@supabase/supabase-js';
import { getSession } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export const config = {
  api: {
    bodyParser: false,
  },
};

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
          
          if (nameMatch) {
            const fieldName = nameMatch[1];
            
            if (filenameMatch && fieldName === 'file') {
              file = {
                originalname: filenameMatch[1],
                buffer: content.slice(0, content.length - 2),
              };
            } else {
              fields[fieldName] = content.toString().trim().replace(/\r\n$/, '');
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const session = await getSession(req);
  if (!session?.data?.memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  try {
    const { file, fields } = await parseMultipartForm(req);
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const { entityType, identifierField, mappings: mappingsStr } = fields;
    const mappings = mappingsStr ? JSON.parse(mappingsStr) : [];
    
    if (!entityType || !identifierField || !mappings.length) {
      return res.status(400).json({ error: 'Missing required fields: entityType, identifierField, mappings' });
    }
    
    const csvContent = file.buffer.toString('utf-8');
    
    const { parse } = await import('csv-parse/sync');
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    
    const identifierMapping = mappings.find(m => m.targetField === identifierField);
    if (!identifierMapping) {
      return res.status(400).json({ error: `No mapping found for identifier field: ${identifierField}` });
    }
    
    const tableName = entityType === 'organization' ? 'organization' : 'member';
    const previewResults = [];
    
    for (let i = 0; i < Math.min(records.length, 10); i++) {
      const row = records[i];
      const identifierValue = row[identifierMapping.sourceColumn]?.trim();
      
      if (!identifierValue) {
        previewResults.push({
          row: i + 1,
          identifier: '',
          action: 'skip',
          reason: 'Empty identifier'
        });
        continue;
      }
      
      const { data: existing } = await supabase
        .from(tableName)
        .select('id')
        .eq(identifierField, identifierValue)
        .maybeSingle();
      
      const mappedFields = {};
      for (const mapping of mappings) {
        if (mapping.sourceColumn && mapping.targetField) {
          mappedFields[mapping.targetField] = row[mapping.sourceColumn] || '';
        }
      }
      
      previewResults.push({
        row: i + 1,
        identifier: identifierValue,
        action: existing ? 'update' : 'create',
        existingId: existing?.id,
        mappedFields
      });
    }
    
    res.json({
      totalRows: records.length,
      previewRows: previewResults,
      summary: {
        creates: previewResults.filter(r => r.action === 'create').length,
        updates: previewResults.filter(r => r.action === 'update').length,
        skips: previewResults.filter(r => r.action === 'skip').length
      }
    });
  } catch (error) {
    console.error('[Import Preview] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to preview import' });
  }
}
