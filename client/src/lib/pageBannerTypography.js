const HTML_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeHtmlEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, code) => {
    if (code[0] !== '#') return HTML_ENTITIES[code.toLowerCase()] ?? entity;

    const isHex = code[1]?.toLowerCase() === 'x';
    const parsed = Number.parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0x10ffff) return entity;

    try {
      return String.fromCodePoint(parsed);
    } catch {
      return entity;
    }
  });
}

export function richTextToPlainText(value, fallback = '') {
  if (typeof value !== 'string' || !value.trim()) return fallback;

  const plainText = decodeHtmlEntities(
    value
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

  return plainText || fallback;
}

export function resolveTypographyColor(style, fallback) {
  return typeof style?.color === 'string' && style.color.trim()
    ? style.color.trim()
    : fallback;
}

export function resolveHeroTypographyColors({
  headingStyle,
  subheadingStyle,
  contentStyle,
  textColor = '#ffffff',
  subheadingColor,
  contentColor,
  mobileCustomTypography = false,
  mobileTextColor,
} = {}) {
  const desktop = {
    heading: resolveTypographyColor(headingStyle, textColor),
    subheading: resolveTypographyColor(subheadingStyle, subheadingColor || textColor),
    content: resolveTypographyColor(contentStyle, contentColor || textColor),
  };

  if (mobileCustomTypography && mobileTextColor) {
    return {
      desktop,
      mobile: {
        heading: mobileTextColor,
        subheading: mobileTextColor,
        content: mobileTextColor,
      },
    };
  }

  return { desktop, mobile: { ...desktop } };
}