import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/api/publicClient";
import { usePublicChromeBranding } from "@/contexts/MicrositeContext";
import { PublicSignInStyledLink } from "@/components/layouts/PublicLoginLink";
import { ORGANISATION_DIRECTORY_GUEST_DEFAULTS, normalizeOrganisationDirectoryGuestLink } from "@/lib/organisationDirectoryGuestSettings";

export default function OrganisationDirectoryGuest() {
  const { branding } = usePublicChromeBranding() || {};
  const tenant = branding?.id || publicClient.getTenantSlug() || window.location.host;
  const settings = useQuery({
    queryKey: ["organisation-directory-guest-settings", tenant],
    queryFn: async () => {
      const keys = ["org_directory_guest_heading", "org_directory_guest_description", "org_directory_guest_join_link"];
      const rows = await Promise.all(keys.map(key => publicClient.getSystemSetting(key)));
      return Object.fromEntries(rows.filter(Boolean).map(row => [row.setting_key, row.setting_value]));
    },
    retry: false,
    staleTime: 0,
  });
  const values = settings.data || {};
  const joinLink = !settings.isPending && !settings.isError
    ? normalizeOrganisationDirectoryGuestLink(values.org_directory_guest_join_link) : null;

  return (
    <section
      aria-labelledby="organisation-directory-guest-heading"
      className="mx-auto max-w-3xl px-4 py-8 text-center sm:px-6 md:py-12"
      data-testid="organisation-directory-guest"
    >
      <h1 id="organisation-directory-guest-heading" className="text-2xl font-semibold text-slate-900 md:text-3xl">
        {values.org_directory_guest_heading || ORGANISATION_DIRECTORY_GUEST_DEFAULTS.heading}
      </h1>
      <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-slate-600">
        {values.org_directory_guest_description || ORGANISATION_DIRECTORY_GUEST_DEFAULTS.description}
      </p>
      {joinLink && (
        <div className="mt-6 flex justify-center">
          <PublicSignInStyledLink
            to={joinLink}
            external={!joinLink.startsWith('/')}
            label="Join"
            textColor="#0F172A"
            testId="link-organisation-directory-guest-join"
          />
        </div>
      )}
    </section>
  );
}