import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useLayoutContext } from "@/contexts/LayoutContext";

export const MEMBER_GROUP_SETTING_KEYS = {
  eventsPerPage: "member_group_events_per_page",
  resourcesPerPage: "member_group_resources_per_page",
  featureName: "member_group_feature_name",
  ticketTypeName: "member_group_ticket_type_name",
};

export const MEMBER_GROUP_SETTING_DEFAULTS = {
  eventsPerPage: 3,
  resourcesPerPage: 6,
  featureName: "Member Groups",
  ticketTypeName: "Standard Ticket",
};

function parsePageSize(value, fallback) {
  const parsed = parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function parseName(value, fallback) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

export function useMemberGroupSettings() {
  const { memberInfo, sessionValidated } = useLayoutContext();
  const isAuthenticated = !!memberInfo && !!sessionValidated;

  const { data: settings = [], isLoading } = useQuery({
    queryKey: ["member-group-settings", isAuthenticated ? "authenticated" : "public"],
    queryFn: async () => {
      if (isAuthenticated) {
        return await base44.entities.SystemSettings.list();
      }
      return await publicClient.listSystemSettings();
    },
    staleTime: 60000,
  });

  const findValue = (key) =>
    (settings || []).find((s) => s.setting_key === key)?.setting_value;

  return {
    eventsPerPage: parsePageSize(
      findValue(MEMBER_GROUP_SETTING_KEYS.eventsPerPage),
      MEMBER_GROUP_SETTING_DEFAULTS.eventsPerPage
    ),
    resourcesPerPage: parsePageSize(
      findValue(MEMBER_GROUP_SETTING_KEYS.resourcesPerPage),
      MEMBER_GROUP_SETTING_DEFAULTS.resourcesPerPage
    ),
    featureName: parseName(
      findValue(MEMBER_GROUP_SETTING_KEYS.featureName),
      MEMBER_GROUP_SETTING_DEFAULTS.featureName
    ),
    ticketTypeName: parseName(
      findValue(MEMBER_GROUP_SETTING_KEYS.ticketTypeName),
      MEMBER_GROUP_SETTING_DEFAULTS.ticketTypeName
    ),
    isLoading,
  };
}
