export function resolveEventEmailPreview(text, preview) {
  let html = String(text || '');
  if (preview?.url) html = html.replace(/\{\{event_survey_url\}\}|\[\[event\.survey_url\]\]/gi, () => preview.url);
  if (preview?.sponsors !== null && preview?.sponsors !== undefined) {
    html = html.replace(/<p\b[^>]*>\s*(?:(?:<span\b[^>]*>|<strong>|<em>)\s*)*(\{\{event_sponsors\}\}|\[\[event\.sponsors\]\])\s*(?:(?:<\/span>|<\/strong>|<\/em>)\s*)*<\/p>/gi, '$1')
      .replace(/\{\{event_sponsors\}\}|\[\[event\.sponsors\]\]/gi, () => preview.sponsors);
  }
  return html;
}