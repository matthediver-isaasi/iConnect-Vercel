export const PROTECTED_DEPARTMENT_FORM_ID = '8b6f44d3-83f8-449e-9496-b10b1dc28e5f';
export const PROTECTED_DEPARTMENT_TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const PROTECTED_FORM_HELPER_MESSAGE = 'This form is protected and cannot be deleted, contact isaasi for details.';

export function isProtectedDepartmentForm(formOrId) {
  const id = typeof formOrId === 'object' && formOrId !== null
    ? formOrId.id
    : formOrId;
  return String(id || '').trim().toLowerCase() === PROTECTED_DEPARTMENT_FORM_ID;
}