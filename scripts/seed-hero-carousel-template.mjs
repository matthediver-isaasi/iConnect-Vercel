import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function seedHeroCarouselTemplate() {
  const { data: existing, error: checkError } = await supabase
    .from('i_edit_element_template')
    .select('id')
    .eq('element_type', 'hero_carousel')
    .maybeSingle();

  if (checkError) {
    console.error('Error checking existing template:', checkError);
    process.exit(1);
  }

  if (existing) {
    console.log('hero_carousel template already exists (id:', existing.id, ')— skipping insert.');
    return;
  }

  const { data, error } = await supabase
    .from('i_edit_element_template')
    .insert({
      element_type: 'hero_carousel',
      name: 'Hero Carousel',
      description: 'Full-width carousel with multiple slides, rich text overlays, background images, and configurable transitions',
      category: 'media',
      icon: 'Image',
      display_order: 102,
      is_active: true,
      default_content: { slides: [] },
      available_variants: ['default'],
      content_schema: { type: 'object', properties: {} }
    })
    .select()
    .single();

  if (error) {
    console.error('Error inserting template:', error);
    process.exit(1);
  }

  console.log('Inserted hero_carousel template:', data.id);
}

seedHeroCarouselTemplate();
