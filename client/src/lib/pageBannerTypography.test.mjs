import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHeroTypographyColors,
  resolveTypographyColor,
  richTextToPlainText,
} from './pageBannerTypography.js';

test('banner card headings show Quill rich text as readable plain text', () => {
  assert.equal(
    richTextToPlainText('<p><span style="color:rgb(41, 42, 46)">Explore BNMS Resources</span></p>', 'Hero Element'),
    'Explore BNMS Resources'
  );
  assert.equal(
    richTextToPlainText('<h2><strong>News &amp; insight</strong></h2><p>For&nbsp;members</p>'),
    'News & insight For members'
  );
  assert.equal(richTextToPlainText('A plain legacy heading'), 'A plain legacy heading');
});

test('banner card headings ignore non-visible and executable markup', () => {
  assert.equal(richTextToPlainText('<p><br></p>', 'Hero Element'), 'Hero Element');
  assert.equal(
    richTextToPlainText('<style>.secret { color: red }</style><script>alert("no")</script><p>Visible</p>'),
    'Visible'
  );
});

test('live typography colours win over saved hero colours', () => {
  assert.deepEqual(
    resolveHeroTypographyColors({
      headingStyle: { color: '#112233' },
      subheadingStyle: { color: '#223344' },
      contentStyle: { color: '#334455' },
      textColor: '#ffffff',
      subheadingColor: '#eeeeee',
      contentColor: '#dddddd',
    }),
    {
      desktop: {
        heading: '#112233',
        subheading: '#223344',
        content: '#334455',
      },
      mobile: {
        heading: '#112233',
        subheading: '#223344',
        content: '#334455',
      },
    }
  );
});

test('saved colours remain fallbacks and explicit mobile colour remains authoritative', () => {
  assert.deepEqual(
    resolveHeroTypographyColors({
      headingStyle: {},
      subheadingStyle: { color: '' },
      textColor: '#101010',
      subheadingColor: '#202020',
      contentColor: '#303030',
      mobileCustomTypography: true,
      mobileTextColor: '#abcdef',
    }),
    {
      desktop: {
        heading: '#101010',
        subheading: '#202020',
        content: '#303030',
      },
      mobile: {
        heading: '#abcdef',
        subheading: '#abcdef',
        content: '#abcdef',
      },
    }
  );
  assert.equal(resolveTypographyColor({ color: '#fedcba' }, '#ffffff'), '#fedcba');
  assert.equal(resolveTypographyColor(null, '#ffffff'), '#ffffff');
});