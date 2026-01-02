import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const videoTemplate = {
    id: randomUUID(),
    element_type: 'video',
    name: 'Video Embed',
    description: 'Embed external videos from YouTube, Vimeo, and other platforms',
    icon: 'Image',
    category: 'media',
    is_active: true,
    display_order: 100,
    available_variants: ['default'],
    default_variant: 'default',
    default_content: {
      embed_code: '',
      aspect_ratio: '16:9',
      max_width: 100,
      alignment: 'center',
      title: '',
      caption: '',
      border_radius: 8,
      show_border: false,
      border_color: '#e2e8f0'
    },
    default_settings: {
      fullWidth: false,
      paddingTop: 32,
      paddingBottom: 32
    },
    content_schema: {
      type: 'object',
      properties: {
        embed_code: { type: 'string', title: 'Embed Code' },
        aspect_ratio: { type: 'string', title: 'Aspect Ratio' },
        max_width: { type: 'number', title: 'Max Width' },
        alignment: { type: 'string', title: 'Alignment' },
        title: { type: 'string', title: 'Title' },
        caption: { type: 'string', title: 'Caption' },
        border_radius: { type: 'number', title: 'Border Radius' },
        show_border: { type: 'boolean', title: 'Show Border' },
        border_color: { type: 'string', title: 'Border Color' }
      }
    },
    created_date: new Date().toISOString()
  };

  try {
    const { data: existing } = await supabase
      .from('i_edit_element_template')
      .select('id')
      .eq('element_type', 'video')
      .single();

    if (existing) {
      return res.status(200).json({ 
        message: 'Video template already exists', 
        id: existing.id 
      });
    }

    const { data, error } = await supabase
      .from('i_edit_element_template')
      .insert(videoTemplate)
      .select()
      .single();

    if (error) {
      console.error('Error creating video template:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ 
      message: 'Video template created successfully', 
      template: data 
    });
  } catch (err) {
    console.error('Seed error:', err);
    return res.status(500).json({ error: err.message });
  }
}
