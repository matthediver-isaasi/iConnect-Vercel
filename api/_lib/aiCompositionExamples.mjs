/**
 * AI Composition example documents — Phase 0 fixtures.
 *
 * Two examples proving the draft schema (api/_lib/aiCompositionSchema.js)
 * expresses both scopes the spec requires from one shape:
 *   1. WHOLE_PAGE_EXAMPLE  — multi-section conference landing page
 *   2. SECTION_EXAMPLE     — single membership-process infographic section
 *
 * Both must pass validateComposition() — enforced by
 * aiCompositionSchema.test.mjs (part of the ai-assistant-tests suite).
 */

export const WHOLE_PAGE_EXAMPLE = {
  schemaVersion: 1,
  id: 'comp_conference_2026',
  name: 'Annual conference landing page',
  compositionType: 'multi_section_page',
  status: 'draft',
  originalPrompt:
    'Create a complete landing page for our annual conference, including a hero, benefits, and a registration call to action.',
  sections: [
    {
      id: 'section_hero',
      name: 'Hero',
      type: 'ai_section',
      readingOrder: ['hero_bg', 'hero_heading', 'hero_sub', 'hero_cta'],
      elements: [
        {
          id: 'hero_bg',
          type: 'background',
          style: {
            backgroundImage: 'linear-gradient(135deg, #2b0a4d 0%, #5C0085 100%)',
          },
        },
        {
          id: 'hero_heading',
          type: 'heading',
          role: 'h1',
          content: { text: 'Shaping the profession together' },
          style: { color: '#ffffff', fontSize: '56px', fontWeight: '700', textAlign: 'center' },
        },
        {
          id: 'hero_sub',
          type: 'paragraph',
          content: { text: 'Join 800 colleagues for two days of insight, connection and celebration.' },
          style: { color: '#ffffff', fontSize: '20px', textAlign: 'center', opacity: '0.9' },
        },
        {
          id: 'hero_cta',
          type: 'button',
          content: { text: 'Register now' },
          link: { kind: 'event_registration', eventId: '4f6f2f9e-0000-4000-8000-000000000001' },
          style: { backgroundColor: '#ffffff', color: '#5C0085', borderRadius: '6px', fontWeight: '600' },
        },
      ],
    },
    {
      id: 'section_benefits',
      name: 'Why attend',
      type: 'ai_section',
      readingOrder: ['benefits_heading', 'benefits_grid'],
      elements: [
        {
          id: 'benefits_heading',
          type: 'heading',
          role: 'h2',
          content: { text: 'Why attend' },
          style: { fontSize: '36px', textAlign: 'center' },
        },
        {
          id: 'benefits_grid',
          type: 'container',
          style: { gap: '24px' },
          children: [
            {
              id: 'benefit_card_1',
              type: 'card',
              children: [
                { id: 'benefit_1_stat', type: 'statistic', data: { value: '40+', label: 'expert sessions' } },
                { id: 'benefit_1_copy', type: 'paragraph', content: { text: 'A programme spanning practice, policy and research.' } },
              ],
            },
            {
              id: 'benefit_card_2',
              type: 'card',
              children: [
                { id: 'benefit_2_stat', type: 'statistic', data: { value: '800', label: 'delegates' } },
                { id: 'benefit_2_copy', type: 'paragraph', content: { text: 'The largest annual gathering of our community.' } },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'section_register',
      name: 'Registration call to action',
      type: 'ai_section',
      readingOrder: ['register_heading', 'register_copy', 'register_button'],
      elements: [
        {
          id: 'register_heading',
          type: 'heading',
          role: 'h2',
          content: { text: 'Secure your place' },
          style: { fontSize: '32px', textAlign: 'center' },
        },
        {
          id: 'register_copy',
          type: 'paragraph',
          content: { text: 'Early-bird registration closes 31 August at £249.' },
          style: { textAlign: 'center' },
        },
        {
          id: 'register_button',
          type: 'button',
          content: { text: 'Register for the conference' },
          link: { kind: 'event_registration', eventId: '4f6f2f9e-0000-4000-8000-000000000001' },
          style: { backgroundColor: '#5C0085', color: '#ffffff', borderRadius: '6px' },
        },
      ],
    },
  ],
  layouts: {
    desktop: {
      hero_bg: { mode: 'absolute', x: 0, y: 0, w: 1200, h: 560, z: 0 },
      hero_heading: { mode: 'absolute', x: 150, y: 160, w: 900, h: null, z: 1 },
      hero_sub: { mode: 'absolute', x: 250, y: 260, w: 700, h: null, z: 1 },
      hero_cta: { mode: 'absolute', x: 510, y: 360, w: 180, h: 48, z: 1 },
      benefits_heading: { mode: 'flow', minH: 48 },
      benefits_grid: { mode: 'grid', minH: 240 },
      benefit_card_1: { mode: 'flow' },
      benefit_card_2: { mode: 'flow' },
      benefit_1_stat: { mode: 'flow' },
      benefit_1_copy: { mode: 'flow' },
      benefit_2_stat: { mode: 'flow' },
      benefit_2_copy: { mode: 'flow' },
      register_heading: { mode: 'flow' },
      register_copy: { mode: 'flow' },
      register_button: { mode: 'flow', w: 280, h: 48 },
    },
    mobile: {
      hero_heading: { x: 20, y: 120, w: 350 },
      hero_sub: { x: 20, y: 220, w: 350 },
      hero_cta: { x: 20, y: 320, w: 350 },
      benefits_grid: { mode: 'flex' },
    },
  },
  protectedValues: [
    {
      id: 'pv_event_link',
      kind: 'event_ref',
      elementId: 'hero_cta',
      path: 'link',
      value: '4f6f2f9e-0000-4000-8000-000000000001',
      source: { type: 'event', recordId: '4f6f2f9e-0000-4000-8000-000000000001' },
      confirmedBy: 'record',
    },
    {
      id: 'pv_price',
      kind: 'price',
      elementId: 'register_copy',
      path: 'content.text',
      value: '£249',
      source: { type: 'event', recordId: '4f6f2f9e-0000-4000-8000-000000000001', field: 'early_bird_price' },
      confirmedBy: 'record',
    },
  ],
  generatedAssets: [],
  conversation: [],
  generationMetadata: { model: 'draft-fixture', creativity: 'brand_led' },
  accessibility: {},
  currentVersionId: null,
};

export const SECTION_EXAMPLE = {
  schemaVersion: 1,
  id: 'comp_membership_process',
  name: 'Membership application process infographic',
  compositionType: 'section',
  status: 'draft',
  originalPrompt:
    'Create an engaging infographic explaining the membership application process. Match the design and tone of the rest of this page.',
  sections: [
    {
      id: 'section_process',
      name: 'Application process',
      type: 'ai_section',
      readingOrder: ['process_heading', 'process_intro', 'process_steps', 'process_cta'],
      elements: [
        {
          id: 'process_heading',
          type: 'heading',
          role: 'h2',
          content: { text: 'How to apply in three steps' },
          style: { fontSize: '32px' },
        },
        {
          id: 'process_intro',
          type: 'paragraph',
          content: { html: '<p>Applying takes around <strong>ten minutes</strong>. Here is what to expect.</p>' },
        },
        {
          id: 'process_steps',
          type: 'structured_infographic',
          data: { a11ySummary: 'Three sequential steps: complete the form, assessment by the panel, receive your decision.' },
          children: [
            {
              id: 'step_1',
              type: 'process_step',
              data: { index: 1, title: 'Complete the application form', detail: 'Tell us about your experience and qualifications.' },
            },
            {
              id: 'step_2',
              type: 'process_step',
              data: { index: 2, title: 'Panel assessment', detail: 'Our membership panel reviews applications monthly.' },
            },
            {
              id: 'step_3',
              type: 'process_step',
              data: { index: 3, title: 'Receive your decision', detail: 'Most applicants hear back within four weeks.' },
            },
          ],
        },
        {
          id: 'process_cta',
          type: 'button',
          content: { text: 'Start your application' },
          link: { kind: 'form', formId: '8a1b3c5d-0000-4000-8000-000000000002' },
          style: { backgroundColor: '#5C0085', color: '#ffffff', borderRadius: '6px' },
        },
      ],
    },
  ],
  layouts: {
    desktop: {
      process_heading: { mode: 'flow' },
      process_intro: { mode: 'flow' },
      process_steps: { mode: 'flex', minH: 220 },
      step_1: { mode: 'flow' },
      step_2: { mode: 'flow' },
      step_3: { mode: 'flow' },
      process_cta: { mode: 'flow', w: 260, h: 48 },
    },
    mobile: {
      process_steps: { mode: 'flex' },
      process_cta: { w: 350 },
    },
  },
  protectedValues: [
    {
      id: 'pv_form_link',
      kind: 'form_ref',
      elementId: 'process_cta',
      path: 'link',
      value: '8a1b3c5d-0000-4000-8000-000000000002',
      source: { type: 'form', recordId: '8a1b3c5d-0000-4000-8000-000000000002' },
      confirmedBy: 'user',
    },
  ],
  generatedAssets: [],
  conversation: [],
  generationMetadata: { model: 'draft-fixture', creativity: 'strict' },
  accessibility: {},
  currentVersionId: null,
};
