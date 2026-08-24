/**
 * A valid elapsed deactivate_at makes a form unavailable even while its
 * is_active flag remains true. Missing or malformed legacy values preserve
 * the historical active behavior.
 */
export function isFormScheduleAvailable(form, now = Date.now()) {
  if (!form?.deactivate_at) return true;
  const deactivateTime = new Date(form.deactivate_at).getTime();
  return !Number.isFinite(deactivateTime) || deactivateTime > Number(now);
}