export function assignmentCategories(assignments) {
  return Object.fromEntries(assignments.filter(a => a.sponsor_id).map(a => [a.sponsor_id, a.category_id || null]));
}

export function linkSponsorOrganization(form, organization) {
  return {
    ...form,
    organization_id: organization?.id || null,
    name: form.name.trim() ? form.name : (organization?.name || form.name),
  };
}
