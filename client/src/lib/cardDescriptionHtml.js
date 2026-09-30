import DOMPurify from "dompurify";

const HTML_TAG_RE = /<\/?[a-z][\s\S]*>/i;

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Card Deck descriptions are now authored with a rich text editor and stored as
// HTML. Older cards were stored as plain text (with raw "\n" newlines and no
// HTML tags). Detect those and convert their newlines to <br> so they keep
// rendering on multiple lines instead of collapsing onto one. Everything is run
// through DOMPurify before being injected, matching the heading/subheading
// rendering in IEditCardDeckElement.
export function cardDescriptionToHtml(description) {
  if (!description) return "";
  const str = String(description);
  if (HTML_TAG_RE.test(str)) {
    return DOMPurify.sanitize(str);
  }
  return DOMPurify.sanitize(escapeHtml(str).replace(/\r\n|\r|\n/g, "<br>"));
}
