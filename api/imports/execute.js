import { createClient } from '@supabase/supabase-js';
import { getSession } from '../_lib/session.js';
import { parseMultipartForm } from '../_lib/multipart.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Parse boolean values (true/false/yes/no) case-insensitively
function parseBoolean(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim().toLowerCase();
  if (['true', 'yes', '1', 'y', 't'].includes(str)) return true;
  if (['false', 'no', '0', 'n', 'f'].includes(str)) return false;
  return null;
}

// Helper function to parse date strings based on format
// Returns ISO date string in UTC to avoid timezone shifts
function parseDate(dateStr, format) {
  if (!dateStr || !format) return null;
  
  const str = dateStr.trim();
  if (!str) return null;
  
  const parts = str.split(/[\/\-\.]/);
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
  
  // Return ISO string - this will be in UTC format (e.g., "2018-05-11T00:00:00.000Z")
  return date.toISOString();
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
    
    // For member imports with email identifier, try using the SQL function (much faster)
    if (entityType === 'member' && identifierField === 'email') {
      console.log('[Import] Attempting SQL function import...');
      
      // Debug: Log all mappings to see what we're working with
      console.log('[Import] All mappings:', JSON.stringify(mappings, null, 2));
      
      // Find created_on mapping specifically for debugging
      const createdOnMapping = mappings.find(m => m.targetField === 'created_on');
      if (createdOnMapping) {
        console.log('[Import] created_on mapping found:', JSON.stringify(createdOnMapping));
        console.log('[Import] created_on mapping targetType:', createdOnMapping.targetType);
        console.log('[Import] created_on mapping dateFormat:', createdOnMapping.dateFormat);
      } else {
        console.log('[Import] WARNING: No created_on mapping found in mappings!');
      }
      
      // Collect notes by email (lowercase) for creation after SQL RPC
      // Use array to support multiple notes per email
      const notesByEmail = new Map();
      
      // Transform records to the format expected by the SQL function
      const batch = records.map((row, index) => {
        const record = { row_index: index };
        let recordEmail = null;
        let recordNote = null;
        
        for (const mapping of mappings) {
          if (!mapping.sourceColumn || !mapping.targetField) continue;
          
          let value = row[mapping.sourceColumn];
          if (value !== undefined && value !== null) {
            value = String(value).trim();
          }
          
          // Debug: Log created_on specifically before parsing
          if (mapping.targetField === 'created_on' && index < 3) {
            console.log(`[Import] Row ${index} created_on RAW value from CSV: "${value}"`);
            console.log(`[Import] Row ${index} created_on targetType: "${mapping.targetType}", dateFormat: "${mapping.dateFormat}"`);
          }
          
          // Parse dates if needed
          if (value && mapping.targetType === 'date' && mapping.dateFormat) {
            const parsed = parseDate(value, mapping.dateFormat);
            
            // Debug: Log date parsing for created_on
            if (mapping.targetField === 'created_on' && index < 3) {
              console.log(`[Import] Row ${index} created_on PARSED value: "${parsed}"`);
            }
            
            if (parsed) value = parsed;
          } else if (mapping.targetField === 'created_on' && index < 3) {
            console.log(`[Import] Row ${index} created_on SKIPPED parsing - targetType: "${mapping.targetType}", dateFormat: "${mapping.dateFormat}", value: "${value}"`);
          }
          
          // Capture note content for later creation
          if (mapping.targetField === '__add_note__') {
            if (value && typeof value === 'string' && value.trim()) {
              recordNote = value.trim();
            }
            continue;
          }
          
          // Map to SQL function expected fields
          if (mapping.targetField === 'email') {
            record.email = value;
            recordEmail = value;
          }
          else if (mapping.targetField === 'first_name') record.first_name = value;
          else if (mapping.targetField === 'last_name') record.last_name = value;
          else if (mapping.targetField === 'mobile') record.mobile = value;
          else if (mapping.targetField === 'landline') record.landline = value;
          else if (mapping.targetField === 'job_title') record.job_title = value;
          else if (mapping.targetField === 'role_id') record.role_name = value; // Pass name, SQL will lookup
          else if (mapping.targetField === 'role_effective_from') record.role_effective_from = value;
          else if (mapping.targetField === 'organization_id') record.organization_name = value; // Pass name, SQL will lookup
          else if (mapping.targetField === 'created_on') record.created_on = value;
        }
        
        // Store note by lowercase email for lookup after SQL RPC (support multiple notes per email)
        if (recordEmail && recordNote) {
          const emailKey = recordEmail.toLowerCase().trim();
          if (!notesByEmail.has(emailKey)) {
            notesByEmail.set(emailKey, []);
          }
          notesByEmail.get(emailKey).push(recordNote);
        }
        
        return record;
      });
      
      // Count total notes collected
      let totalNotesCollected = 0;
      for (const notes of notesByEmail.values()) {
        totalNotesCollected += notes.length;
      }
      console.log(`[Import] Notes collected: ${totalNotesCollected} notes for ${notesByEmail.size} members`);
      
      // Debug: Log first 3 records to verify created_on is set
      console.log('[Import] First 3 batch records created_on values:');
      for (let i = 0; i < Math.min(3, batch.length); i++) {
        console.log(`[Import] Record ${i} created_on: "${batch[i].created_on}"`);
      }
      
      // Process in batches of 1000 to avoid memory issues
      const SQL_BATCH_SIZE = 1000;
      let totalCreated = 0;
      let totalUpdated = 0;
      let totalSkipped = 0;
      let totalErrors = 0;
      
      // Debug: log first record to verify data structure
      if (batch.length > 0) {
        console.log('[Import] Sample record:', JSON.stringify(batch[0]));
        const withEmails = batch.filter(r => r.email && r.email.trim());
        console.log(`[Import] Records with emails: ${withEmails.length} of ${batch.length}`);
      }
      
      for (let i = 0; i < batch.length; i += SQL_BATCH_SIZE) {
        const chunk = batch.slice(i, i + SQL_BATCH_SIZE);
        console.log(`[Import] SQL batch ${i + 1}-${Math.min(i + SQL_BATCH_SIZE, batch.length)} of ${batch.length}`);
        
        const { data, error } = await supabase.rpc('process_member_import_batch', {
          batch: chunk
        });
        
        console.log(`[Import] RPC response:`, JSON.stringify({ data, error }));
        
        if (error) {
          console.log(`[Import] SQL function failed: ${error.message}, falling back to JS...`);
          break; // Fall through to JS implementation
        }
        
        if (data) {
          totalCreated += data.created || 0;
          totalUpdated += data.updated || 0;
          totalSkipped += data.skipped || 0;
          totalErrors += data.errors || 0;
          if (data.first_error) {
            console.log(`[Import] First error in batch: ${data.first_error}`);
          }
        }
        
        // If we processed all batches successfully, handle notes then return
        if (i + SQL_BATCH_SIZE >= batch.length) {
          console.log(`[Import] SQL function complete: ${totalCreated} created, ${totalUpdated} updated`);
          
          // Create member notes if any were collected
          let notesCreated = 0;
          if (notesByEmail.size > 0) {
            console.log(`[Import] Creating notes for ${notesByEmail.size} members...`);
            
            // Fetch member IDs by their emails
            const emailsWithNotes = Array.from(notesByEmail.keys());
            const { data: membersWithNotes, error: memberLookupError } = await supabase
              .from('member')
              .select('id, email')
              .not('email', 'is', null);
            
            if (memberLookupError) {
              console.log(`[Import] Error fetching members for notes: ${memberLookupError.message}`);
            } else if (membersWithNotes) {
              // Build lowercase email -> member ID map
              const memberIdByEmail = new Map();
              membersWithNotes.forEach(m => {
                if (m.email) {
                  memberIdByEmail.set(m.email.toLowerCase().trim(), m.id);
                }
              });
              
              // Create notes for members we found (support multiple notes per member)
              const notesToInsert = [];
              for (const [emailLower, noteContents] of notesByEmail) {
                const memberId = memberIdByEmail.get(emailLower);
                if (memberId) {
                  for (const noteContent of noteContents) {
                    notesToInsert.push({
                      target_member_id: memberId,
                      author_member_id: session.data.memberId,
                      content: noteContent,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString()
                    });
                  }
                }
              }
              
              if (notesToInsert.length > 0) {
                console.log(`[Import] Inserting ${notesToInsert.length} member notes...`);
                const { error: notesError } = await supabase
                  .from('member_note')
                  .insert(notesToInsert);
                
                if (notesError) {
                  console.log(`[Import] Failed to create member notes: ${notesError.message}`);
                } else {
                  notesCreated = notesToInsert.length;
                  console.log(`[Import] Created ${notesCreated} member notes successfully`);
                }
              }
            }
          }
          
          return res.json({
            success: true,
            created: totalCreated,
            updated: totalUpdated,
            skipped: totalSkipped,
            errors: totalErrors,
            notesCreated,
            summary: {
              totalRows: records.length,
              processedRows: totalCreated + totalUpdated,
              createdRows: totalCreated,
              updatedRows: totalUpdated,
              skippedRows: totalSkipped,
              errorRows: totalErrors,
              notesCreated
            }
          });
        }
      }
    }
    
    console.log('[Import] Using JavaScript import...');
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
    
    // For email field, normalize to lowercase for case-insensitive matching
    const isEmailIdentifier = identifierField === 'email';
    const normalizedIdentifierValues = isEmailIdentifier 
      ? identifierValues.map(v => v.toLowerCase())
      : identifierValues;
    
    // Batch fetch all existing entities
    console.log(`[Import] Batch fetching existing records... (case-insensitive: ${isEmailIdentifier})`);
    
    let existingEntities = [];
    if (isEmailIdentifier) {
      // For email, fetch ALL members with emails and build a local lowercase map
      // This is much faster than doing many ilike queries
      const { data, error } = await supabase
        .from(tableName)
        .select('id, email')
        .not('email', 'is', null)
        .neq('email', '');
      
      if (error) {
        console.log(`[Import] Error fetching existing emails: ${error.message}`);
      }
      existingEntities = data || [];
    } else {
      const { data } = await supabase
        .from(tableName)
        .select('id, ' + identifierField)
        .in(identifierField, identifierValues);
      existingEntities = data || [];
    }
    
    // Build lookup map - normalize email keys to lowercase for consistent matching
    const existingMap = new Map();
    existingEntities.forEach(e => {
      const key = isEmailIdentifier && e[identifierField] 
        ? e[identifierField].toLowerCase().trim()
        : e[identifierField];
      existingMap.set(key, e.id);
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
    const memberNotesToCreate = [];
    
    // Check if we need to look up roles (for member imports with role mapping)
    const hasRoleMapping = entityType === 'member' && mappings.some(m => m.targetField === 'role_id');
    let roleMap = new Map();
    
    if (hasRoleMapping) {
      console.log('[Import] Fetching roles for lookup...');
      const { data: roles } = await supabase
        .from('role')
        .select('id, name');
      
      if (roles) {
        roles.forEach(role => {
          // Store by lowercase name for case-insensitive matching
          roleMap.set(role.name.toLowerCase().trim(), role.id);
        });
        console.log(`[Import] Loaded ${roleMap.size} roles for lookup`);
      }
    }
    
    // Check if we need to look up organizations (for member imports with organization mapping)
    const hasOrgMapping = entityType === 'member' && mappings.some(m => m.targetField === 'organization_id');
    let orgMap = new Map();
    
    if (hasOrgMapping) {
      console.log('[Import] Fetching organizations for lookup...');
      const { data: orgs } = await supabase
        .from('organization')
        .select('id, name');
      
      if (orgs) {
        orgs.forEach(org => {
          // Store by lowercase name for case-insensitive matching
          orgMap.set(org.name.toLowerCase().trim(), org.id);
        });
        console.log(`[Import] Loaded ${orgMap.size} organizations for lookup`);
      }
    }
    
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
          
          // Handle role_id lookup - convert role name to UUID
          if (mapping.targetField === 'role_id' && value && typeof value === 'string') {
            const roleName = value.trim().toLowerCase();
            const roleId = roleMap.get(roleName);
            if (roleId) {
              coreData['role_id'] = roleId;
            } else {
              console.log(`[Import] Role not found: "${value}"`);
            }
            continue;
          }
          
          // Handle organization_id lookup - convert organization name to UUID
          if (mapping.targetField === 'organization_id' && value && typeof value === 'string') {
            const orgName = value.trim().toLowerCase();
            const orgId = orgMap.get(orgName);
            if (orgId) {
              coreData['organization_id'] = orgId;
            } else {
              console.log(`[Import] Organization not found: "${value}"`);
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
        
        // Normalize identifier for lookup (lowercase for email)
        const lookupKey = isEmailIdentifier ? identifierValue.toLowerCase() : identifierValue;
        const existingId = existingMap.get(lookupKey);
        
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
          // Handle unique constraint violation (code 23505) - likely duplicate email
          if (insertError.code === '23505' && isEmailIdentifier) {
            console.log(`[Import] Unique constraint violation, falling back to individual inserts...`);
            // Fall back to individual inserts to identify which rows are duplicates
            for (const record of toInsert) {
              const { data: singleInserted, error: singleError } = await supabase
                .from(tableName)
                .insert(record.data)
                .select('id, ' + identifierField)
                .single();
              
              if (singleError) {
                if (singleError.code === '23505') {
                  // This is a duplicate - try to find and update instead
                  const { data: existing } = await supabase
                    .from(tableName)
                    .select('id')
                    .ilike('email', record.data.email)
                    .single();
                  
                  if (existing) {
                    const { error: updateError } = await supabase
                      .from(tableName)
                      .update(record.data)
                      .eq('id', existing.id);
                    
                    if (!updateError) {
                      updatedRows++;
                      existingMap.set(record.data.email?.toLowerCase(), existing.id);
                    } else {
                      errorRows++;
                      errorLog.push({ row: record.rowIndex + 1, identifier: record.identifierValue, error: 'Failed to update existing record' });
                    }
                  } else {
                    errorRows++;
                    errorLog.push({ row: record.rowIndex + 1, identifier: record.identifierValue, error: 'Duplicate email exists' });
                  }
                } else {
                  errorRows++;
                  errorLog.push({ row: record.rowIndex + 1, identifier: record.identifierValue, error: singleError.message });
                }
              } else if (singleInserted) {
                createdRows++;
                const lookupKey = isEmailIdentifier && singleInserted[identifierField]
                  ? singleInserted[identifierField].toLowerCase()
                  : singleInserted[identifierField];
                existingMap.set(lookupKey, singleInserted.id);
              }
            }
          } else {
            console.log(`[Import] Batch insert error: ${insertError.message}`);
            toInsert.forEach(r => {
              errorRows++;
              errorLog.push({ row: r.rowIndex + 1, identifier: r.identifierValue, error: insertError.message });
            });
          }
        } else {
          createdRows += inserted.length;
          
          // Map back inserted IDs and collect notes
          inserted.forEach(entity => {
            const entityIdentifier = entity[identifierField];
            const lookupKey = isEmailIdentifier && entityIdentifier 
              ? entityIdentifier.toLowerCase() 
              : entityIdentifier;
            const original = toInsert.find(r => {
              const origKey = isEmailIdentifier && r.data[identifierField]
                ? r.data[identifierField].toLowerCase()
                : r.data[identifierField];
              return origKey === lookupKey;
            });
            if (original && original.noteContent) {
              if (entityType === 'organization') {
                notesToCreate.push({
                  organization_id: entity.id,
                  member_id: session.data.memberId,
                  content: original.noteContent,
                  attachments: [],
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                });
              } else if (entityType === 'member') {
                memberNotesToCreate.push({
                  target_member_id: entity.id,
                  author_member_id: session.data.memberId,
                  content: original.noteContent,
                  attachments: [],
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                });
              }
            }
            existingMap.set(lookupKey, entity.id);
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
        
        if (updateItem.noteContent) {
          if (entityType === 'organization') {
            notesToCreate.push({
              organization_id: updateItem.id,
              member_id: session.data.memberId,
              content: updateItem.noteContent,
              attachments: [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            });
          } else if (entityType === 'member') {
            memberNotesToCreate.push({
              target_member_id: updateItem.id,
              author_member_id: session.data.memberId,
              content: updateItem.noteContent,
              attachments: [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            });
          }
        }
      }
    }
    
    // Batch insert all organization notes at once
    if (notesToCreate.length > 0 && entityType === 'organization') {
      console.log(`[Import] Creating ${notesToCreate.length} notes...`);
      const { error: notesError } = await supabase
        .from('organization_note')
        .insert(notesToCreate);
      
      if (notesError) {
        console.log(`[Import] Failed to create organization notes: ${notesError.message}`);
      } else {
        console.log(`[Import] Created ${notesToCreate.length} organization notes successfully`);
      }
    }
    
    // Batch insert all member notes at once
    if (memberNotesToCreate.length > 0 && entityType === 'member') {
      console.log(`[Import] Creating ${memberNotesToCreate.length} member notes...`);
      const { error: memberNotesError } = await supabase
        .from('member_note')
        .insert(memberNotesToCreate);
      
      if (memberNotesError) {
        console.log(`[Import] Failed to create member notes: ${memberNotesError.message}`);
      } else {
        console.log(`[Import] Created ${memberNotesToCreate.length} member notes successfully`);
      }
    }
    
    // Handle communication preferences for member imports
    const commMappings = mappings.filter(m => m.targetField?.startsWith('comm:'));
    if (entityType === 'member' && commMappings.length > 0) {
      console.log(`[Import] Processing ${commMappings.length} communication preference mappings...`);
      
      const commPrefsToUpsert = [];
      
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const identifierValue = row[identifierMapping.sourceColumn]?.trim();
        if (!identifierValue) continue;
        
        const lookupKey = isEmailIdentifier ? identifierValue.toLowerCase() : identifierValue;
        const entityId = existingMap.get(lookupKey);
        if (!entityId) continue;
        
        for (const mapping of commMappings) {
          const categoryId = mapping.targetField.replace('comm:', '');
          if (!categoryId) continue;
          
          const rawValue = row[mapping.sourceColumn];
          const optedIn = parseBoolean(rawValue);
          
          // Only upsert if we have a valid boolean value
          if (optedIn !== null) {
            commPrefsToUpsert.push({
              member_id: entityId,
              category_id: categoryId,
              opted_in: optedIn
            });
          }
        }
      }
      
      // Batch upsert communication preferences
      if (commPrefsToUpsert.length > 0) {
        console.log(`[Import] Upserting ${commPrefsToUpsert.length} communication preferences...`);
        
        // Process in smaller batches to avoid memory issues
        const COMM_BATCH_SIZE = 500;
        for (let i = 0; i < commPrefsToUpsert.length; i += COMM_BATCH_SIZE) {
          const chunk = commPrefsToUpsert.slice(i, i + COMM_BATCH_SIZE);
          
          const { error: commError } = await supabase
            .from('member_communication_preference')
            .upsert(chunk, {
              onConflict: 'member_id,category_id'
            });
          
          if (commError) {
            console.log(`[Import] Communication preference upsert error: ${commError.message}`);
          }
        }
        
        console.log(`[Import] Communication preferences processed successfully`);
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
    
    const totalNotesCreated = notesToCreate.length + memberNotesToCreate.length;
    
    res.json({
      success: true,
      jobId,
      created: createdRows,
      updated: updatedRows,
      skipped: skippedRows,
      errors: errorRows,
      notesCreated: totalNotesCreated,
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
