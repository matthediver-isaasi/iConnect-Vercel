import { currentSetDepartmentId } from '@/lib/departmentCurrentSet';

/**
 * Copies only the authorised Department context from the containing Canvas
 * URL. The form iframe must never inherit provider return parameters, draft
 * tokens, or arbitrary parent query values.
 */
export function forwardCanvasDepartmentContext(params, parentSearch) {
  if (!params || typeof params.set !== 'function' || typeof parentSearch !== 'string') return null;
  const departmentId = currentSetDepartmentId(
    new URLSearchParams(parentSearch).get('department_id'),
  );
  if (departmentId) params.set('department_id', departmentId);
  return departmentId;
}