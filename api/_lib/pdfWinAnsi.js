// WinAnsi-safe text sanitiser for jsPDF standard fonts.
//
// jsPDF's built-in fonts (helvetica etc.) encode text as WinAnsi (cp1252).
// If ANY character in a string has no WinAnsi mapping, jsPDF 4.x silently
// switches the WHOLE string to 2-byte encoding, which common PDF viewers
// render as a space between every letter (or raw character codes).
//
// This helper normalises common typographic characters to their ASCII
// equivalents and replaces anything else that has no WinAnsi mapping, so
// jsPDF never flips into 2-byte encoding.

const REPLACEMENTS = {
  '\u2018': "'", // left single quote
  '\u2019': "'", // right single quote / curly apostrophe
  '\u201A': "'", // single low quote
  '\u201B': "'", // single high-reversed quote
  '\u2032': "'", // prime
  '\u201C': '"', // left double quote
  '\u201D': '"', // right double quote
  '\u201E': '"', // double low quote
  '\u2033': '"', // double prime
  '\u2010': '-', // hyphen
  '\u2011': '-', // non-breaking hyphen
  '\u2012': '-', // figure dash
  '\u2013': '-', // en dash
  '\u2014': '-', // em dash
  '\u2015': '-', // horizontal bar
  '\u2212': '-', // minus sign
  '\u2026': '...', // ellipsis
  '\u00A0': ' ', // non-breaking space
  '\u2007': ' ', // figure space
  '\u2009': ' ', // thin space
  '\u200A': ' ', // hair space
  '\u2002': ' ', // en space
  '\u2003': ' ', // em space
  '\u202F': ' ', // narrow no-break space
  '\u3000': ' ', // ideographic space
  '\u2022': '-', // bullet
  '\u2023': '-', // triangular bullet
  '\u25E6': '-', // white bullet
  '\u2043': '-', // hyphen bullet
  '\u2219': '-', // bullet operator
  '\u200B': '', // zero-width space
  '\u200C': '', // zero-width non-joiner
  '\u200D': '', // zero-width joiner
  '\uFEFF': '', // BOM / zero-width no-break space
  '\u2028': '\n', // line separator
  '\u2029': '\n', // paragraph separator
  '\u02BC': "'", // modifier letter apostrophe
};

// Characters (beyond ASCII 0x20-0x7E, tab, newline, CR) that DO have a
// WinAnsi (cp1252) mapping and can be passed through untouched.
const WINANSI_EXTRAS = new Set([
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
  0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178,
]);

function isWinAnsiChar(code) {
  if (code === 0x09 || code === 0x0A || code === 0x0D) return true;
  if (code >= 0x20 && code <= 0x7E) return true;
  if (code >= 0xA0 && code <= 0xFF) return true;
  return WINANSI_EXTRAS.has(code);
}

/**
 * Return a WinAnsi-safe version of `text`. Non-string inputs are coerced
 * with String(). Typographic characters are normalised to ASCII
 * equivalents; any remaining character without a WinAnsi mapping is
 * replaced with '?'. Plain-ASCII input is returned unchanged.
 */
export function toWinAnsi(text) {
  const str = typeof text === 'string' ? text : String(text ?? '');
  // Fast path: pure printable ASCII (plus tab/newline) — return as-is.
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(str)) return str;

  let out = '';
  for (const ch of str) {
    const mapped = REPLACEMENTS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code >= 0xA0 && code <= 0xFF) {
      out += ch; // Latin-1 range maps directly into WinAnsi
      continue;
    }
    if (isWinAnsiChar(code)) {
      // Even though these have mappings, jsPDF only flips to 2-byte when a
      // character has NO mapping — so pass them through.
      out += ch;
      continue;
    }
    // Try Unicode decomposition to strip accents from exotic letters
    const decomposed = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (decomposed !== ch && /^[\x20-\x7E]+$/.test(decomposed)) {
      out += decomposed;
      continue;
    }
    out += '?';
  }
  return out;
}
