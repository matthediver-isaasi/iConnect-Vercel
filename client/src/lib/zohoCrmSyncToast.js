import { toast } from 'sonner';

function formatMechanisms(mechanisms) {
  if (!Array.isArray(mechanisms) || mechanisms.length === 0) return '';
  return mechanisms.join(' + ');
}

function describeSyncResult(syncResult) {
  if (!syncResult || typeof syncResult !== 'object') return null;
  const status = syncResult.status || 'unknown';
  const moduleName = syncResult.zoho_module || 'Zoho';
  const recordId = syncResult.zoho_record_id ? ` (id ${syncResult.zoho_record_id})` : '';
  const mechanismsLine = formatMechanisms(syncResult.mechanisms);
  const errorLine = syncResult.error_message ? `\n${syncResult.error_message}` : '';

  if (syncResult.timed_out) {
    return {
      level: 'warning',
      title: `Zoho CRM sync still running`,
      description: syncResult.message || `Did not complete within ${Math.round((syncResult.timeout_ms || 0) / 1000)}s. Check the sync log.`
    };
  }

  if (status === 'success') {
    return {
      level: 'success',
      title: `Zoho CRM sync: success → ${moduleName}${recordId}`,
      description: [mechanismsLine, errorLine.replace(/^\n/, '')].filter(Boolean).join('\n') || undefined
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
