// Keep the tenant's processed HTML intact. Modern clients get a fluid table;
// Word-based Outlook gets its desktop width from the conditional ghost table.
export function wrapEmailFooter(footerHtml, contentWidth = null) {
  const configuredWidth = String(contentWidth ?? '').trim();
  const parsedWidth = /^\d+(?:px)?$/i.test(configuredWidth)
    ? Number.parseInt(configuredWidth, 10)
    : 0;
  const width = Number.isSafeInteger(parsedWidth) && parsedWidth > 0 ? parsedWidth : 600;
  return `<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="${width}" style="width:${width}px;"><tr><td><![endif]--><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="100%" style="width:100%;max-width:${width}px;margin:0 auto;"><tr><td style="padding:12px 0;">${footerHtml}</td></tr></table><!--[if mso]></td></tr></table><![endif]-->`;
}