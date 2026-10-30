// Copies are editable drafts, never a way to republish a legacy contract.
export function createFormCopy(form, timestamp = Date.now()) {
  const { id, created_date, updated_date, created_at, updated_at, created_by,
    submission_count, archived_at, ...configuration } = form;
  return {
    ...configuration,
    name: `Copy of ${form.name}`,
    slug: `${form.slug}-copy-${timestamp}`,
    submission_count: 0,
    is_active: false,
  };
}
