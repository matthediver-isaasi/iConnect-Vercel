import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { applyHybridColumnFallback } from '../../../client/src/components/email-builder/hybridColumns.js';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(fixtureDirectory, 'generated', 'full-length');
const attachedAssetDirectory = join(fixtureDirectory, '..', '..', '..', 'attached_assets');
const imagePath = join(fixtureDirectory, 'generated', 'assets', 'fixture-image.png');
const imageCid = 'fixture-image@example.invalid';
const boundary = 'sanitized-full-length-related-boundary';

mkdirSync(outputDirectory, { recursive: true });

const decodeQuotedPrintable = value => {
  const unfolded = value.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    const hex = unfolded.slice(index + 1, index + 3);
    if (unfolded[index] === '=' && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(unfolded.charCodeAt(index));
    }
  }
  return Buffer.from(bytes).toString('utf8');
};

const extractHtml = mime => {
  const boundaryMatch = mime.match(/Content-Type:\s*multipart\/alternative;\s*boundary="([^"]+)"/i);
  assert(boundaryMatch, 'Expected multipart/alternative boundary');
  const htmlMatch = mime.match(
    /Content-Type:\s*text\/html;[^\r\n]*\r?\nContent-Transfer-Encoding:\s*quoted-printable\r?\n\r?\n([\s\S]*?)(?=\r?\n--[^\r\n]+(?:--)?\r?$)/im,
  );
  assert(htmlMatch, 'Expected quoted-printable HTML MIME part');
  return decodeQuotedPrintable(htmlMatch[1]);
};

const safeCss = css => css
  .replace(/@import\s+(?:url\()?['"]?[^;'")]+['"]?\)?\s*;?/gi, '')
  .replace(/url\(\s*(['"]?)[^)]+\1\s*\)/gi, `url("cid:${imageCid}")`);

const anonymizeText = value => {
  const replacement = 'Fixture';
  let offset = 0;
  return value.replace(/\S/g, () => replacement[offset++ % replacement.length]);
};

const sanitizeClassIdentifiers = html => {
  const cssClassNames = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .flatMap(style => [...style[1].matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1]));
  const classNames = new Set([
    ...[...html.matchAll(/\bclass="([^"]*)"/gi)]
      .flatMap(match => match[1].trim().split(/\s+/))
      .filter(Boolean),
    ...cssClassNames,
  ]);
  let index = 0;
  let sanitized = html;
  for (const className of classNames) {
    if (/^(?:mj-|moz-text-html$|gmail-)/.test(className)) continue;
    index += 1;
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sanitized = sanitized.replace(
      new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'g'),
      `fixture-class-${index}`,
    );
  }
  return sanitized;
};

const sanitizeConditionalComment = comment => {
  if (!/^\s*\[if\b/i.test(comment)) return ' Sanitized fixture comment. ';
  return comment
    .replace(/\b(?:href|action)="[^"]*"/gi, 'href="#fixture-link"')
    .replace(/\b(?:src|background|poster)="[^"]*"/gi, `src="cid:${imageCid}"`)
    .replace(/https?:\/\/[^\s"'<>)]*/gi, '#fixture-link')
    .replace(/>([^<>]*\S[^<>]*)</g, (_, text) => `>${anonymizeText(text)}<`);
};

const sanitizeHtml = sourceHtml => {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(sourceHtml, { virtualConsole });
  const { document, NodeFilter } = dom.window;
  document.querySelectorAll('script').forEach(node => node.remove());

  const walker = document.createTreeWalker(
    document.documentElement,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT,
  );
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    if (node.nodeType === dom.window.Node.COMMENT_NODE) {
      node.data = sanitizeConditionalComment(node.data);
      continue;
    }
    const parentName = node.parentElement?.tagName;
    if (parentName === 'STYLE') {
      node.data = safeCss(node.data);
    } else if (node.data.trim()) {
      const sanitizedText = anonymizeText(node.data);
      assert.equal(sanitizedText.length, node.data.length, 'Text anonymization must preserve node length');
      node.data = sanitizedText;
    }
  }

  let imageCount = 0;
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith('data-')
        || name.startsWith('on')
        || name === 'id'
        || (element.tagName === 'META' && name === 'content')
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (['href', 'action', 'formaction'].includes(name)) element.setAttribute(attribute.name, '#fixture-link');
      if (['src', 'background', 'poster'].includes(name)) {
        element.setAttribute(attribute.name, `cid:${imageCid}`);
        if (name === 'src' && element.tagName === 'IMG') imageCount += 1;
      }
      if (name === 'srcset') element.setAttribute(attribute.name, `cid:${imageCid} 1x`);
      if (name === 'style') element.setAttribute(attribute.name, safeCss(attribute.value));
      if (['alt', 'title', 'aria-label', 'value'].includes(name)) {
        const sanitizedValue = anonymizeText(attribute.value);
        assert.equal(sanitizedValue.length, attribute.value.length, 'Attribute anonymization must preserve length');
        element.setAttribute(attribute.name, sanitizedValue);
      }
      if (name === 'name' && element.tagName !== 'META') {
        const sanitizedValue = anonymizeText(attribute.value);
        assert.equal(sanitizedValue.length, attribute.value.length, 'Attribute anonymization must preserve length');
        element.setAttribute(attribute.name, sanitizedValue);
      }
    }
  }

  const doctype = sourceHtml.match(/<!doctype[^>]*>/i)?.[0] ?? '<!doctype html>';
  return {
    html: sanitizeClassIdentifiers(`${doctype}\n${document.documentElement.outerHTML}`),
    imageCount,
  };
};

const markMultiColumnSections = html => {
  const divTag = /<\/?div\b[^>]*>/gi;
  const columnClass = /\bclass="[^"]*\bmj-column-(?:per|px)-[^"]*"/i;
  const sectionStyle = /\bstyle="[^"]*\bmax-width:\s*\d+(?:\.\d+)?px/i;
  const stack = [];
  const sections = [];
  let tag;

  while ((tag = divTag.exec(html)) !== null) {
    if (/^<\//.test(tag[0])) {
      assert(stack.length > 0, 'Unbalanced closing div in sanitized HTML');
      stack.pop();
      continue;
    }

    const isColumn = columnClass.test(tag[0]);
    const section = !isColumn && sectionStyle.test(tag[0])
      ? { start: tag.index, end: divTag.lastIndex, tag: tag[0], columnClasses: [] }
      : null;
    const containingSection = section ?? stack.at(-1)?.containingSection ?? null;
    if (isColumn && containingSection) {
      containingSection.columnClasses.push(tag[0].match(/\bmj-column-(?:per|px)-[^\s"]+/i)[0]);
    }
    if (section) sections.push(section);
    stack.push({ containingSection });
  }
  assert.equal(stack.length, 0, 'Unbalanced opening div in sanitized HTML');

  const multiColumnSections = sections.filter(section => section.columnClasses.length > 1);
  assert(multiColumnSections.length > 0, 'Expected at least one multi-column MJML section');
  const expectedColumnClasses = multiColumnSections.flatMap(section => section.columnClasses);
  const expectedHybridColumns = expectedColumnClasses.length;
  const expectedColumnClassCounts = Object.fromEntries(
    [...new Set(expectedColumnClasses)].sort().map(className => [
      className,
      expectedColumnClasses.filter(value => value === className).length,
    ]),
  );
  const marked = multiColumnSections.reverse().reduce((output, section) => {
    assert(!/\bclass=/i.test(section.tag), 'Multi-column section unexpectedly has an existing class');
    const markedTag = section.tag.replace(/^<div\b/i, '<div class="gmail-hybrid-section"');
    return output.slice(0, section.start) + markedTag + output.slice(section.end);
  }, html);

  return {
    html: marked,
    multiColumnSectionCount: multiColumnSections.length,
    expectedHybridColumns,
    expectedColumnClassCounts,
  };
};

const writeRelatedEml = (basename, subject, html, png) => {
  writeFileSync(join(outputDirectory, `${basename}.html`), html);
  writeFileSync(join(outputDirectory, `${basename}.eml`), [
    'From: fixture@example.invalid',
    'To: recipient@example.invalid',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${boundary}`,
    'Content-Type: image/png; name="fixture-image.png"',
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${imageCid}>`,
    'Content-Disposition: inline; filename="fixture-image.png"',
    '',
    png.toString('base64').match(/.{1,76}/g).join('\r\n'),
    `--${boundary}--`,
    '',
  ].join('\r\n'));
};

const sourceCandidates = process.argv[2]
  ? [process.argv[2]]
  : readdirSync(attachedAssetDirectory)
    .filter(name => name.endsWith('.txt'))
    .map(name => join(attachedAssetDirectory, name))
    .filter(path => {
      const content = readFileSync(path, 'utf8');
      return content.includes('Content-Type: multipart/alternative')
        && content.includes('Content-Type: text/html')
        && content.includes('mj-column-');
    })
    .sort((left, right) => readFileSync(right).length - readFileSync(left).length);
assert(sourceCandidates.length > 0, 'Pass the local received-MIME path as the first argument');
const sourceMime = readFileSync(sourceCandidates[0], 'utf8');
const originalHtml = extractHtml(sourceMime);
const { html: baseline, imageCount } = sanitizeHtml(originalHtml);
const marked = markMultiColumnSections(baseline);
const candidate = applyHybridColumnFallback(marked.html);
const png = readFileSync(imagePath);

const safetyChecks = html => {
  assert(!/<script\b/i.test(html), 'Scripts must not remain');
  assert(!/\bdata-[\w-]+=/i.test(html), 'Metadata data attributes must not remain');
  assert(!/\bid=/i.test(html), 'Element IDs must not remain');
  assert(!/\bon[a-z]+\s*=/i.test(html), 'Event-handler attributes must not remain');
  assert(!/<meta\b[^>]*\bcontent=/i.test(html), 'Meta content must not remain');
  assert(!/\b(?:href|src|background|poster|action)=["'](?:https?:|\/\/)/i.test(html), 'Remote resources must not remain');
  assert(!/\b[A-Z0-9._%+-]+@(?!example\.invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(html), 'Private email address must not remain');
  assert(!/[?&](?:utm_[^=]*|token|signature|key|id)=/i.test(html), 'Tracking parameters or tokens must not remain');
  assert(!/\b(?:Delivered-To|Return-Path|DKIM-Signature|Message-Id|X-[A-Za-z0-9-]+)\s*:/i.test(html), 'Transport metadata must not remain');
  assert(!/url\(\s*['"]?https?:/i.test(html), 'Remote CSS resources must not remain');
  assert(html.includes('<!--[if mso'), 'Outlook conditional comments must remain');
  assert(html.includes('@media only screen'), 'Responsive structural CSS must remain');
  assert(html.includes(`cid:${imageCid}`), 'CID image placeholders must remain');
  const classNames = [...html.matchAll(/\bclass="([^"]*)"/gi)]
    .flatMap(match => match[1].trim().split(/\s+/))
    .filter(Boolean);
  assert(
    classNames.every(name => /^(?:fixture-class-\d+|mj-|moz-text-html$|gmail-)/.test(name)),
    'Private class identifiers must not remain',
  );
};

safetyChecks(baseline);
safetyChecks(candidate);
assert.equal((baseline.match(/<table\b/gi) ?? []).length, (originalHtml.match(/<table\b/gi) ?? []).length);
assert.equal((baseline.match(/<!--\[if mso/gi) ?? []).length, (originalHtml.match(/<!--\[if mso/gi) ?? []).length);
const baselineOutlookComments = baseline.match(/<!--\[if mso \| IE\]>[\s\S]*?<!\[endif\]-->/g) ?? [];
const candidateOutlookComments = candidate.match(/<!--\[if mso \| IE\]>[\s\S]*?<!\[endif\]-->/g) ?? [];
assert.deepEqual(candidateOutlookComments, baselineOutlookComments, 'Hybrid correction must preserve Outlook comments');
assert.equal(
  (candidate.match(/<div\b[^>]*\bclass="[^"]*\bgmail-hybrid-column\b/gi) ?? []).length,
  marked.expectedHybridColumns,
  'Every column in every multi-column section must acquire hybrid bounds',
);
const boundedColumnClassCounts = {};
for (const element of candidate.match(/<div\b[^>]*\bclass="[^"]*\bgmail-hybrid-column\b[^"]*"[^>]*>/gi) ?? []) {
  const className = element.match(/\bmj-column-(?:per|px)-[^\s"]+/i)?.[0];
  assert(className, 'Every bounded element must retain its MJML width class');
  boundedColumnClassCounts[className] = (boundedColumnClassCounts[className] ?? 0) + 1;
}
assert.deepEqual(
  boundedColumnClassCounts,
  marked.expectedColumnClassCounts,
  'No width class, including later sponsor rows, may be silently missed',
);

writeRelatedEml('received-full-length.before', 'Sanitized full-length baseline', baseline, png);
writeRelatedEml('received-full-length.after', 'Sanitized full-length candidate', candidate, png);

const counts = html => ({
  bytes: Buffer.byteLength(html),
  tables: (html.match(/<table\b/gi) ?? []).length,
  outlookConditionals: (html.match(/<!--\[if mso/gi) ?? []).length,
  mediaQueries: (html.match(/@media\b/gi) ?? []).length,
  columnClasses: (html.match(/\bmj-column-(?:per|px)-/gi) ?? []).length,
  columnElements: (html.match(/<div\b[^>]*\bclass="[^"]*\bmj-column-(?:per|px)-/gi) ?? []).length,
  cidReferences: (html.match(new RegExp(`cid:${imageCid}`, 'g')) ?? []).length,
  hybridColumns: (html.match(/<div\b[^>]*\bclass="[^"]*\bgmail-hybrid-column\b/gi) ?? []).length,
});
const manifest = {
  sourceCommitted: false,
  sourceDecodedHtmlBytes: Buffer.byteLength(originalHtml),
  imageCidMapping: { [imageCid]: '../assets/fixture-image.png' },
  sanitizedImageElements: imageCount,
  detectedMultiColumnSections: marked.multiColumnSectionCount,
  expectedBoundedMultiColumnElements: marked.expectedHybridColumns,
  expectedBoundedElementsByWidthClass: marked.expectedColumnClassCounts,
  assertions: [
    'no scripts, data-* metadata, IDs, meta content, or on* event attributes',
    'no remote resource attributes or remote CSS URLs',
    'no non-fixture email addresses',
    'no common tracking parameters or transport headers',
    'no non-structural source class identifiers',
    'generic visible-text replacement preserves whitespace and per-node length',
    'table and Outlook conditional counts equal source',
    'all structurally detected multi-column elements receive hybrid bounds',
    'Outlook conditional comments are unchanged by hybrid correction',
    'responsive CSS and CID references present',
  ],
  limitations: [
    'Visible text is generically replaced at the same non-whitespace length; serialization and resource replacement still change decoded byte size.',
    'These artifacts do not emulate Gmail or Word-based Outlook.',
    'Size and structure evidence cannot prove the cause of clipping or column stacking.',
  ],
  original: counts(originalHtml),
  baseline: counts(baseline),
  candidate: counts(candidate),
  artifacts: {
    'received-full-length.before.html': Buffer.byteLength(baseline),
    'received-full-length.before.eml': readFileSync(join(outputDirectory, 'received-full-length.before.eml')).length,
    'received-full-length.after.html': Buffer.byteLength(candidate),
    'received-full-length.after.eml': readFileSync(join(outputDirectory, 'received-full-length.after.eml')).length,
  },
};
writeFileSync(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));