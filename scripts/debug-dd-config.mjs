import { createClient } from '@supabase/supabase-js';

// Use DEV (destination) database where DD configs exist
const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: DEV_SUPABASE_URL/SUPABASE_URL or DEV_SUPABASE_SERVICE_KEY/SUPABASE_SERVICE_KEY not set');
  process.exit(1);
}

console.log('Connecting to Supabase:', supabaseUrl);

const supabase = createClient(supabaseUrl, supabaseKey);

const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

async function debugDDConfigs() {
  console.log('='.repeat(80));
  console.log('DEBUG: Due Diligence Config Comparison - ESO vs SO Forms');
  console.log('='.repeat(80));
  console.log('');

  // First, list ALL DD configs to find available tenants and forms
  const { data: allDDConfigs, error: allConfigError } = await supabase
    .from('form_due_diligence_config')
    .select('id, form_id, tenant_id, workflow_stages')
    .limit(50);
  
  if (allConfigError) {
    console.error('Error fetching DD configs:', allConfigError);
    return;
  }

  // List unique tenant IDs found
  const uniqueTenantIds = [...new Set(allDDConfigs?.map(c => c.tenant_id) || [])];
  console.log(`Found ${allDDConfigs?.length || 0} DD configs across ${uniqueTenantIds.length} tenant(s)`);
  console.log('Tenant IDs:', uniqueTenantIds);
  console.log('');

  // Get ALL forms that have DD configs
  const formIds = allDDConfigs?.map(c => c.form_id) || [];

  if (formIds.length === 0) {
    console.log('No DD configs found in database');
    return;
  }

  // For each config, let's look at the forms
  const { data: forms, error: formsError } = await supabase
    .from('form')
    .select('id, name, slug, fields, tenant_id')
    .in('id', formIds);

  if (formsError) {
    console.error('Error fetching forms:', formsError);
    return;
  }

  console.log(`Found ${forms?.length || 0} forms with DD configs:\n`);
  forms?.forEach(f => console.log(`  - ${f.name} (${f.slug}) [tenant: ${f.tenant_id}]`));
  console.log('');

  // Now filter to forms/configs that match what we're looking for (ESO, SO)
  const ddConfigs = allDDConfigs;

  // Analyze each form
  for (const form of forms) {
    console.log('='.repeat(80));
    console.log(`FORM: ${form.name}`);
    console.log(`  ID: ${form.id}`);
    console.log(`  Slug: ${form.slug}`);
    console.log('');

    // Get contact fields with contract_form_id (signatory fields)
    const fields = form.fields || [];
    const contactFields = fields.filter(f => f.type === 'contact');
    const signatoryFields = contactFields.filter(f => f.contract_form_id);

    console.log('  CONTACT FIELDS:');
    if (contactFields.length === 0) {
      console.log('    (none)');
    } else {
      for (const cf of contactFields) {
        const fieldId = cf.id || cf.name;
        const hasContract = cf.contract_form_id ? `YES (${cf.contract_form_id})` : 'NO';
        console.log(`    - Field ID: "${fieldId}"`);
        console.log(`      Label: ${cf.label || cf.name}`);
        console.log(`      Name: ${cf.name}`);
        console.log(`      Has Contract Form: ${hasContract}`);
      }
    }
    console.log('');

    console.log('  SIGNATORY FIELDS (contact + contract_form_id):');
    if (signatoryFields.length === 0) {
      console.log('    (none - no contact fields have contract_form_id set)');
    } else {
      for (const sf of signatoryFields) {
        console.log(`    - "${sf.id || sf.name}" -> Contract Form: ${sf.contract_form_id}`);
      }
    }
    console.log('');

    // Get DD config for this form
    const ddConfig = ddConfigs.find(c => c.form_id === form.id);
    if (!ddConfig) {
      console.log('  DD CONFIG: NOT FOUND');
      console.log('');
      continue;
    }

    console.log('  DD CONFIG:');
    const workflowStages = ddConfig.workflow_stages || [];
    console.log(`    Workflow Stages: ${workflowStages.length}`);
    console.log('');

    // Find initial stage
    const initialStage = workflowStages.find(s => s.is_initial) || workflowStages[0];
    
    console.log('  WORKFLOW STAGES:');
    for (let i = 0; i < workflowStages.length; i++) {
      const stage = workflowStages[i];
      const isInitial = stage.is_initial || (i === 0 && !workflowStages.some(s => s.is_initial));
      const stageActions = stage.actions || stage.stage_actions || {};
      const sendContracts = stageActions.send_contracts || [];
      
      console.log(`    Stage ${i + 1}: "${stage.name || stage.id}"${isInitial ? ' [INITIAL]' : ''}`);
      console.log(`      ID: ${stage.id}`);
      console.log(`      Has actions: ${stage.actions ? 'Yes (stage.actions)' : 'No'}`);
      console.log(`      Has stage_actions: ${stage.stage_actions ? 'Yes (stage.stage_actions)' : 'No'}`);
      console.log(`      send_contracts: ${JSON.stringify(sendContracts)}`);
      
      if (sendContracts.length > 0) {
        console.log('      send_contracts VALIDATION:');
        for (const contractFieldId of sendContracts) {
          const matchingField = fields.find(f => f.id === contractFieldId || f.name === contractFieldId);
          if (matchingField) {
            const hasContractForm = matchingField.contract_form_id ? 'YES' : 'NO';
            console.log(`        - "${contractFieldId}" -> FOUND (type: ${matchingField.type}, contract_form: ${hasContractForm})`);
          } else {
            console.log(`        - "${contractFieldId}" -> NOT FOUND IN FORM FIELDS ⚠️`);
          }
        }
      }
      console.log('');
    }

    // Check database-stored stage actions
    if (initialStage) {
      console.log('  DATABASE-STORED ACTIONS FOR INITIAL STAGE:');
      
      // Check stage_email_action
      const { data: emailActions } = await supabase
        .from('stage_email_action')
        .select('id, is_active, email_template_id')
        .eq('due_diligence_stage_id', initialStage.id)
        .eq('tenant_id', TENANT_ID);
      console.log(`    Email Actions: ${emailActions?.length || 0}`);
      
      // Check stage_meeting_request
      const { data: meetingRequests } = await supabase
        .from('stage_meeting_request')
        .select('id, is_active, meeting_template_id')
        .eq('due_diligence_stage_id', initialStage.id)
        .eq('tenant_id', TENANT_ID);
      console.log(`    Meeting Requests: ${meetingRequests?.length || 0}`);
      
      // Check stage_member_action
      const { data: memberActions } = await supabase
        .from('stage_member_action')
        .select('id, is_active')
        .eq('due_diligence_stage_id', initialStage.id)
        .eq('tenant_id', TENANT_ID);
      console.log(`    Member Actions: ${memberActions?.length || 0}`);
    }
    
    console.log('');
  }

  // Summary comparison
  console.log('='.repeat(80));
  console.log('SUMMARY COMPARISON');
  console.log('='.repeat(80));
  
  for (const form of forms) {
    const ddConfig = ddConfigs.find(c => c.form_id === form.id);
    const workflowStages = ddConfig?.workflow_stages || [];
    const initialStage = workflowStages.find(s => s.is_initial) || workflowStages[0];
    const stageActions = initialStage?.actions || initialStage?.stage_actions || {};
    const sendContracts = stageActions.send_contracts || [];
    
    const fields = form.fields || [];
    const signatoryFields = fields.filter(f => f.type === 'contact' && f.contract_form_id);
    
    console.log(`\n${form.name}:`);
    console.log(`  Signatory fields in form: ${signatoryFields.length}`);
    console.log(`  send_contracts in initial stage: ${sendContracts.length}`);
    console.log(`  Initial stage has actions/stage_actions: ${initialStage?.actions || initialStage?.stage_actions ? 'YES' : 'NO'}`);
    
    if (sendContracts.length > 0 && signatoryFields.length > 0) {
      const sigFieldIds = signatoryFields.map(f => f.id || f.name);
      const missingInForm = sendContracts.filter(id => !sigFieldIds.includes(id));
      const missingInConfig = sigFieldIds.filter(id => !sendContracts.includes(id));
      
      if (missingInForm.length > 0) {
        console.log(`  ⚠️  send_contracts references fields NOT in form: ${missingInForm.join(', ')}`);
      }
      if (missingInConfig.length > 0) {
        console.log(`  ℹ️  Signatory fields NOT in send_contracts: ${missingInConfig.join(', ')}`);
      }
      if (missingInForm.length === 0 && missingInConfig.length === 0) {
        console.log(`  ✓ All send_contracts match signatory fields`);
      }
    }
  }

  // Check contract forms and their email template configuration
  console.log('\n');
  console.log('='.repeat(80));
  console.log('CONTRACT FORM EMAIL TEMPLATE CONFIGURATION');
  console.log('='.repeat(80));

  // Collect all unique contract_form_ids
  const allContractFormIds = new Set();
  for (const form of forms) {
    const fields = form.fields || [];
    for (const f of fields) {
      if (f.contract_form_id) {
        allContractFormIds.add(f.contract_form_id);
      }
    }
  }

  console.log(`\nFound ${allContractFormIds.size} unique contract form(s) referenced:\n`);

  for (const contractFormId of allContractFormIds) {
    const { data: contractForm, error: cfError } = await supabase
      .from('form')
      .select('id, name, slug, contract_settings')
      .eq('id', contractFormId)
      .single();

    if (cfError || !contractForm) {
      console.log(`Contract Form ID: ${contractFormId}`);
      console.log(`  ⚠️  NOT FOUND IN DATABASE`);
      console.log('');
      continue;
    }

    console.log(`Contract Form: ${contractForm.name}`);
    console.log(`  ID: ${contractFormId}`);
    console.log(`  Slug: ${contractForm.slug}`);
    
    const settings = contractForm.contract_settings || {};
    const initialTemplateId = settings.initial_email_template_id;
    const reminderTemplateId = settings.reminder_email_template_id;
    const timeoutDays = settings.timeout_days;

    console.log(`  Contract Settings:`);
    console.log(`    - initial_email_template_id: ${initialTemplateId || 'NOT SET ⚠️'}`);
    console.log(`    - reminder_email_template_id: ${reminderTemplateId || 'not set'}`);
    console.log(`    - timeout_days: ${timeoutDays || 'not set'}`);

    // Check if initial email template exists
    if (initialTemplateId) {
      const { data: emailTemplate, error: etError } = await supabase
        .from('email_template')
        .select('id, name, subject, from_email')
        .eq('id', initialTemplateId)
        .single();

      if (etError || !emailTemplate) {
        console.log(`    - Initial Email Template: ⚠️  NOT FOUND (ID: ${initialTemplateId})`);
      } else {
        console.log(`    - Initial Email Template: ✓ ${emailTemplate.name}`);
        console.log(`      Subject: ${emailTemplate.subject}`);
        console.log(`      From: ${emailTemplate.from_email || 'default'}`);
      }
    }
    console.log('');
  }

  // Check form_submission records to see if recent submissions exist
  console.log('='.repeat(80));
  console.log('RECENT FORM SUBMISSIONS');
  console.log('='.repeat(80));

  for (const form of forms) {
    const { data: submissions, error: subError } = await supabase
      .from('form_submission')
      .select('id, created_date, form_name')
      .eq('form_id', form.id)
      .order('created_date', { ascending: false })
      .limit(3);

    console.log(`\n${form.name}:`);
    if (subError) {
      console.log(`  Error: ${subError.message}`);
    } else if (!submissions || submissions.length === 0) {
      console.log(`  No submissions found`);
    } else {
      for (const sub of submissions) {
        console.log(`  - ${sub.id} (${sub.created_date})`);
        
        // Check if DD record exists
        const { data: ddRecord } = await supabase
          .from('form_submission_due_diligence')
          .select('id, workflow_status, history_log')
          .eq('form_submission_id', sub.id)
          .single();

        if (ddRecord) {
          console.log(`    DD Status: ${ddRecord.workflow_status}`);
          
          // Check history log for contract_sent events
          const historyLog = ddRecord.history_log || [];
          const contractEvents = historyLog.filter(e => 
            e.event_type === 'contract_sent' || 
            e.event_type?.includes('contract')
          );
          if (contractEvents.length > 0) {
            console.log(`    Contract events in history: ${contractEvents.length}`);
            contractEvents.slice(0, 2).forEach(e => {
              console.log(`      - ${e.event_type} at ${e.timestamp}`);
            });
          } else {
            console.log(`    Contract events in history: 0 ⚠️`);
          }
        } else {
          console.log(`    DD Record: NOT FOUND`);
        }
      }
    }
  }

  // Deep dive: Compare failed vs successful SO submissions
  console.log('\n');
  console.log('='.repeat(80));
  console.log('DEEP DIVE: SO Form Submission Data Comparison');
  console.log('='.repeat(80));

  // Get the SO form
  const soForm = forms.find(f => f.name.includes('SO'));
  if (soForm) {
    const { data: soSubmissions } = await supabase
      .from('form_submission')
      .select('id, created_date, submission_data')
      .eq('form_id', soForm.id)
      .order('created_date', { ascending: false })
      .limit(3);

    const signatoryFieldIds = ['field_1768830421540', 'field_1768830446102'];

    for (const sub of soSubmissions || []) {
      const { data: ddRecord } = await supabase
        .from('form_submission_due_diligence')
        .select('id, history_log, created_at')
        .eq('form_submission_id', sub.id)
        .single();

      // Also get more details about the form_submission
      const { data: fullSub } = await supabase
        .from('form_submission')
        .select('id, submitted_by_email, organization_id, created_organization_id')
        .eq('id', sub.id)
        .single();

      const historyLog = ddRecord?.history_log || [];
      const contractEvents = historyLog.filter(e => e.event_type === 'contract_sent');
      const status = contractEvents.length > 0 ? '✓ WORKED' : '⚠️ FAILED';

      console.log(`\nSubmission: ${sub.id} (${sub.created_date})`);
      console.log(`  Submitted by: ${fullSub?.submitted_by_email || 'NULL (public)'}`);
      console.log(`  Organization ID: ${fullSub?.organization_id || 'null'}`);
      console.log(`  Created Org ID: ${fullSub?.created_organization_id || 'null'}`);
      console.log(`  DD Record created: ${ddRecord?.created_at || 'NO DD RECORD'}`);
      console.log(`  DD Record ID: ${ddRecord?.id || 'none'}`);
      console.log(`  Contract Status: ${status}`);
      console.log(`  Signatory field values:`);

      const submissionData = sub.submission_data || {};
      for (const fieldId of signatoryFieldIds) {
        const value = submissionData[fieldId];
        const fieldLabel = fieldId === 'field_1768830421540' ? 'First signatory' : 'Second signatory';
        
        if (!value) {
          console.log(`    ${fieldLabel} (${fieldId}): NOT PRESENT IN SUBMISSION ⚠️`);
        } else if (typeof value === 'object') {
          console.log(`    ${fieldLabel} (${fieldId}):`);
          console.log(`      email: ${value.email || 'MISSING'}`);
          console.log(`      first_name: ${value.first_name || value.firstName || 'missing'}`);
          console.log(`      last_name: ${value.last_name || value.lastName || 'missing'}`);
        } else {
          console.log(`    ${fieldLabel} (${fieldId}): ${typeof value} - ${JSON.stringify(value).slice(0, 100)}`);
        }
      }

      // Check contract instances for this submission
      const { data: contractInstances } = await supabase
        .from('contract_instance')
        .select('id, form_id, status, sent_at, signers, source_contact_field_id, created_at')
        .eq('form_submission_id', sub.id);

      console.log(`  Contract instances: ${contractInstances?.length || 0}`);
      for (const ci of contractInstances || []) {
        console.log(`    - Instance ${ci.id.slice(0, 8)}...`);
        console.log(`      Form ID: ${ci.form_id}`);
        console.log(`      Source field: ${ci.source_contact_field_id || 'not set'}`);
        console.log(`      Status: ${ci.status}`);
        console.log(`      Sent at: ${ci.sent_at || 'NOT SENT ⚠️'}`);
        console.log(`      Created at: ${ci.created_at}`);
        console.log(`      Signers: ${JSON.stringify(ci.signers?.map(s => ({ email: s.email, sent_at: s.sent_at })))}`);
      }
    }
  }
}

debugDDConfigs().catch(console.error);
