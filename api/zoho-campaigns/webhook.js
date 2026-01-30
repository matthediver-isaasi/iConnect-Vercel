import { supabase } from '../_lib/database.js';
import { validateWebhookSecret } from '../_lib/zohoCampaignsClient.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { tenantId: tenantIdParam, secret } = req.query;
    const body = req.body;

    console.log('[ZohoCampaigns Webhook] Received request for tenant:', tenantIdParam);

    if (!tenantIdParam) {
      console.error('[ZohoCampaigns Webhook] Missing tenantId parameter');
      return res.status(400).json({ error: 'Missing tenantId parameter' });
    }

    if (!secret) {
      console.error('[ZohoCampaigns Webhook] Missing secret parameter');
      return res.status(401).json({ error: 'Missing secret parameter' });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id')
      .eq('id', tenantIdParam)
      .single();

    if (tenantError || !tenant) {
      console.error('[ZohoCampaigns Webhook] Invalid tenant:', tenantIdParam);
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenantId = tenant.id;

    const isValidSecret = await validateWebhookSecret(tenantId, secret);
    if (!isValidSecret) {
      console.error('[ZohoCampaigns Webhook] Invalid secret for tenant:', tenantId);
      return res.status(401).json({ error: 'Invalid secret' });
    }

    console.log('[ZohoCampaigns Webhook] Payload:', JSON.stringify(body, null, 2));

    const action = body.action;
    const actionType = body.actionType;
    const contacts = body.data || [];

    if (action !== 'unsubscribed') {
      console.log('[ZohoCampaigns Webhook] Non-unsubscribe action, ignoring:', action);
      return res.status(200).json({ success: true, message: 'Action ignored' });
    }

    const results = {
      processed: 0,
      updated: 0,
      notFound: 0,
      errors: 0
    };

    for (const contact of contacts) {
      const email = contact.contact_email;
      
      if (!email) {
        results.errors++;
        continue;
      }

      results.processed++;

      try {
        const { data: member, error: memberError } = await supabase
          .from('member')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('email', email.toLowerCase())
          .single();

        if (memberError || !member) {
          console.log('[ZohoCampaigns Webhook] Member not found:', email);
          results.notFound++;
          continue;
        }

        if (actionType === 'doNotMail') {
          const { error: updateError } = await supabase
            .from('member')
            .update({ 
              communications_opted_out_all: true,
              updated_at: new Date().toISOString()
            })
            .eq('id', member.id)
            .eq('tenant_id', tenantId);

          if (updateError) {
            console.error('[ZohoCampaigns Webhook] Error updating member:', updateError);
            results.errors++;
          } else {
            console.log('[ZohoCampaigns Webhook] Member opted out of all:', email);
            results.updated++;
          }
        } else {
          const zohoListKey = getListKeyFromWebhook(body, contact);
          
          if (zohoListKey) {
            const { data: category } = await supabase
              .from('communication_category')
              .select('id')
              .eq('tenant_id', tenantId)
              .eq('zoho_list_id', zohoListKey)
              .single();

            if (category) {
              const { error: prefError } = await supabase
                .from('member_communication_preference')
                .upsert({
                  tenant_id: tenantId,
                  member_id: member.id,
                  category_id: category.id,
                  is_subscribed: false,
                  updated_at: new Date().toISOString()
                }, {
                  onConflict: 'tenant_id,member_id,category_id'
                });

              if (prefError) {
                console.error('[ZohoCampaigns Webhook] Error updating preference:', prefError);
                results.errors++;
              } else {
                console.log('[ZohoCampaigns Webhook] Member unsubscribed from category:', email, category.id);
                results.updated++;
              }
            } else {
              console.log('[ZohoCampaigns Webhook] List key not mapped to category, skipping:', zohoListKey, email);
              results.skipped = (results.skipped || 0) + 1;
            }
          } else {
            console.log('[ZohoCampaigns Webhook] No list key in payload, skipping:', email);
            results.skipped = (results.skipped || 0) + 1;
          }
        }
      } catch (error) {
        console.error('[ZohoCampaigns Webhook] Error processing contact:', email, error);
        results.errors++;
      }
    }

    console.log('[ZohoCampaigns Webhook] Processing complete:', results);

    return res.status(200).json({ 
      success: true, 
      results 
    });

  } catch (error) {
    console.error('[ZohoCampaigns Webhook] Error:', error);
    return res.status(500).json({ 
      error: 'Webhook processing failed',
      details: error.message 
    });
  }
}

function getListKeyFromWebhook(body, contact) {
  if (body.list_key) return body.list_key;
  if (body.listkey) return body.listkey;
  if (body.listKey) return body.listKey;
  
  if (contact?.list_key) return contact.list_key;
  if (contact?.listkey) return contact.listkey;
  if (contact?.listKey) return contact.listKey;
  
  const data = body.data?.[0];
  if (data?.list_key) return data.list_key;
  if (data?.listkey) return data.listkey;
  if (data?.listKey) return data.listKey;
  
  return null;
}
