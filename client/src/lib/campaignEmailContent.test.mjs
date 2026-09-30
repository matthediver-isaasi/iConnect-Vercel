import test from 'node:test';
import assert from 'node:assert/strict';

import { applyCampaignTemplate, resolveCampaignContent } from './campaignEmailContent.js';
import {
  BLOCK_TYPES,
  defaultEmailDesign,
  normalizeEmailDesign,
  normalizeDuplicateDynamicTokens,
} from '../components/email-builder/types.js';

const nestedDesign = {
  type: 'custom-email-builder',
  version: 1,
  globalStyles: {
    backgroundColor: '#102030',
    contentWidth: '720px',
  },
  blocks: [
    {
      id: 'hero',
      type: BLOCK_TYPES.IMAGE,
      src: 'https://images.example.invalid/hero.png',
      alt: 'Campaign hero',
      styles: { width: '82%', textAlign: 'right', paddingTop: '17' },
    },
    {
      id: 'section',
      type: BLOCK_TYPES.SECTION,
      styles: { backgroundColor: '#ffeecc' },
      children: [{
        id: 'section-image',
        type: BLOCK_TYPES.IMAGE,
        src: 'https://images.example.invalid/section.png',
        styles: { maxWidth: '311px' },
      }],
    },
    {
      id: 'columns',
      type: BLOCK_TYPES.COLUMNS,
      styles: { paddingLeft: '13' },
      columns: [
        {
          id: 'left',
          width: '40%',
          backgroundColor: '#abcdef',
          blocks: [{
            id: 'column-image',
            type: BLOCK_TYPES.IMAGE,
            src: 'https://images.example.invalid/column.png',
            styles: { imageSize: '63%', borderRadius: '9px' },
          }],
        },
        {
          id: 'right',
          width: '60%',
          blocks: [{
            id: 'column-text',
            type: BLOCK_TYPES.TEXT,
            content: '<p>Nested copy</p>',
            styles: { color: '#445566', fontFamily: 'Georgia' },
          }],
        },
      ],
    },
  ],
};

test('normalizeEmailDesign accepts object and JSON string as detached snapshots', () => {
  for (const persisted of [nestedDesign, JSON.stringify(nestedDesign)]) {
    const normalized = normalizeEmailDesign(persisted);
    assert.notEqual(normalized, nestedDesign);
    assert.deepEqual(normalized.blocks, nestedDesign.blocks);
    assert.deepEqual(normalized.globalStyles, {
      ...defaultEmailDesign.globalStyles,
      ...nestedDesign.globalStyles,
    });

    normalized.blocks[0].styles.width = '1%';
    normalized.blocks[1].children[0].src = 'changed';
    normalized.blocks[2].columns[0].blocks[0].styles.imageSize = '1%';
    assert.equal(nestedDesign.blocks[0].styles.width, '82%');
    assert.equal(nestedDesign.blocks[1].children[0].src, 'https://images.example.invalid/section.png');
    assert.equal(nestedDesign.blocks[2].columns[0].blocks[0].styles.imageSize, '63%');
  }
});

test('normalizeEmailDesign preserves nested images, columns, and styling', () => {
  const normalized = normalizeEmailDesign(nestedDesign);
  assert.equal(normalized.blocks[0].src, 'https://images.example.invalid/hero.png');
  assert.deepEqual(normalized.blocks[0].styles, nestedDesign.blocks[0].styles);
  assert.deepEqual(normalized.blocks[1].children[0].styles, { maxWidth: '311px' });
  assert.equal(normalized.blocks[2].columns[0].backgroundColor, '#abcdef');
  assert.deepEqual(
    normalized.blocks[2].columns[0].blocks[0].styles,
    { imageSize: '63%', borderRadius: '9px' },
  );
  assert.deepEqual(
    normalized.blocks[2].columns[1].blocks[0].styles,
    { color: '#445566', fontFamily: 'Georgia' },
  );
});

test('normalizeEmailDesign rejects malformed and invalid nested containers', () => {
  const invalid = [
    null,
    undefined,
    '',
    'not json',
    'null',
    '{}',
    '{"blocks":{}}',
    { type: 'custom-email-builder' },
    { blocks: [null] },
    { blocks: [{ id: 'missing-type' }] },
    { blocks: [{ id: 'unknown-type', type: 'made-up-email-block', styles: {} }] },
    { blocks: [{ id: 'section-object-children', type: BLOCK_TYPES.SECTION, children: {} }] },
    { blocks: [{ id: 'section-no-children', type: BLOCK_TYPES.SECTION }] },
    { blocks: [{ id: 'section-with-columns', type: BLOCK_TYPES.SECTION, children: [], columns: [] }] },
    { blocks: [{ id: 'text-invalid-child', type: BLOCK_TYPES.TEXT, children: [{ id: 'nested-without-type' }] }] },
    { blocks: [{ id: 'text-empty-children', type: BLOCK_TYPES.TEXT, children: [] }] },
    { blocks: [{ id: 'image-empty-children', type: BLOCK_TYPES.IMAGE, children: [] }] },
    { blocks: [{ id: 'button-with-columns', type: BLOCK_TYPES.BUTTON, columns: [{ id: 'button-col', blocks: [] }] }] },
    { blocks: [{ id: 'columns-object', type: BLOCK_TYPES.COLUMNS, columns: {} }] },
    { blocks: [{ id: 'columns-missing', type: BLOCK_TYPES.COLUMNS }] },
    { blocks: [{ id: 'columns-with-children', type: BLOCK_TYPES.COLUMNS, columns: [], children: [] }] },
    { blocks: [{ id: 'columns-null-column', type: BLOCK_TYPES.COLUMNS, columns: [null] }] },
    { blocks: [{ id: 'columns-object-blocks', type: BLOCK_TYPES.COLUMNS, columns: [{ id: 'col-object-blocks', blocks: {} }] }] },
    { blocks: [{ id: 'columns-invalid-block', type: BLOCK_TYPES.COLUMNS, columns: [{ id: 'col-invalid-block', blocks: [{ id: 'without-type' }] }] }] },
    { blocks: [{
      id: 'columns-duplicate-column-id',
      type: BLOCK_TYPES.COLUMNS,
      columns: [
        { id: 'duplicate-column', blocks: [] },
        { id: 'duplicate-column', blocks: [] },
      ],
    }] },
    { blocks: [{ id: 'social-missing-platforms', type: BLOCK_TYPES.SOCIAL_ICONS }] },
    { blocks: [{ id: 'social-object-platforms', type: BLOCK_TYPES.SOCIAL_ICONS, platforms: {} }] },
    { blocks: [{ id: 'social-null-platform', type: BLOCK_TYPES.SOCIAL_ICONS, platforms: [null] }] },
    { blocks: [{ id: 'social-missing-key', type: BLOCK_TYPES.SOCIAL_ICONS, platforms: [{ enabled: true }] }] },
    { blocks: [{ id: 'social-non-string-key', type: BLOCK_TYPES.SOCIAL_ICONS, platforms: [{ key: 42 }] }] },
  ];
  for (const value of invalid) assert.equal(normalizeEmailDesign(value), null);
});

test('template snapshots preserve dynamic values and remain repairable without mutating their source', () => {
  const source = {
    id: 'dynamic-template', editor_type: 'visual', body: '<p>Dynamic HTML</p>',
    design_json: {
      blocks: [
        { id: 'dynamic-a', type: BLOCK_TYPES.DYNAMIC_BUTTON, token: 'dynamic_1', linkToken: 'dynamic_1_link', styles: { color: '#123456' } },
        { id: 'dynamic-b', type: BLOCK_TYPES.DYNAMIC_BUTTON, token: 'dynamic_1', linkToken: 'dynamic_1_link', styles: { color: '#654321' } },
      ],
      slotValues: { dynamic_1: 'Register', dynamic_1_link: 'https://example.invalid/register' },
    },
  };
  const before = JSON.stringify(source);
  const loaded = applyCampaignTemplate({}, source);
  const repaired = normalizeDuplicateDynamicTokens(loaded.design_json);
  assert.equal(repaired.changed, true);
  assert.equal(repaired.design.blocks[1].token, 'dynamic_2');
  assert.equal(repaired.design.slotValues.dynamic_2, 'Register');
  assert.equal(repaired.design.slotValues.dynamic_2_link, 'https://example.invalid/register');
  const reopened = resolveCampaignContent(JSON.parse(JSON.stringify({ ...loaded, design_json: repaired.design })));
  assert.deepEqual(reopened.design_json, repaired.design);
  assert.equal(JSON.stringify(source), before);
});

test('resolveCampaignContent prefers the saved design snapshot and preserves saved HTML', () => {
  const campaign = {
    email_template_id: 'linked-template-that-may-have-changed',
    html_content: '<html><body>Saved generated HTML</body></html>',
    design_json: JSON.stringify(nestedDesign),
    template: {
      body: '<p>New linked-template HTML must not replace campaign content</p>',
      design_json: { blocks: [] },
    },
  };
  const resolved = resolveCampaignContent(campaign);
  assert.equal(resolved.editorMode, 'visual');
  assert.equal(resolved.html_content, campaign.html_content);
  assert.deepEqual(resolved.design_json.blocks, nestedDesign.blocks);
  assert.notEqual(resolved.design_json, nestedDesign);
});

test('resolveCampaignContent uses HTML for malformed designs and visual for blank campaigns', () => {
  assert.deepEqual(resolveCampaignContent({
    html_content: '<p>Hand-authored HTML</p>',
    design_json: '{"blocks":"broken"}',
  }), {
    html_content: '<p>Hand-authored HTML</p>',
    design_json: null,
    editorMode: 'html',
  });
  assert.deepEqual(resolveCampaignContent({
    html_content: '   ',
    design_json: null,
  }), {
    html_content: '   ',
    design_json: null,
    editorMode: 'visual',
  });
  assert.deepEqual(resolveCampaignContent(), {
    html_content: '',
    design_json: null,
    editorMode: 'visual',
  });
});

test('applying visual A then visual B then HTML clears stale snapshots and keeps sources immutable', () => {
  const previous = {
    name: 'Quarterly campaign',
    subject: 'Keep my subject',
    from_name: '',
    from_email: 'campaign@example.invalid',
    reply_to: 'reply@example.invalid',
    html_content: '<p>Old campaign</p>',
    design_json: normalizeEmailDesign(nestedDesign),
  };
  const visualA = {
    id: 'visual-a',
    subject: 'Subject A',
    from_name: 'Sender A',
    from_email: 'a@example.invalid',
    body: '<p>Generated A</p>',
    design_json: nestedDesign,
    editor_type: 'visual',
  };
  const visualBDesign = {
    type: 'custom-email-builder',
    blocks: [{ id: 'b', type: BLOCK_TYPES.TEXT, content: '<p>Design B</p>', styles: { color: '#bada55' } }],
  };
  const visualB = {
    id: 'visual-b',
    subject: 'Subject B',
    from_name: 'Sender B',
    from_email: 'b@example.invalid',
    body: '<p>Generated B</p>',
    design_json: JSON.stringify(visualBDesign),
    editor_type: 'visual',
  };
  const html = {
    id: 'html-c',
    subject: 'Subject C',
    from_name: 'Sender C',
    from_email: 'c@example.invalid',
    body: '<table><tr><td>HTML C</td></tr></table>',
    design_json: nestedDesign,
    editor_type: 'html',
  };
  const sourceSnapshots = JSON.stringify({ previous, visualA, visualB, html });

  const afterA = applyCampaignTemplate(previous, visualA);
  assert.equal(resolveCampaignContent(afterA).editorMode, 'visual');
  assert.equal(afterA.subject, 'Keep my subject');
  assert.equal(afterA.from_name, 'Sender A');
  assert.equal(afterA.from_email, 'campaign@example.invalid');
  assert.equal(afterA.html_content, visualA.body);

  const afterB = applyCampaignTemplate(afterA, visualB);
  assert.equal(afterB.email_template_id, 'visual-b');
  assert.equal(afterB.html_content, visualB.body);
  assert.deepEqual(afterB.design_json.blocks, visualBDesign.blocks);
  assert.equal(resolveCampaignContent(afterB).editorMode, 'visual');

  const afterHtml = applyCampaignTemplate(afterB, html);
  assert.equal(afterHtml.email_template_id, 'html-c');
  assert.equal(afterHtml.html_content, html.body);
  assert.equal(afterHtml.design_json, null);
  assert.equal(resolveCampaignContent(afterHtml).editorMode, 'html');
  assert.equal(JSON.stringify({ previous, visualA, visualB, html }), sourceSnapshots);
});
