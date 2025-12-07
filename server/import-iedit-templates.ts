// Import IEdit Element Templates into Supabase
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from 'uuid';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Generate consistent UUIDs from string identifiers (for reference mapping)
function stringToUUID(str: string): string {
  // If already a valid UUID pattern, return as is
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) {
    return str;
  }
  // Otherwise generate a new UUID
  return uuidv4();
}

// Templates without is_sample and created_by columns (not in Supabase schema)
const templates = [
  {
    id: 'hero_banner_template',
    name: 'Hero Banner',
    element_type: 'hero',
    description: 'Large banner section with heading, subheading, and call-to-action button',
    icon: 'Layout',
    category: 'layout',
    default_content: {"heading":"Welcome to Our Website","subheading":"Create amazing experiences with our platform","buttonText":"Get Started","buttonLink":"#"},
    available_variants: ["default","dark","light"],
    content_schema: {"type":"object","properties":{"heading":{"type":"string","title":"Main Heading","placeholder":"Enter main heading"},"subheading":{"type":"string","title":"Subheading","placeholder":"Enter subheading"},"buttonText":{"type":"string","title":"Button Text","placeholder":"Enter button text"},"buttonLink":{"type":"string","title":"Button Link","placeholder":"Enter button URL"}}},
    is_active: true,
    display_order: 1
  },
  {
    id: 'text_block_template',
    name: 'Text Block',
    element_type: 'text_block',
    description: 'Rich text content block with optional heading (supports Markdown)',
    icon: 'Type',
    category: 'content',
    default_content: {"heading":"Section Heading","text":"This is a text block. You can use **Markdown** formatting for _rich text_.\n\n- Bullet points\n- Are supported\n- As well"},
    available_variants: ["default","centered","large"],
    content_schema: {"type":"object","properties":{"heading":{"type":"string","title":"Heading (Optional)","placeholder":"Enter section heading"},"text":{"type":"string","title":"Content","placeholder":"Enter your text content"}}},
    is_active: true,
    display_order: 2
  },
  {
    id: 'two_column_template',
    name: 'Two Column Layout',
    element_type: 'two_column',
    description: 'Side-by-side content with typography controls, images, and background options',
    icon: 'Layout',
    category: 'layout',
    default_content: {
      background_type: 'none',
      leftHeading: 'Left Column',
      leftContent: 'Content for the left column goes here.',
      left_header_font_family: 'Poppins',
      left_header_font_weight: 700,
      left_header_font_size: 24,
      left_header_color: '#1e293b',
      left_content_font_family: 'Poppins',
      left_content_font_weight: 400,
      left_content_font_size: 16,
      left_content_color: '#475569',
      rightHeading: 'Right Column',
      rightContent: 'Content for the right column goes here.',
      right_header_font_family: 'Poppins',
      right_header_font_weight: 700,
      right_header_font_size: 24,
      right_header_color: '#1e293b',
      right_content_font_family: 'Poppins',
      right_content_font_weight: 400,
      right_content_font_size: 16,
      right_content_color: '#475569'
    },
    available_variants: ["default","60-40","40-60"],
    content_schema: {},
    is_active: true,
    display_order: 3
  },
  {
    id: 'cta_button_template',
    name: 'Call-to-Action Button',
    element_type: 'cta_button',
    description: 'Standalone button with customizable link and styling',
    icon: 'Zap',
    category: 'interactive',
    default_content: {"text":"Click Here","link":"#","alignment":"center","openInNewTab":false},
    available_variants: ["default","primary","secondary","success"],
    content_schema: {"type":"object","properties":{"text":{"type":"string","title":"Button Text","placeholder":"e.g., Learn More"},"link":{"type":"string","title":"Link URL","placeholder":"e.g., /contact"},"alignment":{"type":"string","title":"Alignment","enum":["left","center","right"]},"openInNewTab":{"type":"boolean","title":"Open in New Tab"}}},
    is_active: true,
    display_order: 4
  },
  {
    id: 'image_template',
    name: 'Image',
    element_type: 'image',
    description: 'Single image with optional caption',
    icon: 'Image',
    category: 'media',
    default_content: {"imageUrl":"https://images.unsplash.com/photo-1557683316-973673baf926","altText":"Placeholder image","caption":""},
    available_variants: ["default","rounded","circle","none"],
    content_schema: {"type":"object","properties":{"imageUrl":{"type":"string","title":"Image URL","placeholder":"Enter image URL or upload"},"altText":{"type":"string","title":"Alt Text","placeholder":"Describe the image for accessibility"},"caption":{"type":"string","title":"Caption (Optional)","placeholder":"Enter image caption"}}},
    is_active: true,
    display_order: 5
  },
  {
    id: 'image_hero_template',
    name: 'Image Hero',
    element_type: 'image_hero',
    description: 'Full-width hero section with layered background and foreground images. Perfect for creating framed hero sections with transparent overlays.',
    icon: 'Layers',
    category: 'media',
    default_content: {"backgroundImageUrl":"","foregroundImageUrl":"","height":"medium","contentAlignment":"center","overlayOpacity":0},
    available_variants: ["default"],
    content_schema: {"type":"object","properties":{"backgroundImageUrl":{"type":"string","title":"Background Image URL","description":"The main background image"},"foregroundImageUrl":{"type":"string","title":"Foreground Image URL","description":"Overlay image (optional)"},"height":{"type":"string","title":"Height","enum":["small","medium","large"]},"contentAlignment":{"type":"string","title":"Content Alignment","enum":["left","center","right"]},"overlayOpacity":{"type":"number","title":"Overlay Opacity","minimum":0,"maximum":1}}},
    is_active: true,
    display_order: 6
  },
  {
    id: '69198d73e24ee13c2f4d916f',
    name: 'Wall of Fame',
    element_type: 'wall_of_fame',
    description: 'Display sections of people (staff, board, etc.) with interactive profile cards',
    icon: 'Users',
    category: 'media',
    default_content: {"section_id":""},
    available_variants: ["default"],
    content_schema: {"type":"object","properties":{"section_id":{"type":"string","title":"Wall of Fame Section","description":"Select which Wall of Fame section to display"}},"required":["section_id"]},
    is_active: true,
    display_order: 50
  },
  {
    id: '691c43da8b9b2c0cc37c81c6',
    name: 'Form',
    element_type: 'form',
    description: 'Embed a form from the Form Management system',
    icon: 'FileText',
    category: 'content',
    default_content: {"form_slug":""},
    available_variants: ["default"],
    content_schema: {"type":"object","properties":{"form_slug":{"type":"string","title":"Form","description":"Select which form to display"}},"required":["form_slug"]},
    is_active: true,
    display_order: 10
  },
  {
    id: 'text_overlay_image_template',
    name: 'Text Overlay Image',
    element_type: 'text_overlay_image',
    description: 'Single column layout with background image and customizable text overlay with positioning, border, and opacity controls',
    icon: 'Image',
    category: 'media',
    default_content: {},
    available_variants: ["default"],
    content_schema: {"type":"object","properties":{"backgroundImage":{"type":"string","format":"uri","title":"Background Image"},"header":{"type":"string","title":"Header"},"text":{"type":"string","title":"Text Content"},"textPosition":{"type":"string","enum":["top-left","top-center","top-right","center-left","center","center-right","bottom-left","bottom-center","bottom-right"],"title":"Text Position"}}},
    is_active: true,
    display_order: 7
  },
  {
    id: '691f1f4518d71adda8c9fc94',
    name: 'Table/Grid',
    element_type: 'table',
    description: 'Create customizable tables with configurable rows and columns',
    icon: 'Table',
    category: 'content',
    default_content: {"rows":2,"cols":2,"cells":{},"borderColor":"#e2e8f0","headerBgColor":"#f8fafc"},
    available_variants: ["default"],
    content_schema: {},
    is_active: true,
    display_order: 100
  },
  {
    id: '691f53bf055087f9fe888af6',
    name: 'Banner Carousel',
    element_type: 'banner_carousel',
    description: 'Rotating hero banner section with multiple slides',
    icon: 'Images',
    category: 'media',
    default_content: {"banners":[],"autoplayInterval":5},
    available_variants: ["default"],
    content_schema: {},
    is_active: true,
    display_order: 100
  },
  {
    id: '691f55c8b0cae351f843bc5b',
    name: 'Showcase',
    element_type: 'showcase',
    description: 'Display 4 cards from News, Resources, Articles, or Jobs',
    icon: 'LayoutGrid',
    category: 'content',
    default_content: {"headerText":"","descriptionText":"","contentType":"news","backgroundImage":""},
    available_variants: ["default"],
    content_schema: {},
    is_active: true,
    display_order: 101
  },
  {
    id: '69209b58284ef1d24772ee82',
    name: 'Button Block',
    element_type: 'button_block',
    description: 'A block with a header and up to 4 styled buttons',
    icon: 'SquareMousePointer',
    category: 'interactive',
    default_content: {"header":"Take Action","header_alignment":"center","background_color":"#f8fafc","header_font_family":"Poppins","header_font_size":"32","header_color":"#000000","buttons":[{"text":"Learn More","link":"","button_style_id":"","open_in_new_tab":false}]},
    available_variants: ["default"],
    content_schema: {},
    is_active: true,
    display_order: 100
  },
  {
    id: '69209ccd62ed5ef976ff7fc0',
    name: 'Page Header Hero',
    element_type: 'page_header_hero',
    description: 'Hero image with text header positioned left or right',
    icon: 'Image',
    category: 'media',
    default_content: {"image_url":"","header_text":"Welcome","header_position":"left","header_font_family":"Poppins","header_font_size":"48","header_color":"#ffffff"},
    available_variants: ["default"],
    content_schema: {},
    is_active: true,
    display_order: 101
  },
  {
    id: '692368440bfce7613330462a',
    name: 'Resources Showcase',
    element_type: 'resources_showcase',
    description: 'Three-column layout with header, description, CTA button, and resource cards',
    icon: 'Layout',
    category: 'content',
    default_content: {},
    available_variants: ["default"],
    content_schema: {},
    is_active: true,
    display_order: 100
  },
  {
    id: 'accordion_template',
    name: 'Accordion',
    element_type: 'accordion',
    description: 'Expandable FAQ-style accordion with section header, customizable styling, and background options',
    icon: 'List',
    category: 'interactive',
    default_content: {
      header_title: 'Frequently Asked Questions',
      header_subtitle: '',
      header_font_family: 'Poppins',
      header_font_weight: 700,
      header_font_size: 32,
      header_color: '#1e293b',
      header_align: 'center',
      background_type: 'none',
      item_header_font_family: 'Poppins',
      item_header_font_weight: 600,
      item_header_font_size: 18,
      item_header_color: '#1e293b',
      item_header_bg: '#ffffff',
      item_content_font_family: 'Poppins',
      item_content_font_weight: 400,
      item_content_font_size: 16,
      item_content_color: '#475569',
      item_content_line_height: 1.6,
      item_content_bg: '#f8fafc',
      items: []
    },
    available_variants: ["default"],
    content_schema: {},
    is_active: true,
    display_order: 102
  },
  {
    id: 'quote_template',
    name: 'Quote',
    element_type: 'quote',
    description: 'Testimonial or quote block with profile picture, quote text, author name, and decorative quote marks',
    icon: 'Quote',
    category: 'content',
    default_content: {
      quote_text: 'This is an inspiring quote that can be customized with your own content.',
      author_name: 'Author Name',
      profile_image_url: '',
      background_type: 'color',
      background_color: '#f8fafc',
      box_padding: 40,
      box_border_radius: 12,
      box_border_color: '#e2e8f0',
      box_border_width: 1,
      quote_font_family: 'Georgia',
      quote_font_size: 20,
      quote_font_weight: 400,
      quote_color: '#1e293b',
      quote_font_style: 'italic',
      quote_letter_spacing: 0,
      quote_line_height: 1.6,
      quote_align: 'center',
      name_font_family: 'Poppins',
      name_font_size: 16,
      name_font_weight: 600,
      name_color: '#475569',
      name_letter_spacing: 0,
      name_align: 'center',
      quote_mark_color: '#cbd5e1',
      quote_mark_size: 48,
      quote_mark_opacity: 50,
      profile_size: 80,
      profile_border_radius: 50,
      profile_border_color: '#e2e8f0',
      profile_border_width: 2,
      layout: 'stacked'
    },
    available_variants: ["default"],
    content_schema: {},
    is_active: true,
    display_order: 103
  },
  {
    id: 'fifty_fifty_template',
    name: '50/50',
    element_type: 'fifty_fifty',
    description: 'Two-column layout with image or text on each side, background options, column styling, and optional CTA button',
    icon: 'Columns',
    category: 'layout',
    default_content: {
      background_type: 'none',
      background_color: '#ffffff',
      left_content_type: 'text',
      right_content_type: 'image',
      left_heading: 'Your Heading',
      left_subheading: 'Your Subheading',
      left_content: 'Add your content here. Markdown is supported.',
      left_heading_font_family: 'Poppins',
      left_heading_font_weight: 700,
      left_heading_font_size: 32,
      left_heading_color: '#1e293b',
      left_subheading_font_family: 'Poppins',
      left_subheading_font_weight: 500,
      left_subheading_font_size: 20,
      left_subheading_color: '#475569',
      left_content_font_family: 'Poppins',
      left_content_font_weight: 400,
      left_content_font_size: 16,
      left_content_color: '#475569',
      left_text_alignment: 'left',
      left_column_padding: 24,
      right_image_url: '',
      right_image_fit: 'cover',
      right_column_padding: 24,
      column_border_radius: 0,
      button_column: 'left',
      left_vertical_alignment: 'center',
      right_vertical_alignment: 'center',
      column_gap: 32,
      vertical_padding: 48,
      reverse_on_mobile: false
    },
    available_variants: ["default"],
    content_schema: {},
    is_active: true,
    display_order: 104
  },
  {
    id: 'card_deck_template',
    name: 'Card Deck',
    element_type: 'card_deck',
    description: 'Display curated cards from the Card Deck Management system with customizable styling and backgrounds',
    icon: 'LayoutGrid',
    category: 'content',
    default_content: {
      background_type: 'none',
      background_color: '#ffffff',
      gradient_start_color: '#3b82f6',
      gradient_end_color: '#8b5cf6',
      gradient_angle: 135,
      background_image_url: '',
      background_image_fit: 'cover',
      overlay_enabled: false,
      overlay_color: '#000000',
      overlay_opacity: 50,
      heading: '',
      subheading: '',
      body_content: '',
      text_alignment: 'center',
      vertical_padding: 48,
      horizontal_padding: 16,
      cardCount: 3,
      cardIds: [],
      cardBorderRadius: 12,
      cardBackgroundColor: '#ffffff',
      cardShadow: true,
      showCardImage: true,
      imageHeightPercent: 50,
      showCardDescription: true,
      descriptionLineClamp: 3,
      showCardButton: true,
      cardButtonText: 'Learn More',
      cardButtonBgColor: '#2563eb',
      cardButtonTextColor: '#ffffff'
    },
    available_variants: ["default"],
    content_schema: {},
    is_active: true,
    display_order: 105
  }
];

async function importTemplates() {
  console.log("Starting IEdit Element Templates import to Supabase...");
  
  // First check if table exists by trying to query it
  const { data: existingData, error: checkError } = await supabase
    .from('i_edit_element_template')
    .select('id')
    .limit(1);

  if (checkError) {
    console.error("Error checking table:", checkError.message);
    console.log("The table may not exist in Supabase. Please create it first.");
    process.exit(1);
  }

  console.log(`Found table. Inserting ${templates.length} templates...`);

  // First, check for existing templates by element_type
  const { data: existingTemplates } = await supabase
    .from('i_edit_element_template')
    .select('id, element_type');

  const existingByType = new Map(existingTemplates?.map(t => [t.element_type, t.id]) || []);

  // Insert templates with generated UUIDs (skip ID field, let Supabase generate it)
  for (const template of templates) {
    // Check if template with this element_type already exists
    if (existingByType.has(template.element_type)) {
      console.log(`⊘ Skipped (exists): ${template.name} (${template.element_type})`);
      continue;
    }

    // Create a new object without the id field - let Supabase generate UUID
    const { id, ...templateWithoutId } = template;

    const { data, error } = await supabase
      .from('i_edit_element_template')
      .insert(templateWithoutId)
      .select();

    if (error) {
      console.error(`Error inserting template ${template.name}:`, error.message);
    } else {
      console.log(`✓ Inserted: ${template.name} (id: ${data?.[0]?.id})`);
    }
  }

  // Verify the import
  const { data: finalData, error: finalError } = await supabase
    .from('i_edit_element_template')
    .select('id, name, element_type')
    .order('display_order');

  if (finalError) {
    console.error("Error verifying import:", finalError.message);
  } else {
    console.log(`\n✓ Import complete. ${finalData?.length || 0} templates in database.`);
    finalData?.forEach(t => console.log(`  - ${t.name} (${t.element_type})`));
  }
}

importTemplates().catch(console.error);
