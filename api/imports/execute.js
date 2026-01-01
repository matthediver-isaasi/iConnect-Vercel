import { createClient } from '@supabase/supabase-js';
import { getSession } from '../_lib/session.js';
import { parseMultipartForm } from '../_lib/multipart.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Parse date string according to specified format
function parseDate(dateStr, format) {
  if (!dateStr || !format) return null;
  
  const str = dateStr.trim();
  if (!str) return null;
  
  // Detect separator from the actual value (not format) - try common separators
  let dateSeparator = null;
  if (str.includes('/')) dateSeparator = '/';
  else if (str.includes('-')) dateSeparator = '-';
  else if (str.includes('.')) dateSeparator = '.';
  
  if (!dateSeparator) return null;
  
  const parts = str.split(dateSeparator);
  const formatParts = format.split(/[\/\-\.]/);
  
  if (parts.length !== formatParts.length) {
    console.log(`[parseDate] Part count mismatch: value has ${parts.length}, format has ${formatParts.length}`);
    return null;
  }
  
  let day, month, year;
  
  for (let i = 0; i < formatParts.length; i++) {
    const fmt = formatParts[i].toLowerCase();
    const rawVal = parts[i].trim();
    const val = parseInt(rawVal, 10);
    
    if (isNaN(val)) {
      console.log(`[parseDate] Could not parse "${rawVal}" as number at position ${i}`);
      return null;
    }
    
    if (fmt === 'dd' || fmt === 'd') {
      day = val;
    } else if (fmt === 'mm' || fmt === 'm') {
      month = val;
    } else if (fmt === 'yyyy') {
      year = val;
    } else if (fmt === 'yy') {
      // 2-digit year: 00-49 = 2000-2049, 50-99 = 1950-1999
      year = val < 50 ? 2000 + val : 1900 + val;
    }
  }
  
  console.log(`[parseDate] Parsed "${str}" with format "${format}" → day=${day}, month=${month}, year=${year}`);
  
  if (!day || !month || !year) return null;
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  
  // Create ISO date string
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  
  // Validate by parsing
  const parsed = new Date(isoDate);
  if (isNaN(parsed.getTime())) return null;
  
  console.log(`[parseDate] Result: ${isoDate}`);
  return isoDate;
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
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    let csvContent = file.buffer.toString('utf-8');
    
    // Remove BOM if present
    if (csvContent.charCodeAt(0) === 0xFEFF) {
      csvContent = csvContent.slice(1);
    }
    
    // Normalize line endings (CRLF -> LF)
    csvContent = csvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Auto-detect delimiter (semicolon or comma)
    const firstLine = csvContent.split('\n')[0] || '';
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    const delimiter = semicolonCount > commaCount ? ';' : ',';
    
    console.log(`[Import] Detected delimiter: "${delimiter}", first line columns: ${Math.max(semicolonCount, commaCount) + 1}`);
    
    // Debug: Log last 100 chars of CSV to check for truncation at file level
    const last100 = csvContent.slice(-100);
    console.log(`[Import] Last 100 chars of CSV: ${JSON.stringify(last100)}`);
    console.log(`[Import] Last 100 char codes:`, [...last100].map(c => c.charCodeAt(0)));
    
    const { parse } = await import('csv-parse/sync');
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter,
      relax_quotes: true,
      relax_column_count: true,
      escape: '"',
      quote: '"'
    });
    
    const tableName = entityType === 'organization' ? 'organization' : 'member';
    const customValueTable = entityType === 'organization' 
      ? 'organization_preference_value' 
      : 'member_preference_value';
    const entityIdField = entityType === 'organization' ? 'organization_id' : 'member_id';
    
    const identifierMapping = mappings.find(m => m.targetField === identifierField);
    if (!identifierMapping) {
      return res.status(400).json({ error: `No mapping for identifier field: ${identifierField}` });
    }
    
    let jobId = null;
    try {
      const { data: job, error: jobError } = await supabase
        .from('csv_import_job')
        .insert({
          entity_type: entityType,
          status: 'running',
          file_name: file.originalname || 'import.csv',
          total_rows: records.length,
          created_by: session.data.memberId
        })
        .select()
        .single();
      
      if (!jobError && job) {
        jobId = job.id;
      }
    } catch (e) {
      console.log('[Import] Could not create job record (table may not exist)');
    }
    
    let processedRows = 0;
    let createdRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let errorRows = 0;
    const errorLog = [];
    
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      
      // Debug: Log raw row data for first few rows
      if (i < 3) {
        console.log(`[Import] Row ${i + 1} raw data:`, JSON.stringify(row));
        // Log character codes for date field to debug truncation
        const dateField = row['Joined Date'] || row['Created At'] || row['created_at'];
        if (dateField) {
          const charCodes = [...dateField].map(c => c.charCodeAt(0));
          console.log(`[Import] Row ${i + 1} date field "${dateField}" char codes:`, charCodes);
        }
      }
      
      const identifierValue = row[identifierMapping.sourceColumn]?.trim();
      
      if (!identifierValue) {
        skippedRows++;
        errorLog.push({ row: i + 1, error: 'Empty identifier value' });
        continue;
      }
      
      try {
        const { data: existing } = await supabase
          .from(tableName)
          .select('id')
          .eq(identifierField, identifierValue)
          .maybeSingle();
        
        const coreData = {};
        const customData = [];
        
        for (const mapping of mappings) {
          if (!mapping.sourceColumn || !mapping.targetField) continue;
          
          let value = row[mapping.sourceColumn];
          
          if (mapping.clearOnEmpty && (!value || value.trim() === '')) {
            value = null;
          }
          
          // Parse date values according to specified format
          if (value !== null && mapping.targetType === 'date' && mapping.dateFormat) {
            const parsedDate = parseDate(value, mapping.dateFormat);
            if (parsedDate) {
              value = parsedDate;
            } else if (value.trim()) {
              // Log warning but don't fail - keep original value
              console.log(`[Import] Row ${i + 1}: Could not parse date "${value}" with format ${mapping.dateFormat}`);
            }
          }
          
          if (mapping.targetField.startsWith('custom:')) {
            const fieldKey = mapping.targetField.replace('custom:', '');
            customData.push({ fieldKey, value, preferenceFieldId: mapping.preferenceFieldId });
          } else {
            if (value === null || (typeof value === 'string' && value.trim() !== '')) {
              coreData[mapping.targetField] = value === null ? null : value.trim();
            }
          }
        }
        
        let entityId;
        
        if (existing) {
          if (Object.keys(coreData).length > 0) {
            const { error: updateError } = await supabase
              .from(tableName)
              .update(coreData)
              .eq('id', existing.id);
            
            if (updateError) {
              throw new Error(`Update failed: ${updateError.message}`);
            }
          }
          entityId = existing.id;
          updatedRows++;
        } else {
          const { data: newEntity, error: insertError } = await supabase
            .from(tableName)
            .insert(coreData)
            .select('id')
            .single();
          
          if (insertError) {
            throw new Error(`Insert failed: ${insertError.message}`);
          }
          entityId = newEntity.id;
          createdRows++;
        }
        
        for (const customField of customData) {
          if (!customField.preferenceFieldId) continue;
          
          const { data: existingValue } = await supabase
            .from(customValueTable)
            .select('id')
            .eq(entityIdField, entityId)
            .eq('preference_field_id', customField.preferenceFieldId)
            .maybeSingle();
          
          if (existingValue) {
            await supabase
              .from(customValueTable)
              .update({ value: customField.value })
              .eq('id', existingValue.id);
          } else if (customField.value !== null && customField.value !== '') {
            await supabase
              .from(customValueTable)
              .insert({
                [entityIdField]: entityId,
                preference_field_id: customField.preferenceFieldId,
                value: customField.value
              });
          }
        }
        
        processedRows++;
      } catch (rowError) {
        errorRows++;
        errorLog.push({ row: i + 1, identifier: identifierValue, error: rowError.message });
      }
    }
    
    if (jobId) {
      try {
        await supabase
          .from('csv_import_job')
          .update({
            status: 'completed',
            processed_rows: processedRows,
            created_rows: createdRows,
            updated_rows: updatedRows,
            skipped_rows: skippedRows,
            error_rows: errorRows,
            error_log: errorLog,
            completed_at: new Date().toISOString()
          })
          .eq('id', jobId);
      } catch (e) {
        console.log('[Import] Could not update job record');
      }
    }
    
    res.json({
      success: true,
      jobId,
      created: createdRows,
      updated: updatedRows,
      skipped: skippedRows,
      errors: errorRows,
      summary: {
        totalRows: records.length,
        processedRows,
        createdRows,
        updatedRows,
        skippedRows,
        errorRows
      },
      errorDetails: errorLog.slice(0, 20)
    });
  } catch (error) {
    console.error('[Import Execute] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to execute import' });
  }
}
