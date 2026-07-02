import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const tenantId = '21296ad6-1350-483a-a90c-1b06ece70501';

async function debugForms() {
  console.log('=== Comparing SO and ESO Form Configurations ===\n');

  // Get forms with "SO" or "ESO" in name
  const { data: forms, error: formsError } = await supabase
    .from('form')
    .select('id, name, slug, fields, contract_settings, due_diligence_required')
    .eq('tenant_id', tenantId)
    .or('name.ilike.%SO%,name.ilike.%ESO%,slug.ilike.%so%,slug.ilike.%eso%');

  if (formsError) {
    console.error('Error fetching forms:', formsError);
    return;
  }

  console.log('Found forms:', forms?.map(f => ({ id: f.id, name: f.name, slug: f.slug })));

  // Find SO and ESO forms specifically
  const soForm = forms?.find(f => f.name?.toLowerCase().includes('so long') || f.slug?.includes('so-application'));
  const esoForm = forms?.find(f => f.name?.toLowerCase().includes('eso long') || f.slug?.includes('eso-application'));

  console.log('SO Form:', soForm?.name, soForm?.id);
  console.log('ESO Form:', esoForm?.name, esoForm?.id);

  if (!soForm && !esoForm) {
    // Try broader search
    const { data: allForms } = await supabase
      .from('form')
      .select('id, name, slug')
      .eq('tenant_id', tenantId)
      .eq('due_diligence_required', true);
    
    console.log('\nAll DD-enabled forms:', allForms?.map(f => ({ id: f.id, name: f.name, slug: f.slug })));
    return;
  }

  for (const form of [soForm, esoForm].filter(Boolean)) {
    console.log('\n' + '='.repeat(60));
    console.log(`FORM: ${form.name} (${form.id})`);
    console.log('Slug:', form.slug);
    console.log('Due Diligence Required:', form.due_diligence_required);
    console.log('='.repeat(60));

    // Get DD config
    const { data: ddConfig } = await supabase
      .from('form_due_diligence_config')
      .select('*')
      .eq('form_id', form.id)
      .single();

    if (ddConfig) {
      console.log('\n--- DD Config ---');
      console.log('Config ID:', ddConfig.id);
      console.log('Workflow Stages:', JSON.stringify(ddConfig.workflow_stages, null, 2));
      
      // Look at NEW stage specifically
      const newStage = ddConfig.workflow_stages?.find(s => s.id === 'new');
      if (newStage) {
        console.log('\n--- NEW Stage Configuration ---');
        console.log('Stage Actions:', JSON.stringify(newStage.stage_actions || newStage.actions, null, 2));
        console.log('Send Contracts:', newStage.stage_actions?.send_contracts || newStage.actions?.send_contracts);
      }
    } else {
      console.log('\n!!! NO DD CONFIG FOUND !!!');
    }

    // Get contact fields (potential signatories)
    const contactFields = (form.fields || []).filter(f => f.type === 'contact');
    console.log('\n--- Contact Fields (Signatories) ---');
    for (const field of contactFields) {
      console.log(`  Field: ${field.label || field.name} (${field.id})`);
      console.log(`    - contract_form_id: ${field.contract_form_id}`);
      console.log(`    - Type: ${field.type}`);
      
      if (field.contract_form_id) {
        // Get the contract form
        const { data: contractForm } = await supabase
          .from('form')
          .select('id, name, contract_settings')
          .eq('id', field.contract_form_id)
          .single();
        
        if (contractForm) {
          console.log(`    - Contract Form: ${contractForm.name}`);
          console.log(`    - Initial Email Template ID: ${contractForm.contract_settings?.initial_email_template_id}`);
          
          // Get email template details
          if (contractForm.contract_settings?.initial_email_template_id) {
            const { data: emailTemplate } = await supabase
              .from('email_template')
              .select('id, name, subject')
              .eq('id', contractForm.contract_settings.initial_email_template_id)
              .single();
            
            if (emailTemplate) {
              console.log(`    - Email Template: ${emailTemplate.name} (${emailTemplate.id})`);
            } else {
              console.log(`    - !!! Email Template NOT FOUND !!!`);
            }
          }
        } else {
          console.log(`    - !!! Contract Form NOT FOUND !!!`);
        }
      }
    }

    // Get stage email actions for this form
    const { data: emailActions } = await supabase
      .from('stage_email_action')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('form_id', form.id);

    console.log('\n--- Stage Email Actions (form-scoped) ---');
    console.log('Actions:', emailActions?.length || 0);
    emailActions?.forEach(a => {
      console.log(`  Stage: ${a.due_diligence_stage_id}, Template: ${a.email_template_id}`);
    });

    // Also check for global (null form_id) actions
    const { data: globalActions } = await supabase
      .from('stage_email_action')
      .select('*')
      .eq('tenant_id', tenantId)
      .is('form_id', null);

    console.log('\n--- Stage Email Actions (global/null form_id) ---');
    console.log('Actions:', globalActions?.length || 0);
    globalActions?.forEach(a => {
      console.log(`  Stage: ${a.due_diligence_stage_id}, Template: ${a.email_template_id}`);
    });
  }

  // Check if they share the same contract form
  console.log('\n\n' + '='.repeat(60));
  console.log('CROSS-FORM COMPARISON');
  console.log('='.repeat(60));

  const soContactFields = (soForm?.fields || []).filter(f => f.type === 'contact' && f.contract_form_id);
  const esoContactFields = (esoForm?.fields || []).filter(f => f.type === 'contact' && f.contract_form_id);

  const soContractFormIds = soContactFields.map(f => f.contract_form_id);
  const esoContractFormIds = esoContactFields.map(f => f.contract_form_id);

  console.log('\nSO Contract Form IDs:', soContractFormIds);
  console.log('ESO Contract Form IDs:', esoContractFormIds);

  const sharedContractForms = soContractFormIds.filter(id => esoContractFormIds.includes(id));
  if (sharedContractForms.length > 0) {
    console.log('\n!!! SHARED CONTRACT FORMS DETECTED !!!');
    console.log('Shared IDs:', sharedContractForms);
  }

  // Check recent form submissions for both forms
  console.log('\n\n--- Recent Form Submissions ---');
  
  for (const form of [soForm, esoForm].filter(Boolean)) {
    const { data: submissions } = await supabase
      .from('form_submission')
      .select('id, created_at')
      .eq('form_id', form.id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(3);

    console.log(`\n${form.name}: ${submissions?.length || 0} recent submissions`);
    
    for (const sub of submissions || []) {
      // Check DD submission
      const { data: ddSub } = await supabase
        .from('due_diligence_submission')
        .select('id, status, form_id')
        .eq('form_submission_id', sub.id)
        .single();

      // Check contract instances
      const { data: contracts } = await supabase
        .from('contract_instance')
        .select('id, status, sent_at, source_contact_field_id, form_id')
        .eq('form_submission_id', sub.id);

      console.log(`  Submission ${sub.id.substring(0, 8)}... (${sub.created_at})`);
      console.log(`    DD Status: ${ddSub?.status || 'NO DD SUBMISSION'}`);
      console.log(`    Contract Instances: ${contracts?.length || 0}`);
      contracts?.forEach(c => {
        console.log(`      - ${c.id.substring(0, 8)}... status=${c.status}, sent=${c.sent_at ? 'YES' : 'NO'}, field=${c.source_contact_field_id}`);
      });
    }
  }
}

debugForms().catch(console.error);
