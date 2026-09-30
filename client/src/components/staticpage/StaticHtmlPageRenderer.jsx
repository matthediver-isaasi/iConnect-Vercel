import React from "react";

/**
 * Task #3371 — read-only renderer for the "AI generated" static page class
 * (i_edit_page.builder_type === 'ai_static').
 *
 * These pages store pre-sanitized HTML (static_html) and CSS that was scoped
 * at store time so every selector starts with [data-static-page="<page id>"]
 * (static_css). Both fields are only ever written server-side through
 * api/_lib/staticPageContent.js (the generic entity API refuses to write
 * them), so rendering them verbatim here is safe — there is deliberately no
 * client-side sanitisation or scoping step to drift out of sync.
 */
export default function StaticHtmlPageRenderer({ page }) {
  if (!page) return null;
  const html = page.static_html || "";
  const css = page.static_css || "";
  return (
    <>
      {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
      <div
        data-static-page={page.id}
        data-testid={`static-page-${page.slug || page.id}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}
