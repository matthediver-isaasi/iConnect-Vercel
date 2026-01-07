import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';
import { parseMultipartForm } from '../_lib/multipart.js';

// Helper function to parse and validate date strings based on format
function parseDateWithFormat(dateString, format) {
  if (!dateString || !dateString.trim()) return null;
  
  const trimmed = dateString.trim();
  
  const parts = trimmed.split(/[\/\-\.]/);
  if (parts.length !== 3) return null;
  
  let day, month, year;
  
  // Parse based on format pattern
  const formatLower = format.toLowerCase();
  
  if (formatLower.startsWith('dd')) {
    // DD/MM/YYYY or DD/MM/YY formats
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  } else if (formatLower.startsWith('mm')) {
    // MM/DD/YYYY or MM/DD/YY formats  
    month = parseInt(parts[0], 10);
    day = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  } else if (formatLower.startsWith('yy')) {
    // YYYY-MM-DD or YY-MM-DD formats
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    day = parseInt(parts[2], 10);
  } else {
    // Default: assume DD/MM/YYYY
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  }
  
  // Validate parsed values
  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  if (day < 1 || day > 31) return null;
  if (month < 1 || month > 12) return null;
  
  // Handle 2-digit years
  if (year < 100) {
    // Assume 00-49 = 2000-2049, 50-99 = 1950-1999
    year = year < 50 ? 2000 + year : 1900 + year;
  }
  
  // Use Date.UTC to create date in UTC timezone (avoids local timezone shifts)
  const utcTimestamp = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  if (isNaN(utcTimestamp)) return null;
  
  const date = new Date(utcTimestamp);
  
  // Verify the date didn't roll over (e.g., Feb 30 becoming Mar 2)
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1 || date.getUTCFullYear() !== year) {
    return null;
  }
  
  // Return ISO string - this will be in UTC format
  return date.toISOString();
}

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
    const errors = [];
    
    // Validate all rows for date parsing errors (not just preview rows)
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      
      // Validate date fields
      for (const mapping of mappings) {
        if (mapping.targetType === 'date' && mapping.dateFormat) {
          const sourceValue = row[mapping.sourceColumn]?.trim();
          if (sourceValue) {
            const parsedDate = parseDateWithFormat(sourceValue, mapping.dateFormat);
            if (parsedDate === null) {
              errors.push({ 
                row: i + 2, 
                message: `Invalid date "${sourceValue}" for field "${mapping.targetField}" (expected format: ${mapping.dateFormat})` 
              });
            }
          }
        }
      }
    }
    
    // Generate preview for first 10 rows
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
      },
      errors: errors.slice(0, 10) // Return first 10 date validation errors
    });
  } catch (error) {
    console.error('[Import Preview] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to preview import' });
  }
}
