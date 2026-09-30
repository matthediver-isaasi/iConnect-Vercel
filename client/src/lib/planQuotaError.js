import { toast } from 'sonner';

const UPGRADE_PATH = '/admin/plan-usage';

export class PlanQuotaError extends Error {
  constructor(body) {
    const message = body?.error || "You've reached your plan's storage limit.";
    super(message);
    this.name = 'PlanQuotaError';
    this.code = body?.code || 'PLAN_QUOTA_EXCEEDED';
    this.quota = body?.quota || {};
    this.upgradeUrl = body?.quota?.upgrade_url || UPGRADE_PATH;
  }
}

export function isPlanQuotaError(err) {
  if (!err) return false;
  if (err instanceof PlanQuotaError) return true;
  return err.code === 'PLAN_QUOTA_EXCEEDED';
}

/**
 * Inspect a non-OK fetch Response. If it carries a PLAN_QUOTA_EXCEEDED body,
 * throw a PlanQuotaError so callers can surface a friendly upgrade prompt.
 * Otherwise, throw a generic Error using `errorData.error` or the fallback.
 */
export async function throwUploadHttpError(response, fallbackMessage = 'Upload failed') {
  let errorData = {};
  try {
    errorData = await response.json();
  } catch {
    errorData = {};
  }
  if (response.status === 402 && errorData?.code === 'PLAN_QUOTA_EXCEEDED') {
    try {
      const { emitPlanQuotaExceeded } = await import('./queryClient.js');
      emitPlanQuotaExceeded(errorData.quota, errorData?.error || '');
    } catch {
      // no-op
    }
    throw new PlanQuotaError(errorData);
  }
  if (response.status === 401) {
    throw new Error('You must be logged in to upload files');
  }
  throw new Error(errorData?.error || fallbackMessage);
}

/**
 * Show a user-friendly toast for an upload error. Recognises PlanQuotaError
 * and renders an "Upgrade" CTA pointing at /admin/plan-usage; otherwise
 * falls back to a plain error toast with the error's message.
 */
export function showUploadErrorToast(err, fallbackMessage = 'Upload failed') {
  if (isPlanQuotaError(err)) {
    const upgradeUrl = err.upgradeUrl || err.quota?.upgrade_url || UPGRADE_PATH;
    toast.error(err.message || "You've reached your plan's storage limit.", {
      duration: 10000,
      action: {
        label: 'Upgrade',
        onClick: () => {
          window.location.href = upgradeUrl;
        },
      },
    });
    return;
  }
  toast.error(err?.message || fallbackMessage);
}
