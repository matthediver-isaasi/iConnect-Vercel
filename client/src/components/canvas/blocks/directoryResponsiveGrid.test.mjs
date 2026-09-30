import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('./dynamicBlocks.jsx', import.meta.url),
  'utf8',
);

function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const signatureEnd = source.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, `${name} must have a function body`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not read ${name}`);
}

test('public directory cards and loading placeholders use responsive grid CSS', () => {
  const body = functionBody('DirectoryCardsRender');

  assert.match(
    body,
    /buildResponsiveListGridCss\(block\.id, c, c\.gap, \{ testId: 'directory-list' \}\)/,
  );
  assert.match(
    body,
    /buildResponsiveListGridCss\(block\.id, c, c\.gap, \{ testId: 'skeleton-list' \}\)/,
  );
  assert.match(body, /responsive=\{!isPreview\}/);
  assert.match(body, /style=\{isPreview \? gridStyle\(cols, c\.gap\) : undefined\}/);
});

test('responsive CSS preserves three desktop, two tablet, and one mobile column', () => {
  const columnsForBreakpoint = (content, breakpoint) => {
    const columns = content?.columns || {};
    return Math.max(1, Math.min(6, columns[breakpoint] || columns.desktop || 1));
  };
  const BREAKPOINT_MAX_PX = { tablet: 1023, mobile: 767 };
  const buildCss = new Function(
    'columnsForBreakpoint',
    'BREAKPOINT_MAX_PX',
    `${functionBody('escapeCssAttributeValue')};
     ${functionBody('buildResponsiveListGridCss')};
     return buildResponsiveListGridCss;`,
  )(columnsForBreakpoint, BREAKPOINT_MAX_PX);

  const css = buildCss('directory-block', {
    columns: { desktop: 3, tablet: 2, mobile: 1 },
  }, 20, { testId: 'directory-list' });

  assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /max-width:1023px.*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /max-width:767px.*repeat\(1,minmax\(0,1fr\)\)/);
});

test('responsive CSS safely escapes a malicious block ID', () => {
  const columnsForBreakpoint = (content, breakpoint) => (
    content.columns[breakpoint] || content.columns.desktop || 1
  );
  const BREAKPOINT_MAX_PX = { tablet: 1023, mobile: 767 };
  const buildCss = new Function(
    'columnsForBreakpoint',
    'BREAKPOINT_MAX_PX',
    `${functionBody('escapeCssAttributeValue')};
     ${functionBody('buildResponsiveListGridCss')};
     return buildResponsiveListGridCss;`,
  )(columnsForBreakpoint, BREAKPOINT_MAX_PX);

  const css = buildCss('bad"></style><script>alert(1)</script>', {
    columns: { desktop: 3, tablet: 2, mobile: 1 },
  }, 16, { testId: 'directory-list' });

  assert.doesNotMatch(css, /<\/?style|<\/?script|alert\(1\)/i);
  assert.match(css, /\\3c /, 'the less-than character is represented as a CSS escape');
  assert.match(css, /\\3e /, 'the greater-than character is represented as a CSS escape');
});

test('editor previews resolve selected and inherited directory columns inline', () => {
  const columnsForBreakpoint = new Function(
    `${functionBody('columnsForBreakpoint')}; return columnsForBreakpoint;`,
  )();
  const content = { columns: { desktop: 3, tablet: 2, mobile: 1 } };
  const inherited = { columns: { desktop: 3 } };

  assert.equal(columnsForBreakpoint(content, 'desktop'), 3);
  assert.equal(columnsForBreakpoint(content, 'tablet'), 2);
  assert.equal(columnsForBreakpoint(content, 'mobile'), 1);
  assert.equal(columnsForBreakpoint(inherited, 'tablet'), 3);
  assert.equal(columnsForBreakpoint(inherited, 'mobile'), 3);
});