import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL or DEST_SUPABASE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function debugNavigationItems() {
  console.log('Fetching navigation items with form_modal link_type...\n');
  
  const { data: items, error } = await supabase
    .from('navigation_item')
    .select('id, title, link_type, form_slug, url, display_type, button_style')
    .eq('link_type', 'form_modal');

  if (error) {
    console.error('Error fetching navigation items:', error);
    return;
  }

  if (!items || items.length === 0) {
    console.log('No navigation items found with link_type = form_modal');
    console.log('\nChecking all navigation items for any with form_slug set...\n');
    
    const { data: allItems, error: allError } = await supabase
      .from('navigation_item')
      .select('id, title, link_type, form_slug, url, display_type')
      .not('form_slug', 'is', null);
    
    if (allError) {
      console.error('Error:', allError);
    } else if (allItems && allItems.length > 0) {
      console.log('Items with form_slug set:');
      allItems.forEach(item => {
        console.log(`  - ${item.title}: link_type=${item.link_type}, form_slug=${item.form_slug}`);
      });
    } else {
      console.log('No items have form_slug set.');
    }
    return;
  }

  console.log(`Found ${items.length} navigation item(s) with link_type='form_modal':\n`);
  items.forEach(item => {
    console.log(`ID: ${item.id}`);
    console.log(`  Title: ${item.title}`);
    console.log(`  Link Type: ${item.link_type}`);
    console.log(`  Form Slug: ${item.form_slug || '(not set)'}`);
    console.log(`  URL: ${item.url || '(not set)'}`);
    console.log(`  Display Type: ${item.display_type}`);
    console.log(`  Button Style: ${item.button_style}`);
    console.log('');
  });
}

debugNavigationItems().catch(console.error);
