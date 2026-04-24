import { toast } from 'sonner';

function formatMechanisms(mechanisms) {
  if (!Array.isArray(mechanisms) || mechanisms.length === 0) return '';
  return mechanisms.join(' + ');
}

function formatRichTextMismatchLines(rtVerification) {
  if (!rtVerification || rtVerification.success || !Array.isArray(rtVerification.mismatches)) return '';
  const lines = rtVerification.mismatches.map(m => {
    const expected = m.expected_preview != null ? `"${m.expected_preview}"` : `(${m.expected_length}ch)`;
    const actual = m.actual_preview != null ? `"${m.actual_preview}"` : `(${m.actual_length}ch)`;
    return `• ${m.api_name}: sent ${m.expected_length}ch ${expected} → got ${m.actual_length}ch ${actual}`;
  });
  return lines.join('\n');
}

function describeSyncResult(syncResult) {
  if (!syncResult || typeof syncResult !== 'object') return null;
  const status = syncResult.status || 'unknown';
  const moduleName = syncResult.zoho_module || 'Zoho';
  const recordId = syncResult.zoho_record_id ? ` (id ${syncResult.zoho_record_id})` : '';
  const mechanismsLine = formatMechanisms(syncResult.mechanisms);
  const rtMismatchLines = formatRichTextMismatchLines(syncResult.rich_text_verification);
  // When we have structured rich-text mismatch data, prefer rendering
  // it as a clean per-field bullet list instead of the inline suffix
  // baked into error_message. The backend deliberately keeps that
  // suffix free of user content (only field names + length numbers,
  // see #432), so this strip pattern is safe — no embedded `]` from
  // user data can break it. Whitespace-tolerant on both sides.
  const errorWithoutRtSuffix = syncResult.error_message
    ? syncResult.error_message.replace(/\s*\[rich-text verification mismatch:[^\]]*\]\s*/g, ' ').trim()
    : '';
  const errorLine = rtMismatchLines
    ? errorWithoutRtSuffix
    : (syncResult.error_message || '');

  if (syncResult.timed_out) {
    return {
      level: 'warning',
      title: `Zoho CRM sync still running`,
      description: syncResult.message || `Did not complete within ${Math.round((syncResult.timeout_ms || 0) / 1000)}s. Check the sync log.`
    };
  }

  if (status === 'success') {
    const isMismatch = !!rtMismatchLines;
    return {
      level: isMismatch ? 'warning' : 'success',
      title: isMismatch
        ? `Zoho CRM sync: partial → ${moduleName}${recordId}`
        : `Zoho CRM sync: success → ${moduleName}${recordId}`,
      description: [
        mechanismsLine,
        rtMismatchLines ? `Rich-text fields Zoho altered:\n${rtMismatchLines}` : '',
        errorLine
      ].filter(Boolean).join('\n') || undefined
    };
  }

  if (status === 'no_change' || status === 'skipped') {
    return {
      level: 'info',
      title: `Zoho CRM sync: ${status}${moduleName ? ` (${moduleName})` : ''}`,
      description: syncResult.error_message || undefined
    };
  }

  if (status === 'failed') {
    return {
      level: 'error',
      title: `Zoho CRM sync FAILED${moduleName ? ` (${moduleName})` : ''}`,
      description: syncResult.error_message || 'Unknown error'
    };
  }

  return {
    level: 'info',
    title: `Zoho CRM sync: ${status}`,
    description: syncResult.error_message || undefined
  };
}

export function showZohoCrmSyncToast(syncResult) {
  const desc = describeSyncResult(syncResult);
  if (!desc) return;
  const opts = desc.description ? { description: desc.description, duration: 8000 } : { duration: 6000 };
  if (desc.level === 'success') toast.success(desc.title, opts);
  else if (desc.level === 'error') toast.error(desc.title, opts);
  else if (desc.level === 'warning') toast.warning ? toast.warning(desc.title, opts) : toast.message(desc.title, opts);
  else toast.message(desc.title, opts);
}
