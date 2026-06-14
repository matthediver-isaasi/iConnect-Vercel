import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';
import { parseMultipartForm } from '../_lib/multipart.js';
import { parseImportFile } from '../_lib/importFileParser.js';

// How long a single invocation is allowed to spend processing rows before it
// stops and asks the client to continue from the returned cursor. Kept well
// under the 60s function ceiling to leave room for parsing + final writes.
const CHUNK_TIME_BUDGET_MS = 40000;

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

// --- Import job history helpers -------------------------------------------
// Each import run is recorded in csv_import_job so the "Recent Imports" panel
// can show history and offer "reuse setup". Writes are best-effort: a logging
// failure must never abort the import itself.
async function startImportJob({ tenantId, entityType, fileName, totalRows, mappings, identifierField }) {
  try {
    const activeMappings = (mappings || []).filter((m) => m && m.targetField);
    const { data: job, error } = await supabase
      .from('csv_import_job')
      .insert({
        tenant_id: tenantId,
        entity_type: entityType,
        status: 'running',
        file_name: fileName,
        total_rows: totalRows,
        identifier_field: identifierField,
        mappings: activeMappings,
      })
      .select('id')
      .single();
    if (error) {
      console.log('[Import] Could not create job record:', error.message);
      return null;
    }
    return job?.id || null;
  } catch (e) {
    console.log('[Import] Could not create job record:', e.message);
    return null;
  }
}

// Persist running progress to the job row. Counts are CUMULATIVE across chunks
// (the client carries the running totals and re-sends them, the server adds the
// chunk deltas before calling this). `newErrors` are this chunk's errors, which
// are appended to the existing list (capped) so the final record keeps a sample
// from every chunk. Best-effort: never abort the import on a logging failure.
async function updateImportJobProgress(jobId, { created = 0, updated = 0, errors = 0, newErrors = [], done = false } = {}) {
  if (!jobId) return;
  try {
    const processed = created + updated;
    const update = {
      status: done ? (errors > 0 ? 'completed_with_errors' : 'completed') : 'running',
      processed_count: processed,
      success_count: processed,
      created_count: created,
      updated_count: updated,
      error_count: errors,
      updated_at: new Date().toISOString(),
    };
    if (Array.isArray(newErrors) && newErrors.length > 0) {
      const { data: existing } = await supabase
        .from('csv_import_job')
        .select('errors')
        .eq('id', jobId)
        .single();
      const prev = Array.isArray(existing?.errors) ? existing.errors : [];
      update.errors = prev.concat(newErrors).slice(0, 100);
    }
    await supabase
      .from('csv_import_job')
      .update(update)
      .eq('id', jobId);
  } catch (e) {
    console.log('[Import] Could not update job record:', e.message);
  }
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
  
  let importTenantId = null;
  try {
    const { data: sessionMember } = await supabase
      .from('member')
      .select('tenant_id')
      .eq('id', session.data.memberId)
      .single();
    importTenantId = sessionMember?.tenant_id || null;
  } catch (e) {
    console.log('[Import] Could not resolve tenant_id from session member:', e.message);
  }

  // Members and organizations are tenant-scoped. Without a tenant we would
  // create rows invisible to every tenant-scoped view (the original bug), so
  // fail clearly instead of silently importing orphaned records.
  if (!importTenantId) {
    return res.status(400).json({
      error: 'Could not determine your organisation for this import. Please sign out and back in, then try again.'
    });
  }
  
  // The cursor + running totals are carried by the client across chunk calls.
  // Declared in the outer scope so the catch handler can mark the right job
  // record as failed.
  let jobId = null;
  let offset = 0;
  const chunkStartTime = Date.now();
  const timeBudgetReached = () => Date.now() - chunkStartTime > CHUNK_TIME_BUDGET_MS;

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

    // Resumable cursor + running totals. The client re-sends the (already held)
    // file each chunk along with the prior response's offset, jobId, and totals
    // so each invocation processes only a time-budgeted slice of rows.
    offset = Math.max(0, parseInt(fields.offset, 10) || 0);
    const incomingJobId = fields.jobId || null;
    // Once the SQL fast path has fallen back to the JS path, the client echoes
    // `forcePath=js` so every later chunk stays on the JS path (the path choice
    // must be stable across chunks or a later chunk could re-pick the failing
    // SQL path mid-run).
    const forceJsPath = fields.forcePath === 'js';
    let runningCreated = Math.max(0, parseInt(fields.created, 10) || 0);
    let runningUpdated = Math.max(0, parseInt(fields.updated, 10) || 0);
    let runningSkipped = Math.max(0, parseInt(fields.skipped, 10) || 0);
    let runningErrors = Math.max(0, parseInt(fields.errors, 10) || 0);
    let runningNotes = Math.max(0, parseInt(fields.notesCreated, 10) || 0);
    
    // The identifier column must be mapped for both the fast and JS paths.
    // Validate before we create a job record so we never leave a dangling
    // "running" row.
    const identifierMapping = mappings.find(m => m.targetField === identifierField);
    if (!identifierMapping) {
      return res.status(400).json({ error: `No mapping for identifier field: ${identifierField}` });
    }
    
    const { records, isXlsx } = await parseImportFile(file);
    
    console.log(`[Import] Parsed ${records.length} rows (${isXlsx ? 'xlsx' : 'csv'}), resuming from offset ${offset}`);
    
    const tableName = entityType === 'organization' ? 'organization' : 'member';
    
    // Record this run up-front (first chunk only) so it appears in the "Recent
    // Imports" panel and its mapping can be reused later. Later chunks reuse the
    // same job id so there is exactly one job row per import.
    if (incomingJobId) {
      jobId = incomingJobId;
    } else {
      jobId = await startImportJob({
        tenantId: importTenantId,
        entityType,
        fileName: file.originalname || 'import.csv',
        totalRows: records.length,
        mappings,
        identifierField,
      });
    }
    
    // The SQL fast path only persists this fixed set of fields. Any mapping
    // outside this set (biography, social URLs, login flags, external_id, and
    // all custom:* / comm:* fields) would be silently dropped by the fast path,
    // so when the import maps any such field we MUST take the JS path instead.
    const SQL_FASTPATH_FIELDS = new Set([
      'email', 'first_name', 'last_name', 'mobile', 'landline', 'job_title',
      'role_id', 'role_effective_from', 'organization_id', 'created_on', '__add_note__',
    ]);
    const allMappingsFastPathSafe = mappings.every(
      (m) => !m.targetField || SQL_FASTPATH_FIELDS.has(m.targetField)
    );

    // Set to true only if the SQL function fails on the very first batch and we
    // fall back to the JS path. Surfaced to the client so later chunks stay on
    // the JS path.
    let firstBatchRpcFailed = false;

    // For member imports with email identifier, use the SQL function (much faster).
    if (!forceJsPath && entityType === 'member' && identifierField === 'email' && allMappingsFastPathSafe) {
      console.log('[Import] Attempting SQL function import...');
      
      // Collect notes by email (lowercase) for creation after the final SQL
      // batch. Rebuilt every chunk (cheap, in-memory) but only inserted once,
      // on the chunk that finishes the import.
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
          
          // Parse dates if needed
          if (value && mapping.targetType === 'date' && mapping.dateFormat) {
            const parsed = parseDate(value, mapping.dateFormat);
            if (parsed) value = parsed;
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
            // Normalize to lowercase so imported members match the app-wide
            // convention and resolve in the login flow (lower(email) lookup).
            const normalizedEmail = value ? value.toLowerCase() : value;
            record.email = normalizedEmail;
            recordEmail = normalizedEmail;
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
      
      // Process SQL batches resumably: start at the cursor and stop before the
      // time budget; the client loops until done.
      const SQL_BATCH_SIZE = 1000;
      let chunkCreated = 0;
      let chunkUpdated = 0;
      let chunkSkipped = 0;
      let chunkErrors = 0;

      if (offset === 0 && batch.length > 0) {
        const withEmails = batch.filter(r => r.email && r.email.trim());
        console.log(`[Import] Records with emails: ${withEmails.length} of ${batch.length}`);
      }

      let sqlOffset = offset;
      let sqlDone = false;
      for (let i = offset; i < batch.length; i += SQL_BATCH_SIZE) {
        // Always process at least one batch per invocation, then respect budget.
        if (i > offset && timeBudgetReached()) break;

        const chunk = batch.slice(i, i + SQL_BATCH_SIZE);
        console.log(`[Import] SQL batch ${i + 1}-${Math.min(i + SQL_BATCH_SIZE, batch.length)} of ${batch.length}`);

        const { data, error } = await supabase.rpc('process_member_import_batch', {
          batch: chunk,
          p_tenant_id: importTenantId
        });

        if (error) {
          // Only safe to fall back to the JS path when nothing has been imported
          // yet for the whole run (very first batch of the very first chunk).
          if (i === 0) {
            console.log(`[Import] SQL function failed: ${error.message}, falling back to JS...`);
            firstBatchRpcFailed = true;
            break;
          }
          throw new Error(`Import failed mid-run (SQL batch at row ${i + 1}): ${error.message}`);
        }

        if (data) {
          chunkCreated += data.created || 0;
          chunkUpdated += data.updated || 0;
          chunkSkipped += data.skipped || 0;
          chunkErrors += data.errors || 0;
          if (data.first_error) {
            console.log(`[Import] First error in batch: ${data.first_error}`);
          }
        }

        sqlOffset = i + SQL_BATCH_SIZE;
        if (sqlOffset >= batch.length) sqlDone = true;
      }

      if (!firstBatchRpcFailed) {
        runningCreated += chunkCreated;
        runningUpdated += chunkUpdated;
        runningSkipped += chunkSkipped;
        runningErrors += chunkErrors;

        if (!sqlDone) {
          // More batches remain — persist progress and ask the client to continue.
          await updateImportJobProgress(jobId, {
            created: runningCreated,
            updated: runningUpdated,
            errors: runningErrors,
            done: false,
          });
          return res.json({
            success: true,
            done: false,
            jobId,
            offset: Math.min(sqlOffset, records.length),
            created: runningCreated,
            updated: runningUpdated,
            skipped: runningSkipped,
            errors: runningErrors,
            notesCreated: runningNotes,
            totalRows: records.length,
          });
        }

        // Final SQL chunk: create any collected notes, finalize and return.
        console.log(`[Import] SQL function complete: ${runningCreated} created, ${runningUpdated} updated`);

        let notesCreated = 0;
        if (notesByEmail.size > 0) {
          console.log(`[Import] Creating notes for ${notesByEmail.size} members...`);

          const { data: membersWithNotes, error: memberLookupError } = await supabase
            .from('member')
            .select('id, email')
            .eq('tenant_id', importTenantId)
            .not('email', 'is', null);

          if (memberLookupError) {
            console.log(`[Import] Error fetching members for notes: ${memberLookupError.message}`);
          } else if (membersWithNotes) {
            const memberIdByEmail = new Map();
            membersWithNotes.forEach(m => {
              if (m.email) {
                memberIdByEmail.set(m.email.toLowerCase().trim(), m.id);
              }
            });

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
        runningNotes += notesCreated;

        await updateImportJobProgress(jobId, {
          created: runningCreated,
          updated: runningUpdated,
          errors: runningErrors,
          done: true,
        });

        return res.json({
          success: true,
          done: true,
          jobId,
          offset: records.length,
          created: runningCreated,
          updated: runningUpdated,
          skipped: runningSkipped,
          errors: runningErrors,
          notesCreated: runningNotes,
          summary: {
            totalRows: records.length,
            processedRows: runningCreated + runningUpdated,
            createdRows: runningCreated,
            updatedRows: runningUpdated,
            skippedRows: runningSkipped,
            errorRows: runningErrors,
            notesCreated: runningNotes
          }
        });
      }
      // else: firstBatchRpcFailed at offset 0 — fall through to the JS path.
    }
    
    console.log('[Import] Using JavaScript import...');
    // Surfaced to the client so that, once we are on the JS path (either by
    // mapping shape or by SQL fallback), every later chunk stays on it.
    const jsPathHint = (forceJsPath || firstBatchRpcFailed) ? 'js' : null;

    const customValueTable = entityType === 'organization' 
      ? 'organization_preference_value' 
      : 'member_preference_value';
    const entityIdField = entityType === 'organization' ? 'organization_id' : 'member_id';
    
    // For email field, normalize to lowercase for case-insensitive matching
    const isEmailIdentifier = identifierField === 'email';
    
    // --- Per-invocation setup: existing entities, roles, orgs --------------
    // Re-built every chunk. Because each chunk does a fresh fetch, rows inserted
    // by earlier chunks are visible here, so cross-chunk de-duplication works
    // naturally (a member created in chunk 1 is updated, not re-created, later).
    console.log(`[Import] Batch fetching existing records... (case-insensitive: ${isEmailIdentifier})`);
    
    let existingEntities = [];
    if (isEmailIdentifier) {
      // For email, fetch ALL members with emails and build a local lowercase map
      // This is much faster than doing many ilike queries
      const { data, error } = await supabase
        .from(tableName)
        .select('id, email')
        .eq('tenant_id', importTenantId)
        .not('email', 'is', null)
        .neq('email', '');
      
      if (error) {
        console.log(`[Import] Error fetching existing emails: ${error.message}`);
      }
      existingEntities = data || [];
    } else {
      const allIdentifierValues = records
        .map(row => row[identifierMapping.sourceColumn]?.trim())
        .filter(v => v);
      const { data } = await supabase
        .from(tableName)
        .select('id, ' + identifierField)
        .eq('tenant_id', importTenantId)
        .in(identifierField, allIdentifierValues);
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
    
    let chunkCreated = 0;
    let chunkUpdated = 0;
    let chunkSkipped = 0;
    let chunkErrors = 0;
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
        .select('id, name')
        .eq('tenant_id', importTenantId);
      
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
        .select('id, name')
        .eq('tenant_id', importTenantId);
      
      if (orgs) {
        orgs.forEach(org => {
          // Store by lowercase name for case-insensitive matching
          orgMap.set(org.name.toLowerCase().trim(), org.id);
        });
        console.log(`[Import] Loaded ${orgMap.size} organizations for lookup`);
      }
    }
    
    // Process a time-budgeted slice of rows starting from the cursor.
    const BATCH_SIZE = 50;
    let sliceEnd = offset;
    
    for (let batchStart = offset; batchStart < records.length; batchStart += BATCH_SIZE) {
      // Always process at least one batch per invocation, then respect budget.
      if (batchStart > offset && timeBudgetReached()) break;

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
          chunkSkipped++;
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
          
          if (mapping.targetField.startsWith('custom:') || mapping.targetField.startsWith('comm:')) {
            // custom:* values go to *_preference_value and comm:* values go to
            // member_communication_preference, handled by their own blocks
            // below. They are NOT columns on the member/organization table, so
            // they must never be written into coreData (doing so makes the
            // insert/update fail with "column does not exist").
            continue;
          } else if (mapping.targetField === 'id') {
            continue;
          } else {
            if (value === null || (typeof value === 'string' && value.trim() !== '')) {
              let normalized = value === null ? null : value.trim();
              // Normalize email to lowercase to match the app-wide convention
              // and the login resolver's lower(email) lookup.
              if (normalized !== null && mapping.targetField === 'email') {
                normalized = normalized.toLowerCase();
              }
              coreData[mapping.targetField] = normalized;
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
        const insertData = toInsert.map(r => ({ ...r.data, tenant_id: importTenantId }));
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
                .insert({ ...record.data, tenant_id: importTenantId })
                .select('id, ' + identifierField)
                .single();
              
              if (singleError) {
                if (singleError.code === '23505') {
                  // This is a duplicate - try to find and update instead
                  const { data: existing } = await supabase
                    .from(tableName)
                    .select('id')
                    .eq('tenant_id', importTenantId)
                    .ilike('email', record.data.email)
                    .single();
                  
                  if (existing) {
                    const { error: updateError } = await supabase
                      .from(tableName)
                      .update(record.data)
                      .eq('id', existing.id);
                    
                    if (!updateError) {
                      chunkUpdated++;
                      existingMap.set(record.data.email?.toLowerCase(), existing.id);
                    } else {
                      chunkErrors++;
                      errorLog.push({ row: record.rowIndex + 1, identifier: record.identifierValue, error: 'Failed to update existing record' });
                    }
                  } else {
                    chunkErrors++;
                    errorLog.push({ row: record.rowIndex + 1, identifier: record.identifierValue, error: 'Duplicate email exists' });
                  }
                } else {
                  chunkErrors++;
                  errorLog.push({ row: record.rowIndex + 1, identifier: record.identifierValue, error: singleError.message });
                }
              } else if (singleInserted) {
                chunkCreated++;
                const lookupKey = isEmailIdentifier && singleInserted[identifierField]
                  ? singleInserted[identifierField].toLowerCase()
                  : singleInserted[identifierField];
                existingMap.set(lookupKey, singleInserted.id);
              }
            }
          } else {
            console.log(`[Import] Batch insert error: ${insertError.message}`);
            toInsert.forEach(r => {
              chunkErrors++;
              errorLog.push({ row: r.rowIndex + 1, identifier: r.identifierValue, error: insertError.message });
            });
          }
        } else {
          chunkCreated += inserted.length;
          
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
            chunkErrors++;
            errorLog.push({ row: updateItem.rowIndex + 1, identifier: updateItem.identifierValue, error: updateError.message });
            continue;
          }
        }
        chunkUpdated++;
        
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

      sliceEnd = batchEnd;
    }

    const done = sliceEnd >= records.length;
    
    // Batch insert this slice's organization notes at once
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
    
    // Batch insert this slice's member notes at once
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

    const chunkNotes = notesToCreate.length + memberNotesToCreate.length;
    
    // Handle communication preferences for this slice's member imports.
    // De-duplicated by (member_id, category_id) — a single upsert batch cannot
    // touch the same conflict target twice, and a member can legitimately
    // appear more than once across the file; last value wins.
    const commMappings = mappings.filter(m => m.targetField?.startsWith('comm:'));
    if (entityType === 'member' && commMappings.length > 0) {
      console.log(`[Import] Processing ${commMappings.length} communication preference mappings...`);
      
      const commPrefsByKey = new Map();
      
      for (let i = offset; i < sliceEnd; i++) {
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
            commPrefsByKey.set(`${entityId}|${categoryId}`, {
              member_id: entityId,
              category_id: categoryId,
              opted_in: optedIn,
              tenant_id: importTenantId
            });
          }
        }
      }
      
      const commPrefsToUpsert = Array.from(commPrefsByKey.values());
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
    
    // Handle custom fields for this slice. Previously this issued one upsert per
    // row per mapping (the main source of the timeout); now all custom values
    // for the slice are collected and upserted in batches. De-duplicated by
    // (entity_id, field_id) for the same reason as comm prefs above.
    const customMappings = mappings.filter(m => m.targetField?.startsWith('custom:'));
    if (customMappings.length > 0) {
      console.log(`[Import] Processing ${customMappings.length} custom field mappings...`);
      
      const customValuesByKey = new Map();
      
      for (let i = offset; i < sliceEnd; i++) {
        const row = records[i];
        const identifierValue = row[identifierMapping.sourceColumn]?.trim();
        if (!identifierValue) continue;
        
        // Look up the entity using the same normalized (lowercased for email)
        // key the core upsert uses.
        const lookupKey = isEmailIdentifier ? identifierValue.toLowerCase() : identifierValue;
        const entityId = existingMap.get(lookupKey);
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
          
          // The real column on member_preference_value /
          // organization_preference_value is `field_id` (NOT
          // `preference_field_id`); the unique constraint is on
          // (entity_id, field_id).
          customValuesByKey.set(`${entityId}|${mapping.preferenceFieldId}`, {
            [entityIdField]: entityId,
            field_id: mapping.preferenceFieldId,
            value: value?.trim?.() || value
          });
        }
      }
      
      const customValuesToUpsert = Array.from(customValuesByKey.values());
      if (customValuesToUpsert.length > 0) {
        console.log(`[Import] Upserting ${customValuesToUpsert.length} custom field values...`);
        const CUSTOM_BATCH_SIZE = 500;
        for (let i = 0; i < customValuesToUpsert.length; i += CUSTOM_BATCH_SIZE) {
          const chunk = customValuesToUpsert.slice(i, i + CUSTOM_BATCH_SIZE);
          const { error: upsertError } = await supabase
            .from(customValueTable)
            .upsert(chunk, {
              onConflict: `${entityIdField},field_id`
            });
          
          if (upsertError) {
            console.log(`[Import] Custom field batch upsert error: ${upsertError.message}`);
          }
        }
      }
    }
    
    runningCreated += chunkCreated;
    runningUpdated += chunkUpdated;
    runningSkipped += chunkSkipped;
    runningErrors += chunkErrors;
    runningNotes += chunkNotes;
    
    await updateImportJobProgress(jobId, {
      created: runningCreated,
      updated: runningUpdated,
      errors: runningErrors,
      newErrors: errorLog,
      done,
    });
    
    if (!done) {
      return res.json({
        success: true,
        done: false,
        jobId,
        path: jsPathHint,
        offset: sliceEnd,
        created: runningCreated,
        updated: runningUpdated,
        skipped: runningSkipped,
        errors: runningErrors,
        notesCreated: runningNotes,
        totalRows: records.length,
        errorDetails: errorLog.slice(0, 20)
      });
    }
    
    console.log(`[Import] Complete: ${runningCreated} created, ${runningUpdated} updated, ${runningSkipped} skipped, ${runningErrors} errors`);
    
    return res.json({
      success: true,
      done: true,
      jobId,
      path: jsPathHint,
      offset: records.length,
      created: runningCreated,
      updated: runningUpdated,
      skipped: runningSkipped,
      errors: runningErrors,
      notesCreated: runningNotes,
      summary: {
        totalRows: records.length,
        processedRows: runningCreated + runningUpdated,
        createdRows: runningCreated,
        updatedRows: runningUpdated,
        skippedRows: runningSkipped,
        errorRows: runningErrors,
        notesCreated: runningNotes
      },
      errorDetails: errorLog.slice(0, 20)
    });
  } catch (error) {
    console.error('[Import Execute] Error:', error);
    // Don't leave a half-finished run stuck on "running" in the history panel.
    if (jobId) {
      try {
        await supabase
          .from('csv_import_job')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', jobId);
      } catch (e) {
        console.log('[Import] Could not mark job failed:', e.message);
      }
    }
    res.status(500).json({ error: error.message || 'Failed to execute import' });
  }
}
