import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);
const tenantId = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

async function debug() {
  // Check if the articles from the showcase element exist
  const articleIds = [
    "76f28379-4d47-4a70-92f1-b30290bb05b9",
    "48a03e94-0302-4ce3-8946-7815e0947b28",
    "d6ef73be-9ad1-400a-9497-3ba0fa71b009"
  ];
  
  console.log('=== CHECKING ARTICLES REFERENCED IN SHOWCASE ===');
  const { data: articles, error: artErr } = await supabase
    .from('blog_post')
    .select('id, title, tenant_id')
    .in('id', articleIds);
  
  if (artErr) console.log('Error:', artErr);
  else {
    console.log('Found articles:', articles?.length || 0);
    articles?.forEach(a => console.log(`  - ${a.id}: ${a.title?.substring(0, 50)} (tenant: ${a.tenant_id})`));
  }
  
  // Check resources referenced in resources_showcase
  const resourceIds = [
    "fc8a7ff4-3e9e-4d26-be52-b4902cfe448d",
    "a3f28e90-4bd8-4b52-84aa-906caab038b7",
    "8ca8e467-b8fa-4897-90bb-dc5c5cad6bac",
    "822e7b4e-e987-40db-bd02-3badec21e57d"
  ];
  
  console.log('\n=== CHECKING RESOURCES REFERENCED IN RESOURCES_SHOWCASE ===');
  const { data: resources, error: resErr } = await supabase
    .from('resource')
    .select('id, title, tenant_id')
    .in('id', resourceIds);
  
  if (resErr) console.log('Error:', resErr);
  else {
    console.log('Found resources:', resources?.length || 0);
    resources?.forEach(r => console.log(`  - ${r.id}: ${r.title?.substring(0, 50)} (tenant: ${r.tenant_id})`));
  }
  
  // Check the event referenced in hero element 3
  console.log('\n=== CHECKING EVENT REFERENCED IN HERO ELEMENT ===');
  const eventId = "b5d8ab69-519f-424c-932c-e414fcd30ed0";
  const { data: event, error: evtErr } = await supabase
    .from('event')
    .select('id, title, tenant_id')
    .eq('id', eventId)
    .single();
  
  if (evtErr) console.log('Error:', evtErr);
  else console.log('Event:', event);
  
  // Check card deck referenced in the featured_job or other elements
  console.log('\n=== CHECKING CARD DECK ===');
  const { data: cardDecks, error: cdErr } = await supabase
    .from('card_deck')
    .select('id, title, tenant_id')
    .eq('tenant_id', tenantId)
    .limit(5);
  
  if (cdErr) console.log('Error:', cdErr);
  else console.log('Card decks:', cardDecks?.length || 0, cardDecks);
}

debug().catch(console.error);
