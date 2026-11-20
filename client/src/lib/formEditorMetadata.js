// Kept separate from the editable form row so derived capabilities never enter
// form saves, answer fields, validation, or mapping destinations.
export async function loadFormEditorMetadata({ formId, tenantId, fetchMetadata }) {
  const response = await fetchMetadata(`/api/forms/${encodeURIComponent(formId)}/editor-metadata`, {}, tenantId);
  if (!response.ok) throw new Error('Form editor configuration could not be verified. Please retry.');
  const metadata = await response.json();
  if (metadata?.form_id !== formId || typeof metadata.current_set_enabled !== 'boolean') {
    throw new Error('Form editor configuration could not be verified. Please retry.');
  }
  return { current_set_enabled: metadata.current_set_enabled };
}
