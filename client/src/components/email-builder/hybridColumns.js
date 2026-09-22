const SECTION_CLASS = 'gmail-hybrid-section';
const COLUMN_CLASS = 'gmail-hybrid-column';

const addHybridWidth = (tag, width) => {
  let updated = tag.replace(
    /\bclass="([^"]*)"/,
    (_, classes) => `class="${classes} ${COLUMN_CLASS}"`,
  );
  updated = updated.replace(
    /\bstyle="([^"]*)"/,
    (_, styles) => `style="${styles}${styles.endsWith(';') ? '' : ';'}max-width:${width}px;"`,
  );
  return updated;
};

const correctMarkedColumns = (section) => {
  const columnTag = /<div\b[^>]*\bclass="[^"]*\bmj-column-(?:per|px)-[^"]*"[^>]*>/g;
  const replacements = [];
  let match;

  while ((match = columnTag.exec(section)) !== null) {
    const conditionalEnd = section.lastIndexOf('<![endif]-->', match.index);
    if (conditionalEnd < 0) continue;

    const endOffset = conditionalEnd + '<![endif]-->'.length;
    if (section.slice(endOffset, match.index).trim()) continue;

    const conditionalStart = section.lastIndexOf('<!--[if mso | IE]>', conditionalEnd);
    if (conditionalStart < 0) continue;

    const outlookCell = section.slice(conditionalStart, endOffset);
    const widths = [...outlookCell.matchAll(/width:([0-9]+(?:\.[0-9]+)?)px;/g)];
    const width = widths.at(-1)?.[1];
    if (!width) continue;

    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      value: addHybridWidth(match[0], width),
    });
  }

  return replacements.reverse().reduce(
    (output, replacement) => (
      output.slice(0, replacement.start)
      + replacement.value
      + output.slice(replacement.end)
    ),
    section,
  );
};

/**
 * Adds a bounded no-media-query fallback only to MJML sections explicitly
 * marked by the Columns block generator. Conditional Outlook markup is read
 * to obtain MJML's final pixel widths, but is never modified.
 */
export const applyHybridColumnFallback = (html) => {
  if (!html || !html.includes(SECTION_CLASS)) return html;

  const sections = [];
  const sectionStart = new RegExp(`<div\\b[^>]*\\bclass="${SECTION_CLASS}"[^>]*>`, 'g');
  let sectionMatch;
  while ((sectionMatch = sectionStart.exec(html)) !== null) {
    const divTags = /<\/?div\b[^>]*>/g;
    divTags.lastIndex = sectionMatch.index;
    let depth = 0;
    let tag;
    while ((tag = divTags.exec(html)) !== null) {
      depth += tag[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        sections.push({ start: sectionMatch.index, end: divTags.lastIndex });
        break;
      }
    }
  }

  let corrected = sections.reverse().reduce((output, section) => {
    const original = output.slice(section.start, section.end);
    const replacement = correctMarkedColumns(original).replace(
      new RegExp(`\\sclass="${SECTION_CLASS}"`),
      '',
    );
    return output.slice(0, section.start) + replacement + output.slice(section.end);
  }, html);

  corrected = corrected.replace(/<!--\[if mso \| IE\]>[\s\S]*?<!\[endif\]-->/g, comment => (
    comment.replace(new RegExp(`class="${SECTION_CLASS}(?:-outlook)?"`, 'g'), 'class=""')
  ));
  const mobileOverride = `
    <style type="text/css">
      @media only screen and (max-width:479px) {
        .${COLUMN_CLASS} { max-width:100% !important; }
      }
    </style>
  `;

  return corrected.replace('</head>', `${mobileOverride}</head>`);
};

export const HYBRID_COLUMN_SECTION_CLASS = SECTION_CLASS;