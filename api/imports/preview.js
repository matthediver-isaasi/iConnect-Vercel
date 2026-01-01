import { createClient } from '@supabase/supabase-js';
import { getSession } from '../_lib/session.js';
import { parseMultipartForm } from '../_lib/multipart.js';

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
    
    if (!file || !file.buffer) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const { entityType, identifierField, mappings: mappingsStr } = fields;
    const mappings = mappingsStr ? JSON.parse(mappingsStr) : [];
    
    if (!entityType || !identifierField || !mappings.length) {
      return res.status(400).json({ error: 'Missing required fields: entityType, identifierField, mappings' });
    }
    
    let csvContent = file.buffer.toString('utf-8');
    
    // Remove BOM if present
    if (csvContent.charCodeAt(0) === 0xFEFF) {
      csvContent = csvContent.slice(1);
    }
    
    // Auto-detect delimiter (semicolon or comma)
    const firstLine = csvContent.split('\n')[0] || '';
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    const delimiter = semicolonCount > commaCount ? ';' : ',';
    
    const { parse } = await import('csv-parse/sync');
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter,
      relax_quotes: true,
      relax_column_count: true
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
