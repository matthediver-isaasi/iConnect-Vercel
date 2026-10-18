// Sales uses a strict, shared signature payload. Do not change the extra audit
// fields emitted by SignatureField for existing due-diligence forms.
export function signaturePayload(value) {
  if (!value || !['typed', 'drawn', 'uploaded'].includes(value.mode) || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value.data || '')) return null;
  if (value.mode === 'typed' && !value.typedName?.trim()) return null;
  return { mode: value.mode, data: value.data, ...(value.mode === 'typed' ? { typedName: value.typedName.trim() } : {}) };
}

export function legalHtmlOf(quote) {
  return quote?.legalHtml ?? quote?.terms_snapshot?.legalHtml ?? quote?.termsSnapshot?.legalHtml ?? '';
}
