export const SUPPORTED_ATTENDANCE_PROVIDERS = new Set(['zoom']);

/**
 * Resolve a child override without making persistence decisions.  Keeping this
 * pure makes the same inheritance rules usable by every provider adapter.
 */
export function resolveInheritedPolicy(parent, override = {}) {
  const usesOverride = Boolean(override.attendance_policy_override);
  const enabled = usesOverride
    ? override.attendance_tracking_enabled
    : parent.attendance_tracking_enabled;
  const provider = usesOverride
    ? override.attendance_provider
    : parent.attendance_provider;
  const threshold = usesOverride
    ? override.attendance_threshold_minutes
    : parent.attendance_threshold_minutes;
  return {
    enabled: Boolean(enabled),
    provider: provider || null,
    thresholdMinutes: Math.max(0, Number(threshold ?? 1) || 0),
    supported: Boolean(provider && SUPPORTED_ATTENDANCE_PROVIDERS.has(provider)),
  };
}

export function eventAttendancePolicy(event) {
  return resolveInheritedPolicy(event, { attendance_policy_override: false });
}