import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.DEST_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEST_SUPABASE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL and a service key (SUPABASE_SERVICE_KEY/DEST_SUPABASE_KEY/DEV_SUPABASE_SERVICE_KEY) are required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function seed() {
  const { data: existing, error: checkError } = await supabase
    .from('i_edit_element_template')
    .select('id')
    .eq('element_type', 'gallery')
    .maybeSingle();

  if (checkError) {
    console.error('Error checking existing template:', checkError);
    process.exit(1);
  }

  if (existing) {
    console.log('gallery template already exists (id:', existing.id, ') — skipping insert.');
    return;
  }

  const { data, error } = await supabase
    .from('i_edit_element_template')
    .insert({
      element_type: 'gallery',
      name: 'Photo Gallery',
      description:
        'Display photo galleries as cards with a lightbox viewer. Public galleries appear for everyone; members-only galleries require login.',
      category: 'media',
      icon: 'Image',
      display_order: 103,
      is_active: true,
      default_content: { heading: '', gallery_ids: [], columns: 3 },
      available_variants: ['default'],
      content_schema: { type: 'object', properties: {} },
    })
    .select()
    .single();

  if (error) {
    console.error('Error inserting template:', error);
    process.exit(1);
  }

  console.log('Inserted gallery template:', data.id);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
