export function createEmptySpeakerForm() {
  return {
    member_id: null,
    full_name: "",
    email: "",
    organization: "",
    job_title: "",
    biography: "",
    profile_photo_url: "",
    is_active: true,
  };
}

export function speakerToForm(speaker) {
  return {
    ...createEmptySpeakerForm(),
    member_id: speaker?.member_id || null,
    full_name: speaker?.full_name || "",
    email: speaker?.email || "",
    organization: speaker?.organization || "",
    job_title: speaker?.job_title || "",
    biography: speaker?.biography || "",
    profile_photo_url: speaker?.profile_photo_url || "",
    is_active: speaker?.is_active !== false,
  };
}

export function memberToSpeakerForm(currentForm, member) {
  if (!member) return { ...currentForm, member_id: null };
  const fullName = [member.first_name, member.last_name].filter(Boolean).join(" ");
  return {
    ...currentForm,
    member_id: member.id,
    full_name: fullName || member.email || "",
    email: member.email || "",
    organization: member.organization_name || member.organisation_name || member.organization?.name || "",
    job_title: member.job_title || "",
    biography: member.biography || "",
    profile_photo_url: member.profile_photo_url || "",
  };
}