// Only whole contact values are linkable. Labels never determine field semantics.
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const forbidden = /[\s\u0000-\u001f\u007f-\u009f<>"\\]/u;

export function directoryContactLink(field, rawValue) {
  if (typeof rawValue !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(rawValue)) return null;
  const value = rawValue.trim();
  if (!value || forbidden.test(value)) return null;
  const type = field?.field_type || "text";
  const legacy = type === "text";
  if (type === "email" || legacy) {
    const parts = value.split("@");
    const local = parts[0];
    if (parts.length === 2 && local.length <= 64 && value.length <= 254
      && /^[a-z0-9!#$&'*+/=?^_`{|}~.-]+$/i.test(local)
      && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
      && domainPattern.test(parts[1])) {
      return { href: `mailto:${encodeURIComponent(local)}@${parts[1]}`, external: false };
    }
    if (type === "email") return null;
  }
  if (!legacy && type !== "url" && type !== "website") return null;
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;
  const explicit = /^https?:\/\//i.test(value);
  if (!explicit && (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/"))) return null;
  const href = explicit ? value : `https://${value}`;
  // URL() repairs malformed authorities (e.g. https:///host); don't turn
  // invalid stored strings into apparently valid links.
  const authority = href.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0];
  if (!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(authority)) return null;
  try {
    const url = new URL(href);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || !domainPattern.test(url.hostname)) return null;
    // Keep the original path, query, fragment and escaping, not URL's rewritten form.
    return { href, external: true };
  } catch {
    return null;
  }
}
