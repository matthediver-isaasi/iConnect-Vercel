export const CRM_NOTE_TARGET_TYPE = 'crm_note';
export const CRM_NOTE_TARGET_FIELD = 'notes';

export const CRM_NOTE_SOURCE_FIELD_TYPES = Object.freeze([
  'text',
  'textarea',
  'email',
  'url',
  'tel',
  'user_name',
  'user_email',
  'user_job_title',
]);

export const isCrmNoteSourceField = field =>
  CRM_NOTE_SOURCE_FIELD_TYPES.includes(field?.type);