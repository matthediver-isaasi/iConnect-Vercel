// Task #3371 — SSR/prerender rendering for the static "AI generated" page
// class (i_edit_page.builder_type = 'ai_static').
//
// Emits exactly what the client's StaticHtmlPageRenderer produces: the
// store-time-scoped stylesheet followed by the sanitized body wrapped in the
// matching [data-static-page="<page id>"] scope element — so prerendered
// responses are styled identically to the hydrated page and the scoped CSS
// still cannot reach tenant chrome.
//
// Kept dependency-free (no jsdom/postcss) so the prerender function doesn't
// drag in the store-time sanitiser chain.

export function buildStaticPageSsrHtml(page) {
  if (!page || page.builder_type !== 'ai_static') return '';
  const html = page.static_html || '';
  const css = page.static_css || '';
  if (!html && !css) return '';
  // page.id is a UUID from our own DB; escape defensively for the attribute.
  const idAttr = String(page.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const styleTag = css ? `<style>${css}</style>` : '';
  return `${styleTag}<div data-static-page="${idAttr}">${html}</div>`;
}
