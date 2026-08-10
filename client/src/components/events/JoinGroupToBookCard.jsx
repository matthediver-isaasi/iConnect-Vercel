import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Users, LogIn, ArrowRight } from "lucide-react";
import { createPageUrl } from "@/utils";
import { supabase } from "@/api/supabaseClient";

/**
 * Task #3508: group events are viewable by everyone but bookable only by
 * members of the linked member group. When the viewer is not a member of the
 * group, this card replaces the booking controls in the right-hand pane and
 * points them at the group's page:
 *   - authenticated viewers link straight to the group's detail page;
 *   - unauthenticated viewers route via login using the established
 *     returnTo + groupId follow-through convention (group pages are
 *     member-gated), so they land on the group page after signing in.
 */
export default function JoinGroupToBookCard({ groupId, groupName, isAuthenticated }) {
  // Fallback: resolve the group's name when the caller couldn't supply it
  // (e.g. the authenticated event entity payload has no group name).
  const { data: fetchedName } = useQuery({
    queryKey: ["member-group-name", groupId],
    enabled: !!groupId && !groupName,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from("member_group")
          .select("name")
          .eq("id", groupId)
          .maybeSingle();
        if (error) return null;
        return data?.name || null;
      } catch {
        return null;
      }
    },
  });

  const displayName = groupName || fetchedName || "this event's group";
  const groupDetailPath = createPageUrl("MemberGroupDetail");
  const authedHref = `${groupDetailPath}?id=${encodeURIComponent(groupId || "")}`;
  const loginHref = `/login?returnTo=${encodeURIComponent(groupDetailPath)}&groupId=${encodeURIComponent(groupId || "")}`;

  return (
    <Card className="border-blue-200 bg-blue-50 shadow-sm" data-testid="card-join-group-to-book">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <Users className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-blue-900" data-testid="text-join-group-title">
              Group members only
            </h3>
            <p className="text-sm text-blue-800 mt-1" data-testid="text-join-group-message">
              This event is run by <span className="font-semibold">{displayName}</span>. You must
              join the group to attend this event.
            </p>
            <Button
              className="w-full mt-4 bg-blue-600 hover:bg-blue-700"
              onClick={() => {
                window.location.href = isAuthenticated ? authedHref : loginHref;
              }}
              data-testid="button-join-group"
            >
              {isAuthenticated ? (
                <>
                  <ArrowRight className="w-4 h-4 mr-2" />
                  Go to {displayName}
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4 mr-2" />
                  Log in to join {displayName}
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
