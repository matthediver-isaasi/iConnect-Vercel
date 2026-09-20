import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/api/publicClient";
import { useMicrosite, usePublicChromeBranding } from "@/contexts/MicrositeContext";
import PublicHeaderNavigationAction from "@/components/navigation/PublicHeaderNavigationAction";
import { selectPublicHeaderAction } from "@/lib/publicHeaderNavigationActions";
import { ORGANISATION_DIRECTORY_GUEST_DEFAULTS } from "@/lib/organisationDirectoryGuestSettings";

export default function OrganisationDirectoryGuest() {
  const { branding } = usePublicChromeBranding() || {};
  const { micrositePrefix } = useMicrosite();
  const tenant = branding?.id || publicClient.getTenantSlug() || window.location.host;
  const settings = useQuery({
    queryKey: ["organisation-directory-guest-settings", tenant],
    queryFn: async () => {
      const keys = ["org_directory_guest_heading", "org_directory_guest_description", "org_directory_guest_join_action_id"];
      const rows = await Promise.all(keys.map(key => publicClient.getSystemSetting(key)));
      return Object.fromEntries(rows.filter(Boolean).map(row => [row.setting_key, row.setting_value]));
    },
    retry: false,
    staleTime: 0,
  });
  const navigation = useQuery({
    queryKey: ["organisation-directory-guest-navigation", tenant, micrositePrefix || ""],
    queryFn: () => publicClient.listNavigationItems(micrositePrefix),
    retry: false,
    staleTime: 0,
  });
  const values = settings.data || {};
  const action = !settings.isPending && !settings.isError && !navigation.isError
    ? selectPublicHeaderAction(navigation.data || [], {
      navigationItemId: values.org_directory_guest_join_action_id,
    }) : null;

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
      {action && (
        <div className="mt-6 flex justify-center">
          <PublicHeaderNavigationAction item={action} buttonStyles={branding?.brandingConfig?.button_styles} />
        </div>
      )}
    </section>
  );
}