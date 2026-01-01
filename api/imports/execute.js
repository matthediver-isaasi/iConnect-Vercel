import { createClient } from '@supabase/supabase-js';
import { getSession } from '../_lib/session.js';
import { parseMultipartForm } from '../_lib/multipart.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

function parseDate(dateStr, format) {
  if (!dateStr || !format) return null;
  
  const str = dateStr.trim();
  if (!str) return null;
  
  let dateSeparator = null;
  if (str.includes('/')) dateSeparator = '/';
  else if (str.includes('-')) dateSeparator = '-';
  else if (str.includes('.')) dateSeparator = '.';
  
  if (!dateSeparator) return null;
  
  const parts = str.split(dateSeparator);
  const formatParts = format.split(/[\/\-\.]/);
  
  if (parts.length !== formatParts.length) return null;
  
  let day, month, year;
  
  for (let i = 0; i < formatParts.length; i++) {
    const fmt = formatParts[i].toLowerCase();
    const val = parseInt(parts[i].trim(), 10);
    
    if (isNaN(val)) return null;
    
    if (fmt === 'dd' || fmt === 'd') day = val;
    else if (fmt === 'mm' || fmt === 'm') month = val;
    else if (fmt === 'yyyy') year = val;
    else if (fmt === 'yy') year = val < 50 ? 2000 + val : 1900 + val;
  }
  
  if (!day || !month || !year) return null;
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(isoDate);
  if (isNaN(parsed.getTime())) return null;
  
  return isoDate;
}

export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60, // Increase timeout to 60 seconds for Pro plans
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
    
    if (csvContent.charCodeAt(0) === 0xFEFF) {
      csvContent = csvContent.slice(1);
    }
    
    csvContent = csvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    const firstLine = csvContent.split('\n')[0] || '';
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    const delimiter = semicolonCount > commaCount ? ';' : ',';
    
    console.log(`[Import] Delimiter: "${delimiter}", rows parsing...`);
    
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
    
    console.log(`[Import] Parsed ${records.length} rows`);
    
    const tableName = entityType === 'organization' ? 'organization' : 'member';
    const customValueTable = entityType === 'organization' 
      ? 'organization_preference_value' 
      : 'member_preference_value';
    const entityIdField = entityType === 'organization' ? 'organization_id' : 'member_id';
    
    const identifierMapping = mappings.find(m => m.targetField === identifierField);
    if (!identifierMapping) {
      return res.status(400).json({ error: `No mapping for identifier field: ${identifierField}` });
    }
    
    // Extract all identifier values for batch lookup
    const identifierValues = records
      .map(row => row[identifierMapping.sourceColumn]?.trim())
      .filter(v => v);
    
    // Batch fetch all existing entities
    console.log(`[Import] Batch fetching existing records...`);
    const { data: existingEntities } = await supabase
      .from(tableName)
      .select('id, ' + identifierField)
      .in(identifierField, identifierValues);
    
    const existingMap = new Map();
    (existingEntities || []).forEach(e => {
      existingMap.set(e[identifierField], e.id);
    });
    console.log(`[Import] Found ${existingMap.size} existing records`);
    
    let jobId = null;
    try {
      const { data: job } = await supabase
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
      
      if (job) jobId = job.id;
    } catch (e) {
      console.log('[Import] Could not create job record');
    }
    
    let createdRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    let errorRows = 0;
    const errorLog = [];
    const notesToCreate = [];
    
    // Process records in batches
    const BATCH_SIZE = 50;
    
    for (let batchStart = 0; batchStart < records.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, records.length);
      const batch = records.slice(batchStart, batchEnd);
      
      console.log(`[Import] Processing batch ${batchStart + 1}-${batchEnd} of ${records.length}`);
      
      const toInsert = [];
      const toUpdate = [];
      
      for (let i = 0; i < batch.length; i++) {
        const rowIndex = batchStart + i;
        const row = batch[i];
        const identifierValue = row[identifierMapping.sourceColumn]?.trim();
        
        if (!identifierValue) {
          skippedRows++;
          errorLog.push({ row: rowIndex + 1, error: 'Empty identifier value' });
          continue;
        }
        
        const coreData = {};
        let noteContent = null;
        
        for (const mapping of mappings) {
          if (!mapping.sourceColumn || !mapping.targetField) continue;
          
          let value = row[mapping.sourceColumn];
          
          if (mapping.clearOnEmpty && (!value || value.trim() === '')) {
            value = null;
          }
          
          if (value !== null && mapping.targetType === 'date' && mapping.dateFormat) {
            const parsedDate = parseDate(value, mapping.dateFormat);
            if (parsedDate) value = parsedDate;
          }
          
          if (mapping.targetField === '__add_note__') {
            if (value && typeof value === 'string' && value.trim()) {
              noteContent = value.trim();
            }
            continue;
          }
          
          if (mapping.targetField.startsWith('custom:')) {
            // Skip custom fields for now - handle after entity creation
            continue;
          } else {
            if (value === null || (typeof value === 'string' && value.trim() !== '')) {
              coreData[mapping.targetField] = value === null ? null : value.trim();
            }
          }
        }
        
        const existingId = existingMap.get(identifierValue);
        
        if (existingId) {
          toUpdate.push({ id: existingId, data: coreData, noteContent, identifierValue, rowIndex });
        } else {
          toInsert.push({ data: coreData, noteContent, identifierValue, rowIndex });
        }
      }
      
      // Batch insert new records
      if (toInsert.length > 0) {
        const insertData = toInsert.map(r => r.data);
        const { data: inserted, error: insertError } = await supabase
          .from(tableName)
          .insert(insertData)
          .select('id, ' + identifierField);
        
        if (insertError) {
          console.log(`[Import] Batch insert error: ${insertError.message}`);
          toInsert.forEach(r => {
            errorRows++;
            errorLog.push({ row: r.rowIndex + 1, identifier: r.identifierValue, error: insertError.message });
          });
        } else {
          createdRows += inserted.length;
          
          // Map back inserted IDs and collect notes
          inserted.forEach(entity => {
            const original = toInsert.find(r => r.data[identifierField] === entity[identifierField]);
            if (original && original.noteContent) {
              notesToCreate.push({
                organization_id: entity.id,
                member_id: session.data.memberId,
                content: original.noteContent,
                attachments: [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              });
            }
            existingMap.set(entity[identifierField], entity.id);
          });
        }
      }
      
      // Update existing records one by one (can't batch updates with different data)
      for (const updateItem of toUpdate) {
        if (Object.keys(updateItem.data).length > 0) {
          const { error: updateError } = await supabase
            .from(tableName)
            .update(updateItem.data)
            .eq('id', updateItem.id);
          
          if (updateError) {
            errorRows++;
            errorLog.push({ row: updateItem.rowIndex + 1, identifier: updateItem.identifierValue, error: updateError.message });
            continue;
          }
        }
        updatedRows++;
        
        if (updateItem.noteContent && entityType === 'organization') {
          notesToCreate.push({
            organization_id: updateItem.id,
            member_id: session.data.memberId,
            content: updateItem.noteContent,
            attachments: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
        }
      }
    }
    
    // Batch insert all notes at once
    if (notesToCreate.length > 0 && entityType === 'organization') {
      console.log(`[Import] Creating ${notesToCreate.length} notes...`);
      const { error: notesError } = await supabase
        .from('organization_note')
        .insert(notesToCreate);
      
      if (notesError) {
        console.log(`[Import] Failed to create notes: ${notesError.message}`);
      } else {
        console.log(`[Import] Created ${notesToCreate.length} notes successfully`);
      }
    }
    
    // Handle custom fields (simplified - skip for performance if needed)
    const customMappings = mappings.filter(m => m.targetField?.startsWith('custom:'));
    if (customMappings.length > 0) {
      console.log(`[Import] Processing ${customMappings.length} custom field mappings...`);
      
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const identifierValue = row[identifierMapping.sourceColumn]?.trim();
        if (!identifierValue) continue;
        
        const entityId = existingMap.get(identifierValue);
        if (!entityId) continue;
        
        for (const mapping of customMappings) {
          if (!mapping.preferenceFieldId) continue;
          
          let value = row[mapping.sourceColumn];
          if (mapping.clearOnEmpty && (!value || value.trim() === '')) {
            value = null;
          }
          
          if (value !== null && mapping.targetType === 'date' && mapping.dateFormat) {
            const parsedDate = parseDate(value, mapping.dateFormat);
            if (parsedDate) value = parsedDate;
          }
          
          // Upsert custom field value
          const { error: upsertError } = await supabase
            .from(customValueTable)
            .upsert({
              [entityIdField]: entityId,
              preference_field_id: mapping.preferenceFieldId,
              value: value?.trim?.() || value
            }, {
              onConflict: `${entityIdField},preference_field_id`
            });
          
          if (upsertError) {
            console.log(`[Import] Custom field upsert error: ${upsertError.message}`);
          }
        }
      }
    }
    
    const processedRows = createdRows + updatedRows;
    
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
    
    console.log(`[Import] Complete: ${createdRows} created, ${updatedRows} updated, ${skippedRows} skipped, ${errorRows} errors`);
    
    res.json({
      success: true,
      jobId,
      created: createdRows,
      updated: updatedRows,
      skipped: skippedRows,
      errors: errorRows,
      notesCreated: notesToCreate.length,
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
