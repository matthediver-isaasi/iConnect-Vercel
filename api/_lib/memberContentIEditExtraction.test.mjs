import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IEDIT_COMPONENT_POLICIES, extractIEditElement } from './memberContentIEditExtraction.js';

const extract = (element_type, content = {}, extra = {}) => extractIEditElement({ element_type, content, ...extra });
const texts = result => result.sections.map(section => section.text);
const dynamicTypes = new Set(['wall_of_fame', 'form', 'showcase', 'resources_showcase', 'organisation_directory', 'featured_job', 'card_deck', 'event_spotlight', 'gallery']);

// Independent, explicit examples for every renderer registration. The shared
// denial payload makes accidental recursive/stringify-based extraction fail.
const examples = {
  hero: [{ heading: 'Heading', subheading: 'Subheading', content_text: 'Body', button: { text: 'Action', link: 'SECRET' } }, ['Heading', 'Subheading', 'Body', 'Action']],
  text_block: [{ heading: 'Heading', text: '<p>Body</p>' }, ['Heading', 'Body']],
  image: [{ imageUrl: 'SECRET', altText: 'Accessible image', caption: 'Caption' }, ['Accessible image', 'Caption']],
  two_column: [{ leftHeading: 'Left', leftContent: 'Left body', rightHeading: 'Right', rightContent: 'Right body' }, ['Left', 'Left body', 'Right', 'Right body']],
  cta_button: [{ button: { text: 'Action', link: 'SECRET', member: { name: 'SECRET' } } }, ['Action']],
  image_hero: [{ backgroundImageUrl: 'SECRET', foregroundImageUrl: 'SECRET', title: 'SECRET', altText: 'SECRET' }, []],
  wall_of_fame: [{ heading_text: 'Heading', subheading_text: 'Subheading', body_content: 'Body', custom_title: 'Category', section_id: 'SECRET' }, ['Heading', 'Subheading', 'Body', 'Category']],
  form: [{ heading: 'Heading', subheading: 'Subheading', text_content: 'Body', form_slug: 'SECRET', fields: [{ label: 'SECRET', value: 'SECRET' }] }, ['Heading', 'Subheading', 'Body']],
  text_overlay_image: [{ header: 'Header', text: 'Body' }, ['Header', 'Body']],
  table: [{ header: 'Header', description: 'Description', rows: 1, cols: 2, cells: { '0-1': 'Cell two', '0-0': '<b>Cell one</b>' } }, ['Header', 'Description', 'Cell one', 'Cell two']],
  banner_carousel: [{ banners: [{ headerText: 'Header', paragraphText: 'Body', ctaText: 'Action', ctaLink: 'SECRET', metadata: 'SECRET' }] }, ['Header', 'Body', 'Action']],
  showcase: [{ headerText: 'Header', descriptionText: 'Description', body_content: 'Body', cards: [{ title: 'SECRET', summary: 'SECRET', itemId: 'SECRET' }] }, ['Header', 'Description', 'Body']],
  resources_showcase: [{ headerText: 'Header', subheaderText: 'Subheader', descriptionText: 'Description', button_text: 'Action', resources: [{ title: 'SECRET' }] }, ['Header', 'Subheader', 'Description', 'Action']],
  button_block: [{ heading_text: 'Heading', subheading_text: 'Subheading', body_content: 'Body', buttons: [{ text: 'First', url: 'SECRET' }, { text: 'Second' }] }, ['Heading', 'Subheading', 'Body', 'First', 'Second']],
  page_header_hero: [{ header_text: 'Header', subheading_text: 'Subheading', content_text: 'Body' }, ['Header', 'Subheading', 'Body']],
  organisation_directory: [{ header_title: 'Header', header_subtitle: 'Subtitle', header_content: 'Body', organizations: [{ name: 'SECRET' }], members: [{ full_name: 'SECRET' }] }, ['Header', 'Subtitle', 'Body']],
  featured_job: [{ header_label: 'Label', main_heading: 'Heading', subheading: 'Subheading', button_text: 'Action', right_header_text: 'Right', specific_job_id: 'SECRET', job: { title: 'SECRET' } }, ['Label', 'Heading', 'Subheading', 'Action', 'Right']],
  image_panel: [{ panels: [{ header_text: 'Header', bottom_text: 'Bottom', button: { text: 'Action', link: 'SECRET' }, caption: 'SECRET' }] }, ['Header', 'Bottom', 'Action']],
  accordion: [{ header_title: 'Header', header_subtitle: 'Subtitle', header_content: 'Body', items: [{ title: 'Question', content: 'Answer', links: [{ label: 'Download', url: 'SECRET' }], files: [{ description: 'SECRET' }] }] }, ['Header', 'Subtitle', 'Body', 'Question', 'Answer', 'Download']],
  quote: [{ header_title: 'Header', header_subtitle: 'Subtitle', header_content: 'Body', quotes: [{ quote_text: 'Quotation', author_name: 'Authored attribution', email: 'SECRET' }] }, ['Header', 'Subtitle', 'Body', 'Quotation', 'Authored attribution']],
  fifty_fifty: [{ header_title: 'Header', header_subtitle: 'Subtitle', header_content: 'Body', left_heading: 'Left', left_subheading: 'Left subtitle', left_content: 'Left body', right_heading: 'Right', right_subheading: 'Right subtitle', right_content: 'Right body', button: { text: 'Action' } }, ['Header', 'Subtitle', 'Body', 'Left', 'Left subtitle', 'Left body', 'Right', 'Right subtitle', 'Right body', 'Action']],
  card_deck: [{ heading: 'Heading', subheading: 'Subheading', body_content: 'Body', cardButtonText: 'Action', cardIds: ['SECRET'], cards: [{ title: 'SECRET' }] }, ['Heading', 'Subheading', 'Body']],
  logo_grid: [{ heading: 'Heading', subheading: 'Subheading', body_content: 'Body', logos: [{ name: 'Logo name', url: 'SECRET', image_url: 'SECRET', caption: 'SECRET' }] }, ['Heading', 'Subheading', 'Body', 'Logo name']],
  event_spotlight: [{ heading: 'Heading', subheading: 'Subheading', additional_content: 'Body', button: { text: 'Action' }, event: { title: 'SECRET' }, speakers: [{ full_name: 'SECRET' }] }, ['Heading', 'Subheading', 'Body', 'Action']],
  video: [{ title: 'Title', caption: 'Caption', transcript: 'Transcript', embed_code: '<p>SECRET</p>', captions_url: 'SECRET' }, ['Title', 'Caption', 'Transcript']],
  timeline: [{ title: 'Timeline', items: [{ year: 2026, heading: 'Heading', body: 'Body', media_items: [{ src: 'SECRET', alt: 'Image alt', caption: 'SECRET' }], sub_items: [{ year: 'Spring', heading: 'Subheading', body: 'Sub body', media: { src: 'SECRET', alt: 'Legacy alt' } }] }] }, ['Timeline', '2026', 'Heading', 'Body', 'Image alt', 'Spring', 'Subheading', 'Sub body', 'Legacy alt']],
  hero_carousel: [{ slides: [{ headerText: 'Header', subheadingText: 'Subheading', contentText: 'Body', ctaText: 'Action', ctaLink: 'SECRET', imageUrl: 'SECRET', altText: 'SECRET' }] }, ['Header', 'Subheading', 'Body', 'Action']],
  gallery: [{ heading: 'Heading', gallery_ids: ['SECRET'], galleries: [{ title: 'SECRET', photos: [{ caption: 'SECRET' }] }] }, ['Heading']],
};

test('closed policy exactly covers all 28 actual renderer registrations', () => {
  const renderer = readFileSync(new URL('../../client/src/components/iedit/IEditElementRenderer.jsx', import.meta.url), 'utf8');
  const types = [...renderer.matchAll(/^\s+'([a-z_]+)':/gm)].map(match => match[1]).sort();
  assert.equal(types.length, 28);
  assert.deepEqual(Object.keys(IEDIT_COMPONENT_POLICIES).sort(), types);
  assert.deepEqual(Object.keys(examples).sort(), types);
  assert.ok(Object.isFrozen(IEDIT_COMPONENT_POLICIES));
  for (const policy of Object.values(IEDIT_COMPONENT_POLICIES)) {
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.fields));
  }
});

for (const [type, [content, expected]] of Object.entries(examples)) {
  test(`${type}: only authored allowlisted copy, correct dynamic dispatch`, () => {
    const denied = {
      memberInfo: { name: 'SECRET', email: 'SECRET' },
      organizationInfo: { name: 'SECRET' },
      formValues: { name: 'SECRET' },
      prefill: 'SECRET', submitted_values: 'SECRET', draftToken: 'SECRET',
      configuration: 'SECRET', anchor: 'SECRET', background_color: 'SECRET',
      mobile_heading_font_family: 'SECRET', unexpected: { text: 'SECRET' },
    };
    const input = { ...denied, ...structuredClone(content) };
    const before = structuredClone(input);
    const result = extract(type, input, { settings: { title: 'SECRET' }, memberInfo: denied.memberInfo, runtime: 'SECRET' });
    assert.deepEqual(texts(result), expected);
    assert.equal(result.dynamic, dynamicTypes.has(type));
    assert.deepEqual(input, before, 'extraction must not mutate source content');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    for (const section of result.sections) assert.deepEqual(Object.keys(section), ['text']);
  });
}

test('dynamic empty types retain dynamic dispatch without fabricating default copy', () => {
  for (const type of Object.keys(examples)) {
    assert.deepEqual(extract(type), { sections: [], dynamic: dynamicTypes.has(type) });
    assert.deepEqual(extract(type, null), { sections: [], dynamic: dynamicTypes.has(type) });
    assert.deepEqual(extract(type, 'SECRET'), { sections: [], dynamic: dynamicTypes.has(type) });
  }
});

test('unknown, inherited and absent types throw explicitly', () => {
  for (const type of ['future_widget', '__proto__', 'constructor', '', null, undefined]) {
    assert.throws(() => extract(type), /Unsupported iEdit element type/);
  }
  assert.throws(() => extractIEditElement(null), /Unsupported iEdit element type/);
});

test('rich text keeps boundaries, entities, captions, link labels and image alt, not HTML attributes or executable/embed content', () => {
  const result = extract('text_block', {
    text: '<h2>Heading &amp; context</h2><p>Hello <strong>world</strong> &#x1f600;.</p><p><a href="SECRET" title="SECRET">Read more</a></p><figure><img src="SECRET" alt="Accessible &quot;picture&quot;"><figcaption>Caption</figcaption></figure><script>SECRET</script><style>SECRET</style><iframe title="SECRET">SECRET</iframe><template>SECRET</template><input value="SECRET"><textarea>SECRET</textarea><span hidden>SECRET</span><span aria-hidden="true">SECRET</span><span style="display: none">SECRET</span><img role="presentation" alt="SECRET">',
  });
  assert.equal(texts(result).join('\n'), 'Heading & context\nHello world 😀.\nRead more\nAccessible "picture"\nCaption');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('only strings and timeline numeric years become sections; arbitrary objects never stringify', () => {
  assert.deepEqual(texts(extract('hero', { heading: { text: 'SECRET' }, subheading: ['SECRET'], content_text: 42, button: { text: false } })), []);
  assert.deepEqual(texts(extract('timeline', { items: [{ year: 0, heading: { text: 'SECRET' } }, { year: NaN }, null] })), ['0']);
  assert.deepEqual(texts(extract('accordion', { items: [null, { title: 'Question', content: 42, links: [null, { label: { value: 'SECRET' } }] }] })), ['Question']);
});

test('renderer visibility branches omit decorative/missing images and inactive columns and controls', () => {
  assert.deepEqual(texts(extract('image', { imageUrl: 'url', decorative: true, altText: 'SECRET', caption: 'Caption' })), ['Caption']);
  assert.deepEqual(texts(extract('image', { altText: 'SECRET', caption: 'SECRET' })), []);
  assert.deepEqual(texts(extract('fifty_fifty', { left_content_type: 'image', left_heading: 'SECRET', left_content: 'SECRET', right_content: 'Visible' })), ['Visible']);
  assert.deepEqual(texts(extract('wall_of_fame', { custom_title: 'SECRET', show_category_name: false })), []);
  assert.deepEqual(texts(extract('card_deck', { cardButtonText: 'SECRET', showCardButton: false })), []);
  assert.deepEqual(texts(extract('event_spotlight', { button: { text: 'SECRET' }, show_cta_button: false })), []);
  for (const type of ['banner_carousel', 'hero_carousel']) {
    const key = type === 'banner_carousel' ? 'banners' : 'slides';
    assert.deepEqual(texts(extract(type, { [key]: [{ ctaText: 'SECRET' }] })), []);
  }
});

test('legacy quotes only render with quote_text and are superseded by a configured quote list', () => {
  assert.deepEqual(texts(extract('quote', { author_name: 'SECRET' })), []);
  assert.deepEqual(texts(extract('quote', { quote_text: 'Legacy quote', author_name: 'Legacy attribution' })), ['Legacy quote', 'Legacy attribution']);
  assert.deepEqual(texts(extract('quote', { quote_text: 'SECRET', author_name: 'SECRET', quotes: [{ quote_text: 'Current', author_name: 'Author' }] })), ['Current', 'Author']);
});

test('panel renderer uses at most five configured panels, not arbitrary descendant copy', () => {
  const panels = Array.from({ length: 6 }, (_, index) => ({ header_text: index < 5 ? `Panel ${index}` : 'SECRET' }));
  assert.deepEqual(texts(extract('image_panel', { panels })), panels.slice(0, 5).map(panel => panel.header_text));
});

test('table bounds, row-major order, header cells and image cells match renderer', () => {
  const result = extract('table', {
    rows: 2, cols: 2,
    cells: { '1-1': 'Last', '0-1': 'SECRET', '1-0': 'Body', '0-0': 'Header', '2-0': 'SECRET', '-1-0': 'SECRET', '0-2': 'SECRET', config: 'SECRET', '00-0': 'SECRET' },
    cellTypes: { '0-0': 'header', '0-1': 'image' },
  });
  assert.deepEqual(texts(result), ['Header', 'Body', 'Last']);
});

test('timeline traverses selected columns, sub-items, and media fallback without config or stale branches', () => {
  const result = extract('timeline', {
    items: [{
      year: 'Era', columns: 2, heading: 'SECRET', body: 'SECRET', sub_items: [{ body: 'SECRET' }],
      column_content: [
        { year: 'SECRET', heading: 'Column one', body: 'One', media: { src: 'url', alt: 'SECRET' }, media_items: [{ src: 'url', alt: 'Current alt' }, { alt: 'SECRET' }], sub_items: [{ year: 'Spring', body: 'Sub body', sub_items: [{ body: 'SECRET' }] }] },
        { heading: 'Column two', media: { type: 'video', src: 'url', alt: 'SECRET' } },
        { heading: 'SECRET' },
      ],
    }],
  });
  assert.deepEqual(texts(result), ['Era', 'Column one', 'One', 'Current alt', 'Spring', 'Sub body', 'Column two']);
});
