export const BIOGRAPHY_HELPER_SETTING_KEY = 'professional_biography_helper_text';
export const DEFAULT_BIOGRAPHY_HELPER_TEXT = 'This biography will be displayed on your published articles';
export const BIOGRAPHY_HELPER_MAX_LENGTH = 1000;

export function normalizeBiographyHelperText(value) {
  if (typeof value !== 'string') throw new Error('Helper text must be plain text.');
  if (value.length > BIOGRAPHY_HELPER_MAX_LENGTH) {
    throw new Error(`Helper text must be ${BIOGRAPHY_HELPER_MAX_LENGTH} characters or fewer.`);
  }
  return value.trim() || DEFAULT_BIOGRAPHY_HELPER_TEXT;
}
